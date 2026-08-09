import {
  BillParseResult,
  PartialBillFields,
  normalizeBillingId
} from './types.js';
import { isValidRF } from './matching.js';

function parseGreekAmount(raw: string): number | null {
  // O3 (destructive-write audit 2026-07): last-separator-wins, mirroring
  // matching.parseGreekMoney and the client numberformat.parseGreekMoney, so
  // every amount path parses identically. The OLD logic only normalised when a
  // comma was present, so "1.234" (dot as thousands, no decimal) parsed as
  // 1.234 (÷1000) and "1.234.00" (OCR comma→dot) as 1.234 too. Whichever of
  // '.' / ',' is RIGHTMOST is the decimal separator; the other is thousands.
  const s = raw.replace(/[^\d.,]/g, '');
  if (!s) return null;
  let cleaned: string;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    cleaned = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // Rightmost is a dot. A single dot with exactly 3 trailing digits and no
    // comma is ambiguous (1.234 = 1234 thousands, NOT 1.234) — treat a lone
    // 3-digit group after a dot as a thousands separator (DEH prints no
    // sub-euro-less totals as "1.234"); otherwise the dot is decimal.
    if (/^\d{1,3}\.\d{3}$/.test(s)) {
      cleaned = s.replace(/\./g, '');
    } else {
      cleaned = s.replace(/,/g, '');
    }
  } else {
    cleaned = s;
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseGreekDate(raw: string): Date | null {
  // DD/MM/YYYY format — MUST use UTC to avoid the timezone bug (C4):
  // Athens summer (UTC+3) + local Date → periodEnd 01/08 becomes July 31 21:00Z
  // → computeDefaultTerm (which reads getUTCMonth) maps it to the WRONG month.
  const match = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  const d = parseInt(day);
  const mo = parseInt(month);
  const y = parseInt(year);
  // O8 (destructive-write audit 2026-07): reject calendar-invalid OCR dates
  // rather than let Date.UTC ROLL them over ("31/02/2025" → March 3 → the
  // charge lands in the wrong month). Range-check, then confirm the
  // constructed date's parts round-trip (catches 31/04, 29/02 non-leap, etc.).
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
}

// A LABEL line carries no value of its own. On a CamScanner scan of a ΔΕΗ bill
// the OCR emits the whole label column first and the value column after, so a
// label's value can be 1-2 lines below it — and one of those intervening lines
// is frequently ANOTHER label ("Τιμολόγιο:", "Σκανάρετε"). Skipping label-only
// lines is what makes the bounded lookahead below safe: without it, the first
// non-empty line after «ΕΞΟΦΛΗΣΗ ΕΩΣ» on bill-03 is «Τιμολόγιο:» and a naive
// "next line" rule would find no date and then keep walking into «Επόμενη
// καταμέτρηση»'s date — a DIFFERENT field. Measured against all three real
// scans in ~/Downloads/ΛΟΓΑΡΙΑΣΜΟΙ-SPLIT/bills.
//
// These are the labels that actually appear BETWEEN a label and its value in
// the real corpus. Anything not listed is treated as a value line, so an
// unrecognised interloper ENDS the search (no match → honest failure) instead of
// being skipped over to reach a wrong value further down.
// ONLY labels that carry NO value of their own may appear here. A label that
// OWNS a value must never be skipped: skipping it lets the search walk onto that
// other field's value and pair it with ours. Adversarial review found two such
// bugs from exactly this mistake —
//   · «Επόμενη καταμέτρηση:» owns the NEXT-METER-READING date, and skipping it
//     made that date the payment due date (a late-fee-causing lie);
//   · «Εκκαθαριστικός» / «λογαριασμός» precede the Α/Α ΛΟΓΑΡΙΑΣΜΟΥ serial, and
//     skipping them made a 10-digit serial the αριθμός παροχής, which matches the
//     bill to the wrong expense (or creates a new έξοδο every month, since the
//     serial changes).
// Both are therefore NOT in this list. What remains is tariff-name and
// call-to-action text, which is genuinely value-less on every real scan.
// «Διεύθυνση ακινήτου» is also excluded — it owns the address lines.
const DEH_INTERLEAVED_LABELS =
  /^(?:Τ[υψι]?ολόγιο\s*:?|Τιμολόγιο\s*:?|Σκανάρετε|για άμεση εξόφληση|Ειδικό\s*τιμολόγιο|ΓΝ .*Τιμολόγιο)$/i;

/**
 * Find a field's value when the OCR has split it onto a line BELOW its label.
 *
 * Deliberately conservative — this runs on money-bearing fields (the period
 * decides which month the tenants are charged, and the dialog renders the period
 * as STATIC TEXT the operator cannot correct: BillImportDialog.js «Period»).
 * So it must never PAIR A LABEL WITH ANOTHER FIELD'S VALUE; returning null and
 * failing the parse is the correct outcome when the layout is unrecognised.
 *
 * Rules:
 *  - the label must be found (case-insensitive);
 *  - the value may be on the label's own line (preferred), else on one of the
 *    next `maxLookahead` lines;
 *  - blank lines and lines that are themselves KNOWN labels are skipped;
 *  - any OTHER non-matching line stops the search (a value line that isn't the
 *    value we want means the columns don't pair the way we assumed).
 */
function findLabelledValue(
  text: string,
  label: RegExp,
  valuePattern: RegExp,
  maxLookahead = 3,
  // Optional extra test the candidate must pass (e.g. "is not a freephone
  // number"). Applied to BOTH the same-line and lookahead branches.
  accept?: (candidate: string) => boolean
): string | null {
  const ok = (candidate: string | undefined | null): boolean =>
    !!candidate && (!accept || accept(candidate));
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const hit = lines[i].match(label);
    if (!hit || hit.index === undefined) continue;
    // Same-line: take only the text AFTER the label, never the whole line.
    //
    // `replace(label,' ')` deletes the label but LEAVES the rest of the line,
    // and the date pattern is unanchored — so on the pdfjs digital path, where
    // `extractTextFromPdf` joins an entire page with spaces into ONE line, the
    // match returned the FIRST date anywhere on the page rather than the label's
    // own. Adversarial review measured issueDate and dueDate both collapsing to
    // the period's start date. Slicing from the end of the label match confines
    // the search to that label's own text, which is what the "same line" case
    // means. `.trim()` matters too: an anchored valuePattern (`^…$`, which the
    // supply pattern is) can't match a leading space.
    const after = lines[i].slice(hit.index + hit[0].length).trim();
    const sameLine = after.match(valuePattern);
    if (sameLine && ok(sameLine[0])) return sameLine[0];
    for (let j = i + 1; j <= i + maxLookahead && j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (DEH_INTERLEAVED_LABELS.test(line)) continue;
      const m = line.match(valuePattern);
      if (m && ok(m[0])) return m[0];
      // A non-empty, non-label line that does NOT hold the expected value shape
      // means we have walked out of this label's column. Stop rather than keep
      // hunting for a plausible-looking value that belongs to another field.
      break;
    }
  }
  return null;
}

