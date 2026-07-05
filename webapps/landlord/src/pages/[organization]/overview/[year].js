import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis
} from 'recharts';
import { fetchOverview, QueryKeys } from '../../../utils/restcalls';
import { ChartContainer } from '../../../components/ui/chart';
import NumberFormat from '../../../components/NumberFormat';
import Page from '../../../components/Page';
import { LuArrowLeft, LuArrowRight, LuDownload, LuUpload } from 'react-icons/lu';
import { Button } from '../../../components/ui/button';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

// ── small presentational helpers ────────────────────────────────────────────
function SectionLabel({ children }) {
  return (
    <div className="text-label uppercase tracking-wide text-ink-muted font-medium mb-4">
      {children}
    </div>
  );
}

function GraphTitle({ children }) {
  return <div className="text-title text-ink-soft mb-3">{children}</div>;
}

// A single ranked horizontal bar (name · track · value). No side-stripe, full
// track with a filled portion, mono value right-aligned.
function RankBar({ name, value, max, color, meta }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3 my-2 text-body">
      <span className="w-36 shrink-0 truncate text-ink-soft">{name}</span>
      <span className="flex-1 h-3.5 rounded bg-stone relative">
        <span
          className="absolute inset-y-0 left-0 rounded"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </span>
      <span className="w-20 shrink-0 text-right">
        <NumberFormat value={value} showZero />
      </span>
      {meta != null ? (
        <span className="w-16 shrink-0 text-right text-label text-ink-muted">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

// donut / dot legend row
function DonutLegend({ items }) {
  return (
    <div className="text-body">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-2 my-1.5">
          <span
            className="size-3 rounded-sm shrink-0"
            style={{ backgroundColor: it.color }}
          />
          <span className="text-ink-soft">{it.label}</span>
          <span className="ml-auto pl-4">
            <NumberFormat value={it.amount} showZero />
          </span>
        </div>
      ))}
    </div>
  );
}

const DONUT_COLORS = [
  'var(--color-sea)',
  'var(--color-olive)',
  'var(--color-oxide)',
  'var(--color-bark)',
  'var(--color-ink-muted)'
];

