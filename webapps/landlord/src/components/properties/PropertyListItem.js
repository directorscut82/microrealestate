import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle
} from '../../components/ui/card';
import { useCallback } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import NumberFormat from '../../components/NumberFormat';
import PropertyAvatar from './PropertyAvatar';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

export default function PropertyListItem({ property, accent }) {
  const router = useRouter();
  const { t } = useTranslation('common');

  const onClick = useCallback(async () => {
    await router.push(
      `/${router.query.organization}/properties/${property._id}`
    );
  }, [router, property]);

  const atakLabel = property.atakNumber
    ? ` (${[property.atakNumber, ...(property.altAtakNumbers || [])].join(', ')})`
    : '';

  return (
    <Card
      className={cn('cursor-pointer', accent && `border-l-4 ${accent}`)}
      onClick={onClick}
    >
      <CardHeader className="mb-2 pb-2">
        <CardTitle className="flex justify-start items-center gap-2">
          <PropertyAvatar property={property} />
          <div className="min-w-0">
            <Button
              variant="link"
              className="w-fit h-fit p-0 text-sm font-semibold whitespace-normal text-left"
              data-cy="openResourceButton"
            >
              {property.name}
              {atakLabel && (
                <span className="text-xs font-normal text-muted-foreground ml-1">
                  {atakLabel}
                </span>
              )}
            </Button>
            {property.description && (
              <div className="text-xs font-normal text-muted-foreground truncate">
                {property.description}
              </div>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-right space-y-1 pb-3">
        <div className="text-xs text-muted-foreground">
          {t('Rent excluding tax and expenses')}
        </div>
        <NumberFormat
          value={property.price}
          className="text-xl font-medium border py-1.5 px-3 rounded bg-card"
        />
      </CardContent>
      <CardFooter className="p-0 flex-col">
        <div className="flex items-center justify-between w-full py-3 px-6 border-t">
          <div className="text-xs text-muted-foreground">
            {property.status !== 'vacant'
              ? t('Occupied by {{tenant}}', {
                  tenant: property.occupantLabel
                })
              : null}
          </div>
          <Badge
            variant={property.status === 'vacant' ? 'success' : 'secondary'}
            className="text-xs font-normal"
          >
            {property.status === 'vacant' ? t('Vacant') : t('Rented')}
          </Badge>
        </div>
      </CardFooter>
    </Card>
  );
}
