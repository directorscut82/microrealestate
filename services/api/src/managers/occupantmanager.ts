import type { CollectionTypes } from '@microrealestate/types';
import * as Contract from './contract.js';
import * as FD from './frontdata.js';
import {
  Collections,
  logger,
  Pagination,
  Service,
  ServiceError
} from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import axios from 'axios';
import { customAlphabet } from 'nanoid';
import moment from 'moment';
import {
  validateObjectId,
  validateFiniteNumber
} from '../validators.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;
type AnyRecord = Record<string, any>;

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 12);

function _stringToDate(dateString?: string): Date | undefined {
  return dateString ? moment.utc(dateString, 'DD/MM/YYYY').toDate() : undefined;
}

function _formatTenant(tenant: AnyRecord): AnyRecord {
  const formattedTenant: AnyRecord = {
    ...tenant,
    beginDate: _stringToDate(tenant.beginDate),
    endDate: _stringToDate(tenant.endDate),
    terminationDate: _stringToDate(tenant.terminationDate),
    properties: tenant.properties?.map((property: AnyRecord) => ({
      ...property,
      entryDate:
        _stringToDate(property.entryDate) || _stringToDate(tenant.beginDate),
      exitDate:
        _stringToDate(property.exitDate) || _stringToDate(tenant.endDate),
      expenses: property.expenses?.map((expense: AnyRecord) => ({
        ...expense,
        beginDate: _stringToDate(expense.beginDate),
        endDate: _stringToDate(expense.endDate)
      }))
    })),
    reference: tenant.reference || nanoid()
  };

  if (!formattedTenant.isCompany) {
    formattedTenant.company = null;
    formattedTenant.legalForm = null;
    formattedTenant.siret = null;
    formattedTenant.capital = null;
    formattedTenant.name = formattedTenant.name || formattedTenant.manager;
  } else {
    formattedTenant.name = formattedTenant.company;
  }

  return formattedTenant;
}

async function _buildPropertyMap(realm: Req['realm']): Promise<AnyRecord> {
  const properties: any[] = await Collections.Property.find({
    realmId: realm!._id
  }).lean();

  return properties.reduce((acc: AnyRecord, property: AnyRecord) => {
    property._id = String(property._id);
    acc[property._id] = property;
    return acc;
  }, {});
}

async function _fetchBuildingsForProperties(
  realmId: string,
  properties: AnyRecord[]
): Promise<CollectionTypes.Building[]> {
  const propertyIds = properties
    .map((p) => p.propertyId)
    .filter(Boolean);

  if (propertyIds.length === 0) return [];

  const buildings = await Collections.Building.find({
    realmId,
    'units.propertyId': { $in: propertyIds }
  }).lean();

  return buildings as CollectionTypes.Building[];
}

// Update building unit occupancyType based on tenant assignments.
// Call after tenant add/update/delete to keep building overview in sync.
async function _syncOccupancyForProperties(
  realmId: string,
  propertyIds: string[],
  action: 'link' | 'unlink'
): Promise<void> {
  if (!propertyIds.length) return;

  const buildings = await Collections.Building.find({
    realmId,
    'units.propertyId': { $in: propertyIds }
  });

  for (const building of buildings) {
    let changed = false;
    for (const unit of (building as any).units) {
      if (!unit.propertyId || !propertyIds.includes(String(unit.propertyId))) continue;
      if (unit.occupancyType === 'owner_occupied' || unit.occupancyType === 'parking') continue;

      const newType = action === 'link' ? 'rented' : 'vacant';
      if (unit.occupancyType !== newType) {
        unit.occupancyType = newType;
        changed = true;
      }
    }
    if (changed) {
      (building as any).updatedDate = new Date();
      await building.save();
    }
  }
}

// Auto-link properties to buildings by matching ATAK prefix.
// When a tenant is assigned a property with an ATAK number,
// the property gets linked to the correct building automatically.
async function _autoLinkPropertiesToBuildings(
  realmId: string,
  propertyIds: string[]
): Promise<void> {
  if (!propertyIds.length) return;

  const properties: any[] = await Collections.Property.find(
    {
    realmId,
    _id: { $in: propertyIds },
      atakNumber: { $exists: true, $ne: '' },
      buildingId: { $exists: false }
    }
  ).lean();

  if (!properties.length) return;

  // Fetch all buildings once and build prefix map
  const buildings: any[] = await Collections.Building.find({ realmId }, { atakPrefix: 1 }).lean();
  const prefixMap = new Map(buildings.map((b: any) => [b.atakPrefix, String(b._id)]));

  const bulkOps = properties
    .filter((p: any) => p.atakNumber && p.atakNumber.length >= 6)
    .map((p: any) => {
      const buildingId = prefixMap.get(p.atakNumber.substring(0, 6));
      return buildingId ? { updateOne: { filter: { _id: p._id }, update: { buildingId } } } : null;
    })
    .filter(Boolean);

  if (bulkOps.length) {
    await Collections.Property.bulkWrite(bulkOps as any[]);
  }
}

