/**
 * ΕΥΔΑΠ (water + sewerage) bill parser — Slice 3.
 *
 * WHY THIS LOOKS DIFFERENT FROM `deh.ts`. The ΔΕΗ parser pairs a label with a
 * value that sits on the label's own line or just below it. On a photographed
 * ΕΥΔΑΠ bill that assumption is false: the header is a TABLE, and the OCR emits it
 * column-major — first a run of 8 labels, then a run of their values. Measured on
 * the real bill (2026-08-13, 127 lines):
 *
 *      3| T.T.                     11| Α
 *      4| ΑΡΙΘΜΟΙ ΛΟΓΑΠΙΑΣΜΟΥ      12| 99900011122 003
 *      5| ΔΙΑΔΠΟΜΗ                 13| 28
 *      6| ΤΙΜΟΛ.                   14| Β1
 *      7| ΕΙΔ. ΚΑΤ.                15| A99E90001
 *      8| ΑΠΙΟΜΟΙ ΜΕΤΠΗΤΗ          16| 9990001-33
 *      9| ΑΠΙΘΜΟΣ ΜΗΤΡΩΟΥ
 *     10| Α.Ο.M.
 *
 * Two lessons in that block. First, `findLabelledValue`'s 3-line lookahead cannot
 * reach a value 8 lines away. Second — and this is why index-pairing the two runs
 * is NOT the fix — there are 8 labels and only 6 values, because ΕΙΔ. ΚΑΤ. and
 * Α.Φ.Μ. are blank on this bill and the OCR emits nothing for a blank cell. Pairing
 * by position would silently assign the meter number to «ΕΙΔ. ΚΑΤ.» and the μητρώο
 * to the meter. On a money surface, a confidently mis-assigned field is worse than
 * a missing one.
 *
 * Also note how badly the OCR mangles the LABELS while reading the VALUES
 * perfectly: «ΑΡΙΘΜΟΙ ΛΟΓΑΠΙΑΣΜΟΥ» (Ρ→Π), «ΑΠΙΟΜΟΙ ΜΕΤΠΗΤΗ», «Α.Ο.M.» for Α.Φ.Μ.,
 * «ΛΗΕΗ ΠΡΟΘΕΣΜΙΑΣ ΠΑΗΡΩΜΗΣ», «ΠΟΣΟ ΠΛΗΡΟΜΗΣ (ΕΥΡΟ)». Anchoring on those labels is
 * anchoring on noise.
 *
 * SO THE STRATEGY IS: anchor on the VALUE's shape, and corroborate.
 *
 * Every field this parser needs is either uniquely shaped on the page (the account
 * number is the only `11 digits + 3 digits` run; the μητρώο the only `7-2`) or it is
 * printed a SECOND time in the ΑΠΟΚΟΜΜΑ ΤΑΜΕΙΟΥ (the payment stub at the foot),
 * where the layout IS label-adjacent:
 *
 *    103| ΑΡΙΘΜΟΣ ΜΗΤΡΩΟΥ      105| ΚΑΤΑΝΑΛΩΣΗ     108| ΗΜ/ΝΙΑ ΕΚΔΟΣΗΣ
 *    104| 9990001-33           106| 61 M3          109| 04/08/2026
 *
 * The stub is therefore the RELIABLE source and the header the cross-check. When the
 * two disagree the parse reports it rather than picking one, because a disagreement
 * means the OCR misread a digit somewhere and a silent choice would be a guess about
 * money.
 *
 * TWO MONEY DECISIONS, both load-bearing:
 *
 * · ΠΛΗΡΩΤΕΟ vs ΜΕΡΙΚΟ ΣΥΝΟΛΟ. ΕΥΔΑΠ prints both. ΠΛΗΡΩΤΕΟ is what the landlord
 *   owes (prior balance included); ΜΕΡΙΚΟ ΣΥΝΟΛΟ is this period's own charges.
 *   `salvageGenericFields` already decided, correctly, to prefer ΠΛΗΡΩΤΕΟ — reading
 *   the subtotal as "what I owe" under-reports the debt, and silent under-reporting
 *   reads as correct everywhere. But the two answer DIFFERENT questions, and
 *   splitting ΠΛΗΡΩΤΕΟ among tenants would bill them the landlord's arrears. So this
 *   parser returns `totalAmount` = ΠΛΗΡΩΤΕΟ and `chargeableAmount` = ΜΕΡΙΚΟ ΣΥΝΟΛΟ,
 *   and warns when they differ. On the sample they are both 89,94 and nothing changes.
 *
 * · THE PERIOD IS ~3 MONTHS, AND THAT IS NORMAL. ΕΥΔΑΠ reads meters quarterly, so
 *   every Greek water bill covers about three months (87 ΗΜΕΡΕΣ ΚΑΤΑΝΑΛΩΣΗΣ on the
 *   sample). The landlord pays it once and charges it once. An earlier version
 *   warned about the span, which would have fired on EVERY water bill — the trap
 *   described above, where a warning on everything trains the operator to dismiss
 *   the one that matters. The span is kept as data (`details.monthsSpanned`) and
 *   nothing is raised. What IS worth deciding is WHICH MONTH the charge lands in,
 *   and that is `computeDefaultTerm`'s business, not the parser's.
 *
 * INTERNAL CONSISTENCY, because a wrong number that looks right is the failure mode
 * here. Three identities are checked against the document's own arithmetic:
 *   Σ(τίμημα, πάγιο, περιβαλλοντικό, αποχέτευση, ΦΠΑ 13%, ΦΠΑ 24%) = ΜΕΡΙΚΟ ΣΥΝΟΛΟ
 *   Σ(tiered m³) = ΚΑΤΑΝΑΛΩΣΗ = ΤΕΛ. ΕΝΔΕΙΞΗ − ΠΡΟΗΓ. ΕΝΔΕΙΞΗ
 * On the sample: 38,41+8,70+0,03+28,81+4,99+9,00 = 89,94 ✓ and
 * 14,50+43,50+3,00 = 61 = 6061−6000 ✓. A failure is a warning, not a refusal — the
 * operator can still read the figure off the document — but it names which identity
 * broke so they know which number to distrust.
 */
