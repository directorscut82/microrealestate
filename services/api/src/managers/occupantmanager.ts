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
  validateFiniteNumber,
  validateStringField,
  validateArrayMaxLength
} from '../validators.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;
type AnyRecord = Record<string, any>;

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 12);

function _stringToDate(dateString?: string): Date | undefined {
  if (!dateString) return undefined;
  // Strict parse — without this, `Invalid Date` flows down through
  // _formatTenant into Mongoose, where the schema cast errors as a generic
  // 500. Surface a clean 422 to the client instead.
  const m = moment.utc(dateString, 'DD/MM/YYYY', true);
  if (!m.isValid()) {
    throw new ServiceError(`Invalid date: ${dateString}`, 422);
  }
  return m.toDate();
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
  properties: AnyRecord[],
  inFlightTenant?: { _id?: string; properties: AnyRecord[] }
): Promise<CollectionTypes.Building[]> {
  const propertyIds = properties
    .map((p) => p.propertyId)
    .filter(Boolean);

  if (propertyIds.length === 0) return [];

  const buildings = await Collections.Building.find({
    realmId,
    'units.propertyId': { $in: propertyIds }
  }).lean();

  // Pass the in-flight tenant so add()/update() (where the tenant is not yet
  // persisted, or persisted with stale property assignments) sees the
  // current property list rather than what's already in the DB. Without
  // this, the FIRST tenant created in a building falls into the per-unit
  // fallback (zero groups), and a multi-unit tenant on a fresh building
  // gets double-billed for "equal" allocation.
  await _attachTenantGroupsToBuildings(
    realmId,
    buildings as any[],
    inFlightTenant
  );

  return buildings as CollectionTypes.Building[];
}

