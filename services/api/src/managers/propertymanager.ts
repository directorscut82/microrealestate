import * as FD from './frontdata.js';
import {
  Collections,
  Pagination,
  ServiceError
} from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import moment from 'moment';
import {
  validateObjectId,
  validateFiniteNumber,
  validateEnum,
  sanitizeMongoObject,
  isValidGreekPostalCode,
  PROPERTY_TYPES
} from '../validators.js';

// Surface lower-bound depends on property type. A 0-surface apartment is
// nonsensical; parking spots may legitimately have a tiny declared surface
// (or 0 if the user enters it consciously). Apply only when surface is
// supplied — keeps the field optional.
function _surfaceMinForType(type: unknown): number {
  // Wave-17 B8: 'storage' (αποθήκη) follows parking/letterbox — allow a
  // 0-surface declaration since cellars are sometimes recorded without a
  // formal surface measurement.
  if (type === 'parking' || type === 'letterbox' || type === 'storage') {
    return 0;
  }
  return 1;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;

async function _toPropertiesData(realm: Req['realm'], inputProperties: any[]) {
  // Fetch building names for properties that have buildingId
  const buildingIds = [...new Set(
    inputProperties
      .filter((p: any) => p.buildingId)
      .map((p: any) => String(p.buildingId))
  )];
  // Defense-in-depth: realm-scope the building lookup. property.buildingId
  // is server-controlled but a tampered or stale id pointing at another
  // realm's building would otherwise leak that building's name into the
  // properties listing.
  const buildings = buildingIds.length
    ? await Collections.Building.find(
        { realmId: realm!._id, _id: { $in: buildingIds } },
        { name: 1 }
      ).lean()
    : [];
  const buildingMap = new Map((buildings as any[]).map((b: any) => [String(b._id), b.name]));

  const allTenants = await Collections.Tenant.find({
    realmId: realm!._id,
    'properties.propertyId': {
      $in: inputProperties.map(({ _id }: any) => _id)
    }
  }).lean();

  return inputProperties.map((property: any) => {
    const buildingName = property.buildingId
      ? buildingMap.get(String(property.buildingId)) || null
      : null;
    const tenants = (allTenants as any[])
      .filter(({ properties }: any) =>
        properties
          .map(({ propertyId }: any) => propertyId)
          .includes(String(property._id))
      )
      .sort((t1: any, t2: any) => {
        const t1EndDate = t1.terminationDate || t1.endDate;
        const t2EndDate = t2.terminationDate || t2.endDate;
        return t2EndDate - t1EndDate;
      });
    return { ...FD.toProperty(property, tenants?.[0], tenants), buildingName };
  });
}

export async function add(req: Req, res: Res) {
  const realm = req.realm;
  // Wave-21 C30-B5: never trust client-supplied identity on POST. The body
  // is the document the caller wants to create, but _id / __v / realmId are
  // server-owned. Strip them up-front so a malicious payload can't smuggle
  // a chosen ObjectId (which then collides with another realm's id and
  // surfaces as a raw E11000 500 on retry).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id: _ignoredId, __v: _ignoredV, realmId: _ignoredRealmId, ...rest } = req.body || {};
  req.body = rest;
  // Strict type guard — name is .trim()'d below
  if (req.body?.name !== undefined && typeof req.body.name !== 'string') {
    throw new ServiceError('name must be a string', 422);
  }
  if (!req.body.name?.trim()) {
    throw new ServiceError('Property name is missing', 422);
  }
  validateFiniteNumber(req.body.price, 'price', { min: 0, max: 10000000 });
  // type is required — validate before letting Mongoose throw a ValidationError.
  validateEnum(req.body.type, PROPERTY_TYPES, 'type', { required: true });
  // Type-aware surface lower bound (F3): 0 m² apartment/store/etc. is a
  // data-quality bug; parking/letterbox may legitimately be 0.
  validateFiniteNumber(req.body.surface, 'surface', {
    min: _surfaceMinForType(req.body.type),
    max: 100000
  });

  // Tier A2 — Property minimum-required at creation. Address fields
  // (street1 + city + zipCode) become required so receipts, PDF exports,
  // and E9 cross-reference tools all have something to render. The E9
  // import path bypasses this route (creates via Collections.Property.create
  // directly) and always carries address from the parsed building, so
  // imports remain unaffected. The standalone NewPropertyDialog flow MUST
  // surface address fields at creation; that's covered by the form gate.
  const addr = req.body?.address || {};
  if (!addr.street1 || typeof addr.street1 !== 'string' || !addr.street1.trim()) {
    throw new ServiceError('address.street1 is required', 422);
  }
  if (!addr.city || typeof addr.city !== 'string' || !addr.city.trim()) {
    throw new ServiceError('address.city is required', 422);
  }
  if (!addr.zipCode || typeof addr.zipCode !== 'string' || !addr.zipCode.trim()) {
    throw new ServiceError('address.zipCode is required', 422);
  }
  // Tier C2 — Greek postal code format (5 digits).
  if (!isValidGreekPostalCode(addr.zipCode.trim())) {
    throw new ServiceError(
      'address.zipCode must be 5 digits',
      422
    );
  }
  validateFiniteNumber(req.body.landSurface, 'landSurface', {
    min: 0,
    max: 1000000
  });
  // Tier D-B6 — Energy cert: distinguish "invalid date" from "future date"
  // and lower the priority. Per user instruction this validator is the LAST
  // priority and must NEVER block a creation when the value is simply
  // empty/absent. The earlier shape collapsed both invalid-date and
  // future-date into the same misleading error ("cannot be in the future"),
  // confusing AADE PDF imports where the date string occasionally lacked a
  // century and parsed as an out-of-range value.
  if (req.body?.energyCertificate?.issueDate) {
    const d = moment.utc(req.body.energyCertificate.issueDate);
    if (!d.isValid()) {
      throw new ServiceError(
        'energyCertificate.issueDate must be a valid date',
        422
      );
    }
    if (d.isAfter(moment.utc().add(1, 'day'))) {
      throw new ServiceError(
        'energyCertificate.issueDate cannot be in the future',
        422
      );
    }
  }
  const property = new Collections.Property({
    ...req.body,
    realmId: realm!._id
  });
  await property.save();
  const properties = await _toPropertiesData(realm, [property]);
  return res.json(properties[0]);
}

export async function update(req: Req, res: Res) {
  const realm = req.realm;
  const property = req.body;

  validateObjectId(property._id, 'property id');
  validateFiniteNumber(property.price, 'price', { min: 0, max: 10000000 });
  if (property.type !== undefined) {
    validateEnum(property.type, PROPERTY_TYPES, 'type');
  }

  // Look up the existing record so we can (a) compare type changes for the
  // occupied-type-lock (F6) and (b) compute the surface lower bound based on
  // the *effective* type after this update (F3).
  const existing: any = await Collections.Property.findOne({
    _id: property._id,
    realmId: realm!._id
  }).lean();
  if (!existing) {
    throw new ServiceError('Property not found', 404);
  }
  const effectiveType =
    property.type !== undefined ? property.type : existing.type;

  validateFiniteNumber(property.surface, 'surface', {
    min: _surfaceMinForType(effectiveType),
    max: 100000
  });
  validateFiniteNumber(property.landSurface, 'landSurface', {
    min: 0,
    max: 1000000
  });

  // F5: future energyCertificate.issueDate guard on update too.
  if (property?.energyCertificate?.issueDate) {
    const d = moment.utc(property.energyCertificate.issueDate);
    if (!d.isValid() || d.isAfter(moment.utc().add(1, 'day'))) {
      throw new ServiceError(
        'energyCertificate.issueDate cannot be in the future',
        422
      );
    }
  }

  // F6: refuse to mutate `type` while the property is occupied. Type changes
  // shift UI rendering (parking has no rooms, apartment does) and pricing
  // semantics; allowing them silently corrupts charge allocation. Other
  // mutable fields (name, description, surface) remain editable.
  if (property.type !== undefined && property.type !== existing.type) {
    const now = new Date();
    const occupiedBy = await Collections.Tenant.findOne({
      realmId: realm!._id,
      'properties.propertyId': String(property._id),
      $or: [
        { terminationDate: { $exists: false } },
        { terminationDate: null },
        { terminationDate: { $gt: now } }
      ]
    }).lean();
    if (occupiedBy) {
      throw new ServiceError(
        'Cannot change property type while occupied. Terminate or reassign tenant first.',
        422
      );
    }
  }

  const sanitized = sanitizeMongoObject(property);

  // Strip identity / version fields — frontend POSTs the full document back
  // on edit. Mirrors occupantmanager.update().
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, realmId: _realmId, ...payload } = sanitized as any;

  // Drop null / empty-string numeric fields rather than $set'ing them to null —
  // the frontend may send "" for cleared optional inputs and Mongoose will
  // happily cast that to 0.
  for (const k of ['surface', 'landSurface', 'price'] as const) {
    if (payload[k] === null || payload[k] === '') {
      delete payload[k];
    }
  }

  // Letterboxes don't have surfaces. If the type is being switched to
  // 'letterbox', explicitly $unset surface/landSurface so a stale apartment
  // surface doesn't carry over (and confuse downstream charge allocations).
  const updateOps: Record<string, any> = { $set: payload };
  if (payload.type === 'letterbox') {
    updateOps.$unset = { surface: '', landSurface: '' };
    delete updateOps.$set.surface;
    delete updateOps.$set.landSurface;
  }

  const dbProperty = await Collections.Property.findOneAndUpdate(
    {
      realmId: realm!._id,
      _id: property._id
    },
    updateOps,
    { new: true }
  ).lean();

  if (!dbProperty) {
    throw new ServiceError('Property not found', 404);
  }
  const properties = await _toPropertiesData(realm, [dbProperty as any]);
  return res.json(properties[0]);
}

