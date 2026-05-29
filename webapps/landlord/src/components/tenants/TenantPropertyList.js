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
    <div className={cn('flex flex-col gap-3 p-4 border rounded', className)}>
      {tenant.properties.map(({ property }) => (
        <div key={property._id} className="flex items-start gap-3">
          {/* Icon stays as a Button so a future onClick is a one-line add. */}
          <Button variant="outline" size="icon" className="shrink-0">
            <PropertyIcon type={property.type} className="size-8" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-tight truncate">
              {property.name}
            </p>
            {!!property.description && (
              <p className="text-xs text-muted-foreground leading-snug mt-0.5">
                {property.description}
              </p>
            )}
            <div className="mt-1">
              <Address address={property.address} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
