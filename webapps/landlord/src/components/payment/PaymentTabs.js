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
import {
  applyAllocation,
  computeOwedLines
} from '../../utils/paymentAllocation';
import { BUILDING_TYPE_LABEL_KEY } from '../../utils/lineLabels';
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
      // Both sides parsed in UTC. Mixing LOCAL and UTC moments here
      // produced off-by-one rejections at midnight on UTC+2/+3 — the
      // same family of timezone bugs documented in CLAUDE.md (June 2026).
      if (!date || amount == null || amount <= 0) return true;
      const parsed = moment.utc(date, 'YYYY-MM-DD', true);
      if (!parsed.isValid()) return true; // first refinement handles this
      return !parsed.isAfter(moment.utc().add(7, 'days'));
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
// B1: per-allocation-entry display info. Each entry produces one
// stacked bullet under the payment's amount/date/type line, formatted
// as "Πληρωμή <category> (<source description if any>): <amount>".
//
// Resolution strategy for the parenthetical (<source description>):
//   1. Decode the lineKey (preTax:i / charges:i / building:i) to read
//      rent.preTaxAmounts[i] / rent.charges[i] / rent.buildingCharges[i]
//      directly. Works whether or not the line is still in owedLines
//      (which filters out fully-paid lines).
//   2. If rent doesn't carry the source array entry, fall back to
//      owedLines.find by lineKey.
//   3. For scalar lineKeys (previousBalance / vat / extracharge),
//      there is no source description — render no parenthetical.
//
// Building lines additionally include the type label (e.g. "Insurance")
// after the description: "(τεστε — Ασφάλιση)".
const _CATEGORY_LEAD_KEY = {
  rent: 'Payment of rent',
  propertyCharge: 'Payment of property charge',
  buildingCharge: 'Payment of building charge',
  repair: 'Payment of repair',
  previousBalance: 'Payment of previous balance',
  vat: 'Payment of VAT',
  extracharge: 'Payment of extra charge',
  // Legacy pre-B1 payments (no lineKey). "expenses" used to be the
  // catch-all bucket for both property-charge and building-charge,
  // so we cannot infer which one the landlord intended. Render a
  // generic lead instead of guessing.
  expenses: 'Payment of charge',
  repairs: 'Payment of repair'
};

// Map `building:<type>` enum to a t-able localized label. Used for the
// per-bullet parenthetical's type-suffix. Re-uses the canonical map
// in utils/lineLabels.js — previously this file declared its own copy
// where `monthly_charge` mapped to 'Building charges' while the shared
// map mapped it to 'Other', so the same building-charge type rendered
// with two different labels depending on which surface displayed it
// (Πρόγραμμα/RentTable used the shared map; PaymentTabs saved-tile
// bullets used the local copy).
const _BUILDING_TYPE_LABEL_KEY = BUILDING_TYPE_LABEL_KEY;

function _resolveLineSource(allocationEntry, rent, owedLines) {
  const lineKey = allocationEntry?.lineKey;
  if (!lineKey) {
    // Wave-26 round-3v: legacy allocations (pre-B1) have no lineKey. Derive
    // a best-effort source description from the rent's category arrays so
    // the saved-tile bullet shows a meaningful paren instead of being blank.
    // The legacy "expenses" bucket is ambiguous (could map to either
    // rent.charges or rent.buildingCharges), so we leave its paren empty;
    // its lead is already 'Πληρωμή χρέωσης' which is acceptable on its own.
    const category = String(allocationEntry?.category || '');
    if (rent) {
      if (category === 'rent') {
        const entry = (rent.preTaxAmounts || [])[0];
        return {
          description: String(entry?.description || ''),
          typeLabel: '',
          buildingName: ''
        };
      }
      if (category === 'propertyCharge') {
        const entry = (rent.charges || [])[0];
        return {
          description: String(entry?.description || ''),
          typeLabel: '',
          buildingName: ''
        };
      }
      if (category === 'buildingCharge') {
        const entry = (rent.buildingCharges || [])[0];
        return {
          description: String(entry?.description || ''),
          typeLabel: entry?.type ? String(entry.type) : '',
          buildingName: String(entry?.buildingName || '')
        };
      }
      if (category === 'repair') {
        const list = rent.buildingCharges || [];
        const entry =
          list.find((b) => String(b?.type || '') === 'repair') || list[0];
        return {
          description: String(entry?.description || ''),
          typeLabel: entry?.type ? String(entry.type) : '',
          buildingName: String(entry?.buildingName || '')
        };
      }
    }
    return { description: '', typeLabel: '', buildingName: '' };
  }
  if (rent) {
    const preTaxMatch = lineKey.match(/^preTax:(\d+)$/);
    if (preTaxMatch) {
      const idx = Number(preTaxMatch[1]);
      const entry = (rent.preTaxAmounts || [])[idx];
      return {
        description: String(entry?.description || ''),
        typeLabel: '',
        buildingName: ''
      };
    }
    const chargesMatch = lineKey.match(/^charges:(\d+)$/);
    if (chargesMatch) {
      const idx = Number(chargesMatch[1]);
      const entry = (rent.charges || [])[idx];
      return {
        description: String(entry?.description || ''),
        typeLabel: '',
        buildingName: ''
      };
    }
    const buildingMatch = lineKey.match(/^building:(\d+)$/);
    if (buildingMatch) {
      const idx = Number(buildingMatch[1]);
      const entry = (rent.buildingCharges || [])[idx];
      return {
        description: String(entry?.description || ''),
        typeLabel: entry?.type ? String(entry.type) : '',
        buildingName: String(entry?.buildingName || '')
      };
    }
  }
  if (Array.isArray(owedLines)) {
    const line = owedLines.find((l) => l.lineKey === lineKey);
    if (line) {
      return {
        description: String(line.description || ''),
        typeLabel: line.type ? String(line.type) : '',
        buildingName: String(line.buildingName || '')
      };
    }
  }
  return { description: '', typeLabel: '', buildingName: '' };
}

