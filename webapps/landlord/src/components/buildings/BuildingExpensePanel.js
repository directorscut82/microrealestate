import {
  QueryKeys,
  fetchExpenseBreakdown,
  saveMonthlyStatement
} from '../../utils/restcalls';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '../../utils';
import {
  LuChevronLeft,
  LuChevronRight,
  LuInfo,
  LuSave
} from 'react-icons/lu';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Separator } from '../ui/separator';
import NumberFormat from '../NumberFormat';
import useFormatNumber from '../../hooks/useFormatNumber';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';
import moment from 'moment';

/*
 * BuildingExpensePanel — the single, calendar-driven expense surface.
 *
 * Replaces the old side-by-side MonthlyStatement (left) | ExpenseHistory
 * (right) split that the user repeatedly flagged. One tile:
 *   1. A centered month calendar (year nav + 12-month grid). Months that
 *      have ANY expense data carry a dot.
 *   2. Selecting a month shows that month's full picture below the
 *      calendar:
 *        - VARIABLE recurring expenses (isRecurring + no fixed amount):
 *          inline number input + per-row save, so the landlord enters the
 *          actual invoice amount for that month (e.g. ρεύμα, νερό).
 *        - FIXED / one-off / recurring-with-amount expenses: read-only
 *          rows (the amount is already known).
 *        - OWNER expenses (trackOwnerExpense): same split, grouped under
 *          an "Owner" subheading.
 *      The month total is shown in the header.
 *
 * The current month is auto-selected on mount. Saving writes per-unit
 * charges (via saveMonthlyStatement) that flow into rent computation.
 */

// (ALLOCATION_LABELS / ALLOCATION_DESCRIPTIONS removed with the left-panel
// "(Ισομερής)" allocation-method tooltip — FIX_PLAN §500-501: the allocation
// method is noise on the monthly-statement line.)

// Mirrors services/api/src/businesslogic/tasks/1_base.ts isExpenseActiveForTerm
function isExpenseActiveForTerm(expense, term) {
  if (!expense) return false;
  if (!expense.startTerm) return false;
  if (expense.isRecurring === false) {
    const expMonth = Math.floor(Number(expense.startTerm) / 10000);
    const tMonth = Math.floor(Number(term) / 10000);
    return expMonth === tMonth;
  }
  // Step-7 DASH-ACTIVEFORTERM-GRANULARITY (sibling fix): compare the recurring
  // window at MONTH granularity, matching the server (1_base.ts) so a recurring
  // expense with a mid-month startTerm (day != 01 via seed/legacy/import) isn't
  // wrongly excluded from the breakdown.
  const tMonth2 = Math.floor(Number(term) / 10000);
  if (tMonth2 < Math.floor(Number(expense.startTerm) / 10000)) return false;
  if (expense.endTerm && tMonth2 > Math.floor(Number(expense.endTerm) / 10000))
    return false;
  return true;
}

// Build, for a given term, the list of expense rows the landlord should
// see. Each row is { expenseId, name, amount, kind, allocationMethod,
// isOwner } where kind ∈ {'variable','fixed'}.
//   - variable: recurring with NO fixed amount → needs monthly entry.
//     amount comes from persisted monthlyCharges (sum across units) for
//     this term, else blank.
//   - fixed: has a known amount (one-off or recurring-with-amount).
function buildRowsForTerm(building, term, isOwnerSide) {
  const units = building?.units || [];
  const expenses = building?.expenses || [];
  const ownerEntries = building?.ownerMonthlyExpenses || [];
  const rows = [];

  for (const expense of expenses) {
    const tracksOwner = !!expense.trackOwnerExpense;
    // Owner side shows owner-tracked expenses; tenant side shows all
    // expenses (owner-tracked ones still bill tenants for their share).
    if (isOwnerSide && !tracksOwner) continue;

    const fixedAmount = isOwnerSide ? expense.ownerAmount : expense.amount;
    const isVariable = expense.isRecurring && !fixedAmount;

    if (isVariable) {
      // Only surface if active for this term.
      if (!isExpenseActiveForTerm(expense, term)) continue;
      let persisted = 0;
      let hasPersisted = false;
      if (isOwnerSide) {
        const e = ownerEntries.find(
          (o) => o.term === Number(term) && String(o.expenseId) === String(expense._id)
        );
        if (e) {
          persisted = e.amount || 0;
          hasPersisted = true;
        }
      } else {
        // Read back the ENTERED statement figure (inputAmount), not the
        // sum of per-unit shares. Summing shares under-reports whenever a
        // unit is vacant or a share rounds, so re-saving the summed value
        // eroded the amount toward zero. Every per-unit charge for this
        // expense+term carries the same inputAmount, so take the first.
        // Fall back to summing shares only for legacy rows written before
        // inputAmount existed (inputAmount == null).
        let legacyShareSum = 0;
        let sawLegacy = false;
        for (const unit of units) {
          if (!unit.monthlyCharges) continue;
          for (const c of unit.monthlyCharges) {
            if (
              c.term === Number(term) &&
              (String(c.expenseId) === String(expense._id) ||
                c.description === expense.name)
            ) {
              if (c.inputAmount != null) {
                persisted = c.inputAmount;
                hasPersisted = true;
              } else {
                legacyShareSum += c.amount || 0;
                sawLegacy = true;
              }
            }
          }
        }
        if (!hasPersisted && sawLegacy) {
          persisted = legacyShareSum;
          hasPersisted = true;
        }
      }
      rows.push({
        expenseId: String(expense._id),
        name: expense.name,
        type: expense.type,
        kind: 'variable',
        amount: hasPersisted ? persisted : '',
        allocationMethod: expense.allocationMethod,
        isOwner: isOwnerSide
      });
    } else if (fixedAmount) {
      if (!isExpenseActiveForTerm(expense, term)) continue;
      rows.push({
        expenseId: String(expense._id),
        name: expense.name,
        type: expense.type,
        kind: 'fixed',
        amount: Number(fixedAmount) || 0,
        allocationMethod: expense.allocationMethod,
        isOwner: isOwnerSide
      });
    }
  }
  return rows;
}

