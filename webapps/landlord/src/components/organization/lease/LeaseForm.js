import { useMemo } from 'react';
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
import useTranslation from 'next-translate/useTranslation';

const timeRanges = ['days', 'weeks', 'months', 'years'];

function initValues(lease) {
  return {
    name: lease?.name || '',
    description: lease?.description || '',
    numberOfTerms: lease?.numberOfTerms || '',
    timeRange: lease?.timeRange || '',
    // `lease?.active || true` is ALWAYS true — false || true === true. This form
    // exposes no active control, so editing a description on a DEACTIVATED contract
    // silently reactivated it: the card un-greyed and the contract reappeared as
    // selectable in the tenant contract picker with no warning. ?? keeps a stored
    // false, and the submit path below omits `active` entirely so the PATCH cannot
    // flip a state this form does not own.
    active: lease?.active ?? true
  };
}

function getSchema(newLease, existingLeases) {
  const existingNames = (existingLeases || [])
    .filter(({ _id }) => newLease?._id !== _id)
    .map(({ name }) => name);

  // The server compares names TRIMMED and LOWERCASED (leasemanager.ts:67-80). An
  // exact includes() let "  Basic" and "basic" through the client, and the resulting
  // 422 rendered as "Some fields are missing", so the landlord retried the same input.
  const normalized = existingNames.map((n) => String(n).trim().toLowerCase());

  // numberOfTerms/timeRange are DISABLED when the contract is in use, and a legacy
  // in-use contract with a missing numberOfTerms coerced '' -> 0 and failed min(1)
  // under a field that cannot be edited — making name/description edits permanently
  // impossible. The server protects both fields anyway (leasemanager.ts:174-187), so
  // drop them from validation when they are not editable.
  const usedByTenants = !!newLease?.usedByTenants;

  return z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .refine((val) => !normalized.includes(String(val).trim().toLowerCase()), {
        message: 'Name already exists'
      }),
    description: z.string().optional(),
    numberOfTerms: usedByTenants
      ? z.any().optional()
      : z.coerce
          .number({ invalid_type_error: 'Must be at least 1' })
          .int()
          .min(1, { message: 'Must be at least 1' })
          // The server caps at 1000 (leasemanager.ts:57-61); without a client max the
          // rejection came back as "Some fields are missing".
          .max(1000, { message: 'Must be 1000 or less' }),
    timeRange: usedByTenants ? z.any().optional() : z.string().min(1),
    active: z.boolean()
  });
}

export const validate = (newLease, existingLeases) => {
  return getSchema(newLease, existingLeases).parseAsync(initValues(newLease));
};

export default function LeaseForm({ lease, leases, onSubmit }) {
  const { t } = useTranslation('common');

  const schema = useMemo(
    () => getSchema(lease, leases),
    [lease, leases]
  );

  const initialValues = useMemo(() => initValues(lease), [lease]);

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

  const usedByTenants = lease?.usedByTenants;
  const stepperMode = lease?.stepperMode;
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
}
