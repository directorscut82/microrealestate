import { Collections, logger, ServiceError } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import type { CollectionTypes } from '@microrealestate/types';
import { parseE9 } from './e9parser.js';
import * as Contract from './contract.js';
import { _attachTenantGroupsToBuildings } from './occupantmanager.js';
import {
  carryOwnerPayments,
  applyCarriedSettlement,
  recomputeOwnerExpensePaid,
  ownerSlicesOf,
  ownerKeyOf
} from './ownermanager.js';
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
  validateFixedAllocations,
  validateSingleUnitAllocations,
  isValidGreekPostalCode,
  isValidIBAN,
  EXPENSE_TYPES,
  ALLOCATION_METHODS,
  REPAIR_STATUSES,
  CHARGEABLE_TO
} from '../validators.js';
import {
  computeBuildingChargeForProperty,
  computeBuildingExpenseBreakdown,
  isExpenseActiveForTerm,
  repairTenantSharePercentage
} from '../businesslogic/tasks/1_base.js';
import moment from 'moment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// `withUncollected` (L4): explicitly opt into the heavy §5 Αχρέωτα breakdown
// (12 engine runs/building). Default true so the detail-page GET + every
// detail-mutation caller (which pass a single building and render the Overview
// tile) keep computing it. The LIST route (`all()`) and the E9-import route
// (`importFromE9()`) pass false — a realm with exactly one building must NOT
// pay the 12× cost on those just because `buildings.length === 1` happened to
// hold (the old proxy for "detail route"). The length===1 guard below still
// applies as a perf floor — the tile only renders for a single building anyway.
async function _toBuildingData(
  realmId: string,
  buildings: any[],
  withUncollected = true
) {
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

  // Fetch tenants linked to these properties ONCE. Both the occupant map
  // (name + properties) and the A2 rent-YTD rollup (rents.total.*) need the
  // SAME tenant set with the SAME filter — L3 merged the two back-to-back
  // identical-filter Tenant.find calls into one with a combined projection
  // (rents fields are needed only for the YTD loop below).
  const tenants = propertyIds.length
    ? await Collections.Tenant.find(
        {
          realmId,
          'properties.propertyId': { $in: propertyIds }
        },
        {
          name: 1,
          properties: 1,
          'rents.term': 1,
          'rents.total.grandTotal': 1,
          'rents.total.payment': 1,
          'rents.total.balance': 1
        }
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

  // A2: per-building tenant rent collected-vs-owed for the CURRENT YEAR, the
  // tenant twin of the owner paid/unpaid tile. The building payload deliberately
  // strips tenant.rents[] (above), so compute the YTD sums server-side and attach
  // {collected, owed} per building.
  //
  // CARRY-FORWARD: rent.total.grandTotal is a CUMULATIVE running ledger — each
  // month's grandTotal already INCLUDES every prior unpaid month (5_balance:
  // balance = prevGrandTotal − prevPayment; 7_total: grandTotal = thisMonthBill +
  // balance). So Σ max(0, grandTotal − payment) re-adds the arrears every month
  // (quadratic blow-up: 6 months at €1000 unpaid → €21,000 not €6,000). The
  // dashboard income chart (dashboardmanager) strips the carry-in: monthDue =
  // max(0, grandTotal − max(0, balance)); notPaid += max(0, monthDue − payment).
  // We MUST do the same (project total.balance) so this tile reconciles with it
  // (Step-7 caught the missing strip).
  const currentYear = new Date().getFullYear();
  const propIdToBuildingId = new Map<string, string>();
  for (const b of buildings as any[]) {
    for (const u of b.units || []) {
      if (u.propertyId) propIdToBuildingId.set(String(u.propertyId), String(b._id));
    }
  }
  const rentYTDByBuilding = new Map<string, { collected: number; owed: number }>();
  const _r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
  // Reuse the single tenant fetch above (L3) — it now carries the rents.total
  // projection this YTD rollup needs.
  for (const t of tenants as any[]) {
    // ATTRIBUTION: a tenant rent is building-wide. Attribute it to the building
    // holding the tenant's FIRST property that resolves to a building IN THIS
    // payload. (A multi-building tenant is vanishingly rare — one lease, one
    // building in practice; this keeps the figure stable for the common case.)
    let bid: string | null = null;
    for (const tp of t.properties || []) {
      const candidate = propIdToBuildingId.get(String(tp.propertyId));
      if (candidate) {
        bid = candidate;
        break;
      }
    }
    if (!bid) continue;
    let collected = 0;
    let owed = 0;
    for (const rent of t.rents || []) {
      if (Math.floor(Number(rent.term || 0) / 1000000) !== currentYear) continue;
      const grand = Number(rent?.total?.grandTotal) || 0;
      const payment = Number(rent?.total?.payment) || 0;
      const balance = Number(rent?.total?.balance) || 0;
      // THIS month's bill only (strip the carried-in prior-months deficit).
      const monthDue = Math.max(0, grand - Math.max(0, balance));
      collected += payment;
      owed += Math.max(0, monthDue - payment);
    }
    const slot = rentYTDByBuilding.get(bid) || { collected: 0, owed: 0 };
    slot.collected = _r2(slot.collected + collected);
    slot.owed = _r2(slot.owed + owed);
    rentYTDByBuilding.set(bid, slot);
  }

  // §5: cumulative Αχρέωτα (uncollected, netted by voluntary payments) for the
  // current year — ONLY for the single-building detail/dashboard read. It runs
  // the breakdown engine 12× per building, far too heavy for the building LIST
  // (the Overview tile that consumes it only renders on the detail page). One
  // building in the array ⇒ detail route (one()/update()); many ⇒ list (skip).
  const uncollectedByBuilding = new Map<
    string,
    { total: number; paidTotal: number; outstanding: number }
  >();
  if (withUncollected && buildings.length === 1) {
    try {
      uncollectedByBuilding.set(
        String(buildings[0]._id),
        await computeUncollectedByYear(realmId, buildings[0], currentYear)
      );
    } catch {
      // Defensive: a breakdown failure must not break the whole building read.
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
      unitCount: units.length,
      tenantRentYTD:
        rentYTDByBuilding.get(String(building._id)) || { collected: 0, owed: 0 },
      uncollected:
        uncollectedByBuilding.get(String(building._id)) || null
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
// Current month as a YYYYMMDDHH term — the open billing period that
// vacant-owner recompute targets when expenses change.
function _currentTerm(): number {
  return Number(moment().startOf('month').format('YYYYMMDDHH'));
}

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
    'fixed',
    // single_unit also carries a propertyId target in customAllocations[0].
    // Without validating it here, a stale/foreign propertyId saves a
    // well-formed expense that the pipeline (1_base.ts single_unit branch)
    // matches to no real unit and silently bills €0 every term.
    'single_unit'
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
// permanently inconsistent with the rent's input arrays (DOKIMASTI June 2026
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

  // List route: skip the heavy §5 Αχρέωτα breakdown (the tile only renders on
  // the detail page) — L4: don't pay the 12× cost just because the realm has a
  // single building.
  const buildings = await _toBuildingData(
    realm!._id,
    dbBuildings as any[],
    false
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

  // FIXED-ZERO-PATCH (bulk path): the building-create expenses[] array
  // bypassed per-expense allocation validation (only array length was
  // checked), so a fixed expense with empty/zero customAllocations could be
  // created and then bill €0 to every unit — the same silent-money bug the
  // single-expense add/update paths guard. Validate each fixed/percentage/
  // ratio expense here too. Each validator is a no-op for other methods.
  if (Array.isArray(req.body.expenses)) {
    for (const e of req.body.expenses) {
      validateAllocationValues(e?.customAllocations);
      validateFixedAllocations(e?.customAllocations, e?.allocationMethod);
      validatePercentageAllocations(e?.customAllocations, e?.allocationMethod);
      validateRatioAllocations(e?.customAllocations, e?.allocationMethod);
      validateSingleUnitAllocations(e?.customAllocations, e?.allocationMethod);
    }
  }

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

// Append a parsed unit's co-owners (parsedUnit.coOwners) into an EXISTING
// unit's owners[] on re-import, deduped by taxId. The new-unit path does this
// inline; the ATAK-match and DEH-match merge branches previously did NOT, so a
// co-owned unit re-imported (it already existed) silently kept only the primary
// owner — the "50% unit with the other owner missing" bug.
//
// A parsed co-owner NEVER carries a name (the E9 lists only the filer's name);
// it is identifiable ONLY by its ΑΦΜ. A co-owner with no ΑΦΜ is therefore
// UNIDENTIFIABLE and unsettleable — and the parser can spuriously emit one
// (e.g. a phantom 100% co-owner on a unit the filer already owns 100%, which
// rendered a bogus 200% unit + a literal "Co-owner" phantom in the owners
// list, June 2026 round-4). We DROP such co-owners: ownerSlicesOf already
// synthesises a "λοιποί" rest-slice for any un-named ownership remainder, so
// the display reconciles WITHOUT storing an unidentifiable owner subdoc.
function _mergeCoOwners(ownersArr: any[], parsedUnit: any): void {
  if (!Array.isArray(ownersArr)) return;
  for (const co of (parsedUnit as any).coOwners || []) {
    const coTaxId = co.taxId || '';
    if (!coTaxId) continue; // unidentifiable co-owner → rest-slice handles it
    const exists = ownersArr.find(
      (o: any) => o.taxId && o.taxId === coTaxId
    );
    if (exists) {
      // keep the latest declared percentage
      if (
        typeof co.percentage === 'number' &&
        co.percentage !== exists.percentage
      ) {
        exists.percentage = co.percentage;
      }
      continue;
    }
    ownersArr.push({
      type: 'external',
      name: `ΑΦΜ ${coTaxId}`,
      percentage: co.percentage,
      taxId: coTaxId
    });
  }
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
      // who manually created "Οδος ζητά 167" before importing an E9 that
      // declared "ΟΔΟΣ ΖΗΤΑ 167" would have those two records treated as
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
      // Multiple buildings can share the same prefix (e.g. ΟΔΟΣ ΖΗΤΑ 167 and ΟΔΟΣ ΗΤΑ 24)

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
          // OWNER-IDENTITY: the E9 υπόχρεος (parsed.owner) is the real owner of
          // record — a person on the landlord's books, NOT the app user doing
          // the import. Identify them by ΑΦΜ (taxId) first, then by name.
          // (Previously we stamped the importing user's memberId on every
          // parsed owner; since ownerKeyOf keys on memberId first, that
          // collapsed every distinct owner the same operator imported into ONE
          // bucket — e.g. three siblings' 20 units showing as one owner. A
          // parsed owner is never the app user, so we never stamp a memberId;
          // identity is name + ΑΦΜ, mirroring the co-owner handling below.)
          const ownerTaxId = (parsed.owner as any).taxId || '';
          const findExistingOwner = (owners: any[]): any =>
            (owners || []).find((o: any) => {
              if (ownerTaxId && o.taxId && o.taxId === ownerTaxId) return true;
              return o.name === ownerFullName;
            });
          const existingOwner = findExistingOwner(existingUnit.owners);
          if (!existingOwner && existingUnit.owners) {
            existingUnit.owners.push({
              type: 'external',
              name: ownerFullName,
              percentage: parsedUnit.ownershipPercentage,
              taxId: ownerTaxId || undefined
            });
          } else if (existingOwner) {
            // BACKFILL ΑΦΜ: a re-import of the SAME owner now carries their ΑΦΜ
            // (older imports stored none). Stamp it onto the name-matched
            // owner so ownerKeyOf (n:name|taxId) stays stable and the owner is
            // not split into two (n:name| vs n:name|taxId) on the owners page.
            // DISAMBIGUATION GUARD: only stamp when the name is UNAMBIGUOUS on
            // this unit — exactly one owner bears ownerFullName AND no other
            // owner already carries this ΑΦΜ. Otherwise a second person sharing
            // a common Greek name re-importing their own E9 would name-match a
            // taxId-less co-owner and have THEIR ΑΦΜ stamped onto the wrong
            // person, flipping that owner's ledger identity (money-routing
            // corruption — adversarial finding, June 2026 round-4).
            if (ownerTaxId && !existingOwner.taxId) {
              const nameMatches = (existingUnit.owners || []).filter(
                (o: any) => o.name === ownerFullName
              );
              const taxIdElsewhere = (existingUnit.owners || []).some(
                (o: any) => o.taxId && o.taxId === ownerTaxId
              );
              if (nameMatches.length === 1 && !taxIdElsewhere) {
                existingOwner.taxId = ownerTaxId;
              }
            }
            // L4: year-on-year re-imports may declare a different
            // ownership percentage (transfers, shifts in joint
            // ownership). Keep the latest E9 declaration as the source
            // of truth instead of silently preserving the prior value.
            if (
              typeof parsedUnit.ownershipPercentage === 'number' &&
              parsedUnit.ownershipPercentage !== existingOwner.percentage
            ) {
              logger.info(
                `E9 import: owner ${ownerFullName} percentage updated on ATAK ${parsedUnit.atakNumber}: ${existingOwner.percentage} → ${parsedUnit.ownershipPercentage}`
              );
              existingOwner.percentage = parsedUnit.ownershipPercentage;
            }
          }
          // Append any co-owners the parser detected (was dropped on re-import).
          _mergeCoOwners(existingUnit.owners, parsedUnit);
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
          // Same apartment, add co-owner. OWNER-IDENTITY: dedupe by ΑΦΜ
          // (taxId) then name — the parsed owner is the owner of record, not
          // the importing app user, so we never key on the user's memberId
          // (see the ATAK-match branch above for the collapse bug this fixes).
          const ownerTaxId = (parsed.owner as any).taxId || '';
          const existingOwner = (existingByDeh.owners || []).find((o: any) => {
            if (ownerTaxId && o.taxId && o.taxId === ownerTaxId) return true;
            return o.name === ownerFullName;
          });
          if (!existingOwner && existingByDeh.owners) {
            existingByDeh.owners.push({
              type: 'external',
              name: ownerFullName,
              percentage: parsedUnit.ownershipPercentage,
              taxId: ownerTaxId || undefined
            });
          } else if (existingOwner) {
            // BACKFILL ΑΦΜ on the name-matched owner (see ATAK branch above) —
            // same disambiguation guard: stamp only when the name is unique on
            // this unit and the ΑΦΜ is not already on another co-owner.
            if (ownerTaxId && !existingOwner.taxId) {
              const nameMatches = (existingByDeh.owners || []).filter(
                (o: any) => o.name === ownerFullName
              );
              const taxIdElsewhere = (existingByDeh.owners || []).some(
                (o: any) => o.taxId && o.taxId === ownerTaxId
              );
              if (nameMatches.length === 1 && !taxIdElsewhere) {
                existingOwner.taxId = ownerTaxId;
              }
            }
            // L4: see ATAK-match branch above for rationale.
            if (
              typeof parsedUnit.ownershipPercentage === 'number' &&
              parsedUnit.ownershipPercentage !== existingOwner.percentage
            ) {
              logger.info(
                `E9 import: owner ${ownerFullName} percentage updated on DEH-matched ATAK ${parsedUnit.atakNumber}: ${existingOwner.percentage} → ${parsedUnit.ownershipPercentage}`
              );
              existingOwner.percentage = parsedUnit.ownershipPercentage;
            }
          }
          // Append any co-owners the parser detected (was dropped on re-import).
          _mergeCoOwners(existingByDeh.owners, parsedUnit);
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
              // Round-1 audit H10 (Step-7): this E11000 catch is the OTHER
              // buildingId-reassign path (a concurrent import for the same ATAK
              // won the create race and may have linked the property to a
              // DIFFERENT building). Apply the SAME cross-building steal guard
              // as the else-branch so the race loser can't double-link it.
              {
                const otherBuilding = await Collections.Building.findOne({
                  realmId: realm!._id,
                  'units.propertyId': String(property._id)
                }).lean();
                if (
                  otherBuilding &&
                  String((otherBuilding as any)._id) !== String(building!._id)
                ) {
                  throw new ServiceError(
                    `Property ${parsedUnit.atakNumber} is already linked to a unit in another building (${(otherBuilding as any).name || 'unknown'}). Remove that unit first, or re-import into that building.`,
                    422
                  );
                }
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
          // Round-1 audit H10: refuse to STEAL a property already linked to a
          // unit in a DIFFERENT building. The by-ATAK find above is
          // realm-scoped (not building-scoped); without this guard the import
          // reassigns property.buildingId + pushes a fresh unit onto this
          // building while the OTHER building keeps its orphan unit for the
          // same propertyId — rent computation then walks both buildings and
          // double-bills the koinochrista. Mirror the addUnit guard exactly.
          const otherBuilding = await Collections.Building.findOne({
            realmId: realm!._id,
            'units.propertyId': String(property._id)
          }).lean();
          if (
            otherBuilding &&
            String((otherBuilding as any)._id) !== String(building!._id)
          ) {
            throw new ServiceError(
              `Property ${parsedUnit.atakNumber} is already linked to a unit in another building (${(otherBuilding as any).name || 'unknown'}). Remove that unit first, or re-import into that building.`,
              422
            );
          }
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

        // OWNER-IDENTITY: the primary E9 υπόχρεος is an `external` owner of
        // record (a person on the books), identified by name + ΑΦΜ — NOT the
        // app user importing the file. Stamping the importing user's memberId
        // here is what collapsed every distinct imported owner into one bucket
        // (ownerKeyOf keys on memberId first). Co-owner triplets the parser
        // detected are appended the same way (they carry their own AFM); a
        // follow-up flow can reconcile any of them to realm members by taxId.
        const primaryTaxId = (parsed.owner as any).taxId || '';
        const owners: any[] = [
          {
            type: 'external',
            name: ownerFullName,
            percentage: parsedUnit.ownershipPercentage,
            taxId: primaryTaxId || undefined
          }
        ];
        for (const co of (parsedUnit as any).coOwners || []) {
          // A parsed co-owner with no ΑΦΜ is unidentifiable/unsettleable (and
          // the parser can emit a phantom one — see _mergeCoOwners). Skip it;
          // ownerSlicesOf renders the un-named remainder as a "λοιποί" slice.
          if (!co.taxId) continue;
          owners.push({
            type: 'external',
            name: `ΑΦΜ ${co.taxId}`,
            percentage: co.percentage,
            taxId: co.taxId
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

    // REALM-SCOPED ΑΦΜ RECONCILIATION: the per-unit backfill above only
    // collapses the SAME physical unit's owner row (n:name| → n:name|taxId).
    // But the same owner can appear ΑΦΜ-less on OTHER units/buildings from a
    // prior import that dropped the ΑΦΜ — those stay split as a second owner
    // row on the owners page (adversarial finding, June 2026 round-4). Now that
    // this E9 carries the filer's ΑΦΜ, backfill it onto every ΑΦΜ-less owner
    // row of the SAME name across the realm — but ONLY when the name is
    // realm-wide UNAMBIGUOUS (no existing owner of that name already carries a
    // DIFFERENT ΑΦΜ). If the name is ambiguous, skip (the operator reconciles
    // via the manual co-owner editor) rather than stamp a wrong identity.
    const filerTaxId = (parsed.owner as any).taxId || '';
    if (filerTaxId && ownerFullName) {
      const realmBuildings = await Collections.Building.find({
        realmId: realm!._id
      });
      const ambiguous = realmBuildings.some((b: any) =>
        (b.units || []).some((u: any) =>
          (u.owners || []).some(
            (o: any) =>
              o.name === ownerFullName && o.taxId && o.taxId !== filerTaxId
          )
        )
      );
      if (!ambiguous) {
        for (const b of realmBuildings as any[]) {
          let touched = false;
          for (const u of b.units || []) {
            const unitOwners = (u.owners || []) as any[];
            // PER-UNIT DISAMBIGUATION (mirrors the ATAK/DEH backfill guards):
            // only stamp filerTaxId onto a taxId-less owner when the name is
            // UNIQUE on this unit AND no owner on this unit already carries
            // filerTaxId. Otherwise two same-named co-owners on one unit (a
            // common Greek name) would both get the filer's ΑΦΜ — flipping the
            // second person's ledger identity to the filer. The realm-wide
            // `ambiguous` check above only catches a DIFFERENT existing taxId;
            // two taxId-less same-name owners on one unit slip past it, so this
            // per-unit guard is required (round-4 review).
            const nameMatchesOnUnit = unitOwners.filter(
              (o: any) => o.name === ownerFullName
            );
            const filerTaxIdOnUnit = unitOwners.some(
              (o: any) => o.taxId && o.taxId === filerTaxId
            );
            if (nameMatchesOnUnit.length !== 1 || filerTaxIdOnUnit) continue;
            const target = nameMatchesOnUnit[0];
            if (!target.taxId) {
              target.taxId = filerTaxId;
              touched = true;
            }
          }
          if (touched) {
            b.updatedDate = new Date();
            // BEST-EFFORT: this is a cosmetic owner-row dedup (it only collapses
            // n:name| into n:name|taxId on the owners page — it writes NO core
            // import data). It touches potentially every same-named-owner
            // building in the realm, INCLUDING pre-existing legacy buildings
            // whose full-document validation may fail on save (CLAUDE.md notes
            // partially-corrupt legacy rows exist). This step MUST NEVER fail
            // the import: it runs INSIDE the import try, whose catch rolls back
            // (deletes) every building/property the import just created. So
            // swallow ALL save errors here (a 409 concurrency conflict OR a
            // legacy-row ValidationError) — log and move on; the owners page
            // shows the un-collapsed split row until the next reconcile. Do NOT
            // re-throw (round-4-review-2: re-throwing a non-409 ValidationError
            // nuked a fully-successful import).
            try {
              await _saveBuildingWithVersionCheck(b);
            } catch (reconErr: any) {
              logger.warn(
                `E9 import: realm-scoped ΑΦΜ backfill skipped building ${String(
                  b._id
                )} (${
                  reconErr?.statusCode === 409
                    ? 'concurrent modification'
                    : String(reconErr)
                })`
              );
            }
          }
        }
      } else {
        logger.info(
          `E9 import: skipped realm-scoped ΑΦΜ backfill for ambiguous owner name "${ownerFullName}" (another owner of that name already carries a different ΑΦΜ)`
        );
      }
    }

    // Import route: skip the §5 breakdown (no Overview tile rendered from the
    // import dialog response) — L4.
    const result = await _toBuildingData(realm!._id, createdBuildings, false);
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

// Validate + normalise a unit's owners[] coming from the manual unit editor.
// Each owner: name (required, non-empty), optional taxId, percentage in
// [0,100]. The sum of percentages must be ≤ 100 (a unit can be under-declared
// — a co-owner not yet entered — but never over 100). Returns the normalised
// owners array (type defaulted to 'external'), or undefined when the body
// carries no owners key (leave the field untouched on update). Throws 422 on
// any violation.
function _validateUnitOwners(rawOwners: any): any[] | undefined {
  if (rawOwners === undefined) return undefined;
  if (!Array.isArray(rawOwners)) {
    throw new ServiceError('owners must be an array', 422);
  }
  let sum = 0;
  const owners = rawOwners.map((o: any, i: number) => {
    const name = String(o?.name || '').trim();
    if (!name) {
      throw new ServiceError(`owner #${i + 1}: name is required`, 422);
    }
    const pct = Number(o?.percentage);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new ServiceError(
        `owner #${i + 1}: percentage must be between 0 and 100`,
        422
      );
    }
    sum += pct;
    const taxId = String(o?.taxId || '').trim();
    return {
      type: o?.type === 'member' ? 'member' : 'external',
      name,
      percentage: pct,
      ...(taxId ? { taxId } : {}),
      ...(o?.memberId ? { memberId: String(o.memberId) } : {})
    };
  });
  // Allow a tiny rounding slack over 100.
  if (sum > 100.5) {
    throw new ServiceError(
      `owner percentages sum to ${sum}% (must be ≤ 100%)`,
      422
    );
  }
  return owners;
}

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
  // Manual co-owner editor: validate + normalise owners[] (name + % ≤ 100).
  const validatedOwnersAdd = _validateUnitOwners(req.body.owners);
  if (validatedOwnersAdd !== undefined) req.body.owners = validatedOwnersAdd;
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

  // owner-occupied REQUIRES a linked property. The building-expense breakdown
  // (1_base.ts) skips any unit with no propertyId, so an owner_occupied unit
  // without one would silently route its owner-resident share to €0 — the
  // owner never sees the cost they genuinely owe, with no Αχρέωτα warning.
  // Reject at the write side (mirrors the B-C guard's placement).
  if (req.body.occupancyType === 'owner_occupied' && !req.body.propertyId) {
    throw new ServiceError(
      'Η ιδιοκατοίκηση απαιτεί συνδεδεμένο ακίνητο — συνδέστε πρώτα το ακίνητο της μονάδας.',
      422
    );
  }

  // B-C (add path): a NEW unit can't be created owner-occupied on a property a
  // tenant actively rents — same mutually-exclusive rule as updateUnit, DATE-
  // aware so a moved-out tenant doesn't block it.
  if (req.body.occupancyType === 'owner_occupied' && req.body.propertyId) {
    const currentTerm = Number(moment.utc().format('YYYYMM')) * 10000 + 100;
    const occupiedNow = await _occupiedPropertyIdsForTerm(
      building as any,
      realm!._id as string,
      currentTerm
    );
    if (occupiedNow.has(String(req.body.propertyId))) {
      throw new ServiceError(
        'Η μονάδα είναι ενοικιασμένη — τερματίστε πρώτα τη μίσθωση πριν την ορίσετε ως ιδιοκατοίκηση.',
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
  // Manual co-owner editor: validate + normalise owners[] (name + % ≤ 100).
  const validatedOwnersUpd = _validateUnitOwners(req.body.owners);
  if (validatedOwnersUpd !== undefined) req.body.owners = validatedOwnersUpd;
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
  const oldOccupancyType = unit.occupancyType;

  // owner-occupied REQUIRES a linked property (see addUnit). Gate on the
  // EFFECTIVE state after this update, not only on what the body carries:
  //   - effectiveOccupancy: body value if sent, else the unit's current type
  //   - effectivePropertyId: body value if sent, else the current propertyId
  // Reject any update that would LEAVE the unit owner_occupied with an empty
  // propertyId — including the Step-7 bypass of clearing propertyId ('') on an
  // ALREADY owner_occupied unit without resending occupancyType. Otherwise
  // 1_base.ts (skips !propertyId units) drops the owner-resident share to €0.
  {
    const effectiveOccupancy =
      req.body.occupancyType !== undefined
        ? req.body.occupancyType
        : oldOccupancyType;
    const effectivePropertyId =
      req.body.propertyId !== undefined ? req.body.propertyId : oldPropertyId;
    if (effectiveOccupancy === 'owner_occupied' && !effectivePropertyId) {
      throw new ServiceError(
        'Η ιδιοκατοίκηση απαιτεί συνδεδεμένο ακίνητο — συνδέστε πρώτα το ακίνητο της μονάδας.',
        422
      );
    }
  }

  // B-C: refuse to mark a unit owner-occupied while a tenant actively rents its
  // property — the two states are mutually exclusive (a unit can't both bill a
  // tenant rent AND route its expense share to a resident owner). Mirror the
  // active-tenant guard removeUnit already has, but DATE-AWARE (via the shared
  // occupancy helper) so a TERMINATED / moved-out tenant does NOT block the
  // flip. The UI disables the switch too; this is the authoritative gate a raw
  // API call can't bypass.
  if (
    req.body.occupancyType === 'owner_occupied' &&
    oldOccupancyType !== 'owner_occupied' &&
    (req.body.propertyId || oldPropertyId)
  ) {
    const currentTerm = Number(moment.utc().format('YYYYMM')) * 10000 + 100;
    const occupiedNow = await _occupiedPropertyIdsForTerm(
      building as any,
      realm!._id as string,
      currentTerm
    );
    const pidToCheck = String(req.body.propertyId || oldPropertyId);
    if (occupiedNow.has(pidToCheck)) {
      throw new ServiceError(
        'Η μονάδα είναι ενοικιασμένη — τερματίστε πρώτα τη μίσθωση πριν την ορίσετε ως ιδιοκατοίκηση.',
        422
      );
    }
  }

  unit.set(req.body);
  // B-A: recompute owner-side rows on ANY occupancy change (was scoped to
  // owner_occupied transitions only, so rented↔vacant/parking flips left stale
  // owner / uncollected money). recomputeVacantOwnerForProperties is a no-op
  // when nothing owner-side changed, so widening the trigger is safe.
  const occupancyChanged = unit.occupancyType !== oldOccupancyType;

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

  // OWNER-RESIDENT MATERIALISATION: a unit flipping into/out of owner_occupied
  // changes whether its building-expense share is an owner-resident charge
  // (the resident owner's own cost, flag-independent) vs a vacant/uncollected
  // share. The owner-row materialiser is otherwise only triggered by expense
  // edits + tenancy lifecycle — NOT a bare occupancyType edit — so without this
  // the ledger/dashboard/breakdown kept a stale owner-resident row (or missed a
  // new one) until some unrelated recompute ran (round-4 review). Refresh the
  // ±12-month owner rows for the affected property now.
  if (occupancyChanged) {
    const pid = String(req.body.propertyId || oldPropertyId || '');
    if (pid) {
      await recomputeVacantOwnerForProperties(realm!._id as string, [pid]);
      // Also redistribute REPAIR shares: an occupancy flip changes whether a
      // repair's tenant-share bills the tenant, the resident owner, or Αχρέωτα.
      // The expense twin above only refreshes expense-sourced owner rows; the
      // repair twin refreshes repair-vacant rows so a bare owner move-in/out
      // (no tenant lifecycle event) doesn't leave a stale repair-vacant row
      // until the next repair edit (Step-7 follow-up (b)). Best-effort — a
      // redistribution failure must not fail the unit edit.
      try {
        await redistributeRepairsForProperties(realm!._id as string, [pid]);
      } catch (err) {
        logger.error(`repair redistribution after occupancy flip failed: ${err}`);
      }
    }
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

  // --- ALL read-only guards run BEFORE any mutation, so a rejected delete
  //     never leaves the building/property half-mutated. ---
  const pid = unit.propertyId ? String(unit.propertyId) : null;
  const scopedOwnerRows: any[] = pid
    ? ((building as any).ownerMonthlyExpenses || []).filter(
        (r: any) => String(r.propertyId) === pid
      )
    : [];

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
  }

  // An owner charge row (source 'vacant' / 'repair-vacant' / 'owner-resident' /
  // 'credit') stores only propertyId — the owner ledger reader re-resolves the
  // owner(s) via propertyId → unit.owners. Once the unit is gone that lookup
  // fails and ownermanager falls through to the BUILDING-WIDE owner set
  // (ownermanager.ts ~514-519), silently re-attributing the row's money to the
  // wrong owners. A SETTLEMENT-BEARING row therefore BLOCKS the delete: real
  // money is attached; the landlord must settle/cancel it first (mirrors the
  // active-tenant guard above and the "never drop recorded payments" invariant).
  // Checked BEFORE any write so the 422 leaves nothing half-mutated.
  //
  // "settlement-bearing" MUST match the settlement definition the rest of the
  // codebase uses so the guard can't disagree with the readers:
  //   - a positive recorded payment: payments.some(amount > 0)  (ownerstatement.ts:141)
  //   - OR paid===true with NO payments: setOwnerExpensePaid marks a row paid
  //     WITHOUT pushing a payment (a valid recorded settlement state); a bare
  //     `payments.length > 0` check missed this and would DELETE a paid row.
  const isSettlementBearing = (r: any) =>
    r.paid === true ||
    (r.payments || []).some((p: any) => Number(p && p.amount) > 0);
  const settledScoped = scopedOwnerRows.filter(isSettlementBearing);
  if (settledScoped.length) {
    throw new ServiceError(
      'Η μονάδα δεν μπορεί να διαγραφεί: υπάρχουν καταχωρημένες καταβολές ιδιοκτήτη σε χρεώσεις της. Τακτοποιήστε ή ακυρώστε τις πρώτα.',
      422
    );
  }

  // --- guards passed → now mutate. ---
  if (unit.propertyId) {
    await Collections.Property.findOneAndUpdate(
      { _id: unit.propertyId, realmId: realm!._id },
      { $unset: { buildingId: '' } }
    );
  }

  // Drop this unit's UNSETTLED propertyId-scoped owner rows so no orphan
  // survives to misattribute. Settlement-bearing rows were blocked above, so
  // nothing with recorded money is ever pulled here.
  for (const r of scopedOwnerRows) {
    if (isSettlementBearing(r)) continue;
    (building as any).ownerMonthlyExpenses.pull(r._id);
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

// Allocate an OWNER-ONLY euro amount (a fixed ownerAmount or a landlord-typed
// variable owner amount) across a building's MANAGED units, returning one
// {propertyId, share} per unit with Σ(share) === amount EXACTLY.
//
// CRITICAL (Step-7): this MUST NOT reuse the tenant `equal` allocator
// (computeBuildingChargeForProperty with _tenantGroups). That allocator divides
// by tenant PARTIES and collapses a multi-unit tenant's units onto ONE carrier
// (the others return 0) — correct for a tenant-billed expense, but WRONG for an
// owner-only amount, which is an OWNER cost that must split per UNIT among the
// units' owners regardless of who rents them. Routing it through the tenant
// allocator billed one unit's owner €0 and double-billed the carrier unit's
// owner (Step-7 #6/#10/#12). Likewise `fixed` reads customAllocations (the
// TENANT split) and ignores the amount → split equally instead (Step-7 #1/#2).
//
//   - equal / fixed → split equally over managed units, carrier-remainder on the
//     lex-max propertyId so Σ === amount.
//   - thousandths / surface → per-unit ratio over the FULL building denominator
//     (occupancy-independent already); residual snapped onto the largest share.
//   - custom_ratio / custom_percentage → the engine's per-unit value (these are
//     genuine per-unit allocations); residual snapped.
// `buildingPlainNoGroups` is a plain building snapshot WITHOUT _tenantGroups, so
// even if a thousandths/surface path falls through, the equal fallback is the
// per-managed-unit one (1_base ~891), never the tenant-party split.
function _allocateOwnerAmountPerUnit(
  buildingPlainNoGroups: any,
  amount: number,
  allocationMethod: string,
  term: number,
  // The source expense's customAllocations — REQUIRED for custom_ratio /
  // custom_percentage / single_unit so the engine can compute the per-unit
  // distribution of the OWNER amount (Step-7 r2 #7/#10). custom_ratio /
  // custom_percentage describe per-unit RATIOS/PERCENTAGES (applicable to any
  // amount); single_unit targets one unit — all genuine per-unit allocations,
  // UNLIKE 'fixed' whose customAllocations are absolute TENANT euros (handled by
  // the equal branch). Omitted → custom_*/single_unit can't allocate and the
  // caller falls back to a building-wide lump.
  customAllocations?: any[]
): { propertyId: string; share: number }[] {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0)) return [];
  const managed = (buildingPlainNoGroups.units || []).filter(
    (u: any) => u.propertyId
  );
  if (managed.length === 0) return [];
  const method = allocationMethod || 'equal';
  let perUnit: { propertyId: string; share: number }[] = [];
  if (method === 'equal' || method === 'fixed') {
    // Equal split over MANAGED UNITS (NOT tenant parties). Carrier-remainder on
    // the lex-max propertyId so Σ === amount. 'fixed' joins here because its
    // customAllocations are the TENANT euro split, NOT a description of the
    // owner amount (Step-7 #1/#2).
    const ids = managed.map((u: any) => String(u.propertyId)).sort();
    const base = Math.round((amt / ids.length) * 100) / 100;
    perUnit = ids.map((pid: string, i: number) => ({
      propertyId: pid,
      share:
        i === ids.length - 1
          ? Math.round((amt - base * (ids.length - 1)) * 100) / 100
          : base
    }));
  } else if (
    method === 'general_thousandths' ||
    method === 'heating_thousandths' ||
    method === 'elevator_thousandths'
  ) {
    // Thousandths over the MANAGED denominator only (Step-7 r4 #1). The TENANT
    // engine divides thousandths over the FULL building (incl. unmanaged units),
    // intentionally leaking a vacant/unmanaged unit's share to the owner. But the
    // owner AMOUNT is an owner-only euro figure the landlord entered for the
    // MANAGED portfolio — it must be CONSERVED across managed units, not leaked
    // to an unmanaged unit that has no owner row (which silently under-billed the
    // owner by the unmanaged thousandths share). Carrier-remainder on lex-max.
    const key =
      method === 'general_thousandths'
        ? 'generalThousandths'
        : method === 'heating_thousandths'
          ? 'heatingThousandths'
          : 'elevatorThousandths';
    const totalT = managed.reduce(
      (s: number, u: any) => s + (Number(u[key]) || 0),
      0
    );
    if (totalT > 0) {
      const withT = managed
        .filter((u: any) => (Number(u[key]) || 0) > 0)
        .map((u: any) => String(u.propertyId))
        .sort();
      let allocated = 0;
      for (let i = 0; i < withT.length; i++) {
        const u = managed.find(
          (m: any) => String(m.propertyId) === withT[i]
        );
        const raw = (amt * (Number(u[key]) || 0)) / totalT;
        const share =
          i === withT.length - 1
            ? Math.round((amt - allocated) * 100) / 100
            : Math.round(raw * 100) / 100;
        if (i < withT.length - 1) allocated = Math.round((allocated + share) * 100) / 100;
        if (share > 0) perUnit.push({ propertyId: withT[i], share });
      }
    }
  } else {
    // surface / custom_ratio / custom_percentage / single_unit → per-unit value
    // from the engine (surface uses the MANAGED denominator + carrier-remainder;
    // custom_* read the threaded customAllocations). buildingPlainNoGroups carries
    // NO _tenantGroups.
    for (const u of managed) {
      const share = computeBuildingChargeForProperty(
        buildingPlainNoGroups,
        String(u.propertyId),
        {
          amount: amt,
          allocationMethod: method,
          ...(customAllocations ? { customAllocations } : {})
        } as any,
        term
      );
      const r = Math.round(share * 100) / 100;
      if (r > 0) perUnit.push({ propertyId: String(u.propertyId), share: r });
    }
  }
  // CONSERVATION SNAP: a per-unit ROUNDING residual (a few cents) is snapped onto
  // the largest share so Σ === amount EXACTLY. equal/fixed/thousandths/surface
  // are full-coverage methods → any residual is rounding, always snap. BUT
  // custom_percentage / custom_ratio legitimately sum to LESS than 100% (the
  // tenant engine leaves that gap UNBILLED), so for those we snap ONLY the
  // rounding part and LEAVE the deliberate gap unbilled (Step-7 r3 #3 / r4 #3):
  // bound the snap by the intended coverage, not a flat euro band.
  if (perUnit.length > 0) {
    const sum = perUnit.reduce((s, p) => s + p.share, 0);
    let target = amt; // full-coverage methods → conserve the whole amount
    if (
      (method === 'custom_percentage' || method === 'custom_ratio') &&
      Array.isArray(customAllocations) &&
      customAllocations.length
    ) {
      if (method === 'custom_percentage') {
        const pct = customAllocations.reduce(
          (s: number, a: any) => s + (Number(a.value) || 0),
          0
        );
        // Mirror the ENGINE's isFullSplit test (1_base custom_percentage,
        // |Σ%−100|<0.05 → full split with carrier-remainder) so the allocator and
        // the engine agree on whether ~100% means "full" (Step-7 r6 #5): e.g. 3×
        // 33.33% = 99.99 is a FULL 3-way split → target the whole amount and snap
        // the cent. Only a MATERIALLY <100% sum is a deliberate partial → target
        // just the intended coverage and leave the gap unbilled.
        target =
          Math.abs(pct - 100) < 0.05
            ? amt
            : Math.round(amt * (Math.min(pct, 100) / 100) * 100) / 100;
      }
      // custom_ratio always covers 100% of the amount (shares are relative) → amt.
    }
    const residual = Math.round((target - sum) * 100) / 100;
    const roundingTolerance = managed.length * 0.01 + 0.01;
    if (Math.abs(residual) >= 0.005 && Math.abs(residual) <= roundingTolerance) {
      const largest = perUnit.reduce((a, b) => (b.share > a.share ? b : a));
      largest.share = Math.round((largest.share + residual) * 100) / 100;
    }
  }
  return perUnit;
}

// A FIFO queue over a legacy lump's ORIGINAL payments, used to migrate the
// recorded καταβολές onto the new per-unit rows while PRESERVING each payment's
// own ownerKey / date / type / reference (Step-7 r3 #4 — the prior code
// re-stamped every drained sub-payment with payments[0]'s metadata, collapsing
// two co-owners' tagged payments onto one key and losing installment dates).
// `take(room)` draws up to `room` euros off the front of the queue, splitting a
// payment when it straddles the room boundary, and returns the taken sub-payment
// objects (each carrying its source payment's metadata). `remaining()` is the
// undrained euro left (→ the building-level standing credit).
function _makePaymentQueue(payments: any[]) {
  const q = (Array.isArray(payments) ? payments : [])
    .map((p) => ({
      date: p.date,
      amount: Math.round((Number(p.amount) || 0) * 100) / 100,
      type: p.type || 'transfer',
      reference: p.reference || '',
      description: p.description || '',
      ownerKey: p.ownerKey || null
    }))
    .filter((p) => p.amount > 0.005);
  return {
    take(room: number): any[] {
      let left = Math.round(Number(room) * 100) / 100;
      const out: any[] = [];
      while (left > 0.005 && q.length) {
        const head = q[0];
        const give = Math.min(head.amount, left);
        out.push({ ...head, amount: Math.round(give * 100) / 100 });
        head.amount = Math.round((head.amount - give) * 100) / 100;
        left = Math.round((left - give) * 100) / 100;
        if (head.amount <= 0.005) q.shift();
      }
      return out;
    },
    remaining(): any[] {
      return q.map((p) => ({ ...p }));
    },
    remainingTotal(): number {
      return Math.round(q.reduce((s, p) => s + p.amount, 0) * 100) / 100;
    }
  };
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
  // A SEPARATE plain snapshot WITHOUT _tenantGroups for OWNER-amount allocation:
  // the owner amount must split per-UNIT, never by tenant party (Step-7
  // #6/#10/#12). _allocateOwnerAmountPerUnit uses this so an equal fallback is
  // per-managed-unit, not tenant-party.
  const buildingPlainNoGroups = (building as any).toObject();

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
        //
        // κυμαινόμενο correction: a variable monthly expense (amount=0 on
        // the expense record, landlord types the total each month) combined
        // with allocationMethod='fixed' is an invalid state the old UI
        // allowed. 'fixed' reads customAllocations which may point to wrong
        // units. For the monthly-statement save (which IS the variable-amount
        // path), treat fixed+amount-0 as 'equal' so the typed total splits
        // correctly across managed occupied units.
        const effectiveMethod = (() => {
          if (
            allocationMethod === 'fixed' &&
            (Number(buildingExpense?.amount) || 0) === 0
          ) {
            return 'equal';
          }
          return allocationMethod;
        })();
        const share = computeBuildingChargeForProperty(
          buildingPlain,
          String(unit.propertyId),
          {
            ...(buildingExpense?.toObject?.() || {}),
            amount: entry.amount,
            allocationMethod: effectiveMethod
          },
          Number(term)
        );

        if (share > 0) {
          unit.monthlyCharges.push({
            term: Number(term),
            amount: Math.round(share * 100) / 100,
            // Stamp the full entered statement figure on every per-unit
            // share so the form can read back what the landlord typed
            // (summing shares under-reports when a unit is vacant / a
            // share rounds, eroding the value on re-save).
            inputAmount: Math.round(Number(entry.amount) * 100) / 100,
            description,
            expenseId: entry.expenseId
          });
        }
      }
    }
  }

  // Handle owner expenses (the landlord-typed VARIABLE owner amounts for this
  // term → source:'expense' rows). This writer OWNS only source:'expense'
  // rows; it must NOT touch the other sources that share the term:
  //   - 'vacant' / 'repair-vacant' are re-derived by their own recomputes,
  //   - 'repair' is owned by _distributeRepairCharge.
  // The previous code stripped EVERY ownerMonthlyExpense for the term
  // (source-blind) and re-added only the expense ones, so saving a monthly
  // statement DELETED the vacant / repair-vacant / repair owner charges for
  // that term (data loss). Scope the strip to source:'expense' only.
  if (ownerExpensesProvided) {
    // Snapshot the landlord-recorded SETTLEMENT (payments + derived paid) on the
    // source:'expense' rows before the strip+rebuild so re-saving a statement
    // doesn't wipe recorded καταβολές. PER-UNIT now (keyed expenseId|propertyId)
    // because the owner amount is materialised per-unit (see below); the legacy
    // building-wide rows (no propertyId) are also captured under expenseId|__b__
    // so a one-time migration carries their payments onto the new per-unit rows.
    const priorExpenseSettle = new Map<string, any>();
    const priorBuildingWide = new Map<string, any>();
    for (const e of (building as any).ownerMonthlyExpenses as any[]) {
      const src = e.source || 'expense';
      if (src === 'expense' && Number(e.term) === Number(term)) {
        if (e.propertyId) {
          priorExpenseSettle.set(
            `${String(e.expenseId)}|${String(e.propertyId)}`,
            e
          );
        } else {
          priorBuildingWide.set(String(e.expenseId), e);
        }
      }
    }
    // Strip ONLY source:'expense' rows for this term (per-unit AND legacy lump).
    const idsToRemove = (building as any).ownerMonthlyExpenses
      .filter(
        (e: any) =>
          (e.source || 'expense') === 'expense' && e.term === Number(term)
      )
      .map((e: any) => e._id);
    for (const eid of idsToRemove) {
      (building as any).ownerMonthlyExpenses.pull(eid);
    }
    // Materialise each owner-tracked amount PER UNIT, allocated by the expense's
    // allocationMethod (the SAME engine the tenant side uses), so each unit's
    // share is attributed to THAT unit's owner(s) by their declared % on the
    // read surfaces — instead of one building-wide lump that the owner ledger
    // dumped entirely on the sole identified owner (MONEY BUG: ΔΟΚΙΜΗ ΒΗΤΑ,
    // 50%/100% mixed, billed the full €100 instead of her real per-unit share).
    // Σ(per-unit shares) === the entered amount (computeBuildingChargeForProperty
    // is the same conserving allocator the tenant charges use). Recorded
    // καταβολές are carried forward per-unit; a legacy building-wide row's
    // payments are re-applied to the unit rows largest-share-first so no money
    // is lost on the one-time migration.
    const arr = (building as any).ownerMonthlyExpenses;
    for (const entry of ownerExpenses) {
      if (!entry.amount || entry.amount <= 0) continue;
      const buildingExpense = (building as any).expenses.id(entry.expenseId);
      const allocationMethod =
        entry.allocationMethod ||
        buildingExpense?.allocationMethod ||
        'equal';
      const description =
        entry.description || buildingExpense?.name || 'Building charge';
      // Per-unit shares of the entered owner amount — split per MANAGED UNIT
      // (NOT tenant party; fixed→equal); Σ === entry.amount (helper snaps).
      // customAllocations threaded so custom_ratio/custom_percentage/single_unit
      // allocate per-unit instead of returning empty (Step-7 r2 #2/#6).
      const perUnit = _allocateOwnerAmountPerUnit(
        buildingPlainNoGroups,
        Number(entry.amount),
        allocationMethod,
        Number(term),
        buildingExpense?.customAllocations
      );
      // FALLBACK (Step-7 r2 #2): if the owner amount still can't be allocated
      // per-unit (no managed units / a custom expense with no usable
      // customAllocations), DON'T `continue` — that would drop the prior row's
      // recorded καταβολή (already stripped above) with no reattach. Emit ONE
      // building-wide source:'expense' row carrying the legacy payment so the
      // money survives (mirrors the owner-fixed loop's fallback).
      if (perUnit.length === 0) {
        const legacyFb = priorBuildingWide.get(String(entry.expenseId));
        const carriedFb = carryOwnerPayments(legacyFb);
        arr.push({
          expenseId: entry.expenseId,
          term: Number(term),
          amount: Math.round(Number(entry.amount) * 100) / 100,
          propertyId: null,
          description,
          source: 'expense',
          payments: carriedFb.payments
        });
        applyCarriedSettlement(arr[arr.length - 1], carriedFb);
        continue;
      }
      // Migrate a legacy building-wide row's recorded payments onto the new
      // per-unit rows, largest share first, so the total preserved === what was
      // recorded (no money lost when an old lump row is split).
      const legacy = priorBuildingWide.get(String(entry.expenseId));
      const legacyCarried = legacy ? carryOwnerPayments(legacy) : null;
      const migrationPayments = legacyCarried
        ? [...legacyCarried.payments]
        : [];
      // ORPHAN-FLOW (Step-7 r6 #4 — parity with the owner-fixed loop): a prior
      // per-unit 'expense' row whose unit LEFT the new allocation (single_unit/
      // custom retarget, equal share → 0) must FLOW its payment onto the new
      // target unit — but ONLY if the payer owns a surviving target unit. A
      // foreign-tagged payment stays in priorExpenseSettle and the reattach-
      // orphans pass below re-attaches it as a credit on its OWN unit (so it is
      // never mis-credited to another owner — CRITICAL r6 #1 parity).
      {
        const newPidSet = new Set(perUnit.map((p) => p.propertyId));
        const unitByPid = new Map<string, any>(
          (units || [])
            .filter((u: any) => u.propertyId)
            .map((u: any) => [String(u.propertyId), u])
        );
        const targetOwnerKeys = new Set<string>();
        for (const pid of newPidSet) {
          for (const o of (unitByPid.get(pid)?.owners || []) as any[]) {
            const k = ownerKeyOf(o);
            if (k) targetOwnerKeys.add(k);
          }
        }
        const pfx = `${String(entry.expenseId)}|`;
        for (const k of Array.from(priorExpenseSettle.keys())) {
          if (!k.startsWith(pfx)) continue;
          const pid = k.slice(pfx.length);
          if (!pid || newPidSet.has(pid)) continue; // still-billed unit
          const orphanRow = priorExpenseSettle.get(k);
          const orphan = carryOwnerPayments(orphanRow);
          if (!orphan.payments.length) continue;
          const flowable = orphan.payments.every(
            (p: any) => !p.ownerKey || targetOwnerKeys.has(String(p.ownerKey))
          );
          if (flowable) {
            migrationPayments.push(...orphan.payments);
            priorExpenseSettle.delete(k); // consumed → not double-reattached
          }
          // else: leave in priorExpenseSettle → reattach-orphans makes a credit.
        }
      }
      // FIFO queue over the ORIGINAL payments (preserve each payment's
      // ownerKey/date/type/reference — Step-7 r3 #4, r2 #11).
      const legacyQueue = _makePaymentQueue(migrationPayments);
      const legacyHadPayments = legacyQueue.remainingTotal() > 0.005;
      // Bare manual-paid lump (paid=true, no payments) → carry the settled state
      // onto the per-unit rows so a settled liability doesn't re-open (Step-7 r2
      // #8/#9).
      const legacyManualPaid =
        !!(legacyCarried && legacyCarried.priorPaid) && !legacyHadPayments;
      const ordered = [...perUnit].sort((a, b) => b.share - a.share);
      for (const pu of ordered) {
        // Carry this unit's OWN prior per-unit settlement first. MARK CONSUMED
        // (delete from the map) so the reattach-orphans pass below can tell which
        // prior paid rows the rebuild did NOT recreate (Step-7 r3 #2).
        const _puKey = `${String(entry.expenseId)}|${pu.propertyId}`;
        const _prior = priorExpenseSettle.get(_puKey);
        if (_prior !== undefined) priorExpenseSettle.delete(_puKey);
        const carried = carryOwnerPayments(_prior);
        const payments = [...carried.payments];
        // Then top up from the legacy lump queue, capped at this unit's free room.
        const carriedSum = payments.reduce(
          (s: number, p: any) => s + (Number(p.amount) || 0),
          0
        );
        const room = Math.round((pu.share - carriedSum) * 100) / 100;
        if (room > 0.005) payments.push(...legacyQueue.take(room));
        arr.push({
          expenseId: entry.expenseId,
          term: Number(term),
          amount: pu.share,
          propertyId: pu.propertyId,
          description,
          source: 'expense',
          payments
        });
        recomputeOwnerExpensePaid(arr[arr.length - 1]);
        // Propagate a bare legacy manual-paid toggle (no payments) onto this row.
        if (legacyManualPaid && payments.length === 0) {
          arr[arr.length - 1].paid = true;
          arr[arr.length - 1].paidDate =
            legacyCarried.priorPaidDate || new Date();
        }
      }
      // OVERPAY PRESERVATION (Step-7 #4): undrained legacy pool → a BUILDING-LEVEL
      // standing overpayment (propertyId null) so it is counted as PAID yet never
      // cross-nets a distinct liability / mis-credits a unit (Step-7 r3 #1/#5/#6).
      // Keeps the ORIGINAL payments verbatim (each with its own ownerKey/date).
      const leftover = legacyQueue.remaining();
      if (leftover.length > 0) {
        arr.push({
          expenseId: entry.expenseId,
          term: Number(term),
          amount: 0,
          propertyId: null,
          description,
          source: 'credit',
          payments: leftover
        });
        recomputeOwnerExpensePaid(arr[arr.length - 1]);
      }
    }
    // REATTACH ORPHANS (Step-7 r3 #2): any prior per-unit source:'expense' row
    // that the rebuild did NOT recreate (its unit left the new allocation — a
    // single_unit target changed, an equal share went to 0, the unit was
    // unlinked) was deleted by the strip above and never carried forward. If it
    // held recorded καταβολές, that money would VANISH (owner payments live only
    // in these subdocs). Re-attach each un-consumed paid prior row as a
    // source:'credit' row (amount 0, payments kept) — NOT amount=paidSum
    // (Step-7 r4 #4): a remnant carrying its old amount would add a PHANTOM owed
    // line, inflating the gross owner-eksoda above the real expense when the
    // method merely changed. A credit is counted as PAID (addOwed(0) no-op),
    // so the recorded money survives without re-opening a liability. (Zero-
    // payment orphans are safe to drop.)
    for (const prior of priorExpenseSettle.values()) {
      const carried = carryOwnerPayments(prior);
      const paidSum = carried.payments.reduce(
        (s: number, p: any) => s + (Number(p.amount) || 0),
        0
      );
      if (paidSum <= 0.005) continue;
      arr.push({
        expenseId: prior.expenseId,
        term: Number(term),
        amount: 0,
        propertyId: prior.propertyId || null,
        description: prior.description || '',
        source: 'credit',
        payments: carried.payments
      });
      recomputeOwnerExpensePaid(arr[arr.length - 1]);
    }
  }

  // Materialise vacant/owner-resident owner rows for THIS term before saving.
  // Statement entry is the ONLY place a VARIABLE expense (Ρεύμα/Νερό, amount 0)
  // gets its per-unit monthlyCharges figure — and _recomputeVacantOwnerCharges
  // (which writes the owner-side source:'vacant' rows the owner tab + dashboard
  // read) was NOT fired here, only on expense/tenancy edits. So a vacant unit's
  // variable-expense share was billed in the breakdown but absent from the owner
  // tab + dashboard until an unrelated edit (Step-7: Beta 0,21 € vs ~48,81 €
  // owed). Fire it on the in-memory building for the saved term, then one
  // version-checked save (mirrors addExpense). The breakdown persistedVacantKeys
  // dedup + dashboard `covered` set suppress the now-duplicate live rows, so this
  // is additive, not double-counting (Step-7 checks 1+4 confirmed safe).
  await _recomputeVacantOwnerCharges(building, realm!._id as string, Number(term));

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

// GET /buildings/:id/expense-breakdown?term=YYYYMMDDHH
// Returns the authoritative per-recipient breakdown for the term: for each
// active expense and managed unit, the share + whether it bills a renter or
// falls on the owner (vacant). Computed with the real billing engine
// (computeBuildingExpenseBreakdown → computeBuildingChargeForProperty) so
// the breakdown the landlord sees on the Expenses tab matches what is
// actually charged.
export async function getExpenseBreakdown(req: Req, res: Res) {
  const realm = req.realm;
  const { id } = req.params;
  const term = Number(req.query.term);
  if (!term || !/^\d{10}$/.test(String(req.query.term))) {
    throw new ServiceError('Invalid term format (expected YYYYMMDDHH)', 422);
  }

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });
  _findBuilding(building, id);

  // Hydrate units[].property + units[].tenant and attach _tenantGroups,
  // exactly as the Expenses tab's building payload does, so the breakdown
  // engine sees the same shape it relies on for recipient labeling and
  // equal-split grouping.
  const [hydrated] = await _toBuildingData(realm!._id, [
    (building as any).toObject()
  ]);
  await _attachTenantGroupsToBuildings(realm!._id as string, [hydrated]);

  // ONE term-aware occupancy source for this whole handler, derived in-memory
  // from the _tenantGroups just attached (no extra Tenant query). _toBuildingData
  // attaches unit.tenant DATE-BLIND (any tenant ever linked to the property,
  // incl. terminated / future-lease), but the live engine reads unit.tenant to
  // decide recipient renter-vs-owner. So BEFORE computing the breakdown, null
  // unit.tenant for any unit NOT actually occupied for `term` — otherwise a
  // terminated/future-lease unit gets a recipient:'renter' row in the engine
  // AND a surviving owner row here = the same euro double-counted (round-4
  // review). This makes the engine's recipient and the owner-row occupancy
  // guard below share the identical predicate.
  const occupiedForBreakdown = _occupiedFromOccupancyRows(
    ((hydrated as any)._tenantGroups || []) as any[],
    term
  );
  for (const u of (hydrated as any).units || []) {
    if (u.propertyId && !occupiedForBreakdown.has(String(u.propertyId))) {
      u.tenant = null;
    }
  }

  const breakdown = computeBuildingExpenseBreakdown(hydrated as any, term);

  // Owner monthly expenses (separate stream) for this term — surfaced so
  // the breakdown also shows owner-direct charges, not only tenant shares.
  // EXCLUDE source:'vacant' entries ONLY — those building-EXPENSE vacant
  // shares are already represented in breakdown.rows as recipient:'owner'
  // rows (showing them here too would double-count). 'repair-vacant' (a
  // vacant unit's repair share) and 'repair'/'expense' ARE owner-direct
  // liabilities not in breakdown.rows, so they belong here.
  // ALL persisted owner liabilities for the term, EVERY source
  // (expense / repair / vacant / repair-vacant). The UI renders these as one
  // consolidated "Έξοδα ιδιοκτήτη" block where each row carries a paid toggle
  // (the subdoc _id is the PATCH handle). Previously source:'vacant' was
  // excluded here and re-derived live in breakdown.rows — but the live rows
  // have no persisted _id, so they could not carry a paid toggle. Sourcing
  // the whole block from the persisted ledger gives every owner liability a
  // paid handle, which is what the landlord needs to monitor settlement.
  // The persisted vacant rows are kept fresh by _recomputeVacantOwnerCharges
  // (expense edits + tenant lifecycle, ±12-month window) so for the current
  // and recent terms they equal the live computation.
  // Validate persisted source:'vacant' rows against CURRENT live state at read
  // time. The vacant recompute only re-derives the current term, so flipping
  // chargeOwnerWhenVacant OFF (or an expense going inactive) leaves orphaned
  // source:'vacant' rows for OTHER terms. If we surfaced those, the same euro
  // would show twice — once here (owner block, "owed") and once in the live
  // engine's Αχρέωτα "uncollected" section — with contradictory meaning
  // (adversarial finding, June 2026 round-2). Drop a source:'vacant' row whose
  // expense no longer exists / no longer opts in / isn't active for the term.
  // 'repair-vacant' rows are validated against repairs separately below (they
  // are stripped wholesale by _removeRepairCharges on cancel, so a surviving
  // one is genuine). 'expense'/'repair' owner-direct rows are landlord-entered
  // and always shown.
  const liveExpenseById = new Map<string, any>(
    ((hydrated as any).expenses || []).map((e: any) => [String(e._id), e])
  );
  // OCCUPANCY GUARD (mirrors the source:'vacant'/'owner-resident' occupancy-drop
  // in computeOwnerEksodaByMonth's materialised-row loop). The ±12-month vacant
  // recompute leaves source:'vacant'/'owner-resident' rows for OUT-OF-WINDOW
  // terms unchanged; if a tenant later occupies the unit for such a term, the
  // same building-expense euro is billed BOTH to the present tenant's rent
  // (1_base buildingCharges) AND surfaced here as an owner liability — a
  // double-count (adversarial finding, June 2026 round-4). Drop the stale owner
  // row when the unit is occupied for the requested term. Reuses the single
  // occupiedForBreakdown set computed above from _tenantGroups (same predicate
  // the engine recipient now uses), so the filter below is sync.
  const ownerEntries = ((hydrated as any).ownerMonthlyExpenses || []).filter(
    (e: any) => {
      if (Number(e.term) !== term) return false;
      // source:'vacant' AND 'owner-resident' are both re-derived from a
      // building expense — validate both against live state FOR THIS TERM
      // (expense gone / inactive-for-term → stale, drop). They differ in the
      // OPT-IN gate: a 'vacant' (truly-empty unit) row requires
      // chargeOwnerWhenVacant; an 'owner-resident' (the owner lives there) row
      // is the resident owner's OWN cost and is NOT flag-governed (mirrors
      // 1_base ownerBilled = isOwnerOccupied || flag). Both drop when a TENANT
      // occupies the unit FOR THE TERM (the euro is live-billed to the tenant's
      // rent → double-count). Every condition is TERM-anchored — a current-day
      // occupancy flip is the WRITER's job (updateUnit recompute), and a
      // historical owner-resident liability for a term the owner DID reside in
      // must NOT be dropped by today's occupancy (round-4-review-2 money-wrong
      // finding). A row carrying recorded payments is never dropped — recorded
      // money must survive on every settlement surface.
      if (e.source === 'vacant' || e.source === 'owner-resident') {
        const hasPayments =
          Array.isArray(e.payments) &&
          e.payments.some((p: any) => Number(p && p.amount) > 0);
        if (hasPayments) return true;
        const src = liveExpenseById.get(String(e.expenseId));
        if (!src) return false; // expense gone
        if (e.source === 'vacant' && !src.chargeOwnerWhenVacant) return false;
        if (!isExpenseActiveForTerm(src as any, term)) return false;
        // A TENANT occupying the unit live-bills this building expense to them
        // — drop the stale owner row so the euro is not counted twice.
        if (e.propertyId && occupiedForBreakdown.has(String(e.propertyId))) {
          return false;
        }
      }
      return true;
    }
  );
  const hydratedUnits = ((hydrated as any).units || []) as any[];
  const unitByPropId = new Map(
    hydratedUnits
      .filter((u: any) => u.propertyId)
      .map((u: any) => [String(u.propertyId), u])
  );
  // Owner display name for a unit. A unit can be CO-owned (units[].owners is
  // an array with per-owner percentage); showing only the first owner's name
  // silently hides co-owners. Show the first named owner and, when more than
  // one owner carries a name, append a "+N" indicator so co-ownership is
  // visible rather than misattributed to one person.
  const _ownerDisplayName = (unit: any): string | null => {
    const named = ((unit?.owners || []) as any[]).filter(
      (o: any) => o && o.name
    );
    if (named.length === 0) return null;
    return named.map((o: any) => o.name).join(', ');
  };
  // Per-owner slices (name + percentage + € split of `amount`) for an owner
  // row, so the UI can render "ΔΟΚΙΜΗ ΒΗΤΑ 50% = €50" and list every
  // co-owner. Returns [] for a single-owner unit (UI shows just the name).
  const _ownerSlicesFor = (unit: any, amount: number) => {
    const slices = ownerSlicesOf((unit?.owners || []) as any[], amount);
    return slices.length > 1 ? slices : [];
  };
  // Index the engine's per-row ShareBasis by expenseId+propertyId so an owner
  // row can show the SAME calculation explanation a renter row shows (e.g.
  // "1,70 € ÷ 11 μονάδες = 0,15 €"). The basis is computed by the live engine
  // on breakdown.rows; the persisted ownerDirect rows don't carry it, so we
  // graft it on by matching the unit + source expense.
  //
  // CRITICAL (owner-amount display fix): this graft is keyed by
  // expenseId|propertyId and carries the TENANT amount basis ("10 € ÷ 11"). A
  // per-unit OWNER-amount row (source 'owner-fixed' / 'expense') shares the same
  // expenseId+propertyId as the unit's vacant-share row, so grafting gave the
  // €9.09 owner-fixed line the WRONG "10 € ÷ 11 = 0,90 €" calc (it should read
  // "100 € ÷ 11 = 9,09 €"). The graft is correct ONLY for vacant/owner-resident
  // rows (whose euro IS the tenant-amount share routed to the owner). For
  // owner-amount rows we build the basis from the OWNER total below.
  const basisByKey = new Map<string, any>();
  for (const r of (breakdown.rows || []) as any[]) {
    if (r.basis) {
      basisByKey.set(`${String(r.expenseId)}|${String(r.propertyId)}`, r.basis);
    }
  }
  // The full OWNER amount per expense for THIS term = Σ of every per-unit owner
  // -amount row (source 'owner-fixed' or 'expense') sharing the expenseId. For
  // an equal €100 owner-fixed split across 11 units this sums the 11 × €9.09
  // rows back to €100 — the `total` the per-unit calc divides. Computed from the
  // rows themselves (not exp.ownerAmount) so it is correct for BOTH the fixed
  // (ownerAmount) and the variable (landlord-typed) owner-amount paths and needs
  // no extra stored field.
  const ownerAmountTotalByExpense = new Map<string, number>();
  for (const e of ownerEntries) {
    if ((e.source || 'expense') === 'owner-fixed' || (e.source || '') === 'expense') {
      const k = String(e.expenseId);
      ownerAmountTotalByExpense.set(
        k,
        Math.round(
          ((ownerAmountTotalByExpense.get(k) || 0) + (Number(e.amount) || 0)) * 100
        ) / 100
      );
    }
  }
  const _managedUnitsForBasis = hydratedUnits.filter((u: any) => u.propertyId);
  // Build the per-unit ShareBasis for an OWNER-amount row from the owner total
  // (not the tenant amount). Mirrors the engine's _shareBasis divisor resolution
  // (the same shape `formatBasis` renders): equal → ÷ managed-unit count;
  // thousandths/surface → unit part ÷ building whole × total. `fixed` owner
  // amounts are split equally (their customAllocations describe the TENANT
  // amount), so 'fixed' resolves to the equal basis here too.
  const _ownerAmountBasis = (
    unit: any,
    method: string,
    total: number,
    share: number
  ): any => {
    const fmt = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
    const m = method === 'fixed' ? 'equal' : method || 'equal';
    if (m === 'by_surface') {
      const whole = _managedUnitsForBasis.reduce(
        (s: number, u: any) => s + (Number(u.surface) || 0),
        0
      );
      return {
        kind: 'surface',
        part: fmt(unit?.surface || 0),
        whole: fmt(whole),
        total: fmt(total),
        share: fmt(share)
      };
    }
    if (
      m === 'general_thousandths' ||
      m === 'heating_thousandths' ||
      m === 'elevator_thousandths'
    ) {
      const key =
        m === 'general_thousandths'
          ? 'generalThousandths'
          : m === 'heating_thousandths'
            ? 'heatingThousandths'
            : 'elevatorThousandths';
      const whole = hydratedUnits.reduce(
        (s: number, u: any) => s + (Number(u[key]) || 0),
        0
      );
      return {
        kind: 'thousandths',
        part: fmt(unit?.[key] || 0),
        whole: fmt(whole),
        total: fmt(total),
        share: fmt(share)
      };
    }
    // equal / fixed (and any unmapped method) → split over managed units.
    return {
      kind: 'equal',
      count: _managedUnitsForBasis.length,
      total: fmt(total),
      share: fmt(share)
    };
  };
  // Building-wide owner rows (source:'expense'/'repair'/'owner-fixed') carry NO
  // propertyId, so they cannot resolve an owner from a single unit. Resolve
  // from the building's DISTINCT owner set instead: one distinct owner → that
  // owner's name (+ % when fractional); many → the first owner's name with a
  // "+N" indicator. Without this the row rendered the generic "Ιδιοκτήτης" with
  // no name/% (the bug the user flagged on the ΕΞΟΔΑ ΙΔΙΟΚΤΗΤΗ block).
  const buildingOwnersByKey = new Map<string, any>();
  for (const u of hydratedUnits) {
    for (const o of (u.owners || []) as any[]) {
      const k = ownerKeyOf(o);
      if (k && !buildingOwnersByKey.has(k)) buildingOwnersByKey.set(k, o);
    }
  }
  const distinctBuildingOwners = Array.from(buildingOwnersByKey.values());
  const buildingWideOwnerName = (): string | null => {
    const named = distinctBuildingOwners.filter((o: any) => o && o.name);
    if (named.length === 0) return null;
    return named.map((o: any) => o.name).join(', ');
  };
  const buildingWideOwnerPct = (): number | undefined => {
    const named = distinctBuildingOwners.filter((o: any) => o && o.name);
    if (named.length !== 1) return undefined; // only meaningful for a sole owner
    const p = Number(named[0].percentage);
    return Number.isFinite(p) && p < 100 ? p : undefined;
  };
  const ownerDirect = ownerEntries.map((e: any) => {
    // 'expense' source → id is a building expense; 'repair'/'repair-vacant'
    // → id is a repair. Resolve type + a human label from the right list so
    // an id-named row still shows its type ("Κοιν. Νερό") in the UI.
    const exp = ((hydrated as any).expenses || []).find(
      (x: any) => String(x._id) === String(e.expenseId)
    );
    const rep =
      !exp &&
      ((hydrated as any).repairs || []).find(
        (r: any) => String(r._id) === String(e.expenseId)
      );
    const unit = e.propertyId
      ? unitByPropId.get(String(e.propertyId))
      : undefined;
    const rowAmount = Math.round((Number(e.amount) || 0) * 100) / 100;
    // Owner NAME: from the row's unit when propertyId-scoped; otherwise (a
    // building-wide owner-direct/repair row with no propertyId) from the
    // building's distinct owner set — so it never renders the bare "Ιδιοκτήτης".
    const ownerName = unit
      ? _ownerDisplayName(unit)
      : buildingWideOwnerName();
    // Single owner's declared percentage (when <100), for "Name (50%)".
    const soleOwner =
      unit && (unit.owners || []).length === 1 ? unit.owners[0] : null;
    const ownerPercentage =
      soleOwner &&
      Number.isFinite(Number(soleOwner.percentage)) &&
      Number(soleOwner.percentage) < 100
        ? Number(soleOwner.percentage)
        : unit
          ? undefined
          : buildingWideOwnerPct();
    // Per-owner € slices: the unit's owners when scoped; else the building's
    // distinct owners (so a building-wide co-owned charge still splits).
    const ownerSlices = unit
      ? _ownerSlicesFor(unit, rowAmount)
      : (() => {
          const s = ownerSlicesOf(distinctBuildingOwners, rowAmount);
          return s.length > 1 ? s : [];
        })();
    return {
      // ownerExpenseId is the subdoc _id — the handle the UI PATCHes to
      // toggle paid. expenseId still points at the source expense/repair.
      ownerExpenseId: String(e._id),
      expenseId: String(e.expenseId),
      // propertyId so the UI groups owner rows by UNIT (not by the non-unique
      // propertyName — two same-named units must not merge into one owner).
      propertyId: e.propertyId ? String(e.propertyId) : null,
      expenseName: exp?.name || rep?.title || e.description || '',
      // type drives the localized fallback label; repairs use 'repair'.
      expenseType: exp?.type || (rep ? 'repair' : undefined),
      // propertyName + ownerName so a vacant-routed / repair-vacant row says
      // WHICH unit and WHOSE charge it is, not a bare id.
      propertyName: unit
        ? unit.property?.name || unit.name || String(e.propertyId)
        : null,
      ownerName: ownerName || null,
      // ownership %: the sole owner's share when fractional; co-owner slices
      // (name + % + € split of this row) so the UI can show the per-owner
      // breakdown the user asked for ("(ΒΗΤΑ 50% = €50, … 50% = €50)").
      ownerPercentage,
      owners: ownerSlices,
      amount: rowAmount,
      // Calc basis (same shape renter rows carry) so the UI can render the
      // "÷ units = share" explanation on owner rows too. For building-EXPENSE
      // owner rows the engine's per-row basis is grafted by expenseId+propertyId.
      // For REPAIR rows the engine has no basis (repairs aren't in
      // building.expenses), so we compute one from the repair (§1.2): a
      // 'repair' owner-portion shows cost × owner% (=1−tenant%); a
      // 'repair-vacant' per-unit row shows the vacant unit's tenant-share slice.
      basis: (() => {
        // OWNER-AMOUNT row (per-unit owner-fixed / variable 'expense'): build the
        // calc from the OWNER total ("100 € ÷ 11 = 9,09 €"), NOT the tenant-amount
        // graft below (which would wrongly show "10 € ÷ 11"). Only for a
        // propertyId-scoped row with a resolved owner total > 0.
        if (
          (e.source === 'owner-fixed' || e.source === 'expense') &&
          e.propertyId &&
          unit
        ) {
          const ownerTotal = ownerAmountTotalByExpense.get(String(e.expenseId));
          if (ownerTotal && ownerTotal > 0) {
            const method = exp?.allocationMethod || 'equal';
            return _ownerAmountBasis(unit, method, ownerTotal, rowAmount);
          }
        }
        const fromEngine = basisByKey.get(
          `${String(e.expenseId)}|${String(e.propertyId)}`
        );
        if (fromEngine) return fromEngine;
        if (!rep) return null;
        const cost = Number(rep.actualCost) || Number(rep.estimatedCost) || 0;
        // Stale/zero-cost repair (cost cleared after the row was materialised):
        // a "0 € × pct = nonzero" line is self-contradictory — show no basis
        // rather than a wrong explanation (Step-7 staleness note).
        if (!(cost > 0)) return null;
        const tenantPct = repairTenantSharePercentage(rep);
        if (e.source === 'repair') {
          // Building-wide owner portion = cost × (100 − tenantPct)%.
          return {
            kind: 'repair_split',
            total: Math.round(cost * 100) / 100,
            ownerPct: 100 - tenantPct,
            result: rowAmount
          };
        }
        if (e.source === 'repair-vacant') {
          // A vacant unit's slice of the tenant-billed pool, routed to the owner.
          // The pool is cost × tenantPct%; THIS row is the unit's allocated slice
          // of that pool by the repair's allocationMethod. Ship the per-unit
          // DIVISOR (part/whole/count + kind) so the UI renders the real
          // division "pool ÷/× allocation = slice", not just "pool → slice".
          const pool = Math.round(cost * (tenantPct / 100) * 100) / 100;
          const method = (rep as any).allocationMethod || 'general_thousandths';
          // Resolve the unit's part + the building total for this method, mirroring
          // _shareBasis (1_base). Managed units only, matching the billing engine.
          const mu = ((hydrated as any).units || []).filter(
            (u: any) => u.propertyId
          );
          let allocKind: string | undefined;
          let part: number | undefined;
          let whole: number | undefined;
          let count: number | undefined;
          if (method === 'by_surface') {
            allocKind = 'surface';
            part = Math.round((Number(unit?.surface) || 0) * 100) / 100;
            whole =
              Math.round(
                mu.reduce((s: number, u: any) => s + (Number(u.surface) || 0), 0) *
                  100
              ) / 100;
          } else if (
            method === 'general_thousandths' ||
            method === 'heating_thousandths' ||
            method === 'elevator_thousandths'
          ) {
            const key =
              method === 'general_thousandths'
                ? 'generalThousandths'
                : method === 'heating_thousandths'
                  ? 'heatingThousandths'
                  : 'elevatorThousandths';
            allocKind = 'thousandths';
            part = Math.round((Number((unit as any)?.[key]) || 0) * 100) / 100;
            whole =
              Math.round(
                ((hydrated as any).units || []).reduce(
                  (s: number, u: any) => s + (Number(u[key]) || 0),
                  0
                ) * 100
              ) / 100;
          } else if (method === 'equal') {
            allocKind = 'equal';
            count = mu.length;
          }
          return {
            kind: 'repair_vacant',
            total: Math.round(cost * 100) / 100,
            tenantPct,
            pool,
            result: rowAmount,
            // per-unit divisor of the pool (when resolvable):
            allocKind,
            part,
            whole,
            count
          };
        }
        return null;
      })(),
      source: e.source || 'expense',
      // kindLabel: a stable descriptor key the UI appends to the expense label so
      // the TWO owner rows a vacant unit carries — the per-unit OWNER amount
      // (source 'owner-fixed'/'expense') AND the vacant unit's share of the
      // TENANT amount (source 'vacant') — read as DISTINCT lines instead of two
      // identical "Κοιν. Νερό" rows. The UI maps these to localized suffixes.
      kindLabel:
        e.source === 'owner-fixed' || e.source === 'expense'
          ? 'owner-amount'
          : // A repair-vacant row on an OWNER-OCCUPIED unit is the resident
            // owner's own cost, not a vacant-unit share → label it owner-resident.
            e.source === 'repair-vacant' &&
              unit?.occupancyType === 'owner_occupied'
            ? 'owner-resident'
            : e.source === 'vacant'
              ? 'vacant-share'
              : e.source === 'owner-resident'
                ? 'owner-resident'
                : undefined,
      // vacant: true when this euro is a VACANT unit's share routed to the owner
      // (the tenant-amount share of an empty unit). Drives the ΚΕΝΟ pill AND the
      // collapsible "Κενές μονάδες" grouping. The per-unit OWNER amount is NOT
      // vacant-flagged (it is owed whether or not the unit is occupied), so it
      // stays in the regular ΙΔΙΟΚΤΗΤΕΣ section — restoring the grouping the
      // per-unit materialisation broke.
      // vacant ΚΕΝΟ pill: true only for a truly-empty unit's share. A
      // repair-vacant row on an OWNER-OCCUPIED unit is the resident owner's
      // cost, NOT a vacant-unit charge, so it stays in the regular ΙΔΙΟΚΤΗΤΕΣ
      // section (no ΚΕΝΟ pill).
      vacant:
        (e.source === 'vacant' || e.source === 'repair-vacant') &&
        unit?.occupancyType !== 'owner_occupied',
      paid: !!e.paid
    };
  });
  // RECONCILE the live engine's owner-BILLED vacant rows against the
  // persisted ledger, so the owner block is COMPLETE without double-counting:
  //
  //  - The live engine (computeBuildingExpenseBreakdown) emits a
  //    recipient:'owner', ownerBilled:true row for every vacant unit whose
  //    expense has chargeOwnerWhenVacant ON — for the requested term, even
  //    terms OUTSIDE the ±12-month recompute window that never got a persisted
  //    source:'vacant' row.
  //  - ownerDirect (above) already contains the PERSISTED source:'vacant'
  //    rows (which carry the paid handle).
  //
  // For each live owner-billed row, if a persisted vacant row already covers
  // the same expenseId+propertyId we DROP the live one (the persisted row is
  // authoritative and toggle-able — prevents the double-count the adversarial
  // review found). If NO persisted row exists (out-of-window term), we
  // synthesize a read-only ownerDirect entry (no ownerExpenseId → no paid
  // toggle) so the owner-billed money is still VISIBLE instead of vanishing.
  // Both 'vacant' AND 'owner-resident' persisted rows correspond to a live
  // engine owner-billed row (the engine emits ownerBilled:true for empty units
  // with the flag AND for owner-occupied units). Match on BOTH so the live row
  // is dropped when a persisted row already covers the same expense+unit —
  // otherwise an owner-occupied unit's share double-counts (persisted
  // 'owner-resident' + synthesized live row).
  const persistedVacantKeys = new Set(
    ownerEntries
      .filter(
        (e: any) => e.source === 'vacant' || e.source === 'owner-resident'
      )
      .map((e: any) => `${String(e.expenseId)}|${String(e.propertyId)}`)
  );
  const ownerBilledLive = (breakdown.rows || []).filter(
    (r: any) => r.recipient === 'owner' && r.ownerBilled
  );
  for (const r of ownerBilledLive) {
    const key = `${String(r.expenseId)}|${String(r.propertyId)}`;
    if (persistedVacantKeys.has(key)) continue; // covered by a persisted row
    const unit = unitByPropId.get(String(r.propertyId));
    const ownerName = unit ? _ownerDisplayName(unit) : null;
    const rowAmount = Math.round((Number(r.amount) || 0) * 100) / 100;
    const soleOwner =
      unit && (unit.owners || []).length === 1 ? unit.owners[0] : null;
    const ownerPercentage =
      soleOwner &&
      Number.isFinite(Number(soleOwner.percentage)) &&
      Number(soleOwner.percentage) < 100
        ? Number(soleOwner.percentage)
        : undefined;
    ownerDirect.push({
      ownerExpenseId: null, // not persisted → read-only (no paid toggle)
      expenseId: String(r.expenseId),
      propertyId: r.propertyId ? String(r.propertyId) : null,
      expenseName: r.expenseName || '',
      expenseType: r.expenseType,
      propertyName: r.propertyName || null,
      ownerName: ownerName || null,
      ownerPercentage,
      // live engine row already carries per-owner slices (r.owners); fall back
      // to recomputing from the unit if absent.
      owners:
        r.owners && r.owners.length > 1
          ? r.owners
          : unit
            ? _ownerSlicesFor(unit, rowAmount)
            : [],
      amount: rowAmount,
      basis: r.basis || null, // live row carries its own calc basis
      // owner-occupied unit → 'owner-resident' (owner's own cost); empty → 'vacant'.
      source:
        unit && unit.occupancyType === 'owner_occupied'
          ? 'owner-resident'
          : 'vacant',
      paid: false
    });
  }

  // NOTE: `rows` is returned INTACT (owner-billed rows included). The engine's
  // row set is the authoritative breakdown; consumers that want the per-unit
  // owner-billed shares (and the spec that asserts the equal-vacant party
  // lands as a recipient:'owner', ownerBilled:true row) read it here. The
  // frontend does NOT double-render: ChargeBreakdown renders the owner block
  // from `ownerDirect` (persisted/paid-toggleable) and reads `rows` only for
  // renter rows and the uncollected filter (recipient:'owner' && !ownerBilled),
  // so owner-billed `rows` entries are simply not rendered there. The earlier
  // attempt to STRIP owner-billed rows from `rows` broke that engine contract
  // (spec 49.1) for no rendering benefit — removed.
  const ownerDirectTotal =
    Math.round(
      ownerDirect.reduce((s: number, e: any) => s + e.amount, 0) * 100
    ) / 100;

  return res.json({
    term,
    rows: breakdown.rows,
    ownerDirect,
    tenantTotal: breakdown.tenantTotal,
    ownerUnbilledTotal: breakdown.ownerUnbilledTotal,
    ownerBilledTotal: breakdown.ownerBilledTotal,
    ownerDirectTotal
  });
}

// PATCH /buildings/:id/owner-expense/:ownerExpenseId/paid  { paid: boolean }
// Toggle an owner-side monthly-expense row's paid flag. Drives the Overview
// "owner expenses paid vs unpaid" progress tile. Only the four owner-side
// sources are togglable (every ownerMonthlyExpenses row is owner-side, so no
// source filter is needed — but tenant-billed shares never live here). The
// paidDate is stamped on transition to paid and cleared on un-pay.
export async function setOwnerExpensePaid(req: Req, res: Res) {
  const realm = req.realm;
  const { id, ownerExpenseId } = req.params;
  validateObjectId(ownerExpenseId, 'ownerExpenseId');
  const paid = req.body?.paid === true;

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });
  _findBuilding(building, id);

  const entry = (building as any).ownerMonthlyExpenses.id(ownerExpenseId);
  if (!entry) {
    throw new ServiceError('Owner expense entry does not exist', 404);
  }
  entry.paid = paid;
  entry.paidDate = paid ? new Date() : null;
  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

  const result = await _toBuildingData(realm!._id, [building!.toObject()]);
  return res.json(result[0]);
}

// POST /buildings/:id/uncollected-payment  { term, amount, paidByType, payerId, date?, reference? }
// §5: record a VOLUNTARY contribution toward this building's Αχρέωτα (uncollected
// vacant-unit expense money). Αχρέωτα is NOT a liability — this is the ONLY place
// the euro is recorded (never as a settling payment on the payer's rent/owner
// ledger), so it can't double-count. SUBDOC-ONLY: it must NOT push to
// ownerMonthlyExpenses and must NOT trigger _recomputeTenantsForProperty (a
// recompute would regenerate source:'vacant' rows and re-bill the very amount
// just covered). Append-only.
export async function addUncollectedPayment(req: Req, res: Res) {
  const realm = req.realm;
  const { id } = req.params;
  // `term` from the client selects the YEAR; the server ALLOCATES the amount
  // across that year's outstanding terms oldest-first (below) so the payment
  // lands on the months that actually carry the gross — making the per-term
  // ΧΡΕΩΣΕΙΣ panel and the year tile reconcile. (A client-fixed current-month
  // term made them disagree — Step-7 §5 reconciliation finding.)
  const term = validateTerm(req.body?.term, 'term');
  const amount = validateFiniteNumber(req.body?.amount, 'amount', {
    min: 0,
    max: 10000000,
    required: true
  });
  // OPTIONAL attribution: a building-level voluntary coverage has no payer. Only
  // validate/persist paidByType + payerId when the caller actually supplies a
  // specific payer (a future attributed-contribution flow).
  if (req.body?.paidByType != null) {
    validateEnum(req.body.paidByType, ['renter', 'owner'], 'paidByType', {
      required: true
    });
  }
  const payerId = String(req.body?.payerId || '').trim();

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });
  _findBuilding(building, id);

  const _r = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
  const year = Math.floor(Number(term) / 1000000);
  (building as any).uncollectedPayments =
    (building as any).uncollectedPayments || [];

  // Per-term OUTSTANDING gross = gross − already-recorded coverage for that term.
  const grossByTerm = await _uncollectedGrossByTerm(
    realm!._id as string,
    building,
    year
  );
  const paidByTerm = new Map<number, number>();
  for (const p of (building as any).uncollectedPayments) {
    if (Math.floor(Number(p.term || 0) / 1000000) !== year) continue;
    paidByTerm.set(
      Number(p.term),
      _r((paidByTerm.get(Number(p.term)) || 0) + (Number(p.amount) || 0))
    );
  }
  const outstandingTerms = Array.from(grossByTerm.entries())
    .map(([tm, gross]) => [tm, _r(gross - (paidByTerm.get(tm) || 0))] as [
      number,
      number
    ])
    .filter(([, rem]) => rem > 0.005)
    .sort((a, b) => a[0] - b[0]); // oldest term first

  // M2: `new Date("20/06/2026")` returns Invalid Date (JS Date can't parse
  // DD/MM/YYYY). An Invalid Date pushed onto a Date-required schema field fails
  // the Mongoose cast as an opaque 500. Validate explicitly → 422, mirroring
  // ownermanager.pay()'s guard.
  let date = new Date();
  if (req.body?.date) {
    const m = moment.utc(
      req.body.date,
      ['DD/MM/YYYY', 'YYYY-MM-DD', moment.ISO_8601],
      true
    );
    if (!m.isValid()) {
      throw new ServiceError(
        `date is not a valid date: ${String(req.body.date)}`,
        422
      );
    }
    date = m.toDate();
  }
  const reference = String(req.body?.reference || '');
  // Optional attribution — only carried when a specific payer was supplied.
  const attribution: Record<string, any> = {};
  if (req.body?.paidByType != null) attribution.paidByType = req.body.paidByType;
  if (payerId) attribution.payerId = payerId;
  let remaining = _r(Number(amount));
  const pushed: any[] = [];
  for (const [tm, rem] of outstandingTerms) {
    if (remaining <= 0.005) break;
    const apply = Math.min(rem, remaining);
    pushed.push({ term: tm, amount: _r(apply), date, reference, ...attribution });
    remaining = _r(remaining - apply);
  }
  // Any surplus beyond the year's outstanding gross is recorded against the
  // requested term (so nothing is silently dropped); the tile clamps it ≥0.
  if (remaining > 0.005) {
    pushed.push({
      term: Number(term),
      amount: _r(remaining),
      date,
      reference,
      ...attribution
    });
  }
  for (const p of pushed) (building as any).uncollectedPayments.push(p);

  (building as any).updatedDate = new Date();
  await _saveBuildingWithVersionCheck(building!);

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
  validateFixedAllocations(
    req.body.customAllocations,
    req.body.allocationMethod
  );
  validateSingleUnitAllocations(
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
  await _recomputeVacantOwnerCharges(
    building,
    realm!._id as string,
    _currentTerm()
  );
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
  // NOTE: the method-specific allocation validators (percentage / ratio /
  // fixed) are NOT run here. They were previously gated on
  // `if (req.body.allocationMethod)`, which let a partial PATCH that sends
  // only customAllocations (without echoing allocationMethod) bypass the
  // fixed-zero guard entirely — re-opening the silent-€0 money bug on a
  // fixed expense (FIXED-ZERO-PATCH). They now run AFTER the persisted
  // expense is loaded, against the MERGED (effective) allocation method, so
  // a partial PATCH is validated against the rule that will actually apply.
  // See the validation block just after `expense` is resolved below.

  // Wave-18 B1: keep one-time updates aligned to YYYYMM0100 (mirror addExpense).
  if (req.body.isRecurring === false && req.body.startTerm) {
    const st = Number(req.body.startTerm);
    const normalized = Math.floor(st / 10000) * 10000 + 100;
    req.body.startTerm = normalized;
    if (req.body.endTerm) req.body.endTerm = normalized;
  }

  // Optimistic lock (mirrors H6 extend-lease pattern). When the client
  // echoes the building's __v in the request body, atomically "claim"
  // it via findOneAndUpdate before doing the read+write cycle. The
  // claim filter `{__v: requestedVersion}` ensures only ONE concurrent
  // request commits when two race; the loser gets a 409 here rather
  // than silently overwriting via Mongoose's save()-time check (which
  // empirically can be bypassed by network-interleaved findOne→save
  // patterns — spec 47.2 caught this race in the wild).
  //
  // __v is OPTIONAL — legacy UI clients that haven't been updated to
  // thread it through still work as before (no race protection, but
  // single-writer flows are unaffected). Two-tab landlords concurrently
  // editing the same expense: both must pass __v, and one will get a
  // clear 409 instead of silent data loss.
  const requestedVersion =
    req.body.__v !== undefined ? Number(req.body.__v) : NaN;
  if (Number.isFinite(requestedVersion)) {
    const claimed = await Collections.Building.findOneAndUpdate(
      { _id: id, realmId: realm!._id, __v: requestedVersion },
      { $inc: { __v: 1 } }
    );
    if (!claimed) {
      const stillExists = await Collections.Building.exists({
        _id: id,
        realmId: realm!._id
      });
      if (!stillExists) {
        throw new ServiceError('Building does not exist', 404);
      }
      throw new ServiceError(
        'Building was modified concurrently. Please retry.',
        409
      );
    }
  }
  // The findOneAndUpdate above already bumped __v atomically. The
  // subsequent findOne+save cycle reads the now-bumped doc; Mongoose's
  // save() will bump __v again. Net: two bumps per __v-passing request.
  // That's acceptable — the alternative (skipping save() when __v
  // claimed) would require duplicating subdoc validation + recompute
  // logic. Receipt-of-mutation matters; absolute __v counter doesn't.
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
  // The allocations that will be PERSISTED after this PATCH: the body's if it
  // supplied them, otherwise the already-stored ones.
  const effectiveCustomAllocations =
    req.body.customAllocations !== undefined
      ? req.body.customAllocations
      : (expense as any).customAllocations;
  // Validate the EFFECTIVE allocation rule UNCONDITIONALLY (merged method +
  // merged allocations), not only when the body carries customAllocations.
  // Bypasses this closes:
  //   (a) PATCH {customAllocations: []} (no allocationMethod) on a stored
  //       fixed expense — caught because effectiveMethod resolves to 'fixed'.
  //   (b) PATCH {allocationMethod: 'fixed'} with NO customAllocations key, on
  //       an expense whose stored customAllocations is empty — the method
  //       flips to fixed while allocations stay [], billing €0 every term.
  //   (c) single_unit / fixed / custom_* expense whose referenced propertyId
  //       was later removed (the unit deleted): a partial PATCH that omits
  //       customAllocations used to skip the propertyId check, leaving a
  //       well-formed expense that the pipeline matches to no unit → €0. Run
  //       _assertCustomAllocationPropertyIds against the EFFECTIVE (persisted)
  //       allocations so a stale target is caught even when the body doesn't
  //       resend them.
  // Each validator is a no-op unless the effective method matches its rule.
  _assertCustomAllocationPropertyIds(
    building,
    effectiveCustomAllocations,
    effectiveAllocationMethod
  );
  validatePercentageAllocations(
    effectiveCustomAllocations,
    effectiveAllocationMethod
  );
  validateRatioAllocations(effectiveCustomAllocations, effectiveAllocationMethod);
  validateFixedAllocations(effectiveCustomAllocations, effectiveAllocationMethod);
  validateSingleUnitAllocations(
    effectiveCustomAllocations,
    effectiveAllocationMethod
  );

  // Strip __v from the body before $set: never write client-provided
  // __v back. Mongoose's save() will manage it.
  const { __v: _ignored, ...patchBody } = req.body;
  void _ignored;
  // Reviving a soft-deleted expense: the client sends endTerm: null to
  // CLEAR the kill-date. Mongoose's .set(obj) only assigns present keys and
  // never unsets, so an explicit null/0 must be turned into a real unset —
  // otherwise the past endTerm sticks and the expense stays dead.
  if (patchBody.endTerm === null || patchBody.endTerm === 0) {
    expense.set({ endTerm: undefined });
    delete patchBody.endTerm;
  }
  expense.set(patchBody);
  (building as any).updatedDate = new Date();
  await _recomputeVacantOwnerCharges(
    building,
    realm!._id as string,
    _currentTerm()
  );
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
    // Remove orphaned owner monthly expenses — but NEVER drop a row that
    // carries recorded καταβολές: pulling it deletes the payments[] with it and
    // the owner's money vanishes with no trail. A row with payments is instead
    // preserved as a zero-amount CREDIT (owed=0, payments kept) so the owner
    // ledger shows the recorded money as an overpayment/credit. Zero-payment
    // rows are pulled as before.
    const ownerRows = ((building as any).ownerMonthlyExpenses || []).filter(
      (e: any) => String(e.expenseId) === expId
    );
    for (const e of ownerRows) {
      const hasPayments =
        Array.isArray(e.payments) &&
        e.payments.some((p: any) => Number(p && p.amount) > 0);
      if (hasPayments) {
        e.amount = 0;
        e.source = 'credit';
        e.paid = true;
        e.paidDate = e.paidDate || new Date();
      } else {
        (building as any).ownerMonthlyExpenses.pull(e._id);
      }
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

async function _removeRepairCharges(
  building: any,
  repair: any,
  // Optional set of propertyIds whose TENANT monthlyCharge for this repair must
  // be PRESERVED, not pulled (Step-7 r6 medium). Used by the zero-cost /
  // cleared-billing edit early-returns: a frozen+occupied unit's rent is cloned
  // verbatim by Contract.update (it keeps billing the repair on a closed month),
  // so pulling its persisted monthlyCharge would desync the breakdown panel
  // (€0) from the rent the tenant was actually billed. The cancel/delete callers
  // pass nothing → every charge is removed (the repair is genuinely gone).
  preserveTenantChargePropIds?: Set<string>
): Promise<void> {
  const repairIdStr = String(repair._id);
  for (const unit of building.units) {
    // A frozen+occupied unit's tenant charge is pinned by the rent freeze —
    // leave it so the panel keeps matching the (immutable) rent.
    if (
      preserveTenantChargePropIds &&
      unit.propertyId &&
      preserveTenantChargePropIds.has(String(unit.propertyId))
    ) {
      continue;
    }
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
  // Tier I-3.f: also strip any owner-side entries this repair created so a
  // status flip to cancelled / a percentage edit / a cost change doesn't
  // double-count on the owner ledger. Scope by expenseId === repair._id AND
  // a REPAIR source ('repair' = owner-borne portion, 'repair-vacant' = a
  // vacant unit's tenant-portion share routed to the owner) so we never touch
  // building-expense allocations. Without the 'repair-vacant' clause a
  // cancel/delete left that row a permanent orphan on the owner ledger.
  const ownerToRemove = ((building as any).ownerMonthlyExpenses || []).filter(
    (e: any) =>
      (e.source === 'repair' || e.source === 'repair-vacant') &&
      e.expenseId &&
      String(e.expenseId) === repairIdStr
  );
  for (const e of ownerToRemove) {
    // Same owner-payment-preservation invariant as removeExpense: never pull a
    // row carrying recorded καταβολές — keep it as a zero-amount credit so the
    // owner's money survives the repair delete/cancel as a credit. (NOTE: this
    // is the wholesale strip used on cancel/delete; the per-edit redistribution
    // path _distributeRepairCharge carries payments forward separately.)
    const hasPayments =
      Array.isArray(e.payments) &&
      e.payments.some((p: any) => Number(p && p.amount) > 0);
    if (hasPayments) {
      e.amount = 0;
      e.source = 'credit';
      e.paid = true;
      e.paidDate = e.paidDate || new Date();
    } else {
      (building as any).ownerMonthlyExpenses.pull(e._id);
    }
  }
}

// Locale-neutral "today" for a synthetic repair-payment provenance date when
// no prior payment template exists (DD/MM/YYYY, the persisted date format).
function todayDDMMYYYYForRepair(): string {
  return moment.utc().format('DD/MM/YYYY');
}

// Distribute the single recorded-payment pool for a repair across its freshly-
// rebuilt owner rows (source 'repair' owner-portion + per-vacant-unit
// 'repair-vacant'), capped at each row's amount so paid never exceeds amount
// (owed===paid per row — no negative outstanding on the ledger/statement, no
// silent truncation on the eksoda dashboard). Any pool euro the live liability
// rows cannot absorb (the repair is now mostly the tenant's) becomes ONE
// standalone settled-remnant 'repair' row whose amount === that remainder
// (owed===paid). This is the SINGLE place repair payments are re-attached, so
// the result is identical no matter how many reclassify / occupancy / term
// transitions preceded it (round-1 C2 + Step-7 r1/r2/r3 hardening).
function _applyRepairPaymentPool(
  building: any,
  repairIdStr: string,
  term: number,
  paidByProp: Map<string, number>,
  flagByProp: Map<string, { amount: number; date: any }>,
  mkPoolPayment: (amount: number) => any,
  // Per-bucket DROPPABLE € budget: the portion of each bucket's unabsorbable
  // leftover that is a GENUINE overpay — owner cash whose repair share this run
  // was re-billed to an OCCUPIED tenant's rent. We DROP min(leftover, droppable)
  // and PRESERVE the rest as a source:'credit' row. Preserving a droppable euro
  // would double-count it (owner credit + tenant rent); dropping a
  // non-droppable euro (share went to flag-off Αχρέωτα / owner-portion shrank /
  // cancel credit) would silently destroy recorded owner money. Per-AMOUNT (not
  // a per-bucket flag) so a credit and a genuine overpay sharing one property
  // bucket are split correctly (Step-7 re-review: a flag rescued/dropped the
  // whole contaminated bucket).
  droppableByProp: Map<string, number> = new Map(),
  // When true, a leftover that would be DROPPED as a presumed overpay is instead
  // PRESERVED as a source:'credit' remnant (the owner's recorded money survives
  // as a refundable credit). Set only by the tenancy-triggered re-distribution —
  // see _distributeRepairCharge's preserveOverpayAsCredit doc. Default false
  // keeps the deliberate-edit drop behaviour exactly as prior rounds settled it.
  preserveOverpayAsCredit = false
): void {
  const _round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
  const OWNER_KEY = '__owner__';
  const omeArr = (building as any).ownerMonthlyExpenses;
  const liveRows = omeArr.filter(
    (e: any) =>
      (e.source === 'repair' || e.source === 'repair-vacant') &&
      String(e.expenseId) === repairIdStr
  );
  const keyOf = (row: any) =>
    row.propertyId ? String(row.propertyId) : OWNER_KEY;

  // Re-apply recorded καταβολές PER PROPERTY: each rebuilt row draws from its
  // OWN unit's captured pool first (exact owner attribution — a flat pool
  // attributed one owner's payment to another's row in a multi-vacant building,
  // Step-7-r7). Cap each row's fill at its amount. A bare manual paid flag
  // (setOwnerExpensePaid: paid:true, empty payments) for that same property is
  // applied to ONE matching unpaid row when no cash covers it.
  const remainingByProp = new Map<string, number>();
  for (const [k, v] of paidByProp) remainingByProp.set(k, _round(v));

  // Pass 1: fill each row from its OWN property bucket, capped at amount.
  for (const row of liveRows) {
    const k = keyOf(row);
    const rem = remainingByProp.get(k) || 0;
    if (rem <= 0.005) continue;
    const rowAmount = Number(row.amount) || 0;
    if (rowAmount <= 0.005) continue;
    const apply = Math.min(rowAmount, rem);
    row.payments = [
      ...(Array.isArray(row.payments) ? row.payments : []),
      mkPoolPayment(apply)
    ];
    recomputeOwnerExpensePaid(row);
    remainingByProp.set(k, _round(rem - apply));
  }

  // Pass 2: cross-source migration, gated by the SAME owner-identity the READ
  // SIDE uses, so a migrated payment is never attributed to an owner who did not
  // pay it. The realistic carry this preserves: an owner-portion 'repair' row
  // [key '__owner__'] collapses to a per-unit 'repair-vacant' row on a
  // reclassify (single-unit owners→tenants — the C2-a case), or vice-versa.
  //
  // The read side (ownermanager._aggregateOwners, ownerstatement) attributes:
  //   - a per-unit (propertyId) row → that unit's owner(s);
  //   - a building-wide '__owner__' row → the LEX-FIRST canonical owner of the
  //     building's distinct owners (ownermanager.ts canonicalKey).
  // So migration is money-correct only between rows that resolve to the SAME
  // attributed owner. r12 broke because '__owner__' was allowed to reach ANY
  // unit unconditionally; in a mixed building that credited a different owner.
  //
  // Owner identity is reconciled drift-tolerantly (sameOwner): same human across
  // memberId-vs-name and taxId-present-vs-absent key drift (r10), without merging
  // two different same-surname owners who carry conflicting taxIds (r11 B3).
  const sameOwner = (a: any, b: any) => {
    if (!a || !b) return false;
    if (a.memberId && b.memberId)
      return String(a.memberId) === String(b.memberId);
    const an = String(a.name || '').trim().toLowerCase();
    const bn = String(b.name || '').trim().toLowerCase();
    if (!an || !bn || an !== bn) return false; // names must match
    const at = String(a.taxId || '').trim();
    const bt = String(b.taxId || '').trim();
    if (at && bt) return at === bt; // both present → must be equal
    return true; // same name + non-conflicting (≥1 absent) taxId → same human
  };
  const dedupOwners = (owners: any[]): any[] => {
    const out: any[] = [];
    for (const o of owners) if (!out.some((x) => sameOwner(x, o))) out.push(o);
    return out;
  };
  const buildingOwners = dedupOwners(
    (building.units || []).flatMap((u: any) => (u.owners || []) as any[])
  );
  // canonical owner the read side credits a building-wide '__owner__' row to:
  // lex-first by ownerKeyOf (matches ownermanager.canonicalKey).
  const canonicalBuildingOwner =
    buildingOwners.length > 0
      ? [...buildingOwners].sort((x: any, y: any) =>
          ownerKeyOf(x) < ownerKeyOf(y) ? -1 : 1
        )[0]
      : null;
  const ownersOf = (k: string): any[] => {
    if (k === OWNER_KEY)
      return canonicalBuildingOwner ? [canonicalBuildingOwner] : [];
    const unit = (building.units || []).find(
      (u: any) => String(u.propertyId) === String(k)
    );
    return dedupOwners(((unit && unit.owners) || []) as any[]);
  };
  const rowOwners = (row: any): any[] =>
    row.propertyId
      ? ownersOf(String(row.propertyId))
      : canonicalBuildingOwner
        ? [canonicalBuildingOwner]
        : [];
  // Same attributed owner-set (drift-tolerant, order-independent). An empty
  // destination (unowned legacy unit) is reachable from anyone; an empty source
  // reaches only empty destinations.
  const sameAttributedOwner = (src: any[], dst: any[]) => {
    if (dst.length === 0) return true;
    if (src.length !== dst.length) return false;
    const used = new Array(src.length).fill(false);
    for (const d of dst) {
      const i = src.findIndex((s, idx) => !used[idx] && sameOwner(s, d));
      if (i < 0) return false;
      used[i] = true;
    }
    return true;
  };

  // Track each property bucket's UNPLACED remainder after migration, so we can
  // distinguish a genuine overpayment (drop) from a payment whose liability row
  // simply moved to a now-occupied term (re-materialise at the original term).
  const leftoverByProp = new Map<string, number>();
  for (const [k, rem] of remainingByProp) {
    if (rem <= 0.005) continue;
    const srcOwners = ownersOf(k);
    let left = _round(rem);
    for (const row of liveRows) {
      if (left <= 0.005) break;
      if (!sameAttributedOwner(srcOwners, rowOwners(row))) continue;
      const rowAmount = Number(row.amount) || 0;
      const already = (
        Array.isArray(row.payments) ? row.payments : []
      ).reduce((s: number, p: any) => s + (Number(p && p.amount) || 0), 0);
      const room = _round(rowAmount - already);
      if (room <= 0.005) continue;
      const apply = Math.min(room, left);
      row.payments = [
        ...(Array.isArray(row.payments) ? row.payments : []),
        mkPoolPayment(apply)
      ];
      recomputeOwnerExpensePaid(row);
      left = _round(left - apply);
    }
    if (left > 0.005) leftoverByProp.set(k, _round(left));
  }

  // Bare manual paid flags: per property, consume onto ONE matching unpaid row.
  for (const [k, flag] of flagByProp) {
    if (!flag || flag.amount <= 0.005) continue;
    for (const row of liveRows) {
      if (keyOf(row) !== k) continue;
      const hasCash =
        Array.isArray(row.payments) &&
        row.payments.some((p: any) => Number(p && p.amount) > 0);
      if (hasCash) continue;
      if (Math.abs((Number(row.amount) || 0) - flag.amount) <= 0.005) {
        row.paid = true;
        row.paidDate = flag.date || new Date();
        break; // one flag → one row
      }
    }
  }

  // Each property bucket's UNPLACED remainder is resolved one of two ways:
  //
  //  A) PRESERVE up to the bucket's PRESERVABLE budget — money the owner ALREADY
  //     paid that this run stranded into Αχρέωτα/credit (not a tenant re-bill):
  //     a cancel-time 'credit' re-absorbed on un-cancel whose owner-portion
  //     shrank, a 'repair-vacant' row whose flag flipped OFF, or an owner-portion
  //     share that now lands on a flag-off vacant unit. Mirroring
  //     _removeRepairCharges / removeExpense, we keep it as ONE zero-amount
  //     source:'credit' row (payments preserved) so the owner's recorded money
  //     survives on EVERY surface (ledger/statement/dashboard all count a
  //     credit's payments). amount=0 makes it leak-free: it adds PAID, never
  //     owed, and the read-side credit branch is never stale-dropped.
  //
  //  B) DROP + log the REST — a genuine post-transition OVERPAY: the leftover
  //     beyond the preservable budget is a euro whose unit became OCCUPIED (share
  //     re-billed to the tenant's rent) or the charge relocated months.
  //     Preserving it would DOUBLE-COUNT against the tenant rent (Step-7
  //     re-review). MRE has NO owner carry-forward ledger; payOwner auto-mode
  //     drops owner surplus the same way. We tried re-materialising a synthetic
  //     row (r13) but it resurrected as phantom owed/over-paid on adjacent edits
  //     (r14) — dropping a TRUE overpay is the only leak-free rule.
  //
  // min(leftover, budget) splits a bucket that holds BOTH a credit remnant AND a
  // genuine occupied-overpay: only the credit-origin € is preserved, the overpay
  // € drops. Without the per-amount cap a single credit rescued the whole
  // contaminated bucket → the occupied-overpay euro showed on owner credit AND
  // tenant rent.
  let dropped = 0;
  let preserved = 0;
  for (const [k, left] of leftoverByProp) {
    if (left <= 0.005) continue;
    // preserveOverpayAsCredit (tenancy-triggered re-distribution): the
    // "droppable overpay" classification assumes the re-billed tenant share is
    // already covered by the owner's cash, so dropping avoids a double-count.
    // On an AUTOMATIC tenancy flip that assumption is unsafe — the new tenant
    // charge is UNPAID, so the owner's recorded payment is genuine surplus that
    // must survive as a refundable credit, not vanish. Force the whole leftover
    // into the preserve branch (dropBudget 0) in that mode.
    const dropBudget = preserveOverpayAsCredit
      ? 0
      : droppableByProp.get(k) || 0;
    const toDrop = Math.min(_round(left), _round(dropBudget));
    const toPreserve = _round(left - toDrop);
    if (toPreserve > 0.005) {
      omeArr.push({
        expenseId: repairIdStr,
        term,
        amount: 0,
        propertyId: k === OWNER_KEY ? null : k,
        source: 'credit',
        description:
          'Repair credit (κατάλοιπο καταβολής): ' + repairIdStr,
        payments: [mkPoolPayment(toPreserve)],
        paid: true,
        paidDate: new Date()
      });
      preserved = _round(preserved + toPreserve);
    }
    if (toDrop > 0.005) dropped = _round(dropped + toDrop);
  }
  if (preserved > 0.005) {
    logger.info(
      `repair ${repairIdStr} term ${term}: preserved ${preserved} of recorded owner καταβολή as a source:'credit' remnant (liability removed/shrunk by un-cancel or chargeOwnerWhenVacant flip — recorded money must survive).`
    );
  }
  if (dropped > 0.005) {
    logger.warn(
      `repair ${repairIdStr} term ${term}: owner overpayment of ${dropped} exceeds the current owner liability after a charge transition; surplus dropped (no owner carry-forward ledger — matches payOwner auto-mode surplus handling).`
    );
  }
}

// Exported (underscore prefix = internal, exposed for unit tests like
// _recomputeVacantOwnerCharges) so the owner-side repair money carry can be
// asserted directly. See repairCharges.test.js "C2-*".
export async function _distributeRepairCharge(
  building: any,
  repair: any,
  realmId: string,
  // PRESERVE-OVERPAY mode (Step-7 round-2 high). Normally, when an occupied
  // unit's repair share is re-billed to the tenant, a recorded owner καταβολή
  // on the old repair-vacant row is DROPPED as a presumed overpay (avoids the
  // owner-credit + tenant-rent double-count when the landlord DELIBERATELY edits
  // the repair). But when this writer is re-fired AUTOMATICALLY by a tenancy
  // change (redistributeRepairsForProperties), silently destroying the owner's
  // recorded money is wrong — the expense path (reattachPaidOrphans) preserves
  // the identical case as a settled credit remnant. With this flag set, the
  // leftover owner payment is PRESERVED as a source:'credit' row instead of
  // dropped, so the owner's recorded cash survives on every surface as a
  // refundable credit. Default false → the edit path keeps its existing,
  // multi-round-stabilised drop behaviour untouched.
  preserveOverpayAsCredit = false
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

  // Tier I-3.f: owners-only repairs used to short-circuit here, leaving the
  // owner ledger empty. We now keep going so an entry lands in
  // ownerMonthlyExpenses[]. The chargeTerm guard still applies — without a
  // term we don't know which month the entry belongs to.
  // A repair without billing info (no chargeableTo, no chargeTerm, or zero
  // cost) is a draft — no NEW distribution, but a PRIOR distribution (the repair
  // was billable before this edit zeroed its cost / cleared its billing) must be
  // STRIPPED + recomputed, exactly like the cancel path. Without this, editing a
  // billable repair down to €0 (or clearing chargeableTo/chargeTerm) left the
  // old tenant monthlyCharge stranded — the rent engine kept billing it verbatim
  // (it reads unit.monthlyCharges, never the repair's current cost), permanently
  // over-billing the tenant for a now-free repair (Step-7 r3 high). The building
  // is still SAVED so the repair subdoc persists (Step-7 WRITE-PATH finding).
  // Preserve a frozen+occupied unit's pinned tenant charge across the strip
  // (Step-7 r6 medium): Contract.update clones a frozen rent verbatim, so the
  // tenant keeps being billed the repair on a closed month — pulling the
  // persisted charge would desync the breakdown panel from that rent. Compute
  // the frozen∩occupied set for the repair's chargeTerm (when it has one) and
  // hand it to _removeRepairCharges so those tenant charges survive.
  const _frozenOccupiedForStrip = async (): Promise<Set<string>> => {
    if (!repair.chargeTerm) return new Set();
    const t = Number(repair.chargeTerm);
    const propIds = building.units
      .filter((u: any) => u.propertyId)
      .map((u: any) => String(u.propertyId));
    const [frozen, occupied] = await Promise.all([
      _frozenPropertyIdsForTerm(realmId, propIds, t),
      _occupiedPropertyIdsForTerm(building, realmId, t)
    ]);
    return new Set(
      propIds.filter((p: string) => frozen.has(p) && occupied.has(p))
    );
  };
  if (!repair.chargeableTo || !repair.chargeTerm) {
    await _removeRepairCharges(building, repair, await _frozenOccupiedForStrip());
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
  const cost = repair.actualCost || repair.estimatedCost || 0;
  if (cost <= 0) {
    await _removeRepairCharges(building, repair, await _frozenOccupiedForStrip());
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

  // Respect explicit tenantSharePercentage when provided. Default depends on
  // chargeableTo: 'tenants' implies 100% to tenants, 'split' implies 0%
  // unless a percentage was set explicitly. Shared helper (the SINGLE source the
  // eksoda reader + breakdown Αχρέωτα emission also use) so the three can't drift.
  const sharePercentage = repairTenantSharePercentage(repair);

  // Owner share is the inverse of the tenant share. 'owners' = 100% owner;
  // 'split' with 60% tenant = 40% owner; 'tenants' = 0% owner.
  const ownerPortion =
    repair.chargeableTo === 'owners'
      ? cost
      : cost * (1 - sharePercentage / 100);

  const term = Number(repair.chargeTerm);
  const repairIdStr = String(repair._id);

  // EQUAL-ALLOCATION FROZEN BAIL (Step-7 r5/r6). For 'equal' the per-unit share
  // = pool ÷ party-count and the count shifts with occupancy, so there is NO
  // internally-consistent PARTIAL re-division (re-divide thawed units at the NEW
  // count while a frozen sibling stays pinned at the OLD count → Σ(shares) ≠
  // cost). If ANY unit is frozen for this term, leave the ENTIRE prior
  // distribution exactly as it stands (it already sums to cost) and bail NOW —
  // BEFORE the owner-payment pool capture + strip below. Bailing later (after
  // the unconditional strip+rebuild) would discard the captured pool and DESTROY
  // recorded owner καταβολές (Step-7 r6 critical). This must run before any
  // mutation. The building is still saved so a repair-subdoc field edit
  // (title/notes/contractor) persists. The tenancy-triggered redistribute guard
  // already screens equal repairs out building-wide; this covers the direct
  // edit path (updateRepair), which has no such guard.
  const isEqualAlloc =
    (repair.allocationMethod || 'general_thousandths') === 'equal';
  if (isEqualAlloc) {
    const allUnitPropIdsEq = (building.units || [])
      .filter((u: any) => u.propertyId)
      .map((u: any) => String(u.propertyId));
    const frozenEq = await _frozenPropertyIdsForTerm(
      realmId,
      allUnitPropIdsEq,
      term
    );
    if (frozenEq.size > 0) {
      building.updatedDate = new Date();
      await _saveBuildingWithVersionCheck(building);
      return;
    }
  }

  // ── UNIFIED OWNER-SIDE PAYMENT POOL (round-1 C2; hardened across 3 Step-7
  //    rounds) ────────────────────────────────────────────────────────────
  // A repair's owner-borne cost can be carried by TWO sources — 'repair' (the
  // owner-portion of a split/owners repair) and 'repair-vacant' (a tenant share
  // that fell to the owner because the unit was vacant). A recorded owner
  // καταβολή can sit on EITHER, and reclassify/occupancy/term edits migrate the
  // liability between them. Snapshotting/reattaching per-source-per-transition
  // double-counted or dropped money on every multi-step round-trip (Step-7 r1
  // double-count, r2 overpay, r3 owners→tenants→owners). The robust model:
  //   1. POOL = the single total of all recorded payments for this repair
  //      across BOTH sources (the owner has paid €X toward this repair, full
  //      stop), captured BEFORE any strip, with one payment template for
  //      date/type/reference provenance.
  //   2. STRIP every owner-side row (both sources, all terms) up front.
  //   3. REBUILD the fresh liability rows with ZERO payments.
  //   4. APPLY the pool across the rebuilt rows capped per-row (paid never
  //      exceeds amount → owed===paid per row, no negative outstanding, no
  //      vanish); any remainder → ONE settled-remnant 'repair' row (amount ===
  //      remainder). Invariant to the number of transitions.
  let paymentTemplate: any = null;
  // A bare manual paid flag (set via setOwnerExpensePaid: paid:true with EMPTY
  // payments[]) is ALSO recorded settlement state that must survive a rebuild —
  // every other owner-side source preserves it via applyCarriedSettlement, so
  // the repair path must too (Step-7-r4 B1/B2: a manually-checked-paid repair
  // row reverted to outstanding on any innocuous repair edit). Capture the
  // flagged amount + paidDate so a rebuilt row of the SAME amount re-derives
  // paid. (If real payments exist we use those; the flag is the no-payment case.)
  // PER-PROPERTY pools (NOT a flat sum) so a recorded καταβολή is re-applied to
  // the SAME unit's rebuilt row — a flat pool filled rows in array order and, in
  // a multi-vacant building where different units have different owners,
  // attributed one owner's payment to another owner's row (Step-7-r7). Key by
  // propertyId; the building-wide owner-portion ('repair', propertyId null) uses
  // the sentinel '__owner__'. Bare paid flags are tracked the same way.
  const _round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
  const OWNER_KEY = '__owner__';
  const propKeyOf = (e: any) =>
    e.propertyId ? String(e.propertyId) : OWNER_KEY;
  const paidByProp = new Map<string, number>();
  const flagByProp = new Map<string, { amount: number; date: any }>();
  // Per-bucket DROPPABLE €: the part of a bucket's unabsorbable leftover that is
  // a GENUINE overpay — owner cash whose repair share this run was re-billed to
  // an OCCUPIED tenant's rent. Preserving it would DOUBLE-COUNT the same euro on
  // owner credit AND tenant rent (Step-7 re-review confirmed via the real
  // writer), so it is dropped. Everything ELSE in a leftover (share went to
  // flag-off-vacant Αχρέωτα → billed to nobody, or the owner-portion simply
  // shrank / a cancel-time credit) is recorded owner money with no tenant twin →
  // PRESERVED as a source:'credit' row. So: preserve = leftover − min(leftover,
  // droppable). Populated in the unit loop (each occupied unit's re-billed share
  // is attributed to the bucket that actually holds that owner's cash — its own
  // property bucket if it has captured cash, else the building-wide owner-portion
  // bucket — so one rebill is never charged to two buckets, and no cross-owner
  // bucket is touched). The owner-only early-return path bills no tenant, so it
  // passes an EMPTY map (nothing droppable → owner-portion shrink fully
  // preserved). This is the inverse of, and supersedes, the earlier origin-based
  // preserve flag: keying on the transition DESTINATION (occupied-tenant vs
  // Αχρέωτα) is what distinguishes a double-count overpay from preserved money,
  // and it also covers the owners→split-on-vacant-flag-off case (Step-7 finding
  // 4) that an origin flag missed.
  const droppableByProp = new Map<string, number>();
  // 'credit' rows are SACRED and INERT: a credit (created by _removeRepairCharges
  // on cancel, removeExpense on delete, or this function's own leftover-preserve
  // stage) carries recorded owner money that has NO live liability. It is
  // deliberately EXCLUDED here so it is never captured into the payment pool nor
  // stripped — it simply survives, read by every surface (owed 0, paid verbatim).
  //
  // We tried re-absorbing credits into the pool on un-cancel (to merge the
  // floating credit back onto the re-opened liability — purely cosmetic, one row
  // vs two). It created a whole class of money bugs: a credit's cash merged into
  // a liability row (Pass 1) lost its "surplus, no-tenant-twin" provenance, so a
  // later occupy→vacate→occupy oscillation re-classified it as a tenant-rebilled
  // overpay and DROPPED it (Step-7 round-3 money loss), and a credit co-located
  // with a genuine occupied-overpay contaminated the per-bucket drop/preserve
  // split (round-2 double-count). Keeping credits OUT of the pool is the only
  // leak-free rule: the term-level dashboard union-walk already reconciles a
  // floating credit against a re-opened liability (owed===paid → settled), so the
  // money is correct without re-absorption — it just shows as two rows. An
  // expense-derived credit also has a different expenseId, doubly out of scope.
  const isRepairOwnerRow = (e: any) =>
    (e.source === 'repair' || e.source === 'repair-vacant') &&
    e.expenseId &&
    String(e.expenseId) === repairIdStr;
  for (const e of ((building as any).ownerMonthlyExpenses || []) as any[]) {
    if (isRepairOwnerRow(e)) {
      const k = propKeyOf(e);
      let rowPaidSum = 0;
      for (const p of Array.isArray(e.payments) ? e.payments : []) {
        const amt = Number(p && p.amount) || 0;
        if (amt > 0) {
          rowPaidSum += amt;
          paidByProp.set(k, _round((paidByProp.get(k) || 0) + amt));
          if (!paymentTemplate) paymentTemplate = p;
        }
      }
      // (droppableByProp — the genuine-overpay portion of each bucket's leftover
      // — is computed in the unit loop below from the transition DESTINATION, not
      // here from the row's origin: a leftover euro is a double-count overpay only
      // if its share was re-billed to an OCCUPIED tenant this run. That is the
      // exact discriminator; an origin flag could not distinguish a flag-off
      // Αχρέωτα drop, billed to nobody, which must be PRESERVED.)
      if (rowPaidSum <= 0.005 && e.paid === true) {
        const prev = flagByProp.get(k);
        flagByProp.set(k, {
          amount: _round((prev?.amount || 0) + (Number(e.amount) || 0)),
          date: prev?.date || e.paidDate || null
        });
      }
    }
  }
  const mkPoolPayment = (amount: number) => ({
    date: paymentTemplate?.date || todayDDMMYYYYForRepair(),
    amount: Math.round(amount * 100) / 100,
    type: paymentTemplate?.type || 'transfer',
    reference: paymentTemplate?.reference || '',
    description: paymentTemplate?.description || ''
  });

  // Strip ALL prior owner-side rows for this repair (all sources incl. a
  // cancel-time 'credit' remnant, all terms) up front. Payments are preserved
  // in paidByProp/flagByProp above and re-applied after rebuild — so an
  // un-cancel re-absorbs the credit's καταβολές instead of orphaning them.
  const ownerToRemove = ((building as any).ownerMonthlyExpenses || []).filter(
    (e: any) => isRepairOwnerRow(e)
  );
  for (const e of ownerToRemove) {
    (building as any).ownerMonthlyExpenses.pull(e._id);
  }

  // Rebuild the owner-portion liability row (zero payments; pool applied below).
  if (ownerPortion > 0) {
    const arr = (building as any).ownerMonthlyExpenses;
    arr.push({
      expenseId: repairIdStr,
      term,
      amount: Math.round(ownerPortion * 100) / 100,
      source: 'repair',
      description:
        'Repair: ' + (repair.title || repair.description || 'untitled'),
      payments: []
    });
  }

  // If 100% owner-funded, there is no tenant-side / vacant distribution; apply
  // the pool to the owner-portion row (capped) + remnant, then return.
  // Strip any stale tenant monthlyCharges (from a prior 'tenants'/'split'
  // distribution) so a reclassify to 'owners' doesn't leave charges on both
  // sides (E2E S14). Only runs on this early-return path where no unit-loop
  // will re-create them.
  if (sharePercentage <= 0) {
    for (const unit of building.units) {
      const stale = (unit.monthlyCharges || []).filter(
        (c: any) =>
          (c.repairId && String(c.repairId) === repairIdStr) ||
          (!c.repairId && c.description === `Repair: ${repair.title}`)
      );
      for (const charge of stale) {
        unit.monthlyCharges.pull(charge._id);
      }
    }
    _applyRepairPaymentPool(
      building,
      repairIdStr,
      term,
      paidByProp,
      flagByProp,
      mkPoolPayment,
      droppableByProp,
      preserveOverpayAsCredit
    );
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

  const effectiveAmount = cost * (sharePercentage / 100);
  const allocationMethod = repair.allocationMethod || 'general_thousandths';

  // F5 (mirrors saveMonthlyStatement / B2 fix at line 1604): the plain-
  // object snapshot must carry _tenantGroups so equal-allocation groups
  // by unique tenant rather than by managed unit. Without this attach,
  // a tenant occupying multiple units on the same building gets billed
  // a per-unit share for repairs (double-charged for "equal").
  const buildingObj = building.toObject ? building.toObject() : building;
  await _attachTenantGroupsToBuildings(realmId, [buildingObj]);

  // Which units are occupied for the charge term. A repair share for a
  // VACANT unit must NOT be written as a tenant monthlyCharge — that gets
  // stranded (no rent term exists for a unit with no tenant that month, so
  // it bills nobody and silently vanishes). Instead it goes to the owner
  // ledger, like the vacant-owner-expense path. This is the fix for the
  // "repair charged to a tenant who left before the charge term vanishes".
  const occupiedForRepair = await _occupiedPropertyIdsForTerm(
    building,
    realmId,
    term
  );
  // OWNER-OCCUPIED units have no tenant, so they are NOT in occupiedForRepair
  // (that set is built from tenant records only). But an owner LIVES there — the
  // repair's tenant-share is the resident owner's own cost, NOT vacant/
  // uncollected money. Without this the tenant-share of a repair on an
  // owner-occupied unit EVAPORATED (flag off) or was mislabelled 'repair-vacant'
  // (flag on). Route it to the owner ledger as source:'owner-resident',
  // FLAG-INDEPENDENT, mirroring the building-expense path (1_base.ts:196/265 and
  // the expense materialiser's isResident branch).
  const ownerOccupiedForRepair = _ownerOccupiedPropertyIds(building);
  // (Owner-side rows for this repair — both 'repair' and 'repair-vacant' — were
  // already stripped up front; their payments live in paidPool and are
  // re-applied after the rebuild. The unit loop below pushes ZERO-payment
  // repair-vacant rows; the pool reconciliation at the end distributes paidPool.)

  // FROZEN-UNIT handling for NON-equal methods (Step-7 r4). A unit whose
  // covering tenant's rent is frozen for the term (past, or current-fully-paid)
  // must not have its persisted repair charge re-priced — Contract.update clones
  // the frozen rent verbatim and ignores a re-divided monthlyCharge, so
  // overwriting it desyncs the breakdown panel from the rent the tenant was
  // actually billed. The per-unit skip below leaves a frozen+occupied unit's
  // charge pinned. (EQUAL allocation already bailed wholesale far above when any
  // unit was frozen — its divisor couples all units, so a partial skip would
  // break Σ(shares)=cost; here every non-equal share is computed from a FIXED
  // unit attribute occupancy never changes, so pinning one unit is consistent.)
  const frozenPropIds = await _frozenPropertyIdsForTerm(
    realmId,
    (building.units || [])
      .filter((u: any) => u.propertyId)
      .map((u: any) => String(u.propertyId)),
    term
  );

  // Tier I-3.c: when affectedUnitIds is set, restrict the distribution to
  // only those unit ids. Otherwise spread across all units (legacy).
  // affectedUnitIds is a list of unit subdoc _ids — match against
  // String(unit._id), NOT propertyId.
  const restrictUnits =
    Array.isArray(repair.affectedUnitIds) && repair.affectedUnitIds.length > 0
      ? new Set(repair.affectedUnitIds.map((u: any) => String(u)))
      : null;

  for (const unit of building.units) {
    if (!unit.propertyId) continue;
    // Frozen + OCCUPIED unit → its prior TENANT repair charge is pinned by the
    // rent freeze (Contract.update clones the frozen rent verbatim and ignores a
    // re-divided monthlyCharge). Do NOT strip/rebuild it — leave it EXACTLY as
    // the freeze pinned it, so the breakdown panel keeps matching the rent the
    // tenant was actually billed (Step-7 r4). For EQUAL allocation we already
    // bailed wholesale above when any unit was frozen (a partial re-division
    // would break Σ(shares)=cost — Step-7 r5), so reaching here for a frozen
    // unit means a NON-equal method, whose per-unit denominator is a FIXED unit
    // attribute (thousandths/surface/fixed/single/custom) that occupancy never
    // changes — so pinning this one unit while re-pricing thawed siblings stays
    // internally consistent (every share is computed independently of the others).
    // Gate on OCCUPIED: a VACANT unit routes to an OWNER repair-vacant row, which
    // is NOT subject to the tenant-rent freeze, so a vacant unit (incl. a vacant
    // PAST term) must still be processed normally — otherwise a legitimate
    // backdated owner repair-vacant row would never be created.
    if (
      frozenPropIds.has(String(unit.propertyId)) &&
      occupiedForRepair.has(String(unit.propertyId))
    ) {
      continue;
    }
    if (restrictUnits && !restrictUnits.has(String(unit._id))) {
      // Unit was excluded — make sure we strip any prior charge in case it
      // was previously included. Same scoping as the create path below.
      const legacyDescription = `Repair: ${repair.title}`;
      const stale = unit.monthlyCharges.filter(
        (c: any) =>
          (c.repairId && String(c.repairId) === repairIdStr) ||
          (!c.repairId &&
            c.term === term &&
            c.description === legacyDescription)
      );
      for (const charge of stale) {
        unit.monthlyCharges.pull(charge._id);
      }
      continue;
    }

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
      if (occupiedForRepair.has(String(unit.propertyId))) {
        // Occupied this term → bill the tenant via a monthlyCharge.
        unit.monthlyCharges.push({
          term,
          amount: Math.round(share * 100) / 100,
          description: `Repair: ${repair.title}`,
          repairId: repairIdStr
        });
        // This unit's share is now the TENANT's (rent monthlyCharge). Any owner
        // καταβολή captured for it is a genuine overpay → its leftover must DROP,
        // not preserve (else the same euro lands on owner credit AND tenant rent
        // — Step-7 re-review double-count). Attribute the re-billed € to the
        // bucket that holds that owner's cash: the unit's OWN bucket if it had a
        // captured repair-vacant payment, else the building-wide owner-portion
        // bucket (__owner__) which a reclassified owners→tenants repair paid into.
        const dk = paidByProp.has(String(unit.propertyId))
          ? String(unit.propertyId)
          : OWNER_KEY;
        droppableByProp.set(
          dk,
          _round((droppableByProp.get(dk) || 0) + share)
        );
      } else if (
        ownerOccupiedForRepair.has(String(unit.propertyId)) ||
        repair.chargeOwnerWhenVacant
      ) {
        // Two owner-billed cases share ONE well-tested path (source
        // 'repair-vacant'): (a) OWNER LIVES HERE (owner_occupied) — the repair
        // tenant-share is the resident owner's own cost, billed FLAG-
        // INDEPENDENTLY (chargeOwnerWhenVacant governs only truly-EMPTY units);
        // (b) VACANT unit AND the repair opts vacant units into owner-billing.
        // Before this fix an owner-occupied unit (never in occupiedForRepair,
        // which is tenant-only) with the flag OFF fell through to the else
        // below and its tenant-share EVAPORATED (HIGH bug). Reusing
        // 'repair-vacant' means every reader (ledger, statement PDF, xlsx,
        // dashboard, property card) already bills it to the owner and per-owner-
        // slices it, and it survives the expense recompute (that recompute
        // strips vacant/owner-fixed/owner-resident from building.expenses only,
        // never a repair source). The display label is corrected to read
        // 'owner-resident' for an owner-occupied unit at render time (a
        // repair-vacant row on an owner_occupied unit is the resident's cost,
        // not a vacant unit) — see the breakdown/ledger readers.
        const rvArr = (building as any).ownerMonthlyExpenses;
        rvArr.push({
          expenseId: repairIdStr,
          term,
          amount: Math.round(share * 100) / 100,
          propertyId: String(unit.propertyId),
          source: 'repair-vacant',
          description: 'Repair: ' + (repair.title || repair.description || 'untitled'),
          payments: []
        });
      }
      // else: VACANT unit (not owner-occupied) AND chargeOwnerWhenVacant OFF →
      // the share is NOT billed to the owner; it becomes Αχρέωτα (uncollected),
      // surfaced live by the breakdown panel (computed, not persisted) — same as
      // a vacant building expense with the flag off. No owner row created.
    }
  }

  // Apply the single recorded-payment pool across ALL freshly-rebuilt owner
  // rows for this repair (owner-portion + per-vacant-unit), capped per row,
  // remainder → one settled remnant. One pool, one distribution — invariant to
  // however many reclassify/occupancy/term transitions preceded this run.
  _applyRepairPaymentPool(
    building,
    repairIdStr,
    term,
    paidByProp,
    flagByProp,
    mkPoolPayment,
    droppableByProp,
    preserveOverpayAsCredit
  );

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

// #2/#3 — owner billing for VACANT units (per-expense toggle
// chargeOwnerWhenVacant). For each active building expense that opts in,
// any unit with NO tenant covering the term has its computed share routed
// to the owner ledger (ownerMonthlyExpenses, source:'vacant') instead of
// silently evaporating. Without the flag the share stays uncollected
// (split-among-renters is the implicit current behavior since the rent
// engine only bills contracted properties). Replaces all prior
// source:'vacant' entries each run so it is idempotent on re-save.
//
// Occupancy is per-term: a propertyId is occupied for term T when a
// non-terminated tenant's lease window (and per-property window) covers T.
// We resolve that from the realm's tenants rather than units[].tenant
// (which is any-linked, not term-aware).
// Resolve which of a building's unit propertyIds are OCCUPIED for a term:
// a propertyId is occupied when a tenant's lease window (clamped by
// terminationDate) AND the per-property entry/exit window both cover the
// term (compared at YYYYMM granularity). Shared by vacant-owner billing
// and repair distribution so "is this unit vacant this month" is computed
// one way everywhere.
// PURE: given tenant "occupancy rows" (each carrying a lease window
// beginDate/endDate/terminationDate + a properties[] list with per-property
// entry/exit windows) decide which propertyIds are occupied for `term`. This is
// the ONE occupancy algorithm — both the DB-fetching wrapper below AND the
// breakdown read-path (which already has _tenantGroups in memory) call it, so
// "is this unit occupied this month" can never be computed two different ways
// (the divergence that let a terminated/future-lease unit be billed to BOTH the
// tenant rent and the owner — adversarial finding, June 2026 round-4-review).
// A row shape: { beginDate, endDate, terminationDate, properties: [{propertyId,
// entryDate, exitDate}] }. _tenantGroups already matches this shape exactly.
// The propertyIds of units whose OWNER lives in them (occupancyType
// 'owner_occupied'). An owner-occupied unit's building-expense share is the
// resident owner's own cost, billed to the owner regardless of the expense's
// chargeOwnerWhenVacant flag (mirrors 1_base ownerBilled = isOwnerOccupied ||
// flag). ONE definition shared by the materialiser (_recomputeVacantOwnerCharges)
// and the dashboard/breakdown read-paths so they cannot drift.
function _ownerOccupiedPropertyIds(building: any): Set<string> {
  return new Set<string>(
    (building?.units || [])
      .filter((u: any) => u.propertyId && u.occupancyType === 'owner_occupied')
      .map((u: any) => String(u.propertyId))
  );
}

function _occupiedFromOccupancyRows(rows: any[], term: number): Set<string> {
  const ymTerm = Math.floor(term / 10000);
  const toYM = (d: any): number | null => {
    if (!d) return null;
    const m = moment.utc(d);
    return m.isValid() ? m.year() * 100 + (m.month() + 1) : null;
  };
  const occupied = new Set<string>();
  for (const r of rows || []) {
    const begin = toYM(r.beginDate);
    const end = toYM(r.terminationDate || r.endDate);
    if (begin !== null && ymTerm < begin) continue;
    if (end !== null && ymTerm > end) continue;
    for (const tp of r.properties || []) {
      if (!tp.propertyId) continue;
      const pEntry = toYM(tp.entryDate);
      const pExit = toYM(tp.exitDate);
      if (pEntry !== null && ymTerm < pEntry) continue;
      if (pExit !== null && ymTerm > pExit) continue;
      occupied.add(String(tp.propertyId));
    }
  }
  return occupied;
}

async function _occupiedPropertyIdsForTerm(
  building: any,
  realmId: string,
  term: number
): Promise<Set<string>> {
  const buildingUnitPropIds = (building.units || [])
    .filter((u: any) => u.propertyId)
    .map((u: any) => String(u.propertyId));
  // Covering projection: this function reads only the lease/entry-exit date
  // fields below — never tenant.rents[] (the largest embedded field). Without
  // the projection every callsite (incl. recompute fan-out) pulled full tenant
  // docs (perf finding, round-4-review).
  const tenants = await Collections.Tenant.find(
    {
      realmId,
      'properties.propertyId': { $in: buildingUnitPropIds }
    },
    {
      beginDate: 1,
      endDate: 1,
      terminationDate: 1,
      'properties.propertyId': 1,
      'properties.entryDate': 1,
      'properties.exitDate': 1
    }
  ).lean();
  return _occupiedFromOccupancyRows(tenants as any[], term);
}

// Exported for direct unit testing of the owner-row materialiser (the write
// twin of computeOwnerEksodaByMonth's read path). Not a public route handler.
export async function _recomputeVacantOwnerCharges(
  building: any,
  realmId: string,
  term: number
): Promise<void> {
  const expenses = (building.expenses || []) as any[];
  const optInExpenses = expenses.filter(
    (e) => e.chargeOwnerWhenVacant && isExpenseActiveForTerm(e, term)
  );
  // Owner-fixed: expenses that track a FIXED owner-only monthly amount. These
  // are materialised into real payable owner rows (source:'owner-fixed') so
  // the fixed owner portion is settleable via owner καταβολές like every other
  // charge (was previously a display-only dashboard projection). One row per
  // such expense per active term.
  const ownerFixedExpenses = expenses.filter(
    (e) =>
      e.trackOwnerExpense &&
      Number(e.ownerAmount) > 0 &&
      isExpenseActiveForTerm(e, term)
  );

  // Snapshot the landlord-recorded SETTLEMENT (payments + derived paid/paidDate)
  // BEFORE stripping. These rows are strip-and-rebuilt every recompute (so the
  // amount stays live), but the recorded καταβολές are USER STATE that must
  // survive the rebuild. Without this carry-forward, any unrelated expense edit
  // or tenancy change silently wiped recorded owner payments (adversarial-class
  // finding). Keyed by expenseId+propertyId+term — the natural identity of a
  // recomputed row (the _id is regenerated on rebuild). Covers BOTH the vacant
  // and owner-fixed sources this function owns.
  // Source-GROUP-qualified key (Step-7 #5): now that owner-fixed rows carry a
  // propertyId, an expense that is BOTH trackOwnerExpense (owner-fixed) AND
  // chargeOwnerWhenVacant (vacant) produces TWO rows at the same expenseId|pid|
  // term — an un-qualified key would collide and one source's recorded καταβολή
  // would be dropped. Group owner-fixed in its OWN namespace; keep vacant +
  // owner-resident SHARING a namespace (a vacant↔owner-resident occupancy flip
  // is the SAME money and must carry across the transition).
  const settleGroup = (src: string) => (src === 'owner-fixed' ? 'fx' : 'vr');
  const settleKey = (e: any) =>
    `${settleGroup(e.source || '')}|${String(e.expenseId)}|${String(
      e.propertyId || ''
    )}|${Number(e.term)}`;
  const priorSettle = new Map<string, any>();
  for (const e of (building.ownerMonthlyExpenses || []) as any[]) {
    if (
      (e.source === 'vacant' ||
        e.source === 'owner-fixed' ||
        e.source === 'owner-resident') &&
      Number(e.term) === term
    ) {
      priorSettle.set(settleKey(e), e);
    }
  }
  // `consume(key)` reads a prior settlement AND marks it consumed (deletes it
  // from priorSettle) so the post-rebuild re-attach below can tell which prior
  // rows the rebuild did NOT recreate.
  const consume = (key: string) => {
    const v = priorSettle.get(key);
    if (v !== undefined) priorSettle.delete(key);
    return v;
  };
  // Re-attach any payment-carrying prior row the rebuild did NOT recreate (flag
  // flipped OFF, unit now occupied, expense went variable/inactive, early
  // return). The row is no longer ACTIVELY billed, but the recorded καταβολή is
  // USER STATE that must never be silently deleted — the read surfaces keep it
  // (isOwnerExpenseRowStale's hasPayments guard). Without this, a recorded owner
  // payment vanished on the next recompute (adversarial round-1 finding C1:
  // proven by ownerEksodaByMonth.test.js "C1-a/C1-b"). A prior row with ZERO
  // recorded payments is safe to drop (no money lost). MUST run before EVERY
  // exit from this function.
  const reattachPaidOrphans = () => {
    for (const prior of priorSettle.values()) {
      const carried = carryOwnerPayments(prior);
      const paidSum = carried.payments.reduce(
        (s, p) => s + (Number(p.amount) || 0),
        0
      );
      if (paidSum <= 0) continue; // nothing recorded → safe to drop
      const arr = building.ownerMonthlyExpenses;
      // An OWNER-FIXED orphan (a unit that left the per-unit allocation because
      // the expense's allocationMethod changed) is different from a vacant/
      // owner-resident orphan: the owner AMOUNT it carried is STILL owed — it has
      // been re-materialised on the OTHER units this run. Re-attaching its paidSum
      // as a settled remnant (amount=paidSum) would DOUBLE-count the gross owed
      // (the euro is owed on the new units AND as this remnant), inflating the
      // owner-eksoda above the real expense (Step-7 r4 #4). So an owner-fixed
      // orphan becomes a pure source:'credit' (amount 0) — the recorded money is
      // preserved as an overpayment, never re-asserting a liability.
      //
      // A vacant/owner-resident orphan (flag off / unit occupied / inactive) is
      // NOT re-billed anywhere else, so it stays a SETTLED REMNANT: amount
      // collapses to paidSum → owed === paid, outstanding 0 (carrying the full
      // prior amount created a phantom residual, Step-7-r2 B2/B5).
      const isOwnerFixed = (prior.source || '') === 'owner-fixed';
      arr.push({
        expenseId: prior.expenseId,
        term,
        amount: isOwnerFixed ? 0 : Math.round(paidSum * 100) / 100,
        propertyId: prior.propertyId || null,
        source: isOwnerFixed ? 'credit' : prior.source,
        description: prior.description || '',
        payments: carried.payments
      });
      if (isOwnerFixed) {
        recomputeOwnerExpensePaid(arr[arr.length - 1]);
      } else {
        applyCarriedSettlement(arr[arr.length - 1], carried);
      }
      // mark consumed so a second exit-call cannot double-attach.
      priorSettle.delete(settleKey(prior));
    }
  };

  // Strip prior vacant + owner-fixed + owner-resident entries for this term —
  // full re-derive (this function owns all three sources). Recorded καταβολές
  // are carried via priorSettle/consume and re-attached by reattachPaidOrphans.
  const stale = (building.ownerMonthlyExpenses || []).filter(
    (e: any) =>
      (e.source === 'vacant' ||
        e.source === 'owner-fixed' ||
        e.source === 'owner-resident') &&
      Number(e.term) === term
  );
  for (const e of stale) building.ownerMonthlyExpenses.pull(e._id);

  // Plain snapshot + tenant-group attach — needed by BOTH the owner-fixed
  // per-unit allocation (immediately below) and the vacant/owner-resident loop
  // further down. Hoisted above the owner-fixed loop because the fixed owner
  // amount is now split PER-UNIT by the expense's allocationMethod, which needs
  // the same equal-party divisor (active tenant-groups + vacant managed units)
  // the tenant engine uses.
  const buildingObj = building.toObject ? building.toObject() : building;
  await _attachTenantGroupsToBuildings(realmId, [buildingObj]);

  // Materialise the fixed owner-only amount, allocated PER-UNIT by the expense's
  // allocationMethod (the SAME engine the tenant side + the variable owner-amount
  // path use), so each unit's share is attributed to THAT unit's owner(s) by
  // their declared % on the read surfaces — instead of one building-wide lump
  // that the owner ledger dumped entirely on the sole identified owner (MONEY
  // BUG: ΔΟΚΙΜΗ ΒΗΤΑ, owner of 50% on some units / 100% on others, was
  // billed the full €100 owner-water amount instead of her per-unit share).
  // Σ(per-unit shares) === ownerAmount (computeBuildingChargeForProperty is the
  // conserving allocator). Recorded καταβολές are carried per-unit; a legacy
  // building-wide owner-fixed row's payments are re-applied to the unit rows
  // largest-share-first so no money is lost on the one-time migration. The
  // owner-fixed amount is owner-only (NEVER billed to a tenant), so a per-unit
  // row is kept even when the unit is occupied — no tenant-rent double-count.
  for (const expense of ownerFixedExpenses) {
    const ownerAmount = Math.round(Number(expense.ownerAmount) * 100) / 100;
    if (!(ownerAmount > 0)) continue;
    // Per-unit shares of the OWNER amount — split per MANAGED UNIT (NOT tenant
    // party; fixed→equal; Σ === ownerAmount via the helper's snap). See
    // _allocateOwnerAmountPerUnit for why the tenant equal-allocator is wrong
    // for owner money (Step-7 #1/#2/#6/#10/#12). buildingObj carries
    // _tenantGroups (needed by the vacant loop below); the helper ignores them
    // for equal/fixed and the no-groups property is irrelevant for
    // thousandths/surface (full-denominator, occupancy-independent).
    const perUnit = _allocateOwnerAmountPerUnit(
      buildingObj,
      ownerAmount,
      expense.allocationMethod || 'equal',
      term,
      expense.customAllocations
    );
    const arr = building.ownerMonthlyExpenses;
    if (perUnit.length === 0) {
      // No resolvable per-unit share (no managed units / zero divisor): fall
      // back to a single building-wide row so the owner amount is not lost.
      const carried = carryOwnerPayments(
        consume(`fx|${String(expense._id)}||${term}`)
      );
      arr.push({
        expenseId: String(expense._id),
        term,
        amount: ownerAmount,
        propertyId: null,
        source: 'owner-fixed',
        description: expense.name || '',
        payments: carried.payments
      });
      applyCarriedSettlement(arr[arr.length - 1], carried);
      continue;
    }
    // Migration payment pool = the legacy building-wide lump's payments PLUS any
    // ORPHANED per-unit owner-fixed prior payments — a per-unit row whose unit is
    // NO LONGER in the new allocation (a single_unit/custom RETARGET, or an equal
    // share that went to 0). Those payments must FLOW ONTO the new target units
    // (Step-7 r5 #1/#3): stranding them as a credit on the OLD unit made the
    // ledger/PDF (per-propertyId net) disagree with the dashboard (term-level
    // net) — the owner saw €0 owed on one surface and €100 on another for money
    // she already paid. Routing the payment to the live liability keeps all four
    // surfaces in lockstep. Units STILL in the allocation keep their OWN prior
    // (consumed inside the loop below), so only genuinely-orphaned payments pool.
    const legacyCarried = carryOwnerPayments(
      consume(`fx|${String(expense._id)}||${term}`)
    );
    const migrationPayments = [...legacyCarried.payments];
    const newPidSet = new Set(perUnit.map((p) => p.propertyId));
    // Owner-key set across ALL surviving target units — an orphaned payment may
    // ONLY flow onto the new units if its payer OWNS one of them (Step-7 r6 #1).
    const arrFx = building.ownerMonthlyExpenses;
    const unitByPidFx = new Map<string, any>(
      (building.units || [])
        .filter((u: any) => u.propertyId)
        .map((u: any) => [String(u.propertyId), u])
    );
    const targetOwnerKeys = new Set<string>();
    for (const pid of newPidSet) {
      const u = unitByPidFx.get(pid);
      for (const o of (u?.owners || []) as any[]) {
        const k = ownerKeyOf(o);
        if (k) targetOwnerKeys.add(k);
      }
    }
    const fxPrefix = `fx|${String(expense._id)}|`;
    const fxSuffix = `|${term}`;
    for (const k of Array.from(priorSettle.keys())) {
      if (!k.startsWith(fxPrefix) || !k.endsWith(fxSuffix)) continue;
      const pid = k.slice(fxPrefix.length, k.length - fxSuffix.length);
      if (!pid || newPidSet.has(pid)) continue; // building-wide / still-billed
      const orphan = carryOwnerPayments(consume(k));
      if (!orphan.payments.length) continue;
      // Route the orphan's payments ONTO the new units ONLY if every payment's
      // payer owns a surviving target unit (the single-owner retarget the r5 fix
      // targets). A FOREIGN-tagged payment (a DIFFERENT co-owner paid the old
      // unit) must NOT land on another owner's unit (CRITICAL r6 #1: it would
      // credit the wrong owner and erase the real payer's money). Re-attach those
      // as a source:'credit' row on the orphan's OWN propertyId, preserving the
      // payer's ownerKey — mirrors saveMonthlyStatement's reattach-orphans.
      const flowable = orphan.payments.every(
        (p: any) => !p.ownerKey || targetOwnerKeys.has(String(p.ownerKey))
      );
      if (flowable) {
        migrationPayments.push(...orphan.payments);
      } else {
        arrFx.push({
          expenseId: String(expense._id),
          term,
          amount: 0,
          propertyId: pid,
          source: 'credit',
          description: expense.name || '',
          payments: orphan.payments
        });
        recomputeOwnerExpensePaid(arrFx[arrFx.length - 1]);
      }
    }
    // FIFO queue over the ORIGINAL payments — preserves each payment's own
    // ownerKey/date/type/reference as it drains onto per-unit rows (Step-7 r3 #4:
    // don't collapse two co-owners' tagged payments onto one key).
    const legacyQueue = _makePaymentQueue(migrationPayments);
    const legacyHadPayments = legacyQueue.remainingTotal() > 0.005;
    // A BARE manual-paid lump (setOwnerExpensePaid: paid=true, EMPTY payments)
    // must carry its settled state onto the per-unit rows, else a settled
    // liability silently RE-OPENS on the next recompute (Step-7 r2 #8/#9).
    const legacyManualPaid = legacyCarried.priorPaid && !legacyHadPayments;
    const ordered = [...perUnit].sort((a, b) => b.share - a.share);
    for (const pu of ordered) {
      // This unit's OWN prior per-unit owner-fixed settlement first (fx| group).
      const carried = carryOwnerPayments(
        consume(`fx|${String(expense._id)}|${pu.propertyId}|${term}`)
      );
      const payments = [...carried.payments];
      // Then top up from the legacy lump queue, capped at this unit's free room,
      // drawing ORIGINAL payments (tagged ownerKey/date preserved).
      const carriedSum = payments.reduce(
        (s: number, p: any) => s + (Number(p.amount) || 0),
        0
      );
      const room = Math.round((pu.share - carriedSum) * 100) / 100;
      if (room > 0.005) payments.push(...legacyQueue.take(room));
      arr.push({
        expenseId: String(expense._id),
        term,
        amount: pu.share,
        propertyId: pu.propertyId,
        source: 'owner-fixed',
        description: expense.name || '',
        payments
      });
      // applyCarriedSettlement: derives paid from payments vs the new per-unit
      // amount when payments exist; preserves a manual paid toggle only when
      // the per-unit amount is unchanged (mirrors the original owner-fixed row).
      applyCarriedSettlement(arr[arr.length - 1], carried);
      // Propagate a bare legacy manual-paid toggle (no payments) onto this
      // per-unit row (applyCarriedSettlement only saw the empty per-unit prior).
      if (legacyManualPaid && payments.length === 0) {
        arr[arr.length - 1].paid = true;
        arr[arr.length - 1].paidDate =
          legacyCarried.priorPaidDate || new Date();
      }
    }
    // OVERPAY PRESERVATION (Step-7 #4): an undrained legacy pool is a genuine
    // BUILDING-LEVEL standing overpayment (the per-unit rows above are already
    // filled to their full share). Preserve it as a source:'credit' row with
    // propertyId:null (Step-7 r3 #1/#5/#6) — counted as paid, standing alone in
    // its netting group so it never cross-nets a distinct vacant/owner-resident
    // liability, never mis-credits a unit's owner, and matches the dashboard's
    // term-level pool. The undrained ORIGINAL payments are kept verbatim (each
    // with its own ownerKey/date), so multi-co-owner attribution survives.
    const leftover = legacyQueue.remaining();
    if (leftover.length > 0) {
      arr.push({
        expenseId: String(expense._id),
        term,
        amount: 0,
        propertyId: null,
        source: 'credit',
        description: expense.name || '',
        payments: leftover
      });
      recomputeOwnerExpensePaid(arr[arr.length - 1]);
    }
  }

  // Owner-occupied units (the OWNER lives there). Their building-expense share
  // is genuinely the owner's cost — billed to the owner, but tagged
  // 'owner-resident' (NOT 'vacant') so the UI labels it as an owner-resident
  // charge and never as a vacant/uncollected unit. Shared definition with the
  // dashboard/breakdown read-paths (see _ownerOccupiedPropertyIds).
  const ownerOccupied = _ownerOccupiedPropertyIds(building);
  // An owner-resident share is the resident owner's own cost and is NOT
  // governed by chargeOwnerWhenVacant (that flag only governs truly-EMPTY
  // units). So the per-unit owner-share pass must run over the SUPERSET of
  // {flag-on expenses, for empty units} ∪ {any active expense, for owner-
  // occupied units}. Mirrors the live engine (1_base.ts:368, ownerBilled =
  // isOwnerOccupied || flag). Without this, an owner-occupied unit with the
  // flag OFF was billed by the live breakdown but never materialised here nor
  // counted on the dashboard — three surfaces disagreed (adversarial finding,
  // June 2026 round-4, "Attack #3").
  const activeExpenses = expenses.filter((e) =>
    isExpenseActiveForTerm(e, term)
  );
  // Nothing to do if there are neither flag-on expenses NOR owner-occupied
  // units with active expenses (owner-fixed already (re)materialised above).
  if (
    optInExpenses.length === 0 &&
    (ownerOccupied.size === 0 || activeExpenses.length === 0)
  ) {
    // owner-fixed rows above already consumed their priorSettle; any remaining
    // payment-carrying prior row (e.g. a now-inactive vacant expense) must not
    // be silently dropped.
    reattachPaidOrphans();
    return;
  }

  const occupied = await _occupiedPropertyIdsForTerm(building, realmId, term);

  // For each active expense, write each non-tenant unit's share to the owner —
  // 'owner-resident' for an owner-occupied unit (flag-independent), 'vacant'
  // for a truly-empty unit (only when the expense opts in via the flag).
  // (buildingObj / _tenantGroups already prepared above for the owner-fixed
  // per-unit allocation; reuse it.)
  // Include FIXED-allocation expenses even when top-level amount===0: their
  // real per-unit cost lives in customAllocations
  // (computeBuildingChargeForProperty returns the per-unit value), so a vacant
  // / owner-occupied unit's €40 IS owner-borne. Mirrors the dashboard gap-fill
  // predicate (computeOwnerEksodaByMonth) so the ledger, the breakdown panel,
  // AND the dashboard agree (June 2026 round-4 — the recompute used to skip
  // amount===0 fixed expenses, leaving them dashboard-only).
  //
  // VARIABLE expenses (amount 0, non-fixed — e.g. Ρεύμα/Νερό entered per month)
  // are ALSO included now: their per-unit share for a vacant/owner-occupied
  // unit lives in unit.monthlyCharges (written at statement-entry time), NOT in
  // expense.amount (so computeBuildingChargeForProperty returns 0 for them).
  // Reading that persisted share and writing it as a 'vacant'/'owner-resident'
  // ownerMonthlyExpenses row makes the owner tab show + settle the money the
  // breakdown already bills. Without this, a vacant unit's variable-expense
  // share (Ρεύμα 4,86 € × 10 units) was billed in the breakdown but NEVER
  // persisted, so the owner tab under-reported (Beta showed 0,21 €, owed
  // ~48,81 €). The breakdown's persistedVacantKeys dedup (getExpenseBreakdown
  // ~3030) drops its now-duplicate live row, so no double-count.
  const isVariableExpense = (e: any) =>
    (e.allocationMethod || 'equal') !== 'fixed' && !(Number(e.amount) > 0);
  for (const expense of activeExpenses) {
    const flagOn = !!expense.chargeOwnerWhenVacant;
    const variable = isVariableExpense(expense);
    for (const unit of building.units) {
      if (!unit.propertyId) continue;
      if (occupied.has(String(unit.propertyId))) continue; // billed to renter
      const isResident = ownerOccupied.has(String(unit.propertyId));
      // Empty unit → bill the owner only if the expense opts in; owner-occupied
      // unit → always the resident owner's own cost.
      if (!isResident && !flagOn) continue;
      // VARIABLE expense → share = the persisted per-unit monthlyCharge for this
      // expense+term (the statement figure the landlord entered). FIXED /
      // amount>0 → compute from the engine as before.
      let share: number;
      if (variable) {
        const mc = (unit.monthlyCharges || []).find(
          (c: any) =>
            Number(c.term) === term &&
            String(c.expenseId) === String(expense._id)
        );
        share = mc ? Math.round((Number(mc.amount) || 0) * 100) / 100 : 0;
      } else {
        share = computeBuildingChargeForProperty(
          buildingObj,
          String(unit.propertyId),
          expense,
          term
        );
      }
      if (share <= 0) continue;
      // vr| group (vacant + owner-resident share a namespace so an occupancy
      // flip carries the recorded payment; distinct from the fx| owner-fixed
      // namespace — Step-7 #5).
      const carried = carryOwnerPayments(
        consume(`vr|${String(expense._id)}|${String(unit.propertyId)}|${term}`)
      );
      const arr = building.ownerMonthlyExpenses;
      arr.push({
        expenseId: String(expense._id),
        term,
        amount: Math.round(share * 100) / 100,
        propertyId: String(unit.propertyId),
        // owner-occupied → 'owner-resident' (owner's own cost); else 'vacant'.
        source: isResident ? 'owner-resident' : 'vacant',
        description: expense.name || '',
        // Carry recorded καταβολές across the rebuild; paid re-derived below.
        payments: carried.payments
      });
      applyCarriedSettlement(arr[arr.length - 1], carried);
    }
  }

  // Any prior row the rebuild did NOT recreate (occupied unit, flag-off, share
  // <= 0, variable expense) keeps its recorded καταβολή instead of dropping it.
  reattachPaidOrphans();
}

// Exported lifecycle hook: recompute vacant-owner charges for every
// building containing the given propertyIds, across a bounded term window
// (trailing 12 months through the current month). Called when TENANCY
// changes (move-in/out, terminate, extend) — not just on expense edits —
// so a unit going vacant mid-year immediately accrues the owner's share
// for the now-vacant months instead of waiting for a manual expense edit.
// occupantmanager invokes this via dynamic import to avoid a static import
// cycle (buildingmanager already imports occupantmanager).
export async function recomputeVacantOwnerForProperties(
  realmId: string,
  propertyIds: string[]
): Promise<void> {
  if (!propertyIds || propertyIds.length === 0) return;
  const buildings = await Collections.Building.find({
    realmId,
    'units.propertyId': { $in: propertyIds.map((p) => String(p)) }
  });
  if (!buildings.length) return;

  // Term window: 12 months back through the current month PLUS a bounded
  // forward window (now+1 .. now+12). The trailing months cover
  // already-elapsed vacant periods + the current open term; the forward
  // months cover a unit that goes vacant for FUTURE months (e.g. a tenant
  // terminated with an end date months out). The previous code only iterated
  // the trailing window and a stale comment claimed forward terms were
  // "recomputed lazily on the next expense edit / read" — but no read path
  // ever writes vacant-owner rows, so future vacant months were never billed
  // to the owner (VAC-FORWARD-TERMS).
  const now = moment().startOf('month');
  const terms: number[] = [];
  for (let i = 11; i >= 0; i--) {
    terms.push(
      Number(moment(now).subtract(i, 'months').format('YYYYMMDDHH'))
    );
  }
  for (let i = 1; i <= 12; i++) {
    terms.push(Number(moment(now).add(i, 'months').format('YYYYMMDDHH')));
  }

  for (const building of buildings as any[]) {
    let changed = false;
    for (const term of terms) {
      // VAC-CHANGE-DETECT-EDGE: the before/after fingerprint must include
      // propertyId. Without it, an occupancy swap between two units with an
      // identical rounded share within a term produces before===after, so
      // `changed` stays false and the correct in-memory mutation (which now
      // references the OTHER unit's propertyId) is discarded. Keying on
      // [expenseId, propertyId, amount] detects the swap.
      const fingerprint = () =>
        JSON.stringify(
          (building.ownerMonthlyExpenses || [])
            .filter(
              (e: any) =>
                (e.source === 'vacant' || e.source === 'owner-resident') &&
                Number(e.term) === term
            )
            .map((e: any) => [
              String(e.expenseId),
              String(e.propertyId),
              String(e.source),
              e.amount
            ])
            .sort()
        );
      const before = fingerprint();
      await _recomputeVacantOwnerCharges(building, realmId, term);
      const after = fingerprint();
      if (before !== after) changed = true;
    }
    if (changed) {
      building.updatedDate = new Date();
      await _saveBuildingWithVersionCheck(building);
    }
  }
}

// REPAIR-OCCUPANCY-STALENESS fix. _distributeRepairCharge (the repair→rent
// writer) runs ONLY when a repair is added/edited. So when a tenant later
// occupies a unit that was vacant when a repair was distributed, that unit's
// repair share stays stuck in the vacant/owner bucket (source 'repair-vacant',
// or uncollected Αχρέωτα when the flag is off) and is NEVER moved onto the new
// tenant's rent — the occupied tenant is silently under-billed (confirmed on
// ΟΔΟΣ ΗΤΑ 24: 3 tenants missing their 10 € lift-repair share). The tenant
// lifecycle (occupantmanager link/move/unlink) already re-runs the vacant-OWNER
// EXPENSE recompute via recomputeVacantOwnerForProperties; this is its REPAIR
// twin — re-fire the same, already-correct _distributeRepairCharge writer for
// every active repair on each affected building so occupancy changes re-route
// repair shares between tenant-rent and owner-ledger exactly as an expense edit
// would. _distributeRepairCharge is idempotent (it strips + rebuilds this
// repair's rows, carrying recorded καταβολές forward via the payment pool), so
// re-running it on an unchanged building is a no-op. Best-effort per building:
// one repair's failure must not abort the rest of the lifecycle write.
export async function redistributeRepairsForProperties(
  realmId: string,
  propertyIds: string[]
): Promise<void> {
  if (!propertyIds || propertyIds.length === 0) return;
  const buildings = await Collections.Building.find({
    realmId,
    'units.propertyId': { $in: propertyIds.map((p) => String(p)) }
  });
  if (!buildings.length) return;
  // FREEZE GUARD (Step-7 round-2 critical + timezone). A repair share may only
  // be re-routed on a tenancy change when its chargeTerm tenant rent is THAWED —
  // because Contract.update IGNORES a freshly-written monthlyCharge on a FROZEN
  // term (it clones the frozen rent verbatim). If we re-distributed a repair
  // whose chargeTerm is frozen, _distributeRepairCharge would STRIP the owner
  // 'repair-vacant' row (and DROP any recorded owner καταβολή as a presumed
  // overpay) while the frozen rent never absorbs the share → the euro vanishes
  // from BOTH ledgers (vacant→occupied) or double-counts (occupied→vacant: the
  // frozen rent keeps the old charge AND a fresh owner row is created). The
  // repair-EDIT path already refuses a frozen chargeTerm via
  // _assertChargeTermNotFrozen (422); this tenancy-triggered path mirrors that.
  // Frozen is the FULL Contract._isFrozen rule (past = always; current = if any
  // covering tenant fully paid), checked in UTC to match Contract — a bare
  // `chargeTerm < currentTerm` test missed the frozen-PAID current term and
  // disagreed with Contract's UTC boundary at month edges.
  //
  // SCOPE the freeze check to the AFFECTED units (the propertyIds whose
  // occupancy actually changed), NOT the whole building (Step-7 r3 high). The
  // freeze is PER TENANT (Contract.update freezes each tenant's own rent), so a
  // paid sibling on an UNRELATED unit must not block re-routing an affected
  // unit's thawed share — that re-introduced the ΟΔΟΣ ΗΤΑ-24 under-billing for
  // the current term. We only re-route the affected units' shares anyway, so the
  // freeze gate must look only at the tenants covering those units.
  const affectedSet = new Set(propertyIds.map((p) => String(p)));
  for (const building of buildings as any[]) {
    const affectedBuildingPropIds = ((building as any).units || [])
      .filter((u: any) => u.propertyId && affectedSet.has(String(u.propertyId)))
      .map((u: any) => String(u.propertyId));
    if (!affectedBuildingPropIds.length) continue;
    // Collect the IDs of the repairs to re-distribute, THEN process each by
    // re-fetching the building doc fresh per repair (Step-7 medium: a single
    // shared in-memory doc let a repair that threw AFTER its in-memory strip
    // but BEFORE its save leak the half-stripped state into the NEXT repair's
    // save, destroying the first repair's owner rows + καταβολές). A fresh doc
    // per repair guarantees per-repair atomicity: a failed repair leaves the
    // persisted state untouched and cannot corrupt a sibling. The fresh fetch
    // also naturally satisfies the optimistic-lock retry — a concurrent edit
    // just means the next repair (or the recompute) re-reads the new __v.
    const candidates = (((building as any).repairs || []) as any[]).filter(
      (r: any) => {
        // Skip cancelled (nothing billable) and drafts (no chargeableTo/Term).
        if (r.status === 'cancelled') return false;
        if (!r.chargeableTo || !r.chargeTerm) return false;
        return true;
      }
    );
    const allBuildingPropIds = ((building as any).units || [])
      .filter((u: any) => u.propertyId)
      .map((u: any) => String(u.propertyId));
    const repairIds: string[] = [];
    for (const r of candidates) {
      // EQUAL allocation couples ALL units (share = pool ÷ party-count, and the
      // party-count shifts with occupancy). So a partial re-division — re-divide
      // thawed units at the NEW count while a frozen sibling stays pinned at the
      // OLD count — makes Σ(shares) ≠ cost (over/under-collection, Step-7 r5).
      // For equal, the only internally-consistent options are all-or-nothing:
      // gate on BUILDING-WIDE ANY-frozen so a frozen sibling blocks the whole
      // re-division (stale-but-consistent, matching the pre-fix behaviour). For
      // every other method the per-unit denominator is a FIXED unit attribute
      // (thousandths/surface/fixed/single/custom) that occupancy never changes,
      // so a frozen unit's share is stable and the AFFECTED-scoped check is safe
      // (a paid sibling elsewhere must not block re-routing an affected unit).
      const isEqual = (r.allocationMethod || 'general_thousandths') === 'equal';
      const scope = isEqual ? allBuildingPropIds : affectedBuildingPropIds;
      const frozen = await _isRepairTermFrozenForBuilding(
        realmId,
        scope,
        Number(r.chargeTerm)
      );
      if (!frozen) repairIds.push(String(r._id));
    }

    for (const repairId of repairIds) {
      // ONE bounded retry on a concurrency conflict (409), re-reading fresh.
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt++;
        try {
          const fresh = await Collections.Building.findById(building._id);
          if (!fresh) break; // building deleted mid-flight — nothing to do
          const repair = (((fresh as any).repairs || []) as any[]).find(
            (r: any) => String(r._id) === repairId
          );
          if (!repair) break; // repair removed mid-flight
          // preserveOverpayAsCredit: this is an AUTOMATIC tenancy-triggered
          // re-distribution, so a stranded owner καταβολή must be kept as a
          // refundable credit, never silently dropped (Step-7 round-2 high).
          await _distributeRepairCharge(fresh as any, repair, realmId, true);
          break; // success
        } catch (error) {
          // ServiceError carries the HTTP code in `.statusCode` (NOT `.status`)
          // — _saveBuildingWithVersionCheck maps a Mongoose VersionError to
          // ServiceError(…, 409). Reading the wrong field made this retry dead
          // code (Step-7 r3), so a real version conflict silently abandoned the
          // re-route. Read statusCode.
          const statusCode = (error as any)?.statusCode;
          if (statusCode === 409 && attempt < 3) continue; // retry on version conflict
          logger.error(
            `repair re-distribution failed (building ${building._id}, repair ${repairId}): ${error}`
          );
          break;
        }
      }
    }
  }
}

// EKSODA-DASHBOARD: the OWNER-BORNE expense the landlord must pay each month,
// per term across the calendar year — the expense twin of the rent `revenues`
// series. Combines two sources under ONE rule (see "source-of-truth" below):
//
//   MATERIALISED owner rows (ownerMonthlyExpenses) — the authoritative ledger
//   when it exists. Each row contributes owed = row.amount AND paid (recorded
//   καταβολές / manual paid flag) for its term, from the SAME basis. Sources:
//     'expense'        owner-direct / variable amounts typed via MonthlyStatement
//     'owner-fixed'    the fixed owner-only monthly amount (trackOwnerExpense)
//     'vacant'         a vacant unit's share of a chargeOwnerWhenVacant expense
//     'repair'         a repair's owner-borne portion
//     'repair-vacant'  a vacant unit's share of a repair's tenant-billed amount
//
//   LIVE gap-fill — for liabilities NOT yet materialised (old data / pre-
//   feature buildings, the bug that made every eksoda surface read ~€0), the
//   same engine the materialisers use computes owed: owner-fixed (ownerAmount),
//   vacant building-expense shares (computeBuildingChargeForProperty, incl.
//   FIXED expenses whose cost lives in customAllocations), repair owner-portion
//   (cost·(1−tenantShare%) / full for owners-only), and repair-vacant shares.
//   These INCLUDE ΕΠΙΣΚΕΥΕΣ (repairs) — eksoda is the landlord's pay-portion
//   from WHATEVER origin.
//
// Source-of-truth principle: a materialised row wins; live computation only
// fills gaps it does not cover (coverage key = expenseId|propertyId|term). This
// guarantees (a) no double-count between live + ledger, and (b) owed and paid
// share one basis so a settled liability nets to 0 outstanding (no owed-live-
// vs-paid-frozen truncation by the dashboard's min(paid,owed) cap). Returns
// euros owed/paid keyed by term (YYYYMMDDHH) for the year.
export async function computeOwnerEksodaByMonth(
  realmId: string,
  building: any,
  year: number
): Promise<{
  owedByTerm: Map<number, number>;
  paidByTerm: Map<number, number>;
  // per-term breakdown lines so the dashboard tooltip can list, per month,
  // each (owner, category) the eksoda is composed of — the expense twin of the
  // rent tooltip's per-tenant lines. `paid` is filled only for materialised
  // rows (live gap-fill lines have no recorded paid).
  detailByTerm: Map<
    number,
    Array<{ ownerName: string | null; category: string; label: string; owed: number; paid: number; vacant?: boolean }>
  >;
}> {
  const owedByTerm = new Map<number, number>();
  const paidByTerm = new Map<number, number>();
  const detailByTerm = new Map<
    number,
    Array<{ ownerName: string | null; category: string; label: string; owed: number; paid: number; vacant?: boolean }>
  >();
  const addOwed = (term: number, amt: number) => {
    if (!(amt > 0)) return;
    owedByTerm.set(term, (owedByTerm.get(term) || 0) + amt);
  };
  const addPaid = (term: number, amt: number) => {
    if (!(amt > 0)) return;
    paidByTerm.set(term, (paidByTerm.get(term) || 0) + amt);
  };
  // Accumulate a per-(term, owner, category) breakdown line, merging duplicates.
  const addDetail = (
    term: number,
    ownerName: string | null,
    category: string,
    label: string,
    owed: number,
    paid: number,
    // D5: display-only — true when this line is a vacant unit's share routed to
    // the owner (source 'vacant'/'repair-vacant'), so the tooltip can mark it
    // ΚΕΝΟ. Does NOT affect any money computation.
    vacant = false
  ) => {
    if (!(owed > 0) && !(paid > 0)) return;
    const arr = detailByTerm.get(term) || [];
    // Merge key includes the LABEL, not just owner+category. Two distinct
    // charges of the same category for the same owner (e.g. a building-wide
    // repair owner-portion AND a per-unit repair-vacant share of a DIFFERENT
    // repair, or two 'other' expenses) must stay as separate tooltip lines —
    // merging on owner|category alone collapsed them into one and dropped the
    // second label once building-wide lines gained a non-null owner name
    // (round-6 review). Same-charge fragments still merge because they share
    // the same label.
    const key = `${ownerName || ''}|${category}|${label || ''}`;
    const existing = arr.find(
      (d) => `${d.ownerName || ''}|${d.category}|${d.label || ''}` === key
    );
    if (existing) {
      existing.owed = Math.round((existing.owed + owed) * 100) / 100;
      existing.paid = Math.round((existing.paid + paid) * 100) / 100;
      if (!existing.label && label) existing.label = label;
      if (vacant) existing.vacant = true;
    } else {
      arr.push({ ownerName: ownerName || null, category, label, owed, paid, vacant });
    }
    detailByTerm.set(term, arr);
  };
  // First named owner of a unit (for attributing a vacant/repair-vacant line).
  const unitOwnerName = (propertyId: any): string | null => {
    if (!propertyId) return null;
    const unit = (building.units || []).find(
      (u: any) => String(u.propertyId) === String(propertyId)
    );
    const named = ((unit?.owners || []) as any[]).filter((o: any) => o && o.name);
    if (named.length === 0) return null;
    return named.map((o: any) => o.name).join(', ');
  };

  // Building-level owner name for a building-WIDE liability (a repair
  // owner-portion or owner-fixed amount carries no propertyId). The payer is
  // the building's owner(s): the sole distinct named owner, or "<first> +N"
  // when several. So a building-wide repair line shows WHO pays in the tooltip
  // instead of a blank owner (the "Επισκευή ασανσέρ with no payer" bug). Same
  // distinct-owner resolution the building Έξοδα breakdown uses.
  // List ALL building owners by name (not "+N" truncation) so the tooltip
  // shows every co-owner. A building with 2 owners shows "ΛΑΜΔΑ, ΚΑΠΠΑ"
  // not "ΛΑΜΔΑ +1" (the user explicitly flagged the +1 as wrong).
  const buildingOwnerName = (() => {
    const byKey = new Map<string, any>();
    for (const u of (building.units || []) as any[]) {
      for (const o of (u.owners || []) as any[]) {
        const k = ownerKeyOf(o);
        if (k && o && o.name && !byKey.has(k)) byKey.set(k, o);
      }
    }
    const named = Array.from(byKey.values());
    if (named.length === 0) return null;
    return named.map((o) => o.name).join(', ');
  })();

  const expenses = (building.expenses || []) as any[];
  const repairs = (building.repairs || []) as any[];

  // ── Source-of-truth principle ──────────────────────────────────────────
  // A MATERIALISED owner row (ownerMonthlyExpenses) is authoritative for BOTH
  // its owed (= row.amount) AND its paid (recorded καταβολές / paid flag) for
  // its term — they share the SAME basis, so owed and paid for a settled row
  // always net to 0 outstanding. The LIVE streams below only FILL GAPS: a
  // liability that has no materialised row yet (old data / pre-feature
  // buildings — the bug that made every eksoda surface read ~€0). This avoids
  // (a) double-counting a liability that is both materialised and live, and
  // (b) the owed-live-vs-paid-frozen mismatch the dashboard `min(paid,owed)`
  // cap would otherwise silently truncate. Coverage key = expenseId|propertyId
  // |term (a repair row's expenseId IS the repair _id; owner-direct + owner-
  // fixed + repair-portion rows carry no propertyId → '').
  const covered = new Set<string>();
  const covKey = (expenseId: any, propertyId: any, term: number) =>
    `${String(expenseId)}|${propertyId ? String(propertyId) : ''}|${term}`;
  // owner-fixed is now materialised PER-UNIT (each row carries a propertyId),
  // so the building-wide null cov-key the gap-fill used to check is never set.
  // Track which (expenseId, term) pairs have ANY materialised owner-fixed row
  // so the owner-fixed gap-fill below skips an already-materialised expense
  // regardless of how many per-unit rows it produced (else the full ownerAmount
  // is re-added on top of the per-unit rows — a double-count).
  const ownerFixedMaterialised = new Set<string>();
  const ownerFixedKey = (expenseId: any, term: number) =>
    `${String(expenseId)}|${term}`;

  // STALE-VACANT GUARD (mirrors getBuildingExpenseBreakdown's read-time guard,
  // 2335-2361). The vacant/repair-vacant recompute only re-derives the CURRENT
  // term, so flipping chargeOwnerWhenVacant OFF, an expense going inactive, or
  // a unit becoming OCCUPIED leaves orphaned source:'vacant'/'repair-vacant'
  // rows for OTHER terms. Counting them would double-bill: the same euro shows
  // as owner eksoda here AND is billed to the now-present tenant via rent
  // buildingCharges (the owner-is-also-renter double-count the audit found).
  // Drop a vacant row whose expense is gone / no longer opts in / inactive, OR
  // whose unit is occupied for that term. Occupancy is resolved per-term and
  // cached (the rows of a year span ≤12 distinct terms).
  const liveExpenseById = new Map<string, any>(
    expenses.map((e: any) => [String(e._id), e])
  );
  const occupiedCache = new Map<number, Set<string>>();
  const occupiedForTerm = async (term: number): Promise<Set<string>> => {
    if (!occupiedCache.has(term)) {
      occupiedCache.set(
        term,
        await _occupiedPropertyIdsForTerm(building, realmId, term)
      );
    }
    return occupiedCache.get(term)!;
  };
  // CURRENT owner-occupied set — an 'owner-resident' row is only valid while
  // the unit is still owner-occupied (updateUnit can flip occupancyType
  // without a window-bounded owner recompute, leaving a stale row).
  const ownerOccupiedNow = _ownerOccupiedPropertyIds(building);

  for (const row of (building.ownerMonthlyExpenses || []) as any[]) {
    const term = Number(row.term || 0);
    if (Math.floor(term / 1000000) !== year) continue;
    const amount = Number(row.amount) || 0;
    // Keep amount=0 rows carrying recorded καταβολές (delete-time 'credit'
    // rows) so the preserved owner payment is counted in the dashboard eksoda
    // PAID total — mirroring the ledger + statement. (addOwed only fires for
    // amount>0, so a credit adds paid without inflating owed.)
    const rowHasPaymentsK = ((row.payments || []) as any[]).some(
      (p) => Number(p && p.amount) > 0
    );
    if (!(amount > 0) && !rowHasPaymentsK) continue;
    // Validate source:'vacant' (building-expense) rows against current live
    // state. The occupancy/flag/inactive drop applies ONLY to 'vacant': a
    // building expense is LIVE-rederived into the now-occupied tenant's rent
    // (1_base computeBuildingChargeForProperty), so the same euro would
    // double-count (owner here + tenant rent) — drop the stale owner row.
    //
    // 'repair-vacant' is DIFFERENT and must NOT be dropped on occupancy: a
    // repair's tenant-portion share is materialised ONCE by
    // _distributeRepairCharge (re-run only on repair add/edit, NEVER on a
    // tenancy change) and is NOT in building.expenses, so it is never
    // re-billed to a later tenant. Dropping it on occupancy would make the
    // repair share vanish from BOTH the owner eksoda AND the tenant rent —
    // silent money loss (REPAIR-VACANT-VANISHES, adversarial round, June 2026).
    // The owner genuinely owes it (the unit was vacant when the repair was
    // distributed); a tenant who moved in later was not there for the repair.
    if (row.source === 'vacant' || row.source === 'owner-resident') {
      // NEVER drop a row carrying recorded payments — recorded money must
      // survive on every settlement surface (round-4-review-2 finding).
      const hasPayments = ((row.payments || []) as any[]).some(
        (p) => Number(p && p.amount) > 0
      );
      if (!hasPayments) {
        const src = liveExpenseById.get(String(row.expenseId));
        if (!src) continue; // expense gone
        // 'vacant' (truly-empty unit) requires the opt-in flag; 'owner-resident'
        // (the owner lives there) is the resident owner's OWN cost, NOT
        // flag-governed (mirrors 1_base ownerBilled = isOwnerOccupied || flag).
        // Dropping owner-resident on flag-off made the dashboard read €0 while
        // the live breakdown billed it (3-surface disagreement, June 2026).
        if (row.source === 'vacant' && !src.chargeOwnerWhenVacant) continue;
        if (!isExpenseActiveForTerm(src as any, term)) continue; // inactive
        if (row.propertyId) {
          const occ = await occupiedForTerm(term);
          // A TENANT occupying the unit FOR THE TERM live-bills the building
          // expense to them, so a stale 'vacant' OR 'owner-resident' owner row
          // for that unit/term must drop (else the same euro double-counts:
          // owner here + tenant rent). This is the ONLY occupancy drop — a
          // current-day owner-occupancy flip is the writer's job (updateUnit
          // recompute); a historical owner-resident liability for a term the
          // owner DID reside in must NOT be erased by today's state
          // (round-4-review-2 money-wrong finding).
          if (occ.has(String(row.propertyId))) continue;
        }
      }
    }
    // owner-fixed coverage lives in its OWN namespace (ownerFixedMaterialised),
    // NOT the shared `covered` set (Step-7 #8/#13). A per-unit owner-fixed row
    // now carries a propertyId, so adding it to `covered` under
    // covKey(expenseId|propertyId|term) would collide with — and wrongly
    // suppress — the DISTINCT owner-resident/vacant building-expense gap-fill for
    // the SAME (expenseId, propertyId, term). Those are two different liabilities
    // (the fixed owner-only amount vs the tenant-amount share routed to the
    // owner). So owner-fixed rows ONLY mark ownerFixedMaterialised (which gates
    // the owner-fixed gap-fill); every other source uses the shared `covered`.
    if (row.source === 'owner-fixed') {
      ownerFixedMaterialised.add(ownerFixedKey(row.expenseId, term));
    } else {
      covered.add(covKey(row.expenseId, row.propertyId, term));
    }
    // Materialised row → owed AND paid. The PAID figure MUST match the ledger
    // (_aggregateOwners) and the legal PDF (buildOwnerStatement), which both
    // count the FULL recorded payment with NO Math.min(...,amount) clamp and
    // floor outstanding at 0 (Step-7 #3/#7/#14). The dashboard previously clamped
    // paid to the row amount → an over-paid row (owner paid the full share, then
    // ownerAmount was reduced) showed paid=amount here but paid=full on the
    // ledger/PDF — a cross-surface disagreement (Step-7 r6 #2/#3). Count the full
    // recorded payment; the dashboard bridge floors notPaid at max(0, owed−paid)
    // so an over-payment never goes negative. (fromFlag covers a bare manual
    // paid:true with no payments[].)
    addOwed(term, amount);
    const fromPayments = ((row.payments || []) as any[]).reduce(
      (s, p) => s + (Number(p.amount) || 0),
      0
    );
    const fromFlag = row.paid ? amount : 0;
    const rowPaid =
      row.source === 'credit'
        ? fromPayments
        : Math.max(fromPayments, fromFlag);
    addPaid(term, rowPaid);
    // breakdown line: category from source (repair → 'repair', else the
    // source expense's schema type), owner from the row's unit (vacant /
    // owner-resident / repair-vacant) else the building's owner(s) for a
    // building-wide row (owner-direct / owner-fixed / building-wide repair) —
    // so the tooltip always shows WHO pays, never a blank payer.
    const srcExp = liveExpenseById.get(String(row.expenseId));
    const category =
      row.source === 'repair' || row.source === 'repair-vacant'
        ? 'repair'
        : srcExp?.type || 'other';
    addDetail(
      term,
      row.propertyId ? unitOwnerName(row.propertyId) : buildingOwnerName,
      category,
      row.description || srcExp?.name || '',
      amount,
      rowPaid,
      // ΚΕΝΟ only for a truly-vacant unit's share. A repair-vacant (or vacant)
      // row on an OWNER-OCCUPIED unit is the resident owner's own cost — not a
      // vacant-unit charge — so it must NOT carry the ΚΕΝΟ marker.
      (row.source === 'vacant' || row.source === 'repair-vacant') &&
        !(row.propertyId && ownerOccupiedNow.has(String(row.propertyId)))
    );
  }

  // Plain snapshot + tenant-group attach so computeBuildingChargeForProperty's
  // equal-allocation groups by unique tenant (the same prep the materialisers
  // and the breakdown engine do).
  const buildingObj = building.toObject ? building.toObject() : building;
  await _attachTenantGroupsToBuildings(realmId, [buildingObj]);

  const ownerFixed = expenses.filter(
    (e) => e.trackOwnerExpense && Number(e.ownerAmount) > 0
  );
  // Owner-occupied units (the owner lives there) — their share of ANY active
  // expense is the resident owner's OWN cost, billed regardless of the
  // chargeOwnerWhenVacant flag (mirrors _recomputeVacantOwnerCharges).
  // Same shared definition; reuse the set computed above.
  const ownerOccupiedSet = ownerOccupiedNow;

  // Per-month owner liability from building expenses (12 terms of `year`) —
  // ONLY for liabilities not already covered by a materialised row above.
  for (let mm = 1; mm <= 12; mm++) {
    const term = Number(
      moment.utc(`${mm}/${year}`, 'MM/YYYY').format('YYYYMMDDHH')
    );
    // owner-fixed: the fixed owner-only amount for each active expense. The
    // amount is materialised PER-UNIT now (each row carries a propertyId), so
    // check BOTH the legacy building-wide null cov-key AND the per-(expense,
    // term) materialised set — skip the gap-fill when EITHER says the expense
    // is already materialised this term (else the full ownerAmount is re-added
    // on top of the per-unit rows). The gap-fill only fires for legacy/pre-
    // feature data with no materialised owner-fixed row at all.
    for (const e of ownerFixed) {
      if (!isExpenseActiveForTerm(e, term)) continue;
      if (covered.has(covKey(e._id, null, term))) continue; // legacy lump
      if (ownerFixedMaterialised.has(ownerFixedKey(e._id, term))) continue; // per-unit
      const fixedAmt = Math.round(Number(e.ownerAmount) * 100) / 100;
      addOwed(term, fixedAmt);
      addDetail(term, buildingOwnerName, e.type || 'other', e.name || '', fixedAmt, 0);
    }
    // building-expense shares routed to the owner: a truly-EMPTY unit's share
    // when the expense opts in (chargeOwnerWhenVacant), AND an OWNER-OCCUPIED
    // unit's share of ANY active expense (flag-independent — the resident
    // owner's own cost). Include FIXED expenses even though `amount` is 0 — a
    // fixed expense's real cost lives in customAllocations
    // (computeBuildingChargeForProperty returns the per-unit value). Only
    // truly-variable expenses (amount 0, non-fixed — materialised into
    // monthlyCharges at statement time) are skipped here.
    const activeForOwner = expenses.filter(
      (e) =>
        isExpenseActiveForTerm(e, term) &&
        (e.allocationMethod === 'fixed' || Number(e.amount) > 0)
    );
    if (activeForOwner.length) {
      const occupied = await occupiedForTerm(term);
      for (const e of activeForOwner) {
        const flagOn = !!e.chargeOwnerWhenVacant;
        for (const unit of building.units || []) {
          if (!unit.propertyId) continue;
          if (occupied.has(String(unit.propertyId))) continue;
          const isResident = ownerOccupiedSet.has(String(unit.propertyId));
          // empty unit billed only if the expense opts in; owner-occupied unit
          // always (its share is the resident owner's own cost).
          if (!isResident && !flagOn) continue;
          if (covered.has(covKey(e._id, unit.propertyId, term))) continue;
          const share = computeBuildingChargeForProperty(
            buildingObj,
            String(unit.propertyId),
            e,
            term
          );
          const shareR = Math.round(share * 100) / 100;
          if (!(shareR > 0)) continue;
          addOwed(term, shareR);
          addDetail(
            term,
            unitOwnerName(unit.propertyId),
            e.type || 'other',
            e.name || '',
            shareR,
            0,
            true // vacant-unit share routed to owner → ΚΕΝΟ
          );
        }
      }
    }
  }

  // Repairs: owner-portion + vacant-unit shares, at each repair's chargeTerm
  // (only those falling in `year`). Cancelled repairs contribute nothing.
  for (const repair of repairs) {
    if (repair.status === 'cancelled') continue;
    if (!repair.chargeableTo || !repair.chargeTerm) continue;
    const term = Number(repair.chargeTerm);
    if (Math.floor(term / 1000000) !== year) continue;
    const cost = repair.actualCost || repair.estimatedCost || 0;
    if (!(cost > 0)) continue;
    const repairIdStr = String(repair._id);
    // Shared share% resolution (the ONE helper the writer + breakdown also use,
    // so the three can't drift). Same result as the prior inline copy.
    const sharePercentage = repairTenantSharePercentage(repair);
    const ownerPortion =
      repair.chargeableTo === 'owners' ? cost : cost * (1 - sharePercentage / 100);
    // owner-portion (source:'repair', no propertyId) — skip if materialised.
    if (!covered.has(covKey(repairIdStr, null, term))) {
      const ownerPortionR = Math.round(ownerPortion * 100) / 100;
      addOwed(term, ownerPortionR);
      addDetail(
        term,
        buildingOwnerName,
        'repair',
        repair.title || '',
        ownerPortionR,
        0
      );
    }

    // repair-vacant: the tenant-billed amount distributed across units; a
    // VACANT unit's share is the owner's ONLY when the repair opts in via
    // chargeOwnerWhenVacant (§2 — mirrors building expenses). With the flag OFF
    // the vacant share is Αχρέωτα (uncollected), NOT owner-borne — so this live
    // reader MUST gate on the same flag the writer (_distributeRepairCharge)
    // does, else the dashboard eksoda bills the owner for a share the writer
    // never materialised (writer/reader disagreement, Step-7 §2-read finding).
    const effectiveAmount = cost * (sharePercentage / 100);
    // The tenant-share of a repair falls to the owner in TWO cases (mirroring
    // the writer _distributeRepairCharge): a truly-EMPTY unit when the repair
    // opts in via chargeOwnerWhenVacant, AND an OWNER-OCCUPIED unit ALWAYS
    // (flag-independent — the owner lives there, it's their own cost). Before
    // this, the reader gated solely on the flag, so an owner-occupied unit's
    // repair tenant-share was never billed on the dashboard when the flag was
    // OFF — reader/writer disagreement (the resident-owner repair bug).
    const ownerOccForRepair = _ownerOccupiedPropertyIds(building);
    if (effectiveAmount > 0 && (repair.chargeOwnerWhenVacant || ownerOccForRepair.size > 0)) {
      const allocationMethod = repair.allocationMethod || 'general_thousandths';
      const restrictUnits =
        Array.isArray(repair.affectedUnitIds) && repair.affectedUnitIds.length > 0
          ? new Set(repair.affectedUnitIds.map((u: any) => String(u)))
          : null;
      const occupied = await occupiedForTerm(term);
      for (const unit of building.units || []) {
        if (!unit.propertyId) continue;
        if (restrictUnits && !restrictUnits.has(String(unit._id))) continue;
        if (occupied.has(String(unit.propertyId))) continue; // billed to tenant
        if (covered.has(covKey(repairIdStr, unit.propertyId, term))) continue;
        const isResidentUnit = ownerOccForRepair.has(String(unit.propertyId));
        // A truly-empty (vacant) unit is owner-billed ONLY with the flag; an
        // owner-occupied unit is owner-billed regardless.
        if (!isResidentUnit && !repair.chargeOwnerWhenVacant) continue;
        const share = computeBuildingChargeForProperty(
          buildingObj,
          String(unit.propertyId),
          { amount: effectiveAmount, allocationMethod, name: repair.title } as any,
          term
        );
        const shareR = Math.round(share * 100) / 100;
        addOwed(term, shareR);
        addDetail(
          term,
          unitOwnerName(unit.propertyId),
          'repair',
          repair.title || '',
          shareR,
          0,
          // ΚΕΝΟ only for a truly-vacant unit; an owner-occupied unit's repair
          // share is the resident owner's cost, NOT a vacant-unit charge.
          !isResidentUnit
        );
      }
    }
  }

  return { owedByTerm, paidByTerm, detailByTerm };
}

// §5: the per-term GROSS Αχρέωτα (uncollected vacant-unit expense money) for
// every month of `year`. Runs the SAME breakdown engine getExpenseBreakdown
// uses, per month, taking ONLY ownerUnbilledTotal (recipient:'owner',
// !ownerBilled rows — flag-off vacant expense shares + §1.8 flag-off repair
// shares). Returns Map<term, grossEuro>. Expensive (12 engine runs); callers
// gate it to a single building. Has ZERO side effects (works on a deep clone).
async function _uncollectedGrossByTerm(
  realmId: string,
  building: any,
  year: number
): Promise<Map<number, number>> {
  const _r = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
  // DEEP-CLONE: the caller may pass a lean()/toObject() POJO whose reference IS
  // the object _toBuildingData later spreads into the response. Mutating it here
  // (attaching _tenantGroups, per-term unit.tenant scratch) would LEAK internal
  // lease-window data into every single-building API response (Step-7 §5).
  const hydratedBase: any = JSON.parse(
    JSON.stringify(building.toObject ? building.toObject() : building)
  );
  const propIds = (hydratedBase.units || [])
    .filter((u: any) => u.propertyId)
    .map((u: any) => String(u.propertyId));
  const props = propIds.length
    ? await Collections.Property.find({
        realmId,
        _id: { $in: propIds }
      }).lean()
    : [];
  const propMap = new Map((props as any[]).map((p: any) => [String(p._id), p]));
  const tenants = propIds.length
    ? await Collections.Tenant.find(
        { realmId, 'properties.propertyId': { $in: propIds } },
        { name: 1, properties: 1 }
      ).lean()
    : [];
  const tenantByProp = new Map<string, any>();
  for (const tt of tenants as any[]) {
    for (const tp of tt.properties || []) {
      if (tp.propertyId)
        tenantByProp.set(String(tp.propertyId), {
          _id: String(tt._id),
          name: tt.name
        });
    }
  }
  for (const u of hydratedBase.units || []) {
    u.property = u.propertyId ? propMap.get(String(u.propertyId)) : null;
    u.tenant = u.propertyId ? tenantByProp.get(String(u.propertyId)) || null : null;
  }
  await _attachTenantGroupsToBuildings(realmId, [hydratedBase]);
  const groups = (hydratedBase._tenantGroups || []) as any[];
  const baseTenantByUnit = new Map<string, any>();
  for (const u of hydratedBase.units || []) {
    baseTenantByUnit.set(String(u._id), u.tenant || null);
  }
  const byTerm = new Map<number, number>();
  for (let mm = 1; mm <= 12; mm++) {
    const term = Number(`${year}${String(mm).padStart(2, '0')}0100`);
    const occupied = _occupiedFromOccupancyRows(groups, term);
    for (const u of (hydratedBase as any).units || []) {
      if (!u.propertyId) continue;
      u.tenant = occupied.has(String(u.propertyId))
        ? baseTenantByUnit.get(String(u._id)) || null
        : null;
    }
    const bd = computeBuildingExpenseBreakdown(hydratedBase as any, term);
    const g = _r(Number(bd.ownerUnbilledTotal) || 0);
    if (g > 0) byTerm.set(term, g);
  }
  return byTerm;
}

// §5: cumulative Αχρέωτα for `year`, netted against recorded voluntary
// uncollectedPayments. {total, paidTotal, outstanding}.
async function computeUncollectedByYear(
  realmId: string,
  building: any,
  year: number
): Promise<{ total: number; paidTotal: number; outstanding: number }> {
  const _r = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
  const byTerm = await _uncollectedGrossByTerm(realmId, building, year);
  // M1: net PER-TERM, then sum — the ΧΡΕΩΣΕΙΣ panel clamps each month's
  // outstanding to max(0, gross[term] − paid[term]), so an over-contribution in
  // one month stays confined to that month. Summing gross and paid separately
  // and clamping once at year level let an over-payment in month A bleed into
  // and reduce month B's outstanding — the tile then under-reported vs the
  // panel for the same building (reader disagreement). Sum the per-term gross
  // for the headline `total`, and the per-term clamped residual for
  // `outstanding`, so the tile and panel reconcile term-by-term.
  const paidByTerm = new Map<number, number>();
  for (const p of (building as any).uncollectedPayments || []) {
    const tm = Number(p.term || 0);
    if (Math.floor(tm / 1000000) !== year) continue;
    paidByTerm.set(tm, _r((paidByTerm.get(tm) || 0) + (Number(p.amount) || 0)));
  }
  let total = 0;
  let paidTotal = 0;
  let outstanding = 0;
  // Union of terms that carry gross OR a payment, so a contribution recorded
  // against a term with zero gross is still counted in paidTotal (the headline)
  // but contributes 0 to outstanding (clamped) — never a negative.
  const terms = new Set<number>([...byTerm.keys(), ...paidByTerm.keys()]);
  for (const tm of terms) {
    const gross = _r(byTerm.get(tm) || 0);
    const paid = _r(paidByTerm.get(tm) || 0);
    total = _r(total + gross);
    paidTotal = _r(paidTotal + paid);
    outstanding = _r(outstanding + Math.max(0, _r(gross - paid)));
  }
  return { total, paidTotal, outstanding };
}

// Confirm whether ANY tenant LINKED TO THIS BUILDING has a paid rent for
// the given term. Past-paid rents are frozen — repairs targeting those
// terms would write a monthlyCharge that is silently ignored by the
// already-issued bill. Building-scoped query: previously this checked
// realm-wide, which falsely blocked repairs on building B because
// building A had a paid past-month rent (F3-repair regression).
async function _isPastPaidTermFrozenInBuilding(
  realmId: string,
  buildingPropertyIds: string[],
  term: number
): Promise<boolean> {
  if (!buildingPropertyIds.length) return false;
  return Boolean(
    await Collections.Tenant.exists({
      realmId,
      'properties.propertyId': { $in: buildingPropertyIds },
      rents: {
        $elemMatch: {
          term,
          payments: { $elemMatch: { amount: { $gt: 0 } } }
        }
      }
    } as any)
  );
}

// Is `term`'s tenant rent FROZEN for ANY tenant covering this building — i.e.
// would Contract.update IGNORE a freshly-written repair monthlyCharge for that
// term? Mirrors Contract._isFrozen EXACTLY so the redistribute guard and the
// rent recompute agree on the same euro (Step-7 round-2 critical + timezone):
//   - term  < currentTerm (UTC) → ALWAYS frozen (closed month).
//   - term == currentTerm (UTC) → frozen ONLY if some covering tenant has that
//     month FULLY PAID (Σpayments ≥ grandTotal − 1c).
//   - term  > currentTerm → never frozen.
// UTC throughout to match Contract._currentTermFor (the documented timezone
// gotcha: both sides of the comparison must be UTC or both local — never mixed).
async function _isRepairTermFrozenForBuilding(
  realmId: string,
  buildingPropertyIds: string[],
  term: number
): Promise<boolean> {
  if (!buildingPropertyIds.length) return false;
  const frozen = await _frozenPropertyIdsForTerm(
    realmId,
    buildingPropertyIds,
    term
  );
  // ANY covering unit frozen → the repair (which re-divides across all of them)
  // must be treated as frozen for the redistribute guard's scoped check.
  return buildingPropertyIds.some((pid) => frozen.has(String(pid)));
}

// The SET of propertyIds whose covering tenant's rent is FROZEN for `term`
// (Contract.update would ignore a freshly-written monthlyCharge on them).
// Single source of truth for the per-unit freeze test, shared by the
// redistribute guard (_isRepairTermFrozenForBuilding) AND the writer loop
// (_distributeRepairCharge skips strip/rebuild of a frozen unit so an equal-
// allocation divisor shift can't overwrite a frozen sibling's pinned share —
// Step-7 r4 medium). Mirrors Contract._isFrozen EXACTLY, UTC throughout:
//   - term  < currentTerm (UTC) → ALL given units frozen (closed month).
//   - term == currentTerm (UTC) → a unit is frozen iff its covering tenant has
//     that month FULLY PAID (Σpayments ≥ grandTotal − 1c).
//   - term  > currentTerm → none frozen.
async function _frozenPropertyIdsForTerm(
  realmId: string,
  buildingPropertyIds: string[],
  term: number
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!buildingPropertyIds.length) return out;
  const currentTermUtc = Number(
    moment.utc().startOf('month').format('YYYYMMDDHH')
  );
  if (term > currentTermUtc) return out; // future → none frozen
  if (term < currentTermUtc) {
    // past → every given unit is frozen
    for (const pid of buildingPropertyIds) out.add(String(pid));
    return out;
  }
  // Current term: a unit is frozen iff its covering tenant has it fully paid.
  // (Σpayments vs grandTotal cannot be a Mongo query — compute in JS, identical
  // to Contract._isFullyPaid.)
  const tenants = await Collections.Tenant.find(
    {
      realmId,
      'properties.propertyId': { $in: buildingPropertyIds }
    },
    { rents: 1, 'properties.propertyId': 1 }
  ).lean();
  for (const t of tenants as any[]) {
    const rent = (t.rents || []).find((r: any) => Number(r.term) === term);
    if (!rent) continue;
    const totalDue = Number(
      rent?.total?.grandTotal ?? rent?.totalToPay ?? rent?.totalAmount ?? 0
    );
    if (!Number.isFinite(totalDue) || totalDue <= 0) continue;
    const paid = (rent.payments || []).reduce(
      (s: number, p: any) => s + (Number(p.amount) || 0),
      0
    );
    if (paid < totalDue - 0.01) continue; // not fully paid → thawed
    // This tenant's term is fully paid → every property it covers is frozen.
    for (const p of t.properties || []) {
      if (p.propertyId) out.add(String(p.propertyId));
    }
  }
  return out;
}

// Shared past-paid frozen-term guard for addRepair AND updateRepair.
// Throws 422 when chargeTerm is in the past, the repair would charge
// tenants (chargeableTo!=='owners' AND has cost), AND any tenant in this
// building has paid rent for that term.
async function _assertChargeTermNotFrozen(
  realmId: string,
  buildingPropertyIds: string[],
  body: any
): Promise<void> {
  if (!body?.chargeTerm) return;
  if (!body.chargeableTo || body.chargeableTo === 'owners') return;
  const cost = Number(body.actualCost) || Number(body.estimatedCost) || 0;
  if (cost <= 0) return;
  const currentTerm = Number(
    moment.utc().startOf('month').format('YYYYMMDDHH')
  );
  if (Number(body.chargeTerm) >= currentTerm) return;
  const frozen = await _isPastPaidTermFrozenInBuilding(
    realmId,
    buildingPropertyIds,
    Number(body.chargeTerm)
  );
  if (frozen) {
    throw new ServiceError(
      'Charge month is in the past and at least one tenant in this building has paid rent for that month. Past-paid rents are frozen — pick a current or future month.',
      422
    );
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
  // Tier I-3.c: affectedUnitIds is optional but when present must be an
  // array of non-empty strings — Mongoose's [String] casts loosely.
  if (req.body.affectedUnitIds !== undefined) {
    if (!Array.isArray(req.body.affectedUnitIds)) {
      throw new ServiceError('affectedUnitIds must be an array', 422);
    }
    if (
      req.body.affectedUnitIds.some(
        (u: any) => typeof u !== 'string' || !u.trim()
      )
    ) {
      throw new ServiceError(
        'affectedUnitIds must be non-empty strings',
        422
      );
    }
  }
  if (req.body.chargeTerm) {
    validateTerm(req.body.chargeTerm, 'chargeTerm');
    // Round-1 audit L2: normalize chargeTerm to YYYYMM0100 (day=01) so a
    // day≠01 term doesn't vanish from the dashboard rollup (which seeds
    // termToKey only at YYYYMM0100 and drops anything else). Mirrors the
    // one-time expense startTerm normalization (~line 3040). UI emits day-01;
    // this guards API/script callers.
    const _ct = Number(req.body.chargeTerm);
    if (Number.isFinite(_ct)) {
      req.body.chargeTerm = Math.floor(_ct / 10000) * 10000 + 100;
    }
  }

  const building = await Collections.Building.findOne({
    _id: id,
    realmId: realm!._id
  });

  _findBuilding(building, id);

  // Past-paid frozen-term guard, scoped to THIS building's units only.
  await _assertChargeTermNotFrozen(
    String(realm!._id),
    ((building as any).units || [])
      .filter((u: any) => u.propertyId)
      .map((u: any) => String(u.propertyId)),
    req.body
  );

  (building as any).repairs.push(req.body);
  (building as any).updatedDate = new Date();
  // DO NOT save here — _distributeRepairCharge saves the building itself (it
  // mutates unit.monthlyCharges + ownerMonthlyExpenses then calls
  // _saveBuildingWithVersionCheck). Saving twice caused a race: save #1 bumps
  // __v, then _distributeRepairCharge's save #2 conflicts if anything else
  // touched the building between the two (e.g. a concurrent sibling-recompute),
  // causing the distribution to 409 while the repair subdoc persisted — a
  // stranded repair with zero billing data. Single-save eliminates the race.
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
  // Tier I-3.c: same shape guard as addRepair.
  if (req.body.affectedUnitIds !== undefined) {
    if (!Array.isArray(req.body.affectedUnitIds)) {
      throw new ServiceError('affectedUnitIds must be an array', 422);
    }
    if (
      req.body.affectedUnitIds.some(
        (u: any) => typeof u !== 'string' || !u.trim()
      )
    ) {
      throw new ServiceError(
        'affectedUnitIds must be non-empty strings',
        422
      );
    }
  }
  if (req.body.chargeTerm) {
    validateTerm(req.body.chargeTerm, 'chargeTerm');
    // Round-1 audit L2: normalize chargeTerm to YYYYMM0100 (day=01) so a
    // day≠01 term doesn't vanish from the dashboard rollup (which seeds
    // termToKey only at YYYYMM0100 and drops anything else). Mirrors the
    // one-time expense startTerm normalization (~line 3040). UI emits day-01;
    // this guards API/script callers.
    const _ct = Number(req.body.chargeTerm);
    if (Number.isFinite(_ct)) {
      req.body.chargeTerm = Math.floor(_ct / 10000) * 10000 + 100;
    }
  }

  // Optimistic lock — same pattern as updateExpense. When client passes
  // building's __v, atomically claim it before the read+write cycle.
  // Two concurrent PATCHes lose the race deterministically (one 200,
  // one 409) instead of silently last-writer-winning.
  const requestedRepairVersion =
    req.body.__v !== undefined ? Number(req.body.__v) : NaN;
  if (Number.isFinite(requestedRepairVersion)) {
    const claimed = await Collections.Building.findOneAndUpdate(
      { _id: id, realmId: realm!._id, __v: requestedRepairVersion },
      { $inc: { __v: 1 } }
    );
    if (!claimed) {
      const stillExists = await Collections.Building.exists({
        _id: id,
        realmId: realm!._id
      });
      if (!stillExists) {
        throw new ServiceError('Building does not exist', 404);
      }
      throw new ServiceError(
        'Building was modified concurrently. Please retry.',
        409
      );
    }
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

  // Past-paid frozen-term guard for the MERGED state (existing fields +
  // PATCH overrides). Bypassable bug class: user creates the repair with
  // chargeTerm=current then PATCHes chargeTerm to a past month with paid
  // tenant rents — the new monthlyCharge would be silently no-op'd on
  // already-frozen bills. Same scoping fix as addRepair (this building's
  // tenants only).
  await _assertChargeTermNotFrozen(
    String(realm!._id),
    ((building as any).units || [])
      .filter((u: any) => u.propertyId)
      .map((u: any) => String(u.propertyId)),
    {
      chargeTerm: req.body.chargeTerm ?? repair.chargeTerm,
      chargeableTo: req.body.chargeableTo ?? repair.chargeableTo,
      actualCost: req.body.actualCost ?? repair.actualCost,
      estimatedCost: req.body.estimatedCost ?? repair.estimatedCost
    }
  );

  // Never write the client-echoed __v back into the subdoc — it's the
  // optimistic-lock token, not a field on the repair.
  const { __v: _ignoredRepairV, ...repairPatchBody } = req.body;
  void _ignoredRepairV;
  repair.set(repairPatchBody);
  (building as any).updatedDate = new Date();
  // Single-save: _distributeRepairCharge mutates + saves the building itself.
  // Removing the prior separate save eliminates the same race as addRepair
  // (stranded repair with zero billing on 409 between two saves).
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
