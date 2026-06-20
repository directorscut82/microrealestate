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
          {/* Property-level recurring expenses (tenant's own surcharges) */}
          {tenant.expenses > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {t('Additional charges')}
              </span>
              <NumberFormat value={tenant.expenses} />
            </div>
          )}
          {/* Building charges (per-unit allocated from building expenses) */}
          {(tenant.buildingCharges || []).length > 0 && (
            <div className="space-y-0.5">
              {tenant.buildingCharges.map((c, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-muted-foreground truncate mr-2">
                    {c.description || t('Building charge')}
                  </span>
                  <NumberFormat value={c.amount} />
                </div>
              ))}
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
          <div className="flex justify-between mt-4">
            <span className="text-muted-foreground">{t('Total')}</span>
            <NumberFormat value={tenant.total} />
          </div>
        </div>
      )}
    />
  );
}
