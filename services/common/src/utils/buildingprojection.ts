/**
 * buildingprojection.ts — pure projection math for a single building.
 *
 * Lifted from BuildingDashboard.js's client-side useMemo so both the building
 * page and the realm-wide Επισκόπηση use ONE implementation. No DB access, no
 * side effects — takes data already in memory and returns numbers.
 *
 * Consumer A: dashboardmanager.overview (server, sums across all buildings).
 * Consumer B: BuildingDashboard.js (client, per-building — TODO: wire later,
 *   the existing client code is the reference implementation and will be replaced
 *   by consuming the server payload once this ships).
 */
import moment from 'moment';

// ── Types (loose — accepts lean docs and frontdata shapes alike) ──────────

interface UnitLike {
  propertyId?: string | { _id?: string };
  monthlyCharges?: Array<{
    term?: number;
    expenseId?: string;
    repairId?: string;
    description?: string;
    amount?: number;
    inputAmount?: number | null;
  }>;
}

interface ExpenseLike {
  _id?: string;
  name?: string;
  amount?: number;
  allocationMethod?: string;
  isRecurring?: boolean;
  recurring?: boolean;
  startTerm?: number;
  endTerm?: number;
  customAllocations?: Array<{ value?: number }>;
  trackOwnerExpense?: boolean;
  ownerAmount?: number;
  chargeOwnerWhenVacant?: boolean;
}

interface TenantPropertyLike {
  propertyId?: string;
  rent?: number;
  expenses?: Array<{
    amount?: number;
    beginDate?: string;
    endDate?: string;
  }>;
  beginDate?: string;
  endDate?: string;
}

interface OwnerExpenseRowLike {
  term?: number;
  amount?: number;
  source?: string;
  expenseId?: string;
}

interface BuildingLike {
  _id?: string;
  units?: UnitLike[];
  expenses?: ExpenseLike[];
  ownerMonthlyExpenses?: OwnerExpenseRowLike[];
  repairs?: Array<{
    actualCost?: number;
    estimatedCost?: number;
    status?: string;
  }>;
}

