import { Bar, BarChart, Legend, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
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

export default function YearFigures({ className, dashboardData }) {
  const router = useRouter();
  const { t } = useTranslation('common');
  const formatNumber = useFormatNumber();
  const isDesktop = useMediaQuery('(min-width: 768px)');

  const data = useMemo(() => {
    const now = moment();
    return dashboardData?.revenues?.reduce((acc, revenues) => {
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
    }, []) || [];
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
      <div className="bg-popover/75 backdrop-blur-md border border-border/50 rounded-lg shadow-md px-3 py-2 text-xs max-w-64">
        <div className="font-medium text-sm mb-1">
          {moment(data.month, 'MMYYYY').format('MMMM YYYY')}
        </div>
        <div className="flex justify-between gap-3 mb-0.5">
          <span className="text-success">{t('Paid')}</span>
          <span className="font-medium">{formatNumber(data.paid)}</span>
        </div>
        {data.notPaid < 0 && (
          <div className="flex justify-between gap-3 mb-0.5">
            <span className="text-warning">{t('Not paid')}</span>
            <span className="font-medium">{formatNumber(data.notPaid)}</span>
          </div>
        )}
        {tenants.length > 0 && (
          <div className="mt-1.5 border-t border-border/40 pt-1.5 space-y-0.5">
            {tenants.map((tenant, i) => {
              const balance = tenant.paid - tenant.due;
              return (
                <div key={i} className="flex justify-between gap-2">
                  <span className="text-muted-foreground truncate">{tenant.name}</span>
                  <span className={cn('whitespace-nowrap', balance < 0 ? 'text-warning' : 'text-success')}>
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

  return hasRevenues ? (
    <DashboardCard
      Icon={LuBanknote}
      title={t('Rents of {{year}}', { year: moment().format('YYYY') })}
      description={t('Rents for the year')}
      renderContent={() => (
        <ChartContainer
          config={{
            paid: { color: 'hsl(var(--chart-2))' },
            notPaid: { color: 'hsl(var(--chart-1))' }
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
                    className="text-[9px] md:text-xs"
                    fill="hsl(var(--muted-foreground))"
                  >
                    {payload.value}
                  </text>
                );
              }}
            />
            <Legend
              verticalAlign="top"
              content={() => (
                <div className="flex flex-wrap justify-center gap-4 text-sm mb-6">
                  <div className="flex items-center gap-2 text-warning">
                    <div className="size-2 bg-[hsl(var(--chart-1))]" />
                    <span>{t('Not paid')}</span>
                  </div>
                  <div className="flex items-center gap-2 text-success">
                    <div className="size-2 bg-[hsl(var(--chart-2))]" />
                    <span>{t('Paid')}</span>
                  </div>
                </div>
              )}
            />
            <Tooltip content={<CustomBarTooltip />} cursor={{ fill: 'hsl(var(--muted))', opacity: 0.3 }} />
            <Bar
              dataKey="notPaid"
              fill="hsl(var(--chart-1))"
              stackId="stack"
              cursor="pointer"
              label={{
                position: 'right',
                fill: 'hsl(var(--warning))',
                formatter: (value) => (value < 0 ? formatNumber(value) : ''),
                className: 'tracking-tight text-[9px] md:text-sm'
              }}
              stroke="hsl(var(--chart-1-border))"
              radius={[0, 4, 4, 0]}
              barSize={20}
              onClick={handleClick('notPaid')}
            />
            <Bar
              dataKey="paid"
              fill="hsl(var(--chart-2))"
              stackId="stack"
              cursor="pointer"
              label={{
                position: 'right',
                fill: 'hsl(var(--success))',
                formatter: (value) => (value > 0 ? formatNumber(value) : ''),
                className: 'tracking-tight text-[9px] md:text-sm'
              }}
              stroke="hsl(var(--chart-2-border))"
              radius={[0, 4, 4, 0]}
              barSize={20}
              onClick={handleClick('paid')}
            />
            <ReferenceLine x={0} stroke="hsl(var(--border))" />
          </BarChart>
        </ChartContainer>
      )}
      className={className}
    />
  ) : null;
}
