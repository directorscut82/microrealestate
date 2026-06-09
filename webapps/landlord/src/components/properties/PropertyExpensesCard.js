import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '../ui/collapsible';
import { LuChevronsUpDown, LuReceipt } from 'react-icons/lu';
import { useMemo, useState } from 'react';
import { Button } from '../ui/button';
import { DashboardCard } from '../dashboard/DashboardCard';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import useFetchPropertyExpenses from '../../hooks/useFetchPropertyExpenses';
import useTranslation from 'next-translate/useTranslation';

// YYYYMMDDHH integer → "MMM YYYY" string, localised via the active moment locale.
function _formatTermShort(term, locale) {
  if (!term) return '';
  const m = moment.utc(String(term), 'YYYYMMDDHH');
  if (!m.isValid()) return '';
  return locale ? m.locale(locale).format('MMM YYYY') : m.format('MMM YYYY');
}

const CATEGORY_KEYS = [
  'heating',
  'water',
  'electricity',
  'insurance',
  'cleaning',
  'repairs',
  'other'
];

function _categoryLabel(t, key) {
  switch (key) {
    case 'heating':
      return t('Heating');
    case 'water':
      return t('Water');
    case 'electricity':
      return t('Electricity');
    case 'insurance':
      return t('Insurance');
    case 'cleaning':
      return t('Cleaning');
    case 'repairs':
      return t('Repairs');
    case 'other':
    default:
      return t('Other');
  }
}

function CategoryBreakdown({ byCategory, t }) {
  const rows = CATEGORY_KEYS.filter((k) => Number(byCategory?.[k] || 0) !== 0);
  if (!rows.length) {
    return (
      <div className="text-sm text-muted-foreground">
        {t('No expenses for this period')}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {t('By category')}
      </div>
      {rows.map((k) => (
        <div key={k} className="flex justify-between text-sm">
          <span className="text-muted-foreground">{_categoryLabel(t, k)}</span>
          <NumberFormat value={Number(byCategory?.[k] || 0)} />
        </div>
      ))}
    </div>
  );
}

function YearBreakdown({ byYear, t }) {
  const years = useMemo(() => {
    const keys = Object.keys(byYear || {});
    return keys
      .filter((y) => Number(byYear[y] || 0) !== 0)
      .sort((a, b) => Number(b) - Number(a));
  }, [byYear]);
  if (!years.length) return null;
  return (
    <div className="mt-3 space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {t('By year')}
      </div>
      {years.map((y) => (
        <div key={y} className="flex justify-between text-sm">
          <span className="text-muted-foreground">{y}</span>
          <NumberFormat value={Number(byYear[y] || 0)} />
        </div>
      ))}
    </div>
  );
}

function ExpenseLines({ lines, t }) {
  if (!lines?.length) {
    return (
      <div className="text-sm text-muted-foreground">
        {t('No expenses for this period')}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {lines.map((line, idx) => (
        <div
          key={`${line.source}-${idx}-${line.description}`}
          className="flex justify-between gap-2 text-sm"
        >
          <span className="text-muted-foreground truncate">
            {line.description}
          </span>
          <NumberFormat value={Number(line.amount || 0)} />
        </div>
      ))}
    </div>
  );
}

export default function PropertyExpensesCard({ propertyId }) {
  const { t, lang } = useTranslation('common');
  const [openCurrent, setOpenCurrent] = useState(true);
  const [openLifetime, setOpenLifetime] = useState(false);

  const { data, isLoading } = useFetchPropertyExpenses(propertyId);

  // Server returns currentTerm + fromTerm + toTerm as YYYYMMDDHH integers
  // so the tile can label "Current month (June 2026)" and "13-month
  // total (Jun 2025 — Jun 2026)" instead of bare unanchored text.
  const currentMonthLabel = useMemo(() => {
    const base = t('Current month');
    const monthStr = data?.currentTerm
      ? _formatTermShort(data.currentTerm, lang)
      : '';
    return monthStr ? `${base} (${monthStr})` : base;
  }, [data?.currentTerm, lang, t]);

  const lifetimeLabel = useMemo(() => {
    const base = t('Lifetime total');
    const fromStr = data?.fromTerm
      ? _formatTermShort(data.fromTerm, lang)
      : '';
    const toStr = data?.toTerm ? _formatTermShort(data.toTerm, lang) : '';
    return fromStr && toStr ? `${base} (${fromStr} — ${toStr})` : base;
  }, [data?.fromTerm, data?.toTerm, lang, t]);

  const currentTotal = useMemo(() => {
    if (!data?.currentMonth?.byCategory) return 0;
    return CATEGORY_KEYS.reduce(
      (sum, k) => sum + Number(data.currentMonth.byCategory[k] || 0),
      0
    );
  }, [data]);

  const lifetimeTotal = useMemo(() => {
    if (!data?.lifetime?.byCategory) return 0;
    return CATEGORY_KEYS.reduce(
      (sum, k) => sum + Number(data.lifetime.byCategory[k] || 0),
      0
    );
  }, [data]);

  return (
    <DashboardCard
      Icon={LuReceipt}
      title={t('Property expenses')}
      renderContent={() => {
        if (isLoading) {
          return (
            <div className="text-sm text-muted-foreground">
              {t('Loading...')}
            </div>
          );
        }
        if (!data) {
          return (
            <div className="text-sm text-muted-foreground">
              {t('No expenses for this period')}
            </div>
          );
        }
        return (
          <div className="space-y-3 w-full">
            <Collapsible open={openCurrent} onOpenChange={setOpenCurrent}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex w-full justify-between px-2"
                >
                  <span className="font-medium">{currentMonthLabel}</span>
                  <span className="flex items-center gap-2">
                    <NumberFormat value={currentTotal} />
                    <LuChevronsUpDown className="size-4 text-muted-foreground" />
                  </span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="px-2 pt-2 pb-1">
                <CategoryBreakdown
                  byCategory={data.currentMonth?.byCategory}
                  t={t}
                />
                {data.currentMonth?.lines?.length ? (
                  <div className="mt-3">
                    <ExpenseLines lines={data.currentMonth.lines} t={t} />
                  </div>
                ) : null}
              </CollapsibleContent>
            </Collapsible>

            <Collapsible open={openLifetime} onOpenChange={setOpenLifetime}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex w-full justify-between px-2"
                >
                  <span className="font-medium">{lifetimeLabel}</span>
                  <span className="flex items-center gap-2">
                    <NumberFormat value={lifetimeTotal} />
                    <LuChevronsUpDown className="size-4 text-muted-foreground" />
                  </span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="px-2 pt-2 pb-1">
                <CategoryBreakdown
                  byCategory={data.lifetime?.byCategory}
                  t={t}
                />
                <YearBreakdown byYear={data.lifetime?.byYear} t={t} />
              </CollapsibleContent>
            </Collapsible>
          </div>
        );
      }}
    />
  );
}
