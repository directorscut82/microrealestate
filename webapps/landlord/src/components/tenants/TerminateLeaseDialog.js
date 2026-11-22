import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { terminateLease, unpaidAtTermination } from '../../utils/leaseArrears';

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
  // What this window remembers between two presses of «Τερματισμός»: the tenant it
  // has written off for, and the version its last write-off left that tenant at
  // (utils/leaseArrears terminateLease says why).
  const memory = useRef({ wroteOffFor: null, version: null });
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
    formState: { errors, isSubmitting }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
    values: initialValues
  });

  const tenantId = watch('tenantId');

  // Same leak WITHIN one open dialog: the dashboard entry point renders a tenant
  // Select, so the landlord can tick the write-off for tenant A and then switch
  // the dropdown to tenant B without closing. The figures below recompute for B,
  // but the ticked box would carry A's intent onto B's arrears. Untick whenever
  // the subject changes — the landlord must opt in per tenant.
  useEffect(() => {
    setWriteOff(false);
  }, [tenantId]);

  // Closed by ANY route — «Ακύρωση», a finished termination, Esc, the ✕ — the window
  // forgets what it remembered and unticks the box. Esc and ✕ go straight to the
  // parent's setter and never reach handleClose below.
  useEffect(() => {
    if (!open) {
      memory.current.wroteOffFor = null;
      memory.current.version = null;
      setWriteOff(false);
    }
  }, [open]);

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

    // The ledger is read as ONE account, oldest month first (utils/leaseArrears).
    // A row on its own cannot answer «is this month still unpaid?»:
    //   · `totalToPay` includes what the month carried in, so adding rows up counts
    //     the same debt again and again (measured on live data: 23.400 € shown for
    //     3.600 € of real arrears);
    //   · a month is usually settled through a payment recorded on a LATER month's
    //     page — counting such a row offered to write off money already received;
    //   · a month can be covered by a credit carried in from an earlier one —
    //     counting such a row listed it as unpaid when nothing is owed on it.
    const { kept, dropped } = unpaidAtTermination(rents, cutTerm);
    const keptMonths = kept.months;
    const keptAmount = kept.amount;
    const droppedMonths = dropped.months;
    const droppedAmount = dropped.amount;

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
    // `writeOff` is component state, and this dialog is MOUNTED ONCE by the
    // dashboard shortcut (Shortcuts.js:154) and reused for whichever tenant is
    // picked next. reset() only clears the react-hook-form fields, so a ticked
    // write-off box survived a close and applied to a DIFFERENT tenant on the
    // next open — silently discounting that tenant's arrears to zero. Clear it
    // with the form.
    setWriteOff(false);
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
      // Write off first when the box is ticked, then terminate — one request per
      // unpaid month, each from a fresh read of the ledger, and every request sent
      // at the version this window knows the tenant at (utils/leaseArrears
      // terminateLease).
      await terminateLease({
        tenant: updatedTenant,
        writeOff: writeOff && outstanding.keptAmount > 0,
        cutYearMonth: Number(
          moment(tenantPart.terminationDate).format('YYYYMM')
        ),
        note: t('Written off on lease termination'),
        memory: memory.current,
        io: {
          readLedger: () => fetchTenantRents(tenant._id),
          record: payRent,
          terminate: (body) => terminateMutation.mutateAsync(body)
        }
      });
      handleClose();
    } catch (error) {
      // Write-offs recorded before the failure are on the ledger. Refresh what this
      // window (and the rents page behind it) shows, so a second attempt is made on
      // the figures as they now stand and not on the ones from before it.
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
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
          // A 409 here is the optimistic lock, from a write-off or from the
          // termination: the tenant's version is not the one this window knows. It
          // was saved somewhere else since — or a write-off of this window was saved
          // without the window learning the version it left (its answer never
          // arrived, or named none); reloading is right in every case. (A date
          // outside the lease is a 422 and shows the server's own text above; it
          // used to be a 409, hence the old message here.)
          return toast.error(
            t(
              'This tenant was changed by another window. Reload the page and try again.'
            )
          );
        default:
          return toast.error(t('Something went wrong'));
      }
    }
  };

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      // «Σε εξέλιξη» from the first write-off to the end, not only while the
      // termination itself is sent: with the buttons still there, a second press
      // started a second run, and «Ακύρωση» closed the window while the first went
      // on to terminate the lease unseen.
      isLoading={isSubmitting || terminateMutation.isPending}
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
