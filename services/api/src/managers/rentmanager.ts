import * as Contract from './contract.js';
import * as FD from './frontdata.js';
import { _attachTenantGroupsToBuildings } from './occupantmanager.js';
import {
  Collections,
  logger,
  Service,
  ServiceError
} from '@microrealestate/common';
import type { ReqNoParams, ReqWithId, ReqWithIdTerm, ReqWithYearMonth, Res } from '../types/requests.js';
import axios from 'axios';
import moment from 'moment';
import type { CollectionTypes } from '@microrealestate/types';
import {
  validateObjectId,
  validateFiniteNumber,
  validateArrayMaxLength,
  validateDateString,
  validateTerm,
  validateEnum,
  validateStringLength
} from '../validators.js';

// Wave-24 B6: payment.type accepted any string (e.g. "BITCOIN"). Restrict to
// the canonical set the UI offers.
const PAYMENT_TYPES = ['cash', 'transfer', 'levy', 'cheque', ''] as const;

// Wave-25: payment-by-category allocation. Categories map to the rent
// breakdown the landlord sees in the UI (Ενοίκιο / Κοινόχρηστα / etc.).
// `payment.allocation` is optional — when omitted, the server treats the
// payment as auto-spread (today's behavior). When present, sum(allocation
// amounts) must equal payment.amount; categories must be in this set.
const PAYMENT_CATEGORIES = [
  'rent',
  'expenses',
  'repairs',
  'vat',
  'previousBalance',
  'extracharge'
] as const;

// Wave-26 round-3r: auto-spread fills oldest debt classes first so the
// landlord's mental model matches the rent computation pipeline. Order
// kept in sync with AUTO_SPREAD_ORDER in webapps/landlord/src/utils/
// paymentAllocation.js.
const AUTO_SPREAD_ORDER = [
  'previousBalance',
  'rent',
  'expenses',
  'repairs',
  'vat',
  'extracharge'
] as const;

type AnyRecord = Record<string, any>;

const _round = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Wave-26 round-3r: compute the per-category split for a payment when the
 * caller didn't pass an explicit allocation. Same oldest-debt-first rule
 * the frontend uses (paymentAllocation.autoSpreadAllocation).
 *
 * `owed` shape: { rent, expenses, repairs, vat, previousBalance, extracharge }.
 * Returns an array of { category, amount } entries with non-zero amounts.
 * Caller must persist this on payment.allocation so every payment on
 * disk has explicit attribution.
 */
function _computeAutoSpread(
  amount: number,
  owed: AnyRecord
): { category: string; amount: number }[] {
  let remaining = _round(amount);
  const out: { category: string; amount: number }[] = [];
  for (const cat of AUTO_SPREAD_ORDER) {
    if (remaining <= 0) break;
    const due = Number(owed?.[cat]) || 0;
    if (due <= 0) continue;
    const apply = _round(Math.min(remaining, due));
    if (apply > 0) {
      out.push({ category: cat, amount: apply });
      remaining = _round(remaining - apply);
    }
  }
  return out;
}

/**
 * Per-category owed amounts for a single rent. Mirrors the frontend's
 * computeCategoryOwed in paymentAllocation.js, except we compute it over
 * the RAW persisted rent (services-side rent.* shape) rather than the
 * frontdata-flattened shape. Used by:
 *   - PATCH /rents/payment auto-spread on save
 *   - Migration script for legacy payments
 */
function _computeOwedByCategory(rent: AnyRecord): AnyRecord {
  const sumAmounts = (arr: any) =>
    Array.isArray(arr)
      ? arr.reduce(
          (s: number, x: AnyRecord) => s + (Number(x?.amount) || 0),
          0
        )
      : 0;
  const buildingChargesAll = Array.isArray(rent?.buildingCharges)
    ? rent.buildingCharges
    : [];
  const repairCharges = buildingChargesAll
    .filter((c: AnyRecord) => c?.type === 'repair')
    .reduce((s: number, c: AnyRecord) => s + (Number(c.amount) || 0), 0);
  const expenseBuildingCharges = buildingChargesAll
    .filter((c: AnyRecord) => c?.type !== 'repair')
    .reduce((s: number, c: AnyRecord) => s + (Number(c.amount) || 0), 0);
  return {
    rent: _round(Number(rent?.total?.preTaxAmount) || 0),
    expenses: _round(sumAmounts(rent?.charges) + expenseBuildingCharges),
    repairs: _round(repairCharges),
    vat: _round(Number(rent?.total?.vat) || sumAmounts(rent?.vats)),
    previousBalance: _round(
      Math.max(0, Number(rent?.total?.balance) || 0)
    ),
    extracharge: _round(sumAmounts(rent?.debts))
  };
}

