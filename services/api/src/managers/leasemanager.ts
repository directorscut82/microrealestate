import {
  Collections,
  logger,
  Pagination,
  ServiceError
} from '@microrealestate/common';
import type { ReqNoParams, ReqWithId, ReqWithIds, Res } from '../types/requests.js';
import type { CollectionTypes } from '@microrealestate/types';
import {
  validateObjectId,
  validateEnum,
  validateFiniteNumber,
  validateArrayMaxLength,
  validateStringField,
  TIME_RANGES
} from '../validators.js';

async function _leaseUsedByTenant(realm: CollectionTypes.Realm | null | undefined): Promise<Set<string>> {
  const tenants = await Collections.Tenant.find(
    { realmId: realm!._id },
    { realmId: 1, leaseId: 1 }
  ).lean();
  return (tenants as any[]).reduce((acc: Set<string>, { leaseId }: any) => {
    acc.add(String(leaseId));
    return acc;
  }, new Set<string>());
}

export async function add(req: ReqNoParams, res: Res) {
  // Wave-21 C30-B5: strip server-owned identity fields from the payload.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id: _ignoredId, __v: _ignoredV, realmId: _ignoredRealmId, ...rest } = (req.body || {}) as any;
  req.body = rest;
  const lease = req.body;
  // Wave-24 B10: whitespace-only names previously slipped through (`!lease.name`
  // is falsy for empty string but not for "   "). validateStringField trims
  // before checking minLength.
  lease.name = validateStringField(lease.name, 'name', {
    min: 1,
    max: 200,
    required: true
  });
  if (!lease.name) {
    logger.error('missing lease name');
    throw new ServiceError('missing fields', 422);
  }

  // Validate enum + numeric inputs BEFORE Mongoose. add() previously left
  // these to schema validation which throws a generic ValidationError that
  // bubbles to errorHandler as a 500.
  if (lease.timeRange !== undefined) {
    validateEnum(lease.timeRange, TIME_RANGES, 'timeRange');
  }
  validateFiniteNumber(lease.numberOfTerms, 'numberOfTerms', {
    min: 1,
    max: 1000,
    required: true
  });

  const realm = req.realm;
  // Wave-24 B11: case-insensitive duplicate-name check within the realm. The
  // schema comment promises uniqueness but the DB index was relaxed in wave
  // 15 (lease.ts). Enforce here in the manager.
  const candidateName = lease.name.trim().toLowerCase();
  const allLeases: any[] = await Collections.Lease.find({
    realmId: realm!._id
  }).lean();
  if (
    allLeases.some(
      (l) => String(l.name || '').trim().toLowerCase() === candidateName
    )
  ) {
    throw new ServiceError(
      `lease with name '${lease.name}' already exists`,
      422
    );
  }
  const dbLease: any = new Collections.Lease({
    ...lease,
    active: !!lease.active && !!lease.numberOfTerms && !!lease.timeRange,
    realmId: realm!._id
  });
  const savedLease: any = await dbLease.save();
  const setOfUsedLeases = await _leaseUsedByTenant(realm);
  savedLease.usedByTenants = setOfUsedLeases.has(String(savedLease._id));
  res.json(savedLease);
}

