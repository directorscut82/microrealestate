import { BsReceipt } from 'react-icons/bs';
import { DashboardCard } from '../dashboard/DashboardCard';
import NumberFormat from '../NumberFormat';
import { Separator } from '../ui/separator';
import useTranslation from 'next-translate/useTranslation';

export default function RentOverviewCard({ tenant }) {
  const { t } = useTranslation('common');

  return (
    <DashboardCard
      Icon={BsReceipt}
      title={t('Rental')}
      renderContent={() => (
        <div className="text-base space-y-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('Rent')}</span>
            <NumberFormat value={tenant.rental} />
          </div>
          {/* ONLY two charge types on this panel, per spec: the rent (above)
              and "Δαπάνη επί του ενοικίου" (property-level charges on the rent).
              Building-allocated κοινόχρηστα are NOT itemized here. */}
          {tenant.expenses > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {t('Property charge')}
              </span>
              <NumberFormat value={tenant.expenses} />
            </div>
          )}
          {tenant.discount > 0 ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('Discount')}</span>
              <NumberFormat value={tenant.discount * -1} />
            </div>
          ) : null}
          {tenant.isVat && (
            <>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t('Pre-tax total')}
                </span>
                <NumberFormat value={tenant.preTaxTotal} />
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('VAT')}</span>
                <NumberFormat value={tenant.vat} />
              </div>
            </>
          )}
          <Separator />
          {/* Promote the total: it's the figure the user pauses on, so it must
              outweigh its summands (Title-weight ink label + larger mono value),
              not match them at muted size. */}
          <div className="flex items-baseline justify-between mt-4">
            <span className="text-title font-medium text-ink">{t('Total')}</span>
            <span className="font-mono tabular-nums text-headline text-ink">
              <NumberFormat value={tenant.total} />
            </span>
          </div>
        </div>
      )}
    />
  );
}
