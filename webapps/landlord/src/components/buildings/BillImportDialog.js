import {
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
import NumberFormat from '../NumberFormat';
import ResponsiveDialog from '../ResponsiveDialog';
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

// A key that survives across the parse-result list (filename is unique per upload).
const keyOf = (result) => result.filename;

function ResultCard({
  result,
  buildings,
  assignment,
  onAssignBuilding,
  onAssignExpense,
  onCreateExpense,
  onToggleReplace,
  replaceFlags
}) {
  const { t } = useTranslation('common');

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

  const { parsed, match, existingAmount } = result;
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
        <div className="font-medium">
          <NumberFormat value={parsed.totalAmount} />
        </div>

        <div className="text-muted-foreground">{t('Period')}</div>
        <div>
          {new Date(parsed.periodStart).toLocaleDateString()} –{' '}
          {new Date(parsed.periodEnd).toLocaleDateString()}
        </div>

        {parsed.dueDate && (
          <>
            <div className="text-muted-foreground">{t('Due Date')}</div>
            <div>{new Date(parsed.dueDate).toLocaleDateString()}</div>
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
  // Per-result manual assignment for unmatched bills: {filename: {buildingId, expenseId}}
  const [assignments, setAssignments] = useState({});
  // Inline "create expense" flow: which result triggered it + which building.
  const [createFor, setCreateFor] = useState(null); // {filename, building} | null

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
      setAssignments({});
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
      setResults(data);
      setState('preview');
    } catch (error) {
      console.error('Bill parse error:', error);
      toast.error(t('Failed to parse bill PDFs'));
      setState('idle');
    }
  }, [files, t]);

  const assignBuilding = useCallback((filename, buildingId) => {
    // changing the building clears any stale expense selection
    setAssignments((prev) => ({
      ...prev,
      [filename]: { buildingId, expenseId: '' }
    }));
  }, []);

  const assignExpense = useCallback((filename, expenseId) => {
    setAssignments((prev) => ({
      ...prev,
      [filename]: { ...(prev[filename] || {}), expenseId }
    }));
  }, []);

  const handleCreateExpense = useCallback((filename, selectedBuilding) => {
    setCreateFor({ filename, building: selectedBuilding });
  }, []);

  // The pre-filled synthetic expense (NO _id → add mode in ExpenseFormDialog).
  const createPrefill = useMemo(() => {
    if (!createFor) return null;
    const result = results.find((r) => r.filename === createFor.filename);
    const parsed = result?.parsed;
    return {
      name: parsed?.provider ? parsed.provider.toUpperCase() : '',
      type: PROVIDER_TYPE[parsed?.provider] || 'other',
      amount: 0,
      allocationMethod: 'equal',
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
      const parsed = results.find(
        (r) => r.filename === createFor.filename
      )?.parsed;
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
          [createFor.filename]: {
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
      const a = assignments[result.filename];
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

    setState('confirming');

    try {
      const billsToConfirm = confirmable.map(({ r, a }) => ({
        buildingId: a.buildingId,
        expenseId: a.expenseId,
        provider: r.parsed.provider,
        billingId: r.parsed.billingId,
        totalAmount: r.parsed.totalAmount,
        periodStart: r.parsed.periodStart,
        periodEnd: r.parsed.periodEnd,
        issueDate: r.parsed.issueDate,
        dueDate: r.parsed.dueDate,
        term: r.parsed.proposedTerm,
        rfCode: r.parsed.rfCode,
        paymentCode: r.parsed.paymentCode,
        irisCodeBase64: r.parsed.irisCodeBase64,
        replaceExisting: !!replaceFlags[r.filename]
      }));

      await confirmBills(billsToConfirm);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BILLS] });
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building?._id]
      });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      toast.success(
        t('{{count}} bill(s) imported successfully', {
          count: billsToConfirm.length
        })
      );
      handleClose();
    } catch (error) {
      console.error('Bill confirm error:', error);
      toast.error(t('Failed to save bills'));
      setState('preview');
    }
  }, [
    results,
    resolvedAssignment,
    replaceFlags,
    building,
    handleClose,
    queryClient,
    t
  ]);

  const handleToggleReplace = useCallback((filename) => {
    setReplaceFlags((prev) => ({
      ...prev,
      [filename]: !prev[filename]
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

                {results.map((result, idx) => (
                  <ResultCard
                    key={idx}
                    result={result}
                    buildings={buildings}
                    assignment={assignments[result.filename]}
                    onAssignBuilding={assignBuilding}
                    onAssignExpense={assignExpense}
                    onCreateExpense={handleCreateExpense}
                    onToggleReplace={handleToggleReplace}
                    replaceFlags={replaceFlags}
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
