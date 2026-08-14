import {
  QueryKeys,
  fetchBills,
  fetchExpenseBreakdown,
  saveMonthlyStatement
} from '../../utils/restcalls';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
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
import { isVariableExpense } from '../../utils/variableExpense';
import { billTermIsOutsideExpense } from '../../utils/billTerm';
import BillSourceDialog from './BillSourceDialog';
import {
  LuFileText,
  LuReceipt,
  LuScanLine,
  LuAlertTriangle
} from 'react-icons/lu';

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
// Exported for tests ONLY. These two decide, per expense and per month, whether the
// landlord sees an editable κυμαινόμενο input, a read-only figure, or nothing at
// all — and whether the month gets a calendar dot. Every branch is a money
// statement, so they are pinned by an exhaustive shape matrix rather than by
// asserting on the source text.
export function buildRowsForTerm(building, term, isOwnerSide) {
  const units = building?.units || [];
  const expenses = building?.expenses || [];
  const ownerEntries = building?.ownerMonthlyExpenses || [];
  const rows = [];

  for (const expense of expenses) {
    if (!expense || typeof expense !== 'object') continue;
    const tracksOwner = !!expense.trackOwnerExpense;
    // Owner side shows owner-tracked expenses; tenant side shows all
    // expenses (owner-tracked ones still bill tenants for their share).
    if (isOwnerSide && !tracksOwner) continue;

    // The tenant-side monthly cost of a `fixed`-allocation expense lives in
    // `customAllocations`, NOT in `amount` — `amount` is legitimately 0 there and
    // the rent engine still bills the per-unit figures (1_base.ts: the
    // `total <= 0` skip explicitly exempts `fixed`). Reading `amount` alone made
    // this panel call such an expense "variable" and render a blank input, i.e. it
    // said «nothing entered yet» about money already on the tenants' rents, and
    // contributed 0 to the month total while the ΧΡΕΩΣΕΙΣ breakdown underneath —
    // computed by the server — showed the real figures. Same resolution as
    // buildingprojection.expenseMonthlyCost and BuildingDashboard.
    const fixedAmount = isOwnerSide
      ? Number(expense.ownerAmount) || 0
      : expense.allocationMethod === 'fixed'
        ? (expense.customAllocations || []).reduce(
            (sum, a) => sum + (Number(a?.value) || 0),
            0
          )
        : Number(expense.amount) || 0;

    // The κυμαινόμενο decision goes through the SHARED predicate. This file had
    // its own hand-written copy (`expense.isRecurring && !fixedAmount`), so the
    // explicit `isVariable` flag added 2026-08-12 had NO effect on the panel the
    // landlord actually reads. Worst shape: `{isVariable: true, amount: 120}` with
    // an imported charge of 78,40 for the term — the panel showed a read-only
    // «120,00 €» and added 120 to the month total, while the breakdown below it
    // showed 78,40. One screen, two figures, and the 120 was charged to nobody.
    const isVariable = isVariableExpense(expense, fixedAmount);

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
      // `expense.isVariable === false` at a 0 amount is the UNFINISHED expense —
      // the state the flag was added to make distinguishable from a deliberate
      // κυμαινόμενο one. It must still be listed: routing it through the shared
      // predicate correctly stops calling it variable, and without this clause the
      // old `else if (fixedAmount)` dropped it, so the expense disappeared from the
      // panel altogether. Rendered read-only at 0 (its real amount) rather than as
      // an input, because a fixed amount is edited in the expense dialog.
    } else if (fixedAmount || expense.isVariable === false) {
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
export function termsWithData(building) {
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
    if (!expense || typeof expense !== 'object') continue;
    if (!expense.startTerm) continue;
    // A VARIABLE recurring expense (recurring, no fixed amount on either
    // side) has NO data until the landlord enters a monthly amount — that
    // entry is persisted as a unit.monthlyCharge / ownerMonthlyExpense and
    // already dotted by the loops above. Projecting it here would dot every
    // active month unconditionally, destroying the filled-vs-blank signal
    // the calendar dots exist to give. Skip the projection for it; only its
    // real saved entries should dot.
    // Same shared predicate, second copy. The cost is the larger of the two sides,
    // which for legacy rows is 0 exactly when both amounts are 0 — i.e. today's
    // `!amount && !ownerAmount` test, unchanged. `fixed` allocations resolve from
    // customAllocations here too, so a fixed expense carrying 0 keeps its dots.
    const tenantCost =
      expense.allocationMethod === 'fixed'
        ? (expense.customAllocations || []).reduce(
            (sum, a) => sum + (Number(a?.value) || 0),
            0
          )
        : Number(expense.amount) || 0;
    const isVariable = isVariableExpense(
      expense,
      Math.max(tenantCost, Number(expense.ownerAmount) || 0)
    );
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

/**
 * «PDF» / «OCR» / «Απόδειξη» pills on a δαπάνη row — the archived λογαριασμός made
 * reachable from the month it belongs to.
 *
 * Until now a bill's source was uploaded to B2, its key stored on `Bill.pdfUrl`,
 * and then rendered on NO surface in the app: the landlord could not see that a
 * document existed, let alone open it. Absent representation — a bill with a
 * scanned original looked identical to one typed in by hand.
 *
 * «PDF» when the stored file is the issuer's own document, «OCR» when it is a
 * photograph the recogniser read. That difference is worth showing: an OCR'd
 * figure was inferred from an image and is the one to double-check. A row with no
 * bill gets NO pill — never a greyed-out one, which would read as "there is a
 * document and it is broken".
 */
function BillPills({ bill, onOpen, t }) {
  if (!bill) return null;
  const isPdf = /\.pdf$/i.test(String(bill.pdfUrl || ''));
  const hasSource = !!bill.pdfUrl;
  const hasReceipt =
    (bill.receipts || []).some((r) => r?.proofUrl) || !!bill.paymentProofUrl;
  if (!hasSource && !hasReceipt) return null;
  return (
    <span className="flex items-center gap-1 shrink-0">
      {hasSource ? (
        <button
          type="button"
          onClick={() => onOpen(bill, 'bill')}
          data-cy="billSourcePill"
          title={isPdf ? t('Open the bill') : t('Open the scanned bill')}
          className="inline-flex items-center gap-1 h-5 rounded-full border border-stone-line bg-muted/60 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted hover:border-ink-muted hover:text-ink transition-colors"
        >
          {isPdf ? (
            <LuFileText className="size-3" />
          ) : (
            <LuScanLine className="size-3" />
          )}
          {isPdf ? t('PDF') : t('OCR')}
        </button>
      ) : null}
      {hasReceipt ? (
        <button
          type="button"
          onClick={() => onOpen(bill, 'receipt')}
          data-cy="billReceiptPill"
          title={t('Open the payment receipt')}
          className="inline-flex items-center gap-1 h-5 rounded-full border border-stone-line bg-muted/60 px-1.5 text-[10px] font-semibold tracking-wide text-ink-muted hover:border-ink-muted hover:text-ink transition-colors"
        >
          <LuReceipt className="size-3" />
          {t('Receipt')}
        </button>
      ) : null}
    </span>
  );
}

function ExpenseRow({ row, value, onChange, onSave, saving, t, bill, onOpenBill }) {
  return (
    // The tenant and owner lists render the SAME expense name, so a test (or a
    // screenshot reviewer) cannot tell the two rows apart from their text. The side
    // and the expense id are the only way to address one unambiguously.
    <div
      data-cy={row.isOwner ? 'ownerExpenseRow' : 'tenantExpenseRow'}
      data-expense={row.expenseId}
      className="flex items-center justify-between gap-2 text-sm py-0.5"
    >
      <span className="text-muted-foreground min-w-0 flex-1 truncate">
        {/* Left-panel monthly statement (FIX_PLAN §470-503): show the TYPE label
            with the name in parens — "Τύπος (όνομα)" — the SAME convention the
            right-panel breakdown uses (expenseDisplayLabel). The allocation
            method "(Ισομερής)" was removed: per §500-501 it's noise here (the
            landlord doesn't need to see HOW it's split on the statement line). */}
        {expenseDisplayLabel(t, row.name, row.type)}
      </span>
      <BillPills bill={bill} onOpen={onOpenBill} t={t} />
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
        // Per-EXPENSE line amount: SMALLER + regular weight + muted — it is
        // secondary to the section subtotal (ΕΝΟΙΚΙΑΣΤΕΣ/ΙΔΙΟΚΤΗΤΕΣ), which is
        // the bold/large figure to land on. Fixed-width so it aligns to the same
        // right rail as the subtotals.
        <span className="w-28 text-right tabular-nums text-xs font-normal text-ink-muted whitespace-nowrap shrink-0">
          <NumberFormat value={Number(row.amount || 0)} />
        </span>
      )}
    </div>
  );
}

export default function BuildingExpensePanel({ building }) {
  const { t } = useTranslation('common');
  // Locale-aware money formatting for the warning text below (the rest of the panel
  // renders amounts through <NumberFormat/>, which is not usable inside a t() value).
  const formatNumber = useFormatNumber();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  // moment.UTC, not local. The authority this mirrors is UTC throughout —
  // Contract._isFrozen -> _currentTermFor uses moment.utc (contract.ts:499) and
  // _frozenPropertyIdsForTerm likewise (buildingmanager.ts:7639). With local
  // time, for the first ~3h of a month on Athens (UTC+3) the client called the
  // new month "current" while the server's freeze boundary was still the old
  // one — so a charge entered for the old month read as NOT past here and was
  // silently frozen there. The documented moment.utc-vs-local trap.
  const currentTerm = useMemo(
    () => moment.utc().startOf('month').format('YYYYMMDDHH'),
    []
  );
  const [selectedTerm, setSelectedTerm] = useState(currentTerm);
  // The archived λογαριασμός / απόδειξη behind a δαπάνη row. ONE request per
  // building (not per row) — the Bill collection's unique index is exactly
  // (realmId, buildingId, expenseId, term), so the lookup below is an exact match
  // on the same key the server uses, not a heuristic.
  const { data: bills = [] } = useQuery({
    queryKey: [QueryKeys.BILLS, building?._id],
    queryFn: () => fetchBills({ buildingId: building?._id }),
    enabled: !!building?._id
  });
  const billByExpenseTerm = useMemo(() => {
    const m = new Map();
    for (const b of Array.isArray(bills) ? bills : []) {
      if (!b?.expenseId || !b?.term) continue;
      m.set(`${String(b.expenseId)}:${String(b.term)}`, b);
    }
    return m;
  }, [bills]);
  const [sourceDialog, setSourceDialog] = useState(null);

  /**
   * Bills attached to THIS month whose expense is not charged for it.
   *
   * The import dialog warns about this at the moment of import, and now the bot lane
   * does too — but both warnings are gone the second the operator moves on, and the
   * money stays invisible forever after. This is the persistent one: it appears in
   * the month the bill belongs to, which is where the landlord looks when a figure
   * seems to be missing. Live case: a ΔΕΗ bill for June on an expense starting in
   * August — €120 recorded, €0 charged, and until now nothing on any screen said so.
   */
  const orphanBillsForTerm = useMemo(() => {
    const expenses = building?.expenses || [];
    return (Array.isArray(bills) ? bills : [])
      .filter((b) => String(b?.term) === String(selectedTerm))
      .map((b) => {
        const exp = expenses.find(
          (e) => String(e?._id) === String(b.expenseId)
        );
        if (!exp) return null;
        if (!billTermIsOutsideExpense(exp, b.term)) return null;
        return { bill: b, expense: exp };
      })
      .filter(Boolean);
  }, [bills, building, selectedTerm]);
  const handleOpenBill = useCallback(
    (bill, kind) => setSourceDialog({ bill, kind }),
    []
  );
  const isPastTerm = Number(selectedTerm) < Number(currentTerm);
  // Contract._isFrozen ALSO freezes the CURRENT term once a tenant's rent for it
  // is fully paid (contract.ts:475 -> _isFullyPaid), so the phantom-receivable
  // case is not past-only — settling this month then entering a late κοινόχρηστα
  // figure hits it, which is the likeliest real sequence. Per-tenant paid status
  // is not in the breakdown payload, so rather than assert a certainty we cannot
  // compute, the current month carries a conditional note.
  const isCurrentTerm = Number(selectedTerm) === Number(currentTerm);
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
      {orphanBillsForTerm.length ? (
        <div
          className="rounded-md border border-oxide/40 bg-oxide/5 p-3 text-sm text-ink"
          data-cy="orphanBillWarning"
        >
          {orphanBillsForTerm.map(({ bill, expense }) => (
            <div key={String(bill._id)} className="flex items-start gap-2">
              <LuAlertTriangle className="mt-0.5 size-4 shrink-0 text-oxide" />
              <span>
                {t(
                  'A bill of {{amount}} is on file for «{{expense}}», but that expense is not charged this month — so it reaches no one. Adjust the expense period or the bill month.',
                  {
                    amount: formatNumber(Number(bill.totalAmount) || 0),
                    expense: expense.name
                  }
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* The archived document, opened from a row's pill: the bill on the left,
          the data read off it on the right. Mounted once for the whole panel —
          one dialog, whichever row was clicked. */}
      <BillSourceDialog
        open={!!sourceDialog}
        setOpen={(v) => !v && setSourceDialog(null)}
        bill={sourceDialog?.bill}
        kind={sourceDialog?.kind}
      />
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

      {/* A past month is CLOSED for tenant billing: Contract.update clones every
          rent with term < currentTerm verbatim (contract.ts:152), so a charge
          saved here persists and RENDERS in the breakdown below but can never
          reach a rent bill — a phantom receivable. saveMonthlyStatement has no
          frozen-term guard (the repair path has one, _assertChargeTermNotFrozen).
          Owner-side entries are unaffected, so this warns rather than blocks. */}
      {isPastTerm && (
        <div className="mb-4 rounded-md border border-oxide/40 bg-oxide-tint/40 p-3 text-sm text-ink">
          <div className="font-medium">
            {t('{{month}} is closed for tenant billing', {
              month: monthLabel
            })}
          </div>
          <div className="mt-1 text-label text-ink-muted">
            {t(
              'A tenant charge saved for a past month is not added to any rent — it will show in the breakdown below but bill nobody. Enter it in the current month instead. Owner charges are not affected.'
            )}
      {isCurrentTerm && (
        <div className="mb-4 rounded-md border border-stone-line bg-muted/40 p-3 text-sm text-ink-muted">
          {t(
            'If a tenant has already paid this month in full, their month is closed too — a charge added now will not reach that tenant. Check before entering a late figure.'
          )}
        </div>
      )}
          </div>
        </div>
      )}

      {tenantRows.length === 0 && ownerRows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          {t('No expenses for this period')}
        </p>
      ) : (
        <div className="space-y-1">
          {tenantRows.length > 0 && (
            <>
              <div className="flex items-baseline justify-between mb-2 mt-1">
                <span className="text-sm font-semibold uppercase tracking-wide text-ink-soft">
                  {t('Tenants')}
                </span>
                <span className="w-28 text-right text-base font-semibold text-ink tabular-nums">
                  <NumberFormat value={tenantTotal} />
                </span>
              </div>
              <div className="pl-4 space-y-0.5">
                {tenantRows.map((row) => (
                  <ExpenseRow
                    key={`t-${row.expenseId}`}
                    row={row}
                    value={drafts[`tenant:${row.expenseId}`]}
                    bill={billByExpenseTerm.get(
                      `${row.expenseId}:${selectedTerm}`
                    )}
                    onOpenBill={handleOpenBill}
                    onChange={(id, v) => handleDraftChange(id, v, false)}
                    onSave={handleSaveRow}
                    saving={saving}
                    t={t}
                  />
                ))}
              </div>
            </>
          )}

          {ownerRows.length > 0 && (
            <>
              {tenantRows.length > 0 && <div className="mt-8" />}
              <div className="flex items-baseline justify-between mb-2 mt-1">
                <span className="text-sm font-semibold uppercase tracking-wide text-ink-soft">
                  {t('Owners')}
                </span>
                <span className="w-28 text-right text-base font-semibold text-ink tabular-nums">
                  <NumberFormat value={ownerTotal} />
                </span>
              </div>
              <div className="pl-4 space-y-0.5">
                {ownerRows.map((row) => (
                  <ExpenseRow
                    key={`o-${row.expenseId}`}
                    row={row}
                    value={drafts[`owner:${row.expenseId}`]}
                    bill={billByExpenseTerm.get(
                      `${row.expenseId}:${selectedTerm}`
                    )}
                    onOpenBill={handleOpenBill}
                    onChange={(id, v) => handleDraftChange(id, v, true)}
                    onSave={handleSaveRow}
                    saving={saving}
                    t={t}
                  />
                ))}
              </div>
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
  electricity_private: 'Electricity Private',
  water_private: 'Water Private',
  gas_private: 'Gas Private',
  telecom_private: 'Telecom Private',
  telecom_common: 'Telecom Common',
  insurance: 'Insurance',
  management_fee: 'Management Fee',
  garden: 'Garden',
  repairs_fund: 'Repairs Fund',
  pest_control: 'Pest Control',
  repair: 'Repair',
  other: 'Other'
};

// Strip the redundant building-name prefix from a unit's property name so the
// breakdown doesn't repeat 'ΟΔΟΣ ΕΨΙΛΟΝ 28 - ' on every one of 11 rows. The
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
  // INTERNAL-CONSISTENCY BACKSTOP. Never print an equation whose left side does not
  // evaluate to its own stated result — render NO sub-line instead of a false one.
  //
  // The PDF has had this since two arithmetically-false equations shipped past a green
  // jest suite AND a static HTML mock (invoicebody.ejs:58-85, and its comment records
  // why). This panel did not, so it was the outlier: the χιλιοστά carrier-remainder
  // makes the CARRIER unit's charge differ from the raw part÷whole×total by up to
  // (N−1)/2 cents — measured 7,83 against an equation reading «90 ÷ 1000 × 87,43» on an
  // 11-unit building, i.e. the panel printed a sum that does not add up.
  //
  // Same EPS as the PDF (2 cents), so the two surfaces agree about what counts as
  // reconciled and a normal one-cent rounding still shows its explanation.
  const EPS = 0.02;
  let ok = false;
  let lhs;
  switch (basis.kind) {
    case 'equal':
      ok = Number(basis.count) > 0;
      if (ok) lhs = (Number(basis.total) || 0) / Number(basis.count);
      break;
    case 'surface':
    case 'thousandths':
    case 'custom_ratio':
      ok = Number(basis.whole) > 0;
      if (ok) {
        lhs =
          ((Number(basis.part) || 0) / Number(basis.whole)) *
          (Number(basis.total) || 0);
      }
      break;
    case 'custom_percentage':
      ok = true;
      lhs = ((Number(basis.part) || 0) / 100) * (Number(basis.total) || 0);
      break;
    case 'repair_split':
      ok = true;
      lhs = (Number(basis.total) || 0) * ((Number(basis.ownerPct) || 0) / 100);
      break;
    case 'repair_vacant':
      ok = true;
      lhs = (Number(basis.total) || 0) * ((Number(basis.tenantPct) || 0) / 100);
      break;
    case 'fixed':
    case 'single_unit':
      ok = true; // no divisor that could contradict the result
      break;
    default:
      return '';
  }
  if (!ok) return '';
  if (lhs !== undefined) {
    const rhs =
      basis.kind === 'repair_vacant'
        ? Number(basis.pool) || 0
        : basis.kind === 'repair_split'
          ? Number(basis.result) || 0
          : Number(basis.share) || 0;
    if (Math.abs(lhs - rhs) > EPS) return '';
  }
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

// Color-dot per expense TYPE so the eye can group expense kinds at a glance
// (the user-approved Grid 18·4 cue). Coarse mapping onto the 3 design accents +
// marble; any unknown type falls back to marble (a neutral tint).
const DOT_CLASS = {
  heating: 'bg-oxide',
  elevator: 'bg-oxide',
  repair: 'bg-sea-deep',
  insurance: 'bg-sea',
  management_fee: 'bg-marble',
  cleaning: 'bg-olive',
  garden: 'bg-olive',
  water_common: 'bg-sea',
  electricity_common: 'bg-oxide',
  repairs_fund: 'bg-sea-deep',
  pest_control: 'bg-olive',
  other: 'bg-marble'
};

// Localized suffix that disambiguates the kind of an owner charge, appended to
// the expense label so a vacant unit's TWO owner lines — the fixed OWNER amount
// and the vacant unit's share of the TENANT amount — read distinctly instead of
// two identical "Κοιν. Νερό" rows (the duplicate-line bug). Keyed by the
// server's row.kindLabel.
const KIND_SUFFIX = {
  'owner-amount': 'owner amount kind',
  'vacant-share': 'vacant share kind',
  'owner-resident': 'owner resident kind'
};

// The label for one owner-charge line: «Τύπος (Όνομα) — κενή μονάδα», with the
// kind suffix only when present.
function lineLabel(t, it) {
  const base = expenseDisplayLabel(t, it.expenseName, it.expenseType);
  const sk = it.kindLabel && KIND_SUFFIX[it.kindLabel];
  return sk ? `${base} — ${t(sk)}` : base;
}

// Grid 18·4 row emitter: returns the <tr>s for ONE unit — a bold header row plus
// one row per expense line (color-dot + «Τύπος (Όνομα) — είδος» | FULL allocation
// calc | amount). A line on a co-owned unit (it.owners.length > 1) expands into
// one PER-OWNER subrow underneath, each showing the full split calc
// («9,09 € × 50% = 4,55 €») and that owner's € — the user's directive: no name
// in the header, the breakdown spelled out per owner. A vacant-share line shows
// a ΚΕΝΟ pill. `tone` alternates the unit-block background.
function UnitRows({ header, total, items, tone, gap, seq, t, formatNumber }) {
  // ONE uniform 1px border on EVERY cell — no exceptions. (The earlier version
  // mixed border widths / opacity / border-b-0 under border-collapse → uneven
  // doubled hairlines.) Unit separation (user-selected variant 7): a numbered
  // chip on the unit header + a bare gap-band row between consecutive units.
  // The gap <td> spans all 3 columns with NO border, so it can't double a
  // hairline. All information stays — purely presentation.
  const cell = 'border border-stone-line px-3 py-2 align-top';
  return (
    <>
      {/* Gap band between consecutive units so each μονάδα reads as its own
          block. Background-tone fill, no side borders (avoids hairline doubling). */}
      {gap && (
        <tr aria-hidden="true">
          <td colSpan={3} className="h-2.5 bg-cream border-x-0 border-y border-stone-line p-0" />
        </tr>
      )}
      <tr className={tone}>
        <td className={cn(cell, 'font-semibold text-ink')} colSpan={2}>
          {Number.isFinite(seq) && (
            <span
              className="mr-2.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-[5px] bg-marble px-1 text-label font-semibold text-bone align-middle tabular-nums"
              aria-hidden="true"
            >
              {seq}
            </span>
          )}
          {header}
        </td>
        <td className={cn(cell, 'text-right tabular-nums font-semibold text-ink whitespace-nowrap')}>
          <NumberFormat value={total} />
        </td>
      </tr>
      {items.map((it, ii) => {
        const basis = formatBasis(t, it.basis, formatNumber);
        const coOwned = Array.isArray(it.owners) && it.owners.length > 1;
        return (
          <Fragment key={ii}>
            <tr className={tone}>
              {/* Expense label: muted, secondary to the unit header + money. */}
              <td className={cn(cell, 'text-ink-soft pl-6')}>
                <span
                  className={cn(
                    'inline-block size-1.5 rounded-full mr-2 align-middle',
                    DOT_CLASS[it.expenseType] || 'bg-marble'
                  )}
                  aria-hidden="true"
                />
                {lineLabel(t, it)}
              </td>
              {/* Calc: smallest, most muted — the explanation, not the answer. */}
              <td className={cn(cell, 'text-label text-ink-muted/75 tabular-nums leading-snug')}>
                {basis}
                {it.basis?.kind === 'repair_vacant' && (
                  <span className="block">
                    {repairVacantShareLine(t, it.basis, formatNumber)}
                  </span>
                )}
              </td>
              <td className={cn(cell, 'text-right tabular-nums text-ink-soft whitespace-nowrap')}>
                <NumberFormat value={it.amount} />
              </td>
            </tr>
            {/* Per-owner subrows (co-owned unit): owner name + per-owner calc +
                that owner's €. Full info, indented + quieter. Same uniform cell. */}
            {coOwned &&
              it.owners.map((o, oi) => (
                <tr key={`${ii}-o${oi}`} className={tone}>
                  <td className={cn(cell, 'text-ink-muted pl-10')}>
                    <span className="text-ink-muted/50 mr-1.5">└</span>
                    {o.isRest ? t('others') : o.name}
                    {Number.isFinite(Number(o.percentage)) && (
                      <span className="ml-1 text-ink-muted/70">{o.percentage}%</span>
                    )}
                  </td>
                  <td className={cn(cell, 'text-label text-ink-muted/70 tabular-nums leading-snug')}>
                    {t('{{base}} € × {{pct}}% = {{share}} €', {
                      base: formatNumber(it.amount).replace(/\s*€\s*/g, '').trim(),
                      pct: o.percentage,
                      share: formatNumber(o.amount).replace(/\s*€\s*/g, '').trim()
                    })}
                  </td>
                  <td className={cn(cell, 'text-right tabular-nums text-ink-soft whitespace-nowrap')}>
                    <NumberFormat value={o.amount} />
                  </td>
                </tr>
              ))}
          </Fragment>
        );
      })}
    </>
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
  // Vacant-units-billed-to-owner section is COLLAPSED by default: in a building
  // with many identical vacant units it was a wall of repeated rows (the user's
  // complaint). One «Κενές μονάδες (N) — Σ€» line that expands on click.
  const [showVacant, setShowVacant] = useState(false);
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

  // Route each owner LINE (not whole unit) by its own `vacant` flag, then group
  // by propertyId (NOT the non-unique propertyName) so two same-named units
  // never merge. A vacant unit carries BOTH a fixed OWNER-amount line (owed
  // regardless of vacancy → ΙΔΙΟΚΤΗΤΕΣ) AND a vacant-share line (the empty unit's
  // share of the tenant amount → collapsible Κενές μονάδες). Routing per-LINE
  // (not per-unit) is what restores the collapsible vacant grouping the per-unit
  // owner-amount materialisation broke (it had flipped the whole unit non-vacant).
  //   - ownerGroups: non-vacant owner lines (building-wide + per-unit owner amounts)
  //   - vacantGroups: vacant-share lines, folded under ONE "Κενές μονάδες (N)"
  //     disclosure so many near-identical units become one line + aggregate.
  const groupByUnit = (rows) =>
    Array.from(
      rows
        .reduce((map, e) => {
          const key = e.propertyId || '__nameless__';
          if (!map.has(key)) {
            map.set(key, {
              propertyId: e.propertyId || null,
              propertyName: e.propertyName || null,
              ownerName: e.ownerName || null,
              ownerPercentage: e.ownerPercentage,
              items: [],
              total: 0
            });
          }
          const g = map.get(key);
          g.items.push(e);
          g.total = Math.round((g.total + (Number(e.amount) || 0)) * 100) / 100;
          if (!g.ownerName && e.ownerName) g.ownerName = e.ownerName;
          if (g.ownerPercentage === undefined && e.ownerPercentage !== undefined)
            g.ownerPercentage = e.ownerPercentage;
          // SPLIT unit: any line carries >1 owner slice → it's co-owned (or a
          // sole owner declared <100% with a missing co-owner). Per the user's
          // directive, a split unit shows NO name in the header; the per-owner
          // subrows under each line carry the names + full calc instead.
          if (Array.isArray(e.owners) && e.owners.length > 1) g.isSplit = true;
          return map;
        }, new Map())
        .values()
    );
  const ownerGroups = groupByUnit(ownerLiabilities.filter((e) => !e.vacant));
  const vacantGroups = groupByUnit(ownerLiabilities.filter((e) => e.vacant));
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
      {/* The table sits on a BONE field (lighter than the cream zone band) so the
          cream-toned alternate unit blocks are VISIBLE against it. Rounded +
          hairline-bordered so the grid reads as one clean object on the band. */}
      <div className="overflow-hidden rounded-md border border-stone-line bg-bone">

      {/* Grid 18·4 (user-selected): a bordered spreadsheet-style table. Every
          unit is a bold header row («Μονάδα — ΟΝΟΜΑ», both readable, ΑΤΑΚ small +
          faint) followed by its expense lines (color-dot + «Τύπος (Όνομα)» |
          FULL allocation calc | amount). Section header rows separate
          ΕΝΟΙΚΙΑΣΤΕΣ / ΙΔΙΟΚΤΗΤΕΣ / κενές μονάδες. Alternating unit-block tone
          gives clear "where each unit starts/ends" boundaries. No information is
          hidden or abbreviated — calc strings, repair-vacant 2nd line, and
          co-owner split all render verbatim. Mirrored 1:1 into the XLSX/PDF
          exports (buildingExportRows). */}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="border border-stone-line bg-bark text-bone text-label uppercase tracking-wide text-left px-3 py-2">
              {t('Unit / expense')}
            </th>
            <th className="border border-stone-line bg-bark text-bone text-label uppercase tracking-wide text-left px-3 py-2">
              {t('Calculation')}
            </th>
            <th className="border border-stone-line bg-bark text-bone text-label uppercase tracking-wide text-right px-3 py-2">
              {t('Amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {/* ── ΕΝΟΙΚΙΑΣΤΕΣ ── */}
          {byProperty.size > 0 && (
            <tr>
              <td
                colSpan={3}
                className="border border-stone-line bg-marble text-label uppercase tracking-wide font-semibold text-ink px-3 py-1.5"
              >
                {t('Tenants')}
              </td>
            </tr>
          )}
          {Array.from(byProperty.entries()).map(([propertyId, g], gi) => (
            <UnitRows
              key={`p-${gi}`}
              gap={gi > 0}
              seq={gi + 1}
              tone={gi % 2 ? 'bg-cream' : 'bg-bone'}
              header={
                <>
                  <span className="text-ink">
                    {unitLabel(building?.name, g.propertyName)}
                    {g.recipientName ? ` — ${g.recipientName}` : ''}
                  </span>
                  <span className="ml-2 font-normal text-label text-ink-muted">
                    {atakSuffix(propertyId)}
                  </span>
                </>
              }
              total={g.total}
              items={g.items}
              t={t}
              formatNumber={formatNumber}
            />
          ))}

          {/* ── ΙΔΙΟΚΤΗΤΕΣ ── */}
          {ownerGroups.length > 0 && (
            <tr>
              <td
                colSpan={3}
                className="border border-stone-line bg-marble text-label uppercase tracking-wide font-semibold text-ink px-3 py-1.5"
              >
                {t('Owners')}
              </td>
            </tr>
          )}
          {ownerGroups.map((g, gi) => (
            <UnitRows
              key={`og-${gi}`}
              gap={gi > 0}
              seq={gi + 1}
              tone={gi % 2 ? 'bg-cream' : 'bg-bone'}
              header={
                g.propertyId ? (
                  <>
                    {/* Single-owner unit → name in the header (+ amount on the
                        right). Co-owned / split unit → NO name here; the
                        per-owner subrows under each line carry the names + the
                        full calc (the user's directive). */}
                    <span className="text-ink">
                      {unitLabel(building?.name, g.propertyName)}
                      {!g.isSplit && g.ownerName ? ` — ${g.ownerName}` : ''}
                    </span>
                    <span className="ml-2 font-normal text-label text-ink-muted">
                      {atakSuffix(g.propertyId)}
                    </span>
                  </>
                ) : (
                  <span className="text-ink">
                    {t('All units')}
                    {!g.isSplit && g.ownerName ? ` — ${g.ownerName}` : ''}
                    {vacantGroups.length > 0 ? ` ${t('(excluding vacant)')}` : ''}
                  </span>
                )
              }
              total={g.total}
              items={g.items}
              t={t}
              formatNumber={formatNumber}
            />
          ))}

          {/* ── ΙΔΙΟΚΤΗΤΕΣ — ΚΕΝΕΣ ΜΟΝΑΔΕΣ ── (oxide-tinted, COLLAPSIBLE).
              The header row is a toggle showing the count + aggregate total;
              the per-unit rows render in FULL when expanded (no info hidden —
              just folded away by default so many identical vacant units don't
              dominate as a wall). */}
          {vacantGroups.length > 0 && (
            <tr
              onClick={() => setShowVacant((v) => !v)}
              className="cursor-pointer"
            >
              <td
                colSpan={2}
                className="border border-stone-line bg-oxide-tint text-label uppercase tracking-wide font-semibold text-oxide px-3 py-1.5"
              >
                <LuChevronRight
                  className={cn(
                    'inline size-3 mr-1 transition-transform',
                    showVacant && 'rotate-90'
                  )}
                />
                ⚠ {t('Owners')} — {t('Vacant units ({{count}})', { count: vacantGroups.length })}
              </td>
              <td className="border border-stone-line bg-oxide-tint text-right tabular-nums font-semibold text-oxide px-3 py-1.5 whitespace-nowrap">
                <NumberFormat value={vacantTotal} />
              </td>
            </tr>
          )}
          {showVacant &&
            vacantGroups.map((g, gi) => (
              <UnitRows
                key={`vg-${gi}`}
                gap={gi > 0}
                seq={gi + 1}
                tone="bg-oxide-tint/40"
                header={
                  <>
                    {/* split → no name (per-owner subrows carry names); single
                        owner → name in header. */}
                    <span className="text-ink">
                      {unitLabel(building?.name, g.propertyName)}
                      {!g.isSplit && g.ownerName ? ` — ${g.ownerName}` : ''}
                    </span>
                    <span className="ml-2 font-normal text-label text-ink-muted">
                      {atakSuffix(g.propertyId)}
                    </span>
                  </>
                }
                total={g.total}
                items={g.items}
                t={t}
                formatNumber={formatNumber}
              />
            ))}
        </tbody>
      </table>
      </div>

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