async function _fetchTenants(realmId: string, tenantId?: string | string[]): Promise<AnyRecord[]> {
  const $match: AnyRecord = {
    realmId
  };
  if (Array.isArray(tenantId)) {
    $match._id = { $in: tenantId.map((id) => new Collections.ObjectId(id)) };
  } else if (tenantId) {
    $match._id = new Collections.ObjectId(tenantId);
  }

  const tenants: AnyRecord[] = await Collections.Tenant.aggregate([
    { $match },
    {
      $lookup: {
        from: 'templates',
        let: {
          tenant_realmId: '$realmId',
          tenant_tenantId: { $toString: '$_id' },
          tenant_leaseId: '$leaseId'
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$realmId', '$$tenant_realmId'] },
                  { $in: ['$$tenant_leaseId', '$linkedResourceIds'] },
                  { $eq: ['$type', 'fileDescriptor'] }
                ]
              }
            }
          },
          {
            $lookup: {
              from: 'documents',
              let: { template_templateId: { $toString: '$_id' } },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$realmId', '$$tenant_realmId'] },
                        { $eq: ['$tenantId', '$$tenant_tenantId'] },
                        { $eq: ['$leaseId', '$$tenant_leaseId'] },
                        { $eq: ['$type', 'file'] },
                        { $eq: ['$templateId', '$$template_templateId'] }
                      ]
                    }
                  }
                },
                {
                  $project: {
                    realmId: 0,
                    leaseId: 0,
                    tenantId: 0,
                    type: 0,
                    mimeType: 0,
                    templateId: 0,
                    url: 0
                  }
                }
              ],
              as: 'documents'
            }
          },
          {
            $project: {
              realmId: 0,
              linkedResourceIds: 0,
              type: 0,
              hasExpiryDate: 0
            }
          }
        ],
        as: 'filesToUpload'
      }
    },
    { $sort: { name: 1 } }
  ]);

  await Collections.Tenant.populate(tenants, [
    {
      path: 'leaseId'
    },
    {
      path: 'properties.propertyId'
    }
  ]);

  const now = moment.utc();
  tenants.forEach((tenant) =>
    tenant.filesToUpload?.forEach((fileToUpload: AnyRecord) => {
      const { required, requiredOnceContractTerminated, documents } =
        fileToUpload;
      fileToUpload.missing =
        (required || (requiredOnceContractTerminated && tenant.terminated)) &&
        (!documents.length ||
          !documents.some(({ expiryDate }: AnyRecord) =>
            expiryDate ? moment(expiryDate).isSameOrAfter(now) : true
          ));
    })
  );

  return tenants;
}

function _propertiesHaveRentData(properties?: AnyRecord[]): boolean {
  return (
    !!properties?.length &&
    properties.every(
      ({ rent, entryDate, exitDate }: AnyRecord) => rent && entryDate && exitDate
    )
  );
}

