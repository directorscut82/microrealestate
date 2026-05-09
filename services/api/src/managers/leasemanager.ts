import {
  Collections,
  logger,
  Pagination,
  ServiceError
} from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;

async function _leaseUsedByTenant(realm: Req['realm']): Promise<Set<string>> {
  const tenants = await Collections.Tenant.find(
    { realmId: realm!._id },
    { realmId: 1, leaseId: 1 }
  ).lean();
  return (tenants as any[]).reduce((acc: Set<string>, { leaseId }: any) => {
    acc.add(String(leaseId));
    return acc;
  }, new Set<string>());
}

export async function add(req: Req, res: Res) {
  const lease = req.body;
  if (!lease.name) {
    logger.error('missing lease name');
    throw new ServiceError('missing fields', 422);
  }

  const realm = req.realm;
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

export async function update(req: Req, res: Res) {
  const realm = req.realm;
  const lease = req.body;

  if (!lease.name) {
    logger.error('missing lease name');
    throw new ServiceError('missing fields', 422);
  }

  if (lease.active === undefined) {
    lease.active = lease.numberOfTerms > 0 && !!lease.timeRange;
  }

  const setOfUsedLeases = await _leaseUsedByTenant(realm);

  const existingLease: any = setOfUsedLeases.has(String(lease._id))
    ? await Collections.Lease.findOne({ realmId: realm!._id, _id: lease._id }).lean()
    : null;

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
      : lease,
    { new: true }
  ).lean();

  if (!dbLease) {
    throw new ServiceError('lease not found', 404);
  }

  dbLease.usedByTenants = setOfUsedLeases.has(String(dbLease._id));
  res.json(dbLease);
}

export async function remove(req: Req, res: Res) {
  const realm = req.realm;
  const leaseIds = req.params.ids.split(',');

  if (!leaseIds.length) {
    logger.error('missing lease ids');
    throw new ServiceError('missing fields', 422);
  }

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

  const session = await Collections.startSession();
  session.startTransaction();
  try {
    await Promise.all([
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
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw new ServiceError(String(error), 500);
  } finally {
    session.endSession();
  }
  res.sendStatus(200);
}


export async function all(req: Req, res: Res) {
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

export async function one(req: Req, res: Res) {
  const realm = req.realm;
  const leaseId = req.params.id;

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