async function _findOccupants(
  realm: CollectionTypes.Realm | null | undefined,
  tenantId?: string | null,
  startTerm?: number,
  endTerm?: number
): Promise<AnyRecord[]> {
  const filter: AnyRecord = {
    $query: {
      $and: [{ realmId: realm!._id }]
    }
  };
  if (tenantId) {
    filter['$query']['$and'].push({ _id: tenantId });
  }
  if (startTerm && endTerm) {
    filter['$query']['$and'].push({ 'rents.term': { $gte: startTerm } });
    filter['$query']['$and'].push({ 'rents.term': { $lte: endTerm } });
  } else if (startTerm) {
    filter['$query']['$and'].push({ 'rents.term': startTerm });
  }

  const dbTenants: AnyRecord[] = await Collections.Tenant.find(filter.$query)
    .sort({
      name: 1
    })
    .lean();

  return dbTenants.map((tenant) => {
    tenant._id = String(tenant._id);
    // Wave-26 round-3e: stash the FULL rent ledger on _allRents BEFORE
    // we filter `tenant.rents` by date range. The carry-forward status
    // resolver in frontdata.toRentData walks `allRents` to detect
    // whether a partial-paid month is later closed by a catch-up
    // overpayment; if we hand it just the filtered slice (e.g. one
    // month for /rents/{year}/{month}), the running deficit calculation
    // sees only that month's bill and spuriously concludes the rent is
    // settled — flipping a partiallypaid row to "paid" in the UI.
    tenant._allRents = tenant.rents;
    if (startTerm && endTerm) {
      tenant.rents = tenant.rents.filter(
        (rent: AnyRecord) => rent.term >= startTerm && rent.term <= endTerm
      );
    } else if (startTerm) {
      tenant.rents = tenant.rents.filter(
        (rent: AnyRecord) => rent.term === startTerm
      );
    }
    return tenant;
  });
}

async function _getEmailStatus(
  authorizationHeader: string | undefined,
  locale: string | undefined,
  realm: CollectionTypes.Realm | null | undefined,
  startTerm: number,
  endTerm?: number
): Promise<AnyRecord> {
  const { DEMO_MODE, EMAILER_URL } =
    Service.getInstance().envConfig.getValues();
  try {
    let emailEndPoint = `${EMAILER_URL}/status/${startTerm}`;
    if (endTerm) {
      emailEndPoint = `${EMAILER_URL}/status/${startTerm}/${endTerm}`;
    }
    const response = await axios.get(emailEndPoint, {
      headers: {
        authorization: authorizationHeader,
        organizationid: String(realm!._id),
        'Accept-Language': locale
      }
    });
    logger.debug(response.data);
    return response.data.reduce((acc: AnyRecord, status: AnyRecord) => {
      const data = {
        sentTo: status.sentTo,
        sentDate: status.sentDate
      };
      if (!acc[status.recordId]) {
        acc[status.recordId] = { [status.templateName]: [] };
      }
      let documents = acc[status.recordId][status.templateName];
      if (!documents) {
        documents = [];
        acc[status.recordId][status.templateName] = documents;
      }
      documents.push(data);
      return acc;
    }, {});
  } catch (error: any) {
    logger.error(`Failed to get email status: ${error.message || error}`);
    if (DEMO_MODE) {
      logger.info('email status fallback workflow activated in demo mode');
      return {};
    } else {
      throw new ServiceError(
        error.response?.data?.message || 'Failed to fetch email status',
        error.response?.status || 500
      );
    }
  }
}

