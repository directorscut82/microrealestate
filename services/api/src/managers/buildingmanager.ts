import { Collections, ServiceError } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import { parseE9 } from './e9parser.js';
import type { ParsedE9Unit } from './e9parser.js';

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
  // Ground floor (0) in Greece is often commercial
  // But we default to apartment since E9 doesn't carry explicit type
  if (unit.floor === 0) return 'store';
  if (unit.floor !== null && unit.floor < 0) return 'parking';
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
  const building = new Collections.Building({
    ...req.body,
    realmId: realm!._id,
    createdDate: now,
    updatedDate: now
  });
  await building.save();

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
    { ...req.body, updatedDate: new Date() },
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
        // Check if building already exists
        const existing = await Collections.Building.findOne({
          realmId: realm!._id,
          atakPrefix: building.atakPrefix
        }).lean();

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

    // Resolve member ID from user email for ownership
    const userEmail = (req as any).user?.email;
    const memberId = _findMemberIdByEmail(realm, userEmail);

    for (const buildingData of parsed.buildings) {
      // Check if building exists
      let building = await Collections.Building.findOne({
        realmId: realm!._id,
        atakPrefix: buildingData.atakPrefix
      });

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
        // Check if unit already exists in building (by ATAK)
        const existingUnit = (building as any).units.find(
          (u: any) => u.atakNumber === parsedUnit.atakNumber
        );
        if (existingUnit) continue;

        // Find or create the Property record
        let property = await Collections.Property.findOne({
          realmId: realm!._id,
          atakNumber: parsedUnit.atakNumber
        });

        if (!property) {
          property = await Collections.Property.create({
            realmId: realm!._id,
            name: `${parsedUnit.street} ${parsedUnit.streetNumber} - ${parsedUnit.floor != null ? 'Όροφος ' + parsedUnit.floor : 'Ισόγειο'}`,
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

  unit.deleteOne();
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

  charge.deleteOne();
  (building as any).updatedDate = new Date();
  await building!.save();

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

  expense.deleteOne();
  (building as any).updatedDate = new Date();
  await building!.save();

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

  contractor.deleteOne();
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

  repair.deleteOne();
  (building as any).updatedDate = new Date();
  await building!.save();

  const result = await _toBuildingData(realm!._id, [
    building!.toObject()
  ]);
  return res.json(result[0]);
}
