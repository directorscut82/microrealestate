import CompulsoryDocumentStatus from './CompulsaryDocumentStatus';
import { DashboardCard } from '../dashboard/DashboardCard';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { RiContractLine } from 'react-icons/ri';
import useTranslation from 'next-translate/useTranslation';

export default function ContractOverviewCard({ tenant }) {
  const { t } = useTranslation('common');
  return (
    <DashboardCard
      Icon={RiContractLine}
      title={t('Lease')}
      renderContent={() => (
        <div className="text-base space-y-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('Contract')}</span>
            <span>{tenant.contract}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('Status')}</span>
            <span>
              {tenant.terminated
                ? t('Terminated')
                : t('In progress')}
            </span>
          </div>
          {tenant.beginDate && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('Start date')}</span>
              <span>
                {moment(tenant.beginDate, 'DD/MM/YYYY').format('L')}
              </span>
            </div>
          )}
          {(tenant.terminationDate || tenant.endDate) && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('End date')}</span>
              <span>
                {moment(
                  tenant.terminationDate || tenant.endDate,
                  'DD/MM/YYYY'
                ).format('L')}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('Deposit')}</span>
            <NumberFormat value={tenant.guaranty} />
          </div>
          <CompulsoryDocumentStatus
            tenant={tenant}
            className="mt-4"
          />
        </div>
      )}
    />
  );
}
