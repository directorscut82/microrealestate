import type { CollectionTypes } from '@microrealestate/types';
import { logger } from '@microrealestate/common';
import moment from 'moment';

export interface Contract {
  begin: Date;
  end: Date;
  termination?: Date;
  frequency: string;
  terms?: number;
  properties: CollectionTypes.Tenant['properties'];
  buildings?: CollectionTypes.Building[];  // Building data for charge computation
  vatRate?: number;
  discount?: number;
  rents: Rent[];
}

export interface Rent {
  term: number;
  month: number;
  year: number;
  preTaxAmounts: { description: string; amount: number }[];
  charges: { description: string; amount: number }[];
  buildingCharges?: { description: string; amount: number; buildingName?: string; type?: string }[];
  discounts: { origin: string; description: string; amount: number }[];
  debts: { description: string; amount: number; origin?: string }[];
  vats: { origin: string; description: string; rate: number; amount: number }[];
  payments: { date: string; amount: number; type: string; reference: string; description?: string }[];
  description: string;
  balance?: number;
  total: {
    balance: number;
    preTaxAmount: number;
    charges: number;
    debts?: number;
    discount: number;
    vat: number;
    grandTotal: number;
    payment: number;
  };
}

export interface Settlements {
  payments?: { date: string; amount: number; type: string; reference: string; description?: string }[];
  debts?: { origin?: string; description: string; amount: number }[];
  discounts?: { origin?: string; description: string; amount: number }[];
  vats?: { origin: string; description: string; rate: number; amount: number }[];
  description?: string;
}

export type RentTask = (
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
) => Rent;

// Helper to compute building charge share for a property
export function computeBuildingChargeForProperty(
  building: CollectionTypes.Building,
  propertyId: string,
  expense: CollectionTypes.BuildingExpense,
  term?: number
): number {
  return Math.round(_computeBuildingChargeRaw(building, propertyId, expense, term) * 100) / 100;
}

// Per-recipient breakdown of who gets charged what for a building's
// expenses in a given term. Uses the SAME computeBuildingChargeForProperty
// engine that does the real rent billing, so the breakdown the landlord
// sees can never drift from what is actually charged.
//
// For each active building expense and each managed unit, emits the unit's
// share and labels the recipient:
//   - renter: a tenant whose lease covers this term (the share lands on
//     their rent bill)
//   - owner: the unit has no tenant for this term — the share is currently
//     NOT billed to anyone (the vacant-unit gap), surfaced explicitly so
//     the landlord sees the money that evaporates instead of it being
//     silent.
// `building` must carry units[].property + units[].tenant (as attached by
// buildingmanager._toBuildingData) and _tenantGroups (for equal-split).
export type ExpenseBreakdownRow = {
  expenseId: string;
  expenseName: string;
  allocationMethod: string;
  propertyId: string;
  propertyName: string;
  recipient: 'renter' | 'owner';
  recipientName: string | null;
  amount: number;
  // Human-readable "how this share was computed" so the landlord can see
  // the πράξη υπολογισμού per unit (e.g. "by surface: 80m² / 200m² × 120").
  basis: string;
  // For owner (vacant) rows: true when the expense has
  // chargeOwnerWhenVacant — the share is BILLED to the owner; false when
  // it is simply uncollected. Undefined for renter rows.
  ownerBilled?: boolean;
};