export async function update(req: ReqWithId, res: Res) {
  const realm = req.realm;
  const lease = req.body;

  // Wave-24 A7: URL :id is authoritative. Previously update() used
  // req.body._id and silently 404'd when missing, returned wrong document
  // when mismatched. Mirror the rentmanager pattern.
  const urlId = req.params.id;
  validateObjectId(urlId, 'lease id');
  if (lease._id !== undefined && String(lease._id) !== String(urlId)) {
    throw new ServiceError(
      'body._id must match URL :id',
      422
    );
  }
  lease._id = urlId;

  // Wave-24 B10: whitespace-only names slipped through.
  lease.name = validateStringField(lease.name, 'name', {
    min: 1,
    max: 200,
    required: true
  });
  if (!lease.name) {
    logger.error('missing lease name');
    throw new ServiceError('missing fields', 422);
  }

  if (lease.timeRange !== undefined) {
    validateEnum(lease.timeRange, TIME_RANGES, 'timeRange');
  }
  if (lease.numberOfTerms !== undefined) {
    validateFiniteNumber(lease.numberOfTerms, 'numberOfTerms', {
      min: 1,
      max: 1000
    });
  }

  if (lease.active === undefined) {
    lease.active = lease.numberOfTerms > 0 && !!lease.timeRange;
  }

  // Fetch the existing lease BEFORE the in-use guard so we can compare the
  // incoming payload against the persisted document. Without this ordering
  // we cannot detect attempts to mutate protected fields on an in-use lease.
  const existingLease: any = await Collections.Lease.findOne({
    realmId: realm!._id,
    _id: lease._id
  }).lean();

  // Wave-24 B11: refuse duplicate name (case-insensitive) within realm.
  if (lease.name && existingLease) {
    const candidateName = String(lease.name).trim().toLowerCase();
    if (
      candidateName !==
      String(existingLease.name || '').trim().toLowerCase()
    ) {
      const allLeases: any[] = await Collections.Lease.find({
        realmId: realm!._id,
        _id: { $ne: lease._id }
      }).lean();
      if (
        allLeases.some(
          (l) => String(l.name || '').trim().toLowerCase() === candidateName
        )
      ) {
        throw new ServiceError(
          `lease with name '${lease.name}' already exists`,
          422
        );
      }
    }
  }

  const setOfUsedLeases = await _leaseUsedByTenant(realm);

  // When a lease is already referenced by tenants, refuse changes to fields
  // that would invalidate previously-computed rent ledgers (numberOfTerms,
  // timeRange). Previously these fields were silently dropped from the $set
  // payload — the request returned 200 but the values never persisted, which
  // is worse than failing loud because the user has no signal their change
  // was rejected.
  if (setOfUsedLeases.has(String(lease._id))) {
    const protectedFields = ['numberOfTerms', 'timeRange'];
    const requestedChange = protectedFields.some(
      (f) =>
        lease[f] !== undefined &&
        String(lease[f]) !== String(existingLease?.[f])
    );
    if (requestedChange) {
      throw new ServiceError(
        'Cannot change numberOfTerms or timeRange on a lease in use by tenants',
        422
      );
    }
  }

  // Strip identity / version fields from the unrestricted-edit payload —
  // $set must not target the same paths used in the filter clause, otherwise
  // MongoDB rejects with "Updating the path '_id' would create a conflict".
  // Mirrors the equivalent fix in occupantmanager.update().
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, realmId: _realmId, ...leasePayload } = lease;

  const dbLease: any = await Collections.Lease.findOneAndUpdate(
    {
      realmId: realm!._id,
      _id: lease._id
    },
    setOfUsedLeases.has(String(lease._id))
      ? {
          name: lease.name || existingLease?.name,
          description: lease.description ?? existingLease?.description,
          active: lease.active ?? existingLease?.active,
          stepperMode: lease.stepperMode ?? existingLease?.stepperMode
        }
      : leasePayload,
    { new: true }
  ).lean();

  if (!dbLease) {
    throw new ServiceError('lease not found', 404);
  }

  dbLease.usedByTenants = setOfUsedLeases.has(String(dbLease._id));
  res.json(dbLease);
}

