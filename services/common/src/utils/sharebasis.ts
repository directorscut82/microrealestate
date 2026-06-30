// Shared calc-basis builder — the SINGLE source of the per-unit allocation
// equation ("100,00 € ÷ 11 μονάδες = 9,09 €", "unit surface 50 m² ÷ 600 m² ×
// cost 120 € = 10 €", "cost 100 € × owner share 50% = 50 €", …).
//
// It used to live only in the api rent-engine (businesslogic/tasks/1_base.ts),
// so the ΧΡΕΩΣΕΙΣ panel could show the equation but the PDF generator (a
// SEPARATE service that depends on `common`, not `api`) could not. Relocated
// here so the receipt / owner-statement PDF and the on-screen breakdown render
// the IDENTICAL equation from one implementation (no drift). The api engine
// imports `shareBasis`/`equalPartyCount` back from here.
//
// IMPORTANT: `common` has NO moment dependency (see ownerstatement.ts). All
// date math here is moment-free — parse to UTC year*100+month via Date.

export type ShareBasis = {
  kind:
    | 'equal'
    | 'surface'
    | 'thousandths'
    | 'fixed'
    | 'single_unit'
    | 'custom_ratio'
    | 'custom_percentage'
    | 'repair_split'
    | 'repair_vacant'
    | 'none';
  count?: number; // equal: number of PARTIES splitting (tenants + vacant units)
  part?: number; // surface m² / thousandths ‰ / custom ratio share / custom % for this unit
  whole?: number; // total surface / total thousandths / sum of custom ratios
  total?: number; // the expense amount being split
  share?: number; // the resulting per-unit euro amount (the "= X €" tail)
  ownerPct?: number; // repair_split: owner share % (= 100 − tenantPct)
  tenantPct?: number; // repair_vacant: tenant share %
  pool?: number; // repair_vacant: the tenant pool (cost × tenantPct%)
  result?: number; // repair_*: the resulting euro (mirrors `share`)
  allocKind?: string; // repair_vacant per-unit divisor: 'surface' | 'thousandths' | 'equal'
};

const _round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// moment-free: parse a date-ish value to UTC YYYYMM as an integer year*100+month.
function _toYM(d: any): number | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime())
    ? null
    : dt.getUTCFullYear() * 100 + (dt.getUTCMonth() + 1);
}

// Whether a tenant-group is active for `term` (and the given propertyId's
// per-property window). Moved verbatim from 1_base._isGroupActiveForTerm but
// moment-free. `term` is YYYYMMDDHH.
export function isGroupActiveForTerm(
  group: any,
  term: number,
  propertyId: string
): boolean {
  if (!group) return false;
  if (!term) return true;
  const ym = Math.floor(Number(term) / 10000); // YYYYMM

  const begin = _toYM(group.beginDate);
  const end = _toYM(group.endDate);
  const termination = _toYM(group.terminationDate);
  if (begin !== null && ym < begin) return false;
  if (end !== null && ym > end) return false;
  if (termination !== null && ym > termination) return false;

  const props = (group.properties || []) as any[];
  const myProp = props.find(
    (p) => String(p.propertyId) === String(propertyId)
  );
  if (myProp) {
    const entry = _toYM(myProp.entryDate);
    const exit = _toYM(myProp.exitDate);
    if (entry !== null && ym < entry) return false;
    if (exit !== null && ym > exit) return false;
  }
  return true;
}

// The equal-allocation PARTY COUNT for a term: the number of distinct shares
// the pool splits into (active tenant-groups + vacant managed units), matching
// the divisor computeBuildingChargeForProperty uses. Falls back to managed-unit
// count when no tenant groups are attached. Moved verbatim from
// 1_base._equalPartyCount (moment-free).
export function equalPartyCount(building: any, term?: number): number {
  const managed = (building.units || []).filter((u: any) => u.propertyId);
  const rawGroups = (building as any)._tenantGroups as any[] | undefined;
  if (!rawGroups || rawGroups.length === 0) return managed.length;
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
          isGroupActiveForTerm(g, term, pid)
        )
      )
    : normalized;
  const occupied = new Set<string>(
    activeGroups.flatMap((g: any) =>
      (g.propertyIds || [])
        .filter((pid: string) =>
          term ? isGroupActiveForTerm(g, term, String(pid)) : true
        )
        .map((pid: string) => String(pid))
    )
  );
  const vacantCount = managed.filter(
    (u: any) => !occupied.has(String(u.propertyId))
  ).length;
  return activeGroups.length + vacantCount;
}

