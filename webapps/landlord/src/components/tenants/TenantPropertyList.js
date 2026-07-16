import { Button } from '../ui/button';
import { cn } from '../../utils';
import { LuAlertTriangle } from 'react-icons/lu';
import PropertyIcon from '../properties/PropertyIcon';

import useTranslation from 'next-translate/useTranslation';
// Map a raw ISO-3166 country code to a localized name so the address doesn't
// leak 'GR' into Greek UI ('ΑΘΗΝΑ GR'). Unknown codes pass through unchanged.
const _COUNTRY_NAMES = {
  GR: 'Ελλάδα',
  CY: 'Κύπρος'
};
function _countryName(c) {
  if (!c) return '';
  return _COUNTRY_NAMES[String(c).trim().toUpperCase()] || c;
}

function Address({ address }) {
  if (!address?.street1) {
    return null;
  }

  const country = _countryName(address.country);
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
      {address.state && country ? `${address.state} ${country}` : country}
    </p>
  );
}

function BillingWarning({ messages, className }) {
  if (!messages.length) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 px-2.5 py-1.5 border rounded-md text-xs',
        'bg-oxide-tint text-oxide border-oxide/40',
        className
      )}
    >
      <LuAlertTriangle
        className="size-3.5 shrink-0 mt-0.5"
        aria-hidden="true"
      />
      <span className="leading-snug">{messages.join(' · ')}</span>
    </div>
  );
}

export default function TenantPropertyList({ tenant, className }) {
  const { t } = useTranslation('common');

  const warnings = [];
  if (!tenant.properties?.length) {
    warnings.push(t('No property assigned'));
  }
  if (!tenant.leaseId && !tenant.lease) {
    warnings.push(t('No lease assigned'));
  }
  if (!tenant.beginDate) {
    warnings.push(t('Missing lease start date'));
  }
  if (!tenant.endDate) {
    warnings.push(t('Missing lease end date'));
  }
  if (tenant.properties?.length) {
    const noRent = tenant.properties.filter((p) => !p.rent && p.rent !== undefined);
    if (noRent.length) {
      warnings.push(t('Rent is 0 € — billing will not start'));
    }
    const noDates = tenant.properties.filter((p) => !p.entryDate || !p.exitDate);
    if (noDates.length) {
      warnings.push(t('Missing property entry/exit date'));
    }
  }

  if (!tenant.properties?.length) {
    return <BillingWarning messages={warnings} className={className} />;
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {warnings.length > 0 && (
        <BillingWarning messages={warnings} className="mb-1.5" />
      )}
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