function _allocationBullet(entry, t, rent, owedLines) {
  const category = String(entry?.category || '');
  const baseLead = t(_CATEGORY_LEAD_KEY[category] || 'Payment of rent');
  const { description, typeLabel, buildingName } = _resolveLineSource(
    entry,
    rent,
    owedLines
  );
  const isScalar =
    category === 'previousBalance' ||
    category === 'vat' ||
    category === 'extracharge';
  // Wave-26 round-3u: building/repair bullets — append the localized type
  // label to the lead AND render the paren as `(<buildingName> - <description>)`,
  // mirroring the row format on the Πρόγραμμα tile.
  if (
    !isScalar &&
    (category === 'buildingCharge' || category === 'repair') &&
    typeLabel
  ) {
    const typeKey = _BUILDING_TYPE_LABEL_KEY[typeLabel] || typeLabel;
    const localizedType = t(typeKey);
    const lead =
      localizedType && localizedType !== typeKey
        ? `${baseLead} - ${localizedType}`
        : baseLead;
    let paren = '';
    if (buildingName && description) paren = ` (${buildingName} - ${description})`;
    else if (buildingName) paren = ` (${buildingName})`;
    else if (description) paren = ` (${description})`;
    return { lead, paren };
  }
  let paren = '';
  if (!isScalar && description) paren = ` (${description})`;
  return { lead: baseLead, paren };
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
  // Clear edit/delete-confirmation UI state when the dialog is fed a
  // different rent (RentTable.liveSelectedRent re-derives on each
  // open). Without this, opening the dialog on tenant A, clicking
  // edit on a saved tile, closing the dialog, and reopening on
  // tenant B would keep editingIndex pointing into B's tile array
  // by old index — possibly out of bounds, possibly the wrong row.
  useEffect(() => {
    setEditingIndex(null);
    setConfirmingDelete(null);
  }, [rent?._id, rent?.term]);
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

  // E8: the preview must reflect what the SAVED payments have already
  // consumed. Without this seed the AllocationBlock kept advertising the
  // gross owed-line amounts even after a payment had landed against a
  // specific line — users would over-allocate the next payment and only
  // see the discrepancy after submit. Reduce each line by what the
  // already-saved payments allocated to it before handing it to the
  // block.
  const owedLines = useMemo(() => {
    const baseLines = computeOwedLines(rent);
    const savedAllocations = (savedPayments || [])
      .flatMap((sp) =>
        Array.isArray(sp?.allocation) ? sp.allocation : []
      )
      .filter((a) => a && Number(a.amount) > 0);
    if (savedAllocations.length === 0) return baseLines;
    const { remainingLines } = applyAllocation(baseLines, savedAllocations);
    return remainingLines;
  }, [rent, savedPayments]);

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
        const _ahead = moment
          .utc(String(_rentTerm).slice(0, 6) + '01', 'YYYYMMDD')
          .diff(moment.utc().startOf('month'), 'months');
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
      // Wave-26 round-3o + 3t: client-side guard against payment dates
      // OUTSIDE this rent month (with a 7-day cushion after term end).
      // Prevents a misclick on the wrong month's rents page from
      // silently recording an April payment under May's term — and
      // catches the previously-missed forward case (date in May while
      // recording against April) which produced negative grandTotals.
      // Server enforces the same rule.
      const _termStr = String(rent?.term || '');
      const _termFirstDay =
        _termStr.length === 10
          ? moment.utc(
              `${_termStr.slice(0, 4)}-${_termStr.slice(4, 6)}-01`,
              'YYYY-MM-DD',
              true
            )
          : null;
      const _termLastDay = _termFirstDay
        ? _termFirstDay.clone().endOf('month').add(7, 'days')
        : null;
      const _draftValues = values?.payments || [];
      for (const _draft of _draftValues) {
        if (!_draft?.date || Number(_draft?.amount) <= 0) continue;
        const _parsed = moment.utc(_draft.date, 'YYYY-MM-DD', true);
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
        if (
          _termLastDay &&
          _termLastDay.isValid() &&
          _parsed.isValid() &&
          _parsed.isAfter(_termLastDay)
        ) {
          toast.error(
            t(
              'Payment date is after this rent month. Switch to that month’s rents page to record against it.'
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
      // Pair every payment with its source field-array index BEFORE
      // filtering by amount. Filtering after-the-fact and using the
      // post-filter index would mismatch fields[idx] when blank
      // drafts precede real ones — the wrong field's allocState
      // would attach to the submitted payment.
      const drafts = clonedValues.payments
        .map((payment, originalIdx) => ({ payment, originalIdx }))
        .filter(({ payment }) => payment.amount > 0)
        .map(({ payment, originalIdx }) => {
          payment.date = payment.date
            ? moment(payment.date).format('DD/MM/YYYY')
            : '';
          if (payment.type === 'cash') delete payment.reference;
          // B1: per-line allocation. allocState's specificCategory and
          // custom-keyed entries are LINE KEYS (e.g. 'preTax:0',
          // 'charges:1', 'building:0', 'previousBalance', 'vat',
          // 'extracharge'). Resolve each lineKey back to the owedLine
          // so we can persist {category, lineKey, amount}. Server
          // attributes by lineKey directly (no prorate).
          const fieldKey = fields[originalIdx]?.id;
          const aState = (fieldKey && allocState[fieldKey]) || {};
          const amt = Number(payment.amount) || 0;
          const lineByKey = (k) =>
            (owedLines || []).find((l) => l.lineKey === k);
          if (aState.mode === 'specific' && aState.specificCategory && amt > 0) {
            const line = lineByKey(aState.specificCategory);
            if (line) {
              payment.allocation = [
                {
                  category: line.category,
                  lineKey: line.lineKey,
                  amount: amt
                }
              ];
            }
          } else if (aState.mode === 'custom' && aState.custom) {
            const allocation = Object.entries(aState.custom)
              .map(([lineKey, value]) => {
                const line = lineByKey(lineKey);
                if (!line) return null;
                return {
                  category: line.category,
                  lineKey: line.lineKey,
                  amount: Number(value) || 0
                };
              })
              .filter((a) => a && a.amount > 0);
            if (allocation.length) payment.allocation = allocation;
          }
          // mode === 'auto' (or unset): no allocation sent — server
          // auto-spreads.
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
        // Block the close path on the rents refetch. invalidateQueries is
        // fire-and-forget; closing the drawer immediately after it leaves
        // the user staring at a row that still shows the OLD Payment cell
        // for ~500-1500ms (network round-trip). They assume the click
        // failed and click Record again — that is the duplicate-payment
        // class of bug. Awaiting refetchQueries here guarantees the cache
        // holds fresh data BEFORE the drawer closes. ExpressPaymentDialog
        // uses the same pattern.
        await queryClient.refetchQueries({ queryKey: [QueryKeys.RENTS] });
        // Cross-screen caches refresh in the background — the user is on
        // /rents; dashboard / tenants / accounting will be fresh on the
        // next time they're viewed.
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
  // Both moments must be UTC to match the term math above (which uses
  // moment.utc().format('YYYYMMDDHH')). Mixing LOCAL with UTC here was
  // off-by-one near midnight on positive-offset timezones — at 23:30
  // local on the last day of the month, moment().startOf('month') was
  // still on the *current* local month while currentTerm had already
  // ticked over to the next UTC month, computing monthsAhead = -1.
  const monthsAhead =
    rentTerm > currentTerm
      ? moment.utc(String(rentTerm).slice(0, 6) + '01', 'YYYYMMDD').diff(
          moment.utc().startOf('month'),
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
                            {/* B1: stacked bullets — one per allocation
                                entry. Each line reads
                                "Πληρωμή <category> (<source description
                                — type if building>): <amount>". Always
                                rendered when allocation is present, even
                                for single-entry allocations. */}
                            {Array.isArray(sp.allocation) &&
                            sp.allocation.length > 0 ? (
                              <div className="mt-1 space-y-0.5 text-xs text-ink-soft">
                                {sp.allocation
                                  .filter(
                                    (a) => Number(a?.amount) > 0.005
                                  )
                                  .map((a, ai) => {
                                    const { lead, paren } =
                                      _allocationBullet(a, t, rent, owedLines);
                                    return (
                                      <div
                                        key={ai}
                                        className="leading-snug"
                                      >
                                        <span className="text-ink-muted">
                                          {'↳ '}
                                        </span>
                                        {lead}
                                        {paren}
                                        {': '}
                                        <span className="tabular-nums">
                                          <NumberFormat
                                            value={Number(a.amount)}
                                          />
                                        </span>
                                      </div>
                                    );
                                  })}
                              </div>
                            ) : null}
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
                    owedLines={owedLines}
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
