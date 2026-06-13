import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle
} from '../ui/card';
import { Badge } from '../ui/badge';
import { cn } from '../../utils';
import { LuHome, LuUsers } from 'react-icons/lu';
import NumberFormat from '../NumberFormat';
import { Progress } from '../ui/progress';
import { useCallback } from 'react';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

// One owner card in the Owners list. Mirrors TenantListItem: header (name +
// occupancy pill), body (units/buildings + paid-vs-total progress), footer
// (outstanding/settled status pill). Clicking opens the owner detail page.
export default function OwnerListItem({ owner }) {
  const router = useRouter();
  const { t } = useTranslation('common');

  const handleClick = useCallback(async () => {
    await router.push(
      `/${router.query.organization}/owners/${encodeURIComponent(
        owner.ownerKey
      )}`
    );
  }, [router, owner.ownerKey]);

  const total = Number(owner.totalAmount) || 0;
  const paid = Number(owner.totalPaid) || 0;
  const outstanding = Number(owner.totalOutstanding) || 0;
  const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
  const settled = outstanding <= 0.005;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="mb-2 cursor-pointer" onClick={handleClick}>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate">
            {owner.name || t('Owner')}
          </CardTitle>
          {owner.alsoRents && (
            <Badge variant="outline" className="font-normal shrink-0 gap-1">
              <LuHome className="size-3 shrink-0" aria-hidden="true" />
              {t('Also a tenant')}
            </Badge>
          )}
        </div>
        {owner.taxId && (
          <div className="text-label text-ink-muted">
            {t('Tax ID')}: {owner.taxId}
          </div>
        )}
      </CardHeader>

      <CardContent className="cursor-pointer space-y-2" onClick={handleClick}>
        <div className="flex items-center gap-4 text-label text-ink-muted">
          <span className="inline-flex items-center gap-1">
            <LuUsers className="size-3.5" aria-hidden="true" />
            {t('{{count}} units', { count: owner.unitCount || 0 })}
          </span>
          <span>
            {t('{{count}} buildings', { count: owner.buildingCount || 0 })}
          </span>
        </div>
        {total > 0 && (
          <>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-ink-muted">{t('Owner expenses paid')}</span>
              <span className="tabular-nums">
                <NumberFormat value={paid} />
                <span className="text-ink-muted">
                  {' / '}
                  <NumberFormat value={total} />
                </span>
              </span>
            </div>
            <Progress value={pct} />
          </>
        )}
      </CardContent>

      <CardFooter className="flex items-center justify-end w-full py-3 px-5">
        <Badge
          data-owner-state={settled ? 'settled' : 'outstanding'}
          variant={settled ? 'success' : 'outline'}
          className={cn(
            'font-normal',
            !settled && 'border-oxide/40 text-oxide'
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 rounded-pill shrink-0',
              settled ? 'bg-olive' : 'bg-oxide'
            )}
          />
          {settled
            ? t('Settled')
            : `${t('Outstanding')}: ${new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: 'EUR'
              }).format(outstanding)}`}
        </Badge>
      </CardFooter>
    </Card>
  );
}
