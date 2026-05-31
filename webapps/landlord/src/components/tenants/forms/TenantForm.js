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

const PHONE_REGEX = /^[+0-9\s()-]{6,30}$/;
const optionalPhone = z
  .string()
  .trim()
  .max(30)
  .refine((v) => !v || PHONE_REGEX.test(v), { message: 'Invalid phone number' })
  .optional();

const contactSchema = z.object({
  contact: z.string().trim().min(1).max(200),
  // Wave-26: email made optional (empty strings allowed). Co-tenants are now
  // pre-filled into contacts as placeholders; landlords often only have a
  // name + ΑΦΜ for the spouse/secondary occupant. The form drops blank
  // co-tenant placeholders before submit (see _onSubmit), so legitimate
  // primary contacts are still expected to have emails in practice.
  email: z
    .string()
    .trim()
    .email()
    .max(200)
    .or(z.literal(''))
    .optional(),
  phone1: optionalPhone,
  phone2: optionalPhone,
  // Free-text note slot per contact. Useful for an alternative residence
  // ("lives in Athens during winter"), preferred contact times, language
  // preference, or anything the landlord wants to remember about them.
  notes: z.string().trim().max(2000).optional()
});

const schema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  taxId: z.string().trim().max(60).optional(),
  phone: optionalPhone,
  email: z
    .string()
    .trim()
    .email()
    .max(200)
    .or(z.literal(''))
    .optional(),
  isCompany: z.string().min(1),
  legalRepresentative: z.string().trim().max(200).optional(),
  legalStructure: z.string().trim().max(120).optional(),
  ein: z.string().trim().max(60).optional(),
  dos: z.string().trim().max(120).optional(),
  capital: z.string().trim().max(60).optional(),
  contacts: z.array(contactSchema)
});

const emptyContact = { contact: '', email: '', phone1: '', phone2: '', notes: '' };

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
    contacts: _buildInitialContacts(tenant)
  };
};

