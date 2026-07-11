import {
  Collections,
  logger,
  ServiceError,
  OwnerStatement
} from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import { validateFiniteNumber, validateStringField } from '../validators.js';
import moment from 'moment';

// Per-owner € split for DISPLAY — re-exported from the SINGLE canonical
// implementation in common so the owner ledger, the building-expense
// breakdown panel, and the owner-statement PDF can never diverge. See
// common/utils/ownerstatement.ownerSlicesOf for the rules (full-set
// useDeclared decision, [0,100] clamp, carrier-remainder, member-only owners
// kept via ownerKeyOf).
export const ownerSlicesOf = OwnerStatement.ownerSlicesOf;

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

// Apportion a TARGET total across `parts` (each part's nominal share) so the
// rounded shares sum EXACTLY to the rounded target — largest-remainder method.
// Used to slice a co-owner's payments so Σ(per-payment share) === slicePaid
// (the header figure), eliminating the round-of-sum vs sum-of-rounds drift
// Step-7 found (BROKEN 1/3/4/7). `parts` are the raw (unrounded) nominal
// amounts; returns rounded shares aligned to `parts`, summing to _round(target).
function _apportion(target: number, parts: number[]): number[] {
  const tgt = _round(target);
  const partsSum = parts.reduce((s, p) => s + (Number(p) || 0), 0);
  if (parts.length === 0) return [];
  if (!(partsSum > 0)) {
    // nothing to weight by — put the whole target on the first part.
    return parts.map((_p, i) => (i === 0 ? tgt : 0));
  }
  // floor each share to the cent, track remainders, then hand out the leftover
  // cents to the largest remainders so the total reconciles exactly.
  const cents = Math.round(tgt * 100);
  const exact = parts.map((p) => ((Number(p) || 0) / partsSum) * cents);
  const floors = exact.map((x) => Math.floor(x));
  const used = floors.reduce((s, x) => s + x, 0);
  let leftover = cents - used;
  const order = exact
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => b.rem - a.rem);
  const out = floors.slice();
  for (let k = 0; k < order.length && leftover > 0; k++) {
    out[order[k].i] += 1;
    leftover--;
  }
  return out.map((c) => c / 100);
}

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
      description: p.description || '',
      // C2-1 (Step-7): MUST carry ownerKey through every strip+rebuild. Every
      // recompute path (saveMonthlyStatement, _recomputeVacantOwnerCharges)
      // funnels carried payments through here; dropping ownerKey made
      // _aggregateOwners lose the per-co-owner attribution on the first
      // recompute → useTaggedPaid went false → the payment got re-split
      // proportionally across co-owners (one owner's debt re-opened, a co-owner
      // credited money they never paid). Mirror the other carried fields.
      ownerKey: p.ownerKey || null
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
  // schema `type` of the source expense/repair (e.g. 'water_common',
  // 'repair') so the UI can render a localized category label instead of the
  // raw English source enum / description. undefined when not resolvable.
  expenseType?: string;
  description: string;
  propertyId: string | null;
  // Per-unit scope discriminator so the owner-detail Χρεώσεις can label each
  // line by which unit it bills (the user reported 3 visually-identical repair
  // lines). 'building' = a building-wide owner-portion (propertyId null) →
  // "Ολόκληρο κτίριο"; 'unit' = a propertyId-scoped vacant/repair-vacant share
  // → the unit's floor, marked ΚΕΝΟ when the unit is vacant. The frontend maps
  // unitFloor/unitVacant to a localized label (Ισόγειο / Όροφος N / ΚΕΝΟ).
  scope?: 'building' | 'unit';
  unitFloor?: number | null;
  unitVacant?: boolean;
  // present when the charge's unit/building has >1 owner; the charge is
  // attributed once to the canonical owner but flagged co-owned for the UI.
  coOwnerCount?: number;
  coOwnerNames?: string[];
  // DISPLAY-ONLY per-owner split of `amount` by ownership percentage
  // (ownerSlicesOf). Lets the UI show "Name (50%) = €50" per co-owner. The
  // settlement still lands wholly on the canonical owner (one payments[] home).
  coOwners?: { ownerKey: string; name: string; percentage: number; amount: number }[];
  // The recorded καταβολές on this charge (sliced by the same co-owner ratio as
  // `amount`/`paidAmount`). Drives the Τιμολόγια settlements GRID, which mirrors
  // the tenant grid (built from payments, not from owed). Owed stays in the
  // header total, never in the grid (OS1/OS2/OS3, 2026-06-20).
  payments?: {
    date: any;
    amount: number;
    type: string;
    reference: string;
    description: string;
  }[];
};

