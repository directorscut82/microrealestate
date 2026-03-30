import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import PropertyIcon from './PropertyIcon';
import types from './types';
import useTranslation from 'next-translate/useTranslation';

const schema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  surface: z.union([z.string(), z.number()]).optional(),
  phone: z.string().optional(),
  digicode: z.string().optional(),
  address: z.object({
    street1: z.string().optional(),
    street2: z.string().optional(),
    city: z.string().optional(),
    zipCode: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional()
  }),
  rent: z.coerce.number().min(0)
});

function Section({ label, children }) {
  return (
    <div className="pb-10">
      <div className="text-xl">{label}</div>
      <Separator className="mt-1 mb-2" />
      {children}
    </div>
  );
}

const PropertyForm = ({ property, onSubmit }) => {
  const { t } = useTranslation('common');

  const initialValues = useMemo(
    () => ({
      type: property?.type || '',
      name: property?.name || '',
      description: property?.description || '',
      surface: property?.surface || '',
      phone: property?.phone || '',
      digicode: property?.digicode || '',
      address: property?.address || {
        street1: '',
        street2: '',
        city: '',
        zipCode: '',
        state: '',
        country: ''
      },
      rent: property?.price || ''
    }),
    [property]
  );

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initialValues
  });

  const typeValue = watch('type');

  const propertyTypes = useMemo(
    () =>
      types.map((type) => ({
        id: type.id,
        value: type.id,
        label: t(type.labelId),
        type: type.id
      })),
    [t]
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} autoComplete="off">
      <Section label={t('Property information')}>
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1">
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
                      <PropertyIcon type={pt.type} />
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
          <div className="space-y-2 flex-1">
            <Label htmlFor="name">{t('Name')}</Label>
            <Input id="name" {...register('name')} />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
          </div>
        </div>
        <div className="space-y-2 mt-2">
          <Label htmlFor="description">{t('Description')}</Label>
          <Input id="description" {...register('description')} />
        </div>
        {['store', 'building', 'apartment', 'room', 'office', 'garage'].includes(
          typeValue
        ) && (
          <div className="sm:flex sm:gap-2 mt-2">
            <div className="space-y-2 flex-1">
              <Label htmlFor="surface">{t('Surface')}</Label>
              <Input id="surface" type="number" {...register('surface')} />
            </div>
            <div className="space-y-2 flex-1">
              <Label htmlFor="phone">{t('Phone')}</Label>
              <Input id="phone" {...register('phone')} />
            </div>
            <div className="space-y-2 flex-1">
              <Label htmlFor="digicode">{t('Digicode')}</Label>
              <Input id="digicode" {...register('digicode')} />
            </div>
          </div>
        )}
      </Section>
      <Section label={t('Address')}>
        <div className="space-y-2">
          <Label htmlFor="address.street1">{t('Street 1')}</Label>
          <Input id="address.street1" {...register('address.street1')} />
        </div>
        <div className="space-y-2 mt-2">
          <Label htmlFor="address.street2">{t('Street 2')}</Label>
          <Input id="address.street2" {...register('address.street2')} />
        </div>
        <div className="sm:flex sm:gap-2 mt-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="address.zipCode">{t('Zip code')}</Label>
            <Input id="address.zipCode" {...register('address.zipCode')} />
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="address.city">{t('City')}</Label>
            <Input id="address.city" {...register('address.city')} />
          </div>
        </div>
        <div className="sm:flex sm:gap-2 mt-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="address.state">{t('State')}</Label>
            <Input id="address.state" {...register('address.state')} />
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="address.country">{t('Country')}</Label>
            <Input id="address.country" {...register('address.country')} />
          </div>
        </div>
      </Section>
      <Section label={t('Rent')}>
        <div className="space-y-2">
          <Label htmlFor="rent">{t('Rent excluding tax and expenses')}</Label>
          <Input id="rent" type="number" {...register('rent')} />
          {errors.rent && (
            <p className="text-sm text-destructive">{errors.rent.message}</p>
          )}
        </div>
      </Section>
      <Button type="submit" disabled={isSubmitting} data-cy="submit">
        {!isSubmitting ? t('Save') : t('Saving')}
      </Button>
    </form>
  );
};

export default PropertyForm;