// A ΔΕΗ provision number, as it appears on the real scans: 9-12 DIGITS,
// optionally grouped with spaces and carrying a `-NN` check-suffix
// ("9 99935585-016", "999935585-016", "999935585016").
//
// Anchored to the whole line so a bare year, an amount, or an Α/Α λογαριασμού on
// the following line cannot pass as a παροχή — and the DIGIT COUNT is bounded
// explicitly rather than via the character-class length. The looser
// `^\d[\d \t-]{7,20}\d$` form accepted ΔΕΗ's own freephone number
// `800-900-1000`, which is printed on every bill: had a παροχή label ever landed
// above it, that phone number would have become the billing ID and matched the
// bill to the wrong expense (or created a bogus one).
// SHAPE only: digits, optionally grouped with spaces/tabs, optionally carrying a
// `-NN(N)` check-suffix. The DIGIT COUNT is checked separately in
// isPlausibleSupplyNumber — deliberately NOT folded in here.
//
// An earlier version of this line tried to do both at once with a counting
// lookahead, `^(?=(?:[\d \t-]*\d){9,12}[\d \t-]*$)…`, and that was wrong twice
// over (both found by adversarial review):
//   1. CATASTROPHIC BACKTRACKING. The inner class `[\d \t-]*` contains the very
//      digit the quantifier counts, so a subject that fails the final anchor gets
//      re-partitioned exponentially: MEASURED 176ms at 5 digit-groups, 1.5s at 7,
//      9.3s at 8 — on a 41-character line. Node is single-threaded, so that is
//      the WHOLE api service stalled, and the trigger is an ordinary grouped-digit
//      OCR row (the real ΕΥΔΑΠ scan already carries a 5-group one), reachable from
//      the Telegram photo path as well as the upload.
//   2. THE UPPER BOUND DIDN'T EXIST. `{9,12}` counted ITERATIONS, not digits, and
//      an iteration could absorb many digits — so 13, 18, 25-digit runs all passed.
//      A real ΕΥΔΑΠ ΑΡΙΘΜΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ («2026 0009 9990 0000 01», 18 digits) was
//      accepted as a παροχή, which is a wrong billing key: it matches no expense,
//      or the wrong one, and the create-expense prefill would stamp it onto a new
//      δαπάνη permanently.
const DEH_SUPPLY_VALUE = /^\d[\d \t]*(?:-\d{2,3})?[\d \t]*$/;

