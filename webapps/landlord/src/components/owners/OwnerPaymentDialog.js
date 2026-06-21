import { Card, CardContent, CardHeader } from '../ui/card';
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle
} from '../ui/drawer';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import { payOwner, QueryKeys } from '../../utils/restcalls';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Collapse } from '../ui/collapse';
import { DatePickerInput } from '../ui/date-picker-input';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import NumberFormat from '../NumberFormat';
import useFormatNumber from '../../hooks/useFormatNumber';
import { Textarea } from '../ui/textarea';
import { ownerChargeLabel } from '../../utils/lineLabels';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import moment from 'moment';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import usePaymentTypes from '../../hooks/usePaymentTypes';
import useTranslation from 'next-translate/useTranslation';

const _round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const _todayISO = () => moment().format('YYYY-MM-DD');

// A new-καταβολή draft — the owner twin of PaymentTabs' emptyPayment(). The
// owner endpoint records ONE payment per call (date/amount/type/reference/
// description + an allocation across the owner's charges), so each draft is one
// payOwner request; multiple drafts submit sequentially. Allocation mirrors the
// rent AllocationBlock semantics: auto (oldest-first, no allocation sent),
// specific (one charge), custom (per-charge amounts).
const emptyDraft = () => ({
  amount: '',
  date: _todayISO(),
  type: 'transfer',
  reference: '',
  description: '',
  mode: 'auto', // auto | specific | custom
  specificId: '',
  custom: {} // ownerExpenseId -> amount string
});

