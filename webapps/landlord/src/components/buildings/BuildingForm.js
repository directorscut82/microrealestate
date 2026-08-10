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
import { StoreContext } from '../../store';
import { useFieldArray, useForm } from 'react-hook-form';
import { useContext, useMemo } from 'react';
import useTranslation from 'next-translate/useTranslation';
import {
  isValidAFM,
  isValidGreekPostalCode,
  isValidIBAN,
  isValidPhone,
  optionalFormat
} from '../../utils/fieldvalidators';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

// The ΑΤΑΚ *prefix*: the 6-digit building-level part of an 11-digit ΑΤΑΚ. Do NOT
// swap in isValidATAK from utils/fieldvalidators — that checks the full 11 digits
// and would reject every legitimate prefix. 6 is the length e9parser and
// occupantmanager both slice and compare, so any other length means imported
// properties silently never link to this building.
const ATAK_PREFIX_REGEX = /^[0-9]{6}$/;

// Format rules mirror the server (services/api/src/validators.ts) via
// utils/fieldvalidators.js. All of these fields are OPTIONAL — optionalFormat
// treats empty as valid, so nothing here makes a field newly mandatory. That
// matters on the EDIT form: existing buildings already hold an empty zipCode, and
// a bare .refine() would have made them unsavable until refilled.
//
// Built per-building rather than as a module constant so the ΑΤΑΚ-prefix rule can
// grandfather `currentAtakPrefix` — see the atakPrefix field below.
const buildSchema = (currentAtakPrefix) =>
  z.object({
    name: z.string().trim().min(1),
    description: z.string().optional(),
    // The 6-digit rule is NEW, and this input is disabled once the building has
    // units, so an older building holding a malformed prefix would resubmit it
    // unchanged and be blocked from saving anything at all — address, IBAN and
    // manager included — with the offending field greyed out. Accept the stored
    // value as-is and only enforce the format on a value the landlord CHANGED.
    // The server applies the same grandfathering.
    atakPrefix: z
      .string()
      .trim()
      .refine(
        (v) =>
          ATAK_PREFIX_REGEX.test(v) ||
          (!!currentAtakPrefix && v === String(currentAtakPrefix).trim()),
        { message: 'ATAK prefix must be exactly 6 digits' }
      ),
    yearBuilt: z.union([z.string(), z.number()]).optional(),
    totalFloors: z.union([z.string(), z.number()]).optional(),
    hasElevator: z.boolean(),
    hasCentralHeating: z.boolean(),
    heatingType: z.string().optional(),
    address: z.object({
      street1: z.string().optional(),
      street2: z.string().optional(),
      city: z.string().optional(),
      zipCode: z
        .string()
        .optional()
        .refine(optionalFormat(isValidGreekPostalCode), {
          message: 'Postal code must be 5 digits'
        }),
      state: z.string().optional(),
      country: z.string().optional()
    }),
    manager: z
      .object({
        name: z.string().optional(),
        phone: z.string().optional().refine(optionalFormat(isValidPhone), {
          message: 'This is not a valid phone number'
        }),
        email: z.string().optional(),
        taxId: z.string().optional().refine(optionalFormat(isValidAFM), {
          message: 'Invalid AFM checksum'
        }),
        company: z.string().optional()
      })
      .optional(),
    bankInfo: z
      .object({
        name: z.string().optional(),
        iban: z.string().optional().refine(optionalFormat(isValidIBAN), {
          message: 'This is not a valid IBAN'
        })
      })
      .optional(),
    // Shared (κοινόχρηστοι) utility meters. A LIST because a polykatoikia
    // routinely has several (stairwell + lift + pump). Rows the landlord has
    // started but not filled are dropped on submit rather than rejected — see
    // onSubmit — so an empty trailing row never blocks saving the whole form.
    sharedMeters: z
      .array(
        z.object({
          provider: z.string().optional(),
          supplyNumber: z.string().optional(),
          label: z.string().optional()
        })
      )
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
  const store = useContext(StoreContext);

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
      sharedMeters: building?.sharedMeters?.length
        ? building.sharedMeters.map((m) => ({
            provider: m.provider || 'deh',
            supplyNumber: m.supplyNumber || '',
            label: m.label || ''
          }))
        : [],
      notes: building?.notes || ''
    }),
    [building]
  );

  // Keyed on the building's STORED prefix so an existing malformed value stays
  // savable (see buildSchema).
  const schema = useMemo(
    () => buildSchema(building?.atakPrefix),
    [building?.atakPrefix]
  );

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    control,
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
  // useFieldArray, NOT watch+setValue.
  //
  // This form is constructed with the `values` prop (see useForm above), which
  // re-syncs from `initialValues` — and `initialValues` is a useMemo on
  // `building`, which react-query hands back as a NEW OBJECT on every background
  // refetch (the QueryClient is created with no options, so refetchOnWindowFocus
  // is on and staleTime is 0). A hand-rolled array in form state is therefore at
  // risk of being reset mid-edit by nothing more than the operator switching tabs
  // — and `supplyNumber` is a money-routing key, so a silently dropped row means
  // a bill that stops matching. `useFieldArray` owns its own keyed rows and is the
  // idiom already used for repeatable lists here (UnitList.js, ThirdPartiesForm.js);
  // its `key={field.id}` also avoids the index-keyed-input bug where removing row
  // N makes row N+1 display the wrong value.
  const {
    fields: sharedMeterFields,
    append: appendSharedMeter,
    remove: removeSharedMeter
  } = useFieldArray({ control, name: 'sharedMeters' });

  // Drop rows with no supply number before submitting: an empty row the landlord
  // added and left blank is not a meter, and the server requires supplyNumber.
  // Silently pruning beats a validation error on a field they never filled.
  const submit = (data) =>
    onSubmit({
      ...data,
      sharedMeters: (data.sharedMeters || [])
        .filter((m) => String(m?.supplyNumber || '').trim())
        .map((m) => ({
          provider: m.provider || 'deh',
          supplyNumber: String(m.supplyNumber).trim(),
          label: String(m.label || '').trim()
        }))
    });

  return (
    <form onSubmit={handleSubmit(submit)} autoComplete="off">
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
              inputMode="numeric"
              maxLength={6}
            />
            {errors.atakPrefix && (
              <p className="text-sm text-destructive">
                {t(errors.atakPrefix.message)}
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
                {/* §5: this dropdown only renders when Central Heating is ON,
                    so only the CENTRAL types are valid choices — 'Autonomous'
                    and 'None' contradict central heating. The enum keeps all
                    values for data compatibility; only the offered options are
                    gated. */}
                {heatingTypes
                  .filter(
                    (ht) => ht.id === 'central_oil' || ht.id === 'central_gas'
                  )
                  .map((ht) => (
                    <SelectItem key={ht.id} value={ht.id}>
                      {t(ht.labelId)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Shared (κοινόχρηστοι) utility meters.
            The bill importer matches an incoming λογαριασμός on its αριθμός
            παροχής. Before this, that number could only be recorded on a UNIT, so
            a κοινόχρηστο bill matched nothing — and recording it on a unit anyway
            would make the importer bill the building's whole shared supply to that
            single apartment. A building-level entry makes the importer propose a
            κοινόχρηστο expense split by χιλιοστά instead. */}
        <div className="mt-8 space-y-2">
          <Label>{t('Shared meters')}</Label>
          <p className="text-sm text-muted-foreground">
            {t(
              'Supply numbers billed to the whole building. An imported bill matching one of these is proposed as a shared expense.'
            )}
          </p>
          {sharedMeterFields.length > 0 && (
            <div className="space-y-2">
              {sharedMeterFields.map((field, idx) => (
                <div
                  key={field.id}
                  className="sm:flex sm:gap-2 sm:items-end space-y-2 sm:space-y-0"
                >
                  <div className="space-y-1 sm:w-40">
                    <Label
                      htmlFor={`sharedMeters.${idx}.provider`}
                      className="text-sm text-muted-foreground"
                    >
                      {t('Provider')}
                    </Label>
                    <Select
                      value={watch(`sharedMeters.${idx}.provider`) || 'deh'}
                      onValueChange={(val) =>
                        setValue(`sharedMeters.${idx}.provider`, val)
                      }
                    >
                      <SelectTrigger id={`sharedMeters.${idx}.provider`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="deh">{t('DEH')}</SelectItem>
                        <SelectItem value="eydap">{t('EYDAP')}</SelectItem>
                        <SelectItem value="epa">{t('EPA')}</SelectItem>
                        <SelectItem value="other">{t('Other')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1 flex-1">
                    <Label
                      htmlFor={`sharedMeters.${idx}.supplyNumber`}
                      className="text-sm text-muted-foreground"
                    >
                      {t('Supply number')}
                    </Label>
                    <Input
                      id={`sharedMeters.${idx}.supplyNumber`}
                      {...register(`sharedMeters.${idx}.supplyNumber`)}
                      inputMode="numeric"
                    />
                  </div>
                  <div className="space-y-1 flex-1">
                    <Label
                      htmlFor={`sharedMeters.${idx}.label`}
                      className="text-sm text-muted-foreground"
                    >
                      {t('Description')}
                    </Label>
                    <Input
                      id={`sharedMeters.${idx}.label`}
                      {...register(`sharedMeters.${idx}.label`)}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeSharedMeter(idx)}
                    aria-label={t('Remove')}
                  >
                    {t('Remove')}
                  </Button>
                </div>
              ))}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              appendSharedMeter({ provider: 'deh', supplyNumber: '', label: '' })
            }
          >
            {t('Add meter')}
          </Button>
        </div>
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
            <Input
              id="address.zipCode"
              {...register('address.zipCode')}
              inputMode="numeric"
              maxLength={5}
            />
            {errors.address?.zipCode && (
              <p className="text-sm text-destructive">
                {t(errors.address.zipCode.message)}
              </p>
            )}
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
        {/* Pre-fill the manager from the realm's landlord contact (Settings →
            Landlord) — the common case where the landlord manages the
            building themselves. One click instead of retyping. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mb-3"
          onClick={() => {
            const org = store?.organization?.selected;
            const contact = org?.contacts?.[0] || {};
            setValue(
              'manager.name',
              contact.name ||
                (org?.isCompany
                  ? org?.companyInfo?.legalRepresentative
                  : org?.name) ||
                ''
            );
            setValue(
              'manager.company',
              org?.isCompany ? org?.companyInfo?.name || org?.name || '' : ''
            );
            setValue('manager.phone', contact.phone1 || contact.phone2 || '');
            setValue('manager.email', contact.email || '');
            setValue('manager.taxId', org?.companyInfo?.vatNumber || '');
          }}
        >
          {t('Copy my details')}
        </Button>
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
            {errors.manager?.phone && (
              <p className="text-sm text-destructive">
                {t(errors.manager.phone.message)}
              </p>
            )}
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
          {errors.manager?.taxId && (
            <p className="text-sm text-destructive">
              {t(errors.manager.taxId.message)}
            </p>
          )}
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
            {errors.bankInfo?.iban && (
              <p className="text-sm text-destructive">
                {t(errors.bankInfo.iban.message)}
              </p>
            )}
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
