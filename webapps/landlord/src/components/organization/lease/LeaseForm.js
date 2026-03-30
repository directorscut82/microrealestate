import { useContext, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import { Textarea } from '../../ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../ui/select';
import { observer } from 'mobx-react-lite';
import { StoreContext } from '../../../store';
import useTranslation from 'next-translate/useTranslation';

const timeRanges = ['days', 'weeks', 'months', 'years'];

function initValues(lease) {
  return {
    name: lease?.name || '',
    description: lease?.description || '',
    numberOfTerms: lease?.numberOfTerms || '',
    timeRange: lease?.timeRange || '',
    active: lease?.active || true
  };
}

function getSchema(newLease, existingLeases) {
  const existingNames = existingLeases
    .filter(({ _id }) => newLease?._id !== _id)
    .map(({ name }) => name);

  return z.object({
    name: z.string().min(1).refine((val) => !existingNames.includes(val), {
      message: 'Name already exists'
    }),
    description: z.string().optional(),
    numberOfTerms: z.coerce.number().int().min(1),
    timeRange: z.string().min(1),
    active: z.boolean()
  });
}

export const validate = (newLease, existingLeases) => {
  return getSchema(newLease, existingLeases).parseAsync(initValues(newLease));
};

const LeaseForm = ({ onSubmit }) => {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);

  const schema = useMemo(
    () => getSchema(store.lease.selected, store.lease.items),
    [store.lease.selected, store.lease.items]
  );

  const initialValues = useMemo(
    () => initValues(store.lease.selected),
    [store.lease.selected]
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

  const usedByTenants = store.lease.selected?.usedByTenants;
  const stepperMode = store.lease.selected?.stepperMode;
  const timeRange = watch('timeRange');

  return (
    <>
      {usedByTenants && (
        <div className="text-sm text-warning mb-4">
          {t('This contract is currently used, only some fields can be updated')}
        </div>
      )}
      <form onSubmit={handleSubmit(onSubmit)} autoComplete="off">
        {!stepperMode && (
          <div className="pb-10">
            <div className="text-xl">{t('Contract information')}</div>
            <Separator className="mt-1 mb-2" />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="name">{t('Name')}</Label>
          <Input id="name" {...register('name')} />
          {errors.name && (
            <p className="text-sm text-destructive">{errors.name.message}</p>
          )}
        </div>
        <div className="space-y-2 mt-2">
          <Label htmlFor="description">{t('Description')}</Label>
          <Textarea id="description" rows={2} {...register('description')} />
        </div>
        <div className="sm:flex sm:flex-row sm:gap-2 mt-2">
          <div className="space-y-2 flex-1">
            <Label>{t('Schedule type')}</Label>
            <Select
              value={timeRange}
              onValueChange={(val) => setValue('timeRange', val)}
              disabled={usedByTenants}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timeRanges.map((tr) => (
                  <SelectItem key={tr} value={tr}>
                    {t(tr)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.timeRange && (
              <p className="text-sm text-destructive">{errors.timeRange.message}</p>
            )}
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="numberOfTerms">{t('Number of terms')}</Label>
            <Input
              id="numberOfTerms"
              type="number"
              disabled={usedByTenants}
              {...register('numberOfTerms')}
            />
            {errors.numberOfTerms && (
              <p className="text-sm text-destructive">{errors.numberOfTerms.message}</p>
            )}
          </div>
        </div>
        <Button type="submit" className="mt-6" disabled={isSubmitting} data-cy="submit">
          {!isSubmitting ? t('Save') : t('Submitting')}
        </Button>
      </form>
    </>
  );
};

export default observer(LeaseForm);
