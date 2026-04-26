import {
  addBuildingExpense,
  QueryKeys,
  removeBuildingExpense,
  updateBuildingExpense
} from '../../utils/restcalls';
import { LuPencil, LuPlusCircle, LuTrash } from 'react-icons/lu';
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
import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import ConfirmDialog from '../ConfirmDialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import NumberFormat from '../NumberFormat';
import ResponsiveDialog from '../ResponsiveDialog';
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
  amount: z.coerce.number().min(0),
  allocationMethod: z.string().min(1),
  isRecurring: z.boolean(),
  notes: z.string().optional()
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

function ExpenseFormDialog({ open, setOpen, expense, buildingId }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

  const addMutation = useMutation({
    mutationFn: (data) => addBuildingExpense(buildingId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS, buildingId] });
    }
  });

  const updateMutation = useMutation({
    mutationFn: (data) =>
      updateBuildingExpense(buildingId, { ...data, _id: expense._id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS, buildingId] });
    }
  });

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
      amount: '',
      allocationMethod: '',
      isRecurring: true,
      notes: ''
    },
    values: expense
      ? {
          ...expense,
          isRecurring: expense.isRecurring ?? true
        }
      : undefined
  });

  const expenseType = watch('type');
  const allocationMethod = watch('allocationMethod');
  const isRecurring = watch('isRecurring');

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const onSubmit = useCallback(
    async (data) => {
      try {
        setIsLoading(true);
        if (expense?._id) {
          await updateMutation.mutateAsync(data);
        } else {
          await addMutation.mutateAsync(data);
        }
        handleClose();
      } catch (error) {
        console.error(error);
        toast.error(t('Something went wrong'));
      } finally {
        setIsLoading(false);
      }
    },
    [expense, addMutation, updateMutation, handleClose, t]
  );

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => (expense?._id ? t('Edit Expense') : t('Add Expense'))}
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
            <div className="flex items-center gap-2">
              <Switch
                id="isRecurring"
                checked={isRecurring}
                onCheckedChange={(checked) => setValue('isRecurring', checked)}
              />
              <Label htmlFor="isRecurring">{t('Recurring Expense')}</Label>
            </div>
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

  const removeMutation = useMutation({
    mutationFn: (expenseId) => removeBuildingExpense(building._id, expenseId),
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

  const handleConfirmDelete = useCallback(async () => {
    try {
      await removeMutation.mutateAsync(expenseToDelete._id);
    } catch (error) {
      console.error(error);
      toast.error(t('Something went wrong'));
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
                <TableCell>{t(expense.type)}</TableCell>
                <TableCell className="text-right">
                  <NumberFormat value={expense.amount} />
                </TableCell>
                <TableCell>{t(expense.allocationMethod)}</TableCell>
                <TableCell>
                  {expense.isRecurring ? (
                    <Badge variant="default">{t('Yes')}</Badge>
                  ) : (
                    <Badge variant="secondary">{t('No')}</Badge>
                  )}
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
        buildingId={building?._id}
      />

      <ConfirmDialog
        title={t('Are you sure to remove this expense?')}
        subTitle={expenseToDelete?.name}
        open={openConfirmDelete}
        setOpen={setOpenConfirmDelete}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
