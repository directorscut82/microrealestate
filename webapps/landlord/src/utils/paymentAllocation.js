/**
 * B1: Per-line-item payment allocation.
 *
 * Each rent's owed amount is broken into LINE ITEMS that correspond to
 * the underlying source arrays in rent.* (preTaxAmounts, charges,
 * buildingCharges) plus the scalar carry-forward and settlement fields.
 * The katavoli dialog renders one row per line so the user can pick
 * exactly which entry a payment settles, instead of collapsing
 * everything into 6 fixed buckets.
 *
 * Same lines, keys and order as services/api/src/managers/rentmanager.ts
 * _computeOwedLines: the server checks an allocation against its own list,
 * so keep those in step. Two differences are deliberate:
 *   - a credit carried in is taken off the lines here and NOT on the server
 *     (how the server attributes a payment is unchanged on purpose — a
 *     server version was built and withdrawn, DEFERRED_DECISIONS D-8);
 *   - the row this window receives has no `vat` / `vats`, so no VAT line
 *     is built here, while the server has one. The lines of a month that
 *     bills VAT therefore do not add up to its bill, and such a month is
 *     listed exactly as it was before the credit was taken into account
 *     (see listsWholeBill / owedLinesOf): approximate, not made worse.
 *
 * Line shape:
 *   {
 *     category: 'rent' | 'propertyCharge' | 'buildingCharge' |
 *               'repair' | 'vat' | 'previousBalance' | 'extracharge',
 *     lineKey:  '<sourceArray>:<index>'
 *               // 'preTax:0', 'charges:1', 'building:0',
 *               // or 'previousBalance' / 'vat' / 'extracharge' (scalar)
 *     description: string,
 *     amount: number,
 *     type?: string,         // present on building/repair lines
 *     buildingName?: string  // present on building/repair lines
 *   }
 *
 * Auto-spread order matches rentmanager.AUTO_SPREAD by virtue of the
 * order in which computeOwedLines pushes entries:
 *   previousBalance → rent → propertyCharge → buildingCharge →
 *   repair → vat → extracharge.
 */

const _round = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A stored amount is a figure when it is a finite number, or text holding one.
const _figure = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Does the row say the month bills VAT? With `vatAmount` (what `/rents/…`
 * returns: the VAT of the rent and of the charges); `vat` / `vats` would say
 * so too. Anything that is not plainly «no VAT» counts as VAT.
 */
export function billsVat(rent) {
  const positive = (v) => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && !(n <= 0);
  };
  return (
    positive(rent?.vatAmount) ||
    positive(rent?.vat) ||
    (Array.isArray(rent?.vats) && rent.vats.some((x) => positive(x?.amount)))
  );
}

