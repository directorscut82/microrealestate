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
import { LuPencil, LuPlus, LuTrash2 } from 'react-icons/lu';
import NumberFormat from '../NumberFormat';
import ConfirmDialog from '../ConfirmDialog';
import { cn } from '../../utils';
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
    // 'levy' is no longer offered in the dropdown but the enum keeps it
    // so legacy records re-saved through the dialog don't trip validation.
    type: z.enum(['cash', 'transfer', 'levy', 'cheque']),
    reference: z.string().optional(),
    // Wave-26 round-3j: per-payment note/discount/extra-charge. These used to
    // live at the rent level and were re-shown on every reopen; the user
    // expects them to belong to the specific payment instead.
    description: z.string().optional(),
    promo: z.preprocess(
      (v) => (v === '' || v == null ? undefined : v),
      z.coerce.number().min(0).optional()
    ),
    notepromo: z.string().optional(),
    extracharge: z.preprocess(
      (v) => (v === '' || v == null ? undefined : v),
      z.coerce.number().min(0).optional()
    ),
    noteextracharge: z.string().optional()
  })
  .refine(
    ({ amount, date }) => {
      if (amount == null || amount === 0) return true;
      // Any positive amount must be ≥ 0.01 to prevent micro-payments.
      if (amount < 0.01) return false;
      return !!(date && date.length > 0);
    },
    { message: 'Date required when amount > 0', path: ['date'] }
  )
  .refine(
    ({ amount, date }) => {
      // Wave-26 round-3g: server (rentmanager.ts F3) rejects payment
      // dates >7 days in the future. Surface this client-side so the
      // user gets a clear field error instead of a generic toast on
      // submit. Date is stored ISO YYYY-MM-DD inside the form.
      if (!date || amount == null || amount <= 0) return true;
      const parsed = moment(date, 'YYYY-MM-DD', true);
      if (!parsed.isValid()) return true; // first refinement handles this
      return !parsed.isAfter(moment().add(7, 'days'));
    },
    {
      message: 'Payment date cannot be more than 7 days in the future',
      path: ['date']
    }
  );

const schema = z.object({
  // Wave-26 round-3f: was min(1). Form's payments[] is now drafts-only;
  // empty array is legitimate (user is just editing notes/discount, or
  // pressing Record to apply staged edits/deletes to saved tiles).
  // round-3j: rent-level description/promo/extracharge fields removed.
  // They now live per-payment in paymentSchema above.
  payments: z.array(paymentSchema)
});

// Wave-26 round-3g: default the new-draft date to today (ISO). Without
// this the user has to pop the calendar even when paying for a payment
// they're recording right now, which is the >95% case.
const _todayISO = () => moment().format('YYYY-MM-DD');
const emptyPayment = () => ({
  amount: '',
  date: _todayISO(),
  type: 'transfer',
  reference: '',
  // Wave-26 round-3j: per-payment fields default empty.
  description: '',
  promo: '',
  notepromo: '',
  extracharge: '',
  noteextracharge: ''
});

// Wave-26 round-3f: the form's payments[] now holds DRAFTS only — new
// payments the user is about to submit. Existing/saved payments are read
// from `rent.payments` directly and rendered as locked summary tiles
// outside the form. This eliminates the confusion where re-opening the
// dialog showed the existing payment in editable inputs and pressing
// "Εκτέλεση" appeared to do nothing (it submitted the same payment as
// a no-op replace).
// Wave-26 round-3j: form's `payments[]` holds drafts only and starts
// empty. Rent-level note/discount/extracharge fields are gone — those
// values are now per-payment and read from `rent.payments[i]` directly
// for saved tiles, or filled inline per draft when adding new payments.
function initialFormValues() {
  return {
    payments: []
  };
}

