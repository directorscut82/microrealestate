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
import { useCallback } from 'react';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

export default function BuildingListItem({ building }) {
  const router = useRouter();
  const { t } = useTranslation('common');

  const onClick = useCallback(async () => {
    await router.push(
      `/${router.query.organization}/buildings/${building._id}`
    );
  }, [router, building]);

  return (
    <Card className="cursor-pointer" onClick={onClick}>
      <CardHeader className="mb-4">
        <CardTitle className="flex justify-start items-center gap-2">
          <BuildingAvatar />
          <div>
            <Button
              variant="link"
              className="w-fit h-fit p-0 text-xl whitespace-normal"
              data-cy="openResourceButton"
            >
              {building.name}
            </Button>
            <div className="text-xs font-normal text-muted-foreground">
              {building.description}
            </div>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pb-4">
        <div className="text-sm text-muted-foreground">
          {[building.address?.street1, building.address?.city]
            .filter(Boolean)
            .join(', ')}
        </div>
      </CardContent>
      <CardFooter className="p-0 flex-col">
        <div className="flex items-center justify-between w-full py-4 px-6">
          <div className="text-xs text-muted-foreground">
            {t('{{count}} managed of {{total}} units', {
              count: building.managedCount || 0,
              total: building.unitCount || 0
            })}
          </div>
          <Badge variant="secondary" className="font-normal">
            {t('{{count}} units', { count: building.unitCount || 0 })}
          </Badge>
        </div>
      </CardFooter>
    </Card>
  );
}
