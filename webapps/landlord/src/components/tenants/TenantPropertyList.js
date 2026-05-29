import { Button } from '../ui/button';
import { cn } from '../../utils';
import PropertyIcon from '../properties/PropertyIcon';

function Address({ address }) {
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
  if (!tenant.properties?.length) {
    return null;
  }
  return (
    <div
      className={cn(
        'flex flex-col p-3 border rounded divide-y divide-stone-line/40',
        className
      )}
    >
      {tenant.properties.map(({ property }, idx) => (
        <div
          key={property._id}
          className={cn(
            'flex items-center gap-2.5',
            idx === 0 ? 'pb-2.5' : 'py-2.5',
            idx === tenant.properties.length - 1 && idx !== 0 && 'pb-0',
            tenant.properties.length === 1 && 'pb-0'
          )}
        >
          {/* Icon stays as a Button so a future onClick is a one-line add. */}
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 size-9 rounded-md"
          >
            <PropertyIcon type={property.type} className="size-5" />
          </Button>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-sm font-medium truncate">{property.name}</p>
            {!!property.description && (
              <p className="text-xs text-muted-foreground truncate">
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
