import React, { useCallback, useContext, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { contractEndMoment } from '@microrealestate/commonui/utils/contract';
import moment from 'moment';
import ResponsiveDialog from '../ResponsiveDialog';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import { toJS } from 'mobx';
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
  const store = useContext(StoreContext);
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

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
      try {
        setIsLoading(true);
        let tenant = {
          name: tenantPart.name,
          company: tenantPart.name,
          beginDate: moment().startOf('day').format('DD/MM/YYYY'),
          stepperMode: true
        };
        if (tenantPart.isCopyFrom) {
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
          } = toJS(
            store.tenant.items.find(({ _id }) => tenantPart.copyFrom === _id)
          );

          tenant = { ...originalTenant, ...tenant };

          if (originalTenant.lease) {
            const lease = store.lease.items.find(
              ({ _id }) => _id === originalTenant.lease._id
            );
            const newEndDate = contractEndMoment(
              moment().startOf('day'),
              lease
            );
            tenant.endDate = newEndDate.format('DD/MM/YYYY');
          }
        }

        const { status, data } = await store.tenant.create(tenant);
        if (status !== 200) {
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

        handleClose();
        store.tenant.setSelected(data);
        store.appHistory.setPreviousPath(router.asPath);
        await router.push(
          `/${store.organization.selected.name}/tenants/${data._id}`
        );
      } finally {
        setIsLoading(false);
      }
    },
    [store, handleClose, router, t]
  );

  const tenants = store.tenant.items
    .filter((tenant, index, tenants) => {
      return (
        tenants.findIndex(
          (currentTenant) => currentTenant.name === tenant.name
        ) === index
      );
    })
    .map(({ _id, name }) => ({ id: _id, label: name, value: _id }));

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
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
