import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../ui/select';
import { LuChevronDown, LuChevronRight, LuPlus, LuTrash2 } from 'react-icons/lu';
import moment from 'moment';
import { nanoid } from 'nanoid';
import useTranslation from 'next-translate/useTranslation';

const expenseSchema = z.object({
  key: z.string().optional(),
  title: z.string().optional(),
  amount: z.coerce.number().min(0).optional(),
  beginDate: z.string().optional(),
  endDate: z.string().optional()
});

const propertySchema = z.object({
  key: z.string().optional(),
  _id: z.string().min(1),
  rent: z.coerce.number().min(0),
  expenses: z.array(expenseSchema),
  entryDate: z.string().min(1),
  exitDate: z.string().min(1)
});

const schema = z
  .object({
    leaseId: z.string().min(1),
    beginDate: z.string().min(1),
    endDate: z.string().min(1),
    terminated: z.boolean().optional(),
    terminationDate: z.string().optional(),
    properties: z.array(propertySchema).min(1),
    guaranty: z.coerce.number().min(0).max(10000000).finite(),
    guarantyPayback: z.coerce.number().min(0).max(10000000).optional()
  })
  .refine(
    ({ beginDate, endDate }) => {
      if (!beginDate || !endDate) return true;
      return moment(endDate).isAfter(moment(beginDate));
    },
    { message: 'End date must be after start date', path: ['endDate'] }
  )
  .refine(
    ({ terminated, terminationDate }) => {
      if (!terminated) return true;
      return !!(terminationDate && terminationDate.length > 0);
    },
    {
      message: 'Termination date is required',
      path: ['terminationDate']
    }
  );

const emptyExpense = () => ({
  key: nanoid(),
  title: '',
  amount: 0,
  beginDate: '',
  endDate: ''
});

const emptyProperty = () => ({
  key: nanoid(),
  _id: '',
  rent: 0,
  expenses: [],
  entryDate: '',
  exitDate: ''
});

function toDateStr(val, fmt = 'DD/MM/YYYY') {
  if (!val) return '';
  const m = moment(val, fmt);
  return m.isValid() ? m.format('YYYY-MM-DD') : '';
}

const initValues = (tenant) => {
  const beginDate = toDateStr(tenant?.beginDate);
  const endDate = toDateStr(tenant?.endDate);

  return {
    leaseId: tenant?.leaseId || '',
    beginDate,
    endDate,
    terminated: !!tenant?.terminationDate,
    terminationDate: toDateStr(tenant?.terminationDate),
    properties: tenant?.properties?.length
      ? tenant.properties.map((property) => ({
          key: property.property._id,
          _id: property.property._id,
          rent: property.rent || 0,
          expenses: (property.expenses || []).map((expense) => ({
            ...expense,
            key: nanoid(),
            beginDate: toDateStr(expense.beginDate),
            endDate: toDateStr(expense.endDate)
          })),
          entryDate: toDateStr(property.entryDate) || beginDate,
          exitDate: toDateStr(property.exitDate) || endDate
        }))
      : [{ ...emptyProperty(), expenses: [], entryDate: beginDate, exitDate: endDate }],
    guaranty: tenant?.guaranty || 0,
    guarantyPayback: tenant?.guarantyPayback || 0
  };
};

export const validate = (tenant) => schema.parseAsync(initValues(tenant));

function Section({ label, visible = true, children }) {
  if (!visible) return children;
  return (
    <div className="pb-10">
      <div className="text-xl">{label}</div>
      <Separator className="mt-1 mb-2" />
      {children}
    </div>
  );
}