// Wave-26: build the contacts list with auto-prefilled placeholder rows for
// every co-tenant that doesn't already have a matching contact entry.
//   - Contact #1 is always present (existing contact[0], or empty for new).
//   - Each co-tenant whose name is NOT already in contacts[] gets an empty
//     placeholder row pre-filled with their name + ΑΦΜ as a hint in `notes`.
//     If the user leaves all editable fields empty on save, _onSubmit drops
//     the placeholder so blank rows don't pollute the database.
// Wave-26: dedup co-tenants against (a) their own ΑΦΜ — most reliable —
// and (b) a sorted-words name comparison so "ΜΠΙΜΠΙΚΑ ΜΑΡΙΑ" and
// "ΜΑΡΙΑ ΜΠΙΜΠΙΚΑ" are treated as the same person regardless of how the
// PDF parser ordered them. Always skip the primary tenant himself
// (he's typically present in coTenants[] from the import flow).
function _normalizeName(name) {
  return (name || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function _buildInitialContacts(tenant) {
  const existing = (tenant?.contacts || []).map(
    ({ contact, email, phone, phone1, phone2, notes }) => ({
      contact: contact || '',
      email: email || '',
      phone1: phone1 || phone || '',
      phone2: phone2 || '',
      notes: notes || ''
    })
  );
  const contacts = existing.length ? existing : [{ ...emptyContact }];

  // Seed the dedup sets with: every existing contact's normalized name +
  // ΑΦΜ-from-notes; the primary tenant's own name + taxId.
  const knownNames = new Set();
  const knownTaxIds = new Set();
  for (const c of contacts) {
    const norm = _normalizeName(c.contact);
    if (norm) knownNames.add(norm);
    const m = (c.notes || '').match(/ΑΦΜ:\s*([0-9A-Za-z]+)/);
    if (m) knownTaxIds.add(m[1]);
  }
  if (tenant?.name) knownNames.add(_normalizeName(tenant.name));
  if (tenant?.firstName || tenant?.lastName) {
    knownNames.add(
      _normalizeName(`${tenant.firstName || ''} ${tenant.lastName || ''}`)
    );
  }
  if (tenant?.taxId) knownTaxIds.add(tenant.taxId);

  for (const ct of tenant?.coTenants || []) {
    const name = (ct?.name || '').trim();
    const norm = _normalizeName(name);
    if (!name && !ct?.taxId) continue;
    if (ct?.taxId && knownTaxIds.has(ct.taxId)) continue;
    if (norm && knownNames.has(norm)) continue;
    contacts.push({
      contact: name,
      email: '',
      phone1: '',
      phone2: '',
      notes: ct?.taxId ? `ΑΦΜ: ${ct.taxId}` : ''
    });
    if (norm) knownNames.add(norm);
    if (ct?.taxId) knownTaxIds.add(ct.taxId);
  }
  return contacts;
}

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

  // Wave-26 round-3m: deduplicate the co-tenants list against the primary
  // tenant before rendering, so a single-renter case doesn't show the
  // primary tenant as their own συνενοικιαστής. Drops entries whose
  // ΑΦΜ matches the primary tenant's taxId, or whose normalized name
  // matches the primary tenant's normalized name.
  const visibleCoTenants = useMemo(() => {
    const list = tenant?.coTenants || [];
    if (!list.length) return [];
    const primaryNames = new Set(
      [
        tenant?.name,
        `${tenant?.firstName || ''} ${tenant?.lastName || ''}`
      ]
        .map(_normalizeName)
        .filter(Boolean)
    );
    const primaryTaxId = tenant?.taxId || null;
    return list.filter((ct) => {
      if (primaryTaxId && ct?.taxId === primaryTaxId) return false;
      const norm = _normalizeName(ct?.name || '');
      if (norm && primaryNames.has(norm)) return false;
      return true;
    });
  }, [tenant?.coTenants, tenant?.name, tenant?.firstName, tenant?.lastName, tenant?.taxId]);

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
      // Wave-26: Drop placeholder co-tenant contact rows the user never
      // touched. A row counts as "filled in" if the user added an email,
      // any phone, or notes beyond the auto-generated ΑΦΜ hint.
      contacts: data.contacts
        .filter(({ contact, email, phone1, phone2, notes }) => {
          if (!contact) return false;
          // First-class contact (always kept): has email.
          if (email) return true;
          // Auto-prefilled co-tenant placeholder: keep only if user filled
          // any contact channel or wrote a substantive note.
          const noteIsHint = (notes || '').trim().startsWith('ΑΦΜ:');
          return !!(phone1 || phone2 || (notes && !noteIsHint));
        })
        .map(({ contact, email, phone1, phone2, notes }) => ({
          contact,
          email,
          phone1,
          phone2,
          notes: notes || ''
        }))
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
        {visibleCoTenants.length > 0 && (
          <div className="space-y-2">
            <Label>{t('Co-tenants')}</Label>
            <div className="border rounded-md p-3 space-y-2">
              {visibleCoTenants.map((ct, i) => (
                <div key={i} className="text-sm flex justify-between">
                  <span>{ct.name}</span>
                  {ct.taxId ? (
                    <span className="text-muted-foreground">
                      ΑΦΜ: {ct.taxId}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Wave-26 round-3o: top-level Phone/Email removed. The Contact
            details section below holds per-contact phone1/phone2/email.
            Keeping a duplicate tenant-level pair here was confusing —
            users entered data twice or wondered which one matters.
            Existing data on these fields is preserved (no schema
            change), the inputs just no longer surface in the UI. */}
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

      {/* Wave-26: Address section removed. The tenant's "address" of record
          is the property they rent — captured on the lease tab. Anything else
          (alternative residence, summer address, etc.) belongs in the per-
          contact `notes` field below. */}

      <div className="pb-10 mt-12">
        <div className="text-xl">{t('Contact details')}</div>
        <div className="text-muted-foreground text-sm">{t("The contacts will receive the invoices and will be able to access the tenant's portal")}</div>
        <Separator className="mt-1 mb-2" />
        {fields.map((field, index) => (
          <div key={field.id} className="mb-4 p-4 border rounded-md">
            <div className="flex justify-between items-center mb-2">
              <div className="font-medium">{t('Contact #{{count}}', { count: index + 1 })}</div>
              {!readOnly && fields.length > 1 && (
                <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} aria-label={t('Delete')}><LuTrash2 className="size-4" /></Button>
              )}
            </div>
            <div className="space-y-2 mb-2"><Label htmlFor={`contacts.${index}.contact`}>{t('Contact')}</Label><Input id={`contacts.${index}.contact`} disabled={readOnly} {...register(`contacts.${index}.contact`)} />{errors.contacts?.[index]?.contact && <p className="text-sm text-destructive">{errors.contacts[index].contact.message}</p>}</div>
            <div className="space-y-2 mb-2"><Label htmlFor={`contacts.${index}.email`}>{t('Email')}</Label><Input id={`contacts.${index}.email`} disabled={readOnly} {...register(`contacts.${index}.email`)} />{errors.contacts?.[index]?.email && <p className="text-sm text-destructive">{errors.contacts[index].email.message}</p>}</div>
            <div className="sm:flex sm:gap-2 mb-2">
              <div className="space-y-2 flex-1"><Label htmlFor={`contacts.${index}.phone1`}>{t('Phone 1')}</Label><Input id={`contacts.${index}.phone1`} disabled={readOnly} {...register(`contacts.${index}.phone1`)} /></div>
              <div className="space-y-2 flex-1"><Label htmlFor={`contacts.${index}.phone2`}>{t('Phone 2')}</Label><Input id={`contacts.${index}.phone2`} disabled={readOnly} {...register(`contacts.${index}.phone2`)} /></div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`contacts.${index}.notes`}>{t('Notes')}</Label>
              <textarea
                id={`contacts.${index}.notes`}
                disabled={readOnly}
                rows={2}
                placeholder={t('Alternative address, preferred contact times, language, etc.')}
                className="flex min-h-[40px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                {...register(`contacts.${index}.notes`)}
              />
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
