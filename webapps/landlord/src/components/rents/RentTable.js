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

// Wave-26: derive a single-glance payment status pill from the server's
// computed `rent.status` plus the gross/paid amounts. Four states:
//   - paid          → olive
//   - partial       → amber, shows remaining
//   - owed          → oxide-red, shows amount owed
//   - no charge     → slate (grandTotal === 0 — fully discounted month etc.)
function _statusPillData(rent, t) {
  const grandTotal = Number(rent.totalAmount) || 0;
  const paid = Number(rent.payment) || 0;
  const remaining = Math.max(0, grandTotal - paid);

  if (Math.abs(grandTotal) < 0.005) {
    return {
      key: 'none',
      label: t('No charge'),
      className: 'bg-slate-100 text-slate-600 border-slate-200'
    };
  }
  if (rent.status === 'paid') {
    return {
      key: 'paid',
      label: t('Paid'),
      className: 'bg-olive/15 text-olive border-olive/30'
    };
  }
  if (rent.status === 'partiallypaid') {
    return {
      key: 'partial',
      label: t('Partial · {{amount}}€ left', {
        amount: remaining.toFixed(2)
      }),
      className: 'bg-amber-50 text-amber-700 border-amber-200'
    };
  }
  // 'notpaid'
  return {
    key: 'owed',
    label: t('{{amount}}€ owed', { amount: grandTotal.toFixed(2) }),
    className: 'bg-oxide/10 text-oxide border-oxide/30'
  };
}

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

// Wave-26: hover on Previous balance walks back through the tenant's prior
// rent terms (when the parent passes them) and shows where the carry-in
// came from. If the parent didn't supply prior rents (e.g. on /rents which
// only has the current month), we fall back to a one-line origin.
function PriorBalanceBreakdown({ rent }) {
  const { t } = useTranslation('common');
  const balance = Number(rent.balance) || 0;
  const priorRents = Array.isArray(rent.priorRents) ? rent.priorRents : null;

  if (!priorRents || priorRents.length === 0) {
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

  return (
    <div className="text-xs space-y-1 min-w-[220px]">
      {priorRents.map((pr) => {
        const term = String(pr.term);
        const yyyy = term.slice(0, 4);
        const mm = term.slice(4, 6);
        const owed = Number(pr.newBalance) || 0;
        return (
          <div key={pr.term} className="flex justify-between gap-4">
            <span className="text-muted-foreground">
              {moment(`${yyyy}-${mm}-01`).format('MMM YYYY')}
            </span>
            <NumberFormat value={-owed} showZero />
          </div>
        );
      })}
      <div className="flex justify-between gap-4 pt-1 border-t border-border/40 font-medium">
        <span>{t('Carried over')}</span>
        <NumberFormat value={balance} showZero />
      </div>
    </div>
  );
}

function StatusPill({ rent }) {
  const { t } = useTranslation('common');
  const data = _statusPillData(rent, t);
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium whitespace-nowrap',
        data.className
      )}
      data-cy={`status-${data.key}`}
    >
      {data.label}
    </span>
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

            {/* Wave-26: tenant name is now plain text. The right-side
                cash-register icon is the single way to open the payment
                dialog — prevents accidental opens when scanning the row. */}
            <span className="text-lg font-medium leading-tight">
              {rent.occupant.name}
            </span>
          </div>
          <div className="ml-8 flex items-center gap-2 flex-wrap">
            <StatusPill rent={rent} />
            {/* Wave-26: surface a recurring discount footnote when
                tenant.discount > 0 so the per-row deduction is visible
                without expanding the breakdown. */}
            {rentAmounts.discount < 0 && (
              <span className="text-xs text-muted-foreground italic">
                {t('Discount')}:{' '}
                <NumberFormat value={rentAmounts.discount} showZero />
              </span>
            )}
          </div>
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
        </Card>
      ) : (
        <EmptyIllustration label={t('No rents found')} />
      )}
    </>
  );
}

export default RentTable;