// SVG donut from category slices (avoids pulling a second chart lib shape).
function Donut({ slices }) {
  const total = slices.reduce((s, x) => s + Math.max(0, x.amount), 0) || 1;
  let offset = 0;
  return (
    <svg width="112" height="112" viewBox="0 0 42 42" className="shrink-0">
      {/* pathLength=100 normalizes the circumference to exactly 100 so dash
          values are exact percentages — without it the ~99.98 user-unit
          circumference under-draws a single 100% slice (renders as an empty
          ring). Base stone ring shows only when slices don't cover the circle. */}
      <circle
        cx="21"
        cy="21"
        r="15.915"
        fill="none"
        stroke="var(--color-stone)"
        strokeWidth="6"
        pathLength="100"
      />
      {slices.map((s, i) => {
        const frac = Math.max(0, s.amount) / total;
        const dash = frac * 100;
        const el = (
          <circle
            key={s.label}
            cx="21"
            cy="21"
            r="15.915"
            fill="none"
            stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
            strokeWidth="6"
            pathLength="100"
            strokeDasharray={`${dash} ${100 - dash}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 21 21)"
          />
        );
        offset += dash;
        return el;
      })}
    </svg>
  );
}

function Overview() {
  const router = useRouter();
  const { t } = useTranslation('common');
  const org = router.query.organization;
  const year = Number(router.query.year) || new Date().getFullYear();

  const { data, isLoading } = useQuery({
    queryKey: [QueryKeys.DASHBOARD, 'overview', year],
    queryFn: () => fetchOverview(year),
    refetchOnMount: 'always',
    retry: 2
  });

  const d = data || {};
  const totals = d.totals || { income: 0, ownerExpenses: 0, net: 0 };
  const katanomes = d.katanomes || {};

  // month bars for the cash-flow chart (paid vs owed), Greek initials.
  const monthNames = useMemo(
    () => ['Ι', 'Φ', 'Μ', 'Α', 'Μ', 'Ι', 'Ι', 'Α', 'Σ', 'Ο', 'Ν', 'Δ'],
    []
  );
  const cashflow = useMemo(() => {
    const arr = d.monthlyExpenses || [];
    return arr.map((m, i) => ({
      m: monthNames[i] || '',
      paid: m.paid || 0,
      owed: m.owed || 0
    }));
  }, [d.monthlyExpenses, monthNames]);

  const goYear = (delta) =>
    router.push(`/${org}/overview/${year + delta}`);

  const catMax = Math.max(
    1,
    ...(katanomes.byLabel || []).map((x) => x.amount)
  );
  const ownerMax = Math.max(
    1,
    ...(katanomes.byOwner || []).map((x) => x.amount)
  );
  const arrearsMax = Math.max(1, ...(d.arrears || []).map((x) => x.owed));
  const repairMax = Math.max(
    1,
    ...((d.repairs && d.repairs.byBuilding) || []).map((x) => x.cost)
  );

  return (
    <Page loading={isLoading} dataCy="overviewPage">
      {/* header: title + tools */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <h1 className="font-display text-display">{t('Overview')}</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-2">
            <LuDownload className="size-4 opacity-70" />
            {t('Export to Excel')}
          </Button>
          <Button variant="outline" size="sm" className="gap-2">
            <LuUpload className="size-4 opacity-70" />
            {t('Import tax return')}
          </Button>
          <div className="flex items-center gap-1 ml-1">
            <Button
              variant="outline"
              size="icon"
              onClick={() => goYear(-1)}
              aria-label={String(year - 1)}
            >
              <LuArrowLeft className="size-4" />
            </Button>
            <span className="font-mono tabular-nums text-title font-semibold px-2">
              {year}
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => goYear(1)}
              aria-label={String(year + 1)}
            >
              <LuArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {/* PRIMARY — annual projection headline */}
        <div className="rounded-2xl border border-stone-line bg-bone p-6">
          <SectionLabel>
            {t('Annual projection')} {year}
          </SectionLabel>
          <ProjRow
            label={t('Income')}
            value={totals.income}
            valueClass="text-ink"
          />
          <ProjRow
            label={t('Owner expenses')}
            value={totals.ownerExpenses}
            valueClass="text-oxide"
            negative
          />
          <div className="border-t border-stone-line mt-2 pt-3">
            <ProjRow
              label={t('Net profit')}
              value={totals.net}
              valueClass="text-olive"
              bold
            />
          </div>
          <p className="text-label text-ink-muted mt-3 max-w-2xl">
            {t(
              'Actual: collected/charged to date. Estimate: projection for remaining months.'
            )}
          </p>
        </div>

        {/* ANALYSIS — income + owner-expense side by side */}
        <div className="rounded-2xl border border-stone-line bg-bone p-6">
          <SectionLabel>{t('Income & expense analysis')}</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-4">
            <MiniTable
              title={t('Income')}
              rows={[
                { k: t('Rents'), v: totals.income },
                { k: t('Charges on rent short'), v: 0 }
              ]}
              totalLabel={t('Income')}
              totalValue={totals.income}
              t={t}
            />
            <MiniTable
              title={t('Owner expenses')}
              rows={(katanomes.byCategory || []).map((c) => ({
                k: t(_categoryLabelKey(c.label)),
                v: c.amount
              }))}
              totalLabel={t('Owner expenses')}
              totalValue={totals.ownerExpenses}
              t={t}
            />
          </div>
        </div>

        {/* PER OWNER */}
        <div className="rounded-2xl border border-stone-line bg-bone p-6">
          <SectionLabel>{t('Per owner')}</SectionLabel>
          <table className="w-full text-body">
            <thead>
              <tr className="text-label uppercase tracking-wide text-ink-muted">
                <th className="text-left font-medium pb-2">{t('Owner')}</th>
                <th className="text-right font-medium pb-2">
                  {t('Owner expenses')}
                </th>
                <th className="text-right font-medium pb-2">
                  {t('Income tax')}
                </th>
              </tr>
            </thead>
            <tbody>
              {(d.perOwner || []).map((o) => (
                <tr key={o.ownerName} className="border-t border-stone-line">
                  <td className="py-2.5">{o.ownerName}</td>
                  <td className="py-2.5 text-right">
                    <NumberFormat value={o.ownerExpenses} showZero debitColor />
                  </td>
                  <td className="py-2.5 text-right text-ink-muted">—</td>
                </tr>
              ))}
              {!(d.perOwner || []).length ? (
                <tr>
                  <td
                    colSpan={3}
                    className="py-3 text-center text-ink-muted text-label"
                  >
                    {t('No data')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* CASH FLOW + TREND */}
        <div className="rounded-2xl border border-stone-line bg-cream p-6">
          <SectionLabel>{t('Monthly cash flow')}</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-6">
            <div>
              <GraphTitle>{t('Monthly cash flow')}</GraphTitle>
              <ChartContainer config={{}} className="h-[150px] w-full">
                <BarChart data={cashflow}>
                  <CartesianGrid vertical={false} strokeOpacity={0.3} />
                  <XAxis
                    dataKey="m"
                    tickLine={false}
                    axisLine={false}
                    fontSize={10}
                  />
                  <Bar
                    dataKey="paid"
                    stackId="a"
                    fill="var(--color-olive)"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="owed"
                    stackId="a"
                    fill="var(--color-oxide)"
                    radius={[2, 2, 0, 0]}
                  />
                </BarChart>
              </ChartContainer>
            </div>
            <div>
              <GraphTitle>{t('Income & expense trend')}</GraphTitle>
              <ChartContainer config={{}} className="h-[150px] w-full">
                <LineChart data={cashflow}>
                  <CartesianGrid vertical={false} strokeOpacity={0.3} />
                  <XAxis
                    dataKey="m"
                    tickLine={false}
                    axisLine={false}
                    fontSize={10}
                  />
                  <Line
                    type="monotone"
                    dataKey="paid"
                    stroke="var(--color-olive)"
                    strokeWidth={2.5}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="owed"
                    stroke="var(--color-oxide)"
                    strokeWidth={2.5}
                    dot={false}
                  />
                  {d.isCurrentYear ? (
                    <ReferenceLine
                      x={monthNames[new Date().getMonth()]}
                      stroke="var(--color-ink-muted)"
                      strokeDasharray="3 3"
                    />
                  ) : null}
                </LineChart>
              </ChartContainer>
            </div>
          </div>
        </div>

        {/* ALLOCATION — category donut + largest expenses */}
        <div className="rounded-2xl border border-stone-line bg-cream p-6">
          <SectionLabel>{t('Expense allocation by category')}</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-6">
            <div>
              <GraphTitle>{t('Expense allocation by category')}</GraphTitle>
              <div className="flex items-center gap-5">
                <Donut slices={katanomes.byCategory || []} />
                <div className="flex-1">
                  <DonutLegend
                    items={(katanomes.byCategory || []).map((c, i) => ({
                      label: t(_categoryLabelKey(c.label)),
                      amount: c.amount,
                      color: DONUT_COLORS[i % DONUT_COLORS.length]
                    }))}
                  />
                </div>
              </div>
            </div>
            <div>
              <GraphTitle>{t('Largest expenses')}</GraphTitle>
              {(katanomes.byLabel || []).map((x) => (
                <RankBar
                  key={x.label}
                  name={x.label}
                  value={x.amount}
                  max={catMax}
                  color="var(--color-sea)"
                />
              ))}
            </div>
          </div>
        </div>

        {/* ALLOCATION — by building + by owner */}
        <div className="rounded-2xl border border-stone-line bg-cream p-6">
          <SectionLabel>{t('Expense allocation by building')}</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-6">
            <div>
              <GraphTitle>{t('Expense allocation by building')}</GraphTitle>
              <div className="flex items-center gap-5">
                <Donut slices={katanomes.byBuilding || []} />
                <div className="flex-1">
                  <DonutLegend
                    items={(katanomes.byBuilding || []).map((c, i) => ({
                      label: c.label,
                      amount: c.amount,
                      color: DONUT_COLORS[i % DONUT_COLORS.length]
                    }))}
                  />
                </div>
              </div>
            </div>
            <div>
              <GraphTitle>{t('Expense allocation by owner')}</GraphTitle>
              {(katanomes.byOwner || []).map((x) => (
                <RankBar
                  key={x.label}
                  name={x.label}
                  value={x.amount}
                  max={ownerMax}
                  color="var(--color-oxide)"
                />
              ))}
            </div>
          </div>
        </div>

        {/* OVERDUE + REPAIRS */}
        <div className="rounded-2xl border border-stone-line bg-cream p-6">
          <SectionLabel>{t('Overdue by tenant')}</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-6">
            <div>
              <GraphTitle>{t('Overdue by tenant')}</GraphTitle>
              {(d.arrears || []).map((a) => (
                <RankBar
                  key={a.name}
                  name={a.name}
                  value={a.owed}
                  max={arrearsMax}
                  color="var(--color-oxide)"
                />
              ))}
              {!(d.arrears || []).length ? (
                <p className="text-label text-ink-muted">{t('No data')}</p>
              ) : null}
            </div>
            <div>
              <GraphTitle>{t('Repair cost by building')}</GraphTitle>
              {((d.repairs && d.repairs.byBuilding) || []).map((r) => (
                <RankBar
                  key={r.name}
                  name={r.name}
                  value={r.cost}
                  max={repairMax}
                  color="var(--color-bark)"
                  meta={r.count}
                />
              ))}
              {!((d.repairs && d.repairs.byBuilding) || []).length ? (
                <p className="text-label text-ink-muted">{t('No data')}</p>
              ) : null}
            </div>
          </div>
        </div>

        {/* PER BUILDING — rows link to the building page */}
        <div className="rounded-2xl border border-stone-line bg-bone p-6">
          <SectionLabel>{t('Per building')}</SectionLabel>
          <table className="w-full text-body">
            <thead>
              <tr className="text-label uppercase tracking-wide text-ink-muted">
                <th className="text-left font-medium pb-2">{t('Building')}</th>
                <th className="text-right font-medium pb-2">{t('Income')}</th>
                <th className="text-right font-medium pb-2">
                  {t('Owner expenses')}
                </th>
                <th className="text-right font-medium pb-2">{t('Net profit')}</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody>
              {(d.perBuilding || []).map((b) => (
                <tr
                  key={b.buildingId}
                  className="border-t border-stone-line cursor-pointer hover:bg-cream"
                  onClick={() =>
                    router.push(`/${org}/buildings/${b.buildingId}`)
                  }
                >
                  <td className="py-2.5">{b.name}</td>
                  <td className="py-2.5 text-right">
                    <NumberFormat value={b.collected} showZero />
                  </td>
                  <td className="py-2.5 text-right">
                    <NumberFormat value={b.ownerExpenses} showZero debitColor />
                  </td>
                  <td className="py-2.5 text-right">
                    <NumberFormat value={b.net} showZero withColor />
                  </td>
                  <td className="py-2.5 text-right text-ink-muted">›</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Page>
  );
}

// projection headline row: label · big mono value (colored by role)
function ProjRow({ label, value, valueClass, negative, bold }) {
  return (
    <div className="flex items-baseline gap-4 mb-1">
      <span
        className={`flex-1 ${bold ? 'text-title text-ink font-medium' : 'text-body text-ink-soft'}`}
      >
        {label}
      </span>
      <span
        className={`font-mono tabular-nums whitespace-nowrap text-right ${valueClass} ${bold ? 'text-headline font-semibold' : 'text-headline'}`}
      >
        {negative ? '−' : ''}
        <NumberFormat value={value} showZero abs={negative} />
      </span>
    </div>
  );
}

// small 2-col analysis table (label · value), with a bold total row
function MiniTable({ title, rows, totalLabel, totalValue }) {
  return (
    <div>
      <div className="text-title text-ink-soft border-b border-stone-line pb-1.5 mb-1">
        {title}
      </div>
      <table className="w-full text-body">
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.k}-${i}`} className="border-t border-stone-line">
              <td className="py-1.5 text-ink-soft">{r.k}</td>
              <td className="py-1.5 text-right">
                <NumberFormat value={r.v} showZero />
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-stone-line font-semibold">
            <td className="py-1.5">{totalLabel}</td>
            <td className="py-1.5 text-right">
              <NumberFormat value={totalValue} showZero />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// The server breakdown category comes back as the persisted expense type-key or
// a category string; map to the shared building-expense label key so the
// donut/table read the SAME Greek as every other surface. Unknown → passthrough.
function _categoryLabelKey(cat) {
  const MAP = {
    heating: 'Heating',
    elevator: 'Elevator',
    cleaning: 'Cleaning',
    water_common: 'Water Common',
    electricity_common: 'Electricity Common',
    insurance: 'Insurance',
    management_fee: 'Management Fee',
    garden: 'Garden',
    repairs_fund: 'Repairs Fund',
    pest_control: 'Pest Control',
    other: 'Other',
    repair: 'Repair',
    repairs: 'Repairs'
  };
  return MAP[cat] || cat;
}

export default withAuthentication(Overview);
