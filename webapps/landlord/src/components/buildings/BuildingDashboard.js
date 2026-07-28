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
import { cn } from '../../utils';
import { LuArchive, LuBuilding2, LuCar, LuHome, LuUser } from 'react-icons/lu';
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
  },
  // Storage (Αποθήκη) is a special non-residential space like parking — an
  // E9-imported storage room has property.type 'storage' but occupancyType
  // 'vacant', so without its own badge it rendered as plain «Κενό». Distinct
  // sea/teal tone so it reads apart from parking's amber and vacant's grey.
  storage: {
    label: 'Storage',
    color: 'bg-sea',
    textColor: 'text-sea',
    bgColor: 'bg-sea/10',
    icon: LuArchive
  }
};

// B-D + B-E: the ONE source of truth for a unit's effective occupancy, used by
// BOTH the ΜΟΝΑΔΕΣ counts and the per-row badge so they can never disagree.
// Priority: an ACTIVE tenant → 'rented' (regardless of the stored flag); else
// the space TYPE from property.type ('parking'/'storage') — B-E: parking/storage
// are space kinds derived from property.type, NOT hand-set occupancy statuses;
// else the unit's own occupancyType ('owner_occupied'); else 'vacant'.
//
// An active tenant OUTRANKS owner_occupied here on purpose (Finding B): when an
// owner moves out and the landlord links a tenant, the unit still carries the
// owner_occupied flag (the money layer keeps it — a scalar field can't be
// per-term, and flipping it dropped the owner's still-resident-months share).
// The DISPLAY must nevertheless show/count the unit as rented while a tenant
// actually occupies it, so this derivation lets the tenant win WITHOUT touching
// the stored flag. `tenantInfo` is windowed upstream (tenantByPropertyId skips
// terminated/archived AND future-start leases), so neither a moved-out tenant
// nor a not-yet-begun lease keeps the unit "rented" here.
function deriveEffectiveOccupancy(unit, property, tenantInfo) {
  const occ = unit?.occupancyType || 'vacant';
  if (tenantInfo) return 'rented';
  if (occ === 'owner_occupied') return 'owner_occupied';
  if (occ === 'rented') return 'rented'; // tenant not yet joined this term but flagged
  const ptype = property?.type || null;
  if (occ === 'parking' || ptype === 'parking') return 'parking';
  if (occ === 'storage' || ptype === 'storage') return 'storage';
  return 'vacant';
}

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

// Uppercase section label — the architectural-calm section marker (DESIGN.md
// Label role): small, tracked, ink-muted. One per section inside a card.
function SectionLabel({ children, className }) {
  return (
    <div
      className={cn(
        'text-label uppercase tracking-wide text-ink-muted',
        className
      )}
    >
      {children}
    </div>
  );
}

// A thin two-tone progress bar matching the mockup: 8px rounded track on
// `stone`, a colored fill (olive=paid/collected, sea=rent). Replaces the fat
// near-black <Progress> blob. `pct` is clamped 0..100 by the caller.
function BarRow({
  label,
  valueNode,
  pct,
  fill = 'olive',
  footLeft,
  footRight,
  subdued = false
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <span className="text-body text-ink-soft">{label}</span>
        <span className="font-mono tabular-nums text-body text-ink">
          {valueNode}
        </span>
      </div>
      {/* `subdued` thins the track + lowers the fill chroma so a 100% bar for a
          trivial total (e.g. €0.21) doesn't become the loudest thing on the
          card. */}
      <div
        className={cn(
          'rounded-pill bg-stone overflow-hidden',
          subdued ? 'h-1' : 'h-2'
        )}
      >
        <div
          className={cn(
            'h-full rounded-pill',
            subdued
              ? 'bg-olive/40'
              : fill === 'sea'
                ? 'bg-sea'
                : 'bg-olive'
          )}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      {(footLeft || footRight) && (
        <div className="flex justify-between text-label mt-1.5">
          <span className="text-olive">{footLeft}</span>
          <span className="text-oxide">{footRight}</span>
        </div>
      )}
    </div>
  );
}

// One eksoda-composition cell (the mockup's `.comp .cell`): quiet cream tile,
// a 2-line label, a mono value under it. NOT a hero metric and NOT an
// identical-grid card — it's a labelled figure in a flow grid.

// A unit-count cell for the Μονάδες summary (mockup `.ucard`): serif number
// over a small label, centered. Tonal, bordered, no shadow — distinct from the
// banned hero-metric template (no gradient, no accent chip, plain count).
function UnitCountCell({ n, label, tone }) {
  return (
    // Borderless count cell — NO per-cell border/bg so the Μονάδες row reads as
    // one labelled strip inside its card, not 5 bordered tiles nested in a card
    // (DESIGN.md: nested cards / identical-card-grids banned).
    <div className="px-2 py-1 text-center">
      <div
        className={cn(
          'font-display text-2xl leading-none',
          tone === 'rent' && 'text-olive',
          tone === 'own' && 'text-sea',
          tone === 'mut' && 'text-ink-muted'
        )}
      >
        {n}
      </div>
      <div className="text-label text-ink-muted mt-1 normal-case tracking-normal">
        {label}
      </div>
    </div>
  );
}

