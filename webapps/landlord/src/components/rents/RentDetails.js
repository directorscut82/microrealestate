import { cn } from '../../utils';
import NumberFormat from '../NumberFormat';
import { Separator } from '../ui/separator';
import useTranslation from 'next-translate/useTranslation';

export function getRentAmounts(rent) {
  const turnToNegative = (amount) => (amount !== 0 ? amount * -1 : 0);

  return {
    balance: rent.balance,
    absBalance: Math.abs(rent.balance),
    isDebitBalance: turnToNegative(rent.balance) < 0,
    newBalance: rent.newBalance,
    absNewBalance: Math.abs(rent.newBalance),
    isDebitNewBalance: rent.newBalance < 0,
    additionalCosts: rent.extracharge,
    rent: rent.totalWithoutBalanceAmount + rent.promo - rent.extracharge,
    discount: turnToNegative(rent.promo),
    payment: rent.payment,
    paymentReferences:
      rent.payments?.map(({ type, reference }) => ({
        type,
        reference
      })) || [],
    totalAmount: rent.totalAmount,
    preTaxAmounts: rent.preTaxAmounts || [],
    charges: rent.charges || [],
    buildingCharges: rent.buildingCharges || []
  };
}

export function RentAmount({
  label,
  amount,
  creditColor,
  debitColor,
  withColor = true,
  className
}) {
  return (
    <div className={cn('flex flex-col text-right', className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <NumberFormat
        value={amount}
        align="right"
        creditColor={creditColor}
        debitColor={debitColor}
        withColor={withColor}
      />
    </div>
  );
}

export default function RentDetails({ rent }) {
  const { t } = useTranslation('common');

  const rentAmounts = getRentAmounts(rent);
  const hasBuildingCharges = rentAmounts.buildingCharges.length > 0;
  const hasMultipleProperties = rentAmounts.preTaxAmounts.length > 1;
  const hasCharges = rentAmounts.charges.length > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between">
        {rentAmounts.balance === 0
          ? t('Previous balance')
          : rentAmounts.isDebitBalance
            ? t('Previous debit balance')
            : t('Previous credit balance')}
        <NumberFormat
          value={rentAmounts.balance}
          debitColor={rentAmounts.isDebitBalance}
          creditColor={!rentAmounts.isDebitBalance}
        />
      </div>
      {hasMultipleProperties ? (
        rentAmounts.preTaxAmounts.map((item, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{item.description}</span>
            <NumberFormat value={item.amount} />
          </div>
        ))
      ) : (
        <div className="flex justify-between">
          {t('Rent')}
          <NumberFormat value={rentAmounts.rent} />
        </div>
      )}
      {hasCharges && (
        <>
          {rentAmounts.charges.map((charge, i) => (
            <div key={`c-${i}`} className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {charge.description}
              </span>
              <NumberFormat value={charge.amount} />
            </div>
          ))}
        </>
      )}
      {hasBuildingCharges && (
        <>
          <Separator />
          <div className="text-xs font-medium text-muted-foreground uppercase">
            {t('Building charges')}
          </div>
          {rentAmounts.buildingCharges.map((charge, i) => (
            <div key={`bc-${i}`} className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {charge.buildingName
                  ? `${charge.buildingName} - ${charge.description}`
                  : charge.description}
              </span>
              <NumberFormat value={charge.amount} />
            </div>
          ))}
        </>
      )}
      {!hasMultipleProperties && !hasBuildingCharges && (
        <div className="flex justify-between">
          {t('Additional costs')}
          <NumberFormat value={rentAmounts.additionalCosts} />
        </div>
      )}
      <div className="flex justify-between">
        {t('Discount')}
        <NumberFormat value={rentAmounts.discount} />
      </div>
      <Separator />
      <div className="flex justify-between">
        {t('Total to pay')}
        <NumberFormat value={rentAmounts.totalAmount} />
      </div>
      <div className="flex justify-between">
        {t('Payments')}
        <NumberFormat value={rentAmounts.payment} withColor />
      </div>
      <Separator />
      <div className="flex justify-between">
        {rentAmounts.newBalance === 0
          ? t('Balance')
          : rentAmounts.isDebitNewBalance
            ? t('Debit balance')
            : t('Credit balance')}
        <NumberFormat
          value={rentAmounts.newBalance}
          abs={true}
          debitColor={rentAmounts.isDebitNewBalance}
          creditColor={!rentAmounts.isDebitNewBalance}
        />
      </div>
      <Separator />
      <div className="flex flex-col gap-2">
        <div>{t('Note')}</div>
        <div className="h-14 break-words overflow-y-auto">
          {rent.description}
        </div>
      </div>
    </div>
  );
}
