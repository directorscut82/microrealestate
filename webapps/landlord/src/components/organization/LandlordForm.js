import {
  createOrganization,
  QueryKeys,
  updateOrganization
} from '../../utils/restcalls';
import { mergeOrganization, updateStoreOrganization } from './utils';
import { useCallback, useContext, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import cc from 'currency-codes';
import config from '../../config';
import getSymbolFromCurrency from 'currency-symbol-map';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const baseSchema = z.object({
  name: z.string().min(1),
  locale: z.string().min(1),
  currency: z.string().min(1),
  isCompany: z.string().min(1),
  legalRepresentative: z.string().optional(),
  legalStructure: z.string().optional(),
  company: z.string().optional(),
  ein: z.string().optional(),
  dos: z.string().optional(),
  capital: z.union([z.string(), z.coerce.number()]).optional()
});

const schema = baseSchema.refine(
  (data) => {
    if (data.isCompany === 'true') {
      return (
        data.legalStructure?.length > 0 &&
        data.company?.length > 0 &&
        data.ein?.length > 0 &&
        data.capital !== '' && data.capital !== undefined && Number(data.capital) > 0
      );
    }
    return true;
  },
  { message: 'Required', path: ['company'] }
);

const currencies = [
  { id: 'none', label: '', value: '' },
  ...cc.data
    .reduce((acc, { code, currency }) => {
      const symbol = getSymbolFromCurrency(code);
      if (symbol) {
        acc.push({ code, currency, symbol });
      }
      return acc;
    }, [])
    .sort((c1, c2) => c1.currency.localeCompare(c2.currency))
    .map(({ code, currency, symbol }) => ({
      id: code,
      label: `${currency} (${symbol})`,
      value: code
    }))
];

const languages = [
  { id: 'none', label: '', value: '' },
  { id: 'pt-BR', label: 'Brasileiro', value: 'pt-BR' },
  { id: 'en', label: 'English', value: 'en' },
  { id: 'fr-FR', label: 'Français (France)', value: 'fr-FR' },
  { id: 'de-DE', label: 'Deutsch (Deutschland)', value: 'de-DE' },
  { id: 'el', label: 'Ελληνικά', value: 'el' },
  { id: 'es-CO', label: 'Español (Colombia)', value: 'es-CO' }
];

export default function LandlordForm({ organization, firstAccess }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const queryClient = useQueryClient();
  const mutateCreateOrganization = useMutation({
    mutationFn: createOrganization,
    onSuccess: (createdOrgpanization) => {
      updateStoreOrganization(store, createdOrgpanization);
    }
  });
  const mutateUpdateOrganization = useMutation({
    mutationFn: updateOrganization,
    onSuccess: (updatedOrganization) => {
      updateStoreOrganization(store, updatedOrganization);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ORGANIZATIONS] });
    }
  });

  if (mutateCreateOrganization.isError) {
    toast.error(t('Error creating organization'));
  }
  if (mutateUpdateOrganization.isError) {
    toast.error(t('Error updating organization'));
  }

  const initialValues = useMemo(
    () => ({
      name: organization?.name || '',
      locale: organization?.locale || '',
      currency: organization?.currency || '',
      isCompany: organization?.isCompany ? 'true' : 'false',
      legalRepresentative: organization?.companyInfo?.legalRepresentative || '',
      legalStructure: organization?.companyInfo?.legalStructure || '',
      company: organization?.companyInfo?.name || '',
      ein: organization?.companyInfo?.ein || '',
      dos: organization?.companyInfo?.dos || '',
      capital: organization?.companyInfo?.capital || ''
    }),
    [organization]
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

  const isCompany = watch('isCompany');
  const locale = watch('locale');
  const currency = watch('currency');

  const onSubmit = useCallback(
    async (landlord) => {
      if (firstAccess) {
        const createdOrgpanization = {
          ...landlord,
          members: [
            {
              name: `${store.user.firstName} ${store.user.lastName}`,
              email: store.user.email,
              role: 'administrator',
              registered: true
            }
          ]
        };
        await mutateCreateOrganization.mutateAsync({
          store,
          organization: createdOrgpanization
        });
        router.push(
          `/${store.organization.selected.name}/dashboard`,
          undefined,
          { locale: store.organization.selected.locale }
        );
      } else {
        const updatedOrgPart = {
          name: landlord.name,
          isCompany: landlord.isCompany === 'true',
          currency: landlord.currency,
          locale: landlord.locale
        };

        if (updatedOrgPart.isCompany) {
          updatedOrgPart.companyInfo = {
            ...(organization.companyInfo || {}),
            name: landlord.company,
            ein: landlord.ein,
            dos: landlord.dos,
            legalRepresentative: landlord.legalRepresentative,
            legalStructure: landlord.legalStructure,
            capital: landlord.capital
          };
        }

        const savedOrganization = await mutateUpdateOrganization.mutateAsync({
          store,
          organization: mergeOrganization(organization, { ...updatedOrgPart })
        });

        const isOrgNameChanged = savedOrganization.name !== initialValues.name;
        const isLocaleChanged =
          savedOrganization.locale !== initialValues.locale;
        if (isOrgNameChanged || isLocaleChanged) {
          document.cookie = `locale=${savedOrganization.locale};path=/landlord;max-age=31536000`;
          window.location.assign(
            `${config.BASE_PATH}/${savedOrganization.locale}/${savedOrganization.name}/settings/landlord`
          );
        }
      }
    },
    [
      firstAccess,
      store,
      mutateCreateOrganization,
      router,
      mutateUpdateOrganization,
      organization,
      initialValues.name,
      initialValues.locale
    ]
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} autoComplete="off">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">{t('Name')}</Label>
          <Input id="name" {...register('name')} />
          {errors.name && (
            <p className="text-sm text-destructive">{errors.name.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t('Language')}</Label>
          <Select
            name="locale"
            value={locale}
            onValueChange={(val) => setValue('locale', val)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {languages
                .filter((l) => l.value)
                .map((l) => (
                  <SelectItem key={l.id} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {errors.locale && (
            <p className="text-sm text-destructive">{errors.locale.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t('Currency')}</Label>
          <Select
            name="currency"
            value={currency}
            onValueChange={(val) => setValue('currency', val)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {currencies
                .filter((c) => c.value)
                .map((c) => (
                  <SelectItem key={c.id} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {errors.currency && (
            <p className="text-sm text-destructive">{errors.currency.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t('The organization/landlord belongs to')}</Label>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer" data-cy="companyFalse">
              <input
                type="radio"
                value="false"
                checked={isCompany === 'false'}
                onChange={() => setValue('isCompany', 'false')}
                className="accent-primary"
              />
              {t('A personal account')}
            </label>
            <label className="flex items-center gap-2 cursor-pointer" data-cy="companyTrue">
              <input
                type="radio"
                value="true"
                checked={isCompany === 'true'}
                onChange={() => setValue('isCompany', 'true')}
                className="accent-primary"
              />
              {t('A business or an institution')}
            </label>
          </div>
        </div>
        {isCompany === 'true' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="legalRepresentative">{t('Legal representative')}</Label>
              <Input id="legalRepresentative" {...register('legalRepresentative')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="legalStructure">{t('Legal structure')}</Label>
              <Input id="legalStructure" {...register('legalStructure')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company">{t('Name of business or institution')}</Label>
              <Input id="company" {...register('company')} />
              {errors.company && (
                <p className="text-sm text-destructive">{errors.company.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ein">{t('Employer Identification Number')}</Label>
              <Input id="ein" {...register('ein')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dos">{t('Administrative jurisdiction')}</Label>
              <Input id="dos" {...register('dos')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="capital">{t('Capital')}</Label>
              <Input id="capital" type="number" {...register('capital')} />
            </div>
          </>
        )}
      </div>
      <Button type="submit" className="mt-6" disabled={isSubmitting} data-cy="submit">
        {!isSubmitting ? t('Save') : t('Saving')}
      </Button>
    </form>
  );
}