// The lines of the month's OWN bill (everything but what it carries in), in
// the order a payment fills them.
function _ownLines(rent) {
  const lines = [];

  // Rent (preTaxAmounts) — typically one per property.
  const preTax = Array.isArray(rent.preTaxAmounts) ? rent.preTaxAmounts : [];
  preTax.forEach((p, i) => {
    const amount = _round(Number(p?.amount) || 0);
    if (amount <= 0.005) return;
    lines.push({
      category: 'rent',
      lineKey: `preTax:${i}`,
      description: String(p?.description || 'Rent'),
      amount
    });
  });

  // Property-level surcharges (rent.charges) — sourced from
  // tenant.properties[].expenses[].title (e.g. "Επί του ενοικίου").
  const charges = Array.isArray(rent.charges) ? rent.charges : [];
  charges.forEach((c, i) => {
    const amount = _round(Number(c?.amount) || 0);
    if (amount <= 0.005) return;
    lines.push({
      category: 'propertyCharge',
      lineKey: `charges:${i}`,
      description: String(c?.description || 'Charge'),
      amount
    });
  });

  // Building charges — split by type. type !== 'repair' is κοινόχρηστα,
  // type === 'repair' is επισκευές.
  const buildingCharges = Array.isArray(rent.buildingCharges)
    ? rent.buildingCharges
    : [];
  buildingCharges.forEach((c, i) => {
    const amount = _round(Number(c?.amount) || 0);
    if (amount <= 0.005) return;
    const isRepair = c?.type === 'repair';
    lines.push({
      category: isRepair ? 'repair' : 'buildingCharge',
      lineKey: `building:${i}`,
      description: String(c?.description || 'Building charge'),
      amount,
      type: c?.type ? String(c.type) : undefined,
      buildingName: c?.buildingName ? String(c.buildingName) : undefined
    });
  });

  // VAT — aggregated scalar. No per-line description; renderer derives
  // the label from the category.
  const sumAmounts = (arr) =>
    Array.isArray(arr)
      ? arr.reduce((s, x) => s + (Number(x?.amount) || 0), 0)
      : 0;
  const vat = _round(Number(rent?.vat) || sumAmounts(rent?.vats));
  if (vat > 0.005) {
    lines.push({
      category: 'vat',
      lineKey: 'vat',
      description: '',
      amount: vat
    });
  }

  // Extra charge — settlement-origin debts, aggregated scalar.
  const extracharge = _round(
    Number(rent?.extracharge) || sumAmounts(rent?.debts)
  );
  if (extracharge > 0.005) {
    lines.push({
      category: 'extracharge',
      lineKey: 'extracharge',
      description: '',
      amount: extracharge
    });
  }

  return lines;
}

/**
 * Is every euro the month bills on one of its lines? Only then can money — a
 * carried credit, a saved payment — be spread over the lines; otherwise it
 * would be spent on the listed lines alone and the month would list too
 * little.
 *
 * It is not when the row says the month bills VAT (billsVat): the window has
 * no VAT line. And it is not whenever the lines, less the month's discounts,
 * do not add up to the month's own bill (`totalToPay` minus what it carried
 * in), whatever the reason. One that the row does not say: a VAT lease in a
 * month with no rent line still bills the VAT of an extra charge, with
 * `vatAmount` 0 and the extra charge shown net — bill 62, listed 50; counting
 * every euro then listed nothing where 12 was owed.
 *
 * A row without a usable total is not «whole» either.
 */
export function listsWholeBill(rent) {
  if (!rent || billsVat(rent)) return false;
  const total = _figure(rent.totalToPay);
  const carriedIn =
    rent.balance === null || rent.balance === undefined
      ? 0
      : _figure(rent.balance);
  if (total === null || carriedIn === null) return false;
  const listed = _ownLines(rent).reduce((sum, l) => sum + l.amount, 0);
  const discounts = (
    Array.isArray(rent.discounts) ? rent.discounts : []
  ).reduce((sum, d) => sum + (Number(d?.amount) || 0), 0);
  return Math.abs(listed - discounts - (total - carriedIn)) < 0.005;
}

/**
 * Build the per-line owed list for a single rent. The frontdata-shaped
 * rent (services/api/src/managers/frontdata.ts) is what arrives at the
 * dialog — it exposes the same source arrays as the persisted shape
 * (`preTaxAmounts`, `charges`, `buildingCharges`, `vats`, `debts`) plus
 * the flattened totals (`balance`, `totalAmount`, `extracharge`,
 * `discount`).
 */