// Build a short explanation of how a unit's share was derived for a given
// allocation method. Mirrors the formulas in _computeBuildingChargeRaw.
function _shareBasis(
  building: any,
  unit: any,
  expense: any,
  total: number
): string {
  const method = expense.allocationMethod || 'equal';
  const managed = (building.units || []).filter((u: any) => u.propertyId);
  const fmt = (n: number) => Math.round(n * 100) / 100;
  switch (method) {
    case 'by_surface': {
      const sumS = managed.reduce(
        (s: number, u: any) => s + (Number(u.surface) || 0),
        0
      );
      return `${fmt(unit.surface || 0)}m² / ${fmt(sumS)}m² × ${fmt(total)}`;
    }
    case 'general_thousandths':
    case 'heating_thousandths':
    case 'elevator_thousandths': {
      const key =
        method === 'general_thousandths'
          ? 'generalThousandths'
          : method === 'heating_thousandths'
            ? 'heatingThousandths'
            : 'elevatorThousandths';
      const sumT = managed.reduce(
        (s: number, u: any) => s + (Number(u[key]) || 0),
        0
      );
      return `${fmt(unit[key] || 0)}‰ / ${fmt(sumT)}‰ × ${fmt(total)}`;
    }
    case 'equal': {
      return `${fmt(total)} / ${managed.length} units`;
    }
    case 'fixed':
    case 'single_unit':
    case 'custom_ratio':
    case 'custom_percentage':
      return `${method}`;
    default:
      return '';
  }
}

// Authoritative per-recipient breakdown of who gets charged what for a
// building in a given term. Reads from the SAME sources the rent engine
// bills from, so it can never drift from the actual charges:
//   1. Recurring / fixed building.expenses → recomputed live via
//      computeBuildingChargeForProperty (their amount lives on the expense).
//   2. Persisted unit.monthlyCharges → VARIABLE statement amounts AND
//      repair distributions (their per-unit share is already stored; the
//      expense itself carries no amount, so #1 would miss them). When a
//      monthlyCharge carries an expenseId, it OVERRIDES the live expense
//      for that term (mirrors 1_base's suppression to avoid double-count).
//   3. ownerMonthlyExpenses → owner-direct + owner-portion of repairs.
//
// Recipient: a unit with a tenant this term → 'renter' (billed); a unit
// with no tenant → 'owner' (currently uncollected; surfaced explicitly).
// `building` must carry units[].property + units[].tenant + _tenantGroups.
export function computeBuildingExpenseBreakdown(
  building: any,
  term: number
): {
  rows: ExpenseBreakdownRow[];
  tenantTotal: number;
  ownerBilledTotal: number;
  ownerUnbilledTotal: number;
} {
  const rows: ExpenseBreakdownRow[] = [];
  const units = (building?.units || []) as any[];
  const expenses = (building?.expenses || []) as any[];
  const expenseById = new Map(
    expenses.map((e: any) => [String(e._id), e])
  );

  for (const unit of units) {
    if (!unit.propertyId) continue;
    const tenant = unit.tenant || null;
    const recipient: 'renter' | 'owner' = tenant ? 'renter' : 'owner';
    const recipientName = tenant ? tenant.name : null;
    const propertyName =
      unit.property?.name || unit.name || String(unit.propertyId);

    // Which expenseIds are overridden by a persisted monthlyCharge for this
    // term — those are billed from the stored share, not recomputed.
    const overridden = new Set<string>();
    for (const c of unit.monthlyCharges || []) {
      if (Number(c.term) === term && c.expenseId) {
        overridden.add(String(c.expenseId));
      }
    }

    // 1. Live recurring/fixed expenses (skip those overridden by a stored
    //    monthlyCharge so we don't double-count).
    for (const expense of expenses) {
      if (!isExpenseActiveForTerm(expense, term)) continue;
      if (overridden.has(String(expense._id))) continue;
      const total = Number(expense.amount) || 0;
      if (total <= 0) continue; // variable expenses (amount 0) come from #2
      const share = computeBuildingChargeForProperty(
        building,
        String(unit.propertyId),
        expense,
        term
      );
      if (share <= 0) continue;
      rows.push({
        expenseId: String(expense._id),
        expenseName: expense.name || '',
        allocationMethod: expense.allocationMethod || 'equal',
        propertyId: String(unit.propertyId),
        propertyName,
        recipient,
        recipientName,
        amount: share,
        basis: _shareBasis(building, unit, expense, total),
        ...(recipient === 'owner'
          ? { ownerBilled: !!expense.chargeOwnerWhenVacant }
          : {})
      });
    }

    // 2. Persisted per-unit monthly charges (variable statement amounts +
    //    repair distributions). These already hold the final per-unit share.
    for (const c of unit.monthlyCharges || []) {
      if (Number(c.term) !== term) continue;
      const amt = Number(c.amount) || 0;
      if (amt <= 0) continue;
      const srcExpense = c.expenseId
        ? expenseById.get(String(c.expenseId))
        : null;
      rows.push({
        expenseId: String(c.expenseId || c.repairId || ''),
        expenseName:
          c.description || srcExpense?.name || (c.repairId ? 'Repair' : ''),
        allocationMethod: srcExpense?.allocationMethod || 'equal',
        propertyId: String(unit.propertyId),
        propertyName,
        recipient,
        recipientName,
        amount: Math.round(amt * 100) / 100,
        basis: c.repairId ? 'repair' : 'entered amount'
      });
    }
  }

  const tenantTotal = rows
    .filter((r) => r.recipient === 'renter')
    .reduce((s, r) => s + r.amount, 0);
  // Owner (vacant) shares split by whether the expense bills them to the
  // owner (chargeOwnerWhenVacant on) or leaves them uncollected (off).
  const ownerBilledTotal = rows
    .filter((r) => r.recipient === 'owner' && r.ownerBilled)
    .reduce((s, r) => s + r.amount, 0);
  const ownerUnbilledTotal = rows
    .filter((r) => r.recipient === 'owner' && !r.ownerBilled)
    .reduce((s, r) => s + r.amount, 0);

  return {
    rows,
    tenantTotal: Math.round(tenantTotal * 100) / 100,
    ownerBilledTotal: Math.round(ownerBilledTotal * 100) / 100,
    ownerUnbilledTotal: Math.round(ownerUnbilledTotal * 100) / 100
  };
}