// Format a date string for display in the locked tile. Accepts both
// DD/MM/YYYY (rent.payments persisted format) and ISO YYYY-MM-DD.
function _formatDate(d) {
  if (!d) return '';
  let m = moment(d, 'DD/MM/YYYY', true);
  if (!m.isValid()) m = moment(d, 'YYYY-MM-DD', true);
  return m.isValid() ? m.format('L') : d;
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

// Wave-26 round-3f: inline edit form for an already-saved payment.
// Lives inside the locked tile when the user clicks ✏️. Changes are
// staged in component state and committed to `savedPayments` only when
// the user clicks Save. The user still has to press Εκτέλεση on the
// outer dialog to actually persist the change to the server.
function SavedPaymentEditForm({ initial, paymentTypes, onCancel, onSave, t }) {
  const [amount, setAmount] = useState(String(initial.amount ?? ''));
  // initial.date is the persisted DD/MM/YYYY format; convert to ISO
  // for the DatePickerInput's internal storage (YYYY-MM-DD).
  const isoFromInitial = initial.date
    ? moment(initial.date, 'DD/MM/YYYY', true).isValid()
      ? moment(initial.date, 'DD/MM/YYYY').format('YYYY-MM-DD')
      : ''
    : '';
  const [date, setDate] = useState(isoFromInitial);
  const [type, setType] = useState(initial.type || 'transfer');
  const [reference, setReference] = useState(initial.reference || '');

  const canSave =
    Number(amount) > 0 &&
    !!date &&
    moment(date, 'YYYY-MM-DD', true).isValid();

  return (
    <div>
      <div className="text-sm text-amber-700 mb-2">
        {t('Editing a recorded payment. Your changes are not saved until you press Record on the dialog.')}
      </div>
      <div className="grid gap-2 items-end grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label>{t('Date')}</Label>
          <DatePickerInput
            value={date ? moment(date, 'YYYY-MM-DD').format('DD/MM/YYYY') : ''}
            onChange={(d) => {
              const iso = d ? moment(d, 'DD/MM/YYYY').format('YYYY-MM-DD') : '';
              setDate(iso);
            }}
          />
        </div>
        <div className="space-y-1">
          <Label>{t('Type')}</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {paymentTypes.itemList.map((pt) => (
                <SelectItem
                  key={pt.id}
                  value={pt.value}
                  disabled={pt.disabled}
                  className={pt.disabled ? 'italic text-ink-muted' : undefined}
                >
                  {pt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {type !== 'cash' && (
          <div className="space-y-1">
            <Label>
              {type === 'cheque'
                ? t('Cheque no.')
                : type === 'transfer'
                  ? t('IBAN or transaction id')
                  : t('Reference')}
            </Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        )}
        <div className="space-y-1">
          <Label>{t('Amount')}</Label>
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSave}
          onClick={() =>
            onSave({
              amount: Number(amount),
              date: moment(date, 'YYYY-MM-DD').format('DD/MM/YYYY'),
              type,
              reference: type === 'cash' ? '' : reference,
              description: initial.description || ''
            })
          }
        >
          {t('Apply edit')}
        </Button>
      </div>
    </div>
  );
}

function PaymentTabs({ rent, onSubmit, onError }, ref) {
  const queryClient = useQueryClient();
  const store = useContext(StoreContext);
  const { t } = useTranslation('common');
  const paymentTypes = usePaymentTypes();
  const initVals = initialFormValues();
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

  // Wave-26 round-3f: saved payments are managed as a separate state list
  // (locked tiles), not as form fields. The form's `payments[]` array
  // becomes drafts-only. On submit we merge saved + drafts into the
  // payload sent to the server.
  //
  //   savedPayments — what the server currently has (mirror of rent.payments)
  //   editingIndex  — index of the saved payment being edited (or null)
  //   editingDraft  — temp form-state for the row being edited
  //   confirmingDelete — index of the saved payment pending deletion (or null)
  const [savedPayments, setSavedPayments] = useState(() =>
    (rent?.payments || [])
      .filter((p) => Number(p?.amount) > 0)
      .map((p) => ({
        amount: Number(p.amount) || 0,
        date: p.date || '',
        type: p.type || 'transfer',
        reference: p.reference || '',
        // Wave-26 round-3j: per-payment note/discount/extracharge.
        description: p.description || '',
        promo: Number(p.promo) || 0,
        notepromo: p.notepromo || '',
        extracharge: Number(p.extracharge) || 0,
        noteextracharge: p.noteextracharge || ''
      }))
  );
  const [editingIndex, setEditingIndex] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
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
      // Wave-26 (2): hard-block submission if the term is more than 3 months
      // in the future. The banner already warned the user; this is the
      // safety net.
      const _currentTerm = Number(
        moment.utc().startOf('month').format('YYYYMMDDHH')
      );
      const _rentTerm = Number(rent?.term || 0);
      if (_rentTerm > _currentTerm) {
        const _ahead = moment(String(_rentTerm).slice(0, 6) + '01').diff(
          moment().startOf('month'),
          'months'
        );
        if (_ahead > 3) {
          toast.error(
            t(
              'This term is {{count}} months in the future. Recording payments more than 3 months ahead is blocked.',
              { count: _ahead }
            )
          );
          onError?.();
          return;
        }
      }
      const clonedValues = _.cloneDeep(values);
      // Wave-26 round-3f: drafts come from the form (clonedValues.payments).
      // Existing/saved payments come from `savedPayments` state. We merge
      // the two so the server replaces the rent's payments[] with the
      // full intended ledger. Crucially this means: if no drafts AND
      // savedPayments matches what's already on disk, the server-side
      // state is identical and the request is a true no-op (idempotent).
      const drafts = clonedValues.payments
        .filter(({ amount }) => amount > 0)
        .map((payment, idx) => {
          payment.date = payment.date
            ? moment(payment.date).format('DD/MM/YYYY')
            : '';
          if (payment.type === 'cash') delete payment.reference;
          // Wave-25: attach allocation if user picked a non-auto mode.
          // allocState is keyed by useFieldArray field id; the submit
          // payload sees `values.payments[idx]` without ids, so we read
          // the matching field id from the closure.
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
          // mode === 'auto' (or unset): no allocation sent.
          return payment;
        });
      // savedPayments dates are already in DD/MM/YYYY (the persisted
      // format); drafts were converted above. Both are now in the
      // server-expected shape.
      clonedValues.payments = [...savedPayments, ...drafts];

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
        // Wave-26 round-3f: toast amount is the sum of NEW drafts
        // submitted (not the full ledger) — that's what the user
        // intuitively just "added". For pure edits or notes-only
        // saves the toast falls back to a generic "Saved".
        const _sum = drafts.reduce(
          (s, p) => s + (Number(p?.amount) || 0),
          0
        );
        if (_sum > 0) {
          toast.success(
            t('Payment of {{amount}}€ recorded', {
              amount: _sum.toFixed(2)
            })
          );
        } else {
          toast.success(t('Saved'));
        }
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
      allocState,
      savedPayments
    ]
  );

  const payments = watch('payments');

  // Wave-26 (2): future-term safeguard. The data model accepts payments on
  // any term (Wave-14 F3 only blocks dates >7d future). A typo recording
  // September's payment in May silently inflates this year's revenue,
  // poisons the dashboard, and prints a "paid" receipt for September.
  // We allow up to 3 months ahead (real use case for advance payments)
  // and block beyond.
  const currentTerm = Number(
    moment.utc().startOf('month').format('YYYYMMDDHH')
  );
  const rentTerm = Number(rent?.term || 0);
  const monthsAhead =
    rentTerm > currentTerm
      ? moment(String(rentTerm).slice(0, 6) + '01').diff(
          moment().startOf('month'),
          'months'
        )
      : 0;
  const isFutureTermAllowed = monthsAhead > 0 && monthsAhead <= 3;
  const isFutureTermBlocked = monthsAhead > 3;

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit(_handleSubmit, (errs) => {
        // Wave-26 round-3c: surface validation failures as a toast so
        // they're not silent. Without this, zod-rejected submits left
        // the parent dialog stuck on "Saving" with no explanation.
        const firstMsg =
          errs?.payments?.[0]?.date?.message ||
          errs?.payments?.[0]?.amount?.message ||
          errs?.payments?.[0]?.type?.message ||
          errs?.payments?.message ||
          Object.values(errs || {})[0]?.message;
        toast.error(
          firstMsg ? t(firstMsg) : t('Please complete required fields')
        );
        onError?.();
      })}
      autoComplete="off"
    >
      <div className="space-y-4">
        <Card>
          <CardHeader className="text-lg px-6 pt-3 pb-0">{t('Payment')}</CardHeader>
          <CardContent>
            {/* Wave-26 round-3f: future-term safeguard banners (the
                pre-fill banner is gone — saved payments now render as
                locked tiles below, so there's nothing to be confused
                about). */}
            {isFutureTermAllowed && (
              <div className="mb-3 p-2 rounded border border-amber-200 bg-amber-50 text-amber-700 text-sm" data-cy="futureTermBanner">
                {t(
                  'Recording an advance payment for a term {{count}} month(s) in the future. Make sure the term is correct before saving.',
                  { count: monthsAhead }
                )}
              </div>
            )}
            {isFutureTermBlocked && (
              <div className="mb-3 p-2 rounded border border-oxide/40 bg-oxide/10 text-oxide text-sm" data-cy="futureTermBlockedBanner">
                {t(
                  'This term is {{count}} months in the future. Recording payments more than 3 months ahead is blocked to avoid accidental writes.',
                  { count: monthsAhead }
                )}
              </div>
            )}

            {/* Locked tiles — already-recorded payments. Read-only.
                Edit/delete via the icon buttons. When editingIndex
                matches, the tile expands inline into an edit form. */}
            {savedPayments.length > 0 && (
              <div className="space-y-2 mb-3" data-cy="savedPaymentsList">
                {savedPayments.map((sp, sidx) => {
                  const isEditing = editingIndex === sidx;
                  return (
                    <div
                      key={`saved-${sidx}`}
                      className={cn(
                        'border rounded-md',
                        isEditing
                          ? 'border-amber-300 bg-amber-50 p-3'
                          : 'border-olive/30 bg-olive/5 p-3'
                      )}
                      data-cy={`savedPayment-${sidx}`}
                    >
                      {!isEditing ? (
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex-1 min-w-0 text-sm">
                            <div className="font-medium">
                              <NumberFormat value={sp.amount} />
                              <span className="text-ink-muted font-normal">
                                {' · '}
                                {_formatDate(sp.date)}
                                {' · '}
                                {t(
                                  (sp.type || 'transfer')[0].toUpperCase() +
                                    (sp.type || 'transfer').slice(1)
                                )}
                                {sp.reference ? ` · ${sp.reference}` : ''}
                              </span>
                            </div>
                            {/* Wave-26 round-3j: surface per-payment
                                note/discount/extra-charge attached to this
                                saved tile, if any. */}
                            {sp.description ? (
                              <div className="mt-1 text-xs text-ink-muted italic">
                                {t('Note')}: {sp.description}
                              </div>
                            ) : null}
                            {Number(sp.promo) > 0 ? (
                              <div className="mt-0.5 text-xs text-olive">
                                {t('Discount')}:{' '}
                                <NumberFormat value={Number(sp.promo)} />
                                {sp.notepromo ? ` · ${sp.notepromo}` : ''}
                              </div>
                            ) : null}
                            {Number(sp.extracharge) > 0 ? (
                              <div className="mt-0.5 text-xs text-oxide">
                                {t('Additional cost')}:{' '}
                                <NumberFormat value={Number(sp.extracharge)} />
                                {sp.noteextracharge
                                  ? ` · ${sp.noteextracharge}`
                                  : ''}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => setEditingIndex(sidx)}
                              data-cy={`editSavedPayment-${sidx}`}
                              aria-label={t('Edit')}
                            >
                              <LuPencil className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => setConfirmingDelete(sidx)}
                              data-cy={`deleteSavedPayment-${sidx}`}
                              aria-label={t('Delete')}
                            >
                              <LuTrash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <SavedPaymentEditForm
                          initial={sp}
                          paymentTypes={paymentTypes}
                          onCancel={() => setEditingIndex(null)}
                          onSave={(updated) => {
                            setSavedPayments((prev) => {
                              const next = [...prev];
                              next[sidx] = updated;
                              return next;
                            });
                            setEditingIndex(null);
                            toast.success(t('Edited (will save when you press Record)'));
                          }}
                          t={t}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Empty-state caption when nothing saved AND no draft yet. */}
            {savedPayments.length === 0 && fields.length === 0 && (
              <div className="mb-3 p-2 rounded border border-stone-line/40 bg-muted/30 text-muted-foreground text-sm" data-cy="noPaymentBanner">
                {t('No payment recorded yet for this term.')}
              </div>
            )}

            {/* Draft entry rows (form's payments[] — new entries only). */}
            {fields.map((field, index) => (
              <div key={field.id} className="mb-4 p-3 border rounded-md bg-bone">
                <div className="flex justify-between items-center mb-2">
                  <div className="font-medium">{t('New payment')}</div>
                  <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} aria-label={t('Cancel')}>
                    <LuTrash2 className="size-4" />
                  </Button>
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
                          <SelectItem
                            key={pt.id}
                            value={pt.value}
                            disabled={pt.disabled}
                            className={pt.disabled ? 'italic text-ink-muted' : undefined}
                          >
                            {pt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {payments?.[index]?.type !== 'cash' && (
                    <div className="space-y-1">
                      <Label htmlFor={`payments.${index}.reference`}>
                        {payments?.[index]?.type === 'cheque'
                          ? t('Cheque no.')
                          : payments?.[index]?.type === 'transfer'
                            ? t('IBAN or transaction id')
                            : t('Reference')}
                      </Label>
                      <Input
                        id={`payments.${index}.reference`}
                        {...register(`payments.${index}.reference`)}
                      />
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

                {/* Wave-26 round-3j: per-payment Note / Discount / Extra-charge.
                    Collapsed by default. Saving with these fields populated
                    attaches them to this specific payment, not the rent. */}
                <div className="mt-3 space-y-2">
                  <Collapse title={t('Note')}>
                    <div className="space-y-1">
                      <Label htmlFor={`payments.${index}.description`}>
                        {t('Note (only visible to landlord)')}
                      </Label>
                      <Textarea
                        id={`payments.${index}.description`}
                        {...register(`payments.${index}.description`)}
                      />
                    </div>
                  </Collapse>
                  <Collapse title={t('Discount')}>
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <Label htmlFor={`payments.${index}.promo`}>
                          {t('Amount')}
                        </Label>
                        <Input
                          id={`payments.${index}.promo`}
                          type="number"
                          {...register(`payments.${index}.promo`)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`payments.${index}.notepromo`}>
                          {t('Description (visible to tenant)')}
                        </Label>
                        <Textarea
                          id={`payments.${index}.notepromo`}
                          {...register(`payments.${index}.notepromo`)}
                        />
                      </div>
                    </div>
                  </Collapse>
                  <Collapse title={t('Additional cost')}>
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <Label htmlFor={`payments.${index}.extracharge`}>
                          {t('Amount')}
                        </Label>
                        <Input
                          id={`payments.${index}.extracharge`}
                          type="number"
                          {...register(`payments.${index}.extracharge`)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`payments.${index}.noteextracharge`}>
                          {t('Description (visible to tenant)')}
                        </Label>
                        <Textarea
                          id={`payments.${index}.noteextracharge`}
                          {...register(`payments.${index}.noteextracharge`)}
                        />
                      </div>
                    </div>
                  </Collapse>
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() => append(emptyPayment())}
              data-cy="addNewPayment"
            >
              <LuPlus className="size-4 mr-1" />
              {savedPayments.length > 0 || fields.length > 0
                ? t('Add another payment')
                : t('Add a payment')}
            </Button>
          </CardContent>
        </Card>

      </div>

      {/* Wave-26 round-3f: delete confirmation for an already-saved
          payment. Removing it from `savedPayments` is staged; nothing
          is persisted to the server until the user presses Εκτέλεση
          on the outer dialog. */}
      <ConfirmDialog
        title={t('Delete this recorded payment?')}
        subTitle={
          confirmingDelete != null && savedPayments[confirmingDelete]
            ? `${savedPayments[confirmingDelete].amount}€ · ${_formatDate(
                savedPayments[confirmingDelete].date
              )}`
            : ''
        }
        open={confirmingDelete != null}
        setOpen={(open) => {
          if (!open) setConfirmingDelete(null);
        }}
        onConfirm={() => {
          const idx = confirmingDelete;
          if (idx == null) return;
          setSavedPayments((prev) => prev.filter((_, i) => i !== idx));
          setConfirmingDelete(null);
          toast.success(
            t('Removed (will save when you press Record)')
          );
        }}
      />
    </form>
  );
}

export default forwardRef(PaymentTabs);
