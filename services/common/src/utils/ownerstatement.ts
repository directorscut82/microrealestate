// Shared owner-statement data builder. Used by the pdfgenerator owner-statement
// document so the PDF's numbers come from the SAME attribution rules as the
// on-screen owner ledger (api/managers/ownermanager.ts). Kept here in `common`
// — which both `api` and `pdfgenerator` already depend on — so the two cannot
// silently diverge (the €1000→€2000 co-owner double-count rule and ownerKeyOf
// must match the ledger exactly).
//
// This is a READ helper: it loads the realm's buildings and produces, for one
// ownerKey, the charges attributed to that owner (incl. repairs) for the
// requested term(s), plus the owner's identity/contact. It does NOT settle or
// mutate anything.

import { ownerChargeBasis, type ShareBasis } from './sharebasis.js';

// Owner identity key — MUST match api/managers/ownermanager.ts ownerKeyOf.
export function ownerKeyOf(owner: any): string {
  if (!owner) return '';
  if (owner.memberId) return `m:${String(owner.memberId)}`;
  const name = String(owner.name || '').trim().toLowerCase();
  const taxId = String(owner.taxId || '').trim();
  if (!name && !taxId) return '';
  return `n:${name}|${taxId}`;
}

const _round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Is an expense ACTIVE for a term, compared at YYYYMM granularity? Mirrors
// api/businesslogic/tasks/1_base.isExpenseActiveForTerm — duplicated here (not
// imported) because `common` must not depend on `api`. Both must agree.
export function isExpenseActiveForTermMonth(expense: any, term: number): boolean {
  if (!expense) return false;
  const ymTerm = Math.floor(Number(term) / 10000);
  const startYM = expense.startTerm
    ? Math.floor(Number(expense.startTerm) / 10000)
    : null;
  if (!expense.isRecurring) {
    if (!expense.startTerm) return false;
    return startYM === ymTerm;
  }
  if (!expense.startTerm) return false;
  if (ymTerm < (startYM as number)) return false;
  if (expense.endTerm && ymTerm > Math.floor(Number(expense.endTerm) / 10000)) {
    return false;
  }
  return true;
}

// Build the `${propertyId}|${term}` occupancy key-set the staleness guard /
// buildOwnerStatement consume, from raw tenant rows. ONE algorithm shared by
// the owner-statement PDF picker (and any other common-side caller) so it
// matches the api occupancy check. A unit is occupied for a term when the
// tenant's lease window (beginDate..terminationDate|endDate) AND the per-
// property entry/exit window both cover the term's YYYYMM. Date math is
// moment-free (common has no moment dep): parse to UTC year*100+month.
export function occupiedPropertyTermKeys(
  tenants: any[],
  terms: number[]
): Set<string> {
  const toYM = (d: any): number | null => {
    if (!d) return null;
    const dt = d instanceof Date ? d : new Date(d);
    return isNaN(dt.getTime())
      ? null
      : dt.getUTCFullYear() * 100 + (dt.getUTCMonth() + 1);
  };
  const keys = new Set<string>();
  const termYMs = (terms || []).map((t) => ({
    term: Number(t),
    ym: Math.floor(Number(t) / 10000)
  }));
  for (const tn of tenants || []) {
    const begin = toYM(tn.beginDate);
    const end = toYM(tn.terminationDate || tn.endDate);
    for (const tp of tn.properties || []) {
      if (!tp.propertyId) continue;
      const pEntry = toYM(tp.entryDate);
      const pExit = toYM(tp.exitDate);
      for (const { term, ym } of termYMs) {
        if (begin !== null && ym < begin) continue;
        if (end !== null && ym > end) continue;
        if (pEntry !== null && ym < pEntry) continue;
        if (pExit !== null && ym > pExit) continue;
        keys.add(`${String(tp.propertyId)}|${term}`);
      }
    }
  }
  return keys;
}