import {
  BillParseResult,
  ParsedBill,
  PartialBillFields,
  normalizeBillingId
} from './types.js';

// ─── primitives ──────────────────────────────────────────────────────────────
// Deliberately duplicated from deh.ts rather than shared: these two are the ONLY
// functions the two parsers would share, and the ΔΕΗ versions carry ΔΕΗ-specific
// tie-breaks (its "1.234 with no comma is thousands" rule exists because ΔΕΗ prints
// sub-euro-less totals that way). Merging them would mean one function with two
// providers' quirks, which is how a shared money helper starts lying to both. If a
// third parser needs them, extract then — with a case table.

/** «89,94» / «1.234,56» → number. Rightmost separator is the decimal one. */
function parseAmount(raw: string): number | null {
  const s = String(raw).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let cleaned: string;
  if (lastComma > lastDot) {
    cleaned = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    cleaned = /^\d{1,3}\.\d{3}$/.test(s) ? s.replace(/\./g, '') : s.replace(/,/g, '');
  } else {
    cleaned = s;
  }
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * «04/08/2026» → UTC Date.
 *
 * UTC is mandatory, not stylistic: `computeDefaultTerm` reads `getUTCMonth()`, so a
 * local-time Date built in Athens summer (UTC+3) turns a period ending 01/08 into
 * July 31 21:00Z and charges the whole bill to the WRONG MONTH. Calendar-invalid OCR
 * reads (31/02) are rejected rather than allowed to roll over into March.
 */
function parseDate(raw: string): Date | null {
  const m = String(raw).match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const y = parseInt(m[3], 10);
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

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── value shapes ────────────────────────────────────────────────────────────
// Each is chosen to be UNIQUE on an ΕΥΔΑΠ page, verified against the real 127-line
// OCR. Where a shape is not unique, the code takes the corroborated occurrence.

/** ΑΡΙΘΜΟΣ ΛΟΓΑΡΙΑΣΜΟΥ: 11 digits, a space, a 3-digit branch suffix. */
const ACCOUNT_NUMBER = /\b(\d{11})\s+(\d{3})\b/;
/** ΑΡΙΘΜΟΣ ΜΗΤΡΩΟΥ: 7 digits, hyphen, 2. Printed twice (header + stub). */
const REGISTRY_NUMBER = /\b(\d{7})-(\d{2})\b/;
/** ΑΡΙΘΜΟΣ ΜΕΤΡΗΤΗ: letter, 2 digits, letter, 5 digits (e.g. A99E90001). */
const METER_SERIAL = /\b([A-ZΑ-Ω]\d{2}[A-ZΑ-Ω]\d{5})\b/;
/** ΠΕΡΙΟΔΟΣ ΚΑΤΑΝΑΛΩΣΗΣ: «28/04/2026-23/07/2026». Printed twice. */
const PERIOD = /(\d{2}\/\d{2}\/\d{4})\s*[-–—]\s*(\d{2}\/\d{2}\/\d{4})/;
/** ΑΡ. ΠΑΡΑΣΤΑΤΙΚΟΥ: «2026 0007 2757 0091 05». Printed twice. */
const DOCUMENT_NUMBER = /\b(\d{4}\s+\d{4}\s+\d{4}\s+\d{4}\s+\d{2})\b/;
/** A tiered consumption line: «14,50M3 x 0,35 € 5,08» — split across OCR lines. */
const TIER_VOLUME = /^(\d+[.,]\d{2})\s*M3\s*[xX×]?$/i;
const TIER_PRICE = /^(\d+[.,]\d{2})\s*€?$/;
/** MARK (the AADE e-invoicing mark) and the e-invoicing provider. */
const MARK = /MARK[:\s]+(\d{10,20})/i;
// «Πάροχος:» OCRs as «nάpoxoc:» (Π->n, ρ->p, ο->o, χ->x, ς->c). Anchoring on the
// first letter fails; the middle of the word survives, so match that.
const EINVOICE_PROVIDER = /[άa]?[ρp][oο][xχ][oο][cςs]\s*[:;]\s*(.+)$/i;
/** ΤΙΜΟΛΟΓΙΟ (tariff class): «Β1» / «B1», printed twice. */
const TARIFF = /ΤΙΜΟΛΟΓΙΟ\s+([ΑΒΓΔA-Z]\d?)/;
/** A Greek postal code + area, as printed on the address block. */
const POSTCODE_AREA = /^(\d{5})\s+(.+)$/;

/**
 * Amount printed on the line AFTER its label — the layout of both money boxes
 * («ΤΡΕΧΩΝ ΛΟΓΑΡΙΑΣΜΟΣ» and «ΠΡΟΗΓΟΥΜΕΝΕΣ ΟΦΕΙΛΕΣ»), where each row is emitted as
 * label-line then value-line.
 *
 * `maxLookahead` is 2, not 3: the boxes are printed side by side, so the OCR
 * interleaves the two columns' rows and a longer reach starts finding the OTHER
 * box's figures. A percentage line («75%», «13%») is skipped — it sits between an
 * ΑΠΟΧΕΤΕΥΣΗ/ΦΠΑ label and its euro amount.
 */
function amountAfterLabel(
  lines: string[],
  label: RegExp,
  maxLookahead = 2,
  // Look BACKWARDS as well. Measured on the real bill: the two money boxes are
  // printed side by side and the OCR interleaves their rows, which puts
  // ΑΠΟΧΕΤΕΥΣΗ's «28,81» three lines ABOVE its own label:
  //     76| 758           (= 75%, the sewerage rate)
  //     77| 28,81         <- the value
  //     78| ΠΙΣΤΩΤΙΚΟ     (the OTHER box's label)
  //     80| ΑΠΟΧΕΤΕΥΣΗ    <- the label
  // Forward-only search returned null for it, which made `haveWholeBreakdown`
  // false and SILENTLY SKIPPED the sum-to-subtotal identity — the one check that
  // would have caught the missing €28,81. A consistency check that quietly
  // declines to run is worse than not having one, because its silence reads as a
  // pass. Backward reach is opt-in per field so it is never used where forward
  // order is reliable.
  maxLookbehind = 0
): number | null {
  const asAmount = (line: string): number | null => {
    const m = line.match(/^(\d{1,3}(?:[.\s]\d{3})*|\d+)[,.](\d{2})\s*€?$/);
    if (!m) return null;
    const n = parseAmount(m[0]);
    return n !== null && n >= 0 ? n : null;
  };
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    // Same line first: «ΜΕΡΙΚΟ ΣΥΝΟΛΟ (ΕΥΡΩ) : 89,94» is one line on some scans.
    const after = lines[i].replace(label, ' ');
    const sameLine = after.match(/(\d{1,3}(?:[.\s]\d{3})*|\d+)[,.](\d{2})/);
    if (sameLine) {
      const n = parseAmount(sameLine[0]);
      if (n !== null && n >= 0) return n;
    }
    for (let j = i + 1; j <= i + maxLookahead && j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      // A bare percentage belongs to the label, not to the amount column.
      if (/^\d{1,3}\s*[%8]$/.test(line)) continue;
      const m = line.match(/^(\d{1,3}(?:[.\s]\d{3})*|\d+)[,.](\d{2})\s*€?$/);
      if (m) {
        const n = parseAmount(m[0]);
        if (n !== null && n >= 0) return n;
      }
      // Anything else means we have walked out of this row.
      break;
    }
    // Backward, only when asked. Skips the rate line and the other box's labels,
    // and stops at the first amount found — the nearest one above.
    for (let j = i - 1; j >= i - maxLookbehind && j >= 0; j--) {
      const line = lines[j].trim();
      if (!line) continue;
      if (/^\d{1,3}\s*[%8]$/.test(line)) continue;
      const n = asAmount(line);
      if (n !== null) return n;
    }
  }
  return null;
}

/** The value on the line after a label, matched by shape. */
/**
 * A line that is itself a LABEL — all-caps Greek/Latin with no digits and no money.
 *
 * Needed because the header and the stub both interleave several labels between a
 * label and its value. «ΗΜ/ΝΙΑ ΛΗΞΕΩΣ» is 3 lines above its date, with «ΠΛΗΡΩΤΕΟ»
 * and the document number in between; the header's «ΛΗΞΗ ΠΡΟΘΕΣΜΙΑΣ ΠΛΗΡΩΜΗΣ» is 4
 * above its own, with three other labels between. Stopping at the first
 * non-matching line therefore lost the due date entirely. Skipping label lines —
 * and ONLY label lines — is how deh.ts solves the same layout.
 */
const LABEL_LINE =
  /^[Α-ΩΪΫΆΈΉΊΌΎΏA-Z][Α-ΩΪΫΆΈΉΊΌΎΏA-Z\s./():·%-]*$/;

function valueAfterLabel(
  lines: string[],
  label: RegExp,
  shape: RegExp,
  maxLookahead = 2,
  // Opt-in: skip intervening LABEL lines instead of stopping at them. Off by
  // default — where forward adjacency is reliable, stopping is the safer rule,
  // because walking past an unrecognised line is how a label gets paired with
  // another field's value.
  skipLabels = false
): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    const after = lines[i].replace(label, ' ').trim();
    const same = after.match(shape);
    if (same) return same[0];
    for (let j = i + 1; j <= i + maxLookahead && j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      const m = line.match(shape);
      if (m) return m[0];
      if (skipLabels && LABEL_LINE.test(line)) continue;
      break;
    }
  }
  return null;
}