async function _getRentsDataByTerm(
  authorizationHeader: string | undefined,
  locale: string | undefined,
  realm: CollectionTypes.Realm | null | undefined,
  currentDate: moment.Moment,
  frequency: moment.unitOfTime.StartOf
): Promise<AnyRecord> {
  const startTerm = Number(currentDate.startOf(frequency).format('YYYYMMDDHH'));
  const endTerm = Number(currentDate.endOf(frequency).format('YYYYMMDDHH'));

  const [dbOccupants, emailStatus = {}] = await Promise.all([
    _findOccupants(realm, null, startTerm, endTerm),
    _getEmailStatus(
      authorizationHeader,
      locale,
      realm,
      startTerm,
      endTerm
    ).catch((e) => logger.error(String(e)))
  ]);

  const rents = (dbOccupants as AnyRecord[]).reduce(
    (acc: AnyRecord[], occupant: AnyRecord) => {
      // Wave-17 B3: pass the full ledger so a past partiallypaid rent gets
      // promoted to 'paid' on the dashboard once a later overpayment has
      // cleared the running deficit.
      const allRents = occupant._allRents || occupant.rents;
      // Wave-26: build a lightweight per-rent priorRents summary so the
      // /rents UI's "Previous balance" tooltip can show a per-month
      // breakdown of where the carry-in came from. Only includes terms
      // that have a non-zero new-balance (i.e. months that actually
      // contributed to the carry-in), capped at 24 months back so the
      // payload doesn't bloat for long-running tenants.
      const priorRentsByTerm: Record<string, AnyRecord[]> = {};
      for (const rent of occupant.rents) {
        const t = Number(rent.term);
        if (t < startTerm || t > endTerm) continue;
        const priors = (allRents as AnyRecord[])
          .filter((r) => Number(r.term) < t)
          .slice(-24)
          .map((r) => {
            const grandTotal = Number(r.total?.grandTotal) || 0;
            const paid = Number(r.total?.payment) || 0;
            return {
              term: r.term,
              newBalance: paid - grandTotal
            };
          })
          // Drop fully-settled months so the tooltip only shows the rents
          // that actually contributed to the carry-in.
          .filter((r) => Math.abs(r.newBalance) >= 0.005);
        priorRentsByTerm[String(rent.term)] = priors;
      }
      acc.push(
        ...occupant.rents
          .filter(
            (rent: AnyRecord) => rent.term >= startTerm && rent.term <= endTerm
          )
          .map((rent: AnyRecord) => {
            const enriched = FD.toRentData(
              rent,
              occupant,
              (emailStatus as AnyRecord)?.[occupant._id],
              allRents
            );
            enriched.priorRents = priorRentsByTerm[String(rent.term)] || [];
            return enriched;
          })
      );
      return acc;
    },
    []
  );

  const overview: AnyRecord = {
    countAll: 0,
    countPaid: 0,
    countPartiallyPaid: 0,
    countNotPaid: 0,
    totalToPay: 0,
    totalPaid: 0,
    totalNotPaid: 0,
    // Wave-26 round-3r: sum of carry-in arrears across all tenants for
    // this month, surfaced on the /rents KPI tile as
    // "Οφειλές (προηγ. οφειλές: XXX)". Reads frontdata's `rent.balance`
    // (which is positive when tenant is in credit, negative when in
    // arrears coming into this month).
    totalCarriedBalance: 0
  };
  // Wave-26 round-3o: trust the per-rent status that frontdata.toRentData
  // computes. The previous classifier `totalAmount <= 0 || newBalance >= 0
  // → paid` desynced from the row UI's status (set in frontdata.ts:217-247),
  // because that one accounts for carry-forward retroactive settlement and
  // direct-pay coverage, but the overview's raw-field heuristic does not.
  // Result on past months: a partially-paid row would render with a yellow
  // status dot but the header KPI counted them as 'paid' (and partial flag
  // hid because countPartiallyPaid was 0). Now both surfaces share one
  // source of truth.
  rents.reduce((acc: AnyRecord, rent: AnyRecord) => {
    if (rent.status === 'paid') {
      acc.countPaid++;
    } else if (rent.status === 'partiallypaid') {
      acc.countPartiallyPaid++;
    } else {
      acc.countNotPaid++;
    }
    acc.countAll++;
    acc.totalToPay += rent.totalToPay;
    acc.totalPaid += rent.payment;
    acc.totalNotPaid -= rent.newBalance < 0 ? rent.newBalance : 0;
    // Wave-26 round-3s: carry-in arrears. Convention in this codebase
    // is `rent.balance > 0` means tenant owes from prior months
    // (carry-in debt). Round-3r had this inverted as `< 0` which is
    // why the KPI parens never rendered.
    if (rent.balance > 0) {
      acc.totalCarriedBalance += rent.balance;
    }
    return acc;
  }, overview);

  return { overview, rents };
}

/**
 * Wave-26 round-3r: bulk "express εξόφληση" endpoint. Records ONE
 * transfer payment per tenant for whatever combination of monthly +
 * previousBalance the caller wants paid, all dated today.
 *
 * Body shape:
 *   {
 *     items: [
 *       { tenantId, term, monthly?: boolean, previousBalance?: boolean }
 *     ]
 *   }
 *
 * Server resolves each item against the live rent doc (so the caller
 * can't pass an arbitrary amount). Validation is per-item — invalid
 * items abort the whole batch (no partial writes). All writes go
 * through _updateByTerm which already runs Contract.payTerm atomically.
 *
 * Performance: the `items` array is typically <= 30 (one per tenant).
 * We sequentialise per-item to keep the rent computation pipeline's
 * per-tenant idempotency intact; parallel writes against the same
 * tenant could clobber each other.
 */
