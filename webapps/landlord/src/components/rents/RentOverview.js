import { LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import NumberFormat from '../NumberFormat';
import { useCallback } from 'react';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

/*
 * RentOverview — DESIGN.md ledger header.
 *
 * One quiet summary line with the period (with prev/next navigation), and
 * inline counts: total rents, not-paid (+ amount in oxide), paid (+ amount
 * in olive). NOT four hero-metric cards. Numbers in mono tabular.
 */

function PeriodNav({ period, onChange }) {
  const { t } = useTranslation('common');
  const handlePrev = () => onChange(period.clone().subtract(1, 'month'));
  const handleNext = () => onChange(period.clone().add(1, 'month'));

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        onClick={handlePrev}
        aria-label={t('Previous month')}
        className="h-8 w-8"
      >
        <LuChevronLeft className="size-4" />
      </Button>
      <span className="text-headline font-medium text-ink tracking-tight tabular-nums min-w-[10ch] text-center">
        {period.format('MMMM YYYY')}
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleNext}
        aria-label={t('Next month')}
        className="h-8 w-8"
      >
        <LuChevronRight className="size-4" />
      </Button>
    </div>
  );
}

function Stat({ label, count, partialCount, amount, color, className, carryIn }) {
  const { t } = useTranslation('common');
  return (
    <div className={cn('flex flex-col gap-0.5 min-w-0', className)}>
      <span className="text-label text-ink-muted uppercase tracking-wide">
        {label}
        {/* Wave-26 round-3r: 'Οφειλές' tile shows '(prior dues: X)' so
            the landlord knows how much of the outstanding figure is
            carry-in from previous months vs. this month's bill. Parens
            hide when carryIn is zero. */}
        {typeof carryIn === 'number' && carryIn > 0.005 ? (
          <span className="ml-1 text-ink-muted normal-case font-normal tracking-normal">
            ({t('prior dues')}:{' '}
            <NumberFormat value={carryIn} showZero={false} />)
          </span>
        ) : null}
      </span>
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'font-mono tabular-nums text-title font-medium',
            color || 'text-ink'
          )}
        >
          <NumberFormat value={amount} showZero={true} />
        </span>
        {typeof count === 'number' ? (
          <span className="text-label text-ink-muted">
            {t('{{count}} rents', { count })}
            {/* Wave-26 round-3h: when the 'Paid this month' tile counts a mix
                of fully-paid and partially-paid rents, surface the partial
                sub-count in parens so the headline number doesn't lie. The
                parens disappear when there are 0 partials — clean tile in
                the common case. */}
            {typeof partialCount === 'number' && partialCount > 0 ? (
              <> ({t('{{count}} partial', { count: partialCount })})</>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function RentOverview({ data }) {
  const { t } = useTranslation('common');
  const router = useRouter();

  const handlePeriodChange = useCallback(
    async (newPeriod) => {
      await router.push(
        `/${router.query.organization}/rents/${newPeriod.format('YYYY.MM')}`
      );
    },
    [router]
  );

  return (
    <div className="flex flex-col gap-4 mb-2">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <PeriodNav period={data.period} onChange={handlePeriodChange} />
        <span className="text-body text-ink-muted">
          {data.countAll ?? 0} {t('rents in total')}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-x-12 gap-y-4 pb-4 border-b border-stone-line">
        <Stat
          label={t('Outstanding')}
          amount={data.totalNotPaid}
          count={data.countNotPaid}
          carryIn={data.totalCarriedBalance ?? 0}
          color="text-oxide"
        />
        <Stat
          label={t('Receipts')}
          amount={data.totalPaid}
          count={
            (data.countPaid ?? 0) + (data.countPartiallyPaid ?? 0)
          }
          partialCount={data.countPartiallyPaid ?? 0}
          color="text-olive"
        />
      </div>
    </div>
  );
}
