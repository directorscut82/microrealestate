import { useCallback, useMemo, useState } from 'react';
import { cn } from '../../utils';
import { LuCalendar, LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { Separator } from '../ui/separator';
import useTranslation from 'next-translate/useTranslation';
import moment from 'moment';
import NumberFormat from '../NumberFormat';

function getHistoryData(building) {
  const units = building?.units || [];
  const expenses = building?.expenses || [];
  const termMap = {};

  for (const unit of units) {
    if (!unit.monthlyCharges) continue;
    for (const charge of unit.monthlyCharges) {
      const term = String(charge.term);
      if (!termMap[term]) {
        termMap[term] = {};
      }
      const key = charge.expenseId || charge.description || 'unknown';
      if (!termMap[term][key]) {
        termMap[term][key] = {
          expenseId: charge.expenseId,
          description: charge.description || '',
          total: 0
        };
      }
      termMap[term][key].total += charge.amount || 0;
    }
  }

  // Enrich descriptions from expenses list
  for (const term of Object.keys(termMap)) {
    for (const key of Object.keys(termMap[term])) {
      const entry = termMap[term][key];
      if (entry.expenseId) {
        const exp = expenses.find(
          (e) => String(e._id) === String(entry.expenseId)
        );
        if (exp) {
          entry.description = exp.name;
        }
      }
    }
  }

  return termMap;
}

function formatTerm(term) {
  const s = String(term).padEnd(10, '0');
  const m = moment(s, 'YYYYMMDDHH');
  return m.isValid() ? m.format('MMM YYYY') : term;
}

function formatTermShort(term) {
  const s = String(term).padEnd(10, '0');
  const m = moment(s, 'YYYYMMDDHH');
  return m.isValid() ? m.format('MMM') : term;
}

function getTermYear(term) {
  return String(term).slice(0, 4);
}

export default function ExpenseHistory({ building }) {
  const { t } = useTranslation('common');
  const [selectedTerms, setSelectedTerms] = useState([]);
  const [visibleYear, setVisibleYear] = useState(
    () => moment().format('YYYY')
  );

  const historyData = useMemo(() => getHistoryData(building), [building]);

  const availableTerms = useMemo(
    () =>
      Object.keys(historyData)
        .sort((a, b) => Number(b) - Number(a)),
    [historyData]
  );

  const availableYears = useMemo(() => {
    const years = [...new Set(availableTerms.map(getTermYear))].sort(
      (a, b) => Number(b) - Number(a)
    );
    return years.length > 0 ? years : [moment().format('YYYY')];
  }, [availableTerms]);

  const termsForYear = useMemo(
    () => availableTerms.filter((term) => getTermYear(term) === visibleYear),
    [availableTerms, visibleYear]
  );

  const handleYearPrev = useCallback(() => {
    setVisibleYear((y) => String(Number(y) - 1));
  }, []);

  const handleYearNext = useCallback(() => {
    setVisibleYear((y) => String(Number(y) + 1));
  }, []);

  const toggleTerm = useCallback((term) => {
    setSelectedTerms((prev) =>
      prev.includes(term)
        ? prev.filter((t) => t !== term)
        : [...prev, term]
    );
  }, []);

  const selectedData = useMemo(() => {
    const sorted = [...selectedTerms].sort(
      (a, b) => Number(b) - Number(a)
    );
    return sorted.map((term) => ({
      term,
      label: formatTerm(term),
      entries: Object.values(historyData[term] || {})
    }));
  }, [selectedTerms, historyData]);

  if (availableTerms.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-12 text-muted-foreground">
        <LuCalendar className="size-8 mb-3 opacity-40" />
        <p className="text-sm">{t('No history yet')}</p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-lg font-medium mb-4">
        {t('Expense History')}
      </h3>

      {/* Year navigator */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={handleYearPrev}
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          <LuChevronLeft className="size-4" />
        </button>
        <span className="text-sm font-medium tabular-nums">
          {visibleYear}
        </span>
        <button
          onClick={handleYearNext}
          className="p-1 rounded hover:bg-muted transition-colors"
          disabled={
            Number(visibleYear) >= Number(moment().format('YYYY'))
          }
        >
          <LuChevronRight className="size-4" />
        </button>
      </div>

      {/* Month grid */}
      <div className="grid grid-cols-4 gap-1.5 mb-4">
        {Array.from({ length: 12 }, (_, i) => {
          const m = moment(`${visibleYear}-${String(i + 1).padStart(2, '0')}-01`);
          const termPrefix = m.format('YYYYMM');
          const matchingTerm = termsForYear.find((t) =>
            t.startsWith(termPrefix)
          );
          const hasData = !!matchingTerm;
          const isSelected = matchingTerm && selectedTerms.includes(matchingTerm);

          return (
            <button
              key={i}
              disabled={!hasData}
              onClick={() => hasData && toggleTerm(matchingTerm)}
              className={cn(
                'px-2 py-1.5 text-xs rounded-md transition-all duration-150',
                'border border-transparent',
                hasData && !isSelected &&
                  'bg-muted/60 hover:bg-muted text-foreground cursor-pointer hover:border-border',
                isSelected &&
                  'bg-primary text-primary-foreground border-primary shadow-sm',
                !hasData &&
                  'text-muted-foreground/40 cursor-not-allowed'
              )}
            >
              {m.format('MMM')}
            </button>
          );
        })}
      </div>

      {/* Selected months data */}
      {selectedData.length > 0 && (
        <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
          {selectedData.map(({ term, label, entries }) => {
            const total = entries.reduce((sum, e) => sum + e.total, 0);
            return (
              <div
                key={term}
                className="rounded-lg border bg-card p-3"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-sm font-semibold tabular-nums">
                    <NumberFormat value={total} />
                  </span>
                </div>
                <Separator className="mb-2" />
                <div className="space-y-1">
                  {entries.map((entry, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-muted-foreground truncate mr-2">
                        {entry.description}
                      </span>
                      <span className="tabular-nums font-medium whitespace-nowrap">
                        <NumberFormat value={entry.total} />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedData.length === 0 && (
        <p className="text-xs text-muted-foreground text-center mt-2">
          {t('Select months to view expenses')}
        </p>
      )}
    </div>
  );
}
