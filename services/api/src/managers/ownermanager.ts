import { Collections, logger, ServiceError } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import { validateFiniteNumber, validateStringField } from '../validators.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;

// ---------------------------------------------------------------------------
// Owner debt ledger (καταβολές ιδιοκτητών)
//
// Owners are not first-class documents — they live as units[].owners[] on
// building docs. An "owner" here is a distinct identity aggregated across
// every unit/building they own. Their liabilities are the building's
// ownerMonthlyExpenses[] rows; settlement is via owner payments (καταβολές)
// recorded against those rows, mirroring the tenant rent payment model but
// for expenses an owner pays (no rent).
//
// Single source of truth for settlement = each row's `payments[]` array.
// `paid`/`paidDate` are a cached convenience recomputed from payments by
// `recomputeOwnerExpensePaid` (exported so every recompute/rebuild path in
// buildingmanager can call it after touching an owner row).
// ---------------------------------------------------------------------------

const _round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Stable identity for an owner across units/buildings: memberId when present,
// else a normalized name|taxId key. Returns '' (NO identity) when the owner
// has neither memberId nor name nor taxId — such owners MUST NOT be merged
// into a shared "n:|" bucket (that collapsed distinct nameless owners into
// one). Callers skip empty keys (`if (!key) continue`), so a nameless owner is
// simply not surfaced on the owner ledger until it has an identifying field.
export function ownerKeyOf(owner: any): string {
  if (!owner) return '';
  if (owner.memberId) return `m:${String(owner.memberId)}`;
  const name = String(owner.name || '').trim().toLowerCase();
  const taxId = String(owner.taxId || '').trim();
  if (!name && !taxId) return ''; // no identity → not a distinct owner key
  return `n:${name}|${taxId}`;
}

// Derive paid/paidDate for ONE owner ledger row from its payments array.
// paid when outstanding <= 0.005; paidDate = latest payment date when paid.
// Mutates the row in place. Returns the row for chaining.
export function recomputeOwnerExpensePaid(row: any): any {
  const payments = Array.isArray(row.payments) ? row.payments : [];
  const paidAmount = _round(
    payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)
  );
  const amount = _round(row.amount);
  const fullyPaid = paidAmount >= amount - 0.005 && amount > 0;
  row.paid = fullyPaid;
  if (fullyPaid) {
    // latest payment date drives paidDate.
    const latest = payments
      .map((p: any) => (p.date ? new Date(p.date).getTime() : 0))
      .filter((t: number) => Number.isFinite(t) && t > 0)
      .sort((a: number, b: number) => b - a)[0];
    row.paidDate = latest ? new Date(latest) : row.paidDate || new Date();
  } else {
    row.paidDate = null;
  }
  return row;
}

// Carry an owner row's settlement state forward across a strip+rebuild.
// `prior` is the snapshot of the row that existed before the strip (or
// undefined). Returns the fields to spread onto the freshly-pushed row.
//
// IMPORTANT: the returned `paid`/`paidDate` are a CONSERVATIVE carry of the
// prior flag — they are NOT the authoritative derived value for the NEW row
// (whose amount may differ from prior.amount). Every caller MUST call
// `recomputeOwnerExpensePaid(row)` AFTER pushing, so paid is re-derived
// against the row's actual new amount + carried payments. Why carry a flag at
// all then? Two reasons:
//   1. A row marked paid via setOwnerExpensePaid (manual toggle) has paid=true
//      with EMPTY payments[]. recomputeOwnerExpensePaid would reset it to
//      false (no payments). We must preserve that manual paid — but ONLY when
//      the new amount is unchanged from the prior amount; if the amount grew,
//      a manual paid no longer means "fully settled" and is dropped (the
//      landlord must re-confirm). The caller decides via reconcileCarriedPaid.
//   2. paidDate provenance.
export function carryOwnerPayments(prior: any): {
  payments: any[];
  priorPaid: boolean;
  priorPaidDate: any;
  priorAmount: number;
} {
  if (!prior) {
    return { payments: [], priorPaid: false, priorPaidDate: null, priorAmount: 0 };
  }
  const payments = (Array.isArray(prior.payments) ? prior.payments : []).map(
    (p: any) => ({
      date: p.date,
      amount: Number(p.amount) || 0,
      type: p.type || 'transfer',
      reference: p.reference || '',
      description: p.description || ''
    })
  );
  return {
    payments,
    priorPaid: !!prior.paid,
    priorPaidDate: prior.paidDate || null,
    priorAmount: Number(prior.amount) || 0
  };
}

