import { LuCoins, LuKeyRound, LuPercent, LuUserCircle } from 'react-icons/lu';
import { cn } from '../../utils';
import { DashboardCard } from './DashboardCard';
import NumberFormat from '../NumberFormat';
import { StoreContext } from '../../store';
import { useContext } from 'react';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

export default function GeneralFigures({ className, dashboardData }) {
  const store = useContext(StoreContext);
  const router = useRouter();
  const { t } = useTranslation('common');

  const overview = dashboardData?.overview;
  return (
    <div className={cn('space-y-4', className)}>
      <DashboardCard
        Icon={LuCoins}
        title={t('Revenues')}
        description={t('Total revenues for the year')}
        renderContent={() => (
          <NumberFormat value={overview?.totalYearRevenues} showZero={true} />
        )}
        className="text-end"
      />
      <DashboardCard
        Icon={LuPercent}
        title={t('Occupancy rate')}
        description={t('Percentage of occupied properties')}
        renderContent={() => (
          <NumberFormat
            value={overview?.occupancyRate}
            showZero={true}
            minimumFractionDigits={0}
            style="percent"
          />
        )}
        className="text-end"
      />
      <DashboardCard
        Icon={LuUserCircle}
        title={t('Tenants')}
        description={t('Total number of tenants')}
        renderContent={() => overview?.tenantCount}
        onClick={() => {
          router.push(`/${store.organization.selected.name}/tenants`);
        }}
        className="text-end"
      />
      <DashboardCard
        Icon={LuKeyRound}
        title={t('Properties')}
        description={t('Total number of properties')}
        renderContent={() => overview?.propertyCount}
        onClick={() => {
          router.push(`/${store.organization.selected.name}/properties`);
        }}
        className="text-end"
      />
    </div>
  );
}