// Wave-17 B1: attach `_tenantGroups` to every building so per-tenant
// allocation methods ("equal") can divide by the number of UNIQUE tenants
// occupying the building rather than by the number of managed units.
//
// Each entry in _tenantGroups is the sorted list of propertyIds owned by
// ONE tenant within that building. A tenant occupying parking + storage
// in the same building appears as a single group of two propertyIds and
// is counted once in the denominator.
//
// Without this metadata, "equal" allocation double-bills any tenant that
// holds more than one unit (the allocator runs once per property and
// emits a line for each), which silently inflates the koinochrista their
// rent statement carries.
export async function _attachTenantGroupsToBuildings(
  realmId: string,
  buildings: any[],
  inFlightTenant?: { _id?: string; properties: AnyRecord[] }
): Promise<void> {
  if (!buildings.length) return;

  const allUnitPropIds = Array.from(
    new Set(
      buildings
        .flatMap((b) => (b.units || []) as AnyRecord[])
        .map((u) => u.propertyId)
        .filter(Boolean)
        .map((id) => String(id))
    )
  );
  if (!allUnitPropIds.length) {
    buildings.forEach((b) => (b._tenantGroups = []));
    return;
  }

  // Find every tenant in this realm that occupies at least one of these
  // propertyIds. Project tenant- and property-level date fields so the
  // allocation tasks (1_base) can filter to tenants whose lease window
  // actually covers the rent term being computed (Wave-18 B4 fix).
  let tenants: any[] = await Collections.Tenant.find(
    {
      realmId,
      'properties.propertyId': { $in: allUnitPropIds }
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

  // Splice in the in-flight tenant so the equal-allocation grouping reflects
  // the create/update we're currently processing — not the stale persisted
  // state. Without this, a tenant being created sees its OWN units left out
  // of every group and ends up with no buildingCharges line at all (carrier
  // logic returns 0 because no group contains the queried propertyId).
  if (inFlightTenant && Array.isArray(inFlightTenant.properties)) {
    const inFlightId = inFlightTenant._id ? String(inFlightTenant._id) : null;
    if (inFlightId) {
      tenants = tenants.filter((t) => String(t._id) !== inFlightId);
    }
    tenants.push({
      _id: inFlightId || '__inflight__',
      beginDate: (inFlightTenant as AnyRecord).beginDate,
      endDate: (inFlightTenant as AnyRecord).endDate,
      terminationDate: (inFlightTenant as AnyRecord).terminationDate,
      properties: inFlightTenant.properties
    });
  }

  for (const building of buildings) {
    const buildingPropIds = new Set(
      ((building.units || []) as AnyRecord[])
        .map((u) => u.propertyId)
        .filter(Boolean)
        .map((id: string) => String(id))
    );
    // Wave-18 B4: each group now carries the tenant's lease + per-property
    // windows so 1_base can drop tenants whose lease doesn't cover the
    // rent term currently being computed. Without this, equal-allocation
    // splits across the LIFETIME tenant universe of the building (e.g.
    // four ever-tenants), even when only two were active in the queried
    // month — silently shrinking each active tenant's share.
    const groups: AnyRecord[] = [];
    for (const t of tenants) {
      const owned = ((t.properties || []) as AnyRecord[])
        .filter((p) => p.propertyId && buildingPropIds.has(String(p.propertyId)))
        .map((p) => ({
          propertyId: String(p.propertyId),
          entryDate: p.entryDate || null,
          exitDate: p.exitDate || null
        }));
      if (owned.length === 0) continue;
      owned.sort((a, b) => a.propertyId.localeCompare(b.propertyId));
      groups.push({
        propertyIds: owned.map((o) => o.propertyId),
        properties: owned,
        beginDate: t.beginDate || null,
        endDate: t.endDate || null,
        terminationDate: t.terminationDate || null
      });
    }
    building._tenantGroups = groups;
  }
}

// Wave-20 F1: building-wide sibling recompute.
//
// Equal allocation expenses divide a fixed pool by the number of UNIQUE
// active tenants in the building. The denominator changes whenever any
// tenant lifecycle event (add/update/remove/terminate) changes the cohort,
// so every SIBLING tenant in the same building must be recomputed — not
// only the tenant being mutated. Without this, the FIRST tenant created
// keeps its old €120 share even after three more tenants join (they should
// all see €30). Same staleness on terminationDate edits and removes.
//
// Excluding the just-mutated tenant prevents redundant work and avoids
// fighting the upstream computation (which already wrote the correct
// rents for that tenant). The freeze logic in contract.ts protects paid
// historical rents from being repriced.
async function _recomputeSiblingTenantsInBuildings(
  realmId: string,
  propertyIds: string[],
  excludeTenantId?: string
): Promise<void> {
  if (!propertyIds.length) return;

  // Find all buildings that contain ANY of the affected propertyIds.
  const buildings: any[] = await Collections.Building.find({
    realmId,
    'units.propertyId': { $in: propertyIds }
  }).lean();
  if (!buildings.length) return;

  // Collect every propertyId across all touched buildings — these are the
  // siblings whose tenants need recomputing.
  const siblingPropIds = new Set<string>();
  for (const b of buildings) {
    for (const u of (b.units || []) as AnyRecord[]) {
      if (u.propertyId) siblingPropIds.add(String(u.propertyId));
    }
  }
  if (!siblingPropIds.size) return;

  const tenantFilter: AnyRecord = {
    realmId,
    'properties.propertyId': { $in: Array.from(siblingPropIds) }
  };
  if (excludeTenantId) {
    tenantFilter._id = { $ne: new Collections.ObjectId(excludeTenantId) };
  }
  const siblings: AnyRecord[] = await Collections.Tenant.find(tenantFilter).lean();
  if (!siblings.length) return;

  // Wave-26 round-3u: see buildingmanager._saveRecomputedRentsWithRetry.
  // Sibling-tenant recompute used to do a blind updateOne, which races with
  // concurrent payment PATCHes (rentmanager._updateByTerm) and overwrote
  // the just-saved payment-derived state. Optimistic-concurrency retry
  // closes the race; re-reading the tenant on each attempt ensures the
  // recompute is based on the latest rent state including any racing
  // payment write that won this round.
  // Wave-26 round-3v: 5→8 with exponential backoff. See buildingmanager
  // for the rationale — short linear backoff exhausted before slow racing
  // writes committed, leaving total.grandTotal permanently inconsistent.
  const SIBLING_MAX_ATTEMPTS = 8;
  const siblingBackoffMs = (attempt: number) =>
    Math.min(50 * Math.pow(2, attempt - 1), 800);
  for (const tenantInitial of siblings) {
    const initialId = String((tenantInitial as AnyRecord)._id);
    let done = false;
    for (let attempt = 1; attempt <= SIBLING_MAX_ATTEMPTS; attempt++) {
      const fresh =
        attempt === 1
          ? tenantInitial
          : ((await Collections.Tenant.findOne({
              _id: initialId,
              realmId
            }).lean()) as AnyRecord | null);
      if (!fresh) {
        done = true;
        break;
      }
      const tenantObj: AnyRecord = fresh;
      if (!tenantObj.beginDate || !tenantObj.endDate) {
        done = true;
        break;
      }
      if (!tenantObj.properties?.length) {
        done = true;
        break;
      }
      const tenantPropIds = (tenantObj.properties as AnyRecord[])
        .map((p) => p.propertyId)
        .filter(Boolean);
      if (!tenantPropIds.length) {
        done = true;
        break;
      }

      const props: any[] = await Collections.Property.find({
        realmId,
        _id: { $in: tenantPropIds }
      }).lean();
      const propMap = props.reduce((acc: AnyRecord, p: any) => {
        acc[String(p._id)] = p;
        return acc;
      }, {});
      (tenantObj.properties as AnyRecord[]).forEach((p) => {
        p.property = propMap[String(p.propertyId)] || p.property;
      });

      const tenantBuildings: any[] = await Collections.Building.find({
        realmId,
        'units.propertyId': { $in: tenantPropIds }
      }).lean();
      await _attachTenantGroupsToBuildings(realmId, tenantBuildings);

      try {
        const termFrequency = tenantObj.frequency || 'months';
        const contractIn = {
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
          buildings: tenantBuildings,
          vatRate: tenantObj.vatRatio,
          discount: tenantObj.discount,
          rents: tenantObj.rents || []
        };
        const updated = Contract.update(contractIn as any, {
          begin: tenantObj.beginDate,
          end: tenantObj.endDate,
          termination: tenantObj.terminationDate,
          properties: tenantObj.properties,
          frequency: termFrequency
        });
        // Wave-26 round-3v: realmId added to the filter and the existence
        // re-read so a stale tenantId from another realm cannot be touched
        // by this realm's sibling-recompute.
        const result = await Collections.Tenant.findOneAndUpdate(
          { _id: tenantObj._id, realmId, __v: Number(tenantObj.__v) || 0 },
          { $set: { rents: updated.rents }, $inc: { __v: 1 } },
          { new: true }
        ).lean();
        if (result) {
          done = true;
          break;
        }
        const stillExists = await Collections.Tenant.findOne(
          { _id: tenantObj._id, realmId },
          { _id: 1 }
        ).lean();
        if (!stillExists) {
          done = true;
          break;
        }
        await new Promise((r) => setTimeout(r, siblingBackoffMs(attempt)));
      } catch (error) {
        logger.error(
          `sibling recompute failed for tenant ${tenantObj._id}: ${error}`
        );
        done = true;
        break;
      }
    }
    if (!done) {
      logger.error(
        'sibling recompute failed for tenant after exhausting version-conflict retries',
        {
          tenantId: initialId,
          realmId,
          finalAttempt: SIBLING_MAX_ATTEMPTS
        }
      );
    }
  }
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

// Wave-20 F7: validate per-property date windows. Without this guard, a
// payload like {entryDate:01/12, exitDate:01/01} silently collapses every
// rent term to €0 because the contract loop computes negative spans.
// Wave-20 F8: also reject duplicate propertyIds — the same propertyId
// appearing twice doubles the billing and corrupts the rent ledger.
function _validatePropertyWindows(
  tenant: AnyRecord
): void {
  const props = tenant.properties as AnyRecord[] | undefined;
  if (!Array.isArray(props) || props.length === 0) return;

  // Wave-20 F8: dedupe propertyIds.
  const seen = new Set<string>();
  for (let i = 0; i < props.length; i++) {
    const pid = props[i]?.propertyId ? String(props[i].propertyId) : '';
    if (!pid) continue;
    if (seen.has(pid)) {
      throw new ServiceError(
        `duplicate propertyId in properties array: ${pid}`,
        422
      );
    }
    seen.add(pid);
  }

  const tenantBegin = tenant.beginDate ? moment.utc(tenant.beginDate) : null;
  const tenantEnd = tenant.endDate ? moment.utc(tenant.endDate) : null;

  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    const entry = p?.entryDate ? moment.utc(p.entryDate) : null;
    const exit = p?.exitDate ? moment.utc(p.exitDate) : null;

    if (entry && exit && entry.isAfter(exit)) {
      throw new ServiceError(
        `properties[${i}].entryDate must be on or before exitDate`,
        422
      );
    }
    if (tenantBegin && entry && entry.isBefore(tenantBegin)) {
      throw new ServiceError(
        `properties[${i}].entryDate cannot be before tenant beginDate`,
        422
      );
    }
    if (tenantEnd && exit && exit.isAfter(tenantEnd)) {
      throw new ServiceError(
        `properties[${i}].exitDate cannot be after tenant endDate`,
        422
      );
    }
  }
}

function _propertiesHaveRentData(properties?: AnyRecord[]): boolean {
  return (
    !!properties?.length &&
    properties.every(
      ({ rent, entryDate, exitDate }: AnyRecord) => rent && entryDate && exitDate
    )
  );
}

// Wave-24 A1+A5: shared body-shape validators applied by add() and update().
// Without a single helper, drift between POST and PATCH was the source of A1
// (PATCH had guaranty validators but POST didn't) and A5 (negative
// properties[].rent slipping through). Centralizing makes future drift
// impossible.
function _validateOccupantPayload(body: AnyRecord): void {
  // Wave-24 A1: deposit field validators on add(). PATCH already had these
  // (wave-21 C28-B1/B2); POST silently persisted negatives.
  if (body.guaranty !== undefined) {
    validateFiniteNumber(body.guaranty, 'guaranty', {
      min: 0,
      max: 10000000
    });
  }
  if (body.guarantyPayback !== undefined) {
    validateFiniteNumber(body.guarantyPayback, 'guarantyPayback', {
      min: 0,
      max: 10000000
    });
  }
  // If both are present, the per-property guard mirroring update() catches
  // payback > guaranty before save. Skip when only one is present (the other
  // is loaded later for the effective comparison in update()).
  if (
    body.guaranty !== undefined &&
    body.guarantyPayback !== undefined &&
    Number.isFinite(Number(body.guaranty)) &&
    Number.isFinite(Number(body.guarantyPayback)) &&
    Number(body.guarantyPayback) > Number(body.guaranty)
  ) {
    throw new ServiceError(
      'guarantyPayback cannot exceed guaranty',
      422
    );
  }

  // Wave-24 A5: negative properties[].rent silently produced negative
  // grandTotal entries for the term. Validate each property.rent here.
  if (Array.isArray(body.properties)) {
    body.properties.forEach((p: AnyRecord, i: number) => {
      if (p?.rent !== undefined && p.rent !== null && p.rent !== '') {
        validateFiniteNumber(p.rent, `properties[${i}].rent`, {
          min: 0,
          max: 10000000
        });
      }
    });
  }
}

// Cross-tenant double-occupancy guard. For every propertyId in the incoming
// tenant's properties[], reject if another active tenant in the same realm
// occupies that SAME propertyId during an overlapping per-property date
// window. Compares PER-PROPERTY entryDate/exitDate (with tenant-level
// beginDate/endDate as fallback) instead of tenant-level windows — so a
// mid-year handover (T_OLD vacates apt2 30/06, T_NEW takes apt2 from 01/08)
// is correctly accepted even when both tenants' tenant-level windows still
// span the full year. The terminationDate further clamps the upper bound.
//
// Excludes the current tenant's own _id (so editing your own tenant doesn't
// fail) and tenants whose effective per-property window doesn't actually
// overlap the new assignment.
async function _assertNoDoubleOccupancy(
  realmId: string,
  incoming: AnyRecord,
  excludeTenantId?: string
): Promise<void> {
  if (!Array.isArray(incoming.properties) || !incoming.properties.length) return;

  const incomingBegin = incoming.beginDate
    ? moment.utc(incoming.beginDate)
    : null;
  const incomingTermination = incoming.terminationDate
    ? moment.utc(incoming.terminationDate)
    : null;
  const incomingTenantEnd = incoming.endDate
    ? moment.utc(incoming.endDate)
    : null;
  if (!incomingBegin || (!incomingTenantEnd && !incomingTermination)) return;

  // Build the per-property effective window for each propertyId in payload:
  //   from = max(tenant.beginDate, property.entryDate)
  //   to   = min(tenant.endDate, property.exitDate, terminationDate)
  type Window = { propertyId: string; from: moment.Moment; to: moment.Moment };
  const incomingWindows: Window[] = [];
  for (const p of incoming.properties as AnyRecord[]) {
    if (!p.propertyId) continue;
    const entry = p.entryDate ? moment.utc(p.entryDate) : null;
    const exit = p.exitDate ? moment.utc(p.exitDate) : null;
    // from = max(tenantBegin, propertyEntry || tenantBegin)
    const from = entry && entry.isAfter(incomingBegin) ? entry : incomingBegin;
    // candidate upper bounds: tenantEnd, propertyExit, termination
    const candidates: moment.Moment[] = [];
    if (incomingTenantEnd) candidates.push(incomingTenantEnd);
    if (exit) candidates.push(exit);
    if (incomingTermination) candidates.push(incomingTermination);
    if (!candidates.length) continue;
    let to = candidates[0];
    for (const c of candidates) if (c.isBefore(to)) to = c;
    if (!from.isSameOrBefore(to)) continue; // empty window
    incomingWindows.push({ propertyId: String(p.propertyId), from, to });
  }
  if (!incomingWindows.length) return;

  const propertyIds = incomingWindows.map((w) => w.propertyId);

  const filter: AnyRecord = {
    realmId,
    'properties.propertyId': { $in: propertyIds }
  };
  if (excludeTenantId) {
    filter._id = { $ne: new Collections.ObjectId(excludeTenantId) };
  }

  const others: AnyRecord[] = await Collections.Tenant.find(filter).lean();
  for (const other of others) {
    const otherBegin = other.beginDate ? moment.utc(other.beginDate) : null;
    const otherTermination = other.terminationDate
      ? moment.utc(other.terminationDate)
      : null;
    const otherTenantEnd = other.endDate ? moment.utc(other.endDate) : null;
    if (!otherBegin || (!otherTenantEnd && !otherTermination)) continue;

    for (const otherProp of (other.properties || []) as AnyRecord[]) {
      const otherPropId = String(otherProp.propertyId || '');
      if (!otherPropId) continue;
      const incomingW = incomingWindows.find((w) => w.propertyId === otherPropId);
      if (!incomingW) continue;

      const oEntry = otherProp.entryDate ? moment.utc(otherProp.entryDate) : null;
      const oExit = otherProp.exitDate ? moment.utc(otherProp.exitDate) : null;

      const oFrom = oEntry && oEntry.isAfter(otherBegin) ? oEntry : otherBegin;
      const oCandidates: moment.Moment[] = [];
      if (otherTenantEnd) oCandidates.push(otherTenantEnd);
      if (oExit) oCandidates.push(oExit);
      if (otherTermination) oCandidates.push(otherTermination);
      if (!oCandidates.length) continue;
      let oTo = oCandidates[0];
      for (const c of oCandidates) if (c.isBefore(oTo)) oTo = c;
      if (!oFrom.isSameOrBefore(oTo)) continue;

      // Per-property window overlap.
      const overlaps =
        oFrom.isSameOrBefore(incomingW.to) && oTo.isSameOrAfter(incomingW.from);
      if (overlaps) {
        throw new ServiceError(
          `Property is already assigned to another tenant during this period: ${other.name}`,
          422
        );
      }
    }
  }
}

export async function add(req: Req, res: Res) {
  const realm = req.realm;

  // Wave-21 C30-B5: strip server-owned identity fields from the payload.
  // _id is also destructured later via _formatTenant, but stripping here
  // prevents accidental retention of __v/realmId from a round-tripped GET.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id: _ignoredId, __v: _ignoredV, realmId: _ignoredRealmId, ...rest } = (req.body || {}) as any;
  req.body = rest;

  // Strict type guard for `name` — hits .trim() later. Mongoose string casts
  // would otherwise turn a non-string (e.g. {$ne: ''} NoSQL injection probe)
  // into a generic 500.
  if (req.body?.name !== undefined && typeof req.body.name !== 'string') {
    throw new ServiceError('name must be a string', 422);
  }

  // Optional fields that the frontend round-trips with `null` when the tenant
  // is an individual (non-company). Allow string OR null OR undefined; reject
  // anything else (numbers, objects, mongo operators) before _formatTenant.
  ['company', 'legalForm', 'siret', 'manager'].forEach((field) => {
    const v = req.body?.[field];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new ServiceError(
        `${field} must be a string, null, or omitted`,
        422
      );
    }
  });

  // Reject empty/whitespace propertyId entries early. _buildPropertyMap
  // would otherwise return undefined for `""`, _formatTenant happily passes
  // it through, and the rent computation crashes deep in Contract.create
  // with an opaque message — or worse, persists a tenant with an unusable
  // properties[] entry.
  if (Array.isArray(req.body.properties)) {
    req.body.properties.forEach((p: AnyRecord, i: number) => {
      if (
        p?.propertyId !== undefined &&
        p?.propertyId !== null &&
        (typeof p.propertyId !== 'string' || !p.propertyId.trim())
      ) {
        throw new ServiceError(
          `properties[${i}].propertyId must be a valid id or omitted`,
          422
        );
      }
    });
  }

  // Wave-24 A2: empty-string leaseId from the frontend was being passed
  // through to Mongoose, which then cast-failed on every subsequent GET that
  // populated `leaseId`. Normalize to undefined so the doc has no leaseId.
  if (req.body.leaseId === '' || req.body.leaseId === null) {
    delete req.body.leaseId;
  }

  // Wave-24 A1+A5: shared body-shape validators (deposit + per-property rent).
  _validateOccupantPayload(req.body);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, ...occupant } = _formatTenant(req.body);

  // Validate + normalize name (trim, length cap, non-empty)
  const trimmedName = validateStringField(occupant.name, 'name', {
    min: 1,
    max: 200,
    required: true
  });
  occupant.name = trimmedName;

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
    // A tenant attached to a lease but with no properties materializes the
    // configured number of zero-rent terms (e.g. 12 monthly entries with
    // grandTotal=0), polluting the rent ledger and dashboards. Refuse
    // upfront — the UI should pick at least one property before save.
    if (!occupant.properties || occupant.properties.length === 0) {
      throw new ServiceError(
        'Tenant with a lease must have at least one property',
        422
      );
    }
  }
  validateFiniteNumber(occupant.vatRatio, 'vatRatio', { min: 0, max: 1 });
  validateFiniteNumber(occupant.discount, 'discount', { min: 0, max: 10000000 });
  // Use isSameOrBefore so equal begin/end dates surface here as 422 rather
  // than later inside Contract.create as a 409 (the contract layer treats
  // equal dates as a duration error).
  if (
    occupant.beginDate &&
    occupant.endDate &&
    moment(occupant.endDate).isSameOrBefore(moment(occupant.beginDate))
  ) {
    throw new ServiceError('End date must be after begin date', 422);
  }

  // Wave-20 F7+F8: per-property date windows + duplicate propertyId guard.
  _validatePropertyWindows(occupant);

  // Cross-tenant overlap guard: block double-booking the same property in
  // overlapping date windows within the same realm.
  await _assertNoDoubleOccupancy(realm!._id, occupant);

  const propertyMap = await _buildPropertyMap(realm);

  // Cross-realm guard: every propertyId in the body must resolve to a
  // property in THIS realm. Without this, the .price access on the next
  // line throws an opaque TypeError 500 when a foreign propertyId is
  // passed; turn that into a clear 422 instead.
  occupant.properties?.forEach((p: AnyRecord, i: number) => {
    if (p?.propertyId && !propertyMap[String(p.propertyId)]) {
      throw new ServiceError(
        `properties[${i}].propertyId not found in this organization`,
        422
      );
    }
  });

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

  // Reject discounts that exceed the rentable amount. Without this, a 600€
  // discount on a 500€ rent slips through, produces a negative preTaxAmount
  // (-100€), and task 4_vats then computes a negative VAT (e.g. -13€) and a
  // negative grandTotal (-113€) — values that propagate into accounting,
  // dashboard totals and CSV exports.
  if (
    Number(occupant.discount) > 0 &&
    Array.isArray(occupant.properties) &&
    occupant.properties.length
  ) {
    const totalRent = occupant.properties.reduce(
      (sum: number, p: AnyRecord) =>
        sum + (Number(p.rent) || Number(p.property?.price) || 0),
      0
    );
    if (Number(occupant.discount) > totalRent) {
      throw new ServiceError(
        `Discount (${occupant.discount}) cannot exceed total rent (${totalRent})`,
        422
      );
    }
  }

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
        occupant.properties,
        // Wave-17 B1: include the in-flight tenant so equal-allocation
        // tenant groups already reflect this NEW tenant on first save.
        { properties: occupant.properties }
      );

      // Schema default ('months') applies at persistence time. Fall back
      // here too because Contract.create requires frequency for the rent
      // term math regardless of what Mongoose will set on save.
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
    // Contract.create throws on validation issues (bad frequency, empty
    // properties, termination out of range, end<=begin). These are
    // unprocessable entity (422), not concurrency conflicts (409).
    throw new ServiceError(String(error), 422);
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

  // Wave-20 F1: cohort changed — sibling tenants in the same building(s)
  // need re-allocation (equal-method denominator depends on cohort size).
  if (linkedPropIds.length) {
    await _recomputeSiblingTenantsInBuildings(
      realm!._id,
      linkedPropIds,
      String(newOccupant._id)
    );
  }

  const occupants = await _fetchTenants(req.realm!._id, newOccupant._id);
  res.json(FD.toOccupantData(occupants.length ? occupants[0] : null as any));
}

