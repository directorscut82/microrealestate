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
  landSurface: z.union([z.string(), z.number()]).optional(),
  phone: z.string().optional(),
  digicode: z.string().optional(),
  atakNumber: z.string().optional(),
  dehNumber: z.string().optional(),
  energyClass: z.string().optional(),
  energyCertNumber: z.string().optional(),
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
    <section className="pb-12">
      <div className="text-label uppercase tracking-wide text-ink-muted mb-2">
        {label}
      </div>
      <Separator className="mb-5" />
      <div className="space-y-4">{children}</div>
    </section>
  );
}

// Two-column field row on md+ viewports. Greek labels need more room
// than English so we never go to 3- or 4-col grids; long forms simply
// scroll instead.
function Row({ children }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>;
}

function Field({ children }) {
  return <div className="space-y-1.5">{children}</div>;
}

const PropertyForm = ({ property, onSubmit }) => {
  const { t } = useTranslation('common');

  const initialValues = useMemo(
    () => ({
      type: property?.type || '',
      name: property?.name || '',
      description: property?.description || '',
      surface: property?.surface || '',
      landSurface: property?.landSurface || '',
      phone: property?.phone || '',
      digicode: property?.digicode || '',
      atakNumber: property?.atakNumber || '',
      dehNumber: property?.dehNumber || '',
      energyClass: property?.energyCertificate?.energyClass || '',
      energyCertNumber: property?.energyCertificate?.number || '',
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
    defaultValues: initialValues,
    values: initialValues
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
    <form onSubmit={handleSubmit((data) => {
      const { energyClass, energyCertNumber, atakNumber, dehNumber, ...rest } = data;
      onSubmit({
        ...rest,
        atakNumber,
        dehNumber,
        energyCertificate: energyClass || energyCertNumber
          ? {
              ...(property?.energyCertificate || {}),
              energyClass: energyClass || '',
              number: energyCertNumber || ''
            }
          : undefined
      });
    })} autoComplete="off">
      <Section label={t('Property information')}>
        <Row>
          <Field>
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
              <p className="text-label text-oxide">{errors.type.message}</p>
            )}
          </Field>
          <Field>
            <Label htmlFor="name">{t('Name')}</Label>
            <Input id="name" {...register('name')} />
            {errors.name && (
              <p className="text-label text-oxide">{errors.name.message}</p>
            )}
          </Field>
        </Row>
        <Field>
          <Label htmlFor="description">{t('Description')}</Label>
          <Input id="description" {...register('description')} />
        </Field>
        {/* Surface in m² applies to almost every property type — apartments,
            offices, stores, garages and parking spots all have a measurable
            footprint. Only mailboxes don't. Phone/digicode are physical-access
            fields that don't apply to parking or mailboxes. */}
        {typeValue !== 'letterbox' && (
          <Row>
            <Field>
              <Label htmlFor="surface">{t('Surface')}</Label>
              <Input id="surface" type="number" {...register('surface')} />
            </Field>
            <Field>
              <Label htmlFor="landSurface">{t('Land Surface')}</Label>
              <Input id="landSurface" type="number" {...register('landSurface')} />
            </Field>
          </Row>
        )}
        {['store', 'building', 'apartment', 'room', 'office', 'garage'].includes(
          typeValue
        ) && (
          <Row>
            <Field>
              <Label htmlFor="phone">{t('Phone')}</Label>
              <Input id="phone" {...register('phone')} />
            </Field>
            <Field>
              <Label htmlFor="digicode">{t('Digicode')}</Label>
              <Input id="digicode" {...register('digicode')} />
            </Field>
          </Row>
        )}
        <Row>
          <Field>
            <Label htmlFor="atakNumber">{t('ATAK Number')}</Label>
            <Input id="atakNumber" {...register('atakNumber')} />
          </Field>
          <Field>
            <Label htmlFor="dehNumber">{t('DEH Number')}</Label>
            <Input id="dehNumber" {...register('dehNumber')} />
          </Field>
        </Row>
        <Row>
          <Field>
            <Label htmlFor="energyClass">{t('Energy Class')}</Label>
            <Input id="energyClass" {...register('energyClass')} />
          </Field>
          <Field>
            <Label htmlFor="energyCertNumber">{t('Energy Certificate')}</Label>
            <Input id="energyCertNumber" {...register('energyCertNumber')} />
          </Field>
        </Row>
      </Section>
      <Section label={t('Address')}>
        <Field>
          <Label htmlFor="address.street1">{t('Street 1')}</Label>
          <Input id="address.street1" {...register('address.street1')} />
        </Field>
        <Field>
          <Label htmlFor="address.street2">{t('Street 2')}</Label>
          <Input id="address.street2" {...register('address.street2')} />
        </Field>
        <Row>
          <Field>
            <Label htmlFor="address.zipCode">{t('Zip code')}</Label>
            <Input id="address.zipCode" {...register('address.zipCode')} />
          </Field>
          <Field>
            <Label htmlFor="address.city">{t('City')}</Label>
            <Input id="address.city" {...register('address.city')} />
          </Field>
        </Row>
        <Row>
          <Field>
            <Label htmlFor="address.state">{t('State')}</Label>
            <Input id="address.state" {...register('address.state')} />
          </Field>
          <Field>
            <Label htmlFor="address.country">{t('Country')}</Label>
            <Input id="address.country" {...register('address.country')} />
          </Field>
        </Row>
      </Section>
      <Section label={t('Rent')}>
        <Field>
          <Label htmlFor="rent">{t('Rent excluding tax and expenses')}</Label>
          <Input id="rent" type="number" {...register('rent')} />
          {errors.rent && (
            <p className="text-label text-oxide">{errors.rent.message}</p>
          )}
        </Field>
      </Section>
      <div className="flex justify-end">
        <Button type="submit" disabled={isSubmitting} data-cy="submit">
          {!isSubmitting ? t('Save') : t('Saving')}
        </Button>
      </div>
    </form>
  );
};

export default PropertyForm;
