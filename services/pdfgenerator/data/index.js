import { Collections, logger } from '@microrealestate/common';
import moment from 'moment';

export async function getRentsData(params) {
  const { id: tenantId, term, realmId } = params;

  // Realm-scope the query: callers MUST supply the realmId of the requester
  // so a session in one organization can never read a tenant from another.
  // We accept calls without realmId only for backward compat with callers
  // that have not been updated yet, but log loudly so missing call sites
  // surface in production logs.
  const filter = { _id: tenantId };
  if (realmId) {
    filter.realmId = realmId;
  } else {
    logger.warn(
      `getRentsData called without realmId for tenant ${tenantId} — cross-tenant access not enforced`
    );
  }

  let dbTenant;
  try {
    dbTenant = await Collections.Tenant.findOne(filter)
      .populate('realmId')
      .populate('leaseId')
      .populate('properties.propertyId');
  } catch (error) {
    logger.error(error);
  }
  if (!dbTenant) {
    throw new Error(`tenant ${tenantId} not found`);
  }

  const landlord = dbTenant.realmId;
  landlord.name =
    (landlord.isCompany
      ? landlord.companyInfo?.name
      : landlord.contacts?.[0]?.name) || '';
  landlord.hasCompanyInfo = !!landlord.companyInfo;
  landlord.hasBankInfo = !!landlord.bankInfo;
  landlord.hasAddress = !!landlord.addresses?.length;
  landlord.hasContact = !!landlord.contacts?.length;

  let rents = [];
  if (dbTenant.rents.length) {
    rents = dbTenant.rents
      .filter((rent) => String(rent.term).startsWith(term))
      .map((rent) => ({
        ...rent,
        period: rent.term,
        billingReference: `${moment(rent.term, 'YYYYMMDDHH').format('MM_YY_')}${
          dbTenant.reference
        }`,
        total: {
          ...rent.total,
          payment: rent.total.payment || 0,
          // subTotal must include EVERY pre-VAT line, including
          // buildingCharges (κοινόχρηστα). Was previously omitted; the
          // PDF's "subTotal" then disagreed with the visible grandTotal
          // by the buildingCharges amount, confusing tenants who tried
          // to verify the math themselves.
          subTotal:
            rent.total.preTaxAmount +
            rent.total.charges +
            (rent.buildingCharges || []).reduce(
              (s, c) => s + (Number(c.amount) || 0),
              0
            ) -
            rent.total.discount +
            rent.total.debts,
          newBalance: rent.total.grandTotal - rent.total.payment
        }
      }));
  }

  const tenant = {
    name: dbTenant.isCompany ? dbTenant.company : dbTenant.name,
    isCompany: dbTenant.isCompany,
    companyInfo: {
      name: dbTenant.company,
      capital: dbTenant.capital,
      ein: dbTenant.siret,
      dos: dbTenant.rcs,
      // Tenant schema stores the VAT/tax id as `taxId`. Reading
      // `vatNumber` here always returned undefined and the PDF rendered
      // a blank where the company's ΑΦΜ should appear.
      vatNumber: dbTenant.taxId,
      legalRepresentative: dbTenant.manager
    },
    addresses: [
      {
        street1: dbTenant.street1,
        street2: dbTenant.street2,
        city: dbTenant.city,
        state: dbTenant.state,
        country: dbTenant.country
      }
    ],
    contract: {
      name: dbTenant.contract,
      lease: dbTenant.leaseId,
      beginDate: dbTenant.beginDate,
      endDate: dbTenant.endDate,
      properties: dbTenant.properties.reduce((acc, { propertyId }) => {
        acc.push(propertyId);
        return acc;
      }, [])
    },
    rents
  };
  if (dbTenant.terminationDate) {
    tenant.contract.terminationDate = dbTenant.terminationDate;
  }

  // Sanitize fileName before it becomes a filesystem path. dbTenant.name
  // is user-controlled and previously flowed straight into file IO,
  // which crashed on names containing `/`, `..`, or quotes — and worse,
  // could escape the output directory. Allow ASCII alphanum, dot,
  // dash, underscore plus the Greek code blocks to keep Greek tenant
  // names intact. Same shape as the emailer attachments sanitize().
  const sanitize = (s) =>
    String(s || 'tenant')
      .replace(/[^A-Za-z0-9._\-Ͱ-Ͽἀ-῿]/g, '_')
      .slice(0, 100);
  const fileName = `${sanitize(dbTenant.name)}-${term}`;

  return {
    fileName,
    tenant,
    landlord
  };
}

export function avoidWeekend(aMoment) {
  const day = aMoment.isoWeekday();
  if (day === 6) {
    // if saturday shift the due date to friday
    aMoment.subtract(1, 'days');
  } else if (day === 7) {
    // if sunday shift the due date to friday
    aMoment.subtract(2, 'days');
  }
  return aMoment;
}
