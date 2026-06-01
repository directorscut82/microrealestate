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
 * Mirrors services/api/src/managers/rentmanager.ts _computeOwedLines.
 * Keep the two in sync.
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