// SHARED read-time staleness predicate for a persisted ownerMonthlyExpenses
// row of source 'vacant' / 'owner-resident'. These two sources are RE-DERIVED
// from a building expense by the ±12-month recompute, so a row can outlive the
// state that justified it FOR ITS TERM (expense deleted / went inactive for
// that term / flag flipped off / a tenant occupies the unit that term). Every
// READ surface that sums these rows as owner liability — the building-expense
// breakdown panel, the dashboard eksoda series, the owner καταβολές ledger, and
// the owner-statement PDF — MUST drop such a stale row, or the same euro is
// counted as BOTH the owner's liability AND the present tenant's rent (the
// owner-is-also-renter double-count). This is the ONE definition so the four
// surfaces cannot drift (adversarial finding, June 2026 round-4 review).
//
// 'repair' / 'repair-vacant' / 'expense' / 'owner-fixed' rows are NOT covered
// here — they are not re-derived from a building expense (a repair share is
// materialised once and never re-billed; owner-direct/fixed are landlord-
// entered), so they are always kept by their respective surfaces.
//
// Inputs are pre-resolved by the caller (so `common` needs no DB / no api dep):
//   expense        the live building expense for row.expenseId, or null/undefined if gone
//   isOccupied     true if a TENANT occupies row.propertyId for row.term
// Every drop condition here is TERM-ANCHORED (it is true/false for the row's
// own term), so a row is only ever dropped when the SAME-term live state
// contradicts it — never because of unrelated current-day state. Two
// conditions that look tempting are deliberately NOT here:
//   • "unit is no longer owner-occupied" — occupancy is TERM-specific (the
//     owner genuinely lived there in a historical term); a current move-out
//     must not retroactively erase past owner-resident liabilities. The
//     in-window correction is the WRITER's job (updateUnit →
//     recomputeVacantOwnerForProperties restrips/rebuilds the ±12-month
//     window); out-of-window historical rows stay as genuinely owed.
//   • dropping a row that carries recorded payments — see the hasPayments
//     guard below: a recorded καταβολή is USER STATE and must survive any
//     read-time drop (mirrors carryOwnerPayments), or real money vanishes from
//     the ledger/statement with no audit trail (round-4-review-2 finding).
export function isOwnerExpenseRowStale(
  row: {
    source?: string;
    expenseId?: any;
    term?: any;
    propertyId?: any;
    payments?: any[];
  },
  expense: any,
  isOccupied: boolean
): boolean {
  const src = row.source || 'expense';
  if (src !== 'vacant' && src !== 'owner-resident') return false;
  // NEVER drop a row with a recorded payment — the money is real and must stay
  // reconcilable on every settlement surface.
  const hasPayments =
    Array.isArray(row.payments) &&
    row.payments.some((p: any) => Number(p && p.amount) > 0);
  if (hasPayments) return false;
  if (!expense) return true; // source expense gone
  // 'vacant' (truly-empty unit) requires the opt-in flag; 'owner-resident'
  // (resident owner's own cost) is NOT flag-governed.
  if (src === 'vacant' && !expense.chargeOwnerWhenVacant) return true;
  if (!isExpenseActiveForTermMonth(expense, Number(row.term))) return true;
  // A tenant occupying the unit FOR THIS TERM live-bills the expense to them →
  // the owner row would double-count that euro. Term-anchored via the caller's
  // per-(propertyId,term) occupancy resolution.
  if (row.propertyId && isOccupied) return true;
  return false;
}

