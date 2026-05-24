import {
  Card,
  CardContent,
  CardHeader,
  CardTitle
} from '../ui/card';
import { LuKeyRound, LuUserCircle } from 'react-icons/lu';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import NumberFormat from '../NumberFormat';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

/*
 * GeneralFigures — DESIGN.md panel composition.
 *
 * One quiet card with rows of label : value, NOT four stacked hero-metric
 * boxes. Numbers in mono tabular at body size, never oversized. Counts of
 * tenants and properties are pillarized as compact rows with affordance
 * arrows when navigable.
 */
function Row({
  label,
  value,
  description,
  onClick,
  emphasis = false
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4 py-3',
        'border-b border-stone-line last:border-b-0'
      )}
    >
      <div className="min-w-0">
        <div className="text-body text-ink">{label}</div>
        {description ? (
          <div className="text-label text-ink-muted mt-0.5">{description}</div>
        ) : null}
      </div>
      <div className="flex items-baseline gap-3 shrink-0">
        <span
          className={cn(
            'font-mono tabular-nums text-ink',
            emphasis ? 'text-title font-medium' : 'text-body'
          )}
        >
          {value}
        </span>
        {onClick ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClick}
            className="text-ink-muted hover:text-ink h-6 px-2 text-label"
          >
            ›
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default function GeneralFigures({ className, dashboardData }) {
  const router = useRouter();
  const { t } = useTranslation('common');

  const overview = dashboardData?.overview ?? {};

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader>
        <CardTitle>{t('Overview')}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Row
          label={t('Revenues')}
          description={t('Total revenues for the year')}
          value={
            <NumberFormat value={overview.totalYearRevenues} showZero={true} />
          }
          emphasis
        />
        <Row
          label={t('Occupancy rate')}
          description={t('Percentage of occupied properties')}
          value={
            <NumberFormat
              value={overview.occupancyRate}
              showZero={true}
              minimumFractionDigits={0}
              style="percent"
            />
          }
        />
        <Row
          label={
            <span className="inline-flex items-center gap-2">
              <LuUserCircle className="size-4 text-ink-muted" />
              {t('Tenants')}
            </span>
          }
          value={overview.tenantCount ?? 0}
          onClick={() =>
            router.push(`/${router.query.organization}/tenants`)
          }
        />
        <Row
          label={
            <span className="inline-flex items-center gap-2">
              <LuKeyRound className="size-4 text-ink-muted" />
              {t('Properties')}
            </span>
          }
          value={overview.propertyCount ?? 0}
          onClick={() =>
            router.push(`/${router.query.organization}/properties`)
          }
        />
      </CardContent>
    </Card>
  );
}
