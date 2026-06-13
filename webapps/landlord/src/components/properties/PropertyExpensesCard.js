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

// A description that is a bare id-like token ('d6aa8660a511') is meaningless
// to a human — the expense was named with an id. Treat it as "no real name"
// so the line falls back to its category label instead of printing the hash.
// Mirrors expenseDisplayLabel in BuildingExpensePanel.
function _looksLikeId(name) {
  if (!name || typeof name !== 'string') return false;
  const s = name.trim();
  if (!s) return false;
  return /^[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f]{24}$/i.test(s);
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
      {lines.map((line, idx) => {
        // Render "<Category> (<description>)" so the user sees BOTH the
        // panel bucket AND the actual expense entry name. When the
        // server didn't tag a category (legacy line), or the description
        // is empty / equal to the category label, collapse to whatever
        // is informative.
        const categoryLabel = line.category
          ? _categoryLabel(t, line.category)
          : '';
        // I2-06: server emits empty description for legacy/unnamed
        // entries plus a descriptionKey ('monthly_charge', 'owner_repair',
        // 'owner_expense', 'repair', 'category_<panel>') that the client
        // resolves to the active locale. Without this, English fallback
        // strings bled into the Greek UI.
        let desc = line.description || '';
        // An id-named expense ('d6aa8660a511') carries no human meaning —
        // suppress it so the line shows its category ('Ύδρευση') instead of
        // "Ύδρευση (d6aa8660a511)". Real descriptions still append.
        if (_looksLikeId(desc)) desc = '';
        if (!desc && line.descriptionKey) {
          desc = _resolveDescriptionKey(t, line.descriptionKey);
        }
        const display =
          categoryLabel && desc && desc !== categoryLabel
            ? `${categoryLabel} (${desc})`
            : desc || categoryLabel || t('Other');
        // Who bears this line — renter (billed to the tenant) vs owner (an
        // owner-side liability attributed to this unit, e.g. a vacant-month
        // share). Surfaced as a small tag so the user sees the split the
        // category total is composed of, instead of an opaque sum.
        const payerLabel =
          line.payer === 'owner'
            ? t('owner')
            : line.payer === 'renter'
              ? t('tenant')
              : '';
        return (
          <div
            key={`${line.source}-${idx}-${line.description}`}
            className="flex justify-between gap-2 text-sm"
          >
            <span className="text-muted-foreground break-words min-w-0 flex-1">
              {display}
              {payerLabel && (
                <span className="ml-1 text-xs text-muted-foreground/60">
                  ({payerLabel})
                </span>
              )}
            </span>
            <span className="shrink-0">
              <NumberFormat value={Number(line.amount || 0)} />
            </span>
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
                {/* The per-line list and the by-category rollup carry the
                    SAME numbers whenever every category maps to exactly one
                    line (e.g. Θέρμανση 0,05 + Ασφάλιση 0,04 appears once as a
                    category and once as a line — double-vision). The category
                    rollup only ADDS information when at least one category
                    aggregates 2+ lines. So: prefer the line list (it's the
                    most specific, and shows descriptions); show the category
                    breakdown ONLY when it's a genuine rollup of multiple lines
                    into fewer categories. */}
                {(() => {
                  const lines = data.currentMonth?.lines || [];
                  const cats = data.currentMonth?.byCategory || {};
                  const nonZeroCats = CATEGORY_KEYS.filter(
                    (k) => Number(cats[k] || 0) !== 0
                  );
                  // A rollup is only additive when there are strictly more
                  // lines than non-zero categories (i.e. some category bundles
                  // multiple lines). Equal counts → 1:1 → redundant.
                  const categoryAddsInfo =
                    lines.length > 0 && lines.length > nonZeroCats.length;
                  // No lines at all but we do have category totals (legacy
                  // data without per-line detail): fall back to the rollup.
                  const showCategoryOnly =
                    lines.length === 0 && nonZeroCats.length > 0;
                  return (
                    <>
                      {(categoryAddsInfo || showCategoryOnly) && (
                        <CategoryBreakdown
                          byCategory={data.currentMonth?.byCategory}
                          t={t}
                        />
                      )}
                      {lines.length > 0 ? (
                        <div className={categoryAddsInfo ? 'mt-3' : ''}>
                          <ExpenseLines lines={lines} t={t} />
                        </div>
                      ) : (
                        !showCategoryOnly && (
                          <div className="text-sm text-muted-foreground">
                            {t('No expenses for this period')}
                          </div>
                        )
                      )}
                    </>
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
