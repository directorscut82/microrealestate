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

  // Wave-26 round-3u: pull the building doc(s) for the tenant's properties
  // so the receipt header can prefer the building.manager (διαχειριστής)
  // over the realm (ιδιοκτήτης) when present. The Property schema carries
  // buildingId, but populate() didn't reach into Building. Fetch separately.
  const propertyBuildingIds = (dbTenant.properties || [])
    .map((p) => p?.propertyId?.buildingId)
    .filter(Boolean)
    .map((id) => String(id));
  let firstBuilding = null;
  if (propertyBuildingIds.length) {
    try {
      firstBuilding = await Collections.Building.findOne({
        _id: propertyBuildingIds[0]
      }).lean();
    } catch (error) {
      logger.error(error);
    }
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
        total: (() => {
          // Wave-26 round-3u: receipts (απόδειξη είσπραξης) exclude
          // rent.charges (Δαπάνες επί του ενοικίου). Those are surcharges
          // the tenant pays to a third party — not amounts the landlord
          // collects on this receipt. The on-screen Πρόγραμμα tile keeps
          // them, but the PDF body and totals must drop them.
          const buildingChargesSum = (rent.buildingCharges || []).reduce(
            (s, c) => s + (Number(c.amount) || 0),
            0
          );
          const subTotal =
            (rent.total.preTaxAmount || 0) +
            buildingChargesSum -
            (rent.total.discount || 0) +
            (rent.total.debts || 0);
          const invoiceGrandTotal =
            Math.round((subTotal + (rent.total.balance || 0)) * 100) / 100;
          return {
            ...rent.total,
            payment: rent.total.payment || 0,
            subTotal: Math.round(subTotal * 100) / 100,
            invoiceGrandTotal,
            newBalance: invoiceGrandTotal - (rent.total.payment || 0)
          };
        })(),
        // Property address line for the customer-reference table
        // (Διεύθυνση μισθίου). First property only — multi-property
        // tenants get the first one rendered; the table is a single row.
        propertyAddress: (() => {
          const addr = dbTenant.properties?.[0]?.propertyId?.address;
          if (!addr) return '';
          return [addr.street1, addr.zipCode, addr.city]
            .filter(Boolean)
            .join(', ');
        })()
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
    // Wave-26 round-3u: expose tenant.contacts so the receipt's tenant
     // block can render phone1/phone2/email under the ΑΦΜ line.
    contacts: dbTenant.contacts || [],
    addresses: [
      {
        street1: dbTenant.street1,
        street2: dbTenant.street2,
        city: dbTenant.city,
        state: dbTenant.state,
        country: dbTenant.country,
        zipCode: dbTenant.zipCode || ''
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

  // Wave-26 round-3u: documentActor — the issuer rendered in the receipt's
  // header + footer. Priority: building.manager (διαχειριστής) when ANY of
  // its fields is present; else the realm (ιδιοκτήτης). Empty fields stay
  // empty — there is no implicit fallback to admin user info.
  const buildDocumentActor = () => {
    const m = firstBuilding?.manager;
    if (m && (m.name || m.taxId || m.phone || m.email || m.company)) {
      return {
        role: 'manager',
        name: m.name || m.company || '',
        taxId: m.taxId || '',
        phone: m.phone || '',
        email: m.email || '',
        address: null
      };
    }
    return {
      role: 'owner',
      name: landlord.name,
      taxId: landlord.companyInfo?.vatNumber || '',
      phone: landlord.contacts?.[0]?.phone1 || '',
      email: landlord.contacts?.[0]?.email || '',
      address: landlord.addresses?.[0] || null
    };
  };

  return {
    fileName,
    tenant,
    landlord,
    documentActor: buildDocumentActor()
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
