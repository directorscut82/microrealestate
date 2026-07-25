import {
  confirmReceiptPayments,
  parsePaymentReceipts,
  QueryKeys
} from '../../utils/restcalls';
import {
  LuAlertTriangle,
  LuCheck,
  LuFileWarning,
  LuReceipt
} from 'react-icons/lu';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import FileDropZone from '../ui/file-drop-zone';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import NumberFormat from '../NumberFormat';
import ResponsiveDialog from '../ResponsiveDialog';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

/*
 * PaymentReceiptDialog — U6 (Slice 6, approved mock
 * documentation/mockups/receipt-match-panel.html).
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

function ReceiptMatchCard({
  result,
  uid,
  selectedId,
  onSelect,
  editAmount,
  amount
}) {
  const { t } = useTranslation('common');
  const rec = result.recognized || {};
  const candidates = result.candidates || [];

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
            <span className="font-mono">
              {new Date(rec.date).toLocaleDateString()}
            </span>
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
        {!rec.hasValidLongKey && (
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

  useEffect(() => {
    if (!open) {
      setState('idle');
      setFiles([]);
      setResults([]);
      setSelected({});
      setAmounts({});
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

  const confirmable = useMemo(
    () =>
      results
        .map((r, i) => ({ r, uid: uidOf(r, i) }))
        .filter(({ r, uid }) => r.success && selected[uid]),
    [results, selected]
  );

  const handleConfirm = useCallback(async () => {
    if (confirmable.length === 0) return;
    setState('confirming');
    try {
      const payments = confirmable.map(({ r, uid }) => {
        const c = selected[uid];
        const parsedAmount = parseFloat(String(amounts[uid]).replace(',', '.'));
        return {
          kind: c.kind,
          billId: c.kind === 'bill' ? c.billId : undefined,
          repairId: c.kind === 'repair' ? c.repairId : undefined,
          buildingId: c.buildingId,
          amount: Number.isFinite(parsedAmount) ? parsedAmount : undefined,
          date: r.recognized?.date,
          matchedOn: c.matchedOn,
          ocrText: r.ocrText
        };
      });
      await confirmReceiptPayments(payments);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BILLS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      if (building?._id) {
        queryClient.invalidateQueries({
          queryKey: [QueryKeys.BUILDINGS, building._id]
        });
      }
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      toast.success(
        t('{{count}} payment(s) recorded', { count: payments.length })
      );
      handleClose();
    } catch (error) {
      console.error('Payment confirm error:', error);
      toast.error(t('Failed to confirm payment'));
      setState('preview');
    }
  }, [
    confirmable,
    selected,
    amounts,
    building?._id,
    handleClose,
    queryClient,
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
