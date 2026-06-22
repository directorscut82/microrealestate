import { Badge } from '../ui/badge';
import CompulsoryDocumentStatus from './CompulsaryDocumentStatus';
import { DashboardCard } from '../dashboard/DashboardCard';
import { LuCheck, LuClock } from 'react-icons/lu';
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
            {/* Match the deposit's empty treatment so the two empty fields in
                this card read consistently (was a blank orphan row). */}
            <span>{tenant.contract || '–'}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">{t('Status')}</span>
            {/* State carries a glyph + pill (mirrors the rent-statement state
                pills), not bare value text. */}
            {tenant.terminated ? (
              <Badge variant="neutral" className="gap-1.5 font-normal">
                <LuCheck className="size-3 shrink-0" aria-hidden="true" />
                {t('Terminated')}
              </Badge>
            ) : (
              <Badge variant="pending" className="gap-1.5 font-normal">
                <LuClock className="size-3 shrink-0" aria-hidden="true" />
                {t('In progress')}
              </Badge>
            )}
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
