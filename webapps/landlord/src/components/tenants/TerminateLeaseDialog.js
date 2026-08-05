import React, { useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import moment from 'moment';
import {
  fetchTenantRents,
  payRent,
  QueryKeys,
  updateTenant
} from '../../utils/restcalls';
import ResponsiveDialog from '../ResponsiveDialog';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';
import useFormatNumber from '../../hooks/useFormatNumber';

const schema = z.object({
  tenantId: z.string().min(1),
  terminationDate: z.string().min(1),
  guarantyPayback: z.coerce.number().min(0).optional()
});

export default function TerminateLeaseDialog({ open, setOpen, tenant: tenantProp, tenantList }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const formRef = useRef();
  const [writeOff, setWriteOff] = useState(false);
  const formatNumber = useFormatNumber();
  const fmt = (n) => formatNumber(Number(n) || 0, 'currency', 2);

  const selected = tenantProp;

  const terminateMutation = useMutation({
    mutationFn: updateTenant,
    onSuccess: () => {
      // Termination truncates the rent series and frees the property. Rent
      // ledgers, dashboard counts, and property occupancy all need refresh
      // alongside the tenant cache.
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      // Covers both the rents grid and this dialog's [RENTS,'tenant',id] ledger.
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PROPERTIES] });
    }
  });

  const initialValues = useMemo(
    () => ({
      // Dashboard "Terminate" shortcut passes a tenantList and no tenant.
      // The Select is disabled when only one tenant is available, so we
      // pre-populate tenantId so the form has a valid value out of the
      // gate — otherwise the disabled empty-value Select rejects submit.
      tenantId:
        !tenantList && selected?._id
          ? selected._id
          : tenantList?.length === 1
            ? tenantList[0]._id
            : '',
      terminationDate:
        !tenantList && selected?.terminationDate
          ? moment(selected.terminationDate, 'DD/MM/YYYY').format('YYYY-MM-DD')
          : '',
      guarantyPayback: !tenantList ? selected?.guarantyPayback || '' : ''
    }),
    [selected?._id, selected?.guarantyPayback, selected?.terminationDate, tenantList]
  );

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
    values: initialValues
  });

  const tenantId = watch('tenantId');

  const tenants = useMemo(() => {
    if (tenantList) {
      return tenantList.map((tenant) => ({
        id: tenant._id,
        value: tenant._id,
        label: tenant.name
      }));
    }
    if (selected) {
      return [{ id: selected._id, value: selected._id, label: selected.name }];
    }
    return [];
  }, [selected, tenantList]);

  const minMaxDates = useMemo(() => {
    const tenant =
      tenantList?.find(({ _id }) => _id === tenantId) || selected;
    return {
      min: tenant?.beginDate
        ? moment(tenant.beginDate, 'DD/MM/YYYY').format('YYYY-MM-DD')
        : undefined,
      max: tenant?.endDate
        ? moment(tenant.endDate, 'DD/MM/YYYY').format('YYYY-MM-DD')
        : undefined
    };
  }, [tenantId, tenantList, selected]);

  const terminationDate = watch('terminationDate');
  const guarantyPayback = watch('guarantyPayback');

  // The rent ledger is NOT on the tenant. Measured against the live API: neither
  // GET /tenants nor GET /tenants/:id returns a `rents` key at all — the ledger
  // lives behind GET /rents/tenant/:id (routes.ts:253 → rentManager.rentsOfOccupant).
  // The first version of this panel read `tenant.rents`, so every figure below the
  // deposit was permanently zero and the whole warning silently never rendered.
  const { data: ledger } = useQuery({
    queryKey: [QueryKeys.RENTS, 'tenant', tenantId],
    queryFn: () => fetchTenantRents(tenantId),
    enabled: !!open && !!tenantId
  });

  // WHAT IS STILL OPEN when this lease ends. The dialog used to show four
  // labels and two buttons — no unpaid rent, no held deposit — while
  // Contract.create stops the term loop at the termination date (contract.ts:70),
  // so every rent AFTER it is DELETED from rents[]. The paid-orphan guard
  // (_checkLostPayments) only protects months that carry a PAYMENT, so unpaid
  // arrears in those months pass freely and vanish with no record. Split the
  // figures by whether termination destroys them:
  //   · kept    — months up to and including the termination month stay on the
  //               ledger and remain claimable.
  //   · dropped — months after it are removed outright.
  const outstanding = useMemo(() => {
    const tenant =
      tenantList?.find(({ _id }) => _id === tenantId) || selected;
    const rents = ledger?.rents || [];
    const cutTerm = terminationDate
      ? Number(moment(terminationDate).format('YYYYMM'))
      : null;

    // `totalToPay` INCLUDES the carried `balance` from prior months, so summing
    // it per month double-counts the same debt. Measured on live data: a naive
    // sum reported 23.400 € where the real arrears were 3.600 € — a 6,5×
    // overstatement, the same shape as the repair-panel figure that had to be
    // withdrawn. The month's OWN net charge is `totalToPay − balance`; a payment
    // first clears the carried balance and only the remainder touches this month.
    const ownNetOwed = (r) => {
      const own =
        Math.round(
          ((Number(r?.totalToPay) || 0) - (Number(r?.balance) || 0)) * 100
        ) / 100;
      if (!(own > 0)) return 0;
      const paid = (r?.payments || []).reduce(
        (s, pm) => s + (Number(pm?.amount) || 0),
        0
      );
      const carried = Math.max(0, Number(r?.balance) || 0);
      const appliedToOwn = Math.max(0, Math.round((paid - carried) * 100) / 100);
      return Math.max(0, Math.round((own - appliedToOwn) * 100) / 100);
    };

    let keptMonths = 0;
    let keptAmount = 0;
    let droppedMonths = 0;
    let droppedAmount = 0;

    for (const r of rents) {
      const owed = ownNetOwed(r);
      if (owed <= 0.005) continue;
      const rTerm = Math.floor(Number(r?.term || 0) / 10000);
      if (cutTerm !== null && rTerm > cutTerm) {
        droppedMonths += 1;
        droppedAmount += owed;
      } else {
        keptMonths += 1;
        keptAmount += owed;
      }
    }

    const guaranty = Number(tenant?.guaranty || 0);
    const alreadyRefunded = Number(guarantyPayback || tenant?.guarantyPayback || 0);
    const depositHeld = Math.round((guaranty - alreadyRefunded) * 100) / 100;

    return {
      keptMonths,
      keptAmount: Math.round(keptAmount * 100) / 100,
      droppedMonths,
      droppedAmount: Math.round(droppedAmount * 100) / 100,
      depositHeld: depositHeld > 0.005 ? depositHeld : 0,
      hasAnything:
        keptMonths > 0 || droppedMonths > 0 || depositHeld > 0.005
    };
  }, [tenantId, tenantList, selected, terminationDate, guarantyPayback, ledger]);

  const handleClose = () => {
    setOpen(false);
    reset();
  };

  const _onSubmit = async (tenantPart) => {
    const tenant =
      tenantList?.find(({ _id }) => _id === tenantPart.tenantId) || selected;
    const updatedTenant = {
      ...tenant,
      terminationDate: moment(tenantPart.terminationDate).format('DD/MM/YYYY'),
      guarantyPayback: tenantPart.guarantyPayback || 0
    };

    try {
      // Write off FIRST, then terminate. A `promo` on a payment becomes a
      // settlement-origin discount (rentmanager.ts:1236), and Contract.update
      // REPLAYS settlement discounts across the rebuild (contract.ts:184), so
      // the write-off survives the truncation the termination then performs.
      // Doing it after would be pointless: the months are already gone.
      if (writeOff && outstanding.keptAmount > 0) {
        const cut = Number(moment(tenantPart.terminationDate).format('YYYYMM'));
        // Re-fetch rather than reuse the render-time ledger: the query may have
        // been served from cache while the landlord had the dialog open, and a
        // stale `payments` array here would be REPLACED onto disk (see below).
        const fresh = await fetchTenantRents(tenant._id);
        const ownNet = (r) => {
          const own =
            Math.round(
              ((Number(r?.totalToPay) || 0) - (Number(r?.balance) || 0)) * 100
            ) / 100;
          if (!(own > 0)) return 0;
          const paid = (r?.payments || []).reduce(
            (s, pm) => s + (Number(pm?.amount) || 0),
            0
          );
          const carried = Math.max(0, Number(r?.balance) || 0);
          const applied = Math.max(0, Math.round((paid - carried) * 100) / 100);
          return Math.max(0, Math.round((own - applied) * 100) / 100);
        };

        const openRents = (fresh?.rents || []).filter(
          (r) =>
            ownNet(r) > 0.005 &&
            Math.floor(Number(r?.term || 0) / 10000) <= cut
        );

        for (const r of openRents) {
          const owed = ownNet(r);
          const term = String(r.term);
          // The PATCH has REPLACE semantics — the payments array sent OVERWRITES
          // what is on disk (rentmanager `_updateByTerm`), so existing payments
          // must be echoed back verbatim or a partially-paid month loses its real
          // payment (date/reference/allocation). Same trap as ImportTenantDialog L1.
          const existing = (r.payments || [])
            .filter((p) => Number(p?.amount) > 0)
            .map((p) => ({
              amount: Number(p.amount) || 0,
              date: p.date || '',
              type: p.type || 'transfer',
              reference: p.reference || '',
              description: p.description || '',
              promo: Number(p.promo) || 0,
              notepromo: p.notepromo || '',
              extracharge: Number(p.extracharge) || 0,
              noteextracharge: p.noteextracharge || '',
              allocation: Array.isArray(p.allocation) ? p.allocation : []
            }));

          // The rent-level `promo` is honoured ONLY when no payment carries its
          // own promo (rentmanager.ts:1240 `else if (paymentData.promo)`). On a
          // month whose existing payment already has a promo, a rent-level promo
          // is silently DROPPED — the write-off would report success and record
          // nothing. So attach the write-off to a payment when any exists, and
          // fall back to the rent level only for a month with no payments.
          const anyPaymentPromo = existing.some((p) => p.promo > 0);
          const note = t('Written off on lease termination');
          const payment = {
            _id: tenant._id,
            month: Number(term.slice(4, 6)),
            year: Number(term.slice(0, 4)),
            description: r.description || '',
            extracharge: 0,
            noteextracharge: '',
            promo: 0,
            notepromo: ''
          };
          if (existing.length && anyPaymentPromo) {
            // Add the write-off to the first payment's own promo so the
            // per-payment branch carries it and the cap is respected.
            payment.payments = existing.map((p, i) =>
              i === 0
                ? {
                    ...p,
                    promo: Math.round((p.promo + owed) * 100) / 100,
                    notepromo: p.notepromo ? `${p.notepromo}; ${note}` : note
                  }
                : p
            );
          } else {
            payment.payments = existing;
            payment.promo = owed;
            payment.notepromo = note;
          }
          await payRent({ term, payment });
        }
      }

      await terminateMutation.mutateAsync(updatedTenant);
      handleClose();
    } catch (error) {
      const status = error?.response?.status;
      // The server's 422 here is ACTIONABLE — it names the months with recorded
      // payments that a termination would orphan ("Some payments will be lost
      // because they are out of the contract time frame: 2025040100 500 …").
      // Mapping it to «Λείπει το όνομα ενοικιαστή» was doubly wrong: this dialog
      // has no name field, and it threw away the one message that tells the
      // landlord what to do. Surface apiMessage like the sibling dialogs
      // (NewTenantDialog, tenants/[id]) already do.
      const apiMessage = error?.response?.data?.message;
      switch (status) {
        case 422:
          return toast.error(apiMessage || t('Cannot terminate the lease'));
        case 403:
          return toast.error(t('You are not allowed to update the tenant'));
        case 409:
          return toast.error(t('Termination date is out of the contract time frame'));
        default:
          return toast.error(t('Something went wrong'));
      }
    }
  };

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={terminateMutation.isPending}
      renderHeader={() => t('Terminate a lease')}
      renderContent={() => (
        <form ref={formRef} onSubmit={handleSubmit(_onSubmit)} autoComplete="off" className="w-full">
          <div className="pt-6 space-y-4">
            <div className="space-y-2">
              <Label>{t('Tenant')}</Label>
              <Select
                value={tenantId}
                onValueChange={(val) => setValue('tenantId', val)}
                disabled={tenants.length <= 1}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {tenants.map((ten) => (
                    <SelectItem key={ten.id} value={ten.value}>{ten.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.tenantId && <p className="text-sm text-destructive">{errors.tenantId.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="terminationDate">{t('Termination date')}</Label>
              <Input
                id="terminationDate"
                type="date"
                min={minMaxDates.min}
                max={minMaxDates.max}
                {...register('terminationDate')}
              />
              {errors.terminationDate && <p className="text-sm text-destructive">{errors.terminationDate.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="guarantyPayback">{t('Amount of the deposit refund')}</Label>
              <Input id="guarantyPayback" type="number" {...register('guarantyPayback')} />
              {outstanding.depositHeld > 0 && (
                <p className="text-label text-ink-muted">
                  {t(
                    'Deposit still held: {{amount}}. After termination the deposit amount is LOCKED — only the refund stays editable.',
                    { amount: fmt(outstanding.depositHeld) }
                  )}
                </p>
              )}
            </div>

            {outstanding.hasAnything && (
              <div className="rounded-md border border-oxide/40 bg-oxide-tint/40 p-3 text-sm text-ink space-y-1.5">
                <div className="font-medium">
                  {t('Money still open on this lease')}
                </div>
                {outstanding.keptMonths > 0 && (
                  <div className="text-label">
                    {t(
                      '{{count}} unpaid month(s) up to the termination — {{amount}}. These stay on the ledger and remain claimable.',
                      {
                        count: outstanding.keptMonths,
                        amount: fmt(outstanding.keptAmount)
                      }
                    )}
                  </div>
                )}
                {outstanding.droppedMonths > 0 && (
                  <div className="text-label font-medium text-oxide">
                    {t(
                      '{{count}} unpaid month(s) AFTER the termination date — {{amount}}. Terminating DELETES these from the rent ledger with no record.',
                      {
                        count: outstanding.droppedMonths,
                        amount: fmt(outstanding.droppedAmount)
                      }
                    )}
                  </div>
                )}
                {outstanding.keptAmount > 0 && (
                  <div className="pt-1">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={writeOff}
                        onChange={(e) => setWriteOff(e.target.checked)}
                      />
                      <span className="text-label">
                        {t(
                          'Write off the {{amount}} still claimable as a recorded discount before terminating, so it leaves a trace instead of sitting as a debt nobody will collect.',
                          { amount: fmt(outstanding.keptAmount) }
                        )}
                      </span>
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>
        </form>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleClose}>{t('Cancel')}</Button>
          <Button onClick={() => formRef.current?.requestSubmit()}>{t('Terminate')}</Button>
        </>
      )}
    />
  );
}
