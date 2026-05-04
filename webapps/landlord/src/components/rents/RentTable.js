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

            <Button
              variant="link"
              className="p-0 h-fit text-lg whitespace-normal text-left"
              onClick={onEdit(rent)}
            >
              {rent.occupant.name}
            </Button>
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
          <RentAmount
            label={t('Previous balance')}
            amount={rentAmounts.balance}
            withColor={false}
            className="hidden lg:block text-muted-foreground"
          />
          <RentAmount
            label={t('Total due')}
            amount={rentAmounts.totalAmount}
            withColor={false}
            debitColor={rentAmounts.totalAmount > 0}
            creditColor={rentAmounts.totalAmount < 0}
            className={rentAmounts.totalAmount !== 0 ? 'font-bold' : ''}
          />
          <div className="grow">
            <RentAmount
              label={t('Payment')}
              amount={rent.payment}
              className={rentAmounts.payment > 0 ? 'font-bold' : ''}
            />
          </div>
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
