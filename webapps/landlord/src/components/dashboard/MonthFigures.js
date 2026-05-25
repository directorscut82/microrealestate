import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { LuAlertTriangle, LuBanknote } from 'react-icons/lu';
import { useMemo } from 'react';
import { CelebrationIllustration } from '../../components/Illustrations';
import { ChartContainer } from '../ui/chart';
import { cn } from '../../utils';
import { DashboardCard } from './DashboardCard';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import useFormatNumber from '../../hooks/useFormatNumber';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

/*
 * MonthFigures — DESIGN.md committed-color exception for data viz.
 *
 * Charts are the one place where Full-palette color is permitted: each
 * category gets a deliberate role color. Paid segments use bold OKLCH; unpaid
 * segments use a desaturated marble version of the same hue. The user can
 * read the boldness as much as the hue.
 *
 * All hues stay within the system's palette: sea, olive, oxide, marble,
 * with a small set of tertiary hues drawn from Mediterranean materials
 * (terracotta, copper, slate, sage). No neon.
 */

const CATEGORY_COLORS = {
  // Charts use a quiet earth-tone palette built around petrol. Each
  // category is muted (chroma 0.04–0.08 for paid, 0.018–0.028 for unpaid)
  // so the dashboard reads as a ledger, not a marketing slide.
  rent: { bold: 'oklch(94% 0.038 140)', faded: 'oklch(92% 0.022 22)' }, // mint / pink
  charges: { bold: 'oklch(40% 0.020 240)', faded: 'oklch(85% 0.012 240)' }, // slate
  heating: { bold: 'oklch(50% 0.080 35)', faded: 'oklch(86% 0.024 35)' }, // terracotta
  elevator: { bold: 'oklch(45% 0.040 200)', faded: 'oklch(86% 0.016 200)' }, // dim teal
  cleaning: { bold: 'oklch(50% 0.040 180)', faded: 'oklch(86% 0.016 180)' }, // dusty teal
  water_common: { bold: 'oklch(42% 0.045 220)', faded: 'oklch(86% 0.018 220)' }, // water
  electricity_common: {
    bold: 'oklch(55% 0.080 75)',
    faded: 'oklch(88% 0.022 75)'
  }, // muted amber
  insurance: { bold: 'oklch(40% 0.060 290)', faded: 'oklch(84% 0.018 290)' }, // plum
  management_fee: {
    bold: 'oklch(45% 0.060 320)',
    faded: 'oklch(84% 0.018 320)'
  }, // mauve
  garden: { bold: 'oklch(45% 0.070 130)', faded: 'oklch(86% 0.020 130)' }, // olive
  repairs_fund: { bold: 'oklch(48% 0.070 60)', faded: 'oklch(86% 0.020 60)' }, // ochre
  pest_control: { bold: 'oklch(45% 0.045 110)', faded: 'oklch(84% 0.016 110)' }, // sage
  repair: { bold: 'oklch(48% 0.090 20)', faded: 'oklch(86% 0.022 20)' }, // copper
  monthly_charge: {
    bold: 'oklch(48% 0.080 50)',
    faded: 'oklch(86% 0.022 50)'
  }, // umber
  other: { bold: 'oklch(50% 0.012 240)', faded: 'oklch(82% 0.008 240)' } // marble
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

// Universal unpaid grey kept as fallback for any caller still using a
// single neutral. New code uses CATEGORY_COLORS[type].faded.
export const UNPAID_LIGHT = '#bdb8b1';
export const UNPAID_DARK = '#6a6864';

function isDark() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('dark');
}

function categoryFor(type) {
  return CATEGORY_COLORS[type] ? type : 'other';
}

export function paidColor(type) {
  return CATEGORY_COLORS[categoryFor(type)].bold;
}

export function unpaidColor(type) {
  if (type && CATEGORY_COLORS[type]) {
    return CATEGORY_COLORS[type].faded;
  }
  return isDark() ? UNPAID_DARK : UNPAID_LIGHT;
}

function getColor(type, status) {
  return status === 'paid' ? paidColor(type) : unpaidColor(type);
}