export function computeOwedLines(rent) {
  if (!rent) return [];
  const lines = [];

  // Carry-forward from prior month — first in spread order.
  // Scalar categories (previousBalance/vat/extracharge) carry no per-
  // line description; the renderer derives the Greek label from the
  // category itself. Storing an empty description keeps the upstream
  // contract simple: description is the user-facing per-line text only
  // when the underlying source array entry has one.
  const balance = Math.max(0, Number(rent?.balance) || 0);
  if (balance > 0.005) {
    lines.push({
      category: 'previousBalance',
      lineKey: 'previousBalance',
      description: '',
      amount: _round(balance)
    });
  }

  lines.push(..._ownLines(rent));

  // A credit carried in from an earlier, overpaid month has already paid for
  // part of this month. Take it off the lines in the order a payment fills
  // them, so the window asks only for what the month still needs — listing
  // the full bill invited the landlord to collect a covered month again.
  // Only when the lines hold the whole bill (listsWholeBill).
  let credit = _round(Math.max(0, -(Number(rent?.balance) || 0)));
  if (credit > 0.005 && listsWholeBill(rent)) {
    for (const line of lines) {
      if (credit <= 0.005) break;
      const used = _round(Math.min(credit, line.amount));
      line.amount = _round(line.amount - used);
      credit = _round(credit - used);
    }
    return lines.filter((line) => line.amount > 0.005);
  }

  return lines;
}

/**
 * Auto-spread a payment amount across owed lines (oldest-first).
 * Returns an allocation array suitable for persistence:
 *   [{ category, lineKey, amount }, ...]
 *
 * `lines` MUST come from computeOwedLines — the input order is the
 * spread order.
 */
export function autoSpreadAllocation(amount, lines) {
  let remaining = _round(amount);
  const out = [];
  for (const line of lines || []) {
    if (remaining <= 0) break;
    const due = Number(line?.amount) || 0;
    if (due <= 0) continue;
    const apply = _round(Math.min(remaining, due));
    if (apply > 0) {
      out.push({
        category: line.category,
        lineKey: line.lineKey,
        amount: apply
      });
      remaining = _round(remaining - apply);
    }
  }
  return out;
}

/**
 * Apply an allocation array to a line list. Returns:
 *   - remainingLines: the same shape as `lines` with each line's
 *     `amount` decremented by what was allocated to it (clamped at 0).
 *   - creditToNextMonth: surplus when the allocation total exceeds the
 *     sum of owed line amounts.
 *   - remainingTotal: sum of remainingLines amounts.
 *
 * Match strategy: prefer exact-match by lineKey; fall back to the
 * first line of the same category for legacy {category, amount}
 * allocations that don't carry a lineKey.
 */
export function applyAllocation(lines, allocation) {
  const remainingLines = (lines || []).map((l) => ({ ...l }));
  let allocSum = 0;
  for (const entry of allocation || []) {
    if (!entry) continue;
    const amt = Number(entry.amount) || 0;
    if (amt <= 0) continue;
    allocSum += amt;
    let toApply = amt;
    const ek = entry.lineKey;
    const ec = entry.category;
    for (const line of remainingLines) {
      if (toApply <= 0.005) break;
      if (line.amount <= 0.005) continue;
      const matches = ek ? line.lineKey === ek : line.category === ec;
      if (!matches) continue;
      const take = _round(Math.min(toApply, line.amount));
      line.amount = _round(line.amount - take);
      toApply = _round(toApply - take);
      if (ek) break;
    }
  }
  const owedTotal = (lines || []).reduce(
    (s, l) => s + (Number(l?.amount) || 0),
    0
  );
  const creditToNextMonth = _round(Math.max(0, allocSum - owedTotal));
  const remainingTotal = _round(
    remainingLines.reduce((s, l) => s + (Number(l?.amount) || 0), 0)
  );
  return { remainingLines, creditToNextMonth, remainingTotal };
}

// A legacy attribution names a bucket, not a line.
const _LEGACY_BUCKETS = {
  expenses: ['propertyCharge', 'buildingCharge'],
  repairs: ['repair']
};

