import { LuCalendar, LuTrendingDown, LuTrendingUp } from 'react-icons/lu';
import { useCallback } from 'react';
import { BsReceipt } from 'react-icons/bs';
import { DashboardCard } from '../dashboard/DashboardCard';
import NumberFormat from '../NumberFormat';
import PeriodPicker from '../PeriodPicker';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

export function RentOverview({ data }) {
  const { t } = useTranslation('common');
  const router = useRouter();

  const handlePeriodChange = useCallback(
    async (period) => {
      await router.push(
        `/${router.query.organization}/rents/${period.format('YYYY.MM')}`
      );
    },
    [router]
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-10 gap-4">
      <DashboardCard
        Icon={LuCalendar}
        title={t('Period')}
        renderContent={() => (
          <PeriodPicker value={data.period} onChange={handlePeriodChange} />
        )}
        className="2xl:col-span-2"
      />

      <DashboardCard
        Icon={BsReceipt}
        title={t('Rents')}
        description={t('Rents for the period')}
        renderContent={() => data.countAll}
        className="hidden sm:block 2xl:col-span-2 text-center"
      />
      <DashboardCard
        Icon={LuTrendingDown}
        title={t('Not paid')}
        description={t('{{count}} rents', {
          count: data.countNotPaid
        })}
        renderContent={() => (
          <NumberFormat
            value={data.totalNotPaid}
            debitColor={true}
            className="flex-grow"
          />
        )}
        className="hidden sm:block 2xl:col-span-3 text-end"
      />
      <DashboardCard
        Icon={LuTrendingUp}
        title={t('Paid')}
        description={t('{{count}} rents', {
          count: data.countPaid + data.countPartiallyPaid
        })}
        renderContent={() => (
          <NumberFormat
            value={data.totalPaid}
            creditColor={true}
            showZero={true}
            className="flex-grow"
          />
        )}
        className="hidden sm:block 2xl:col-span-3 text-end"
      />
    </div>
  );
}
