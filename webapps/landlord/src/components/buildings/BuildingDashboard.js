import {
  fetchProperties,
  fetchTenants,
  QueryKeys
} from '../../utils/restcalls';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { Progress } from '../ui/progress';
import { cn } from '../../utils';
import { LuBuilding2, LuCar, LuHome, LuUser } from 'react-icons/lu';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { Button } from '../ui/button';
import UncollectedPaymentDialog from './UncollectedPaymentDialog';
import { useContext, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';
import { StoreContext } from '../../store';

// Mirror services/api/src/businesslogic/tasks/1_base.ts :: isExpenseActiveForTerm —
// must agree with the rent-pipeline check so the dashboard headline matches what
// is actually being billed. Recurring expenses honor [startTerm, endTerm];
// one-time expenses match by YYYYMM (Wave-18 B1).
function isExpenseActiveForTerm(expense, term) {
  if (!(expense.isRecurring ?? expense.recurring)) {
    if (!expense.startTerm) return false;
    if (Math.floor(expense.startTerm / 10000) !== Math.floor(term / 10000)) {
      return false;
    }
    return true;
  }
  // Step-7 DASH-ACTIVEFORTERM-GRANULARITY: compare the recurring window at
  // MONTH (YYYYMM) granularity, matching the server's authoritative check
  // (1_base.ts isExpenseActiveForTerm). currentTerm is YYYYMM0100, so a
  // recurring expense persisted with a mid-month startTerm (day != 01, possible
  // via seed/legacy/import) was wrongly excluded at full YYYYMMDDHH granularity
  // → under-reported recurring eksoda + over-reported Net. (Same fix the
  // owner-tile path already uses via _activeForTermMonthH3.)
  const ymTerm = Math.floor(Number(term) / 10000);
  if (expense.startTerm && ymTerm < Math.floor(Number(expense.startTerm) / 10000))
    return false;
  if (expense.endTerm && ymTerm > Math.floor(Number(expense.endTerm) / 10000))
    return false;
  return true;
}

const OCCUPANCY_CONFIG = {
  rented: {
    label: 'Rented',
    color: 'bg-green-500',
    textColor: 'text-green-700',
    bgColor: 'bg-green-50',
    icon: LuUser
  },
  owner_occupied: {
    label: 'Owner occupied',
    color: 'bg-blue-500',
    textColor: 'text-blue-700',
    bgColor: 'bg-blue-50',
    icon: LuHome
  },
  vacant: {
    label: 'Vacant',
    color: 'bg-muted-foreground',
    textColor: 'text-muted-foreground',
    bgColor: 'bg-muted/30',
    icon: LuBuilding2
  },
  parking: {
    label: 'Parking',
    color: 'bg-amber-500',
    textColor: 'text-amber-700',
    bgColor: 'bg-amber-50',
    icon: LuCar
  }
};

function OccupancyBadge({ type }) {
  const { t } = useTranslation('common');
  const config = OCCUPANCY_CONFIG[type] || OCCUPANCY_CONFIG.vacant;
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 font-normal', config.textColor, config.bgColor)}
    >
      <span className={cn('h-2 w-2 rounded-full', config.color)} />
      {t(config.label)}
    </Badge>
  );
}

function FloorLabel({ floor }) {
  const { t } = useTranslation('common');
  if (floor === -1 || floor === null || floor === undefined) {
    return <span className="text-muted-foreground">{t('Basement')}</span>;
  }
  if (floor === 0) {
    return <span>{t('Ground floor')}</span>;
  }
  return (
    <span>
      {t('Floor')} {floor}
    </span>
  );
}

