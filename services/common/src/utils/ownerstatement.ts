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

export function ownerSlicesOf(
  unitOwners: any[],
  amount: number
): { ownerKey: string; name: string; percentage: number; amount: number }[] {
  const amt = _round(amount);
  const allOwners = unitOwners || [];
  const owners = allOwners.filter((o) => ownerKeyOf(o));
  if (owners.length === 0) return [];
  // useDeclared over the FULL declared set (clamped), not the survivors.
  const fullPctSum = allOwners.reduce((s, o) => s + _clampPct(o.percentage), 0);
  const useDeclared = fullPctSum > 0.5 && Math.abs(fullPctSum - 100) <= 1;
  const allIdentified = owners.length === allOwners.length;

  if (useDeclared) {
    const slices = owners.map((o) => {
      const pct = _clampPct(o.percentage);
      return {
        ownerKey: ownerKeyOf(o),
        name: String(o.name || '').trim(),
        percentage: Math.round(pct * 10) / 10,
        amount: _round((amt * pct) / 100)
      };
    });
    // Only force-sum to `amt` when every owner is identified (no nameless
    // co-owner whose share is legitimately not shown).
    if (allIdentified && slices.length) {
      const sum = _round(slices.reduce((s, x) => s + x.amount, 0));
      const drift = _round(amt - sum);
      if (drift !== 0) {
        slices[slices.length - 1].amount = _round(
          slices[slices.length - 1].amount + drift
        );
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
  for (const b of buildings) {
    const bid = String(b._id);
    const bset = new Set<string>();
    for (const u of b.units || []) {
      const pid = u.propertyId ? String(u.propertyId) : null;
      const keys: string[] = [];
      for (const o of u.owners || []) {
        const k = ownerKeyOf(o);
        if (!k) continue;
        keys.push(k);
        bset.add(k);
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
      if (pid && keys.length) propertyOwnerKeys.set(pid, keys);
    }
    buildingOwnerKeys.set(bid, bset);
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
        propertyId: pid
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
