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
import { DashboardCard } from './DashboardCard';
import { LuWallet } from 'react-icons/lu';
import moment from 'moment';
import useFormatNumber from '../../hooks/useFormatNumber';
import { useMediaQuery } from 'usehooks-ts';
import useTranslation from 'next-translate/useTranslation';

/*
 * ExpensesYearFigures — the ΕΞΟΔΑ twin of YearFigures. Same stacked
 * horizontal per-month bar chart (paid dark, owed light), but fed by the
 * landlord's owner-borne expenses (dashboardData.expenses) instead of rent.
 * Έξοδα includes repairs (the owner portion). Mirrors the rent chart 1:1 so
 * the dashboard reads income and expense the same way.
 */

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

export default function ExpensesYearFigures({ className, dashboardData }) {
  const { t } = useTranslation('common');
  const formatNumber = useFormatNumber();
  const isDesktop = useMediaQuery('(min-width: 768px)', {
    initializeWithValue: false
  });

  const data = useMemo(() => {
    const now = moment();
    return (
      dashboardData?.expenses?.reduce((acc, e) => {
        const m = moment(e.month, 'MMYYYY');
        const graphData = {
          ...e,
          name: m.format('MMM'),
          yearMonth: m.format('YYYY.MM')
        };
        if (m.isSameOrBefore(now)) acc.push(graphData);
        else acc.push({ ...graphData, notPaid: 0, paid: 0 });
        return acc;
      }, []) || []
    );
  }, [dashboardData?.expenses]);

  const hasData = useMemo(
    () => data.some((r) => r.notPaid !== 0 || r.paid !== 0),
    [data]
  );

  const CustomBarTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    if (!d) return null;
    return (
      <div className="bg-bone border border-stone-line rounded-lg shadow-floating px-2.5 py-1.5 text-label max-w-60">
        <div className="font-medium text-body text-ink mb-1 leading-tight">
          {moment(d.month, 'MMYYYY').format('MMMM YYYY')}
        </div>
        <div className="flex justify-between gap-3 mb-0.5 font-mono tabular-nums text-label">
          <span style={{ color: CHART_PAID_LIGHT }}>{t('Paid')}</span>
          <span className="text-ink">{formatNumber(d.paid)}</span>
        </div>
        {d.notPaid > 0 && (
          <div className="flex justify-between gap-3 mb-0.5 font-mono tabular-nums text-label">
            <span className="text-ink-muted">{t('Outstanding')}</span>
            <span className="text-ink">{formatNumber(d.notPaid)}</span>
          </div>
        )}
      </div>
    );
  };

  const { paid: CHART_PAID, unpaid: CHART_UNPAID } = pickChart();

  return hasData ? (
    <DashboardCard
      Icon={LuWallet}
      title={t('Owner expenses of {{year}}', { year: moment().format('YYYY') })}
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
                <div className="flex flex-wrap justify-center gap-x-6 gap-y-1.5 text-label text-ink-soft mb-6">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-pill"
                      style={{ background: CHART_UNPAID }}
                      aria-hidden="true"
                    />
                    <span>
                      {t('Outstanding')}{' '}
                      <span className="text-ink-muted">
                        ({t('this month')})
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-pill"
                      style={{ background: CHART_PAID }}
                      aria-hidden="true"
                    />
                    <span>{t('Paid')}</span>
                  </div>
                </div>
              )}
            />
            <Tooltip
              content={<CustomBarTooltip />}
              cursor={{ fill: 'oklch(96% 0.006 85)', opacity: 0.6 }}
            />
            <Bar
              dataKey="paid"
              fill={CHART_PAID}
              stackId="stack"
              label={{
                position: 'left',
                fill: 'var(--color-ink)',
                formatter: (value) => (value > 0 ? formatNumber(value) : ''),
                className: 'tracking-tight text-[10px] md:text-[11px] font-mono'
              }}
              stroke={CHART_PAID_BORDER}
              radius={[4, 0, 0, 4]}
              barSize={20}
            />
            <Bar
              dataKey="notPaid"
              fill={CHART_UNPAID}
              stackId="stack"
              label={{
                position: 'right',
                fill: 'var(--color-ink)',
                formatter: (value) => (value > 0 ? formatNumber(value) : ''),
                className: 'tracking-tight text-[10px] md:text-[11px] font-mono'
              }}
              stroke={CHART_UNPAID_BORDER}
              radius={[0, 4, 4, 0]}
              barSize={20}
            />
            <ReferenceLine x={0} stroke="oklch(88% 0.008 85)" />
          </BarChart>
        </ChartContainer>
      )}
      className={className}
    />
  ) : null;
}
