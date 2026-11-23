// Which shares of building charges a tenant's rents already hold.
//
// A tenant share of a building charge whose own month is closed for that tenant is
// billed on the tenant's next open month (tasks/1_base.ts `_carriedInto`,
// DEFERRED_DECISIONS D-10). Where it is billed is never stored: every time a month is
// priced the engine asks «is this share already on a closed rent?», and the screens ask
// the same question to say where a share went (managers/chargecarry.ts). The two must
// give the same answer, so both ask it here and nowhere else.
//
// No database, no clock: plain data in, plain data out.

/** A building line of a rent, as far as this question goes. */
export type HeldLine = {
  // the rent the line is on
  rentTerm: number;
  // the month the share is FOR: the rent's own, or an earlier one for a carried line
  month: number;
  // '' when the line names no unit / no expense (lines stored before lines carried ids)
  propertyId: string;
  expenseId: string;
  buildingName: string;
  description: string;
  amount: number;
};

/** A unit's row for one expense and month, as far as this question goes. */
export type ShareRow = {
  propertyId: string;
  expenseId: string;
  month: number;
  // `carry: true` — written by a statement save as a share that did not exist before
  marked: boolean;
  // what the row's line says on a rent
  description: string;
  buildingName: string;
  // the row's `_id` as text: rows sort by it in the order they were created
  created: string;
  // the unit's share as the building holds it today
  amount?: number;
  // did the tenant hold the unit in the row's month? (yes when not given)
  held?: boolean;
};

/** What `coverRows` answers. */
export type Covered<Row> = {
  // the rows a line of a closed rent stands for: one line, one row
  covered: Map<Row, HeldLine>;
  // rows an OLD line may be for, though no line is known to be (see `coverRows`): they
  // are not billed again, and nothing says they were billed
  unsure: Set<Row>;
};

type AnyRecord = Record<string, any>;

// A month as a ledger stores it: a number, or — in a ledger that was restored or
// written by hand — the same ten digits as text. Anything else is no month.
const _term = (value: unknown): number | null =>
  typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{10}$/.test(value)
      ? Number(value)
      : null;

/**
 * The building lines of the given rents that are shares of an expense. Repair lines are
 * not: a repair is never carried, and one that happens to be called like an expense is
 * not that expense's share. (A repair line stored before lines carried ids has no
 * `repairId`; its `type` says what it is.)
 */
export function heldLinesOf(rents: AnyRecord[] | undefined): HeldLine[] {
  const held: HeldLine[] = [];
  for (const rent of Array.isArray(rents) ? rents : []) {
    const rentTerm = _term(rent?.term);
    if (rentTerm === null) continue;
    const lines: unknown = rent.buildingCharges;
    for (const line of (Array.isArray(lines) ? lines : []) as AnyRecord[]) {
      if (!line || typeof line !== 'object') continue;
      if (line.repairId || line.type === 'repair') continue;
      held.push({
        rentTerm,
        // a line billed here for an earlier month says so; any other is this month's
        month:
          line.expenseId && Number.isInteger(line.forTerm)
            ? line.forTerm
            : rentTerm,
        propertyId: String(line.propertyId ?? ''),
        expenseId: String(line.expenseId ?? ''),
        buildingName: String(line.buildingName ?? ''),
        description: String(line.description ?? ''),
        amount: Number(line.amount) || 0
      });
    }
  }
  return held;
}

/**
 * Which of a tenant's rows are on a rent already, and by which line. One line covers one
 * row at most, and a row that is covered is never billed again.
 *
 * `rows`: EVERY row of the tenant's units that the question could be about — marked or
 * not, in a month the tenant held the unit or not (`held`). A row that is left out is
 * not «not billed»: the line it was billed with is then taken for another row's.
 * `held`: `heldLinesOf` the tenant's rents. `liveExpenseIds`: the expenses that exist
 * today in the buildings of those units. `tenantUnits`: the units the tenant has or had
 * (all of them when not given).
 *
 * In this order:
 *   1. A line of an expense that exists covers the row of ITS OWN unit for that
 *      expense and month. Never another unit's while its own unit has one: a tenant
 *      with two units has two shares, and one line is not both.
 *   2. An OLD line — of no living expense: stored before lines carried ids, or of an
 *      expense that was deleted since (and perhaps created again) — that NAMES a unit
 *      is for a row of that unit, same month, that reads the same (building name,
 *      description) and that no line covers yet. Unless the rows that read like it are
 *      of two or more expenses (namesakes): the unit then says too little — the share
 *      may have moved to another unit while a namesake's row sits on this one — and
 *      the line goes on to rule 4.
 *   3. A line of rule 1 whose unit has no row for that expense and month (any more)
 *      stands in for one other row of that expense and month — the share of a tenant
 *      with two units sits on one of them when the split is per tenant, and can move to
 *      the other when the split is run again. It takes the row that would otherwise be
 *      billed: one of a month the tenant held the unit, that no old line has put in
 *      doubt, and that is marked (that is what a moved share is) — before any other.
 *      Only a unit of the tenant's can stand in.
 *   4. What is left of the old lines — the ones that name no unit, and the ones whose
 *      unit has no free row that reads the same (none at all, or only rows that their
 *      own lines cover: a namesake's) — is for a row of the same month that reads the
 *      same, of any unit.
 *
 * AN OLD LINE THAT COULD BE FOR SEVERAL ROWS. It says a name and an amount, nothing
 * else. With one row that reads like it there is nothing to decide. With several, the
 * app does not guess with a tenant's money: guessing wrong bills a share twice. The
 * line is SHOWN against the row it most likely was billed for (the one with exactly its
 * amount, then one of a month the tenant held the unit, then one that was there before
 * the mark existed, then the nearest amount, then the oldest) — that row is `covered` —
 * and every other row it could be for is `unsure`: not known to be billed, and never
 * billed again. Two earlier versions guessed and carried the rest; each was broken by
 * review with a history that billed twice.
 */