// Net a 'credit' row's overpayment against its SIBLING liability — same
// obligation only: identical (expenseId, term, propertyId). Returns a Map from a
// charge's array index to its NETTED outstanding.
//
// WHY: a cancel→un-cancel (or chargeOwnerWhenVacant OFF→ON on a paid vacant
// repair) leaves two rows for ONE obligation — an inert source:'credit'
// {amount:0, paid:X} beside a re-opened liability {amount:X, paid:0}. Summing
// each row's own max(0, amount−paid) shows a PHANTOM X outstanding (the credit's
// −X surplus is clamped away) on a debt the owner already settled — and offers
// it as a collectible owed-line (double-charge). The dashboard eksoda already
// nets owed/paid per TERM; this brings the per-row settlement readers (ledger
// _aggregateOwners + statement buildOwnerStatement + _ownerOwedLines) into
// agreement (Step-7 round-4 reader-disagreement finding).
//
// SCOPE GUARD: nets ONLY within the same (expenseId|term|propertyId) key, so a
// credit can NEVER mask a DIFFERENT obligation's debt (e.g. a co-owner's unpaid
// share on another unit — Step-7 round-3 cross-owner masking finding). Group
// outstanding = max(0, Σamount − Σpaid); distributed across the group's rows
// largest-amount-first (a credit's amount 0 → it never carries outstanding).
export function netOwnerChargeOutstanding(
  charges: {
    expenseId?: any;
    term?: any;
    propertyId?: any;
    amount?: number;
    paidAmount?: number;
    source?: any;
  }[]
): Map<number, number> {
  const _r = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
  // Source-FAMILY of a row for netting (Step-7 r5 #2). A 'credit' must net ONLY
  // its own obligation's sibling, NEVER a DISTINCT vacant building-expense share
  // that merely shares the unit (different obligations — the writer's fx|/vr|
  // settleKey split encodes this). The vacant/owner-resident family is isolated;
  // every other source (expense / owner-fixed / repair / repair-vacant / credit)
  // shares one family — safe because the expenseId in the key already separates a
  // repair (keyed by repair _id) from an owner-amount (keyed by expense _id), so
  // a repair-credit can only meet repair siblings and an owner-amount-credit only
  // owner-amount siblings. This nets credit↔repair (cancel/un-cancel) AND
  // credit↔owner-fixed (overpay) while shielding the vacant share.
  const _fam = (src: any): string => {
    const s = String(src || 'expense');
    return s === 'vacant' || s === 'owner-resident' ? 'vr' : 'ob';
  };
  const groups = new Map<string, number[]>();
  charges.forEach((c, i) => {
    const key = `${_fam(c.source)}|${String(c.expenseId)}|${String(c.term)}|${
      c.propertyId == null ? '' : String(c.propertyId)
    }`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  });
  const out = new Map<number, number>();
  for (const idxs of groups.values()) {
    // CREDIT-ONLY netting (Step-7 r2 #5): net a group ONLY when it contains a
    // source:'credit' row — that is the documented intent ("net a credit's
    // surplus against its same-obligation sibling"). Two GENUINE liabilities
    // that now happen to share (expenseId|term|propertyId) — e.g. a per-unit
    // owner-fixed row AND a vacant/owner-resident building-expense share for the
    // same expense+unit (both real, distinct debts) — must EACH keep their own
    // clamped outstanding, never cross-net (which would mark one paid by the
    // other's payment). Giving owner-fixed rows a propertyId made that collision
    // newly possible; this guard prevents the paid/unpaid swap on ledger + PDF.
    const hasCredit = idxs.some(
      (i) => (charges[i].source || '') === 'credit'
    );
    // Fast path: a lone row, OR a multi-row group with NO credit → each row
    // keeps its own clamped outstanding (no netting).
    if (idxs.length === 1 || !hasCredit) {
      for (const i of idxs) {
        const c = charges[i];
        out.set(
          i,
          Math.max(0, _r((Number(c.amount) || 0) - (Number(c.paidAmount) || 0)))
        );
      }
      continue;
    }
    const sumAmount = _r(
      idxs.reduce((s, i) => s + (Number(charges[i].amount) || 0), 0)
    );
    const sumPaid = _r(
      idxs.reduce((s, i) => s + (Number(charges[i].paidAmount) || 0), 0)
    );
    let groupOutstanding = Math.max(0, _r(sumAmount - sumPaid));
    // Distribute the netted group outstanding across the rows, largest amount
    // first, capped at each row's own amount (a credit's amount 0 gets nothing).
    const ordered = [...idxs].sort(
      (a, b) => (Number(charges[b].amount) || 0) - (Number(charges[a].amount) || 0)
    );
    for (const i of ordered) {
      const cap = Number(charges[i].amount) || 0;
      const give = Math.min(cap, groupOutstanding);
      out.set(i, _r(give));
      groupOutstanding = _r(groupOutstanding - give);
    }
  }
  return out;
}

// Split a charge `amount` across a unit's owners by ownership percentage, for
// DISPLAY ("ΔΟΚΙΜΗ ΒΗΤΑ 50% = €50"). The SINGLE canonical implementation
// — both api/managers/ownermanager.ts and api/businesslogic/tasks/1_base.ts
// import THIS so the building-breakdown panel and the owner ledger can never
// show different splits (they diverged when each had its own copy).
//
// Rules (adversarial-hardened, June 2026):
//  - Only owners with an identity (ownerKeyOf truthy: memberId OR name OR
//    taxId) get a slice — a nameless+idless owner is not displayable.
//  - `useDeclared` is decided over the FULL owner set's declared percentages
//    (not the survivors), so a unit with a named 40% + named 40% + nameless
//    20% still shows 40%/40% (not a re-normalised 50/50). When declared, each
//    identified owner shows its TRUE declared share of `amount`; an unidentified
//    co-owner's portion is simply not displayed (the named owners are not
//    inflated to absorb it).
//  - When ALL owners are identified, carrier-remainder makes the slices sum to
//    exactly `amount` (no lost cent).
//  - When percentages are absent / don't sum to ~100, fall back to an EQUAL
//    split over the survivors (carrier-remainder, Σ === amount).
//  - Percentages are CLAMPED to [0,100] so a malformed negative/>100 value
//    never renders a negative € slice.
//
// DISPLAY-ONLY: never changes settlement (the whole charge keeps one payments[]
// home on the canonical owner; see ownermanager._aggregateOwners).
const _clampPct = (v: any): number =>
  Math.max(0, Math.min(100, Number(v) || 0));

