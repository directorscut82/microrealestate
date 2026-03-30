import { useContext, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import { Switch } from '../../ui/switch';
import { observer } from 'mobx-react-lite';
import { StoreContext } from '../../../store';
import useTranslation from 'next-translate/useTranslation';

const schema = z.object({
  reference: z.string().min(1),
  isVat: z.boolean(),
  vatRatio: z.coerce.number().min(0).max(100).optional(),
  discount: z.coerce.number().min(0).optional()
});

const initValues = (tenant) => ({
  reference: tenant?.reference || '',
  isVat: !!tenant?.isVat,
  vatRatio: tenant?.vatRatio * 100 || 0,
  discount: tenant?.discount || 0
});

export const validate = (tenant) => {
  return schema.parseAsync(initValues(tenant));
};

const Billing = observer(({ readOnly, onSubmit }) => {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);

  const initialValues = useMemo(
    () => initValues(store.tenant?.selected),
    [store.tenant?.selected]
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

  const isVat = watch('isVat');
  const discount = watch('discount');
  const stepperMode = store.tenant.selected.stepperMode;

  const _onSubmit = async (billing) => {
    await onSubmit({
      reference: billing.reference,
      isVat: billing.isVat,
      vatRatio: billing.isVat ? billing.vatRatio / 100 : 0,
      discount: billing.discount
    });
  };

  return (
    <form onSubmit={handleSubmit(_onSubmit)} autoComplete="off">
      {!stepperMode && (
        <div className="pb-4">
          <div className="text-xl">{t('Billing information')}</div>
          <Separator className="mt-1 mb-2" />
        </div>
      )}
      <div className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="reference">{t('Tenant reference')}</Label>
          <Input
            id="reference"
            disabled={readOnly}
            {...register('reference')}
          />
          {errors.reference && (
            <p className="text-sm text-destructive">{errors.reference.message}</p>
          )}
        </div>
        {store.organization.selected?.isCompany && (
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
        {discount > 0 ? (
          <div className="space-y-2">
            <Label htmlFor="discount">{t('Discount')}</Label>
            <Input
              id="discount"
              type="number"
              disabled={readOnly}
              {...register('discount')}
            />
          </div>
        ) : null}
      </div>
      {!readOnly && (
        <Button type="submit" className="mt-6" disabled={isSubmitting} data-cy="submit">
          {!isSubmitting ? t('Save') : t('Saving')}
        </Button>
      )}
    </form>
  );
});

export default Billing;
