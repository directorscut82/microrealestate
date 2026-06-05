import * as Express from 'express';
import { Collections, logger, ServiceError } from '@microrealestate/common';
import {
  CollectionTypes,
  MongooseDocument,
  TenantAPI,
  UserServicePrincipal
} from '@microrealestate/types';
import moment from 'moment';

export async function getOneTenant(
  request: Express.Request,
  response: Express.Response
) {
  const req = request as TenantAPI.GetOneTenant.Request;
  const res = response as TenantAPI.GetOneTenant.Response;
  const email = (req.user as UserServicePrincipal).email;
  if (!email) {
    logger.error('missing email field');
    throw new ServiceError('unauthorized', 401);
  }
  const tenantId = req.params.tenantId;

  // Wave-24 A11: GET /tenantapi/tenant/me — resolve to the caller's tenant.
  // Without this, "me" was passed to Mongo as an ObjectId and threw 500.
  // Match by email contact alone; if multiple tenants share the contact
  // email (rare — same person renting from two landlords), return the
  // first match. The full list is also reachable via getAllTenants.
  const filter: Record<string, unknown> =
    tenantId === 'me'
      ? { 'contacts.email': { $eq: email.toLowerCase() } }
      : {
          _id: tenantId,
          'contacts.email': { $eq: email.toLowerCase() }
        };

  // Validate non-"me" id format up front to avoid CastError 500.
  if (tenantId !== 'me' && !/^[a-fA-F0-9]{24}$/.test(String(tenantId))) {
    throw new ServiceError('invalid tenant id', 422);
  }

  const dbTenant = await Collections.Tenant.findOne<
    MongooseDocument<CollectionTypes.Tenant>
  >(filter).populate<{
    realmId: CollectionTypes.Realm;
    leaseId: CollectionTypes.Lease;
  }>(['realmId', 'leaseId']);

  if (!dbTenant) {
    throw new ServiceError('tenant not found', 404);
  }

  const now = moment.utc();
  const lastTerm = Number(now.format('YYYYMMDDHH'));

  res.json({
    results: [_toTenantResponse(dbTenant, lastTerm)]
  });
}

export async function getAllTenants(
  request: Express.Request,
  response: Express.Response
) {
  const req = request as TenantAPI.GetAllTenants.Request;
  const res = response as TenantAPI.GetAllTenants.Response;
  const email = (req.user as UserServicePrincipal).email;
  if (!email) {
    logger.error('missing email field');
    throw new ServiceError('unauthorized', 401);
  }

  // find tenants from mongo which has a given email contact
  const dbTenants = await Collections.Tenant.find<
    MongooseDocument<CollectionTypes.Tenant>
  >({
    'contacts.email': { $eq: email.toLowerCase() }
  }).populate<{
    realmId: CollectionTypes.Realm;
    leaseId: CollectionTypes.Lease;
  }>(['realmId', 'leaseId']);

  // the last term considering the current date
  const lastTerm = Number(moment.utc().format('YYYYMMDDHH'));

  res.json({
    results: dbTenants.map((tenant) => _toTenantResponse(tenant, lastTerm))
  });
}

// Mongoose populate result type — `.populate(['realmId', 'leaseId'])` replaces
// the foreign-key string fields with the full documents at runtime.
type PopulatedTenant = Omit<CollectionTypes.Tenant, 'realmId' | 'leaseId'> & {
  realmId: CollectionTypes.Realm;
  leaseId: CollectionTypes.Lease;
};

// Wave-24 B16: legacy/seed rents may lack `.total`. Defensive shape so the
// tenant API doesn't 500 on a malformed historical rent.
const ZERO_TOTAL = {
  preTaxAmount: 0,
  charges: 0,
  vat: 0,
  balance: 0,
  grandTotal: 0,
  payment: 0
};
function _safeTotal(rent: { total?: any } | null | undefined) {
  return (rent?.total as any) ?? ZERO_TOTAL;
}

