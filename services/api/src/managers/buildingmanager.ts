import { Collections, logger, ServiceError } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import type { CollectionTypes } from '@microrealestate/types';
import { parseE9 } from './e9parser.js';
import type { ParsedE9Unit } from './e9parser.js';
import * as Contract from './contract.js';
import { computeBuildingChargeForProperty } from '../businesslogic/tasks/1_base.js';
import moment from 'moment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function _toBuildingData(realmId: string, buildings: any[]) {
  const propertyIds = buildings.flatMap((b: any) =>
    (b.units || [])
      .filter((u: any) => u.propertyId)
      .map((u: any) => u.propertyId)
  );

  const properties = propertyIds.length
    ? await Collections.Property.find({
        realmId,
        _id: { $in: propertyIds }
      }).lean()
    : [];

  const propMap = new Map(
    (properties as any[]).map((p: any) => [String(p._id), p])
  );

  return buildings.map((building: any) => {
    const units = (building.units || []).map((unit: any) => ({
      ...unit,
      property: unit.propertyId ? propMap.get(String(unit.propertyId)) : null
    }));

    const managedCount = units.filter((u: any) => u.isManaged).length;

    return {
      ...building,
      units,
      managedCount,
      unitCount: units.length
    };
  });
}

function _findBuilding(building: any, id: string) {
  if (!building) {
    throw new ServiceError('Building does not exist', 404);
  }
  return building;
}

// Infer property type from E9 parsed unit data
function _inferPropertyType(unit: ParsedE9Unit): string {
  // Category from E9: 1=apartment, 2=store, 51=parking/storage
  if (unit.category !== null) {
    if (unit.category === 2) return 'store';
    if (unit.category >= 50) return 'parking';
  }
  // Fallback heuristics when category not available
  if (unit.floor === 0 && unit.category === null) return 'store';
  if (unit.floor !== null && unit.floor < 0 && unit.category === null) return 'parking';
  return 'apartment';
}

// Find the realm member ID for a given email
function _findMemberIdByEmail(
  realm: any,
  email: string
): string | undefined {
  if (!realm?.members) return undefined;
  const member = (realm.members as any[]).find(
    (m: any) => m.email === email
  );
  return member ? String(member._id) : undefined;
}

