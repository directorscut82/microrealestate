import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '../ui/collapsible';
import { LuChevronsUpDown, LuWallet } from 'react-icons/lu';
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

// I2-06: server-side English fallback strings ('Monthly charge',
// 'Owner repair', 'Owner expense', 'Repair') used to bleed into the
// Greek UI when a row lacked a user-supplied description. The server
// now ships an empty `description` plus a `descriptionKey` token; this
// helper translates the token client-side via the active locale.
function _resolveDescriptionKey(t, key) {
  if (!key) return '';
  if (key === 'monthly_charge') return t('Monthly charge');
  if (key === 'owner_repair') return t('Owner repair');
  if (key === 'owner_expense') return t('Owner expense');
  if (key === 'repair') return t('Repair');
  if (typeof key === 'string' && key.startsWith('category_')) {
    const panel = key.slice('category_'.length);
    return _categoryLabel(t, panel);
  }
  return '';
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

// Render ONE expense line's label: "<Category> (<name>)" + payer tag.
// Shared by the flat list and the grouped-by-category list.
function _lineLabel(t, line) {
  const categoryLabel = line.category ? _categoryLabel(t, line.category) : '';
  let desc = line.description || '';
  // Strip the server's legacy English "Repair: <title>" prefix.
  desc = desc.replace(/^Repair:\s*/i, '');
  if (!desc && line.descriptionKey) {
    desc = _resolveDescriptionKey(t, line.descriptionKey);
  }
  return categoryLabel && desc && desc !== categoryLabel
    ? `${categoryLabel} (${desc})`
    : desc || categoryLabel || t('Other');
}

function _payerTag(t, line) {
  return line.payer === 'owner'
    ? t('owner')
    : line.payer === 'renter'
      ? t('tenant')
      : '';
}

// Grouped list (user-chosen layout): lines bucketed by category. A category
// with ONE line renders as a single row (no redundant subtotal). A category
// with 2+ lines renders a subtotal row, then its members indented beneath. This
// replaces the old "category rollup block + flat line list" pair, which printed
// single-line categories twice (double-vision).
function GroupedExpenseLines({ lines, t }) {
  if (!lines?.length) {
    return (
      <div className="text-sm text-muted-foreground">
        {t('No expenses for this period')}
      </div>
    );
  }
  // Preserve first-seen category order.
  const order = [];
  const groups = new Map();
  for (const line of lines) {
    const key = line.category || 'other';
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(line);
  }
  return (
    <div className="space-y-1.5">
      {order.map((key) => {
        const members = groups.get(key);
        const subtotal = members.reduce(
          (s, l) => s + Number(l.amount || 0),
          0
        );
        // Single-line category → one plain row (label carries the name).
        if (members.length === 1) {
          const line = members[0];
          const payer = _payerTag(t, line);
          return (
            <div
              key={key}
              className="flex justify-between gap-2 text-sm"
            >
              <span className="text-muted-foreground break-words min-w-0 flex-1">
                {_lineLabel(t, line)}
                {payer && (
                  <span className="ml-1 text-xs text-muted-foreground/60">
                    ({payer})
                  </span>
                )}
              </span>
              <span className="shrink-0">
                <NumberFormat value={Number(line.amount || 0)} />
              </span>
            </div>
          );
        }
        // Multi-line category → subtotal header + indented members.
        return (
          <div key={key}>
            <div className="flex justify-between gap-2 text-sm font-medium text-ink">
              <span>{_categoryLabel(t, key)}</span>
              <NumberFormat value={subtotal} />
            </div>
            <div className="mt-0.5 space-y-0.5">
              {members.map((line, i) => {
                const payer = _payerTag(t, line);
                // Indented member label: drop the leading category (it's in the
                // header) and show just the name + payer.
                const name = (() => {
                  let desc = (line.description || '').replace(
                    /^Repair:\s*/i,
                    ''
                  );
                  if (!desc && line.descriptionKey) {
                    desc = _resolveDescriptionKey(t, line.descriptionKey);
                  }
                  return desc || _categoryLabel(t, key);
                })();
                return (
                  <div
                    key={i}
                    className="flex justify-between gap-2 text-sm pl-3"
                  >
                    <span className="text-muted-foreground break-words min-w-0 flex-1">
                      <span className="text-muted-foreground/50">↳ </span>
                      {name}
                      {payer && (
                        <span className="ml-1 text-xs text-muted-foreground/60">
                          ({payer})
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      <NumberFormat value={Number(line.amount || 0)} />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
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
    // ' έως ' (not an em dash, which is banned in copy) — matches the
    // previous-tenants card's range wording.
    return fromStr && toStr
      ? `${base} (${fromStr} ${t('to')} ${toStr})`
      : base;
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
      Icon={LuWallet}
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
                  className="flex w-full justify-between gap-2 px-2 h-auto py-1.5"
                >
                  <span className="font-medium text-left whitespace-normal break-words min-w-0 flex-1">
                    {currentMonthLabel}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <NumberFormat value={currentTotal} />
                    <LuChevronsUpDown className="size-4 text-muted-foreground" />
                  </span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="px-2 pt-2 pb-1">
                {/* ONE grouped list (user-chosen): lines bucketed by category;
                    a single-line category is one row, a multi-line category
                    shows a subtotal + indented members. This replaced the old
                    "ΑΝΑ ΚΑΤΗΓΟΡΙΑ rollup block + flat line list" pair, which
                    printed single-line categories twice (double-vision). When
                    there are no per-line details (legacy data) fall back to the
                    category rollup so the figures still show. */}
                {(() => {
                  const lines = data.currentMonth?.lines || [];
                  const cats = data.currentMonth?.byCategory || {};
                  const nonZeroCats = CATEGORY_KEYS.filter(
                    (k) => Number(cats[k] || 0) !== 0
                  );
                  if (lines.length > 0) {
                    return <GroupedExpenseLines lines={lines} t={t} />;
                  }
                  if (nonZeroCats.length > 0) {
                    return (
                      <CategoryBreakdown
                        byCategory={data.currentMonth?.byCategory}
                        t={t}
                      />
                    );
                  }
                  return (
                    <div className="text-sm text-muted-foreground">
                      {t('No expenses for this period')}
                    </div>
                  );
                })()}
              </CollapsibleContent>
            </Collapsible>

            <Collapsible open={openLifetime} onOpenChange={setOpenLifetime}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex w-full justify-between gap-2 px-2 h-auto py-1.5"
                >
                  <span className="font-medium text-left whitespace-normal break-words min-w-0 flex-1">
                    {lifetimeLabel}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <NumberFormat value={lifetimeTotal} />
                    <LuChevronsUpDown className="size-4 text-muted-foreground" />
                  </span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="px-2 pt-2 pb-1">
                {/* Hide redundant single-row breakdowns. With one expense in
                    one year, both ANA KATHGORIA and ANA ETOS have a single
                    row that equals the total — duplicated information.
                    Only render a section when it adds info (>1 row). */}
                {(() => {
                  const cats = data.lifetime?.byCategory || {};
                  const years = data.lifetime?.byYear || {};
                  const nonZeroCats = CATEGORY_KEYS.filter(
                    (k) => Number(cats[k] || 0) !== 0
                  );
                  const nonZeroYears = Object.keys(years).filter(
                    (y) => Number(years[y] || 0) !== 0
                  );
                  const showCats = nonZeroCats.length > 1;
                  const showYears = nonZeroYears.length > 1;
                  if (!showCats && !showYears) {
                    // Single category × single year: just say what it is
                    // and stop. Redundant breakdown removed.
                    return (
                      <div className="text-sm text-muted-foreground">
                        {nonZeroCats.length === 1 && nonZeroYears.length === 1
                          ? t(
                              'All in {{category}} during {{year}}',
                              {
                                category: _categoryLabel(t, nonZeroCats[0]),
                                year: nonZeroYears[0]
                              }
                            )
                          : t('No expenses for this period')}
                      </div>
                    );
                  }
                  return (
                    <>
                      {showCats && (
                        <CategoryBreakdown byCategory={cats} t={t} />
                      )}
                      {showYears && (
                        <YearBreakdown byYear={years} t={t} />
                      )}
                    </>
                  );
                })()}
              </CollapsibleContent>
            </Collapsible>
          </div>
        );
      }}
    />
  );
}
