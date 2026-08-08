import React, { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../ui/select';
import { createLease, QueryKeys } from '../../../utils/restcalls';
import ResponsiveDialog from '../../ResponsiveDialog';
import { StoreContext } from '../../../store';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

// Mirror TIME_RANGES in services/api/src/validators.ts.
const TIME_RANGES = ['days', 'weeks', 'months', 'years'];

const schema = z.object({
  name: z.string().trim().min(1),
  // Without an explicit message, an emptied field coerces to 0 and zodErrorMap maps
  // every non-string too_small to «Πολύ μικρό» ("Too short") — a string-length message
  // under a count field, with no hint that the minimum is 1.
  numberOfTerms: z.coerce
    .number({ invalid_type_error: 'Must be at least 1' })
    .int()
    .min(1, { message: 'Must be at least 1' })
    .max(1000, { message: 'Must be 1000 or less' }),
  timeRange: z.enum(['days', 'weeks', 'months', 'years'])
});

export default function NewLeaseDialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);

  const createMutation = useMutation({
    mutationFn: createLease,
    onSuccess: () => {
      // New leases will be picked up by tenant flows; rent computation reads
      // lease config (numberOfTerms, timeRange, fees). Keep TENANTS+RENTS in
      // sync per the lease-mutation rule.
      queryClient.invalidateQueries({ queryKey: [QueryKeys.LEASES] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
    }
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: '', numberOfTerms: 12, timeRange: 'months' }
  });

  const timeRange = watch('timeRange');

  const timeRangeOptions = useMemo(
    () => TIME_RANGES.map((tr) => ({ value: tr, label: t(tr) })),
    [t]
  );

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const _onSubmit = useCallback(
    async (leasePart) => {
      try {
        setIsLoading(true);
        const data = await createMutation.mutateAsync({
          ...leasePart,
          stepperMode: true
        });
        handleClose();
        const orgName = store.organization.selected?.name || router.query.organization;
        await router.push(
          `/${orgName}/settings/contracts/${data._id}`,
          undefined,
          { locale: store.organization.selected?.locale }
        );
      } catch (error) {
        const status = error?.response?.status;
        const message = error?.response?.data?.message;
        switch (status) {
          case 422:
            // A duplicate name is a 422 here, NOT a 409 — leasemanager.add throws
            // ServiceError(422) at :76-79 and grep finds no 409 anywhere in the api.
            // So the `case 409` branch below was dead and the translated «Η σύμβαση
            // υπάρχει ήδη» could never render; the raw English server string showed on
            // the Greek UI instead. Detect the duplicate and use the translation.
            if (message && /already exists/i.test(message)) {
              return toast.error(t('The contract already exists'));
            }
            return toast.error(message || t('Contract name is missing'));
          case 403:
            return toast.error(t('You are not allowed to create a contract'));
          default:
            return toast.error(message || t('Something went wrong'));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [createMutation, handleClose, router, t]
  );

  const formRef = useRef();

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Create a contract')}
      renderContent={() => (
        <form
          ref={formRef}
          onSubmit={handleSubmit(_onSubmit)}
          autoComplete="off"
        >
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="name">{t('Name')}</Label>
              <Input id="name" {...register('name')} />
              {errors.name && (
                <p className="text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>
            <div className="sm:flex sm:gap-2">
              <div className="space-y-2 flex-1">
                <Label htmlFor="numberOfTerms">{t('Number of terms')}</Label>
                <Input
                  id="numberOfTerms"
                  type="number"
                  min="1"
                  {...register('numberOfTerms')}
                />
                {errors.numberOfTerms && (
                  <p className="text-sm text-destructive">
                    {errors.numberOfTerms.message}
                  </p>
                )}
              </div>
              <div className="space-y-2 flex-1">
                <Label>{t('Schedule type')}</Label>
                <Select
                  value={timeRange}
                  onValueChange={(val) => setValue('timeRange', val)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {timeRangeOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.timeRange && (
                  <p className="text-sm text-destructive">
                    {errors.timeRange.message}
                  </p>
                )}
              </div>
            </div>
          </div>
        </form>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleClose}>
            {t('Cancel')}
          </Button>
          <Button
            onClick={() => formRef.current?.requestSubmit()}
            data-cy="submitContract"
          >
            {t('Create')}
          </Button>
        </>
      )}
    />
  );
}