/** Every occurrence of a shape, so agreement between copies can be checked. */
function allMatches(text: string, shape: RegExp): string[] {
  const g = new RegExp(shape.source, shape.flags.includes('g') ? shape.flags : `${shape.flags}g`);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    out.push(m[0]);
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return out;
}

/**
 * The consumption tiers: «14,50M3 x» / «0,35 €» / «5,08» on three consecutive
 * lines. Read as triples so a tier whose price OCR'd badly is dropped rather than
 * paired with the next tier's number.
 */
function parseTiers(
  lines: string[]
): { volume: number; unitPrice: number; amount: number }[] {
  const tiers: { volume: number; unitPrice: number; amount: number }[] = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const v = lines[i].trim().match(TIER_VOLUME);
    if (!v) continue;
    const p = lines[i + 1].trim().match(TIER_PRICE);
    if (!p) continue;
    const a = lines[i + 2].trim().match(TIER_PRICE);
    if (!a) continue;
    const volume = parseAmount(v[1]);
    const unitPrice = parseAmount(p[1]);
    const amount = parseAmount(a[1]);
    if (volume === null || unitPrice === null || amount === null) continue;
    tiers.push({ volume, unitPrice, amount });
    i += 2;
  }
  return tiers;
}

/**
 * The account holder and the address.
 *
 * Not decoration: when the παροχή on the bill matches nothing on file, the address
 * is the only other thing that can point at a building — and a landlord looking at
 * an unmatched bill needs to know WHOSE it is before they can file it. Read from the
 * stub block, where a 5-digit postcode line is a reliable anchor: the line above it
 * is the street, and the name is the nearest all-caps Greek line above that.
 *
 * Returned verbatim and never normalised or matched on automatically — a name is
 * personal data, and guessing a building from a fuzzy address match is exactly the
 * kind of confident wrong answer this parser is built to avoid.
 */