// ΔΕΗ prints its own freephone numbers on every bill («800-900-1000»,
// «800 400 4000»). They are 9-10 digits and would otherwise satisfy
// DEH_SUPPLY_VALUE, so a παροχή label landing above one would turn a support
// line into a billing ID. Greek service numbers start 800/801/807; no παροχή
// does. Checked as a predicate rather than folded into the regex, because a
// negative lookahead there made the pattern unreadable for the next reader.
const GREEK_SERVICE_NUMBER = /^80[017][\d \t-]*$/;

// A ΔΕΗ provision number carries 9-12 digits once separators are stripped. Two
// real imposters this rejects, both taken from the corpus: an 8-digit meter
// reading below, and an 18-digit ΑΡΙΘΜΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ above. Counted on the
// stripped string — a plain `replace` + `test` is linear, so it also removes the
// backtracking cliff the counting lookahead had.
const DEH_SUPPLY_DIGITS = /^\d{9,12}$/;

function isPlausibleSupplyNumber(value: string): boolean {
  const line = value.trim();
  if (!DEH_SUPPLY_DIGITS.test(line.replace(/[ \t-]/g, ''))) return false;
  if (!DEH_SUPPLY_VALUE.test(line)) return false;
  if (GREEK_SERVICE_NUMBER.test(line)) return false;
  return true;
}
const DATE_VALUE = /\d{2}\/\d{2}\/\d{4}/;

