import * as FD from './frontdata.js';
import { Collections, ServiceError } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;

async function _toPropertiesData(realm: Req['realm'], inputProperties: any[]) {
  const allTenants = await Collections.Tenant.find({
    realmId: realm!._id,
    'properties.propertyId': {
      $in: inputProperties.map(({ _id }: any) => _id)
    }
  }).lean();

  return inputProperties.map((property: any) => {
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
    return FD.toProperty(property, tenants?.[0], tenants);
  });
}

export async function add(req: Req, res: Res) {
  const realm = req.realm;
  if (!req.body.name?.trim()) {
    throw new ServiceError('Property name is missing', 422);
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

  const dbProperty = await Collections.Property.findOneAndUpdate(
    {
      realmId: realm!._id,
      _id: property._id
    },
    property,
    { new: true }
  ).lean();

  const properties = await _toPropertiesData(realm, [dbProperty]);
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

  const dbProperties = await Collections.Property.find({
    realmId: realm!._id
  })
    .sort({
      name: 1
    })
    .lean();

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
