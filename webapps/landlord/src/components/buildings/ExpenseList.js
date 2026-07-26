import {
  addBuildingExpense,
  fetchTenants,
  QueryKeys,
  removeBuildingExpense,
  updateBuildingExpense
} from '../../utils/restcalls';
import {
  LuAlertTriangle,
  LuCalendarX2,
  LuFileUp,
  LuPencil,
  LuPlusCircle,
  LuTrash,
  LuTrash2
} from 'react-icons/lu';
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import NumberFormat from '../NumberFormat';
import BillImportDialog from './BillImportDialog';
import PaymentReceiptDialog from './PaymentReceiptDialog';
import ResponsiveDialog from '../ResponsiveDialog';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import useTranslation from 'next-translate/useTranslation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

import {
  ExpenseFormDialog,
  expenseTypes,
  allocationMethods,
  ALLOCATION_DESCRIPTIONS
} from './ExpenseFormDialog';


export default function ExpenseList({ building, onAddRepair }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [openExpenseDialog, setOpenExpenseDialog] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState(null);
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false);
  const [expenseToDelete, setExpenseToDelete] = useState(null);
  const [openBillImport, setOpenBillImport] = useState(false);
  const [openPaymentReceipt, setOpenPaymentReceipt] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const removeMutation = useMutation({
    mutationFn: ({ expenseId, mode }) =>
      removeBuildingExpense(building._id, expenseId, mode),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building._id]
      });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      // Deleting an expense must also refresh the ΧΡΕΩΣΕΙΣ breakdown panel
      // (separate query key) + the owner ledger / accounting surfaces.
      queryClient.invalidateQueries({ queryKey: ['expense-breakdown'] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.OWNERS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
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
    // Also count owner monthly expenses
    for (const e of building.ownerMonthlyExpenses || []) {
      if (String(e.expenseId) === expId) terms.add(e.term);
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
      // Surface the server's specific message when it has one — e.g. the
      // hard-delete guard 422 "linked bill(s) have recorded payments; use soft
      // delete" — a generic toast would hide the actionable guidance.
      const serverMessage =
        error?.response?.data?.error || error?.response?.data?.message;
      toast.error(serverMessage || t('Something went wrong'));
    } finally {
      setIsDeleting(false);
    }
  }, [expenseToDelete, removeMutation, t]);

  const expenses = building?.expenses || [];

  return (
    <div>
      <div className="mb-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="gap-2"
            onClick={handleAddExpense}
            data-cy="addExpense"
          >
            <LuPlusCircle className="size-4" />
            {t('Add Expense')}
          </Button>
          {/* "Add repair" sits IMMEDIATELY after "Add expense" (both are the
              "add a charge" actions; repairs ARE expenses). It triggers
              RepairList's dialog via the onAddRepair callback the page wires to
              RepairList's ref. */}
          {onAddRepair && (
            <Button
              variant="secondary"
              className="gap-2"
              onClick={onAddRepair}
              data-cy="addRepair"
            >
              <LuPlusCircle className="size-4" />
              {t('Add repair')}
            </Button>
          )}
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => setOpenBillImport(true)}
            data-cy="importBill"
          >
            <LuFileUp className="size-4" />
            {t('Import Bill')}
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => setOpenPaymentReceipt(true)}
            data-cy="paymentReceipt"
          >
            <LuFileUp className="size-4" />
            {t('Payment Receipts')}
          </Button>
        </div>
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
                <TableCell>
                  {/* The Όνομα column shows the declared name VERBATIM (user
                      rule, 2026-06: never hide a typed name — the Τύπος column
                      beside it already shows the kind). No id-hiding here. */}
                  {expense.name}
                </TableCell>
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
                          {/* Recurring status is metadata, not a primary
                              action — use quiet tinted variants, not the
                              solid-ink default (reserved for primary buttons). */}
                          {expense.isRecurring && expense.amount > 0 ? (
                            <Badge variant="pending">{t('Yes')}</Badge>
                          ) : expense.isRecurring && !expense.amount ? (
                            <Badge variant="pending">
                              {t('Yes')} ({t('variable')})
                            </Badge>
                          ) : (
                            <Badge variant="neutral">{t('No')}</Badge>
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
                  {expense.trackOwnerExpense && (
                    <Badge
                      variant="outline"
                      className="ml-1.5 text-[10px] px-1.5"
                    >
                      {t('owner')}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEditExpense(expense)}
                    aria-label={t('Edit')}
                    >
                      <LuPencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteExpense(expense)}
                    aria-label={t('Delete')}
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
            <DialogTitle>
              {t('Delete expense')}: {expenseToDelete?.name}
            </DialogTitle>
            <DialogDescription>
              {t('Choose how to handle this expense.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {deleteImpact.months > 0 && (
              <div className="flex gap-3 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm dark:bg-amber-950/30 dark:border-amber-800">
                <LuAlertTriangle className="size-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                <p className="font-medium text-amber-800 dark:text-amber-200">
                  {t('This expense has {{count}} months of recorded charges.', { count: deleteImpact.months })}
                </p>
                <p className="text-amber-700/80 dark:text-amber-300/80 text-xs mt-0.5">
                  {t('Permanent deletion will remove historical charges and may create tenant credit balances.')}
                </p>
                </div>
              </div>
            )}
            <div className="space-y-3">
              <button
                type="button"
                className="w-full rounded-lg border border-border p-4 text-left hover:bg-muted/50 transition-colors disabled:opacity-50"
                disabled={isDeleting}
                onClick={() => handleDelete('soft')}
              >
                <div className="flex gap-3 items-start">
                  <div className="rounded-full bg-muted p-2 shrink-0">
                    <LuCalendarX2 className="size-4 text-muted-foreground" />
                  </div>
                  <div>
                    <span className="font-medium text-sm">
                      {t('End from current month')}
                    </span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                    {t('Keeps historical charges intact. Stops applying from this month.')}
                    </span>
                  </div>
                </div>
              </button>
              <button
                type="button"
                className="w-full rounded-lg border border-destructive/30 p-4 text-left hover:bg-destructive/5 transition-colors disabled:opacity-50"
                disabled={isDeleting}
                onClick={() => handleDelete('hard')}
              >
                <div className="flex gap-3 items-start">
                  <div className="rounded-full bg-destructive/10 p-2 shrink-0">
                    <LuTrash2 className="size-4 text-destructive" />
                  </div>
                  <div>
                    <span className="font-medium text-sm text-destructive">
                      {t('Delete permanently')}
                    </span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {t('Removes charges from all months. Tenant balances will change.')}
                    </span>
                  </div>
                </div>
              </button>
            </div>
          </div>
          <DialogFooter className="sm:justify-center">
            <Button
              variant="ghost"
              onClick={() => setOpenConfirmDelete(false)}
            >
              {t('Cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* BuildingExpensePanel (the month calendar + ΧΡΕΩΣΕΙΣ breakdown) is
          rendered by the page AFTER RepairList, so Επισκευές sits before the
          dates + right panel (user-specified order). */}

      <BillImportDialog
        open={openBillImport}
        setOpen={setOpenBillImport}
        building={building}
      />
      <PaymentReceiptDialog
        open={openPaymentReceipt}
        setOpen={setOpenPaymentReceipt}
        building={building}
      />
    </div>
  );
}