// Which terms (YYYYMMDDHH) have ANY data — drives the calendar dots.
function termsWithData(building) {
  const set = new Set();
  const units = building?.units || [];
  const expenses = building?.expenses || [];
  const ownerEntries = building?.ownerMonthlyExpenses || [];

  for (const unit of units) {
    for (const c of unit.monthlyCharges || []) {
      if (c.term) set.add(String(c.term));
    }
  }
  for (const e of ownerEntries) {
    if (e.term) set.add(String(e.term));
  }
  // Recurring/fixed expenses project across their active range. Use LOCAL
  // moment() for the current-month cap so it matches the calendar grid and
  // selection (which are local) — mixing moment.utc() here lagged the dot
  // by a month during the first 2-3h of a month in Athens (UTC+2/+3).
  const currentTerm = Number(moment().startOf('month').format('YYYYMMDDHH'));
  for (const expense of expenses) {
    if (!expense.startTerm) continue;
    // A VARIABLE recurring expense (recurring, no fixed amount on either
    // side) has NO data until the landlord enters a monthly amount — that
    // entry is persisted as a unit.monthlyCharge / ownerMonthlyExpense and
    // already dotted by the loops above. Projecting it here would dot every
    // active month unconditionally, destroying the filled-vs-blank signal
    // the calendar dots exist to give. Skip the projection for it; only its
    // real saved entries should dot.
    const isVariable =
      expense.isRecurring &&
      !Number(expense.amount) &&
      !Number(expense.ownerAmount);
    if (isVariable) continue;
    const start = Number(expense.startTerm);
    const end = expense.endTerm
      ? Number(expense.endTerm)
      : expense.isRecurring === false
        ? start
        : currentTerm;
    let cursor = moment.utc(String(start).padEnd(10, '0'), 'YYYYMMDDHH');
    const endMoment = moment.utc(String(end).padEnd(10, '0'), 'YYYYMMDDHH');
    let guard = 0;
    while (cursor.isSameOrBefore(endMoment, 'month') && guard < 600) {
      const term = cursor.format('YYYYMM') + '0100';
      if (isExpenseActiveForTerm(expense, term)) set.add(term);
      cursor.add(1, 'month');
      guard++;
    }
  }
  return set;
}

function ExpenseRow({ row, value, onChange, onSave, saving, t }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm py-0.5">
      <span className="text-muted-foreground min-w-0 flex-1 truncate">
        {/* Left-panel monthly statement (FIX_PLAN §470-503): show the TYPE label
            with the name in parens — "Τύπος (όνομα)" — the SAME convention the
            right-panel breakdown uses (expenseDisplayLabel). The allocation
            method "(Ισομερής)" was removed: per §500-501 it's noise here (the
            landlord doesn't need to see HOW it's split on the statement line). */}
        {expenseDisplayLabel(t, row.name, row.type)}
      </span>
      {row.kind === 'variable' ? (
        <div className="flex items-center gap-1.5 shrink-0">
          <Input
            type="number"
            step="0.01"
            min="0"
            className="w-24 h-8 text-right text-sm"
            value={value ?? ''}
            onChange={(e) => onChange(row.expenseId, e.target.value)}
            placeholder="0.00"
          />
          <span className="text-xs text-muted-foreground">€</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onSave(row)}
            disabled={saving}
            aria-label={t('Save')}
          >
            <LuSave className="size-4" />
          </Button>
        </div>
      ) : (
        // Fixed-width money cell so read-only amounts align to the same right
        // rail as the subtotals + breakdown figures (ledger alignment).
        <span className="w-28 text-right tabular-nums font-medium whitespace-nowrap shrink-0">
          <NumberFormat value={Number(row.amount || 0)} />
        </span>
      )}
    </div>
  );
}