// A slice is one owner's € portion of a charge. `isRest:true` marks a SYNTHETIC
// slice for the un-identified remainder (a declared co-owner with no name/taxId
// in the data) so the UI can show "(ΒΗΤΑ 50% = €50, λοιποί 50% = €50)" and the
// "(50%)" beside a name always reconciles with its € — never sits next to a full
// share with no remainder shown (the misleading case the user flagged).
export interface OwnerSlice {
  ownerKey: string;
  name: string;
  percentage: number;
  amount: number;
  isRest?: boolean;
}

export function ownerSlicesOf(
  unitOwners: any[],
  amount: number
): OwnerSlice[] {
  const amt = _round(amount);
  const allOwners = unitOwners || [];
  const owners = allOwners.filter((o) => ownerKeyOf(o));
  if (owners.length === 0) return [];
  // useDeclared over the FULL declared set (clamped), not the survivors.
  const fullPctSum = allOwners.reduce((s, o) => s + _clampPct(o.percentage), 0);
  // Each identified owner carries a sane declared %? Use declared shares when
  // the FULL set sums to ~100 (co-owners all present), OR when every owner's
  // own % is in (0,100] — the latter handles a unit whose co-owner is simply
  // absent from the data (e.g. a sole 50%-owner): we honour the 50% and show
  // the missing 50% as a "rest" slice rather than pretending they own 100%.
  const everyDeclaredInRange =
    owners.length > 0 &&
    owners.every((o) => {
      const p = _clampPct(o.percentage);
      return p > 0 && p <= 100;
    });
  // Sum of the IDENTIFIED owners' declared % (clamped). Used both to decide
  // whether to honour declared shares AND, below, whether they cover the whole
  // unit. Hoisted above the decision so an OVER-declared set (Σ% > 101) — which
  // neither the coversWhole nor the rest-slice branch can reconcile — falls to
  // the equal-split branch instead of returning raw declared slices that
  // over-sum the charge. Real trigger: a building-wide owner-direct row built
  // from the DISTINCT owner set of a multi-unit building, where each owner is
  // the sole 100% owner of their own unit → Σ% = N×100 (adversarial finding,
  // June 2026 round-4: a €240 charge rendered "(A 100%=€240, B 100%=€240, …)").
  const identifiedPctSum = owners.reduce(
    (s, o) => s + _clampPct(o.percentage),
    0
  );
  const overCovers = identifiedPctSum > 101;
  const useDeclared =
    !overCovers &&
    ((fullPctSum > 0.5 && Math.abs(fullPctSum - 100) <= 1) ||
      everyDeclaredInRange);

  if (useDeclared) {
    const slices: OwnerSlice[] = owners.map((o) => {
      const pct = _clampPct(o.percentage);
      return {
        ownerKey: ownerKeyOf(o),
        name: String(o.name || '').trim(),
        percentage: Math.round(pct * 10) / 10,
        amount: _round((amt * pct) / 100)
      };
    });
    // Decide by whether the IDENTIFIED owners' declared % covers the whole unit
    // (~100). The array being "complete" (allIdentified) is NOT the signal — a
    // co-owner can be entirely absent from the data, so a sole 50%-owner has a
    // complete array yet only covers 50%.
    const coversWhole = Math.abs(identifiedPctSum - 100) <= 1;
    if (coversWhole && slices.length) {
      // Identified owners cover the whole unit → force-sum to amt.
      const sum = _round(slices.reduce((s, x) => s + x.amount, 0));
      const drift = _round(amt - sum);
      if (drift !== 0) {
        slices[slices.length - 1].amount = _round(
          slices[slices.length - 1].amount + drift
        );
      }
    } else if (slices.length) {
      // A declared co-owner is NOT identified (no name/taxId in the data).
      // Append a synthetic "rest" slice for the residual % + € so the split
      // still reconciles to the full share and "(50%)" never looks like the
      // owner owes 100%. Only when the residual is material (> ~0.5%).
      const identifiedPct = _round(
        slices.reduce((s, x) => s + x.percentage, 0)
      );
      const restPct = Math.round((100 - identifiedPct) * 10) / 10;
      const identifiedAmt = _round(slices.reduce((s, x) => s + x.amount, 0));
      const restAmt = _round(amt - identifiedAmt);
      if (restPct > 0.5 && restAmt > 0.005) {
        slices.push({
          ownerKey: '',
          name: '',
          percentage: restPct,
          amount: restAmt,
          isRest: true
        });
      }
    }
    return slices;
  }

  // Equal split over survivors, carrier-remainder so Σ === amt.
  const n = owners.length;
  let allocated = 0;
  return owners.map((o, i) => {
    const amountSlice =
      i === n - 1 ? _round(amt - allocated) : _round(amt / n);
    if (i < n - 1) allocated = _round(allocated + amountSlice);
    return {
      ownerKey: ownerKeyOf(o),
      name: String(o.name || '').trim(),
      percentage: Math.round((100 / n) * 10) / 10,
      amount: amountSlice
    };
  });
}