export async function bulkExpressPayment(req: ReqNoParams, res: Res) {
  const realm = req.realm;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'] as string | undefined;
  const body = (req.body || {}) as AnyRecord;
  const items = Array.isArray(body.items) ? body.items : [];

  if (items.length === 0) {
    throw new ServiceError('items required', 422);
  }
  if (items.length > 50) {
    throw new ServiceError('items count exceeds 50', 422);
  }

  // Validate every item up-front so a bad row aborts the batch before
  // any write happens.
  items.forEach((it: AnyRecord, idx: number) => {
    validateObjectId(it?.tenantId, `items[${idx}].tenantId`);
    validateTerm(String(it?.term || ''), `items[${idx}].term`);
    if (
      typeof it?.monthly !== 'boolean' &&
      typeof it?.previousBalance !== 'boolean'
    ) {
      throw new ServiceError(
        `items[${idx}] must request monthly or previousBalance`,
        422
      );
    }
    if (it?.monthly === false && it?.previousBalance === false) {
      throw new ServiceError(
        `items[${idx}] selects nothing to pay`,
        422
      );
    }
  });

  const todayDDMMYYYY = moment.utc().format('DD/MM/YYYY');

  // Wave-26 round-3r perf: prefetch all tenants in ONE query instead
  // of N round-trips inside the loop. For 30-tenant batches this turns
  // ~30 × RTT into 1 × RTT.
  const tenantIds = items.map((it: AnyRecord) => String(it.tenantId));
  const tenants = (await Collections.Tenant.find({
    _id: { $in: tenantIds },
    realmId: realm!._id
  }).lean()) as AnyRecord[];
  const tenantById = new Map(tenants.map((t) => [String(t._id), t]));

  // Build paymentData payloads first (sync, no I/O) — surfaces missing-
  // tenant errors before any write. After validation succeeds for all
  // items we fan out the writes in parallel via Promise.all; each
  // _updateByTerm operates on a different tenant doc so there is no
  // cross-tenant contention.
  const writePlans: Array<{
    tenantId: string;
    term: string;
    amount: number;
    paymentData: AnyRecord;
  } | null> = items.map((it: AnyRecord, idx: number) => {
    const tenantId = String(it.tenantId);
    const term = String(it.term);

    const tenant = tenantById.get(tenantId);
    if (!tenant) {
      throw new ServiceError(`items[${idx}] tenant not found`, 404);
    }

    const targetRent = (tenant.rents || []).find(
      (r: AnyRecord) => Number(r.term) === Number(term)
    );
    if (!targetRent) {
      throw new ServiceError(
        `items[${idx}] rent for term not found`,
        404
      );
    }

    const owed = _computeOwedByCategory(targetRent);
    const monthlyOwed = _round(
      owed.rent + owed.expenses + owed.repairs + owed.vat + owed.extracharge
    );
    const previousOwed = _round(owed.previousBalance);
    let amount = 0;
    const allocation: { category: string; amount: number }[] = [];

    if (it.monthly === true && monthlyOwed > 0) {
      amount = _round(amount + monthlyOwed);
      const monthOnlyOwed: AnyRecord = {
        previousBalance: 0,
        rent: owed.rent,
        expenses: owed.expenses,
        repairs: owed.repairs,
        vat: owed.vat,
        extracharge: owed.extracharge
      };
      allocation.push(..._computeAutoSpread(monthlyOwed, monthOnlyOwed));
    }
    if (it.previousBalance === true && previousOwed > 0) {
      amount = _round(amount + previousOwed);
      allocation.push({
        category: 'previousBalance',
        amount: previousOwed
      });
    }

    if (amount <= 0) {
      // Nothing actually owed for the requested categories — skip
      // silently so a partially-owed batch doesn't fail because one
      // tenant is already paid.
      return null;
    }

    const paymentData: AnyRecord = {
      _id: tenantId,
      month: Number(term.slice(4, 6)),
      year: Number(term.slice(0, 4)),
      payments: [
        {
          amount,
          date: todayDDMMYYYY,
          type: 'transfer',
          reference: '',
          allocation
        }
      ],
      promo: 0,
      extracharge: 0
    };

    return { tenantId, term, amount, paymentData };
  });

  const live = writePlans.filter(
    (p): p is NonNullable<typeof p> => p != null
  );
  // Parallel writes: each _updateByTerm targets a different tenant
  // document so there is no contention. Errors from any one item
  // reject the whole batch (Promise.all propagation) — preserves
  // round-3r's "no partial writes" guarantee.
  await Promise.all(
    live.map((p) =>
      _updateByTerm(authorizationHeader, locale, realm, p.term, p.paymentData)
    )
  );

  res.json({
    results: writePlans.map((p, idx) =>
      p == null
        ? {
            tenantId: String(items[idx].tenantId),
            term: String(items[idx].term),
            skipped: true
          }
        : {
            tenantId: p.tenantId,
            term: p.term,
            amount: p.amount,
            skipped: false
          }
    )
  });
}

export async function update(req: ReqNoParams, res: Res) {
  const realm = req.realm;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'] as string | undefined;
  const paymentData = req.body;

  validateObjectId(paymentData._id, 'tenant id');
  validateFiniteNumber(paymentData.year, 'year', { required: true, min: 2020, max: 2099 });
  validateFiniteNumber(paymentData.month, 'month', { required: true, min: 1, max: 12 });
  validateFiniteNumber(paymentData.promo, 'promo', { min: 0, max: 10000000 });
  validateFiniteNumber(paymentData.extracharge, 'extracharge', { min: 0, max: 10000000 });
  validateArrayMaxLength(paymentData.payments, 20, 'payments');
  // Wave-24 B7: cap free-text descriptors to prevent runaway document size.
  validateStringLength(paymentData.notepromo, 1000, 'notepromo');
  validateStringLength(paymentData.noteextracharge, 1000, 'noteextracharge');
  validateStringLength(paymentData.description, 1000, 'description');

  const term = `${paymentData.year}${String(paymentData.month).padStart(2, '0')}0100`;

  res.json(
    await _updateByTerm(authorizationHeader, locale, realm, term, paymentData)
  );
}

export async function updateByTerm(req: ReqWithIdTerm, res: Res) {
  const realm = req.realm;
  const term = req.params.term;
  const urlTenantId = req.params.id;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'] as string | undefined;
  const paymentData = req.body;

  // Wave-20 F10: URL :id is authoritative. Without this guard, the route
  // ignored req.params.id and used paymentData._id from the body for the
  // tenant lookup — which let a caller PATCH /rents/payment/{realA}/{term}
  // with body {_id: realB} and silently mutate B's rent. Validate both
  // ids and require them to match.
  validateObjectId(urlTenantId, 'URL tenant id');
  validateObjectId(paymentData._id, 'tenant id');
  if (String(urlTenantId) !== String(paymentData._id)) {
    throw new ServiceError(
      'URL tenant id does not match body tenant id',
      422
    );
  }
  if (!/^\d{10}$/.test(term)) {
    throw new ServiceError('Invalid term format', 422);
  }
  validateFiniteNumber(paymentData.promo, 'promo', { min: 0, max: 10000000 });
  validateFiniteNumber(paymentData.extracharge, 'extracharge', { min: 0, max: 10000000 });
  validateArrayMaxLength(paymentData.payments, 20, 'payments');
  // Wave-24 B7: cap free-text descriptors.
  validateStringLength(paymentData.notepromo, 1000, 'notepromo');
  validateStringLength(paymentData.noteextracharge, 1000, 'noteextracharge');
  validateStringLength(paymentData.description, 1000, 'description');

  res.json(
    await _updateByTerm(authorizationHeader, locale, realm, term, paymentData)
  );
}

