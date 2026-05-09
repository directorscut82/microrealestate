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
  sanitizeMongoObject
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
  if (!req.body.name?.trim()) {
    throw new ServiceError('Property name is missing', 422);
  }
  validateFiniteNumber(req.body.price, 'price', { min: 0, max: 10000000 });
  validateFiniteNumber(req.body.surface, 'surface', { min: 0, max: 100000 });
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
  const sanitized = sanitizeMongoObject(property);

  const dbProperty = await Collections.Property.findOneAndUpdate(
    {
      realmId: realm!._id,
      _id: sanitized._id
    },
    sanitized,
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

  await Collections.Property.deleteMany({
    _id: { $in: ids },
    realmId: realm!._id
  });

  res.sendStatus(200);
}

export async function all(req: Req, res: Res) {
  const realm = req.realm;
  const { page, limit, skip } = Pagination.parsePagination(req as any);
  const filter = { realmId: realm!._id };

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