export default function BuildingExpensePanel({ building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const currentTerm = useMemo(
    () => moment().startOf('month').format('YYYYMMDDHH'),
    []
  );
  const [selectedTerm, setSelectedTerm] = useState(currentTerm);
  const [visibleYear, setVisibleYear] = useState(() =>
    moment().format('YYYY')
  );
  // Draft amounts for variable rows, keyed `${tenant|owner}:${expenseId}`.
  const [drafts, setDrafts] = useState({});
  // Keys the user has typed into but not yet saved. A background building
  // refetch (e.g. editing another expense in the sibling ExpenseList)
  // changes the `building` reference and re-fires the seed effect; without
  // this guard that re-seed would silently wipe a typed-but-unsaved amount
  // back to its persisted value (blank). We re-seed only NON-dirty keys on
  // a row change, and fully reset (clearing dirty) only when the selected
  // month changes.
  const dirtyKeys = useRef(new Set());
  const prevTermRef = useRef(selectedTerm);

  const dataTerms = useMemo(() => termsWithData(building), [building]);

  const tenantRows = useMemo(
    () => buildRowsForTerm(building, selectedTerm, false),
    [building, selectedTerm]
  );
  const ownerRows = useMemo(
    () => buildRowsForTerm(building, selectedTerm, true),
    [building, selectedTerm]
  );

  const hasAnyConfiguredExpense = (building?.expenses || []).length > 0;

  // Seed drafts from persisted amounts. On a month change: full reset and
  // clear dirty tracking. On a row-identity change within the same month
  // (background refetch): preserve dirty (unsaved) keys; re-seed the rest.
  useEffect(() => {
    const monthChanged = prevTermRef.current !== selectedTerm;
    prevTermRef.current = selectedTerm;
    const persisted = {};
    for (const r of tenantRows) {
      if (r.kind === 'variable') persisted[`tenant:${r.expenseId}`] = r.amount;
    }
    for (const r of ownerRows) {
      if (r.kind === 'variable') persisted[`owner:${r.expenseId}`] = r.amount;
    }
    if (monthChanged) {
      dirtyKeys.current = new Set();
      setDrafts(persisted);
      return;
    }
    // Same month, rows changed: keep dirty keys as the user typed them,
    // refresh everything else from the persisted values.
    setDrafts((prev) => {
      const next = { ...persisted };
      for (const k of dirtyKeys.current) {
        if (k in prev) next[k] = prev[k];
      }
      return next;
    });
  }, [selectedTerm, tenantRows, ownerRows]);

  // Authoritative per-recipient breakdown for the selected month — who is
  // charged what (each unit's renter, or the owner when vacant). Computed
  // server-side with the real billing engine so it matches what is actually
  // charged. Refetched whenever the month or the building data changes.
  const { data: breakdown } = useQuery({
    queryKey: ['expense-breakdown', building?._id, selectedTerm],
    queryFn: () => fetchExpenseBreakdown(building._id, selectedTerm),
    enabled: !!building?._id && !!selectedTerm && hasAnyConfiguredExpense
  });

  const mutation = useMutation({
    mutationFn: (payload) => saveMonthlyStatement(building._id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building._id]
      });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: ['expense-breakdown'] });
      // Saving a statement now materialises vacant-owner rows (variable-expense
      // shares), so the owner ledger + accounting tabs must refresh too.
      queryClient.invalidateQueries({ queryKey: [QueryKeys.OWNERS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
    }
  });

  const handleDraftChange = useCallback((expenseId, value, isOwner) => {
    const key = `${isOwner ? 'owner' : 'tenant'}:${expenseId}`;
    dirtyKeys.current.add(key);
    setDrafts((prev) => ({
      ...prev,
      [key]: value === '' ? '' : Number(value)
    }));
  }, []);

  // Save the single edited variable row. The monthly-statement endpoint
  // takes the full set for the term, so we send every variable row's
  // current draft (the edited one plus the others' persisted values) to
  // avoid clobbering siblings.
  const handleSaveRow = useCallback(
    async () => {
      const buildEntries = (rows, isOwner) =>
        rows
          .filter((r) => r.kind === 'variable')
          .map((r) => {
            const key = `${isOwner ? 'owner' : 'tenant'}:${r.expenseId}`;
            const raw = drafts[key];
            const amount =
              raw === '' || raw == null || Number.isNaN(Number(raw))
                ? 0
                : Number(raw);
            return {
              expenseId: r.expenseId,
              amount,
              description: r.name,
              ...(isOwner ? {} : { allocationMethod: r.allocationMethod })
            };
          });

      try {
        setSaving(true);
        await mutation.mutateAsync({
          term: Number(selectedTerm),
          expenses: buildEntries(tenantRows, false),
          ownerExpenses: buildEntries(ownerRows, true)
        });
        // All variable drafts for this term were just persisted — clear
        // the dirty set so the post-save refetch re-seeds them with the
        // server-normalized (rounded) values rather than the raw typed ones.
        dirtyKeys.current = new Set();
        toast.success(t('Monthly statement saved'));
      } catch (e) {
        toast.error(t('Something went wrong'));
      } finally {
        setSaving(false);
      }
    },
    [drafts, selectedTerm, tenantRows, ownerRows, mutation, t]
  );

  const handleYearPrev = useCallback(
    () => setVisibleYear((y) => String(Number(y) - 1)),
    []
  );
  const handleYearNext = useCallback(
    () => setVisibleYear((y) => String(Number(y) + 1)),
    []
  );

  const monthLabel = useMemo(
    () =>
      moment.utc(String(selectedTerm).padEnd(10, '0'), 'YYYYMMDDHH').format(
        'MMMM YYYY'
      ),
    [selectedTerm]
  );

  const tenantTotal = useMemo(
    () =>
      tenantRows.reduce((s, r) => {
        const key = `tenant:${r.expenseId}`;
        const v = r.kind === 'variable' ? drafts[key] : r.amount;
        return s + (Number(v) || 0);
      }, 0),
    [tenantRows, drafts]
  );
  const ownerTotal = useMemo(
    () =>
      ownerRows.reduce((s, r) => {
        const key = `owner:${r.expenseId}`;
        const v = r.kind === 'variable' ? drafts[key] : r.amount;
        return s + (Number(v) || 0);
      }, 0),
    [ownerRows, drafts]
  );

  if (!hasAnyConfiguredExpense) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/30 text-muted-foreground p-4 flex gap-3 items-start">
        <LuInfo className="h-5 w-5 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {t('Monthly entry')}
          </p>
          <p className="text-sm leading-relaxed">
            {t('Variable expense placeholder body')}
          </p>
        </div>
      </div>
    );
  }

  return (
    // Single full-width vertical stack (user request 2026-06): the calendar +
    // month detail span the whole panel on top; the ΧΡΕΩΣΕΙΣ breakdown sits
    // entirely BELOW (was a side-by-side 2-col grid that cramped both halves).
    <div className="space-y-6">
      {/* TOP — calendar + month total + variable-amount entry rows */}
      <div className="min-w-0">
      {/* Centered year navigator */}
      <div className="flex items-center justify-center gap-6 mb-3">
        <button
          onClick={handleYearPrev}
          className="p-1 rounded hover:bg-muted transition-colors"
          aria-label={t('Previous')}
        >
          <LuChevronLeft className="size-4" />
        </button>
        <span className="text-sm font-medium tabular-nums w-16 text-center">
          {visibleYear}
        </span>
        <button
          onClick={handleYearNext}
          className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-30"
          disabled={Number(visibleYear) >= Number(moment().format('YYYY'))}
          aria-label={t('Next')}
        >
          <LuChevronRight className="size-4" />
        </button>
      </div>

      {/* Month grid — 6 columns × 2 rows now that the calendar owns the full
          panel width (was 4×3 in the cramped left column). */}
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-1.5 mb-5">
        {Array.from({ length: 12 }, (_, i) => {
          const m = moment(
            `${visibleYear}-${String(i + 1).padStart(2, '0')}-01`
          );
          const term = m.format('YYYYMM') + '0100';
          const isFuture = m.isAfter(moment(), 'month');
          const hasData = dataTerms.has(term);
          const isSelected = term === selectedTerm;
          return (
            <button
              key={i}
              disabled={isFuture}
              onClick={() => setSelectedTerm(term)}
              className={cn(
                'relative px-2 py-1.5 text-xs rounded-md transition-all duration-150 border border-transparent',
                isSelected
                  ? 'bg-sea-tint text-sea-deep border-sea/40 font-medium'
                  : isFuture
                    ? 'text-muted-foreground/40 cursor-not-allowed'
                    : 'bg-muted/60 hover:bg-muted text-foreground cursor-pointer hover:border-border'
              )}
            >
              {m.format('MMM')}
              {hasData && !isSelected && (
                <span className="absolute top-1 right-1 size-1.5 rounded-full bg-olive" />
              )}
            </button>
          );
        })}
      </div>

      <Separator className="mb-5" />

      {/* ZONE A header — ONE line: «Μηνιαία Καταχώρηση (Ιούνιος 2026)» + the
          COMBINED month total (tenants + owners) on the right. Names the entry
          zone AND its month in a single title so it reads as one distinct
          concept from the ΧΡΕΩΣΕΙΣ breakdown zone below (the user's "two areas
          not separated" complaint + the explicit "one line" request). Serif
          display register = the figure/label to pause on. The old "Χρέωση
          ενοικιαστών" caption is gone: the two amounts are itemized under their
          own ΕΝΟΙΚΙΑΣΤΕΣ / ΙΔΙΟΚΤΗΤΕΣ subheaders below. */}
      <div className="flex items-baseline justify-between gap-2 mb-4">
        <span className="font-display text-headline min-w-0">
          {t('Monthly entry')} ({monthLabel})
        </span>
        <span className="font-display text-headline tabular-nums whitespace-nowrap">
          <NumberFormat value={tenantTotal + ownerTotal} />
        </span>
      </div>

      {tenantRows.length === 0 && ownerRows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          {t('No expenses for this period')}
        </p>
      ) : (
        <div className="space-y-1">
          {tenantRows.length > 0 && (
            <>
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('Tenants')}
                </span>
                <span className="w-28 text-right text-xs font-medium text-muted-foreground tabular-nums">
                  <NumberFormat value={tenantTotal} />
                </span>
              </div>
              {tenantRows.map((row) => (
                <ExpenseRow
                  key={`t-${row.expenseId}`}
                  row={row}
                  value={drafts[`tenant:${row.expenseId}`]}
                  onChange={(id, v) => handleDraftChange(id, v, false)}
                  onSave={handleSaveRow}
                  saving={saving}
                  t={t}
                />
              ))}
            </>
          )}

          {ownerRows.length > 0 && (
            <>
              {/* whitespace, not a hairline — the uppercase subheader is enough
                  of a delimiter (the user flagged "all those lines"). */}
              {tenantRows.length > 0 && <div className="mt-4" />}
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('Owners')}
                </span>
                <span className="w-28 text-right text-xs font-medium text-muted-foreground tabular-nums">
                  <NumberFormat value={ownerTotal} />
                </span>
              </div>
              {ownerRows.map((row) => (
                <ExpenseRow
                  key={`o-${row.expenseId}`}
                  row={row}
                  value={drafts[`owner:${row.expenseId}`]}
                  onChange={(id, v) => handleDraftChange(id, v, true)}
                  onSave={handleSaveRow}
                  saving={saving}
                  t={t}
                />
              ))}
            </>
          )}
        </div>
      )}
      </div>

      {/* BOTTOM — who is charged (the breakdown), full width below the calendar */}
      <div className="min-w-0">
        <ChargeBreakdown
          breakdown={breakdown}
          building={building}
          term={selectedTerm}
          t={t}
        />
      </div>
    </div>
  );
}

