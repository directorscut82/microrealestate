import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '../ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { LuAlertTriangle, LuReceipt } from 'react-icons/lu';
import { Badge } from '../ui/badge';
import { cn } from '../../utils';
import moment from 'moment';
import { useMemo } from 'react';
import NumberFormat from '../NumberFormat';
import useTranslation from 'next-translate/useTranslation';

export default function PendingBills({ className, dashboardData }) {
  const { t } = useTranslation('common');
  const pendingBills = dashboardData?.pendingBills || [];

  if (!pendingBills.length) return null;

  const totalPending = useMemo(() => pendingBills.reduce(
    (sum, group) =>
      sum + group.bills.reduce((s, b) => s + (b.totalAmount || 0), 0),
    0
  ), [pendingBills]);

  const now = useMemo(() => moment(), []);
  const overdueBills = useMemo(() => pendingBills.flatMap((group) =>
    group.bills.filter((b) => b.dueDate && moment(b.dueDate).isBefore(now, 'day'))
  ), [pendingBills, now]);

  return (
    <Card className={cn('', className)}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between font-normal text-xs xl:text-base">
          <span className="flex items-center gap-2">
            <LuReceipt className="size-5" />
            {t('Pending Bills')}
          </span>
          {overdueBills.length > 0 && (
            <Badge variant="destructive" className="text-xs">
              <LuAlertTriangle className="size-3 mr-1" />
              {overdueBills.length} {t('overdue')}
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="flex justify-between text-xs">
          <span>
            {t('Utility bills awaiting payment')}
          </span>
          <span className="font-medium">
            <NumberFormat value={totalPending} showZero={true} />
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {pendingBills.map((group) => (
            <div key={group.buildingId}>
              <div className="text-sm font-medium text-muted-foreground mb-2">
                {group.buildingName}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{t('Expense')}</TableHead>
                    <TableHead className="text-xs text-right">
                      {t('Amount')}
                    </TableHead>
                    <TableHead className="text-xs text-right">
                      {t('Due date')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.bills.map((bill) => {
                    const isOverdue =
                      bill.dueDate &&
                      moment(bill.dueDate).isBefore(now, 'day');
                    return (
                      <TableRow
                        key={bill._id}
                        className={cn(isOverdue && 'bg-destructive/5')}
                      >
                        <TableCell className="text-sm">
                          <div>{bill.expenseName}</div>
                          {bill.periodStart && bill.periodEnd && (
                            <div className="text-xs text-muted-foreground">
                              {moment(bill.periodStart).format('DD/MM')} —{' '}
                              {moment(bill.periodEnd).format('DD/MM/YY')}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-right font-medium">
                          <NumberFormat
                            value={bill.totalAmount}
                            showZero={true}
                          />
                        </TableCell>
                        <TableCell className="text-sm text-right">
                          {bill.dueDate ? (
                            <span
                              className={cn(
                                isOverdue && 'text-destructive font-medium'
                              )}
                            >
                              {moment(bill.dueDate).format('DD/MM/YY')}
                            </span>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