export function coverRows<Row extends ShareRow>(
  rows: Row[],
  held: HeldLine[],
  liveExpenseIds: Set<string>,
  options: { tenantUnits?: Set<string> } = {}
): Covered<Row> {
  const covered = new Map<Row, HeldLine>();
  const unsure = new Set<Row>();
  if (!rows?.length || !held?.length) return { covered, unsure };

  // by month, each month in the order its rows were created (stable for equal ids)
  const byMonth = new Map<number, Row[]>();
  rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) =>
      a.row.created < b.row.created
        ? -1
        : a.row.created > b.row.created
          ? 1
          : a.at - b.at
    )
    .forEach(({ row }) => {
      if (!byMonth.has(row.month)) byMonth.set(row.month, []);
      byMonth.get(row.month)!.push(row);
    });
  const free = (row: Row) => !covered.has(row);
  const isTenants = (propertyId: string) =>
    !propertyId || !options.tenantUnits || options.tenantUnits.has(propertyId);
  // the first of `candidates` (they come oldest first) with the lowest rank
  const first = (candidates: Row[], rank: (row: Row) => number[]): Row => {
    let best = candidates[0];
    let bestRank = rank(best);
    for (const row of candidates.slice(1)) {
      const its = rank(row);
      const at = its.findIndex((n, i) => n !== bestRank[i]);
      if (at !== -1 && its[at] < bestRank[at]) {
        best = row;
        bestRank = its;
      }
    }
    return best;
  };
  // An old line and the free rows it could be for: with one there is nothing to
  // decide; with several it is shown against the likeliest, and the others are unsure.
  const place = (candidates: Row[], line: HeldLine) => {
    if (!candidates.length) return;
    const shown =
      candidates.length === 1
        ? candidates[0]
        : first(candidates, (row) => {
            const apart =
              row.amount === undefined
                ? 0
                : Math.round(Math.abs(row.amount - line.amount) * 100);
            return [
              apart === 0 ? 0 : 1,
              row.held === false ? 1 : 0,
              row.marked ? 1 : 0,
              apart
            ];
          });
    covered.set(shown, line);
    candidates.forEach((row) => {
      if (row !== shown) unsure.add(row);
    });
  };
  const alikeOf = (line: HeldLine): Row[] =>
    (byMonth.get(line.month) || []).filter(
      (r) =>
        r.description === line.description &&
        r.buildingName === line.buildingName
    );

  const standIns: HeldLine[] = [];
  const old: HeldLine[] = [];
  // 1.
  for (const line of held) {
    const ofMonth = byMonth.get(line.month);
    if (!ofMonth) continue;
    const ofExpense = line.expenseId
      ? ofMonth.filter((r) => r.expenseId === line.expenseId)
      : [];
    if (
      line.expenseId &&
      (liveExpenseIds.has(line.expenseId) || ofExpense.length > 0)
    ) {
      const ofUnit = ofExpense.filter((r) => r.propertyId === line.propertyId);
      const own = ofUnit.find(free);
      if (own) covered.set(own, line);
      else if (ofUnit.length === 0) standIns.push(line);
      // else: its unit's row is covered already — a second line covers nothing more
    } else {
      old.push(line);
    }
  }
  // 2.
  const unnamed: HeldLine[] = [];
  for (const line of old) {
    const alike = alikeOf(line);
    const namesakes = new Set(alike.map((r) => r.expenseId)).size > 1;
    const ofUnit =
      line.propertyId && !namesakes
        ? alike.filter((r) => r.propertyId === line.propertyId && free(r))
        : [];
    if (!ofUnit.length) {
      unnamed.push(line);
      continue;
    }
    place(ofUnit, line);
  }
  // 3.
  for (const line of standIns) {
    if (!isTenants(line.propertyId)) continue;
    const others = byMonth
      .get(line.month)!
      .filter((r) => r.expenseId === line.expenseId && free(r));
    if (!others.length) continue;
    covered.set(
      first(others, (row) => [
        row.held === false ? 1 : 0,
        unsure.has(row) ? 1 : 0,
        row.marked ? 0 : 1
      ]),
      line
    );
  }
  // 4.
  for (const line of unnamed) {
    if (!isTenants(line.propertyId)) continue;
    place(alikeOf(line).filter(free), line);
  }
  // a row that another line turned out to cover is not unsure
  covered.forEach((_line, row) => unsure.delete(row));
  return { covered, unsure };
}
