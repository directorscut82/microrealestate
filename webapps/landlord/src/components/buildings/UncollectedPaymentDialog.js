import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '../ui/dialog';
import { addUncollectedPayment, QueryKeys } from '../../utils/restcalls';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { DatePickerInput } from '../ui/date-picker-input';
import NumberFormat from '../NumberFormat';
import moment from 'moment';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

const _todayISO = () => moment().format('YYYY-MM-DD');

// §5: a small, SELF-CONTAINED dialog to record a VOLUNTARY contribution toward a
// building's Αχρέωτα (uncollected vacant-unit expense money). It POSTs ONLY to
// /buildings/:id/uncollected-payment — it deliberately does NOT touch the rent /
// owner payment-allocation engine, so the contributed euro is never recorded as
// a settling payment on any ledger (no double-count, no phantom credit). The
// landlord opens it from the Overview Αχρέωτα tile. paidByType/payerId default
// to a generic 'owner'/'building' marker since this is a building-level
// voluntary coverage, not attributed to a specific tenant or owner debt.
export default function UncollectedPaymentDialog({
  open,
  setOpen,
  building,
  outstanding
}) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const submittingRef = useRef(false);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(_todayISO());
  const [reference, setReference] = useState('');

  // The term to attribute the contribution to: the current month (the tile is a
  // cumulative-year figure; we record the voluntary coverage against the current
  // term so the panel for this month reflects it).
  const currentTerm = useMemo(
    () => Number(moment().format('YYYYMM') + '0100'),
    []
  );

  const mutation = useMutation({
    mutationFn: (payload) => addUncollectedPayment(building._id, payload)
  });

  const reset = useCallback(() => {
    setAmount('');
    setDate(_todayISO());
    setReference('');
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return;
    const amt = Math.round((Number(amount) || 0) * 100) / 100;
    if (!(amt > 0)) {
      toast.error(t('Enter a payment amount'));
      return;
    }
    // Clamp to the outstanding Αχρέωτα — you can't cover more than is uncollected.
    if (outstanding != null && amt > Number(outstanding) + 0.005) {
      toast.error(
        t('Over-allocated by {{amount}}', {
          amount: (amt - Number(outstanding)).toFixed(2)
        })
      );
      return;
    }
    submittingRef.current = true;
    try {
      await mutation.mutateAsync({
        term: currentTerm,
        amount: amt,
        paidByType: 'owner',
        payerId: 'building',
        date,
        reference
      });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      toast.success(
        t('Payment of {{amount}} recorded', { amount: amt.toFixed(2) })
      );
      reset();
      setOpen(false);
    } catch (e) {
      toast.error(
        e?.response?.data?.error ||
          e?.response?.data?.message ||
          e?.message ||
          t('Something went wrong')
      );
    } finally {
      submittingRef.current = false;
    }
  }, [
    amount,
    outstanding,
    currentTerm,
    date,
    reference,
    mutation,
    queryClient,
    reset,
    setOpen,
    t
  ]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Cover building uncollected')}</DialogTitle>
          <DialogDescription>
            {t(
              'A coverage payment toward this building’s uncollected expenses. It is NOT a debt and does not settle any rent or owner charge.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {outstanding != null && (
            <div className="text-sm text-muted-foreground">
              {t('Still uncollected')}:{' '}
              <span className="font-medium text-oxide">
                <NumberFormat value={Number(outstanding)} showZero />
              </span>
            </div>
          )}
          <div className="space-y-1">
            <Label>{t('Amount')}</Label>
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
              <span className="text-sm text-muted-foreground">€</span>
            </div>
          </div>
          <div className="space-y-1">
            <Label>{t('Date')}</Label>
            <DatePickerInput value={date} onChange={setDate} />
          </div>
          <div className="space-y-1">
            <Label>{t('Reference')}</Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSubmit}>{t('Coverage payment')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