// Apply carried settlement to a freshly-pushed owner row, then derive paid
// correctly against the row's ACTUAL (possibly-changed) amount:
//   - re-derive paid from Σ payments vs the new amount (recomputeOwnerExpensePaid);
//   - if there are NO payments but the prior row was manually marked paid AND
//     the amount is unchanged, preserve that manual paid (a bare toggle, e.g.
//     setOwnerExpensePaid). If the amount changed, a bare manual paid is
//     dropped (the new amount is no longer known-settled).
// `row` is the just-pushed mongoose subdoc (it already has `payments` from the
// carry). Mutates row.paid/paidDate in place.
export function applyCarriedSettlement(
  row: any,
  carried: { priorPaid: boolean; priorPaidDate: any; priorAmount: number }
): void {
  const hasPayments = Array.isArray(row.payments) && row.payments.length > 0;
  if (hasPayments) {
    recomputeOwnerExpensePaid(row); // derive against the row's real amount
    return;
  }
  // No payments. Preserve a manual paid toggle only when the amount is
  // unchanged (a bare paid:true with empty payments came from
  // setOwnerExpensePaid; an amount change invalidates that certainty).
  const amountUnchanged =
    Math.abs((Number(row.amount) || 0) - (carried.priorAmount || 0)) <= 0.005;
  if (carried.priorPaid && amountUnchanged && Number(row.amount) > 0) {
    row.paid = true;
    row.paidDate = carried.priorPaidDate || new Date();
  } else {
    row.paid = false;
    row.paidDate = null;
  }
}

// ---------------------------------------------------------------------------
// Aggregation: build the owner list / one owner from the realm's buildings.
// ---------------------------------------------------------------------------

type OwnerCharge = {
  buildingId: string;
  buildingName: string;
  ownerExpenseId: string;
  expenseId: string;
  term: number;
  amount: number;
  paidAmount: number;
  outstanding: number;
  paid: boolean;
  source: string;
  description: string;
  propertyId: string | null;
  // present when the charge's unit/building has >1 owner; the charge is
  // attributed once to the canonical owner but flagged co-owned for the UI.
  coOwnerCount?: number;
  coOwnerNames?: string[];
};

type OwnerAgg = {
  ownerKey: string;
  name: string;
  taxId: string;
  memberId: string | null;
  unitCount: number;
  buildingIds: Set<string>;
  charges: OwnerCharge[];
  totalAmount: number;
  totalPaid: number;
  totalOutstanding: number;
  // does this owner ALSO rent a unit (for the occupancy pill)?
  alsoRents: boolean;
};