// Wave-26: simplified property-level handover dates collapsible.
//   - Renders ONLY the property entry/exit dates (no more duplicate per-
//     expense inputs — each expense manages its own dates inside its own
//     card now).
//   - Closed by default. Auto-opens only when current values differ from
//     the lease's own begin/end (i.e. there's actually a handover gap).
function PropertyHandoverDates({ index, property, beginDate, endDate, readOnly, register, t }) {
  const custom =
    (property.entryDate && property.entryDate !== beginDate) ||
    (property.exitDate && property.exitDate !== endDate);
  const [open, setOpen] = useState(!!custom);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground -ml-2" data-cy={`customizeDates-${index}`}>
          {open ? <LuChevronDown className="size-3 mr-1" /> : <LuChevronRight className="size-3 mr-1" />}
          {t('Mid-lease handover dates')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="text-xs text-muted-foreground mb-2 ml-1">
          {t(
            "Defaults to the lease's start and end. Set only if this property's occupancy starts later or ends earlier than the lease."
          )}
        </p>
        <div className="sm:flex sm:gap-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor={`properties.${index}.entryDate`}>{t('Occupancy starts')}</Label>
            <Input id={`properties.${index}.entryDate`} type="date" min={beginDate} max={endDate} disabled={!property._id || readOnly} {...register(`properties.${index}.entryDate`)} />
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor={`properties.${index}.exitDate`}>{t('Occupancy ends')}</Label>
            <Input id={`properties.${index}.exitDate`} type="date" min={beginDate} max={endDate} disabled={!property._id || readOnly} {...register(`properties.${index}.exitDate`)} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Wave-26: each expense renders as a self-contained card with title /
// amount / explicit Frequency dropdown, plus a "Custom date range"
// collapsible (closed by default) for when this expense applies only to a
// sub-period of the lease. The Frequency dropdown replaces the silent
// "[One-time]"/"[Monthly]" badge that previously toggled based on whether
// beginDate equaled endDate without giving the user any control.
function ExpenseCard({
  index,
  ei,
  expense,
  property,
  beginDate,
  endDate,
  readOnly,
  register,
  setValue,
  t
}) {
  // "One-time" is when begin === end (a single day's charge). "Monthly" is
  // anything spanning more than a day. We treat empty dates as "Monthly"
  // and default to the lease range.
  const isOneTime = !!(
    expense.beginDate &&
    expense.endDate &&
    expense.beginDate === expense.endDate
  );
  const customRange =
    (expense.beginDate && expense.beginDate !== beginDate) ||
    (expense.endDate && expense.endDate !== endDate);
  const [rangeOpen, setRangeOpen] = useState(!!customRange);

  const onFrequencyChange = (val) => {
    if (val === 'one-time') {
      // Pin both dates to the lease begin so the user only has one date to
      // think about; they can change it via the custom range collapsible.
      setValue(`properties.${index}.expenses.${ei}.beginDate`, beginDate || '');
      setValue(`properties.${index}.expenses.${ei}.endDate`, beginDate || '');
    } else {
      // Restore the lease range so the expense applies for the whole lease.
      setValue(`properties.${index}.expenses.${ei}.beginDate`, beginDate || '');
      setValue(`properties.${index}.expenses.${ei}.endDate`, endDate || '');
    }
  };

  return (
    <div className="ml-2 mb-2 p-3 border rounded-md bg-muted/30">
      <div className="flex justify-between items-center mb-2">
        <div className="text-sm font-medium">
          {expense.title?.trim() || t('Recurring expense')}
        </div>
        {!readOnly && (
          <Button type="button" variant="ghost" size="icon" onClick={() => {
            const exps = [...property.expenses];
            exps.splice(ei, 1);
            setValue(`properties.${index}.expenses`, exps);
          }}>
            <LuTrash2 className="size-3" />
          </Button>
        )}
      </div>
      <div className="sm:flex sm:gap-2 mb-2">
        <div className="space-y-1 flex-1">
          <Label htmlFor={`properties.${index}.expenses.${ei}.title`}>{t('Title')}</Label>
          <Input id={`properties.${index}.expenses.${ei}.title`} disabled={!property._id || readOnly} {...register(`properties.${index}.expenses.${ei}.title`)} />
        </div>
        <div className="space-y-1 sm:w-1/4">
          <Label htmlFor={`properties.${index}.expenses.${ei}.amount`}>{t('Amount')}</Label>
          <Input id={`properties.${index}.expenses.${ei}.amount`} type="number" disabled={!property._id || readOnly} {...register(`properties.${index}.expenses.${ei}.amount`)} />
        </div>
        <div className="space-y-1 sm:w-1/4">
          <Label>{t('Frequency')}</Label>
          <Select
            value={isOneTime ? 'one-time' : 'monthly'}
            onValueChange={onFrequencyChange}
            disabled={!property._id || readOnly}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">{t('Monthly')}</SelectItem>
              <SelectItem value="one-time">{t('One-time')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Collapsible open={rangeOpen} onOpenChange={setRangeOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground -ml-2">
            {rangeOpen ? <LuChevronDown className="size-3 mr-1" /> : <LuChevronRight className="size-3 mr-1" />}
            {t('Custom date range')}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p className="text-xs text-muted-foreground mb-2 ml-1">
            {t(
              "Defaults to the lease's range. Set only if this expense applies to a sub-period of the lease."
            )}
          </p>
          <div className="sm:flex sm:gap-2">
            <div className="space-y-1 flex-1">
              <Label htmlFor={`properties.${index}.expenses.${ei}.beginDate`}>{t('From')}</Label>
              <Input id={`properties.${index}.expenses.${ei}.beginDate`} type="date" min={beginDate} max={endDate} disabled={!property._id || readOnly} {...register(`properties.${index}.expenses.${ei}.beginDate`)} />
            </div>
            <div className="space-y-1 flex-1">
              <Label htmlFor={`properties.${index}.expenses.${ei}.endDate`}>{t('To')}</Label>
              <Input id={`properties.${index}.expenses.${ei}.endDate`} type="date" min={beginDate} max={endDate} disabled={!property._id || readOnly} {...register(`properties.${index}.expenses.${ei}.endDate`)} />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function LeaseContractForm({ tenant, leases = [], properties: propertyItems = [], readOnly, onSubmit }) {
  const { t } = useTranslation('common');
  const [contractDuration, setContractDuration] = useState();

  useEffect(() => {
    const lease = tenant?.lease;
    if (lease) {
      setContractDuration(moment.duration(lease.numberOfTerms, lease.timeRange));
    } else {
      setContractDuration(undefined);
    }
  }, [tenant?.lease]);

  const initialValues = useMemo(() => initValues(tenant), [tenant]);

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

  const { fields: propertyFields, append: appendProperty, remove: removeProperty } = useFieldArray({ control, name: 'properties' });

  const leaseId = watch('leaseId');
  const beginDate = watch('beginDate');
  const endDate = watch('endDate');
  const terminated = watch('terminated');
  const properties = watch('properties');

  const availableLeases = useMemo(() =>
    leases.map(({ _id, name, active }) => ({ id: _id, value: _id, label: name, disabled: !active })),
    [leases]
  );

  const availableProperties = useMemo(() => {
    const currentProps = tenant?.properties?.map(({ propertyId }) => propertyId) || [];
    return [
      { id: '', label: '', value: '' },
      ...propertyItems.map(({ _id, name, status, occupantLabel }) => ({
        id: _id, value: _id,
        label: t('{{name}} - {{status}}', {
          name,
          status: status === 'occupied'
            ? !currentProps.includes(_id) ? t('occupied by {{tenantName}}', { tenantName: occupantLabel }) : t('occupied by current tenant')
            : t('vacant')
        })
      }))
    ];
  }, [t, tenant?.properties, propertyItems]);

  const onLeaseChange = useCallback((val) => {
    setValue('leaseId', val);
    const lease = leases.find(({ _id }) => _id === val);
    if (lease) {
      setContractDuration(moment.duration(lease.numberOfTerms, lease.timeRange));
      if (beginDate) {
        const newEnd = moment(beginDate).add(moment.duration(lease.numberOfTerms, lease.timeRange)).subtract(1, 'second');
        setValue('endDate', newEnd.format('YYYY-MM-DD'));
      }
    }
  }, [leases, setValue, beginDate]);

  const onPropertyChange = useCallback((val, index) => {
    const property = propertyItems.find(({ _id }) => _id === val);
    setValue(`properties.${index}._id`, val);
    if (property) {
      setValue(`properties.${index}.rent`, property.price || 0);
      setValue(`properties.${index}.entryDate`, beginDate);
      setValue(`properties.${index}.exitDate`, endDate);
    }
  }, [propertyItems, setValue, beginDate, endDate]);

  const _onSubmit = useCallback(async (lease) => {
    await onSubmit({
      leaseId: lease.leaseId,
      frequency: leases.find(({ _id }) => _id === lease.leaseId)?.timeRange,
      beginDate: lease.beginDate ? moment(lease.beginDate).format('DD/MM/YYYY') : '',
      endDate: lease.endDate ? moment(lease.endDate).format('DD/MM/YYYY') : '',
      terminationDate: lease.terminationDate ? moment(lease.terminationDate).format('DD/MM/YYYY') : '',
      guaranty: lease.guaranty || 0,
      guarantyPayback: lease.guarantyPayback || 0,
      properties: lease.properties
        .filter((p) => !!p._id)
        .map((p) => ({
          propertyId: p._id,
          rent: p.rent,
          expenses: p.expenses?.map((e) => ({
            ...e,
            beginDate: e.beginDate ? moment(e.beginDate).format('DD/MM/YYYY') : '',
            endDate: e.endDate ? moment(e.endDate).format('DD/MM/YYYY') : ''
          })) || [],
          entryDate: p.entryDate ? moment(p.entryDate).format('DD/MM/YYYY') : '',
          exitDate: p.exitDate ? moment(p.exitDate).format('DD/MM/YYYY') : ''
        }))
    });
  }, [onSubmit, leases]);

  return (
    <form onSubmit={handleSubmit(_onSubmit)} autoComplete="off">
      {terminated && (
        <Section label={t('Termination')}>
          <div className="space-y-2 mb-2">
            <Label htmlFor="terminationDate">{t('Termination date')}</Label>
            <Input id="terminationDate" type="date" min={beginDate} max={endDate} disabled={readOnly} {...register('terminationDate')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="guarantyPayback">{t('Amount of the deposit refund')}</Label>
            <Input id="guarantyPayback" type="number" disabled={readOnly} {...register('guarantyPayback')} />
          </div>
        </Section>
      )}

      <Section label={t('Lease')} visible={!tenant?.stepperMode}>
        <div className="space-y-2 mb-2">
          <Label>{t('Lease')}</Label>
          {availableLeases.length === 0 ? (
            <p className="text-sm text-muted-foreground p-2 border rounded-md bg-muted">
              {t('No contracts found. Go to Settings > Contracts to create one.')}
            </p>
          ) : (
            <Select value={leaseId} onValueChange={onLeaseChange} disabled={readOnly}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {availableLeases.map((l) => (
                  <SelectItem key={l.id} value={l.value} disabled={l.disabled}>{l.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {errors.leaseId && <p className="text-sm text-destructive">{errors.leaseId.message}</p>}
        </div>
        <div className="sm:flex sm:gap-2 mb-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor="beginDate">{t('Start date')}</Label>
            <Input id="beginDate" type="date" disabled={!leaseId || readOnly} {...register('beginDate')} />
            {errors.beginDate && <p className="text-sm text-destructive">{errors.beginDate.message}</p>}
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor="endDate">{t('End date')}</Label>
            <Input id="endDate" type="date" disabled={!leaseId || readOnly} {...register('endDate')} />
            {errors.endDate && <p className="text-sm text-destructive">{errors.endDate.message}</p>}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="guaranty">{t('Deposit')}</Label>
          <Input id="guaranty" type="number" disabled={!leaseId || readOnly} {...register('guaranty')} />
        </div>
      </Section>

      <Section label={t('Properties')}>
        {propertyFields.map((field, index) => (
          <div key={field.id} className="mb-4 p-4 border rounded-md">
            <div className="flex justify-between items-center mb-2">
              <div className="font-medium">{t('Property #{{count}}', { count: index + 1 })}</div>
              {!readOnly && propertyFields.length > 1 && (
                <Button type="button" variant="ghost" size="icon" onClick={() => removeProperty(index)}>
                  <LuTrash2 className="size-4" />
                </Button>
              )}
            </div>
            <div className="sm:flex sm:gap-2 mb-2">
              <div className="space-y-2 md:w-3/4">
                <Label>{t('Property')}</Label>
                <Select value={properties?.[index]?._id || ''} onValueChange={(val) => onPropertyChange(val, index)} disabled={readOnly}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {availableProperties.filter((p) => p.value).map((p) => (
                      <SelectItem key={p.id} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.properties?.[index]?._id && <p className="text-sm text-destructive">{errors.properties[index]._id.message}</p>}
              </div>
              <div className="space-y-2 md:w-1/6">
                <Label htmlFor={`properties.${index}.rent`}>{t('Rent')}</Label>
                <Input id={`properties.${index}.rent`} type="number" disabled={!properties?.[index]?._id || readOnly} {...register(`properties.${index}.rent`)} />
              </div>
            </div>

            <PropertyHandoverDates
              index={index}
              property={properties?.[index] || {}}
              beginDate={beginDate}
              endDate={endDate}
              readOnly={readOnly}
              register={register}
              t={t}
            />

            {properties?.[index]?.expenses?.length > 0 && (
              <div className="text-xs text-muted-foreground mt-3 mb-2 uppercase tracking-wide">
                {t('Recurring expenses')}
              </div>
            )}
            {properties?.[index]?.expenses?.map((expense, ei) => (
              <ExpenseCard
                key={expense.key || ei}
                index={index}
                ei={ei}
                expense={expense}
                property={properties[index]}
                beginDate={beginDate}
                endDate={endDate}
                readOnly={readOnly}
                register={register}
                setValue={setValue}
                t={t}
              />
            ))}
            {!readOnly && (
              <Button type="button" variant="outline" size="sm" className="mt-1" onClick={() => {
                const exps = [...(properties?.[index]?.expenses || []), { ...emptyExpense(), beginDate, endDate }];
                setValue(`properties.${index}.expenses`, exps);
              }}>
              <LuPlus className="size-3 mr-1" />{t('Add expense')}
              </Button>
            )}
          </div>
        ))}
        {!readOnly && (
          <Button type="button" variant="outline" onClick={() => appendProperty({ ...emptyProperty(), expenses: [], entryDate: beginDate, exitDate: endDate })} data-cy="addPropertiesItem">
            <LuPlus className="size-4 mr-1" />{t('Add a property')}
          </Button>
        )}
      </Section>

      {!readOnly && (
        <Button type="submit" disabled={isSubmitting} data-cy="submit">
          {!isSubmitting ? t('Save') : t('Saving')}
        </Button>
      )}
    </form>
  );
}

export default LeaseContractForm;