export async function remove(req: ReqWithIds, res: Res) {
  const realm = req.realm;
  const leaseIds = req.params.ids.split(',');

  if (!leaseIds.length) {
    logger.error('missing lease ids');
    throw new ServiceError('missing fields', 422);
  }

  validateArrayMaxLength(leaseIds, 50, 'lease ids');
  leaseIds.forEach((id: string) => validateObjectId(id, 'lease id'));

  const setOfUsedLeases = await _leaseUsedByTenant(realm);
  if (leaseIds.some((leaseId: string) => setOfUsedLeases.has(leaseId))) {
    logger.error('lease used by tenants and cannot be removed');
    throw new ServiceError('Contract is used by tenants, it cannot be removed', 422);
  }

  const leases = await Collections.Lease.find({
    realmId: realm!._id,
    _id: { $in: leaseIds }
  });

  if (!leases.length) {
    throw new ServiceError('lease not found', 404);
  }

  const templates: any[] = await Collections.Template.find({
    realmId: realm!._id,
    linkedResourceIds: { $in: leaseIds }
  });

  const templateIdsToRemove = templates
    .filter(({ linkedResourceIds }: any) => linkedResourceIds.length <= 1)
    .reduce((acc: string[], { _id }: any) => [...acc, _id], []);

  // Mongo standalone (NAS deployment) doesn't support multi-document
  // transactions, so we run the deletes in parallel without a session.
  // Failure mode: if one delete succeeds and another fails, we get partial
  // cleanup. Acceptable for now — the realmId filter prevents cross-realm
  // damage and a retry will re-converge.
  const [leaseDeleteResult] = await Promise.all([
    Collections.Lease.deleteMany({
      _id: { $in: leaseIds },
      realmId: realm!._id
    }),
    Collections.Template.deleteMany({
      _id: { $in: templateIdsToRemove },
      realmId: realm!._id
    }),
    Collections.Template.updateMany(
      {
        realmId: realm!._id,
        linkedResourceIds: { $in: leaseIds }
      },
      {
        $pull: { linkedResourceIds: { $in: leaseIds } }
      }
    )
  ]);

  if ((leaseDeleteResult?.deletedCount ?? 0) === 0) {
    throw new ServiceError(
      'No records deleted (none of the ids matched)',
      404
    );
  }

  // Partial-success path: report counts so the client can detect drift.
  if ((leaseDeleteResult.deletedCount ?? 0) < leaseIds.length) {
    return res.status(200).json({
      deleted: leaseDeleteResult.deletedCount,
      requested: leaseIds.length
    });
  }

  res.sendStatus(200);
}


export async function all(req: ReqNoParams, res: Res) {
  const realm = req.realm;
  const { page, limit, skip, isPaginated } = Pagination.parsePagination(req as any);
  const filter = { realmId: realm!._id };
  const setOfUsedLeases = await _leaseUsedByTenant(realm);

  if (!isPaginated) {
    const dbLeases = await Collections.Lease.find(filter)
      .sort({ name: 1 })
      .lean();
    res.json((dbLeases as any[]).map((dbLease: any) => ({
      ...dbLease,
      usedByTenants: setOfUsedLeases.has(String(dbLease._id))
    })));
  } else {
    const [dbLeases, total] = await Promise.all([
      Collections.Lease.find(filter)
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Collections.Lease.countDocuments(filter)
    ]);
    const meta = Pagination.buildPaginationMeta(total, page, limit);
    Pagination.setPaginationHeaders(res as any, meta);
    res.json((dbLeases as any[]).map((dbLease: any) => ({
      ...dbLease,
      usedByTenants: setOfUsedLeases.has(String(dbLease._id))
    })));
  }
}

export async function one(req: ReqWithId, res: Res) {
  const realm = req.realm;
  const leaseId = req.params.id;
  // Wave-24 A6: GET /leases/notvalid was 500 (CastError). Validate up front.
  validateObjectId(leaseId, 'lease id');

  const dbLease: any = await Collections.Lease.findOne({
    _id: leaseId,
    realmId: realm!._id
  }).lean();

  if (!dbLease) {
    throw new ServiceError('lease not found', 404);
  }

  const setOfUsedLeases = await _leaseUsedByTenant(realm);
  dbLease.usedByTenants = setOfUsedLeases.has(String(dbLease._id));
  res.json(dbLease);
}
