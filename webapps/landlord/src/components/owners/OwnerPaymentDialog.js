import { payOwner, QueryKeys } from '../../utils/restcalls';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import NumberFormat from '../NumberFormat';
import ResponsiveDialog from '../ResponsiveDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

const _round = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Owner καταβολή dialog — mirrors the tenant rent payment dialog for owner
// expenses. Records ONE payment against the owner with an allocation across
// their outstanding charges:
//   - auto    → omit allocation; server spreads oldest-term-first
//   - specific→ one chosen charge, full amount
//   - custom  → per-charge amounts (capped at each charge's outstanding)
export default function OwnerPaymentDialog({ open, setOpen, owner }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [type, setType] = useState('transfer');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState('auto'); // auto | specific | custom
  const [specificId, setSpecificId] = useState('');
  const [custom, setCustom] = useState({}); // ownerExpenseId -> amount string

  const outstandingCharges = useMemo(
    () =>
      (owner?.charges || [])
        .filter((c) => Number(c.outstanding) > 0.005)
        .sort((a, b) => a.term - b.term),
    [owner]
  );

  // Reset the form whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setAmount('');
      setDate(new Date().toISOString().slice(0, 10));
      setType('transfer');
      setReference('');
      setDescription('');
      setMode('auto');
      setSpecificId(outstandingCharges[0]?.ownerExpenseId || '');
      setCustom({});
    }
  }, [open, outstandingCharges]);

  const mutation = useMutation({
    mutationFn: (payload) => payOwner(owner.ownerKey, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.OWNERS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    }
  });

  const _termLabel = (term) => {
    const s = String(term);
    return s.length >= 6 ? `${s.slice(4, 6)}/${s.slice(0, 4)}` : s;
  };

  const customTotal = useMemo(
    () =>
      _round(
        Object.values(custom).reduce((s, v) => s + (Number(v) || 0), 0)
      ),
    [custom]
  );

  const handleSubmit = useCallback(async () => {
    const amt = _round(amount);
    if (!(amt > 0)) {
      toast.error(t('Enter a payment amount'));
      return;
    }
    let allocation;
    if (mode === 'specific') {
      if (!specificId) {
        toast.error(t('Select a charge to settle'));
        return;
      }
      allocation = [{ ownerExpenseId: specificId, amount: amt }];
    } else if (mode === 'custom') {
      allocation = Object.entries(custom)
        .map(([ownerExpenseId, v]) => ({
          ownerExpenseId,
          amount: _round(v)
        }))
        .filter((a) => a.amount > 0.005);
      if (allocation.length === 0) {
        toast.error(t('Enter at least one charge amount'));
        return;
      }
    }
    // auto → no allocation field (server spreads oldest-first).
    try {
      await mutation.mutateAsync({
        date,
        amount: amt,
        type,
        reference,
        description,
        ...(allocation ? { allocation } : {})
      });
      toast.success(t('Payment recorded'));
      setOpen(false);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || t('Something went wrong');
      toast.error(msg);
    }
  }, [
    amount,
    date,
    type,
    reference,
    description,
    mode,
    specificId,
    custom,
    mutation,
    setOpen,
    t
  ]);

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={mutation.isPending}
      renderHeader={() => t('Record an owner payment')}
      renderContent={() => (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ownerPayAmount">{t('Amount')}</Label>
              <Input
                id="ownerPayAmount"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ownerPayDate">{t('Date')}</Label>
              <Input
                id="ownerPayDate"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>{t('Payment method')}</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="transfer">{t('transfer')}</SelectItem>
                  <SelectItem value="cash">{t('cash')}</SelectItem>
                  <SelectItem value="cheque">{t('cheque')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ownerPayRef">{t('Reference')}</Label>
              <Input
                id="ownerPayRef"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="ownerPayDesc">{t('Description')}</Label>
            <Input
              id="ownerPayDesc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Allocation mode */}
          <div className="space-y-2 pt-1">
            <Label>{t('Allocation')}</Label>
            <div className="flex gap-2 text-sm">
              {['auto', 'specific', 'custom'].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={
                    'rounded-md border px-3 py-1.5 transition-colors ' +
                    (mode === m
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

            {mode === 'auto' && (
              <p className="text-xs text-muted-foreground">
                {t(
                  'The payment settles the oldest outstanding charges first.'
                )}
              </p>
            )}

            {mode === 'specific' && (
              <Select value={specificId} onValueChange={setSpecificId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('Select a charge')} />
                </SelectTrigger>
                <SelectContent>
                  {outstandingCharges.map((c) => (
                    <SelectItem key={c.ownerExpenseId} value={c.ownerExpenseId}>
                      {_termLabel(c.term)} · {c.description || c.source} ·{' '}
                      {new Intl.NumberFormat(undefined, {
                        style: 'currency',
                        currency: 'EUR'
                      }).format(c.outstanding)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {mode === 'custom' && (
              <div className="space-y-1">
                {outstandingCharges.map((c) => (
                  <div
                    key={c.ownerExpenseId}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="truncate text-muted-foreground">
                      {_termLabel(c.term)} · {c.description || c.source}{' '}
                      <span className="text-muted-foreground/60">
                        ({t('Outstanding')}:{' '}
                        <NumberFormat value={c.outstanding} />)
                      </span>
                    </span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max={c.outstanding}
                      className="w-24 h-8 text-right"
                      value={custom[c.ownerExpenseId] ?? ''}
                      onChange={(e) =>
                        setCustom((p) => ({
                          ...p,
                          [c.ownerExpenseId]: e.target.value
                        }))
                      }
                      placeholder="0.00"
                    />
                  </div>
                ))}
                <div className="flex justify-between text-xs pt-1 border-t border-stone-line/50">
                  <span className="text-muted-foreground">
                    {t('Allocated')}
                  </span>
                  <span className="tabular-nums">
                    <NumberFormat value={customTotal} />
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {t('Record')}
          </Button>
        </>
      )}
    />
  );
}
