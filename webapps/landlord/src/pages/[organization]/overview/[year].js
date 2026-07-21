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
import { BUILDING_TYPE_LABEL_KEY } from '../../../utils/lineLabels';
import { ChartContainer } from '../../../components/ui/chart';
import NumberFormat from '../../../components/NumberFormat';
import Page from '../../../components/Page';
import { LuArrowLeft, LuArrowRight } from 'react-icons/lu';
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
  const totals = d.totals || { income: 0, ownerExpenses: 0, net: 0, projection: {} };
  const proj = totals.projection || {};
  const katanomes = d.katanomes || {};

  // month bars for the cash-flow chart (paid vs owed), Greek initials.
  const monthNames = useMemo(
    () => ['Ι', 'Φ', 'Μ', 'Α', 'Μ', 'Ι', 'Ι', 'Α', 'Σ', 'Ο', 'Ν', 'Δ'],
    []
  );
  const cashflow = useMemo(() => {
    // Server returns `monthly` already ordered Jan→Dec (month 1..12) with an
    // income + expense figure per slot; index i maps to monthNames[i].
    const arr = d.monthly || [];
    return arr.map((m, i) => ({
      m: monthNames[i] || '',
      income: m.income || 0,
      expense: m.expense || 0
    }));
  }, [d.monthly, monthNames]);

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
          {/* F3 (audit-2026-07): removed a dead «Export to Excel» button that
              had no onClick and no backing endpoint (the Overview has no xlsx
              export; only the Accounting page does). A control that does
              nothing when clicked is a broken promise — reinstate it here only
              alongside a real /overview/:year export route. */}
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
          <ProjectionTable totals={totals} proj={proj} year={year} t={t} />
        </div>

        {/* ANALYSIS — income + owner-expense side by side */}
        <div className="rounded-2xl border border-stone-line bg-bone p-6">
          <SectionLabel>
            {t('Income & expense analysis')} ({t('up to')} {_todayFormatted()})
          </SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-4">
            <MiniTable
              title={t('Income')}
              rows={[
                { k: t('Rents'), v: totals.income || 0 },
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
          <div className="border-t border-stone-line mt-4 pt-3 flex items-baseline justify-between">
            <span className="text-title text-ink font-medium">{t('Difference')}</span>
            <span className="font-mono tabular-nums font-semibold text-olive">
              <NumberFormat value={(totals.income || 0) - (totals.ownerExpenses || 0)} showZero />
            </span>
          </div>
        </div>

        {/* PER OWNER — amounts to date (projection in parentheses) */}
        <div className="rounded-2xl border border-stone-line bg-bone p-6">
          <SectionLabel>
            {t('Per owner')} — {t('up to')} {_todayFormatted()} ({t('year projection in parens')})
          </SectionLabel>
          <table className="w-full text-body">
            <thead>
              <tr className="text-label uppercase tracking-wide text-ink-muted">
                <th className="text-left font-medium pb-2">{t('Owner')}</th>
                <th className="text-right font-medium pb-2">
                  {t('Rents')} ({t('projection')})
                </th>
                <th className="text-right font-medium pb-2">
                  {t('Owner expenses')} ({t('projection')})
                </th>
                <th className="text-right font-medium pb-2">
                  {t('Income tax')} ({t('projection')})
                </th>
                <th className="text-right font-medium pb-2">
                  {t('Net earnings')} ({t('projection')})
                </th>
              </tr>
            </thead>
            <tbody>
              {(d.perOwner || []).map((o) => (
                <tr key={o.ownerName} className="border-t border-stone-line">
                  <td className="py-2.5">{o.ownerName}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums">
                    <NumberFormat value={o.income} showZero />
                    {' '}
                    <span className="text-ink-muted">
                      (<NumberFormat value={o.incomeProjected} showZero />)
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-mono tabular-nums">
                    <NumberFormat value={o.ownerExpenses} showZero />
                    {' '}
                    <span className="text-ink-muted">
                      (<NumberFormat value={o.ownerExpensesProjected} showZero />)
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-mono tabular-nums">
                    <NumberFormat value={o.tax} showZero />
                    {' '}
                    <span className="text-ink-muted">
                      (<NumberFormat value={o.taxProjected} showZero />)
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-mono tabular-nums font-semibold">
                    <NumberFormat value={o.net} showZero withColor />
                    {' '}
                    <span className="text-ink-muted">
                      (<NumberFormat value={o.netProjected} showZero />)
                    </span>
                  </td>
                </tr>
              ))}
              {!(d.perOwner || []).length ? (
                <tr>
                  <td
                    colSpan={5}
                    className="py-3 text-center text-ink-muted text-label"
                  >
                    {t('No data')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="text-label text-ink-muted mt-3">
            {t('Tax is computed on rents only (95% × art. 40 brackets), excluding charges on rent.')}
          </p>
        </div>

        {/* PER BUILDING — rows link to the building page */}
        <div className="rounded-2xl border border-stone-line bg-bone p-6">
          <SectionLabel>
            {t('Per building')} — {t('up to')} {_todayFormatted()} ({t('year projection in parens')})
          </SectionLabel>
          <table className="w-full text-body">
            <thead>
              <tr className="text-label uppercase tracking-wide text-ink-muted">
                <th className="text-left font-medium pb-2">{t('Building')}</th>
                <th className="text-right font-medium pb-2">
                  {t('Income')} ({t('projection')})
                </th>
                <th className="text-right font-medium pb-2">
                  {t('Owner expenses')} ({t('projection')})
                </th>
                <th className="text-right font-medium pb-2">
                  {t('Net profit')} ({t('projection')})
                </th>
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
                  <td className="py-2.5 text-right font-mono tabular-nums">
                    <NumberFormat value={b.collected} showZero />
                    {' '}
                    <span className="text-ink-muted">
                      (<NumberFormat value={b.collectedProjected} showZero />)
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-mono tabular-nums">
                    <NumberFormat value={b.ownerExpenses} showZero />
                    {' '}
                    <span className="text-ink-muted">
                      (<NumberFormat value={b.ownerExpensesProjected} showZero />)
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-mono tabular-nums">
                    <NumberFormat value={b.net} showZero withColor />
                    {' '}
                    <span className="text-ink-muted">
                      (<NumberFormat value={b.netProjected} showZero />)
                    </span>
                  </td>
                  <td className="py-2.5 text-right text-ink-muted">›</td>
                </tr>
              ))}
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
                  {/* Grouped (not stacked): income vs expense side by side per
                      month — a real cash-flow, olive in / oxide out. */}
                  <Bar
                    dataKey="income"
                    fill="var(--color-olive)"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="expense"
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
                    dataKey="income"
                    stroke="var(--color-olive)"
                    strokeWidth={2.5}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="expense"
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
              {(katanomes.byLabel || []).map((x) => {
                // Strip the server's legacy English "Repair: <title>" prefix and
                // prepend the localized «Επισκευή», matching PropertyExpensesCard
                // (_lineLabel) and the category donut — the raw prefix leaked
                // English onto this otherwise-Greek surface.
                const isRepair = /^Repair:\s*/i.test(x.label || '');
                const stripped = (x.label || '').replace(/^Repair:\s*/i, '');
                const name = isRepair ? `${t('Repair')} (${stripped})` : x.label;
                return (
                  <RankBar
                    key={x.label}
                    name={name}
                    value={x.amount}
                    max={catMax}
                    color="var(--color-sea)"
                  />
                );
              })}
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

      </div>
    </Page>
  );
}

