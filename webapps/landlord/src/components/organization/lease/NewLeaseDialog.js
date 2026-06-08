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
  name: z.string().min(1),
  numberOfTerms: z.coerce.number().int().min(1),
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
            return toast.error(message || t('Contract name is missing'));
          case 403:
            return toast.error(t('You are not allowed to create a contract'));
          case 409:
            return toast.error(t('The contract already exists'));
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