// ── ΛΟΙΠΟΙ (unnamed co-owner) placeholder identity ─────────────────────────
// ownerSlicesOf appends a SYNTHETIC `isRest` slice for a co-ownership remainder
// that has NO name/taxId in the data (a declared co-owner the landlord hasn't
// filled in yet — the sole-50%-owner unit, or a building-wide part-owned lump).
// Historically every read surface DROPPED that slice: the euro was billed to
// NOBODY on the ledger/statement and folded into «Αδιάθετο» on the dashboard,
// so the three surfaces couldn't reconcile and the money looked like it
// vanished. Instead we attribute the remainder to an INTERNAL placeholder owner
// «Λοιποί ιδιοκτήτες» keyed PER UNIT (loipoi:<propertyId>) — a real owner
// liability with no name yet. Keyed per-unit (the user's explicit choice) so it
// points at the exact apartment whose co-owner needs a name; the moment the
// landlord sets that owner's name+ΑΦΜ on the unit, ownerSlicesOf stops emitting
// a rest slice for it and the ΛΟΙΠΟΙ bucket shrinks/vanishes automatically on
// the next read (no stored state to migrate). A building-wide part-owned row
// (propertyId null) keys to loipoi:b:<buildingId>.
//
// This is ZERO stored state: nothing is persisted, so naming the owner needs no
// recompute — the next aggregation simply attributes the euro to the named
// owner instead. ONE definition so ledger + statement + dashboard agree on the
// key and label.
export const LOIPOI_LABEL = 'Λοιποί ιδιοκτήτες';
export function loipoiKey(
  buildingId: string,
  propertyId: string | null | undefined
): string {
  return propertyId
    ? `loipoi:${String(propertyId)}`
    : `loipoi:b:${String(buildingId)}`;
}
export function isLoipoiKey(ownerKey: string | null | undefined): boolean {
  return !!ownerKey && String(ownerKey).startsWith('loipoi:');
}

export interface OwnerStatementCharge {
  buildingId: string;
  buildingName: string;
  // The source expense/repair _id. Needed to group same-obligation rows for
  // credit netting (a credit + its re-opened liability share expenseId+term+
  // propertyId). Was previously omitted, which made every charge net into one
  // group (undefined key) and a credit masked unrelated debts.
  expenseId?: string;
  term: number;
  amount: number;
  paidAmount: number;
  outstanding: number;
  paid: boolean;
  source: string;
  expenseType?: string;
  description: string;
  propertyId: string | null;
  // DISPLAY-only per-owner split of `amount` (when co-owned); same slices the
  // on-screen breakdown shows, so the PDF reconciles per owner.
  coOwners?: OwnerSlice[];
  // Calc-basis equation for the owner-statement PDF (item 6) — same shape the
  // ΧΡΕΩΣΕΙΣ panel uses. null when no meaningful basis applies.
  basis?: ShareBasis | null;
}

export interface OwnerStatementData {
  owner: {
    ownerKey: string;
    name: string;
    taxId: string;
    iban: string;
    phone: string;
    email: string;
  } | null;
  charges: OwnerStatementCharge[];
  totals: { amount: number; paid: number; outstanding: number };
}