export async function add(req: Req, res: Res) {
  const realm = req.realm;
  const { _id, ...occupant } = _formatTenant(req.body);

  if (!occupant.name) {
    logger.error('missing tenant name');
    throw new ServiceError('missing fields', 422);
  }
  if (occupant.leaseId) {
    validateObjectId(occupant.leaseId, 'leaseId');
    const leaseExists = await Collections.Lease.exists({
      _id: occupant.leaseId,
      realmId: realm!._id
    });
    if (!leaseExists) {
      throw new ServiceError('Lease not found', 404);
    }
  }
  validateFiniteNumber(occupant.vatRatio, 'vatRatio', { min: 0, max: 1 });
  validateFiniteNumber(occupant.discount, 'discount', { min: 0, max: 10000000 });
  if (occupant.beginDate && occupant.endDate && moment(occupant.endDate).isBefore(moment(occupant.beginDate))) {
    throw new ServiceError('End date must be after begin date', 422);
  }

  const propertyMap = await _buildPropertyMap(realm);

  occupant.properties?.forEach((property: AnyRecord) => {
    property.property = propertyMap[property.propertyId];
    property.rent = property.rent || property.property.price;
    property.expenses =
      property.expenses ||
      (property.property.expense && [
        { title: 'general expense', amount: property.property.expense }
      ]) ||
      [];
  });

  try {
    occupant.rents = [];
    if (
      occupant.beginDate &&
      occupant.endDate &&
      _propertiesHaveRentData(occupant.properties)
    ) {
      // Auto-link properties to buildings by ATAK prefix
      const propIds = occupant.properties
        .map((p: AnyRecord) => p.propertyId)
        .filter(Boolean);
      await _autoLinkPropertiesToBuildings(realm!._id, propIds);

      const buildings = await _fetchBuildingsForProperties(
        realm!._id,
        occupant.properties
      );

      const contract = Contract.create({
        begin: occupant.beginDate,
        end: occupant.endDate,
        frequency: occupant.frequency || 'months',
        properties: occupant.properties,
        buildings,
        vatRate: occupant.vatRatio,
        discount: occupant.discount || 0,
        rents: []
      });

      occupant.rents = contract.rents;
    }
  } catch (error) {
    throw new ServiceError(String(error), 409);
  }

  const newOccupant: any = await Collections.Tenant.create({
    ...occupant,
    realmId: realm!._id
  });

  // Sync building occupancy
  const linkedPropIds = (newOccupant as any).properties
    ?.map((p: AnyRecord) => p.propertyId)
    .filter(Boolean) || [];
  await _syncOccupancyForProperties(realm!._id, linkedPropIds, 'link');

  const occupants = await _fetchTenants(req.realm!._id, newOccupant._id);
  res.json(FD.toOccupantData(occupants.length ? occupants[0] : null as any));
}

