import {
  attachBillSource,
  confirmBills,
  fetchBuildings,
  parseBillPdfs,
  QueryKeys
} from '../../utils/restcalls';
import {
  LuAlertTriangle,
  LuCheckCircle,
  LuFileWarning,
  LuPlusCircle,
  LuReceipt
} from 'react-icons/lu';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ExpenseFormDialog } from './ExpenseFormDialog';
import FileDropZone from '../ui/file-drop-zone';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { parseGreekMoney } from '../../utils/numberformat';
import ResponsiveDialog from '../ResponsiveDialog';
import { Switch } from '../ui/switch';
import { termMonthYearAccusative } from '../../utils/greekMonths';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

// Provider → building expense `type` enum (services/common/.../building.ts).
// A SUGGESTION for the pre-filled new-expense form; the user can change it.
const PROVIDER_TYPE = {
  deh: 'electricity_common',
  eydap: 'water_common',
  epa: 'heating'
};

// H4: key per-result state by a stable synthetic uid, NOT filename. Two uploaded
// files can share a name (the server keeps both), and a filename key made their
// cards collide onto one state entry — assigning one drove the other, routing
// both bills to the same expense. `_uid` is stamped on each result at parse time.
const keyOf = (result) => result._uid;

function ResultCard({
  result,
  buildings,
  assignment,
  onAssignBuilding,
  onAssignExpense,
  onCreateExpense,
  onToggleReplace,
  replaceFlags,
  chargeFlags,
  onToggleCharge,
  amountOverride,
  onAmountChange
}) {
  const { t, lang } = useTranslation('common');

  if (!result.success) {
    return (
      <div className="border rounded-md p-4 space-y-2 border-destructive/30 bg-destructive/5">
        <div className="flex items-start gap-2">
          <LuFileWarning className="size-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-sm">{result.filename}</div>
            <div className="text-sm text-destructive">{result.error}</div>
          </div>
        </div>
      </div>
    );
  }

  const { parsed, match, existingAmount, duplicate } = result;
  // Effective assignment: an exact server match wins; otherwise the user's
  // in-dialog selection (assignment). An unmatched result is confirmable only
  // once BOTH building and expense are chosen.
  const buildingId = match?.buildingId || assignment?.buildingId || '';
  const expenseId = match?.expenseId || assignment?.expenseId || '';
  const selectedBuilding = buildings?.find(
    (b) => String(b._id) === String(buildingId)
  );
  const expenseOptions = (selectedBuilding?.expenses || []).filter(
    // hide soft-deleted expenses (endTerm in the past)
    (e) => !e.endTerm
  );

  return (
    <div className="border rounded-md p-4 space-y-3">
      <div className="flex items-start gap-2">
        <LuReceipt className="size-5 text-primary shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{result.filename}</div>
          <div className="text-xs text-muted-foreground uppercase">
            {parsed.provider}
          </div>
        </div>
        {match && (
          <Badge variant="outline" className="shrink-0">
            {match.expenseName}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div className="text-muted-foreground">{t('Billing ID')}</div>
        <div className="font-mono text-xs">{parsed.billingId}</div>

        <div className="text-muted-foreground">{t('Amount')}</div>
        {/* O3 (destructive-write audit 2026-07): the amount is now EDITABLE.
            It was a read-only NumberFormat, so an OCR misread of the total
            (e.g. "186,21" read as "18621", or a dropped decimal) could not be
            corrected and flowed verbatim into the bill and — via «Χρέωση
            ενοικιαστών» — into every tenant's rent. The editable value
            overrides parsed.totalAmount in the confirm payload. */}
        <div className="font-medium">
          <Input
            type="text"
            inputMode="decimal"
            className="h-7 w-32 text-sm"
            value={
              amountOverride !== undefined
                ? amountOverride
                : String(parsed.totalAmount ?? '')
            }
            onChange={(e) => onAmountChange(result._uid, e.target.value)}
            aria-label={t('Amount')}
          />
        </div>

        <div className="text-muted-foreground">{t('Period')}</div>
        {/* i18n (2026-07): moment(undefined) is TODAY, not "Invalid Date" —
            unguarded, an absent period bound would silently claim today as the
            billing period on the very screen the landlord uses to decide what
            to commit. Today the parser can't produce that (deh.ts:104 returns
            success:false without a period and ResultCard early-returns above),
            so this is defence-in-depth against a future parser that relaxes
            the non-optional `periodStart: Date` contract. */}
        <div>
          {parsed.periodStart ? moment(parsed.periodStart).format('L') : '—'} –{' '}
          {parsed.periodEnd ? moment(parsed.periodEnd).format('L') : '—'}
        </div>

        {parsed.dueDate && (
          <>
            <div className="text-muted-foreground">{t('Due Date')}</div>
            <div>{moment(parsed.dueDate).format('L')}</div>
          </>
        )}

        {parsed.rfCode && (
          <>
            <div className="text-muted-foreground">{t('RF Code')}</div>
            <div className="font-mono text-xs">{parsed.rfCode}</div>
          </>
        )}
      </div>

      {/* No exact match → let the user assign a building + expense in-dialog. */}
      {!match && (
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
          <div className="text-xs font-medium text-ink-muted uppercase tracking-wide">
            {t('Assign to')}
          </div>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">
              {t('Building')}
            </label>
            <Select
              value={buildingId || undefined}
              onValueChange={(val) => onAssignBuilding(keyOf(result), val)}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('Select a building')} />
              </SelectTrigger>
              <SelectContent>
                {(buildings || []).map((b) => (
                  <SelectItem key={b._id} value={String(b._id)}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {buildingId && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">
                {t('Expense')}
              </label>
              <Select
                value={expenseId || undefined}
                onValueChange={(val) => {
                  if (val === '__new__') {
                    onCreateExpense(keyOf(result), selectedBuilding);
                  } else {
                    onAssignExpense(keyOf(result), val);
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select an expense')} />
                </SelectTrigger>
                <SelectContent>
                  {expenseOptions.map((e) => (
                    <SelectItem key={e._id} value={String(e._id)}>
                      {e.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">
                    <span className="flex items-center gap-1.5 text-primary">
                      <LuPlusCircle className="size-3.5" />
                      {t('Create new expense')}
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {/* Once an expense is resolved (matched or assigned), offer to charge
          tenants this month — this bridges the amount into the rent engine. */}
      {expenseId && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
          <Label
            htmlFor={`charge-${keyOf(result)}`}
            className="text-sm cursor-pointer"
          >
            {t('Charge tenants this month')}
          </Label>
          <Switch
            id={`charge-${keyOf(result)}`}
            checked={!!chargeFlags[keyOf(result)]}
            onCheckedChange={() => onToggleCharge(keyOf(result))}
          />
        </div>
      )}

      {existingAmount !== undefined && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 dark:bg-amber-950/30 dark:border-amber-800">
          <div className="flex items-start gap-2">
            <LuAlertTriangle className="size-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                {t('A bill already exists for this period')}
              </p>
              <p className="text-amber-700/80 dark:text-amber-300/80 text-xs mt-0.5">
                {t('Existing amount')}: <NumberFormat value={existingAmount} />
              </p>
              <button
                type="button"
                className="mt-2 text-xs font-medium underline text-amber-800 dark:text-amber-200"
                onClick={() => onToggleReplace(keyOf(result))}
              >
                {replaceFlags[keyOf(result)]
                  ? t('Keep existing (cancel replace)')
                  : t('Replace existing bill')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BILL-IDENTITY (bill-OCR audit 2026-07): the same PHYSICAL bill is
          already stored under a DIFFERENT term. The banner above cannot see
          this — it queries by the term derived from this file's OCR'd periodEnd,
          which is exactly the value that diverged. Confirming would insert a
          second Bill and charge the tenants in a second month.

          Mutually exclusive with the same-term banner (identical `=== undefined`
          predicate on both sides of the wire; the server skips the probe in that
          case) so the operator never gets two warnings for one file.

          NO «Replace existing bill» button here, deliberately: replaceExisting
          upserts on (buildingId, expenseId, term) and would write at THIS file's
          term, leaving the other month's bill untouched — a button that looks
          like it resolves the duplicate while silently creating it. The only
          remedy the dialog actually offers is to deselect this file, so that is
          what the hint says (the period renders as static text — there is no
          period/term override input on this row). */}
      {duplicate && existingAmount === undefined && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 dark:bg-amber-950/30 dark:border-amber-800">
          <div className="flex items-start gap-2">
            <LuAlertTriangle className="size-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                {t('This bill appears to be already imported')}
              </p>
              <p className="text-amber-700/80 dark:text-amber-300/80 text-xs mt-0.5">
                {t('Already imported for {{month}}', {
                  // Term is YYYYMMDDHH; the first 6 chars are the month.
                  // Accusative, not moment's nominative: the el carrier is
                  // «Έχει καταχωρηθεί για {{month}}» and «για» governs the
                  // accusative («για Ιούλιο 2026», not «για Ιούλιος 2026»).
                  // Same banner as InboxBell — same helper.
                  month: termMonthYearAccusative(duplicate.term, lang)
                })}
                {' — '}
                <NumberFormat value={duplicate.totalAmount} />
              </p>
              <p className="text-amber-700/80 dark:text-amber-300/80 text-xs mt-0.5">
                {t(
                  'Check that month before confirming — deselect this file if it is a duplicate'
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {parsed.irisCodeBase64 && (
        <div className="flex justify-center pt-2">
          <img
            src={`data:image/png;base64,${parsed.irisCodeBase64}`}
            alt="IRIS QR"
            className="w-24 h-24"
          />
        </div>
      )}
    </div>
  );
}

export default function BillImportDialog({ open, setOpen, building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle');
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [replaceFlags, setReplaceFlags] = useState({});
  // O3: per-result edited amount (raw string as typed) overriding the parsed
  // total when the operator corrects an OCR misread. {_uid: '123,45'}
  const [amountOverrides, setAmountOverrides] = useState({});
  const handleAmountChange = useCallback((uid, raw) => {
    setAmountOverrides((prev) => ({ ...prev, [uid]: raw }));
  }, []);
  // Per-result «charge tenants this month» toggle: {_uid: boolean}
  const [chargeFlags, setChargeFlags] = useState({});
  // Per-result manual assignment for unmatched bills: {_uid: {buildingId, expenseId}}
  const [assignments, setAssignments] = useState({});
  // Inline "create expense" flow: which result triggered it + which building.
  const [createFor, setCreateFor] = useState(null); // {uid, building} | null

  // All realm buildings — a parsed bill may match a DIFFERENT building than the
  // one being viewed, and the no-match dropdown lists them all (§2.1c).
  const { data: buildings } = useQuery({
    queryKey: [QueryKeys.BUILDINGS],
    queryFn: fetchBuildings,
    enabled: open
  });

  useEffect(() => {
    if (!open) {
      setState('idle');
      setFiles([]);
      setResults([]);
      setReplaceFlags({});
      setChargeFlags({});
      setAssignments({});
      setAmountOverrides({});
      setCreateFor(null);
    }
  }, [open]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleParse = useCallback(async () => {
    if (files.length === 0) return;
    setState('loading');

    try {
      const data = await parseBillPdfs(files);
      // H4: stamp a stable per-result uid so state maps don't collide on filename.
      const rows = (data || []).map((r, i) => ({
        ...r,
        _uid: `${i}:${r.filename}`
      }));
      setResults(rows);
      // Pre-select the building for no-match bills whose αριθμός παροχής
      // identified an apartment — the landlord lands on the right building with
      // only the expense left to create/pick.
      const seededAssign = {};
      for (const r of rows) {
        if (r.success && !r.match && r.unitMatch?.buildingId) {
          seededAssign[r._uid] = {
            buildingId: r.unitMatch.buildingId,
            expenseId: ''
          };
        }
      }
      if (Object.keys(seededAssign).length) {
        setAssignments((prev) => ({ ...seededAssign, ...prev }));
      }
      setState('preview');
    } catch (error) {
      console.error('Bill parse error:', error);
      toast.error(t('Failed to parse bill PDFs'));
      setState('idle');
    }
  }, [files, t]);

  const assignBuilding = useCallback((uid, buildingId) => {
    // changing the building clears any stale expense selection
    setAssignments((prev) => ({
      ...prev,
      [uid]: { buildingId, expenseId: '' }
    }));
  }, []);

  const assignExpense = useCallback((uid, expenseId) => {
    setAssignments((prev) => ({
      ...prev,
      [uid]: { ...(prev[uid] || {}), expenseId }
    }));
  }, []);

  const handleCreateExpense = useCallback((uid, selectedBuilding) => {
    setCreateFor({ uid, building: selectedBuilding });
  }, []);

  // The pre-filled synthetic expense (NO _id → add mode in ExpenseFormDialog).
  // When the αριθμός παροχής identified a specific apartment (unitMatch), target
  // that single unit (single_unit allocation) so the landlord only confirms;
  // otherwise default to an equal split. billingId + provider→type are
  // suggested from the parsed bill.
  const createPrefill = useMemo(() => {
    if (!createFor) return null;
    const result = results.find((r) => r._uid === createFor.uid);
    const parsed = result?.parsed;
    const unitMatch = result?.unitMatch;
    return {
      name: parsed?.provider ? parsed.provider.toUpperCase() : '',
      type: PROVIDER_TYPE[parsed?.provider] || 'other',
      amount: 0,
      allocationMethod: unitMatch ? 'single_unit' : 'equal',
      customAllocations: unitMatch
        ? [{ propertyId: unitMatch.propertyId, value: 0 }]
        : [],
      isRecurring: true,
      chargeOwnerWhenVacant: true,
      billingId: parsed?.billingId || ''
    };
  }, [createFor, results]);

  // After the new expense is created, the server returns the updated building.
  // Find the new expense (by billingId, else the last one) and auto-select it.
  const handleExpenseCreated = useCallback(
    (updatedBuilding) => {
      if (!createFor || !updatedBuilding) return;
      const parsed = results.find((r) => r._uid === createFor.uid)?.parsed;
      const expenses = updatedBuilding.expenses || [];
      const created =
        expenses.find(
          (e) =>
            parsed?.billingId &&
            e.billingId &&
            e.billingId.replace(/[\s\-.]/g, '') ===
              parsed.billingId.replace(/[\s\-.]/g, '')
        ) || expenses[expenses.length - 1];
      if (created) {
        setAssignments((prev) => ({
          ...prev,
          [createFor.uid]: {
            buildingId: String(updatedBuilding._id),
            expenseId: String(created._id)
          }
        }));
      }
      // refresh the buildings list so the dropdown shows the new expense
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      setCreateFor(null);
    },
    [createFor, results, queryClient]
  );

  // A result is confirmable if it has an exact match OR a full manual assignment.
  const resolvedAssignment = useCallback(
    (result) => {
      if (result.match) {
        return {
          buildingId: result.match.buildingId,
          expenseId: result.match.expenseId
        };
      }
      const a = assignments[result._uid];
      return a?.buildingId && a?.expenseId ? a : null;
    },
    [assignments]
  );

  const handleConfirm = useCallback(async () => {
    const confirmable = results
      .filter((r) => r.success)
      .map((r) => ({ r, a: resolvedAssignment(r) }))
      .filter(({ a }) => !!a);
    if (confirmable.length === 0) return;

    // O3: resolve the effective amount (operator override → parsed) per bill
    // and refuse to confirm if any is non-positive, so an OCR misread the user
    // failed to correct can't silently reach the ledger.
    const effectiveAmount = (r) => {
      const raw = amountOverrides[r._uid];
      if (raw !== undefined && String(raw).trim() !== '') {
        return parseGreekMoney(raw);
      }
      return Number(r.parsed.totalAmount);
    };
    const badAmount = confirmable.find(({ r }) => {
      const v = effectiveAmount(r);
      return !Number.isFinite(v) || v <= 0.005;
    });
    if (badAmount) {
      toast.error(
        t('Please enter a valid amount for {{name}}', {
          name: badAmount.r.filename || badAmount.r.parsed?.billingId || ''
        })
      );
      return;
    }

    setState('confirming');

    try {
      const billsToConfirm = confirmable.map(({ r, a }) => {
        const b = buildings?.find(
          (bld) => String(bld._id) === String(a.buildingId)
        );
        const expenseName =
          r.match?.expenseName ||
          (b?.expenses || []).find((e) => String(e._id) === String(a.expenseId))
            ?.name ||
          r.parsed.provider;
        return {
          buildingId: a.buildingId,
          expenseId: a.expenseId,
          provider: r.parsed.provider,
          billingId: r.parsed.billingId,
          totalAmount: effectiveAmount(r),
          periodStart: r.parsed.periodStart,
          periodEnd: r.parsed.periodEnd,
          issueDate: r.parsed.issueDate,
          dueDate: r.parsed.dueDate,
          term: r.parsed.proposedTerm,
          rfCode: r.parsed.rfCode,
          paymentCode: r.parsed.paymentCode,
          irisCodeBase64: r.parsed.irisCodeBase64,
          // Slice 6 — carry the raw OCR text to persist on the Bill for later
          // απόδειξη matching (the server rebuilds the match bag from it).
          ocrText: r.parsed.ocrText,
          replaceExisting: !!replaceFlags[r._uid],
          chargeThisMonth: !!chargeFlags[r._uid],
          expenseName
        };
      });

      const savedBills = await confirmBills(billsToConfirm);

      // Slice 5: archive each saved bill's SOURCE file to B2. The source can't
      // ride the JSON /confirm (100kb cap), so we re-send it per bill now that
      // we have the bill _id — and only for bills that actually saved (no
      // orphaned uploads). Index-aligned: savedBills[k] ↔ confirmable[k].
      // Best-effort: a failed archive never blocks the import outcome, but it
      // must NOT fail silently — log it and count so the user can be told the
      // source PDF wasn't stored (the bill itself saved fine).
      const archiveResults = await Promise.all(
        (Array.isArray(savedBills) ? savedBills : []).map((row, k) => {
          if (!row || row.saveFailed || !row._id) return null;
          const uid = confirmable[k]?.r?._uid;
          const idx = uid ? Number(String(uid).split(':')[0]) : NaN;
          const file = Number.isInteger(idx) ? files[idx] : undefined;
          if (!file) return null;
          return attachBillSource(row._id, file)
            .then(() => true)
            .catch((err) => {
              console.error(
                `attachBillSource failed for bill ${row._id}:`,
                err
              );
              return false;
            });
        })
      );
      const archiveFailures = archiveResults.filter((x) => x === false).length;

      queryClient.invalidateQueries({ queryKey: [QueryKeys.BILLS] });
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building?._id]
      });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      // M3: any bill that also CHARGED tenants went through the same
      // saveMonthlyStatement write as BuildingExpensePanel — mirror its full
      // invalidation set so rent/owner/breakdown surfaces don't show stale
      // figures until a manual refetch.
      const anyCharged = billsToConfirm.some((b) => b.chargeThisMonth);
      if (anyCharged) {
        queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.OWNERS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
        queryClient.invalidateQueries({ queryKey: ['expense-breakdown'] });
      }
      const rows = Array.isArray(savedBills) ? savedBills : [];
      // The batch is non-atomic: the server returns an index-aligned row per
      // bill, flagging per-bill save failures (saveFailed) and per-bill charge
      // failures (chargeError) rather than aborting. Report the real outcome.
      const saveFailures = rows.filter((b) => b && b.saveFailed);
      // H2: a bill can be SAVED yet fail to charge (bridge error).
      const chargeFailures = rows.filter((b) => b && b.chargeError);
      const savedOk = rows.filter((b) => b && !b.saveFailed).length;

      if (saveFailures.length > 0) {
        // Some bills could not be saved (e.g. duplicate for the period).
        toast.warning(
          t(
            '{{saved}} of {{total}} bills saved. {{failed}} could not be saved (already exist or invalid).',
            {
              saved: savedOk,
              total: rows.length,
              failed: saveFailures.length
            }
          )
        );
      } else if (chargeFailures.length > 0) {
        toast.warning(
          t(
            'Bills saved. {{failed}} could not charge tenants — charge them from the building statement.',
            { failed: chargeFailures.length }
          )
        );
      } else {
        toast.success(
          t('{{count}} bill(s) imported successfully', {
            count: savedOk || billsToConfirm.length
          })
        );
      }
      // The bills saved regardless, but if the source PDF archive failed for
      // some, tell the user (the file just isn't stored in the document
      // archive — they can re-attach it later).
      if (archiveFailures > 0) {
        toast.warning(
          t('{{failed}} source file(s) could not be archived.', {
            failed: archiveFailures
          })
        );
      }
      handleClose();
    } catch (error) {
      console.error('Bill confirm error:', error);
      toast.error(t('Failed to save bills'));
      setState('preview');
    }
  }, [
    results,
    files,
    resolvedAssignment,
    replaceFlags,
    chargeFlags,
    buildings,
    building,
    handleClose,
    queryClient,
    t
  ]);

  const handleToggleReplace = useCallback((uid) => {
    setReplaceFlags((prev) => ({
      ...prev,
      [uid]: !prev[uid]
    }));
  }, []);

  const handleToggleCharge = useCallback((uid) => {
    setChargeFlags((prev) => ({
      ...prev,
      [uid]: !prev[uid]
    }));
  }, []);

  const confirmableCount = results.filter(
    (r) => r.success && !!resolvedAssignment(r)
  ).length;
  const failedCount = results.filter((r) => !r.success).length;
  const unassignedCount = results.filter(
    (r) => r.success && !resolvedAssignment(r)
  ).length;
  const isLoading = state === 'loading' || state === 'confirming';

  return (
    <>
      <ResponsiveDialog
        open={!!open}
        setOpen={setOpen}
        isLoading={isLoading}
        renderHeader={() => t('Import Bills')}
        renderContent={() => (
          <div className="pt-4 space-y-4">
            {(state === 'idle' || state === 'loading') && (
              <FileDropZone
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.webp"
                files={files}
                onFilesChange={setFiles}
                disabled={isLoading}
                dropLabel={t('Drop PDF or photos here or click to browse')}
                description={t(
                  'Up to 20 files — PDF, JPG, PNG or WEBP (DEH, EYDAP, DEYA bills, scanned or photographed)'
                )}
              />
            )}

            {state === 'preview' && results.length > 0 && (
              <div className="space-y-4 max-h-[60vh] overflow-y-auto">
                <div className="flex gap-2 flex-wrap">
                  {confirmableCount > 0 && (
                    <Badge variant="default" className="gap-1">
                      <LuCheckCircle className="size-3" />
                      {confirmableCount} {t('ready')}
                    </Badge>
                  )}
                  {unassignedCount > 0 && (
                    <Badge variant="secondary" className="gap-1">
                      <LuAlertTriangle className="size-3" />
                      {unassignedCount} {t('need assignment')}
                    </Badge>
                  )}
                  {failedCount > 0 && (
                    <Badge variant="destructive" className="gap-1">
                      <LuFileWarning className="size-3" />
                      {failedCount} {t('failed')}
                    </Badge>
                  )}
                </div>

                {results.map((result) => (
                  <ResultCard
                    key={result._uid}
                    result={result}
                    buildings={buildings}
                    assignment={assignments[result._uid]}
                    onAssignBuilding={assignBuilding}
                    onAssignExpense={assignExpense}
                    onCreateExpense={handleCreateExpense}
                    onToggleReplace={handleToggleReplace}
                    replaceFlags={replaceFlags}
                    chargeFlags={chargeFlags}
                    onToggleCharge={handleToggleCharge}
                    amountOverride={amountOverrides[result._uid]}
                    onAmountChange={handleAmountChange}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        renderFooter={() => (
          <>
            <Button variant="outline" onClick={handleClose}>
              {t('Cancel')}
            </Button>
            {state === 'idle' && files.length > 0 && (
              <Button onClick={handleParse} data-cy="parseBills">
                {t('Continue')}
              </Button>
            )}
            {state === 'preview' && confirmableCount > 0 && (
              <Button onClick={handleConfirm} data-cy="confirmBills">
                {t('Confirm Import')} ({confirmableCount})
              </Button>
            )}
          </>
        )}
      />

      {/* Inline create-expense: the SAME ExpenseFormDialog, pre-filled, add mode. */}
      {createFor && (
        <ExpenseFormDialog
          open={!!createFor}
          setOpen={(v) => {
            if (!v) setCreateFor(null);
          }}
          expense={createPrefill}
          building={createFor.building}
          onCreated={handleExpenseCreated}
        />
      )}
    </>
  );
}