function _toTenantResponse(
  tenant: PopulatedTenant,
  lastTerm: number
): TenantAPI.TenantDataType {
  const now = moment.utc();
  const firstRent = tenant.rents?.[0];
  const firstTotal = _safeTotal(firstRent as any);
  const totalPreTaxAmount = firstTotal.preTaxAmount || 0;
  const totalChargesAmount = firstTotal.charges || 0;
  const totalVatAmount = firstTotal.vat || 0;
  const totalAmount = totalPreTaxAmount + totalChargesAmount + totalVatAmount;
  const { remainingIterations, remainingIterationsToPay } =
    _computeRemainingIterations(tenant, lastTerm, totalAmount);
  const landlord = tenant.realmId;
  const lease = tenant.leaseId;
  return {
    tenant: {
      id: tenant._id,
      name: tenant.name,
      contacts: tenant.contacts.map((contact) => ({
        name: contact.contact,
        email: contact.email,
        phone1: contact.phone
      })),
      addresses: [
        {
          street1: tenant.street1,
          street2: tenant.street2,
          zipCode: tenant.zipCode,
          city: tenant.city,
          state: '',
          country: ''
        }
      ]
    },
    landlord: {
      name: landlord.name,
      addresses: landlord.addresses,
      contacts: landlord.contacts,
      currency: landlord.currency,
      locale: landlord.locale
    },
    lease: {
      name: lease.name,
      beginDate: tenant.beginDate,
      endDate: tenant.endDate,
      terminationDate: tenant.terminationDate,
      timeRange: lease.timeRange,
      status: tenant.terminationDate
        ? 'terminated'
        : moment(tenant.endDate, 'YYYY-MM-DD').isBefore(now)
          ? 'ended'
          : 'active',
      rent: {
        totalPreTaxAmount,
        totalChargesAmount,
        totalVatAmount,
        totalAmount
      },
      remainingIterations,
      remainingIterationsToPay,
      properties:
        tenant.properties?.map((property) => ({
          id: property.property._id,
          name: property.property.name,
          description: property.property.description,
          type: property.property.type
        })) || [],
      invoices: tenant.rents
        ?.filter(({ term }) => term <= lastTerm)
        .sort((r1, r2) => r2.term - r1.term)
        .map((rent) => {
          const total = _safeTotal(rent as any);
          const payments = Array.isArray((rent as any).payments)
            ? (rent as any).payments
            : [];
          // E10: mirror the landlord-side frontdata.toRentData decision
          // tree so the same rent reads the same status from either API.
          // The wire enum stays 'paid' | 'partially-paid' | 'unpaid'
          // (the tenant frontend's locales / equality checks depend on
          // these literals) but the rule that decides which one to send
          // tracks frontdata: a direct payment that closes the deficit
          // is 'paid', a partial direct payment is 'partially-paid',
          // anything else is 'unpaid'. The previous rule
          // (`grandTotal - payment <= 0 → paid`) flagged carry-credit
          // months as paid even when no money had landed in that term.
          const _grandTotal = Number(total.grandTotal) || 0;
          const _payment = Number(total.payment) || 0;
          const _status: 'paid' | 'partially-paid' | 'unpaid' =
            _payment > 0 && _grandTotal - _payment <= 0.005
              ? 'paid'
              : _payment > 0
                ? 'partially-paid'
                : 'unpaid';
          return {
            id: `${tenant._id}-${rent.term}`,
            term: rent.term,
            balance: total.balance,
            grandTotal: total.grandTotal,
            payment: total.payment || 0,
            methods: payments
              .filter((payment: any) => !!payment)
              .map((payment: any) => payment.type),
            status: _status,
            payments:
              payments.map((payment: any) => ({
                date: payment.date,
                method: payment.type,
                reference: payment.reference,
                amount: payment.amount || 0
              })) || []
          };
        }),
      balance: _computeBalance(tenant.rents, lastTerm),
      deposit: tenant.guaranty - tenant.guarantyPayback
    }
  };
}

function _computeRemainingIterations(
  tenant: PopulatedTenant,
  lastTerm: number,
  rentAmount: number
) {
  const timeRange = tenant.leaseId.timeRange;
  const remainingIterations = Math.ceil(
    moment(tenant.terminationDate || tenant.endDate).diff(
      moment(lastTerm, 'YYYYMMDDHH').startOf(timeRange),
      timeRange,
      true
    )
  );

  let remainingIterationsToPay = remainingIterations;
  const balance = _computeBalance(tenant.rents, lastTerm);

  if (balance === 0) {
    remainingIterationsToPay -= 1;
  } else if (balance > 0) {
    const nbIterationWhereRentPaid = Math.abs(balance / rentAmount);
    remainingIterationsToPay -= Math.floor(nbIterationWhereRentPaid);
  }

  return {
    remainingIterations,
    remainingIterationsToPay
  };
}

function _computeBalance(rents: CollectionTypes.PartRent[], lastTerm: number) {
  if (!rents || rents.length === 0) {
    return 0;
  }
  // The rents array order from Mongo is not guaranteed; sort ascending by term
  // before scanning so the "closest to lastTerm" reducer is correct.
  const sorted = [...rents].sort((a, b) => a.term - b.term);
  const rent = sorted.reduce<CollectionTypes.PartRent | null>((prev, curr) => {
    if (curr.term <= lastTerm) {
      return curr;
    }
    return prev;
  }, null);

  if (!rent) {
    return 0;
  }
  // Wave-24 B16: defensive read.
  const total = _safeTotal(rent as any);
  return -total.grandTotal + (total.payment || 0);
}
