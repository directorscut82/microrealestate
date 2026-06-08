import { useCallback, useContext, useMemo, useRef } from 'react';
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
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

// Greek AFM: 9 digits with a modulo-11 checksum. Tier C1 — block
// transposed-digit typos at the dialog level. AADE PDF imports always
// carry a checksum-valid AFM.
const AFM_REGEX = /^[0-9]{9}$/;
function isValidAFM(value) {
  if (typeof value !== 'string' || !AFM_REGEX.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += parseInt(value[i], 10) * Math.pow(2, 8 - i);
  }
  return ((sum % 11) % 10) === parseInt(value[8], 10);
}

const schema = z
  .object({
    firstName: z.string().trim().min(1).max(120),
    lastName: z.string().trim().min(1).max(120),
    taxId: z
      .string()
      .trim()
      .regex(AFM_REGEX, 'AFM must be 9 digits')
      .refine(isValidAFM, { message: 'Invalid AFM checksum' }),
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
      // A new tenant adds rows to dashboard + rent ledger once a property
      // is assigned downstream. Invalidate RENTS/DASHBOARD now so initial
      // landings on those screens see the new record.
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    }
  });

  const {
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      firstName: '',
      lastName: '',
      taxId: '',
      copyFrom: '',
      isCopyFrom: false
    }
  });

  const isCopyFrom = watch('isCopyFrom');

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const _onSubmit = useCallback(
    async (tenantPart) => {
      const fullName = `${tenantPart.firstName} ${tenantPart.lastName}`.trim();
      let tenant = {
        name: fullName,
        firstName: tenantPart.firstName,
        lastName: tenantPart.lastName,
        taxId: tenantPart.taxId,
        manager: fullName,
        isCompany: false,
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
            firstName: srcFirstName,
            lastName: srcLastName,
            taxId: srcTaxId,
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
        const orgName = store.organization.selected?.name || router.query.organization;
        await router.push(
          `/${orgName}/tenants/${data._id}`,
          undefined,
          { locale: store.organization.selected?.locale }
        );
      } catch (error) {
        const status = error?.response?.status;
        const apiMessage = error?.response?.data?.message;
        switch (status) {
          case 422:
            return toast.error(apiMessage || t('Tenant name is missing'));
          case 403:
            return toast.error(t('You are not allowed to add a tenant'));
          case 409:
            return toast.error(apiMessage || t('The tenant already exists'));
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
            <div className="sm:flex sm:gap-2">
              <div className="space-y-2 flex-1">
                <Label htmlFor="firstName">{t('First name')}</Label>
                <Input
                  id="firstName"
                  value={watch('firstName')}
                  onChange={(e) => setValue('firstName', e.target.value)}
                  name="firstName"
                />
                {errors.firstName && (
                  <p className="text-sm text-destructive">{errors.firstName.message}</p>
                )}
              </div>
              <div className="space-y-2 flex-1">
                <Label htmlFor="lastName">{t('Last name')}</Label>
                <Input
                  id="lastName"
                  value={watch('lastName')}
                  onChange={(e) => setValue('lastName', e.target.value)}
                  name="lastName"
                />
                {errors.lastName && (
                  <p className="text-sm text-destructive">{errors.lastName.message}</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="taxId">{t('Tax ID')}</Label>
              <Input
                id="taxId"
                value={watch('taxId')}
                onChange={(e) => setValue('taxId', e.target.value)}
                name="taxId"
                inputMode="numeric"
                maxLength={9}
              />
              {errors.taxId && (
                <p className="text-sm text-destructive">{errors.taxId.message}</p>
              )}
            </div>
            <div className={tenants?.length ? '' : 'hidden'}>
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
                <div className="space-y-2 mt-4">
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
            data-cy="submitTenant"
          >
            {t('Add')}
          </Button>
        </>
      )}
    />
  );
}
