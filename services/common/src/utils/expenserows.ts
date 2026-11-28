/**
 * Does this stored unit charge (a row of `unit.monthlyCharges`) belong to this expense?
 *
 * A row written by the monthly statement carries the expense's id, and when that id names an
 * expense of the building it decides: a row of one expense is never another expense's,
 * whatever the two are called.
 *
 * A row with NO id — written on 01–03/05/2026, before rows carried one — or with an id that
 * names NO expense of the building (the manual-charge door stores any id it is given) is
 * recognised by its text, and only when exactly ONE expense of the building has that
 * name: the rule the api uses for a row with no id when it saves a month
 * (buildingmanager.ts `saveMonthlyStatement`, «LEGACY BACKFILL»;
 * `_stampLegacyChargesBeforeRename`: «never guess between two candidates»). A row that is
 * nobody's shows in no input, and the next save of its month strips it. The landlord app
 * mirrors this file in `webapps/landlord/src/utils/expenseRows.js`;
 * `expenseRowsParity.test.js` in the api holds the two to the same answers.
 *
 * The readers used to say `expenseId === id || description === name`. With two expenses
 * of one name — one «ΔΕΗ» per apartment, which is what the bill import creates — the
 * text matched a row that carried the OTHER expense's id, so each expense's yearly
 * figure took in the other's months.
 */

interface RowLike {
  expenseId?: unknown;
  repairId?: unknown;
  description?: unknown;
}

interface NamedExpense {
  _id?: unknown;
  name?: unknown;
}

export function isRowOfExpense(
  row: RowLike | null | undefined,
  expense: NamedExpense | null | undefined,
  expenses: Array<NamedExpense | null | undefined> | null | undefined
): boolean {
  if (!row || !expense) return false;
  if (row.expenseId) {
    const id = String(row.expenseId);
    // no list to look the id up in: the id decides, as it always did
    if (!expenses) return id === String(expense._id);
    if (expenses.some((e) => e?._id != null && String(e._id) === id)) {
      return id === String(expense._id);
    }
  }
  if (row.repairId) return false;
  const text = String(row.description || '').trim();
  // 'Repair: …' rows are the repairs' own old rows
  if (!text || /^Repair: /.test(text)) return false;
  const name = String(expense.name || '').trim();
  if (text !== name) return false;
  return (
    (expenses || []).filter((e) => String(e?.name || '').trim() === name)
      .length === 1
  );
}
