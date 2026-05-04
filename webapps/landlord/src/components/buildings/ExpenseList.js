import {
  addBuildingExpense,
  fetchTenants,
  QueryKeys,
  removeBuildingExpense,
  updateBuildingExpense
} from '../../utils/restcalls';
import { LuPencil, LuPlusCircle, LuTrash } from 'react-icons/lu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import NumberFormat from '../NumberFormat';
import ExpenseHistory from './ExpenseHistory';
import MonthlyStatement from './MonthlyStatement';
import ResponsiveDialog from '../ResponsiveDialog';
import { Separator } from '../ui/separator';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import useTranslation from 'next-translate/useTranslation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const expenseSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  amount: z.coerce.number().min(0).optional().default(0),
  allocationMethod: z.string().min(1),
  isRecurring: z.boolean(),
  startFromCurrentMonth: z.boolean().optional().default(true),
  notes: z.string().optional(),
  customAllocations: z
    .array(
      z.object({
        propertyId: z.string(),
        value: z.coerce.number().min(0).default(0)
      })
    )
    .optional()
    .default([])
}).superRefine((data, ctx) => {
  if (!data.isRecurring && (!data.amount || data.amount <= 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Amount is required for non-recurring expenses',
      path: ['amount']
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
  { id: 'custom_percentage', labelId: 'Custom Percentage' }
];

const ALLOCATION_DESCRIPTIONS = {
  equal: 'Split equally among all units',
  by_surface: 'Split proportionally by unit surface area (m²)',
  general_thousandths: 'Split by general thousandths (‰) from E9',
  heating_thousandths: 'Split by heating thousandths (‰) from E9',
  elevator_thousandths: 'Split by elevator thousandths (‰) — ground floor excluded',
  fixed: 'Each unit pays a fixed predefined amount',
  custom_ratio: 'Split by custom ratio shares you defined per unit',
  custom_percentage: 'Each unit pays a custom percentage of the total'
};

const METHODS_NEEDING_ALLOCATIONS = [
  'custom_percentage',
  'custom_ratio',
  'fixed'
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
            <span className="text-green-600">
              ● {occupant.name}
            </span>
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
            method === 'custom_percentage'
              ? '%'
              : method === 'fixed'
                ? '€'
                : ''
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

function ExpenseFormDialog({ open, setOpen, expense, building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

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

  const addMutation = useMutation({
    mutationFn: (data) => addBuildingExpense(buildingId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, buildingId]
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: (data) =>
      updateBuildingExpense(buildingId, { ...data, _id: expense._id }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, buildingId]
      });
    }
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
      startFromCurrentMonth: true,
      notes: '',
      customAllocations: buildDefaultAllocations([])
    },
    values: expense
      ? {
          ...expense,
          isRecurring: expense.isRecurring ?? true,
          startFromCurrentMonth: !expense.startTerm,
          customAllocations: buildDefaultAllocations(
            expense.customAllocations
          )
        }
      : undefined
  });

  const expenseType = watch('type');
  const allocationMethod = watch('allocationMethod');
  const isRecurring = watch('isRecurring');
  const amount = watch('amount');

  const needsAllocations = METHODS_NEEDING_ALLOCATIONS.includes(
    allocationMethod
  );

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
        } else {
          payload.customAllocations = payload.customAllocations.filter(
            (a) => a.value > 0
          );
        }
        // Set startTerm for recurring with fixed amount
        if (payload.isRecurring && payload.amount > 0 && data.startFromCurrentMonth) {
          const now = new Date();
          const term = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}0100`;
          payload.startTerm = Number(term);
        }
        if (expense?._id) {
          await updateMutation.mutateAsync(payload);
        } else {
          await addMutation.mutateAsync(payload);
        }
        handleClose();
      } catch (error) {
        toast.error(t('Something went wrong'));
      } finally {
        setIsLoading(false);
      }
    },
    [expense, addMutation, updateMutation, handleClose, t]
  );

  const unitsWithProperty = units.filter((u) => u.propertyId);

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() =>
        expense?._id ? t('Edit Expense') : t('Add Expense')
      }
      renderContent={() => (
        <form
          ref={formRef}
          onSubmit={handleSubmit(onSubmit)}
          autoComplete="off"
        >
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
                  {allocationMethods.map((am) => (
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
            </div>

            {needsAllocations && unitsWithProperty.length > 0 && (
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
              <div className="flex items-center gap-2 ml-6">
                <Switch
                  id="startFromCurrentMonth"
                  checked={watch('startFromCurrentMonth')}
                  onCheckedChange={(checked) =>
                    setValue('startFromCurrentMonth', checked)
                  }
                />
                <Label htmlFor="startFromCurrentMonth" className="text-sm text-muted-foreground">
                  {t('Start billing from current month only')}
                </Label>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="notes">{t('Notes')}</Label>
              <Textarea id="notes" rows={3} {...register('notes')} />
            </div>
          </div>
        </form>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => formRef.current?.requestSubmit()}>
            {expense?._id ? t('Update') : t('Add')}
          </Button>
        </>
      )}
    />
  );
}

export default function ExpenseList({ building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [openExpenseDialog, setOpenExpenseDialog] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState(null);
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false);
  const [expenseToDelete, setExpenseToDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const removeMutation = useMutation({
    mutationFn: ({ expenseId, mode }) =>
      removeBuildingExpense(building._id, expenseId, mode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    }
  });

  const handleAddExpense = useCallback(() => {
    setSelectedExpense(null);
    setOpenExpenseDialog(true);
  }, []);

  const handleEditExpense = useCallback((expense) => {
    setSelectedExpense(expense);
    setOpenExpenseDialog(true);
  }, []);

  const handleDeleteExpense = useCallback((expense) => {
    setExpenseToDelete(expense);
    setOpenConfirmDelete(true);
  }, []);

  const deleteImpact = useMemo(() => {
    if (!expenseToDelete || !building) return { months: 0 };
    const units = building.units || [];
    const expId = String(expenseToDelete._id);
    const terms = new Set();
    for (const unit of units) {
      for (const c of unit.monthlyCharges || []) {
        if (String(c.expenseId) === expId) terms.add(c.term);
      }
    }
    return { months: terms.size };
  }, [expenseToDelete, building]);

  const handleDelete = useCallback(async (mode) => {
    try {
      setIsDeleting(true);
      await removeMutation.mutateAsync({ expenseId: expenseToDelete._id, mode });
      setOpenConfirmDelete(false);
      setExpenseToDelete(null);
    } catch (error) {
      toast.error(t('Something went wrong'));
    } finally {
      setIsDeleting(false);
    }
  }, [expenseToDelete, removeMutation, t]);

  const expenses = building?.expenses || [];

  return (
    <div>
      <div className="mb-4">
        <Button
          variant="secondary"
          className="w-full gap-2 sm:w-fit"
          onClick={handleAddExpense}
          data-cy="addExpense"
        >
          <LuPlusCircle className="size-4" />
          {t('Add Expense')}
        </Button>
      </div>

      {expenses.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Name')}</TableHead>
              <TableHead>{t('Type')}</TableHead>
              <TableHead className="text-right">{t('Amount')}</TableHead>
              <TableHead>{t('Allocation')}</TableHead>
              <TableHead>{t('Recurring')}</TableHead>
              <TableHead className="text-right">{t('Actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {expenses.map((expense) => (
              <TableRow key={expense._id}>
                <TableCell>{expense.name}</TableCell>
                <TableCell>
                  {t(
                    expenseTypes.find((et) => et.id === expense.type)
                      ?.labelId || expense.type
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <NumberFormat value={expense.amount} />
                </TableCell>
                <TableCell>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="border-b border-dotted border-muted-foreground/50 cursor-help">
                          {t(
                            allocationMethods.find(
                              (am) => am.id === expense.allocationMethod
                            )?.labelId || expense.allocationMethod
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[260px] text-xs">
                        {t(ALLOCATION_DESCRIPTIONS[expense.allocationMethod] || '')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </TableCell>
                <TableCell>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help">
                          {expense.isRecurring && expense.amount > 0 ? (
                            <Badge variant="default">{t('Yes')}</Badge>
                          ) : expense.isRecurring && !expense.amount ? (
                            <Badge variant="default">
                              {t('Yes')} ({t('variable')})
                            </Badge>
                          ) : (
                            <Badge variant="secondary">{t('No')}</Badge>
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[260px] text-xs">
                        {expense.isRecurring && expense.amount > 0
                          ? t('Fixed amount charged automatically every month.')
                          : expense.isRecurring
                            ? t('Variable expense — enter actual amounts each month via Monthly Statement.')
                            : t('One-time charge, not included in monthly rent calculations.')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEditExpense(expense)}
                    >
                      <LuPencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteExpense(expense)}
                    >
                      <LuTrash className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="text-muted-foreground text-center py-8">
          {t('No expenses added yet')}
        </div>
      )}

      <ExpenseFormDialog
        open={openExpenseDialog}
        setOpen={setOpenExpenseDialog}
        expense={selectedExpense}
        building={building}
      />

      <Dialog open={openConfirmDelete} onOpenChange={setOpenConfirmDelete}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t('Delete expense')}: {expenseToDelete?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {deleteImpact.months > 0 && (
              <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm">
                <p className="font-medium text-destructive mb-1">
                  {t('This expense has {{count}} months of recorded charges.', { count: deleteImpact.months })}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('Permanent deletion will remove all historical charges and recalculate tenant balances retroactively.')}
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start"
                disabled={isDeleting}
                onClick={() => handleDelete('soft')}
              >
                <span className="text-left">
                  <span className="font-medium">{t('End from current month')}</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {t('Keeps historical charges intact. Stops applying from this month.')}
                  </span>
                </span>
              </Button>
              <Button
                variant="destructive"
                className="w-full justify-start"
                disabled={isDeleting}
                onClick={() => handleDelete('hard')}
              >
                <span className="text-left">
                  <span className="font-medium">{t('Delete permanently')}</span>
                  <span className="block text-xs text-destructive-foreground/80 mt-0.5">
                    {t('Removes all charges from all months. Tenant balances will change.')}
                  </span>
                </span>
              </Button>
            </div>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => setOpenConfirmDelete(false)}
            >
              {t('Cancel')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {expenses.length > 0 && (
        <>
        <Separator className="mt-8 mb-8" />
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1px_1fr] gap-8">
          <div>
            <MonthlyStatement building={building} />
          </div>
          <Separator orientation="vertical" className="hidden lg:block h-full" />
          <div>
            <ExpenseHistory building={building} />
          </div>
        </div>
        </>
      )}
    </div>
  );
}
