import { getRentAmounts, RentAmount } from './RentDetails';
import { LuHistory, LuPaperclip } from 'react-icons/lu';
import { useCallback, useContext, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { cn } from '../../utils';
import { downloadDocument } from '../../utils/fetch';
import { EmptyIllustration } from '../Illustrations';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import NewPaymentDialog from '../payment/NewPaymentDialog';
import RentHistoryDialog from './RentHistoryDialog';
import { Separator } from '../ui/separator';
import { StoreContext } from '../../store';
import { TbCashRegister } from 'react-icons/tb';
import Tooltip from '../Tooltip';
import {
  Tooltip as SCNTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/tooltip';
import useTranslation from 'next-translate/useTranslation';

function Reminder({ rent, className }) {
  const { t } = useTranslation('common');

  let label;
  let sentDate;
  let color = 'text-muted-foreground';
  let endpoint;
  let documentName;

  if (rent.emailStatus?.status?.rentcall) {
    sentDate = moment(rent.emailStatus.last.rentcall.sentDate);
    label = t('1st notice sent on {{date}}', {
      date: sentDate.format('L LT')
    });
    documentName = `${rent.occupant.name}-${t('first notice')}.pdf`;
    endpoint = `/documents/rentcall/${rent.occupant._id}/${rent.term}`;
  }

  if (rent.emailStatus?.last?.rentcall_reminder) {
    sentDate = moment(rent.emailStatus.last.rentcall_reminder.sentDate);
    label = t('2nd notice sent on {{date}}', {
      date: sentDate.format('L LT')
    });
    documentName = `${rent.occupant.name}-${t('second notice')}.pdf`;
    endpoint = `/documents/rentcall_reminder/${rent.occupant._id}/${rent.term}`;
  }

  if (rent.emailStatus?.last?.rentcall_last_reminder) {
    sentDate = moment(rent.emailStatus.last.rentcall_last_reminder.sentDate);
    label = t('Last notice sent on {{date}}', {
      date: sentDate.format('L LT')
    });
    color = 'text-warning';
    documentName = `${rent.occupant.name}-${t('last notice')}.pdf`;
    endpoint = `/documents/rentcall_last_reminder/${rent.occupant._id}/${rent.term}`;
  }

  if (rent.emailStatus?.last?.invoice) {
    sentDate = moment(rent.emailStatus.last.invoice.sentDate);
    label = t('Invoice sent on {{date}}', { date: sentDate.format('L LT') });
    color = 'text-success';
    documentName = `${rent.occupant.name}-${t('invoice')}.pdf`;
    endpoint = `/documents/invoice/${rent.occupant._id}/${rent.term}`;
  }

  const visible = label && sentDate;

  const handleDownloadClick = useCallback(() => {
    downloadDocument({ endpoint, documentName });
  }, [documentName, endpoint]);

  return visible ? (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'rounded-lg text-xs bg-muted font-normal h-fit gap-1 px-1 py-0.5',
        color,
        `hover:${color}`,
        className
      )}
      onClick={handleDownloadClick}
    >
      <LuPaperclip className="size-4" />
      <div className="whitespace-normal">{label}</div>
    </Button>
  ) : null;
}

function MonthlyBreakdown({ rentAmounts }) {
  const { t } = useTranslation('common');
  const hasMultiple = rentAmounts.preTaxAmounts.length > 1;
  const hasCharges = rentAmounts.charges.length > 0;
  const hasBuildingCharges = rentAmounts.buildingCharges.length > 0;

  if (!hasMultiple && !hasCharges && !hasBuildingCharges) {
    return null;
  }

  return (
    <div className="space-y-1 text-xs min-w-36">
      {rentAmounts.preTaxAmounts.map((item, i) => (
        <div key={`r-${i}`} className="flex justify-between gap-4">
          <span className="text-muted-foreground truncate">
            {hasMultiple ? item.description : t('Rent')}
          </span>
          <NumberFormat value={item.amount} className="whitespace-nowrap" />
        </div>
      ))}
      {hasCharges && rentAmounts.charges.map((charge, i) => (
        <div key={`c-${i}`} className="flex justify-between gap-4">
          <span className="text-muted-foreground truncate">
            {charge.description || t('Extra charges')}
          </span>
          <NumberFormat value={charge.amount} className="whitespace-nowrap" />
        </div>
      ))}
      {hasBuildingCharges && rentAmounts.buildingCharges.map((charge, i) => (
        <div key={`b-${i}`} className="flex justify-between gap-4">
          <span className="text-muted-foreground truncate">
            {charge.buildingName
              ? `${charge.buildingName} - ${charge.description}`
              : charge.description}
          </span>
          <NumberFormat value={charge.amount} className="whitespace-nowrap" />
        </div>
      ))}
      <Separator className="my-0.5" />
      <div className="flex justify-between gap-4 font-medium">
        <span>{t('Total')}</span>
        <NumberFormat value={rentAmounts.rent} className="whitespace-nowrap" />
      </div>
    </div>
  );
}

