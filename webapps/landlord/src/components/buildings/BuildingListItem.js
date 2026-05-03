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
import { useCallback } from 'react';
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

  return (
    <Card
      className={cn('cursor-pointer border-l-4', accent)}
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
      <CardContent className="space-y-1 pb-3">
        <div className="text-xs text-muted-foreground">
          {[building.address?.street1, building.address?.city]
            .filter(Boolean)
            .join(', ')}
        </div>
      </CardContent>
      <CardFooter className="p-0 flex-col">
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
