import {
  buildingLineLabel,
  chargeLineLabel,
  rentLineLabel
} from '../../utils/lineLabels';
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
    // Wave-26 round-3u: NOTE — rentAmounts.rent here is the
    // grandTotal-minus-balance "monthly amount" used by RentTable's
    // tooltip total + cell. RentDetails (Πρόγραμμα tile) NO LONGER
    // renders it as "Ενοίκιο" — that line was a double-count of the
    // charges/buildingCharges that are also rendered as separate rows.
    // The tile now iterates preTaxAmounts/charges/buildingCharges
    // directly. This `rent` field is kept ONLY for the RentTable
    // tooltip's "Total" row.
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
    <div className={cn('flex flex-col text-right min-w-0 leading-snug', className)}>
      <div className="text-label text-ink-muted truncate">{label}</div>
      <NumberFormat
        value={amount}
        align="right"
        creditColor={creditColor}
        debitColor={debitColor}
        withColor={withColor}
        className="text-label text-ink"
      />
    </div>
  );
}

export default function RentDetails({ rent }) {
  const { t } = useTranslation('common');

  const rentAmounts = getRentAmounts(rent);
  const buildingNonRepair = rentAmounts.buildingCharges.filter(
    (c) => c?.type !== 'repair'
  );
  const buildingRepair = rentAmounts.buildingCharges.filter(
    (c) => c?.type === 'repair'
  );

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

      {/* Wave-26 round-3u: per-line rent rows. Always iterate
          preTaxAmounts[i] using the shared rentLineLabel rule. The prior
          single-property branch was bundling charges + buildingCharges
          into the "Ενοίκιο" row by reading rentAmounts.rent (which is
          grandTotal − balance + promo − extracharge), then ALSO rendering
          those same lines below — double-counting. */}
      {rentAmounts.preTaxAmounts.map((item, i) => (
        <div key={`r-${i}`} className="flex justify-between">
          <span>{rentLineLabel(t, item)}</span>
          <NumberFormat value={item.amount} />
        </div>
      ))}

      {rentAmounts.charges.map((charge, i) => (
        <div key={`c-${i}`} className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            {chargeLineLabel(t, charge)}
          </span>
          <NumberFormat value={charge.amount} />
        </div>
      ))}

      {buildingNonRepair.length > 0 && (
        <>
          <Separator />
          <div className="text-xs font-medium text-muted-foreground uppercase">
            {t('Building charges')}
          </div>
          {buildingNonRepair.map((charge, i) => (
            <div key={`bc-${i}`} className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {buildingLineLabel(t, charge)}
              </span>
              <NumberFormat value={charge.amount} />
            </div>
          ))}
        </>
      )}

      {buildingRepair.length > 0 && (
        <>
          <Separator />
          <div className="text-xs font-medium text-muted-foreground uppercase">
            {t('Repairs')}
          </div>
          {buildingRepair.map((charge, i) => (
            <div key={`rp-${i}`} className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {buildingLineLabel(t, charge)}
              </span>
              <NumberFormat value={charge.amount} />
            </div>
          ))}
        </>
      )}

      {Number(rentAmounts.additionalCosts) > 0 && (
        <div className="flex justify-between text-oxide">
          {t('Additional cost')}
          <NumberFormat value={rentAmounts.additionalCosts} />
        </div>
      )}
      {Number(rentAmounts.discount) < 0 && (
        <div className="flex justify-between text-olive">
          {t('Discount')}
          <NumberFormat value={rentAmounts.discount} />
        </div>
      )}
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