// Build the calc-basis for ONE unit's share of an expense. Moved verbatim from
// 1_base._shareBasis. `partyCount` is the real equal-divisor for the term (pass
// equalPartyCount(building, term)); when omitted, equal falls back to managed
// unit count.
export function shareBasis(
  building: any,
  unit: any,
  expense: any,
  total: number,
  share: number,
  partyCount?: number
): ShareBasis {
  const method = expense.allocationMethod || 'equal';
  const managed = (building.units || []).filter((u: any) => u.propertyId);
  const fmt = (n: number) => _round(n);
  switch (method) {
    case 'by_surface': {
      const sumS = managed.reduce(
        (s: number, u: any) => s + (Number(u.surface) || 0),
        0
      );
      return {
        kind: 'surface',
        part: fmt(unit.surface || 0),
        whole: fmt(sumS),
        total: fmt(total),
        share: fmt(share)
      };
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
      const sumT = (building.units || []).reduce(
        (s: number, u: any) => s + (Number(u[key]) || 0),
        0
      );
      return {
        kind: 'thousandths',
        part: fmt(unit[key] || 0),
        whole: fmt(sumT),
        total: fmt(total),
        share: fmt(share)
      };
    }
    case 'equal':
      return {
        kind: 'equal',
        count: partyCount != null ? partyCount : managed.length,
        total: fmt(total),
        share: fmt(share)
      };
    case 'fixed':
      return { kind: 'fixed', share: fmt(share) };
    case 'single_unit':
      return { kind: 'single_unit', share: fmt(share) };
    case 'custom_ratio': {
      const allocs = expense.customAllocations || [];
      const mine = allocs.find(
        (a: any) => String(a.propertyId) === String(unit.propertyId)
      );
      const whole = allocs.reduce(
        (s: number, a: any) => s + (Number(a.value) || 0),
        0
      );
      return {
        kind: 'custom_ratio',
        part: Number(mine?.value) || 0,
        whole: fmt(whole),
        total: fmt(total),
        share: fmt(share)
      };
    }
    case 'custom_percentage': {
      const allocs = expense.customAllocations || [];
      const mine = allocs.find(
        (a: any) => String(a.propertyId) === String(unit.propertyId)
      );
      return {
        kind: 'custom_percentage',
        part: Number(mine?.value) || 0,
        total: fmt(total),
        share: fmt(share)
      };
    }
    default:
      return { kind: 'none', share: fmt(share) };
  }
}

// Tenant share % of a repair (mirrors 1_base.repairTenantSharePercentage).
function _repairTenantPct(repair: any): number {
  if (!repair) return 0;
  if (repair.chargeableTo === 'owners') return 0;
  if (
    typeof repair.tenantSharePercentage === 'number' &&
    Number.isFinite(repair.tenantSharePercentage)
  ) {
    return Math.max(0, Math.min(100, repair.tenantSharePercentage));
  }
  return repair.chargeableTo === 'tenants' ? 100 : 0;
}

