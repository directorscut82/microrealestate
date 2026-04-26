import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { useForm } from 'react-hook-form';
import { useMemo } from 'react';
import useTranslation from 'next-translate/useTranslation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const schema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  atakPrefix: z.string().min(1),
  yearBuilt: z.union([z.string(), z.number()]).optional(),
  totalFloors: z.union([z.string(), z.number()]).optional(),
  hasElevator: z.boolean(),
  hasCentralHeating: z.boolean(),
  heatingType: z.string().optional(),
  address: z.object({
    street1: z.string().optional(),
    street2: z.string().optional(),
    city: z.string().optional(),
    zipCode: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional()
  }),
  manager: z
    .object({
      name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      taxId: z.string().optional(),
      company: z.string().optional()
    })
    .optional(),
  bankInfo: z
    .object({
      name: z.string().optional(),
      iban: z.string().optional()
    })
    .optional(),
  notes: z.string().optional()
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

const heatingTypes = [
  { id: 'central_oil', labelId: 'Central Oil' },
  { id: 'central_gas', labelId: 'Central Gas' },
  { id: 'autonomous', labelId: 'Autonomous' },
  { id: 'none', labelId: 'None' }
];

export default function BuildingForm({ building, onSubmit }) {
  const { t } = useTranslation('common');

  const initialValues = useMemo(
    () => ({
      name: building?.name || '',
      description: building?.description || '',
      atakPrefix: building?.atakPrefix || '',
      yearBuilt: building?.yearBuilt || '',
      totalFloors: building?.totalFloors || '',
      hasElevator: building?.hasElevator || false,
      hasCentralHeating: building?.hasCentralHeating || false,
      heatingType: building?.heatingType || '',
      address: building?.address || {
        street1: '',
        street2: '',
        city: '',
        zipCode: '',
        state: '',
        country: ''
      },
      manager: building?.manager || {
        name: '',
        phone: '',
        email: '',
        taxId: '',
        company: ''
      },
      bankInfo: building?.bankInfo || {
        name: '',
        iban: ''
      },
      notes: building?.notes || ''
    }),
    [building]
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

  const hasElevator = watch('hasElevator');
  const hasCentralHeating = watch('hasCentralHeating');
  const heatingType = watch('heatingType');
  const hasUnits = building?.units?.length > 0;

  return (
    <form onSubmit={handleSubmit(onSubmit)} autoComplete="off">
      <Section label={t('Building information')}>
        {hasUnits && (
          <div className="text-sm text-warning mb-4">
            {t('ATAK prefix cannot be changed because this building has units')}
          </div>
        )}
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="name">{t('Name')}</Label>
            <Input id="name" {...register('name')} />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="atakPrefix">{t('ATAK Prefix')}</Label>
            <Input
              id="atakPrefix"
              {...register('atakPrefix')}
              disabled={hasUnits}
            />
            {errors.atakPrefix && (
              <p className="text-sm text-destructive">
                {errors.atakPrefix.message}
              </p>
            )}
          </div>
        </div>
        <div className="space-y-2 mt-2">
          <Label htmlFor="description">{t('Description')}</Label>
          <Input id="description" {...register('description')} />
        </div>
        <div className="sm:flex sm:gap-2 mt-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="yearBuilt">{t('Year Built')}</Label>
            <Input id="yearBuilt" type="number" {...register('yearBuilt')} />
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="totalFloors">{t('Total Floors')}</Label>
            <Input
              id="totalFloors"
              type="number"
              {...register('totalFloors')}
            />
          </div>
        </div>
        <div className="flex flex-col gap-4 mt-4">
          <div className="flex items-center gap-2">
            <Switch
              id="hasElevator"
              checked={hasElevator}
              onCheckedChange={(checked) => setValue('hasElevator', checked)}
            />
            <Label htmlFor="hasElevator">{t('Has Elevator')}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="hasCentralHeating"
              checked={hasCentralHeating}
              onCheckedChange={(checked) =>
                setValue('hasCentralHeating', checked)
              }
            />
            <Label htmlFor="hasCentralHeating">
              {t('Has Central Heating')}
            </Label>
          </div>
        </div>
        {hasCentralHeating && (
          <div className="space-y-2 mt-4">
            <Label>{t('Heating Type')}</Label>
            <Select
              value={heatingType}
              onValueChange={(val) => setValue('heatingType', val)}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('Select heating type')} />
              </SelectTrigger>
              <SelectContent>
                {heatingTypes.map((ht) => (
                  <SelectItem key={ht.id} value={ht.id}>
                    {t(ht.labelId)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

      <Section label={t('Building Manager')}>
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="manager.name">{t('Name')}</Label>
            <Input id="manager.name" {...register('manager.name')} />
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="manager.company">{t('Company')}</Label>
            <Input id="manager.company" {...register('manager.company')} />
          </div>
        </div>
        <div className="sm:flex sm:gap-2 mt-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="manager.phone">{t('Phone')}</Label>
            <Input id="manager.phone" {...register('manager.phone')} />
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="manager.email">{t('Email')}</Label>
            <Input
              id="manager.email"
              type="email"
              {...register('manager.email')}
            />
          </div>
        </div>
        <div className="space-y-2 mt-2">
          <Label htmlFor="manager.taxId">{t('Tax ID')}</Label>
          <Input id="manager.taxId" {...register('manager.taxId')} />
        </div>
      </Section>

      <Section label={t('Bank Information')}>
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="bankInfo.name">{t('Bank Name')}</Label>
            <Input id="bankInfo.name" {...register('bankInfo.name')} />
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="bankInfo.iban">{t('IBAN')}</Label>
            <Input id="bankInfo.iban" {...register('bankInfo.iban')} />
          </div>
        </div>
      </Section>

      <Section label={t('Notes')}>
        <div className="space-y-2">
          <Label htmlFor="notes">{t('Notes')}</Label>
          <Textarea id="notes" rows={4} {...register('notes')} />
        </div>
      </Section>

      <Button type="submit" disabled={isSubmitting} data-cy="submit">
        {!isSubmitting ? t('Save') : t('Saving')}
      </Button>
    </form>
  );
}