export default function BuildingDashboard({ building }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  // §5: dialog for recording a voluntary contribution toward the Αχρέωτα.
  const [uncollectedDialogOpen, setUncollectedDialogOpen] = useState(false);
  // B1/B2: locale-aware plain-decimal formatter (NOT currency, NOT the ×100
  // percent path). Used for τ.μ. surfaces (70,05) and owner % (33,33%) so the
  // whole screen follows the org locale's decimal separator instead of a raw
  // JS dot. Up to 2 decimals, trailing zeros trimmed.
  const _locale = store?.organization?.selected?.locale || undefined;
  const fmtNum = (v) =>
    Number(v).toLocaleString(_locale, { maximumFractionDigits: 2 });

  // A7: dual repair status.
  //  (1) WORK badge — the manual status enum (planned/in_progress/completed/
  //      cancelled).
  //  (2) MONEY badge — DERIVED: Πληρωμένη (fully collected) / Εκκρεμεί
  //      (uncollected, term not yet passed) / Εκπρόθεσμη (uncollected AND the
  //      chargeTerm/completionDate has passed). Owner-side paid is read from the
  //      building's ownerMonthlyExpenses repair rows (source repair/repair-vacant
  //      with this repairId). The TENANT repair-share has NO per-charge paid
  //      field (monthlyCharges; deferred-decisions D-9), so the money badge
  //      reflects the OWNER side only — it does not claim anything about
  //      tenant-side collection it cannot see.
  const _workStatusLabel = (status) => {
    switch (status) {
      case 'in_progress':
        return t('In progress');
      case 'completed':
        return t('Completed');
      case 'cancelled':
        return t('Cancelled');
      default:
        return t('Planned');
    }
  };
  const _repairMoneyBadge = (repair) => {
    const repairId = String(repair._id || '');
    const rows = (building?.ownerMonthlyExpenses || []).filter(
      (e) =>
        String(e.expenseId) === repairId &&
        (e.source === 'repair' || e.source === 'repair-vacant')
    );
    // No materialised owner rows → nothing owner-side to settle; no money badge.
    if (rows.length === 0) return null;
    const owed = rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const paid = rows.reduce(
      (s, e) =>
        s +
        Math.min(
          (e.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0),
          Number(e.amount) || 0
        ),
      0
    );
    if (paid >= owed - 0.005 && owed > 0) {
      return { key: 'paid', label: t('Paid'), cls: 'bg-olive/15 text-olive' };
    }
    // time check: has the charge term / completion date passed?
    const term = Number(repair.completionDate
      ? moment(repair.completionDate).format('YYYYMM')
      : String(repair.chargeTerm || '').slice(0, 6));
    const nowYM = Number(moment().format('YYYYMM'));
    const overdue = term > 0 && term < nowYM;
    return overdue
      ? { key: 'overdue', label: t('Overdue'), cls: 'bg-oxide/15 text-oxide' }
      : { key: 'pending', label: t('Pending'), cls: 'bg-stone text-ink-muted' };
  };

  const { data: properties } = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties
  });

  const { data: tenants } = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: () => fetchTenants()
  });

  // Build lookup maps
  const propertyMap = useMemo(() => {
    const map = new Map();
    if (properties) {
      properties.forEach((p) => map.set(p._id, p));
    }
    return map;
  }, [properties]);

  const tenantByPropertyId = useMemo(() => {
    const map = new Map();
    if (tenants) {
      tenants.forEach((tenant) => {
        // E22: skip terminated / archived tenants so the building view's
        // "Tenant / Occupant" column doesn't keep showing a person who
        // has already moved out. Without this filter the dashboard
        // claimed a unit was rented even after termination, masking the
        // vacancy from the operator until they navigated to the tenant
        // record itself.
        if (tenant.terminated || tenant.archived) return;
        if (tenant.properties) {
          tenant.properties.forEach((tp) => {
            map.set(tp.propertyId, {
              name: tenant.name,
              rent: tp.rent,
              tenantId: tenant._id,
              // E1: the tenant's δαπάνες επί ενοικίου for this property — these
              // are charged to the tenant ON TOP of base rent, so the building
              // income projection must include them, not rent alone.
              expenses: Array.isArray(tp.expenses) ? tp.expenses : []
            });
          });
        }
      });
    }
    return map;
  }, [tenants]);

  const tenantById = useMemo(() => {
    const map = new Map();
    if (tenants) {
      tenants.forEach((tenant) => map.set(tenant._id, tenant));
    }
    return map;
  }, [tenants]);

  // Sort units by floor, then by surface
  const sortedUnits = useMemo(() => {
    if (!building?.units) return [];
    return [...building.units].sort((a, b) => {
      const fa = a.floor ?? -99;
      const fb = b.floor ?? -99;
      if (fa !== fb) return fa - fb;
      return (b.surface || 0) - (a.surface || 0);
    });
  }, [building?.units]);

  // Group by floor for summary
  const floorSummary = useMemo(() => {
    const floors = new Map();
    sortedUnits.forEach((unit) => {
      const floor = unit.floor ?? -1;
      if (!floors.has(floor)) floors.set(floor, []);
      floors.get(floor).push(unit);
    });
    return floors;
  }, [sortedUnits]);

  // Stats
  const stats = useMemo(() => {
    const s = { total: 0, rented: 0, ownerOccupied: 0, vacant: 0, parking: 0 };
    sortedUnits.forEach((unit) => {
      s.total++;
      const occ = unit.occupancyType || 'vacant';
      if (occ === 'rented') s.rented++;
      else if (occ === 'owner_occupied') s.ownerOccupied++;
      else if (occ === 'parking') s.parking++;
      else s.vacant++;
    });
    return s;
  }, [sortedUnits]);

  // Annual esoda / eksoda summary for this building.
  // Esoda  = sum of monthly rent across all currently-rented units × 12.
  // Eksoda = recurring building expenses ×12 + one-time expenses
  //          + tenant-distributed portion of repairs (from unit.monthlyCharges
  //            with repairId set — owner-portion already lands in
  //            ownerMonthlyExpenses via Stage 1 I-3.f, so we must NOT also
  //            count repair.actualCost/estimatedCost wholesale)
  //          + owner expenses (ownerMonthlyExpenses entries +
  //            sum(BuildingExpense.ownerAmount) ×12 for recurring fixed
  //            owner-tracked expenses active for the current period).
  // Owner-occupied + parking units contribute zero esoda but still incur
  // their share of any owner-tracked expenses.
  const finance = useMemo(() => {
    const _now = moment();
    // E1: a tenant's δαπάνες-επί-ενοικίου for the CURRENT month — windowed by
    // each expense's [beginDate,endDate] at month granularity, mirroring the
    // rent engine (frontdata.ts toOccupantData / 1_base.ts) so a one-time /
    // sub-period expense doesn't inflate the monthly figure outside its window.
    const _monthlyPropExpenses = (expenses) =>
      (Array.isArray(expenses) ? expenses : [])
        .filter((e) => {
          if (!e?.beginDate && !e?.endDate) return true;
          // Step-7 E1-DATE-MISPARSE: the API serves these as DD/MM/YYYY STRINGS
          // (frontdata.toOccupantData formats them), so a bare moment(str)
          // misparses (US MM/DD fallback; day>12 → Invalid → wrongly kept).
          // Parse with the explicit format + strict, exactly like the server
          // (frontdata.ts uses moment.utc(e.beginDate,'DD/MM/YYYY')).
          const begin = e.beginDate
            ? moment(e.beginDate, 'DD/MM/YYYY', true)
            : null;
          const end = e.endDate ? moment(e.endDate, 'DD/MM/YYYY', true) : null;
          if (begin && !begin.isValid()) return true;
          if (end && !end.isValid()) return true;
          if (begin && _now.isBefore(begin, 'month')) return false;
          if (end && _now.isAfter(end, 'month')) return false;
          return true;
        })
        .reduce((s, e) => s + (Number(e.amount) || 0), 0);

    // Income = base rent + δαπάνες επί ενοικίου (both charged to the tenant).
    const monthlyEsoda = sortedUnits.reduce((sum, unit) => {
      if (!unit.propertyId) return sum;
      const property = propertyMap.get(
        typeof unit.propertyId === 'string' ? unit.propertyId : unit.propertyId?._id
      );
      const tenantInfo = property ? tenantByPropertyId.get(property._id) : null;
      if (!tenantInfo) return sum;
      return (
        sum +
        (Number(tenantInfo.rent) || 0) +
        _monthlyPropExpenses(tenantInfo.expenses)
      );
    }, 0);

    // Current term in YYYYMMDDHH so we can ask isExpenseActiveForTerm whether
    // an expense's [startTerm, endTerm] window covers "now". Using local
    // moment matches the rent-pipeline projection in 1_base.ts (which
    // operates on rent.term).
    const currentTerm = Number(
      moment().startOf('month').format('YYYYMMDDHH')
    );

    // The headline reads "Annual projection". Every additive stream below
    // MUST be scoped to either (a) the current term (for the ×12 monthly
    // streams) or (b) the current calendar year (for the lifetime
    // ledgers). Without this scoping the figure becomes a hidden
    // lifetime sum and inflates monotonically for multi-year buildings —
    // a class of regression caught in the F1/F2/F3 dashboard audit.
    // Term shape is YYYYMMDDHH; floor by 1e6 yields the year.
    const currentYear = Math.floor(currentTerm / 1000000);

    // Wave-24 A13: legacy seed data persists this flag as `recurring`
    // (without the is- prefix). Read both so existing buildings show the
    // correct totals after upgrade — the new schema field shadows the
    // legacy one when both happen to be set.
    //
    // F2-buildingdash: gate recurring on isExpenseActiveForTerm — without
    // this, terminated expenses (endTerm < currentTerm) and not-yet-started
    // expenses (startTerm > currentTerm) inflate the headline.
    // The effective monthly cost of an expense. For most methods this is
    // `amount`. For a FIXED expense `amount` is 0 (it's a placeholder) and the
    // real monthly cost is the SUM of its per-unit customAllocations — that is
    // exactly what the rent engine bills (1_base.ts 'fixed' case returns each
    // unit's customAllocations value). Without this, a fixed expense (e.g.
    // Ρεύμα split €40+€10 per unit) contributed €0 to the headline and the
    // building under-reported its annual expenses by the entire fixed cost.
    const _expenseMonthlyCost = (e) => {
      if (e.allocationMethod === 'fixed') {
        return (e.customAllocations || []).reduce(
          (s, a) => s + (Number(a.value) || 0),
          0
        );
      }
      return Number(e.amount) || 0;
    };
    const recurringMonthlyEksoda = (building?.expenses || [])
      .filter(
        (e) =>
          (e.isRecurring ?? e.recurring) &&
          _expenseMonthlyCost(e) > 0 &&
          isExpenseActiveForTerm(e, currentTerm)
      )
      .reduce((sum, e) => sum + _expenseMonthlyCost(e), 0);
    // A6: κυμαινόμενα (variable) recurring expenses have amount 0 — their real
    // monthly figure is the landlord-typed `inputAmount` saved per term on the
    // unit monthlyCharges. They are NOT a ×12 projection (each month differs), so
    // we sum the ACTUAL typed totals for the CURRENT YEAR ("φέτος μέχρι σήμερα").
    // Per (expenseId, term) take inputAmount ONCE — every per-unit share carries
    // the same inputAmount (buildingmanager.saveMonthlyStatement) — with a legacy
    // fallback of summing the per-unit shares when inputAmount is absent. Mirrors
    // BuildingExpensePanel's per-term variable read so the two never disagree.
    const _isVariableExpense = (e) =>
      (e.isRecurring ?? e.recurring) && _expenseMonthlyCost(e) === 0;
    const variableYtdEksoda = (building?.expenses || [])
      .filter(_isVariableExpense)
      .reduce((sum, e) => {
        const perTerm = new Map(); // term -> { input: number|null, shareSum }
        for (const unit of building?.units || []) {
          for (const c of unit.monthlyCharges || []) {
            const inYear =
              Math.floor(Number(c.term || 0) / 1000000) === currentYear;
            const matches =
              String(c.expenseId) === String(e._id) ||
              c.description === e.name;
            if (!inYear || !matches) continue;
            const slot = perTerm.get(c.term) || { input: null, shareSum: 0 };
            if (c.inputAmount != null) slot.input = Number(c.inputAmount) || 0;
            else slot.shareSum += Number(c.amount) || 0;
            perTerm.set(c.term, slot);
          }
        }
        let exTotal = 0;
        for (const slot of perTerm.values()) {
          exTotal += slot.input != null ? slot.input : slot.shareSum;
        }
        return sum + exTotal;
      }, 0);
    // F3-buildingdash: gate one-time expenses on currentYear — a one-time
    // expense saved in 2018 must not appear in the 2026 headline.
    const oneTimeEksoda = (building?.expenses || [])
      .filter(
        (e) =>
          !(e.isRecurring ?? e.recurring) &&
          _expenseMonthlyCost(e) > 0 &&
          Math.floor(Number(e.startTerm || 0) / 1000000) === currentYear
      )
      .reduce((sum, e) => sum + _expenseMonthlyCost(e), 0);
    // Stage 1 I-3.f: tenant share of repairs is materialized as
    // unit.monthlyCharges entries (one per unit per term, repairId set).
    // F1-buildingdash: filter to currentYear charges — without this the
    // sum spans the lifetime per-unit ledger and inflates the headline.
    const repairEksoda = (building?.units || []).reduce((sum, unit) => {
      const charges = unit.monthlyCharges || [];
      return (
        sum +
        charges
          .filter(
            (c) =>
              c.repairId &&
              Math.floor(Number(c.term || 0) / 1000000) === currentYear
          )
          .reduce((s, c) => s + (Number(c.amount) || 0), 0)
      );
    }, 0);
    // Owner expenses comprise three additive streams (no overlap between them):
    //  1. ownerMonthlyExpenses entries — variable owner amounts entered per
    //     term via MonthlyStatement, plus owner-portion of repairs (Stage 1).
    //  2. BuildingExpense.ownerAmount where trackOwnerExpense+isRecurring —
    //     the fixed monthly owner-only portion of a recurring expense, which
    //     is NEVER persisted to ownerMonthlyExpenses (those rows are reserved
    //     for variable amounts). Without this projection the dashboard
    //     undercounts by the entire fixed owner share.
    const recordedOwnerEksoda = (building?.ownerMonthlyExpenses || [])
      .filter((e) => Math.floor(Number(e.term || 0) / 1000000) === currentYear)
      // EXCLUDE the recurring-building-expense owner rows (vacant +
      // owner-resident + owner-fixed; see the three exclusions below): a vacant
      // or owner-occupied unit's share of a recurring building EXPENSE is routed
      // to the owner, but that euro is ALREADY counted once in
      // recurringMonthlyEksoda * 12 (the full expense amount). Routing changes
      // WHO pays, not the building total — counting it here too would
      // double-count the headline.
      //   We deliberately do NOT exclude source:'repair-vacant' (a vacant
      //   unit's tenant-portion share of a REPAIR routed to the owner):
      //   repairEksoda above sums only unit.monthlyCharges with a repairId,
      //   and the repair-vacant euro lives in ownerMonthlyExpenses, not
      //   monthlyCharges — so it is counted NOWHERE else. Excluding it (the
      //   old `source !== 'vacant'` was written before the two vacant kinds
      //   were disambiguated) dropped the vacant unit's repair cost from
      //   annualEksoda and over-reported Net (DASH-REPAIR-UNDERCOUNT).
      //   ALSO exclude source:'owner-fixed': the fixed owner-only amount is
      //   materialised into owner ledger rows (per term, for settlement /
      //   καταβολές), but the ANNUAL headline counts it via the
      //   fixedOwnerProrated projection below — a complete projection that
      //   does NOT depend on whether the materialiser has run for every month
      //   of the year. Counting both would double-count.
      //   ALSO exclude source:'owner-resident' — the occupancy-TWIN of
      //   'vacant': an owner-occupied unit's share of a recurring building
      //   expense routed to the resident owner. That euro is ALSO already in
      //   recurringMonthlyEksoda * 12 (the full expense amount, occupancy-
      //   blind), so counting it here too would double-count the headline,
      //   exactly like 'vacant' (June 2026 round-4 — owner-resident is now
      //   materialised flag-independently, so this exclusion is load-bearing).
      .filter(
        (e) =>
          e.source !== 'vacant' &&
          e.source !== 'owner-resident' &&
          e.source !== 'owner-fixed'
      )
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    // F4-buildingdash: prorate by the months the expense is actually
    // active in the current calendar year. A new owner-tracked expense
    // starting in July must contribute 6 months × ownerAmount, not 12 ×.
    // Same for an expense ending mid-year — only the months that fall
    // inside [Jan 1 of currentYear .. Dec 31 of currentYear] count.
    const fixedOwnerProrated = (building?.expenses || [])
      .filter(
        (e) =>
          e.trackOwnerExpense &&
          (e.isRecurring ?? e.recurring) &&
          Number(e.ownerAmount) > 0 &&
          isExpenseActiveForTerm(e, currentTerm)
      )
      .reduce((sum, e) => {
        const startMonth = e.startTerm
          ? Math.floor((Number(e.startTerm) % 1000000) / 10000) // YYYYMMDDHH → MM
          : 1;
        const endMonth = e.endTerm
          ? Math.floor((Number(e.endTerm) % 1000000) / 10000)
          : 12;
        const startYear = e.startTerm
          ? Math.floor(Number(e.startTerm) / 1000000)
          : currentYear;
        const endYear = e.endTerm
          ? Math.floor(Number(e.endTerm) / 1000000)
          : currentYear;
        const fromMonth = startYear < currentYear ? 1 : startMonth;
        const toMonth = endYear > currentYear ? 12 : endMonth;
        const months = Math.max(0, toMonth - fromMonth + 1);
        return sum + (Number(e.ownerAmount) || 0) * months;
      }, 0);
    const ownerEksoda = recordedOwnerEksoda + fixedOwnerProrated;

    // Owner-side paid vs unpaid (current calendar year). Drives the progress
    // tile under the income card. Settlement is DERIVED from each row's
    // καταβολές: paidAmount = Σ payments.amount (partial payments count), and
    // the row's outstanding = amount − paidAmount. Every owner-liability source
    // is settleable now (expense, repair, vacant, repair-vacant, AND the
    // materialised owner-fixed) — they all appear in the ledger and the owner
    // pays them via owner καταβολές. ownerLedgerTotal is the sum of the rows'
    // amounts; ownerPaid the sum of payments; ownerUnpaid the remainder.
    // Round-1 audit H3 (+ Step-7): drop STALE vacant/owner-resident rows before
    // summing, mirroring the read-side predicate
    // (OwnerStatement.isOwnerExpenseRowStale) so this tile can't inflate the
    // owner liability past every other surface. We drop ONLY the deterministic,
    // TERM-INDEPENDENT stale conditions: source expense gone /
    // chargeOwnerWhenVacant off (vacant) / expense inactive for the row's term.
    // We deliberately DO NOT apply an occupancy-based drop here: the client has
    // only CURRENT occupancy (tenantByPropertyId), not the per-(propertyId,term)
    // occupancy the server uses — a current move-IN would otherwise wrongly
    // erase a genuinely-owed PAST-term owner-resident row (Step-7 H3). The
    // server's _aggregateOwners already drops occupancy-stale rows term-anchored;
    // this tile only needs the expense-existence/flag/active checks. NEVER drop
    // a row carrying recorded καταβολές — that money is real.
    const _expByIdH3 = new Map(
      (building?.expenses || []).map((x) => [String(x._id), x])
    );
    // Match the SERVER's owner-side activeness predicate
    // (OwnerStatement.isExpenseActiveForTermMonth) at YYYYMM granularity. The
    // shared isExpenseActiveForTerm above compares recurring startTerm at full
    // YYYYMMDDHH granularity — but an owner row's term is always start-of-month
    // (YYYYMM0100), so a recurring expense with a mid-month startTerm (day != 01,
    // e.g. 2026011500) would make `rowTerm(2026010100) < startTerm` TRUE and
    // wrongly drop a row the server KEEPS (Step-7 H3-v2 undercount). Compare at
    // month granularity here so the tile agrees with the ledger/statement.
    const _activeForTermMonthH3 = (exp, term) => {
      const ymTerm = Math.floor(Number(term) / 10000); // YYYYMMDDHH → YYYYMM
      if (exp.startTerm && ymTerm < Math.floor(Number(exp.startTerm) / 10000))
        return false;
      if (exp.endTerm && ymTerm > Math.floor(Number(exp.endTerm) / 10000))
        return false;
      return true;
    };
    const _isOwnerRowStaleH3 = (e) => {
      const src = e.source || 'expense';
      if (src !== 'vacant' && src !== 'owner-resident') return false;
      const hasPayments = (e.payments || []).some(
        (p) => Number(p && p.amount) > 0
      );
      if (hasPayments) return false;
      const exp = _expByIdH3.get(String(e.expenseId));
      if (!exp) return true; // source expense gone
      if (src === 'vacant' && !exp.chargeOwnerWhenVacant) return true;
      if (!_activeForTermMonthH3(exp, Number(e.term))) return true;
      return false;
    };
    const ownerLedgerThisYear = (building?.ownerMonthlyExpenses || []).filter(
      (e) =>
        Math.floor(Number(e.term || 0) / 1000000) === currentYear &&
        !_isOwnerRowStaleH3(e)
    );
    // Per-row paid amount = Σ recorded καταβολές, OR the full amount when the
    // row carries the manual paid flag (paid:true) with no payment record.
    // Bridging both keeps old checkbox-marked-paid rows (paid via the now-
    // removed breakdown toggle, flag carried forward, no payments[]) counted
    // as paid alongside new payment-recorded settlements — no interim
    // regression while the owner-debt tab (which records καταβολές) is built.
    const _rowAmount = (e) => Number(e.amount) || 0;
    const _rowPaidAmount = (e) => {
      const fromPayments = (e.payments || []).reduce(
        (s, p) => s + (Number(p.amount) || 0),
        0
      );
      // A 'credit' row (amount 0, καταβολές preserved when its source expense/
      // repair was deleted/shrunk) is paid VERBATIM — clamping to amount(=0)
      // hid the owner's recorded money on this tile while all four server
      // readers (eksoda, ledger, statement, dashboard rollup) counted it
      // (Step-7 round-3 reader-consistency finding). Match them here.
      if (e.source === 'credit') return fromPayments;
      const fromFlag = e.paid ? _rowAmount(e) : 0;
      return Math.min(Math.max(fromPayments, fromFlag), _rowAmount(e));
    };
    // NET same-obligation rows before totalling, mirroring the server ledger
    // (ownermanager._aggregateOwners) + statement netting. A cancel→un-cancel /
    // chargeOwnerWhenVacant OFF→ON pair leaves an inert credit {amount 0, paid X}
    // beside a re-opened liability {amount X, paid 0} for the SAME obligation
    // (expenseId|term|propertyId). Summing each row's own amount/paid would
    // DOUBLE-COUNT the denominator (X credit + X liability = 2X owed) and show a
    // phantom half-paid bar. Collapse each obligation group to one effective
    // {amount = Σamount, paid = min(Σpaid, Σamount)} so the tile agrees with the
    // server (Step-7 round-4 reader-disagreement / round-4 denominator finding).
    const _obKey = (e) =>
      `${String(e.expenseId)}|${String(e.term)}|${
        e.propertyId == null ? '' : String(e.propertyId)
      }`;
    const _obGroups = new Map();
    for (const e of ownerLedgerThisYear) {
      const k = _obKey(e);
      const g = _obGroups.get(k) || { amount: 0, paid: 0 };
      g.amount += _rowAmount(e);
      g.paid += _rowPaidAmount(e);
      _obGroups.set(k, g);
    }
    let ownerLedgerTotal = 0;
    let ownerPaid = 0;
    for (const g of _obGroups.values()) {
      // Denominator = the obligation's owed (Σamount), but never less than its
      // paid so a credit-only obligation (amount 0, paid X) still surfaces the
      // tile and counts its X. Paid is capped at that denominator so an
      // overpayment can't push the bar past 100%.
      const denom = Math.max(g.amount, g.paid);
      ownerLedgerTotal += denom;
      ownerPaid += Math.min(g.paid, denom);
    }
    const ownerUnpaid = Math.max(0, ownerLedgerTotal - ownerPaid);

    const annualEsoda = monthlyEsoda * 12;
    // Pass-through (paid by tenants, remitted to providers — κοινόχρηστα,
    // tenant repairs): recurring×12 + one-time + tenant-repair share. These are
    // NOT the owner's money.
    const passThroughEksoda =
      recurringMonthlyEksoda * 12 + oneTimeEksoda + repairEksoda;
    // Total building cash flow (kept for the breakdown tiles).
    const annualEksoda = passThroughEksoda + ownerEksoda;
    // Step-7 A5 fix (DASH-A5-VACANT-OWNER-SHARE): a vacant/owner-occupied unit's
    // share of a recurring/one-time building expense is genuine owner cost
    // (materialised source:'vacant'/'owner-resident'), but it is EXCLUDED from
    // ownerEksoda (correct — the FULL expense is in passThroughEksoda). Since A5
    // no longer subtracts passThrough from Net, that owner share would vanish
    // from Net. Derive it from the already-year-scoped, stale-dropped owner
    // ledger and subtract it in Net ONLY (the headline ownerEksoda column still
    // pairs with the ΕΝΟΙΚΙΑΣΤΕΣ pass-through breakdown).
    const vacantOwnerResidentEksoda = ownerLedgerThisYear
      .filter((e) => e.source === 'vacant' || e.source === 'owner-resident')
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    // A5 (user decision 2026-06-20): NET subtracts ONLY owner-borne expenses
    // (έξοδα ιδιοκτήτη) — pass-through κοινόχρηστα/tenant-repairs are the
    // tenants' money flowing to providers, never the owner's. Owner-borne =
    // ownerEksoda (direct + repairs + fixed) + the vacant/owner-resident
    // expense shares. (Future: a φόρος line subtracted too.)
    const net = annualEsoda - ownerEksoda - vacantOwnerResidentEksoda;
    // Repairs OPERATIONAL state (not just billed euros) — the overview
    // never surfaced building.repairs, so planned/in-progress/emergency
    // work was invisible until you opened the Repairs tab.
    const repairsList = building?.repairs || [];
    const repairStats = {
      planned: repairsList.filter((r) => r.status === 'planned').length,
      inProgress: repairsList.filter((r) => r.status === 'in_progress').length,
      emergencies: repairsList.filter(
        (r) =>
          r.urgency === 'emergency' &&
          (r.status === 'planned' || r.status === 'in_progress')
      ).length
    };
    repairStats.open = repairStats.planned + repairStats.inProgress;
    return {
      monthlyEsoda,
      annualEsoda,
      recurringMonthlyEksoda,
      variableYtdEksoda,
      oneTimeEksoda,
      repairEksoda,
      ownerEksoda,
      // owner-borne total used by the headline + Net so Income − this === Net
      // exactly (includes the vacant/owner-resident expense shares).
      ownerBorneTotal: ownerEksoda + vacantOwnerResidentEksoda,
      vacantOwnerResidentEksoda,
      passThroughEksoda,
      annualEksoda,
      net,
      repairStats,
      ownerPaid,
      ownerUnpaid,
      ownerLedgerTotal
    };
  }, [
    sortedUnits,
    propertyMap,
    tenantByPropertyId,
    building?.expenses,
    building?.units,
    building?.ownerMonthlyExpenses,
    building?.repairs
  ]);

  if (!building) return null;

  return (
    <div className="space-y-6">
      {/* Esoda / Eksoda summary (annual projection) — at the top so the
          landlord sees the headline financial picture before the unit list. */}
      <Card className="p-4">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-label text-muted-foreground uppercase tracking-wide">
              {t('Annual projection')}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {/* A1/A5: pure annual projection; only OWNER expenses are
                  subtracted from Net (pass-through κοινόχρηστα/tenant repairs
                  are the tenants' money). */}
              {t(
                'Annual projection based on the current state. New or changed expenses, repairs or rents in individual months will change this projection.'
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-6 text-right">
            <div>
              <div className="text-label text-muted-foreground uppercase">
                {t('Income')}
              </div>
              <div className="text-xl font-medium text-olive">
                <NumberFormat value={finance.annualEsoda} showZero />
              </div>
            </div>
            <div>
              <div className="text-label text-muted-foreground uppercase">
                {t('Owner expenses')}
              </div>
              <div className="text-xl font-medium text-oxide">
                {/* A5: the subtracted figure is owner-borne only — includes the
                    vacant/owner-resident expense shares so Income − this === Net. */}
                <NumberFormat value={finance.ownerBorneTotal} showZero />
              </div>
            </div>
            <div>
              <div className="text-label text-muted-foreground uppercase">
                {t('Net')}
              </div>
              <div
                className={cn(
                  'text-xl font-semibold',
                  // F6-buildingdash: break-even (net===0) shouldn't be
                  // colored as profit. Three-way state — green for
                  // positive, red for loss, neutral for zero.
                  finance.net > 0 && 'text-olive',
                  finance.net < 0 && 'text-oxide',
                  finance.net === 0 && 'text-ink-muted'
                )}
              >
                <NumberFormat value={finance.net} showZero />
              </div>
            </div>
          </div>
        </div>
        {(finance.annualEksoda > 0 || finance.variableYtdEksoda > 0) && (
          /* H3: variableYtdEksoda is NOT part of annualEksoda (which only sums
             fixed×12 + one-time + repairs + ownerEksoda). A building whose only
             expenses are κυμαινόμενα (variable monthly — electricity/water) thus
             had annualEksoda 0 and the whole "who pays" breakdown, including its
             real Variable YTD figure, was hidden. Surface it when either is > 0. */
          /* A5/A6 — "who pays" breakdown, two plain groups. ΕΝΟΙΚΙΑΣΤΕΣ pay the
             pass-through (κοινόχρηστα + one-time + tenant repairs) — NOT
             subtracted from Net; ΙΔΙΟΚΤΗΤΕΣ pay έξοδα ιδιοκτήτη — the only part
             subtracted from Net. */
          <div className="mt-3 pt-3 border-t border-stone-line/60 space-y-2 text-xs text-muted-foreground">
            <div>
              <div className="font-medium text-olive mb-1">
                {t('TENANTS')}{' '}
                <span className="text-muted-foreground/70 font-normal">
                  — {t('not subtracted from Net')}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pl-2">
                <div>
                  {t('Fixed recurring')} ×12:{' '}
                  <NumberFormat
                    value={finance.recurringMonthlyEksoda * 12}
                    showZero
                  />
                </div>
                {/* A6: κυμαινόμενα are NOT ×12 — the actual typed totals YTD. */}
                <div>
                  {t('Variable (year to date)')}:{' '}
                  <NumberFormat value={finance.variableYtdEksoda} showZero />
                </div>
                <div>
                  {t('One-time')}:{' '}
                  <NumberFormat value={finance.oneTimeEksoda} showZero />
                </div>
                <div>
                  {t('Tenant repairs')}:{' '}
                  <NumberFormat value={finance.repairEksoda} showZero />
                </div>
              </div>
            </div>
            <div>
              <div className="font-medium text-oxide mb-1">
                {t('OWNERS')}{' '}
                <span className="text-muted-foreground/70 font-normal">
                  — {t('subtracted from Net')}
                </span>
              </div>
              <div className="pl-2 space-y-0.5">
                <div>
                  {t('Owner expenses')}:{' '}
                  <NumberFormat value={finance.ownerEksoda} showZero />
                </div>
                {finance.vacantOwnerResidentEksoda > 0 && (
                  <div>
                    {t('Vacant / owner-occupied unit shares')}:{' '}
                    <NumberFormat
                      value={finance.vacantOwnerResidentEksoda}
                      showZero
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {/* Per-repair financial line items — each repair with title, term,
            charge attribution, and total cost so repairs are visible as named
            entities in the overview, not just aggregated into a single number.
            All 22 downstream read-surfaces (expense panel, owner ledger, rent
            detail, invoices, PDFs, charts) render repair-BILLING data
            (monthlyCharges/ownerMonthlyExpenses) which requires the distribution
            to have run; this section shows the REPAIR ITSELF regardless. */}
        {(building?.repairs || []).filter(
          (r) => (r.actualCost || r.estimatedCost) && r.status !== 'cancelled'
        ).length > 0 && (
          <div className="mt-3 pt-3 border-t border-stone-line/60">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              {t('Repairs')}
            </div>
            <div className="space-y-1">
              {(building.repairs || [])
                .filter(
                  (r) =>
                    (r.actualCost || r.estimatedCost) &&
                    r.status !== 'cancelled'
                )
                .map((r, i) => {
                  const cost = Number(r.actualCost || r.estimatedCost || 0);
                  const tp = r.tenantSharePercentage || 0;
                  const chargeLabel =
                    r.chargeableTo === 'tenants'
                      ? t('Tenants')
                      : r.chargeableTo === 'owners'
                        ? t('Owners')
                        : r.chargeableTo === 'split'
                          ? `${t('Tenants')} ${tp}% · ${t('Owners')} ${100 - tp}%`
                          : t('Unassigned');
                  // A7: term or MM/YYYY–MM/YYYY span (when completionDate set).
                  const startYM = r.chargeTerm
                    ? `${String(r.chargeTerm).slice(4, 6)}/${String(r.chargeTerm).slice(0, 4)}`
                    : '';
                  const endYM = r.completionDate
                    ? moment(r.completionDate).format('MM/YYYY')
                    : '';
                  const termLabel =
                    endYM && endYM !== startYM
                      ? `${startYM} – ${endYM}`
                      : startYM;
                  const work = _workStatusLabel(r.status);
                  const money = _repairMoneyBadge(r);
                  return (
                    <div
                      key={r._id || i}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-ink truncate">
                          {r.title || r.description || t('Repair')}
                        </span>
                        {/* A7 dual status: work badge + (owner-side) money badge */}
                        <span className="inline-block px-1.5 rounded-pill bg-sea-tint text-sea-deep">
                          {work}
                        </span>
                        {money && (
                          <span
                            className={cn('inline-block px-1.5 rounded-pill', money.cls)}
                          >
                            {money.label}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-2 whitespace-nowrap text-muted-foreground">
                        {termLabel && <span>{termLabel}</span>}
                        <span>→ {chargeLabel}</span>
                        <NumberFormat
                          value={cost}
                          className="text-ink font-medium"
                        />
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </Card>

      {/* A2: tenant rent collected vs owed (φέτος μέχρι σήμερα) — the tenant
          twin of the owner paid/unpaid tile below. collected = Σ rent payments
          this year, owed = Σ unpaid rent this year (server-computed in
          _toBuildingData from the tenants' rents). Shown when there is any rent
          activity this year. */}
      {(() => {
        const ytd = building?.tenantRentYTD || { collected: 0, owed: 0 };
        const total = (Number(ytd.collected) || 0) + (Number(ytd.owed) || 0);
        if (!(total > 0)) return null;
        return (
          <Card className="p-4">
            <div className="flex items-end justify-between gap-4 mb-2">
              <div>
                <div className="text-label text-muted-foreground uppercase tracking-wide">
                  {t('Rent collected')}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t('Tenant rent for {{year}}: collected vs owed.', {
                    year: new Date().getFullYear()
                  })}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xl font-medium">
                  <NumberFormat value={ytd.collected} showZero />
                  <span className="text-sm text-muted-foreground">
                    {' / '}
                    <NumberFormat value={total} showZero />
                  </span>
                </div>
              </div>
            </div>
            <Progress value={Math.round((ytd.collected / total) * 100)} />
            <div className="mt-2 flex justify-between text-xs text-muted-foreground">
              <span className="text-olive">
                {t('Collected')}:{' '}
                <NumberFormat value={ytd.collected} showZero />
              </span>
              <span className="text-oxide">
                {t('Owed')}: <NumberFormat value={ytd.owed} showZero />
              </span>
            </div>
          </Card>
        );
      })()}

      {/* Owner expenses paid vs unpaid — directly under the income card, the
          eksoda counterpart to the esoda headline. Only shown when the owner
          ledger has entries this year. The landlord marks each owner-side
          charge paid from the building Expenses → breakdown; this tile rolls
          them up so "how much of this year's owner expenses have I settled?"
          is answerable at a glance. */}
      {finance.ownerLedgerTotal > 0 && (
        <Card className="p-4">
          <div className="flex items-end justify-between gap-4 mb-2">
            <div>
              <div className="text-label text-muted-foreground uppercase tracking-wide">
                {t('Owner expenses paid')}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {t('Owner-side charges for {{year}}: paid vs outstanding.', {
                  year: new Date().getFullYear()
                })}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xl font-medium">
                <NumberFormat value={finance.ownerPaid} showZero />
                <span className="text-sm text-muted-foreground">
                  {' / '}
                  <NumberFormat value={finance.ownerLedgerTotal} showZero />
                </span>
              </div>
            </div>
          </div>
          <Progress
            value={
              finance.ownerLedgerTotal > 0
                ? Math.round(
                    (finance.ownerPaid / finance.ownerLedgerTotal) * 100
                  )
                : 0
            }
          />
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span className="text-olive">
              {t('Paid')}: <NumberFormat value={finance.ownerPaid} showZero />
            </span>
            <span className="text-oxide">
              {t('Outstanding')}:{' '}
              <NumberFormat value={finance.ownerUnpaid} showZero />
            </span>
          </div>
        </Card>
      )}

      {/* §5: Αχρέωτα (uncollected) — vacant-unit expense money billed to NOBODY
          (the share of an expense/repair on a vacant unit with the
          chargeOwnerWhenVacant flag off). NOT a debt — it's money the building
          simply doesn't collect. The tile shows the cumulative year total and
          how much has been VOLUNTARILY covered (building.uncollected, computed
          server-side, netted by uncollectedPayments). Server returns it only on
          the building detail read. */}
      {building?.uncollected && building.uncollected.total > 0 && (
        <Card className="p-4">
          <div className="flex items-end justify-between gap-4 mb-2">
            <div>
              <div className="text-label text-muted-foreground uppercase tracking-wide">
                {t('Uncollected')}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {t(
                  'Vacant-unit expense shares billed to nobody for {{year}}. Not a debt — coverage payments reduce it.',
                  { year: new Date().getFullYear() }
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xl font-medium">
                <NumberFormat value={building.uncollected.outstanding} showZero />
                <span className="text-sm text-muted-foreground">
                  {' / '}
                  <NumberFormat value={building.uncollected.total} showZero />
                </span>
              </div>
            </div>
          </div>
          <Progress
            value={
              building.uncollected.total > 0
                ? Math.min(
                    100,
                    Math.round(
                      (building.uncollected.paidTotal /
                        building.uncollected.total) *
                        100
                    )
                  )
                : 0
            }
          />
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span className="text-olive">
              {t('Covered')}:{' '}
              <NumberFormat value={building.uncollected.paidTotal} showZero />
            </span>
            <span className="text-oxide">
              {t('Still uncollected')}:{' '}
              <NumberFormat value={building.uncollected.outstanding} showZero />
            </span>
          </div>
          {building.uncollected.outstanding > 0 && (
            <div className="mt-3 flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setUncollectedDialogOpen(true)}
              >
                {t('Coverage payment')}
              </Button>
            </div>
          )}
          <UncollectedPaymentDialog
            open={uncollectedDialogOpen}
            setOpen={setUncollectedDialogOpen}
            building={building}
            outstanding={building.uncollected.outstanding}
          />
        </Card>
      )}

      {/* Summary cards — B3: Κενά and Στάθμευση are DISTINCT categories, shown
          as separate cards (was one merged "Vacant / Parking"). A4: occupancy %
          below. */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="p-4 text-center">
          <div className="text-2xl font-bold">{stats.total}</div>
          <div className="text-sm text-muted-foreground">{t('Total units')}</div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-2xl font-bold text-green-600">
            {stats.rented}
          </div>
          <div className="text-sm text-muted-foreground">{t('Rented')}</div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">
            {stats.ownerOccupied}
          </div>
          <div className="text-sm text-muted-foreground">
            {t('Owner occupied')}
          </div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-2xl font-bold text-muted-foreground">
            {stats.vacant}
          </div>
          <div className="text-sm text-muted-foreground">{t('Vacant')}</div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-2xl font-bold text-muted-foreground">
            {stats.parking}
          </div>
          <div className="text-sm text-muted-foreground">{t('Parking')}</div>
        </Card>
      </div>
      {/* A4: occupancy rate (rented of total). */}
      {stats.total > 0 && (
        <div className="text-xs text-muted-foreground text-right -mt-3">
          {t('Occupancy')}:{' '}
          <span className="font-semibold text-ink">
            {Math.round((stats.rented / stats.total) * 100)}%
          </span>{' '}
          ({stats.rented} {t('of')} {stats.total})
        </div>
      )}

      {/* Repairs operational summary — open (planned + in-progress) repairs
          and any emergencies, so scheduled work is visible on the overview
          instead of only inside the Repairs tab. */}
      {(building?.repairs || []).length > 0 && (
        <Card className="p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <span className="text-sm font-medium">
              {t('Repairs / scheduled work')}
            </span>
            <div className="flex items-center gap-6 text-sm">
              <span className="text-muted-foreground">
                {t('Open')}:{' '}
                <span className="font-semibold text-ink">
                  {finance.repairStats.open}
                </span>
              </span>
              <span className="text-muted-foreground">
                {t('In progress')}:{' '}
                <span className="font-semibold text-ink">
                  {finance.repairStats.inProgress}
                </span>
              </span>
              {finance.repairStats.emergencies > 0 && (
                <span className="text-oxide font-medium">
                  {t('Emergencies')}: {finance.repairStats.emergencies}
                </span>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Floor-by-floor table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">{t('Floor')}</TableHead>
              <TableHead className="w-[80px]">{t('m²')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead>{t('Owner')}</TableHead>
              <TableHead>{t('Tenant / Occupant')}</TableHead>
              <TableHead className="text-right">{t('Rent')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from(floorSummary.entries()).map(([floor, units]) =>
              units.map((unit, idx) => {
                const occupancy = unit.occupancyType || 'vacant';
                const property = unit.propertyId
                  ? propertyMap.get(
                      typeof unit.propertyId === 'string'
                        ? unit.propertyId
                        : unit.propertyId?._id
                    )
                  : null;
                const tenantInfo = property
                  ? tenantByPropertyId.get(property._id)
                  : null;

                // Determine effective occupancy
                let effectiveOccupancy = occupancy;
                if (
                  occupancy === 'vacant' &&
                  tenantInfo
                ) {
                  effectiveOccupancy = 'rented';
                }

                // Owner display
                const ownerName =
                  unit.owners?.length > 0
                    ? unit.owners
                        .map(
                          (o) =>
                            `${o.name || ''} ${o.percentage < 100 ? `(${fmtNum(o.percentage)}%)` : ''}`.trim()
                        )
                        .join(', ')
                    : '—';

                // Tenant/occupant display
                let occupantDisplay = '';
                if (effectiveOccupancy === 'rented' && tenantInfo) {
                  occupantDisplay = tenantInfo.name;
                } else if (effectiveOccupancy === 'owner_occupied') {
                  occupantDisplay = ownerName;
                } else if (
                  effectiveOccupancy === 'parking' &&
                  unit.parkingAssignedTo?.length > 0
                ) {
                  occupantDisplay = unit.parkingAssignedTo
                    .map((id) => tenantById.get(id)?.name || id)
                    .join(', ');
                }

                // Rent display — use NumberFormat so currency follows the
                // realm locale (€ in el-GR, $ in en-US, etc.) instead of
                // being hardcoded.
                const rentDisplay =
                  effectiveOccupancy === 'rented' && tenantInfo?.rent ? (
                    <NumberFormat value={Number(tenantInfo.rent)} />
                  ) : (
                    ''
                  );

                return (
                  <TableRow
                    key={unit._id}
                    className={cn(
                      OCCUPANCY_CONFIG[effectiveOccupancy]?.bgColor
                    )}
                  >
                    <TableCell className="font-medium">
                      {idx === 0 ? <FloorLabel floor={floor} /> : ''}
                    </TableCell>
                    <TableCell>
                      {unit.surface ? fmtNum(unit.surface) : '—'}
                    </TableCell>
                    <TableCell>
                      <OccupancyBadge type={effectiveOccupancy} />
                    </TableCell>
                    <TableCell className="text-sm">{ownerName}</TableCell>
                    <TableCell className="font-medium">
                      {occupantDisplay}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {rentDisplay}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
            {sortedUnits.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  {t('No units registered. Import an E9 or add units manually.')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
