import * as FD from './frontdata.js';
import {
  Collections,
  Pagination,
  ServiceError
} from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import {
  validateObjectId,
  validateFiniteNumber,
  validateEnum,
  sanitizeMongoObject,
  PROPERTY_TYPES
} from '../validators.js';

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
  const buildings = buildingIds.length
    ? await Collections.Building.find({ _id: { $in: buildingIds } }, { name: 1 }).lean()
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
  // Strict type guard — name is .trim()'d below
  if (req.body?.name !== undefined && typeof req.body.name !== 'string') {
    throw new ServiceError('name must be a string', 422);
  }
  if (!req.body.name?.trim()) {
    throw new ServiceError('Property name is missing', 422);
  }
  validateFiniteNumber(req.body.price, 'price', { min: 0, max: 10000000 });
  validateFiniteNumber(req.body.surface, 'surface', { min: 0, max: 100000 });
  validateFiniteNumber(req.body.landSurface, 'landSurface', {
    min: 0,
    max: 1000000
  });
  // type is required — validate before letting Mongoose throw a ValidationError.
  validateEnum(req.body.type, PROPERTY_TYPES, 'type', { required: true });
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
  validateFiniteNumber(property.surface, 'surface', { min: 0, max: 100000 });
  validateFiniteNumber(property.landSurface, 'landSurface', {
    min: 0,
    max: 1000000
  });
  if (property.type !== undefined) {
    validateEnum(property.type, PROPERTY_TYPES, 'type');
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

  const tenantsUsingProperties = await Collections.Tenant.find({
    realmId: realm!._id,
    'properties.propertyId': { $in: ids }
  }).lean();

  if ((tenantsUsingProperties as any[]).length) {
    const names = (tenantsUsingProperties as any[]).map(({ name }: any) => name).join(', ');
    throw new ServiceError(
      `Property cannot be deleted because it is used by: ${names}`,
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

  // Clean up dangling building.units[].propertyId references — otherwise a
  // building keeps a unit pointing at a deleted property which then
  // surfaces as a null property in _toBuildingData.
  await Collections.Building.updateMany(
    { realmId: realm!._id, 'units.propertyId': { $in: ids } },
    { $set: { 'units.$[elem].propertyId': null } },
    { arrayFilters: [{ 'elem.propertyId': { $in: ids } }] }
  );

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
