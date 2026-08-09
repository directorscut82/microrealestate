/**
 * `salvageGenericFields` — best-effort field recovery for a bill that could NOT
 * be parsed (unknown provider, or a recognised-but-unimplemented one like
 * ΕΥΔΑΠ), so the operator can still see what the OCR read and register the
 * expense by hand.
 *
 * These assertions are the GUARD RAILS, not the happy path: salvage feeds a
 * screen the landlord reads to decide what to type into the ledger, so reporting
 * a WRONG figure is worse than reporting none. Every case below was derived from
 * the real 7-bill corpus (3 ΔΕΗ, 3 NOVA, 1 ΕΥΔΑΠ) captured 2026-08-09.
 */
import { salvageGenericFields } from '../managers/billparser/index.js';

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

describe('salvageGenericFields', () => {
  it('reads the total from an explicit total label (NOVA layout)', () => {
    const text = ['Συνολικό ποσό πληρωμής', '33,98 €'].join('\n');
    expect(salvageGenericFields(text).totalAmount).toBe(33.98);
  });

  it('reads the total from the ΕΥΔΑΠ ΠΛΗΡΩΤΕΟ stub', () => {
    const text = ['ΠΛΗΡΩΤΕΟ', '72,11€'].join('\n');
    expect(salvageGenericFields(text).totalAmount).toBe(72.11);
  });

  it('never reports a DOT-FORMATTED DATE as the amount', () => {
    // Self-probe finding: the amount pattern matched "23.06.2026" as 23.06 and
    // "1.4.2026" as 4.2. Both ΔΕΗ and ΕΥΔΑΠ print dot-dates, and a total label
    // above one would show a DATE in the amount field.
    for (const dateLine of [
      '23.06.2026',
      '1.4.2026',
      '24.07.2026',
      'Από 25.05.2026 έως 24.06.2026'
    ]) {
      const text = ['Συνολικό ποσό πληρωμής', dateLine].join('\n');
      const got = salvageGenericFields(text).totalAmount;
      expect({ dateLine, got }).toEqual({ dateLine, got: undefined });
    }
  });

  it('prefers ΠΛΗΡΩΤΕΟ over the ΜΕΡΙΚΟ ΣΥΝΟΛΟ subtotal above it', () => {
    // Caught by adversarial review. ΕΥΔΑΠ prints the SUBTOTAL first and the
    // PAYABLE below it; first-match-wins therefore reported the subtotal, so on a
    // bill carrying a prior balance the operator was shown LESS than is owed and
    // would type that figure — the difference leaving no trace anywhere.
    const text = [
      'ΕΥΔΑΠ',
      'ΠΡΟΗΓΟΥΜΕΝΕΣ ΟΦΕΙΛΕΣ (ΕΥΡΩ)',
      '48,00',
      'ΜΕΡΙΚΟ ΣΥΝΟΛΟ (ΕΥΡΩ) :',
      '72,11',
      'ΠΛΗΡΩΤΕΟ (ΕΥΡΩ) :',
      '120,11'
    ].join('\n');
    expect(salvageGenericFields(text).totalAmount).toBe(120.11);
  });

  it('falls back to the subtotal only when no payable label exists', () => {
    const text = ['ΜΕΡΙΚΟ ΣΥΝΟΛΟ (ΕΥΡΩ) :', '72,11'].join('\n');
    expect(salvageGenericFields(text).totalAmount).toBe(72.11);
  });

  it('reports NO amount when there is no total label (never guesses)', () => {
    // A bill states many euro figures — per-charge lines, VAT, prior balance.
    // Taking the largest is the prior-balance double-count trap
    // (BILL_OCR_INBOX_PLAN §17.5.2), so with no label there must be no amount.
    const text = [
      'Χρεώσεις προμήθειας ΔΕΗ',
      '59,62€',
      'Ρυθμιζόμενες χρεώσεις',
      '25,76€',
      'ΦΠΑ',
      '5,18€'
    ].join('\n');
    expect(salvageGenericFields(text).totalAmount).toBeUndefined();
  });

  it('never guesses a billing ID (a wrong one matches the wrong expense)', () => {
    const text = ['Αριθμός παροχής', '9 99935585-016'].join('\n');
    expect(salvageGenericFields(text).billingId).toBeUndefined();
  });

  it('reads a labelled issue date, including the tonos-less OCR spelling', () => {
    expect(
      iso(salvageGenericFields('Ημ/νία Εκδοσης\n25/06/2026').issueDate)
    ).toBe('2026-06-25');
    expect(
      iso(salvageGenericFields('ΗΜ/ΝΙΑ ΕΚΔΟΣΗΣ\n07/05/2026').issueDate)
    ).toBe('2026-05-07');
  });

  it('reads the right dates when the whole ΕΥΔΑΠ page is ONE line', () => {
    // extractTextFromPdf joins a whole page with spaces, so the digital path
    // delivers one line. Matching the label then scanning the WHOLE line returned
    // the first date on the page: on the real ΕΥΔΑΠ bill that reported the ISSUE
    // date (07/05) as the payment DEADLINE — a month early, on the card the
    // operator reads to decide what to pay.
    const forward =
      'ΕΥΔΑΠ ΗΜ/ΝΙΑ ΕΚΔΟΣΗΣ 07/05/2026 ΛΗΞΗ ΠΡΟΘΕΣΜΙΑΣ ΠΛΗΡΩΜΗΣ 05/06/2026 ΠΛΗΡΩΤΕΟ (ΕΥΡΩ) : 72,11';
    const a = salvageGenericFields(forward);
    expect(iso(a.issueDate)).toBe('2026-05-07');
    expect(iso(a.dueDate)).toBe('2026-06-05');
    expect(a.totalAmount).toBe(72.11);

    // Order-independent: the bug reported wrong values in BOTH label orders.
    const reversed =
      'ΕΥΔΑΠ ΛΗΞΗ ΠΡΟΘΕΣΜΙΑΣ ΠΛΗΡΩΜΗΣ 05/06/2026 ΗΜ/ΝΙΑ ΕΚΔΟΣΗΣ 07/05/2026 ΠΛΗΡΩΤΕΟ (ΕΥΡΩ) : 72,11';
    const b = salvageGenericFields(reversed);
    expect(iso(b.issueDate)).toBe('2026-05-07');
    expect(iso(b.dueDate)).toBe('2026-06-05');
  });

  it('reports no date for a fully COLUMNAR layout it cannot pair (ΕΥΔΑΠ)', () => {
    // Real ΕΥΔΑΠ: the label is followed by three MORE labels before any value,
    // so the first date within reach belongs to another column. Reporting
    // nothing is correct; reporting the neighbour's date is not.
    const text = [
      'ΛΗΞΗ ΠΡΟΘΕΣΜΙΑΣ ΠΛΗΡΩΜΗΣ',
      'ΠΟΣΟ ΠΛΗΡΩΜΗΣ (ΕΥΡΩ)',
      'ΠΕΡΙΟΔΟΣ ΚΑΤΑΝΑΛΩΣΗΣ',
      'ΑΡΙΘΜΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ',
      '05/06/2026'
    ].join('\n');
    expect(salvageGenericFields(text).dueDate).toBeUndefined();
  });

  it('rejects a calendar-invalid OCR date instead of rolling it over', () => {
    // 31/02 would roll to March 3 — a date the document never states.
    expect(
      salvageGenericFields('Ημ/νία Εκδοσης\n31/02/2026').issueDate
    ).toBeUndefined();
  });

  it('only reports an RF code whose ISO-11649 checksum passes', () => {
    const good = 'RF33999000000000000000001';
    expect(salvageGenericFields(`Κωδικός\n${good}`).rfCode).toBe(good);
    // one digit changed → checksum fails → must not be offered as a payment ref
    expect(
      salvageGenericFields('Κωδικός\nRF33999000000000000000002').rfCode
    ).toBeUndefined();
  });

  it('returns an empty object for empty input rather than throwing', () => {
    expect(salvageGenericFields('')).toEqual({});
    expect(salvageGenericFields(undefined)).toEqual({});
  });
});