// NOTE: payments array is REPLACED, not appended. Callers must include
// all existing payments + new ones in the request body. Stale-state writes
// (a tab that read the rent before another tab added a payment) will
// silently lose prior payments. The optimistic __v lock catches concurrent
// writes against the same baseline but not stale single-tab writes.
// This is intentional PUT semantics — confirm with product before changing
// to merge/append behavior.
async function _updateByTerm(
  authorizationHeader: string | undefined,
  locale: string | undefined,
  realm: CollectionTypes.Realm | null | undefined,
  term: string,
  paymentData: AnyRecord
): Promise<AnyRecord> {
  if (!paymentData.promo || Number(paymentData.promo) <= 0) {
    paymentData.promo = 0;
    paymentData.notepromo = null;
  }

  if (!paymentData.extracharge || Number(paymentData.extracharge) <= 0) {
    paymentData.extracharge = 0;
    paymentData.noteextracharge = null;
  }

  const occupantDoc: AnyRecord = (await Collections.Tenant.findOne({
    _id: paymentData._id,
    realmId: realm!._id
  }).lean()) as AnyRecord;

  if (!occupantDoc) {
    throw new ServiceError('Tenant not found', 404);
  }

  const occupant = occupantDoc;
  const documentVersion = occupant.__v;

  // Fetch buildings for the tenant's properties so building charges (and
  // their VATs) are recomputed when the rent is repaid. Without this,
  // Contract.payTerm rebuilds rents using contract.buildings = undefined
  // and silently drops the buildingCharges line items.
  const propertyIds = (occupant.properties || [])
    .map((p: AnyRecord) => p.propertyId)
    .filter(Boolean);
  const buildings = propertyIds.length
    ? ((await Collections.Building.find({
        realmId: realm!._id,
        'units.propertyId': { $in: propertyIds }
      }).lean()) as any[])
    : [];
  // Wave-17 B1: attach tenant groups so "equal" allocation divides by
  // unique tenants when payTerm rebuilds rents.
  if (buildings.length) {
    await _attachTenantGroupsToBuildings(String(realm!._id), buildings);
  }

  const contract: AnyRecord = {
    frequency: occupant.frequency || 'months',
    begin: occupant.beginDate,
    end: occupant.endDate,
    discount: occupant.discount || 0,
    vatRate: occupant.vatRatio,
    properties: occupant.properties,
    buildings,
    rents: occupant.rents
  };

  const settlements: AnyRecord = {
    payments: [],
    debts: [],
    discounts: [],
    description: ''
  };

  if (paymentData) {
    if (paymentData.payments && paymentData.payments.length) {
      // Validate every payment amount BEFORE the filter so a malformed
      // value surfaces as 422 instead of silently disappearing.
      paymentData.payments.forEach((p: AnyRecord, idx: number) => {
        if (p?.amount !== undefined && p.amount !== null && p.amount !== '') {
          validateFiniteNumber(p.amount, `payments[${idx}].amount`, {
            min: 0,
            max: 10000000
          });
        }
        // Wave-24 B6: enum guard on payment.type.
        if (p?.type !== undefined && p.type !== null) {
          validateEnum(p.type, PAYMENT_TYPES, `payments[${idx}].type`);
        }
        // Wave-24 B7: cap length on free-text fields so a paste-bomb doesn't
        // bloat the embedded array document.
        if (p?.reference !== undefined && p.reference !== null) {
          validateStringLength(
            p.reference,
            1000,
            `payments[${idx}].reference`
          );
        }
        if (p?.description !== undefined && p.description !== null) {
          validateStringLength(
            p.description,
            1000,
            `payments[${idx}].description`
          );
        }
        // Wave-26 round-3o (security): per-payment promo / extracharge /
        // notepromo / noteextracharge introduced in round-3j had NO
        // validation. Rent-level versions (lines 257-263, 296-302) cap
        // numbers at 10M and strings at 1000 chars; the per-payment
        // variants must match. Without these checks a tenant could
        // submit a 10MB notepromo or a 9.99e308 promo that breaks
        // downstream VAT calculations and inflates the document.
        if (p?.promo !== undefined && p.promo !== null && p.promo !== '') {
          validateFiniteNumber(p.promo, `payments[${idx}].promo`, {
            min: 0,
            max: 10000000
          });
        }
        if (
          p?.extracharge !== undefined &&
          p.extracharge !== null &&
          p.extracharge !== ''
        ) {
          validateFiniteNumber(
            p.extracharge,
            `payments[${idx}].extracharge`,
            { min: 0, max: 10000000 }
          );
        }
        if (p?.notepromo !== undefined && p.notepromo !== null) {
          validateStringLength(
            p.notepromo,
            1000,
            `payments[${idx}].notepromo`
          );
        }
        if (
          p?.noteextracharge !== undefined &&
          p.noteextracharge !== null
        ) {
          validateStringLength(
            p.noteextracharge,
            1000,
            `payments[${idx}].noteextracharge`
          );
        }
        // Wave-25: payment-by-category allocation validation. The field is
        // optional (legacy/auto-spread callers send no allocation), but when
        // present every entry must reference a known category, every amount
        // must be a valid non-negative number, and the sum must not exceed
        // the payment amount. Surplus (sum < amount) is allowed — the
        // overflow becomes a credit carried into the next term via the
        // existing balance logic in 5_balance.ts.
        if (p?.allocation !== undefined && p.allocation !== null) {
          if (!Array.isArray(p.allocation)) {
            throw new ServiceError(
              `payments[${idx}].allocation must be an array`,
              422
            );
          }
          let allocSum = 0;
          p.allocation.forEach((entry: AnyRecord, allocIdx: number) => {
            if (!entry || typeof entry !== 'object') {
              throw new ServiceError(
                `payments[${idx}].allocation[${allocIdx}] must be an object`,
                422
              );
            }
            validateEnum(
              entry.category,
              PAYMENT_CATEGORIES,
              `payments[${idx}].allocation[${allocIdx}].category`
            );
            validateFiniteNumber(
              entry.amount,
              `payments[${idx}].allocation[${allocIdx}].amount`,
              { min: 0, max: 10000000 }
            );
            allocSum += Number(entry.amount) || 0;
          });
          const paymentAmount = Number(p.amount) || 0;
          // Allow a tiny epsilon for floating-point sums (e.g., 99.99 + 0.01).
          if (allocSum > paymentAmount + 0.005) {
            throw new ServiceError(
              `payments[${idx}].allocation total ${allocSum.toFixed(2)} exceeds payment amount ${paymentAmount.toFixed(2)}`,
              422
            );
          }
        }
        // Validate optional payment.date in DD/MM/YYYY when present.
        // Empty string and missing are tolerated (legacy callers); but a
        // non-empty malformed value must surface as 422 instead of being
        // stored verbatim and breaking downstream date parsing.
        if (p?.date !== undefined && p.date !== null && p.date !== '') {
          validateDateString(p.date, `payments[${idx}].date`);
          // Wave-14 F3: reject payment dates more than 7 days in the future.
          // A typo like 31/12/2099 is otherwise persisted verbatim and
          // inflates the dashboard for that future year forever. The 7-day
          // cushion accommodates cheque-clearing/post-dated entries.
          const parsed = moment.utc(p.date, 'DD/MM/YYYY', true);
          if (parsed.isValid() && parsed.isAfter(moment.utc().add(7, 'days'))) {
            throw new ServiceError(
              `payments[${idx}].date too far in the future`,
              422
            );
          }
          // Wave-26 round-3o: reject payment dates BEFORE the rent term's
          // first day. round-3t: also reject payment dates AFTER the
          // term's last day + 7d cheque-clearing cushion. Both cases
          // almost always mean the user opened the wrong rents page;
          // accepting the payment carries the credit/debit forward and
          // can produce a NEGATIVE grandTotal on the next month
          // (Contract.payTerm has no clamp). Forces the landlord to
          // record against the correct term explicitly.
          //
          // term is YYYYMMDDHH (e.g. 2026050100 -> 2026-05-01).
          const termStr = String(term);
          if (termStr.length === 10) {
            const termFirstDay = moment.utc(
              `${termStr.slice(0, 4)}-${termStr.slice(4, 6)}-01`,
              'YYYY-MM-DD',
              true
            );
            if (
              parsed.isValid() &&
              termFirstDay.isValid() &&
              parsed.isBefore(termFirstDay)
            ) {
              throw new ServiceError(
                `payments[${idx}].date is before this rent month — switch to that month's rents page to record against it`,
                422
              );
            }
            // Last day of the term-month, +7 days cushion.
            const termLastDay = termFirstDay
              .clone()
              .endOf('month')
              .add(7, 'days');
            if (
              parsed.isValid() &&
              termLastDay.isValid() &&
              parsed.isAfter(termLastDay)
            ) {
              throw new ServiceError(
                `payments[${idx}].date is after this rent month — switch to that month's rents page to record against it`,
                422
              );
            }
          }
        }
      });
      // Wave-26 round-3r: every persisted payment carries an `allocation`.
      // If the caller passed one (Specific / Custom mode), normalise and
      // honour it. Otherwise compute auto-spread server-side against the
      // rent's per-category owed, decrementing as we walk through the
      // payments so a 2nd payment sees what's left after the 1st landed.
      const _targetTermNum = Number(term);
      const _targetRent = (occupant.rents || []).find(
        (r: AnyRecord) => Number(r.term) === _targetTermNum
      );
      const _runningOwed = _computeOwedByCategory(_targetRent || {});

      settlements.payments = paymentData.payments
        .filter(({ amount }: AnyRecord) =>
          Number.isFinite(Number(amount)) && Number(amount) >= 0.01
        )
        .map((payment: AnyRecord) => {
          const amt = Number(payment.amount);
          let allocation: { category: string; amount: number }[];
          if (
            Array.isArray(payment.allocation) &&
            payment.allocation.length
          ) {
            allocation = payment.allocation.map((a: AnyRecord) => ({
              category: String(a.category),
              amount: Number(a.amount)
            }));
          } else {
            allocation = _computeAutoSpread(amt, _runningOwed);
          }
          // Decrement runningOwed by what this payment took, so later
          // payments in the same batch don't double-fill the same buckets.
          allocation.forEach((entry) => {
            const k = entry.category;
            if (_runningOwed[k] != null) {
              _runningOwed[k] = _round(
                Math.max(0, Number(_runningOwed[k]) - entry.amount)
              );
            }
          });
          return {
            date: payment.date || '',
            amount: amt,
            type: payment.type || '',
            reference: payment.reference || '',
            description: payment.description || '',
            // Wave-26 round-3j fields, kept for shape stability.
            promo: Number(payment.promo) || 0,
            notepromo: payment.notepromo || '',
            extracharge: Number(payment.extracharge) || 0,
            noteextracharge: payment.noteextracharge || '',
            allocation
          };
        });
    }

    // Wave-26 round-3j: per-payment description/promo/extracharge fields.
    // The dialog now records these inline with each payment draft so the
    // form does not re-show stored values from a previous reopen. We push
    // one settlements.discounts/debts entry per payment that carries them,
    // tagged with that payment's date so the UI can render the attached
    // description on the correct saved tile.
    //
    // Backward compat: paymentData.promo / paymentData.extracharge /
    // paymentData.description (rent-level) are still honored if the
    // payment-level fields are absent on every entry.
    const _vatFactor = contract.vatRate ? 1 / (1 + contract.vatRate) : 1;
    const targetTerm = Number(term);
    const targetRent = (occupant.rents || []).find(
      (r: AnyRecord) => Number(r.term) === targetTerm
    );
    const grandTotalPrePromo = Number(targetRent?.total?.grandTotal) || 0;

    let perPaymentTotalPromoGross = 0;
    (paymentData.payments || []).forEach((p: AnyRecord) => {
      perPaymentTotalPromoGross += Number(p?.promo) || 0;
    });

    if (perPaymentTotalPromoGross > 0) {
      // Wave-20 F6 cap, summed across per-payment promos.
      if (
        grandTotalPrePromo > 0 &&
        perPaymentTotalPromoGross > grandTotalPrePromo + 0.005
      ) {
        throw new ServiceError(
          `Total promo (${perPaymentTotalPromoGross}) cannot exceed rent grand total of ${grandTotalPrePromo}`,
          422
        );
      }
      (paymentData.payments || []).forEach((p: AnyRecord) => {
        const promo = Number(p?.promo) || 0;
        if (promo <= 0) return;
        settlements.discounts.push({
          origin: 'settlement',
          description: p?.notepromo || '',
          amount: promo * _vatFactor
        });
      });
    } else if (paymentData.promo) {
      const promoGross = Number(paymentData.promo);
      if (grandTotalPrePromo > 0 && promoGross > grandTotalPrePromo + 0.005) {
        throw new ServiceError(
          `Promo (${promoGross}) cannot exceed rent grand total of ${grandTotalPrePromo}`,
          422
        );
      }
      settlements.discounts.push({
        origin: 'settlement',
        description: paymentData.notepromo || '',
        amount: Number(paymentData.promo) * _vatFactor
      });
    }

    let perPaymentTotalExtraGross = 0;
    (paymentData.payments || []).forEach((p: AnyRecord) => {
      perPaymentTotalExtraGross += Number(p?.extracharge) || 0;
    });

    if (perPaymentTotalExtraGross > 0) {
      (paymentData.payments || []).forEach((p: AnyRecord) => {
        const extra = Number(p?.extracharge) || 0;
        if (extra <= 0) return;
        settlements.debts.push({
          description: p?.noteextracharge || '',
          amount: extra * _vatFactor
        });
      });
    } else if (paymentData.extracharge) {
      settlements.debts.push({
        description: paymentData.noteextracharge || '',
        amount: Number(paymentData.extracharge) * _vatFactor
      });
    }

    // Description: aggregate per-payment notes (one per line). Rent-level
    // description still honored if no per-payment notes exist.
    const perPaymentNotes = (paymentData.payments || [])
      .map((p: AnyRecord) => String(p?.description || '').trim())
      .filter(Boolean);
    if (perPaymentNotes.length > 0) {
      settlements.description = perPaymentNotes.join('\n');
    } else if (paymentData.description) {
      settlements.description = paymentData.description;
    }
  }

  // Contract.payTerm throws plain Errors for business-rule failures (e.g.
  // payment term outside contract frame, payments lost). Surface those as
  // 422 so the client gets an actionable error instead of a generic 500.
  try {
    occupant.rents = Contract.payTerm(contract as any, term, settlements).rents;
  } catch (e: any) {
    const msg = (e && e.message) || String(e);
    if (e instanceof ServiceError) throw e;
    throw new ServiceError(msg, 422);
  }

  const emailStatus =
    (await _getEmailStatus(
      authorizationHeader,
      locale,
      realm,
      Number(term)
    ).catch((e) => logger.error(String(e)))) || {};

  const savedOccupant: AnyRecord = await Collections.Tenant.findOneAndUpdate(
    {
      _id: occupant._id,
      realmId: realm!._id,
      __v: documentVersion
    },
    { $set: { rents: occupant.rents }, $inc: { __v: 1 } },
    { new: true }
  ).lean();

  if (!savedOccupant) {
    throw new ServiceError(
      'Payment conflict: another update was made simultaneously. Please retry.',
      409
    );
  }

  const rent = savedOccupant.rents.filter(
    (rent: AnyRecord) => rent.term === Number(term)
  )[0];

  return FD.toRentData(
    rent,
    savedOccupant,
    (emailStatus as AnyRecord)?.[String(savedOccupant._id)],
    // Wave-17 B3: savedOccupant.rents contains the full ledger here (no
    // term filter has been applied), so the running-balance check sees
    // every prior/later rent including the just-saved settlement.
    savedOccupant.rents
  );
}