export async function update(req: Req, res: Res) {
  const realm = req.realm;
  const occupantId = req.params.id;
  const newOccupant = _formatTenant(req.body);

  if (!newOccupant.name) {
    logger.error('missing tenant name');
    throw new ServiceError('missing fields', 422);
  }
  if (newOccupant.leaseId) {
    validateObjectId(newOccupant.leaseId, 'leaseId');
    const leaseExists = await Collections.Lease.exists({
      _id: newOccupant.leaseId,
      realmId: realm!._id
    });
    if (!leaseExists) {
      throw new ServiceError('Lease not found', 404);
    }
  }
  validateFiniteNumber(newOccupant.vatRatio, 'vatRatio', { min: 0, max: 1 });
  validateFiniteNumber(newOccupant.discount, 'discount', { min: 0, max: 10000000 });
  if (newOccupant.beginDate && newOccupant.endDate && moment(newOccupant.endDate).isBefore(moment(newOccupant.beginDate))) {
    throw new ServiceError('End date must be after begin date', 422);
  }

  const originalOccupantDoc: any = await Collections.Tenant.findOne({
    _id: occupantId,
    realmId: realm!._id
  }).lean();

  if (!originalOccupantDoc) {
    throw new ServiceError('tenant not found', 404);
  }
  const originalOccupant = originalOccupantDoc;
  const documentVersion = originalOccupant.__v;

  if (originalOccupant.documents) {
    newOccupant.documents = originalOccupant.documents;
  }

  const propertyMap = await _buildPropertyMap(realm);

  newOccupant.properties = newOccupant.properties.map((rentedProperty: AnyRecord) => {
    if (!rentedProperty.property) {
      const orignalProperty = originalOccupant.properties?.find(
        ({ propertyId }: AnyRecord) => propertyId === rentedProperty.propertyId
      );

      rentedProperty.property =
        orignalProperty?.property || propertyMap[rentedProperty.propertyId];
    }

    return rentedProperty;
  });

  if (
    newOccupant.beginDate &&
    newOccupant.endDate &&
    _propertiesHaveRentData(newOccupant.properties)
  ) {
    try {
      const termFrequency = newOccupant.frequency || 'months';

      // Auto-link new properties to buildings by ATAK prefix
      const newPropIds = newOccupant.properties
        .map((p: AnyRecord) => p.propertyId)
        .filter(Boolean);
      await _autoLinkPropertiesToBuildings(realm!._id, newPropIds);

      // Fetch buildings for both old and new properties to cover property changes
      const allPropertyIds = [...new Set([
        ...originalOccupant.properties.map((p: AnyRecord) => p.propertyId),
        ...newOccupant.properties.map((p: AnyRecord) => p.propertyId)
      ])];
      const buildings = await _fetchBuildingsForProperties(
        realm!._id,
        allPropertyIds.map((id: string) => ({ propertyId: id }))
      );

      const contract = {
        begin: originalOccupant.beginDate,
        end: originalOccupant.endDate,
        frequency: termFrequency,
        terms: Math.ceil(
          moment(originalOccupant.endDate).diff(
            moment(originalOccupant.beginDate),
            termFrequency as moment.unitOfTime.Diff,
            true
          )
        ),
        properties: originalOccupant.properties,
        buildings,
        vatRate: originalOccupant.vatRatio,
        discount: originalOccupant.discount,
        rents: originalOccupant.rents
      };

      const modification: AnyRecord = {
        begin: newOccupant.beginDate,
        end: newOccupant.endDate,
        termination: newOccupant.terminationDate,
        properties: newOccupant.properties,
        frequency: termFrequency
      };
      if (newOccupant.vatRatio !== undefined) {
        modification.vatRate = newOccupant.vatRatio;
      }
      if (newOccupant.discount !== undefined) {
        modification.discount = newOccupant.discount;
      }

      const newContract = Contract.update(contract, modification);
      newOccupant.rents = newContract.rents;
    } catch (e) {
      throw new ServiceError(String(e), 409);
    }
  } else {
    const hasPaidRents = (newOccupant.rents || []).some(
      (rent: AnyRecord) =>
        (rent.payments &&
          rent.payments.some((payment: AnyRecord) => Number(payment.amount) > 0)) ||
        (rent.discounts || []).some(
          (discount: AnyRecord) => discount.origin === 'settlement'
        )
    );

    if (hasPaidRents) {
      throw new ServiceError(
        'impossible to update tenant some rents have been paid',
        409
      );
    }
    newOccupant.rents = [];
  }

  const updated = await Collections.Tenant.findOneAndUpdate(
    {
      realmId: realm!._id,
      _id: occupantId,
      __v: documentVersion
    },
    { $set: newOccupant, $inc: { __v: 1 } }
  );
  if (!updated) {
    throw new ServiceError(
      'Update conflict: tenant was modified simultaneously. Please retry.',
      409
    );
  }

  // Sync building occupancy for added/removed properties
  const oldPropIds = (originalOccupant.properties || [])
    .map((p: AnyRecord) => String(p.propertyId))
    .filter(Boolean);
  const newPropIds = (newOccupant.properties || [])
    .map((p: AnyRecord) => String(p.propertyId))
    .filter(Boolean);
  const removedPropIds = oldPropIds.filter((id: string) => !newPropIds.includes(id));
  const addedPropIds = newPropIds.filter((id: string) => !oldPropIds.includes(id));

  if (addedPropIds.length) await _syncOccupancyForProperties(realm!._id, addedPropIds, 'link');
  if (removedPropIds.length) await _syncOccupancyForProperties(realm!._id, removedPropIds, 'unlink');

  const newOccupants = await _fetchTenants(req.realm!._id, newOccupant._id);
  res.json(FD.toOccupantData(newOccupants.length ? newOccupants[0] : null as any));
}