export async function update(req: Req, res: Res) {
  const realm = req.realm;
  const occupantId = req.params.id;
  validateObjectId(occupantId, 'tenant id');

  // Wave-24 A2: empty-string leaseId on edit poisons populate() in tenantmanager.
  if (req.body.leaseId === '' || req.body.leaseId === null) {
    delete req.body.leaseId;
  }

  // Wave-24 A5: per-property rent validation (mirror add()).
  _validateOccupantPayload(req.body);

  // Strict type guard for `name` — hits .trim() later. Mongoose string casts
  // would otherwise turn a non-string (e.g. {$ne: ''} NoSQL injection probe)
  // into a generic 500.
  if (req.body?.name !== undefined && typeof req.body.name !== 'string') {
    throw new ServiceError('name must be a string', 422);
  }

  // Optional fields that the frontend round-trips with `null` when the tenant
  // is an individual (non-company). Allow string OR null OR undefined; reject
  // anything else (numbers, objects, mongo operators) before _formatTenant.
  ['company', 'legalForm', 'siret', 'manager'].forEach((field) => {
    const v = req.body?.[field];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new ServiceError(
        `${field} must be a string, null, or omitted`,
        422
      );
    }
  });

  const newOccupant = _formatTenant(req.body);

  // _formatTenant sets company/legalForm/siret/capital to null for non-company
  // tenants. When the frontend round-trips that document back on edit, the
  // null values reach validateStringField (which only accepts string) and
  // 422 on the second save. Normalize null → undefined so the validators
  // simply skip these optional fields.
  ['company', 'legalForm', 'siret', 'manager'].forEach((field) => {
    if (newOccupant[field] === null) newOccupant[field] = undefined;
  });

  if (!newOccupant.properties) {
    newOccupant.properties = [];
  }

  // Validate + normalize name (trim, length cap, non-empty) — mirror add().
  // After _formatTenant, .name has already been derived from manager/company
  // when applicable, so we apply the same field-level validation here.
  newOccupant.name = validateStringField(newOccupant.name, 'name', {
    min: 1,
    max: 200,
    required: true
  });
  if (newOccupant.manager !== undefined) {
    const trimmedManager = validateStringField(newOccupant.manager, 'manager', {
      min: 1,
      max: 200
    });
    if (trimmedManager !== undefined) newOccupant.manager = trimmedManager;
  }
  if (newOccupant.company !== undefined) {
    const trimmedCompany = validateStringField(newOccupant.company, 'company', {
      min: 1,
      max: 200
    });
    if (trimmedCompany !== undefined) newOccupant.company = trimmedCompany;
  }

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
  // Wave-21 C28-B1/B2: deposit field validators. Without these, negative
  // values for guaranty / guarantyPayback are silently persisted and break
  // accounting aggregations downstream.
  validateFiniteNumber(newOccupant.guaranty, 'guaranty', {
    min: 0,
    max: 10000000
  });
  validateFiniteNumber(newOccupant.guarantyPayback, 'guarantyPayback', {
    min: 0,
    max: 10000000
  });
  // Use isSameOrBefore so equal begin/end dates surface here as 422 rather
  // than later inside Contract.update/create as a 409.
  if (
    newOccupant.beginDate &&
    newOccupant.endDate &&
    moment(newOccupant.endDate).isSameOrBefore(moment(newOccupant.beginDate))
  ) {
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

  // Wave-21 C28-B3: guarantyPayback may not exceed guaranty. The "effective"
  // guaranty is the new value if supplied else the persisted one.
  const effGuaranty =
    newOccupant.guaranty != null
      ? Number(newOccupant.guaranty)
      : Number(originalOccupant.guaranty || 0);
  const effPayback =
    newOccupant.guarantyPayback != null
      ? Number(newOccupant.guarantyPayback)
      : Number(originalOccupant.guarantyPayback || 0);
  if (
    Number.isFinite(effGuaranty) &&
    Number.isFinite(effPayback) &&
    effPayback > effGuaranty
  ) {
    throw new ServiceError(
      `guarantyPayback (${effPayback}) cannot exceed guaranty (${effGuaranty})`,
      422
    );
  }

  // Wave-21 C28-B4: guaranty itself is locked once a terminationDate is on
  // file. The post-termination workflow expects guaranty to be the agreed
  // deposit amount; refunding (guarantyPayback) is the only thing that
  // changes after termination.
  if (
    newOccupant.guaranty !== undefined &&
    originalOccupant.terminationDate &&
    Number(newOccupant.guaranty) !== Number(originalOccupant.guaranty || 0)
  ) {
    throw new ServiceError(
      'guaranty cannot be changed after the tenant lease has been terminated',
      422
    );
  }
  // E15: __v is REQUIRED on the PATCH body. Falling back to the freshly
  // re-read __v silently disabled optimistic locking the moment a client
  // forgot to round-trip the field — two concurrent editors would each
  // miss the conflict signal because the server kept "winning" each
  // race against itself. A missing __v now surfaces as 422 so the
  // client gets a deterministic error and the user is forced to refresh.
  const requestedVersion = Number(req.body.__v);
  if (!Number.isFinite(requestedVersion)) {
    throw new ServiceError(
      'tenant __v is required on PATCH (optimistic lock)',
      422
    );
  }
  const documentVersion = requestedVersion;

  if (originalOccupant.documents) {
    newOccupant.documents = originalOccupant.documents;
  }

  // Wave-20 F7+F8: per-property date windows + duplicate propertyId guard.
  _validatePropertyWindows(newOccupant);

  // Wave-21 C26-B5: refuse endDate shrinks that would orphan PAID rents.
  // A landlord may legitimately shrink the lease (lease was actually
  // shorter than registered), so we don't block unpaid orphans — but
  // discarding a rent that was already paid corrupts the audit trail.
  if (
    newOccupant.endDate &&
    originalOccupantDoc.endDate &&
    moment.utc(newOccupant.endDate).isBefore(moment.utc(originalOccupantDoc.endDate))
  ) {
    const newEndTerm = Number(
      moment.utc(newOccupant.endDate).format('YYYYMMDDHH')
    );
    const orphanPaid = ((originalOccupantDoc.rents || []) as AnyRecord[]).filter(
      (rent: AnyRecord) => {
        if (!Number.isFinite(Number(rent.term))) return false;
        if (Number(rent.term) <= newEndTerm) return false;
        const paidByPayments =
          rent.payments &&
          rent.payments.some(
            (payment: AnyRecord) => Number(payment.amount) > 0
          );
        const paidBySettlement = (rent.discounts || []).some(
          (discount: AnyRecord) => discount.origin === 'settlement'
        );
        return !!(paidByPayments || paidBySettlement);
      }
    );
    if (orphanPaid.length) {
      throw new ServiceError(
        `Cannot shrink endDate: ${orphanPaid.length} paid rent term(s) would be orphaned. Reverse those payments first.`,
        422
      );
    }
  }

  // Cross-tenant overlap guard for edits — exclude this tenant's own _id so
  // extending dates doesn't conflict with itself.
  await _assertNoDoubleOccupancy(realm!._id, newOccupant, occupantId);

  const propertyMap = await _buildPropertyMap(realm);

  // Cross-realm guard. propertyMap is realm-scoped; if a propertyId in
  // the body does not resolve here it either belongs to a different
  // realm or does not exist. Persisting a foreign propertyId on this
  // tenant would leave a dangling reference (the rent pipeline would
  // silently drop the line, but the orphan stays in mongo and pollutes
  // future queries). Reject loudly instead.
  newOccupant.properties.forEach((rentedProperty: AnyRecord) => {
    if (!rentedProperty.propertyId) return;
    const inRealm = !!propertyMap[String(rentedProperty.propertyId)];
    const wasOriginallyAssigned = (originalOccupant.properties || []).some(
      ({ propertyId }: AnyRecord) =>
        String(propertyId) === String(rentedProperty.propertyId)
    );
    if (!inRealm && !wasOriginallyAssigned) {
      throw new ServiceError(
        `Property ${rentedProperty.propertyId} not found in this organization`,
        422
      );
    }
  });

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

  // Mirror the cap check from add(): a discount > total rent silently
  // produces negative preTaxAmount → negative VAT → negative grandTotal,
  // which then poisons every aggregator that consumes it.
  if (
    Number(newOccupant.discount) > 0 &&
    Array.isArray(newOccupant.properties) &&
    newOccupant.properties.length
  ) {
    const totalRent = newOccupant.properties.reduce(
      (sum: number, p: AnyRecord) =>
        sum + (Number(p.rent) || Number(p.property?.price) || 0),
      0
    );
    if (Number(newOccupant.discount) > totalRent) {
      throw new ServiceError(
        `Discount (${newOccupant.discount}) cannot exceed total rent (${totalRent})`,
        422
      );
    }
  }

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
        allPropertyIds.map((id: string) => ({ propertyId: id })),
        // Wave-17 B1: include the in-flight tenant (with its CURRENT
        // properties[]) so the grouping reflects this UPDATE, not the
        // persisted stale state.
        { _id: occupantId, properties: newOccupant.properties }
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
      // Contract.update throws on validation issues (e.g. termination out of
      // contract time frame, bad date ranges). These are 422, not 409.
      // 409 is reserved below for genuine optimistic-lock concurrency
      // conflicts (the __v mismatch).
      throw new ServiceError(String(e), 422);
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
        422
      );
    }

    // Refuse to wipe historical paid rents on the original document either —
    // _propertiesHaveRentData() returning false (e.g. user removed entryDate
    // on a property) would otherwise silently delete the rent ledger.
    const originalHasPaidRents = (originalOccupant.rents || []).some(
      (rent: AnyRecord) =>
        (rent.payments &&
          rent.payments.some(
            (payment: AnyRecord) => Number(payment.amount) > 0
          )) ||
        (rent.discounts || []).some(
          (discount: AnyRecord) => discount.origin === 'settlement'
        )
    );
    if (originalHasPaidRents) {
      throw new ServiceError(
        'cannot clear rents: tenant has recorded payments. Restore property rent/entry/exit dates before saving.',
        422
      );
    }

    newOccupant.rents = [];
  }

  // Strip identity / version fields from the payload — $set must not target
  // the same paths that the filter clause (_id, realmId) and $inc (__v) own,
  // otherwise MongoDB rejects the update with "Updating the path '__v' would
  // create a conflict at '__v'". The frontend POSTs the full tenant document
  // back on edit, including these fields.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, realmId: _realmId, ...occupantPatch } = newOccupant;
  const updated = await Collections.Tenant.findOneAndUpdate(
    {
      realmId: realm!._id,
      _id: occupantId,
      __v: documentVersion
    },
    { $set: occupantPatch, $inc: { __v: 1 } }
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

  // Wave-20 F1: any change in cohort membership (added/removed properties)
  // OR change to lease window (terminationDate, endDate) requires sibling
  // tenants in the affected building(s) to re-allocate equal-method
  // expenses for current/future terms.
  const allTouchedPropIds = Array.from(
    new Set([...oldPropIds, ...newPropIds])
  );
  if (allTouchedPropIds.length) {
    await _recomputeSiblingTenantsInBuildings(
      realm!._id,
      allTouchedPropIds,
      occupantId
    );
  }

  const newOccupants = await _fetchTenants(req.realm!._id, occupantId);
  res.json(FD.toOccupantData(newOccupants.length ? newOccupants[0] : null as any));
}