export function parseDehBill(text: string): BillParseResult {
  // Extract billing ID - handle both full and abbreviated forms:
  // "Αριθμός παροχής 9 99935585-03 2"   (label and value on ONE line)
  // "Αρ. παροχής: 9 99935585-03 2"
  //   ...and the CamScanner scan layout, where they are on TWO lines:
  // "Αριθμός παροχής" / "9 99935585-016"
  //
  // The same-line value class stays [\d \t-] (NOT \s) so it cannot cross a
  // newline and swallow the next line's digits — that was the original fix here.
  // The two-line case is handled by findLabelledValue, which requires the value
  // line to match DEH_SUPPLY_VALUE in full, so it likewise cannot absorb a date
  // or an amount from a neighbouring column.
  //
  // PRE-EXISTING BUG, found while adversarially probing this change: the LABEL
  // side leaked across lines even though the value side could not. In the
  // abbreviated alternative `Αρ\.?\s*παροχής\s*:?` the trailing `\s*` matches a
  // NEWLINE, after which `[ \t]+` matches the next line's leading indent — so
  // "Αρ. παροχής\n 800-900-1000" matched as a same-line pairing and took ΔΕΗ's
  // freephone number as the billing ID, bypassing the plausibility check on the
  // lookahead branch. `[ \t]` in both label gaps confines the pattern to one
  // line, which is what its comment always claimed.
  // Accent-tolerant on the stressed vowels: the OCR of these scans demonstrably
  // drops the tonos («Ημ/νία Εκδοσης», «Τψολόγιο»), and a label that gates the
  // whole parse must not fail on a missing accent — the cost is another 51-second
  // OCR that ends in an error. (In THIS corpus these two labels kept their
  // accents; this is hardening for the next scan, not a fix for a seen failure.)
  const SUPPLY_LABEL = /(?:Αριθμ[όο]ς[ \t]+παροχ[ήη]ς|Αρ\.?[ \t]*παροχ[ήη]ς)[ \t]*:?/i;
  let billingId: string | null = null;
  const sameLineSupply = text.match(
    /(?:Αριθμ[όο]ς[ \t]+παροχ[ήη]ς|Αρ\.?[ \t]*παροχ[ήη]ς[ \t]*:?)[ \t]+([\d][\d \t-]+\d)/i
  );
  if (sameLineSupply && isPlausibleSupplyNumber(sameLineSupply[1])) {
    billingId = sameLineSupply[1].trim();
  } else {
    const nextLineSupply = findLabelledValue(
      text,
      SUPPLY_LABEL,
      DEH_SUPPLY_VALUE,
      3,
      isPlausibleSupplyNumber
    );
    billingId = nextLineSupply ? nextLineSupply.trim() : null;
  }
  // NOTE (parse-fail surface): the field extractions below all run even when an
  // earlier one failed, and every `return {success:false}` carries a `partial`
  // with what WAS recovered. Bailing out on the first missing field is what made
  // three real bills report only «Δεν βρέθηκε αριθμός παροχής» while their
  // amount, period, dates and RF sat parsed and discarded. `partial` is
  // diagnostic/prefill only — see PartialBillFields — and must never be treated
  // as chargeable.

  // Extract total amount - try multiple patterns
  let totalAmount: number | null = null;

  // Pattern 1: "Συνολικό ποσό πληρωμής" line
  const totalMatch = text.match(
    /Συνολικό ποσό πληρωμής\s*\*?\s*([\d\s,.]+)\s*€/i
  );
  if (totalMatch) {
    totalAmount = parseGreekAmount(totalMatch[1]);
  }

  // Pattern 2: "ΠΟΣΟ ΠΛΗΡΩΜΗΣ" then "*amount€"
  if (totalAmount === null) {
    const altMatch = text.match(/\*\s*([\d,.]+)\s*€/);
    if (altMatch) {
      totalAmount = parseGreekAmount(altMatch[1]);
    }
  }

  // Extract consumption period.
  //
  // THE HIGHEST-RISK FIELD IN THIS PARSER: periodEnd feeds computeDefaultTerm,
  // which decides WHICH MONTH every tenant in the building is charged — and the
  // import dialog renders the period as static text, so a wrong pairing here is
  // not correctable by the operator before it reaches the ledger. Both bounds
  // must therefore come from the label's own column; a partial read fails.
  let periodStartRaw: string | undefined;
  let periodEndRaw: string | undefined;
  const periodMatch = text.match(
    /Περ[ίι]οδος[ \t]+Καταν[άα]λωσης\s+(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/i
  );
  if (periodMatch) {
    periodStartRaw = periodMatch[1];
    periodEndRaw = periodMatch[2];
  } else {
    // Scan layout: the label is followed by its two dates on the NEXT TWO lines
    // and there is no "-" between them:
    //   "Περίοδος Κατανάλωσης" / "28/05/2026" / "22/06/2026"
    // Require BOTH to be immediately consecutive date lines. Taking only the
    // first and hunting further for a second would risk pairing the period start
    // with «Ημ/νία Εκδοσης» or «Επόμενη καταμέτρηση» — a fabricated period.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/Περ[ίι]οδος[ \t]+Καταν[άα]λωσης/i.test(lines[i])) continue;
      const dates: string[] = [];
      // The label line itself may carry the dates (mixed layouts) — but ONLY the
      // text AFTER the label counts.
      //
      // WRONG-MONTH BUG (adversarial review): this used `replace(label,' ')` +
      // a GLOBAL match, so it collected every date on the line INCLUDING ones
      // printed BEFORE the label. On the pdfjs digital path a whole page is one
      // line, so a period written with an EN-DASH (which pattern P1 above does
      // not accept) fell through to here and harvested «ΕΞΟΦΛΗΣΗ ΕΩΣ» and
      // «Επόμενη καταμέτρηση» as the period — deriving APRIL for a bill the
      // document states as MARCH, and charging every tenant in the building for
      // the wrong month. Slicing after the label removes the whole class.
      const labelHit = lines[i].match(/Περ[ίι]οδος[ \t]+Καταν[άα]λωσης/i);
      const afterLabel =
        labelHit && labelHit.index !== undefined
          ? lines[i].slice(labelHit.index + labelHit[0].length)
          : '';
      const onLabel = afterLabel.match(new RegExp(DATE_VALUE, 'g'));
      if (onLabel) dates.push(...onLabel);
      // WRONG-MONTH BUG, caught by adversarial review of this very fix: an
      // earlier version SKIPPED interleaved label lines while hunting for the
      // second date. On the layout
      //     «Περίοδος Κατανάλωσης 25/02/2026» / «Επόμενη καταμέτρηση:» / «24/04/2026»
      // it skipped the label and took the NEXT METER READING's date as periodEnd
      // → computeDefaultTerm charged every tenant in the building for April
      // instead of March. A label after the label line means the period's own
      // column has ENDED, so it must TERMINATE the search, not be stepped over.
      // (The label-skip is still correct for findLabelledValue, which looks for
      // ONE value; it is only wrong here, where the two dates must be adjacent.)
      for (let j = i + 1; j < lines.length && dates.length < 2; j++) {
        const line = lines[j].trim();
        if (!line) continue;
        // Only skip a label BEFORE any date has been seen (the pure-columnar
        // layout, where labels precede the whole value column). Once the first
        // date is in hand, any label ends the pairing.
        if (DEH_INTERLEAVED_LABELS.test(line)) {
          if (dates.length === 0) continue;
          break;
        }
        const m = line.match(DATE_VALUE);
        if (!m) break; // left the date column — do not keep hunting
        dates.push(m[0]);
      }
      if (dates.length >= 2) {
        periodStartRaw = dates[0];
        periodEndRaw = dates[1];
      }
      break;
    }
  }
  const periodStart = periodStartRaw ? parseGreekDate(periodStartRaw) : null;
  const periodEnd = periodEndRaw ? parseGreekDate(periodEndRaw) : null;
  // Order sanity: a scan whose two date lines arrive reversed (or whose columns
  // paired wrongly) must not silently produce an inverted period — periodEnd is
  // the term anchor. Reject rather than swap: a swap would assert a period the
  // document may not actually state.
  const periodInverted =
    !!periodStart && !!periodEnd && periodEnd.getTime() < periodStart.getTime();

  // Extract issue date.
  //
  // `Έκδοσης` is matched as `Έ?κδοσης` with the tonos OPTIONAL: the OCR of all
  // three real scans emits «Ημ/νία Εκδοσης» — unaccented — so the original
  // accented-only pattern never matched a scanned bill. (Same class of trap as
  // the Θ↔Ο confusion documented for ΕΥΔΑΠ in BILL_OCR_INBOX_PLAN §17.4: an OCR
  // label is not a reliable literal.) The value is also frequently on the next
  // line, so both fields go through findLabelledValue.
  const issueDateRaw = findLabelledValue(
    text,
    /Ημ\.?\/?νία\s+[ΈΕ]κδοσης\s*:?/i,
    DATE_VALUE
  );
  const issueDate = issueDateRaw ? parseGreekDate(issueDateRaw) : undefined;

  // Extract due date. On bill-03 the line after «ΕΞΟΦΛΗΣΗ ΕΩΣ» is the label
  // «Τιμολόγιο:» and the date is the line AFTER that — hence the label-skipping
  // in findLabelledValue. Without it, the naive next-line read finds no date and
  // the next date in the file belongs to «Επόμενη καταμέτρηση».
  const dueDateRaw = findLabelledValue(
    text,
    /(?:ΕΞΟΦΛΗΣΗ\s+ΕΩΣ|Εξόφληση\s+έως)\s*:?/i,
    DATE_VALUE
  );
  const dueDate = dueDateRaw ? parseGreekDate(dueDateRaw) : undefined;

  // Extract RF code — and VALIDATE its ISO-11649 mod-97 checksum (O5,
  // destructive-write audit 2026-07). A photographed/OCR'd bill can drop or
  // swap an RF digit; the RF + paymentCode are combined into the IRIS payment
  // QR, so a corrupt RF would produce a SCANNABLE QR that sends the landlord's
  // bank transfer to the wrong reference. Reject a checksum-failed RF (leave
  // rfCode undefined → no QR / QR without a bad reference) rather than encode
  // it. The receipt-matching path already validates via isValidRF; this closes
  // the bill-ingest side.
  const rfMatch = text.match(/(RF\d{15,30})/);
  const rfCode = rfMatch && isValidRF(rfMatch[1]) ? rfMatch[1] : undefined;

  // Extract payment amount code (e.g., "000000186,21 3" → "000000186213")
  // This is combined with RF code to form the IRIS QR content
  const paymentCodeMatch = text.match(/(\d{6,12}),(\d{2})\s+(\d)/);
  const paymentCode = paymentCodeMatch
    ? paymentCodeMatch[1] + paymentCodeMatch[2] + paymentCodeMatch[3]
    : undefined;

  // ——— Single decision point. Everything above only READS; nothing bails early,
  // so a failure can report both what is missing AND what was recovered.
  const partial: PartialBillFields = {
    billingId: billingId || undefined,
    billingIdNormalized: billingId
      ? normalizeBillingId(billingId)
      : undefined,
    totalAmount: totalAmount === null ? undefined : totalAmount,
    periodStart: periodStart || undefined,
    periodEnd: periodEnd || undefined,
    issueDate: issueDate || undefined,
    dueDate: dueDate || undefined,
    rfCode,
    paymentCode
  };

  // Error precedence is UNCHANGED from before this refactor (παροχή → ποσό →
  // περίοδος → invalid dates) so existing tests and the operator-facing message
  // for a given document stay identical; only the accompanying `partial` is new.
  const missingFields: string[] = [];
  // STABLE CODES, not Greek prose. These are rendered on a localised card, and
  // hardcoded Greek here appeared verbatim under a German/English heading — the
  // one string on the new surface that wasn't translatable. The client maps each
  // code through its existing i18n key (BillImportDialog «Not read» list).
  if (!billingId) missingFields.push('billingId');
  if (totalAmount === null) missingFields.push('totalAmount');
  if (!periodStart || !periodEnd) missingFields.push('period');
  partial.missingFields = missingFields;

  if (!billingId) {
    return {
      success: false,
      error: 'Δεν βρέθηκε αριθμός παροχής',
      partial
    };
  }
  if (totalAmount === null) {
    return { success: false, error: 'Δεν βρέθηκε ποσό πληρωμής', partial };
  }
  if (!periodStartRaw || !periodEndRaw) {
    return {
      success: false,
      error: 'Δεν βρέθηκε περίοδος κατανάλωσης',
      partial
    };
  }
  if (!periodStart || !periodEnd || periodInverted) {
    return {
      success: false,
      error: 'Μη έγκυρες ημερομηνίες περιόδου κατανάλωσης',
      partial
    };
  }

  return {
    success: true,
    bill: {
      provider: 'deh',
      billingId,
      billingIdNormalized: normalizeBillingId(billingId),
      totalAmount,
      periodStart,
      periodEnd,
      issueDate: issueDate || undefined,
      dueDate: dueDate || undefined,
      rfCode,
      paymentCode
    }
  };
}