export async function rentsOfOccupant(req: ReqWithId, res: Res) {
  const realm = req.realm;
  const { id } = req.params;
  // Wave-24 A3: validate the tenant id early so a bad path returns 422 not
  // a Mongoose CastError 500 from `_findOccupants`.
  validateObjectId(id, 'tenant id');
  const term = Number(moment.utc().format('YYYYMMDDHH'));

  const dbOccupants = await _findOccupants(realm, id);
  if (!dbOccupants.length) {
    return res.sendStatus(404);
  }

  const dbOccupant = dbOccupants[0];
  // Wave-17 B3: precompute "running deficit cleared by/at term X" so a past
  // partiallypaid rent gets promoted to 'paid' when a later overpayment
  // covers the carried balance. Passing _allRents lets toRentData detect a
  // future rent whose own newBalance returns to >= 0 — that rent is the
  // catch-up that retroactively closes prior deficits.
  const allRents = dbOccupant._allRents || dbOccupant.rents;
  const rentsToReturn = dbOccupant.rents.map((currentRent: AnyRecord) => {
    const rent: AnyRecord = FD.toRentData(currentRent, undefined, undefined, allRents);
    if (currentRent.term === term) {
      rent.active = 'active';
    }
    rent.vatRatio = dbOccupant.vatRatio;
    return rent;
  });

  res.json({
    occupant: FD.toOccupantData(dbOccupant),
    rents: rentsToReturn
  });
}

