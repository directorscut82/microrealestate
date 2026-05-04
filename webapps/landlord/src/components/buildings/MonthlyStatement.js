import {
  QueryKeys,
  saveMonthlyStatement
} from '../../utils/restcalls';
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/tooltip';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';
import moment from 'moment';

const ALLOCATION_LABELS = {
  equal: 'Equal',
  by_surface: 'By Surface',
  general_thousandths: 'General ‰',
  heating_thousandths: 'Heating ‰',
  elevator_thousandths: 'Elevator ‰',
  fixed: 'Fixed',
  custom_ratio: 'Custom Ratio',
  custom_percentage: 'Custom Percentage'
};

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

function generateTermOptions() {
  const options = [];
  const now = moment();
  for (let i = -24; i <= 6; i++) {
    const m = moment(now).add(i, 'months').startOf('month');
    options.push({
      value: m.format('YYYYMMDDHH'),
      label: m.format('MMMM YYYY')
    });
  }
  return options;
}

function getExistingAmounts(building, term) {
  const amounts = {};
  const units = building?.units || [];
  const expenses = building?.expenses || [];

  for (const expense of expenses) {
    let total = 0;
    for (const unit of units) {
      if (!unit.monthlyCharges) continue;
      const charges = unit.monthlyCharges.filter(
        (c) =>
          c.term === Number(term) &&
          (c.description === expense.name ||
            c.expenseId === expense._id)
      );
      for (const c of charges) {
        total += c.amount || 0;
      }
    }
    if (total > 0) {
      amounts[expense._id] = total;
    }
  }
  return amounts;
}

function getExistingOwnerAmounts(building, term) {
  const amounts = {};
  const ownerExpenses = building?.ownerMonthlyExpenses || [];
  for (const entry of ownerExpenses) {
    if (entry.term === Number(term)) {
      amounts[entry.expenseId] = entry.amount;
    }
  }
  return amounts;
}

