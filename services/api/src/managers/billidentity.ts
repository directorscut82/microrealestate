/**
 * Physical-bill identity — BILL-IDENTITY (bill-OCR audit 2026-07).
 *
 * THE BUG THIS EXISTS FOR. A Bill's stored identity is the unique index
 * `{realmId, buildingId, expenseId, term}` (services/common/src/collections/
 * bill.ts:66-69). `term` is DERIVED from the OCR'd `periodEnd` by
 * computeDefaultTerm, and that derivation is fallible — a re-photographed bill
 * whose `Περίοδος Κατανάλωσης` end date reads one day differently (or is parsed
 * across the Athens UTC+3 boundary, see billparser/deh.ts:37) lands in a
 * different month. The upsert at billmanager.ts findOneAndUpdate then sees a
 * fresh key and INSERTS a second Bill for the same physical λογαριασμός, and
 * bridgeChargeToStatement charges the tenants in two different months.
 *
 * The parse-time probe at billmanager.ts (`existingAmount`) cannot catch this:
 * it queries by that same derived term, so on divergence it matches nothing and
 * the dialog shows no warning at all.
 *
 * WHY THIS IS ADVISORY, NOT A BLOCK. It reports; it never rejects a write.
 *  - A unique index on a physical-identity key would abort its own build if
 *    production already holds a divergent pair, and there is no safe automatic
 *    winner: the two docs can carry different `receipts[]` / `paymentProofUrl` /
 *    `originalTotalAmount`. Collapsing them is a money decision an operator
 *    makes, not a migration.
 *  - `rfCode` is legitimately absent for non-DEH providers and for
 *    checksum-rejected OCR (deh.ts:137 leaves it undefined on mod-97 failure),
 *    so it cannot carry a uniqueness constraint.
 * A false positive therefore costs one amber line; a false negative costs a
 * double tenant charge. That asymmetry is why the arms below are tuned to be
 * precise rather than eager — an over-firing banner trains the operator to
 * ignore the one warning that matters, which is the same defect as not warning.
 *
 * Deliberately its OWN module rather than a billmanager export: it imports only
 * `Collections`, so the Telegram scanner can reach it without pulling the PDF
 * parser + axios into a job module, and its unit suite needs a one-key
 * `@microrealestate/common` mock instead of billmanager's five.
 */
import { Collections } from '@microrealestate/common';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far two `periodEnd`s may sit apart and still be judged the same physical
 * bill. The failure being detected is a SMALL misread of the period end (a
 * digit, or a timezone-boundary day) that pushed the derived term into an
 * adjacent month, so real drift is 0-3 days. A Greek monthly cycle is ~30 days
 * and even a bimonthly ΕΥΔΑΠ cycle ~60, so 10 days sits an order of magnitude
 * below the gap to a genuine NEXT bill while comfortably covering the misread.
 */
const SAME_BILL_PERIOD_END_TOLERANCE_DAYS = 10;

export interface DuplicateBillMatch {
  /** The term the ALREADY-STORED bill sits at (never the proposed one). */
  term: number;
  totalAmount: number;
  matchedOn: 'rfCode' | 'period';
}

/**
 * Look for an already-stored Bill that is the same PHYSICAL bill as `bill` but
 * filed under a different term. Returns undefined when there is no such bill —
 * which is the overwhelmingly common case.
 *
 * Always scoped to `term: {$ne: proposedTerm}`: a same-term hit is the ordinary
 * re-import/replace case, already reported by billmanager's `existingAmount`
 * probe and handled by its Replace button. Reporting it twice would be noise.
 */
export async function findDuplicateBillByIdentity(
  realmId: string,
  buildingId: string,
  expenseId: string,
  bill: {
    rfCode?: string;
    billingId?: string;
    periodStart?: Date | string;
    periodEnd?: Date | string;
  },
  proposedTerm: number
): Promise<DuplicateBillMatch | undefined> {
  const scope = {
    realmId,
    buildingId,
    expenseId,
    term: { $ne: Number(proposedTerm) }
  };

  // ARM 1 — rfCode. The payment reference is per-bill (it pairs with
  // paymentCode, which encodes the amount, to form the IRIS QR), so equality is
  // a strong signal on its own. Note the invariant is "validated at parse time"
  // (deh.ts:137 runs mod-97 before emitting it) and NOT "guaranteed on the
  // stored doc" — confirmBills persists rfCode from the CLIENT payload
  // (inboxmanager.ts forwards p.rfCode) and bill.ts declares it a plain String
  // with no validator. Strong enough for an advisory banner; do NOT promote
  // this arm to a hard block without re-running isValidRF server-side.
  const rf = typeof bill.rfCode === 'string' ? bill.rfCode.trim() : '';
  if (rf) {
    const hit: any = await Collections.Bill.findOne({
      ...scope,
      rfCode: rf
    }).lean();
    if (hit) {
      return {
        term: Number(hit.term),
        totalAmount: Number(hit.totalAmount) || 0,
        matchedOn: 'rfCode'
      };
    }
  }

  // ARM 2 — billingId + a period END that is within a few days.
  //
  // billingId ALONE must never be an identity key: it is the αριθμός παροχής,
  // IDENTICAL across every monthly bill for that meter (see the same warning at
  // inboxmanager.ts:129-133). It needs a period discriminator, and the
  // discriminator has to distinguish "the same bill, period misread by a day"
  // from "next month's bill for the same meter".
  //
  // Proximity of periodEnd, NOT interval overlap. Overlap is the wrong model:
  // Greek utility periods are quoted with a SHARED boundary date (…–09/07, then
  // 09/07–09/08), so an inclusive overlap test ($lte/$gte) is satisfied by every
  // routine consecutive pair and the banner would fire on nearly every normal
  // monthly import. Two copies of the SAME bill instead have near-identical
  // endpoints — the divergence this hunts for is in the derived term, not in the
  // period itself.
  const start = bill.periodStart ? new Date(bill.periodStart) : null;
  const end = bill.periodEnd ? new Date(bill.periodEnd) : null;
  const billingId =
    typeof bill.billingId === 'string' ? bill.billingId.trim() : '';
  const endValid = !!end && !Number.isNaN(end.getTime());
  const startValid = !!start && !Number.isNaN(start.getTime());
  // Require BOTH bounds: periodStart/periodEnd are schema-required on every
  // stored Bill, so a candidate missing one is a malformed parse and matching it
  // on billingId alone would reintroduce the αριθμός-παροχής weakness above.
  if (billingId && endValid && startValid) {
    const tol = SAME_BILL_PERIOD_END_TOLERANCE_DAYS * DAY_MS;
    const hit: any = await Collections.Bill.findOne({
      ...scope,
      billingId,
      periodEnd: {
        $gte: new Date(end!.getTime() - tol),
        $lte: new Date(end!.getTime() + tol)
      }
    }).lean();
    if (hit) {
      return {
        term: Number(hit.term),
        totalAmount: Number(hit.totalAmount) || 0,
        matchedOn: 'period'
      };
    }
  }

  return undefined;
}