/*
 * ChargeBreakdown — the "who gets charged what" view the landlord asked
 * for: for the selected month, every per-unit share grouped by recipient
 * (the unit's renter, or the OWNER when the unit is vacant and the share is
 * therefore not billed to anyone), plus owner-direct entries. Computed
 * server-side with the real billing engine so it always matches what is
 * actually charged.
 */
// Map an expense schema `type` to its localized label, reusing the SAME
// keys ExpenseList defines (so the two surfaces never drift). 'repair' is a
// synthetic type the breakdown attaches to repair-sourced rows.
const EXPENSE_TYPE_LABEL = {
  heating: 'Heating',
  elevator: 'Elevator',
  cleaning: 'Cleaning',
  water_common: 'Water Common',
  electricity_common: 'Electricity Common',
  insurance: 'Insurance',
  management_fee: 'Management Fee',
  garden: 'Garden',
  repairs_fund: 'Repairs Fund',
  pest_control: 'Pest Control',
  repair: 'Repair',
  other: 'Other'
};

// Strip the redundant building-name prefix from a unit's property name so the
// breakdown doesn't repeat 'ΑΓ. ΟΔΟΣ ΕΨΙΛΟΝ 28 - ' on every one of 11 rows. The
// building name is already the page title, so each row only needs its unit
// suffix ('Υπόγειο', '1ος όροφος'). Returns the original name when it isn't a
// '<building> - <unit>' compound (so non-conforming names never get mangled).
function unitLabel(buildingName, propertyName) {
  const p = String(propertyName || '').trim();
  const b = String(buildingName || '').trim();
  if (!p || !b || p === b) return p;
  if (p.startsWith(b)) {
    const rest = p.slice(b.length).replace(/^[\s\-·,]+/, '').trim();
    return rest || p;
  }
  return p;
}

