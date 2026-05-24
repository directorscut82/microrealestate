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

/*
 * PendingBills — DESIGN.md ledger pattern.
 *
 * Building groups stack as labeled tables (no nested cards). Overdue rows
 * tint the entire row in oxide-tint (full background, never side-stripe).
 * Numbers use the table's numeric column treatment.
 */

export default function PendingBills({ className, dashboardData }) {
  const { t } = useTranslation('common');
  const pendingBills = dashboardData?.pendingBills || [];

  const totalPending = useMemo(
    () =>
      pendingBills.reduce(
        (sum, group) =>
          sum + group.bills.reduce((s, b) => s + (b.totalAmount || 0), 0),
        0
      ),
    [pendingBills]
  );

  const now = useMemo(() => moment(), []);
  const overdueBills = useMemo(
    () =>
      pendingBills.flatMap((group) =>
        group.bills.filter(
          (b) => b.dueDate && moment(b.dueDate).isBefore(now, 'day')
        )
      ),
    [pendingBills, now]
  );

  if (!pendingBills.length) return null;

  return (
    <Card className={cn('', className)}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <CardTitle className="font-sans text-title font-semibold flex items-center gap-2 text-ink">
              <LuReceipt className="size-4 text-ink-muted" />
              {t('Pending Bills')}
            </CardTitle>
            <CardDescription>
              {t('Utility bills awaiting payment')}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {overdueBills.length > 0 && (
              <Badge variant="overdue">
                <LuAlertTriangle className="size-3" />
                {overdueBills.length} {t('overdue')}
              </Badge>
            )}
            <span className="font-mono tabular-nums text-title font-semibold text-ink">
              <NumberFormat value={totalPending} showZero={true} />
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-5">
          {pendingBills.map((group) => (
            <div key={group.buildingId}>
              <div className="text-label font-medium text-ink-muted uppercase tracking-wide mb-2 px-1">
                {group.buildingName}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Expense')}</TableHead>
                    <TableHead numeric>{t('Amount')}</TableHead>
                    <TableHead numeric>{t('Due date')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.bills.map((bill) => {
                    const isOverdue =
                      bill.dueDate && moment(bill.dueDate).isBefore(now, 'day');
                    return (
                      <TableRow
                        key={bill._id}
                        className={cn(
                          isOverdue && 'bg-oxide-tint/60 hover:bg-oxide-tint'
                        )}
                      >
                        <TableCell>
                          <div className="text-ink">{bill.expenseName}</div>
                          {bill.periodStart && bill.periodEnd && (
                            <div className="text-label text-ink-muted mt-0.5">
                              {moment(bill.periodStart).format('DD/MM')}
                              {' – '}
                              {moment(bill.periodEnd).format('DD/MM/YY')}
                            </div>
                          )}
                        </TableCell>
                        <TableCell numeric className="font-medium">
                          <NumberFormat
                            value={bill.totalAmount}
                            showZero={true}
                          />
                        </TableCell>
                        <TableCell numeric>
                          {bill.dueDate ? (
                            <span
                              className={cn(
                                'font-mono tabular-nums',
                                isOverdue
                                  ? 'text-oxide font-semibold'
                                  : 'text-ink'
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