type OwnerAgg = {
  ownerKey: string;
  name: string;
  taxId: string;
  memberId: string | null;
  // the owner's ownership percentage as declared on their unit(s). When an
  // owner holds units at different percentages this is the LAST seen non-100
  // value (display hint only); 100/undefined for sole owners.
  percentage?: number;
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
//
// `occupiedKeys` (optional): `${propertyId}|${term}` keys of tenant-occupied
// units, used by the shared staleness guard so the ledger (the settlement
// surface) drops a 'vacant'/'owner-resident' row whose unit is actually
// tenant-occupied / no longer owner-occupied / whose expense went inactive —
// never billing the owner for a euro that is also the tenant's rent (round-4
// review). Omitted → no unit treated as occupied (legacy callers / tests).
// `year` (optional): when supplied, only owner charges whose term falls in that
// calendar year are aggregated. Round-2 audit H9 — the year-scoped Accounting
// page was summing all-time totals (no year filter), contradicting the
// year-scoped statement PDF beside it. Absent year → all-time (the standalone
// Owners page). Exported for the H9 jest proof.
export function _aggregateOwners(
  buildings: any[],
  occupiedKeys?: Set<string>,
  year?: number
): Map<string, OwnerAgg> {
  const owners = new Map<string, OwnerAgg>();
  const occSet = occupiedKeys || new Set<string>();

  // First pass: every unit's owners → owner identity + unit count.
  // propertyId → ownerKeys, so we can attribute propertyId-scoped charges.
  const propertyOwners = new Map<string, string[]>();
  // propertyId → the unit's raw owners[] (name+percentage), so a charge on
  // that unit can be sliced per co-owner by percentage (ownerSlicesOf).
  const propertyOwnerArr = new Map<string, any[]>();
  // buildingId → the building's distinct owners[] (deduped by ownerKey), for
  // slicing building-wide owner charges (propertyId null) across co-owners.
  const buildingOwnerArr = new Map<string, any[]>();

  for (const b of buildings) {
    const bid = String(b._id);
    const bOwnersByKey = new Map<string, any>();
    for (const u of b.units || []) {
      const pid = u.propertyId ? String(u.propertyId) : null;
      const keysForUnit: string[] = [];
      for (const o of u.owners || []) {
        const key = ownerKeyOf(o);
        if (!key) continue;
        keysForUnit.push(key);
        if (!bOwnersByKey.has(key)) bOwnersByKey.set(key, o);
        if (!owners.has(key)) {
          owners.set(key, {
            ownerKey: key,
            name: o.name || '',
            taxId: o.taxId || '',
            memberId: o.memberId ? String(o.memberId) : null,
            percentage:
              Number.isFinite(Number(o.percentage)) && Number(o.percentage) < 100
                ? Number(o.percentage)
                : undefined,
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
        // a fractional percentage anywhere is a useful display hint
        if (
          agg.percentage === undefined &&
          Number.isFinite(Number(o.percentage)) &&
          Number(o.percentage) < 100
        ) {
          agg.percentage = Number(o.percentage);
        }
      }
      if (pid && keysForUnit.length) {
        propertyOwners.set(pid, keysForUnit);
        propertyOwnerArr.set(pid, u.owners || []);
      }
    }
    buildingOwnerArr.set(bid, Array.from(bOwnersByKey.values()));
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

  // ── ΛΟΙΠΟΙ (unnamed co-owner remainder) placeholder aggregates ───────────
  // A co-ownership remainder that has no name/taxId in the data (a declared
  // co-owner the landlord hasn't filled in yet) is a REAL owner liability that
  // was previously DROPPED here — billed to nobody, so the ledger under-summed
  // vs the dashboard total (which counts the whole row). Route each such rest
  // slice to an INTERNAL placeholder owner «Λοιποί ιδιοκτήτες», keyed PER UNIT
  // (loipoi:<propertyId>; a building-wide part-owned row → loipoi:b:<bid>) so it
  // points at the exact apartment whose co-owner needs a name. ZERO stored
  // state: when the landlord sets that owner's name+ΑΦΜ, ownerSlicesOf stops
  // emitting a rest slice and the ΛΟΙΠΟΙ bucket shrinks/vanishes on the next
  // read — no recompute needed. This is ADDITIVE: it never changes a NAMED
  // owner's billed/paid; it only surfaces the euro that was already dropped.
  const loipoiAggFor = (
    buildingId: string,
    buildingIdForAgg: string,
    propertyId: string | null,
    restSlice: { percentage: number }
  ): OwnerAgg => {
    const key = OwnerStatement.loipoiKey(buildingId, propertyId);
    let agg = owners.get(key);
    if (!agg) {
      agg = {
        ownerKey: key,
        name: OwnerStatement.LOIPOI_LABEL,
        taxId: '',
        memberId: null,
        percentage: restSlice.percentage,
        // A per-unit ΛΟΙΠΟΙ key (loipoi:<propertyId>) represents exactly ONE
        // unit's un-named remainder → unitCount 1, so the owner card reads
        // "1 μονάδα · 1 κτίριο" instead of the confusing "0 units · 1 buildings".
        unitCount: propertyId ? 1 : 0,
        buildingIds: new Set<string>(),
        charges: [],
        totalAmount: 0,
        totalPaid: 0,
        totalOutstanding: 0,
        alsoRents: false
      };
      owners.set(key, agg);
    }
    agg.buildingIds.add(buildingIdForAgg);
    return agg;
  };

  for (const b of buildings) {
    const bid = String(b._id);
    const bname = b.name || '';
    // expenseId → schema `type` (for a localized category label on the charge).
    const expTypeById = new Map<string, string>();
    const expById = new Map<string, any>();
    for (const e of b.expenses || []) {
      if (e && e._id) {
        expById.set(String(e._id), e);
        if (e.type) expTypeById.set(String(e._id), String(e.type));
      }
    }
    // propertyId → unit, so a propertyId-scoped charge can label its line by
    // the unit's floor + occupancy (ΚΕΝΟ when vacant).
    const unitByPropId = new Map<string, any>();
    for (const u of b.units || []) {
      if (u.propertyId) unitByPropId.set(String(u.propertyId), u);
    }
    for (const row of b.ownerMonthlyExpenses || []) {
      const amount = _round(row.amount);
      // Skip empty rows — EXCEPT a 'credit' row (amount=0) that carries recorded
      // καταβολές: that is preserved owner money from a deleted expense/repair
      // and MUST surface as an overpayment/credit, not be dropped (the whole
      // point of the delete-time payment-preservation fix).
      const rowHasPayments =
        Array.isArray(row.payments) &&
        row.payments.some((p: any) => Number(p && p.amount) > 0);
      if (!(amount > 0) && !rowHasPayments) continue;
      // Round-2 audit H9: year-scope when requested. term is YYYYMMDDHH →
      // Math.floor(term / 1e6) = YYYY. Absent year → no filter (all-time).
      if (year && Math.floor(Number(row.term) / 1000000) !== year) continue;
      // SHARED staleness guard: drop a 'vacant'/'owner-resident' row whose
      // source expense is gone / flag-off / inactive / the unit is
      // tenant-occupied FOR THIS TERM. The ledger is the settlement surface, so
      // counting a stale row would bill the owner for a euro that is also the
      // present tenant's rent (round-4 review). A row with recorded payments is
      // NEVER dropped (isOwnerExpenseRowStale) — recorded money must survive.
      {
        const rpid = row.propertyId ? String(row.propertyId) : null;
        const rterm = Number(row.term);
        const isOccupied = rpid ? occSet.has(`${rpid}|${rterm}`) : false;
        if (
          OwnerStatement.isOwnerExpenseRowStale(
            row,
            expById.get(String(row.expenseId)),
            isOccupied
          )
        ) {
          continue;
        }
      }
      const payments = Array.isArray(row.payments) ? row.payments : [];
      const paidAmount = _round(
        payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)
      );
      // TILE-FLAG "settled everywhere" (Step-7 reader-consistency HIGH + user
      // decision): a bare paid:true flag (set via setOwnerExpensePaid or the
      // migration flag-carry — paid:true with NO cash) means the WHOLE row is
      // settled. The dashboard already honours it (Math.max(fromPayments,
      // fromFlag)); the ledger + legal PDF must MIRROR it so all three surfaces
      // agree. When flagLifted, every derived line (named slices + ΛΟΙΠΟΙ rest) is
      // lifted to its OWN billed amount → Σ per-owner paid === row amount.
      //   GATE on paidAmount<=0.005 — NOT merely row.paid===true. A CO-OWNED row
      // that ONE owner fully paid in CASH has paid===true set by
      // recomputeOwnerExpensePaid; lifting it would credit the NON-paying co-owner
      // with the payer's cash (ΟΔΟΣ ΗΤΑ: ΛΑΜΔΑ's cash leaked €69 onto ΚΑΠΠΑ — a
      // dry-run PAID breach). A genuine tile-flag carries NO cash, so restricting
      // to cashless rows both handles the tile/migration case AND makes a
      // cross-owner cash leak impossible (there is no cash on the row to move).
      // Excludes 'credit' rows (amount 0 — their payments ARE the value).
      const flagLifted =
        row.paid === true &&
        paidAmount <= 0.005 &&
        (row.source || 'expense') !== 'credit';
      // C2: per-owner paid attribution. A building-wide co-owned charge's
      // payments[] is shared; without this, the multi-owner re-split below
      // credited one owner's καταβολή to a co-owner. Sum each payment under its
      // recorded ownerKey. `taggedPaid` is the total of ATTRIBUTED payments;
      // when it covers the whole paidAmount we attribute per owner exactly,
      // otherwise (legacy untagged rows) we fall back to the proportional split.
      const taggedPaidByKey = new Map<string, number>();
      let taggedPaid = 0;
      for (const p of payments) {
        const k = p && p.ownerKey ? String(p.ownerKey) : '';
        if (!k) continue;
        const amt = Number(p.amount) || 0;
        taggedPaidByKey.set(k, _round((taggedPaidByKey.get(k) || 0) + amt));
        taggedPaid = _round(taggedPaid + amt);
      }
      // Use attribution only when the tagged payments account for (essentially)
      // all recorded money — a partially-tagged row would otherwise under-credit.
      const useTaggedPaid = taggedPaid >= paidAmount - 0.005 && taggedPaid > 0;
      const src = row.source || 'expense';
      // A repair row's expenseId is the repair _id (not a building expense), so
      // type='repair'; otherwise look up the source expense's schema type.
      const expenseType =
        src === 'repair' || src === 'repair-vacant'
          ? 'repair'
          : expTypeById.get(String(row.expenseId)) || undefined;
      const charge: OwnerCharge = {
        buildingId: bid,
        buildingName: bname,
        ownerExpenseId: String(row._id),
        expenseId: String(row.expenseId),
        term: Number(row.term),
        amount,
        paidAmount,
        // CLAMP outstanding to ≥0: an over-paid row (owner overpaid a repair,
        // then a transition reduced its owner-portion) must never render a
        // NEGATIVE outstanding on the ledger/statement (Step-7 r2/r5). The
        // surplus stays visible as paidAmount; outstanding floors at 0.
        outstanding: Math.max(0, _round(amount - paidAmount)),
        paid: paidAmount >= amount - 0.005,
        source: src,
        expenseType,
        description: row.description || '',
        propertyId: row.propertyId ? String(row.propertyId) : null,
        // Per-unit scope label (see OwnerCharge.scope). A building-wide
        // owner-portion has no propertyId → 'building'; a propertyId-scoped
        // share is a 'unit' line, labeled by the unit's floor and marked vacant
        // (ΚΕΝΟ) when occupancyType==='vacant'.
        ...(() => {
          const u = row.propertyId
            ? unitByPropId.get(String(row.propertyId))
            : null;
          // Step-7 BROKEN 5: a propertyId-scoped row whose unit no longer
          // exists (orphaned vacant/repair-vacant row surviving the staleness
          // guard because it carries payments) must NOT be forced to scope
          // 'unit' with a fake non-vacant label. With no resolvable unit, treat
          // it as building-wide so the line reads "Ολόκληρο κτίριο", not a
          // mislabeled occupied unit.
          if (!u) return { scope: 'building' as const };
          return {
            scope: 'unit' as const,
            unitFloor: u.floor != null ? Number(u.floor) : null,
            unitVacant: (u.occupancyType || 'vacant') === 'vacant'
          };
        })(),
        // raw recorded payments on this owner row (full, unsliced). For the
        // single-owner path these go verbatim onto the charge; the multi-owner
        // path re-slices amounts by ratio below.
        payments: payments.map((p: any) => ({
          date: p.date,
          amount: Number(p.amount) || 0,
          type: p.type || 'transfer',
          reference: p.reference || '',
          description: p.description || ''
        }))
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
      // Split the charge PROPORTIONALLY across co-owners so each owner's
      // ledger shows their OWN share (not the full amount on one canonical
      // owner). A €50 charge on a building with 2 co-owners at 50% each
      // becomes €25 per owner. Payments are split the same way so
      // outstanding = slice(amount) − slice(paid) per owner.
      // When there's a single owner, the full amount lands on them (no split).
      const sortedKeys = [...keys].sort();
      // sliceFromUnit: did sliceOwners come FROM THIS UNIT (deterministic %s)?
      // Only then is the per-owner slice billing safe. A per-unit row whose unit
      // has EMPTY owners[] (legacy/E9-corrupt data — the real Beta realm shape)
      // falls back to the building owner set, whose stored % is import-order-
      // dependent and borrowed from a DIFFERENT unit; slicing by it mis-attributes
      // (Step-7 r4 #2 — Beta billed a unit she doesn't own). When false, keep
      // the FULL amount on the canonical owner (matches the dashboard/panel which
      // read the full per-unit row), never a borrowed-% slice.
      const sliceFromUnit =
        !!charge.propertyId && propertyOwnerArr.has(charge.propertyId);
      const sliceOwners = sliceFromUnit
        ? propertyOwnerArr.get(charge.propertyId as string)!
        : buildingOwnerArr.get(bid) || [];
      const slices = ownerSlicesOf(sliceOwners, charge.amount);
      // C2-1 round-2 (Step-7): useTaggedPaid alone is NOT safe for the
      // multi-owner split. It only checks that the tagged payments cover
      // paidAmount — NOT that every tagged ownerKey maps to a CURRENT owner
      // slice. If a payer's identity changed after paying (ΑΦΜ/memberId
      // correction, rename) or the payer LEFT the building (unit sold /
      // reassigned / E9 re-import), the tagged key resolves to no surviving
      // slice; slicePaid then reads taggedPaidByKey.get(missingKey)=0 for EVERY
      // owner, so the recorded euro VANISHES from totalPaid and the payer's debt
      // re-opens — strictly worse than the pre-C2 proportional split, which is
      // ownerKey-independent and always conserves the money. Require that ALL
      // tagged money maps to a current slice; otherwise fall back to the
      // lossless proportional path. Invariant: Σ slicePaid === paidAmount.
      const matchedTagged = slices.reduce(
        (s: number, sl: any) =>
          _round(s + (sl.ownerKey ? taggedPaidByKey.get(sl.ownerKey) || 0 : 0)),
        0
      );
      const useTaggedPaidForSlices =
        useTaggedPaid && matchedTagged >= taggedPaid - 0.005;
      // This owner's BILLED share of the charge. ownerSlicesOf appends a "rest"
      // slice (ownerKey '') for any un-identified co-owner; the named slices are
      // what real owners owe. When the sole identified owner does NOT cover the
      // whole charge (a unit declared at 50% whose co-owner is absent from the
      // data), bill only their share — the residual is the missing co-owner's,
      // billed to nobody (MONEY BUG: ΔΟΚΙΜΗ ΒΗΤΑ, sole 50% owner of a unit,
      // was billed the full per-unit share instead of 50%). For a true sole 100%
      // owner the identified slice === charge.amount, so nothing changes. SAFE
      // because the charge is now PER-UNIT (propertyId set): sliceOwners is the
      // unit's own owners → deterministic, not the import-order-dependent
      // building-wide owner set the reverted patch read (Step-7 r-prev).
      const identifiedSliceTotal = _round(
        slices.reduce(
          (s: number, sl: any) => s + (sl.ownerKey ? sl.amount : 0),
          0
        )
      );
      // Map each slice to the ownerKey it belongs to (by name match or by
      // position-aligned fallback). When only one identified owner, bill them
      // their identified share (not necessarily the full amount).
      if (keys.length === 1 || slices.length <= 1) {
        const agg = owners.get(sortedKeys[0]);
        if (!agg) continue;
        // Bill the identified owner's slice — but ONLY for a PROPERTY-SCOPED
        // charge (propertyId set), where sliceOwners is that unit's own owners
        // (deterministic). For a BUILDING-WIDE charge (propertyId null — a
        // repair owner-portion / owner-fixed) sliceOwners is the dedup-by-key
        // building owner set, whose stored % is import-order-dependent for an
        // owner declared at different %s across units; slicing by it would
        // nondeterministically under/over-bill (Step-7 r-prev critical). So a
        // building-wide single-owner charge keeps the FULL amount; per-unit
        // owner-tracked expenses (now materialised per unit) get the slice.
        // GATE on sliceFromUnit, NOT charge.propertyId (Step-7 r4 #2): a per-unit
        // row whose unit has empty owners[] resolved sliceOwners from the building
        // set (borrowed %) — slicing by it mis-attributes, so keep the FULL amount
        // on the canonical owner (matches dashboard/panel). Empty slices
        // (legacy/no owners) → full amount. A 'credit' row keeps amount 0.
        const billed =
          !sliceFromUnit || slices.length === 0
            ? _round(charge.amount)
            : identifiedSliceTotal;
        // Payment share: NEVER scale-erase recorded money (Step-7 #3/#7/#14).
        // Take this owner's TAGGED payments when attribution is sound; otherwise
        // keep the FULL recorded payment on the row. The earlier
        // Math.min(paidAmount, billed) clamp DROPPED recorded money whenever the
        // row carried more than the identified owner's reduced slice (a 50% unit
        // whose row holds the full per-unit καταβολή): she paid €16,67 but billed
        // €8,34 → €8,33 silently vanished, and the dashboard (which counts the
        // full row payment) then disagreed with the ledger. Keep the full
        // recorded paid visible (outstanding floors at 0 below — an overpayment
        // shows owed<paid, never negative), mirroring the multi-owner overpay
        // handling. A 'credit' row (amount 0) likewise keeps its full payment.
        const paidShareRaw = useTaggedPaidForSlices
          ? _round(taggedPaidByKey.get(sortedKeys[0]) || 0)
          : _round(paidAmount);
        // flag-lifted → this owner's slice is fully settled (max of recorded cash
        // and the billed slice), mirroring the dashboard's fromFlag.
        const paidShare = flagLifted
          ? _round(Math.max(paidShareRaw, billed))
          : paidShareRaw;
        if (keys.length > 1) {
          charge.coOwnerCount = keys.length;
          charge.coOwnerNames = sortedKeys
            .map((k) => owners.get(k)?.name)
            .filter(Boolean) as string[];
          charge.coOwners = slices.length > 1 ? slices : undefined;
        }
        const ownCharge = {
          ...charge,
          amount: billed,
          paidAmount: paidShare,
          outstanding: Math.max(0, _round(billed - paidShare)),
          paid: billed > 0 && paidShare >= billed - 0.005,
          // expose the co-owner split for display when we actually billed the
          // partial slice (unit-resolved owners, identified owner < whole) so the
          // line can show "50% (€25) · λοιποί …".
          coOwners:
            sliceFromUnit &&
            slices.length > 1 &&
            identifiedSliceTotal < _round(charge.amount) - 0.005
              ? slices
              : charge.coOwners
        };
        agg.charges.push(ownCharge);
        agg.totalAmount = _round(agg.totalAmount + ownCharge.amount);
        agg.totalPaid = _round(agg.totalPaid + ownCharge.paidAmount);
        agg.totalOutstanding = _round(
          agg.totalOutstanding + ownCharge.outstanding
        );
        // ΛΟΙΠΟΙ remainder: on a UNIT-resolved row where the identified owner
        // covers < the whole charge (a sole 50%-owner unit), ownerSlicesOf
        // appended a rest slice for the un-named co-owner. It was DROPPED — now
        // route it to the per-unit «Λοιποί ιδιοκτήτες» placeholder as a real
        // (unpaid) liability so ledger/statement/dashboard agree. paidAmount 0:
        // the recorded καταβολή belongs to the NAMED owner (kept above); the
        // remainder is a distinct unpaid share.
        if (sliceFromUnit) {
          const rest = slices.find((sl: any) => sl.isRest && sl.amount > 0.005);
          if (rest) {
            const lagg = loipoiAggFor(bid, bid, charge.propertyId, rest);
            // flag-lifted → the un-named co-owner's remainder is settled too
            // (the whole row is flagged paid), so ΛΟΙΠΟΙ shows paid, outstanding
            // 0 — else the tile-tick would leave the ΛΟΙΠΟΙ portion dunned.
            const restPaid = flagLifted ? _round(rest.amount) : 0;
            const restCharge: OwnerCharge = {
              ...charge,
              amount: _round(rest.amount),
              paidAmount: restPaid,
              outstanding: Math.max(0, _round(rest.amount - restPaid)),
              paid: flagLifted,
              coOwnerCount: keys.length,
              coOwnerNames: sortedKeys
                .map((k) => owners.get(k)?.name)
                .filter(Boolean) as string[],
              coOwners: slices,
              payments: []
            };
            lagg.charges.push(restCharge);
            lagg.totalAmount = _round(lagg.totalAmount + restCharge.amount);
            lagg.totalPaid = _round(lagg.totalPaid + restCharge.paidAmount);
            lagg.totalOutstanding = _round(
              lagg.totalOutstanding + restCharge.outstanding
            );
          }
        }
      } else {
        // Multi-owner proportional split: each owner gets their percentage
        // of amount AND paidAmount so the ledger reflects their own liability.
        // For a 'credit' row (charge.amount=0) the preserved payment is split by
        // the SAME carrier-corrected ownerSlicesOf algorithm used for a sibling
        // liability's amount — NOT by the 1-decimal display percentage. With
        // non-terminating shares (33.33% etc.) the rounded percentage (33.3)
        // diverged from the exact euro slice (33.33), leaving a few-cent phantom
        // outstanding that the same-obligation netting could not cancel (a credit
        // €33.3 vs a liability €33.33 per owner → €0.03 residual; Step-7 round-5).
        // Splitting both by ownerSlicesOf makes credit-paid === liability-amount
        // per owner → nets to exactly €0.
        const creditPaidSlices =
          charge.source === 'credit' && paidAmount > 0
            ? ownerSlicesOf(sliceOwners, paidAmount)
            : null;
        const creditPaidByKey = new Map<string, number>();
        if (creditPaidSlices) {
          for (const s of creditPaidSlices) {
            if (s.ownerKey) {
              creditPaidByKey.set(
                s.ownerKey,
                _round((creditPaidByKey.get(s.ownerKey) || 0) + s.amount)
              );
            }
          }
        }
        for (const slice of slices) {
          // Resolve which ownerKey this slice belongs to by the slice's OWN
          // ownerKey (ownerSlicesOf populates it distinctly per owner). Step-7
          // BROKEN 2: name-match dropped/double-attributed a payment for two
          // same-name co-owners with distinct taxIds. The 'rest' carrier slice
          // (ownerKey '', isRest) is the un-named co-owner remainder — attribute
          // it to the per-unit «Λοιποί ιδιοκτήτες» placeholder (a real unpaid
          // liability) instead of dropping it, so this surface reconciles with
          // the dashboard total. paid=0 (a recorded καταβολή is tagged to a
          // NAMED owner and credited there; the rest share is unpaid).
          if ((slice as any).isRest) {
            // Gate on sliceFromUnit — IDENTICAL to the single-owner branch
            // (Step-7 fact-check): only route a remainder to ΛΟΙΠΟΙ when the
            // slice %s came from the UNIT's own owners[] (deterministic). A
            // building-wide row (propertyId null) resolves slices from the
            // dedup-by-key building owner set, whose stored % is import-order-
            // dependent and borrowed from a DIFFERENT unit; splitting a residual
            // by it would mis-attribute (the exact borrowed-% hazard the
            // single-owner branch refuses). Building-wide rows keep the FULL
            // amount on the canonical owner (unchanged pre-existing behaviour);
            // their per-unit split is the deferred repair-writer pass.
            const restAmt = sliceFromUnit ? _round(slice.amount) : 0;
            if (restAmt > 0.005) {
              const lagg = loipoiAggFor(bid, bid, charge.propertyId, slice);
              // flag-lifted → the un-named remainder is settled too.
              const restPaid = flagLifted ? restAmt : 0;
              const restCharge: OwnerCharge = {
                ...charge,
                amount: restAmt,
                paidAmount: restPaid,
                outstanding: Math.max(0, _round(restAmt - restPaid)),
                paid: flagLifted,
                coOwnerCount: keys.length,
                coOwnerNames: sortedKeys
                  .map((k) => owners.get(k)?.name)
                  .filter(Boolean) as string[],
                coOwners: slices,
                payments: []
              };
              lagg.charges.push(restCharge);
              lagg.totalAmount = _round(lagg.totalAmount + restAmt);
              lagg.totalPaid = _round(lagg.totalPaid + restPaid);
              lagg.totalOutstanding = _round(
                lagg.totalOutstanding + restCharge.outstanding
              );
            }
            continue;
          }
          const sliceKey = slice.ownerKey || null;
          const agg = sliceKey ? owners.get(sliceKey) : null;
          if (!agg) continue;
          // Use the slice's EXACT carrier-corrected euro (ownerSlicesOf already
          // makes Σ slice.amount === charge.amount), NOT percentage*amount —
          // Step-7 BROKEN 3 (rounded display % drifts).
          const sliceAmount = _round(slice.amount);
          // slicePaid is the round-ONCE header figure; the per-payment shares
          // below are apportioned to sum to EXACTLY this (Step-7 BROKEN 1/4/7:
          // round-of-sum header vs sum-of-rounds grid disagreed). Ratio uses the
          // slice's exact share of the charge — EXCEPT a delete-time 'credit'
          // row has charge.amount=0 (so amount-ratio would be 0 and DROP the
          // preserved payment across co-owners, F1/F3). For a credit, split the
          // preserved payment by the owner's PERCENTAGE instead.
          // slicePaid resolution, in priority order:
          //  1. ATTRIBUTED (C2): if this row's payments are tagged with the
          //     paying owner's key, this owner is credited EXACTLY their own
          //     tagged καταβολές — never a co-owner's. This is the correct path
          //     for owner καταβολές recorded after the C2 fix.
          //  2. credit row (amount 0): carrier-corrected ownerSlicesOf split.
          //  3. legacy fallback: proportional paidAmount × (slice share) — for
          //     pre-C2 untagged rows where we cannot know who paid.
          const slicePaidRaw = useTaggedPaidForSlices
            ? _round(taggedPaidByKey.get(sliceKey || '') || 0)
            : charge.amount > 0
              ? _round(paidAmount * (sliceAmount / charge.amount))
              : charge.source === 'credit'
                ? creditPaidByKey.get(sliceKey || '') || 0
                : 0;
          // flag-lifted → this co-owner's slice is settled (max of recorded and
          // its billed amount), mirroring the dashboard's fromFlag.
          const slicePaid = flagLifted
            ? _round(Math.max(slicePaidRaw, sliceAmount))
            : slicePaidRaw;
          const sliceOutstanding = Math.max(0, _round(sliceAmount - slicePaid));
          // Apportion slicePaid across this owner's payment shares so the grid
          // (Σ payment shares) reconciles EXACTLY with slicePaid / the header.
          const payShares = _apportion(
            slicePaid,
            (charge.payments || []).map((p) => Number(p.amount) || 0)
          );
          const sliceCharge: OwnerCharge = {
            ...charge,
            amount: sliceAmount,
            paidAmount: slicePaid,
            outstanding: sliceOutstanding,
            paid: slicePaid >= sliceAmount - 0.005,
            coOwnerCount: keys.length,
            coOwnerNames: sortedKeys
              .map((k) => owners.get(k)?.name)
              .filter(Boolean) as string[],
            coOwners: slices,
            payments: (charge.payments || []).map((p, pi) => ({
              ...p,
              amount: payShares[pi] || 0
            }))
          };
          agg.charges.push(sliceCharge);
          agg.totalAmount = _round(agg.totalAmount + sliceAmount);
          agg.totalPaid = _round(agg.totalPaid + slicePaid);
          agg.totalOutstanding = _round(agg.totalOutstanding + sliceOutstanding);
        }
      }
    }
  }

  // Finalization: NET a credit's surplus against its same-obligation
  // (expenseId|term|propertyId) sibling on each owner's ledger, so a
  // cancel→un-cancel / chargeOwnerWhenVacant OFF→ON pair (an inert credit beside
  // a re-opened liability) shows €0 outstanding — settled — instead of a phantom
  // debt that also leaked into the collectible owed-lines (double-charge path).
  // Scoped to the same obligation so a credit can never mask an unrelated debt.
  // Matches the dashboard's term-level netting + buildOwnerStatement (Step-7
  // round-4 reader-disagreement finding). Recompute totalOutstanding from the
  // netted per-charge values.
  for (const agg of owners.values()) {
    const netted = OwnerStatement.netOwnerChargeOutstanding(agg.charges);
    let total = 0;
    agg.charges.forEach((c, i) => {
      const o = netted.get(i);
      if (o != null) {
        c.outstanding = o;
        c.paid = o <= 0.005;
      }
      total = _round(total + c.outstanding);
    });
    agg.totalOutstanding = total;
  }

  return owners;
}

// Resolve the `${propertyId}|${term}` tenant-occupancy key-set for the staleness
// guard in _aggregateOwners — over every term present in the buildings' owner
// rows. One Tenant query (projected to date fields), one shared occupancy
// algorithm (common.occupiedPropertyTermKeys). Returns an empty set when there
// are no propertyId-scoped vacant/owner-resident rows to validate (no query).
export async function _occupiedKeysForBuildings(
  realmId: string,
  buildings: any[]
): Promise<Set<string>> {
  const propIds = new Set<string>();
  const terms = new Set<number>();
  for (const b of buildings as any[]) {
    for (const u of b.units || []) {
      if (u.propertyId) propIds.add(String(u.propertyId));
    }
    for (const row of b.ownerMonthlyExpenses || []) {
      if (
        (row.source === 'vacant' || row.source === 'owner-resident') &&
        row.propertyId
      ) {
        terms.add(Number(row.term));
      }
    }
  }
  if (terms.size === 0 || propIds.size === 0) return new Set<string>();
  const tenants = await Collections.Tenant.find(
    { realmId, 'properties.propertyId': { $in: Array.from(propIds) } },
    {
      beginDate: 1,
      endDate: 1,
      terminationDate: 1,
      'properties.propertyId': 1,
      'properties.entryDate': 1,
      'properties.exitDate': 1
    }
  ).lean();
  return OwnerStatement.occupiedPropertyTermKeys(
    tenants as any[],
    Array.from(terms)
  );
}

// Mark owners who ALSO rent a unit (occupancy pill). A tenant whose taxId or
// name matches an owner identity is "alsoRents".
export async function _markAlsoRents(
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

export function _serializeOwnerSummary(agg: OwnerAgg) {
  // Build per-month settlements (12 slots) from the owner's recorded καταβολές
  // — mirroring TenantSettlements, which is built from rent.payments[] (a
  // PAYMENT each: date + type + amount + note). OS1/OS2/OS3 (2026-06-20): the
  // owner grid was wrongly built from CHARGES (owed/source), which put owed in
  // the notes column and left the money column empty. Owed is NOT in the grid;
  // it lives in the header total (totalAmount/totalOutstanding below).
  const settlements: (any[] | undefined)[] = Array.from({ length: 12 }, () => undefined);
  for (const charge of agg.charges) {
    const term = Number(charge.term);
    if (!term) continue;
    const month = Math.floor((term % 1000000) / 10000) - 1; // 0-based
    if (month < 0 || month > 11) continue;
    for (const p of charge.payments || []) {
      const amt = Number(p.amount) || 0;
      // Step-7 r2 OWN-2: skip ONLY exact-zero (adds nothing). A negative
      // correction/refund row IS counted in the header totalPaid, so it must
      // also appear in the grid or the two diverge (grid > header). Reachable
      // only via direct DB seed today (pay() enforces min 0.01), but aligning
      // the filters keeps grid≡header for any future correction feature.
      if (amt === 0) continue;
      if (!settlements[month]) settlements[month] = [];
      settlements[month]!.push({
        date: p.date || null,
        amount: _round(amt),
        // payment TYPE (cash/transfer/cheque) — what the tenant grid shows in
        // its money column — NOT the charge source.
        type: p.type || 'transfer',
        reference: p.reference || '',
        // the καταβολή note → the right (notes) column, like the tenant grid.
        description: p.description || ''
      });
    }
  }
  return {
    ownerKey: agg.ownerKey,
    name: agg.name,
    taxId: agg.taxId,
    memberId: agg.memberId,
    percentage: agg.percentage,
    unitCount: agg.unitCount,
    buildingCount: agg.buildingIds.size,
    totalAmount: _round(agg.totalAmount),
    totalPaid: _round(agg.totalPaid),
    totalOutstanding: _round(agg.totalOutstanding),
    alsoRents: agg.alsoRents,
    settlements
  };
}

// GET /owners — aggregated owner list.
export async function all(req: Req, res: Res) {
  const realm = req.realm;
  // Round-2 audit H9: optional ?year= scopes the owner totals to that calendar
  // year so the Accounting page's Owners tab reconciles with its sibling
  // year-scoped tabs + statement PDF. Absent → all-time (standalone Owners page).
  const yearRaw = (req.query as Record<string, unknown> | undefined)?.year;
  const year = yearRaw != null && yearRaw !== '' ? Number(yearRaw) : undefined;
  const buildings = await Collections.Building.find({
    realmId: realm!._id
  }).lean();
  const occupiedKeys = await _occupiedKeysForBuildings(
    String(realm!._id),
    buildings as any[]
  );
  const owners = _aggregateOwners(
    buildings as any[],
    occupiedKeys,
    Number.isFinite(year) ? year : undefined
  );
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
  // Express already decodes the :ownerKey path param once; a second decode
  // throws URIError on names with a literal '%' (adversarial finding, June
  // 2026). Use the param verbatim.
  const ownerKey = req.params.ownerKey || '';
  if (!ownerKey) throw new ServiceError('ownerKey is required', 422);
  const buildings = await Collections.Building.find({
    realmId: realm!._id
  }).lean();
  const occupiedKeys = await _occupiedKeysForBuildings(
    String(realm!._id),
    buildings as any[]
  );
  const owners = _aggregateOwners(buildings as any[], occupiedKeys);
  await _markAlsoRents(String(realm!._id), owners);
  const agg = owners.get(ownerKey);
  if (!agg) throw new ServiceError('Owner not found', 404);
  // payment history: flatten every payment across the owner's charges.
  const buildingById = new Map(
    (buildings as any[]).map((b) => [String(b._id), b])
  );
  const paymentHistory: any[] = [];
  // ΛΟΙΠΟΙ (un-named co-owner remainder) has NO καταβολές of its own — its
  // charges reuse the shared unit row's ownerExpenseId, whose payments belong to
  // the NAMED owner. Flattening row.payments here would surface the named
  // owner's private payments on the placeholder's page (cross-attribution). The
  // placeholder is unpaid by construction (restCharge.paidAmount 0), so its
  // history is empty.
  if (!OwnerStatement.isLoipoiKey(ownerKey)) {
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
  }
  paymentHistory.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  // Owned properties: every unit across all buildings where the owner's key
  // appears in unit.owners[]. Provides the data for the owner detail page's
  // apartment list (ATAK + address + link to property page).
  const ownerPropIds: string[] = [];
  const ownerUnits: any[] = [];
  for (const b of buildings as any[]) {
    for (const u of b.units || []) {
      const isOwner = (u.owners || []).some(
        (o: any) => ownerKeyOf(o) === ownerKey
      );
      if (!isOwner) continue;
      ownerUnits.push({ unit: u, building: b });
      if (u.propertyId) ownerPropIds.push(String(u.propertyId));
    }
  }
  const props = ownerPropIds.length
    ? await Collections.Property.find(
        { _id: { $in: ownerPropIds } },
        { name: 1, 'address.street1': 1, 'address.city': 1, 'address.zipCode': 1 }
      ).lean()
    : [];
  const propById = new Map((props as any[]).map((p) => [String(p._id), p]));
  const ownedProperties = ownerUnits.map(({ unit: u, building: b }) => {
    const ownerEntry = (u.owners || []).find(
      (o: any) => ownerKeyOf(o) === ownerKey
    );
    const prop = u.propertyId ? propById.get(String(u.propertyId)) : null;
    return {
      propertyId: u.propertyId ? String(u.propertyId) : null,
      buildingId: String(b._id),
      buildingName: b.name || '',
      atakNumber: u.atakNumber || '',
      surface: u.surface || null,
      floor: u.floor ?? null,
      percentage: ownerEntry?.percentage ?? null,
      propertyName: prop?.name || '',
      address: prop?.address || null
    };
  });

  return res.json({
    ...(_serializeOwnerSummary(agg) as any),
    charges: agg.charges.sort((a, b) => a.term - b.term),
    paymentHistory,
    ownedProperties
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
  // Express already decodes the path param once — no second decode (URIError
  // on '%'-names). Verbatim.
  const ownerKey = req.params.ownerKey || '';
  if (!ownerKey) throw new ServiceError('ownerKey is required', 422);
  // ΛΟΙΠΟΙ is a read-time PLACEHOLDER for an un-named co-owner remainder — it
  // has NO persisted owner row of its own; its charges reuse the SHARED unit
  // row's ownerExpenseId. Recording a payment "as ΛΟΙΠΟΙ" would tag money onto
  // that shared row under a synthetic key that maps to no real owner, corrupting
  // the named owners' attribution. The remainder is settled by NAMING the owner
  // (add name+ΑΦΜ on the unit), which re-routes it to a real payable owner. So
  // reject a payment against a placeholder outright (the UI also hides the pay
  // button, but the API must not trust the client).
  if (OwnerStatement.isLoipoiKey(ownerKey)) {
    throw new ServiceError(
      'Cannot record a payment for the «Λοιποί ιδιοκτήτες» placeholder — set the co-owner’s name and Α.Φ.Μ. on the unit first, then pay that owner.',
      422
    );
  }
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
  const occupiedKeys = await _occupiedKeysForBuildings(
    String(realm!._id),
    lean as any[]
  );
  const owners = _aggregateOwners(lean as any[], occupiedKeys);
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
  // Parse the payment date. The landlord UI sends DD/MM/YYYY (matching the rent
  // payment handler); accept ISO YYYY-MM-DD too (API callers / imports). Raw
  // `new Date("20/06/2026")` returns Invalid Date because JS Date doesn't parse
  // DD/MM/YYYY. A truly-unparseable date must 422 (not persist an Invalid Date
  // that fails the Mongoose cast with a 500 — hardening found via E2E spec 51).
  let pDate = new Date();
  if (payment.date) {
    const m = moment.utc(
      payment.date,
      ['DD/MM/YYYY', 'YYYY-MM-DD', moment.ISO_8601],
      true
    );
    if (!m.isValid()) {
      throw new ServiceError(
        `payment.date is not a valid date: ${String(payment.date)}`,
        422
      );
    }
    pDate = m.toDate();
  }
  const touchedBuildings = new Set<string>();
  for (const t of targets) {
    if (!Array.isArray(t.row.payments)) t.row.payments = [];
    t.row.payments.push({
      date: pDate,
      amount: t.amount,
      type,
      reference: payment.reference || '',
      description: payment.description || '',
      // Attribute this slice to the PAYING owner so a building-wide co-owned
      // charge's read-time re-split credits it to the right owner (audit C2).
      ownerKey
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

  // The amount ACTUALLY allocated to charges (≤ payment.amount). For an
  // auto-spread overpayment the surplus is dropped (owner has no carry-forward
  // ledger), so this can be < payment.amount — the client must report THIS,
  // not the typed amount, or it would tell the landlord more money was
  // recorded than actually landed on the ledger (adversarial finding).
  const allocatedTotal = _round(
    targets.reduce((s, tgt) => s + (Number(tgt.amount) || 0), 0)
  );

  // Re-aggregate for the response so the client sees fresh totals.
  const fresh = await Collections.Building.find({ realmId: realm!._id }).lean();
  const freshOccupied = await _occupiedKeysForBuildings(
    String(realm!._id),
    fresh as any[]
  );
  const freshOwners = _aggregateOwners(fresh as any[], freshOccupied);
  await _markAlsoRents(String(realm!._id), freshOwners);
  const updated = freshOwners.get(ownerKey);
  return res.json(
    updated
      ? { ..._serializeOwnerSummary(updated), allocatedTotal }
      : { ownerKey, allocatedTotal }
  );
}
