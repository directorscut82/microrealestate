import {
  confirmReceiptPayments,
  parsePaymentReceipts,
  pollRecapture,
  QueryKeys,
  startRecapture
} from '../../utils/restcalls';
import {
  LuAlertTriangle,
  LuCamera,
  LuCheck,
  LuFileWarning,
  LuLoader,
  LuReceipt
} from 'react-icons/lu';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/button';
import FileDropZone from '../ui/file-drop-zone';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { parseGreekMoney } from '../../utils/numberformat';
import { isValidIBAN, isValidRF } from '../../utils/rfIban';
import ResponsiveDialog from '../ResponsiveDialog';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

/*
 * PaymentReceiptDialog — U6 (Slice 6). Built against an approved local mock
 * (receipt-match-panel.html), which is NOT in the repo: the mockups render real
 * bill/receipt data and are gitignored. This comment is the surviving spec.
 *
 * Two-pane suggested-match: the receipt is OCR'd server-side, its elements
 * scored (soft TF-IDF, no hard categories) against every open bill AND repair.
 * LEFT = recognized fields (editable amount). RIGHT = ranked candidates with the
 * top pre-selected + WHICH tokens matched. Confirm records the receipt as an
 * installment (receipts[]) on the chosen bill/repair → paid/partial. Accepts
 * images (phone photos), not just PDFs.
 */

// Stable per-receipt key (two files can share a name).
const uidOf = (r, i) => `${i}:${r.filename}`;

function formatMoney(n) {
  return new Intl.NumberFormat('el-GR', {
    style: 'currency',
    currency: 'EUR'
  }).format(Number(n) || 0);
}

/*
 * Tier-2 re-capture (Slice 6 §15). Shown when the receipt had an RF/IBAN-shaped
 * token that failed its checksum (Tier-1 auto re-crop already tried). The field
 * is ALWAYS manually editable; this offers «Θα στείλω άλλη φωτογραφία»: click →
 * open a server session → poll while the user sends a zoomed close-up to the
 * bot → on recovery the value flips in live (red→green). ~2min timeout, then
 * the manual field remains.
 */
function RecaptureField({ target, value, onEdit, onRecovered }) {
  const { t } = useTranslation('common');
  const [phase, setPhase] = useState('idle'); // idle|waiting|recovered|timeout
  const pollRef = useRef(null);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    []
  );

  const begin = useCallback(async () => {
    try {
      const { id } = await startRecapture(target);
      setPhase('waiting');
      pollRef.current = setInterval(async () => {
        try {
          const s = await pollRecapture(id);
          if (s.status === 'recovered' && s.value) {
            clearInterval(pollRef.current);
            setPhase('recovered');
            onRecovered(s.value);
          } else if (s.status === 'timeout') {
            clearInterval(pollRef.current);
            setPhase('timeout');
          }
        } catch {
          /* keep polling; a transient error shouldn't kill the session */
        }
      }, 3000);
    } catch {
      setPhase('idle');
    }
  }, [target, onRecovered]);

  const label = target === 'iban' ? 'IBAN' : 'RF';

  // This field exists BECAUSE the OCR'd code failed its checksum, so a typed
  // replacement has to clear the same bar. The value is appended to the stored
  // ocrText, and the matcher rebuilds its element bag from ocrText
  // (billmanager.ts:1168) — an unchecked typo becomes a permanent match key that
  // silently attaches future receipts to the wrong bill.
  const typed = String(value ?? '').trim();
  const typedInvalid =
    typed.length > 0 &&
    !(target === 'iban' ? isValidIBAN(typed) : isValidRF(typed));

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        value={value ?? ''}
        onChange={(e) => onEdit(e.target.value)}
        className={`font-mono text-xs ${
          typedInvalid
            ? 'border-destructive'
            : phase === 'recovered'
              ? 'border-success'
              : 'border-destructive'
        }`}
        placeholder={t('Type the correct code or re-photograph')}
      />
      {typedInvalid && (
        <div className="text-[11px] text-destructive flex items-center gap-1">
          <LuAlertTriangle className="size-3" />
          {target === 'iban'
            ? t('This is not a valid IBAN')
            : t('This is not a valid RF code')}
        </div>
      )}
      {phase === 'idle' && (
        <div className="text-[11px] text-destructive flex items-center gap-1">
          <LuAlertTriangle className="size-3" />
          {t('OCR could not read this code reliably.')}
        </div>
      )}
      {phase === 'waiting' && (
        <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          <LuLoader className="size-3 animate-spin" />
          {t('Send the photo to @MicroRealEstateBot…')}
        </div>
      )}
      {phase === 'recovered' && (
        <div className="text-[11px] text-success flex items-center gap-1">
          <LuCheck className="size-3" />
          {t('Updated from the new photo.')}
        </div>
      )}
      {phase === 'timeout' && (
        <div className="text-[11px] text-muted-foreground">
          {t('No photo received — try again or edit manually.')}
        </div>
      )}
      {(phase === 'idle' || phase === 'timeout') && (
        <button
          type="button"
          onClick={begin}
          className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-primary border border-primary/40 bg-primary/5 rounded px-2 py-1"
        >
          <LuCamera className="size-3.5" />
          {t('Send another photo')}
        </button>
      )}
    </div>
  );
}