// The human label for an expense/owner/repair row: prefer the TYPE label;
// append the user-given name only when it's a real name (not an id, not equal
// to the type label). So 'Κοιν. Νερό' for an id-named water expense, and
// 'Κοιν. Νερό (ΔΕΗ Ιουνίου)' when a real name adds information.
// ALWAYS render "Τύπος (Όνομα)" so the user sees BOTH the expense kind AND the
// name they declared in the form. The ONLY suppression is when the name is
// EXACTLY equal to the type label (diacritic/case-insensitive) — then the
// parenthetical would be a pure duplicate ('Κοινόχρηστο Νερό (Κοινόχρηστο
// Νερό)'). The user's rule (2026-06): never silently drop a name the user
// typed — not even hash-looking ones; if a name is junk the user must SEE it
// to fix it, not have the UI hide it.
function expenseDisplayLabel(t, name, type) {
  const typeLabel = type && EXPENSE_TYPE_LABEL[type] ? t(EXPENSE_TYPE_LABEL[type]) : '';
  const realName = String(name || '').trim();
  const norm = (s) =>
    String(s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim();
  const isExactDuplicate =
    realName && typeLabel && norm(realName) === norm(typeLabel);
  if (typeLabel && realName && !isExactDuplicate) {
    return `${typeLabel} (${realName})`;
  }
  return typeLabel || realName || t('Expense');
}

// Render the structured ShareBasis (from the server) as a localized,
// HUMAN-READABLE calc explanation showing the full operation:
//   equal:       1,70 € ÷ 11 μονάδες = 0,15 €
//   surface:     50 τ.μ. ÷ 600 τ.μ. × 120 € = 10 €
//   thousandths: 150‰ ÷ 1000‰ × 120 € = 18 €
//   fixed:       σταθερό ποσό μονάδας
//   single_unit: όλο το ποσό σε μία μονάδα
// Returns '' only when there is genuinely nothing to explain ('none').
function formatBasis(t, basis, fmt) {
  if (!basis || typeof basis !== 'object') return '';
  // el-GR money formatter for the euro tokens inside the basis string. Without
  // it the raw JS numbers render '1.7' (dot decimal, unpadded) instead of the
  // mandated '1,70'. The template strings already carry a literal ' €', so we
  // STRIP the currency symbol the formatter adds — otherwise the cell rendered
  // a doubled sign ('1,70 € €'). count/‰/m² are NOT currency — leave them raw.
  const e = (n) =>
    fmt ? fmt(Number(n) || 0).replace(/\s*€\s*/g, '').trim() : n;
  // Non-currency quantity formatter (m² / thousandths): el-GR decimal comma,
  // but NO € sign and NO forced 2-decimals (a surface like 66,75 keeps its
  // value; an integer ‰ like 150 stays 150). Without this, part/whole rendered
  // as raw JS '66.75' with a DOT — wrong for el-GR (the user flagged it).
  const q = (n) => {
    const num = Number(n);
    if (!Number.isFinite(num)) return n;
    return num.toLocaleString('el-GR', { maximumFractionDigits: 2 });
  };
  switch (basis.kind) {
    // Wording approved by the user (2026-06): original equation order, with a
    // short label naming each non-currency number (επιφάνεια/χιλιοστά). Fixed +
    // single_unit have no division → state the rule. custom_ratio shows the
    // bare ratio in parens "(2 ÷ 5)".
    case 'equal':
      return t('{{total}} € ÷ {{count}} units = {{share}} €', {
        total: e(basis.total),
        count: basis.count,
        share: e(basis.share)
      });
    case 'surface':
      return t(
        'unit surface {{part}} m² ÷ total {{whole}} m² × cost {{total}} € = {{share}} €',
        {
          part: q(basis.part),
          whole: q(basis.whole),
          total: e(basis.total),
          share: e(basis.share)
        }
      );
    case 'thousandths':
      return t(
        'unit thousandths {{part}} ÷ {{whole}} total × cost {{total}} € = {{share}} €',
        {
          part: q(basis.part),
          whole: q(basis.whole),
          total: e(basis.total),
          share: e(basis.share)
        }
      );
    case 'fixed':
      return t('fixed amount per unit: {{share}} €', { share: e(basis.share) });
    case 'single_unit':
      return t('the whole amount is charged to one unit: {{share}} €', {
        share: e(basis.share)
      });
    case 'custom_ratio':
      // Server ships part/whole (the unit's ratio share and the sum of ratios);
      // render "(2 ÷ 5) × cost 30,00 € = 12,00 €". Falls back to just the share
      // when the numbers aren't present (legacy basis).
      return basis.part != null && basis.whole != null
        ? t('({{part}} ÷ {{whole}}) × cost {{total}} € = {{share}} €', {
            part: basis.part,
            whole: basis.whole,
            total: e(basis.total),
            share: e(basis.share)
          })
        : t('custom ratio share: {{share}} €', { share: e(basis.share) });
    case 'custom_percentage':
      return basis.part != null
        ? t('unit percentage {{part}}% × cost {{total}} € = {{share}} €', {
            part: basis.part,
            total: e(basis.total),
            share: e(basis.share)
          })
        : t('custom percentage share: {{share}} €', { share: e(basis.share) });
    // §1.2/§1.3: repair owner-portion = cost × owner% (= 100 − tenant%).
    case 'repair_split':
      return t('cost {{total}} € × owner share {{pct}}% = {{share}} €', {
        total: e(basis.total),
        pct: basis.ownerPct,
        share: e(basis.result)
      });
    // §1.2/§1.3: a vacant unit's slice of the repair's tenant pool, routed to
    // the owner. Approved 2-line form: line 1 = cost × tenant% = pool; line 2 =
    // this vacant unit's share. We return the FIRST line here; the second
    // ("μερίδιο κενής μονάδας: X €") is rendered as its own line by the caller
    // (see repairVacantShareLine).
    case 'repair_vacant':
      return t('cost {{total}} € × tenants share {{pct}}% = {{pool}} €', {
        total: e(basis.total),
        pct: basis.tenantPct,
        pool: e(basis.pool)
      });
    default:
      return '';
  }
}

// Second line for a repair_vacant basis: how the tenant pool is split to THIS
// vacant unit — the REAL division (pool ÷ N μονάδες / by m² / by ‰ = slice),
// when the server resolved the per-unit divisor (basis.allocKind). Falls back
// to the bare "vacant-unit share: X €" when the divisor isn't resolvable.
function repairVacantShareLine(t, basis, fmt) {
  if (!basis || basis.kind !== 'repair_vacant') return '';
  const e = (n) => (fmt ? fmt(Number(n) || 0).replace(/\s*€\s*/g, '').trim() : n);
  // el-GR quantity formatter (comma decimal, no €) for m²/‰ part/whole.
  const q = (n) => {
    const num = Number(n);
    return Number.isFinite(num)
      ? num.toLocaleString('el-GR', { maximumFractionDigits: 2 })
      : n;
  };
  const pool = e(basis.pool);
  const share = e(basis.result);
  switch (basis.allocKind) {
    case 'equal':
      return t('vacant-unit share: {{pool}} € ÷ {{count}} units = {{share}} €', {
        pool,
        count: basis.count,
        share
      });
    case 'surface':
      return t(
        'vacant-unit share: unit {{part}} m² ÷ total {{whole}} m² × {{pool}} € = {{share}} €',
        { part: q(basis.part), whole: q(basis.whole), pool, share }
      );
    case 'thousandths':
      return t(
        'vacant-unit share: unit {{part}} ÷ {{whole}} total × {{pool}} € = {{share}} €',
        { part: q(basis.part), whole: q(basis.whole), pool, share }
      );
    default:
      return t('vacant-unit share: {{share}} €', { share });
  }
}

function OwnerName({ name, percentage }) {
  // Show just the owner name (with percentage if co-owned). No "Ιδιοκτήτης:"
  // prefix — the section heading already makes the owner context obvious.
  const showPct =
    Number.isFinite(Number(percentage)) && Number(percentage) < 100;
  if (!name) return null;
  return (
    <span className="font-normal text-muted-foreground">
      · {showPct ? `${name} (${percentage}%)` : name}
    </span>
  );
}

// Per-owner € split parenthesis for a co-owned amount: "(ΒΗΤΑ 50% = €50,
// ΓΕΩΡΓΙΟΣ 50% = €50)". `owners` is the server-computed slice array
// (name + percentage + € amount). Renders nothing for a single owner. A slice
// with isRest:true is the un-identified remainder co-owner — labeled "λοιποί"
// (others) so the parenthesis still reconciles to the full share when the E9
// only carried one of the co-owners.
function CoOwnerSplit({ owners, t, formatNumber }) {
  if (!Array.isArray(owners) || owners.length < 2) return null;
  // Own full-width line, prefixed «Ιδιοκτήτες:» so the co-owner split is clearly
  // labelled (was a bare "50% = 2,43" that read as gibberish). Each co-owner as
  // "NAME pct% (€amount)".
  return (
    <div className="text-label text-muted-foreground/80 leading-tight">
      <span className="uppercase tracking-wide mr-1">{t('Owners')}:</span>
      {owners
        .map((o) =>
          t('{{name}} {{pct}}% ({{amount}})', {
            name: o.isRest ? t('others') : o.name,
            pct: o.percentage,
            amount: formatNumber(o.amount)
          })
        )
        .join(' · ')}
    </div>
  );
}

// Per-unit group in the breakdown — the user-approved "Zebra 5·1" layout:
// each unit opens with a STRONG top rule (border-ink) + a bold header (unit
// label · recipient — total), then its expense lines INDENTED, each with the
// full allocation calc directly beneath. ALWAYS expanded (no collapse) so every
// figure + its derivation is visible at once; the rule per unit is what gives
// the clear "where each unit starts/ends" boundary the user asked for. NO
// information is ever hidden or abbreviated — label, amount, full calc string,
// repair-vacant 2nd line, and co-owner split all render verbatim.
function UnitGroup({ title, total, items, t, formatNumber, ownerTinted }) {
  return (
    <div className="border-t-2 border-ink/80 pt-2 mt-2 first:mt-0">
      {/* Unit header: label (+ recipient) on the left, total on the right rail. */}
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span
          className={cn(
            'font-semibold min-w-0 flex-1',
            ownerTinted && 'text-ink-muted'
          )}
        >
          {title}
        </span>
        <span className="w-24 text-right tabular-nums font-semibold whitespace-nowrap">
          <NumberFormat value={total} />
        </span>
      </div>
      <div className="mt-1 space-y-1.5">
        {items.map((it, ii) => {
          const basis = formatBasis(t, it.basis, formatNumber);
          return (
            <div key={ii} className="pl-4">
              <div className="flex items-baseline justify-between gap-2 text-sm text-ink-soft">
                <span className="min-w-0 flex-1">
                  {expenseDisplayLabel(t, it.expenseName, it.expenseType)}
                </span>
                <span className="w-24 text-right tabular-nums whitespace-nowrap">
                  <NumberFormat value={it.amount} />
                </span>
              </div>
              {/* Full allocation calc directly under the line (no prefix
                  label; the equation stands on its own). Never abbreviated. */}
              {basis && (
                <div className="text-label text-ink-muted/90 font-mono tabular-nums leading-snug mt-0.5">
                  {basis}
                </div>
              )}
              {/* repair_vacant: the vacant unit's share on its own 2nd line */}
              {it.basis?.kind === 'repair_vacant' && (
                <div className="text-label text-ink-muted/90 font-mono tabular-nums leading-snug">
                  {repairVacantShareLine(t, it.basis, formatNumber)}
                </div>
              )}
              {it.owners && (
                <CoOwnerSplit
                  owners={it.owners}
                  t={t}
                  formatNumber={formatNumber}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Collapsible roll-up for vacant units billed to the owner. Mirrors the
// Αχρέωτα warning pattern: ONE oxide header line carrying the unit count + the
// aggregate total, expanding to each vacant unit's full UnitGroup (so every
// per-unit ΑΤΑΚ / owner / amount / calc-basis is preserved one level in). This
// replaces the wall of ~10 near-identical "Υπόγειο — Κενό … 0,91 €" rows with
// a single meaningful line. Collapsed by default.
function VacantOwnerGroup({ groups, total, building, atakSuffix, t, formatNumber }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5 rounded-md bg-oxide-tint px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-sm text-left"
      >
        <span className="font-medium text-oxide truncate min-w-0 flex-1">
          ⚠ {t('Vacant units ({{count}})', { count: groups.length })}
        </span>
        <span className="flex items-baseline gap-1 shrink-0">
          <span className="w-20 text-right tabular-nums font-medium text-oxide whitespace-nowrap">
            <NumberFormat value={total} />
          </span>
          <LuChevronRight
            className={cn(
              'inline size-3 text-oxide transition-transform',
              open && 'rotate-90'
            )}
          />
        </span>
      </button>
      <p className="text-xs text-muted-foreground mt-1">
        {t('Charged to the owner because these units are vacant.')}
      </p>
      {open && (
        <div className="mt-2">
          {groups.map((g, gi) => (
            <UnitGroup
              key={`vac-${gi}`}
              ownerTinted
              title={
                <>
                  {unitLabel(building?.name, g.propertyName)}
                  <span className="font-normal text-muted-foreground/70">
                    {atakSuffix(g.propertyId)}
                  </span>
                  <OwnerName name={g.ownerName} percentage={g.ownerPercentage} />
                </>
              }
              total={g.total}
              items={g.items}
              t={t}
              formatNumber={formatNumber}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Truncate a long ΑΤΑΚ for inline display: keep the first 4 + last 4 digits
// ('0501…6789'). ΑΤΑΚs are ~12 digits — the full string crowds every row, and
// the user asked for the ΑΤΑΚ shown but truncated. Returns '' for empty input.
function truncateAtak(atak) {
  const s = String(atak || '').trim();
  if (!s) return '';
  if (s.length <= 9) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function ChargeBreakdown({ breakdown, building, term, t }) {
  const [showUncollected, setShowUncollected] = useState(false);
  const formatNumber = useFormatNumber();
  // ΑΤΑΚ per unit, keyed by propertyId, so every breakdown row can show the
  // unit's cadastral code (truncated) in parens. Built from the building's
  // units (the breakdown rows carry propertyId but not the ΑΤΑΚ).
  const atakByPropertyId = useMemo(() => {
    const m = new Map();
    for (const u of building?.units || []) {
      if (u.propertyId && u.atakNumber) {
        m.set(String(u.propertyId), String(u.atakNumber));
      }
    }
    return m;
  }, [building]);
  const atakSuffix = useCallback(
    (propertyId) => {
      const a = truncateAtak(atakByPropertyId.get(String(propertyId)));
      return a ? ` (${t('ATAK')} ${a})` : '';
    },
    [atakByPropertyId, t]
  );
  if (!breakdown || !Array.isArray(breakdown.rows)) return null;
  const renterRows = breakdown.rows.filter((r) => r.recipient === 'renter');
  // The ONLY owner rows we take from breakdown.rows are the UNCOLLECTED ones
  // (vacant unit, chargeOwnerWhenVacant OFF) → the Αχρέωτα warning. Everything
  // the owner is actually CHARGED — owner-tracked expenses, repair
  // owner-portions, and vacant shares billed to the owner — comes from
  // breakdown.ownerDirect, consolidated into one block. Settlement (paid /
  // καταβολές) is NOT shown here; it lives on the dedicated owner tab.
  const ownerVacantRows = breakdown.rows.filter(
    (r) => r.recipient === 'owner' && !r.ownerBilled
  );
  const ownerLiabilities = breakdown.ownerDirect || [];
  const uncollectedGross = ownerVacantRows.reduce(
    (s, r) => s + (Number(r.amount) || 0),
    0
  );
  // §5: subtract this term's VOLUNTARY contributions (building.uncollectedPayments)
  // from the gross Αχρέωτα. Note: term is a STRING ('YYYYMMDDHH'), the persisted
  // term is a Number — compare with Number(term) or the === silently never
  // matches. Clamp ≥0 (an over-contribution must not render a phantom credit).
  // Subtract ONLY the building subdoc (the single source); never also the
  // payer's rent/owner ledger — Option A keeps the euro off those entirely.
  const uncollectedPaidForTerm = (building?.uncollectedPayments || [])
    .filter((up) => Number(up.term) === Number(term))
    .reduce((s, up) => s + (Number(up.amount) || 0), 0);
  const uncollectedTotal = Math.max(
    0,
    Math.round((uncollectedGross - uncollectedPaidForTerm) * 100) / 100
  );

  if (renterRows.length === 0 && ownerLiabilities.length === 0 && ownerVacantRows.length === 0) {
    return null;
  }

  // Group renter rows by property so each apartment shows its renter + the
  // expenses charged to them.
  const byProperty = new Map();
  for (const r of renterRows) {
    if (!byProperty.has(r.propertyId)) {
      byProperty.set(r.propertyId, {
        propertyName: r.propertyName,
        recipientName: r.recipientName,
        items: [],
        total: 0
      });
    }
    const g = byProperty.get(r.propertyId);
    g.items.push(r);
    g.total += r.amount;
  }

  // Group owner liabilities by propertyId (NOT the non-unique propertyName) so
  // two same-named units never merge. Rows with no propertyId (building-wide
  // owner-direct costs) collapse under one nameless group. Then split into:
  //  - ownerGroups: building-wide + genuinely owner-tracked unit charges →
  //    rendered as individual UnitGroups (as before).
  //  - vacantGroups: empty units billed to the owner → collapsed under ONE
  //    "Κενές μονάδες (N)" disclosure so 10 near-identical rows become 1 line
  //    with a count + aggregate total (the user's "wall of identical rows").
  const ownerGroupMap = ownerLiabilities.reduce((map, e) => {
    const key = e.propertyId || '__nameless__';
    if (!map.has(key)) {
      map.set(key, {
        propertyId: e.propertyId || null,
        propertyName: e.propertyName || null,
        ownerName: e.ownerName || null,
        ownerPercentage: e.ownerPercentage,
        // A group is "vacant" only when ALL its rows are vacant-sourced.
        isVacant: true,
        items: [],
        total: 0
      });
    }
    const g = map.get(key);
    g.items.push(e);
    g.total += Number(e.amount) || 0;
    if (!g.ownerName && e.ownerName) g.ownerName = e.ownerName;
    if (g.ownerPercentage === undefined && e.ownerPercentage !== undefined)
      g.ownerPercentage = e.ownerPercentage;
    if (e.source !== 'vacant' && e.source !== 'repair-vacant')
      g.isVacant = false;
    return map;
  }, new Map());
  const allOwnerGroups = Array.from(ownerGroupMap.values());
  const ownerGroups = allOwnerGroups.filter((g) => !g.isVacant);
  const vacantGroups = allOwnerGroups.filter((g) => g.isVacant);
  const vacantTotal =
    Math.round(vacantGroups.reduce((s, g) => s + g.total, 0) * 100) / 100;

  return (
    // ZONE B "Χρεώσεις" sits on a CREAM tonal band, full-bleed to the tab
    // card's inner edges (-mx-6 / -mb-6 cancel the Card's p-6; rounded-b-lg
    // matches the card's bottom corners). This is the bone(98%)→cream(96%)
    // tonal-layer device the design system prescribes — it makes the breakdown
    // read as a distinct REGION from the bone entry zone above, which a bare
    // hairline could not. It is NOT a nested card: no border, no shadow, it
    // touches both edges. (The user's "the two areas are not clearly
    // separated" complaint.)
    <div className="-mx-6 -mb-6 mt-8 rounded-b-lg bg-cream px-6 pb-6 pt-5">
      {/* ZONE B title — serif display register, same weight as the ZONE A
          "Μηνιαία Καταχώρηση" title, so the two zones read as peers. */}
      <div className="font-display text-headline mb-4">{t('Charges')}</div>

      {/* Renters → per apartment */}
      {byProperty.size > 0 && (
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
          {t('Tenants')}
        </div>
      )}
      {Array.from(byProperty.entries()).map(([propertyId, g], gi) => (
        <UnitGroup
          key={`p-${gi}`}
          title={
            <>
              {unitLabel(building?.name, g.propertyName)}
              <span className="font-normal text-muted-foreground/70">
                {atakSuffix(propertyId)}
              </span>
              <span className="ml-1 font-normal text-muted-foreground">
                ·{' '}
                {g.recipientName
                  ? t('Renter: {{name}}', { name: g.recipientName })
                  : t('Renter')}
              </span>
            </>
          }
          total={g.total}
          items={g.items}
          t={t}
          formatNumber={formatNumber}
        />
      ))}

      {/* ONE consolidated owner block. Grouped by property and labeled with
          the OWNER NAME exactly like the renter rows ("property · Ιδιοκτήτης:
          <name>"), so each owner charge is attributed to a person, not left
          anonymous. Owner-direct rows that carry no propertyId (building-wide
          owner costs) fall under a nameless "Owner expenses" group. NO
          paid/settlement controls here — settlement (καταβολές, paid/unpaid)
          lives on the dedicated owner tab. */}
      {ownerLiabilities.length > 0 && (
        <div className="mt-5">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
            {t('Owners')}
          </div>
          {/* Building-wide + owner-tracked unit charges (non-vacant). */}
          {ownerGroups.map((g, gi) => (
            <UnitGroup
              key={`og-${gi}`}
              ownerTinted
              title={
                g.propertyId ? (
                  <>
                    {unitLabel(building?.name, g.propertyName)}
                    <span className="font-normal text-muted-foreground/70">
                      {atakSuffix(g.propertyId)}
                    </span>
                    <OwnerName
                      name={g.ownerName}
                      percentage={g.ownerPercentage}
                    />
                  </>
                ) : (
                  // Building-wide owner-tracked cost (no single unit): label it
                  // "Όλες οι μονάδες", with "(πλην κενών)" appended only when the
                  // building has vacant units (itemized in the roll-up below).
                  <>
                    {t('All units')}
                    {vacantGroups.length > 0 && (
                      <span className="font-normal text-muted-foreground/70">
                        {' '}
                        {t('(excluding vacant)')}
                      </span>
                    )}
                  </>
                )
              }
              total={g.total}
              items={g.items}
              t={t}
              formatNumber={formatNumber}
            />
          ))}
          {/* Vacant units billed to the owner → ONE oxide roll-up with a count
              + aggregate total, expanding to each unit's UnitGroup. Collapses
              the wall of ~10 identical "Υπόγειο — Κενό … 0,91 €" rows into a
              single meaningful line. No information dropped — every per-unit
              row (ΑΤΑΚ, owner, amount, basis-on-expand) lives one level in. */}
          {vacantGroups.length > 0 && (
            <VacantOwnerGroup
              groups={vacantGroups}
              total={vacantTotal}
              building={building}
              atakSuffix={atakSuffix}
              t={t}
              formatNumber={formatNumber}
            />
          )}
        </div>
      )}

      {/* Uncollected (vacant units, chargeOwnerWhenVacant OFF) — money that
          nobody pays. Collapsed by default into a single warning line so it
          doesn't dominate as a wall of identical rows; expandable for detail.
          Prompts the landlord to enable owner-billing if they want it charged. */}
      {ownerVacantRows.length > 0 && (
        <div className="mt-3 pt-2 border-t border-stone-line/50">
          <button
            type="button"
            onClick={() => setShowUncollected((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-sm text-left"
          >
            <span className="font-medium text-oxide truncate min-w-0 flex-1">
              ⚠ {t('Uncollected (vacant units)')}
            </span>
            <span className="tabular-nums font-medium text-oxide whitespace-nowrap shrink-0">
              <NumberFormat value={uncollectedTotal} />
              {showUncollected ? (
                <LuChevronRight className="inline size-3 ml-1 rotate-90" />
              ) : (
                <LuChevronRight className="inline size-3 ml-1" />
              )}
            </span>
          </button>
          <p className="text-xs text-muted-foreground mt-1">
            {t(
              'Enable "Charge owner for vacant units" on these expenses to bill the owner instead of leaving them uncollected.'
            )}
          </p>
          {showUncollected &&
            ownerVacantRows.map((r, i) => (
              <div
                key={`ov-${i}`}
                className="flex items-baseline justify-between gap-2 text-xs text-oxide/80 pl-3 mt-0.5"
              >
                <span className="truncate min-w-0 flex-1">
                  {unitLabel(building?.name, r.propertyName)}
                  {atakSuffix(r.propertyId)} ·{' '}
                  {expenseDisplayLabel(t, r.expenseName, r.expenseType)}
                </span>
                <span className="tabular-nums whitespace-nowrap shrink-0">
                  <NumberFormat value={r.amount} />
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