function BuildingProjectionTable({ finance, t }) {
  const [expanded, setExpanded] = useState({});
  const toggle = (key) =>
    setExpanded((s) => ({ ...s, [key]: !s[key] }));

  const now = new Date();
  const MONTH_GEN = [
    'Ιανουαρίου', 'Φεβρουαρίου', 'Μαρτίου', 'Απριλίου', 'Μαΐου', 'Ιουνίου',
    'Ιουλίου', 'Αυγούστου', 'Σεπτεμβρίου', 'Οκτωβρίου', 'Νοεμβρίου', 'Δεκεμβρίου'
  ];
  const monthLabel = MONTH_GEN[now.getMonth()];

  const incomeTotal = finance.annualEsoda;
  const rentActual = finance.annualRentOnly;
  const chargesActual = finance.annualRentExpenses;

  const expTotal = finance.ownerBorneTotal;
  const recordedVal = finance.recordedOwnerEksoda;
  const vacantVal = finance.vacantOwnerResidentEksoda;


  // `neg` prefixes a minus so a cost reads as a deduction. Zero is not a
  // deduction: prefixing unconditionally rendered «−0,00 €» on a building with
  // no owner expenses, i.e. a negative amount that does not exist.
  const HeadRow = ({ label, actual, est, total, cls, neg }) => {
    const sign = (v) => (neg && Number(v) !== 0 ? '−' : '');
    return (
    <tr className="font-medium">
      <td className={`py-2 ${cls || 'text-ink'}`}>{label}</td>
      <td className={`py-2 text-right font-mono tabular-nums ${cls || 'text-ink'}`}>
        {sign(actual)}<NumberFormat value={actual} showZero abs={neg} />
      </td>
      <td className={`py-2 text-right font-mono tabular-nums ${cls || 'text-ink'}`}>
        {sign(est)}<NumberFormat value={est} showZero abs={neg} />
      </td>
      <td className={`py-2 text-right font-mono tabular-nums font-semibold ${cls || 'text-ink'}`}>
        {sign(total)}<NumberFormat value={total} showZero abs={neg} />
      </td>
    </tr>
    );
  };

  const SubRow = ({ label, actual, est, total, expandKey, children }) => {
    const isOpen = expanded[expandKey];
    const hasChildren = children && (Array.isArray(children) ? children.length > 0 : true);
    return (
      <>
        <tr
          className={cn('text-ink-soft', hasChildren && 'cursor-pointer hover:bg-cream')}
          onClick={hasChildren ? () => toggle(expandKey) : undefined}
        >
          <td className="py-1.5 pl-4">
            {hasChildren && <span className="mr-1.5 text-ink-muted">{isOpen ? '▾' : '▸'}</span>}
            {label}
          </td>
          <td className="py-1.5 text-right font-mono tabular-nums">
            <NumberFormat value={actual} showZero />
          </td>
          <td className="py-1.5 text-right font-mono tabular-nums">
            <NumberFormat value={est} showZero />
          </td>
          <td className="py-1.5 text-right font-mono tabular-nums">
            <NumberFormat value={total} showZero />
          </td>
        </tr>
        {isOpen && children}
      </>
    );
  };

  const DetailRow = ({ label, value }) => (
    <tr className="text-label text-ink-muted">
      <td className="py-0.5 pl-10">{label}</td>
      <td colSpan={3} className="py-0.5 text-right font-mono tabular-nums">
        {value}
      </td>
    </tr>
  );

  return (
    <div className="mt-3">
      <table className="w-full text-body">
        <thead>
          <tr className="text-label text-ink-muted">
            <th className="text-left font-medium pb-2" />
            <th className="text-right font-medium pb-2 whitespace-nowrap">
              ({t('up to')} {monthLabel})
            </th>
            <th className="text-right font-medium pb-2 whitespace-nowrap">
              ({t('Projected short')})
            </th>
            <th className="text-right font-medium pb-2">{t('Total')}</th>
          </tr>
        </thead>
        <tbody>
          <HeadRow
            label={t('Income')}
            actual={incomeTotal}
            est={0}
            total={incomeTotal}
          />
          <SubRow
            label={t('Rents')}
            actual={rentActual}
            est={0}
            total={rentActual}
            expandKey="rents"
          />
          <SubRow
            label={t('Charges on rent short')}
            actual={chargesActual}
            est={0}
            total={chargesActual}
            expandKey="charges"
          />

          <tr><td colSpan={4} className="border-t border-stone-line" /></tr>

          <HeadRow
            label={t('Owner expenses')}
            actual={expTotal}
            est={0}
            total={expTotal}
            cls="text-oxide"
            neg
          />
          {(finance.fixedOwnerDetail || []).map((exp, i) => (
            <SubRow
              key={`fixed-${i}`}
              label={exp.name}
              actual={exp.annual}
              est={0}
              total={exp.annual}
              expandKey={`fixed-${i}`}
            >
              <DetailRow
                label={`${exp.monthly} €/${t('month')} × ${exp.months} ${t('months')}`}
                value={<NumberFormat value={exp.annual} showZero />}
              />
            </SubRow>
          ))}
          {recordedVal > 0 && (
            <SubRow
              label={t('Other')}
              actual={recordedVal}
              est={0}
              total={recordedVal}
              expandKey="recorded"
            />
          )}
          {vacantVal > 0 && (
            <SubRow
              label={t('Vacant / owner-occupied unit shares')}
              actual={vacantVal}
              est={0}
              total={vacantVal}
              expandKey="vacant"
            >
              {finance.ownerResidentEksoda > 0 && (
                <DetailRow label={t('Owner occupied')} value={<NumberFormat value={finance.ownerResidentEksoda} showZero />} />
              )}
              {finance.vacantShareEksoda > 0 && (
                <DetailRow label={t('Vacant units')} value={<NumberFormat value={finance.vacantShareEksoda} showZero />} />
              )}
            </SubRow>
          )}

          <tr><td colSpan={4} className="border-t border-stone-line" /></tr>

          <tr className="font-semibold">
            <td className="py-2 text-ink">{t('Net')}</td>
            <td className={cn('py-2 text-right font-mono tabular-nums', finance.net > 0 ? 'text-olive' : finance.net < 0 ? 'text-oxide' : 'text-ink-muted')}>
              <NumberFormat value={finance.net} showZero />
            </td>
            <td className="py-2 text-right font-mono tabular-nums text-ink-muted">
              <NumberFormat value={0} showZero />
            </td>
            <td className={cn('py-2 text-right font-mono tabular-nums font-semibold', finance.net > 0 ? 'text-olive' : finance.net < 0 ? 'text-oxide' : 'text-ink-muted')}>
              <NumberFormat value={finance.net} showZero />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-label text-ink-muted mt-3">
        {t('New or changed expenses, repairs or rents in individual months will change the annual projection.')}
      </p>
    </div>
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
      return { key: 'paid', label: t('Paid'), variant: 'paid' };
    }
    // Overdue = the BILLING month (chargeTerm) has passed. Billing keys solely
    // off chargeTerm (server), so the badge must too — not completionDate (a
    // cosmetic field that diverged the badge from the actual charge month).
    const term = Number(String(repair.chargeTerm || '').slice(0, 6));
    const nowYM = Number(moment().format('YYYYMM'));
    const overdue = term > 0 && term < nowYM;
    return overdue
      ? { key: 'overdue', label: t('Overdue'), variant: 'overdue' }
      : { key: 'pending', label: t('Pending'), variant: 'neutral' };
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
    const now = moment();
    if (tenants) {
      tenants.forEach((tenant) => {
        // E22: skip terminated / archived tenants so the building view's
        // "Tenant / Occupant" column doesn't keep showing a person who
        // has already moved out. Without this filter the dashboard
        // claimed a unit was rented even after termination, masking the
        // vacancy from the operator until they navigated to the tenant
        // record itself.
        if (tenant.terminated || tenant.archived) return;
        // Finding B (Step-7 r2): a FUTURE-START lease must not count as
        // occupying the unit yet — otherwise an owner-occupied (or vacant)
        // unit shows/counts as «Ενοικιασμένο» before the tenant actually moves
        // in. The money layer already windows by begin/end per term
        // (_occupiedFromOccupancyRows); mirror that here. Dates are
        // 'DD/MM/YYYY' (frontdata.toOccupantData formats them). Compare at
        // month granularity to match the rent-term projection.
        if (tenant.beginDate) {
          const begin = moment(tenant.beginDate, 'DD/MM/YYYY', true);
          if (begin.isValid() && begin.isAfter(now, 'month')) return;
        }
        if (tenant.properties) {
          tenant.properties.forEach((tp) => {
            map.set(tp.propertyId, {
              name: tenant.name,
              rent: tp.rent,
              tenantId: tenant._id,
              // E1: the tenant's δαπάνες επί ενοικίου for this property — these
              // are charged to the tenant ON TOP of base rent, so the building
              // income projection must include them, not rent alone.
              expenses: Array.isArray(tp.expenses) ? tp.expenses : [],
              // Lease window (DD/MM/YYYY) so the annual Income figure can count
              // only the months this lease is actually active in the year — a
              // tenant who started in March is NOT billed 12 months.
              // Per-property entry/exit take precedence over the lease-level
              // dates when present (a multi-property lease can stagger units).
              beginDate: tp.entryDate || tenant.beginDate || null,
              endDate:
                tenant.terminationDate || tp.exitDate || tenant.endDate || null
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

  // Floor-table column totals (mockup A4 'Σύνολο' row): total surface + total
  // rent across all units, so the operator sees the building's totals at a
  // glance. Rent is the active tenant's rent for each unit (same source the
  // rows render).
  const floorTotals = useMemo(() => {
    let surface = 0;
    let rent = 0;
    sortedUnits.forEach((unit) => {
      surface += Number(unit.surface) || 0;
      const prop = unit.propertyId
        ? propertyMap.get(
            typeof unit.propertyId === 'string'
              ? unit.propertyId
              : unit.propertyId?._id
          )
        : null;
      const t = prop ? tenantByPropertyId.get(prop._id) : null;
      if (t?.rent) rent += Number(t.rent) || 0;
    });
    return { surface, rent };
  }, [sortedUnits, propertyMap, tenantByPropertyId]);

  // Stats
  const stats = useMemo(() => {
    const s = {
      total: 0,
      rented: 0,
      ownerOccupied: 0,
      vacant: 0,
      parking: 0,
      storage: 0
    };
    sortedUnits.forEach((unit) => {
      s.total++;
      // B-D: counts use the SAME deriveEffectiveOccupancy helper the rows use,
      // so the ΜΟΝΑΔΕΣ tallies can never disagree with the per-row badges. The
      // helper resolves tenant→rented, then property.type→parking/storage
      // (B-E), then owner_occupied, then vacant.
      const pid =
        typeof unit.propertyId === 'string'
          ? unit.propertyId
          : unit.propertyId?._id;
      const property = pid ? propertyMap.get(pid) : null;
      const tenantInfo = property ? tenantByPropertyId.get(property._id) : null;
      const eff = deriveEffectiveOccupancy(unit, property, tenantInfo);
      if (eff === 'rented') s.rented++;
      else if (eff === 'owner_occupied') s.ownerOccupied++;
      else if (eff === 'parking') s.parking++;
      else if (eff === 'storage') s.storage++;
      else s.vacant++;
    });
    return s;
  }, [sortedUnits, propertyMap, tenantByPropertyId]);

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
    // Current term (YYYYMMDDHH) + year, defined ONCE at the top so every stream
    // below shares them (income proration, expense-active-months, year gating).
    const currentTerm = Number(_now.clone().startOf('month').format('YYYYMMDDHH'));
    const currentYear = Math.floor(currentTerm / 1000000);
    // ONE shared "active months in the current year" helper, used by income
    // (lease window) AND owner/expense projection (expense startTerm/endTerm).
    // Accepts DD/MM/YYYY strings (leases) OR YYYYMMDDHH terms (expenses); pass
    // the matching parser. Returns 0 when the window is entirely outside the
    // year, else the count of months of `currentYear` the window covers.
    const _monthsInYear = (startMonth, startYear, endMonth, endYear) => {
      if (startYear > currentYear || endYear < currentYear) return 0;
      const from = startYear < currentYear ? 1 : startMonth;
      const to = endYear > currentYear ? 12 : endMonth;
      return Math.max(0, to - from + 1);
    };
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
    // ANNUAL income counts each unit's rent ONLY for the months its lease is
    // active in the current year — a tenant who started in March is billed 10
    // months, NOT 12. The old `monthlyEsoda × 12` over-counted every mid-year
    // lease (the 7.800-vs-7.560,56 discrepancy). Active months come from the
    // shared _monthsInYear via the lease window (DD/MM/YYYY strings from
    // frontdata; missing → treated as full-year active).
    const _leaseActiveMonths = (info) => {
      const b = info.beginDate ? moment(info.beginDate, 'DD/MM/YYYY', true) : null;
      const e = info.endDate ? moment(info.endDate, 'DD/MM/YYYY', true) : null;
      const startMonth = b && b.isValid() ? b.month() + 1 : 1;
      const startYear = b && b.isValid() ? b.year() : currentYear;
      const endMonth = e && e.isValid() ? e.month() + 1 : 12;
      const endYear = e && e.isValid() ? e.year() : currentYear;
      return _monthsInYear(startMonth, startYear, endMonth, endYear);
    };
    // Also keep a "current month" roll for surfaces that want the monthly figure.
    let monthlyRentOnly = 0;
    let monthlyRentExpenses = 0;
    // Annual, active-months-prorated components (drive Έσοδα on the card).
    let annualRentOnly = 0;
    let annualRentExpenses = 0;
    for (const unit of sortedUnits) {
      if (!unit.propertyId) continue;
      const property = propertyMap.get(
        typeof unit.propertyId === 'string' ? unit.propertyId : unit.propertyId?._id
      );
      const tenantInfo = property ? tenantByPropertyId.get(property._id) : null;
      if (!tenantInfo) continue;
      const rent = Number(tenantInfo.rent) || 0;
      const exp = _monthlyPropExpenses(tenantInfo.expenses);
      monthlyRentOnly += rent;
      monthlyRentExpenses += exp;
      const months = _leaseActiveMonths(tenantInfo);
      annualRentOnly += rent * months;
      annualRentExpenses += exp * months;
    }
    const monthlyEsoda = monthlyRentOnly + monthlyRentExpenses;

    // (currentTerm / currentYear defined at the top of the memo — shared by
    // every stream. The headline reads "Ετήσια προβολή"; each stream is scoped
    // to the current YEAR and, for the projected months, estimated — never a
    // hidden lifetime sum, the F1/F2/F3 dashboard-audit regression class.)

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
    // Active months in the current year for an EXPENSE (its startTerm/endTerm
    // are YYYYMMDDHH; a recurring expense with no endTerm runs through Δεκ).
    const _expenseActiveMonths = (e) => {
      const st = Number(e.startTerm) || 0;
      const et = Number(e.endTerm) || 0;
      const startMonth = st ? Math.floor((st % 1000000) / 10000) : 1;
      const startYear = st ? Math.floor(st / 1000000) : currentYear;
      const endMonth = et ? Math.floor((et % 1000000) / 10000) : 12;
      const endYear = et ? Math.floor(et / 1000000) : currentYear;
      return _monthsInYear(startMonth, startYear, endMonth, endYear);
    };
    // Σταθερά (fixed recurring): the per-month cost is constant, so the annual
    // figure is monthlyCost × the months it is ACTIVE in the year — NOT a blind
    // ×12. An expense that started in July contributes 6 months, not 12 (the
    // 576→288 bug). recurringMonthlyEksoda keeps the current-month figure for
    // other surfaces; recurringAnnualEksoda is the active-months-prorated total.
    const _recurringFixed = (building?.expenses || []).filter(
      (e) =>
        (e.isRecurring ?? e.recurring) &&
        _expenseMonthlyCost(e) > 0 &&
        isExpenseActiveForTerm(e, currentTerm)
    );
    const recurringMonthlyEksoda = _recurringFixed.reduce(
      (sum, e) => sum + _expenseMonthlyCost(e),
      0
    );
    const recurringAnnualEksoda = _recurringFixed.reduce(
      (sum, e) => sum + _expenseMonthlyCost(e) * _expenseActiveMonths(e),
      0
    );
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
    // Κυμαινόμενα (variable): each month's amount is landlord-typed per term, so
    // FUTURE months can't be known — they are ESTIMATED. Per expense:
    //   actual  = Σ the real typed amounts for months already entered this year
    //   projected = (average of the last 3 entered months) × remaining active
    //               months of the year (Αυγ–Δεκ when today is Ιούλ)
    // The card shows both, projected clearly marked «εκτ.». variableYtdEksoda
    // stays = the ACTUAL-so-far (used elsewhere); variableProjectedEksoda is the
    // estimate for the remaining months; their sum is the annual figure.
    let variableYtdEksoda = 0;
    let variableProjectedEksoda = 0;
    for (const e of (building?.expenses || []).filter(_isVariableExpense)) {
      // Collect this year's entered per-term totals (inputAmount once per term,
      // legacy fallback = Σ per-unit shares), keyed + sorted by term.
      const perTerm = new Map(); // term -> { input: number|null, shareSum }
      for (const unit of building?.units || []) {
        for (const c of unit.monthlyCharges || []) {
          const inYear = Math.floor(Number(c.term || 0) / 1000000) === currentYear;
          const matches =
            String(c.expenseId) === String(e._id) || c.description === e.name;
          if (!inYear || !matches) continue;
          const slot = perTerm.get(c.term) || { input: null, shareSum: 0 };
          if (c.inputAmount != null) slot.input = Number(c.inputAmount) || 0;
          else slot.shareSum += Number(c.amount) || 0;
          perTerm.set(c.term, slot);
        }
      }
      // Per-term entered amount, oldest→newest.
      const entered = [...perTerm.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, s]) => (s.input != null ? s.input : s.shareSum));
      const actual = entered.reduce((s, v) => s + v, 0);
      variableYtdEksoda += actual;
      // Remaining ACTIVE months of the year for this variable expense.
      const activeMonths = _expenseActiveMonths(e);
      const remaining = Math.max(0, activeMonths - entered.length);
      if (remaining > 0 && entered.length > 0) {
        const last3 = entered.slice(-3);
        const avg = last3.reduce((s, v) => s + v, 0) / last3.length;
        variableProjectedEksoda += avg * remaining;
      }
    }
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
    const _fixedOwnerExpenses = (building?.expenses || []).filter(
      (e) =>
        e.trackOwnerExpense &&
        (e.isRecurring ?? e.recurring) &&
        Number(e.ownerAmount) > 0 &&
        isExpenseActiveForTerm(e, currentTerm)
    );
    const fixedOwnerProrated = _fixedOwnerExpenses.reduce(
      (sum, e) => sum + (Number(e.ownerAmount) || 0) * _expenseActiveMonths(e),
      0
    );
    const fixedOwnerDetail = _fixedOwnerExpenses.map((e) => ({
      name: e.name || '',
      monthly: Number(e.ownerAmount) || 0,
      months: _expenseActiveMonths(e),
      annual: (Number(e.ownerAmount) || 0) * _expenseActiveMonths(e)
    }));
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

    // Annual income = active-months-prorated rent + expenses (NOT flat ×12).
    const annualEsoda = annualRentOnly + annualRentExpenses;
    // Pass-through (paid by tenants, remitted to providers — κοινόχρηστα,
    // tenant repairs): recurring×12 + one-time + tenant-repair share. These are
    // NOT the owner's money.
    // Pass-through annual = fixed-recurring PRORATED by active months (not ×12)
    // + variable ACTUAL-so-far + variable PROJECTED (3-month avg × remaining) +
    // one-time (real, in its month) + tenant repair shares (real per term).
    const passThroughEksoda =
      recurringAnnualEksoda +
      variableYtdEksoda +
      variableProjectedEksoda +
      oneTimeEksoda +
      repairEksoda;
    // Total building cash flow (kept for the breakdown tiles).
    const annualEksoda = passThroughEksoda + ownerEksoda;
    // Step-7 A5 fix (DASH-A5-VACANT-OWNER-SHARE): a vacant/owner-occupied unit's
    // share of a recurring/one-time building expense is genuine owner cost
    // (materialised source:'vacant'/'owner-resident'), but it is EXCLUDED from
    // ownerEksoda (correct — the FULL expense is in passThroughEksoda). Since A5
    // no longer subtracts passThrough from Net, that owner share would vanish
    // from Net.
    //
    // BUG (2026-07, dashboard-vs-building-screen disagreement): summing the
    // materialised rows AS-IS counted these shares for ONLY the month(s) the
    // per-term materialiser (_recomputeVacantOwnerCharges) has run — usually
    // just the current month — while the fixed owner-portion above is PROJECTED
    // across all active months (fixedOwnerProrated). So a €51,24/mo owner cost
    // read 180 (fixed ×6) + 21,24 (1 materialised month) = 201,24 here, but the
    // server dashboard (computeOwnerEksodaByMonth) projected the SAME shares ×6
    // = 307,44. A RECURRING expense's vacant/owner-resident share recurs every
    // active month exactly like its fixed portion, so it must be projected the
    // same way. Project each row's amount across its SOURCE EXPENSE's active
    // months, reusing the SHARED _expenseActiveMonths (same month-count as the
    // fixed owner portion + income proration) so no two surfaces can diverge.
    // Non-recurring (one-time) source expenses keep a single month — no recur.
    const _projectOwnerShare = (row) => {
      const exp = _expByIdH3.get(String(row.expenseId));
      // A VARIABLE owner expense (recurring but amount 0 — its monthly figure is
      // landlord-typed per term) must NOT be flat-projected: each month differs,
      // so its future months are unknown. Count only its ENTERED (materialised)
      // months — exactly like the κυμαινόμενα cell — matching the server
      // dashboard (which sums the per-term rows, not a projection). Only a
      // FIXED recurring expense (amount>0) is projected across active months.
      const isRecurring = exp && (exp.isRecurring ?? exp.recurring);
      const isVariable = isRecurring && _expenseMonthlyCost(exp) === 0;
      const months = isRecurring && !isVariable ? _expenseActiveMonths(exp) : 1;
      return (Number(row.amount) || 0) * months;
    };
    const ownerResidentEksoda = ownerLedgerThisYear
      .filter((e) => e.source === 'owner-resident')
      .reduce((sum, e) => sum + _projectOwnerShare(e), 0);
    const vacantShareEksoda = ownerLedgerThisYear
      .filter((e) => e.source === 'vacant')
      .reduce((sum, e) => sum + _projectOwnerShare(e), 0);
    const vacantOwnerResidentEksoda = ownerResidentEksoda + vacantShareEksoda;
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
      // Έσοδα inline breakdown: base rent vs δαπάνες επί ενοικίου, each already
      // prorated by the lease's active months in the year (mid-year leases are
      // NOT counted ×12), so the two sum to annualEsoda exactly.
      annualRentOnly,
      annualRentExpenses,
      recurringMonthlyEksoda,
      variableYtdEksoda,
      oneTimeEksoda,
      repairEksoda,
      ownerEksoda,
      // owner-borne total used by the headline + Net so Income − this === Net
      // exactly (includes the vacant/owner-resident expense shares).
      ownerBorneTotal: ownerEksoda + vacantOwnerResidentEksoda,
      vacantOwnerResidentEksoda,
      // The three additive owner-borne components, for the ΕΤΗΣΙΑ ΠΡΟΒΟΛΗ
      // breakdown (all already projected across active months):
      //   fixedOwnerProrated  = Σ ownerAmount × active-months (the fixed owner
      //     portion) — note ownerEksoda also includes recordedOwnerEksoda
      //     (variable owner amounts + owner-portion of repairs), surfaced as a
      //     separate «Λοιπά» line so the three cells still sum to ownerBorneTotal.
      fixedOwnerProrated,
      fixedOwnerDetail,
      recordedOwnerEksoda,
      ownerResidentEksoda,
      vacantShareEksoda,
      // ΕΝΟΙΚΙΑΣΤΕΣ pass-through, actuals + projection split for the cells:
      recurringAnnualEksoda, // Σταθερά, active-months-prorated (was ×12)
      variableProjectedEksoda, // Κυμαινόμενα projected remainder (εκτ.)
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
    <div className="space-y-4">
      {/* CARD 1 — Ετήσια προβολή (annual projection). 3-column table
          (ΕΩΣ μήνα / ΕΚΤΙΜΗΣΗ / ΣΥΝΟΛΟ) with collapsible sub-rows per category.
          Same rhythm as the realm-wide Επισκόπηση ΕΤΗΣΙΑ ΠΡΟΒΟΛΗ table. */}
      <Card className="p-5">
        <SectionLabel>
          {t('Annual projection')} {new Date().getFullYear()}
        </SectionLabel>
        <BuildingProjectionTable finance={finance} t={t} />
      </Card>

      {/* CARD 2 — ΑΠΟ ΑΡΧΗΣ ΕΤΟΥΣ: this year's actuals, both bars in ONE card
          (A2). Rent collected-vs-owed + owner expenses paid-vs-outstanding,
          thin two-tone tracks (not the fat near-black blob). Only the bars that
          have data render. */}
      {(() => {
        const ytd = building?.tenantRentYTD || { collected: 0, owed: 0 };
        const rentTotal = (Number(ytd.collected) || 0) + (Number(ytd.owed) || 0);
        const hasRent = rentTotal > 0;
        const hasOwner = finance.ownerLedgerTotal > 0;
        if (!hasRent && !hasOwner) return null;
        return (
          <Card className="p-5">
            <SectionLabel className="mb-3">
              {t('From {{date}}', {
                date: `01/01/${new Date().getFullYear()}`
              })}
            </SectionLabel>
            <div className="space-y-4">
              {hasRent && (
                <BarRow
                  label={t('Rent collected')}
                  valueNode={
                    <>
                      <NumberFormat value={ytd.collected} showZero />
                      <span className="text-ink-muted">
                        {' / '}
                        <NumberFormat value={rentTotal} showZero />
                      </span>
                    </>
                  }
                  pct={Math.round((ytd.collected / rentTotal) * 100)}
                  fill="sea"
                  footLeft={
                    <>
                      {t('Collected')}:{' '}
                      <NumberFormat value={ytd.collected} showZero />
                    </>
                  }
                  footRight={
                    <>
                      {t('Rent owed')}:{' '}
                      <NumberFormat value={ytd.owed} showZero />
                    </>
                  }
                />
              )}
              {hasOwner && (
                <BarRow
                  label={t('Owner expenses short')}
                  valueNode={
                    <>
                      <NumberFormat value={finance.ownerPaid} showZero />
                      <span className="text-ink-muted">
                        {' / '}
                        <NumberFormat
                          value={finance.ownerLedgerTotal}
                          showZero
                        />
                      </span>
                    </>
                  }
                  pct={Math.round(
                    (finance.ownerPaid / finance.ownerLedgerTotal) * 100
                  )}
                  fill="olive"
                  subdued={finance.ownerLedgerTotal < 1}
                  footLeft={
                    <>
                      {t('Settled')}:{' '}
                      <NumberFormat value={finance.ownerPaid} showZero />
                    </>
                  }
                  footRight={
                    <>
                      {t('Owner owed')}:{' '}
                      <NumberFormat value={finance.ownerUnpaid} showZero />
                    </>
                  }
                />
              )}
            </div>
          </Card>
        );
      })()}

      {/* §5: Αχρέωτα (uncollected) — vacant-unit expense money billed to NOBODY
          (the share of an expense/repair on a vacant unit with the
          chargeOwnerWhenVacant flag off). NOT a debt — it's money the building
          simply doesn't collect. The tile shows the cumulative year total and
          how much has been VOLUNTARILY covered (building.uncollected, computed
          server-side, netted by uncollectedPayments). Server returns it only on
          the building detail read. */}
      {building?.uncollected && building.uncollected.total > 0 && (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div className="min-w-0 md:max-w-[62%]">
              <SectionLabel>{t('Uncollected expenses short')}</SectionLabel>
            </div>
            {building.uncollected.outstanding > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setUncollectedDialogOpen(true)}
              >
                {t('Coverage payment')}
              </Button>
            )}
          </div>
          <BarRow
            label={t('Covered expenses short')}
            valueNode={
              <>
                {/* Header must agree with the label + fill: Καλυμμένα = paidTotal
                    of total (was wrongly fed `outstanding`, so it read
                    "Καλυμμένα 10,85 / 10,85" while the track + foot said 0). */}
                <NumberFormat value={building.uncollected.paidTotal} showZero />
                <span className="text-ink-muted">
                  {' / '}
                  <NumberFormat value={building.uncollected.total} showZero />
                </span>
              </>
            }
            pct={Math.round(
              (building.uncollected.paidTotal /
                (building.uncollected.total || 1)) *
                100
            )}
            fill="olive"
            footRight={
              <>
                {t('Still uncollected')}:{' '}
                <NumberFormat
                  value={building.uncollected.outstanding}
                  showZero
                />
              </>
            }
          />
          <UncollectedPaymentDialog
            open={uncollectedDialogOpen}
            setOpen={setUncollectedDialogOpen}
            building={building}
            outstanding={building.uncollected.outstanding}
          />
        </Card>
      )}

      {/* CARD 3 — Επισκευές (A3: moved BEFORE units). Two lines per repair:
          name + dual status badge + cost on line 1; the charge split on line 2.
          Plus a one-line operational summary (open / in progress / emergencies)
          in the header. Every repair value is preserved (no data dropped). */}
      {(building?.repairs || []).length > 0 && (
        <Card className="p-5">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <span className="font-display text-headline">{t('Repairs')}</span>
            <div className="flex items-center gap-5 text-label text-ink-muted">
              <span>
                {t('Repairs new count')}:{' '}
                <span className="font-medium text-ink">
                  {finance.repairStats.open}
                </span>
              </span>
              <span>
                {t('In progress')}:{' '}
                <span className="font-medium text-ink">
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
          {(() => {
            const billed = (building.repairs || []).filter(
              (r) =>
                (r.actualCost || r.estimatedCost) && r.status !== 'cancelled'
            );
            if (billed.length === 0) {
              return (
                <p className="text-body text-ink-muted">
                  {t('No billable repairs recorded.')}
                </p>
              );
            }
            return (
              <div>
                {billed.map((r, i) => {
                  const cost = Number(r.actualCost || r.estimatedCost || 0);
                  const tp = r.tenantSharePercentage || 0;
                  // Allocation-method label (Ισομερής / Γενικά Χιλιοστά …), same
                  // keys ExpenseList uses, so the tile shows HOW the share splits
                  // (user: tile needs «50/50 + the method»).
                  const METHOD_LABEL = {
                    general_thousandths: 'General Thousandths',
                    heating_thousandths: 'Heating Thousandths',
                    elevator_thousandths: 'Elevator Thousandths',
                    equal: 'Equal',
                    by_surface: 'By Surface',
                    fixed: 'Fixed',
                    custom_ratio: 'Custom Ratio',
                    custom_percentage: 'Custom Percentage',
                    single_unit: 'Single Unit'
                  };
                  const methodLabel = METHOD_LABEL[r.allocationMethod]
                    ? t(METHOD_LABEL[r.allocationMethod])
                    : '';
                  const splitLabel =
                    r.chargeableTo === 'tenants'
                      ? t('Tenants')
                      : r.chargeableTo === 'owners'
                        ? t('Owners')
                        : r.chargeableTo === 'split'
                          ? `${t('Tenants')} ${tp}% · ${t('Owners')} ${100 - tp}%`
                          : t('Unassigned');
                  const chargeLabel = methodLabel
                    ? `${splitLabel} · ${methodLabel}`
                    : splitLabel;
                  // A repair bills to ONE month (chargeTerm). The old code glued
                  // chargeTerm to completionDate as a «MM/YYYY – MM/YYYY» range,
                  // which rendered BACKWARDS (06/2026 – 05/2026) and implied a
                  // multi-month span that does not exist. Show only the charge
                  // month. (completionDate is cosmetic; see the audit.)
                  const termLabel = r.chargeTerm
                    ? `${String(r.chargeTerm).slice(4, 6)}/${String(r.chargeTerm).slice(0, 4)}`
                    : '';
                  const work = _workStatusLabel(r.status);
                  const money = _repairMoneyBadge(r);
                  return (
                    <div
                      key={r._id || i}
                      className={cn(
                        'py-3.5',
                        i > 0 && 'border-t border-stone-line'
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-4">
                        <div className="min-w-0 flex items-baseline gap-2 flex-wrap">
                          <span className="font-medium text-ink truncate">
                            {r.title || r.description || t('Repair')}
                          </span>
                          {termLabel && (
                            <span className="text-label text-ink-muted">
                              {termLabel}
                            </span>
                          )}
                          <Badge variant="pending">{work}</Badge>
                          {money && (
                            <Badge variant={money.variant}>{money.label}</Badge>
                          )}
                        </div>
                        <span className="font-mono tabular-nums text-body text-ink whitespace-nowrap">
                          <NumberFormat value={cost} />
                        </span>
                      </div>
                      <div className="text-label text-ink-soft mt-1 normal-case tracking-normal">
                        {t('Allocation')}: {chargeLabel}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </Card>
      )}

      {/* CARD 4 — Μονάδες (B3: Κενά and Στάθμευση distinct; A4 occupancy). One
          card holding a 5-cell count row, NOT five identical cards. */}
      <Card className="p-5">
        <SectionLabel className="mb-3">{t('Units')}</SectionLabel>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2.5">
          <UnitCountCell n={stats.total} label={t('Total units')} />
          <UnitCountCell n={stats.rented} label={t('Rented')} tone="rent" />
          <UnitCountCell
            n={stats.ownerOccupied}
            label={t('Owner occupied')}
            tone="own"
          />
          <UnitCountCell n={stats.vacant} label={t('Vacant')} tone="mut" />
          <UnitCountCell n={stats.parking} label={t('Parking')} tone="mut" />
          <UnitCountCell n={stats.storage} label={t('Storage')} tone="mut" />
        </div>
        {stats.total > 0 && (
          <div className="text-label text-ink-muted text-right mt-2.5 normal-case tracking-normal">
            {t('Occupancy')}:{' '}
            <span className="font-medium text-ink">
              {Math.round((stats.rented / stats.total) * 100)}%
            </span>{' '}
            ({stats.rented} {t('of')} {stats.total})
          </div>
        )}
      </Card>

      {/* Floor-by-floor table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">{t('Floor')}</TableHead>
              <TableHead className="w-[80px] text-right">{t('m²')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead>{t('Owner')}</TableHead>
              <TableHead>{t('Tenant / Occupant')}</TableHead>
              <TableHead className="text-right">{t('Rent')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from(floorSummary.entries()).map(([floor, units]) =>
              units.map((unit, idx) => {
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

                // B-D: same shared helper as the ΜΟΝΑΔΕΣ counts — badge and
                // tally can never diverge.
                const effectiveOccupancy = deriveEffectiveOccupancy(
                  unit,
                  property,
                  tenantInfo
                );

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
                    {/* Repeat the floor label on every row (was blanked on
                        all but idx===0). A faint label on continuation rows
                        keeps the first row dominant while letting every row
                        self-identify, per the approved mockup (B1). */}
                    <TableCell
                      className={cn(
                        'font-medium',
                        idx !== 0 && 'text-ink-muted/50'
                      )}
                    >
                      <FloorLabel floor={floor} />
                    </TableCell>
                    <TableCell numeric className="font-mono tabular-nums">
                      {unit.surface ? fmtNum(unit.surface) : '—'}
                    </TableCell>
                    <TableCell>
                      <OccupancyBadge type={effectiveOccupancy} />
                    </TableCell>
                    <TableCell className="text-sm">{ownerName}</TableCell>
                    <TableCell className="font-medium">
                      {occupantDisplay}
                    </TableCell>
                    <TableCell className="text-right font-medium font-mono tabular-nums">
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
            {/* Σύνολο totals row (mockup A4): total surface + total rent. */}
            {sortedUnits.length > 0 && (
              <TableRow className="bg-cream border-t-2 border-marble hover:bg-cream">
                <TableCell className="font-medium">{t('Total')}</TableCell>
                <TableCell numeric className="font-medium font-mono tabular-nums">
                  {fmtNum(floorTotals.surface)}
                </TableCell>
                <TableCell colSpan={3} />
                <TableCell numeric className="font-medium font-mono tabular-nums">
                  <NumberFormat value={floorTotals.rent} showZero />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
