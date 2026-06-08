import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../ui/button';
import { createProperty, fetchProperties, QueryKeys } from '../../utils/restcalls';
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
import PropertyIcon from './PropertyIcon';
import propertyTypeDefs from './types';
import ResponsiveDialog from '../ResponsiveDialog';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

// Mirror PROPERTY_TYPES in services/api/src/validators.ts. The server rejects
// any other value with 422 so we hard-gate the picker to this exact list.
const PROPERTY_TYPES_ENUM = propertyTypeDefs.map((t) => t.id);

// Greek postal code: 5 digits.
const POSTAL_REGEX = /^[0-9]{5}$/;

const schema = z
  .object({
    name: z.string().trim().min(1),
    type: z.enum(PROPERTY_TYPES_ENUM),
    street1: z.string().trim().min(1),
    city: z.string().trim().min(1),
    zipCode: z
      .string()
      .trim()
      .regex(POSTAL_REGEX, 'Postal code must be 5 digits'),
    isCopyFrom: z.boolean(),
    copyFrom: z.string()
  })
  .refine(
    (data) => !data.isCopyFrom || data.copyFrom.length > 0,
    { message: 'Required', path: ['copyFrom'] }
  );

export default function NewPropertyDialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

  const { data: propertyItems = [] } = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties
  });

  const createMutation = useMutation({
    mutationFn: createProperty,
    onSuccess: () => {
      // New properties become available for tenant assignment and feed into
      // dashboard/rent computation as soon as a tenant picks them up. Keep
      // the rent stack consistent per the property-mutation rule.
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PROPERTIES] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
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
      name: '',
      type: 'apartment',
      street1: '',
      city: '',
      zipCode: '',
      copyFrom: '',
      isCopyFrom: false
    }
  });

  const isCopyFrom = watch('isCopyFrom');
  const typeValue = watch('type');

  const propertyTypes = useMemo(
    () =>
      propertyTypeDefs.map((pt) => ({
        id: pt.id,
        value: pt.id,
        label: t(pt.labelId)
      })),
    [t]
  );

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const _onSubmit = useCallback(
    async (propertyPart) => {
      try {
        setIsLoading(true);
        const { street1, city, zipCode, ...rest } = propertyPart;
        let property = {
          ...rest,
          address: { street1, city, zipCode }
        };

        if (propertyPart.isCopyFrom) {
          const { _id, ...originalProperty } =
            propertyItems.find(({ _id }) => propertyPart.copyFrom === _id) || {};
          // Address typed in dialog wins; `address` from copy source is
          // intentionally overridden so the new property gets the address
          // the user just typed.
          property = { ...originalProperty, ...property };
        }

        const data = await createMutation.mutateAsync(property);
        handleClose();
        const orgName = store.organization.selected?.name || router.query.organization;
        await router.push(
          `/${orgName}/properties/${data._id}`,
          undefined,
          { locale: store.organization.selected?.locale }
        );
      } catch (error) {
        const status = error?.response?.status;
        const message = error?.response?.data?.message;
        switch (status) {
          case 422:
            return toast.error(message || t('Property name is missing'));
          case 403:
            return toast.error(t('You are not allowed to add a property'));
          case 409:
            return toast.error(t('The property already exists'));
          default:
            return toast.error(message || t('Something went wrong'));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [createMutation, propertyItems, handleClose, router, t]
  );

  const properties = propertyItems.map(({ _id, name, type }) => ({
    id: _id,
    label: name,
    value: _id,
    type
  }));

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Add a property')}
      renderContent={() => (
        <form
          ref={formRef}
          onSubmit={handleSubmit(_onSubmit)}
          autoComplete="off"
        >
          <div className="pt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('Name')}</Label>
              <Input id="name" value={watch('name')} onChange={(e) => setValue('name', e.target.value)} name="name" />
              {errors.name && (
                <p className="text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('Property Type')}</Label>
              <Select
                value={typeValue}
                onValueChange={(val) => setValue('type', val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select a type')} />
                </SelectTrigger>
                <SelectContent>
                  {propertyTypes.map((pt) => (
                    <SelectItem key={pt.id} value={pt.value}>
                      <div className="flex items-center gap-2">
                        <PropertyIcon type={pt.id} />
                        {pt.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.type && (
                <p className="text-sm text-destructive">{errors.type.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="street1">{t('Street 1')}</Label>
              <Input
                id="street1"
                value={watch('street1')}
                onChange={(e) => setValue('street1', e.target.value)}
                name="street1"
              />
              {errors.street1 && (
                <p className="text-sm text-destructive">{errors.street1.message}</p>
              )}
            </div>
            <div className="sm:flex sm:gap-2">
              <div className="space-y-2 flex-1">
                <Label htmlFor="zipCode">{t('Zip code')}</Label>
                <Input
                  id="zipCode"
                  value={watch('zipCode')}
                  onChange={(e) => setValue('zipCode', e.target.value)}
                  name="zipCode"
                  inputMode="numeric"
                  maxLength={5}
                />
                {errors.zipCode && (
                  <p className="text-sm text-destructive">{errors.zipCode.message}</p>
                )}
              </div>
              <div className="space-y-2 flex-1">
                <Label htmlFor="city">{t('City')}</Label>
                <Input
                  id="city"
                  value={watch('city')}
                  onChange={(e) => setValue('city', e.target.value)}
                  name="city"
                />
                {errors.city && (
                  <p className="text-sm text-destructive">{errors.city.message}</p>
                )}
              </div>
            </div>
            <div className={properties?.length ? '' : 'hidden'}>
              <div className="flex items-center gap-2">
                <Switch
                    id="isCopyFrom"
                    checked={isCopyFrom}
                    onCheckedChange={(checked) =>
                      setValue('isCopyFrom', checked)
                    }
                  />
                  <Label htmlFor="isCopyFrom">
                    {t('Copy from an existing property')}
                  </Label>
                </div>
                <div className="space-y-2 mt-4">
                  <Label>{t('Property')}</Label>
                  <Select
                    disabled={!isCopyFrom}
                    onValueChange={(val) => setValue('copyFrom', val)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('Select a property')} />
                    </SelectTrigger>
                    <SelectContent>
                      {properties.map((p) => (
                        <SelectItem key={p.id} value={p.value}>
                          <div className="flex items-center gap-2">
                            <PropertyIcon type={p.type} />
                            {p.label}
                          </div>
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
            data-cy="submitProperty"
          >
            {t('Add')}
          </Button>
        </>
      )}
    />
  );
}
