import {
  addBuildingExpense,
  fetchTenants,
  QueryKeys,
  updateBuildingExpense
} from '../../utils/restcalls';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import ResponsiveDialog from '../ResponsiveDialog';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import useTranslation from 'next-translate/useTranslation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const expenseSchema = z
  .object({
    name: z.string().min(1).max(200),
    type: z.string().min(1),
    amount: z.coerce.number().min(0).max(10000000).optional().default(0),
    allocationMethod: z.string().min(1),
    isRecurring: z.boolean(),
    trackOwnerExpense: z.boolean().optional().default(false),
    ownerAmount: z.coerce.number().min(0).max(10000000).optional().default(0),
    chargeOwnerWhenVacant: z.boolean().optional().default(false),
    startFromCurrentMonth: z.boolean().optional().default(true),
    notes: z.string().max(5000).optional(),
    billingId: z.string().optional(),
    customAllocations: z
      .array(
        z.object({
          propertyId: z.string(),
          value: z.coerce.number().min(0).default(0)
        })
      )
      .optional()
      .default([])
  })
  .superRefine((data, ctx) => {
    if (!data.isRecurring && (!data.amount || data.amount <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Amount is required for non-recurring expenses',
        path: ['amount']
      });
    }
    if (
      data.allocationMethod === 'custom_percentage' &&
      data.customAllocations?.length
    ) {
      const sum = data.customAllocations.reduce(
        (s, a) => s + (a.value || 0),
        0
      );
      if (Math.abs(sum - 100) > 0.01) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Percentages must sum to 100% (currently ${sum.toFixed(1)}%)`,
          path: ['customAllocations']
        });
      }
    }
    if (
      data.allocationMethod === 'custom_ratio' &&
      data.customAllocations?.length
    ) {
      const total = data.customAllocations.reduce(
        (s, a) => s + (a.value || 0),
        0
      );
      if (total <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'At least one unit must have a non-zero ratio',
          path: ['customAllocations']
        });
      }
    }
    // 'fixed' bills each unit a predefined per-unit amount (the
    // customAllocations values ARE euros, not %/ratio). A fixed expense with
    // no allocations, or all-zero values, charges nobody — a 'σταθερό' with
    // zero ποσό is meaningless. Require at least one positive per-unit amount.
    if (data.allocationMethod === 'fixed') {
      const total = (data.customAllocations || []).reduce(
        (s, a) => s + (Number(a.value) || 0),
        0
      );
      if (!(total > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Fixed allocation needs at least one unit with a non-zero amount',
          path: ['customAllocations']
        });
      }
    }
    // F4-expense: single_unit MUST have a target unit picked. Without
    // this guard the form passes zod with customAllocations=[] and the
    // expense persists with nobody to bill. The pipeline at
    // 1_base.ts:355-364 returns 0 share for every unit silently.
    if (data.allocationMethod === 'single_unit') {
      const target = data.customAllocations?.[0];
      if (!target?.propertyId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Pick a unit to bill',
          path: ['customAllocations']
        });
      }
    }
    // F6-expense: custom_percentage / custom_ratio with empty
    // customAllocations should also fail validation (the existing checks
    // gate on length > 0, so length=0 silently bypassed both branches).
    if (
      (data.allocationMethod === 'custom_percentage' ||
        data.allocationMethod === 'custom_ratio') &&
      !(data.customAllocations?.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Custom allocations require at least one positive entry',
        path: ['customAllocations']
      });
    }
  });

const expenseTypes = [
  { id: 'heating', labelId: 'Heating' },
  { id: 'elevator', labelId: 'Elevator' },
  { id: 'cleaning', labelId: 'Cleaning' },
  { id: 'water_common', labelId: 'Water Common' },
  { id: 'electricity_common', labelId: 'Electricity Common' },
  { id: 'insurance', labelId: 'Insurance' },
  { id: 'management_fee', labelId: 'Management Fee' },
  { id: 'garden', labelId: 'Garden' },
  { id: 'repairs_fund', labelId: 'Repairs Fund' },
  { id: 'pest_control', labelId: 'Pest Control' },
  { id: 'other', labelId: 'Other' }
];

const allocationMethods = [
  { id: 'general_thousandths', labelId: 'General Thousandths' },
  { id: 'heating_thousandths', labelId: 'Heating Thousandths' },
  { id: 'elevator_thousandths', labelId: 'Elevator Thousandths' },
  { id: 'equal', labelId: 'Equal' },
  { id: 'by_surface', labelId: 'By Surface' },
  { id: 'fixed', labelId: 'Fixed' },
  { id: 'custom_ratio', labelId: 'Custom Ratio' },
  { id: 'custom_percentage', labelId: 'Custom Percentage' },
  { id: 'single_unit', labelId: 'Single Unit' }
];

const ALLOCATION_DESCRIPTIONS = {
  equal: 'Split equally among all units',
  by_surface: 'Split proportionally by unit surface area (m²)',
  general_thousandths: 'Split by general thousandths (‰) from E9',
  heating_thousandths: 'Split by heating thousandths (‰) from E9',
  elevator_thousandths:
    'Split by elevator thousandths (‰) — ground floor excluded',
  fixed: 'Each unit pays a fixed predefined amount',
  custom_ratio: 'Split by custom ratio shares you defined per unit',
  custom_percentage: 'Each unit pays a custom percentage of the total',
  single_unit: 'Bill the whole expense to one specific unit'
};

const ALLOCATION_METHODS_BY_TYPE = {
  heating: [
    'heating_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ],
  elevator: [
    'elevator_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ],
  cleaning: [
    'general_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ],
  water_common: [
    'general_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ],
  electricity_common: [
    'general_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ],
  insurance: [
    'general_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ],
  management_fee: [
    'general_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ],
  garden: [
    'general_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ],
  repairs_fund: [
    'general_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ],
  pest_control: [
    'general_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ]
};

// κυμαινόμενο (variable monthly) expenses have amount=0 — the landlord types
// the total each month in the monthly statement. 'fixed' makes no sense here
// because fixed means absolute per-unit amounts that don't change — but the
// total DOES change monthly. All other methods (equal, thousandths, surface,
// custom_percentage, custom_ratio, single_unit) work fine: they distribute
// whatever total the landlord types proportionally.
function getAllocationMethodsForType(expenseType, isVariable, building) {
  const allowed = ALLOCATION_METHODS_BY_TYPE[expenseType];
  let methods = allowed
    ? allocationMethods.filter((m) => allowed.includes(m.id))
    : allocationMethods;
  if (isVariable) {
    methods = methods.filter((m) => m.id !== 'fixed');
  }
  // Building-flag gating: an allocation by elevator/heating thousandths makes no
  // sense on a building without an elevator / central heating. Hide those
  // methods unless the building has the corresponding feature. (No flag info →
  // don't gate, to avoid hiding a valid method when building is absent.)
  if (building) {
    if (!building.hasElevator) {
      methods = methods.filter((m) => m.id !== 'elevator_thousandths');
    }
    if (!building.hasCentralHeating) {
      methods = methods.filter((m) => m.id !== 'heating_thousandths');
    }
  }
  return methods;
}

const METHODS_NEEDING_ALLOCATIONS = [
  'custom_percentage',
  'custom_ratio',
  'fixed',
  // single_unit stores the chosen target as customAllocations[0] with
  // percentage=100. Without this entry, the submit handler wipes
  // customAllocations to [] and the chosen unit is lost — every save
  // becomes "bill nobody".
  'single_unit'
];

function UnitAllocationRow({ unit, occupant, index, register, method, t }) {
  const propertyName =
    unit.property?.name || `${t('Unit')} ${unit.unitLabel || unit.floor || ''}`;
  const floorLabel = unit.floor != null ? `${t('Floor')} ${unit.floor}` : '';

  return (
    <div className="flex items-center gap-3 py-2 border-b last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{propertyName}</div>
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          {floorLabel && <span>{floorLabel}</span>}
          {unit.surface > 0 && <span>{unit.surface} m²</span>}
        </div>
        <div className="text-xs mt-0.5">
          {occupant ? (
            <span className="text-green-600">● {occupant.name}</span>
          ) : (
            <span className="text-muted-foreground">○ {t('Vacant')}</span>
          )}
        </div>
      </div>
      <div className="w-24">
        <Input
          type="number"
          step="0.01"
          min="0"
          className="h-8 text-sm"
          placeholder={
            method === 'custom_percentage' ? '%' : method === 'fixed' ? '€' : ''
          }
          {...register(`customAllocations.${index}.value`, {
            valueAsNumber: true
          })}
        />
        <input
          type="hidden"
          {...register(`customAllocations.${index}.propertyId`)}
        />
      </div>
      <div className="w-8 text-xs text-muted-foreground">
        {method === 'custom_percentage' ? '%' : method === 'fixed' ? '€' : ''}
      </div>
    </div>
  );
}

// `onCreated(updatedBuilding)` is optional: when the dialog is reused from the
// bill-import flow (add mode), it fires after a successful CREATE with the
// server's updated building (which contains the new expense + its generated
// _id) so the caller can auto-select it. ExpenseList does not pass it → no-op.
function ExpenseFormDialog({ open, setOpen, expense, building, onCreated }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const buildingId = building?._id;
  const units = building?.units || [];

  const { data: tenants } = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: () => fetchTenants(),
    enabled: open
  });

  const occupantsByPropertyId = useMemo(() => {
    if (!tenants) return {};
    const map = {};
    tenants.forEach((tenant) => {
      if (tenant.properties) {
        tenant.properties.forEach((p) => {
          if (p.propertyId) {
            map[p.propertyId] = tenant;
          }
        });
      }
    });
    return map;
  }, [tenants]);

  // Building expense changes flow into tenant rent computation (recurring
  // expenses are computed live), so a payment dialog opened after a koino
  // edit must see fresh amounts. Invalidate RENTS/DASHBOARD/TENANTS in
  // addition to the building cache. Mirrors the delete-mutation pattern.
  const _invalidateAllExpenseDependents = () => {
    queryClient.invalidateQueries({
      queryKey: [QueryKeys.BUILDINGS, buildingId]
    });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
    // The ΧΡΕΩΣΕΙΣ breakdown panel (BuildingExpensePanel) is a SEPARATE query
    // key ['expense-breakdown', buildingId, term] — without invalidating it,
    // toggling a flag (Καταγραφή/Χρέωση ιδιοκτήτη), editing an amount, or
    // adding an expense updated the building doc but left the right-hand
    // breakdown stale until a manual page refresh. Invalidate the whole
    // 'expense-breakdown' family (all terms) + the owner ledger surfaces.
    queryClient.invalidateQueries({ queryKey: ['expense-breakdown'] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.OWNERS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
    // C1 (destructive-write audit 2026-07): the per-property «Έξοδα ακινήτου»
    // card (useFetchPropertyExpenses, key ['property-expenses', …]) reads the
    // same building expenses; without this it stayed stale after an expense
    // add/edit until navigation.
    queryClient.invalidateQueries({ queryKey: ['property-expenses'] });
  };

  const addMutation = useMutation({
    mutationFn: (data) => addBuildingExpense(buildingId, data),
    onSuccess: _invalidateAllExpenseDependents
  });

  const updateMutation = useMutation({
    mutationFn: (data) =>
      updateBuildingExpense(buildingId, { ...data, _id: expense._id }),
    onSuccess: _invalidateAllExpenseDependents
  });

  const buildDefaultAllocations = useCallback(
    (existingAllocations) => {
      return units
        .filter((u) => u.propertyId)
        .map((u) => {
          const existing = existingAllocations?.find(
            (a) => String(a.propertyId) === String(u.propertyId)
          );
          return {
            propertyId: String(u.propertyId),
            value: existing?.value || 0
          };
        });
    },
    [units]
  );

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      name: '',
      type: '',
      amount: 0,
      allocationMethod: '',
      isRecurring: true,
      trackOwnerExpense: false,
      ownerAmount: 0,
      chargeOwnerWhenVacant: false,
      startFromCurrentMonth: true,
      notes: '',
      customAllocations: buildDefaultAllocations([])
    },
    values: expense
      ? {
          ...expense,
          trackOwnerExpense: expense.trackOwnerExpense ?? false,
          ownerAmount: expense.ownerAmount ?? 0,
          chargeOwnerWhenVacant: expense.chargeOwnerWhenVacant ?? false,
          isRecurring: expense.isRecurring ?? true,
          startFromCurrentMonth: !expense.startTerm,
          // single_unit stores exactly one {propertyId,value} target (read as
          // customAllocations[0]); do NOT expand it across all units, or the
          // prefilled/edited target is lost. Other methods get per-unit rows.
          customAllocations:
            expense.allocationMethod === 'single_unit'
              ? expense.customAllocations || []
              : buildDefaultAllocations(expense.customAllocations)
        }
      : undefined
  });

  const expenseType = watch('type');
  const allocationMethod = watch('allocationMethod');
  const isRecurring = watch('isRecurring');
  const amount = watch('amount');
  const trackOwnerExpense = watch('trackOwnerExpense');
  const ownerAmount = watch('ownerAmount');

  const isVariable = isRecurring && (Number(amount) || 0) === 0;
  const filteredMethods = useMemo(() => {
    const methods = getAllocationMethodsForType(
      expenseType,
      isVariable,
      building
    );
    // An expense SAVED with a method the gates would now hide (e.g. saved as
    // elevator_thousandths, then the building's hasElevator was turned off)
    // must still appear in its own picker — otherwise the trigger renders the
    // «Select allocation method» placeholder and the landlord cannot see how
    // this expense actually allocates. Append rather than re-sort so the
    // normal option order is untouched.
    const saved = expense?.allocationMethod;
    if (saved && !methods.find((m) => m.id === saved)) {
      const savedDef = allocationMethods.find((m) => m.id === saved);
      if (savedDef) return [...methods, savedDef];
    }
    return methods;
  }, [expenseType, isVariable, building, expense?.allocationMethod]);

  useEffect(() => {
    if (expenseType && allocationMethod) {
      const valid = getAllocationMethodsForType(
        expenseType,
        isVariable,
        building
      );
      if (!valid.find((m) => m.id === allocationMethod)) {
        // Do NOT rewrite the method an expense was actually SAVED with. This
        // effect exists to repair an impossible combination the USER just
        // created by changing the type; applied to a persisted value it
        // silently re-routes money. Reproduced: an expense saved as
        // elevator_thousandths on a building whose hasElevator is false (or
        // was later turned off) reopened with the picker blanked to «Select
        // allocation method» — pressing Update then persisted a DIFFERENT
        // allocation than the landlord chose, with no warning. The stored
        // method stays selected and the picker still offers it (see
        // filteredMethods below), so the landlord can keep or change it
        // deliberately.
        if (allocationMethod !== expense?.allocationMethod) {
          setValue('allocationMethod', valid[0]?.id || '');
        }
      }
    }
  }, [
    expenseType,
    allocationMethod,
    isVariable,
    building,
    setValue,
    expense?.allocationMethod
  ]);

  // F5-expense: switching allocation methods leaves customAllocations in
  // a corrupted partial state (a custom_percentage with values 30/40/30
  // becomes a single_unit with the first row pre-selected at 30 — wrong).
  // Reset to a method-appropriate default whenever allocationMethod
  // changes.
  const previousAllocationMethodRef = useRef(allocationMethod);
  useEffect(() => {
    const previous = previousAllocationMethodRef.current;
    // `previous && …` used to skip the FIRST selection too (the '' → method
    // transition). On the ADD dialog that was a real money bug:
    // `defaultValues.customAllocations` is buildDefaultAllocations([]) — one row
    // PER UNIT, each with a real propertyId — so picking single_unit as the
    // first method inherited unit #1 as a silent pre-selected target. The zod
    // guard only checks `customAllocations[0].propertyId`, which was already
    // populated, so «Pick a unit to bill» never fired and the whole expense was
    // billed to whichever unit happened to be first, without the landlord
    // choosing it.
    //
    // But that same `previous &&` is LOAD-BEARING on the EDIT dialog: RHF
    // applies the `values` prop from a useEffect AFTER first render (see
    // useForm: `if (props.values && !deepEqual(...)) control._reset(...)`), so
    // an edited expense's saved method arrives as a '' → 'single_unit'
    // transition too. Firing there would wipe the persisted target.
    //
    // So allow the first transition only when CREATING (no `expense` prop).
    if (previous !== allocationMethod && (previous || !expense)) {
      if (allocationMethod === 'single_unit') {
        // Start with no target; the user MUST pick one (zod enforces).
        setValue('customAllocations', [], { shouldDirty: true });
      } else if (METHODS_NEEDING_ALLOCATIONS.includes(allocationMethod)) {
        // custom_percentage / custom_ratio / fixed → fresh default rows.
        setValue('customAllocations', buildDefaultAllocations([]), {
          shouldDirty: true
        });
      } else {
        // Methods that don't use customAllocations (general_thousandths,
        // equal, by_surface, etc.) — clear so submit doesn't ship stale rows.
        setValue('customAllocations', [], { shouldDirty: true });
      }
    }
    previousAllocationMethodRef.current = allocationMethod;
  }, [allocationMethod, setValue, buildDefaultAllocations, expense]);

  const needsAllocations =
    METHODS_NEEDING_ALLOCATIONS.includes(allocationMethod);
  // single_unit is in METHODS_NEEDING_ALLOCATIONS (so the submit handler
  // preserves its customAllocations[0]), but it must NOT render the per-unit
  // «Κατανομές ανά Μονάδα» table — it has its OWN dedicated unit picker. When
  // both rendered, the per-unit table's registered `customAllocations.0.value`
  // input (default 0) overwrote the picker's {propertyId, value:100}, so submit
  // filtered it out (value 0) → customAllocations:[] → server 422 "requires a
  // target unit". Most visible on a 1-unit building where the collision is
  // guaranteed on index 0. The per-unit table is for custom_ratio / custom_%
  // / fixed ONLY.
  const showAllocationTable =
    needsAllocations && allocationMethod !== 'single_unit';

  // Reset form when dialog opens in "add" mode (no expense)
  // Handles case where dialog was closed via X button without calling reset()
  useEffect(() => {
    if (open && !expense) {
      reset();
    }
  }, [open, expense, reset]);

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const onSubmit = useCallback(
    async (data) => {
      try {
        setIsLoading(true);
        const payload = { ...data };
        delete payload.startFromCurrentMonth;
        if (!METHODS_NEEDING_ALLOCATIONS.includes(payload.allocationMethod)) {
          payload.customAllocations = [];
        } else if (payload.allocationMethod === 'single_unit') {
          // single_unit is defined ENTIRELY by its target propertyId — the
          // rent pipeline bills the whole amount to customAllocations[0]
          // regardless of the value. Do NOT drop the row for value===0 (the
          // prefill seeds value:0), or the server rejects with "single_unit
          // allocation requires a target unit". Keep only the first row with a
          // propertyId.
          payload.customAllocations = (payload.customAllocations || [])
            .filter((a) => a.propertyId)
            .slice(0, 1);
        } else {
          payload.customAllocations = payload.customAllocations.filter(
            (a) => a.value > 0
          );
        }
        // Set startTerm for recurring with fixed amount.
        // On EDIT, preserve the persisted startTerm (RHF only carries registered
        // fields, so without this the PATCH would strip it and the API would
        // reject with "startTerm is required for recurring expenses").
        //
        // Anchoring rule:
        //  - On CREATE: if user opted "start from current month" (default),
        //    use this month. Otherwise we need a startTerm anyway since
        //    the API rejects recurring expenses without one — fall back
        //    to current month (the Switch is informational, not a way to
        //    skip the anchor).
        //  - On EDIT: preserve the persisted startTerm, but if the user
        //    flipped startFromCurrentMonth on, advance to current month.
        const currentMonthTerm = Number(
          `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}0100`
        );
        if (expense?._id) {
          if (data.startFromCurrentMonth) {
            payload.startTerm = currentMonthTerm;
          } else if (expense?.startTerm) {
            payload.startTerm = expense.startTerm;
          }
        } else {
          // CREATE: always send a startTerm. The Switch defaults to true
          // and if zod's .optional().default() races with the resolver
          // (RHF + zodResolver edge case where `data.startFromCurrentMonth`
          // ends up undefined despite the form-state default), we still
          // anchor to this month rather than 422 the user.
          payload.startTerm = currentMonthTerm;
        }
        // endTerm: soft-delete stamps endTerm = previous month (always a
        // PAST value) to kill a recurring expense. Re-editing it must not
        // blindly copy that stale kill-date back, or the expense can never
        // be revived from this form. Preserve ONLY a FUTURE endTerm (a real
        // scheduled end); otherwise send explicit null so the server clears
        // it and the expense becomes active again. (Today no future endTerm
        // is creatable via the UI, so this effectively always revives on
        // edit — matching the "edit = intent to keep active" semantics.)
        if (expense?._id) {
          payload.endTerm =
            expense?.endTerm && Number(expense.endTerm) >= currentMonthTerm
              ? expense.endTerm
              : null;
        } else if (expense?.endTerm) {
          payload.endTerm = expense.endTerm;
        }
        // Owner expense tracking
        if (!payload.trackOwnerExpense) {
          payload.ownerAmount = 0;
        }

        // Optimistic-lock token: thread the building's __v so the
        // server can detect concurrent edits (two tabs / two
        // landlords). On 409 the user gets a clear "modified
        // concurrently" toast instead of silent data loss.
        if (expense?._id && typeof building?.__v === 'number') {
          payload.__v = building.__v;
        }

        if (expense?._id) {
          await updateMutation.mutateAsync(payload);
        } else {
          const updatedBuilding = await addMutation.mutateAsync(payload);
          // Bill-import reuse: hand the caller the updated building so it can
          // locate the freshly-created expense (by name+billingId) and select
          // it. No-op for the normal ExpenseList flow (onCreated undefined).
          if (onCreated) {
            onCreated(updatedBuilding);
          }
        }
        handleClose();
      } catch (error) {
        // A 409 means another tab/landlord changed this building between
        // our load and save (optimistic lock). It is RETRYABLE and no data
        // was lost — tell the user that specifically instead of a generic
        // failure that reads like data loss.
        if (error?.response?.status === 409) {
          toast.error(
            t(
              'This expense was changed in another tab — please reopen and retry'
            )
          );
        } else {
          toast.error(t('Something went wrong'));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [expense, addMutation, updateMutation, handleClose, onCreated, building, t]
  );

  const unitsWithProperty = units.filter((u) => u.propertyId);

  // Denominators MUST mirror 1_base.computeBuildingChargeForProperty exactly:
  // the ‰ branches reduce over ALL building.units (:598), surface/equal use
  // managedUnits = units with a propertyId (:590, :762). Getting this wrong in
  // either direction is a false positive or a missed warning.
  const _sum = (list, f) => list.reduce((s, u) => s + (Number(u?.[f]) || 0), 0);
  const allocationBlocker = (() => {
    const m = allocationMethod;
    if (!m) return null;
    // single_unit bills one named unit and is already handled: its picker is
    // hidden when nothing is linked, so zod's «Pick a unit to bill» fires.
    if (m === 'single_unit') return null;
    if (unitsWithProperty.length === 0) {
      return {
        title: t('No unit in this building is linked to a property'),
        detail: t(
          'This expense would be charged to nobody. Link the units to properties on the Units tab first.'
        )
      };
    }
    const THOUSANDTHS = {
      general_thousandths: 'generalThousandths',
      heating_thousandths: 'heatingThousandths',
      elevator_thousandths: 'elevatorThousandths'
    };
    if (THOUSANDTHS[m] && _sum(units, THOUSANDTHS[m]) === 0) {
      return {
        title: t('The units have no thousandths for this method'),
        detail: t(
          'Every unit would compute a zero share, so no amount is charged to anyone — in any month. Set the thousandths on the Units tab, or choose «Equal».'
        )
      };
    }
    if (m === 'by_surface' && _sum(unitsWithProperty, 'surface') === 0) {
      return {
        title: t('The linked units have no surface (m²)'),
        detail: t(
          'Every unit would compute a zero share, so no amount is charged to anyone — in any month. Set the unit m² on the Units tab, or choose «Equal».'
        )
      };
    }
    return null;
  })();

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => (expense?._id ? t('Edit Expense') : t('Add Expense'))}
      renderContent={() => (
        <form onSubmit={handleSubmit(onSubmit)} autoComplete="off">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('Name')}</Label>
              <Input id="name" {...register('name')} />
              {errors.name && (
                <p className="text-sm text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('Type')}</Label>
              <Select
                value={expenseType}
                onValueChange={(val) => setValue('type', val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select type')} />
                </SelectTrigger>
                <SelectContent>
                  {expenseTypes.map((et) => (
                    <SelectItem key={et.id} value={et.id}>
                      {t(et.labelId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.type && (
                <p className="text-sm text-destructive">
                  {errors.type.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="amount">{t('Amount')}</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                {...register('amount')}
              />
              {errors.amount && (
                <p className="text-sm text-destructive">
                  {errors.amount.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('Allocation Method')}</Label>
              <Select
                value={allocationMethod}
                onValueChange={(val) => setValue('allocationMethod', val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select allocation method')} />
                </SelectTrigger>
                <SelectContent>
                  {filteredMethods.map((am) => (
                    <SelectItem key={am.id} value={am.id}>
                      {t(am.labelId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.allocationMethod && (
                <p className="text-sm text-destructive">
                  {errors.allocationMethod.message}
                </p>
              )}
              {/* Zero-denominator pre-flight. The server's 422
                  (_assertThousandthsAvailable) covers ONLY the three ‰ methods
                  AND only when amount > 0 — so a variable expense (amount 0) or
                  by_surface bypasses it entirely and every unit's share computes
                  to 0: no rent line, no breakdown row, no owner row, every month,
                  with a success toast. */}
              {allocationBlocker && (
                <div className="mt-2 rounded-md border border-oxide/40 bg-oxide-tint/40 p-2.5 text-sm text-ink">
                  <div className="font-medium">{allocationBlocker.title}</div>
                  <div className="mt-1 text-label text-ink-muted">
                    {allocationBlocker.detail}
                  </div>
                </div>
              )}
            </div>

            {allocationMethod === 'single_unit' &&
              unitsWithProperty.length > 0 && (
                <div className="space-y-2">
                  <Label>{t('Pick the unit to bill')}</Label>
                  <Select
                    value={watch('customAllocations')?.[0]?.propertyId || ''}
                    onValueChange={(propertyId) => {
                      setValue(
                        'customAllocations',
                        [{ propertyId, value: 100 }],
                        { shouldDirty: true, shouldValidate: true }
                      );
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t('Select a unit')} />
                    </SelectTrigger>
                    <SelectContent>
                      {unitsWithProperty.map((u) => {
                        const occ = occupantsByPropertyId[u.propertyId];
                        // The property name already encodes the floor
                        // ("ΟΔΟΣ ΕΨΙΛΟΝ 28 - Υπόγειο" / "- Όροφος 1"), so
                        // appending t('Floor {{n}}') AND unitLabel repeated
                        // the floor up to 3× ("Υπόγειο — Όροφος -1 — Όροφος
                        // -1"). Only add a floor/unit suffix when the name
                        // does NOT already carry one. ATAK is the real
                        // tiebreaker for units sharing a floor.
                        const propertyName =
                          u.property?.name ||
                          `${t('Unit')} ${u.unitLabel || u.floor || ''}`;
                        const nameHasFloor =
                          /Υπόγειο|Ισόγειο|Όροφος|Floor|Étage|Piso|Andar|Stockwerk/i.test(
                            propertyName
                          );
                        const parts = [
                          propertyName,
                          !nameHasFloor && u.floor != null
                            ? t('Floor {{n}}', { n: u.floor })
                            : null,
                          !nameHasFloor ? u.unitLabel : null,
                          u.atakNumber ? `ATAK ${u.atakNumber}` : null,
                          occ?.name ? `(${occ.name})` : `(${t('Vacant')})`
                        ].filter(Boolean);
                        return (
                          <SelectItem key={u._id} value={u.propertyId}>
                            {parts.join(' — ')}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  {/* The old copy ended "(owner billing for vacant units is
                      coming soon)". That feature SHIPPED in 978bf92b and this
                      same dialog carries its «Charge owner for vacant units»
                      switch a few rows below — the note was telling the
                      landlord a control they can see does not exist. Point at
                      the switch instead. */}
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'The full expense amount will be billed to this unit. If the unit has no tenant for a month, that month is billed to the owner when «Charge owner for vacant units» is on, and to nobody when it is off.'
                    )}
                  </p>
                  {errors.customAllocations && (
                    <p className="text-sm text-destructive">
                      {errors.customAllocations.message ||
                        errors.customAllocations.root?.message ||
                        t('Pick a unit to bill')}
                    </p>
                  )}
                </div>
              )}

            {showAllocationTable && unitsWithProperty.length > 0 && (
              <div className="space-y-2">
                <Label>
                  {t('Allocations per Unit')}
                  {allocationMethod === 'custom_percentage' && (
                    <span className="text-xs text-muted-foreground ml-2">
                      ({t('percentage of total')})
                    </span>
                  )}
                  {allocationMethod === 'fixed' && (
                    <span className="text-xs text-muted-foreground ml-2">
                      ({t('fixed amount per unit')})
                    </span>
                  )}
                  {allocationMethod === 'custom_ratio' && (
                    <span className="text-xs text-muted-foreground ml-2">
                      ({t('ratio shares')})
                    </span>
                  )}
                </Label>
                {errors.customAllocations && (
                  <p className="text-sm text-destructive">
                    {errors.customAllocations.message ||
                      errors.customAllocations.root?.message}
                  </p>
                )}
                <div className="border rounded-md p-3 max-h-64 overflow-y-auto">
                  {unitsWithProperty.map((unit, index) => (
                    <UnitAllocationRow
                      key={unit._id}
                      unit={unit}
                      occupant={occupantsByPropertyId[unit.propertyId]}
                      index={index}
                      register={register}
                      method={allocationMethod}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Switch
                id="isRecurring"
                checked={isRecurring}
                onCheckedChange={(checked) => setValue('isRecurring', checked)}
              />
              <Label htmlFor="isRecurring">{t('Recurring Expense')}</Label>
            </div>

            {isRecurring && amount > 0 && (
              <div className="flex items-center gap-2 ml-14 border-l-2 border-stone-line pl-4 py-1">
                <Switch
                  id="startFromCurrentMonth"
                  checked={watch('startFromCurrentMonth')}
                  onCheckedChange={(checked) =>
                    setValue('startFromCurrentMonth', checked)
                  }
                />
                <Label
                  htmlFor="startFromCurrentMonth"
                  className="text-label text-ink-muted"
                >
                  {t('Start billing from current month only')}
                </Label>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Switch
                id="trackOwnerExpense"
                checked={trackOwnerExpense}
                onCheckedChange={(checked) =>
                  setValue('trackOwnerExpense', checked)
                }
              />
              <Label htmlFor="trackOwnerExpense">
                {t('Track owner expense')}
              </Label>
            </div>

            <div className="flex items-start gap-2">
              <Switch
                id="chargeOwnerWhenVacant"
                checked={watch('chargeOwnerWhenVacant') || false}
                onCheckedChange={(checked) =>
                  setValue('chargeOwnerWhenVacant', checked, {
                    shouldDirty: true
                  })
                }
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="chargeOwnerWhenVacant">
                  {t('Charge owner for vacant units')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "When a unit has no tenant for a month, route its share of this expense to the owner instead of leaving it uncollected. Off: the vacant unit's share is not billed to anyone."
                  )}
                </p>
              </div>
            </div>

            {trackOwnerExpense && (
              <div className="ml-6 space-y-2">
                <Label
                  htmlFor="ownerAmount"
                  className="text-sm text-muted-foreground"
                >
                  {t('Owner monthly amount')}
                </Label>
                <Input
                  id="ownerAmount"
                  type="number"
                  step="0.01"
                  className="w-40"
                  {...register('ownerAmount')}
                />
                {isRecurring && (
                  <p className="text-xs text-muted-foreground">
                    {t('Set to 0 for variable — enter actual amounts monthly.')}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="notes">{t('Notes')}</Label>
              <Textarea id="notes" rows={3} {...register('notes')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="billingId">
                {t('Billing ID')}
                <span className="text-xs text-muted-foreground ml-2">
                  ({t('e.g. supply number')})
                </span>
              </Label>
              <Input
                id="billingId"
                {...register('billingId')}
                placeholder={t('e.g. supply number placeholder')}
              />
            </div>
          </div>
        </form>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleClose}>
            {t('Cancel')}
          </Button>
          <Button
            onClick={handleSubmit(onSubmit)}
            disabled={
              addMutation.isPending || updateMutation.isPending || isLoading
            }
          >
            {expense?._id ? t('Update') : t('Add')}
          </Button>
        </>
      )}
    />
  );
}

export {
  ExpenseFormDialog,
  expenseTypes,
  allocationMethods,
  ALLOCATION_DESCRIPTIONS
};
