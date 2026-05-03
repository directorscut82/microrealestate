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

const CATEGORY_COLORS = {
  rent: { bold: 'hsl(210, 70%, 50%)', faded: 'hsl(210, 30%, 82%)' },
  charges: { bold: 'hsl(262, 60%, 55%)', faded: 'hsl(262, 25%, 82%)' },
  heating: { bold: 'hsl(15, 85%, 50%)', faded: 'hsl(15, 40%, 82%)' },
  elevator: { bold: 'hsl(200, 70%, 50%)', faded: 'hsl(200, 30%, 82%)' },
  cleaning: { bold: 'hsl(170, 60%, 45%)', faded: 'hsl(170, 25%, 82%)' },
  water_common: { bold: 'hsl(220, 70%, 55%)', faded: 'hsl(220, 30%, 82%)' },
  electricity_common: { bold: 'hsl(45, 90%, 50%)', faded: 'hsl(45, 40%, 82%)' },
  insurance: { bold: 'hsl(280, 50%, 50%)', faded: 'hsl(280, 25%, 82%)' },
  management_fee: { bold: 'hsl(320, 50%, 50%)', faded: 'hsl(320, 25%, 82%)' },
  garden: { bold: 'hsl(100, 60%, 40%)', faded: 'hsl(100, 25%, 80%)' },
  repairs_fund: { bold: 'hsl(30, 70%, 50%)', faded: 'hsl(30, 30%, 82%)' },
  pest_control: { bold: 'hsl(60, 50%, 40%)', faded: 'hsl(60, 25%, 80%)' },
  repair: { bold: 'hsl(340, 65%, 50%)', faded: 'hsl(340, 30%, 82%)' },
  monthly_charge: { bold: 'hsl(25, 85%, 55%)', faded: 'hsl(25, 40%, 82%)' },
  other: { bold: 'hsl(0, 0%, 50%)', faded: 'hsl(0, 0%, 82%)' }
};

const TYPE_LABELS = {
  rent: 'Rent',
  charges: 'Extra charges',
  heating: 'Heating',
  elevator: 'Elevator',
  cleaning: 'Cleaning',
  water_common: 'Water',
  electricity_common: 'Electricity',
  insurance: 'Insurance',
  management_fee: 'Management',
  garden: 'Garden',
  repairs_fund: 'Repairs fund',
  pest_control: 'Pest control',
  repair: 'Repairs',
  monthly_charge: 'Building charges',
  other: 'Other'
};

function getColor(type, status) {
  const colors = CATEGORY_COLORS[type] || CATEGORY_COLORS.other;
  return status === 'paid' ? colors.bold : colors.faded;
}

export default function MonthFigures({ className, dashboardData }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const formatNumber = useFormatNumber();
  const yearMonth = moment().format('YYYY.MM');

  const currentRevenues = useMemo(() => {
    const currentMonth = moment().format('MMYYYY');
    return dashboardData?.revenues?.find(
      ({ month }) => currentMonth === month
    ) || { month: currentMonth, paid: 0, notPaid: 0, baseRent: 0, charges: 0, buildingCharges: 0, buildingChargesByType: {}, tenants: [] };
  }, [dashboardData?.revenues]);

  const { pieData, legend } = useMemo(() => {
    const { baseRent, charges, buildingChargesByType = {}, paid } = currentRevenues;
    const totalBuildingCharges = Object.values(buildingChargesByType).reduce((s, v) => s + v, 0);
    const totalDue = baseRent + charges + totalBuildingCharges;
    if (totalDue === 0) return { pieData: [], legend: [] };

    const paidRatio = Math.min(paid / totalDue, 1);
    const segments = [];
    const legendItems = [];

    // Rent
    if (baseRent > 0) {
      const rentPaid = Math.round(baseRent * paidRatio);
      const rentUnpaid = baseRent - rentPaid;
      legendItems.push({ type: 'rent', label: t(TYPE_LABELS.rent) });
      if (rentPaid > 0) segments.push({ name: t('Rent') + ' (' + t('paid') + ')', value: rentPaid, color: getColor('rent', 'paid'), type: 'rent' });
      if (rentUnpaid > 0) segments.push({ name: t('Rent') + ' (' + t('unpaid') + ')', value: rentUnpaid, color: getColor('rent', 'unpaid'), type: 'rent' });
    }

    // Per-tenant extra charges
    if (charges > 0) {
      const chargesPaid = Math.round(charges * paidRatio);
      const chargesUnpaid = charges - chargesPaid;
      legendItems.push({ type: 'charges', label: t(TYPE_LABELS.charges) });
      if (chargesPaid > 0) segments.push({ name: t('Extra charges') + ' (' + t('paid') + ')', value: chargesPaid, color: getColor('charges', 'paid'), type: 'charges' });
      if (chargesUnpaid > 0) segments.push({ name: t('Extra charges') + ' (' + t('unpaid') + ')', value: chargesUnpaid, color: getColor('charges', 'unpaid'), type: 'charges' });
    }

    // Each building charge type as its own segment
    Object.entries(buildingChargesByType).forEach(([type, amount]) => {
      if (amount <= 0) return;
      const label = t(TYPE_LABELS[type] || type);
      legendItems.push({ type, label });
      const typePaid = Math.round(amount * paidRatio);
      const typeUnpaid = amount - typePaid;
      if (typePaid > 0) segments.push({ name: label + ' (' + t('paid') + ')', value: typePaid, color: getColor(type, 'paid'), type });
      if (typeUnpaid > 0) segments.push({ name: label + ' (' + t('unpaid') + ')', value: typeUnpaid, color: getColor(type, 'unpaid'), type });
    });

    return { pieData: segments, legend: legendItems };
  }, [currentRevenues, t]);

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const entry = payload[0].payload;
    const tenants = currentRevenues.tenants || [];
    const totalDue = currentRevenues.baseRent + currentRevenues.charges +
      Object.values(currentRevenues.buildingChargesByType || {}).reduce((s, v) => s + v, 0);
    const paidRatio = totalDue > 0 ? currentRevenues.paid / totalDue : 0;

    return (
      <div className="bg-background/90 backdrop-blur-sm border rounded-lg shadow-lg p-3 text-sm max-w-80">
        <div className="font-semibold mb-1">{entry.name}</div>
        <div className="font-medium mb-2">{formatNumber(entry.value)}</div>
        {tenants.length > 0 && (
          <div className="border-t pt-2 space-y-2">
            {tenants.map((tenant, i) => {
              const catAmount = entry.type === 'rent' ? tenant.baseRent
                : entry.type === 'charges' ? tenant.charges
                : (tenant.buildingChargesByType?.[entry.type] || 0);
              if (catAmount <= 0) return null;
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

  const totalDue = currentRevenues.baseRent + currentRevenues.charges +
    Object.values(currentRevenues.buildingChargesByType || {}).reduce((s, v) => s + v, 0);
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
                  {legend.map(({ type, label }) => (
                    <div key={type} className="flex items-center gap-1">
                      <div className="size-3 rounded-sm" style={{ background: getColor(type, 'paid') }} />
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-center text-[10px] text-muted-foreground mb-1">
                  <span>{t('Bold = paid, faded = unpaid')}</span>
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
