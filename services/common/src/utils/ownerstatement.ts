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

export interface OwnerStatementCharge {
  buildingId: string;
  buildingName: string;
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
export function buildOwnerStatement(
  buildings: any[],
  ownerKey: string,
  terms: number[]
): OwnerStatementData {
  const termSet = new Set((terms || []).map((t) => Number(t)));
  const wantTerm = (t: number) => termSet.size === 0 || termSet.has(Number(t));

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
    for (const e of b.expenses || []) {
      if (e && e._id && e.type) expTypeById.set(String(e._id), String(e.type));
    }
    for (const row of b.ownerMonthlyExpenses || []) {
      const term = Number(row.term || 0);
      if (!wantTerm(term)) continue;
      const amount = _round(row.amount);
      if (!(amount > 0)) continue;
      // Attribute to the SAME canonical owner the ledger does (lex-first
      // ownerKey of the row's owner set), counted once.
      let keys: string[] = [];
      const pid = row.propertyId ? String(row.propertyId) : null;
      if (pid && propertyOwnerKeys.has(pid)) {
        keys = propertyOwnerKeys.get(pid)!;
      } else {
        keys = Array.from(buildingOwnerKeys.get(bid) || []);
      }
      keys = Array.from(new Set(keys));
      if (keys.length === 0) continue;
      const canonicalKey = [...keys].sort()[0];
      if (canonicalKey !== ownerKey) continue; // not this owner's charge
      const payments = Array.isArray(row.payments) ? row.payments : [];
      const paidAmount = _round(
        payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)
      );
      const src = row.source || 'expense';
      const expenseType =
        src === 'repair' || src === 'repair-vacant'
          ? 'repair'
          : expTypeById.get(String(row.expenseId)) || undefined;
      // Per-owner slices for a co-owned charge (display).
      const sliceOwners =
        pid && propertyOwnerArr.has(pid)
          ? propertyOwnerArr.get(pid)!
          : buildingOwnerArr.get(bid) || [];
      const slices = ownerSlicesOf(sliceOwners, amount);
      charges.push({
        buildingId: bid,
        buildingName: bname,
        term,
        amount,
        paidAmount,
        outstanding: _round(amount - paidAmount),
        paid: paidAmount >= amount - 0.005,
        source: src,
        expenseType,
        description: String(row.description || '').replace(/^Repair:\s*/i, ''),
        propertyId: pid,
        ...(slices.length > 1 ? { coOwners: slices } : {})
      });
    }
  }

  charges.sort((a, b) => a.term - b.term);
  const totals = charges.reduce(
    (acc, c) => {
      acc.amount = _round(acc.amount + c.amount);
      acc.paid = _round(acc.paid + c.paidAmount);
      acc.outstanding = _round(acc.outstanding + c.outstanding);
      return acc;
    },
    { amount: 0, paid: 0, outstanding: 0 }
  );

  return { owner: ownerIdentity, charges, totals };
}