export async function remove(req: Req, res: Res) {
  const realm = req.realm;
  const ids = req.params.ids.split(',');
  ids.forEach((id: string) => validateObjectId(id, 'property id'));

  // Wave-24 B14: collect BOTH guard results so the user sees every blocker
  // in one error rather than fixing them one at a time.
  const [tenantsUsingProperties, buildingsLinking] = await Promise.all([
    Collections.Tenant.find({
      realmId: realm!._id,
      'properties.propertyId': { $in: ids }
    }).lean(),
    Collections.Building.find(
      {
        realmId: realm!._id,
        'units.propertyId': { $in: ids }
      },
      { name: 1, units: 1 }
    ).lean()
  ]);

  const blockers: string[] = [];
  if ((tenantsUsingProperties as any[]).length) {
    const names = (tenantsUsingProperties as any[])
      .map(({ name }: any) => name)
      .join(', ');
    blockers.push(`tenant(s): ${names}`);
  }
  if ((buildingsLinking as any[]).length) {
    const names = (buildingsLinking as any[])
      .map(({ name }: any) => name)
      .join(', ');
    blockers.push(`building unit(s) in: ${names} (detach the unit first)`);
  }
  if (blockers.length) {
    throw new ServiceError(
      `Property cannot be deleted because it is still referenced by ${blockers.join(' AND ')}`,
      422
    );
  }

  const result = await Collections.Property.deleteMany({
    _id: { $in: ids },
    realmId: realm!._id
  });

  if ((result?.deletedCount ?? 0) === 0) {
    throw new ServiceError('Property not found', 404);
  }

  // Wave-21 C30-B2: dangling-unit cleanup is no longer needed — the new
  // pre-delete guard above refuses the delete when any building unit still
  // references the property. The block forces the caller to detach the
  // unit first, which keeps building.units[].propertyId in sync.

  // Partial-success path: some ids didn't match (likely cross-realm or
  // already deleted). Surface the count so callers can detect drift instead
  // of silently dropping.
  if ((result.deletedCount ?? 0) < ids.length) {
    return res.status(200).json({
      deleted: result.deletedCount,
      requested: ids.length
    });
  }

  res.sendStatus(200);
}

export async function all(req: Req, res: Res) {
  const realm = req.realm;
  const { page, limit, skip, isPaginated } = Pagination.parsePagination(req as any);
  const filter = { realmId: realm!._id };

  if (!isPaginated) {
    const dbProperties = await Collections.Property.find(filter)
      .sort({ name: 1 })
      .lean();
    const properties = await _toPropertiesData(realm, dbProperties as any[]);
    return res.json(properties);
  }

  const [dbProperties, total] = await Promise.all([
    Collections.Property.find(filter)
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Collections.Property.countDocuments(filter)
  ]);
  const meta = Pagination.buildPaginationMeta(total, page, limit);
  Pagination.setPaginationHeaders(res as any, meta);
  const properties = await _toPropertiesData(realm, dbProperties as any[]);
  return res.json(properties);
}

export async function one(req: Req, res: Res) {
  const realm = req.realm;
  const propertyId = req.params.id;

  const dbProperty = await Collections.Property.findOne({
    _id: propertyId,
    realmId: realm!._id
  }).lean();

  if (!dbProperty) {
    throw new ServiceError('Property does not exist', 404);
  }

  const properties = await _toPropertiesData(realm, [dbProperty]);
  return res.json(properties[0]);
}
