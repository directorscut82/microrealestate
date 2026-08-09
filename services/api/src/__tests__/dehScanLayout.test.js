/**
 * ΔΕΗ scanned-bill layout regression suite.
 *
 * WHY THIS EXISTS: on 2026-08-09 the landlord imported three real ΔΕΗ bills
 * through «Εισαγωγή λογαριασμών» and ALL THREE failed with «Δεν βρέθηκε αριθμός
 * παροχής», after ~51s of OCR each. The OCR had in fact read every field
 * correctly — the parser threw the whole extraction away because on a CamScanner
 * scan the OCR emits the LABEL column first and the VALUE column after, so a
 * label and its value land on SEPARATE lines:
 *
 *     Αριθμός παροχής        <- label line
 *     9 99935585-016         <- value line
 *
 * while every regex in deh.ts required the value on the label's own line. Four
 * of the parser's eight fields were affected (παροχή, period, issue date, due
 * date); amount / RF / paymentCode matched anyway because they are not
 * label-anchored.
 *
 * A SECOND, INDEPENDENT bug surfaced in the same corpus: the OCR renders
 * «Ημ/νία Εκδοσης» WITHOUT the tonos, and the pattern demanded «Έκδοσης`.
 *
 * The fixtures are the REAL OCR output of the real scans, byte-for-byte in
 * layout, with identity-bearing values replaced by the repo's synthetic
 * placeholders (`999…` band, ΔΟΚΙΜΗ ΚΑΠΠΑ / ΟΔΟΣ ΗΤΑ) per CLAUDE.md — the
 * layout is what is under test, so it must not be tidied.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseDehBill } from '../managers/billparser/deh.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

// Ground truth read off the scans by eye (see BILL_OCR_INBOX_PLAN §17-style
// per-field table). Every value here was confirmed against the fixture text.
const CASES = [
  {
    file: 'deh-scan-2026-06.txt',
    totalAmount: 120.0,
    billingIdNormalized: '999935585016',
    periodStart: '2026-05-28',
    periodEnd: '2026-06-22',
    issueDate: '2026-06-25',
    dueDate: '2026-07-16'
  },
  {
    file: 'deh-scan-2026-05.txt',
    totalAmount: 153.0,
    billingIdNormalized: '999935585016',
    periodStart: '2026-04-27',
    periodEnd: '2026-05-27',
    issueDate: '2026-06-02',
    // The line directly under «ΕΞΟΦΛΗΣΗ ΕΩΣ» on this scan is ANOTHER label
    // («Τιμολόγιο:»); the date is the line after it. A naive next-line-only
    // rule finds nothing here and the next date in the file belongs to
    // «Επόμενη καταμέτρηση» (24/06) — so this case is the one that pins the
    // label-skipping behaviour to the CORRECT date.
    dueDate: '2026-06-23'
  },
  {
    file: 'deh-scan-2026-04.txt',
    totalAmount: 265.0,
    // Same παροχή, printed WITHOUT the space after the leading digit on this
    // scan ("999935585-016" vs "9 99935585-016") — normalisation must collapse
    // both to the same key or the bill matches no expense.
    billingIdNormalized: '999935585016',
    periodStart: '2026-03-24',
    periodEnd: '2026-04-26',
    issueDate: '2026-04-29',
    dueDate: '2026-05-21'
  }
];

describe('DEH scanned-bill layout (label and value on separate OCR lines)', () => {
  for (const c of CASES) {
    describe(c.file, () => {
      const result = () => parseDehBill(fixture(c.file));

      it('parses successfully (regression: all three failed on παροχή)', () => {
        const r = result();
        expect(r.error).toBeUndefined();
        expect(r.success).toBe(true);
      });

      it('extracts the αριθμός παροχής from the following line', () => {
        expect(result().bill?.billingIdNormalized).toBe(c.billingIdNormalized);
      });

      it('extracts the total amount', () => {
        expect(result().bill?.totalAmount).toBe(c.totalAmount);
      });

      it('extracts the consumption period from the two following lines', () => {
        const b = result().bill;
        expect(iso(b?.periodStart)).toBe(c.periodStart);
        expect(iso(b?.periodEnd)).toBe(c.periodEnd);
      });

      it('extracts the issue date despite the missing tonos (Εκδοσης)', () => {
        expect(iso(result().bill?.issueDate)).toBe(c.issueDate);
      });

      it('extracts the due date, skipping interleaved label lines', () => {
        expect(iso(result().bill?.dueDate)).toBe(c.dueDate);
      });

      it('keeps the RF code (checksum-valid) and payment code', () => {
        const b = result().bill;
        expect(b?.rfCode).toMatch(/^RF\d+$/);
        expect(b?.paymentCode).toBeDefined();
      });
    });
  }

  // ——— The guard rails. These are the reason the lookahead is bounded and
  // label-aware rather than a loose [\s\S]*? — periodEnd picks the month every
  // tenant is charged, and the import dialog renders the period as STATIC text
  // the operator cannot correct before confirming.

  it('does NOT pair a label with a DIFFERENT field value further down', () => {
    // «Αριθμός παροχής» with no value of its own; the next value-shaped line is
    // an Α/Α λογαριασμού. Pairing them would invent a παροχή and could match
    // the bill to the wrong expense.
    const text = [
      'Αριθμός παροχής',
      'Η κατανάλωσή σας',
      'Α/Α Λογαριασμού',
      '1999000001',
      'Συνολικό ποσό πληρωμής',
      '*120,00€'
    ].join('\n');
    const r = parseDehBill(text);
    expect(r.success).toBe(false);
    expect(r.error).toBe('Δεν βρέθηκε αριθμός παροχής');
  });

  it('does NOT take «Επόμενη καταμέτρηση»’s date as the period end', () => {
    // WRONG-MONTH BUG caught by adversarial review of this fix. With the first
    // period date on the LABEL line, the lookahead skipped the «Επόμενη
    // καταμέτρηση:» label and took the NEXT METER READING's date as periodEnd →
    // computeDefaultTerm charged every tenant in the building for April instead
    // of March. A label AFTER the first date must terminate the pairing.
    const text = [
      'ΔΕΗ A.E.',
      'dei.gr',
      'Αριθμός παροχής 9 99935585-03 2',
      'Συνολικό ποσό πληρωμής *186,21€',
      'Περίοδος Κατανάλωσης 25/02/2026',
      'Επόμενη καταμέτρηση:',
      '24/04/2026'
    ].join('\n');
    const r = parseDehBill(text);
    expect(r.success).toBe(false);
    expect(r.error).toBe('Δεν βρέθηκε περίοδος κατανάλωσης');
    // and the salvaged partial must not assert a period either
    expect(r.partial?.periodEnd).toBeUndefined();
  });

  it('still pairs the two dates when they are consecutive after the label', () => {
    // The pure-columnar layout must keep working: labels precede the value
    // column, so a label BEFORE any date is still skipped.
    const text = [
      'Αριθμός παροχής',
      '9 99935585-016',
      'Συνολικό ποσό πληρωμής',
      '*120,00€',
      'Περίοδος Κατανάλωσης',
      'Σκανάρετε',
      '28/05/2026',
      '22/06/2026'
    ].join('\n');
    const r = parseDehBill(text);
    expect(r.success).toBe(true);
    expect(iso(r.bill?.periodStart)).toBe('2026-05-28');
    expect(iso(r.bill?.periodEnd)).toBe('2026-06-22');
  });

  it('refuses a period when only ONE of the two dates is present', () => {
    const text = [
      'Αριθμός παροχής',
      '9 99935585-016',
      'Συνολικό ποσό πληρωμής',
      '*120,00€',
      'Περίοδος Κατανάλωσης',
      '28/05/2026',
      'Ημέρες',
      '26',
      'Ημ/νία Εκδοσης',
      '25/06/2026'
    ].join('\n');
    const r = parseDehBill(text);
    // The second date must NOT be harvested from «Ημ/νία Εκδοσης».
    expect(r.success).toBe(false);
    expect(r.error).toBe('Δεν βρέθηκε περίοδος κατανάλωσης');
  });

  it('rejects an inverted period rather than silently swapping it', () => {
    const text = [
      'Αριθμός παροχής',
      '9 99935585-016',
      'Συνολικό ποσό πληρωμής',
      '*120,00€',
      'Περίοδος Κατανάλωσης',
      '22/06/2026',
      '28/05/2026'
    ].join('\n');
    const r = parseDehBill(text);
    expect(r.success).toBe(false);
    expect(r.error).toBe('Μη έγκυρες ημερομηνίες περιόδου κατανάλωσης');
  });

  it('still parses the ONE-LINE (pdfjs text-layer) layout unchanged', () => {
    // The non-scanned path must be untouched by the lookahead.
    const text = [
      'ΔΕΗ A.E.',
      'dei.gr',
      'Αριθμός παροχής 9 99935585-03 2',
      'Συνολικό ποσό πληρωμής *186,21€',
      'ΕΞΟΦΛΗΣΗ ΕΩΣ 22/04/2026',
      'Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026',
      'Ημ/νία Έκδοσης 27/03/2026'
    ].join('\n');
    const r = parseDehBill(text);
    expect(r.success).toBe(true);
    expect(r.bill?.billingIdNormalized).toBe('999935585032');
    expect(r.bill?.totalAmount).toBe(186.21);
    expect(iso(r.bill?.periodStart)).toBe('2026-02-25');
    expect(iso(r.bill?.periodEnd)).toBe('2026-03-23');
    expect(iso(r.bill?.issueDate)).toBe('2026-03-27');
    expect(iso(r.bill?.dueDate)).toBe('2026-04-22');
  });

  // Found by adversarially probing my own fix (Step 7): DEH prints its OWN
  // freephone numbers on every bill, and the first version of the supply-value
  // pattern (`^\d[\d \t-]{7,20}\d$`) ACCEPTED "800-900-1000". A παροχή label
  // landing above a phone line would have turned a support number into a billing
  // ID — matching the bill to the wrong expense, or creating a bogus one.
  it('never takes a ΔΕΗ freephone number as the αριθμός παροχής', () => {
    for (const phone of ['800-900-1000', '800 400 4000', '801 200 5000']) {
      const text = [
        'Αριθμός παροχής',
        phone,
        'Συνολικό ποσό πληρωμής',
        '*120,00€',
        'Περίοδος Κατανάλωσης',
        '28/05/2026',
        '22/06/2026'
      ].join('\n');
      const r = parseDehBill(text);
      // (jest's expect takes ONE argument — the phone is named in the loop body
      // above, so a failure here identifies itself from the assertion output.)
      expect({ phone, success: r.success }).toEqual({ phone, success: false });
      expect(r.error).toBe('Δεν βρέθηκε αριθμός παροχής');
    }
  });

  // Also found by self-probe: `line.replace(label, ' ')` leaves the substituted
  // space, so an ANCHORED value pattern could never match on the label's own
  // line and the same-line branch of findLabelledValue was silently dead.
  // Exercised here through the issue date, whose value CAN sit beside its label.
  it('reads a value that sits on the label line itself (trim after replace)', () => {
    const text = [
      'Αριθμός παροχής',
      '9 99935585-016',
      'Συνολικό ποσό πληρωμής',
      '*120,00€',
      'Περίοδος Κατανάλωσης',
      '28/05/2026',
      '22/06/2026',
      'Ημ/νία Εκδοσης 25/06/2026',
      'ΕΞΟΦΛΗΣΗ ΕΩΣ 16/07/2026'
    ].join('\n');
    const r = parseDehBill(text);
    expect(r.success).toBe(true);
    expect(iso(r.bill?.issueDate)).toBe('2026-06-25');
    expect(iso(r.bill?.dueDate)).toBe('2026-07-16');
  });

  it('carries partial fields on a FAILED parse instead of discarding them', () => {
    // The 2026-08-09 report: the παροχή is unreadable but everything else is
    // present. The operator must SEE the amount/period rather than only an error.
    const text = [
      'ΔΕΗ Α.Ε.',
      'Συνολικό ποσό πληρωμής',
      '*120,00€',
      'Περίοδος Κατανάλωσης',
      '28/05/2026',
      '22/06/2026',
      'Ημ/νία Εκδοσης',
      '25/06/2026'
    ].join('\n');
    const r = parseDehBill(text);
    expect(r.success).toBe(false);
    expect(r.error).toBe('Δεν βρέθηκε αριθμός παροχής');
    expect(r.partial?.totalAmount).toBe(120);
    expect(iso(r.partial?.periodStart)).toBe('2026-05-28');
    expect(iso(r.partial?.periodEnd)).toBe('2026-06-22');
    expect(iso(r.partial?.issueDate)).toBe('2026-06-25');
    // STABLE CODES, not Greek prose — the client maps them through its own i18n
    // keys. Emitting Greek here rendered untranslated under a German heading.
    expect(r.partial?.missingFields).toContain('billingId');
    // and it must NOT be presented as a usable bill
    expect(r.bill).toBeUndefined();
  });

  // ——— The four bugs adversarial review found in THIS fix. All four are
  // money-bearing: two derive the wrong charged MONTH, one fabricates a payment
  // deadline (late fees), one matches the bill to the wrong expense.

  it('reads the right dates when the whole page is ONE line (pdfjs digital path)', () => {
    // extractTextFromPdf joins every text item of a page with spaces, so a
    // digital bill arrives as a single line. Matching the label then scanning the
    // WHOLE line returned the first date on the page, collapsing issueDate and
    // dueDate onto the period's start date.
    const oneLine =
      'ΔΕΗ A.E. dei.gr Αριθμός παροχής 9 99935585-03 2 ' +
      'Συνολικό ποσό πληρωμής *186,21€ ' +
      'Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026 ' +
      'ΕΞΟΦΛΗΣΗ ΕΩΣ 22/04/2026 Ημ/νία Έκδοσης 27/03/2026';
    const r = parseDehBill(oneLine);
    expect(r.success).toBe(true);
    expect(iso(r.bill?.periodStart)).toBe('2026-02-25');
    expect(iso(r.bill?.periodEnd)).toBe('2026-03-23');
    expect(iso(r.bill?.issueDate)).toBe('2026-03-27');
    expect(iso(r.bill?.dueDate)).toBe('2026-04-22');
  });

  it('does not build a period from dates printed BEFORE the label', () => {
    // Same one-line page, but the period uses an EN-DASH, which the strict
    // pattern rejects. The fallback used a GLOBAL match over the line and
    // harvested «ΕΞΟΦΛΗΣΗ ΕΩΣ» + «Επόμενη καταμέτρηση» as the period → APRIL for
    // a MARCH bill, charging every tenant in the building for the wrong month.
    const oneLine =
      'ΔΕΗ A.E. Αριθμός παροχής 9 99935585-03 2 Συνολικό ποσό πληρωμής *186,21€ ' +
      'ΕΞΟΦΛΗΣΗ ΕΩΣ 22/04/2026 Επόμενη καταμέτρηση: 24/04/2026 ' +
      'Περίοδος Κατανάλωσης 25/02/2026 – 23/03/2026';
    const r = parseDehBill(oneLine);
    expect(iso(r.bill?.periodStart)).toBe('2026-02-25');
    expect(iso(r.bill?.periodEnd)).toBe('2026-03-23');
  });

  it('never takes «Επόμενη καταμέτρηση»’s date as the payment due date', () => {
    // That label owns the NEXT METER READING date. It used to be skip-listed, so
    // the due-date lookahead hopped over it and returned its date — telling the
    // landlord the bill is due weeks later than it is.
    const text = [
      'Αριθμός παροχής',
      '9 99935585-016',
      'Συνολικό ποσό πληρωμής',
      '*120,00€',
      'Περίοδος Κατανάλωσης',
      '28/05/2026',
      '22/06/2026',
      'ΕΞΟΦΛΗΣΗ ΕΩΣ',
      'Σκανάρετε',
      'Επόμενη καταμέτρηση:',
      '24/07/2026'
    ].join('\n');
    const r = parseDehBill(text);
    expect(r.success).toBe(true);
    expect(r.bill?.dueDate).toBeUndefined();
  });

  it('never takes the Α/Α Λογαριασμού serial as the αριθμός παροχής', () => {
    // «Εκκαθαριστικός» / «λογαριασμός» precede the account serial on every real
    // scan. Skip-listing them let a 10-digit serial — which satisfies the supply
    // shape — become the billing ID, matching the bill to the wrong expense (and
    // the serial changes monthly, so it would spawn a new έξοδο every month).
    const text = [
      'Αριθμός παροχής',
      'Εκκαθαριστικός',
      'λογαριασμός',
      '1999000001',
      'Συνολικό ποσό πληρωμής',
      '*120,00€',
      'Περίοδος Κατανάλωσης',
      '28/05/2026',
      '22/06/2026'
    ].join('\n');
    const r = parseDehBill(text);
    expect(r.success).toBe(false);
    expect(r.error).toBe('Δεν βρέθηκε αριθμός παροχής');
  });

  it('parses a grouped-digit line in linear time (no catastrophic backtracking)', () => {
    // The supply pattern used a counting lookahead whose inner class contained the
    // digit it counted, so a subject failing the final anchor was re-partitioned
    // exponentially: MEASURED 176ms at 5 digit-groups, 1.5s at 7, 9.3s at 8 — on a
    // 41-char line. Node is single-threaded, so that stalled the WHOLE api, and an
    // ordinary grouped-digit OCR row triggers it (the real ΕΥΔΑΠ scan has a
    // 5-group one). Guard the COMPLEXITY, not just the result.
    const line = Array.from({ length: 12 }, () => '1234').join(' ') + ' x';
    const text = [
      'Αριθμός παροχής',
      line,
      'Συνολικό ποσό πληρωμής',
      '*120,00€'
    ].join('\n');
    const t0 = Date.now();
    parseDehBill(text);
    const elapsed = Date.now() - t0;
    // Linear behaviour is ~1ms here; the old form needed minutes at 12 groups.
    // 500ms is a deliberately loose ceiling so this cannot flake on a busy machine
    // while still failing hard if the exponential form ever returns.
    expect(elapsed).toBeLessThan(500);
  });

  it('rejects an over-long digit run as the αριθμός παροχής', () => {
    // The documented "9-12 digits" bound did not exist: `{9,12}` counted regex
    // ITERATIONS, not digits, so 13/18/25-digit runs all passed. A real ΕΥΔΑΠ
    // ΑΡΙΘΜΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ (18 digits) was accepted as a παροχή — a wrong billing
    // key that matches no expense, or the wrong one, and gets stamped onto a new
    // δαπάνη by the create-expense prefill.
    const imposters = [
      '2026 0009 9990 0000 01', // ΕΥΔΑΠ document number, 18 digits
      '19990000099990001', // cash-stub row, 17 digits
      '0000099990 0000099990', // 20 digits
      '00099999' // 8-digit meter reading — below the bound
    ];
    for (const v of imposters) {
      const text = [
        'Αριθμός παροχής',
        v,
        'Συνολικό ποσό πληρωμής',
        '*120,00€',
        'Περίοδος Κατανάλωσης',
        '28/05/2026',
        '22/06/2026'
      ].join('\n');
      const r = parseDehBill(text);
      expect({ v, success: r.success }).toEqual({ v, success: false });
    }
    // …while the real shapes still pass and normalise to one key.
    for (const v of ['9 99935585-016', '999935585-016', '999935585016']) {
      const text = [
        'Αριθμός παροχής',
        v,
        'Συνολικό ποσό πληρωμής',
        '*120,00€',
        'Περίοδος Κατανάλωσης',
        '28/05/2026',
        '22/06/2026'
      ].join('\n');
      const r = parseDehBill(text);
      expect({ v, id: r.bill?.billingIdNormalized }).toEqual({
        v,
        id: '999935585016'
      });
    }
  });

  it('does not let the lookahead cross into the next page of a multi-page scan', () => {
    // A παροχή label at the very end of page 1 with the value column on page 2
    // is NOT a pairing this parser is willing to assert.
    const text = [
      'Αριθμός παροχής',
      '',
      '--- PAGE BREAK ---',
      '',
      'ΔΕΗ Α.Ε.',
      '9 99935585-016'
    ].join('\n');
    const r = parseDehBill(text);
    expect(r.success).toBe(false);
  });
});
