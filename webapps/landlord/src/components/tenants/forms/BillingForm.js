import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '../../ui/collapsible';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import { Switch } from '../../ui/switch';
import { LuChevronDown, LuChevronRight } from 'react-icons/lu';
import useTranslation from 'next-translate/useTranslation';

const schema = z.object({
  // Empty is allowed — the server fills in a nanoid() when blank.
  reference: z.string().max(120).optional(),
  isVat: z.boolean(),
  vatRatio: z.coerce.number().min(0).max(100).optional()
  // Note: tenant.discount is still a writable field on the schema, but
  // the per-tenant monthly discount UI was removed because in practice
  // the data comes from the lease/import flow, not from this form.
});

const initValues = (tenant) => ({
  reference: tenant?.reference || '',
  isVat: !!tenant?.isVat,
  vatRatio: tenant?.vatRatio * 100 || 0
});

export const validate = (tenant) => {
  return schema.parseAsync(initValues(tenant));
};

const Billing = ({ tenant, organization, readOnly, onSubmit }) => {
  const { t } = useTranslation('common');

  const initialValues = useMemo(
    () => initValues(tenant),
    [tenant]
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

  const isVat = watch('isVat');
  const stepperMode = tenant?.stepperMode;

  const _onSubmit = async (billing) => {
    await onSubmit({
      reference: billing.reference,
      isVat: billing.isVat,
      vatRatio: billing.isVat ? billing.vatRatio / 100 : 0
    });
  };

  // The reference field is auto-populated by the server (nanoid()) when
  // empty. Most landlords never need to edit it, so it lives behind an
  // Advanced collapsible to declutter the form. Open by default if the
  // tenant has a non-default reference the user might want to see.
  const [advancedOpen, setAdvancedOpen] = useState(
    !!(tenant?.reference && tenant.reference.length > 0)
  );

  return (
    <form onSubmit={handleSubmit(_onSubmit)} autoComplete="off">
      {!stepperMode && (
        <div className="pb-4">
          <div className="text-xl">{t('Invoicing settings')}</div>
          <Separator className="mt-1 mb-2" />
        </div>
      )}
      <div className="space-y-6">
        {organization?.isCompany && (
          <>
            <div className="flex items-center gap-2">
              <Switch
                id="isVat"
                checked={isVat}
                disabled={readOnly}
                onCheckedChange={(checked) => setValue('isVat', checked)}
              />
              <Label htmlFor="isVat">{t('Subject to VAT')}</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="vatRatio">{t('VAT percentage')}</Label>
              <Input
                id="vatRatio"
                type="number"
                disabled={readOnly || !isVat}
                {...register('vatRatio')}
              />
            </div>
          </>
        )}
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground -ml-2"
            >
              {advancedOpen ? (
                <LuChevronDown className="size-3 mr-1" />
              ) : (
                <LuChevronRight className="size-3 mr-1" />
              )}
              {t('Advanced')}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-2 mt-2">
              <Label htmlFor="reference">{t('Tenant reference (auto-generated if empty)')}</Label>
              <Input
                id="reference"
                disabled={readOnly}
                {...register('reference')}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  'Identifier printed on this tenant\'s invoices. Leave blank to let the system generate one.'
                )}
              </p>
              {errors.reference && (
                <p className="text-sm text-destructive">{errors.reference.message}</p>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      {!readOnly && (
        <Button type="submit" className="mt-6" disabled={isSubmitting} data-cy="submit">
          {!isSubmitting ? t('Save') : t('Saving')}
        </Button>
      )}
    </form>
  );
};

export default Billing;