// Wave-18 B4: group is "active" for `term` when the tenant's lease window
// (clamped by terminationDate) AND the per-property entry/exit window both
// cover the rent term. Term is YYYYMMDDHH; we compare in YYYYMM granularity
// (one expense line per rent month) by stripping day+hour. A group with
// no dates at all (legacy / test fixtures) is treated as always active.
function _isGroupActiveForTerm(group: any, term: number, propertyId: string): boolean {
  if (!group) return false;
  if (!term) return true;
  const ym = Math.floor(term / 10000); // YYYYMM
  const toYM = (d: any): number | null => {
    if (!d) return null;
    const m = moment.utc(d);
    if (!m.isValid()) return null;
    return m.year() * 100 + (m.month() + 1);
  };

  const begin = toYM(group.beginDate);
  const end = toYM(group.endDate);
  const termination = toYM(group.terminationDate);
  if (begin !== null && ym < begin) return false;
  if (end !== null && ym > end) return false;
  if (termination !== null && ym > termination) return false;

  // per-property window for this exact propertyId within the group
  const props = (group.properties || []) as any[];
  const myProp = props.find((p) => String(p.propertyId) === String(propertyId));
  if (myProp) {
    const entry = toYM(myProp.entryDate);
    const exit = toYM(myProp.exitDate);
    if (entry !== null && ym < entry) return false;
    if (exit !== null && ym > exit) return false;
  }
  return true;
}