// Map a propertyId → the ownerKey(s) of its unit's owners, across all
// buildings, plus accumulate each owner's charges. Returns a Map keyed by
// ownerKey. `buildings` are lean docs.
function _aggregateOwners(buildings: any[]): Map<string, OwnerAgg> {
  const owners = new Map<string, OwnerAgg>();

  // First pass: every unit's owners → owner identity + unit count.
  // propertyId → ownerKeys, so we can attribute propertyId-scoped charges.
  const propertyOwners = new Map<string, string[]>();

  for (const b of buildings) {
    const bid = String(b._id);
    for (const u of b.units || []) {
      const pid = u.propertyId ? String(u.propertyId) : null;
      const keysForUnit: string[] = [];
      for (const o of u.owners || []) {
        const key = ownerKeyOf(o);
        if (!key) continue;
        keysForUnit.push(key);
        if (!owners.has(key)) {
          owners.set(key, {
            ownerKey: key,
            name: o.name || '',
            taxId: o.taxId || '',
            memberId: o.memberId ? String(o.memberId) : null,
            unitCount: 0,
            buildingIds: new Set<string>(),
            charges: [],
            totalAmount: 0,
            totalPaid: 0,
            totalOutstanding: 0,
            alsoRents: false
          });
        }
        const agg = owners.get(key)!;
        agg.unitCount += 1;
        agg.buildingIds.add(bid);
        // fill in name/taxId if a later unit has richer data
        if (!agg.name && o.name) agg.name = o.name;
        if (!agg.taxId && o.taxId) agg.taxId = o.taxId;
      }
      if (pid && keysForUnit.length) propertyOwners.set(pid, keysForUnit);
    }
  }

  // Second pass: attribute each ownerMonthlyExpenses row to its owner(s).
  //  - propertyId-scoped rows (vacant / repair-vacant) → the owners of THAT
  //    unit.
  //  - building-wide rows (expense / repair / owner-fixed, propertyId null) →
  //    split across ALL owner identities in the building? No — attribute to
  //    every owner of the building EQUALLY would double-count. Instead a
  //    building-wide owner charge has no single unit; attribute it to the
  //    building's owner set is ambiguous. v1 rule: a building-wide owner row
  //    is attributed to the owner resolved from the expense's source unit when
  //    available; when truly building-wide (null propertyId), attribute to the
  //    SINGLE distinct owner of the building if there is exactly one, else to a
  //    synthetic per-building "owner" bucket keyed by building. This keeps
  //    money attributable without inventing splits.
  const buildingOwnerKeys = new Map<string, Set<string>>();
  for (const b of buildings) {
    const bid = String(b._id);
    const set = new Set<string>();
    for (const u of b.units || []) {
      for (const o of u.owners || []) {
        const k = ownerKeyOf(o);
        if (k) set.add(k);
      }
    }
    buildingOwnerKeys.set(bid, set);
  }

  for (const b of buildings) {
    const bid = String(b._id);
    const bname = b.name || '';
    for (const row of b.ownerMonthlyExpenses || []) {
      const amount = _round(row.amount);
      if (!(amount > 0)) continue;
      const payments = Array.isArray(row.payments) ? row.payments : [];
      const paidAmount = _round(
        payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)
      );
      const charge: OwnerCharge = {
        buildingId: bid,
        buildingName: bname,
        ownerExpenseId: String(row._id),
        expenseId: String(row.expenseId),
        term: Number(row.term),
        amount,
        paidAmount,
        outstanding: _round(amount - paidAmount),
        paid: paidAmount >= amount - 0.005,
        source: row.source || 'expense',
        description: row.description || '',
        propertyId: row.propertyId ? String(row.propertyId) : null
      };
      // Resolve the owner(s) this charge belongs to.
      //   - propertyId-scoped (vacant / repair-vacant): the owners of THAT
      //     unit.
      //   - building-wide (expense / repair / owner-fixed, propertyId null):
      //     the building's distinct owners.
      let keys: string[] = [];
      if (charge.propertyId && propertyOwners.has(charge.propertyId)) {
        keys = propertyOwners.get(charge.propertyId)!;
      } else {
        const bset = buildingOwnerKeys.get(bid);
        keys = bset ? Array.from(bset) : [];
      }
      keys = Array.from(new Set(keys)).filter((k) => owners.has(k));
      if (keys.length === 0) continue;
      // Attribute the charge to a SINGLE canonical owner (lex-first ownerKey),
      // counted ONCE — never split across co-owners, and never N-counted.
      // Rationale: a charge has ONE ownerMonthlyExpenses row with ONE payments
      // array; attributing the same row to N owners and summing the full
      // amount to each inflated liability (the N-count bug: €1000 → €2000 in a
      // 2-owner building). Splitting the amount across owners would instead
      // make a single payments[] array ambiguous (which co-owner paid which
      // slice). v1 therefore lands the whole charge on one canonical owner so
      // it is counted once and payments have an unambiguous home. Per-owner
      // percentage split is deferred (design spec "Follow-ons"). When there
      // ARE multiple owners we record the count + the co-owners' names so the
      // UI can show "co-owned by A, B" against the canonical owner's charge.
      const sortedKeys = [...keys].sort();
      const canonicalKey = sortedKeys[0];
      const agg = owners.get(canonicalKey);
      if (!agg) continue;
      if (keys.length > 1) {
        (charge as any).coOwnerCount = keys.length;
        (charge as any).coOwnerNames = sortedKeys
          .map((k) => owners.get(k)?.name)
          .filter(Boolean);
      }
      agg.charges.push(charge);
      agg.totalAmount = _round(agg.totalAmount + charge.amount);
      agg.totalPaid = _round(agg.totalPaid + charge.paidAmount);
      agg.totalOutstanding = _round(agg.totalOutstanding + charge.outstanding);
    }
  }

  return owners;
}