// Recompute rents for all tenants that use a specific property
async function _recomputeTenantsForProperty(
  realmId: string,
  propertyId: string
): Promise<void> {
  const tenants = await Collections.Tenant.find({
    realmId,
    'properties.propertyId': propertyId
  });

  if (!tenants.length) return;

  for (const tenant of tenants) {
    const tenantObj: any = tenant.toObject();
    if (!tenantObj.beginDate || !tenantObj.endDate) continue;
    if (!tenantObj.properties?.length) continue;

    // Fetch property details for the tenant
    const propertyIds = tenantObj.properties
      .map((p: any) => p.propertyId)
      .filter(Boolean);
    const properties = await Collections.Property.find({
      _id: { $in: propertyIds }
    }).lean();
    const propMap = properties.reduce((acc: any, p: any) => {
      acc[String(p._id)] = p;
      return acc;
    }, {});

    tenantObj.properties.forEach((p: any) => {
      p.property = propMap[String(p.propertyId)] || p.property;
    });

    // Fetch buildings for rent computation
    const buildings: CollectionTypes.Building[] = await Collections.Building.find({
      realmId,
      'units.propertyId': { $in: propertyIds }
    }).lean() as CollectionTypes.Building[];

    try {
      const termFrequency = tenantObj.frequency || 'months';
      const contract = {
        begin: tenantObj.beginDate,
        end: tenantObj.endDate,
        frequency: termFrequency,
        terms: Math.ceil(
          moment(tenantObj.endDate).diff(
            moment(tenantObj.beginDate),
            termFrequency as moment.unitOfTime.Diff,
            true
          )
        ),
        properties: tenantObj.properties,
        buildings,
        vatRate: tenantObj.vatRatio,
        discount: tenantObj.discount,
        rents: tenantObj.rents || []
      };

      const updated = Contract.update(contract, {
        begin: tenantObj.beginDate,
        end: tenantObj.endDate,
        termination: tenantObj.terminationDate,
        properties: tenantObj.properties,
        frequency: termFrequency
      });

      await Collections.Tenant.updateOne(
        { _id: tenant._id },
        { rents: updated.rents }
      );
      logger.info(`Recomputed rents for tenant ${tenantObj.name} (property ${propertyId})`);
    } catch (error) {
      logger.error(`Failed to recompute rents for tenant ${tenantObj.name}: ${error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Building CRUD
// ---------------------------------------------------------------------------

export async function all(req: Req, res: Res) {
  const realm = req.realm;
  const dbBuildings = await Collections.Building.find({
    realmId: realm!._id
  })
    .sort({ name: 1 })
    .lean();

  const buildings = await _toBuildingData(
    realm!._id,
    dbBuildings as any[]
  );
  return res.json(buildings);
}

export async function one(req: Req, res: Res) {
  const realm = req.realm;
  const dbBuilding = await Collections.Building.findOne({
    _id: req.params.id,
    realmId: realm!._id
  }).lean();

  _findBuilding(dbBuilding, req.params.id);

  const buildings = await _toBuildingData(realm!._id, [dbBuilding]);
  return res.json(buildings[0]);
}

export async function add(req: Req, res: Res) {
  const realm = req.realm;
  if (!req.body.name?.trim()) {
    throw new ServiceError('Building name is missing', 422);
  }
  if (!req.body.atakPrefix?.trim()) {
    throw new ServiceError('ATAK prefix is missing', 422);
  }

  const existing = await Collections.Building.findOne({
    realmId: realm!._id,
    atakPrefix: req.body.atakPrefix
  }).lean();

  if (existing) {
    throw new ServiceError(
      `A building with ATAK prefix ${req.body.atakPrefix} already exists`,
      422
    );
  }

  const now = new Date();
  const {
    name, description, address, blockNumber, blockStreets,
    atakPrefix, yearBuilt, totalFloors, hasElevator,
    hasCentralHeating, heatingType, manager, bankInfo,
    units, expenses, contractors, repairs, notes
  } = req.body;
  const building = new Collections.Building({
    name, description, address, blockNumber, blockStreets,
    atakPrefix, yearBuilt, totalFloors, hasElevator,
    hasCentralHeating, heatingType, manager, bankInfo,
    units: units || [], expenses: expenses || [],
    contractors: contractors || [], repairs: repairs || [],
    notes,
    realmId: realm!._id,
    createdDate: now,
    updatedDate: now
  });
  await building.save();

  // Link properties to the building
  const unitPropertyIds = (units || [])
    .filter((u: any) => u.propertyId)
    .map((u: any) => u.propertyId);
  if (unitPropertyIds.length) {
    await Collections.Property.updateMany(
      { _id: { $in: unitPropertyIds }, realmId: realm!._id },
      { buildingId: String(building._id) }
    );
  }

  const buildings = await _toBuildingData(realm!._id, [
    building.toObject()
  ]);
  return res.json(buildings[0]);
}

export async function update(req: Req, res: Res) {
  const realm = req.realm;

  if (req.body.atakPrefix) {
    const existing = await Collections.Building.findOne({
      _id: req.params.id,
      realmId: realm!._id
    }).lean();
    if (existing && (existing as any).atakPrefix !== req.body.atakPrefix) {
      const dup = await Collections.Building.findOne({
        realmId: realm!._id,
        atakPrefix: req.body.atakPrefix,
        _id: { $ne: req.params.id }
      }).lean();
      if (dup) throw new ServiceError('ATAK prefix already in use', 422);
    }
  }
  const dbBuilding = await Collections.Building.findOneAndUpdate(
    {
      _id: req.params.id,
      realmId: realm!._id
    },
    {
      $set: {
        ...(req.body.name !== undefined && { name: req.body.name }),
        ...(req.body.description !== undefined && { description: req.body.description }),
        ...(req.body.address !== undefined && { address: req.body.address }),
        ...(req.body.blockNumber !== undefined && { blockNumber: req.body.blockNumber }),
        ...(req.body.blockStreets !== undefined && { blockStreets: req.body.blockStreets }),
        ...(req.body.atakPrefix !== undefined && { atakPrefix: req.body.atakPrefix }),
        ...(req.body.yearBuilt !== undefined && { yearBuilt: req.body.yearBuilt }),
        ...(req.body.totalFloors !== undefined && { totalFloors: req.body.totalFloors }),
        ...(req.body.hasElevator !== undefined && { hasElevator: req.body.hasElevator }),
        ...(req.body.hasCentralHeating !== undefined && { hasCentralHeating: req.body.hasCentralHeating }),
        ...(req.body.heatingType !== undefined && { heatingType: req.body.heatingType }),
        ...(req.body.manager !== undefined && { manager: req.body.manager }),
        ...(req.body.bankInfo !== undefined && { bankInfo: req.body.bankInfo }),
        ...(req.body.notes !== undefined && { notes: req.body.notes }),
        updatedDate: new Date()
      }
    },
    { new: true }
  ).lean();

  _findBuilding(dbBuilding, req.params.id);

  const buildings = await _toBuildingData(realm!._id, [dbBuilding]);
  return res.json(buildings[0]);
}

export async function remove(req: Req, res: Res) {
  const realm = req.realm;
  const ids = req.params.ids.split(',');

  for (const id of ids) {
    const building = await Collections.Building.findOne({
      _id: id,
      realmId: realm!._id
    }).lean();

    if (!building) {
      continue;
    }

    const managedPropertyIds = ((building as any).units || [])
      .filter((u: any) => u.propertyId)
      .map((u: any) => u.propertyId);

    if (managedPropertyIds.length) {
      const activeTenants = await Collections.Tenant.find({
        realmId: realm!._id,
        'properties.propertyId': { $in: managedPropertyIds }
      }).lean();

      if ((activeTenants as any[]).length) {
        const names = (activeTenants as any[])
          .map(({ name }: any) => name)
          .join(', ');
        throw new ServiceError(
          `Building cannot be deleted because units have active tenants: ${names}`,
          422
        );
      }
    }
  }

  await Collections.Building.deleteMany({
    _id: { $in: ids },
    realmId: realm!._id
  });

  // Clear buildingId from linked properties
  await Collections.Property.updateMany(
    { realmId: realm!._id, buildingId: { $in: ids } },
    { $unset: { buildingId: '' } }
  );

  res.sendStatus(200);
}

// ---------------------------------------------------------------------------
// E9 PDF Import (stub — full parser in Task 6)
// ---------------------------------------------------------------------------

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  let fullText = '';
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(buffer);
    const doc = await getDocument({ data }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      fullText +=
        content.items.map((item: any) => item.str).join(' ') +
        '\n--- PAGE BREAK ---\n';
    }
  } catch (error) {
    throw new ServiceError(
      'Failed to parse PDF file: ' + String(error),
      422
    );
  }
  return fullText;
}

export async function importFromE9(req: Req, res: Res) {
  const realm = req.realm;
  const file = (req as any).file;

  if (!file) {
    throw new ServiceError('PDF file is required', 422);
  }

  // Extract and parse PDF
  const text = await extractTextFromPdf(file.buffer);
  const parsed = parseE9(text);

  if (!parsed.owner.taxId) {
    throw new ServiceError('Could not parse owner information from E9 PDF', 422);
  }

  if (parsed.buildings.length === 0) {
    throw new ServiceError('No buildings found in E9 PDF', 422);
  }

  // Build preview response
  const preview = {
    owner: parsed.owner,
    buildings: await Promise.all(
      parsed.buildings.map(async (building) => {
        // Check if building already exists by address first, then atakPrefix
        let existing = await Collections.Building.findOne({
          realmId: realm!._id,
          'address.street1': building.address.street1,
          'address.zipCode': building.address.zipCode
        }).lean();

        if (!existing) {
            existing = await Collections.Building.findOne({
              realmId: realm!._id,
              'address.street1': building.address.street1
            }).lean();
          }

        // Check which units can be matched to existing properties
        const unitPreviews = await Promise.all(
          building.units.map(async (unit) => {
            const existingProperty = await Collections.Property.findOne({
              realmId: realm!._id,
              atakNumber: unit.atakNumber
            }).lean();

            return {
              ...unit,
              existingPropertyId: existingProperty?._id || null,
              existingPropertyName: existingProperty?.name || null
            };
          })
        );

        return {
          ...building,
          existingBuildingId: existing?._id || null,
          existingBuildingName: existing?.name || null,
          units: unitPreviews
        };
      })
    ),
    skippedLandPlots: parsed.skippedLandPlots
  };

  // If confirmed=true query param, actually create/update
  if (req.query.confirmed === 'true') {
    const createdBuildings = [];

    const ownerFullName = `${parsed.owner.lastName} ${parsed.owner.firstName}`.trim();

    // Resolve member ID from user email for ownership
    const userEmail = (req as any).user?.email;
    const memberId = _findMemberIdByEmail(realm, userEmail);

    for (const buildingData of parsed.buildings) {
      // Check if building exists
      // 1. Exact address match (street1 + zipCode)
      let building = await Collections.Building.findOne({
        realmId: realm!._id,
        'address.street1': buildingData.address.street1,
        'address.zipCode': buildingData.address.zipCode
      });

      // 2. Street-only match (handles empty/different zips between owners)
      if (!building && buildingData.address.street1) {
        building = await Collections.Building.findOne({
          realmId: realm!._id,
          'address.street1': buildingData.address.street1
        });
      }

      // NOTE: Do NOT match by ATAK prefix — it's a cadastral area code, not building ID
      // Multiple buildings can share the same prefix (e.g. ΑΧΑΡΝΩΝ 167 and ΚΑΛΑΜΩΝ 24)

      if (!building) {
        // Create new building
        building = new Collections.Building({
          realmId: realm!._id,
          name: buildingData.address.street1,
          atakPrefix: buildingData.atakPrefix,
          address: buildingData.address,
          blockNumber: buildingData.blockNumber,
          blockStreets: buildingData.blockStreets,
          yearBuilt: buildingData.yearBuilt,
          hasElevator: false,
          hasCentralHeating: false,
          units: [],
          expenses: [],
          contractors: [],
          repairs: [],
          createdDate: new Date(),
          updatedDate: new Date()
        });
        await building.save();
      } else {
        // Consolidate: merge incoming data into existing building
        let updated = false;
        const b = building as any;
        if (buildingData.address?.street1 && !b.address?.street1) {
          b.address = buildingData.address;
          updated = true;
        }
        if (buildingData.yearBuilt && !b.yearBuilt) {
          b.yearBuilt = buildingData.yearBuilt;
          updated = true;
        }
        if (buildingData.blockNumber && !b.blockNumber) {
          b.blockNumber = buildingData.blockNumber;
          updated = true;
        }
        if (buildingData.blockStreets?.length && !b.blockStreets?.length) {
          b.blockStreets = buildingData.blockStreets;
          updated = true;
        }
        if (updated) {
          b.updatedDate = new Date();
          await building.save();
        }
      }

      // Add units and create/link properties
      for (const parsedUnit of buildingData.units) {
        // Check if unit already exists in building
        // 1. By ATAK number (same owner re-importing)
        const existingUnit = (building as any).units.find(
          (u: any) => u.atakNumber === parsedUnit.atakNumber
        );
        if (existingUnit) {
          // Add this owner if not already listed
          const hasOwner = existingUnit.owners?.some(
            (o: any) => o.name === ownerFullName
          );
          if (!hasOwner && existingUnit.owners) {
            existingUnit.owners.push({
              type: 'member',
              name: ownerFullName,
              percentage: parsedUnit.ownershipPercentage,
              memberId: memberId || userEmail
            });
          }
          continue;
        }

        // 2. By DEH number + floor + surface (same apartment, different owner's ATAK)
        // Must match floor+surface too: different floors sharing one meter are separate units
        const existingByDeh = parsedUnit.electricitySupplyNumber
          ? (building as any).units.find(
              (u: any) => u.electricitySupplyNumber === parsedUnit.electricitySupplyNumber
                && u.floor === parsedUnit.floor
                && u.surface === parsedUnit.surface
            )
          : null;
        if (existingByDeh) {
          // Same apartment, add co-owner
          const hasOwner = existingByDeh.owners?.some(
            (o: any) => o.name === ownerFullName
          );
          if (!hasOwner && existingByDeh.owners) {
            existingByDeh.owners.push({
              type: 'member',
              name: ownerFullName,
              percentage: parsedUnit.ownershipPercentage,
              memberId: memberId || userEmail
            });
          }
          // Store co-owner's ATAK in altAtakNumbers (on building unit and property)
          if (existingByDeh.atakNumber !== parsedUnit.atakNumber) {
            if (!existingByDeh.altAtakNumbers) existingByDeh.altAtakNumbers = [];
            if (!existingByDeh.altAtakNumbers.includes(parsedUnit.atakNumber)) {
              existingByDeh.altAtakNumbers.push(parsedUnit.atakNumber);
            }
            // Also update the linked Property record
            if (existingByDeh.propertyId) {
              await Collections.Property.updateOne(
                { _id: existingByDeh.propertyId },
                { $addToSet: { altAtakNumbers: parsedUnit.atakNumber } }
              );
            }
          }
          continue;
        }

        // Find or create the Property record
        let property = await Collections.Property.findOne({
          realmId: realm!._id,
          atakNumber: parsedUnit.atakNumber
        });

        if (!property) {
          property = await Collections.Property.create({
            realmId: realm!._id,
            name: `${parsedUnit.street} ${parsedUnit.streetNumber} - ${
              parsedUnit.floor == null || parsedUnit.floor === 0 ? 'Ισόγειο'
              : parsedUnit.floor < 0 ? 'Υπόγειο' : 'Όροφος ' + parsedUnit.floor}`,
            type: _inferPropertyType(parsedUnit),
            surface: parsedUnit.surface,
            atakNumber: parsedUnit.atakNumber,
            electricitySupplyNumber: parsedUnit.electricitySupplyNumber,
            buildingId: String(building!._id),
            address: buildingData.address
          });
        } else {
          property.buildingId = String(building!._id) as any;
          property.electricitySupplyNumber = parsedUnit.electricitySupplyNumber as any;
          // Fix name if it's still just an ATAK number (from lease import)
          if (/^\d{11}$/.test(property.name)) {
            const floorLabel = parsedUnit.floor == null || parsedUnit.floor === 0
              ? 'Ισόγειο'
              : parsedUnit.floor < 0 ? 'Υπόγειο' : `Όροφος ${parsedUnit.floor}`;
            property.name = `${parsedUnit.street} ${parsedUnit.streetNumber} - ${floorLabel}` as any;
          }
          if (parsedUnit.surface && !property.surface) {
            property.surface = parsedUnit.surface as any;
          }
          await property.save();
        }

        (building as any).units.push({
          atakNumber: parsedUnit.atakNumber,
          floor: parsedUnit.floor,
          surface: parsedUnit.surface,
          yearBuilt: parsedUnit.yearBuilt,
          electricitySupplyNumber: parsedUnit.electricitySupplyNumber,
          owners: [{
            type: 'member',
            name: ownerFullName,
            percentage: parsedUnit.ownershipPercentage,
            memberId: memberId || userEmail
          }],
          propertyId: String(property._id),
          isManaged: true
        });
      }

      (building as any).updatedDate = new Date();
      await building!.save();

      createdBuildings.push(building.toObject());

      // Recompute rents for existing tenants whose share may have changed
      // (e.g. equal allocation denominator increased with new units)
      const managedPropertyIds = (building as any).units
        .filter((u: any) => u.isManaged && u.propertyId)
        .map((u: any) => String(u.propertyId));

      for (const propId of managedPropertyIds) {
        await _recomputeTenantsForProperty(realm!._id, propId);
      }
    }

    const result = await _toBuildingData(realm!._id, createdBuildings);
    return res.json({ created: true, buildings: result });
  }

  // Return preview
  return res.json({ preview: true, ...preview });
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export async function addUnit(req: Req, res: Res) {
  const realm = req.realm;
  const { id } = req.params;

  if (!req.body.atakNumber?.trim()) {
    throw new ServiceError('Unit ATAK number is missing', 422);
  }

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const existingUnit = (building as any).units.find(
    (u: any) => u.atakNumber === req.body.atakNumber
  );
  if (existingUnit) {
    throw new ServiceError(
      'Unit with this ATAK number already exists in building',
      422
    );
  }
  (building as any).units.push(req.body);
  (building as any).updatedDate = new Date();
  await building!.save();

  // Link property if propertyId provided
  if (req.body.propertyId) {
    await Collections.Property.findOneAndUpdate(
      { _id: req.body.propertyId, realmId: realm!._id },
      { buildingId: id }
    );
    await _recomputeTenantsForProperty(realm!._id, req.body.propertyId);
  }

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

export async function updateUnit(req: Req, res: Res) {
  const realm = req.realm;
  const { id, unitId } = req.params;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const unit = (building as any).units.id(unitId);
  if (!unit) {
    throw new ServiceError('Unit does not exist', 404);
  }

  const oldPropertyId = unit.propertyId;
  unit.set(req.body);
  (building as any).updatedDate = new Date();
  await building!.save();

  // Update property links if propertyId changed
  if (oldPropertyId && oldPropertyId !== req.body.propertyId) {
    await Collections.Property.findOneAndUpdate(
      { _id: oldPropertyId, realmId: realm!._id },
      { $unset: { buildingId: '' } }
    );
  }
  if (req.body.propertyId) {
    await Collections.Property.findOneAndUpdate(
      { _id: req.body.propertyId, realmId: realm!._id },
      { buildingId: id }
    );
  }

  // Recompute rents for affected tenants
  if (req.body.propertyId) {
    await _recomputeTenantsForProperty(realm!._id, req.body.propertyId);
  }
  if (oldPropertyId && String(oldPropertyId) !== String(req.body.propertyId)) {
    await _recomputeTenantsForProperty(realm!._id, String(oldPropertyId));
  }

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

export async function removeUnit(req: Req, res: Res) {
  const realm = req.realm;
  const { id, unitId } = req.params;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const unit = (building as any).units.id(unitId);
  if (!unit) {
    throw new ServiceError('Unit does not exist', 404);
  }

  if (unit.propertyId) {
    const tenants = await Collections.Tenant.find({
      realmId: realm!._id,
      'properties.propertyId': unit.propertyId
    }).lean();

    if ((tenants as any[]).length) {
      throw new ServiceError(
        'Unit cannot be removed because it has active tenants',
        422
      );
    }

    await Collections.Property.findOneAndUpdate(
      { _id: unit.propertyId, realmId: realm!._id },
      { $unset: { buildingId: '' } }
    );
  }

  (building as any).units.pull(unit._id);
  (building as any).updatedDate = new Date();
  await building!.save();

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

// ---------------------------------------------------------------------------
// Monthly Charges
// ---------------------------------------------------------------------------

export async function addMonthlyCharge(req: Req, res: Res) {
  const realm = req.realm;
  const { id, unitId } = req.params;

  if (req.body.amount == null) {
    throw new ServiceError('Charge amount is required', 422);
  }

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const unit = (building as any).units.id(unitId);
  if (!unit) {
    throw new ServiceError('Unit does not exist', 404);
  }

  unit.monthlyCharges.push(req.body);
  (building as any).updatedDate = new Date();
  await building!.save();

  if (unit.propertyId) {
    await _recomputeTenantsForProperty(realm!._id, String(unit.propertyId));
  }

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

export async function updateMonthlyCharge(req: Req, res: Res) {
  const realm = req.realm;
  const { id, unitId, chargeId } = req.params;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const unit = (building as any).units.id(unitId);
  if (!unit) {
    throw new ServiceError('Unit does not exist', 404);
  }

  const charge = unit.monthlyCharges.id(chargeId);
  if (!charge) {
    throw new ServiceError('Monthly charge does not exist', 404);
  }

  charge.set(req.body);
  (building as any).updatedDate = new Date();
  await building!.save();

  if (unit.propertyId) {
    await _recomputeTenantsForProperty(realm!._id, String(unit.propertyId));
  }

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

export async function removeMonthlyCharge(req: Req, res: Res) {
  const realm = req.realm;
  const { id, unitId, chargeId } = req.params;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const unit = (building as any).units.id(unitId);
  if (!unit) {
    throw new ServiceError('Unit does not exist', 404);
  }

  const charge = unit.monthlyCharges.id(chargeId);
  if (!charge) {
    throw new ServiceError('Monthly charge does not exist', 404);
  }

  unit.monthlyCharges.pull(charge._id);
  (building as any).updatedDate = new Date();
  await building!.save();

  if (unit.propertyId) {
    await _recomputeTenantsForProperty(realm!._id, String(unit.propertyId));
  }

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

// ---------------------------------------------------------------------------
// Monthly Statement (batch distribution of expenses to units for a given month)
// ---------------------------------------------------------------------------

export async function saveMonthlyStatement(req: Req, res: Res) {
  const realm = req.realm;
  const { id } = req.params;
  const { term, expenses: expenseEntries } = req.body;

  if (!term) {
    throw new ServiceError('Term (YYYYMMDDHH) is required', 422);
  }
  if (!expenseEntries || !Array.isArray(expenseEntries) || expenseEntries.length === 0) {
    throw new ServiceError('Expenses array is required', 422);
  }

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const units = (building as any).units;
  if (!units.length) {
    throw new ServiceError('Building has no units', 422);
  }

  // For each unit, remove existing monthly charges for this term, then add new ones
  for (const unit of units) {
    if (!unit.propertyId) continue;

    // Remove existing charges for this term
    const idsToRemove = unit.monthlyCharges.filter(
      (c: any) => c.term === Number(term)
    ).map((c: any) => c._id);
    for (const chargeId of idsToRemove) {
      unit.monthlyCharges.pull(chargeId);
    }

    // Compute and add new charges for each expense
    for (const entry of expenseEntries) {
      if (!entry.amount || entry.amount <= 0) continue;

      // Find the building expense to get its allocation method
      const buildingExpense = (building as any).expenses.id(entry.expenseId);
      const allocationMethod = entry.allocationMethod || buildingExpense?.allocationMethod || 'equal';
      const description = entry.description || buildingExpense?.name || 'Building charge';

      // Compute share for this unit
      const share = computeBuildingChargeForProperty(
        (building as any).toObject(),
        String(unit.propertyId),
        { ...buildingExpense?.toObject?.() || {}, amount: entry.amount, allocationMethod }
      );

      if (share > 0) {
        unit.monthlyCharges.push({
          term: Number(term),
          amount: Math.round(share * 100) / 100,
          description,
          expenseId: entry.expenseId
        });
      }
    }
  }

  (building as any).updatedDate = new Date();
  await building!.save();

  // Recompute rents for all tenants linked to this building
  const propertyIds = units
    .filter((u: any) => u.propertyId)
    .map((u: any) => String(u.propertyId));
  for (const propId of propertyIds) {
    await _recomputeTenantsForProperty(realm!._id, propId);
  }

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export async function addExpense(req: Req, res: Res) {
  const realm = req.realm;
  const { id } = req.params;

  if (!req.body.name?.trim()) {
    throw new ServiceError('Expense name is required', 422);
  }

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  (building as any).expenses.push(req.body);
  (building as any).updatedDate = new Date();
  await building!.save();

  // Recompute rents for all tenants linked to this building
  const propertyIds = (building as any).units
    .filter((u: any) => u.propertyId)
    .map((u: any) => String(u.propertyId));
  for (const propId of propertyIds) {
    await _recomputeTenantsForProperty(realm!._id, propId);
  }

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

export async function updateExpense(req: Req, res: Res) {
  const realm = req.realm;
  const { id, expenseId } = req.params;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const expense = (building as any).expenses.id(expenseId);
  if (!expense) {
    throw new ServiceError('Expense does not exist', 404);
  }

  expense.set(req.body);
  (building as any).updatedDate = new Date();
  await building!.save();

  // Recompute rents for all tenants linked to this building
  const propertyIds = (building as any).units
    .filter((u: any) => u.propertyId)
    .map((u: any) => String(u.propertyId));
  for (const propId of propertyIds) {
    await _recomputeTenantsForProperty(realm!._id, propId);
  }

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

export async function removeExpense(req: Req, res: Res) {
  const realm = req.realm;
  const { id, expenseId } = req.params;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const expense = (building as any).expenses.id(expenseId);
  if (!expense) {
    throw new ServiceError('Expense does not exist', 404);
  }

  (building as any).expenses.pull(expense._id);
  (building as any).updatedDate = new Date();
  await building!.save();

  // Recompute rents for all tenants linked to this building
  const propertyIds = (building as any).units
    .filter((u: any) => u.propertyId)
    .map((u: any) => String(u.propertyId));
  for (const propId of propertyIds) {
    await _recomputeTenantsForProperty(realm!._id, propId);
  }

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

// ---------------------------------------------------------------------------
// Contractors
// ---------------------------------------------------------------------------

export async function addContractor(req: Req, res: Res) {
  const realm = req.realm;
  const { id } = req.params;

  if (!req.body.name?.trim()) {
    throw new ServiceError('Contractor name is required', 422);
  }

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  (building as any).contractors.push(req.body);
  (building as any).updatedDate = new Date();
  await building!.save();

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

export async function updateContractor(req: Req, res: Res) {
  const realm = req.realm;
  const { id, contractorId } = req.params;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const contractor = (building as any).contractors.id(contractorId);
  if (!contractor) {
    throw new ServiceError('Contractor does not exist', 404);
  }

  contractor.set(req.body);
  (building as any).updatedDate = new Date();
  await building!.save();

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

export async function removeContractor(req: Req, res: Res) {
  const realm = req.realm;
  const { id, contractorId } = req.params;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const hasRepairs = (building as any).repairs.some(
    (r: any) => r.contractorId === contractorId
  );

  if (hasRepairs) {
    throw new ServiceError(
      'Contractor cannot be removed because they are linked to repairs',
      422
    );
  }

  const contractor = (building as any).contractors.id(contractorId);
  if (!contractor) {
    throw new ServiceError('Contractor does not exist', 404);
  }

  (building as any).contractors.pull(contractor._id);
  (building as any).updatedDate = new Date();
  await building!.save();

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

// ---------------------------------------------------------------------------
// Repairs
// ---------------------------------------------------------------------------

async function _distributeRepairCharge(
  building: any,
  repair: any,
  realmId: string
): Promise<void> {
  if (!repair.chargeableTo || repair.chargeableTo === 'owners') return;
  if (!repair.chargeTerm) return;

  const cost = repair.actualCost || repair.estimatedCost || 0;
  if (cost <= 0) return;

  const sharePercentage = repair.chargeableTo === 'tenants'
    ? 100
    : (repair.tenantSharePercentage || 0);
  if (sharePercentage <= 0) return;

  const effectiveAmount = cost * (sharePercentage / 100);
  const allocationMethod = repair.allocationMethod || 'general_thousandths';
  const term = Number(repair.chargeTerm);

  const buildingObj = building.toObject ? building.toObject() : building;

  for (const unit of building.units) {
    if (!unit.propertyId) continue;

    const share = computeBuildingChargeForProperty(
      buildingObj,
      String(unit.propertyId),
      { amount: effectiveAmount, allocationMethod, name: repair.title } as any
    );

    if (share > 0) {
      // Remove any existing charge for this repair+term combo
      const existingIdx = unit.monthlyCharges.findIndex(
        (c: any) => c.term === term && c.description === `Repair: ${repair.title}`
      );
      if (existingIdx >= 0) {
        unit.monthlyCharges.pull(unit.monthlyCharges[existingIdx]._id);
      }

      unit.monthlyCharges.push({
        term,
        amount: Math.round(share * 100) / 100,
        description: `Repair: ${repair.title}`
      });
    }
  }

  building.updatedDate = new Date();
  await building.save();

  // Recompute rents
  const propertyIds = building.units
    .filter((u: any) => u.propertyId)
    .map((u: any) => String(u.propertyId));
  for (const propId of propertyIds) {
    await _recomputeTenantsForProperty(realmId, propId);
  }
}

export async function addRepair(req: Req, res: Res) {
  const realm = req.realm;
  const { id } = req.params;

  if (!req.body.title?.trim()) {
    throw new ServiceError('Repair title is required', 422);
  }

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  (building as any).repairs.push(req.body);
  (building as any).updatedDate = new Date();
  await building!.save();

  // Distribute repair cost to tenants if chargeable
  const newRepair = (building as any).repairs[(building as any).repairs.length - 1];
  await _distributeRepairCharge(building as any, newRepair, realm!._id);

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

export async function updateRepair(req: Req, res: Res) {
  const realm = req.realm;
  const { id, repairId } = req.params;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const repair = (building as any).repairs.id(repairId);
  if (!repair) {
    throw new ServiceError('Repair does not exist', 404);
  }

  repair.set(req.body);
  (building as any).updatedDate = new Date();
  await building!.save();

  // Re-distribute repair cost
  await _distributeRepairCharge(building as any, repair, realm!._id);

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}

export async function removeRepair(req: Req, res: Res) {
  const realm = req.realm;
  const { id, repairId } = req.params;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const repair = (building as any).repairs.id(repairId);
  if (!repair) {
    throw new ServiceError('Repair does not exist', 404);
  }

  (building as any).repairs.pull(repair._id);
  (building as any).updatedDate = new Date();
  await building!.save();

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}