export default function MonthFigures({ className, dashboardData }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const formatNumber = useFormatNumber();
  const yearMonth = moment().format('YYYY.MM');

  const currentRevenues = useMemo(() => {
    const currentMonth = moment().format('MMYYYY');
    return (
      dashboardData?.revenues?.find(({ month }) => currentMonth === month) || {
        month: currentMonth,
        paid: 0,
        notPaid: 0,
        baseRent: 0,
        charges: 0,
        buildingCharges: 0,
        buildingChargesByType: {},
        tenants: []
      }
    );
  }, [dashboardData?.revenues]);

  const { pieData, legend } = useMemo(() => {
    const {
      baseRent,
      charges,
      buildingChargesByType = {},
      paid
    } = currentRevenues;
    const totalBuildingCharges = Object.values(buildingChargesByType).reduce(
      (s, v) => s + v,
      0
    );
    const totalDue = baseRent + charges + totalBuildingCharges;
    if (totalDue === 0) return { pieData: [], legend: [] };

    const paidRatio = Math.min(paid / totalDue, 1);
    const segments = [];
    const legendItems = [];

    if (baseRent > 0) {
      const rentPaid = Math.round(baseRent * paidRatio);
      const rentUnpaid = baseRent - rentPaid;
      legendItems.push({ type: 'rent', label: t(TYPE_LABELS.rent) });
      if (rentPaid > 0)
        segments.push({
          name: t('Rent') + ' (' + t('collected') + ')',
          value: rentPaid,
          color: getColor('rent', 'paid'),
          type: 'rent'
        });
      if (rentUnpaid > 0)
        segments.push({
          name: t('Rent') + ' (' + t('owed') + ')',
          value: rentUnpaid,
          color: getColor('rent', 'unpaid'),
          type: 'rent'
        });
    }

    if (charges > 0) {
      const chargesPaid = Math.round(charges * paidRatio);
      const chargesUnpaid = charges - chargesPaid;
      legendItems.push({ type: 'charges', label: t(TYPE_LABELS.charges) });
      if (chargesPaid > 0)
        segments.push({
          name: t('Extra charges') + ' (' + t('collected') + ')',
          value: chargesPaid,
          color: getColor('charges', 'paid'),
          type: 'charges'
        });
      if (chargesUnpaid > 0)
        segments.push({
          name: t('Extra charges') + ' (' + t('owed') + ')',
          value: chargesUnpaid,
          color: getColor('charges', 'unpaid'),
          type: 'charges'
        });
    }

    Object.entries(buildingChargesByType).forEach(([type, amount]) => {
      if (amount <= 0) return;
      const label = t(TYPE_LABELS[type] || type);
      legendItems.push({ type, label });
      const typePaid = Math.round(amount * paidRatio);
      const typeUnpaid = amount - typePaid;
      if (typePaid > 0)
        segments.push({
          name: label + ' (' + t('collected') + ')',
          value: typePaid,
          color: getColor(type, 'paid'),
          type
        });
      if (typeUnpaid > 0)
        segments.push({
          name: label + ' (' + t('owed') + ')',
          value: typeUnpaid,
          color: getColor(type, 'unpaid'),
          type
        });
    });

    return { pieData: segments, legend: legendItems };
  }, [currentRevenues, t]);

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const entry = payload[0].payload;
    const tenants = currentRevenues.tenants || [];

    return (
      <div className="bg-bone border border-stone-line rounded-lg shadow-floating px-2.5 py-1.5 text-label max-w-64">
        <div className="font-medium text-body text-ink mb-0.5 leading-tight">
          {entry.name}
        </div>
        <div className="font-mono tabular-nums text-label text-ink mb-1.5">
          {formatNumber(entry.value)}
        </div>
        {tenants.length > 0 && (
          <div className="border-t border-stone-line pt-1.5 space-y-1">
            {tenants.map((tenant, i) => {
              const catAmount =
                entry.type === 'rent'
                  ? tenant.baseRent
                  : entry.type === 'charges'
                    ? tenant.charges
                    : tenant.buildingChargesByType?.[entry.type] || 0;
              if (catAmount <= 0) return null;
              // Per-tenant proportional ratio against per-tenant due — best we
              // can do without per-category paid breakdown from the API.
              const tenantPaidRatio =
                tenant.due > 0 ? Math.min(tenant.paid / tenant.due, 1) : 0;
              const catPaid = Math.round(catAmount * tenantPaidRatio);
              return (
                <div key={i}>
                  <div className="truncate text-label text-ink-soft">{tenant.name}</div>
                  <div className="flex gap-2 text-label text-ink-muted font-mono tabular-nums">
                    <span>
                      {t('Owed')}: {formatNumber(catAmount)}
                    </span>
                    <span
                      style={{
                        color:
                          catPaid >= catAmount
                            ? paidColor(entry.type)
                            : undefined
                      }}
                      className={catPaid >= catAmount ? '' : 'text-ink-muted'}
                    >
                      {t('Collected')}: {formatNumber(catPaid)}
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

  const totalDue =
    currentRevenues.baseRent +
    currentRevenues.charges +
    Object.values(currentRevenues.buildingChargesByType || {}).reduce(
      (s, v) => s + v,
      0
    );
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
                  className="flex items-center justify-between gap-3 py-2 border-b border-stone-line last:border-b-0"
                >
                  <button
                    type="button"
                    onClick={() => {
                      router.push(
                        `/${router.query.organization}/rents/${yearMonth}?search=${encodeURIComponent(tenant.name)}`
                      );
                    }}
                    className="text-left text-body text-ink truncate flex-grow hover:text-sea-deep transition-colors duration-base ease-out-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sea rounded-sm"
                  >
                    {tenant.name}
                  </button>
                  <NumberFormat
                    value={balance}
                    withColor
                    className="font-medium"
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
        title={t('Payments')}
        description={t('Rents of {{monthYear}}', {
          monthYear: moment().format('MMMM YYYY')
        })}
        renderContent={() => (
          <div>
            {pieData.length > 0 ? (
              <>
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-label text-ink-soft mb-3">
                  {legend.map(({ type, label }) => (
                    <div key={type} className="flex items-center gap-1.5">
                      <span
                        className="size-2.5 rounded-pill"
                        style={{ background: getColor(type, 'paid') }}
                        aria-hidden="true"
                      />
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-center text-label text-ink-muted mb-1">
                  <span>{t('Bold = paid, faded = unpaid')}</span>
                </div>
                <ChartContainer
                  config={{}}
                  className="h-[320px] w-full overflow-hidden"
                >
                  <PieChart>
                    <Pie
                      data={pieData}
                      dataKey="value"
                      startAngle={180}
                      endAngle={0}
                      cx="50%"
                      cy="85%"
                      innerRadius="102%"
                      outerRadius="170%"
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
                <div className="flex justify-between text-body mt-1 px-4 font-mono tabular-nums">
                  <div>
                    <span className="text-ink-muted">{t('Collected')}: </span>
                    <span
                      className="font-semibold"
                      style={{ color: paidColor('rent') }}
                    >
                      {formatNumber(totalPaid)}
                    </span>
                  </div>
                  <div>
                    <span className="text-ink-muted">{t('Owed')}: </span>
                    <span className="font-semibold text-ink">
                      {formatNumber(totalDue)}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-[320px] text-ink-muted">
                {t('No data')}
              </div>
            )}
          </div>
        )}
      />
    </div>
  );
}
