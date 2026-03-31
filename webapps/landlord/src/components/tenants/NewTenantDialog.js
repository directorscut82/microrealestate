import React, { useCallback, useMemo, useRef } from 'react';
import {
  createTenant,
  fetchLeases,
  fetchTenants,
  QueryKeys
} from '../../utils/restcalls';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../ui/button';
import { contractEndMoment } from '@microrealestate/commonui/utils/contract';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import moment from 'moment';
import ResponsiveDialog from '../ResponsiveDialog';
import { Switch } from '../ui/switch';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const schema = z
  .object({
    name: z.string().min(1),
    isCopyFrom: z.boolean(),
    copyFrom: z.string()
  })
  .refine(
    (data) => !data.isCopyFrom || data.copyFrom.length > 0,
    { message: 'Required', path: ['copyFrom'] }
  );

export default function NewTenantDialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const queryClient = useQueryClient();
  const formRef = useRef();

  const { data: allTenants = [] } = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: fetchTenants,
    enabled: !!open
  });

  const { data: leases = [] } = useQuery({
    queryKey: [QueryKeys.LEASES],
    queryFn: fetchLeases,
    enabled: !!open
  });

  const mutation = useMutation({
    mutationFn: createTenant,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
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
    defaultValues: { name: '', copyFrom: '', isCopyFrom: false }
  });

  const isCopyFrom = watch('isCopyFrom');

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const _onSubmit = useCallback(
    async (tenantPart) => {
      let tenant = {
        name: tenantPart.name,
        company: tenantPart.name,
        beginDate: moment().startOf('day').format('DD/MM/YYYY'),
        stepperMode: true
      };
      if (tenantPart.isCopyFrom) {
        const source = allTenants.find(({ _id }) => tenantPart.copyFrom === _id);
        if (source) {
          const {
            _id,
            reference,
            name,
            terminated,
            beginDate,
            endDate,
            terminationDate,
            properties,
            discount,
            guaranty,
            ...originalTenant
          } = source;
          tenant = { ...originalTenant, ...tenant };
          if (originalTenant.lease) {
            const lease = leases.find(({ _id }) => _id === originalTenant.lease._id);
            if (lease) {
              const newEndDate = contractEndMoment(moment().startOf('day'), lease);
              tenant.endDate = newEndDate.format('DD/MM/YYYY');
            }
          }
        }
      }

      try {
        const data = await mutation.mutateAsync(tenant);
        handleClose();
        await router.push(
          `/${router.query.organization}/tenants/${data._id}`
        );
      } catch (error) {
        const status = error?.response?.status;
        switch (status) {
          case 422:
            return toast.error(t('Tenant name is missing'));
          case 403:
            return toast.error(t('You are not allowed to add a tenant'));
          case 409:
            return toast.error(t('The tenant already exists'));
          default:
            return toast.error(t('Something went wrong'));
        }
      }
    },
    [allTenants, leases, mutation, handleClose, router, t]
  );

  const tenants = useMemo(
    () =>
      allTenants
        .filter(
          (tenant, index, arr) =>
            arr.findIndex((t) => t.name === tenant.name) === index
        )
        .map(({ _id, name }) => ({ id: _id, label: name, value: _id })),
    [allTenants]
  );

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={mutation.isPending}
      renderHeader={() => t('Add a tenant')}
      renderContent={() => (
        <form
          ref={formRef}
          onSubmit={handleSubmit(_onSubmit)}
          autoComplete="off"
        >
          <div className="pt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('Name')}</Label>
              <Input id="name" {...register('name')} />
              {errors.name && (
                <p className="text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>
            {tenants?.length ? (
              <>
                <div className="flex items-center gap-2">
                  <Switch
                    id="isCopyFrom"
                    checked={isCopyFrom}
                    onCheckedChange={(checked) =>
                      setValue('isCopyFrom', checked)
                    }
                  />
                  <Label htmlFor="isCopyFrom">
                    {t('Copy from an existing tenant')}
                  </Label>
                </div>
                <div className="space-y-2">
                  <Label>{t('Tenant')}</Label>
                  <Select
                    disabled={!isCopyFrom}
                    onValueChange={(val) => setValue('copyFrom', val)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('Select a tenant')} />
                    </SelectTrigger>
                    <SelectContent>
                      {tenants.map((ten) => (
                        <SelectItem key={ten.id} value={ten.value}>
                          {ten.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.copyFrom && (
                    <p className="text-sm text-destructive">
                      {errors.copyFrom.message}
                    </p>
                  )}
                </div>
              </>
            ) : null}
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
            data-cy="submitTenant"
          >
            {t('Add')}
          </Button>
        </>
      )}
    />
  );
}