function _computeBuildingChargeRaw(
  building: CollectionTypes.Building,
  propertyId: string,
  expense: CollectionTypes.BuildingExpense,
  term?: number
): number {
  if (!building?.units || !Array.isArray(building.units)) return 0;

  const unit = building.units.find(
    (u) => String(u.propertyId) === String(propertyId)
  );
  if (!unit) return 0;

  const { allocationMethod, amount, customAllocations } = expense;
  // For non-fixed methods, amount must be a valid positive number
  if (allocationMethod !== 'fixed' && (!Number.isFinite(amount) || amount <= 0)) return 0;

  // Many allocation methods must only count "managed" units (those with a
  // linked propertyId). Unmanaged units inflate the denominator and silently
  // shrink every managed unit's share, leaking money out of the building's
  // recoverable charges.
  const managedUnits = building.units.filter((u) => u.propertyId);

  switch (allocationMethod) {
    case 'general_thousandths': {
      // Wave-14 F2: use the FULL building denominator (sum across ALL units,
      // including vacant) so each tenant pays exactly their pro-rata share.
      // The vacant unit's share is implicitly absorbed by the owner — it is
      // never associated with a tenant property, so it never lands on a bill.
      const generalTotal = building.units.reduce((sum, u) => sum + (Number(u.generalThousandths) || 0), 0);
      if (generalTotal === 0) return 0;
      return (amount * (Number(unit.generalThousandths) || 0)) / generalTotal;
    }

    case 'heating_thousandths': {
      // Wave-14 F2: see general_thousandths note.
      const heatingTotal = building.units.reduce((sum, u) => sum + (Number(u.heatingThousandths) || 0), 0);
      if (heatingTotal === 0) return 0;
      return (amount * (Number(unit.heatingThousandths) || 0)) / heatingTotal;
    }

    case 'elevator_thousandths': {
      // Wave-14 F2: see general_thousandths note.
      const elevatorTotal = building.units.reduce((sum, u) => sum + (Number(u.elevatorThousandths) || 0), 0);
      if (elevatorTotal === 0) return 0;
      return (amount * (Number(unit.elevatorThousandths) || 0)) / elevatorTotal;
    }

    case 'equal': {
      // Wave-17 B1: "equal" must split per-tenant, not per-managed-unit.
      // A tenant occupying multiple units in the same building (e.g.
      // apartment + storage) was previously billed once per unit, so
      // their cleaning/management charge appeared twice on the rent.
      // _tenantGroups (attached by occupantmanager._attachTenantGroupsToBuildings)
      // exposes the unique-tenant grouping; if present, divide by group
      // count and emit the line on only ONE propertyId per group (the
      // sorted-min, deterministic carrier).
      //
      // Wave-18 B4: groups now carry tenant-window metadata. Filter to the
      // tenants whose lease + per-property windows actually cover the rent
      // `term` being computed. Without this filter, expenses split across
      // the LIFETIME tenant universe of the building (e.g. 320/4) instead
      // of the active-this-term tenants (e.g. 320/2 in 2027/3 when only
      // two of four historical tenants are still active).
      const rawGroups = (building as any)._tenantGroups as any[] | undefined;
      if (rawGroups && rawGroups.length > 0) {
        // New shape: [{ propertyIds, properties, beginDate, endDate, terminationDate }]
        // Legacy shape: string[][] (kept for back-compat with any caller
        // that hasn't been refreshed via _attachTenantGroupsToBuildings).
        const isNewShape = !Array.isArray(rawGroups[0]);
        const normalized = isNewShape
          ? rawGroups
          : (rawGroups as unknown as string[][]).map((ids) => ({
              propertyIds: ids,
              properties: ids.map((id) => ({ propertyId: id })),
              beginDate: null,
              endDate: null,
              terminationDate: null
            }));

        const activeGroups = term
          ? normalized.filter((g: any) =>
              (g.propertyIds || []).some((pid: string) =>
                _isGroupActiveForTerm(g, term, pid)
              )
            )
          : normalized;

        const myGroup = activeGroups.find((g: any) =>
          (g.propertyIds || []).includes(String(propertyId))
        );
        if (!myGroup) return 0;
        // Carrier = the lex-min member that is ACTIVE this term, not the
        // static group lex-min. A group survives `activeGroups` if ANY
        // member is active, so a multi-unit tenant whose lex-min unit has
        // exited (but a sibling is still active) used to compute its share
        // into the denominator yet emit it on the exited carrier — which
        // the outer loop never bills — so the whole share silently
        // vanished. Selecting the active carrier emits it on the unit the
        // outer loop actually visits. (term may be falsy in the
        // non-term-scoped path; then all members count as active.)
        const _activeCarrier = (g: any): string | undefined =>
          (g.propertyIds || [])
            .filter((pid: string) =>
              term ? _isGroupActiveForTerm(g, term, String(pid)) : true
            )
            .map((pid: string) => String(pid))
            .sort()[0];
        const carrier = _activeCarrier(myGroup);
        if (!carrier || String(propertyId) !== carrier) return 0;
        const totalGroups = activeGroups.length;
        if (totalGroups === 0) return 0;
        const base = Math.round((amount / totalGroups) * 100) / 100;
        // Push rounding remainder onto the LAST group (lex-max by active
        // carrier id) so totals reconcile (100/3 → 33.33+33.33+33.34 =
        // 100.00). Use the same active-member carrier selection so the
        // remainder lands on a unit that is actually billed.
        const carriers = activeGroups
          .map((g: any) => _activeCarrier(g))
          .filter(Boolean)
          .sort();
        if (carrier === carriers[carriers.length - 1]) {
          return Math.round((amount - base * (totalGroups - 1)) * 100) / 100;
        }
        return base;
      }
      // Fallback (legacy / tests without _tenantGroups): per-managed-unit.
      const totalUnits = managedUnits.length;
      if (totalUnits === 0) return 0;
      const base = Math.round((amount / totalUnits) * 100) / 100;
      const sortedIds = managedUnits
        .map((u) => String(u.propertyId))
        .sort();
      if (String(propertyId) === sortedIds[sortedIds.length - 1]) {
        return Math.round((amount - base * (totalUnits - 1)) * 100) / 100;
      }
      return base;
    }

    case 'by_surface': {
      // E19: surface allocation must only consider MANAGED units (units
      // tied to a Property the landlord operates). The previous
      // denominator summed over ALL units in the building including the
      // owner-occupied / vacant / non-managed ones — so when a building
      // had any unmanaged unit, the managed tenants' share went DOWN
      // (denominator inflated), the building bill was under-collected,
      // and the missing amount silently disappeared from the rent.
      const totalSurface = managedUnits.reduce(
        (sum, u) => sum + (Number(u.surface) || 0),
        0
      );
      if (totalSurface === 0) return 0;
      // Carrier-remainder: every share except the last is rounded
      // independently; the last unit (lex-max propertyId among managed
      // units with surface > 0) absorbs the rounding remainder so the
      // sum bills exactly `amount`. Without this, three units of 1m²
      // each sharing 10€ each get 3.33€ and the building only collects
      // 9.99€ — landlord eats the 0.01€ every month.
      const myPropId = String(propertyId);
      const _orderedIds = managedUnits
        .filter((u) => (Number(u.surface) || 0) > 0 && u.propertyId)
        .map((u) => String(u.propertyId))
        .sort();
      if (_orderedIds.length === 0) return 0;
      const isLast = myPropId === _orderedIds[_orderedIds.length - 1];
      if (!isLast) {
        return (amount * (Number(unit.surface) || 0)) / totalSurface;
      }
      // Last unit gets `amount - sum(other rounded shares)`.
      let othersSum = 0;
      for (const id of _orderedIds) {
        if (id === myPropId) continue;
        const otherUnit = managedUnits.find(
          (u) => String(u.propertyId) === id
        );
        const share = (amount * (Number(otherUnit?.surface) || 0)) / totalSurface;
        othersSum += Math.round(share * 100) / 100;
      }
      return Math.round((amount - othersSum) * 100) / 100;
    }

    case 'fixed': {
      // Fixed allocation per unit. Negative values are misconfiguration
      // (a "negative fixed share") — log and clamp to 0 instead of silently
      // accepting them or letting them bubble into the rent total.
      const allocation = customAllocations?.find((a) => String(a.propertyId) === String(propertyId));
      const v = Number(allocation?.value);
      if (Number.isFinite(v) && v < 0) {
        logger.warn(
          `Fixed allocation has negative value (${v}) for property ${propertyId} ` +
            `in building ${building._id}; clamping to 0.`
        );
      }
      return Math.max(0, Number.isFinite(v) ? v : 0);
    }

    case 'custom_ratio': {
      // Custom ratio — normalize to sum, carrier-remainder for rounding.
      // Single-unit fallback: if NO ratios are configured but the building
      // has exactly one unit, that unit takes the full amount.
      const unitsWithProperty = building.units.filter((u) => u.propertyId);
      const totalRatio = customAllocations?.reduce((sum, a) => sum + (Number(a.value) || 0), 0) || 0;
      const allocation = customAllocations?.find((a) => String(a.propertyId) === String(propertyId));
      if (totalRatio === 0) {
        if (unitsWithProperty.length === 1) return amount;
        logger.warn(
          `custom_ratio allocation has no ratios set for building ${building._id} ` +
            `(${unitsWithProperty.length} units). Returning 0 share for property ${propertyId}.`
        );
        return 0;
      }
      if (!allocation) return 0;
      const av = Number(allocation.value) || 0;
      // Carrier-remainder: 7 units sharing 1€ at 1:1:1:1:1:1:1 each get
      // 0.142857... rounded to 0.14 → sum 0.98 (2 cents lost). Last
      // unit (lex-max propertyId among non-zero ratios) absorbs the
      // remainder so the sum bills exactly amount.
      const _ratioIds = (customAllocations || [])
        .filter((a) => Number(a?.value) > 0)
        .map((a) => String(a.propertyId))
        .sort();
      const myIdStr = String(propertyId);
      const isLast = _ratioIds.length > 0 && myIdStr === _ratioIds[_ratioIds.length - 1];
      if (!isLast) return (amount * av) / totalRatio;
      let othersSum = 0;
      for (const id of _ratioIds) {
        if (id === myIdStr) continue;
        const other = (customAllocations || []).find((a) => String(a.propertyId) === id);
        const ov = Number(other?.value) || 0;
        othersSum += Math.round(((amount * ov) / totalRatio) * 100) / 100;
      }
      return Math.round((amount - othersSum) * 100) / 100;
    }

    case 'custom_percentage': {
      // Custom percentage - value is already a percentage. Carrier-remainder
      // pattern fires ONLY when multiple carriers + their percentages sum
      // to exactly 100% (the "split" intent: 3 units at 33.33% must total
      // 99.99% absorbed by carry-correction). When the percentages sum to
      // less than 100% — including the single-carrier-at-35% case — each
      // carrier bills its own percent directly with no carry math.
      const allocation = customAllocations?.find((a) => String(a.propertyId) === String(propertyId));
      if (!allocation) return 0;
      const pct = Number(allocation.value) || 0;
      if (pct <= 0) return 0;
      const _pctIds = (customAllocations || [])
        .filter((a) => Number(a?.value) > 0)
        .map((a) => String(a.propertyId))
        .sort();
      const totalPct = (customAllocations || [])
        .reduce((s, a) => s + (Number(a?.value) || 0), 0);
      // Only apply carry-remainder when the allocations are intended to
      // sum to 100% (within rounding tolerance). Otherwise treat each
      // entry as an independent percentage of the expense.
      const isFullSplit = Math.abs(totalPct - 100) < 0.05;
      if (!isFullSplit) {
        return Math.round(((amount * pct) / 100) * 100) / 100;
      }
      const myIdStr = String(propertyId);
      const isLast = _pctIds.length > 0 && myIdStr === _pctIds[_pctIds.length - 1];
      if (!isLast) return (amount * pct) / 100;
      let othersSum = 0;
      for (const id of _pctIds) {
        if (id === myIdStr) continue;
        const other = (customAllocations || []).find((a) => String(a.propertyId) === id);
        const op = Number(other?.value) || 0;
        if (op <= 0) continue;
        othersSum += Math.round(((amount * op) / 100) * 100) / 100;
      }
      return Math.round((amount - othersSum) * 100) / 100;
    }

    case 'single_unit': {
      // Bill the entire expense to one specific unit. The chosen
      // propertyId lives in customAllocations[0].propertyId. The user
      // picked a single apartment from the dropdown; every other
      // property's share is 0.
      const target = (customAllocations || [])[0];
      if (!target?.propertyId) return 0;
      if (String(target.propertyId) !== String(propertyId)) return 0;
      return Math.round(amount * 100) / 100;
    }

    default:
      return 0;
  }
}

