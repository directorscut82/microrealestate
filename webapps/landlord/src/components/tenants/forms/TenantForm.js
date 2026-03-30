import { useContext, useMemo } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import { observer } from 'mobx-react-lite';
import { StoreContext } from '../../../store';
import useTranslation from 'next-translate/useTranslation';

const contactSchema = z.object({
  contact: z.string().min(1),
  email: z.string().email().min(1),
  phone1: z.string().optional(),
  phone2: z.string().optional()
});

const schema = z.object({
  name: z.string().min(1),
  isCompany: z.string().min(1),
  legalRepresentative: z.string().optional(),
  legalStructure: z.string().optional(),
  ein: z.string().optional(),
  dos: z.string().optional(),
  capital: z.string().optional(),
  contacts: z.array(contactSchema),
  address: z.object({
    street1: z.string().min(1),
    street2: z.string().optional(),
    city: z.string().min(1),
    zipCode: z.string().min(1),
    state: z.string().optional(),
    country: z.string().min(1)
  })
});

const emptyContact = { contact: '', email: '', phone1: '', phone2: '' };

const initValues = (tenant) => ({
  name: tenant?.name || '',
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
});

export const validate = (tenant) => schema.parseAsync(initValues(tenant));

const TenantForm = observer(({ readOnly, onSubmit }) => {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);

  const initialValues = useMemo(
    () => initValues(store.tenant?.selected),
    [store.tenant?.selected]
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
    defaultValues: initialValues
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'contacts'
  });

  const isCompany = watch('isCompany');
  const stepperMode = store.tenant.selected.stepperMode;

  const _onSubmit = async (tenant) => {
    await onSubmit({
      name: tenant.name,
      isCompany: tenant.isCompany === 'true',
      company: tenant.isCompany === 'true' ? tenant.name : '',
      manager: tenant.isCompany === 'true' ? tenant.legalRepresentative : tenant.name,
      legalForm: tenant.isCompany === 'true' ? tenant.legalStructure : '',
      siret: tenant.isCompany === 'true' ? tenant.ein : '',
      rcs: tenant.isCompany === 'true' ? tenant.dos : '',
      capital: tenant.isCompany === 'true' ? tenant.capital : '',
      street1: tenant.address.street1,
      street2: tenant.address.street2 || '',
      zipCode: tenant.address.zipCode,
      city: tenant.address.city,
      state: tenant.address.state,
      country: tenant.address.country,
      contacts: tenant.contacts
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
        <div className="space-y-2">
          <Label htmlFor="name">{t('Name')}</Label>
          <Input id="name" disabled={readOnly} {...register('name')} />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
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
        <Separator className="mt-1 mb-2" />
        <div className="space-y-2 mb-2"><Label htmlFor="address.street1">{t('Street 1')}</Label><Input id="address.street1" disabled={readOnly} {...register('address.street1')} />{errors.address?.street1 && <p className="text-sm text-destructive">{errors.address.street1.message}</p>}</div>
        <div className="space-y-2 mb-2"><Label htmlFor="address.street2">{t('Street 2')}</Label><Input id="address.street2" disabled={readOnly} {...register('address.street2')} /></div>
        <div className="sm:flex sm:gap-2 mb-2">
          <div className="space-y-2 flex-1"><Label htmlFor="address.zipCode">{t('Zip code')}</Label><Input id="address.zipCode" disabled={readOnly} {...register('address.zipCode')} />{errors.address?.zipCode && <p className="text-sm text-destructive">{errors.address.zipCode.message}</p>}</div>
          <div className="space-y-2 flex-1"><Label htmlFor="address.city">{t('City')}</Label><Input id="address.city" disabled={readOnly} {...register('address.city')} />{errors.address?.city && <p className="text-sm text-destructive">{errors.address.city.message}</p>}</div>
        </div>
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1"><Label htmlFor="address.state">{t('State')}</Label><Input id="address.state" disabled={readOnly} {...register('address.state')} /></div>
          <div className="space-y-2 flex-1"><Label htmlFor="address.country">{t('Country')}</Label><Input id="address.country" disabled={readOnly} {...register('address.country')} />{errors.address?.country && <p className="text-sm text-destructive">{errors.address.country.message}</p>}</div>
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
});

export default TenantForm;