export default function MonthlyStatement({ building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [amounts, setAmounts] = useState({});
  const [ownerAmounts, setOwnerAmounts] = useState({});
  const [isLoading, setIsLoading] = useState(false);

  const termOptions = useMemo(() => generateTermOptions(), []);

  // Auto-select current month
  const currentTerm = useMemo(
    () => moment().startOf('month').format('YYYYMMDDHH'),
    []
  );
  const [selectedTerm, setSelectedTerm] = useState(currentTerm);

  // Variable recurring tenant expenses (isRecurring + no fixed amount)
  const tenantExpenses = useMemo(
    () => (building?.expenses || []).filter((e) => e.isRecurring && !e.amount),
    [building?.expenses]
  );

  // Variable recurring owner expenses (trackOwnerExpense + isRecurring + no fixed ownerAmount)
  const ownerExpenses = useMemo(
    () =>
      (building?.expenses || []).filter(
        (e) => e.trackOwnerExpense && e.isRecurring && !e.ownerAmount
      ),
    [building?.expenses]
  );

  const hasAnyExpenses = tenantExpenses.length > 0 || ownerExpenses.length > 0;

  const mutation = useMutation({
    mutationFn: (data) => saveMonthlyStatement(building._id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building._id]
      });
    }
  });

  const handleTermChange = useCallback(
    (term) => {
      setSelectedTerm(term);
      setAmounts(getExistingAmounts(building, term));
      setOwnerAmounts(getExistingOwnerAmounts(building, term));
    },
    [building]
  );

  // Load existing amounts for current month on mount
  useEffect(() => {
    if (selectedTerm && building) {
      setAmounts(getExistingAmounts(building, selectedTerm));
      setOwnerAmounts(getExistingOwnerAmounts(building, selectedTerm));
    }
  }, [building, selectedTerm]);

  const handleAmountChange = useCallback((expenseId, value) => {
    setAmounts((prev) => ({
      ...prev,
      [expenseId]: value === '' ? '' : Number(value)
    }));
  }, []);

  const handleOwnerAmountChange = useCallback((expenseId, value) => {
    setOwnerAmounts((prev) => ({
      ...prev,
      [expenseId]: value === '' ? '' : Number(value)
    }));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!selectedTerm) {
      toast.error(t('Please select a month'));
      return;
    }

    const expenseEntries = tenantExpenses
      .map((expense) => ({
        expenseId: expense._id,
        amount: Number(amounts[expense._id]) || 0,
        description: expense.name,
        allocationMethod: expense.allocationMethod
      }))
      .filter((e) => e.amount > 0);

    const ownerEntries = ownerExpenses
      .map((expense) => ({
        expenseId: expense._id,
        amount: Number(ownerAmounts[expense._id]) || 0,
        description: expense.name
      }))
      .filter((e) => e.amount > 0);

    if (expenseEntries.length === 0 && ownerEntries.length === 0) {
      toast.error(t('Please enter at least one amount'));
      return;
    }

    try {
      setIsLoading(true);
      await mutation.mutateAsync({
        term: Number(selectedTerm),
        expenses: expenseEntries,
        ownerExpenses: ownerEntries
      });
      toast.success(t('Monthly statement saved'));
    } catch (error) {
      toast.error(t('Something went wrong'));
    } finally {
      setIsLoading(false);
    }
  }, [selectedTerm, tenantExpenses, ownerExpenses, amounts, ownerAmounts, mutation, t]);

  if (!hasAnyExpenses) {
    return null;
  }

  return (
    <div>
      <h3 className="text-lg font-medium mb-4">
        {t('Monthly Statement')}
      </h3>
      <p className="text-sm text-muted-foreground mb-4">
        {t(
          'Enter actual expense amounts for a specific month. Amounts will be distributed to units based on allocation method.'
        )}
      </p>

      <div className="flex gap-4 items-end mb-4">
        <div className="w-64">
          <Select value={selectedTerm} onValueChange={handleTermChange}>
            <SelectTrigger>
              <SelectValue placeholder={t('Select month')} />
            </SelectTrigger>
            <SelectContent>
              {termOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {selectedTerm && (
        <>
          {tenantExpenses.length > 0 && (
            <>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                {t('Tenant charges')}
              </h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Expense')}</TableHead>
                    <TableHead>{t('Allocation')}</TableHead>
                    <TableHead className="text-right">
                      {t('Amount')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenantExpenses.map((expense) => (
                    <TableRow key={expense._id}>
                      <TableCell>{expense.name}</TableCell>
                      <TableCell className="text-sm">
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-muted-foreground border-b border-dotted border-muted-foreground/50 cursor-help">
                                {t(
                                  ALLOCATION_LABELS[expense.allocationMethod] ||
                                    expense.allocationMethod
                                )}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-[240px] text-xs">
                              {t(ALLOCATION_DESCRIPTIONS[expense.allocationMethod] || '')}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          className="w-32 ml-auto text-right"
                          value={amounts[expense._id] ?? ''}
                          onChange={(e) =>
                            handleAmountChange(expense._id, e.target.value)
                          }
                          placeholder="0.00"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}

          {ownerExpenses.length > 0 && (
            <>
              <h4 className="text-sm font-medium text-muted-foreground mb-2 mt-6">
                {t('Owner expenses')}
              </h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Expense')}</TableHead>
                    <TableHead className="text-right">
                      {t('Amount')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ownerExpenses.map((expense) => (
                    <TableRow key={expense._id}>
                      <TableCell>{expense.name}</TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          className="w-32 ml-auto text-right"
                          value={ownerAmounts[expense._id] ?? ''}
                          onChange={(e) =>
                            handleOwnerAmountChange(expense._id, e.target.value)
                          }
                          placeholder="0.00"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}

          <div className="mt-4 flex justify-end">
            <Button onClick={handleSubmit} disabled={isLoading}>
              {isLoading ? t('Saving...') : t('Save Statement')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