function ReceiptMatchCard({
  result,
  uid,
  selectedId,
  onSelect,
  editAmount,
  amount,
  longKeys,
  onEditLongKey,
  onRecoverLongKey
}) {
  const { t } = useTranslation('common');
  const rec = result.recognized || {};
  const candidates = result.candidates || [];
  const invalid = rec.invalidLongKeys || [];

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_1.15fr] gap-0 border rounded-lg overflow-hidden">
      {/* LEFT — recognized fields */}
      <div className="p-4 space-y-3 bg-muted/30 border-b md:border-b-0 md:border-r">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('Receipt details')}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LuReceipt className="size-4 shrink-0" />
          <span className="truncate">{result.filename}</span>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t('Amount')}</Label>
          <Input
            value={amount ?? ''}
            inputMode="decimal"
            onChange={(e) => editAmount(uid, e.target.value)}
            className="font-mono"
          />
        </div>

        {rec.date && (
          <div className="grid grid-cols-2 gap-x-3 text-sm">
            <span className="text-muted-foreground">{t('Date')}</span>
            <span className="font-mono">{moment(rec.date).format('L')}</span>
          </div>
        )}

        {/* Long keys — shown only when present; a missing one is normal (a
            repair/POS receipt has none) and NOT an error. */}
        {rec.rfCodes?.length > 0 && (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 text-sm items-center">
            <span className="text-muted-foreground">RF</span>
            <span className="font-mono text-xs flex items-center gap-1 text-success">
              {rec.rfCodes[0]} <LuCheck className="size-3" />
            </span>
          </div>
        )}
        {rec.ibans?.length > 0 && (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 text-sm items-center">
            <span className="text-muted-foreground">IBAN</span>
            <span className="font-mono text-xs flex items-center gap-1 text-success">
              {rec.ibans[0]} <LuCheck className="size-3" />
            </span>
          </div>
        )}
        {/* Tier-2: a long key was present but failed checksum → recapture. */}
        {invalid.map((target) => (
          <RecaptureField
            key={target}
            target={target}
            value={longKeys?.[target] ?? ''}
            onEdit={(v) => onEditLongKey(uid, target, v)}
            onRecovered={(v) => onRecoverLongKey(uid, target, v)}
          />
        ))}

        {!rec.hasValidLongKey && invalid.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            {t(
              'No RF/IBAN on this receipt — matched on the other details below.'
            )}
          </p>
        )}
      </div>

      {/* RIGHT — ranked candidates */}
      <div className="p-4 space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('Suggested match (bills + repairs)')}
        </div>
        {candidates.length === 0 && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/5 text-destructive text-xs px-2.5 py-2">
            <LuAlertTriangle className="size-3.5 shrink-0" />
            {t('No open bill or repair matched this receipt.')}
          </div>
        )}
        {candidates.map((c) => {
          const cid = c.kind === 'repair' ? c.repairId : c.billId;
          const isSel = selectedId === cid;
          return (
            <button
              type="button"
              key={cid}
              onClick={() => onSelect(uid, c)}
              className={`w-full text-left rounded-lg border p-3 transition ${
                isSel
                  ? 'border-primary ring-1 ring-primary bg-primary/5'
                  : 'border-border hover:bg-accent'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-sm">
                  {c.buildingName} · {c.expenseName}
                </span>
                <span className="font-mono text-sm">
                  <NumberFormat value={c.totalAmount} />
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {c.kind === 'repair' ? t('Repair') : t('Bill')}
                {c.contractorName ? ` · ${c.contractorName}` : ''} ·{' '}
                {c.paidSoFar > 0
                  ? t('{{paid}} paid / {{remaining}} remaining', {
                      paid: formatMoney(c.paidSoFar),
                      remaining: formatMoney(c.remaining)
                    })
                  : t('remaining {{remaining}}', {
                      remaining: formatMoney(c.remaining)
                    })}
              </div>
              {c.matchedOn?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <span className="text-[11px] text-muted-foreground">
                    {t('shared')}:
                  </span>
                  {c.matchedOn.map((m, i) => (
                    <span
                      key={i}
                      className={`text-[11px] rounded px-1.5 py-0.5 ${
                        c.strong
                          ? 'bg-success/15 text-success'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {m}
                    </span>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function PaymentReceiptDialog({ open, setOpen, building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle');
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  // Per-receipt chosen candidate + editable amount, keyed by uid.
  const [selected, setSelected] = useState({}); // uid → candidate object
  const [amounts, setAmounts] = useState({}); // uid → string
  // Per-receipt recovered/typed long keys, keyed by uid → { rf?, iban? }.
  const [longKeys, setLongKeys] = useState({});

  useEffect(() => {
    if (!open) {
      setState('idle');
      setFiles([]);
      setResults([]);
      setSelected({});
      setAmounts({});
      setLongKeys({});
    }
  }, [open]);

  const handleClose = useCallback(() => setOpen(false), [setOpen]);

  const handleParse = useCallback(async () => {
    if (files.length === 0) return;
    setState('loading');
    try {
      const data = await parsePaymentReceipts(files);
      const rows = Array.isArray(data) ? data : [];
      // Pre-select the top candidate + seed the editable amount from the
      // recognized value (soft-suggestion — the user can change either).
      const sel = {};
      const amt = {};
      rows.forEach((r, i) => {
        const uid = uidOf(r, i);
        if (r.success) {
          if (r.candidates?.length) sel[uid] = r.candidates[0];
          if (r.recognized?.amount != null) {
            amt[uid] = String(r.recognized.amount);
          }
        }
      });
      setResults(rows);
      setSelected(sel);
      setAmounts(amt);
      setState('preview');
    } catch (error) {
      console.error('Payment receipt parse error:', error);
      toast.error(t('Failed to parse payment receipts'));
      setState('idle');
    }
  }, [files, t]);

  const onSelect = useCallback((uid, candidate) => {
    setSelected((prev) => ({ ...prev, [uid]: candidate }));
  }, []);

  const editAmount = useCallback((uid, value) => {
    setAmounts((prev) => ({ ...prev, [uid]: value }));
  }, []);

  const onEditLongKey = useCallback((uid, target, value) => {
    setLongKeys((prev) => ({
      ...prev,
      [uid]: { ...(prev[uid] || {}), [target]: value }
    }));
  }, []);

  // A recovered key from Tier-2 fills the field live + is carried on confirm.
  const onRecoverLongKey = useCallback(
    (uid, target, value) => {
      onEditLongKey(uid, target, value);
      toast.success(t('Code updated from the new photo'));
    },
    [onEditLongKey, t]
  );

  const confirmable = useMemo(
    () =>
      results
        .map((r, i) => ({ r, uid: uidOf(r, i) }))
        .filter(({ r, uid }) => r.success && selected[uid]),
    [results, selected]
  );

  // Every money surface a recorded receipt moves. Kept as one callback because
  // the success AND failure paths must both run it — the server's batch is not
  // transactional (one save() per receipt), so a mid-batch failure has already
  // persisted the earlier ones. See documentation/MONEY_SURFACE_MATRIX.md.
  const invalidateMoneySurfaces = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.BILLS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    if (building?._id) {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building._id]
      });
    }
    queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
  }, [queryClient, building?._id]);

  const handleConfirm = useCallback(async () => {
    if (confirmable.length === 0) return;
    setState('confirming');
    try {
      const payments = confirmable.map(({ r, uid }) => {
        const c = selected[uid];
        // O1 (destructive-write audit 2026-07): use the shared Greek/English
        // money parser (last-separator-wins) — the old parseFloat(replace(','
        // ,'.')) recorded "1.234,56" as €1.23.
        const parsedAmount = parseGreekMoney(amounts[uid]);
        const lk = longKeys[uid] || {};
        return {
          kind: c.kind,
          billId: c.kind === 'bill' ? c.billId : undefined,
          repairId: c.kind === 'repair' ? c.repairId : undefined,
          buildingId: c.buildingId,
          amount: Number.isFinite(parsedAmount) ? parsedAmount : undefined,
          date: r.recognized?.date,
          matchedOn: c.matchedOn,
          // Recovered/typed long keys ride along so the stored receipt keeps the
          // corrected RF/IBAN (appended to ocrText for the audit trail).
          ocrText: [r.ocrText, lk.rf, lk.iban].filter(Boolean).join(' ')
        };
      });
      const data = await confirmReceiptPayments(payments);
      invalidateMoneySurfaces();
      // BATCH-TRUTH (2026-07): report what the SERVER did, not what we asked
      // for. `payments.length` was our own intent — it counted deduped receipts
      // and vanished bills as recorded, so the landlord read «2 πληρωμές
      // καταχωρήθηκαν» when Σ(receipts) moved by one or by nothing at all. The
      // server returns one `updated` entry per processed payment, flagged
      // `duplicate: true` when its idempotency guard skipped the write, and
      // omits entries entirely for a bill/repair it could not find.
      // NOT named `results` — that is the component-level OCR result list this
      // dialog renders from, and shadowing it here would be a trap for the next
      // edit inside this block.
      const serverResults = Array.isArray(data?.updated) ? data.updated : [];
      const recorded = serverResults.filter((u) => !u?.duplicate).length;
      const duplicates = serverResults.filter((u) => u?.duplicate).length;
      const missing = Math.max(0, payments.length - serverResults.length);
      if (recorded) {
        toast.success(t('{{count}} payment(s) recorded', { count: recorded }));
      }
      if (duplicates) {
        toast.info(
          t('{{count}} payment(s) were already recorded — skipped', {
            count: duplicates
          })
        );
      }
      if (missing) {
        toast.warning(
          t('{{count}} payment(s) could not be matched and were not recorded', {
            count: missing
          })
        );
      }
      // OVERPAY (2026-07): the server reports `overpaid` (Σ(receipts) − owed) on
      // any target this batch pushed past its total. Recording still happened —
      // refusing would drop money the landlord actually paid — but this is the
      // ONLY moment the excess is visible: an overpaid bill becomes 'paid', and
      // every downstream surface either clamps the outstanding at zero or filters
      // 'paid' out entirely. Usually it means the receipt matched the WRONG bill
      // or an amount was typed with a slipped decimal, so name the target (from
      // the candidate the user picked) and keep the toast up until dismissed.
      for (const u of serverResults) {
        if (!(u?.overpaid > 0)) continue;
        const id = u.kind === 'repair' ? u.repairId : u.billId;
        const picked = confirmable.find(({ uid }) => {
          const c = selected[uid];
          return (
            c &&
            String(c.kind === 'repair' ? c.repairId : c.billId) === String(id)
          );
        });
        const name = picked
          ? selected[picked.uid].expenseName
          : t('the selected item');
        toast.warning(
          t('{{name}} is now overpaid by {{amount}} — check the match', {
            name,
            amount: formatMoney(u.overpaid)
          }),
          { duration: Infinity }
        );
      }
      handleClose();
    } catch (error) {
      console.error('Payment confirm error:', error);
      // The server records each receipt in its own save() — the batch is NOT
      // transactional, so a failure on payment 3 of 5 has already persisted 1
      // and 2. Skipping invalidation here left those two paid bills rendering
      // as unpaid until the next refetch, which invites the landlord to record
      // them a second time. Invalidate on the failure path too.
      invalidateMoneySurfaces();
      toast.error(t('Failed to confirm payment'));
      setState('preview');
    }
  }, [
    confirmable,
    selected,
    amounts,
    longKeys,
    handleClose,
    invalidateMoneySurfaces,
    t
  ]);

  const failedCount = results.filter((r) => !r.success).length;
  const isLoading = state === 'loading' || state === 'confirming';

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Match payment receipt')}
      renderContent={() => (
        <div className="pt-4 space-y-4">
          {(state === 'idle' || state === 'loading') && (
            <FileDropZone
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              files={files}
              onFilesChange={setFiles}
              disabled={isLoading}
              dropLabel={t('Drop receipt PDF or photo here or click to browse')}
              description={t(
                'Upload payment receipts (PDF or photo). Matched to open bills and repairs.'
              )}
            />
          )}

          {state === 'preview' && (
            <div className="space-y-4 max-h-[65vh] overflow-y-auto">
              {failedCount > 0 && (
                <div className="flex items-center gap-2 rounded-md bg-destructive/5 text-destructive text-xs px-2.5 py-2">
                  <LuFileWarning className="size-3.5 shrink-0" />
                  {t('{{failed}} receipt(s) could not be read', {
                    failed: failedCount
                  })}
                </div>
              )}
              {results.map((r, i) => {
                const uid = uidOf(r, i);
                if (!r.success) return null;
                const c = selected[uid];
                const cid = c
                  ? c.kind === 'repair'
                    ? c.repairId
                    : c.billId
                  : null;
                return (
                  <ReceiptMatchCard
                    key={uid}
                    uid={uid}
                    result={r}
                    selectedId={cid}
                    onSelect={onSelect}
                    editAmount={editAmount}
                    amount={amounts[uid]}
                    longKeys={longKeys[uid]}
                    onEditLongKey={onEditLongKey}
                    onRecoverLongKey={onRecoverLongKey}
                  />
                );
              })}
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
            <Button onClick={handleParse} data-cy="parseReceipts">
              {t('Continue')}
            </Button>
          )}
          {state === 'preview' && confirmable.length > 0 && (
            <Button onClick={handleConfirm} data-cy="confirmPayment">
              {t('Record payment')} ({confirmable.length})
            </Button>
          )}
        </>
      )}
    />
  );
}
