/**
 * Does this stored unit charge (a row of `unit.monthlyCharges`) belong to this expense?
 *
 * A row written by the monthly statement carries the expense's id, and that id decides:
 * a row of one expense is never another expense's, whatever the two are called.
 *
 * Only a row with NO id at all — written on 01–03/05/2026, before rows carried one — is
 * recognised by its text, and only when exactly ONE expense of the building has that
 * name: the rule the server uses when it saves a month (buildingmanager.ts
 * `saveMonthlyStatement`, «LEGACY BACKFILL»; `_stampLegacyChargesBeforeRename`:
 * «never guess between two candidates»). Mirrored in services/common
 * `utils/expenserows.ts`.
 *
 * The readers used to say `expenseId === id || description === name`. With two expenses
 * of one name — one «ΔΕΗ» per apartment, which is what the bill import creates — the
 * text matched a row that carried the OTHER expense's id: the month's input of the
 * second «ΔΕΗ» was pre-filled with the figure typed for the first, and the next save of
 * the month billed it to the second apartment's tenant (review of 24/11/2026).
 */
export function isRowOfExpense(row, expense, expenses) {
  if (!row || !expense) return false;
  if (row.expenseId) return String(row.expenseId) === String(expense._id);
  if (row.repairId) return false;
  const text = String(row.description || '').trim();
  // 'Repair: …' rows without an id are the repairs' own old rows
  if (!text || /^Repair: /.test(text)) return false;
  const name = String(expense.name || '').trim();
  if (text !== name) return false;
  return (
    (expenses || []).filter((e) => String(e?.name || '').trim() === name)
      .length === 1
  );
}

/**
 * The figures typed for one monthly (κυμαινόμενο) expense in a year, oldest month first:
 * one per month that holds a row of the expense. Every share of a month carries the figure
 * that was typed (`inputAmount`), so it is taken once; a month whose rows are from before
 * `inputAmount` existed gives the sum of its shares instead.
 */
export function enteredFiguresOfYear(units, expenses, expense, year) {
  const perTerm = new Map(); // term -> { input: number|null, shareSum }
  for (const unit of units || []) {
    for (const c of unit?.monthlyCharges || []) {
      const inYear = Math.floor(Number(c?.term || 0) / 1000000) === year;
      if (!inYear || !isRowOfExpense(c, expense, expenses)) continue;
      const slot = perTerm.get(c.term) || { input: null, shareSum: 0 };
      if (c.inputAmount != null) slot.input = Number(c.inputAmount) || 0;
      else slot.shareSum += Number(c.amount) || 0;
      perTerm.set(c.term, slot);
    }
  }
  return [...perTerm.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => (s.input != null ? s.input : s.shareSum));
}
