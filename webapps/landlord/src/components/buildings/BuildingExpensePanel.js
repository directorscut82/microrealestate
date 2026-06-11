import {
  QueryKeys,
  saveMonthlyStatement
} from '../../utils/restcalls';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '../../utils';
import {
  LuChevronLeft,
  LuChevronRight,
  LuInfo,
  LuSave
} from 'react-icons/lu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/tooltip';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Separator } from '../ui/separator';
import NumberFormat from '../NumberFormat';
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

const ALLOCATION_LABELS = {
  equal: 'Equal',
  by_surface: 'By Surface',
  general_thousandths: 'General ‰',
  heating_thousandths: 'Heating ‰',
  elevator_thousandths: 'Elevator ‰',
  fixed: 'Fixed',
  custom_ratio: 'Custom Ratio',
  custom_percentage: 'Custom Percentage'
};

const ALLOCATION_DESCRIPTIONS = {
  equal: 'Split equally among all units',
  by_surface: 'Split proportionally by unit surface area (m²)',
  general_thousandths: 'Split by general thousandths (‰) from E9',
  heating_thousandths: 'Split by heating thousandths (‰) from E9',
  elevator_thousandths: 'Split by elevator thousandths (‰) — ground floor excluded',
  fixed: 'Each unit pays a fixed predefined amount',
  custom_ratio: 'Split by custom ratio shares you defined per unit',
  custom_percentage: 'Each unit pays a custom percentage of the total'
};

// Mirrors services/api/src/businesslogic/tasks/1_base.ts isExpenseActiveForTerm
function isExpenseActiveForTerm(expense, term) {
  if (!expense) return false;
  if (!expense.startTerm) return false;
  if (expense.isRecurring === false) {
    const expMonth = Math.floor(Number(expense.startTerm) / 10000);
    const tMonth = Math.floor(Number(term) / 10000);
    return expMonth === tMonth;
  }
  if (Number(term) < Number(expense.startTerm)) return false;
  if (expense.endTerm && Number(term) > Number(expense.endTerm)) return false;
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
        for (const unit of units) {
          if (!unit.monthlyCharges) continue;
          for (const c of unit.monthlyCharges) {
            if (
              c.term === Number(term) &&
              (String(c.expenseId) === String(expense._id) ||
                c.description === expense.name)
            ) {
              persisted += c.amount || 0;
              hasPersisted = true;
            }
          }
        }
      }
      rows.push({
        expenseId: String(expense._id),
        name: expense.name,
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
  // Recurring/fixed expenses project across their active range.
  const currentTerm = Number(moment.utc().startOf('month').format('YYYYMMDDHH'));
  for (const expense of expenses) {
    if (!expense.startTerm) continue;
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
        {row.name}
        {row.allocationMethod && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="ml-1 text-xs text-muted-foreground/70 border-b border-dotted border-muted-foreground/40 cursor-help">
                  (
                  {t(
                    ALLOCATION_LABELS[row.allocationMethod] ||
                      row.allocationMethod
                  )}
                  )
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px] text-xs">
                {t(ALLOCATION_DESCRIPTIONS[row.allocationMethod] || '')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
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
        <span className="tabular-nums font-medium whitespace-nowrap shrink-0">
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

  // Seed drafts from persisted amounts whenever the selected month changes.
  useEffect(() => {
    const seed = {};
    for (const r of tenantRows) {
      if (r.kind === 'variable') seed[`tenant:${r.expenseId}`] = r.amount;
    }
    for (const r of ownerRows) {
      if (r.kind === 'variable') seed[`owner:${r.expenseId}`] = r.amount;
    }
    setDrafts(seed);
  }, [selectedTerm, tenantRows, ownerRows]);

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
    }
  });

  const handleDraftChange = useCallback((expenseId, value, isOwner) => {
    const key = `${isOwner ? 'owner' : 'tenant'}:${expenseId}`;
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
    <div className="max-w-xl mx-auto">
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

      {/* Month grid */}
      <div className="grid grid-cols-4 gap-1.5 mb-5">
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
                  ? 'bg-primary text-primary-foreground border-primary shadow-sm'
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

      <Separator className="mb-4" />

      {/* Selected month detail */}
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-sm font-medium">{monthLabel}</span>
        <span className="text-sm font-semibold tabular-nums">
          <NumberFormat value={tenantTotal} />
        </span>
      </div>

      {tenantRows.length === 0 && ownerRows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          {t('No expenses for this period')}
        </p>
      ) : (
        <div className="space-y-1">
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

          {ownerRows.length > 0 && (
            <>
              <Separator className="my-2" />
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('Owner expenses')}
                </span>
                {ownerTotal !== 0 && (
                  <span className="text-xs italic text-muted-foreground tabular-nums">
                    <NumberFormat value={ownerTotal} />
                  </span>
                )}
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
  );
}
