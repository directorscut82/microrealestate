import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle
} from '../ui/card';
import { Badge } from '../ui/badge';
import BuildingAvatar from './BuildingAvatar';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import { LuAlertTriangle } from 'react-icons/lu';
import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const ACCENT_COLORS = [
  'border-l-blue-500',
  'border-l-emerald-500',
  'border-l-amber-500',
  'border-l-violet-500',
  'border-l-rose-500',
  'border-l-cyan-500',
  'border-l-orange-500',
  'border-l-indigo-500'
];

export default function BuildingListItem({ building, index = 0 }) {
  const router = useRouter();
  const { t } = useTranslation('common');

  const accent = ACCENT_COLORS[index % ACCENT_COLORS.length];

  const onClick = useCallback(async () => {
    await router.push(
      `/${router.query.organization}/buildings/${building._id}`
    );
  }, [router, building]);

  const atakLabel = building.atakPrefix
    ? ` (${building.atakPrefix})`
    : '';

  // Tier B9 — "Ελλειπή στοιχεία (διαμερίσματα, διαχειριστής, ...)" warning.
  // Gap-list mirrors the tenant tile pattern: brief, precise, parenthesized.
  // Detection rules:
  //   - units missing → 'διαμερίσματα'
  //   - manager.name missing → 'διαχειριστής'
  //   - address incomplete (any of street1/city/zipCode missing) → 'διεύθυνση'
  // atakPrefix is enforced at creation (Tier A3) so will never appear here.
  const missingFields = useMemo(() => {
    const gaps = [];
    if (!building.units?.length && !building.unitCount) {
      gaps.push(t('apartments'));
    }
    if (!building.manager?.name?.trim?.()) {
      gaps.push(t('manager'));
    }
    const a = building.address || {};
    if (!a.street1 || !a.city || !a.zipCode) {
      gaps.push(t('address'));
    }
    return gaps;
  }, [building.units, building.unitCount, building.manager, building.address, t]);

  return (
    <Card
      className={cn('cursor-pointer border-l-4 flex flex-col h-full', accent)}
      onClick={onClick}
    >
      <CardHeader className="mb-2 pb-2">
        <CardTitle className="flex justify-start items-center gap-2">
          <BuildingAvatar />
          <div className="min-w-0">
            <Button
              variant="link"
              className="w-fit h-fit p-0 text-sm font-semibold whitespace-normal text-left"
              data-cy="openResourceButton"
            >
              {building.name}
              {atakLabel && (
                <span className="text-xs font-normal text-muted-foreground ml-1">
                  {atakLabel}
                </span>
              )}
            </Button>
            {building.description && (
              <div className="text-xs font-normal text-muted-foreground truncate">
                {building.description}
              </div>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pb-3 flex-1">
        <div className="text-xs text-muted-foreground">
          {[building.address?.street1, building.address?.city]
            .filter(Boolean)
            .join(', ')}
        </div>
        {missingFields.length > 0 && (
          <div
            role="status"
            data-cy="buildingMissingFields"
            className="flex items-start gap-2 px-2.5 py-1.5 mt-2 border rounded-md text-xs bg-amber-50 text-amber-700 border-amber-200"
          >
            <LuAlertTriangle className="size-3.5 shrink-0 mt-0.5" aria-hidden="true" />
            <span className="leading-snug">
              {t('Missing details')} ({missingFields.join(', ')})
            </span>
          </div>
        )}
      </CardContent>
      <CardFooter className="p-0 flex-col mt-auto">
        <div className="flex items-center justify-between w-full py-3 px-6 border-t">
          <div className="text-xs text-muted-foreground">
            {t('{{count}} managed of {{total}} units', {
              count: building.managedCount || 0,
              total: building.unitCount || 0
            })}
          </div>
          <Badge variant="secondary" className="text-xs font-normal">
            {t('{{count}} units', { count: building.unitCount || 0 })}
          </Badge>
        </div>
      </CardFooter>
    </Card>
  );
}
