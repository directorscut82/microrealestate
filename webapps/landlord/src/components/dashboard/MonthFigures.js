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
  // Wave-26 round-3r: Mediterranean earth palette, distinct hue per
  // category, chroma boosted so each color reads as itself (not a
  // washed-out tint). Paid (bold) = ~50% L / 0.10–0.13 C. Owed (faded)
  // = ~78% L / 0.05–0.07 C — light but still recognisably the same
  // hue, never grey-on-grey.
  rent: { bold: 'oklch(50% 0.120 220)', faded: 'oklch(78% 0.058 220)' }, // petrol blue
  charges: { bold: 'oklch(48% 0.060 245)', faded: 'oklch(78% 0.030 245)' }, // slate
  heating: { bold: 'oklch(58% 0.135 35)', faded: 'oklch(80% 0.058 35)' }, // terracotta
  elevator: { bold: 'oklch(52% 0.085 200)', faded: 'oklch(80% 0.040 200)' }, // dim teal
  cleaning: { bold: 'oklch(54% 0.075 180)', faded: 'oklch(80% 0.038 180)' }, // dusty teal
  water_common: { bold: 'oklch(50% 0.100 230)', faded: 'oklch(80% 0.046 230)' }, // ocean
  electricity_common: { bold: 'oklch(62% 0.130 75)', faded: 'oklch(82% 0.058 75)' }, // ochre
  insurance: { bold: 'oklch(45% 0.110 305)', faded: 'oklch(78% 0.052 305)' }, // plum
  management_fee: { bold: 'oklch(50% 0.105 325)', faded: 'oklch(80% 0.050 325)' }, // mauve
  garden: { bold: 'oklch(52% 0.115 135)', faded: 'oklch(80% 0.052 135)' }, // olive
  repairs_fund: { bold: 'oklch(56% 0.115 60)', faded: 'oklch(82% 0.054 60)' }, // ochre amber
  pest_control: { bold: 'oklch(52% 0.080 115)', faded: 'oklch(80% 0.038 115)' }, // sage
  repair: { bold: 'oklch(54% 0.135 20)', faded: 'oklch(80% 0.060 20)' }, // copper
  monthly_charge: { bold: 'oklch(54% 0.115 50)', faded: 'oklch(80% 0.054 50)' }, // umber
  other: { bold: 'oklch(50% 0.030 245)', faded: 'oklch(78% 0.018 245)' } // marble grey
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

