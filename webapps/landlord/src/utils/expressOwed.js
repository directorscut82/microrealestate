const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * What «Έξπρες εξόφληση» offers for one row of the rents page, split the way
 * the drawer shows it: `monthly` (what this month's own bill still needs) and
 * `carry` (what is still owed from earlier months).
 *
 * The amount that is actually recorded is decided on the server by
 * `_expressNetOwed` (services/api/src/managers/rentmanager.ts) — keep the two
 * in step, or the drawer shows one figure and records another.
 *
 * `rent` is a row as the API returns it: `totalWithoutBalanceAmount` (the
 * month's own bill), `balance` (carried in: positive = owed from before,
 * negative = credit) and `payment` (already paid on this month).
 */
export function expressOwed(rent) {
  const carriedIn = Number(rent?.balance) || 0;
  // A credit carried in from an earlier, overpaid month has already paid for
  // part of this month's bill. Offering the full bill again recorded a
  // payment nobody made.
  let monthly = Math.max(
    0,
    (Number(rent?.totalWithoutBalanceAmount) || 0) + Math.min(0, carriedIn)
  );
  let carry = Math.max(0, carriedIn);
  // What is already paid on this month settles the carried debt first, then
  // the month itself.
  let paid = Math.max(0, Number(rent?.payment) || 0);
  if (paid > 0 && carry > 0) {
    const used = Math.min(paid, carry);
    carry -= used;
    paid -= used;
  }
  if (paid > 0 && monthly > 0) {
    monthly -= Math.min(paid, monthly);
  }
  return { monthly: round2(monthly), carry: round2(carry) };
}