function parseRecipient(
  lines: string[]
): { name?: string; street?: string; postCode?: string; area?: string } {
  // A STREET carries a number («ΟΔΟΣ ΑΛΦΑ 24»); a NAME does not. The first version
  // used one digit-free pattern for both, so the street line never matched and the
  // NAME was returned as the street — the address would have been wrong on screen
  // and useless for locating a building.
  const NAME_LINE = /^[Α-ΩΪΫΆΈΉΊΌΎΏ][Α-ΩΪΫΆΈΉΊΌΎΏ\s.'-]{4,}$/;
  const STREET_LINE = /^[Α-ΩΪΫΆΈΉΊΌΎΏ][Α-ΩΪΫΆΈΉΊΌΎΏ\s.'-]{2,}\s+\d{1,4}[Α-Ω]?$/;
  for (let i = 1; i < lines.length; i++) {
    const pc = lines[i].trim().match(POSTCODE_AREA);
    if (!pc) continue;
    // Walk up past blank lines for the street, then for the name.
    let street: string | undefined;
    let name: string | undefined;
    for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
      const line = lines[j].trim();
      if (!line) continue;
      if (!street && STREET_LINE.test(line)) {
        street = line;
        continue;
      }
      if (street && NAME_LINE.test(line)) {
        name = line;
        break;
      }
      // A line that is neither, between the postcode and the street, is OCR noise
      // from the interleaved stub columns — keep walking rather than give up.
      if (!street && NAME_LINE.test(line)) {
        // A name found BEFORE any street means this block has no street line;
        // record it and stop, rather than mislabel it as the street.
        name = line;
        break;
      }
    }
    if (street || name) {
      return { name, street, postCode: pc[1], area: pc[2].trim() };
    }
  }
  return {};
}

/** Whole-euro-ish integers on their own line, in document order. */
function integerLines(lines: string[]): number[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => /^\d{1,7}$/.test(l))
    .map((l) => parseInt(l, 10));
}

