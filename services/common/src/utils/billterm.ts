/**
 * Does a bill's term fall INSIDE the active range of the expense it is attached to?
 *
 * WHY THIS EXISTS. A bill carries the month it covers (`term`, YYYYMMDDHH). The
 * expense it is attached to carries `startTerm` and optionally `endTerm`. When the
 * bill's term is outside that range, the rent engine does not charge the expense for
 * that month at all — so the bill's amount is recorded and then lands on NO surface.
 * It is not an error anywhere: the bill saves, the expense exists, the money simply
 * never appears. Absent representation, on a money surface.
 *
 * This happened in live data: a ΔΕΗ bill for June 2026 attached to an expense whose
 * `startTerm` is August 2026. €120 recorded, €0 charged, nothing said.
 *
 * The upload dialog already warned about it (T5) by re-deriving the comparison
 * inline. The Telegram ingest path did not warn at all — it hardcoded
 * `warnings: []`. Two ingest doors, one rule, and only one of them enforced it: the
 * same defect shape as the duplicated bill matcher and the duplicated κυμαινόμενο
 * inference. So the rule lives here, once.
 *
 * Deliberately moment-free and comparison-only: terms are numeric YYYYMMDDHH, so
 * ordering is plain integer ordering and there is no timezone in the question. Every
 * `moment.utc` vs `moment` mismatch in this repo came from turning a term into a date
 * when it did not need to be one.
 */

export interface TermRangeLike {
  /** YYYYMMDDHH, e.g. 2026080100. */
  startTerm?: number | string | null;
  endTerm?: number | string | null;
}

export type BillTermFit =
  | { fits: true }
  /** The expense begins after the month the bill covers. */
  | { fits: false; reason: 'before-start'; startTerm: number }
  /** The expense ended before the month the bill covers. */
  | { fits: false; reason: 'after-end'; endTerm: number }
  /** No startTerm at all — the expense is charged for no month whatsoever. */
  | { fits: false; reason: 'no-start' };

function toTerm(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  // A term is a 10-digit YYYYMMDDHH. Anything else is not comparable, and guessing
  // would produce a confident wrong answer about money.
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/**
 * @param expense the expense the bill is (or would be) attached to
 * @param billTerm the month the bill covers, YYYYMMDDHH
 */
export function billTermFitsExpense(
  expense: TermRangeLike | null | undefined,
  billTerm: number | string | null | undefined
): BillTermFit {
  const term = toTerm(billTerm);
  const start = toTerm(expense?.startTerm);
  const end = toTerm(expense?.endTerm);

  // Unknown bill term: say nothing rather than warn on a comparison we cannot make.
  // A false warning on every bill trains the operator to dismiss the real one.
  if (term === null) return { fits: true };

  if (start === null) return { fits: false, reason: 'no-start' };
  if (term < start) return { fits: false, reason: 'before-start', startTerm: start };
  if (end !== null && term > end) return { fits: false, reason: 'after-end', endTerm: end };
  return { fits: true };
}

/** True when the bill's month is one the expense is NOT charged for. */
export function billTermIsOutsideExpense(
  expense: TermRangeLike | null | undefined,
  billTerm: number | string | null | undefined
): boolean {
  return !billTermFitsExpense(expense, billTerm).fits;
}

/**
 * WHICH MONTH a bill's amount is charged in.
 *
 * THE RULE: the month the bill was ISSUED, falling back to the end of the period it
 * covers when no issue date was read.
 *
 * WHY NOT periodEnd, which is what both copies of this used to do. A bill's period is
 * what it MEASURES; its issue date is when it becomes something the landlord can act
 * on. The two are routinely different months, and for ΕΥΔΑΠ they are always different
 * — meters are read quarterly, so a bill measuring 28/04–23/07 is issued on 04/08 and
 * payable by 01/09. Keying the term to periodEnd charged it to JULY: a month whose
 * κοινόχρηστα statement may already be issued to the tenants, whose rents may already
 * be paid, and which the engine may treat as frozen. The landlord receives it in
 * August, pays it in August, and charges it in August.
 *
 * It also removes a whole failure class. `periodEnd` can precede the expense's
 * `startTerm` while `issueDate` does not, which is the shape that put a June bill on
 * an August expense and left €120 charged to nobody (see billTermFitsExpense above).
 * The issue date is never earlier than the period it bills, so it can only ever
 * propose a month at or after the one periodEnd would have.
 *
 * UTC throughout: the term is read back with getUTCMonth elsewhere, and an Athens
 * summer local Date (UTC+3) turns a 01/08 boundary into July 31 21:00Z and charges
 * the whole bill to the wrong month.
 *
 * This lived as TWO byte-identical private copies — `billmanager.ts` and
 * `telegramInboxScanner.ts` — so the upload lane and the bot lane each decided the
 * charge month for themselves. Exactly the shape of the duplicated bill matcher and
 * the duplicated κυμαινόμενο inference before them.
 */
export function computeChargeTerm(bill: {
  issueDate?: Date | string | null;
  periodEnd?: Date | string | null;
}): number | undefined {
  const pick = (v: unknown): Date | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isFinite(d.getTime()) ? d : null;
  };
  const anchor = pick(bill?.issueDate) || pick(bill?.periodEnd);
  if (!anchor) return undefined;
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + 1;
  return year * 1000000 + month * 10000 + 100;
}