export async function remove(req: Req, res: Res) {
  const realm = req.realm;
  const occupantIds = req.params?.ids.split(',') ?? [];

  if (!occupantIds.length) {
    throw new ServiceError('tenant not found', 404);
  }

  const occupants: any[] = await Collections.Tenant.find({
    realmId: realm!._id,
    _id: { $in: occupantIds }
  });

  if (!occupants.length) {
    throw new ServiceError('tenant not found', 404);
  }

  const occupantsWithPaidRents = occupants.filter((occupant: AnyRecord) => {
    return (occupant.rents || []).some(
      (rent: AnyRecord) =>
        (rent.payments &&
          rent.payments.some((payment: AnyRecord) => Number(payment.amount) > 0)) ||
        (rent.discounts || []).some((discount: AnyRecord) => discount.origin === 'settlement')
    );
  });

  if (occupantsWithPaidRents.length) {
    throw new ServiceError(
      `impossible to remove ${occupantsWithPaidRents[0].name} some rents have been paid`,
      409
    );
  }

  // Note: active lease and unpaid balance are warned in the frontend,
  // not blocked here. Only paid rents are a hard block.

  const session = await Collections.startSession();
  session.startTransaction();
  try {
    const documents: any[] = await Collections.Document.find(
      {
        realmId: realm!._id,
        tenantId: { $in: occupantIds }
      },
      {
        _id: 1
      }
    );

    const { PDFGENERATOR_URL } = Service.getInstance().envConfig.getValues();
    const documentIds = documents.map(({ _id }: any) => _id).join(',');
    if (!documentIds) {
      logger.debug('no documents to delete for tenant');
    } else {
      const documentsEndPoint = `${PDFGENERATOR_URL}/documents/${documentIds}`;
      try {
      await axios.delete(documentsEndPoint, {
        headers: {
          authorization: req.headers.authorization,
          organizationid: req.headers.organizationid || String(req.realm!._id),
          'Accept-Language': req.headers['accept-language']
        }
      });
      } catch (error: any) {
        const errorMessage = error.response?.data?.message || error.message;
        logger.error('DELETE documents failed');
        logger.error(errorMessage);
      }
    }

    // Sync building occupancy for removed tenant's properties
    const removedPropIds = occupants.flatMap((o: any) =>
      (o.properties || []).map((p: AnyRecord) => String(p.propertyId)).filter(Boolean)
    );
    if (removedPropIds.length) {
      await _syncOccupancyForProperties(realm!._id, removedPropIds, 'unlink');
    }

    await Collections.Tenant.deleteMany({
      realmId: realm!._id,
      _id: { $in: occupantIds }
    });
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
  const includeArchived = req.query?.includeArchived === 'true';
  const { page, limit, skip } = Pagination.parsePagination(req as any);

  const countFilter: AnyRecord = { realmId: req.realm!._id };
  if (!includeArchived) {
    countFilter.$or = [{ archived: { $exists: false } }, { archived: false }];
  }
  const total = await Collections.Tenant.countDocuments(countFilter);

  const tenants: AnyRecord[] = await Collections.Tenant.aggregate([
    { $match: countFilter },
    { $sort: { name: 1 } },
    { $skip: skip },
    { $limit: limit }
  ]);

  const meta = Pagination.buildPaginationMeta(total, page, limit);
  Pagination.setPaginationHeaders(res as any, meta);

  // Fetch full data (with $lookup) only for the paginated subset
  const tenantIds = tenants.map((t) => String(t._id));
  const fullTenants = tenantIds.length
    ? await _fetchTenants(req.realm!._id, tenantIds)
    : [];
  const sorted = tenantIds.map((id) =>
    fullTenants.find((t) => String(t._id) === id)
  ).filter(Boolean) as AnyRecord[];
  res.json(sorted.map((tenant) => FD.toOccupantData(tenant)));
}

export async function archive(req: Req, res: Res) {
  const tenantId = req.params.id;
  const tenant = await Collections.Tenant.findOneAndUpdate(
    { _id: tenantId, realmId: req.realm!._id },
    { $set: { archived: true } },
    { new: true }
  );
  if (!tenant) {
    throw new ServiceError('tenant not found', 404);
  }
  res.json({ status: 'archived' });
}

export async function unarchive(req: Req, res: Res) {
  const tenantId = req.params.id;
  const tenant = await Collections.Tenant.findOneAndUpdate(
    { _id: tenantId, realmId: req.realm!._id },
    { $set: { archived: false } },
    { new: true }
  );
  if (!tenant) {
    throw new ServiceError('tenant not found', 404);
  }
  res.json({ status: 'unarchived' });
}

export async function one(req: Req, res: Res) {
  const occupantId = req.params.id;
  const tenants = await _fetchTenants(req.realm!._id, occupantId);
  if (!tenants.length) {
    throw new ServiceError('tenant not found', 404);
  }
  res.json(FD.toOccupantData(tenants[0]));
}

export async function overview(req: Req, res: Res) {
  const realm = req.realm;
  const currentDate = moment.utc();

  const occupants: any[] = await Collections.Tenant.find({
    realmId: realm!._id
  }).lean();

  let result: AnyRecord = {
    countAll: occupants?.length || 0,
    countActive: 0,
    countInactive: 0
  };

  result = occupants.reduce((acc, occupant: AnyRecord) => {
    const endMoment = moment(occupant.terminationDate || occupant.endDate);
    if (endMoment.isBefore(currentDate, 'day')) {
      acc.countInactive++;
    } else {
      acc.countActive++;
    }
    return acc;
  }, result);

  res.json(result);
}
