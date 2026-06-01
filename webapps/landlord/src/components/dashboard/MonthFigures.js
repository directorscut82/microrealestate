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
  // B1 top-level slices (in addition to per-type entries below for
  // tooltip subcategory rows). propertyCharge = "Επί του ενοικίου"
  // (rent surcharge), koinoxrhsta = "Κοινόχρηστα" (sum of non-repair
  // building-types).
  propertyCharge: { bold: 'oklch(48% 0.060 245)', faded: 'oklch(78% 0.030 245)' }, // slate
  koinoxrhsta: { bold: 'oklch(50% 0.105 325)', faded: 'oklch(80% 0.050 325)' }, // mauve (mirrors management_fee)
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
  // B1 top-level pie categories (4 slices).
  rent: 'Rent',
  propertyCharge: 'Rent surcharge',
  koinoxrhsta: 'Common expenses',
  repair: 'Repairs',
  // Legacy / per-type labels retained for backwards-compat with any
  // caller that still passes a building-expense `type` (used by
  // tooltip subcategory rows below).
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
  // B1: pie aggregates the granular per-line server data into 4
  // top-level slices: enoikio (rent), epi-tou-enoikiou (charges),
  // koinoxrhsta (building-non-repair), episkeues (building-repair).
  // Per-line description detail moves to the hover tooltip.
  //
  // Bucket map (top -> server bucket key in tenant.paidByBucket):
  //   rent           <- 'rent'
  //   propertyCharge <- 'charges'
  //   koinoxrhsta    <- every 'building:<type>' where type !== 'repair'
  //   repair         <- 'building:repair'
  const { pieData } = useMemo(() => {
    const {
      baseRent,
      charges,
      buildingChargesByType = {},
      tenants = []
    } = currentRevenues;

    // Sum paid amounts per top-category across all tenants by walking
    // each tenant.paidByBucket entry once.
    const paidByTop = {
      rent: 0,
      propertyCharge: 0,
      koinoxrhsta: 0,
      repair: 0
    };
    tenants.forEach((tenant) => {
      const tb = tenant?.paidByBucket || {};
      Object.entries(tb).forEach(([k, v]) => {
        const amt = Number(v) || 0;
        if (k === 'rent') {
          paidByTop.rent += amt;
        } else if (k === 'charges') {
          paidByTop.propertyCharge += amt;
        } else if (k === 'building:repair') {
          paidByTop.repair += amt;
        } else if (k.startsWith('building:')) {
          paidByTop.koinoxrhsta += amt;
        }
      });
    });

    // Sum owed per top-category. baseRent / charges are already
    // top-level; building-by-type is split by `repair` vs everything
    // else.
    let owedKoinoxrhsta = 0;
    let owedRepair = 0;
    Object.entries(buildingChargesByType).forEach(([type, amount]) => {
      const a = Number(amount) || 0;
      if (type === 'repair') owedRepair += a;
      else owedKoinoxrhsta += a;
    });
    const owedByTop = {
      rent: Number(baseRent) || 0,
      propertyCharge: Number(charges) || 0,
      koinoxrhsta: owedKoinoxrhsta,
      repair: owedRepair
    };

    const segments = [];

    const _push = (top, owedAmount, paidAmount) => {
      if (owedAmount <= 0 && paidAmount <= 0) return;
      // Paid sub-segment first (visual prominence).
      if (paidAmount > 0) {
        segments.push({
          name: t(TYPE_LABELS[top] || top),
          value: Math.min(paidAmount, owedAmount), // can't exceed owed
          color: paidColor(top),
          type: top,
          status: 'paid'
        });
      }
      const unpaidValue = Math.max(0, owedAmount - paidAmount);
      if (unpaidValue > 0) {
        segments.push({
          name: t(TYPE_LABELS[top] || top),
          value: unpaidValue,
          color: unpaidColor(top),
          type: top,
          status: 'unpaid'
        });
      }
    };

    // Order: rent, epi-tou-enoikiou, koinoxrhsta, episkeues.
    _push('rent', owedByTop.rent, paidByTop.rent);
    _push('propertyCharge', owedByTop.propertyCharge, paidByTop.propertyCharge);
    _push('koinoxrhsta', owedByTop.koinoxrhsta, paidByTop.koinoxrhsta);
    _push('repair', owedByTop.repair, paidByTop.repair);

    return { pieData: segments };
  }, [currentRevenues, t]);

  // B1: tooltip rows expand the hovered TOP slice into per-tenant
  // per-line subcategory rows. Each row shows the tenant name, the
  // line description (verbatim from rent.charges/rent.buildingCharges,
  // e.g. "Επί του ενοικίου", "τεστε"), and the owed/collected for
  // that specific line. Multiple rows per tenant when a tenant has
  // multiple lines in the hovered top-category.
  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const entry = payload[0].payload;
    const top = entry.type; // 'rent' | 'propertyCharge' | 'koinoxrhsta' | 'repair'
    const tenants = currentRevenues.tenants || [];

    // Build per-tenant per-line rows for the hovered top-category.
    // The server emits chargesLines and buildingChargesLines per
    // tenant; we filter and split them by `type` for the building
    // case. For 'rent' we use baseRent (a single line per tenant —
    // typically one preTaxAmounts entry).
    const rows = [];
    tenants.forEach((tenant) => {
      const tenantName = tenant?.name || '';
      if (top === 'rent') {
        const owed = Number(tenant.baseRent) || 0;
        const collected = Number(tenant.paidByBucket?.rent) || 0;
        if (owed > 0.005 || collected > 0.005) {
          rows.push({
            tenantName,
            lineDescription: '',
            lineSubLabel: '',
            owed,
            collected
          });
        }
      } else if (top === 'propertyCharge') {
        const lines = Array.isArray(tenant.chargesLines)
          ? tenant.chargesLines
          : [];
        const collectedTotal = Number(tenant.paidByBucket?.charges) || 0;
        const owedTotal = lines.reduce(
          (s, l) => s + (Number(l?.amount) || 0),
          0
        );
        // Split this tenant's "charges" collected pro-rata across its
        // chargesLines (the server emits a single 'charges' bucket
        // sum; the lineKey-based payment will refine this in a future
        // pass). Single-line case (the common one) collapses to a
        // direct attribution.
        lines.forEach((l) => {
          const lineOwed = Number(l?.amount) || 0;
          if (lineOwed <= 0.005) return;
          const collected =
            owedTotal > 0
              ? (collectedTotal * lineOwed) / owedTotal
              : 0;
          rows.push({
            tenantName,
            lineDescription: l.description || '',
            lineSubLabel: '',
            owed: lineOwed,
            collected
          });
        });
      } else {
        // top === 'koinoxrhsta' OR 'repair'.
        const wantsRepair = top === 'repair';
        const lines = Array.isArray(tenant.buildingChargesLines)
          ? tenant.buildingChargesLines
          : [];
        const matchingLines = lines.filter((l) =>
          wantsRepair ? l?.type === 'repair' : l?.type !== 'repair'
        );
        if (matchingLines.length === 0) return;
        // Aggregate per-line. Collected per line: server already
        // attributes per-bucket via lineKey when present; for
        // back-compat we read paidByBucket['building:<type>'] which
        // is shared across same-type lines.
        const groupedCollected = {};
        matchingLines.forEach((l) => {
          const key = `building:${l.type || 'other'}`;
          groupedCollected[key] = Number(tenant.paidByBucket?.[key]) || 0;
        });
        const owedByType = {};
        matchingLines.forEach((l) => {
          const k = `building:${l.type || 'other'}`;
          owedByType[k] = (owedByType[k] || 0) + (Number(l?.amount) || 0);
        });
        matchingLines.forEach((l) => {
          const lineOwed = Number(l?.amount) || 0;
          if (lineOwed <= 0.005) return;
          const k = `building:${l.type || 'other'}`;
          const totalForType = owedByType[k] || 0;
          const collected =
            totalForType > 0
              ? (groupedCollected[k] * lineOwed) / totalForType
              : 0;
          rows.push({
            tenantName,
            lineDescription: l.description || '',
            lineSubLabel:
              l.type && TYPE_LABELS[l.type] ? t(TYPE_LABELS[l.type]) : '',
            owed: lineOwed,
            collected
          });
        });
      }
    });

    // Filter rows that have actual money (owed or collected > 0) and
    // sort by owed desc so largest first.
    const visibleRows = rows
      .filter((r) => r.owed > 0.005 || r.collected > 0.005)
      .sort((a, b) => b.owed - a.owed);

    return (
      <div className="bg-bone border border-stone-line rounded-lg shadow-floating px-3 py-2 text-label max-w-md">
        <div className="font-medium text-body text-ink leading-tight">
          {entry.name}
        </div>
        <div className="font-mono tabular-nums text-label text-ink-muted mb-2">
          {formatNumber(entry.value)}
        </div>
        {visibleRows.length > 0 && (
          <div className="max-h-[280px] overflow-y-auto scrollbar-branded">
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
                    {t('Receipts')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r, i) => {
                  const fullyPaid =
                    r.owed > 0 && r.collected + 0.005 >= r.owed;
                  // Tenant column shows: <tenant> (<subcategory or description>)
                  // when the row has a sub-label; falls back to plain
                  // tenant name for the rent case.
                  const subFragment = r.lineDescription
                    ? r.lineSubLabel
                      ? `${r.lineDescription} — ${r.lineSubLabel}`
                      : r.lineDescription
                    : '';
                  return (
                    <tr key={i} className="border-t border-stone-line/40">
                      <td className="py-0.5 pr-2 text-ink max-w-[16rem]">
                        <div className="truncate">{r.tenantName}</div>
                        {subFragment && (
                          <div className="text-xs text-ink-muted truncate">
                            {subFragment}
                          </div>
                        )}
                      </td>
                      <td className="py-0.5 pl-3 text-right text-ink-muted">
                        {formatNumber(r.owed)}
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
                        {formatNumber(r.collected)}
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
        description={t('Pie chart subheader')}
        renderContent={() => (
          <div>
            {pieData.length > 0 ? (
              <>
                {/* Legend lives at the BOTTOM CORNERS of the pie (under
                    the chart): Owed (Οφειλές) bottom-left with the
                    light swatch, Receipts (Εισπράξεις) bottom-right
                    with the dark swatch. The previous centered-top
                    legend was removed in favor of corner placement. */}
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
                  {/* Bottom-left corner: Owed (Οφειλές) + light swatch. */}
                  <div className="flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-pill"
                      style={{ background: '#bdb8b1' }}
                      aria-hidden="true"
                    />
                    <span className="text-ink-muted">{t('Owed')}: </span>
                    <span className="font-semibold text-ink">
                      {formatNumber(totalDue)}
                    </span>
                  </div>
                  {/* Bottom-right corner: Receipts (Εισπράξεις) + dark
                      swatch. Was previously labelled 'Collected'
                      (Εισπραχθέντα); locale 'Receipts' renders as
                      'Εισπράξεις' which is the user-correct word. */}
                  <div className="flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-pill"
                      style={{ background: '#4a4d52' }}
                      aria-hidden="true"
                    />
                    <span className="text-ink-muted">{t('Receipts')}: </span>
                    <span
                      className="font-semibold"
                      style={{ color: paidColor('rent') }}
                    >
                      {formatNumber(totalPaid)}
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
