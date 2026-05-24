import {
  Bar,
  BarChart,
  Legend,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { useMemo } from 'react';
import { ChartContainer } from '../ui/chart';
import { cn } from '../../utils';
import { DashboardCard } from './DashboardCard';
import { LuBanknote } from 'react-icons/lu';
import moment from 'moment';
import useFormatNumber from '../../hooks/useFormatNumber';
import { useMediaQuery } from 'usehooks-ts';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

/*
 * YearFigures — annual rent bar chart.
 *
 * Stacked horizontal bars per month: paid (olive) on the right, unpaid
 * (oxide) on the left of zero. Labels in mono tabular numerals. Paid /
 * unpaid pair is the one place we use red/green semantics — but pair them
 * with explicit labels in the legend, never color alone.
 */

// Bar chart uses two greys to keep the donut's olive/terracotta/petrol
// trio reserved for the donut category breakdown. Dark grey = collected,
// light grey = owed. Same logic in light + dark mode.
const CHART_PAID_LIGHT = '#4a4d52';
const CHART_UNPAID_LIGHT = '#bdb8b1';
const CHART_PAID_DARK = '#c8c6c2';
const CHART_UNPAID_DARK = '#6a6864';
const CHART_PAID_BORDER = '#34373c';
const CHART_UNPAID_BORDER = '#9a958d';

function pickChart() {
  const dark =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark');
  return {
    paid: dark ? CHART_PAID_DARK : CHART_PAID_LIGHT,
    unpaid: dark ? CHART_UNPAID_DARK : CHART_UNPAID_LIGHT
  };
}

export default function YearFigures({ className, dashboardData }) {
  const router = useRouter();
  const { t } = useTranslation('common');
  const formatNumber = useFormatNumber();
  const isDesktop = useMediaQuery('(min-width: 768px)', {
    initializeWithValue: false
  });

  const data = useMemo(() => {
    const now = moment();
    return (
      dashboardData?.revenues?.reduce((acc, revenues) => {
        const revenuesMoment = moment(revenues.month, 'MMYYYY');
        const graphData = {
          ...revenues,
          name: revenuesMoment.format('MMM'),
          yearMonth: moment(revenues.month, 'MMYYYY').format('YYYY.MM')
        };
        if (revenuesMoment.isSameOrBefore(now)) {
          acc.push(graphData);
        } else {
          acc.push({ ...graphData, notPaid: 0, paid: 0 });
        }
        return acc;
      }, []) || []
    );
  }, [dashboardData?.revenues]);

  const hasRevenues = useMemo(() => {
    return data.some((r) => r.notPaid !== 0 || r.paid !== 0);
  }, [data]);

  const handleClick = (dataKey) => (data) => {
    const { yearMonth } = data;
    const status = dataKey.toLowerCase();
    router.push(
      `/${router.query.organization}/rents/${yearMonth}?statuses=${status}`
    );
  };

  const CustomBarTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const data = payload[0]?.payload;
    if (!data) return null;
    const tenants = data.tenants || [];
    return (
      <div className="bg-bone border border-stone-line rounded-lg shadow-floating px-2.5 py-1.5 text-label max-w-60">
        <div className="font-medium text-body text-ink mb-1 leading-tight">
          {moment(data.month, 'MMYYYY').format('MMMM YYYY')}
        </div>
        <div className="flex justify-between gap-3 mb-0.5 font-mono tabular-nums text-label">
          <span style={{ color: CHART_PAID_LIGHT }}>{t('Collected')}</span>
          <span className="text-ink">{formatNumber(data.paid)}</span>
        </div>
        {data.notPaid < 0 && (
          <div className="flex justify-between gap-3 mb-0.5 font-mono tabular-nums text-label">
            <span className="text-ink-muted">{t('Owed')}</span>
            <span className="text-ink">{formatNumber(data.notPaid)}</span>
          </div>
        )}
        {tenants.length > 0 && (
          <div className="mt-1.5 border-t border-stone-line pt-1.5 space-y-0.5">
            {tenants.map((tenant, i) => {
              const balance = tenant.paid - tenant.due;
              return (
                <div
                  key={i}
                  className="flex justify-between gap-2 font-mono tabular-nums text-label"
                >
                  <span className="text-ink-muted truncate font-sans">
                    {tenant.name}
                  </span>
                  <span
                    className="whitespace-nowrap"
                    style={{
                      color:
                        balance < 0 ? CHART_UNPAID_LIGHT : CHART_PAID_LIGHT
                    }}
                  >
                    {formatNumber(tenant.paid)} / {formatNumber(tenant.due)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const { paid: CHART_PAID, unpaid: CHART_UNPAID } = pickChart();

  return hasRevenues ? (
    <DashboardCard
      Icon={LuBanknote}
      title={t('Rents of {{year}}', { year: moment().format('YYYY') })}
      description={t('Rents for the year')}
      renderContent={() => (
        <ChartContainer
          config={{
            paid: { color: CHART_PAID },
            notPaid: { color: CHART_UNPAID }
          }}
          className="h-[450px] w-full"
        >
          <BarChart data={data} layout="vertical" stackOffset="sign">
            <XAxis
              type="number"
              hide={true}
              domain={['dataMin', 'dataMax']}
              padding={
                isDesktop ? { left: 70, right: 70 } : { left: 35, right: 35 }
              }
            />
            <YAxis
              dataKey="name"
              hide={false}
              axisLine={false}
              tickLine={false}
              type="category"
              tick={(props) => {
                const { x, y, payload } = props;
                return (
                  <text
                    x={x - 30}
                    y={y}
                    className="text-label"
                    fill="oklch(50% 0.008 240)"
                  >
                    {payload.value}
                  </text>
                );
              }}
            />
            <Legend
              verticalAlign="top"
              content={() => (
                <div className="flex flex-wrap justify-center gap-4 text-label text-ink-soft mb-6">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-pill"
                      style={{ background: CHART_UNPAID }}
                      aria-hidden="true"
                    />
                    <span>{t('Cumulative balance')}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-pill"
                      style={{ background: CHART_PAID }}
                      aria-hidden="true"
                    />
                    <span>{t('Collected')}</span>
                  </div>
                </div>
              )}
            />
            <Tooltip
              content={<CustomBarTooltip />}
              cursor={{ fill: 'oklch(96% 0.006 85)', opacity: 0.6 }}
            />
            <Bar
              dataKey="notPaid"
              fill={CHART_UNPAID}
              stackId="stack"
              cursor="pointer"
              label={{
                position: 'left',
                fill: 'var(--color-ink)',
                formatter: (value) => (value < 0 ? formatNumber(value) : ''),
                className: 'tracking-tight text-[10px] md:text-[11px] font-mono'
              }}
              stroke={CHART_UNPAID_BORDER}
              radius={[4, 0, 0, 4]}
              barSize={20}
              onClick={handleClick('notPaid')}
            />
            <Bar
              dataKey="paid"
              fill={CHART_PAID}
              stackId="stack"
              cursor="pointer"
              label={{
                position: 'right',
                fill: 'var(--color-ink)',
                formatter: (value) => (value > 0 ? formatNumber(value) : ''),
                className: 'tracking-tight text-[10px] md:text-[11px] font-mono'
              }}
              stroke={CHART_PAID_BORDER}
              radius={[0, 4, 4, 0]}
              barSize={20}
              onClick={handleClick('paid')}
            />
            <ReferenceLine x={0} stroke="oklch(88% 0.008 85)" />
          </BarChart>
        </ChartContainer>
      )}
      className={className}
    />
  ) : null;
}