// Build the statement for one ownerKey across all the realm's buildings,
// filtered to the requested terms (array of YYYYMMDDHH numbers; empty = all).
// `buildings` are lean docs (units[].owners[], ownerMonthlyExpenses[]).
//
// `occupiedKeys` (optional): a Set of `${propertyId}|${term}` keys for units a
// TENANT occupies that term. The caller resolves it (this module is DB-free).
// It drives the shared staleness guard (isOwnerExpenseRowStale) so the
// statement — the settlement document of record — never bills the owner for a
// 'vacant'/'owner-resident' euro that is also billed to the present tenant's
// rent (round-4 review). Omitted → no unit is treated as tenant-occupied
// (matches the pre-guard behaviour for callers that don't supply it).
export function buildOwnerStatement(
  buildings: any[],
  ownerKey: string,
  terms: number[],
  occupiedKeys?: Set<string>
): OwnerStatementData {
  const termSet = new Set((terms || []).map((t) => Number(t)));
  const wantTerm = (t: number) => termSet.size === 0 || termSet.has(Number(t));
  const occSet = occupiedKeys || new Set<string>();

  // Resolve the owner's identity + contact from the matching unit owner
  // subdoc (first one whose ownerKey matches). The ledger drops iban/phone/
  // email, so we read them straight from units[].owners[] here.
  let ownerIdentity: OwnerStatementData['owner'] = null;
  // propertyId → ownerKeys (for attributing propertyId-scoped rows), and
  // buildingId → distinct ownerKeys (for building-wide rows).
  const propertyOwnerKeys = new Map<string, string[]>();
  const buildingOwnerKeys = new Map<string, Set<string>>();
  // propertyId → the unit's raw owners[] + buildingId → distinct owners[], so a
  // charge can be sliced per co-owner for the statement (same as the on-screen
  // breakdown).
  const propertyOwnerArr = new Map<string, any[]>();
  const buildingOwnerArr = new Map<string, any[]>();
  for (const b of buildings) {
    const bid = String(b._id);
    const bset = new Set<string>();
    const bOwnersByKey = new Map<string, any>();
    for (const u of b.units || []) {
      const pid = u.propertyId ? String(u.propertyId) : null;
      const keys: string[] = [];
      for (const o of u.owners || []) {
        const k = ownerKeyOf(o);
        if (!k) continue;
        keys.push(k);
        bset.add(k);
        if (!bOwnersByKey.has(k)) bOwnersByKey.set(k, o);
        if (k === ownerKey && !ownerIdentity) {
          ownerIdentity = {
            ownerKey,
            name: String(o.name || '').trim(),
            taxId: String(o.taxId || '').trim(),
            iban: String(o.iban || '').trim(),
            phone: String(o.phone || '').trim(),
            email: String(o.email || '').trim()
          };
        }
      }
      if (pid && keys.length) {
        propertyOwnerKeys.set(pid, keys);
        propertyOwnerArr.set(pid, u.owners || []);
      }
    }
    buildingOwnerKeys.set(bid, bset);
    buildingOwnerArr.set(bid, Array.from(bOwnersByKey.values()));
  }

  const charges: OwnerStatementCharge[] = [];
  for (const b of buildings) {
    const bid = String(b._id);
    const bname = b.name || '';
    const expTypeById = new Map<string, string>();
    const expById = new Map<string, any>();
    for (const e of b.expenses || []) {
      if (e && e._id) {
        expById.set(String(e._id), e);
        if (e.type) expTypeById.set(String(e._id), String(e.type));
      }
    }
    for (const row of b.ownerMonthlyExpenses || []) {
      const term = Number(row.term || 0);
      if (!wantTerm(term)) continue;
      const amount = _round(row.amount);
      // Keep amount=0 rows that carry recorded καταβολές (a delete-time 'credit'
      // row preserving owner money) so the preserved payment surfaces on the
      // STATEMENT PDF as a credit — mirroring the ledger (_aggregateOwners). The
      // two settlement surfaces MUST agree on owner paid amount (file header).
      const rowHasPayments =
        Array.isArray(row.payments) &&
        row.payments.some((p: any) => Number(p && p.amount) > 0);
      if (!(amount > 0) && !rowHasPayments) continue;
      // SHARED staleness guard: drop a 'vacant'/'owner-resident' row whose
      // source expense is gone / flag-off / inactive / the unit is
      // tenant-occupied FOR THIS TERM — the same term-anchored drop the
      // breakdown + dashboard read-paths apply, so the settlement document
      // never double-counts the owner against the tenant's rent. (Never drops
      // a row with recorded payments; see isOwnerExpenseRowStale.)
      {
        const rpid = row.propertyId ? String(row.propertyId) : null;
        const isOccupied = rpid ? occSet.has(`${rpid}|${term}`) : false;
        if (
          isOwnerExpenseRowStale(
            row,
            expById.get(String(row.expenseId)),
            isOccupied
          )
        ) {
          continue;
        }
      }
      // Resolve the owner set this row belongs to (propertyId-scoped → the
      // unit's owners; building-wide → the building's distinct owners).
      let keys: string[] = [];
      const pid = row.propertyId ? String(row.propertyId) : null;
      if (pid && propertyOwnerKeys.has(pid)) {
        keys = propertyOwnerKeys.get(pid)!;
      } else {
        keys = Array.from(buildingOwnerKeys.get(bid) || []);
      }
      keys = Array.from(new Set(keys));
      if (keys.length === 0) continue;
      const sortedKeys = [...keys].sort();
      const canonicalKey = sortedKeys[0];
      const payments = Array.isArray(row.payments) ? row.payments : [];
      const paidAmount = _round(
        payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)
      );
      const src = row.source || 'expense';
      const expenseType =
        src === 'repair' || src === 'repair-vacant'
          ? 'repair'
          : expTypeById.get(String(row.expenseId)) || undefined;
      // Per-owner slices for a co-owned charge (display + this owner's share).
      // sliceFromUnit: was sliceOwners resolved FROM THE UNIT (deterministic %s)?
      // A per-unit row whose unit has empty owners[] falls back to the building
      // set (borrowed %) → slicing would mis-attribute (Step-7 r4 #2). Mirror
      // _aggregateOwners: only slice when unit-resolved; else keep full amount.
      const sliceFromUnit = !!pid && propertyOwnerArr.has(pid);
      const sliceOwners = sliceFromUnit
        ? propertyOwnerArr.get(pid as string)!
        : buildingOwnerArr.get(bid) || [];
      const slices = ownerSlicesOf(sliceOwners, amount);
      const mySlice = slices.find((sl: any) => sl.ownerKey === ownerKey);
      const identifiedSliceTotal = _round(
        slices.reduce(
          (s: number, sl: any) => s + (sl.ownerKey ? sl.amount : 0),
          0
        )
      );
      // ΛΟΙΠΟΙ statement: when the requested ownerKey is the per-unit unnamed-
      // remainder placeholder, this row contributes ONLY its rest slice (the
      // un-named co-owner's share), unpaid — mirroring _aggregateOwners so the
      // statement PDF reconciles with the ledger to the cent. A recorded
      // καταβολή on the row is a NAMED owner's and is credited on THEIR
      // statement, never here. Short-circuits the named-owner billing below.
      if (isLoipoiKey(ownerKey)) {
        // Gate on sliceFromUnit — MUST mirror _aggregateOwners: only a per-unit
        // row (unit-declared %s) produces a ΛΟΙΠΟΙ remainder. A building-wide row
        // resolves slices from the borrowed, import-order-dependent building
        // owner set, which the ledger refuses to split — so the statement must
        // not either, or ledger↔statement disagree (Step-7 fact-check). A
        // building-wide loipoi key therefore never matches a row here.
        if (!sliceFromUnit) continue;
        if (loipoiKey(bid, pid) !== ownerKey) continue;
        const rest = slices.find((sl: any) => sl.isRest && sl.amount > 0.005);
        if (!rest) continue;
        const restAmt = _round(rest.amount);
        charges.push({
          buildingId: bid,
          buildingName: bname,
          expenseId: String(row.expenseId),
          term,
          amount: restAmt,
          paidAmount: 0,
          outstanding: restAmt,
          paid: false,
          source: src,
          expenseType,
          description: String(row.description || '').replace(/^Repair:\s*/i, ''),
          propertyId: pid,
          basis: ownerChargeBasis(b, {
            expenseId: row.expenseId,
            source: src,
            propertyId: pid,
            amount: restAmt
          }),
          ...(slices.length > 1 ? { coOwners: slices } : {})
        });
        continue;
      }
      // C2 TAGGED-PAYMENT attribution — MUST mirror ownermanager._aggregateOwners
      // (Step-7 r2 #1/#4): a payment recorded by a specific owner carries that
      // owner's ownerKey, so each co-owner is credited ONLY their own tagged
      // καταβολές. A purely proportional split would tell a non-paying co-owner
      // they are PAID (and the paying one over-paid) — the legal PDF would then
      // contradict the on-screen ledger. Fall back to proportional only for
      // legacy untagged rows.
      const taggedPaidByKey = new Map<string, number>();
      let taggedPaid = 0;
      for (const p of payments) {
        const k = p && p.ownerKey ? String(p.ownerKey) : '';
        if (!k) continue;
        const amt = Number(p.amount) || 0;
        taggedPaidByKey.set(k, _round((taggedPaidByKey.get(k) || 0) + amt));
        taggedPaid = _round(taggedPaid + amt);
      }
      const useTaggedPaid = taggedPaid >= paidAmount - 0.005 && taggedPaid > 0;
      const matchedTagged = slices.reduce(
        (s: number, sl: any) =>
          _round(s + (sl.ownerKey ? taggedPaidByKey.get(sl.ownerKey) || 0 : 0)),
        0
      );
      const useTaggedPaidForSlices =
        useTaggedPaid && matchedTagged >= taggedPaid - 0.005;
      // BILLING — MUST mirror ownermanager._aggregateOwners EXACTLY so the legal
      // PDF and the on-screen ledger agree to the cent (Step-7 #9/#11/#16). Two
      // branches, same discriminant the ledger uses:
      //   SINGLE path (keys.length===1 || slices.length<=1): only the lex-first
      //     owner carries the row. billed = the identified slice for a
      //     property-scoped charge (a sole 50%-owner unit with the co-owner
      //     absent bills only 50%), or the FULL amount for a building-wide
      //     charge / no resolvable slices. paid = TAGGED owner's payments when
      //     attribution is sound, else the FULL recorded payment (no Math.min
      //     clamp — that DROPPED recorded money, Step-7 #14).
      //   MULTI path (2+ identified co-owners, slices>1): EACH co-owner's
      //     statement carries THEIR OWN slice; paid = their TAGGED καταβολές when
      //     sound, else proportional (credit rows split the preserved payment by
      //     %), conserving Σ (Step-7 #1/#4/#9/#11).
      let billed: number;
      let paidShare: number;
      if (keys.length === 1 || slices.length <= 1) {
        if (canonicalKey !== ownerKey) continue; // single path: canonical only
        // Gate on sliceFromUnit (Step-7 r4 #2): a per-unit row on a unit with no
        // owners resolved a borrowed building % → keep the FULL amount, not a
        // mis-attributed slice (mirrors _aggregateOwners).
        billed =
          !sliceFromUnit || slices.length === 0 ? amount : identifiedSliceTotal;
        paidShare = useTaggedPaidForSlices
          ? _round(taggedPaidByKey.get(ownerKey) || 0)
          : _round(paidAmount); // full recorded; outstanding floors ≥0
      } else {
        if (!mySlice) continue; // ownerKey is not an identified owner of this row
        billed = _round(mySlice.amount);
        if (useTaggedPaidForSlices) {
          paidShare = _round(taggedPaidByKey.get(ownerKey) || 0);
        } else if (src === 'credit') {
          // amount 0 → split the preserved payment by ownership %.
          const creditSlices = ownerSlicesOf(sliceOwners, paidAmount);
          const myCredit = creditSlices.find(
            (sl: any) => sl.ownerKey === ownerKey
          );
          paidShare = _round(myCredit ? myCredit.amount : 0);
        } else {
          paidShare =
            amount > 0
              ? _round(paidAmount * (mySlice.amount / amount))
              : 0;
        }
      }
      charges.push({
        buildingId: bid,
        buildingName: bname,
        expenseId: String(row.expenseId),
        term,
        amount: billed,
        paidAmount: paidShare,
        // CLAMP outstanding to ≥0 so an over-paid row never prints a negative
        // outstanding on the legal owner statement (Step-7 r2/r5).
        outstanding: Math.max(0, _round(billed - paidShare)),
        paid: billed > 0 && paidShare >= billed - 0.005,
        source: src,
        expenseType,
        description: String(row.description || '').replace(/^Repair:\s*/i, ''),
        propertyId: pid,
        // Calc-basis equation ("100 € ÷ 11 μονάδες = 9,09 €" / "cost 100 € ×
        // owner 50% = 50 €") so the owner-statement PDF shows the SAME
        // breakdown as the on-screen ΧΡΕΩΣΕΙΣ panel. Computed from the source
        // expense/repair via the shared builder (item 6).
        basis: ownerChargeBasis(b, {
          expenseId: row.expenseId,
          source: src,
          propertyId: pid,
          amount: billed
        }),
        ...(slices.length > 1 ? { coOwners: slices } : {})
      });
    }
  }

  charges.sort((a, b) => a.term - b.term);
  // Net a credit's surplus against its same-obligation (expenseId|term|
  // propertyId) sibling so a cancel→un-cancel / flag OFF→ON pair shows €0
  // outstanding (settled), not a phantom debt — matching the dashboard's
  // term-level netting. Scoped to the same obligation so it never masks an
  // unrelated debt. (Step-7 round-4.)
  const nettedOutstanding = netOwnerChargeOutstanding(charges);
  charges.forEach((c, i) => {
    c.outstanding = nettedOutstanding.get(i) ?? c.outstanding;
    c.paid = c.outstanding <= 0.005;
  });
  const totals = charges.reduce(
    (acc, c) => {
      acc.amount = _round(acc.amount + c.amount);
      acc.paid = _round(acc.paid + c.paidAmount);
      acc.outstanding = _round(acc.outstanding + c.outstanding);
      return acc;
    },
    { amount: 0, paid: 0, outstanding: 0 }
  );

  // ΛΟΙΠΟΙ placeholder has no unit-owner subdoc to resolve identity from —
  // synthesise a name-only identity so the statement header isn't blank.
  if (!ownerIdentity && isLoipoiKey(ownerKey)) {
    ownerIdentity = {
      ownerKey,
      name: LOIPOI_LABEL,
      taxId: '',
      iban: '',
      phone: '',
      email: ''
    };
  }

  return { owner: ownerIdentity, charges, totals };
}