export async function remove(req: Req, res: Res) {
  const realm = req.realm;
  const occupantIds = req.params?.ids.split(',') ?? [];

  if (!occupantIds.length) {
    throw new ServiceError('tenant not found', 404);
  }

  // Wave-21 cycle-25-1 follow-up: cap bulk delete to 50 ids. Mirrors
  // leasemanager.remove. Without this, a runaway client (or buggy script)
  // can issue an unbounded $in query.
  validateArrayMaxLength(occupantIds, 50, 'tenant ids');

  // Validate each id before using $in — prevents NoSQL injection /
  // CastError 500s when the URL contains a malformed id.
  occupantIds.forEach((id: string) => validateObjectId(id, 'tenant id'));

  const occupants: any[] = await Collections.Tenant.find({
    realmId: realm!._id,
    _id: { $in: occupantIds }
  });

  if (!occupants.length) {
    throw new ServiceError('tenant not found', 404);
  }

  // Admin escape hatch: ?force=true ARCHIVES tenants with paid rents
  // instead of physically deleting them — preserves the financial audit
  // trail (rents[]) while removing them from active counters/lists.
  const force = req.query?.force === 'true';

  // Identify tenants with paid rent history. These are NEVER physically
  // deleted; with force=true they are archived (terminationDate set to
  // today or last rent term, archived=true). Without force, hard-block.
  const occupantsWithPaidRents = occupants.filter((occupant: AnyRecord) => {
    return (occupant.rents || []).some(
      (rent: AnyRecord) =>
        (rent.payments &&
          rent.payments.some(
            (payment: AnyRecord) => Number(payment.amount) > 0
          )) ||
        (rent.discounts || []).some(
          (discount: AnyRecord) => discount.origin === 'settlement'
        )
    );
  });

  if (!force && occupantsWithPaidRents.length) {
    throw new ServiceError(
      `impossible to remove ${occupantsWithPaidRents[0].name} some rents have been paid`,
      422
    );
  }

  // Wave-21 C30-B7: force-delete archives tenants with paid rents instead
  // of physically deleting them. The CSV/dashboard counters then drop them
  // (filter on archived) while the rents[] history stays intact.
  const idsToArchive = new Set<string>(
    occupantsWithPaidRents.map((o: any) => String(o._id))
  );
  if (force && idsToArchive.size) {
    logger.warn(
      `force-archive tenant(s) ${Array.from(idsToArchive).join(',')} (paid rents preserved)`
    );
    for (const o of occupantsWithPaidRents as any[]) {
      // Pick the most recent rent term as the termination date when no
      // explicit termination is on the document yet. Falls back to today.
      let terminationDate: Date = o.terminationDate || null;
      if (!terminationDate) {
        const terms = ((o.rents || []) as any[])
          .map((r: any) => Number(r.term))
          .filter((n: number) => Number.isFinite(n))
          .sort((a: number, b: number) => b - a);
        if (terms.length) {
          // YYYYMMDDHH → first day of that month UTC
          const t = String(terms[0]).padStart(10, '0');
          const yr = Number(t.slice(0, 4));
          const mo = Number(t.slice(4, 6));
          terminationDate = new Date(Date.UTC(yr, mo - 1, 1));
        } else {
          terminationDate = new Date();
        }
      }
      await Collections.Tenant.updateOne(
        { _id: o._id, realmId: realm!._id },
        { $set: { archived: true, terminationDate } }
      );
    }
  }

  // Note: active lease and unpaid balance are warned in the frontend,
  // not blocked here. Only paid rents are a hard block.

  // Mongo standalone (our local/dev deployment) does not support
  // transactions. Delete sequentially and let any per-step failure surface.
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
  // E16: track partial-failure across the remove pipeline. The previous
  // code logged documents-DELETE failures to the operator but returned
  // 200 to the client — the user thought the tenant was fully cleaned
  // up while related documents were still on disk / in S3. Collect
  // failures and surface them as a 500 with structured info at the end.
  const _failureInfo: Record<string, string> = {};
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
      _failureInfo.documents = String(errorMessage || error);
    }
  }

  // Sync building occupancy for removed tenant's properties
  const removedPropIds = occupants.flatMap((o: any) =>
    (o.properties || []).map((p: AnyRecord) => String(p.propertyId)).filter(Boolean)
  );
  if (removedPropIds.length) {
    await _syncOccupancyForProperties(realm!._id, removedPropIds, 'unlink');
  }

  // Wave-20 F1: deleting tenants shrinks the equal-allocation cohort —
  // sibling tenants in the same building(s) must recompute their share.
  // Run BEFORE the delete so the persistent state still reflects the
  // outgoing tenants when _attachTenantGroupsToBuildings reads, and
  // pass the deleted ids as exclusions.
  if (removedPropIds.length) {
    await _recomputeSiblingTenantsInBuildings(
      realm!._id,
      removedPropIds,
      undefined
    );
    // Note: `excludeTenantId` only takes a single id; with multiple
    // tenants being deleted we accept that the dying tenants may
    // briefly recompute before being removed. The subsequent
    // deleteMany is what removes them from the cohort permanently.
    // Run the recompute AGAIN after the delete so the cohort denominator
    // reflects the post-delete state.
  }

  // Wave-21 C30-B7: only physically delete tenants WITHOUT paid history.
  // Archived (paid-history) tenants are kept so the rents[] audit trail and
  // outgoing CSV reports stay correct.
  const idsToDelete = occupantIds.filter(
    (id: string) => !idsToArchive.has(String(id))
  );
  const tenantDeleteResult = idsToDelete.length
    ? await Collections.Tenant.deleteMany({
        realmId: realm!._id,
        _id: { $in: idsToDelete }
      })
    : { deletedCount: 0 };

  if (
    (tenantDeleteResult?.deletedCount ?? 0) === 0 &&
    idsToArchive.size === 0
  ) {
    throw new ServiceError(
      'No records deleted (none of the ids matched)',
      404
    );
  }

  // Wave-20 F1: post-delete sibling recompute now that the cohort has
  // truly shrunk. Equal-allocation buildings need this second pass so
  // the surviving tenants see the correct (smaller) denominator on
  // their NEXT current/future term.
  if (removedPropIds.length) {
    await _recomputeSiblingTenantsInBuildings(
      realm!._id,
      removedPropIds,
      undefined
    );
  }

  // E16: if any side-step (documents cascade) failed, surface a 500 so
  // the operator knows orphan resources may exist — but include the
  // counts of what DID land so the client can refresh accurately.
  if (Object.keys(_failureInfo).length > 0) {
    logger.error(
      `tenant remove partial failure: ${JSON.stringify(_failureInfo)}`
    );
    return res.status(500).json({
      status: 500,
      message:
        'Partial failure deleting tenant(s). Some related records may not have been cleaned up.',
      deleted: tenantDeleteResult.deletedCount ?? 0,
      archived: idsToArchive.size,
      requested: occupantIds.length,
      failures: _failureInfo
    });
  }

  // Partial-success path: report counts so the client can detect drift.
  // Wave-21 C30-B7: include archived count (force-archived tenants are not
  // "deleted" but the operation succeeded; surface them separately).
  const totalProcessed =
    (tenantDeleteResult.deletedCount ?? 0) + idsToArchive.size;
  if (totalProcessed < occupantIds.length || idsToArchive.size > 0) {
    return res.status(200).json({
      deleted: tenantDeleteResult.deletedCount ?? 0,
      archived: idsToArchive.size,
      requested: occupantIds.length
    });
  }

  res.sendStatus(200);
}