/* getColor removed in round-3r — pie slices use paidColor/unpaidColor
   directly, legend uses literal oklch swatches. */

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

  // Wave-26 round-3r: per-category split with TWO sub-segments per
  // category — paid (bold hue) + owed (faded hue). Sub-segment sizes
  // come from REAL allocation data (paidByBucket on each tenant, summed
  // across tenants). No paidRatio fabrication. Categories with zero
  // both-owed-and-paid are skipped.
  //
  // Bucket aggregation: walk currentRevenues.tenants[*].paidByBucket
  // server-side already does the per-rent allocation -> bucket mapping
  // (dashboardmanager._computePaidByBucket). Frontend just sums.
  const { pieData } = useMemo(() => {
    const {
      baseRent,
      charges,
      buildingChargesByType = {},
      tenants = []
    } = currentRevenues;

    // Sum paid amounts per bucket key across all tenants.
    const paidByBucket = {};
    tenants.forEach((tenant) => {
      const tb = tenant?.paidByBucket || {};
      Object.entries(tb).forEach(([k, v]) => {
        paidByBucket[k] = (paidByBucket[k] || 0) + (Number(v) || 0);
      });
    });

    const segments = [];
    const legendItems = [];

    const _push = (type, owedAmount, paidAmount) => {
      if (owedAmount <= 0 && paidAmount <= 0) return;
      legendItems.push({
        type,
        label: t(TYPE_LABELS[type] || type)
      });
      // Paid sub-segment first (visual prominence).
      if (paidAmount > 0) {
        segments.push({
          name: t(TYPE_LABELS[type] || type),
          value: Math.min(paidAmount, owedAmount), // can't exceed owed
          color: paidColor(type),
          type,
          status: 'paid'
        });
      }
      const unpaidValue = Math.max(0, owedAmount - paidAmount);
      if (unpaidValue > 0) {
        segments.push({
          name: t(TYPE_LABELS[type] || type),
          value: unpaidValue,
          color: unpaidColor(type),
          type,
          status: 'unpaid'
        });
      }
    };

    _push('rent', baseRent, paidByBucket.rent || 0);
    _push('charges', charges, paidByBucket.charges || 0);
    Object.entries(buildingChargesByType).forEach(([type, amount]) => {
      _push(type, amount, paidByBucket[`building:${type}`] || 0);
    });

    return { pieData: segments, legend: legendItems };
  }, [currentRevenues, t]);

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const entry = payload[0].payload;
    const tenants = currentRevenues.tenants || [];
    const bucketKey =
      entry.type === 'rent'
        ? 'rent'
        : entry.type === 'charges'
          ? 'charges'
          : `building:${entry.type}`;
    const owedFor = (tenant) =>
      entry.type === 'rent'
        ? Number(tenant.baseRent) || 0
        : entry.type === 'charges'
          ? Number(tenant.charges) || 0
          : Number(tenant.buildingChargesByType?.[entry.type]) || 0;

    // Per-tenant rows: only show tenants with non-zero owed OR non-zero
    // εισπράξεις in this bucket. Sort by owed desc so the largest
    // outstanding tenants surface first when scrolling.
    const rows = tenants
      .map((tenant) => {
        const owed = owedFor(tenant);
        const collected = Number(tenant.paidByBucket?.[bucketKey]) || 0;
        return { tenant, owed, collected };
      })
      .filter(({ owed, collected }) => owed > 0.005 || collected > 0.005)
      .sort((a, b) => b.owed - a.owed);

    return (
      <div className="bg-bone border border-stone-line rounded-lg shadow-floating px-3 py-2 text-label max-w-sm">
        <div className="font-medium text-body text-ink leading-tight">
          {entry.name}
        </div>
        <div className="font-mono tabular-nums text-label text-ink-muted mb-2">
          {formatNumber(entry.value)}
        </div>
        {rows.length > 0 && (
          <div
            className="max-h-[280px] overflow-y-auto scrollbar-branded"
            // ~7 rows fit before scroll engages.
          >
            <table className="w-full tabular-nums text-label">
              <thead className="text-xs text-ink-muted sticky top-0 bg-bone">
                <tr>
                  <th className="text-left font-normal pb-1">
                    {t('Tenant')}
                  </th>
                  <th className="text-right font-normal pb-1 pl-3">
                    {t('Owed')}
                  </th>
                  <th className="text-right font-normal pb-1 pl-3">
                    {t('Collected')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ tenant, owed, collected }, i) => {
                  const fullyPaid =
                    owed > 0 && collected + 0.005 >= owed;
                  return (
                    <tr key={i} className="border-t border-stone-line/40">
                      <td className="py-0.5 pr-2 text-ink truncate max-w-[12rem]">
                        {tenant.name}
                      </td>
                      <td className="py-0.5 pl-3 text-right text-ink-muted">
                        {formatNumber(owed)}
                      </td>
                      <td
                        className={cn(
                          'py-0.5 pl-3 text-right',
                          fullyPaid ? '' : 'text-ink-muted'
                        )}
                        style={{
                          color: fullyPaid
                            ? paidColor(entry.type)
                            : undefined
                        }}
                      >
                        {formatNumber(collected)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
                  {/* Wave-26 round-3t: balance is now POSITIVE remaining
                      owed; render in oxide so it reads as 'they owe you
                      this much' without the misleading negative sign. */}
                  <NumberFormat
                    value={balance}
                    debitColor
                    className="font-medium text-oxide"
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
        title={t('Rents of {{monthYear}}', {
          monthYear: moment().format('MMMM YYYY')
        })}
        renderContent={() => (
          <div>
            {pieData.length > 0 ? (
              <>
                {/* Wave-26 round-3r: unified two-swatch legend matches
                    the bar chart. Per-category hue is visible inside
                    pie slices; the legend conveys the light/dark split
                    abstractly. */}
                <div className="flex flex-wrap justify-center gap-x-6 gap-y-1.5 text-label text-ink-soft mb-3">
                  {/* Wave-26 round-3s: greyscale legend swatches that
                      match the bar chart exactly (#bdb8b1 / #4a4d52).
                      Per-category hue is visible inside pie slices;
                      legend conveys the light=owed / dark=paid split. */}
                  <div className="flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-pill"
                      style={{ background: '#bdb8b1' }}
                      aria-hidden="true"
                    />
                    <span>{t('Outstanding')}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-pill"
                      style={{ background: '#4a4d52' }}
                      aria-hidden="true"
                    />
                    <span>{t('Receipts')}</span>
                  </div>
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
