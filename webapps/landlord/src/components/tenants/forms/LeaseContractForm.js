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

const schema = z.object({
  leaseId: z.string().min(1),
  beginDate: z.string().min(1),
  endDate: z.string().min(1),
  terminated: z.boolean().optional(),
  terminationDate: z.string().optional(),
  properties: z.array(propertySchema).min(1),
  guaranty: z.coerce.number().min(0),
  guarantyPayback: z.coerce.number().min(0).optional()
});

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

function hasCustomDates(property, beginDate, endDate) {
  if (property.entryDate && property.entryDate !== beginDate) return true;
  if (property.exitDate && property.exitDate !== endDate) return true;
  for (const exp of property.expenses || []) {
    if (exp.beginDate && exp.beginDate !== beginDate) return true;
    if (exp.endDate && exp.endDate !== endDate) return true;
  }
  return false;
}

function PropertyDates({ index, property, beginDate, endDate, readOnly, register, setValue, t }) {
  const custom = hasCustomDates(property, beginDate, endDate);
  const [open, setOpen] = useState(custom);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground mt-2 mb-1" data-cy={`customizeDates-${index}`}>
          {open ? <LuChevronDown className="size-3 mr-1" /> : <LuChevronRight className="size-3 mr-1" />}
          {t('Customize dates')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* Expenses */}
        {property.expenses?.map((expense, ei) => (
          <div key={ei} className="ml-4 mb-2 p-3 border-l-2">
            <div className="flex justify-between items-center mb-1">
              <div className="text-sm font-medium">{t('Expense #{{count}}', { count: ei + 1 })}</div>
              {!readOnly && property.expenses.length > 1 && (
                <Button type="button" variant="ghost" size="icon" onClick={() => {
                  const exps = [...property.expenses];
                  exps.splice(ei, 1);
                  setValue(`properties.${index}.expenses`, exps);
                }}><LuTrash2 className="size-3" /></Button>
              )}
            </div>
            <div className="sm:flex sm:gap-2">
              <div className="space-y-1 flex-1">
                <Label htmlFor={`properties.${index}.expenses.${ei}.beginDate`}>{t('Start date')}</Label>
                <Input id={`properties.${index}.expenses.${ei}.beginDate`} type="date" min={beginDate} max={endDate} disabled={!property._id || readOnly} {...register(`properties.${index}.expenses.${ei}.beginDate`)} />
              </div>
              <div className="space-y-1 flex-1">
                <Label htmlFor={`properties.${index}.expenses.${ei}.endDate`}>{t('End date')}</Label>
                <Input id={`properties.${index}.expenses.${ei}.endDate`} type="date" min={beginDate} max={endDate} disabled={!property._id || readOnly} {...register(`properties.${index}.expenses.${ei}.endDate`)} />
              </div>
            </div>
          </div>
        ))}
        <div className="sm:flex sm:gap-2 mt-2">
          <div className="space-y-2 flex-1">
            <Label htmlFor={`properties.${index}.entryDate`}>{t('Entry date')}</Label>
            <Input id={`properties.${index}.entryDate`} type="date" min={beginDate} max={endDate} disabled={!property._id || readOnly} {...register(`properties.${index}.entryDate`)} />
          </div>
          <div className="space-y-2 flex-1">
            <Label htmlFor={`properties.${index}.exitDate`}>{t('Exit date')}</Label>
            <Input id={`properties.${index}.exitDate`} type="date" min={beginDate} max={endDate} disabled={!property._id || readOnly} {...register(`properties.${index}.exitDate`)} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
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

            {/* Expenses - title and amount always visible */}
            {properties?.[index]?.expenses?.map((expense, ei) => (
              <div key={ei} className="ml-4 mb-2 p-3 border-l-2">
                <div className="flex justify-between items-center mb-1">
                  <div className="text-sm font-medium">{t('Recurring expense')} #{ei + 1}</div>
                  {!readOnly && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => {
                      const exps = [...properties[index].expenses];
                      exps.splice(ei, 1);
                      setValue(`properties.${index}.expenses`, exps);
                    }}><LuTrash2 className="size-3" /></Button>
                  )}
                </div>
                <div className="sm:flex sm:gap-2">
                  <div className="space-y-1 md:w-1/2">
                    <Label htmlFor={`properties.${index}.expenses.${ei}.title`}>{t('Expense')}</Label>
                    <Input id={`properties.${index}.expenses.${ei}.title`} disabled={!properties?.[index]?._id || readOnly} {...register(`properties.${index}.expenses.${ei}.title`)} />
                  </div>
                  <div className="space-y-1 md:w-1/6">
                    <Label htmlFor={`properties.${index}.expenses.${ei}.amount`}>{t('Amount')}</Label>
                    <Input id={`properties.${index}.expenses.${ei}.amount`} type="number" disabled={!properties?.[index]?._id || readOnly} {...register(`properties.${index}.expenses.${ei}.amount`)} />
                  </div>
                </div>
              </div>
            ))}
            {!readOnly && (
              <Button type="button" variant="ghost" size="sm" className="ml-4" onClick={() => {
                const exps = [...(properties?.[index]?.expenses || []), { ...emptyExpense(), beginDate, endDate }];
                setValue(`properties.${index}.expenses`, exps);
              }}>
              <LuPlus className="size-3 mr-1" />{t('Add monthly expense')}
              </Button>
            )}

            <PropertyDates
              index={index}
              property={properties?.[index] || {}}
              beginDate={beginDate}
              endDate={endDate}
              readOnly={readOnly}
              register={register}
              setValue={setValue}
              t={t}
            />
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