export async function all(req: Req, res: Res) {
  const includeArchived = req.query?.includeArchived === 'true';
  const { page, limit, skip, isPaginated } = Pagination.parsePagination(req as any);
  const countFilter: AnyRecord = { realmId: req.realm!._id };
  if (!includeArchived) {
    countFilter.$or = [{ archived: { $exists: false } }, { archived: false }];
  }

  if (!isPaginated) {
    // No pagination params: return ALL items (backward compatible)
    const tenants = await _fetchTenants(req.realm!._id);
    const filtered = includeArchived
      ? tenants
      : tenants.filter((t) => !t.archived);
    res.json(filtered.map((tenant) => FD.toOccupantData(tenant)));
  } else {
    // Explicit pagination: apply skip/limit
    const [tenants, total] = await Promise.all([
      Collections.Tenant.aggregate<AnyRecord>([
        { $match: countFilter },
        { $sort: { name: 1 } },
        { $skip: skip },
        { $limit: limit }
      ]),
      Collections.Tenant.countDocuments(countFilter)
    ]);

    const meta = Pagination.buildPaginationMeta(total, page, limit);
    Pagination.setPaginationHeaders(res as any, meta);

    // Fetch full data (with $lookup) only for the paginated subset
    const tenantIds = tenants.map((t) => String(t._id));
    const fullTenants = tenantIds.length
      ? await _fetchTenants(req.realm!._id, tenantIds)
      : [];
    const tenantMap = new Map(
      fullTenants.map((t) => [String(t._id), t])
    );
    const sorted = tenantIds
      .map((id) => tenantMap.get(id))
      .filter(Boolean) as AnyRecord[];
    res.json(sorted.map((tenant) => FD.toOccupantData(tenant)));
  }
}