// Today formatted as DD/MM/YYYY for the analysis section header.
function _todayFormatted() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Greek accusative month names for the «έως Ιούλιο» column header.
const MONTH_ACC = [
  'Ιανουάριο',
  'Φεβρουάριο',
  'Μάρτιο',
  'Απρίλιο',
  'Μάιο',
  'Ιούνιο',
  'Ιούλιο',
  'Αύγουστο',
  'Σεπτέμβριο',
  'Οκτώβριο',
  'Νοέμβριο',
  'Δεκέμβριο'
];

function ProjectionTable({ totals, proj, year, t }) {
  const now = new Date();
  const isCurrentYear = now.getFullYear() === year;
  const monthLabel = isCurrentYear
    ? MONTH_ACC[now.getMonth()]
    : MONTH_ACC[11];
  // incomeEstimate = remaining future months; incomeOwed = past-due arrears.
  // Full-year projection = collected + owed + remaining (all three disjoint).
  const incOwed = totals.incomeOwed || 0;
  const incEst = (proj.incomeEstimate || 0) + incOwed;
  const expEst = proj.ownerExpensesEstimate || 0;
  const netEst = incEst - expEst;
  const incTotal = totals.income + incEst;
  const expTotal = totals.ownerExpenses + expEst;
  const netTotal = totals.net + netEst;

  const rows = [
    {
      label: t('Income'),
      actual: totals.income,
      est: incEst,
      total: incTotal,
      cls: 'text-ink'
    },
    {
      label: t('Owner expenses'),
      actual: totals.ownerExpenses,
      est: expEst,
      total: expTotal,
      cls: 'text-oxide',
      neg: true
    }
  ];

  return (
    <table className="w-full text-body">
      <thead>
        <tr className="text-label text-ink-muted">
          <th className="text-left font-medium pb-2" />
          <th className="text-right font-medium pb-2 whitespace-nowrap">
            (έως {monthLabel})
          </th>
          <th className="text-right font-medium pb-2 whitespace-nowrap">
            (εκτίμηση υπόλοιπων μηνών)
          </th>
          <th className="text-right font-medium pb-2">{t('Total')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td className="py-1.5 text-ink-soft">{r.label}</td>
            <td className={`py-1.5 text-right font-mono tabular-nums ${r.cls}`}>
              {r.neg ? '−' : ''}
              <NumberFormat value={r.actual} showZero abs={r.neg} />
            </td>
            <td className={`py-1.5 text-right font-mono tabular-nums ${r.cls}`}>
              {r.neg ? '−' : ''}
              <NumberFormat value={r.est} showZero abs={r.neg} />
            </td>
            <td className={`py-1.5 text-right font-mono tabular-nums font-semibold ${r.cls}`}>
              {r.neg ? '−' : ''}
              <NumberFormat value={r.total} showZero abs={r.neg} />
            </td>
          </tr>
        ))}
        <tr className="border-t border-stone-line font-semibold">
          <td className="py-2 text-ink">{t('Net profit')}</td>
          <td className="py-2 text-right font-mono tabular-nums text-olive">
            <NumberFormat value={totals.net} showZero />
          </td>
          <td className="py-2 text-right font-mono tabular-nums text-olive">
            <NumberFormat value={netEst} showZero />
          </td>
          <td className="py-2 text-right font-mono tabular-nums font-semibold text-olive">
            <NumberFormat value={netTotal} showZero />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// small 2-col analysis table (label · value), with a bold total row.
// ONE hairline only — above the total (per user). No header underline, no
// per-row rules; whitespace separates the rows.
function MiniTable({ title, rows, totalLabel, totalValue }) {
  return (
    <div>
      <div className="text-title text-ink-soft mb-2">{title}</div>
      <table className="w-full text-body">
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.k}-${i}`}>
              <td className="py-1.5 text-ink-soft">{r.k}</td>
              <td className="py-1.5 text-right">
                <NumberFormat value={r.v} showZero />
              </td>
            </tr>
          ))}
          <tr className="border-t border-stone-line font-semibold">
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

// The server breakdown category comes back as the persisted expense type-key
// or 'repair'; map to the shared building-expense label key so the donut/table
// read the SAME Greek as every other surface. Unknown → passthrough.
// F5 (audit-2026-07): use the single source of truth (lineLabels.
// BUILDING_TYPE_LABEL_KEY) instead of a 4th inline copy of the map that would
// silently drift from the expense table / PDF / dashboard chart.
function _categoryLabelKey(cat) {
  return BUILDING_TYPE_LABEL_KEY[cat] || cat;
}

export default withAuthentication(Overview);