/**
 * What is still owed on each line once the payments ALREADY SAVED on the month
 * are counted. `lines` is `computeOwedLines(rent)`; returns the same shape.
 *
 * Every euro received on the month counts, whatever it was attributed to when
 * it was saved. An attribution is honoured first; but the line it names can
 * have shrunk or gone since (the previous balance was later paid on its own
 * month, a credit arrived and now covers the line, the month was re-priced),
 * and a payment can carry no attribution at all (recorded before attributions
 * existed, or the surplus of an overpayment). Money that finds no room on the
 * line it names settles what is still owed, in the order a payment fills the
 * lines. Dropping it listed a settled month's lines as owed and invited the
 * landlord to collect them again.
 *
 * This holds for lines that add up to the month's bill (listsWholeBill). Use
 * `owedLinesOf`, which leaves any other month to the old rule.
 *
 * The lines then add up to the row's «Υπόλοιπο» (total due minus paid), except
 * on a month with a discount: lines are listed before discounts.
 */
export function owedAfterSavedPayments(lines, savedPayments) {
  const remainingLines = (lines || []).map((l) => ({ ...l }));
  let unplaced = 0;
  for (const payment of savedPayments || []) {
    const amount = Math.max(0, Number(payment?.amount) || 0);
    let attributed = 0;
    const allocation = Array.isArray(payment?.allocation)
      ? payment.allocation
      : [];
    for (const entry of allocation) {
      const amt = Number(entry?.amount) || 0;
      if (amt <= 0) continue;
      attributed = _round(attributed + amt);
      let toApply = amt;
      const ek = entry.lineKey;
      const categories = _LEGACY_BUCKETS[entry.category] || [entry.category];
      for (const line of remainingLines) {
        if (toApply <= 0.005) break;
        if (line.amount <= 0.005) continue;
        const matches = ek
          ? line.lineKey === ek
          : categories.includes(line.category);
        if (!matches) continue;
        const take = _round(Math.min(toApply, line.amount));
        line.amount = _round(line.amount - take);
        toApply = _round(toApply - take);
        if (ek) break;
      }
      unplaced = _round(unplaced + toApply);
    }
    unplaced = _round(unplaced + Math.max(0, amount - attributed));
  }
  for (const line of remainingLines) {
    if (unplaced <= 0.005) break;
    if (line.amount <= 0.005) continue;
    const take = _round(Math.min(unplaced, line.amount));
    line.amount = _round(line.amount - take);
    unplaced = _round(unplaced - take);
  }
  return remainingLines;
}

/**
 * The lines of the payment window for one month: what is owed on each, once
 * the payments already saved on the month are counted.
 *
 * A month whose lines hold its whole bill (listsWholeBill): every euro
 * received counts (owedAfterSavedPayments), after a carried credit
 * (computeOwedLines).
 *
 * Any other month — one that bills VAT, above all — is listed as it always
 * was: each saved attribution comes off the line it names and nothing else is
 * counted (applyAllocation), and a carried credit is not taken off. Money
 * cannot be spread over lines that are not the whole bill: counting every euro
 * listed 280 on a month that still owed 400 of rent, and nothing on a month
 * that still owed its extra charge. Listing such a month properly needs the
 * VAT line itself.
 */
export function owedLinesOf(rent, savedPayments) {
  const lines = computeOwedLines(rent);
  if (listsWholeBill(rent)) {
    return owedAfterSavedPayments(lines, savedPayments);
  }
  const attributions = (savedPayments || [])
    .flatMap((p) => (Array.isArray(p?.allocation) ? p.allocation : []))
    .filter((a) => a && Number(a.amount) > 0);
  return applyAllocation(lines, attributions).remainingLines;
}

/**
 * Group the line list into the 4 top-level pie categories so the
 * dialog can show grouped subtotals if needed:
 *   enoikio: rent
 *   epi-tou-enoikiou: propertyCharge
 *   koinoxrhsta: buildingCharge (non-repair)
 *   episkeues: repair
 * vat / previousBalance / extracharge are NOT in the 4-category split
 * (they sit alongside as their own concepts).
 */
export const TOP_CATEGORY_ORDER = [
  'previousBalance',
  'rent',
  'propertyCharge',
  'buildingCharge',
  'repair',
  'vat',
  'extracharge'
];
