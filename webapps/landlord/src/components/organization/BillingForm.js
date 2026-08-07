import { mergeOrganization, updateStoreOrganization } from './utils';
import { QueryKeys, updateOrganization } from '../../utils/restcalls';
import { useCallback, useContext, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  isValidGreekPostalCode,
  isValidIBAN,
  isValidPhone,
  optionalFormat
} from '../../utils/fieldvalidators';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

function Section({ label, children }) {
  return (
    <div className="pb-10">
      {label && (
        <>
          <div className="text-xl">{label}</div>
          <Separator className="mt-1 mb-2" />
        </>
      )}
      {children}
    </div>
  );
}

export default function BillingForm({ organization }) {
  const store = useContext(StoreContext);
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const { mutateAsync, isError } = useMutation({
    mutationFn: updateOrganization,
    onSuccess: (updatedOrganization) => {
      updateStoreOrganization(store, updatedOrganization);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ORGANIZATIONS] });
    }
  });

  if (isError) {
    toast.error(t('Error updating organization'));
  }

  const isCompany = organization.isCompany;

  const schema = useMemo(
    () =>
      // Every string is .trim()'d before .min(1): without it a single space
      // satisfied "required" and the field persisted as effectively blank while
      // the form reported success — the PDF letterhead then rendered an empty
      // contact block. And the three FORMAT fields are checked against the same
      // rules the server owns (see utils/fieldvalidators.js): a garbage IBAN is
      // the pay-to account printed on every receipt, so the tenant would pay
      // into nothing.
      z.object({
        vatNumber: isCompany
          ? z.string().trim().min(1)
          : z.string().trim().optional(),
        bankName: isCompany
          ? z.string().trim().min(1)
          : z.string().trim().optional(),
        iban: (isCompany
          ? z.string().trim().min(1)
          : z.string().trim().optional()
        ).refine(optionalFormat(isValidIBAN), {
          message: 'This is not a valid IBAN'
        }),
        contact: z.string().trim().min(1),
        email: z.string().trim().email().min(1),
        phone1: z
          .string()
          .trim()
          .min(1)
          .refine(optionalFormat(isValidPhone), {
            message: 'This is not a valid phone number'
          }),
        phone2: z
          .string()
          .trim()
          .optional()
          .refine(optionalFormat(isValidPhone), {
            message: 'This is not a valid phone number'
          }),
        address: z.object({
          street1: z.string().trim().min(1),
          street2: z.string().trim().optional(),
          city: z.string().trim().min(1),
          zipCode: z
            .string()
            .trim()
            .min(1)
            .refine(optionalFormat(isValidGreekPostalCode), {
              message: 'Postal code must be 5 digits'
            }),
          state: z.string().trim().optional(),
          country: z.string().trim().min(1)
        })
      }),
    [isCompany]
  );

  const initialValues = useMemo(
    () => ({
      vatNumber: organization.companyInfo?.vatNumber || '',
      bankName: organization.bankInfo?.name || '',
      iban: organization.bankInfo?.iban || '',
      contact: organization.contacts?.[0]?.name || '',
      email: organization.contacts?.[0]?.email || '',
      phone1: organization.contacts?.[0]?.phone1 || '',
      phone2: organization.contacts?.[0]?.phone2 || '',
      address: organization.addresses?.[0] || {
        street1: '',
        street2: '',
        city: '',
        zipCode: '',
        state: '',
        country: ''
      }
    }),
    [organization]
  );

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
    values: initialValues
  });

  const onSubmit = useCallback(
    async (billing) => {
      const updatedOrganization = mergeOrganization(organization, {
        companyInfo: {
          ...organization.companyInfo,
          vatNumber: billing.vatNumber
        },
        bankInfo: { name: billing.bankName, iban: billing.iban },
        contacts: [
          {
            name: billing.contact,
            email: billing.email,
            phone1: billing.phone1,
            phone2: billing.phone2
          }
        ],
        addresses: [billing.address]
      });
      await mutateAsync(updatedOrganization);
    },
    [mutateAsync, organization]
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} autoComplete="off">
      <Section>
        {isCompany && (
          <div className="space-y-2 mb-2">
            <Label htmlFor="vatNumber">{t('VAT number')}</Label>
            <Input id="vatNumber" {...register('vatNumber')} />
            {errors.vatNumber && <p className="text-sm text-destructive">{errors.vatNumber.message}</p>}
          </div>
        )}
        <div className="space-y-2 mb-2">
          <Label htmlFor="bankName">{t('Bank name')}</Label>
          <Input id="bankName" {...register('bankName')} />
          {errors.bankName && <p className="text-sm text-destructive">{errors.bankName.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="iban">{t('IBAN')}</Label>
          <Input id="iban" {...register('iban')} />
          {errors.iban && <p className="text-sm text-destructive">{errors.iban.message}</p>}
        </div>
      </Section>
      <Section label={t('Contact')}>
        <div className="space-y-2 mb-2">
          <Label htmlFor="contact">{t('Contact')}</Label>
          <Input id="contact" {...register('contact')} />
          {errors.contact && <p className="text-sm text-destructive">{errors.contact.message}</p>}
        </div>
        <div className="space-y-2 mb-2">
          <Label htmlFor="email">{t('Email')}</Label>
          <Input id="email" {...register('email')} />
          {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
        </div>
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="phone1">{t('Phone 1')}</Label>
            <Input id="phone1" {...register('phone1')} />
            {errors.phone1 && <p className="text-sm text-destructive">{errors.phone1.message}</p>}
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="phone2">{t('Phone 2')}</Label>
            <Input id="phone2" {...register('phone2')} />
          </div>
        </div>
      </Section>
      <Section label={t('Address')}>
        <div className="space-y-2 mb-2">
          <Label htmlFor="address.street1">{t('Street 1')}</Label>
          <Input id="address.street1" {...register('address.street1')} />
          {errors.address?.street1 && <p className="text-sm text-destructive">{errors.address.street1.message}</p>}
        </div>
        <div className="space-y-2 mb-2">
          <Label htmlFor="address.street2">{t('Street 2')}</Label>
          <Input id="address.street2" {...register('address.street2')} />
        </div>
        <div className="sm:flex sm:gap-2 mb-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="address.zipCode">{t('Zip code')}</Label>
            <Input id="address.zipCode" {...register('address.zipCode')} />
            {errors.address?.zipCode && <p className="text-sm text-destructive">{errors.address.zipCode.message}</p>}
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="address.city">{t('City')}</Label>
            <Input id="address.city" {...register('address.city')} />
            {errors.address?.city && <p className="text-sm text-destructive">{errors.address.city.message}</p>}
          </div>
        </div>
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="address.state">{t('State')}</Label>
            <Input id="address.state" {...register('address.state')} />
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="address.country">{t('Country')}</Label>
            <Input id="address.country" {...register('address.country')} />
            {errors.address?.country && <p className="text-sm text-destructive">{errors.address.country.message}</p>}
          </div>
        </div>
      </Section>
      <Button type="submit" disabled={isSubmitting} data-cy="submit">
        {!isSubmitting ? t('Save') : t('Saving')}
      </Button>
    </form>
  );
}
