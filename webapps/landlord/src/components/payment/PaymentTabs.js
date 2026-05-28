import { Card, CardContent, CardHeader } from '../ui/card';
import {
  forwardRef,
  useCallback,
  useContext,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import _ from 'lodash';
import { Button } from '../ui/button';
import { Collapse } from '../ui/collapse';
import { DatePickerInput } from '../ui/date-picker-input';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import moment from 'moment';
import { payRent, QueryKeys } from '../../utils/restcalls';
import {
  PAYMENT_CATEGORIES,
  applyAllocation,
  autoSpreadAllocation,
  computeCategoryOwed
} from '../../utils/paymentAllocation';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import usePaymentTypes from '../../hooks/usePaymentTypes';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

const paymentSchema = z
  .object({
    amount: z.preprocess(
      (v) => (v === '' || v == null ? undefined : v),
      z.coerce.number().min(0).optional()
    ),
    date: z.string().optional(),
    type: z.enum(['cash', 'transfer', 'levy', 'cheque']),
    reference: z.string().optional()
  })
  .refine(
    ({ amount, date }) => {
      if (amount == null || amount === 0) return true;
      // Any positive amount must be ≥ 0.01 to prevent micro-payments.
      if (amount < 0.01) return false;
      return !!(date && date.length > 0);
    },
    { message: 'Date required when amount > 0', path: ['date'] }
  );

const schema = z.object({
  payments: z.array(paymentSchema).min(1),
  description: z.string().optional(),
  extracharge: z.coerce.number().min(0).optional(),
  noteextracharge: z.string().optional(),
  promo: z.coerce.number().min(0).optional(),
  notepromo: z.string().optional()
});

const emptyPayment = { amount: '', date: '', type: 'transfer', reference: '' };

function initialFormValues(rent) {
  return {
    payments: rent?.payments?.length
      ? rent.payments.map(({ amount, date, type, reference }) => ({
          amount: amount === 0 ? '' : amount,
          date: date ? moment(date, 'DD/MM/YYYY').format('YYYY-MM-DD') : '',
          type,
          reference: reference || ''
        }))
      : [emptyPayment],
    description: rent?.description?.trimEnd() || '',
    extracharge: rent?.extracharge !== 0 ? rent.extracharge : '',
    noteextracharge: rent?.noteextracharge?.trimEnd() || '',
    promo: rent?.promo !== 0 ? rent.promo : '',
    notepromo: rent?.notepromo?.trimEnd() || ''
  };
}

// Wave-25: human-readable label for each payment category. The values here
// are the LITERAL English keys that exist in every locale's common.json —
// next-translate uses string-keyed flat JSON, not dot-notation namespaces.
const CATEGORY_LABEL_KEY = {
  rent: 'Rent',
  expenses: 'Building expenses',
  repairs: 'Repairs',
  vat: 'VAT',
  previousBalance: 'Previous balance',
  extracharge: 'Extra charge'
};

/**
 * Wave-25: per-payment allocation block. Three modes:
 *   - auto: payment auto-spreads oldest debt category first (server default)
 *   - specific: pick one category, full amount goes there
 *   - custom: per-category inputs, sum should equal payment amount
 *
 * The preview shows owed-before / owed-after for every category that has
 * a non-zero owed amount. Categories with zero owed are hidden (avoids
 * cluttering the table with rows that don't apply this month).
 *
 * Overpayment surfaces a "Credit to next month" line so the surplus is
 * visible, never silent.
 */
function AllocationBlock({
  index,
  fieldKey,
  amount,
  owed,
  state,
  onModeChange,
  onSpecificCategoryChange,
  onCustomAmountChange,
  t
}) {
  const mode = state.mode || 'auto';
  const specificCategory = state.specificCategory || '';
  const custom = state.custom || {};

  // Build the working allocation array based on the active mode. This is
  // what the preview applies to `owed` to render before/after columns.
  let allocation = [];
  if (mode === 'auto') {
    allocation = autoSpreadAllocation(amount, owed);
  } else if (mode === 'specific' && specificCategory) {
    allocation = [{ category: specificCategory, amount }];
  } else if (mode === 'custom') {
    allocation = Object.entries(custom)
      .map(([category, val]) => ({ category, amount: Number(val) || 0 }))
      .filter((a) => a.amount > 0);
  }

  const { remaining, creditToNextMonth, remainingTotal } = applyAllocation(
    owed,
    allocation
  );

  // Visible categories: anything with a non-zero owed amount, OR being
  // explicitly allocated to in custom mode.
  const visibleCats = PAYMENT_CATEGORIES.filter((c) => {
    if ((Number(owed?.[c]) || 0) > 0) return true;
    if (mode === 'custom' && Number(custom[c]) > 0) return true;
    return false;
  });

  const customSum = Object.values(custom).reduce(
    (s, v) => s + (Number(v) || 0),
    0
  );
  const customDelta = amount - customSum; // >0 = under-allocated, <0 = over

  return (
    <div className="mt-3 pt-3 border-t border-stone-line/60 space-y-3">
      <div className="text-sm font-medium">{t('Apply to')}</div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={`alloc-mode-${fieldKey}`}
            value="auto"
            checked={mode === 'auto'}
            onChange={() => onModeChange('auto')}
            className="mt-1"
            data-cy={`allocMode-${index}-auto`}
          />
          <div className="flex-1">
            <div>{t('Auto-spread (oldest first)')}</div>
            <div className="text-xs text-muted-foreground">
              {t(
                'Payment fills the oldest unpaid category first, then the next.'
              )}
            </div>
          </div>
        </label>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={`alloc-mode-${fieldKey}`}
            value="specific"
            checked={mode === 'specific'}
            onChange={() => onModeChange('specific')}
            className="mt-1"
            data-cy={`allocMode-${index}-specific`}
          />
          <div className="flex-1">
            <div>{t('Specific category')}</div>
            {mode === 'specific' && (
              <div className="mt-1">
                <Select
                  value={specificCategory}
                  onValueChange={onSpecificCategoryChange}
                >
                  <SelectTrigger
                    className="max-w-xs"
                    data-cy={`allocSpecificCategory-${index}`}
                  >
                    <SelectValue placeholder={t('Select a category')} />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_CATEGORIES.filter(
                      (c) => (Number(owed?.[c]) || 0) > 0
                    ).map((c) => (
                      <SelectItem key={c} value={c}>
                        {t(CATEGORY_LABEL_KEY[c])}
                        {' '}
                        ({(Number(owed?.[c]) || 0).toFixed(2)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </label>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={`alloc-mode-${fieldKey}`}
            value="custom"
            checked={mode === 'custom'}
            onChange={() => onModeChange('custom')}
            className="mt-1"
            data-cy={`allocMode-${index}-custom`}
          />
          <div className="flex-1">
            <div>{t('Custom split')}</div>
            {mode === 'custom' && (
              <div className="mt-2 space-y-2">
                {visibleCats.map((c) => (
                  <div
                    key={c}
                    className="grid grid-cols-3 items-center gap-2 text-sm"
                  >
                    <div>{t(CATEGORY_LABEL_KEY[c])}</div>
                    <div className="text-muted-foreground tabular-nums">
                      {t('owed')}: {(Number(owed?.[c]) || 0).toFixed(2)}
                    </div>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={custom[c] ?? ''}
                      onChange={(e) =>
                        onCustomAmountChange(c, e.target.value)
                      }
                      data-cy={`allocCustom-${index}-${c}`}
                    />
                  </div>
                ))}
                <div
                  className={`text-xs ${
                    Math.abs(customDelta) < 0.005
                      ? 'text-muted-foreground'
                      : customDelta > 0
                        ? 'text-amber-600'
                        : 'text-destructive'
                  }`}
                >
                  {t('Allocated')}: {customSum.toFixed(2)} /{' '}
                  {amount.toFixed(2)}
                  {Math.abs(customDelta) >= 0.005 &&
                    ' — ' +
                      (customDelta > 0
                        ? t('{{amount}} unallocated', {
                            amount: customDelta.toFixed(2)
                          })
                        : t('{{amount}} over', {
                            amount: (-customDelta).toFixed(2)
                          }))}
                </div>
              </div>
            )}
          </div>
        </label>
      </div>

      {/* Preview: owed before / after for visible (non-zero owed) categories */}
      <div className="bg-marble-tint/40 rounded-md p-3 space-y-1 text-sm">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('Preview after this {{amount}} payment', {
            amount: amount.toFixed(2)
          })}
        </div>
        {visibleCats.length === 0 ? (
          <div className="text-muted-foreground italic">
            {t('Nothing currently owed.')}
          </div>
        ) : (
          <table className="w-full tabular-nums">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="text-left font-normal">{t('Category')}</th>
                <th className="text-right font-normal">{t('Before')}</th>
                <th className="text-right font-normal">{t('After')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleCats.map((c) => {
                const before = Number(owed?.[c]) || 0;
                const after = Number(remaining?.[c]) || 0;
                const delta = before - after;
                return (
                  <tr key={c}>
                    <td>{t(CATEGORY_LABEL_KEY[c])}</td>
                    <td className="text-right">{before.toFixed(2)}</td>
                    <td className="text-right">
                      {after.toFixed(2)}
                      {delta > 0.005 && (
                        <span className="ml-1 text-xs text-olive">
                          (-{delta.toFixed(2)})
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-stone-line/60 font-medium">
                <td>{t('Total')}</td>
                <td className="text-right">
                  {(Number(owed?.total) || 0).toFixed(2)}
                </td>
                <td className="text-right">
                  {Number(remainingTotal).toFixed(2)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {creditToNextMonth > 0 && (
          <div
            className="text-xs text-blue-700 mt-2"
            data-cy={`allocCredit-${index}`}
          >
            {t('Credit to next month')}:{' '}
            {creditToNextMonth.toFixed(2)}
          </div>
        )}
      </div>
    </div>
  );
}

function PaymentTabs({ rent, onSubmit, onError }, ref) {
  const queryClient = useQueryClient();
  const store = useContext(StoreContext);
  const { t } = useTranslation('common');
  const paymentTypes = usePaymentTypes();
  const initVals = initialFormValues(rent);
  const [expandedNote, setExpandedNote] = useState(!!initVals.description);
  const [expandedDiscount, setExpandedDiscount] = useState(initVals.promo > 0);
  const [expandedAdditionalCost, setExpandedAdditionalCost] = useState(initVals.extracharge > 0);
  const formRef = useRef();

  // Wave-25: per-payment allocation state. Keyed by field id so it survives
  // useFieldArray reorders. Default mode is 'auto' which sends NO allocation
  // (server falls through to legacy behavior — no regression risk).
  // Modes:
  //   auto     -> no allocation sent
  //   specific -> single category, full payment amount goes to it
  //   custom   -> per-line inputs, sum must equal payment amount (or be a
  //               surplus that becomes carried-forward credit)
  const [allocState, setAllocState] = useState({});
  const _setAllocMode = (key, mode) =>
    setAllocState((s) => ({ ...s, [key]: { ...(s[key] || {}), mode } }));
  const _setAllocSpecificCategory = (key, category) =>
    setAllocState((s) => ({
      ...s,
      [key]: { ...(s[key] || {}), specificCategory: category }
    }));
  const _setAllocCustomAmount = (key, category, amount) =>
    setAllocState((s) => ({
      ...s,
      [key]: {
        ...(s[key] || {}),
        custom: { ...((s[key] || {}).custom || {}), [category]: amount }
      }
    }));

  const owed = useMemo(() => computeCategoryOwed(rent), [rent]);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    reset,
    formState: { errors, isDirty, isSubmitting }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initVals
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'payments' });

  useImperativeHandle(ref, () => ({
    isDirty: () => isDirty,
    isSubmitting: () => isSubmitting,
    async submit() { formRef.current?.requestSubmit(); },
    setValues(rent) { reset(initialFormValues(rent)); }
  }), [isDirty, reset]);

  const _handleSubmit = useCallback(
    async (values) => {
      const clonedValues = _.cloneDeep(values);
      clonedValues.payments = clonedValues.payments
        .filter(({ amount }) => amount > 0)
        .map((payment, idx) => {
          payment.date = payment.date
            ? moment(payment.date).format('DD/MM/YYYY')
            : '';
          if (payment.type === 'cash') delete payment.reference;
          // Wave-25: attach allocation if user picked a non-auto mode. The
          // form-array uses positional keys; allocState is keyed by the
          // useFieldArray field id which is `fields[idx].id` at render
          // time. The submit payload sees `values.payments[idx]` without
          // that id, so we read the matching field id from the closure.
          const fieldKey = fields[idx]?.id;
          const aState = (fieldKey && allocState[fieldKey]) || {};
          const amt = Number(payment.amount) || 0;
          if (aState.mode === 'specific' && aState.specificCategory && amt > 0) {
            payment.allocation = [
              { category: aState.specificCategory, amount: amt }
            ];
          } else if (aState.mode === 'custom' && aState.custom) {
            const allocation = Object.entries(aState.custom)
              .map(([category, value]) => ({
                category,
                amount: Number(value) || 0
              }))
              .filter((a) => a.amount > 0);
            if (allocation.length) payment.allocation = allocation;
          }
          // mode === 'auto' (or unset): no allocation sent — server keeps
          // its legacy behavior. Same as pre-wave-25.
          return payment;
        });

      const payment = {
        _id: rent._id,
        month: rent.month,
        year: rent.year,
        ...clonedValues
      };

      try {
        await payRent({ term: String(rent.term), payment });
        // Invalidate via prefix so all rent periods, dashboards, tenants and
        // accounting screens refetch (no specific period to keep stale).
        queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
        onSubmit?.();
      } catch (error) {
        console.error(error);
        toast.error(t('Something went wrong'));
        onError?.();
      }
    },
    [
      onSubmit,
      onError,
      queryClient,
      rent._id,
      rent.month,
      rent.term,
      rent.year,
      t,
      fields,
      allocState
    ]
  );

  const payments = watch('payments');

  return (
    <form ref={formRef} onSubmit={handleSubmit(_handleSubmit)} autoComplete="off">
      <div className="space-y-4">
        <Card>
          <CardHeader className="text-lg px-6 pt-3 pb-0">{t('Payment')}</CardHeader>
          <CardContent>
            {fields.map((field, index) => (
              <div key={field.id} className="mb-4 p-3 border rounded-md">
                <div className="flex justify-between items-center mb-2">
                  <div className="font-medium">{t('Payment #{{count}}', { count: index + 1 })}</div>
                  {fields.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)}>
                      <LuTrash2 className="size-4" />
                    </Button>
                  )}
                </div>
                <div className="grid gap-2 items-end grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-1">
                    <Label htmlFor={`payments.${index}.date`}>{t('Date')}</Label>
                    <DatePickerInput
                      id={`payments.${index}.date`}
                      value={
                        payments?.[index]?.date
                          ? moment(payments[index].date, 'YYYY-MM-DD').format('DD/MM/YYYY')
                          : ''
                      }
                      onChange={(d) => {
                        // Store ISO format internally so the existing _handleSubmit
                        // moment(payment.date).format('DD/MM/YYYY') still works.
                        const iso = d ? moment(d, 'DD/MM/YYYY').format('YYYY-MM-DD') : '';
                        setValue(`payments.${index}.date`, iso, {
                          shouldDirty: true
                        });
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>{t('Type')}</Label>
                    <Select value={payments?.[index]?.type || 'transfer'} onValueChange={(val) => setValue(`payments.${index}.type`, val)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {paymentTypes.itemList.map((pt) => (
                          <SelectItem key={pt.id} value={pt.value}>{pt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {payments?.[index]?.type !== 'cash' && (
                    <div className="space-y-1">
                      <Label htmlFor={`payments.${index}.reference`}>{t('Reference')}</Label>
                      <Input id={`payments.${index}.reference`} {...register(`payments.${index}.reference`)} />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label htmlFor={`payments.${index}.amount`}>{t('Amount')}</Label>
                    <Input id={`payments.${index}.amount`} type="number" {...register(`payments.${index}.amount`)} />
                  </div>
                </div>
                {/* Wave-25: per-payment allocation block. Hidden when no */}
                {/* amount is entered yet (UX: don't clutter the form before */}
                {/* the user has typed an amount). */}
                {Number(payments?.[index]?.amount) > 0 && (
                  <AllocationBlock
                    index={index}
                    fieldKey={field.id}
                    amount={Number(payments?.[index]?.amount) || 0}
                    owed={owed}
                    state={allocState[field.id] || {}}
                    onModeChange={(mode) => _setAllocMode(field.id, mode)}
                    onSpecificCategoryChange={(cat) =>
                      _setAllocSpecificCategory(field.id, cat)
                    }
                    onCustomAmountChange={(cat, val) =>
                      _setAllocCustomAmount(field.id, cat, val)
                    }
                    t={t}
                  />
                )}
              </div>
            ))}
            <Button type="button" variant="outline" onClick={() => append(emptyPayment)}>
              <LuPlus className="size-4 mr-1" />{t('Add a payment')}
            </Button>
          </CardContent>
        </Card>

        <Collapse title={t('Note')} open={expandedNote} onOpenChange={setExpandedNote}>
          <div className="space-y-1">
            <Label htmlFor="description">{t('Note (only visible to landlord)')}</Label>
            <Textarea id="description" {...register('description')} />
          </div>
        </Collapse>

        <Collapse title={t('Discount')} open={expandedDiscount} onOpenChange={setExpandedDiscount}>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="promo">{t('Amount')}</Label>
              <Input id="promo" type="number" {...register('promo')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="notepromo">{t('Description (visible to tenant)')}</Label>
              <Textarea id="notepromo" {...register('notepromo')} />
            </div>
          </div>
        </Collapse>

        <Collapse title={t('Additional cost')} open={expandedAdditionalCost} onOpenChange={setExpandedAdditionalCost}>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="extracharge">{t('Amount')}</Label>
              <Input id="extracharge" type="number" {...register('extracharge')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="noteextracharge">{t('Description (visible to tenant)')}</Label>
              <Textarea id="noteextracharge" {...register('noteextracharge')} />
            </div>
          </div>
        </Collapse>
      </div>
    </form>
  );
}

export default forwardRef(PaymentTabs);
