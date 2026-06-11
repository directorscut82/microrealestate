import * as FD from './frontdata.js';
import {
  Collections,
  logger,
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
import { computeBuildingChargeForProperty } from '../businesslogic/tasks/1_base.js';
import { _attachTenantGroupsToBuildings } from './occupantmanager.js';

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

// ---------------------------------------------------------------------------
// Per-property expense panel
// ---------------------------------------------------------------------------

const EXPENSE_CATEGORIES = [
  'heating',
  'water',
  'electricity',
  'insurance',
  'cleaning',
  'repairs',
  'other'
] as const;

type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

type CategoryTotals = Record<ExpenseCategory, number>;

interface ExpenseLine {
  // Panel category (heating | water | electricity | insurance | cleaning |
  // repairs | other) so the UI can render "<Category> (<description>)"
  // and the user sees both the bucket and the actual entry name.
  category: ExpenseCategory;
  // Free-form description from the underlying entry (charge.description,
  // expense.name, repair.title, etc.) — empty when no user-supplied text
  // exists. The UI is responsible for rendering a localised fallback
  // when this is empty (see PropertyExpensesCard, descriptionKey below).
  description: string;
  // i18n key for the localised fallback when description is empty:
  //   'monthly_charge'   — manual unit charge / typed building expense override
  //   'owner_repair'     — owner-side repair allocation with no title
  //   'owner_expense'    — owner-side variable allocation with no description
  //   'repair'           — repair without a title
  // The UI looks up `t(descriptionKey)` only when description === ''.
  descriptionKey?: string;
  amount: number;
  source: string;
}

function _zeroCategoryTotals(): CategoryTotals {
  return {
    heating: 0,
    water: 0,
    electricity: 0,
    insurance: 0,
    cleaning: 0,
    repairs: 0,
    other: 0
  };
}

// Map a building expense schema `type` to one of the 7 panel categories.
// The schema enum (services/common/src/collections/building.ts BuildingExpenseSchema.type)
// has 11 values: heating, elevator, cleaning, water_common, electricity_common,
// insurance, management_fee, garden, repairs_fund, pest_control, other.
// Every enum value MUST be mapped explicitly here — silent fall-through to
// 'other' would make the panel undercounting visible only when the user
// happens to add an elevator/garden/pest_control expense. The jest unit at
// services/api/src/__tests__/propertymanager.classifyExpense.test.js
// asserts every schema enum value resolves to a non-default category.
export function _classifyExpenseType(
  type: string | undefined | null
): ExpenseCategory {
  switch (type) {
    case 'heating':
      return 'heating';
    case 'water_common':
      return 'water';
    case 'electricity_common':
      return 'electricity';
    case 'insurance':
      return 'insurance';
    case 'cleaning':
    case 'garden':
    case 'pest_control':
      // garden + pest_control are common-area maintenance — group with cleaning
      // for the panel headline. Each still appears as a separate line in
      // currentMonth.lines so the user can disambiguate per row.
      return 'cleaning';
    case 'elevator':
    case 'repairs_fund':
    case 'repair':
      // elevator maintenance is mechanically-similar to repairs (irregular
      // upkeep on building infrastructure); roll into 'repairs' rather than
      // create a 4-row "elevator" category that doubles the panel size.
      return 'repairs';
    case 'management_fee':
    case 'other':
    case undefined:
    case null:
    case '':
      return 'other';
    default:
      // Unknown enum value — treat as 'other' but warn so future schema
      // additions are surfaced rather than silently miscategorised.
      logger.warn(
        `_classifyExpenseType: unmapped expense type "${type}" — defaulted to 'other'`
      );
      return 'other';
  }
}

// Parse YYYYMM and return a YYYYMMDDHH term (first day of month, hour 00)
function _parseYYYYMM(value: string, fieldName: string): number {
  const parsed = moment.utc(value, 'YYYYMM', true);
  if (!parsed.isValid()) {
    throw new ServiceError(
      `Invalid ${fieldName}: expected YYYYMM (e.g. 202604)`,
      422
    );
  }
  return Number(parsed.startOf('month').format('YYYYMMDDHH'));
}

// Walk a YYYYMM range inclusive, yielding YYYYMMDDHH terms (one per month).
function _enumerateTerms(fromTerm: number, toTerm: number): number[] {
  const fromMoment = moment.utc(String(fromTerm), 'YYYYMMDDHH');
  const toMoment = moment.utc(String(toTerm), 'YYYYMMDDHH');
  const terms: number[] = [];
  const cursor = fromMoment.clone();
  // Cap at 240 months (20 years) to avoid unbounded iteration on bad input.
  let safety = 0;
  while (cursor.isSameOrBefore(toMoment, 'month') && safety < 240) {
    terms.push(Number(cursor.format('YYYYMMDDHH')));
    cursor.add(1, 'month');
    safety++;
  }
  return terms;
}

function _isExpenseActiveForTerm(
  expense: any,
  term: number
): boolean {
  if (!expense) return false;
  if (!expense.isRecurring) {
    if (!expense.startTerm) return false;
    return Math.floor(expense.startTerm / 10000) === Math.floor(term / 10000);
  }
  // Recurring: reject a falsy startTerm (don't bill back to epoch) and
  // compare at YYYYMM granularity. Mirrors the rent-engine predicate in
  // businesslogic/tasks/1_base.ts so the property-side expense view agrees
  // with what actually gets billed.
  if (!expense.startTerm) return false;
  const ymTerm = Math.floor(term / 10000);
  if (ymTerm < Math.floor(expense.startTerm / 10000)) return false;
  if (expense.endTerm && ymTerm > Math.floor(expense.endTerm / 10000)) {
    return false;
  }
  return true;
}

export async function getExpenses(req: Req, res: Res) {
  const realm = req.realm;
  const propertyId = req.params.id;
  validateObjectId(propertyId, 'property id');

  const dbProperty: any = await Collections.Property.findOne({
    _id: propertyId,
    realmId: realm!._id
  }).lean();
  if (!dbProperty) {
    throw new ServiceError('Property does not exist', 404);
  }

  // Default range: past 12 months PLUS the current month (13 entries total).
  const now = moment.utc().startOf('month');
  const defaultTo = Number(now.format('YYYYMMDDHH'));
  const defaultFrom = Number(
    now.clone().subtract(12, 'months').format('YYYYMMDDHH')
  );

  const fromTerm = req.query?.from
    ? _parseYYYYMM(String(req.query.from), 'from')
    : defaultFrom;
  const toTerm = req.query?.to
    ? _parseYYYYMM(String(req.query.to), 'to')
    : defaultTo;

  if (fromTerm > toTerm) {
    throw new ServiceError('"from" must be before or equal to "to"', 422);
  }

  const terms = _enumerateTerms(fromTerm, toTerm);
  const currentTerm = Number(now.format('YYYYMMDDHH'));

  // Locate the building that contains this property as a unit. Realm-scoped.
  const building: any = await Collections.Building.findOne({
    realmId: realm!._id,
    'units.propertyId': String(propertyId)
  }).lean();

  // Attach _tenantGroups so the equal-allocation case in
  // computeBuildingChargeForProperty can split per-tenant rather than
  // per-unit (mirrors rentmanager / buildingmanager flow).
  if (building) {
    await _attachTenantGroupsToBuildings(String(realm!._id), [building]);
  }

  const lifetimeByCategory: CategoryTotals = _zeroCategoryTotals();
  const lifetimeByYear: Record<string, number> = {};
  let currentMonthByCategory: CategoryTotals = _zeroCategoryTotals();
  let currentMonthLines: ExpenseLine[] = [];

  if (building) {
    const unit = (building.units || []).find(
      (u: any) => String(u.propertyId) === String(propertyId)
    );

    for (const term of terms) {
      const ymKey = String(Math.floor(term / 1000000)); // YYYY
      const isCurrent = term === currentTerm;
      const monthLines: ExpenseLine[] = [];
      const monthByCategory = _zeroCategoryTotals();

      // 1. Building expenses active for this term — but skip those
      //    already overridden by a unit-level monthly charge (mirrors
      //    1_base.ts behaviour to avoid double-counting).
      const monthlyChargeExpenseIds = new Set<string>();
      if (unit && Array.isArray(unit.monthlyCharges)) {
        for (const charge of unit.monthlyCharges) {
          if (charge.term === term && charge.expenseId) {
            monthlyChargeExpenseIds.add(String(charge.expenseId));
          }
        }
      }

      for (const expense of (building.expenses || []) as any[]) {
        if (!_isExpenseActiveForTerm(expense, term)) continue;
        if (monthlyChargeExpenseIds.has(String(expense._id))) continue;
        const share = computeBuildingChargeForProperty(
          building,
          String(propertyId),
          expense,
          term
        );
        if (share <= 0) continue;
        const category = _classifyExpenseType(expense.type);
        const line: ExpenseLine = {
          category,
          description: expense.name || '',
          // Building expenses without a user-set name are rare but
          // possible (legacy imports). Fall back to category-as-label.
          descriptionKey: expense.name ? undefined : `category_${category}`,
          amount: share,
          source: 'building_expense'
        };
        monthByCategory[category] += share;
        lifetimeByCategory[category] += share;
        lifetimeByYear[ymKey] = (lifetimeByYear[ymKey] || 0) + share;
        if (isCurrent) monthLines.push(line);
        else if (terms.length === 1) monthLines.push(line);
      }

      // 2. Unit-level monthly charges for this term (manual entries +
      //    repair-distributed lines; both already carry a final amount).
      //    When charge.expenseId is set, the line came from MonthlyStatement
      //    distribution of a typed building.expense (heating/water/...). We
      //    must inherit that expense's category so the panel's heating row
      //    actually shows heating amounts — hardcoding 'other' silently
      //    miscategorised every Monthly Statement entry as misc spend
      //    (I2-02).
      if (unit && Array.isArray(unit.monthlyCharges)) {
        for (const charge of unit.monthlyCharges as any[]) {
          if (charge.term !== term) continue;
          const amount = Number(charge.amount) || 0;
          if (amount <= 0) continue;
          const isRepair = !!charge.repairId;
          let category: ExpenseCategory;
          let lineDescription = '';
          let descriptionKey: string | undefined;
          if (isRepair) {
            category = 'repairs';
            lineDescription = charge.description || '';
            if (!lineDescription) descriptionKey = 'monthly_charge';
          } else if (charge.expenseId) {
            const sourceExpense = (building.expenses || []).find(
              (e: any) => String(e._id) === String(charge.expenseId)
            );
            category = _classifyExpenseType(sourceExpense?.type);
            lineDescription =
              charge.description || sourceExpense?.name || '';
            if (!lineDescription) descriptionKey = 'monthly_charge';
          } else {
            // Truly free-form unit-only charge — no link to a typed
            // building expense. Land in 'other'.
            category = 'other';
            lineDescription = charge.description || '';
            if (!lineDescription) descriptionKey = 'monthly_charge';
          }
          const line: ExpenseLine = {
            category,
            description: lineDescription,
            descriptionKey,
            amount,
            source: isRepair ? 'repair' : 'monthly_charge'
          };
          monthByCategory[category] += amount;
          lifetimeByCategory[category] += amount;
          lifetimeByYear[ymKey] = (lifetimeByYear[ymKey] || 0) + amount;
          if (isCurrent) monthLines.push(line);
          else if (terms.length === 1) monthLines.push(line);
        }
      }

      // 3. Owner monthly expenses for this term — these are already
      //    materialised per-term so no allocation is needed. The schema
      //    (services/common/src/collections/building.ts OwnerMonthlyExpense)
      //    declares `source: 'expense' | 'repair'`. For source='repair'
      //    `expenseId` holds a REPAIR _id (services/api/src/managers/buildingmanager.ts
      //    _distributeRepairCharge writes ownerMonthlyExpenses with
      //    source='repair' and expenseId = repair._id), so the building.expenses
      //    lookup misses; categorise those directly as 'repairs'. For
      //    source='expense' (or undefined for legacy rows) look up the source
      //    expense type to classify correctly.
      if (Array.isArray(building.ownerMonthlyExpenses)) {
        for (const ownerEntry of building.ownerMonthlyExpenses as any[]) {
          if (ownerEntry.term !== term) continue;
          const amount = Number(ownerEntry.amount) || 0;
          if (amount <= 0) continue;
          let category: ExpenseCategory;
          let lineDescription = '';
          let descriptionKey: string | undefined;
          if (ownerEntry.source === 'repair') {
            const sourceRepair = (building.repairs || []).find(
              (r: any) => String(r._id) === String(ownerEntry.expenseId)
            );
            category = 'repairs';
            lineDescription =
              ownerEntry.description ||
              (sourceRepair?.title ? `Repair: ${sourceRepair.title}` : '');
            if (!lineDescription) descriptionKey = 'owner_repair';
          } else {
            const sourceExpense = (building.expenses || []).find(
              (e: any) => String(e._id) === String(ownerEntry.expenseId)
            );
            category = _classifyExpenseType(sourceExpense?.type);
            lineDescription =
              ownerEntry.description || sourceExpense?.name || '';
            if (!lineDescription) descriptionKey = 'owner_expense';
          }
          const line: ExpenseLine = {
            category,
            description: lineDescription,
            descriptionKey,
            amount,
            source: 'owner_monthly_expense'
          };
          monthByCategory[category] += amount;
          lifetimeByCategory[category] += amount;
          lifetimeByYear[ymKey] = (lifetimeByYear[ymKey] || 0) + amount;
          if (isCurrent) monthLines.push(line);
          else if (terms.length === 1) monthLines.push(line);
        }
      }

      // 4. Repairs whose chargeTerm matches this term AND whose
      //    affectedUnitIds includes the unit. Repair-distributed lines on
      //    monthlyCharges (handled above) already cover the
      //    chargeable-to-tenants split; a raw repair with no charge
      //    distribution still counts toward the property's lifetime spend
      //    (owner-borne portion). Skip if already counted via the
      //    distribution path to avoid double-counting.
      if (unit && Array.isArray(building.repairs)) {
        const distributedRepairIds = new Set<string>();
        if (Array.isArray(unit.monthlyCharges)) {
          for (const charge of unit.monthlyCharges as any[]) {
            if (charge.term === term && charge.repairId) {
              distributedRepairIds.add(String(charge.repairId));
            }
          }
        }
        for (const repair of building.repairs as any[]) {
          if (!repair) continue;
          if (Number(repair.chargeTerm) !== term) continue;
          const affected = (repair.affectedUnitIds || []).map((x: any) =>
            String(x)
          );
          if (!affected.includes(String(unit._id))) continue;
          if (distributedRepairIds.has(String(repair._id))) continue;
          const cost =
            Number(repair.actualCost) || Number(repair.estimatedCost) || 0;
          if (cost <= 0) continue;
          // Even split across affected units (owner-borne portion lands
          // here). This is a coarse view — the precise allocation is
          // handled by _distributeRepairCharge for tenant-charged repairs.
          const share = Math.round((cost / affected.length) * 100) / 100;
          if (share <= 0) continue;
          const line: ExpenseLine = {
            category: 'repairs',
            description: repair.title || '',
            descriptionKey: repair.title ? undefined : 'repair',
            amount: share,
            source: 'repair'
          };
          monthByCategory.repairs += share;
          lifetimeByCategory.repairs += share;
          lifetimeByYear[ymKey] = (lifetimeByYear[ymKey] || 0) + share;
          if (isCurrent) monthLines.push(line);
          else if (terms.length === 1) monthLines.push(line);
        }
      }

      // Flush "the active month" to the response. By default that's the
      // current calendar month. When the caller picked a single-month
      // window (?from=YYYYMM&to=YYYYMM), the panel should show THAT month
      // as the active one — without this branch the response shipped
      // currentMonth.lines:[] and zeroed byCategory even though entries
      // existed for that term (I2-01 regression).
      if (isCurrent || terms.length === 1) {
        currentMonthByCategory = monthByCategory;
        currentMonthLines = monthLines;
      }
    }
  }

  // Round all category totals to 2dp for stable display.
  const _round2 = (n: number) => Math.round(n * 100) / 100;
  for (const k of EXPENSE_CATEGORIES) {
    currentMonthByCategory[k] = _round2(currentMonthByCategory[k]);
    lifetimeByCategory[k] = _round2(lifetimeByCategory[k]);
  }
  const lifetimeByYearRounded: Record<string, number> = {};
  for (const k of Object.keys(lifetimeByYear)) {
    lifetimeByYearRounded[k] = _round2(lifetimeByYear[k]);
  }

  return res.json({
    propertyId: String(propertyId),
    currency: realm!.currency || '',
    currentTerm,
    // Echo the window the panel covers so the UI can label "Current
    // month (June 2026)" / "13-month total (Jun 2025 — Jun 2026)" with
    // real dates instead of unanchored "Current month / Lifetime".
    fromTerm,
    toTerm,
    currentMonth: {
      byCategory: currentMonthByCategory,
      lines: currentMonthLines
    },
    lifetime: {
      byCategory: lifetimeByCategory,
      byYear: lifetimeByYearRounded
    }
  });
}