// Wave-26: derive a single-glance payment status from the server's
// computed `rent.status`. Four states, rendered as a small colored dot
// at the start of each row. The legend below the table explains the
// color codes; per-row labels would only repeat what the legend says.
//   - paid          → olive
//   - partial       → amber
//   - owed          → oxide-red
//   - no charge     → slate (grandTotal === 0 — fully discounted month etc.)
function _statusKey(rent) {
  const grandTotal = Number(rent.totalAmount) || 0;
  if (Math.abs(grandTotal) < 0.005) return 'none';
  if (rent.status === 'paid') return 'paid';
  if (rent.status === 'partiallypaid') return 'partial';
  return 'owed';
}

const STATUS_DOT_CLASS = {
  paid: 'bg-olive',
  partial: 'bg-amber-500',
  owed: 'bg-oxide',
  none: 'bg-slate-400'
};

// Wave-26: hover on the Payment cell shows "Owed remaining = grandTotal -
// payment" so the user can see the resulting balance without doing math.
function PaymentBreakdown({ rent, t }) {
  const grandTotal = Number(rent.totalAmount) || 0;
  const paid = Number(rent.payment) || 0;
  const remaining = grandTotal - paid;
  return (
    <div className="text-xs space-y-1 min-w-[200px]">
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">{t('Total due')}</span>
        <NumberFormat value={grandTotal} showZero />
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">{t('Paid')}</span>
        <NumberFormat value={paid} showZero />
      </div>
      <div className="flex justify-between gap-4 pt-1 border-t border-border/40 font-medium">
        <span>{t('Owed remaining')}</span>
        <NumberFormat value={remaining > 0 ? remaining : 0} showZero />
      </div>
      {remaining < 0 && (
        <div className="flex justify-between gap-4 text-blue-700">
          <span>{t('Overpayment')}</span>
          <NumberFormat value={-remaining} showZero />
        </div>
      )}
    </div>
  );
}

// Wave-26: hover on Previous balance shows where the carry-in came from.
// When 0–6 contributing prior months: list each. When more, bucket into
// 3- or 6-month chunks so the tooltip stays compact. The breakdown comes
// from rent.priorRents (added server-side in rentmanager.ts), which lists
// ONLY months that contributed a non-zero new-balance.
function _bucketPriorRents(priorRents) {
  // Wave-26 round-3d adaptive chunking:
  //   ≤3 months → list each month
  //   4–12 months → 3-month chunks
  //   >12 months → 6-month chunks
  if (priorRents.length <= 3) {
    return priorRents.map((pr) => {
      const term = String(pr.term);
      return {
        key: term,
        label: moment(`${term.slice(0, 4)}-${term.slice(4, 6)}-01`).format(
          'MMM YYYY'
        ),
        amount: -(Number(pr.newBalance) || 0)
      };
    });
  }
  const chunkSize = priorRents.length <= 12 ? 3 : 6;
  const buckets = [];
  for (let i = 0; i < priorRents.length; i += chunkSize) {
    const slice = priorRents.slice(i, i + chunkSize);
    const sum = slice.reduce((s, pr) => s - (Number(pr.newBalance) || 0), 0);
    const startTerm = String(slice[0].term);
    const endTerm = String(slice[slice.length - 1].term);
    const startLabel = moment(
      `${startTerm.slice(0, 4)}-${startTerm.slice(4, 6)}-01`
    ).format('MMM YYYY');
    const endLabel = moment(
      `${endTerm.slice(0, 4)}-${endTerm.slice(4, 6)}-01`
    ).format('MMM YYYY');
    buckets.push({
      key: startTerm,
      label: `${startLabel} – ${endLabel}`,
      amount: sum
    });
  }
  return buckets;
}

function PriorBalanceBreakdown({ rent }) {
  const { t } = useTranslation('common');
  const balance = Number(rent.balance) || 0;
  const priorRents = Array.isArray(rent.priorRents) ? rent.priorRents : [];

  if (priorRents.length === 0) {
    if (Math.abs(balance) < 0.005) {
      return (
        <div className="text-xs text-muted-foreground min-w-[200px]">
          {t('No previous balance carried over.')}
        </div>
      );
    }
    return (
      <div className="text-xs space-y-1 min-w-[200px]">
        <div className="text-muted-foreground">
          {t('Carried over from previous months')}
        </div>
        <div className="flex justify-between gap-4 font-medium pt-1 border-t border-border/40">
          <span>{t('Total')}</span>
          <NumberFormat value={balance} showZero />
        </div>
      </div>
    );
  }

  const buckets = _bucketPriorRents(priorRents);
  return (
    <div className="text-xs space-y-1 min-w-[240px]">
      {buckets.map((b) => (
        <div key={b.key} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{b.label}</span>
          <NumberFormat value={b.amount} showZero />
        </div>
      ))}
      <div className="flex justify-between gap-4 pt-1 border-t border-border/40 font-medium">
        <span>{t('Carried over')}</span>
        <NumberFormat value={balance} showZero />
      </div>
    </div>
  );
}

