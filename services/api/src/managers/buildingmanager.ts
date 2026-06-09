import { Collections, logger, ServiceError } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import type { CollectionTypes } from '@microrealestate/types';
import { parseE9 } from './e9parser.js';
import * as Contract from './contract.js';
import { _attachTenantGroupsToBuildings } from './occupantmanager.js';
import {
  validateObjectId,
  validateTerm,
  validateFiniteNumber,
  validateStringField,
  validateEnum,
  validateArrayMaxLength,
  validateAllocationValues,
  validatePercentageAllocations,
  validateRatioAllocations,
  isValidGreekPostalCode,
  isValidIBAN,
  EXPENSE_TYPES,
  ALLOCATION_METHODS,
  REPAIR_STATUSES,
  CHARGEABLE_TO
} from '../validators.js';
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

  // Fetch tenants linked to these properties for occupant info
  const tenants = propertyIds.length
    ? await Collections.Tenant.find(
        {
          realmId,
          'properties.propertyId': { $in: propertyIds }
        },
        { name: 1, properties: 1 }
      ).lean()
    : [];

  const tenantByPropertyId = new Map<string, { _id: string; name: string }>();
  for (const tenant of tenants as any[]) {
    for (const tp of tenant.properties || []) {
      if (tp.propertyId) {
        tenantByPropertyId.set(String(tp.propertyId), {
          _id: String(tenant._id),
          name: tenant.name
        });
      }
    }
  }

  return buildings.map((building: any) => {
    const units = (building.units || []).map((unit: any) => ({
      ...unit,
      property: unit.propertyId ? propMap.get(String(unit.propertyId)) : null,
      tenant: unit.propertyId
        ? tenantByPropertyId.get(String(unit.propertyId)) || null
        : null
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

function _findBuilding(building: any, _id: string) {
  if (!building) {
    throw new ServiceError('Building does not exist', 404);
  }
  return building;
}

// Audit B3: Optimistic concurrency wrapper for building.save(). The
// schema (collections/building.ts) now sets optimisticConcurrency:true
// so Mongoose bumps __v on every save and throws VersionError when the
// document was modified between findOne and save. Surface that as a
// 409 ("Building was modified concurrently. Please retry.") instead of
// letting one writer silently overwrite the other or leaking a generic
// 500. Mirrors realmmanager.ts:430-443.
async function _saveBuildingWithVersionCheck(b: any): Promise<void> {
  try {
    await b.save();
  } catch (err: any) {
    if (err && err.name === 'VersionError') {
      throw new ServiceError(
        'Building was modified concurrently. Please retry.',
        409
      );
    }
    throw err;
  }
}

// Wave-18 B5: validate that every customAllocations[].propertyId references
// a unit that belongs to this building, and that custom_percentage shares
// sum to 100 (±0.01 tolerance). Without this guard, an expense saved with
// a foreign / non-existent propertyId silently produces a dead allocation
// that never bills anyone.
function _assertCustomAllocationPropertyIds(
  building: any,
  customAllocations: any,
  allocationMethod: string | undefined
): void {
  if (!Array.isArray(customAllocations) || customAllocations.length === 0) return;
  const allocationKinds = new Set([
    'custom_percentage',
    'custom_ratio',
    'fixed'
  ]);
  if (!allocationMethod || !allocationKinds.has(allocationMethod)) return;

  const validPropIds = new Set(
    ((building?.units || []) as any[])
      .map((u) => (u.propertyId ? String(u.propertyId) : ''))
      .filter(Boolean)
  );

  customAllocations.forEach((a: any, i: number) => {
    if (!a?.propertyId) return;
    if (!validPropIds.has(String(a.propertyId))) {
      throw new ServiceError(
        `customAllocations[${i}].propertyId is not in this building`,
        422
      );
    }
  });
}

// See businesslogic/inferPropertyType.ts for the documented mapping.
// Re-exported here so external call sites continue to import from
// './buildingmanager.js' if they were already doing so.
import { inferPropertyType as _inferPropertyType } from '../businesslogic/inferPropertyType.js';
export { _inferPropertyType };

// Find the realm member ID for a given email
function _findMemberIdByEmail(realm: any, email: string): string | undefined {
  if (!realm?.members) return undefined;
  const member = (realm.members as any[]).find((m: any) => m.email === email);
  return member ? String(member._id) : undefined;
}

// L14: Greek-aware string normaliser used to match a manually-created
// building against an E9-parsed street1 even when one side is in
// uppercase polytonic Greek (E9 source) and the other is in mixed
// case with diacritics (manual entry). The normalised form is used
// for lookup ONLY — never persisted, so existing records keep their
// original casing/accents. NFKD + lower + diacritic strip is the
// standard Unicode-aware approach.
function _greekNormalize(s: string | undefined | null): string {
  if (!s) return '';
  return String(s)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// L2: locale-aware floor label. The E9 importer previously hardcoded
// the Greek labels (Ισόγειο / Υπόγειο / Όροφος) into the Property name.
// For non-Greek realms (e.g. fr-FR or en realms re-importing an E9 from
// a Greek property they manage) that produced names that mixed Greek
// labels with the rest of the UI's locale. Read realm.locale and emit
// the localised label when we have a translation, falling back to the
// Greek default so existing data remains stable.
function _floorLabel(
  floor: number | null | undefined,
  realm: any
): string {
  const isBasement = floor != null && floor < 0;
  const isGround = floor == null || floor === 0;
  const locale = (realm && realm.locale) || 'el';

  // The labels mirror the Basement / Ground floor / Floor entries that
  // already live in webapps/landlord/locales/<lang>/common.json. Keep
  // the table small and additive — drift between server and client
  // locales is not worth dragging in a full i18n stack server-side.
  const TABLE: Record<string, { ground: string; basement: string; floor: string }> =
    {
      el: { ground: 'Ισόγειο', basement: 'Υπόγειο', floor: 'Όροφος' },
      en: { ground: 'Ground floor', basement: 'Basement', floor: 'Floor' },
      'fr-FR': {
        ground: 'Rez-de-chaussée',
        basement: 'Sous-sol',
        floor: 'Étage'
      },
      'de-DE': {
        ground: 'Erdgeschoss',
        basement: 'Keller',
        floor: 'Stockwerk'
      },
      'es-CO': {
        ground: 'Planta baja',
        basement: 'Sótano',
        floor: 'Piso'
      },
      'pt-BR': { ground: 'Térreo', basement: 'Porão', floor: 'Andar' }
    };
  const entry = TABLE[locale] || TABLE['el'];
  if (isGround) return entry.ground;
  if (isBasement) return entry.basement;
  return `${entry.floor} ${floor}`;
}

// Wave-26 round-3u: optimistic-concurrency wrapper for the rent-recompute
// writes triggered by building expense / property edits. Without this,
// _recomputeTenantsForBuilding / _recomputeTenantsForProperty would do
// `Tenant.updateOne({_id}, {rents: ...})` blindly. If a concurrent payment
// PATCH (rentmanager._updateByTerm) was running on the same tenant, the
// recompute write would overwrite the just-saved payment-derived state
// with a snapshot taken before the payment landed — leaving total.grandTotal
// permanently inconsistent with the rent's input arrays (PRIFTI June 2026
// drift incident). The retry loop reads tenant + buildings + properties
// fresh on each attempt so the recompute uses the latest rent state.
// Wave-26 round-3v: 5→8 attempts with EXPONENTIAL backoff. The original
// linear "25 * attempt" budget peaked at 125ms — short enough that a slow
// rentmanager._updateByTerm could exhaust all 5 retries before the racing
// payment write committed. The new schedule (50, 100, 200, 400, 800, 800,
// 800, 800 ms) gives ~3.95s of total wait before giving up, which covers
// the worst observed payment-PATCH durations on NAS.
const RECOMPUTE_MAX_ATTEMPTS = 8;

function _recomputeBackoffMs(attempt: number): number {
  return Math.min(50 * Math.pow(2, attempt - 1), 800);
}

async function _saveRecomputedRentsWithRetry(
  realmId: string,
  tenantId: string,
  expectedVersion: number,
  newRents: any[]
): Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'notfound' }> {
  // realmId is part of the filter so a stale tenantId from a different
  // realm can never get its rents overwritten by this realm's recompute.
  // Same scoping discipline as the rest of the multi-tenant query layer.
  const result = await Collections.Tenant.findOneAndUpdate(
    { _id: tenantId, realmId, __v: expectedVersion },
    { $set: { rents: newRents }, $inc: { __v: 1 } },
    { new: true }
  ).lean();
  if (!result) {
    // Distinguish: did the document disappear, or did __v move?
    const exists = await Collections.Tenant.findOne(
      { _id: tenantId, realmId },
      { _id: 1 }
    ).lean();
    return { ok: false, reason: exists ? 'conflict' : 'notfound' };
  }
  return { ok: true };
}

async function _recomputeTenantsForProperty(
  realmId: string,
  propertyId: string
): Promise<void> {
  const tenants = await Collections.Tenant.find({
    realmId,
    'properties.propertyId': propertyId
  });
  if (!tenants.length) return;

  const recomputeOne = async (tenantInitial: any) => {
    for (let attempt = 1; attempt <= RECOMPUTE_MAX_ATTEMPTS; attempt++) {
      // Re-read the tenant on every attempt so the recompute is based on
      // the latest rent state (in particular, latest payments). Without the
      // re-read, attempt N would keep producing the same stale rents[] and
      // every retry would lose the same race.
      const fresh =
        attempt === 1
          ? tenantInitial
          : await Collections.Tenant.findOne({
              _id: tenantInitial._id,
              realmId
            });
      if (!fresh) return;
      const tenantObj: any = fresh.toObject ? fresh.toObject() : fresh;
      if (!tenantObj.beginDate || !tenantObj.endDate) {
        // PII: don't log tenant.name. Tenant id is enough to correlate
        // the audit trail without leaking PII into log-aggregation.
        logger.warn(
          `_recomputeTenantsForProperty: skipped tenant ${tenantObj._id}: missing beginDate/endDate`
        );
        return;
      }
      if (!tenantObj.properties?.length) return;
      const propertyIds = tenantObj.properties
        .map((p: any) => p.propertyId)
        .filter(Boolean);
      const properties = await Collections.Property.find({
        realmId,
        _id: { $in: propertyIds }
      }).lean();
      const propMap = properties.reduce((acc: any, p: any) => {
        acc[String(p._id)] = p;
        return acc;
      }, {});
      tenantObj.properties.forEach((p: any) => {
        p.property = propMap[String(p.propertyId)] || p.property;
      });
      const buildings: CollectionTypes.Building[] =
        (await Collections.Building.find({
          realmId,
          'units.propertyId': { $in: propertyIds }
        }).lean()) as CollectionTypes.Building[];
      await _attachTenantGroupsToBuildings(realmId, buildings as any[]);
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
        const saveResult = await _saveRecomputedRentsWithRetry(
          realmId,
          String(tenantObj._id),
          Number(tenantObj.__v) || 0,
          updated.rents
        );
        if (saveResult.ok) {
          logger.info(
            `Recomputed rents for tenant ${tenantObj._id} (property ${propertyId})`
          );
          return;
        }
        if (saveResult.reason === 'notfound') return;
        // conflict — exponential backoff so the racing writer can finish
        await new Promise((r) => setTimeout(r, _recomputeBackoffMs(attempt)));
      } catch (error) {
        logger.error(
          `Failed to recompute rents for tenant ${tenantObj._id}: ${error}`
        );
        return;
      }
    }
    logger.error(
      'Failed to recompute rents for tenant after exhausting version-conflict retries (property scope)',
      {
        tenantId: String(tenantInitial._id),
        realmId,
        propertyId,
        finalAttempt: RECOMPUTE_MAX_ATTEMPTS
      }
    );
  };

  await Promise.all(tenants.map(recomputeOne));
}

// Wave-14 F6: recompute rents for every tenant linked to ANY managed unit
// of a building, deduped. Building-expense edits (add/update/remove) must
// produce a deterministic forward-looking recompute for all tenants — the
// per-property loop previously used here ran once per propertyId and
// could leave some tenants out-of-sync when the in-memory building state
// drifted between sequential calls. The freeze logic in contract.ts
// protects already-paid historical rents.
async function _recomputeTenantsForBuilding(
  realmId: string,
  building: any
): Promise<void> {
  const propertyIds = ((building as any)?.units || [])
    .filter((u: any) => u.propertyId)
    .map((u: any) => String(u.propertyId));
  if (!propertyIds.length) return;

  const tenants = await Collections.Tenant.find({
    realmId,
    'properties.propertyId': { $in: propertyIds }
  }).lean();
  if (!tenants.length) return;

  // Dedupe by tenant _id so a tenant linked to multiple managed units of
  // this building is recomputed exactly once.
  const seen = new Set<string>();
  const unique: any[] = [];
  for (const t of tenants) {
    const id = String(t._id);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(t);
  }

  for (const tenantInitial of unique) {
    const initialId = String((tenantInitial as any)._id);
    let saved = false;
    for (let attempt = 1; attempt <= RECOMPUTE_MAX_ATTEMPTS; attempt++) {
      // Re-read the tenant on every attempt so the recompute is based on
      // the latest rent state (esp. latest payments). Without this re-read
      // a __v conflict retry would just re-emit the same stale rents[].
      const fresh =
        attempt === 1
          ? tenantInitial
          : ((await Collections.Tenant.findOne({
              _id: initialId,
              realmId
            }).lean()) as any);
      if (!fresh) {
        saved = true;
        break;
      }
      const tenantObj: any = fresh;
      if (!tenantObj.beginDate || !tenantObj.endDate) {
        // PII: don't log tenant.name. Tenant id is enough to correlate
        // the audit trail without leaking PII into log-aggregation.
        logger.warn(
          `_recomputeTenantsForBuilding: skipped tenant ${tenantObj._id}: missing beginDate/endDate`
        );
        saved = true;
        break;
      }
      if (!tenantObj.properties?.length) {
        saved = true;
        break;
      }
      const tenantPropIds = tenantObj.properties
        .map((p: any) => p.propertyId)
        .filter(Boolean);
      const properties = await Collections.Property.find({
        realmId,
        _id: { $in: tenantPropIds }
      }).lean();
      const propMap = properties.reduce((acc: any, p: any) => {
        acc[String(p._id)] = p;
        return acc;
      }, {});
      tenantObj.properties.forEach((p: any) => {
        p.property = propMap[String(p.propertyId)] || p.property;
      });
      const buildings: CollectionTypes.Building[] =
        (await Collections.Building.find({
          realmId,
          'units.propertyId': { $in: tenantPropIds }
        }).lean()) as CollectionTypes.Building[];
      await _attachTenantGroupsToBuildings(realmId, buildings as any[]);
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
        const saveResult = await _saveRecomputedRentsWithRetry(
          realmId,
          String(tenantObj._id),
          Number(tenantObj.__v) || 0,
          updated.rents
        );
        if (saveResult.ok) {
          logger.info(
            `Recomputed rents for tenant ${tenantObj._id} (building ${building._id})`
          );
          saved = true;
          break;
        }
        if (saveResult.reason === 'notfound') {
          saved = true;
          break;
        }
        await new Promise((r) => setTimeout(r, _recomputeBackoffMs(attempt)));
      } catch (error) {
        logger.error(
          `Failed to recompute rents for tenant ${tenantObj._id}: ${error}`
        );
        saved = true;
        break;
      }
    }
    if (!saved) {
      logger.error(
        'Failed to recompute rents for tenant after exhausting version-conflict retries (building scope)',
        {
          tenantId: initialId,
          realmId,
          buildingId: String(building._id),
          finalAttempt: RECOMPUTE_MAX_ATTEMPTS
        }
      );
    }
  }
}

// Recompute rents for all tenants that use a specific property

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

  const buildings = await _toBuildingData(realm!._id, dbBuildings as any[]);
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
  // Wave-21 C30-B5: strip server-owned identity fields from the payload.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id: _ignoredId, __v: _ignoredV, realmId: _ignoredRealmId, ...rest } = req.body || {};
  req.body = rest;
  if (!req.body.name?.trim()) {
    throw new ServiceError('Building name is missing', 422);
  }
  if (!req.body.atakPrefix?.trim()) {
    throw new ServiceError('ATAK prefix is missing', 422);
  }

  // Tier A3 — Building minimum-required at creation. Address fields
  // (street1 + city + zipCode) become required so PDF receipts (which
  // render the building address as the property's address fallback),
  // E9 cross-reference, and the dashboard tile have something to show.
  // The E9 import path creates Buildings directly via
  // `new Collections.Building({...})` without going through this route
  // and always carries the parsed address; imports remain unaffected.
  // Units/manager/bankInfo intentionally stay optional — a building
  // without those is allowed and surfaces an "Ελλειπή στοιχεία" warning
  // on the tile (Tier B9), not a creation block.
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
  validateFiniteNumber(req.body.yearBuilt, 'yearBuilt', {
    min: 1800,
    max: 2099
  });
  validateFiniteNumber(req.body.totalFloors, 'totalFloors', {
    min: 1,
    max: 200
  });
  if (req.body.heatingType !== undefined && req.body.heatingType !== '') {
    validateEnum(
      req.body.heatingType,
      ['central_oil', 'central_gas', 'autonomous', 'none'] as const,
      'heatingType'
    );
  }
  validateArrayMaxLength(req.body.units, 200, 'units');
  validateArrayMaxLength(req.body.expenses, 100, 'expenses');
  validateArrayMaxLength(req.body.contractors, 50, 'contractors');
  validateArrayMaxLength(req.body.repairs, 100, 'repairs');

  // Tier C3 — IBAN structural validation when present. bankInfo is
  // optional at creation per the user matrix; if the user provides one
  // it must be well-formed (mod-97 == 1).
  const iban = req.body?.bankInfo?.iban;
  if (typeof iban === 'string' && iban.trim() && !isValidIBAN(iban.trim())) {
    throw new ServiceError('bankInfo.iban is not a valid IBAN', 422);
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
    name,
    description,
    address,
    blockNumber,
    blockStreets,
    atakPrefix,
    yearBuilt,
    totalFloors,
    hasElevator,
    hasCentralHeating,
    heatingType,
    manager,
    bankInfo,
    units,
    expenses,
    contractors,
    repairs,
    notes
  } = req.body;
  const building = new Collections.Building({
    name,
    description,
    address,
    blockNumber,
    blockStreets,
    atakPrefix,
    yearBuilt,
    totalFloors,
    hasElevator,
    hasCentralHeating,
    heatingType,
    manager,
    bankInfo,
    units: units || [],
    expenses: expenses || [],
    contractors: contractors || [],
    repairs: repairs || [],
    notes,
    realmId: realm!._id,
    createdDate: now,
    updatedDate: now
  });
  await _saveBuildingWithVersionCheck(building);

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

  const buildings = await _toBuildingData(realm!._id, [building.toObject()]);
  return res.json(buildings[0]);
}

export async function update(req: Req, res: Res) {
  const realm = req.realm;

  // Mirror validations from add()
  if (req.body.name !== undefined) {
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
      throw new ServiceError('Building name is missing', 422);
    }
  }
  if (req.body.atakPrefix !== undefined) {
    if (typeof req.body.atakPrefix !== 'string' || !req.body.atakPrefix.trim()) {
      throw new ServiceError('ATAK prefix is missing', 422);
    }
  }
  if (req.body.yearBuilt !== undefined) {
    validateFiniteNumber(req.body.yearBuilt, 'yearBuilt', {
      min: 1800,
      max: 2099
    });
  }
  if (req.body.totalFloors !== undefined) {
    validateFiniteNumber(req.body.totalFloors, 'totalFloors', {
      min: 1,
      max: 200
    });
  }
  if (req.body.heatingType !== undefined && req.body.heatingType !== '') {
    validateEnum(
      req.body.heatingType,
      ['central_oil', 'central_gas', 'autonomous', 'none'] as const,
      'heatingType'
    );
  }

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
        ...(req.body.description !== undefined && {
          description: req.body.description
        }),
        ...(req.body.address !== undefined && { address: req.body.address }),
        ...(req.body.blockNumber !== undefined && {
          blockNumber: req.body.blockNumber
        }),
        ...(req.body.blockStreets !== undefined && {
          blockStreets: req.body.blockStreets
        }),
        ...(req.body.atakPrefix !== undefined && {
          atakPrefix: req.body.atakPrefix
        }),
        ...(req.body.yearBuilt !== undefined && {
          yearBuilt: req.body.yearBuilt
        }),
        ...(req.body.totalFloors !== undefined && {
          totalFloors: req.body.totalFloors
        }),
        ...(req.body.hasElevator !== undefined && {
          hasElevator: req.body.hasElevator
        }),
        ...(req.body.hasCentralHeating !== undefined && {
          hasCentralHeating: req.body.hasCentralHeating
        }),
        ...(req.body.heatingType !== undefined && {
          heatingType: req.body.heatingType
        }),
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

  // Cascade-delete linked Bill records before the buildings — otherwise
  // bills reference dangling buildingIds.
  // E16: track step-level failure across the (Bill → Building → Property)
  // cascade so partial cleanup is surfaced as a 500 with structured info.
  // The previous code awaited each step in sequence: a failure on the
  // Property.updateMany step (after Building.deleteMany succeeded) would
  // bubble as a 500 with no breakdown of what landed, leaving the
  // operator unable to tell whether the buildings still existed.
  const _failureInfo: Record<string, string> = {};
  try {
    await Collections.Bill.deleteMany({
      realmId: realm!._id,
      buildingId: { $in: ids }
    });
  } catch (e: any) {
    _failureInfo.bills = String(e?.message || e);
  }

  try {
    await Collections.Building.deleteMany({
      _id: { $in: ids },
      realmId: realm!._id
    });
  } catch (e: any) {
    _failureInfo.buildings = String(e?.message || e);
  }

  // Clear buildingId from linked properties
  try {
    await Collections.Property.updateMany(
      { realmId: realm!._id, buildingId: { $in: ids } },
      { $unset: { buildingId: '' } }
    );
  } catch (e: any) {
    _failureInfo.propertyUnlink = String(e?.message || e);
  }

  if (Object.keys(_failureInfo).length > 0) {
    logger.error(
      `building remove partial failure: ${JSON.stringify(_failureInfo)}`
    );
    return res.status(500).json({
      status: 500,
      message:
        'Partial failure deleting building(s). Some related records may not have been cleaned up.',
      failures: _failureInfo
    });
  }

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
    const pdfPromise = getDocument({ data }).promise;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('PDF parsing timed out after 30s')),
        30000
      )
    );
    const doc = await Promise.race([pdfPromise, timeout]);
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      fullText +=
        content.items.map((item: any) => item.str).join(' ') +
        '\n--- PAGE BREAK ---\n';
    }
  } catch (error) {
    throw new ServiceError('Failed to parse PDF file: ' + String(error), 422);
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

  // L6 (run BEFORE L7): empty-PDF check has its own specific message;
  // letting the L7 marker check fire first would short-circuit it with
  // a misleading "does not look like an E9" error.
  if (!text.trim()) {
    throw new ServiceError('E9 PDF appears to be empty', 422);
  }

  // L7: upfront E9 marker sniff. Lease PDFs and other non-E9 documents
  // were previously fed through the full ~3s parser before being
  // rejected with a generic "No buildings found" — confusing UX and
  // wasted CPU on every non-E9 upload. Real AADE-issued PDFs use the
  // genitive case ("ΒΕΒΑΙΩΣΗ ΔΗΛΩΘΕΙΣΑΣ ΠΕΡΙΟΥΣΙΑΚΗΣ ΚΑΤΑΣΤΑΣΗΣ") so we
  // accept any inflected form of ΠΕΡΙΟΥΣΙΑΚ-, plus a bare "Ε9" token
  // (covers "ΕΝΤΥΠΟ Ε9", "ΣΤΟΙΧΕΙΑ Ε9", etc.), plus the canonical AADE
  // form header.
  const E9_MARKERS = [
    /Ε9/,
    /ΠΕΡΙΟΥΣΙΑΚ[ΗΟΩ]Σ?/,
    /ΒΕΒΑΙΩΣΗ ΥΠΟΒΟΛΗΣ ΔΗΛΩΣΗΣ ΣΤΟΙΧΕΙΩΝ ΑΚΙΝΗΤΩΝ/
  ];
  const looksLikeE9 = E9_MARKERS.some((rx) => rx.test(text));
  if (!looksLikeE9) {
    throw new ServiceError(
      'PDF does not look like an E9 declaration (missing Ε9 / ΠΕΡΙΟΥΣΙΑΚ- markers)',
      422
    );
  }

  const parsed = parseE9(text);

  if (!parsed.owner.taxId) {
    throw new ServiceError(
      'Could not parse owner information from E9 PDF',
      422
    );
  }

  // L6 (continued): distinguish no-buildings vs land-plot-only outcomes
  // so the user can tell whether the realm legitimately has nothing to
  // import vs uploaded the wrong file. Without this every failure
  // surfaced as the same generic "No buildings found".
  if (parsed.buildings.length === 0) {
    if (parsed.skippedLandPlots > 0) {
      throw new ServiceError(
        'E9 PDF contains only land plots (ΠΙΝΑΚΑΣ 2). MicroRealEstate manages buildings — nothing to import.',
        422
      );
    }
    throw new ServiceError('No buildings found in E9 PDF', 422);
  }

  // Build preview response
  const previewOwnerName =
    `${parsed.owner.lastName} ${parsed.owner.firstName}`.trim();
  const preview = {
    owner: { ...parsed.owner, name: previewOwnerName },
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
    // T1.P1.19: track per-building outcome so the response reports
    // wasCreated/wasUpdated counts instead of returning created:true on
    // every call (which lies on re-imports that only attached units to
    // existing buildings).
    const perBuildingOutcomes: {
      buildingId: string;
      buildingName: string;
      wasCreated: boolean;
      wasUpdated: boolean;
      unitsAdded: number;
    }[] = [];

    const ownerFullName =
      `${parsed.owner.lastName} ${parsed.owner.firstName}`.trim();

    // Resolve member ID from user email for ownership
    const userEmail = (req as any).user?.email;
    const memberId = _findMemberIdByEmail(realm, userEmail);

    // T2.P1.20: opt-in destructive overwrite. Default OFF — server only
    // fills empty fields on existing Property records. With force=true
    // it overwrites electricitySupplyNumber, surface, and the
    // auto-generated name fallback even when the Property already had
    // values. Surfaced via the "Update existing properties" checkbox in
    // ImportE9Dialog preview.
    const forceOverwrite = req.query.force === 'true';

    // T2.P1.6: track every Property and Building this request creates so
    // a mid-batch failure can be rolled back. Without this, a partial
    // import leaves orphaned Property records whose buildingId points at
    // a Building that may not have been finalized — and the user sees a
    // confusing 500 with no way to recover except hand-editing mongo.
    const createdPropertyIds: string[] = [];
    const createdBuildingIds: string[] = [];

    try {
    // L13: mirror the 200-unit cap that addUnit / addBuilding enforce on
    // the manual path. The E9 importer can append to an existing
    // building, so the cap is computed against (existing + incoming)
    // and not against the parsed unit count alone — without this,
    // re-importing a 195-unit building plus 10 new units would silently
    // push the total over the schema limit and trigger downstream
    // ValidationErrors on the next save.
    for (const buildingData of parsed.buildings) {
      const existingForCap = await Collections.Building.findOne({
        realmId: realm!._id,
        'address.street1': buildingData.address.street1
      })
        .select({ units: 1 })
        .lean();
      const existingCount = ((existingForCap as any)?.units || []).length;
      const incomingCount = (buildingData.units || []).length;
      if (existingCount + incomingCount > 200) {
        throw new ServiceError(
          `Too many units in E9 (${existingCount + incomingCount} ≥ 200) for building "${buildingData.address.street1}"`,
          422
        );
      }
    }
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

      // 3. L14: Greek-aware case/accent-insensitive fallback. A user
      // who manually created "Αχαρνών 167" before importing an E9 that
      // declared "ΑΧΑΡΝΩΝ 167" would have those two records treated as
      // separate buildings — silently duplicating the building and
      // splitting unit attachment between the two. Pull every building
      // in the realm and pick the first whose normalised street1
      // matches the parsed street1. This is realm-scoped so it cannot
      // cross tenants.
      if (!building && buildingData.address.street1) {
        const normalisedTarget = _greekNormalize(buildingData.address.street1);
        if (normalisedTarget) {
          const candidates = await Collections.Building.find({
            realmId: realm!._id
          })
            .select({ _id: 1, address: 1 })
            .lean();
          const hit = (candidates as any[]).find(
            (c) =>
              _greekNormalize(c?.address?.street1 || '') === normalisedTarget
          );
          if (hit) {
            building = await Collections.Building.findOne({
              _id: (hit as any)._id,
              realmId: realm!._id
            });
          }
        }
      }

      // NOTE: Do NOT match by ATAK prefix — it's a cadastral area code, not building ID
      // Multiple buildings can share the same prefix (e.g. ΑΧΑΡΝΩΝ 167 and ΚΑΛΑΜΩΝ 24)

      let wasCreated = false;
      let wasUpdated = false;
      let unitsAdded = 0;

      if (!building) {
        // T3.P1.29: derive UI-required fields (totalFloors, hasElevator)
        // from the parsed unit floors so the Edit Building form does not
        // open with two empty mandatory inputs after every E9 import.
        // - totalFloors: max(floor) + abs(min(floor)) + 1, counting any
        //   basement(s) as additional floors. Defaults to undefined when
        //   no unit declared a numeric floor (server schema accepts it
        //   as Number; the form treats undefined as "please fill in").
        // - hasElevator: heuristic — any unit on the 4th floor or above
        //   strongly implies an elevator. User can correct in the form.
        const numericFloors = (buildingData.units || [])
          .map((u: any) => u.floor)
          .filter((f: any) => typeof f === 'number');
        let totalFloors: number | undefined = undefined;
        if (numericFloors.length > 0) {
          const maxF = Math.max(...numericFloors);
          const minF = Math.min(...numericFloors);
          totalFloors = maxF + Math.abs(Math.min(0, minF)) + 1;
        }
        const hasElevator = numericFloors.some((f: number) => f >= 4);
        building = new Collections.Building({
          realmId: realm!._id,
          name: buildingData.address.street1,
          atakPrefix: buildingData.atakPrefix,
          address: buildingData.address,
          blockNumber: buildingData.blockNumber,
          blockStreets: buildingData.blockStreets,
          yearBuilt: buildingData.yearBuilt,
          ...(totalFloors !== undefined && { totalFloors }),
          hasElevator,
          hasCentralHeating: false,
          units: [],
          expenses: [],
          contractors: [],
          repairs: [],
          createdDate: new Date(),
          updatedDate: new Date()
        });
        await _saveBuildingWithVersionCheck(building);
        // T2.P1.6: remember the new building so a downstream failure can
        // delete it during rollback.
        createdBuildingIds.push(String(building._id));
        wasCreated = true;
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
          await _saveBuildingWithVersionCheck(building);
          wasUpdated = true;
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
          // L11: find an existing owner entry by memberId where we
          // have one (most reliable across renames / accent / case),
          // falling back to taxId, then to a string name compare. The
          // pure string-compared name was wrong whenever the realm
          // member's display name drifted from the E9 owner name (e.g.
          // accent-stripped Property records vs. polytonic E9 capture).
          const ownerMemberId = memberId || userEmail;
          const ownerTaxId = (parsed.owner as any).taxId || '';
          const findExistingOwner = (owners: any[]): any =>
            (owners || []).find((o: any) => {
              if (ownerMemberId && o.memberId && o.memberId === ownerMemberId)
                return true;
              if (ownerTaxId && o.taxId && o.taxId === ownerTaxId) return true;
              return o.name === ownerFullName;
            });
          const existingOwner = findExistingOwner(existingUnit.owners);
          if (!existingOwner && existingUnit.owners) {
            existingUnit.owners.push({
              type: 'member',
              name: ownerFullName,
              percentage: parsedUnit.ownershipPercentage,
              memberId: ownerMemberId
            });
          } else if (existingOwner) {
            // L4: year-on-year re-imports may declare a different
            // ownership percentage (transfers, shifts in joint
            // ownership). Keep the latest E9 declaration as the source
            // of truth instead of silently preserving the prior value.
            // Audit log so the change is visible in operator review.
            if (
              typeof parsedUnit.ownershipPercentage === 'number' &&
              parsedUnit.ownershipPercentage !== existingOwner.percentage
            ) {
              logger.info(
                `E9 import: owner ${ownerMemberId || ownerFullName} percentage updated on ATAK ${parsedUnit.atakNumber}: ${existingOwner.percentage} → ${parsedUnit.ownershipPercentage}`
              );
              existingOwner.percentage = parsedUnit.ownershipPercentage;
            }
          }
          continue;
        }

        // 2. By DEH number + floor + surface (same apartment, different owner's ATAK)
        // Must match floor+surface too: different floors sharing one meter are separate units
        const existingByDeh = parsedUnit.electricitySupplyNumber
          ? (building as any).units.find(
              (u: any) =>
                u.electricitySupplyNumber ===
                  parsedUnit.electricitySupplyNumber &&
                u.floor === parsedUnit.floor &&
                u.surface === parsedUnit.surface
            )
          : null;
        if (existingByDeh) {
          // Same apartment, add co-owner.
          // L11: dedupe by memberId/taxId before falling back to name.
          const ownerMemberId = memberId || userEmail;
          const ownerTaxId = (parsed.owner as any).taxId || '';
          const existingOwner = (existingByDeh.owners || []).find((o: any) => {
            if (ownerMemberId && o.memberId && o.memberId === ownerMemberId)
              return true;
            if (ownerTaxId && o.taxId && o.taxId === ownerTaxId) return true;
            return o.name === ownerFullName;
          });
          if (!existingOwner && existingByDeh.owners) {
            existingByDeh.owners.push({
              type: 'member',
              name: ownerFullName,
              percentage: parsedUnit.ownershipPercentage,
              memberId: ownerMemberId
            });
          } else if (existingOwner) {
            // L4: see ATAK-match branch above for rationale.
            if (
              typeof parsedUnit.ownershipPercentage === 'number' &&
              parsedUnit.ownershipPercentage !== existingOwner.percentage
            ) {
              logger.info(
                `E9 import: owner ${ownerMemberId || ownerFullName} percentage updated on DEH-matched ATAK ${parsedUnit.atakNumber}: ${existingOwner.percentage} → ${parsedUnit.ownershipPercentage}`
              );
              existingOwner.percentage = parsedUnit.ownershipPercentage;
            }
          }
          // Store co-owner's ATAK in altAtakNumbers (on building unit and property)
          if (existingByDeh.atakNumber !== parsedUnit.atakNumber) {
            if (!existingByDeh.altAtakNumbers)
              existingByDeh.altAtakNumbers = [];
            if (!existingByDeh.altAtakNumbers.includes(parsedUnit.atakNumber)) {
              existingByDeh.altAtakNumbers.push(parsedUnit.atakNumber);
            }
            // Also update the linked Property record. Realm-scope the
            // updateOne so a smuggled propertyId pointing at another realm's
            // Property cannot have its altAtakNumbers mutated by this E9
            // import.
            if (existingByDeh.propertyId) {
              await Collections.Property.updateOne(
                {
                  _id: existingByDeh.propertyId,
                  realmId: realm!._id
                },
                { $addToSet: { altAtakNumbers: parsedUnit.atakNumber } }
              );
            }
          }
          // L5: when an empty-only field on the matched Property record
          // can be filled from the new E9 row (and the user has not
          // opted into forceOverwrite which is handled in the by-ATAK
          // branch), fill it. Preserves user edits via the empty-only
          // rule from T2.P1.20 — we never overwrite a non-empty value.
          if (existingByDeh.propertyId) {
            const fillSet: Record<string, any> = {};
            if (parsedUnit.surface) fillSet.surface = parsedUnit.surface;
            if (parsedUnit.yearBuilt) fillSet.yearBuilt = parsedUnit.yearBuilt;
            if (parsedUnit.electricitySupplyNumber) {
              fillSet.electricitySupplyNumber =
                parsedUnit.electricitySupplyNumber;
            }
            if ((parsedUnit as any).kaek) {
              fillSet.kaek = (parsedUnit as any).kaek;
            }
            const $or: any[] = Object.keys(fillSet).map((k) => ({
              [k]: { $in: [null, undefined, ''] }
            }));
            // Build per-field empty-only update so we update each
            // field independently and never clobber a populated value.
            for (const k of Object.keys(fillSet)) {
              await Collections.Property.updateOne(
                {
                  _id: existingByDeh.propertyId,
                  realmId: realm!._id,
                  $or: [
                    { [k]: { $exists: false } },
                    { [k]: null },
                    { [k]: '' }
                  ]
                },
                { $set: { [k]: fillSet[k] } }
              );
            }
            // Suppress unused-var warning for $or (built but not used
            // because per-field guard above is more granular).
            void $or;
          }
          continue;
        }

        // Find or create the Property record
        let property = await Collections.Property.findOne({
          realmId: realm!._id,
          atakNumber: parsedUnit.atakNumber
        });

        if (!property) {
          // L16: the partial unique index on (realmId, atakNumber)
          // means a concurrent E9 import (e.g. two browser tabs) racing
          // for the same ATAK would have the second findOne miss and
          // both fall through to create — the loser would surface a
          // raw E11000 as a 500. Catch the duplicate-key, refetch by
          // ATAK, and proceed with the existing record so the user
          // sees the same outcome as a sequential re-import.
          try {
            const computedName = `${parsedUnit.street} ${parsedUnit.streetNumber} - ${_floorLabel(
              parsedUnit.floor,
              realm
            )}`;
            property = await Collections.Property.create({
              realmId: realm!._id,
              name: computedName,
              type: _inferPropertyType({
                category: parsedUnit.category,
                floor: parsedUnit.floor,
                name: computedName
              }),
              surface: parsedUnit.surface,
              atakNumber: parsedUnit.atakNumber,
              // L9: persist the cadastral code when E9 emitted one.
              ...(((parsedUnit as any).kaek)
                ? { kaek: (parsedUnit as any).kaek }
                : {}),
              electricitySupplyNumber: parsedUnit.electricitySupplyNumber,
              buildingId: String(building!._id),
              address: buildingData.address
            });
            // T2.P1.6: track newly-created property so a downstream
            // exception can delete it during rollback.
            createdPropertyIds.push(String(property._id));
          } catch (createErr: any) {
            if (createErr && createErr.code === 11000) {
              property = await Collections.Property.findOne({
                realmId: realm!._id,
                atakNumber: parsedUnit.atakNumber
              });
              if (!property) {
                // The duplicate key existed at write time but the
                // refetch missed — surface the original error so the
                // outer rollback path can clean up.
                throw createErr;
              }
              // Fall into the existing-property branch below — apply
              // the empty-only fills via a synthetic re-entry.
              property.buildingId = String(building!._id) as any;
              if (
                forceOverwrite ||
                !property.electricitySupplyNumber
              ) {
                property.electricitySupplyNumber =
                  parsedUnit.electricitySupplyNumber as any;
              }
              if (parsedUnit.surface && (forceOverwrite || !property.surface)) {
                property.surface = parsedUnit.surface as any;
              }
              if (
                (parsedUnit as any).kaek &&
                (forceOverwrite || !(property as any).kaek)
              ) {
                (property as any).kaek = (parsedUnit as any).kaek;
              }
              await property.save();
            } else {
              throw createErr;
            }
          }
        } else {
          // T2.P1.20: gate destructive writes. Without forceOverwrite we
          // only fill empty fields on an existing Property — preserving
          // user edits (e.g. a hand-corrected DEH supply number) that
          // would otherwise be silently clobbered by every re-import.
          property.buildingId = String(building!._id) as any;
          if (
            forceOverwrite ||
            !property.electricitySupplyNumber
          ) {
            property.electricitySupplyNumber =
              parsedUnit.electricitySupplyNumber as any;
          }
          // Fix name if it's still just an ATAK number (from lease import)
          // OR if force-overwriting (user opted in to refresh from E9).
          // L2: read realm.locale so non-Greek realms get a localised
          // label instead of always falling back to Greek strings.
          const floorLabel = _floorLabel(parsedUnit.floor, realm);
          if (/^\d{11}$/.test(property.name) || forceOverwrite) {
            property.name =
              `${parsedUnit.street} ${parsedUnit.streetNumber} - ${floorLabel}` as any;
          }
          if (parsedUnit.surface && (forceOverwrite || !property.surface)) {
            property.surface = parsedUnit.surface as any;
          }
          // L9: backfill kaek when E9 emitted one and the existing
          // Property record does not have it (or force-overwriting).
          if (
            (parsedUnit as any).kaek &&
            (forceOverwrite || !(property as any).kaek)
          ) {
            (property as any).kaek = (parsedUnit as any).kaek;
          }
          await property.save();
        }

        // T2.P1.4: include any co-owner triplets the parser detected as
        // additional `external` owners. They carry the AFM emitted by
        // E9 but no realm member is associated yet — a follow-up flow
        // can reconcile them to realm members by taxId.
        const owners: any[] = [
          {
            type: 'member',
            name: ownerFullName,
            percentage: parsedUnit.ownershipPercentage,
            memberId: memberId || userEmail
          }
        ];
        for (const co of (parsedUnit as any).coOwners || []) {
          owners.push({
            type: 'external',
            name: co.taxId ? `ΑΦΜ ${co.taxId}` : 'Co-owner',
            percentage: co.percentage,
            taxId: co.taxId || undefined
          });
        }
        (building as any).units.push({
          atakNumber: parsedUnit.atakNumber,
          floor: parsedUnit.floor,
          surface: parsedUnit.surface,
          yearBuilt: parsedUnit.yearBuilt,
          electricitySupplyNumber: parsedUnit.electricitySupplyNumber,
          // T2.P1.14: persist rightType so bare/usufruct units survive
          // round-trip and downstream UIs can treat them differently
          // (e.g. usufruct units shouldn't appear in owner-side reports).
          rightType: (parsedUnit as any).rightType || 'full',
          owners,
          propertyId: String(property._id),
          isManaged: true
        });
        unitsAdded++;
      }

      (building as any).updatedDate = new Date();
      await _saveBuildingWithVersionCheck(building!);

      // T1.P1.19: a re-import that only attached units to an existing
      // building (no field-merge above) should still report wasUpdated:true.
      if (!wasCreated && unitsAdded > 0) {
        wasUpdated = true;
      }

      perBuildingOutcomes.push({
        buildingId: String((building as any)._id),
        buildingName: (building as any).name,
        wasCreated,
        wasUpdated,
        unitsAdded
      });

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
    // T1.P1.19: emit per-building outcomes plus aggregate counts so the
    // dialog can surface accurate "X created, Y updated, Z units added"
    // text instead of a blanket "created:true" lie. Keep the legacy
    // `created` boolean (true when any building was created) so older
    // callers don't break, but its meaning is now "imported successfully"
    // rather than "everything was newly created".
    const createdCount = perBuildingOutcomes.filter((o) => o.wasCreated).length;
    const updatedCount = perBuildingOutcomes.filter(
      (o) => !o.wasCreated && o.wasUpdated
    ).length;
    const unitsAddedTotal = perBuildingOutcomes.reduce(
      (sum, o) => sum + o.unitsAdded,
      0
    );
    return res.json({
      created: true,
      buildings: result,
      outcomes: perBuildingOutcomes,
      createdCount,
      updatedCount,
      unitsAddedTotal,
      skippedLandPlots: parsed.skippedLandPlots,
      failedRows: parsed.failedRows
    });
    } catch (importErr) {
      // T2.P1.6: rollback any Property and Building records this request
      // created before re-throwing. Without this, a mid-batch failure
      // (e.g. mongoose VersionError, network blip on the 5th building)
      // leaves orphan Property docs with buildingId pointing at a saved
      // Building plus partial unit lists — recovering would require
      // hand-editing mongo. We tolerate cleanup errors (log and continue)
      // because surfacing the original importErr is more useful than the
      // cleanup secondary failure.
      try {
        if (createdPropertyIds.length) {
          await Collections.Property.deleteMany({
            _id: { $in: createdPropertyIds },
            realmId: realm!._id
          });
        }
      } catch (cleanupErr) {
        logger.error(
          `E9 import rollback: Property cleanup failed: ${String(
            cleanupErr
          )} (originalIds=${createdPropertyIds.join(',')})`
        );
      }
      try {
        if (createdBuildingIds.length) {
          await Collections.Building.deleteMany({
            _id: { $in: createdBuildingIds },
            realmId: realm!._id
          });
        }
      } catch (cleanupErr) {
        logger.error(
          `E9 import rollback: Building cleanup failed: ${String(
            cleanupErr
          )} (originalIds=${createdBuildingIds.join(',')})`
        );
      }
      throw importErr;
    }
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

  if (typeof req.body.atakNumber !== 'string') {
    throw new ServiceError('atakNumber must be a string', 422);
  }
  if (!req.body.atakNumber.trim()) {
    throw new ServiceError('Unit ATAK number is missing', 422);
  }
  validateFiniteNumber(req.body.generalThousandths, 'generalThousandths', {
    min: 0,
    max: 1000
  });
  validateFiniteNumber(req.body.heatingThousandths, 'heatingThousandths', {
    min: 0,
    max: 1000
  });
  validateFiniteNumber(req.body.elevatorThousandths, 'elevatorThousandths', {
    min: 0,
    max: 1000
  });
  validateFiniteNumber(req.body.surface, 'surface', { min: 0, max: 100000 });
  validateFiniteNumber(req.body.floor, 'floor', { min: -5, max: 200 });
  if (req.body.propertyId) {
    validateObjectId(req.body.propertyId, 'propertyId');
    // Wave-21 C30-B4: cross-realm guard. Without this, a malicious admin in
    // realm A can attach a propertyId from realm B to one of their units,
    // silently linking foreign data into their own building.
    const sameRealmProperty = await Collections.Property.findOne({
      _id: req.body.propertyId,
      realmId: realm!._id
    }).lean();
    if (!sameRealmProperty) {
      throw new ServiceError(
        'propertyId does not exist in this realm',
        422
      );
    }
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

  // Prevent orphan units across buildings: if the property is already
  // referenced by a unit in a DIFFERENT building, refuse the link until
  // the caller removes the previous unit. Otherwise rent computation
  // walks both buildings and double-bills the tenant.
  if (req.body.propertyId) {
    const otherBuilding = await Collections.Building.findOne({
      realmId: realm!._id,
      'units.propertyId': req.body.propertyId
    }).lean();
    if (otherBuilding && String((otherBuilding as any)._id) !== String(id)) {
      throw new ServiceError(
        'Property is already linked to a unit in another building. Remove that unit first.',
        422
      );
    }
  }

  (building as any).units.push(req.body);

  // Building-wide thousandths sums must not exceed 1000 across all units —
  // each scheme is supposed to total 1000 across the building. Reject if
  // adding this unit would push any sum above 1000.
  {
    const sums = (
      ['generalThousandths', 'heatingThousandths', 'elevatorThousandths'] as const
    ).map((field) => ({
      field,
      total: (building as any).units.reduce(
        (s: number, u: any) => s + (Number(u[field]) || 0),
        0
      )
    }));
    const overflow = sums.find((s) => s.total > 1000);
    if (overflow) {
      throw new ServiceError(
        `${overflow.field} sum (${overflow.total}) exceeds 1000`,
        422
      );
    }
  }

  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

  // Link property if propertyId provided
  if (req.body.propertyId) {
    await Collections.Property.findOneAndUpdate(
      { _id: req.body.propertyId, realmId: realm!._id },
      { buildingId: id }
    );
    await _recomputeTenantsForProperty(realm!._id, req.body.propertyId);
  }

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

export async function updateUnit(req: Req, res: Res) {
  const realm = req.realm;
  const { id, unitId } = req.params;

  validateFiniteNumber(req.body.generalThousandths, 'generalThousandths', {
    min: 0,
    max: 1000
  });
  validateFiniteNumber(req.body.heatingThousandths, 'heatingThousandths', {
    min: 0,
    max: 1000
  });
  validateFiniteNumber(req.body.elevatorThousandths, 'elevatorThousandths', {
    min: 0,
    max: 1000
  });
  validateFiniteNumber(req.body.surface, 'surface', { min: 0, max: 100000 });
  validateFiniteNumber(req.body.floor, 'floor', { min: -5, max: 200 });
  if (req.body.propertyId) {
    validateObjectId(req.body.propertyId, 'propertyId');
    // Wave-21 C30-B4: cross-realm guard. Mirror addUnit — block linking a
    // unit to a property from a different realm.
    const sameRealmProperty = await Collections.Property.findOne({
      _id: req.body.propertyId,
      realmId: realm!._id
    }).lean();
    if (!sameRealmProperty) {
      throw new ServiceError(
        'propertyId does not exist in this realm',
        422
      );
    }
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

  // Wave-24 A14: refuse renaming a unit's atakNumber to one already used by
  // another unit in the same building. Mirror the addUnit guard.
  if (
    req.body.atakNumber !== undefined &&
    req.body.atakNumber !== null &&
    String(req.body.atakNumber).trim() !== '' &&
    String(req.body.atakNumber) !== String(unit.atakNumber)
  ) {
    const collision = (building as any).units.find(
      (u: any) =>
        String(u._id) !== String(unit._id) &&
        u.atakNumber === req.body.atakNumber
    );
    if (collision) {
      throw new ServiceError(
        'ATAK number is already used by another unit in this building',
        422
      );
    }
  }

  const oldPropertyId = unit.propertyId;
  unit.set(req.body);

  // Validate building-wide thousandths totals after the update — if the
  // edit pushes any of the three schemes above 1000, refuse the change.
  {
    const sums = (
      ['generalThousandths', 'heatingThousandths', 'elevatorThousandths'] as const
    ).map((field) => ({
      field,
      total: (building as any).units.reduce(
        (s: number, u: any) => s + (Number(u[field]) || 0),
        0
      )
    }));
    const overflow = sums.find((s) => s.total > 1000);
    if (overflow) {
      throw new ServiceError(
        `${overflow.field} sum (${overflow.total}) exceeds 1000`,
        422
      );
    }
  }

  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

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

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
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
  await _saveBuildingWithVersionCheck(building!);

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

// ---------------------------------------------------------------------------
// Monthly Charges
// ---------------------------------------------------------------------------

export async function addMonthlyCharge(req: Req, res: Res) {
  const realm = req.realm;
  const { id, unitId } = req.params;

  // Pre-validate inputs before save() — without this a missing/bad term
  // surfaces as a Mongoose ValidationError (HTTP 500 with raw schema text).
  if (req.body.term == null || !/^\d{10}$/.test(String(req.body.term))) {
    throw new ServiceError('Invalid term format', 422);
  }
  validateTerm(req.body.term, 'term');
  validateFiniteNumber(req.body.amount, 'amount', {
    min: 0,
    max: 10000000,
    required: true
  });
  validateStringField(req.body.description, 'description', {
    min: 1,
    max: 200,
    required: true
  });

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
  await _saveBuildingWithVersionCheck(building!);

  if (unit.propertyId) {
    await _recomputeTenantsForProperty(realm!._id, String(unit.propertyId));
  }

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

export async function updateMonthlyCharge(req: Req, res: Res) {
  const realm = req.realm;
  const { id, unitId, chargeId } = req.params;

  // Mirror addMonthlyCharge validation so partial updates can't smuggle a
  // bad term/amount/description and trigger a Mongoose 500 on save.
  if (req.body.term !== undefined) {
    if (!/^\d{10}$/.test(String(req.body.term))) {
      throw new ServiceError('Invalid term format', 422);
    }
    validateTerm(req.body.term, 'term');
  }
  if (req.body.amount !== undefined) {
    validateFiniteNumber(req.body.amount, 'amount', {
      min: 0,
      max: 10000000
    });
  }
  if (req.body.description !== undefined) {
    validateStringField(req.body.description, 'description', {
      min: 1,
      max: 200
    });
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

  const charge = unit.monthlyCharges.id(chargeId);
  if (!charge) {
    throw new ServiceError('Monthly charge does not exist', 404);
  }

  charge.set(req.body);
  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

  if (unit.propertyId) {
    await _recomputeTenantsForProperty(realm!._id, String(unit.propertyId));
  }

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
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
  await _saveBuildingWithVersionCheck(building!);

  if (unit.propertyId) {
    await _recomputeTenantsForProperty(realm!._id, String(unit.propertyId));
  }

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

// ---------------------------------------------------------------------------
// Monthly Statement (batch distribution of expenses to units for a given month)
// ---------------------------------------------------------------------------

export async function saveMonthlyStatement(req: Req, res: Res) {
  const realm = req.realm;
  const { id } = req.params;
  const { term, expenses: expenseEntries, ownerExpenses } = req.body;

  if (!term || !/^\d{10}$/.test(String(term))) {
    throw new ServiceError('Invalid term format (expected YYYYMMDDHH)', 422);
  }
  const termNumber = Number(term);
  if (termNumber < 2020010100 || termNumber > 2099123100) {
    throw new ServiceError('Term out of valid range', 422);
  }
  // Array present = user intends to set state for this section (even if empty = clear)
  const expensesProvided = Array.isArray(expenseEntries);
  const ownerExpensesProvided = Array.isArray(ownerExpenses);

  if (!expensesProvided && !ownerExpensesProvided) {
    throw new ServiceError('At least one expense entry is required', 422);
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

  // Audit B2: build a plain-object snapshot of the building and attach
  // _tenantGroups to it so the "equal" allocation method divides by
  // unique tenants (not managed units). Without this, the per-unit
  // toObject() inside the loop ships a plain object with no
  // _tenantGroups, computeBuildingChargeForProperty falls through to
  // the per-managed-unit fallback at 1_base.ts:209-219, and a tenant
  // occupying multiple units in the same building (apt + storage) is
  // billed once per unit (double-billed for "equal" allocation).
  // Mirrors the live-path attach in _recomputeTenantsForProperty
  // (line 154) and _recomputeTenantsForBuilding (line 254) added in
  // wave-17 (51bbefca).
  const buildingPlain = (building as any).toObject();
  await _attachTenantGroupsToBuildings(realm!._id as string, [buildingPlain]);

  // Validate every referenced expenseId exists on the building before we
  // mutate any unit. Silently accepting unknown ids leaves orphan charges.
  if (expensesProvided) {
    for (const entry of expenseEntries || []) {
      if (entry?.expenseId) {
        const exp = (building as any).expenses.id(entry.expenseId);
        if (!exp) {
          throw new ServiceError(
            `Unknown expenseId: ${entry.expenseId}`,
            422
          );
        }
      }
    }
  }
  if (ownerExpensesProvided) {
    for (const entry of ownerExpenses || []) {
      if (entry?.expenseId) {
        const exp = (building as any).expenses.id(entry.expenseId);
        if (!exp) {
          throw new ServiceError(
            `Unknown expenseId: ${entry.expenseId}`,
            422
          );
        }
      }
    }
  }

  // For each unit, remove existing monthly charges for this term, then add new ones
  for (const unit of units) {
    if (!unit.propertyId) continue;

    if (expensesProvided) {
      // Remove existing charges for this term
      const idsToRemove = unit.monthlyCharges
        .filter((c: any) => c.term === Number(term))
        .map((c: any) => c._id);
      for (const chargeId of idsToRemove) {
        unit.monthlyCharges.pull(chargeId);
      }

      // Compute and add new charges for each expense
      for (const entry of expenseEntries) {
        if (!entry.amount || entry.amount <= 0) continue;

        // Find the building expense to get its allocation method
        const buildingExpense = (building as any).expenses.id(entry.expenseId);
        const allocationMethod =
          entry.allocationMethod ||
          buildingExpense?.allocationMethod ||
          'equal';
        const description =
          entry.description || buildingExpense?.name || 'Building charge';

        // Compute share for this unit. Pass the buildingPlain snapshot
        // (with _tenantGroups attached above) so equal-allocation
        // groups by unique tenant instead of by managed unit.
        const share = computeBuildingChargeForProperty(
          buildingPlain,
          String(unit.propertyId),
          {
            ...(buildingExpense?.toObject?.() || {}),
            amount: entry.amount,
            allocationMethod
          },
          Number(term)
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
  }

  // Handle owner expenses
  if (ownerExpensesProvided) {
    // Remove existing owner expenses for this term
    const idsToRemove = (building as any).ownerMonthlyExpenses
      .filter((e: any) => e.term === Number(term))
      .map((e: any) => e._id);
    for (const eid of idsToRemove) {
      (building as any).ownerMonthlyExpenses.pull(eid);
    }
    // Add new owner expenses
    for (const entry of ownerExpenses) {
      if (!entry.amount || entry.amount <= 0) continue;
      (building as any).ownerMonthlyExpenses.push({
        expenseId: entry.expenseId,
        term: Number(term),
        amount: entry.amount,
        description: entry.description || ''
      });
    }
  }

  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

  // Recompute rents for all tenants linked to this building
  const propertyIds = units
    .filter((u: any) => u.propertyId)
    .map((u: any) => String(u.propertyId));
  for (const propId of propertyIds) {
    await _recomputeTenantsForProperty(realm!._id, propId);
  }

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export async function addExpense(req: Req, res: Res) {
  const realm = req.realm;
  const { id } = req.params;

  // Normalize alternate field name from older UI builds: `recurring` →
  // `isRecurring`. Without this, the schema default (true) silently kicks
  // in and a one-off expense becomes recurring forever.
  if (req.body.isRecurring === undefined && req.body.recurring !== undefined) {
    req.body.isRecurring = req.body.recurring;
    delete req.body.recurring;
  }

  // A non-recurring expense MUST be anchored to a specific term — otherwise
  // it has no meaning in the rent pipeline (it would never fire).
  if (req.body.isRecurring === false && !req.body.startTerm) {
    throw new ServiceError(
      'startTerm is required for non-recurring expenses',
      422
    );
  }

  // Wave-18 B6: a recurring expense without a startTerm bills every tenant
  // back to epoch (the rent pipeline treats undefined startTerm as "always
  // active"). Require an explicit anchor.
  if (req.body.isRecurring !== false && !req.body.startTerm) {
    throw new ServiceError(
      'startTerm is required for recurring expenses',
      422
    );
  }

  if (!req.body.name?.trim()) {
    throw new ServiceError('Expense name is required', 422);
  }
  validateEnum(req.body.type, EXPENSE_TYPES, 'type', { required: true });
  validateEnum(
    req.body.allocationMethod,
    ALLOCATION_METHODS,
    'allocationMethod',
    { required: true }
  );
  validateFiniteNumber(req.body.amount, 'amount', { min: 0, max: 10000000 });
  validateFiniteNumber(req.body.ownerAmount, 'ownerAmount', {
    min: 0,
    max: 10000000
  });
  if (req.body.startTerm) {
    validateTerm(req.body.startTerm, 'startTerm');
  }
  if (req.body.endTerm) {
    validateTerm(req.body.endTerm, 'endTerm');
  }
  if (
    req.body.startTerm &&
    req.body.endTerm &&
    Number(req.body.startTerm) > Number(req.body.endTerm)
  ) {
    throw new ServiceError('startTerm must be before endTerm', 422);
  }

  // Wave-18 B1: normalize one-time startTerm to YYYYMM0100 so historical
  // data stays consistent with the YYYYMM-based active-term comparison.
  if (req.body.isRecurring === false && req.body.startTerm) {
    const st = Number(req.body.startTerm);
    const normalized = Math.floor(st / 10000) * 10000 + 100;
    req.body.startTerm = normalized;
    if (req.body.endTerm) req.body.endTerm = normalized;
  }

  validateAllocationValues(req.body.customAllocations);
  validatePercentageAllocations(
    req.body.customAllocations,
    req.body.allocationMethod
  );
  validateRatioAllocations(
    req.body.customAllocations,
    req.body.allocationMethod
  );
  validateArrayMaxLength(req.body.customAllocations, 200, 'customAllocations');

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  // Wave-18 B5: customAllocations entries must reference units that actually
  // belong to this building. Without this guard, a typo'd / spoofed
  // propertyId silently produces an expense that never bills anyone (or
  // worse, bills a unit in a different building).
  _assertCustomAllocationPropertyIds(
    building,
    req.body.customAllocations,
    req.body.allocationMethod
  );

  (building as any).expenses.push(req.body);
  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

  // Wave-14 F6: recompute every tenant linked to the building exactly once.
  await _recomputeTenantsForBuilding(realm!._id, building);

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

export async function updateExpense(req: Req, res: Res) {
  const realm = req.realm;
  const { id, expenseId } = req.params;

  // Normalize alternate field name from older UI builds: `recurring` →
  // `isRecurring`. See note in addExpense.
  if (req.body.isRecurring === undefined && req.body.recurring !== undefined) {
    req.body.isRecurring = req.body.recurring;
    delete req.body.recurring;
  }

  // A non-recurring expense MUST be anchored to a specific term — same
  // invariant as addExpense; updates that flip recurring → false without a
  // startTerm would silently produce dead expenses.
  if (req.body.isRecurring === false && !req.body.startTerm) {
    throw new ServiceError(
      'startTerm is required for non-recurring expenses',
      422
    );
  }
  // Wave-18 B6: same invariant for recurring expenses (mirror addExpense).
  if (req.body.isRecurring === true && !req.body.startTerm) {
    throw new ServiceError(
      'startTerm is required for recurring expenses',
      422
    );
  }

  if (req.body.type) {
    validateEnum(req.body.type, EXPENSE_TYPES, 'type');
  }
  if (req.body.allocationMethod) {
    validateEnum(
      req.body.allocationMethod,
      ALLOCATION_METHODS,
      'allocationMethod'
    );
  }
  validateFiniteNumber(req.body.amount, 'amount', { min: 0, max: 10000000 });
  validateFiniteNumber(req.body.ownerAmount, 'ownerAmount', {
    min: 0,
    max: 10000000
  });
  if (req.body.startTerm) {
    validateTerm(req.body.startTerm, 'startTerm');
  }
  if (req.body.endTerm) {
    validateTerm(req.body.endTerm, 'endTerm');
  }
  validateAllocationValues(req.body.customAllocations);
  if (req.body.allocationMethod) {
    validatePercentageAllocations(
      req.body.customAllocations,
      req.body.allocationMethod
    );
    validateRatioAllocations(
      req.body.customAllocations,
      req.body.allocationMethod
    );
  }

  // Wave-18 B1: keep one-time updates aligned to YYYYMM0100 (mirror addExpense).
  if (req.body.isRecurring === false && req.body.startTerm) {
    const st = Number(req.body.startTerm);
    const normalized = Math.floor(st / 10000) * 10000 + 100;
    req.body.startTerm = normalized;
    if (req.body.endTerm) req.body.endTerm = normalized;
  }

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const expense = (building as any).expenses.id(expenseId);
  if (!expense) {
    throw new ServiceError('Expense does not exist', 404);
  }

  // Wave-18 B5: validate customAllocations propertyIds against the
  // building's units. Use the merged allocation method so partial updates
  // (allocationMethod unchanged) still validate against the right rule.
  const effectiveAllocationMethod =
    req.body.allocationMethod || (expense as any).allocationMethod;
  if (req.body.customAllocations !== undefined) {
    _assertCustomAllocationPropertyIds(
      building,
      req.body.customAllocations,
      effectiveAllocationMethod
    );
  }

  expense.set(req.body);
  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

  // Wave-14 F6: recompute every tenant linked to the building exactly once.
  await _recomputeTenantsForBuilding(realm!._id, building);

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

export async function removeExpense(req: Req, res: Res) {
  const realm = req.realm;
  const { id, expenseId } = req.params;
  const mode = (req.query.mode as string) || 'hard';

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  const expense = (building as any).expenses.id(expenseId);
  if (!expense) {
    throw new ServiceError('Expense does not exist', 404);
  }

  if (mode === 'soft') {
    // Set endTerm to previous month so it stops applying from current month
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endTerm = Number(
      `${prevMonth.getFullYear()}${String(prevMonth.getMonth() + 1).padStart(2, '0')}0100`
    );
    expense.set({ endTerm });
  } else {
    // Hard delete: remove expense and clean up orphaned monthly charges
    const expId = String(expense._id);
    for (const unit of (building as any).units) {
      const orphaned = unit.monthlyCharges
        .filter((c: any) => String(c.expenseId) === expId)
        .map((c: any) => c._id);
      for (const chargeId of orphaned) {
        unit.monthlyCharges.pull(chargeId);
      }
    }
    // Remove orphaned owner monthly expenses
    const ownerOrphaned = ((building as any).ownerMonthlyExpenses || [])
      .filter((e: any) => String(e.expenseId) === expId)
      .map((e: any) => e._id);
    for (const eid of ownerOrphaned) {
      (building as any).ownerMonthlyExpenses.pull(eid);
    }
    (building as any).expenses.pull(expense._id);

    // Delete linked Bill records — they reference this expense and would
    // become orphans otherwise.
    await Collections.Bill.deleteMany({
      realmId: realm!._id,
      buildingId: id,
      expenseId: expId
    });
  }

  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

  // Wave-14 F6: recompute every tenant linked to the building exactly once.
  await _recomputeTenantsForBuilding(realm!._id, building);

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

// ---------------------------------------------------------------------------
// Contractors
// ---------------------------------------------------------------------------

const VALID_CONTRACTOR_SPECIALTIES = [
  'plumbing',
  'electrical',
  'plumber',
  'electrician',
  'painter',
  'carpenter',
  'mason',
  'gardener',
  'cleaner',
  'elevator',
  'locksmith',
  'hvac',
  'general',
  'other'
];

export async function addContractor(req: Req, res: Res) {
  const realm = req.realm;
  const { id } = req.params;

  // Validate required fields up-front. Without this, a missing/invalid
  // specialty becomes a Mongoose ValidationError that surfaces as 500.
  if (!req.body.specialty) {
    throw new ServiceError('contractor specialty is required', 422);
  }
  if (!VALID_CONTRACTOR_SPECIALTIES.includes(req.body.specialty)) {
    throw new ServiceError(`invalid specialty: ${req.body.specialty}`, 422);
  }

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
  await _saveBuildingWithVersionCheck(building!);

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

export async function updateContractor(req: Req, res: Res) {
  const realm = req.realm;
  const { id, contractorId } = req.params;

  // If specialty is being set, validate it before save() — a bad value would
  // otherwise surface as a Mongoose ValidationError 500.
  if (req.body.specialty !== undefined) {
    if (!req.body.specialty) {
      throw new ServiceError('contractor specialty is required', 422);
    }
    if (!VALID_CONTRACTOR_SPECIALTIES.includes(req.body.specialty)) {
      throw new ServiceError(`invalid specialty: ${req.body.specialty}`, 422);
    }
  }

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
  await _saveBuildingWithVersionCheck(building!);

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
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
  await _saveBuildingWithVersionCheck(building!);

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

// ---------------------------------------------------------------------------
// Repairs
// ---------------------------------------------------------------------------

// Mirrors the Repair schema's `category` enum in
// services/common/src/collections/building.ts. Validating up-front keeps a
// missing/invalid category from surfacing as a Mongoose ValidationError 500.
const VALID_REPAIR_CATEGORIES = [
  'plumbing',
  'electrical',
  'elevator',
  'roof',
  'facade',
  'heating',
  'doors_windows',
  'painting',
  'flooring',
  'general',
  'other'
];

async function _removeRepairCharges(building: any, repair: any): Promise<void> {
  const repairIdStr = String(repair._id);
  for (const unit of building.units) {
    // Prefer scoping by repairId (handles renames). Fall back to legacy
    // description match for charges created before repairId was introduced.
    const legacyDescription = `Repair: ${repair.title}`;
    const toRemove = unit.monthlyCharges.filter(
      (c: any) =>
        (c.repairId && String(c.repairId) === repairIdStr) ||
        (!c.repairId && c.description === legacyDescription)
    );
    for (const charge of toRemove) {
      unit.monthlyCharges.pull(charge._id);
    }
  }
}

async function _distributeRepairCharge(
  building: any,
  repair: any,
  realmId: string
): Promise<void> {
  // Cancelled repairs must not retain monthly charges. Wipe any prior
  // distribution for this repair and bail out before re-creating.
  if (repair.status === 'cancelled') {
    await _removeRepairCharges(building, repair);
    building.updatedDate = new Date();
    await _saveBuildingWithVersionCheck(building);

    const propertyIds = building.units
      .filter((u: any) => u.propertyId)
      .map((u: any) => String(u.propertyId));
    for (const propId of propertyIds) {
      await _recomputeTenantsForProperty(realmId, propId);
    }
    return;
  }

  if (!repair.chargeableTo || repair.chargeableTo === 'owners') return;
  if (!repair.chargeTerm) return;

  const cost = repair.actualCost || repair.estimatedCost || 0;
  if (cost <= 0) return;

  // Respect explicit tenantSharePercentage when provided. Default depends on
  // chargeableTo: 'tenants' implies 100% to tenants, 'split' implies 0%
  // unless a percentage was set explicitly.
  const sharePercentage = (() => {
    if (repair.chargeableTo === 'owners') return 0;
    if (
      typeof repair.tenantSharePercentage === 'number' &&
      Number.isFinite(repair.tenantSharePercentage)
    ) {
      return Math.max(0, Math.min(100, repair.tenantSharePercentage));
    }
    return repair.chargeableTo === 'tenants' ? 100 : 0;
  })();
  if (sharePercentage <= 0) return;

  const effectiveAmount = cost * (sharePercentage / 100);
  const allocationMethod = repair.allocationMethod || 'general_thousandths';
  const term = Number(repair.chargeTerm);
  const repairIdStr = String(repair._id);

  // F5 (mirrors saveMonthlyStatement / B2 fix at line 1604): the plain-
  // object snapshot must carry _tenantGroups so equal-allocation groups
  // by unique tenant rather than by managed unit. Without this attach,
  // a tenant occupying multiple units on the same building gets billed
  // a per-unit share for repairs (double-charged for "equal").
  const buildingObj = building.toObject ? building.toObject() : building;
  await _attachTenantGroupsToBuildings(realmId, [buildingObj]);

  for (const unit of building.units) {
    if (!unit.propertyId) continue;

    const share = computeBuildingChargeForProperty(
      buildingObj,
      String(unit.propertyId),
      { amount: effectiveAmount, allocationMethod, name: repair.title } as any,
      term
    );

    // Remove existing charges for THIS repair (regardless of title), so
    // renaming a repair doesn't double-count via description-based de-dup.
    const legacyDescription = `Repair: ${repair.title}`;
    const toRemove = unit.monthlyCharges.filter(
      (c: any) =>
        (c.repairId && String(c.repairId) === repairIdStr) ||
        (!c.repairId &&
          c.term === term &&
          c.description === legacyDescription)
    );
    for (const charge of toRemove) {
      unit.monthlyCharges.pull(charge._id);
    }

    if (share > 0) {
      unit.monthlyCharges.push({
        term,
        amount: Math.round(share * 100) / 100,
        description: `Repair: ${repair.title}`,
        repairId: repairIdStr
      });
    }
  }

  building.updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building);

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
  // Validate category up-front. Without this, a missing/invalid category
  // becomes a Mongoose ValidationError that surfaces as 500.
  if (!req.body.category) {
    throw new ServiceError('Repair category is required', 422);
  }
  if (!VALID_REPAIR_CATEGORIES.includes(req.body.category)) {
    throw new ServiceError(`Invalid category: ${req.body.category}`, 422);
  }
  validateFiniteNumber(req.body.estimatedCost, 'estimatedCost', {
    min: 0,
    max: 10000000
  });
  validateFiniteNumber(req.body.actualCost, 'actualCost', {
    min: 0,
    max: 10000000
  });
  validateFiniteNumber(
    req.body.tenantSharePercentage,
    'tenantSharePercentage',
    { min: 0, max: 100 }
  );
  validateEnum(req.body.chargeableTo, CHARGEABLE_TO, 'chargeableTo');
  validateEnum(req.body.status, REPAIR_STATUSES, 'status');
  if (req.body.allocationMethod) {
    validateEnum(
      req.body.allocationMethod,
      ALLOCATION_METHODS,
      'allocationMethod'
    );
  }
  if (req.body.chargeTerm) {
    validateTerm(req.body.chargeTerm, 'chargeTerm');

    // A repair targeting a paid past month would silently no-op: the rent
    // is frozen (wave-13) so the new monthlyCharge gets written but the
    // tenant ledger is never repriced. Refuse loudly instead of writing
    // dead data.
    if (
      req.body.chargeableTo &&
      req.body.chargeableTo !== 'owners' &&
      (req.body.actualCost > 0 || req.body.estimatedCost > 0)
    ) {
      const currentTerm = Number(
        moment.utc().startOf('month').format('YYYYMMDDHH')
      );
      if (Number(req.body.chargeTerm) < currentTerm) {
        // Check whether ANY tenant in this building has a paid rent for
        // that term. If yes, the bill is frozen and our charge would be
        // invisible.
        // E20: use $elemMatch so the term-match AND the
        // payments.amount > 0 must both apply to the SAME rent entry.
        // The previous shape (`'rents.term': N` + `'rents.payments.amount': {$gt: 0}`)
        // used dot-paths that match ACROSS the rents[] array — a tenant
        // with a paid rent in March 2026 AND an empty rent in May 2026
        // would falsely report May 2026 as "frozen" and reject the
        // legitimate charge.
        const paidExists = await Collections.Tenant.exists({
          realmId: realm!._id,
          rents: {
            $elemMatch: {
              term: Number(req.body.chargeTerm),
              payments: { $elemMatch: { amount: { $gt: 0 } } }
            }
          }
        } as any);
        if (paidExists) {
          throw new ServiceError(
            'Charge month is in the past and at least one tenant has paid rent for that month. Past-paid rents are frozen — pick a current or future month.',
            422
          );
        }
      }
    }
  }

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  (building as any).repairs.push(req.body);
  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

  // Distribute repair cost to tenants if chargeable
  const newRepair = (building as any).repairs[
    (building as any).repairs.length - 1
  ];
  await _distributeRepairCharge(building as any, newRepair, realm!._id);

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

export async function updateRepair(req: Req, res: Res) {
  const realm = req.realm;
  const { id, repairId } = req.params;

  // PATCH semantics: only validate category when it is being changed.
  // undefined means "don't touch"; null/empty/other-value triggers 422
  // before save() so a Mongoose ValidationError can't surface as 500.
  if (req.body.category !== undefined) {
    if (!req.body.category) {
      throw new ServiceError('Repair category is required', 422);
    }
    if (!VALID_REPAIR_CATEGORIES.includes(req.body.category)) {
      throw new ServiceError(`Invalid category: ${req.body.category}`, 422);
    }
  }

  validateFiniteNumber(req.body.estimatedCost, 'estimatedCost', {
    min: 0,
    max: 10000000
  });
  validateFiniteNumber(req.body.actualCost, 'actualCost', {
    min: 0,
    max: 10000000
  });
  validateFiniteNumber(
    req.body.tenantSharePercentage,
    'tenantSharePercentage',
    { min: 0, max: 100 }
  );
  if (req.body.chargeableTo) {
    validateEnum(req.body.chargeableTo, CHARGEABLE_TO, 'chargeableTo');
  }
  if (req.body.status) {
    validateEnum(req.body.status, REPAIR_STATUSES, 'status');
  }
  if (req.body.allocationMethod) {
    validateEnum(
      req.body.allocationMethod,
      ALLOCATION_METHODS,
      'allocationMethod'
    );
  }
  if (req.body.chargeTerm) {
    validateTerm(req.body.chargeTerm, 'chargeTerm');
  }

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
  await _saveBuildingWithVersionCheck(building!);

  // Re-distribute repair cost
  await _distributeRepairCharge(building as any, repair, realm!._id);

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
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

  // Clean up monthlyCharges created by _distributeRepairCharge — scope by
  // repairId (with legacy description fallback) so renames don't leak.
  await _removeRepairCharges(building, repair);

  (building as any).repairs.pull(repair._id);
  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

  // Recompute rents for affected tenants
  const propertyIds = (building as any).units
    .filter((u: any) => u.propertyId)
    .map((u: any) => String(u.propertyId));
  for (const propId of propertyIds) {
    await _recomputeTenantsForProperty(realm!._id, propId);
  }

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}