// Mark owners who ALSO rent a unit (occupancy pill). A tenant whose taxId or
// name matches an owner identity is "alsoRents".
async function _markAlsoRents(
  realmId: string,
  owners: Map<string, OwnerAgg>
): Promise<void> {
  if (owners.size === 0) return;
  const tenants = await Collections.Tenant.find(
    { realmId },
    { name: 1, taxId: 1 }
  ).lean();
  const tenantKeys = new Set<string>();
  for (const t of tenants as any[]) {
    const name = String(t.name || '').trim().toLowerCase();
    const taxId = String(t.taxId || '').trim();
    if (taxId) tenantKeys.add(`tax:${taxId}`);
    if (name) tenantKeys.add(`name:${name}`);
  }
  for (const agg of owners.values()) {
    const byTax = agg.taxId && tenantKeys.has(`tax:${agg.taxId.trim()}`);
    const byName =
      agg.name && tenantKeys.has(`name:${agg.name.trim().toLowerCase()}`);
    agg.alsoRents = Boolean(byTax || byName);
  }
}

function _serializeOwnerSummary(agg: OwnerAgg) {
  return {
    ownerKey: agg.ownerKey,
    name: agg.name,
    taxId: agg.taxId,
    memberId: agg.memberId,
    unitCount: agg.unitCount,
    buildingCount: agg.buildingIds.size,
    totalAmount: _round(agg.totalAmount),
    totalPaid: _round(agg.totalPaid),
    totalOutstanding: _round(agg.totalOutstanding),
    alsoRents: agg.alsoRents
  };
}

// GET /owners — aggregated owner list.
export async function all(req: Req, res: Res) {
  const realm = req.realm;
  const buildings = await Collections.Building.find({
    realmId: realm!._id
  }).lean();
  const owners = _aggregateOwners(buildings as any[]);
  await _markAlsoRents(String(realm!._id), owners);
  const list = Array.from(owners.values())
    .map(_serializeOwnerSummary)
    // outstanding first, then name, for a useful default order.
    .sort(
      (a, b) =>
        b.totalOutstanding - a.totalOutstanding ||
        a.name.localeCompare(b.name)
    );
  return res.json(list);
}

// GET /owners/:ownerKey — one owner: charges grouped + payment history.
export async function one(req: Req, res: Res) {
  const realm = req.realm;
  const ownerKey = decodeURIComponent(req.params.ownerKey || '');
  if (!ownerKey) throw new ServiceError('ownerKey is required', 422);
  const buildings = await Collections.Building.find({
    realmId: realm!._id
  }).lean();
  const owners = _aggregateOwners(buildings as any[]);
  await _markAlsoRents(String(realm!._id), owners);
  const agg = owners.get(ownerKey);
  if (!agg) throw new ServiceError('Owner not found', 404);
  // payment history: flatten every payment across the owner's charges.
  const buildingById = new Map(
    (buildings as any[]).map((b) => [String(b._id), b])
  );
  const paymentHistory: any[] = [];
  for (const charge of agg.charges) {
    const b = buildingById.get(charge.buildingId);
    const row = (b?.ownerMonthlyExpenses || []).find(
      (e: any) => String(e._id) === charge.ownerExpenseId
    );
    for (const p of row?.payments || []) {
      paymentHistory.push({
        ownerExpenseId: charge.ownerExpenseId,
        buildingId: charge.buildingId,
        buildingName: charge.buildingName,
        term: charge.term,
        date: p.date,
        amount: _round(p.amount),
        type: p.type,
        reference: p.reference || '',
        description: p.description || ''
      });
    }
  }
  paymentHistory.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  return res.json({
    ...(_serializeOwnerSummary(agg) as any),
    charges: agg.charges.sort((a, b) => a.term - b.term),
    paymentHistory
  });
}

// Owed lines for an owner = their outstanding charges, oldest term first.
// Mirrors rentmanager._computeOwedLines but keyed by ownerExpenseId.
function _ownerOwedLines(agg: OwnerAgg): {
  ownerExpenseId: string;
  buildingId: string;
  amount: number;
}[] {
  return agg.charges
    .filter((c) => c.outstanding > 0.005)
    .sort((a, b) => a.term - b.term)
    .map((c) => ({
      ownerExpenseId: c.ownerExpenseId,
      buildingId: c.buildingId,
      amount: c.outstanding
    }));
}

