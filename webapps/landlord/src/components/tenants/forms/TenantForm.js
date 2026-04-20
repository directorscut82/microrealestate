import { useMemo } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import useTranslation from 'next-translate/useTranslation';

const contactSchema = z.object({
  contact: z.string().min(1),
  email: z.string().email().min(1),
  phone1: z.string().optional(),
  phone2: z.string().optional()
});

const schema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  taxId: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().or(z.literal('')).optional(),
  isCompany: z.string().min(1),
  legalRepresentative: z.string().optional(),
  legalStructure: z.string().optional(),
  ein: z.string().optional(),
  dos: z.string().optional(),
  capital: z.string().optional(),
  contacts: z.array(contactSchema),
  address: z.object({
    street1: z.string().optional(),
    street2: z.string().optional(),
    city: z.string().optional(),
    zipCode: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional()
  })
});

const emptyContact = { contact: '', email: '', phone1: '', phone2: '' };

const initValues = (tenant) => {
  // Parse existing 'name' into firstName/lastName for backward compat
  let firstName = tenant?.firstName || '';
  let lastName = tenant?.lastName || '';
  if (!firstName && !lastName && tenant?.name) {
    const parts = tenant.name.trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  return {
    firstName,
    lastName,
    taxId: tenant?.taxId || '',
    phone: tenant?.phone || '',
    email: tenant?.email || '',
    isCompany: tenant?.isCompany ? 'true' : 'false',
    legalRepresentative: tenant?.manager || '',
    legalStructure: tenant?.legalForm || '',
    ein: tenant?.siret || '',
    dos: tenant?.rcs || '',
    capital: tenant?.capital || '',
    contacts: tenant?.contacts?.length
      ? tenant.contacts.map(({ contact, email, phone, phone1, phone2 }) => ({
          contact,
          email,
          phone1: phone1 || phone || '',
          phone2: phone2 || ''
        }))
      : [emptyContact],
    address: {
      street1: tenant?.street1 || '',
      street2: tenant?.street2 || '',
      city: tenant?.city || '',
      zipCode: tenant?.zipCode || '',
      state: tenant?.state || '',
      country: tenant?.country || ''
    }
  };
};

export const validate = (tenant) => schema.parseAsync(initValues(tenant));

const TenantForm = ({ tenant, readOnly, onSubmit }) => {
  const { t } = useTranslation('common');

  const initialValues = useMemo(
    () => initValues(tenant),
    [tenant]
  );

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
    values: initialValues
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'contacts'
  });

  const isCompany = watch('isCompany');
  const stepperMode = tenant?.stepperMode;

  const _onSubmit = async (data) => {
    const fullName = `${data.firstName} ${data.lastName}`.trim();
    await onSubmit({
      name: fullName,
      firstName: data.firstName,
      lastName: data.lastName,
      taxId: data.taxId || '',
      phone: data.phone || '',
      email: data.email || '',
      isCompany: data.isCompany === 'true',
      company: data.isCompany === 'true' ? fullName : '',
      manager: data.isCompany === 'true' ? data.legalRepresentative : fullName,
      legalForm: data.isCompany === 'true' ? data.legalStructure : '',
      siret: data.isCompany === 'true' ? data.ein : '',
      rcs: data.isCompany === 'true' ? data.dos : '',
      capital: data.isCompany === 'true' ? data.capital : '',
      street1: data.address.street1 || '',
      street2: data.address.street2 || '',
      zipCode: data.address.zipCode || '',
      city: data.address.city || '',
      state: data.address.state || '',
      country: data.address.country || '',
      contacts: data.contacts
        .filter(({ contact }) => !!contact)
        .map(({ contact, email, phone1, phone2 }) => ({ contact, email, phone1, phone2 }))
    });
  };

  return (
    <form onSubmit={handleSubmit(_onSubmit)} autoComplete="off">
      {!stepperMode && (
        <div className="pb-4">
          <div className="text-xl">{t('Tenant information')}</div>
          <Separator className="mt-1 mb-2" />
        </div>
      )}
      <div className="space-y-4">
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="firstName">{t('First name')}</Label>
            <Input id="firstName" disabled={readOnly} {...register('firstName')} />
            {errors.firstName && <p className="text-sm text-destructive">{errors.firstName.message}</p>}
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="lastName">{t('Last name')}</Label>
            <Input id="lastName" disabled={readOnly} {...register('lastName')} />
            {errors.lastName && <p className="text-sm text-destructive">{errors.lastName.message}</p>}
          </div>
        </div>
        <div className="space-y-2 sm:w-1/2">
          <Label htmlFor="taxId">{t('Tax ID')}</Label>
          <Input id="taxId" disabled={readOnly} {...register('taxId')} placeholder={t('e.g. ΑΦΜ')} />
        </div>
        {tenant?.coTenants?.length > 0 && (
          <div className="space-y-2">
            <Label>{t('Co-tenants')}</Label>
            <div className="border rounded-md p-3 space-y-2">
              {tenant.coTenants.map((ct, i) => (
                <div key={i} className="text-sm flex justify-between">
                  <span>{ct.name}</span>
                  <span className="text-muted-foreground">ΑΦΜ: {ct.taxId}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="phone">{t('Phone')}</Label>
            <Input id="phone" disabled={readOnly} {...register('phone')} />
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="email">{t('Email')}</Label>
            <Input id="email" disabled={readOnly} {...register('email')} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>{t('The tenant belongs to')}</Label>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer" data-cy="tenantIsPersonalAccount">
              <input type="radio" value="false" checked={isCompany === 'false'} onChange={() => setValue('isCompany', 'false')} disabled={readOnly} className="accent-primary" />
              {t('A personal account')}
            </label>
            <label className="flex items-center gap-2 cursor-pointer" data-cy="tenantIsBusinessAccount">
              <input type="radio" value="true" checked={isCompany === 'true'} onChange={() => setValue('isCompany', 'true')} disabled={readOnly} className="accent-primary" />
              {t('A business or an institution')}
            </label>
          </div>
        </div>
        {isCompany === 'true' && (
          <>
            <div className="space-y-2"><Label htmlFor="legalRepresentative">{t('Legal representative')}</Label><Input id="legalRepresentative" disabled={readOnly} {...register('legalRepresentative')} /></div>
            <div className="space-y-2"><Label htmlFor="legalStructure">{t('Legal structure')}</Label><Input id="legalStructure" disabled={readOnly} {...register('legalStructure')} /></div>
            <div className="space-y-2"><Label htmlFor="ein">{t('Employer Identification Number')}</Label><Input id="ein" disabled={readOnly} {...register('ein')} /></div>
            <div className="space-y-2"><Label htmlFor="dos">{t('Administrative jurisdiction')}</Label><Input id="dos" disabled={readOnly} {...register('dos')} /></div>
            <div className="space-y-2"><Label htmlFor="capital">{t('Capital')}</Label><Input id="capital" disabled={readOnly} {...register('capital')} /></div>
          </>
        )}
      </div>

      <div className="pb-10 mt-6">
        <div className="text-xl">{t('Address')}</div>
        <p className="text-sm text-muted-foreground mb-1">{t('Optional')}</p>
        <Separator className="mt-1 mb-2" />
        <div className="space-y-2 mb-2"><Label htmlFor="address.street1">{t('Street 1')}</Label><Input id="address.street1" disabled={readOnly} {...register('address.street1')} /></div>
        <div className="space-y-2 mb-2"><Label htmlFor="address.street2">{t('Street 2')}</Label><Input id="address.street2" disabled={readOnly} {...register('address.street2')} /></div>
        <div className="sm:flex sm:gap-2 mb-2">
          <div className="space-y-2 flex-1"><Label htmlFor="address.zipCode">{t('Zip code')}</Label><Input id="address.zipCode" disabled={readOnly} {...register('address.zipCode')} /></div>
          <div className="space-y-2 flex-1"><Label htmlFor="address.city">{t('City')}</Label><Input id="address.city" disabled={readOnly} {...register('address.city')} /></div>
        </div>
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1"><Label htmlFor="address.state">{t('State')}</Label><Input id="address.state" disabled={readOnly} {...register('address.state')} /></div>
          <div className="space-y-2 flex-1"><Label htmlFor="address.country">{t('Country')}</Label><Input id="address.country" disabled={readOnly} {...register('address.country')} /></div>
        </div>
      </div>

      <div className="pb-10">
        <div className="text-xl">{t('Contacts')}</div>
        <div className="text-muted-foreground text-sm">{t("The contacts will receive the invoices and will be able to access the tenant's portal")}</div>
        <Separator className="mt-1 mb-2" />
        {fields.map((field, index) => (
          <div key={field.id} className="mb-4 p-4 border rounded-md">
            <div className="flex justify-between items-center mb-2">
              <div className="font-medium">{t('Contact #{{count}}', { count: index + 1 })}</div>
              {!readOnly && fields.length > 1 && (
                <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)}><LuTrash2 className="size-4" /></Button>
              )}
            </div>
            <div className="space-y-2 mb-2"><Label htmlFor={`contacts.${index}.contact`}>{t('Contact')}</Label><Input id={`contacts.${index}.contact`} disabled={readOnly} {...register(`contacts.${index}.contact`)} />{errors.contacts?.[index]?.contact && <p className="text-sm text-destructive">{errors.contacts[index].contact.message}</p>}</div>
            <div className="space-y-2 mb-2"><Label htmlFor={`contacts.${index}.email`}>{t('Email')}</Label><Input id={`contacts.${index}.email`} disabled={readOnly} {...register(`contacts.${index}.email`)} />{errors.contacts?.[index]?.email && <p className="text-sm text-destructive">{errors.contacts[index].email.message}</p>}</div>
            <div className="sm:flex sm:gap-2">
              <div className="space-y-2 flex-1"><Label htmlFor={`contacts.${index}.phone1`}>{t('Phone 1')}</Label><Input id={`contacts.${index}.phone1`} disabled={readOnly} {...register(`contacts.${index}.phone1`)} /></div>
              <div className="space-y-2 flex-1"><Label htmlFor={`contacts.${index}.phone2`}>{t('Phone 2')}</Label><Input id={`contacts.${index}.phone2`} disabled={readOnly} {...register(`contacts.${index}.phone2`)} /></div>
            </div>
          </div>
        ))}
        {!readOnly && (
          <Button type="button" variant="outline" onClick={() => append(emptyContact)} data-cy="addContactsItem">
            <LuPlus className="size-4 mr-1" />{t('Add a contact')}
          </Button>
        )}
      </div>

      {!readOnly && (
        <Button type="submit" disabled={isSubmitting} data-cy="submit">
          {!isSubmitting ? t('Save') : t('Saving')}
        </Button>
      )}
    </form>
  );
};

export default TenantForm;