export async function rentOfOccupantByTerm(req: ReqWithIdTerm, res: Res) {
  const realm = req.realm;
  const { id, term } = req.params;
  // Wave-24 A3: term parameter is reflected straight into a Mongo query and
  // string-compared. An invalid value like "notaterm" would silently match
  // the first rent in the array (Number(NaN) → 0). Validate up front.
  validateObjectId(id, 'tenant id');
  validateTerm(term, 'term');

  res.json(
    await _rentOfOccupant(
      req.headers.authorization,
      req.headers['accept-language'] as string | undefined,
      realm,
      id,
      term
    )
  );
}

async function _rentOfOccupant(
  authorizationHeader: string | undefined,
  locale: string | undefined,
  realm: CollectionTypes.Realm | null | undefined,
  tenantId: string,
  term: string
): Promise<AnyRecord> {
  const [dbOccupants = [], emailStatus = {}] = await Promise.all([
    _findOccupants(realm, tenantId, Number(term)).catch((e) => {
      logger.error(`Failed to find occupants: ${e}`);
      return [];
    }),
    _getEmailStatus(authorizationHeader, locale, realm, Number(term)).catch((e) => {
      logger.error(`Failed to get email status: ${e}`);
      return {};
    })
  ]);

  if (!(dbOccupants as AnyRecord[]).length) {
    throw new ServiceError('tenant not found', 404);
  }
  const dbOccupant = (dbOccupants as AnyRecord[])[0];

  if (!dbOccupant.rents.length) {
    throw new ServiceError('rent not found', 404);
  }
  // Wave-17 B3: pass the full unfiltered ledger (_allRents) so the running
  // balance through this term reflects later catch-up payments.
  const allRents = dbOccupant._allRents || dbOccupant.rents;
  const rent: AnyRecord = FD.toRentData(
    dbOccupant.rents[0],
    dbOccupant,
    (emailStatus as AnyRecord)?.[dbOccupant._id],
    allRents
  );
  if (rent.term === Number(moment.utc().format('YYYYMMDDHH'))) {
    rent.active = 'active';
  }
  rent.vatRatio = dbOccupant.vatRatio;

  return rent;
}

export async function all(req: ReqWithYearMonth, res: Res) {
  const realm = req.realm;

  let currentDate = moment.utc().startOf('month');
  if (req.params.year && req.params.month) {
    currentDate = moment.utc(`${req.params.month}/${req.params.year}`, 'MM/YYYY');
  }

  res.json(
    await _getRentsDataByTerm(
      req.headers.authorization,
      req.headers['accept-language'] as string | undefined,
      realm,
      currentDate,
      'months'
    )
  );
}