function StatusDot({ rent }) {
  const key = _statusKey(rent);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2.5 rounded-full shrink-0',
        STATUS_DOT_CLASS[key]
      )}
      data-cy={`status-${key}`}
    />
  );
}

function StatusLegend() {
  const { t } = useTranslation('common');
  const items = [
    { key: 'paid', label: t('Paid') },
    { key: 'partial', label: t('Partial') },
    { key: 'owed', label: t('Owed') },
    { key: 'none', label: t('No charge') }
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs text-muted-foreground">
      {items.map((it) => (
        <span key={it.key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              'inline-block size-2 rounded-full',
              STATUS_DOT_CLASS[it.key]
            )}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function RentRow({ rent, isSelected, onSelect, onEdit, onHistory }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const rentAmounts = getRentAmounts(rent);
  const hasBreakdown =
    rentAmounts.preTaxAmounts.length > 1 ||
    rentAmounts.charges.length > 0 ||
    rentAmounts.buildingCharges.length > 0;

  return (
    <>
      <div className="flex flex-col gap-4 md:gap-0 md:flex-row md:items-center">
        <div className="w-full md:w-2/6 space-y-2">
          <div className="flex items-center gap-4">
            {store.organization.canSendEmails ? (
              rent.occupant.hasContactEmails ? (
                <Checkbox
                  checked={isSelected}
                  disabled={!store.organization.canSendEmails}
                  onCheckedChange={onSelect(rent)}
                  aria-labelledby={rent.occupant.name}
                />
              ) : (
                <Tooltip title={t('No emails available for this tenant')}>
                  <Checkbox
                    onCheckedChange={onSelect(rent)}
                    aria-labelledby={rent.occupant.name}
                    disabled
                  />
                </Tooltip>
              )
            ) : null}

            {/* Wave-26 round-3d: small colored dot indicates status; the
                legend below the table explains the colors. Name is plain
                text — only the right-side cash-register icon opens the
                payment dialog. */}
            <StatusDot rent={rent} />
            <span className="text-lg font-medium leading-tight">
              {rent.occupant.name}
            </span>
          </div>
          {rentAmounts.discount < 0 && (
            <div className="ml-8 text-xs text-muted-foreground italic">
              {t('Discount')}:{' '}
              <NumberFormat value={rentAmounts.discount} showZero />
            </div>
          )}
          <Reminder rent={rent} className="hidden md:inline-flex ml-8" />
        </div>
        <div className="flex pl-8 md:pl-0 md:grid md:grid-cols-3 lg:grid-cols-5 gap-4 w-full md:w-4/6">
          {hasBreakdown ? (
            <TooltipProvider delayDuration={200}>
              <SCNTooltip>
                <TooltipTrigger asChild>
                  <div className="hidden lg:block cursor-default">
                    <RentAmount
                      label={t('Monthly amount')}
                      amount={rentAmounts.rent}
                      withColor={false}
                      className="text-muted-foreground underline decoration-dotted underline-offset-2"
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent className="bg-popover/80 backdrop-blur-md border-border/50 shadow-lg p-3">
                  <MonthlyBreakdown rentAmounts={rentAmounts} />
                </TooltipContent>
              </SCNTooltip>
            </TooltipProvider>
          ) : (
            <RentAmount
              label={t('Monthly amount')}
              amount={rentAmounts.rent}
              withColor={false}
              className="hidden lg:block text-muted-foreground"
            />
          )}
          {/* Wave-26: Previous balance now hovers a per-prior-month
              breakdown so the carry-in number isn't a mystery. */}
          <TooltipProvider delayDuration={200}>
            <SCNTooltip>
              <TooltipTrigger asChild>
                <div className="hidden lg:block cursor-default">
                  <RentAmount
                    label={t('Previous balance')}
                    amount={rentAmounts.balance}
                    withColor={false}
                    className="text-muted-foreground underline decoration-dotted underline-offset-2"
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent className="bg-popover/80 backdrop-blur-md border-border/50 shadow-lg p-3">
                <PriorBalanceBreakdown rent={rent} />
              </TooltipContent>
            </SCNTooltip>
          </TooltipProvider>
          <RentAmount
            label={t('Total due')}
            amount={rentAmounts.totalAmount}
            withColor={false}
            debitColor={rentAmounts.totalAmount > 0}
            creditColor={rentAmounts.totalAmount < 0}
            className={rentAmounts.totalAmount !== 0 ? 'font-bold' : ''}
          />
          {/* Wave-26: Payment column hovers a remaining-owed line so the
              user can see at a glance "how much is still due." */}
          <TooltipProvider delayDuration={200}>
            <SCNTooltip>
              <TooltipTrigger asChild>
                <div className="grow cursor-default">
                  <RentAmount
                    label={t('Payment')}
                    amount={rent.payment}
                    className={cn(
                      rentAmounts.payment > 0 ? 'font-bold' : '',
                      'underline decoration-dotted underline-offset-2'
                    )}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent className="bg-popover/80 backdrop-blur-md border-border/50 shadow-lg p-3">
                <PaymentBreakdown rent={rent} t={t} />
              </TooltipContent>
            </SCNTooltip>
          </TooltipProvider>
          <div className="text-right space-x-2 grow whitespace-nowrap">
            <Button
              variant="ghost"
              size="icon"
              onClick={onEdit(rent)}
              className="hidden sm:inline-flex"
            >
              <TbCashRegister className="size-6" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onHistory(rent)}>
              <LuHistory className="size-6" />
            </Button>
          </div>
        </div>
        <Reminder rent={rent} className="md:hidden w-fit" />
      </div>
    </>
  );
}

function RentTable({ rents = [], selected, setSelected }) {
  const store = useContext(StoreContext);
  const { t } = useTranslation('common');
  const [openNewPaymentDialog, setOpenNewPaymentDialog] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState(null);
  const [openRentHistoryDialog, setOpenRentHistoryDialog] = useState(false);
  const [selectedRentHistory, setSelectedRentHistory] = useState(null);

  const selectableRentNum = useMemo(() => {
    return rents.reduce((acc, { _id, occupant: { hasContactEmails } }) => {
      if (hasContactEmails) {
        acc.push(_id);
      }
      return acc;
    }, []).length;
  }, [rents]);

  const onSelectAllClick = useCallback(
    (checked) => {
      let rentSelected = [];
      if (checked) {
        rentSelected = rents.filter((rent) => rent.occupant.hasContactEmails);
      }
      setSelected?.(rentSelected);
    },
    [rents, setSelected]
  );

  const onSelectClick = useCallback(
    (rent) => (checked) => {
      let rentSelected = [];
      if (checked) {
        rentSelected = [...selected, rent];
      } else {
        rentSelected = selected.filter((r) => r._id !== rent._id);
      }
      setSelected?.(rentSelected);
    },
    [selected, setSelected]
  );

  const handleEdit = useCallback(
    (rent) => () => {
      setSelectedPayment(rent);
      setOpenNewPaymentDialog(true);
    },
    [setOpenNewPaymentDialog, setSelectedPayment]
  );

  const handleHistory = useCallback(
    (rent) => () => {
      setSelectedRentHistory(rent.occupant);
      setOpenRentHistoryDialog(true);
    },
    [setOpenRentHistoryDialog, setSelectedRentHistory]
  );

  return (
    <>
      <NewPaymentDialog
        open={openNewPaymentDialog}
        setOpen={setOpenNewPaymentDialog}
        data={selectedPayment}
      />

      <RentHistoryDialog
        open={openRentHistoryDialog}
        setOpen={setOpenRentHistoryDialog}
        data={selectedRentHistory}
      />

      {rents.length ? (
        <Card className="p-6">
          {store.organization.canSendEmails ? (
            <div className="space-y-2">
              <Checkbox
                checked={
                  selected.length > 0 && selected.length < selectableRentNum
                    ? 'intermediate'
                    : selected.length === selectableRentNum
                }
                disabled={!store.organization.canSendEmails}
                onCheckedChange={onSelectAllClick}
                aria-labelledby={t('select all rents')}
              />
              <Separator className="my-1" />
            </div>
          ) : null}
          {rents.map((rent) => {
            const isItemSelected = selected
              .map((r) => r._id)
              .includes(rent._id);
            return (
              <div key={`${rent._id}_${rent.term}`}>
                <div className="my-3">
                  <RentRow
                    rent={rent}
                    isSelected={isItemSelected}
                    onSelect={onSelectClick}
                    onEdit={handleEdit}
                    onHistory={handleHistory}
                  />
                </div>
                <Separator />
              </div>
            );
          })}
          <StatusLegend />
        </Card>
      ) : (
        <EmptyIllustration label={t('No rents found')} />
      )}
    </>
  );
}

export default RentTable;