// Auto-spread a payment amount across owed lines OLDEST-FIRST (the lines are
// pre-sorted by term). Returns allocation entries [{ownerExpenseId, amount}]
// summing to min(amount, Σ owed). Surplus (over the total owed) is left
// unallocated by the caller. Pure + exported for unit testing.
export function autoSpreadOwnerPayment(
  amount: number,
  owedLines: { ownerExpenseId: string; amount: number }[]
): { ownerExpenseId: string; amount: number }[] {
  let remaining = _round(amount);
  const allocation: { ownerExpenseId: string; amount: number }[] = [];
  for (const line of owedLines) {
    if (remaining <= 0.005) break;
    const take = _round(Math.min(remaining, line.amount));
    if (take <= 0.005) continue;
    allocation.push({ ownerExpenseId: line.ownerExpenseId, amount: take });
    remaining = _round(remaining - take);
  }
  return allocation;
}

// POST /owners/:ownerKey/payment — record an owner καταβολή with allocation.
// Body: { payment: { date, amount, type, reference, description,
//   allocation?: [{ ownerExpenseId, amount }] } }
// When allocation omitted → auto-spread oldest-term-first across the owner's
// outstanding charges. The payment is fanned onto the matched rows'
// payments[]; derived paid recomputed per row; the touched buildings saved.
export async function pay(req: Req, res: Res) {
  const realm = req.realm;
  const ownerKey = decodeURIComponent(req.params.ownerKey || '');
  if (!ownerKey) throw new ServiceError('ownerKey is required', 422);
  const payment = req.body?.payment;
  if (!payment || typeof payment !== 'object') {
    throw new ServiceError('payment is required', 422);
  }
  const amount = Number(payment.amount);
  validateFiniteNumber(amount, 'payment.amount', { min: 0.01, max: 100000000 });
  if (payment.date && typeof payment.date !== 'string' && !(payment.date instanceof Date)) {
    throw new ServiceError('payment.date must be a date', 422);
  }
  const type = ['cash', 'transfer', 'cheque'].includes(payment.type)
    ? payment.type
    : 'transfer';
  validateStringField(payment.reference, 'payment.reference', { max: 200, required: false });
  validateStringField(payment.description, 'payment.description', { max: 500, required: false });

  // Load this realm's buildings (mutable docs — we save the touched ones).
  const buildings = await Collections.Building.find({ realmId: realm!._id });
  const lean = buildings.map((b: any) => b.toObject());
  const owners = _aggregateOwners(lean as any[]);
  const agg = owners.get(ownerKey);
  if (!agg) throw new ServiceError('Owner not found', 404);

  // Resolve the allocation: caller-supplied (specific/custom) or auto-spread.
  let allocation: { ownerExpenseId: string; amount: number }[];
  if (Array.isArray(payment.allocation) && payment.allocation.length) {
    // DEDUPE by ownerExpenseId FIRST: multiple entries targeting the same
    // charge must be summed before capping, otherwise two [{X,60},{X,60}]
    // entries each pass a per-entry cap (60<=100) but sum to 120 on a €100
    // row → negative outstanding (the D5-incomplete hole). One entry per
    // charge after this fold.
    const folded = new Map<string, number>();
    for (const a of payment.allocation) {
      const id = String(a.ownerExpenseId);
      const amt = _round(a.amount);
      if (!(amt > 0.005)) continue;
      folded.set(id, _round((folded.get(id) || 0) + amt));
    }
    allocation = Array.from(folded.entries()).map(([ownerExpenseId, amount]) => ({
      ownerExpenseId,
      amount
    }));
    // every allocated charge must belong to this owner, AND its (now
    // cumulative) slice may not exceed that charge's OUTSTANDING (overpaying a
    // row would push its outstanding negative, netting against other charges).
    const chargeByIdForCap = new Map(
      agg.charges.map((c) => [c.ownerExpenseId, c])
    );
    for (const a of allocation) {
      const c = chargeByIdForCap.get(a.ownerExpenseId);
      if (!c) {
        throw new ServiceError(
          `allocation references a charge not owned by this owner: ${a.ownerExpenseId}`,
          422
        );
      }
      if (a.amount > c.outstanding + 0.005) {
        throw new ServiceError(
          `allocation for charge ${a.ownerExpenseId} (€${a.amount}) exceeds its outstanding (€${c.outstanding})`,
          422
        );
      }
    }
    const sum = _round(allocation.reduce((s, a) => s + a.amount, 0));
    if (sum > _round(amount) + 0.005) {
      throw new ServiceError(
        'allocation total exceeds the payment amount',
        422
      );
    }
  } else {
    // auto-spread oldest-first across outstanding.
    const owed = _ownerOwedLines(agg);
    allocation = autoSpreadOwnerPayment(amount, owed);
    const allocatedSum = _round(
      allocation.reduce((s, a) => s + a.amount, 0)
    );
    const surplus = _round(amount - allocatedSum);
    // surplus (overpayment) is dropped here — owner has no carry-forward
    // ledger across terms the way rent does; a future feature could credit it.
    if (surplus > 0.005) {
      logger.info(
        `owner payment surplus €${surplus} for ${ownerKey} not allocated (no outstanding charge left)`
      );
    }
  }

  if (allocation.length === 0) {
    throw new ServiceError(
      'nothing to allocate — the owner has no outstanding charges',
      422
    );
  }

  // RESOLVE every target row to its mutable building doc + subdoc BEFORE
  // mutating anything — so a payment that can't be fully applied fails atomically
  // (nothing written) rather than landing a partial slice. The aggregation was
  // built from .toObject() copies; resolve back to the live docs via .id().
  const chargeById = new Map(
    agg.charges.map((c) => [c.ownerExpenseId, c])
  );
  const targets: { building: any; row: any; amount: number }[] = [];
  for (const a of allocation) {
    const charge = chargeById.get(a.ownerExpenseId);
    if (!charge) {
      throw new ServiceError(
        `cannot resolve charge ${a.ownerExpenseId}`,
        422
      );
    }
    const building = buildings.find(
      (b: any) => String(b._id) === charge.buildingId
    ) as any;
    const row = building?.ownerMonthlyExpenses?.id(a.ownerExpenseId);
    if (!building || !row) {
      // the ledger changed under us (a recompute removed the row) — 409 so the
      // client refetches, rather than silently dropping the slice.
      throw new ServiceError(
        'The owner ledger changed while recording the payment. Please retry.',
        409
      );
    }
    targets.push({ building, row, amount: a.amount });
  }

  // Mutate in memory (all targets resolved above), then save each touched
  // building with a VersionError→409 guard (the codebase standard; mirrors
  // _saveBuildingWithVersionCheck in buildingmanager). Multi-building owner
  // payments are rare (an owner's charges usually sit in one building); the
  // save loop is sequential and a mid-loop VersionError surfaces as 409 — a
  // partial commit is possible only across DISTINCT buildings under concurrent
  // edits, an accepted edge for v1 (documented; mongo-transaction wrapping is a
  // follow-on if it ever bites).
  const pDate = payment.date ? new Date(payment.date) : new Date();
  const touchedBuildings = new Set<string>();
  for (const t of targets) {
    if (!Array.isArray(t.row.payments)) t.row.payments = [];
    t.row.payments.push({
      date: pDate,
      amount: t.amount,
      type,
      reference: payment.reference || '',
      description: payment.description || ''
    });
    recomputeOwnerExpensePaid(t.row);
    touchedBuildings.add(String(t.building._id));
  }

  for (const b of buildings as any[]) {
    if (!touchedBuildings.has(String(b._id))) continue;
    b.updatedDate = new Date();
    try {
      await b.save();
    } catch (err: any) {
      if (err && err.name === 'VersionError') {
        throw new ServiceError(
          'Building was modified concurrently while recording the payment. Please retry.',
          409
        );
      }
      throw err;
    }
  }

  // Re-aggregate for the response so the client sees fresh totals.
  const fresh = await Collections.Building.find({ realmId: realm!._id }).lean();
  const freshOwners = _aggregateOwners(fresh as any[]);
  await _markAlsoRents(String(realm!._id), freshOwners);
  const updated = freshOwners.get(ownerKey);
  return res.json(updated ? _serializeOwnerSummary(updated) : { ownerKey });
}
