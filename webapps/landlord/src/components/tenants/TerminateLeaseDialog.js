import React, { useContext, useMemo, useRef, useState } from 'react';
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
import { QueryKeys } from '../../utils/restcalls';
import ResponsiveDialog from '../ResponsiveDialog';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import { toJS } from 'mobx';
import { useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

const schema = z.object({
  tenantId: z.string().min(1),
  terminationDate: z.string().min(1),
  guarantyPayback: z.coerce.number().min(0).optional()
});

export default function TerminateLeaseDialog({ open, setOpen, tenantList }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const store = useContext(StoreContext);
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

  const selected = store.tenant.selected;

  const initialValues = useMemo(
    () => ({
      tenantId: !tenantList && selected?._id ? selected._id : '',
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

  const handleClose = () => {
    setOpen(false);
    reset();
  };

  const _onSubmit = async (tenantPart) => {
    try {
      setIsLoading(true);
      const tenant =
        tenantList?.find(({ _id }) => _id === tenantPart.tenantId) || selected;
      const updatedTenant = {
        ...toJS(tenant),
        terminationDate: moment(tenantPart.terminationDate).format('DD/MM/YYYY'),
        guarantyPayback: tenantPart.guarantyPayback || 0
      };

      const { status, data } = await store.tenant.update(updatedTenant);
      if (status !== 200) {
        switch (status) {
          case 422:
            return toast.error(t('Tenant name is missing'));
          case 403:
            return toast.error(t('You are not allowed to update the tenant'));
          case 409:
            return toast.error(t('Termination date is out of the contract time frame'));
          default:
            return toast.error(t('Something went wrong'));
        }
      }

      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      store.tenant.setSelected(data);
      handleClose();
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
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
            </div>
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
