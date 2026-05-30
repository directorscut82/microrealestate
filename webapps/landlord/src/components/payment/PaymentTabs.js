import { Card, CardContent, CardHeader } from '../ui/card';
import {
  forwardRef,
  useCallback,
  useEffect,
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
import { computeCategoryOwed } from '../../utils/paymentAllocation';
import AllocationBlock from './AllocationBlock';
import SavedPaymentEditForm from './SavedPaymentEditForm';
import { toast } from 'sonner';
import usePaymentTypes from '../../hooks/usePaymentTypes';
import { useQueryClient } from '@tanstack/react-query';
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
// Wave-26 round-3r: render a payment's allocation breakdown as a
// compact " (Rent 67 · Insurance 53)" string. Skips zero-amount
// entries. Single-category case collapses to "(Rent)" without
// per-amount detail. Caller-supplied `t` does the i18n.
function _formatAllocation(allocation, t) {
  if (!Array.isArray(allocation) || allocation.length === 0) return '';
  const labelMap = {
    rent: 'Rent',
    expenses: 'Building expenses',
    repairs: 'Repairs',
    vat: 'VAT',
    previousBalance: 'Previous balance',
    extracharge: 'Extra charge'
  };
  const nonZero = allocation.filter((a) => Number(a?.amount) > 0.005);
  if (nonZero.length === 0) return '';
  if (nonZero.length === 1) {
    return ` (${t(labelMap[nonZero[0].category] || nonZero[0].category)})`;
  }
  const _fmtAmt = (n) => {
    const num = Number(n) || 0;
    return Number.isInteger(num) ? String(num) : num.toFixed(2);
  };
  const parts = nonZero.map(
    (a) =>
      `${t(labelMap[a.category] || a.category)} ${_fmtAmt(a.amount)}`
  );
  return ` (${parts.join(' · ')})`;
}

function _formatDate(d) {
  if (!d) return '';
  let m = moment(d, 'DD/MM/YYYY', true);
  if (!m.isValid()) m = moment(d, 'YYYY-MM-DD', true);
  return m.isValid() ? m.format('L') : d;
}

// Wave-26 round-3o: AllocationBlock + SavedPaymentEditForm extracted to
// dedicated files so this module stays under 1000 lines and the sub-
// components can be tested independently. See AllocationBlock.js and
// SavedPaymentEditForm.js in the same directory.

function PaymentTabs({ rent, onSubmit, onError, lockDateToToday = false }, ref) {
  const queryClient = useQueryClient();
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
  // Wave-26 round-3s: derive savedPayments from rent.payments via
  // useMemo (was useState with init, which only ran once on mount).
  // When the parent re-feeds a fresh `rent` after a payment-record
  // invalidation, the saved tiles must reflect the new payments,
  // including any newly-attached promo/extracharge/notes.
  const _normalizedRentPayments = useMemo(
    () =>
      (rent?.payments || [])
        .filter((p) => Number(p?.amount) > 0)
        .map((p) => ({
          amount: Number(p.amount) || 0,
          date: p.date || '',
          type: p.type || 'transfer',
          reference: p.reference || '',
          description: p.description || '',
          promo: Number(p.promo) || 0,
          notepromo: p.notepromo || '',
          extracharge: Number(p.extracharge) || 0,
          noteextracharge: p.noteextracharge || '',
          allocation: Array.isArray(p.allocation) ? p.allocation : []
        })),
    [rent?.payments]
  );
  const [savedPayments, setSavedPayments] = useState(_normalizedRentPayments);
  // Sync local edits with fresh server state when the rent prop
  // changes (e.g. after a save invalidates queries and the parent
  // re-renders with new data). Local edits during dialog session
  // ARE preserved within the same `rent.payments` snapshot — only
  // a genuinely-different snapshot triggers re-init.
  useEffect(() => {
    setSavedPayments(_normalizedRentPayments);
  }, [_normalizedRentPayments]);
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
    formState: { isDirty, isSubmitting }
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
      // Wave-26 round-3o: client-side guard against payment dates BEFORE
      // the rent term's first day. Prevents a misclick on the wrong
      // month's rents page from silently recording an April payment
      // under May's term. Server enforces the same rule (rentmanager.ts
      // F3) — this is a UX-friendly early surface.
      const _termStr = String(rent?.term || '');
      const _termFirstDay =
        _termStr.length === 10
          ? moment.utc(
              `${_termStr.slice(0, 4)}-${_termStr.slice(4, 6)}-01`,
              'YYYY-MM-DD',
              true
            )
          : null;
      const _draftValues = values?.payments || [];
      for (const _draft of _draftValues) {
        if (!_draft?.date || Number(_draft?.amount) <= 0) continue;
        const _parsed = moment(_draft.date, 'YYYY-MM-DD', true);
        if (
          _termFirstDay &&
          _termFirstDay.isValid() &&
          _parsed.isValid() &&
          _parsed.isBefore(_termFirstDay)
        ) {
          toast.error(
            t(
              'Payment date is before this rent month. Switch to that month’s rents page to record against it.'
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

      // Wave-26 round-3o: detect whether the submit actually changes
      // anything before firing a success toast. A no-op Record (no
      // drafts, saved tiles unchanged from the original rent) used to
      // toast 'Saved successfully' anyway — confusing because the user
      // didn't change anything. Now we toast on:
      //   - new drafts submitted   -> 'Payment of {amount} recorded'
      //   - savedPayments changed  -> 'Saved'
      //   - neither                -> nothing (silent close)
      const _sum = drafts.reduce(
        (s, p) => s + (Number(p?.amount) || 0),
        0
      );
      const _origPayments = (rent?.payments || []).filter(
        (p) => Number(p?.amount) > 0
      );
      const _savedTilesChanged =
        savedPayments.length !== _origPayments.length ||
        savedPayments.some((sp, i) => {
          const op = _origPayments[i] || {};
          return (
            Number(sp.amount) !== Number(op.amount) ||
            sp.date !== op.date ||
            sp.type !== op.type ||
            (sp.reference || '') !== (op.reference || '')
          );
        });
      try {
        await payRent({ term: String(rent.term), payment });
        // Invalidate via prefix so all rent periods, dashboards, tenants and
        // accounting screens refetch (no specific period to keep stale).
        queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
        if (_sum > 0) {
          toast.success(
            t('Payment of {{amount}}€ recorded', {
              amount: _sum.toFixed(2)
            })
          );
        } else if (_savedTilesChanged) {
          toast.success(t('Saved'));
        }
        // No toast when there was nothing to save.
        onSubmit?.();
      } catch (error) {
        // Wave-26 round-3o: surface the API's actual error message
        // (e.g. 'payments[0].promo cannot exceed grand total') instead
        // of the generic 'Something went wrong' banner. Only fall back
        // to the generic message when the server didn't send one.
        // eslint-disable-next-line no-console
        console.error(error);
        const apiMsg =
          error?.response?.data?.message ||
          error?.response?.data?.error ||
          (typeof error?.response?.data === 'string'
            ? error.response.data
            : null);
        toast.error(apiMsg ? String(apiMsg) : t('Something went wrong'));
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
                              {/* Wave-26 round-3r: allocation breakdown
                                  inline so the saved tile says exactly
                                  what the money paid for. */}
                              <span className="text-ink-soft font-normal">
                                {_formatAllocation(sp.allocation, t)}
                              </span>
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
                      paymentContext={!lockDateToToday}
                      disabled={lockDateToToday}
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
