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

const COLORS = {
  rent: 'hsl(142, 71%, 45%)',
  rentFaded: 'hsl(142, 30%, 80%)',
  charges: 'hsl(262, 60%, 55%)',
  chargesFaded: 'hsl(262, 25%, 82%)',
  building: 'hsl(25, 85%, 55%)',
  buildingFaded: 'hsl(25, 40%, 82%)'
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
      if (rentPaid > 0) segments.push({ name: t('Rent') + ' (' + t('paid') + ')', value: rentPaid, color: COLORS.rent, category: 'rent', status: 'paid' });
      if (rentUnpaid > 0) segments.push({ name: t('Rent') + ' (' + t('unpaid') + ')', value: rentUnpaid, color: COLORS.rentFaded, category: 'rent', status: 'unpaid' });
    }
    if (charges > 0) {
      const chargesPaid = Math.round(charges * paidRatio);
      const chargesUnpaid = charges - chargesPaid;
      if (chargesPaid > 0) segments.push({ name: t('Extra charges') + ' (' + t('paid') + ')', value: chargesPaid, color: COLORS.charges, category: 'charges', status: 'paid' });
      if (chargesUnpaid > 0) segments.push({ name: t('Extra charges') + ' (' + t('unpaid') + ')', value: chargesUnpaid, color: COLORS.chargesFaded, category: 'charges', status: 'unpaid' });
    }
    if (buildingCharges > 0) {
      const buildingPaid = Math.round(buildingCharges * paidRatio);
      const buildingUnpaid = buildingCharges - buildingPaid;
      if (buildingPaid > 0) segments.push({ name: t('Building charges') + ' (' + t('paid') + ')', value: buildingPaid, color: COLORS.building, category: 'building', status: 'paid' });
      if (buildingUnpaid > 0) segments.push({ name: t('Building charges') + ' (' + t('unpaid') + ')', value: buildingUnpaid, color: COLORS.buildingFaded, category: 'building', status: 'unpaid' });
    }
    return segments;
  }, [currentRevenues, t]);

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const { name, value } = payload[0];
    const tenants = currentRevenues.tenants || [];
    return (
      <div className="bg-background border rounded-lg shadow-lg p-3 text-sm max-w-64">
        <div className="font-semibold mb-1">{name}</div>
        <div className="font-medium">{formatNumber(value)}</div>
        {tenants.length > 0 && (
          <div className="mt-2 border-t pt-2 space-y-1">
            {tenants.map((tenant, i) => (
              <div key={i} className="flex justify-between gap-4">
                <span className="text-muted-foreground truncate">{tenant.name}</span>
                <span className="whitespace-nowrap">
                  {formatNumber(tenant.paid)} / {formatNumber(tenant.due)}
                </span>
              </div>
            ))}
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
                <div className="flex flex-wrap justify-center gap-4 text-xs mb-2">
                  <div className="flex items-center gap-1">
                    <div className="size-3 rounded-sm" style={{ background: COLORS.rent }} />
                    <span>{t('Rent')}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="size-3 rounded-sm" style={{ background: COLORS.charges }} />
                    <span>{t('Extra charges')}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="size-3 rounded-sm" style={{ background: COLORS.building }} />
                    <span>{t('Building charges')}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="size-3 rounded-sm opacity-40" style={{ background: '#888' }} />
                    <span className="text-muted-foreground">{t('= unpaid')}</span>
                  </div>
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
