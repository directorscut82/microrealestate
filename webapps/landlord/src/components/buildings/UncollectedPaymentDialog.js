import ResponsiveDialog from '../ResponsiveDialog';
import { addUncollectedPayment, QueryKeys } from '../../utils/restcalls';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { DatePickerInput } from '../ui/date-picker-input';
import NumberFormat from '../NumberFormat';
import useFormatNumber from '../../hooks/useFormatNumber';
import moment from 'moment';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

const _todayISO = () => moment().format('YYYY-MM-DD');

// §5: a small dialog to record a VOLUNTARY contribution toward a building's
// uncollected (Μη εισπραχθέντα) vacant-unit expense money. It POSTs ONLY to
// /buildings/:id/uncollected-payment — it deliberately does NOT touch the rent /
// owner payment-allocation engine, so the contributed euro is never recorded as
// a settling payment on any ledger (no double-count, no phantom credit). Opened
// from the Overview Μη εισπραχθέντα tile. Uses ResponsiveDialog (the building
// domain's shared Dialog-on-desktop / Drawer-on-mobile shell) like every other
// building form. It is a building-level contribution attributed to no specific
// payer, so the payload carries no payerId/paidByType.
export default function UncollectedPaymentDialog({
  open,
  setOpen,
  building,
  outstanding
}) {
  const { t } = useTranslation('common');
  const formatNumber = useFormatNumber();
  const queryClient = useQueryClient();
  const submittingRef = useRef(false);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(_todayISO());
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  // currentTerm is sent only to select the YEAR; the server allocates the amount
  // across that year's outstanding terms oldest-first (see addUncollectedPayment
  // in buildingmanager.ts), so the contribution lands on the months that actually
  // carry the gross, not necessarily this month.
  const currentTerm = useMemo(
    () => Number(moment().format('YYYYMM') + '0100'),
    []
  );

  const mutation = useMutation({
    mutationFn: (payload) => addUncollectedPayment(building._id, payload)
  });

  // Reset on (re)open — mirrors OwnerPaymentDialog so a Cancel/Esc/overlay-close
  // doesn't leave stale values for the next open, and re-defaults the date.
  useEffect(() => {
    if (open) {
      setAmount('');
      setDate(_todayISO());
      setReference('');
      submittingRef.current = false;
      setSaving(false);
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return;
    const amt = Math.round((Number(amount) || 0) * 100) / 100;
    if (!(amt > 0)) {
      toast.error(t('Enter a payment amount'));
      return;
    }
    // Clamp to the outstanding — you can't cover more than is uncollected.
    if (outstanding != null && amt > Number(outstanding) + 0.005) {
      toast.error(
        t('Over-allocated by {{amount}}', {
          amount: formatNumber(amt - Number(outstanding))
        })
      );
      return;
    }
    submittingRef.current = true;
    setSaving(true);
    try {
      await mutation.mutateAsync({
        term: currentTerm,
        amount: amt,
        date,
        reference
      });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      toast.success(
        t('Payment of {{amount}} recorded', { amount: formatNumber(amt) })
      );
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
      setSaving(false);
    }
  }, [
    amount,
    outstanding,
    currentTerm,
    date,
    reference,
    mutation,
    queryClient,
    setOpen,
    t,
    formatNumber
  ]);

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      className="max-w-md"
      renderHeader={() => t('Cover building uncollected')}
      renderContent={() => (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t(
              'A coverage payment toward this building’s uncollected expenses. It is NOT a debt and does not settle any rent or owner charge.'
            )}
          </p>
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
            {/* Keep `date` in ISO internally; bridge to the picker's DD/MM/YYYY
                display + back, exactly like OwnerPaymentDialog — else the server
                new Date() receives an unparseable string. */}
            <DatePickerInput
              value={date ? moment(date, 'YYYY-MM-DD').format('DD/MM/YYYY') : ''}
              onChange={(val) =>
                setDate(val ? moment(val, 'DD/MM/YYYY').format('YYYY-MM-DD') : '')
              }
            />
          </div>
          <div className="space-y-1">
            <Label>{t('Reference')}</Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        </div>
      )}
      renderFooter={() => (
        <div className="flex flex-col md:flex-row md:justify-end sm:gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? t('Saving') : t('Record')}
          </Button>
        </div>
      )}
    />
  );
}
