import * as Invoice from '../invoice/index.js';
import { Service } from '@microrealestate/common';
import moment from 'moment';

/**
 * Build the data envelope for a lease_expiry_notice email.
 *
 * Mirrors the rentcall pattern: re-uses Invoice.get() to fetch the
 * landlord/tenant/realm objects, then layers on the expiry-specific fields
 * (daysUntilExpiry, formatted endDate, deep link to landlord panel).
 *
 * The Invoice.get() path *requires* tenant.rents.length > 0 to succeed —
 * for tenants whose lease is ending but who have no rent rows we fall back
 * to a direct Tenant lookup so the email still goes out. We mirror just
 * enough of the Invoice envelope to satisfy the EJS templates and the
 * recipients/lease_expiry_notice resolver.
 */
export async function get(tenantId: string, params: Record<string, any>) {
  const daysUntilExpiry = computeDaysUntil(params);
  const baseUrl = resolveLandlordBaseUrl();

  const envelope = await fetchEnvelope(tenantId, params);
  const tenant = envelope.tenant;
  const landlord = envelope.landlord;

  const property = pickPrimaryProperty(tenant);
  const endDateFormatted = tenant?.contract?.endDate
    ? moment.utc(tenant.contract.endDate).format('DD/MM/YYYY')
    : tenant?.endDate
      ? moment.utc(tenant.endDate).format('DD/MM/YYYY')
      : '';

  const landlordPanelUrl =
    `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(
      String(landlord?._id || '')
    )}/tenants/${encodeURIComponent(String(tenantId))}` +
    '?action=renew';

  return {
    landlord,
    tenant,
    property,
    daysUntilExpiry,
    endDateFormatted,
    landlordPanelUrl,
    today: moment().format('DD/MM/YYYY')
  };
}

function computeDaysUntil(params: Record<string, any>): number {
  if (
    typeof params?.daysUntilExpiry === 'number' &&
    Number.isFinite(params.daysUntilExpiry)
  ) {
    return params.daysUntilExpiry;
  }
  if (params?.endDate) {
    const target = moment.utc(params.endDate);
    if (target.isValid()) {
      return target.startOf('day').diff(moment.utc().startOf('day'), 'days');
    }
  }
  return 0;
}

function resolveLandlordBaseUrl(): string {
  // APP_URL / APP_DOMAIN are set per-deployment; keep a sane default that
  // points at the dev server so links don't render as "undefined/...".
  const env = Service.getInstance().envConfig.getValues() as Record<
    string,
    any
  >;
  return (
    env.LANDLORD_APP_URL ||
    env.APP_URL ||
    (env.APP_DOMAIN ? `${env.APP_PROTOCOL || 'https'}://${env.APP_DOMAIN}/landlord` : '') ||
    'http://localhost:8080/landlord'
  );
}

function pickPrimaryProperty(tenant: any): {
  name: string;
  address: string;
} | null {
  const first = tenant?.contract?.properties?.[0];
  if (!first) return null;
  const name = first.name || first.description || '';
  const address = [
    first.address?.street1,
    first.address?.street2,
    first.address?.zipCode,
    first.address?.city
  ]
    .filter(Boolean)
    .join(', ');
  return { name, address };
}

async function fetchEnvelope(
  tenantId: string,
  params: Record<string, any>
): Promise<any> {
  try {
    return await Invoice.get(tenantId, params);
  } catch (err) {
    // Fallback path — Invoice.get throws when there are no rent rows. Read
    // the tenant directly and stitch a minimal envelope that satisfies the
    // EJS templates + recipient resolver.
    const { Collections } = await import('@microrealestate/common');
    const filter: Record<string, any> = { _id: tenantId };
    if (params?.realmId) filter.realmId = params.realmId;
    const dbTenant = await (Collections as any).Tenant.findOne(filter)
      .populate('realmId')
      .populate('properties.propertyId');
    if (!dbTenant) {
      throw err;
    }
    const tenant: any = dbTenant.toObject();
    const landlord = tenant.realmId;
    if (landlord) {
      landlord.name =
        (landlord.isCompany
          ? landlord.companyInfo?.name
          : landlord.contacts?.[0]?.name) || '';
    }
    delete tenant.realmId;
    tenant.contract = {
      name: tenant.contract,
      lease: tenant.leaseId,
      beginDate: tenant.beginDate,
      endDate: tenant.endDate,
      properties: (tenant.properties || []).reduce(
        (acc: any[], { propertyId }: { propertyId: any }) => {
          if (propertyId) acc.push(propertyId);
          return acc;
        },
        []
      )
    };
    return { landlord, tenant };
  }
}
