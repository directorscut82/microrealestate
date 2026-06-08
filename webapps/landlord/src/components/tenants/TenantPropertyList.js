import { Button } from '../ui/button';
import { cn } from '../../utils';
import { LuAlertTriangle } from 'react-icons/lu';
import PropertyIcon from '../properties/PropertyIcon';

import useTranslation from 'next-translate/useTranslation';
function Address({ address }) {
  const { t } = useTranslation('common');
  if (!address?.street1) {
    return null;
  }

  return (
    <p className="text-xs text-muted-foreground leading-snug">
      {address.street1}
      <br />
      {address.street2 ? (
        <>
          {address.street2}
          <br />
        </>
      ) : null}
      {address.city} {address.zipCode}
      <br />
      {address.state && address.country
        ? `${address.state} ${address.country}`
        : address.country}
    </p>
  );
}

export default function TenantPropertyList({ tenant, className }) {
  const { t } = useTranslation('common');
  if (!tenant.properties?.length) {
    // T1.7: Surface a subtle amber warning in the address slot when the
    // tenant has no property assigned. Without a property+lease the rent
    // pipeline produces no rent records — the user needs to know they
    // must finish setup before billing kicks in. Mirror the amber palette
    // used by ChannelStatusBanners so the visual language is consistent.
    return (
      <div
        role="status"
        className={cn(
          'flex items-start gap-2 px-2.5 py-1.5 border rounded-md text-xs',
          'bg-amber-50 text-amber-700 border-amber-200',
          className
        )}
      >
        <LuAlertTriangle
          className="size-3.5 shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <span className="leading-snug">
          {t(
            'No property assigned — set a property/lease for rent billing to start'
          )}
        </span>
      </div>
    );
  }
  // Wave-26 round-3b: removed the outer bordered container. Multiple
  // properties are separated only by a subtle bottom-divider on each row
  // except the last, so the block reads as a flat list. Smaller icon, less
  // vertical padding to make the section feel tighter against the
  // contract/progress block above (which TenantListItem now spaces with
  // `mt-2` instead of `mt-6`).
  return (
    <div className={cn('flex flex-col', className)}>
      {tenant.properties.map(({ property }, idx) => (
        <div
          key={property._id}
          className={cn(
            'flex items-center gap-2 py-1.5',
            idx < tenant.properties.length - 1 && 'border-b border-stone-line/30'
          )}
        >
          {/* Icon kept as a Button so a future onClick is a one-line add.
              Smaller (size-7 with size-4 icon) for a more compact row. */}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 size-7 rounded-md text-muted-foreground"
          aria-label={t('Remove property')}
          >
            <PropertyIcon type={property.type} className="size-4" />
          </Button>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-sm font-medium truncate">{property.name}</p>
            {!!property.description && (
              <p className="text-[11px] text-muted-foreground truncate">
                {property.description}
              </p>
            )}
            <Address address={property.address} />
          </div>
        </div>
      ))}
    </div>
  );
}
