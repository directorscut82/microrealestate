import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { LuAlertTriangle, LuBanknote } from 'react-icons/lu';
import { useMemo } from 'react';
import { Button } from '../ui/button';
import { CelebrationIllustration } from '../../components/Illustrations';
import { ChartContainer } from '../ui/chart';
import { cn } from '../../utils';
import { DashboardCard } from './DashboardCard';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import useFormatNumber from '../../hooks/useFormatNumber';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const CATEGORIES = {
  rent: {
    bold: 'hsl(210, 70%, 50%)',
    faded: 'hsl(210, 25%, 82%)'
  },
  charges: {
    bold: 'hsl(262, 60%, 55%)',
    faded: 'hsl(262, 25%, 82%)'
  },
  building: {
    bold: 'hsl(25, 85%, 55%)',
    faded: 'hsl(25, 40%, 82%)'
  }
};

export default function MonthFigures({ className, dashboardData }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const formatNumber = useFormatNumber();
  const yearMonth = moment().format('YYYY.MM');

  const currentRevenues = useMemo(() => {
    const currentMonth = moment().format('MMYYYY');
    return dashboardData?.revenues?.find(
      ({ month }) => currentMonth === month
    ) || { month: currentMonth, paid: 0, notPaid: 0, baseRent: 0, charges: 0, buildingCharges: 0, tenants: [] };
  }, [dashboardData?.revenues]);

  const pieData = useMemo(() => {
    const { baseRent, charges, buildingCharges, paid } = currentRevenues;
    const totalDue = baseRent + charges + buildingCharges;
    if (totalDue === 0) return [];

    const paidRatio = Math.min(paid / totalDue, 1);

    const segments = [];
    if (baseRent > 0) {
      const rentPaid = Math.round(baseRent * paidRatio);
      const rentUnpaid = baseRent - rentPaid;
      if (rentPaid > 0) segments.push({ name: t('Rent') + ' (' + t('paid') + ')', value: rentPaid, color: CATEGORIES.rent.bold, category: 'rent', status: 'paid' });
      if (rentUnpaid > 0) segments.push({ name: t('Rent') + ' (' + t('unpaid') + ')', value: rentUnpaid, color: CATEGORIES.rent.faded, category: 'rent', status: 'unpaid' });
    }
    if (charges > 0) {
      const chargesPaid = Math.round(charges * paidRatio);
      const chargesUnpaid = charges - chargesPaid;
      if (chargesPaid > 0) segments.push({ name: t('Extra charges') + ' (' + t('paid') + ')', value: chargesPaid, color: CATEGORIES.charges.bold, category: 'charges', status: 'paid' });
      if (chargesUnpaid > 0) segments.push({ name: t('Extra charges') + ' (' + t('unpaid') + ')', value: chargesUnpaid, color: CATEGORIES.charges.faded, category: 'charges', status: 'unpaid' });
    }
    if (buildingCharges > 0) {
      const buildingPaid = Math.round(buildingCharges * paidRatio);
      const buildingUnpaid = buildingCharges - buildingPaid;
      if (buildingPaid > 0) segments.push({ name: t('Building charges') + ' (' + t('paid') + ')', value: buildingPaid, color: CATEGORIES.building.bold, category: 'building', status: 'paid' });
      if (buildingUnpaid > 0) segments.push({ name: t('Building charges') + ' (' + t('unpaid') + ')', value: buildingUnpaid, color: CATEGORIES.building.faded, category: 'building', status: 'unpaid' });
    }
    return segments;
  }, [currentRevenues, t]);

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const entry = payload[0].payload;
    const tenants = currentRevenues.tenants || [];
    const paidRatio = currentRevenues.paid / (currentRevenues.baseRent + currentRevenues.charges + currentRevenues.buildingCharges) || 0;

    return (
      <div className="bg-background border rounded-lg shadow-lg p-3 text-sm max-w-80">
        <div className="font-semibold mb-1">{entry.name}</div>
        <div className="font-medium mb-2">{formatNumber(entry.value)}</div>
        {tenants.length > 0 && (
          <div className="border-t pt-2 space-y-2">
            {tenants.map((tenant, i) => {
              const catAmount = entry.category === 'rent' ? tenant.baseRent
                : entry.category === 'charges' ? tenant.charges
                : tenant.buildingCharges;
              const catPaid = Math.round(catAmount * Math.min(paidRatio, 1));
              return (
                <div key={i}>
                  <div className="font-medium truncate">{tenant.name}</div>
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span>{t('Due')}: {formatNumber(catAmount)}</span>
                    <span className={catPaid >= catAmount ? 'text-success' : 'text-warning'}>
                      {t('Paid')}: {formatNumber(catPaid)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const totalDue = currentRevenues.baseRent + currentRevenues.charges + currentRevenues.buildingCharges;
  const totalPaid = currentRevenues.paid || 0;

  return (
    <div className={cn('grid grid-cols-1 gap-4', className)}>
      <DashboardCard
        Icon={dashboardData?.topUnpaid?.length ? LuAlertTriangle : null}
        title={
          dashboardData?.topUnpaid?.length ? t('Top 5 of not paid rents') : ''
        }
        description={
          dashboardData?.topUnpaid?.length
            ? t('Tenants with the highest unpaid balance')
            : ''
        }
        renderContent={() =>
          dashboardData?.topUnpaid?.length ? (
            <div className="flex flex-col gap-2 min-h-48">
              {dashboardData.topUnpaid.map(({ tenant, balance }) => (
                <div
                  key={tenant._id}
                  className="flex items-center text-sm md:text-base"
                >
                  <Button
                    variant="link"
                    onClick={() => {
                      router.push(
                        `/${router.query.organization}/rents/${yearMonth}?search=${tenant.name}`
                      );
                    }}
                    className="justify-start flex-grow p-0 m-0"
                  >
                    {tenant.name}
                  </Button>
                  <NumberFormat
                    value={balance}
                    withColor
                    className="font-semibold"
                  />
                </div>
              ))}
            </div>
          ) : (
            <CelebrationIllustration
              label={t('Well done! All rents are paid')}
            />
          )
        }
      />
      <DashboardCard
        Icon={LuBanknote}
        title={t('Settlements')}
        description={t('Rents of {{monthYear}}', {
          monthYear: moment().format('MMMM YYYY')
        })}
        renderContent={() => (
          <div>
            {pieData.length > 0 ? (
              <>
                <div className="flex flex-wrap justify-center gap-3 text-xs mb-2">
                  <div className="flex items-center gap-1">
                    <div className="size-3 rounded-sm" style={{ background: CATEGORIES.rent.bold }} />
                    <span>{t('Rent')}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="size-3 rounded-sm" style={{ background: CATEGORIES.charges.bold }} />
                    <span>{t('Extra charges')}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="size-3 rounded-sm" style={{ background: CATEGORIES.building.bold }} />
                    <span>{t('Building charges')}</span>
                  </div>
                </div>
                <div className="flex justify-center gap-4 text-[10px] text-muted-foreground mb-1">
                  <span>■ {t('bold')} = {t('paid')}</span>
                  <span>□ {t('faded')} = {t('unpaid')}</span>
                </div>
                <ChartContainer
                  config={{}}
                  className="h-[180px] w-full"
                >
                  <PieChart>
                    <Pie
                      data={pieData}
                      dataKey="value"
                      startAngle={180}
                      endAngle={0}
                      cx="50%"
                      cy="85%"
                      innerRadius="60%"
                      outerRadius="100%"
                      paddingAngle={1}
                      stroke="none"
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={index} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ChartContainer>
                <div className="flex justify-between text-sm mt-1 px-4">
                  <div>
                    <span className="text-muted-foreground">{t('Paid')}: </span>
                    <span className="font-semibold text-success">{formatNumber(totalPaid)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('Due')}: </span>
                    <span className="font-semibold">{formatNumber(totalDue)}</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-[180px] text-muted-foreground">
                {t('No data')}
              </div>
            )}
          </div>
        )}
      />
    </div>
  );
}