// Per-unit divisor of an OWNER-amount expense (owner-fixed / variable
// 'expense') — the owner total split across managed units by the expense's
// allocation method. 'fixed' resolves to equal (no per-unit divisor). Mirrors
// buildingmanager._ownerAmountBasis.
// The `share` (= the equation's RHS) is COMPUTED from the equation's own LHS
// (total × part/whole, or total ÷ count) so the printed line is always
// self-consistent — it shows the PER-UNIT owner amount, NOT a co-owner slice.
// The co-owner suffix ("Name 50% = €X") bridges the per-unit amount to the
// individual's slice, mirroring the on-screen ΧΡΕΩΣΕΙΣ panel's parent row.
function _ownerAmountBasis(
  building: any,
  unit: any,
  method: string,
  total: number
): ShareBasis {
  const fmt = (n: number) => _round(n);
  const managed = (building.units || []).filter((u: any) => u.propertyId);
  const m = method === 'fixed' ? 'equal' : method || 'equal';
  if (m === 'by_surface') {
    const whole = managed.reduce(
      (s: number, u: any) => s + (Number(u.surface) || 0),
      0
    );
    const part = Number(unit?.surface) || 0;
    return {
      kind: 'surface',
      part: fmt(part),
      whole: fmt(whole),
      total: fmt(total),
      share: whole > 0 ? fmt((part / whole) * total) : 0
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
    const whole = (building.units || []).reduce(
      (s: number, u: any) => s + (Number(u[key]) || 0),
      0
    );
    const part = Number(unit?.[key]) || 0;
    return {
      kind: 'thousandths',
      part: fmt(part),
      whole: fmt(whole),
      total: fmt(total),
      share: whole > 0 ? fmt((part / whole) * total) : 0
    };
  }
  const count = managed.length;
  return {
    kind: 'equal',
    count,
    total: fmt(total),
    share: count > 0 ? fmt(total / count) : 0
  };
}

// Calc-basis for ONE owner-ledger charge (ownerMonthlyExpenses row) so the
// owner-statement PDF shows the SAME equation as the ΧΡΕΩΣΕΙΣ panel. Mirrors
// the owner-side basis logic in buildingmanager.getExpenseBreakdown. Resolves
// the source expense/repair from the building so it never needs the api engine.
//   charge: { expenseId, source, propertyId, amount }
// Returns null when no meaningful basis applies (legacy/zero-cost rows).
// NOTE on co-owned charges: a charge passed here may be a single co-owner's
// SLICE (e.g. €25 = €50 owner pool × 50%). The basis equation always shows the
// SELF-CONSISTENT per-unit/whole owner figure (€50), and the caller renders a
// co-owner suffix "(Name 50% = €25, …)" to bridge to the individual — exactly
// like the on-screen ΧΡΕΩΣΕΙΣ panel's parent row + indented children. So the
// equation's RHS is NEVER the sliced amount; it is computed from its own LHS.
export function ownerChargeBasis(building: any, charge: any): ShareBasis | null {
  if (!building || !charge) return null;
  const source = charge.source || 'expense';
  const managed = (building.units || []).filter((u: any) => u.propertyId);
  const unit = charge.propertyId
    ? (building.units || []).find(
        (u: any) => String(u.propertyId) === String(charge.propertyId)
      )
    : null;

  // Per-unit OWNER-amount expense (owner-fixed / variable 'expense').
  if ((source === 'owner-fixed' || source === 'expense') && charge.propertyId && unit) {
    const exp = (building.expenses || []).find(
      (e: any) => String(e._id) === String(charge.expenseId)
    );
    // The owner total for this expense across the units it bills (sum of the
    // owner rows sharing this expenseId) — so "÷ N" reflects the owner pool.
    const ownerTotal = _round(
      (building.ownerMonthlyExpenses || [])
        .filter(
          (e: any) =>
            String(e.expenseId) === String(charge.expenseId) &&
            (e.source === 'owner-fixed' || e.source === 'expense')
        )
        .reduce((s: number, e: any) => s + (Number(e.amount) || 0), 0)
    );
    if (ownerTotal > 0) {
      return _ownerAmountBasis(
        building,
        unit,
        exp?.allocationMethod || 'equal',
        ownerTotal
      );
    }
    return null;
  }

  // Repair rows: resolve the repair to derive cost × pct.
  const rep = (building.repairs || []).find(
    (r: any) => String(r._id) === String(charge.expenseId)
  );
  if (!rep) return null;
  const cost = Number(rep.actualCost) || Number(rep.estimatedCost) || 0;
  if (!(cost > 0)) return null;
  const tenantPct = _repairTenantPct(rep);

  if (source === 'repair') {
    const ownerPct = 100 - tenantPct;
    // RHS computed from the LHS (cost × owner%), NOT the co-owner slice.
    return {
      kind: 'repair_split',
      total: _round(cost),
      ownerPct,
      result: _round(cost * (ownerPct / 100))
    };
  }
  if (source === 'repair-vacant') {
    const pool = _round(cost * (tenantPct / 100));
    const method = rep.allocationMethod || 'general_thousandths';
    let allocKind: string | undefined;
    let part: number | undefined;
    let whole: number | undefined;
    let count: number | undefined;
    if (method === 'by_surface') {
      allocKind = 'surface';
      part = _round(Number(unit?.surface) || 0);
      whole = _round(
        managed.reduce((s: number, u: any) => s + (Number(u.surface) || 0), 0)
      );
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
      part = _round(Number(unit?.[key]) || 0);
      whole = _round(
        (building.units || []).reduce(
          (s: number, u: any) => s + (Number(u[key]) || 0),
          0
        )
      );
    } else if (method === 'equal') {
      allocKind = 'equal';
      count = managed.length;
    }
    // result = this vacant unit's slice of the pool, computed from the divisor
    // (self-consistent), NOT a co-owner slice. The EJS renders only the first
    // line ("cost × tenants% = pool"); `result` is kept for completeness.
    let result = pool;
    if (allocKind === 'equal' && count && count > 0) result = _round(pool / count);
    else if ((allocKind === 'surface' || allocKind === 'thousandths') && whole && whole > 0)
      result = _round((Number(part) / whole) * pool);
    return {
      kind: 'repair_vacant',
      total: _round(cost),
      tenantPct,
      pool,
      result,
      allocKind,
      part,
      whole,
      count
    };
  }
  return null;
}
