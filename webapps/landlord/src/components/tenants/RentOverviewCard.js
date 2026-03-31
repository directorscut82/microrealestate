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
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('Expenses')}</span>
            <NumberFormat value={tenant.expenses} />
          </div>
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
          <div className="flex justify-between mt-4">
            <span className="text-muted-foreground">{t('Total')}</span>
            <NumberFormat value={tenant.total} />
          </div>
        </div>
      )}
    />
  );
}
