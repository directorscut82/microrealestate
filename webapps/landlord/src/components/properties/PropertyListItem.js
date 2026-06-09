import { useCallback } from 'react';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../utils';
import NumberFormat from '../../components/NumberFormat';
import PropertyAvatar from './PropertyAvatar';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

/*
 * PropertyListItem — DESIGN.md card consumer.
 *
 * Bone surface, hairline border, no colored side-stripe, no boxed price.
 * Property name in ink (NOT sea — sea reserved for genuine link affordances).
 * Status pill in the bottom-right consistently. Hover lifts to cream tonally,
 * no shadow.
 */
export default function PropertyListItem({ property }) {
  const router = useRouter();
  const { t } = useTranslation('common');

  const onClick = useCallback(async () => {
    await router.push(
      `/${router.query.organization}/properties/${property._id}`
    );
  }, [router, property]);

  const isVacant = property.status === 'vacant';

  return (
    <button
      type="button"
      onClick={onClick}
      data-cy="openResourceButton"
      className={cn(
        'group flex flex-col w-full rounded-lg border border-stone-line bg-bone',
        'text-left transition-colors duration-base ease-out-quart',
        'hover:bg-cream',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sea focus-visible:ring-offset-2 focus-visible:ring-offset-cream'
      )}
    >
      <div className="flex items-start gap-3 px-5 pt-4 pb-3">
        <PropertyAvatar property={property} />
        <div className="min-w-0 flex-1">
          <div className="text-title font-medium text-ink truncate">
            {property.name}
          </div>
          {property.description && (
            <div className="text-label text-ink-muted truncate mt-0.5">
              {property.description}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-3 px-5 py-3 border-t border-stone-line">
        <div className="text-label text-ink-muted truncate">
          {t('Rent excluding tax and expenses')}
        </div>
        <NumberFormat
          value={property.price}
          className="text-body text-ink shrink-0"
        />
      </div>

      <div className="flex items-center justify-between gap-3 px-5 py-2 border-t border-stone-line">
        <div className="text-label text-ink-muted truncate">
          {!isVacant && property.occupantLabel
            ? t('Occupied by {{tenant}}', { tenant: property.occupantLabel })
            : null}
        </div>
        <Badge
          variant={isVacant ? 'success' : 'secondary'}
          className="shrink-0 px-2 py-0 text-[11px] leading-none font-normal"
        >
          {isVacant ? t('Vacant') : t('Rented')}
        </Badge>
      </div>
    </button>
  );
}