export function parseEydapBill(text: string): BillParseResult {
  if (!text) {
    return {
      success: false,
      error: 'Δεν αναγνώστηκε κείμενο από τον λογαριασμό',
      detectedProvider: 'eydap'
    };
  }
  const lines = text.split('\n');
  const missing: string[] = [];
  const warnings: string[] = [];

  // ─── identity ──────────────────────────────────────────────────────────────
  const accountMatch = text.match(ACCOUNT_NUMBER);
  const accountNumber = accountMatch
    ? `${accountMatch[1]} ${accountMatch[2]}`
    : null;

  // The μητρώο is printed twice. Disagreement between the copies means a misread
  // digit, and since this is a MATCH KEY a wrong one silently attributes the bill
  // to the wrong apartment — so it is reported, not resolved.
  const registryAll = [...new Set(allMatches(text, REGISTRY_NUMBER))];
  const registryNumber = registryAll[0] || null;
  if (registryAll.length > 1) {
    warnings.push('registry-number-disagrees');
  }

  // Without a meter number there is nothing to match on that identifies a supply
  // point; the billing numbers are only fallbacks for pre-existing data.
  const meterSerial = text.match(METER_SERIAL)?.[1] || null;
  if (!meterSerial && !accountNumber && !registryNumber) missing.push('billingId');

  // ─── period ────────────────────────────────────────────────────────────────
  // TWO date RANGES are printed, and only one of them is the billing period:
  //     40| 28/04/2026-23/07/2026                          <- ΠΕΡΙΟΔΟΣ ΚΑΤΑΝΑΛΩΣΗΣ
  //     42| ΕΠΟΜΕΝΗ ΚΑΤΑΜΕΤΡΗΣΗ: 18/10/2026-24/10/2026     <- the NEXT meter read
  //    100| 28/04/2026-23/07/2026                          <- the stub's copy
  // Taking "the first range on the page" got the right answer here only by
  // document order. If the next-reading line ever printed first, the parser would
  // charge the bill to OCTOBER — a wrong month with no symptom, because the amount
  // and the παροχή would both be right. So the next-reading line is excluded
  // outright, and the ΠΕΡΙΟΔΟΣ ΚΑΤΑΝΑΛΩΣΗΣ label (which IS adjacent to its value in
  // the stub) is preferred over position.
  const periodLines = lines.filter((l) => !/ΕΠΟΜΕΝΗ\s+ΚΑΤΑΜΕΤΡΗΣΗ/i.test(l));
  const labelledPeriod = valueAfterLabel(
    periodLines,
    // «ΠΕΡΙΟΔΟΣ ΚΑΤΑΝΑΛΩΣΗΣ» OCRs as «ΠΕΡΙΟΔΟΣ ΚΑΤΑΝΑΛΩΙΗΣ» (Σ->Ι) in the header.
    /ΠΕΡΙΟΔΟΣ\s+ΚΑΤΑΝΑΛΩ[ΣΙ]Η[ΣΙ]/i,
    PERIOD
  );
  const periodAll = [...new Set(allMatches(periodLines.join('\n'), PERIOD))];
  const periodMatch =
    (labelledPeriod || periodAll[0])?.match(PERIOD) || null;
  const periodStart = periodMatch ? parseDate(periodMatch[1]) : null;
  const periodEnd = periodMatch ? parseDate(periodMatch[2]) : null;
  if (!periodStart || !periodEnd) missing.push('period');
  if (periodAll.length > 1) warnings.push('period-disagrees');
  if (periodStart && periodEnd && periodEnd < periodStart) {
    // An inverted period would make every downstream month calculation nonsense.
    missing.push('period');
  }

  // ─── dates ─────────────────────────────────────────────────────────────────
  // Read from the STUB, where labels and values are adjacent. The header's copies
  // are unreachable by label (see the file docstring).
  const issueDate =
    parseDate(
      valueAfterLabel(lines, /ΗΜ\/?ΝΙΑ\s+ΕΚΔΟΣΗΣ|ΗΜΝΙΑ\s+ΕΚΔΟΣΗΣ/i, /\d{2}\/\d{2}\/\d{4}/) || ''
    ) || undefined;
  const dueDate =
    parseDate(
      valueAfterLabel(
        lines,
        // «ΗΜ/ΝΙΑ ΛΗΞΕΩΣ» on the stub; the header's «ΛΗΞΗ ΠΡΟΘΕΣΜΙΑΣ ΠΛΗΡΩΜΗΣ» OCRs
        // as «ΛΗΕΗ ΠΡΟΘΕΣΜΙΑΣ ΠΑΗΡΩΜΗΣ», so Ξ→Ε and Λ→Α are tolerated.
        /ΗΜ\/?ΝΙΑ\s+ΛΗ[ΞΕ]ΕΩΣ|ΛΗ[ΞΕ]Η\s+ΠΡΟΘΕΣΜΙΑΣ/i,
        /\d{2}\/\d{2}\/\d{4}/,
        // 4 lines with label-skipping: the stub puts «ΠΛΗΡΩΤΕΟ» and the document
        // number between this label and its date, and the header puts three other
        // labels between its copy and hers.
        4,
        true
      ) || ''
    ) || undefined;

  // ─── money ─────────────────────────────────────────────────────────────────
  // «ΠΛΗΡΩΤΕΟ(ΕΥΡΩ) :» has no space before the bracket on the real bill.
  const payable = amountAfterLabel(lines, /ΠΛΗΡΩΤΕΟ\s*\(?ΕΥΡ[ΩО]?\)?\s*:?|ΠΛΗΡΩΤΕΟ/i);
  const subtotal = amountAfterLabel(lines, /ΜΕΡΙΚΟ\s+ΣΥΝΟΛΟ/i);
  const totalAmount = payable ?? subtotal;
  if (totalAmount === null || !(totalAmount > 0)) missing.push('totalAmount');

  // The current-period breakdown. Each is optional — a bill may legitimately omit
  // the environmental levy — but their SUM is what validates the subtotal.
  const breakdown = {
    charges: amountAfterLabel(lines, /ΣΥΝΟΛΟ\s+ΤΙΜΗΜΑΤΟΣ/i),
    fixedFee: amountAfterLabel(lines, /ΠΑΓΙΟ\s+ΤΕΛΟΣ/i),
    environmentalFee: amountAfterLabel(lines, /ΠΕΡΙΒΑΛΛ[.Α-Ω]*\s+ΤΕΛΟΣ/i),
    // The only field whose value the OCR places above its label (see
    // amountAfterLabel's maxLookbehind note). 4 lines covers the observed gap.
    sewerage: amountAfterLabel(lines, /ΑΠΟΧΕΤΕΥΣΗ/i, 2, 4),
    vatOnCharges: amountAfterLabel(lines, /ΦΠΑ\s+ΕΠΙ\s+ΤΙΜΗΜΑΤΟΣ/i),
    vatOnOther: amountAfterLabel(lines, /ΦΠΑ\s+ΕΠΙ\s+ΛΟΙΠΩΝ/i)
  };

  // IDENTITY 1: the six current-period lines must sum to ΜΕΡΙΚΟ ΣΥΝΟΛΟ.
  const breakdownSum = round2(
    Object.values(breakdown).reduce<number>((s, v) => s + (v ?? 0), 0)
  );
  const haveWholeBreakdown = Object.values(breakdown).every((v) => v !== null);
  if (subtotal !== null && haveWholeBreakdown) {
    // 2c tolerance: each of six lines can round by a cent.
    if (Math.abs(breakdownSum - subtotal) > 0.02) {
      warnings.push('breakdown-does-not-sum-to-subtotal');
    }
  }

  // ARREARS. When ΠΛΗΡΩΤΕΟ exceeds ΜΕΡΙΚΟ ΣΥΝΟΛΟ the difference is a prior balance,
  // and charging THAT to tenants would bill them the landlord's debt. Only flagged
  // in the direction that costs someone money: a payable BELOW the subtotal is a
  // credit and harmless to split (the tenants pay less).
  if (payable !== null && subtotal !== null && payable - subtotal > 0.02) {
    warnings.push('prior-balance-included-in-payable');
  }

  // ─── consumption ───────────────────────────────────────────────────────────
  const tiers = parseTiers(lines);
  const tieredVolume = round2(tiers.reduce((s, t) => s + t.volume, 0));
  const tieredAmount = round2(tiers.reduce((s, t) => s + t.amount, 0));

  // ΠΡΟΗΓ. ΕΝΔΕΙΞΗ / ΤΕΛ. ΕΝΔΕΙΞΗ / ΚΑΤΑΝΑΛΩΣΗ are three consecutive integer lines
  // in the header's value run. The STUB's «61 M3» is the corroboration, and it is
  // the one read by label because that block is label-adjacent.
  const stubConsumption = (() => {
    const v = valueAfterLabel(lines, /ΚΑΤΑΝΑΛΩΣΗ/i, /^\d{1,7}\s*M3$/i);
    return v ? parseInt(v, 10) : null;
  })();
  const ints = integerLines(lines);
  let previousReading: number | null = null;
  let currentReading: number | null = null;
  let consumption: number | null = stubConsumption;
  // Find the readings by the identity that defines them: two integers whose
  // difference equals the stated consumption. Far more reliable than position, and
  // it self-validates — if no such pair exists, the readings are not reported.
  if (stubConsumption !== null) {
    for (let i = 0; i < ints.length - 1; i++) {
      if (ints[i + 1] - ints[i] === stubConsumption && ints[i + 1] > ints[i]) {
        previousReading = ints[i];
        currentReading = ints[i + 1];
        break;
      }
    }
  }
  if (consumption === null && tiers.length) {
    // No stub reading — fall back to the tiers, which sum to the same m³.
    consumption = Math.round(tieredVolume);
    warnings.push('consumption-from-tiers-only');
  }

  // IDENTITY 2: Σ(tiered m³) = ΚΑΤΑΝΑΛΩΣΗ.
  if (consumption !== null && tiers.length && Math.abs(tieredVolume - consumption) > 0.5) {
    warnings.push('tiers-do-not-sum-to-consumption');
  }
  // IDENTITY 3: Σ(tier amounts) = ΣΥΝΟΛΟ ΤΙΜΗΜΑΤΟΣ.
  if (
    breakdown.charges !== null &&
    tiers.length &&
    Math.abs(tieredAmount - breakdown.charges) > 0.02
  ) {
    warnings.push('tier-amounts-do-not-sum-to-charges');
  }

  // ΗΜΕΡΕΣ ΚΑΤΑΝΑΛΩΣΗΣ. Not readable by label: the OCR merges «ΗΜΕΡΕΣ KΑΤΑΝ.» with
  // «ΥΠΟΧΡ. ΚΑΤΑΝ» on one line and the value is 8 lines below in the value run.
  // Read positionally instead — but only on a run that CORROBORATES itself: the
  // header's value column is [ΠΡΟΗΓ, ΤΕΛ, ΚΑΤΑΝΑΛΩΣΗ, ΗΜΕΡΕΣ, …], so the integer
  // two places after the current reading must equal the consumption already read
  // from the stub. When it does, the next one is the day count. When it does not,
  // the column is not the shape assumed and nothing is reported — a plausible
  // wrong day count would silently misstate the consumption rate.
  const daysBilled = (() => {
    if (currentReading === null || consumption === null) return null;
    const idx = ints.indexOf(currentReading);
    if (idx < 0) return null;
    if (ints[idx + 1] !== consumption) return null;
    const days = ints[idx + 2];
    return Number.isFinite(days) && days > 0 && days < 400 ? days : null;
  })();

  // ─── the rest, kept because discarding it is irreversible ──────────────────
  const documentNumberRaw = text.match(DOCUMENT_NUMBER)?.[1] || null;
  const mark = text.match(MARK)?.[1] || null;
  const tariff = text.match(TARIFF)?.[1] || null;
  const recipient = parseRecipient(lines);
  const einvoiceProvider = (() => {
    for (const l of lines) {
      const m = l.match(EINVOICE_PROVIDER);
      if (m) return m[1].trim();
    }
    return null;
  })();
  const nextReading = (() => {
    // Reads the line the period search deliberately excluded.
    const idx = lines.findIndex((l) => /ΕΠΟΜΕΝΗ\s+ΚΑΤΑΜΕΤΡΗΣΗ/i.test(l));
    if (idx < 0) return null;
    const m = lines[idx].match(PERIOD);
    return m ? { from: m[1], to: m[2] } : null;
  })();

  // ─── period span, reported rather than decided ─────────────────────────────
  let monthsSpanned: number | null = null;
  if (periodStart && periodEnd) {
    // Calendar months touched, kept as DATA and deliberately NOT warned about.
    //
    // An earlier version raised `period-spans-multiple-months` here, on the theory
    // that a ~3-month bill charged to one term is a distortion. It is not: ΕΥΔΑΠ
    // reads meters QUARTERLY, so every Greek water bill covers about three months.
    // The warning would have fired on every ΕΥΔΑΠ bill ever imported — the exact
    // failure this file warns about elsewhere, that a warning appearing on
    // everything trains the operator to dismiss the one that matters. A normal bill
    // must look normal.
    const monthsTouched =
      (periodEnd.getUTCFullYear() - periodStart.getUTCFullYear()) * 12 +
      (periodEnd.getUTCMonth() - periodStart.getUTCMonth()) +
      1;
    monthsSpanned = monthsTouched;
  }

  // ─── assemble ──────────────────────────────────────────────────────────────
  if (missing.length || !periodStart || !periodEnd || totalAmount === null) {
    // Partial, never a bare error: on the real ΔΕΗ bills a single unreadable field
    // discarded everything else the OCR had read perfectly, and the landlord was
    // left with «parse failed» after 51 seconds.
    const partial: PartialBillFields = { missingFields: [...new Set(missing)] };
    if (meterSerial) {
      partial.billingId = meterSerial;
      partial.billingIdNormalized = normalizeBillingId(meterSerial);
    } else if (accountNumber) {
      partial.billingId = accountNumber;
      partial.billingIdNormalized = normalizeBillingId(accountNumber);
    } else if (registryNumber) {
      partial.billingId = registryNumber;
      partial.billingIdNormalized = normalizeBillingId(registryNumber);
    }
    if (totalAmount !== null) partial.totalAmount = totalAmount;
    if (periodStart) partial.periodStart = periodStart;
    if (periodEnd) partial.periodEnd = periodEnd;
    if (issueDate) partial.issueDate = issueDate;
    if (dueDate) partial.dueDate = dueDate;
    if (documentNumberRaw) partial.paymentCode = normalizeBillingId(documentNumberRaw);
    return {
      success: false,
      error: `Ο λογαριασμός ΕΥΔΑΠ διαβάστηκε μερικώς (λείπει: ${[...new Set(missing)].join(', ')})`,
      detectedProvider: 'eydap',
      partial
    };
  }

  // THE METER NUMBER IS THE KEY. The first version used the ΑΡΙΘΜΟΣ ΛΟΓΑΡΙΑΣΜΟΥ
  // because that is what you pay with — which is the wrong axis. The account number
  // and the μητρώο are BILLING artefacts: they identify a contract, and a contract
  // moves when the customer changes, gets re-issued, or is renumbered. The ΑΡΙΘΜΟΣ
  // ΜΕΤΡΗΤΗ is the physical meter bolted to the building, and that is the thing the
  // landlord actually knows and records.
  //
  // Matching on the meter answers everything downstream in one step: WHICH building
  // (the meter is on exactly one), κοινόχρηστο or ιδιωτικό (whether it sits in
  // `sharedMeters` or on a `unit`), and whether a δαπάνη already exists for it. No
  // second decision is needed and none should be invented.
  //
  // The account number and μητρώο stay as ALTERNATES, not because the parser is
  // hedging but because existing data was entered before this was settled — a
  // landlord who typed the account number into `eydapNumber` must still match rather
  // than be told their own bill is unrecognised.
  const primary = meterSerial || accountNumber || (registryNumber as string);
  const alternates = [accountNumber, registryNumber]
    .filter((v): v is string => !!v && v !== primary)
    .map((v) => normalizeBillingId(v));

  const bill: ParsedBill = {
    provider: 'eydap',
    billingId: primary,
    billingIdNormalized: normalizeBillingId(primary),
    totalAmount,
    periodStart,
    periodEnd,
    issueDate,
    dueDate,
    // ΕΥΔΑΠ prints no RF code; the ΑΡΙΘΜΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ is the payment reference.
    paymentCode: documentNumberRaw
      ? normalizeBillingId(documentNumberRaw)
      : undefined,
    chargeableAmount: subtotal ?? undefined,
    alternateBillingIds: alternates.length ? alternates : undefined,
    warnings: warnings.length ? [...new Set(warnings)] : undefined,
    details: {
      accountNumber,
      registryNumber,
      meterSerial,
      tariff,
      documentNumber: documentNumberRaw,
      mark,
      einvoiceProvider,
      recipient,
      consumption:
        consumption === null
          ? undefined
          : {
              cubicMetres: consumption,
              previousReading,
              currentReading,
              daysBilled,
              tiers
            },
      breakdown,
      monthsSpanned,
      nextReading
    }
  };

  return { success: true, bill, detectedProvider: 'eydap' };
}