export interface BuildingProjectionResult {
  annualIncome: number;
  annualIncomeProjected: number;
  annualOwnerExpenses: number;
  annualOwnerExpensesProjected: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function monthsInYear(
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  currentYear: number
): number {
  if (startYear > currentYear || endYear < currentYear) return 0;
  const from = startYear < currentYear ? 1 : startMonth;
  const to = endYear > currentYear ? 12 : endMonth;
  return Math.max(0, to - from + 1);
}

function expenseMonthlyCost(e: ExpenseLike): number {
  if (e.allocationMethod === 'fixed') {
    return (e.customAllocations || []).reduce(
      (s, a) => s + (Number(a.value) || 0),
      0
    );
  }
  return Number(e.amount) || 0;
}

function expenseActiveMonths(e: ExpenseLike, currentYear: number): number {
  const st = Number(e.startTerm) || 0;
  const et = Number(e.endTerm) || 0;
  const startMonth = st ? Math.floor((st % 1000000) / 10000) : 1;
  const startYear = st ? Math.floor(st / 1000000) : currentYear;
  const endMonth = et ? Math.floor((et % 1000000) / 10000) : 12;
  const endYear = et ? Math.floor(et / 1000000) : currentYear;
  return monthsInYear(startMonth, startYear, endMonth, endYear, currentYear);
}

function isExpenseActiveForTerm(e: ExpenseLike, currentTerm: number): boolean {
  const st = Number(e.startTerm) || 0;
  const et = Number(e.endTerm) || 0;
  if (st && currentTerm < st) return false;
  if (et && currentTerm > et) return false;
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────

/**
 * Compute the annual projection for a single building.
 *
 * @param building - lean building doc (units, expenses, ownerMonthlyExpenses)
 * @param tenantsByPropertyId - Map<propertyId, { rent, expenses, beginDate, endDate }>
 *   (from the allTenants query + frontdata shape — each active tenant's property info)
 * @param year - fiscal year (e.g. 2026)
 * @param now - moment instance for "today" (pass explicitly for testability)
 */
export function computeBuildingProjection(
  building: BuildingLike,
  tenantsByPropertyId: Map<string, TenantPropertyLike>,
  year: number,
  now?: moment.Moment
): BuildingProjectionResult {
  const _now = now || moment.utc();
  const currentTerm = Number(
    _now.clone().startOf('month').format('YYYYMMDDHH')
  );
  const currentYear = year;
  const currentMonthIdx = _now.year() === year ? _now.month() + 1 : 12;

  // ── Income projection ───────────────────────────────────────────────────
  // Rent × lease-active-months-in-year + δαπάνες-επί-ενοικίου windowed.
  let annualRentOnly = 0;
  let annualRentExpenses = 0;

  const _leaseActiveMonths = (info: TenantPropertyLike): number => {
    const b = info.beginDate
      ? moment.utc(info.beginDate, 'DD/MM/YYYY', true)
      : null;
    const e = info.endDate
      ? moment.utc(info.endDate, 'DD/MM/YYYY', true)
      : null;
    const startMonth = b && b.isValid() ? b.month() + 1 : 1;
    const startYear = b && b.isValid() ? b.year() : currentYear;
    const endMonth = e && e.isValid() ? e.month() + 1 : 12;
    const endYear = e && e.isValid() ? e.year() : currentYear;
    return monthsInYear(startMonth, startYear, endMonth, endYear, currentYear);
  };

  const _monthlyPropExpenses = (
    expenses: TenantPropertyLike['expenses']
  ): number =>
    (Array.isArray(expenses) ? expenses : [])
      .filter((ex) => {
        if (!ex?.beginDate && !ex?.endDate) return true;
        const begin = ex.beginDate
          ? moment.utc(ex.beginDate, 'DD/MM/YYYY', true)
          : null;
        const end = ex.endDate
          ? moment.utc(ex.endDate, 'DD/MM/YYYY', true)
          : null;
        if (begin && !begin.isValid()) return true;
        if (end && !end.isValid()) return true;
        if (begin && _now.isBefore(begin, 'month')) return false;
        if (end && _now.isAfter(end, 'month')) return false;
        return true;
      })
      .reduce((s, ex) => s + (Number(ex.amount) || 0), 0);

  for (const unit of building.units || []) {
    const pid =
      typeof unit.propertyId === 'string'
        ? unit.propertyId
        : unit.propertyId?._id;
    if (!pid) continue;
    const tenantInfo = tenantsByPropertyId.get(pid);
    if (!tenantInfo) continue;
    const rent = Number(tenantInfo.rent) || 0;
    const exp = _monthlyPropExpenses(tenantInfo.expenses);
    const months = _leaseActiveMonths(tenantInfo);
    annualRentOnly += rent * months;
    annualRentExpenses += exp * months;
  }
  const annualIncome = round2(annualRentOnly + annualRentExpenses);

  // How much of that income is projection (remaining months after today):
  // actuals are rent × months-elapsed-so-far; projected = total − actuals.
  let actualIncomeMonths = 0;
  for (const unit of building.units || []) {
    const pid =
      typeof unit.propertyId === 'string'
        ? unit.propertyId
        : unit.propertyId?._id;
    if (!pid) continue;
    const tenantInfo = tenantsByPropertyId.get(pid);
    if (!tenantInfo) continue;
    const rent = Number(tenantInfo.rent) || 0;
    const exp = _monthlyPropExpenses(tenantInfo.expenses);
    const totalMonths = _leaseActiveMonths(tenantInfo);
    // Active months elapsed so far (Jan..currentMonth, clamped to lease window)
    const b = tenantInfo.beginDate
      ? moment.utc(tenantInfo.beginDate, 'DD/MM/YYYY', true)
      : null;
    const startMonth = b && b.isValid() ? b.month() + 1 : 1;
    const startYear = b && b.isValid() ? b.year() : currentYear;
    const fromMonth = startYear < currentYear ? 1 : startMonth;
    const elapsedTo = Math.min(currentMonthIdx, fromMonth + totalMonths - 1);
    const elapsed = Math.max(0, elapsedTo - fromMonth + 1);
    actualIncomeMonths += (rent + exp) * elapsed;
  }
  const annualIncomeProjected = round2(
    Math.max(0, annualIncome - round2(actualIncomeMonths))
  );

  // ── Owner expenses projection ──────────────────────────────────────────
  // Fixed recurring owner-tracked × active months
  const _recurringFixed = (building.expenses || []).filter(
    (e) =>
      (e.isRecurring ?? e.recurring) &&
      expenseMonthlyCost(e) > 0 &&
      isExpenseActiveForTerm(e, currentTerm)
  );

  // Fixed owner portion: expenses with trackOwnerExpense + ownerAmount > 0
  let fixedOwnerProrated = 0;
  for (const e of _recurringFixed) {
    if (e.trackOwnerExpense && Number(e.ownerAmount) > 0) {
      fixedOwnerProrated +=
        Number(e.ownerAmount) * expenseActiveMonths(e, currentYear);
    }
  }

  // Variable owner expenses (κυμαινόμενα): actuals + 3-month-avg × remaining
  let variableOwnerYtd = 0;
  let variableOwnerProjected = 0;
  const _isVariableExpense = (e: ExpenseLike): boolean =>
    !!(e.isRecurring ?? e.recurring) && expenseMonthlyCost(e) === 0;
  for (const e of (building.expenses || []).filter(_isVariableExpense)) {
    if (!e.trackOwnerExpense) continue;
    const perTerm = new Map<number, number>();
    for (const unit of building.units || []) {
      for (const c of unit.monthlyCharges || []) {
        const inYear =
          Math.floor(Number(c.term || 0) / 1000000) === currentYear;
        const matches =
          String(c.expenseId) === String(e._id) || c.description === e.name;
        if (!inYear || !matches) continue;
        const slot = perTerm.get(c.term!) || 0;
        perTerm.set(c.term!, Math.max(slot, Number(c.inputAmount ?? c.amount) || 0));
      }
    }
    const entered = [...perTerm.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    const ownerRatio =
      expenseMonthlyCost(e) > 0
        ? Number(e.ownerAmount) / expenseMonthlyCost(e)
        : 1;
    const actual = entered.reduce((s, v) => s + v * ownerRatio, 0);
    variableOwnerYtd += actual;
    const activeMonths = expenseActiveMonths(e, currentYear);
    const remaining = Math.max(0, activeMonths - entered.length);
    if (remaining > 0 && entered.length > 0) {
      const last3 = entered.slice(-3);
      const avg = last3.reduce((s, v) => s + v, 0) / last3.length;
      variableOwnerProjected += avg * ownerRatio * remaining;
    }
  }

  // Recorded owner eksoda this year (from ownerMonthlyExpenses — repair-vacant,
  // owner-resident, vacant shares) — these are actuals, no projection.
  const ownerLedgerThisYear = (building.ownerMonthlyExpenses || []).filter(
    (e) => Math.floor(Number(e.term || 0) / 1000000) === currentYear
  );
  // For recurring expenses, project across active months (same logic as client).
  const _expByIdMap = new Map<string, ExpenseLike>();
  for (const e of building.expenses || []) {
    if (e._id) _expByIdMap.set(String(e._id), e);
  }
  let vacantOwnerResidentEksoda = 0;
  for (const row of ownerLedgerThisYear) {
    if (row.source !== 'vacant' && row.source !== 'owner-resident') continue;
    const exp = row.expenseId ? _expByIdMap.get(String(row.expenseId)) : null;
    const isRecurring = exp && (exp.isRecurring ?? exp.recurring);
    const isVariable = isRecurring && expenseMonthlyCost(exp!) === 0;
    const months =
      isRecurring && !isVariable ? expenseActiveMonths(exp!, currentYear) : 1;
    vacantOwnerResidentEksoda += (Number(row.amount) || 0) * months;
  }

  const annualOwnerExpenses = round2(
    fixedOwnerProrated + variableOwnerYtd + variableOwnerProjected + vacantOwnerResidentEksoda
  );
  // The projected portion (future months only):
  const annualOwnerExpensesProjected = round2(variableOwnerProjected);

  return {
    annualIncome,
    annualIncomeProjected,
    annualOwnerExpenses,
    annualOwnerExpensesProjected
  };
}