// Owner καταβολή dialog — the OWNER twin of the tenant rent settlement dialog
// (NewPaymentDialog + PaymentTabs). Same Drawer shell, same per-charge summary
// rows (Οφειλόμενο / Καταβολή / Υπόλοιπο), same "Καταβολή" card with "Νέα
// καταβολή" draft rows (Ημερομηνία / Τύπος / IBAN ή αρ. πράξης / Ποσό + the
// collapsible Σημείωση) and the "+ Προσθήκη νέας καταβολής" button. Fed by the
// owner's charges (every eksoda type + επισκευή per month) instead of one
// rent's term, and posted to payOwner instead of payRent. The UI language is
// deliberately identical to the tenant dialog (the user's explicit ask).
export default function OwnerPaymentDialog({ open, setOpen, owner }) {
  const { t } = useTranslation('common');
  const formatNumber = useFormatNumber();
  const queryClient = useQueryClient();
  const { itemList: paymentTypes } = usePaymentTypes();
  const [drafts, setDrafts] = useState([]);
  const [saving, setSaving] = useState(false);
  // Synchronous re-entry guard — `saving` (useState) only disables the button
  // AFTER React re-renders; a fast double-click before that runs handleSubmit
  // twice and fires duplicate payOwner calls. A ref flips synchronously so the
  // second click bails (mirrors NewPaymentDialog.submittingRef).
  const submittingRef = useRef(false);

  // Outstanding charges, grouped by month then sorted by type — so the summary
  // shows "every eksoda type + επισκευή per month" the way the rent dialog
  // shows a term's charges. (A settled charge has outstanding 0 → excluded,
  // exactly like the rent dialog only lists owed lines.)
  const outstandingCharges = useMemo(
    () =>
      (owner?.charges || [])
        .filter((c) => Number(c.outstanding) > 0.005)
        .sort((a, b) => a.term - b.term),
    [owner]
  );

  const chargesByMonth = useMemo(() => {
    const map = new Map();
    for (const c of outstandingCharges) {
      const key = Number(c.term);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [outstandingCharges]);

  // Reset on (re)open.
  useEffect(() => {
    if (open) {
      setDrafts([]);
      submittingRef.current = false;
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: (payload) => payOwner(owner.ownerKey, payload)
  });

  const _termLabel = (term) => {
    const s = String(term);
    return s.length >= 6 ? `${s.slice(4, 6)}/${s.slice(0, 4)}` : s;
  };

  const setDraft = (index, patch) =>
    setDrafts((prev) =>
      prev.map((d, i) => (i === index ? { ...d, ...patch } : d))
    );

  // Build the payOwner payload for one draft (mirrors the owner allocation
  // contract: omit allocation for auto; one entry for specific; per-charge for
  // custom). Returns null when the draft is empty/invalid.
  const draftToPayload = useCallback((d) => {
    const amt = _round(d.amount);
    if (!(amt > 0)) return null;
    let allocation;
    if (d.mode === 'specific') {
      if (!d.specificId) return { error: t('Select a charge to settle') };
      allocation = [{ ownerExpenseId: d.specificId, amount: amt }];
    } else if (d.mode === 'custom') {
      allocation = Object.entries(d.custom)
        .map(([ownerExpenseId, v]) => ({ ownerExpenseId, amount: _round(v) }))
        .filter((a) => a.amount > 0.005);
      if (allocation.length === 0)
        return { error: t('Enter at least one charge amount') };
      const allocSum = _round(allocation.reduce((s, a) => s + a.amount, 0));
      // Block over-allocation client-side (server would 422). The submitted
      // amount IS the allocation sum in custom mode, so the toast + the
      // recorded figure can never disagree.
      if (allocSum > amt + 0.005) {
        // R2-M6: org locale/currency, €-free key.
        return { error: t('Over-allocated by {{amount}}', {
          amount: formatNumber(allocSum - amt)
        }) };
      }
    }
    // In custom mode the payment amount IS the allocation sum (so no surplus
    // is silently dropped and the toast is truthful); auto/specific use the
    // typed amount.
    const payloadAmount =
      d.mode === 'custom'
        ? _round(allocation.reduce((s, a) => s + a.amount, 0))
        : amt;
    return {
      payload: {
        date: d.date,
        amount: payloadAmount,
        type: d.type,
        reference: d.reference,
        description: d.description,
        ...(allocation ? { allocation } : {})
      }
    };
  }, [t]);

  // Refresh every owner/expense surface AND block until the owners cache is
  // fresh — same contract the tenant dialog uses (PaymentTabs await-refetch)
  // so a re-click cannot re-submit against stale outstanding.
  const refreshOwners = useCallback(async () => {
    await queryClient
      .refetchQueries({ queryKey: [QueryKeys.OWNERS] })
      .catch(() => {});
    queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
  }, [queryClient]);

  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return; // synchronous re-entry guard
    // Index the real (amount>0) drafts so we can drop the ones that COMMITTED
    // if a later one fails — the owner endpoint records ONE payment per call
    // and is NOT atomic across drafts. Without dropping committed drafts, a
    // retry after a mid-sequence error re-submits an already-recorded payment
    // (the duplicate-payment class the tenant dialog guards against).
    const realIdx = drafts
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => _round(d.amount) > 0);
    if (realIdx.length === 0) {
      toast.error(t('Enter a payment amount'));
      return;
    }
    const items = [];
    for (const { d, i } of realIdx) {
      const r = draftToPayload(d);
      if (r?.error) {
        toast.error(r.error);
        return;
      }
      if (r?.payload) items.push({ payload: r.payload, draftIndex: i });
    }
    submittingRef.current = true;
    setSaving(true);
    const committedDraftIndexes = [];
    let allocatedTotal = 0;
    try {
      for (const it of items) {
        // Report the server's ACTUALLY-allocated sum, never the typed amount —
        // an auto/custom overpayment drops the surplus (no owner carry-forward
        // ledger), so the typed figure would over-state what landed.
        const res = await mutation.mutateAsync(it.payload);
        committedDraftIndexes.push(it.draftIndex);
        const landed = Number(res?.allocatedTotal);
        allocatedTotal += Number.isFinite(landed)
          ? landed
          : Number(it.payload.amount) || 0;
      }
      await refreshOwners();
      toast.success(
        // R2-M6: org locale/currency, €-free key.
        t('Payment of {{amount}} recorded', {
          amount: formatNumber(allocatedTotal)
        })
      );
      setOpen(false);
    } catch (e) {
      // Drop the drafts that already committed so a retry can't double-pay,
      // and refresh so any remaining drafts re-validate against live
      // outstanding. The dialog stays open with only the UNcommitted drafts.
      if (committedDraftIndexes.length > 0) {
        const committed = new Set(committedDraftIndexes);
        setDrafts((prev) => prev.filter((_, i) => !committed.has(i)));
        await refreshOwners();
      }
      const msg =
        e?.response?.data?.error ||
        e?.response?.data?.message ||
        e?.message ||
        t('Something went wrong');
      toast.error(
        committedDraftIndexes.length > 0
          ? `${t('Some payments were recorded; the rest were not.')} ${msg}`
          : msg
      );
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }, [drafts, draftToPayload, mutation, refreshOwners, setOpen, t]);

  // Per-charge summary row — the owner twin of the rent dialog's owed-line
  // header: label (incl. επισκευές) + Οφειλόμενο / Καταβολή / Υπόλοιπο.
  const renderChargeRow = (c) => {
    const paidSoFar = _round(
      (Number(c.amount) || 0) - (Number(c.outstanding) || 0)
    );
    return (
      <div
        key={c.ownerExpenseId}
        className="grid grid-cols-[1fr_auto] gap-2 py-1.5 border-b border-stone-line/40 last:border-b-0"
      >
        <div className="min-w-0">
          <div className="text-sm text-ink truncate">
            {ownerChargeLabel(t, c)}
          </div>
          <div className="text-label text-ink-muted">{c.buildingName}</div>
        </div>
        <div className="flex items-center gap-4 shrink-0 text-label tabular-nums">
          <span className="text-right">
            <span className="block text-ink-muted">{t('Owed')}</span>
            <NumberFormat value={c.amount} />
          </span>
          <span className="text-right">
            <span className="block text-ink-muted">{t('Payment')}</span>
            <NumberFormat value={paidSoFar} />
          </span>
          <span className="text-right">
            <span className="block text-ink-muted">{t('Balance')}</span>
            <span className="text-oxide">
              <NumberFormat value={c.outstanding} />
            </span>
          </span>
        </div>
      </div>
    );
  };

  // One "Νέα καταβολή" draft block — identical layout to PaymentTabs' draft
  // row (Ημερομηνία / Τύπος / IBAN ή αρ. πράξης / Ποσό + collapsible Σημείωση),
  // plus the owner allocation selector (auto / specific / custom).
  const renderDraft = (d, index) => {
    const customTotal = _round(
      Object.values(d.custom).reduce((s, v) => s + (Number(v) || 0), 0)
    );
    // Delta between the typed amount and the custom allocation — mirrors the
    // rent AllocationBlock so the landlord sees an under/over-allocation
    // BEFORE submit (the owner endpoint silently drops an under-allocated
    // surplus; an over-allocation is rejected 422). Only meaningful in custom.
    const draftAmt = _round(d.amount);
    const customDelta = _round(draftAmt - customTotal);
    return (
      <div key={index} className="mb-4 p-3 border rounded-md bg-bone">
        <div className="flex justify-between items-center mb-2">
          <div className="font-medium">{t('New payment')}</div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== index))}
            aria-label={t('Cancel')}
          >
            <LuTrash2 className="size-4" />
          </Button>
        </div>
        <div className="grid gap-2 items-end grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor={`ownerPay.${index}.date`}>{t('Date')}</Label>
            <DatePickerInput
              id={`ownerPay.${index}.date`}
              value={
                d.date ? moment(d.date, 'YYYY-MM-DD').format('DD/MM/YYYY') : ''
              }
              onChange={(val) => {
                const iso = val
                  ? moment(val, 'DD/MM/YYYY').format('YYYY-MM-DD')
                  : '';
                setDraft(index, { date: iso });
              }}
            />
          </div>
          <div className="space-y-1">
            <Label>{t('Type')}</Label>
            <Select
              value={d.type}
              onValueChange={(val) => setDraft(index, { type: val })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {paymentTypes.map((pt) => (
                  <SelectItem
                    key={pt.id}
                    value={pt.value}
                    disabled={pt.disabled}
                    className={pt.disabled ? 'italic text-ink-muted' : undefined}
                  >
                    {pt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {d.type !== 'cash' && (
            <div className="space-y-1">
              <Label htmlFor={`ownerPay.${index}.reference`}>
                {d.type === 'cheque'
                  ? t('Cheque no.')
                  : d.type === 'transfer'
                    ? t('IBAN or transaction id')
                    : t('Reference')}
              </Label>
              <Input
                id={`ownerPay.${index}.reference`}
                value={d.reference}
                onChange={(e) => setDraft(index, { reference: e.target.value })}
              />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`ownerPay.${index}.amount`}>{t('Amount')}</Label>
            <Input
              id={`ownerPay.${index}.amount`}
              type="number"
              step="0.01"
              min="0"
              value={d.amount}
              onChange={(e) => setDraft(index, { amount: e.target.value })}
            />
          </div>
        </div>

        {/* Allocation — owner twin of AllocationBlock: which charge(s) this
            καταβολή settles. Shown once an amount is entered. */}
        {Number(d.amount) > 0 && outstandingCharges.length > 0 && (
          <div className="mt-3 space-y-2">
            <Label>{t('Apply to')}</Label>
            <div className="flex flex-wrap gap-2 text-sm">
              {['auto', 'specific', 'custom'].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDraft(index, { mode: m })}
                  className={
                    'rounded-md border px-3 py-1.5 transition-colors ' +
                    (d.mode === m
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted')
                  }
                >
                  {m === 'auto'
                    ? t('Auto (oldest first)')
                    : m === 'specific'
                      ? t('Specific charge')
                      : t('Custom split')}
                </button>
              ))}
            </div>

            {d.mode === 'auto' && (
              <p className="text-xs text-muted-foreground">
                {t('The payment settles the oldest outstanding charges first.')}
              </p>
            )}

            {d.mode === 'specific' && (
              <Select
                value={d.specificId}
                onValueChange={(val) => setDraft(index, { specificId: val })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select a charge')} />
                </SelectTrigger>
                <SelectContent>
                  {outstandingCharges.map((c) => (
                    <SelectItem key={c.ownerExpenseId} value={c.ownerExpenseId}>
                      {/* Append the outstanding amount so two charges of the
                          same type/month (identical label) are still
                          distinguishable in the list — and so the landlord sees
                          what each option costs. */}
                      <span className="inline-flex w-full items-baseline justify-between gap-3">
                        <span className="truncate">
                          {_termLabel(c.term)} · {ownerChargeLabel(t, c)}
                        </span>
                        <span className="font-mono tabular-nums text-ink-muted shrink-0">
                          <NumberFormat value={c.outstanding} />
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {d.mode === 'custom' && (
              <div className="space-y-1.5">
                {outstandingCharges.map((c) => (
                  <div
                    key={c.ownerExpenseId}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="text-sm text-ink-muted truncate min-w-0">
                      {_termLabel(c.term)} · {ownerChargeLabel(t, c)}
                    </span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max={c.outstanding}
                      className="w-24 h-8 text-right shrink-0"
                      value={d.custom[c.ownerExpenseId] ?? ''}
                      onChange={(e) =>
                        setDraft(index, {
                          custom: {
                            ...d.custom,
                            [c.ownerExpenseId]: e.target.value
                          }
                        })
                      }
                      placeholder="0.00"
                    />
                  </div>
                ))}
                <div className="flex justify-between text-xs pt-1 border-t border-stone-line/50">
                  <span className="text-muted-foreground">{t('Allocated')}</span>
                  <span className="tabular-nums">
                    <NumberFormat value={customTotal} /> /{' '}
                    <NumberFormat value={draftAmt} />
                  </span>
                </div>
                {/* Under/over-allocation warning (mirrors AllocationBlock).
                    Over → server rejects; under → the typed surplus is dropped
                    (no owner carry-forward), so warn the landlord before submit. */}
                {Math.abs(customDelta) > 0.005 && (
                  <div
                    className={
                      'text-xs ' +
                      (customDelta < 0 ? 'text-oxide' : 'text-amber-600')
                    }
                  >
                    {/* R2-M6: org locale/currency, €-free keys. */}
                    {customDelta < 0
                      ? t('Over-allocated by {{amount}}', {
                          amount: formatNumber(Math.abs(customDelta))
                        })
                      : t('{{amount}} of this payment is unallocated and will not be recorded.', {
                          amount: formatNumber(customDelta)
                        })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Per-payment note — same collapsible affordance as the rent dialog
            (the owner endpoint has no discount/extra-charge, so only Σημείωση). */}
        <div className="mt-3">
          <Collapse title={t('Note')}>
            <div className="space-y-1">
              <Label htmlFor={`ownerPay.${index}.description`}>
                {t('Note (only visible to landlord)')}
              </Label>
              <Textarea
                id={`ownerPay.${index}.description`}
                value={d.description}
                onChange={(e) => setDraft(index, { description: e.target.value })}
              />
            </div>
          </Collapse>
        </div>
      </div>
    );
  };

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerContent className="h-full w-full">
        <DrawerHeader className="mx-auto w-full max-w-screen-lg text-lg md:text-xl font-semibold leading-none tracking-tight px-4">
          <DrawerTitle>
            {owner?.name
              ? `${t('Enter an owner expense settlement')} — ${owner.name}`
              : t('Enter an owner expense settlement')}
          </DrawerTitle>
        </DrawerHeader>

        <div className="p-4 overflow-y-auto scrollbar-branded mx-auto w-full max-w-screen-lg space-y-4">
          {/* Per-charge summary — every outstanding eksoda type + επισκευή,
              grouped by month, with Οφειλόμενο / Καταβολή / Υπόλοιπο. */}
          {chargesByMonth.length > 0 ? (
            chargesByMonth.map(([term, charges]) => (
              <div
                key={term}
                className="rounded-md border border-stone-line/60 bg-muted/20 p-3"
              >
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                  {_termLabel(term)}
                </div>
                {charges.map(renderChargeRow)}
              </div>
            ))
          ) : (
            <div className="p-2 rounded border border-stone-line/40 bg-muted/30 text-muted-foreground text-sm">
              {t('No outstanding owner charges.')}
            </div>
          )}

          {/* Καταβολή card — the draft entries, identical to the rent dialog. */}
          <Card>
            <CardHeader className="text-lg px-6 pt-3 pb-0">
              {t('Payment')}
            </CardHeader>
            <CardContent>
              {drafts.map(renderDraft)}
              <Button
                type="button"
                variant="outline"
                onClick={() => setDrafts((prev) => [...prev, emptyDraft()])}
                disabled={outstandingCharges.length === 0}
              >
                <LuPlus className="size-4 mr-1" />
                {drafts.length > 0 ? t('Add another payment') : t('Add a payment')}
              </Button>
            </CardContent>
          </Card>
        </div>

        <DrawerFooter className="mx-auto w-full max-w-screen-lg">
          <div className="flex flex-col md:flex-row md:justify-end sm:gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={saving || drafts.length === 0}
            >
              {saving ? t('Saving') : t('Record')}
            </Button>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