// Check if expense is active for the given term
export function isExpenseActiveForTerm(expense: CollectionTypes.BuildingExpense, term: number): boolean {
  // Non-recurring expenses MUST have an explicit startTerm — without one
  // they would otherwise be treated as "active forever" by the date-range
  // checks below, which is the opposite of the intended behavior. Reject
  // them so misconfigured one-shot expenses don't silently bill every
  // term until end of time.
  //
  // Wave-18 B1: compare at YYYYMM granularity, not exact YYYYMMDDHH. A
  // one-time expense saved at term 2026061500 (mid-June) was silently
  // dropped because June rents normalize to 2026060100 and the equality
  // check failed. Both are "June" — match the month.
  if (!(expense as any).isRecurring) {
    if (!expense.startTerm) return false;
    if (Math.floor(expense.startTerm / 10000) !== Math.floor(term / 10000)) {
      return false;
    }
    return true;
  }
  // Recurring: a falsy startTerm must be rejected, NOT treated as
  // active-since-epoch (the comment above documents this intent, but the
  // recurring branch previously skipped the lower-bound when startTerm was
  // falsy — so a legacy/seeded recurring expense with no startTerm billed
  // every tenant back to the beginning of time, invisible in the UI which
  // already guards `!startTerm`). Compare at YYYYMM granularity so a
  // mid-month startTerm (day != 01) still bills its own start month.
  if (!expense.startTerm) return false;
  const ymTerm = Math.floor(term / 10000);
  if (ymTerm < Math.floor(expense.startTerm / 10000)) return false;
  if (expense.endTerm && ymTerm > Math.floor(expense.endTerm / 10000)) {
    return false;
  }
  return true;
}