export async function archive(req: Req, res: Res) {
  const tenantId = req.params.id;
  validateObjectId(tenantId, 'tenant id');
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
  validateObjectId(tenantId, 'tenant id');
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
  validateObjectId(occupantId, 'tenant id');
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
    // E2: keep both sides of the comparison in UTC. `currentDate` above is
    // moment.utc() and the persisted endDate/terminationDate are pure dates;
    // mixing in a local-zone moment caused day-boundary flicker around
    // midnight on Athens (UTC+2/+3) — a tenant whose endDate is "today"
    // could flip between countActive and countInactive depending on the
    // server's local-time offset.
    //
    // T2.1: also require a non-empty `properties` array and a valid end
    // date for active. Without these guards `moment.utc(undefined)`
    // resolves to "now", which made `isBefore(currentDate, 'day')` return
    // false — so every property-less tenant with no endDate (i.e. an
    // incomplete tenant record, the same setup-incomplete state T1.7's
    // amber warning surfaces) inflated countActive. Use the same
    // `terminationDate || endDate` pair the rest of the codebase reads.
    const endValue = occupant.terminationDate || occupant.endDate;
    const endMoment = endValue ? moment.utc(endValue) : null;
    const dateOk = !!endMoment && endMoment.isValid();
    const propertyOk = !!occupant.properties?.length;
    if (
      dateOk &&
      propertyOk &&
      !endMoment!.isBefore(currentDate, 'day')
    ) {
      acc.countActive++;
    } else {
      acc.countInactive++;
    }
    return acc;
  }, result);

  res.json(result);
}