export default function taskBase(
  contract: Contract,
  rentDate: string,
  // Unused here — kept for RentTask signature compatibility (used by 5_balance).
  _previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  const currentMoment = moment.utc(rentDate, 'DD/MM/YYYY HH:mm');
  if (!currentMoment.isValid()) return rent;

  rent.term = Number(currentMoment.format('YYYYMMDDHH'));
  if (contract.frequency === 'months') {
    // NOTE: contract.ts uses startOf('month') so mid-month begin/end dates
    // produce a full-month rent (a tenant who moves in on the 20th is
    // billed the full month for that month). If proration is required,
    // change here to compute partial-month rent based on
    // day-of-month / daysInMonth — and apply the same scaling in
    // 2_amount.ts where preTaxAmount is computed.
    rent.term = Number(
      moment.utc(currentMoment).startOf('month').format('YYYYMMDDHH')
    );
  }
  if (contract.frequency === 'days') {
    rent.term = Number(
      moment.utc(currentMoment).startOf('day').format('YYYYMMDDHH')
    );
  }
  if (contract.frequency === 'hours') {
    rent.term = Number(
      moment.utc(currentMoment).startOf('hour').format('YYYYMMDDHH')
    );
  }
  rent.month = currentMoment.month() + 1;
  rent.year = currentMoment.year();

  const properties = contract.properties || [];

  properties
    .filter((property) => {
      const entryMoment = moment.utc(property.entryDate).startOf('day');
      const exitMoment = moment.utc(property.exitDate).endOf('day');

      return currentMoment.isBetween(
        entryMoment,
        exitMoment,
        contract.frequency as moment.unitOfTime.StartOf,
        '[]'
      );
    })
    .forEach(function (property) {
      if (property.property) {
        const name = property.property.name || '';
        const preTaxAmount = Math.round((Number(property.rent) || 0) * 100) / 100;
        const expenses = property.expenses || [];

        rent.preTaxAmounts.push({
          description: name,
          amount: preTaxAmount
        });

        if (expenses.length) {
          rent.charges.push(
            ...expenses
              .filter(({ beginDate, endDate }) => {
                const expenseBegin = moment.utc(beginDate, 'DD/MM/YYYY').startOf(
                  'day'
                );
                const expenseEnd = moment.utc(endDate, 'DD/MM/YYYY').endOf('day');

                return currentMoment.isBetween(
                  expenseBegin,
                  expenseEnd,
                  contract.frequency as moment.unitOfTime.StartOf,
                  '[]'
                );
              })
              .map(({ title, amount }) => ({
                description: title,
                amount: Math.round((Number(amount) || 0) * 100) / 100
              }))
          );
        }

      }
    });

  // Always initialize buildingCharges
  rent.buildingCharges = [];

  if (contract.buildings && contract.buildings.length > 0) {
    properties
      .filter((property) => {
        const entryMoment = moment.utc(property.entryDate).startOf('day');
        const exitMoment = moment.utc(property.exitDate).endOf('day');

        return currentMoment.isBetween(
          entryMoment,
          exitMoment,
          contract.frequency as moment.unitOfTime.StartOf,
          '[]'
        );
      })
      .forEach((property) => {
        if (!property.propertyId) return;

        // Find building for this property
        const building = contract.buildings!.find((b) =>
          b.units.some((u) => String(u.propertyId) === String(property.propertyId))
        );

        if (!building) return;

        // Process monthly charges for this unit (overrides recurring expenses)
        const unit = building.units.find((u) => String(u.propertyId) === String(property.propertyId));
        const monthlyChargeExpenseIds = new Set<string>();
        if (unit) {
          unit.monthlyCharges
            .filter((charge) => charge.term === rent.term)
            .forEach((charge) => {
              if (charge.expenseId) monthlyChargeExpenseIds.add(String(charge.expenseId));
              // Repair-distributed charges have repairId set (see
              // buildingmanager._distributeRepairCharge). Tag them as
              // type='repair' so they reach the dashboard pie's repair
              // color and the auto-spread 'repairs' allocation bucket.
              // Without this, the whole `repairs` chain
              // (rentmanager._computeOwedByCategory.repairs and
              // dashboardmanager pie's repair color) is dead code.
              const _isRepair = !!(charge as { repairId?: unknown }).repairId;
              rent.buildingCharges!.push({
                description: charge.description || 'Building charges',
                amount: charge.amount,
                buildingName: building.name,
                type: _isRepair ? 'repair' : 'monthly_charge'
              });
            });
        }

        // Process recurring building expenses (skip those overridden by monthly charges)
        building.expenses
          .filter((expense) =>
            isExpenseActiveForTerm(expense, rent.term) &&
            !monthlyChargeExpenseIds.has(String(expense._id))
          )
          .forEach((expense) => {
            const share = computeBuildingChargeForProperty(
              building,
              String(property.propertyId),
              expense,
              rent.term
            );

            if (share > 0) {
              rent.buildingCharges!.push({
                description: expense.name,
                amount: share,
                buildingName: building.name,
                type: expense.type
              });
            }
          });

      });
  }

  if (settlements) {
    rent.description = settlements.description || '';
  }
  return rent;
}
