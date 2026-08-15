/**
 * The ΕΥΔΑΠ parser (Slice 3), against a real photographed bill's OCR layout.
 *
 * THE FIXTURE IS SYNTHETIC BY CONSTRUCTION. It is the real 127-line OCR output with
 * every identifying value substituted — the ΑΦΜ-band account number, the `ΟΔΟΣ ΑΛΦΑ`
 * street placeholder, a synthetic name — because this repo is public and a real
 * utility bill carries the account holder's name, address, supply number, meter
 * serial and AADE MARK. The LAYOUT and every OCR corruption are preserved verbatim,
 * which is the part that has to be tested: «ΑΡΙΘΜΟΙ ΛΟΓΑΠΙΑΣΜΟΥ» for ΑΡΙΘΜΟΣ,
 * «ΑΠΙΟΜΟΙ ΜΕΤΠΗΤΗ», «Α.Ο.M.» for Α.Φ.Μ., «nάpoxoc:» for Πάροχος, «758» for 75%.
 *
 * WHY EACH ASSERTION EXISTS. Every one below corresponds to a defect the first
 * version of this parser actually had, found by running it against the real bill
 * rather than against my own expectations of one:
 *
 *  1. ΑΠΟΧΕΤΕΥΣΗ (€28,81 of €89,94 — a THIRD of the bill) was silently absent,
 *     because its value is printed three lines ABOVE its label. That alone would
 *     have been visible. What made it dangerous: the missing field turned
 *     `haveWholeBreakdown` false, which SKIPPED the sum-to-subtotal check — the one
 *     assertion that would have caught it. A consistency check that quietly declines
 *     to run reads exactly like one that passed.
 *  2. The recipient's NAME was returned as the street, because one digit-free
 *     pattern matched both and a street always carries a number.
 *  3. ΗΜΕΡΕΣ ΚΑΤΑΝΑΛΩΣΗΣ was unreachable — its label is merged with the next one on
 *     a single OCR line and its value sits eight lines away in the value run.
 *  4. The e-invoicing provider was missed: «Πάροχος:» OCRs as «nάpoxoc:», so
 *     anchoring on the first letter fails.
 *  5. The billing PERIOD competed with «ΕΠΟΜΕΝΗ ΚΑΤΑΜΕΤΡΗΣΗ: 18/10-24/10», which is
 *     the same shape. It got the right answer only from document order — had that
 *     line printed first, the bill would have been charged to OCTOBER, with no
 *     symptom at all because the amount and the παροχή would both still be right.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseEydapBill } from '../managers/billparser/eydap.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OCR = fs.readFileSync(
  path.join(HERE, 'fixtures/eydap-ocr.synthetic.txt'),
  'utf8'
);

describe('ΕΥΔΑΠ parser — the fixture itself', () => {
  it('contains only SYNTHETIC identifiers', () => {
    // The first version of this test listed the real account number, name, street
    // and area as forbidden strings — so the test guarding against PII CONTAINED the
    // PII, and `scripts/scan-pii.mjs` blocked the commit. Correctly.
    //
    // Structural instead of a denylist: every long digit run in the fixture must be
    // one this repo mints deliberately. That is stronger than naming values to
    // exclude (it catches an identifier nobody thought to list) and it names nothing
    // real, so the test itself can never become the leak.
    const runs = [...OCR.matchAll(/\d{7,}/g)].map((m) => m[0]);
    expect(runs.length).toBeGreaterThan(3);
    const SYNTHETIC = [
      '99900011122', // account number
      '9990001', // registry number
      '499900000000001', // AADE MARK
      '999000009', // envelope reference
      '9999999', // freephone
      '0000089946', // the barcode's amount field
      '2026999000010002030000089942026090109990001',
      '12026090199900010',
      '2026090199900010'
    ];
    const unexpected = runs.filter(
      (r) => !SYNTHETIC.some((ok) => r.includes(ok) || ok.includes(r))
    );
    expect(unexpected).toEqual([]);
  });

  it('uses the reserved synthetic placeholders for name and address', () => {
    // ΟΔΟΣ ΑΛΦΑ is the repo's street placeholder; the name is invented.
    expect(OCR).toContain('ΟΔΟΣ ΑΛΦΑ 24');
    expect(OCR).toContain('ΠΑΠΑΔΟΠΟΥΛΟΣ ΝΙΚΟΣ');
  });

  it('preserves the OCR corruption the parser has to survive', () => {
    // If a future edit "tidies" the fixture, the label-tolerance below stops being
    // tested and the parser silently becomes brittle against real photographs.
    for (const mangled of [
      'ΑΡΙΘΜΟΙ ΛΟΓΑΠΙΑΣΜΟΥ', // Ρ -> Π
      'ΑΠΙΟΜΟΙ ΜΕΤΠΗΤΗ',
      'Α.Ο.M.', // Α.Φ.Μ.
      'nάpoxoc', // Πάροχος
      '758' // 75%
    ]) {
      expect({ mangled, present: OCR.includes(mangled) }).toEqual({
        mangled,
        present: true
      });
    }
  });
});

describe('ΕΥΔΑΠ parser — money', () => {
  const r = parseEydapBill(OCR);

  it('parses successfully', () => {
    expect({ success: r.success, error: r.error }).toEqual({
      success: true,
      error: undefined
    });
  });

  it('reads ΠΛΗΡΩΤΕΟ as what is owed', () => {
    expect(r.bill.totalAmount).toBe(89.94);
  });

  it('reads ΜΕΡΙΚΟ ΣΥΝΟΛΟ separately as what tenants may be charged', () => {
    // Equal here because this bill has no prior balance. They must stay SEPARATE
    // fields regardless: splitting ΠΛΗΡΩΤΕΟ would bill tenants the landlord's
    // arrears, and splitting ΜΕΡΙΚΟ ΣΥΝΟΛΟ when it is the only figure read would
    // under-report the debt.
    expect(r.bill.chargeableAmount).toBe(89.94);
  });

  it('recovers the ENTIRE breakdown, including the one printed above its label', () => {
    // ΑΠΟΧΕΤΕΥΣΗ is 28,81 of 89,94 — a third of the bill — and was silently null.
    expect(r.bill.details.breakdown).toEqual({
      charges: 38.41,
      fixedFee: 8.7,
      environmentalFee: 0.03,
      sewerage: 28.81,
      vatOnCharges: 4.99,
      vatOnOther: 9
    });
  });

  it("the breakdown sums to the subtotal — the document's own arithmetic", () => {
    const b = r.bill.details.breakdown;
    const sum =
      Math.round(Object.values(b).reduce((s, v) => s + v, 0) * 100) / 100;
    expect(sum).toBe(r.bill.chargeableAmount);
  });

  it('does NOT warn that the breakdown fails to sum (the check must RUN)', () => {
    // The defect was not a wrong warning — it was NO warning, because a null field
    // skipped the check entirely. Asserting the absence of the warning is only
    // meaningful alongside the assertion above that every field is present.
    expect(r.bill.warnings || []).not.toContain(
      'breakdown-does-not-sum-to-subtotal'
    );
  });
});

describe('ΕΥΔΑΠ parser — identity and matching', () => {
  const r = parseEydapBill(OCR);

  it('uses the ΑΡΙΘΜΟΣ ΜΕΤΡΗΤΗ as the primary key', () => {
    // The first version keyed on the ΑΡΙΘΜΟΣ ΛΟΓΑΡΙΑΣΜΟΥ because that is what you
    // pay with — the wrong axis. The account number and the μητρώο identify a
    // CONTRACT, which moves when the customer changes or the account is re-issued.
    // The meter is the physical thing bolted to the building, so matching on it
    // answers everything at once: which building, κοινόχρηστο or ιδιωτικό (whether
    // it is in `sharedMeters` or on a `unit`), and whether a δαπάνη exists already.
    expect(r.bill.billingId).toBe('A99E90001');
    expect(r.bill.billingIdNormalized).toBe('A99E90001');
    expect(r.bill.details.meterSerial).toBe('A99E90001');
  });

  it('keeps the billing numbers as alternates for data entered before that', () => {
    // Not hedging: a landlord who already typed the account number into
    // `eydapNumber` must still match rather than be told their own bill is
    // unrecognised.
    // The 11-digit BODY rides along too: the 14-digit form is outside supplyBody's
    // 9-12 window and could only match by exact string equality.
    expect(r.bill.alternateBillingIds).toEqual([
      '99900011122003',
      '99900011122',
      '999000133'
    ]);
  });

  it('reads the tariff class', () => {
    expect(r.bill.details.tariff).toBe('Β1');
  });

  it('reads the SCANNABLE payment string, not the document number', () => {
    // This assertion used to expect the 18-digit ΑΡ. ΠΑΡΑΣΤΑΤΙΚΟΥ — the FALLBACK — and
    // so encoded a defect as the expected behaviour. The cause was in the fixture: my
    // synthetic substitution grew the payment line to 43 digits where the real bill has
    // 41, `PAYMENT_STRING` never matched, and every test therefore ran the fallback
    // path while the barcode had no coverage at all. The real bill was always parsed
    // correctly, which is exactly why nothing looked wrong.
    expect(r.bill.paymentCode).toBe(
      '20269990000100020000089942026090109990001'
    );
    expect(r.bill.details.paymentString).toBe(r.bill.paymentCode);
    expect(r.bill.rfCode).toBeUndefined();
  });

  it('the payment string corroborates all four fields it encodes', () => {
    // 16+9+8+8. Each part must agree with a value read INDEPENDENTLY elsewhere on the
    // bill, because a scannable code built from a misread digit pays the wrong invoice —
    // and a wrong code that scans is far worse than no code.
    const v = r.bill.details.paymentString;
    expect(v).toHaveLength(41);
    // amount in cents -> ΠΛΗΡΩΤΕΟ
    expect(parseInt(v.slice(16, 25), 10) / 100).toBe(r.bill.totalAmount);
    // due date -> ΗΜ/ΝΙΑ ΛΗΞΕΩΣ
    const d = r.bill.dueDate;
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    expect(v.slice(25, 33)).toBe(ymd);
    // registry number -> ΑΡΙΘΜΟΣ ΜΗΤΡΩΟΥ
    expect(String(parseInt(v.slice(33, 41), 10))).toBe(
      r.bill.details.registryNumber.replace('-33', '')
    );
    // document number prefix -> ΑΡ. ΠΑΡΑΣΤΑΤΙΚΟΥ
    expect(r.bill.details.documentNumber.replace(/\s/g, '')).toContain(
      v.slice(0, 16)
    );
  });

  it('REFUSES a payment string that does not corroborate', () => {
    // The guard that matters: a 41-digit run whose amount disagrees with ΠΛΗΡΩΤΕΟ is a
    // misread, so it must be reported and NOT used as a payable code.
    const broken = OCR.replace(
      '20269990000100020000089942026090109990001',
      '20269990000100020000099992026090109990001' // amount 99,99 vs ΠΛΗΡΩΤΕΟ 89,94
    );
    const b = parseEydapBill(broken).bill;
    expect(b.warnings).toContain('payment-string-does-not-corroborate');
    // Falls back to the document number rather than shipping a wrong scannable code.
    expect(b.paymentCode).toBe('202699900001000203');
    expect(b.details.paymentString).toBeNull();
  });

  it('reads the AADE MARK and the e-invoicing provider despite «nάpoxoc»', () => {
    expect(r.bill.details.mark).toBe('499900000000001');
    expect(r.bill.details.einvoiceProvider).toBe('Epsilon Digital');
  });

  it('separates the recipient NAME from the STREET', () => {
    expect(r.bill.details.recipient).toEqual({
      name: 'ΠΑΠΑΔΟΠΟΥΛΟΣ ΝΙΚΟΣ',
      street: 'ΟΔΟΣ ΑΛΦΑ 24',
      postCode: '11111',
      area: 'ΑΘΗΝΩΝ'
    });
  });

  it('does NOT decide κοινόχρηστος vs ιδιωτικός', () => {
    // That answer comes from WHICH list the number is found in — a shared meter
    // (water_common, split by χιλιοστά) or an apartment (water_private, that unit
    // alone). A parser that guessed would either bill a whole building's water to
    // one flat or split one flat's water across the building. So there must be no
    // such field on the parse result at all.
    expect(r.bill.details.isShared).toBeUndefined();
    expect(r.bill.details.expenseType).toBeUndefined();
    expect(r.bill.details.allocationMethod).toBeUndefined();
  });
});

describe('ΕΥΔΑΠ parser — the period, which decides WHICH MONTH is charged', () => {
  const r = parseEydapBill(OCR);

  it('takes the ΠΕΡΙΟΔΟΣ ΚΑΤΑΝΑΛΩΣΗΣ, not the ΕΠΟΜΕΝΗ ΚΑΤΑΜΕΤΡΗΣΗ range', () => {
    // Both are «dd/mm/yyyy-dd/mm/yyyy». The next-reading range is 18/10–24/10; had
    // it won, the bill would land in OCTOBER instead of July with no visible symptom.
    expect(r.bill.periodStart.toISOString()).toBe('2026-04-28T00:00:00.000Z');
    expect(r.bill.periodEnd.toISOString()).toBe('2026-07-23T00:00:00.000Z');
  });

  it('keeps the next-reading window as data, not as the period', () => {
    expect(r.bill.details.nextReading).toEqual({
      from: '18/10/2026',
      to: '24/10/2026'
    });
  });

  it('does NOT warn about the quarterly period — that is how ΕΥΔΑΠ meters work', () => {
    // ΕΥΔΑΠ reads meters quarterly, so ~3 months is what EVERY Greek water bill
    // covers. Warning about it would fire on every bill ever imported and train the
    // operator to dismiss warnings, including the ones that matter. Kept as data.
    expect(r.bill.warnings || []).not.toContain('period-spans-multiple-months');
    expect(r.bill.details.monthsSpanned).toBe(4);
  });

  it('a clean bill carries NO warnings at all', () => {
    // The whole array is absent, not merely free of one code: a self-consistent
    // quarterly water bill is the NORMAL case and must present as unremarkable.
    expect(r.bill.warnings).toBeUndefined();
  });

  it('reads both dates, whose labels sit 3-4 lines from their values', () => {
    expect(r.bill.issueDate.toISOString()).toBe('2026-08-04T00:00:00.000Z');
    expect(r.bill.dueDate.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('builds dates in UTC so the term cannot slip a month', () => {
    // A local-time Date in Athens summer (UTC+3) turns a period ending 01/08 into
    // July 31 21:00Z, and computeDefaultTerm reads getUTCMonth() — the whole bill
    // would be charged to the wrong month.
    for (const d of [r.bill.periodStart, r.bill.periodEnd, r.bill.issueDate]) {
      expect({
        h: d.getUTCHours(),
        m: d.getUTCMinutes(),
        s: d.getUTCSeconds()
      }).toEqual({ h: 0, m: 0, s: 0 });
    }
  });
});

describe('ΕΥΔΑΠ parser — consumption', () => {
  const r = parseEydapBill(OCR);
  const c = () => r.bill.details.consumption;

  it('reads the volume, both meter readings and the day count', () => {
    expect(c()).toMatchObject({
      cubicMetres: 61,
      previousReading: 6000,
      currentReading: 6061,
      daysBilled: 87
    });
  });

  it('the readings satisfy the identity that defines them', () => {
    // They are LOCATED by this identity rather than by position, so it holding is
    // the reason to trust them at all.
    expect(c().currentReading - c().previousReading).toBe(c().cubicMetres);
  });

  it('reads the tiered tariff, and the tiers reconcile', () => {
    const tiers = c().tiers;
    expect(tiers).toEqual([
      { volume: 14.5, unitPrice: 0.35, amount: 5.08 },
      { volume: 43.5, unitPrice: 0.64, amount: 27.84 },
      { volume: 3, unitPrice: 1.83, amount: 5.49 }
    ]);
    const vol = tiers.reduce((s, t) => s + t.volume, 0);
    const amt = Math.round(tiers.reduce((s, t) => s + t.amount, 0) * 100) / 100;
    expect(vol).toBe(61);
    expect(amt).toBe(r.bill.details.breakdown.charges);
  });

  it('raises no reconciliation warning on a self-consistent bill', () => {
    for (const w of [
      'tiers-do-not-sum-to-consumption',
      'tier-amounts-do-not-sum-to-charges',
      'consumption-from-tiers-only'
    ]) {
      expect({ warning: w, raised: (r.bill.warnings || []).includes(w) }).toEqual({
        warning: w,
        raised: false
      });
    }
  });
});

describe('ΕΥΔΑΠ parser — degradation', () => {
  it('returns a PARTIAL rather than a bare error when a field is unreadable', () => {
    // On the real ΔΕΗ bills a single unreadable field discarded everything else the
    // OCR had read perfectly, and the landlord saw only «parse failed» after 51s.
    const noPeriod = OCR.split('\n')
      .filter((l) => !/28\/04\/2026/.test(l))
      .join('\n');
    const r = parseEydapBill(noPeriod);
    expect(r.success).toBe(false);
    expect(r.partial.missingFields).toContain('period');
    // …and what WAS read survives, so the operator can still create the έξοδο.
    expect(r.partial.totalAmount).toBe(89.94);
    expect(r.partial.billingId).toBe('A99E90001');
    expect(r.partial.issueDate.toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });

  it('reports an inverted period as missing rather than charging backwards', () => {
    const inverted = OCR.replace(
      /28\/04\/2026-23\/07\/2026/g,
      '23/07/2026-28/04/2026'
    );
    const r = parseEydapBill(inverted);
    expect(r.success).toBe(false);
    expect(r.partial.missingFields).toContain('period');
  });

  it('flags a prior balance instead of letting it be split among tenants', () => {
    // Raise ΠΛΗΡΩΤΕΟ above ΜΕΡΙΚΟ ΣΥΝΟΛΟ, which is what arrears look like.
    const lines = OCR.split('\n');
    const i = lines.findIndex((l) => /ΠΛΗΡΩΤΕΟ\(ΕΥΡΩ\)/.test(l));
    expect(i).toBeGreaterThan(-1);
    lines[i + 1] = '149,94';
    const r = parseEydapBill(lines.join('\n'));
    expect(r.success).toBe(true);
    expect(r.bill.totalAmount).toBe(149.94);
    // The chargeable figure stays this period's own charges.
    expect(r.bill.chargeableAmount).toBe(89.94);
    expect(r.bill.warnings).toContain('prior-balance-included-in-payable');
  });

  it('handles empty and junk input without throwing', () => {
    expect(parseEydapBill('').success).toBe(false);
    expect(parseEydapBill('χχχ').success).toBe(false);
    expect(parseEydapBill('').detectedProvider).toBe('eydap');
  });
});

describe('parser robustness — the shapes real OCR produces', () => {
  const lines = OCR.split('\n');

  it('walks PAST an interleaved stub label instead of calling it the name', () => {
    // The stub columns are printed side by side, so the OCR interleaves their rows: an
    // all-caps label can land between the street and the postcode. «All-caps Greek with
    // no digits» describes a LABEL as well as a person, so an earlier version accepted
    // the label as the account holder AND lost the street — a confidently wrong answer,
    // which is worse than an absent one. The street's adjacency is the only thing that
    // distinguishes the two.
    const pcIdx = lines.findIndex((l) => /^\d{5}\s+\S/.test(l.trim()));
    expect(pcIdx).toBeGreaterThan(0);
    const injected = [...lines];
    injected.splice(pcIdx, 0, 'ΑΠΟ ΛΟΓΑΡΙΑΣΜΟΥΣ');
    const r = parseEydapBill(injected.join('\n')).bill;
    expect(r.details.recipient).toEqual({
      name: 'ΠΑΠΑΔΟΠΟΥΛΟΣ ΝΙΚΟΣ',
      street: 'ΟΔΟΣ ΑΛΦΑ 24',
      postCode: '11111',
      area: 'ΑΘΗΝΩΝ'
    });
  });

  it('reports NO recipient rather than a label when there is no street', () => {
    // Absent beats wrong. Strip the street and the name must not be reported either,
    // because without the street beneath it there is nothing to tell a person from a
    // stub label.
    const noStreet = lines.filter((l) => !/ΟΔΟΣ ΑΛΦΑ 24/.test(l)).join('\n');
    const r = parseEydapBill(noStreet).bill;
    expect(r.details.recipient.name).toBeUndefined();
    expect(r.details.recipient.street).toBeUndefined();
  });

  it('drops daysBilled when the ΗΜΕΡΕΣ cell is blank', () => {
    // A blank cell emits NOTHING, so the positional read lands on whatever integer
    // follows — and ΥΔΡΟΛ / ΠΡΟΣΘΕΤΑ are small positive integers that pass a range check
    // on their own. Corroborated against the period length, so a wrong number is
    // rejected rather than used to misstate the consumption rate.
    const noDays = lines.filter((l) => l.trim() !== '87').join('\n');
    expect(
      parseEydapBill(noDays).bill.details.consumption.daysBilled
    ).toBeNull();
    // …and the unmodified bill still reports it.
    expect(
      parseEydapBill(OCR).bill.details.consumption.daysBilled
    ).toBe(87);
  });

  it('rejects a day count that contradicts the period it bills', () => {
    // 28/04–23/07 is 86 days; a read of 8 must not be accepted just because it is a
    // small positive integer.
    const wrong = OCR.replace(/^87$/m, '8');
    expect(
      parseEydapBill(wrong).bill.details.consumption.daysBilled
    ).toBeNull();
  });

  it('offers the 11-digit account BODY as an alternate, not only the 14-digit form', () => {
    // The account number normalises to 14 digits (11 + a 3-digit branch), which is
    // outside supplyBody's 9-12 window — so on its own it could match only by exact
    // string equality, and a landlord who recorded the 11-digit body would not match at
    // all. Both forms are offered, de-duplicated.
    const alts = parseEydapBill(OCR).bill.alternateBillingIds;
    expect(alts).toContain('99900011122003');
    expect(alts).toContain('99900011122');
    expect(alts).toContain('999000133');
    expect(new Set(alts).size).toBe(alts.length);
  });
});

describe('every consistency check has a test that FAILS if it is deleted', () => {
  /**
   * WHY THIS EXISTS. The parser can emit eight warning codes. Six of them had NO
   * assertion at all — neither positive nor negative — so every one of those checks
   * could be deleted and this 750-line suite would stay green. They are not decoration:
   * they are the difference between "the OCR read this bill correctly" and "these numbers
   * do not add up and a human should look", on a document that decides what tenants pay.
   *
   * A negative assertion (`not.toContain`) cannot substitute. It passes both when the
   * check is working and when the check is gone.
   *
   * Each test below feeds the parser an input that trips exactly one identity, so the
   * assertion fails the moment that identity stops being computed.
   */

  it('breakdown-does-not-sum-to-subtotal — the six lines vs ΜΕΡΙΚΟ ΣΥΝΟΛΟ', () => {
    // Move ΠΑΓΙΟ ΤΕΛΟΣ so the six current-period lines no longer reach the subtotal.
    // This is the check that catches a misread digit in the one figure tenants are
    // charged, so it is the most consequential of the eight.
    const broken = OCR.replace(/^8,70$/m, '18,70');
    const b = parseEydapBill(broken).bill;
    expect(b.warnings).toContain('breakdown-does-not-sum-to-subtotal');
    // And the clean bill must NOT report it, or the warning is just noise.
    expect(parseEydapBill(OCR).bill.warnings ?? []).not.toContain(
      'breakdown-does-not-sum-to-subtotal'
    );
  });

  it('tiers-do-not-sum-to-consumption — Σ(tier m³) vs ΚΑΤΑΝΑΛΩΣΗ', () => {
    // 14,50 + 43,50 + 3,00 = 61 m³, which matches 6061 − 6000. Break the first tier's
    // volume and the identity must report itself.
    const broken = OCR.replace('14,50M3', '24,50M3');
    const b = parseEydapBill(broken).bill;
    expect(b.warnings).toContain('tiers-do-not-sum-to-consumption');
  });

  it('tier-amounts-do-not-sum-to-charges — Σ(tier €) vs ΣΥΝΟΛΟ ΤΙΜΗΜΑΤΟΣ', () => {
    // 5,08 + 27,84 + 5,49 = 38,41. Change one and the sum no longer matches the
    // charges line it is the breakdown of.
    const broken = OCR.replace(/^5,08$/m, '6,08');
    const b = parseEydapBill(broken).bill;
    expect(b.warnings).toContain('tier-amounts-do-not-sum-to-charges');
  });

  it('registry-number-disagrees — two different ΑΡΙΘΜΟΣ ΜΗΤΡΩΟΥ on one bill', () => {
    // The registry number appears twice (header and stub). If they differ, the bill may
    // have been mis-OCR'd or two bills photographed together — and attributing it by the
    // wrong one puts the charge on the wrong apartment. Reported, never silently
    // resolved: replace only the SECOND occurrence.
    const first = OCR.indexOf('9990001-33');
    const second = OCR.indexOf('9990001-33', first + 1);
    expect(second).toBeGreaterThan(first); // the fixture really does carry it twice
    const broken =
      OCR.slice(0, second) + '9990002-33' + OCR.slice(second + '9990001-33'.length);
    const b = parseEydapBill(broken).bill;
    expect(b.warnings).toContain('registry-number-disagrees');
  });

  it('period-disagrees — two different consumption periods on one bill', () => {
    const first = OCR.indexOf('28/04/2026-23/07/2026');
    const second = OCR.indexOf('28/04/2026-23/07/2026', first + 1);
    expect(second).toBeGreaterThan(first);
    const broken =
      OCR.slice(0, second) +
      '28/04/2026-24/07/2026' +
      OCR.slice(second + '28/04/2026-23/07/2026'.length);
    const b = parseEydapBill(broken).bill;
    expect(b.warnings).toContain('period-disagrees');
  });

  it('consumption-from-tiers-only — the stub reading is missing', () => {
    // With no ΚΑΤΑΝΑΛΩΣΗ figure the parser falls back to summing the tiers. That is a
    // reasonable recovery and it must SAY it recovered, because the fallback cannot be
    // cross-checked against the meter readings the way the printed figure can.
    const noStub = OCR.split('\n')
      .filter((l) => l.trim() !== '61' && l.trim() !== '61 M3')
      .join('\n');
    const b = parseEydapBill(noStub).bill;
    expect(b.warnings).toContain('consumption-from-tiers-only');
    // The recovered value must still be right.
    expect(b.details.consumption.cubicMetres).toBe(61);
  });

  it('a clean bill emits NO warnings at all', () => {
    // The other half of the contract: if this ever starts reporting something, one of the
    // identities above has become over-eager and the landlord will learn to ignore them.
    expect(parseEydapBill(OCR).bill.warnings ?? []).toEqual([]);
  });
});

describe('the CHARGEABLE figure must survive a mislocated subtotal label', () => {
  /**
   * FOUND BY TESTING THE SAME DOCUMENT AS BOTH PNG AND PDF, which is the only reason it
   * surfaced: the PNG gave chargeableAmount 89,94 and the PDF gave 289,94.
   *
   * A PDF TEXT LAYER can arrive as one long line, where OCR gives one line per row. The
   * ΜΕΡΙΚΟ ΣΥΝΟΛΟ label match then latches onto a nearby number — measured: the payable.
   * chargeableAmount became the payable, so the tenant-charge bridge would have split
   * the landlord's arrears. The same money defect fixed in the ledger today, arriving
   * through a different door, and invisible because the wrong value is self-consistent.
   *
   * The itemised breakdown is the better authority by construction: six separately
   * located current-period lines, none of which is the payable.
   */
  it('prefers the itemised sum when the label disagrees with it', () => {
    // Make the subtotal label read the PAYABLE, exactly as the one-line PDF text did.
    const broken = OCR.replace(
      /ΜΕΡΙΚΟ ΣΥΝΟΛΟ \(ΕΥΡΩ\) :\n89,94/,
      'ΜΕΡΙΚΟ ΣΥΝΟΛΟ (ΕΥΡΩ) :\n289,94'
    );
    expect(broken).not.toBe(OCR); // the substitution must actually have applied
    const b = parseEydapBill(broken).bill;
    // The itemised lines sum to 89,94 — that is what tenants may be charged.
    expect(b.chargeableAmount).toBe(89.94);
    expect(b.warnings).toContain('breakdown-does-not-sum-to-subtotal');
    expect(b.warnings).toContain('subtotal-label-overridden-by-breakdown-sum');
  });

  it('still detects the prior balance after the override', () => {
    // The arrears test must run against the TRUSTED figure, or overriding the label would
    // silently disable the very warning that says «do not charge this to tenants».
    const broken = OCR.replace(
      /ΜΕΡΙΚΟ ΣΥΝΟΛΟ \(ΕΥΡΩ\) :\n89,94/,
      'ΜΕΡΙΚΟ ΣΥΝΟΛΟ (ΕΥΡΩ) :\n289,94'
    ).replace(/ΠΛΗΡΩΤΕΟ\(ΕΥΡΩ\) :\n89,94/, 'ΠΛΗΡΩΤΕΟ(ΕΥΡΩ) :\n289,94');
    const b = parseEydapBill(broken).bill;
    expect(b.totalAmount).toBe(289.94);
    expect(b.chargeableAmount).toBe(89.94);
    expect(b.warnings).toContain('prior-balance-included-in-payable');
  });

  it('derives the subtotal when the label is absent entirely', () => {
    const noLabel = OCR.replace(/ΜΕΡΙΚΟ ΣΥΝΟΛΟ \(ΕΥΡΩ\) :\n89,94\n/, '');
    const b = parseEydapBill(noLabel).bill;
    expect(b.chargeableAmount).toBe(89.94);
    expect(b.warnings).toContain('subtotal-derived-from-breakdown');
  });

  it('a clean bill still overrides NOTHING and warns about NOTHING', () => {
    const b = parseEydapBill(OCR).bill;
    expect(b.chargeableAmount).toBe(89.94);
    expect(b.warnings ?? []).toEqual([]);
  });
});

describe('when the printed subtotal and the itemised lines disagree', () => {
  /**
   * The override is a BACKSTOP, and a backstop has to fail toward the party who cannot see
   * it. Two opposed risks live here:
   *
   *   · the ΜΕΡΙΚΟ ΣΥΝΟΛΟ label latched the ΠΛΗΡΩΤΕΟ box — trusting it charges the
   *     TENANTS the landlord's arrears;
   *   · the bill printed a seventh charge line this parser does not know, so the six-line
   *     sum under-counts — trusting it under-charges the tenants and the landlord absorbs
   *     the difference.
   *
   * Over-charging spends someone else's money; under-charging costs the operator, who is
   * the person reading the warning and can raise the figure. So the rule is: charge the
   * LOWER of the two, and never silently.
   */
  const withSubtotal = (v) =>
    OCR.replace(/ΜΕΡΙΚΟ ΣΥΝΟΛΟ \(ΕΥΡΩ\) :\n89,94/, `ΜΕΡΙΚΟ ΣΥΝΟΛΟ (ΕΥΡΩ) :\n${v}`);

  it('a SEVENTH charge line does not silently under-charge without a warning', () => {
    // The printed subtotal is 20,00 higher than the six lines this parser knows — exactly
    // what an added levy looks like. The lower figure is charged, and BOTH codes fire so
    // the operator can raise it.
    const b = parseEydapBill(withSubtotal('109,94')).bill;
    expect({
      chargeable: b.chargeableAmount,
      disagrees: b.warnings.includes('breakdown-does-not-sum-to-subtotal'),
      overridden: b.warnings.includes('subtotal-label-overridden-by-breakdown-sum')
    }).toEqual({ chargeable: 89.94, disagrees: true, overridden: true });
  });

  it('itemised lines ABOVE the printed subtotal keep the lower printed figure', () => {
    // The other direction: the sum exceeds the label, so the label is already the lower
    // number and stands. Reported, because lines that exceed the stated subtotal mean
    // something was misread.
    const b = parseEydapBill(withSubtotal('69,94')).bill;
    expect({
      chargeable: b.chargeableAmount,
      exceeds: b.warnings.includes('breakdown-exceeds-subtotal'),
      overridden: b.warnings.includes('subtotal-label-overridden-by-breakdown-sum')
    }).toEqual({ chargeable: 69.94, exceeds: true, overridden: false });
  });

  it('never resolves to a figure that is neither of the two', () => {
    // A guard against a future "average"/"repair" attempt: the chargeable figure must be
    // one of the two numbers the document supports, not a third one invented here.
    for (const v of ['109,94', '69,94', '289,94']) {
      const b = parseEydapBill(withSubtotal(v)).bill;
      const printed = Number(v.replace(',', '.'));
      expect([printed, 89.94]).toContain(b.chargeableAmount);
    }
  });
});

describe('the identity must not decline to run in silence', () => {
  /**
   * `haveWholeBreakdown` requires all six lines, so a bill that legitimately omits one —
   * the environmental levy is not on every bill — skipped the sum check entirely, and its
   * silence read as a pass. That is the defect `amountAfterLabel`'s own comment warns
   * about: «a consistency check that quietly declines to run is worse than not having
   * one».
   */
  const dropLine = (label) =>
    OCR.split('\n')
      .filter((l, i, all) => {
        // Drop the label AND the amount line that follows it.
        if (l.includes(label)) return false;
        return !(i > 0 && all[i - 1].includes(label));
      })
      .join('\n');

  it('a five-line bill whose lines already exceed the subtotal is reported', () => {
    // Remove the environmental levy (0,03) and lower the printed subtotal well below the
    // remaining five lines. The five found lines now exceed what the bill says.
    const src = dropLine('ΠΕΡΙΒΑΛΛ').replace(
      /ΜΕΡΙΚΟ ΣΥΝΟΛΟ \(ΕΥΡΩ\) :\n89,94/,
      'ΜΕΡΙΚΟ ΣΥΝΟΛΟ (ΕΥΡΩ) :\n50,00'
    );
    const r = parseEydapBill(src);
    const b = r.bill ?? r.partial;
    expect(b.warnings).toContain('breakdown-exceeds-subtotal');
  });

  it('a five-line bill that merely sums LOW is NOT reported — that would be noise', () => {
    // With a line missing, a sum below the subtotal is exactly what one expects. Warning
    // about it would train the operator to dismiss the block that matters.
    const src = dropLine('ΠΕΡΙΒΑΛΛ');
    const r = parseEydapBill(src);
    const b = r.bill ?? r.partial;
    // `?? []`: the bill omits `warnings` entirely when there are none, so asserting on the
    // bare property tests `undefined` and reports «Received has value: undefined» — which
    // is a pass for the wrong reason on `.not.toContain`, and the failure that taught me
    // this. Also assert the parse SUCCEEDED, or a broken fixture would satisfy the rest.
    expect(r.success).toBe(true);
    expect(b.warnings ?? []).not.toContain('breakdown-exceeds-subtotal');
    expect(b.warnings ?? []).not.toContain('breakdown-does-not-sum-to-subtotal');
    // …and the figure is still the printed subtotal, unchanged by a missing line.
    expect(b.chargeableAmount).toBe(89.94);
  });
});

describe('an unreadable subtotal is not a neutral absence', () => {
  it('says so, because confirm would otherwise charge the PAYABLE', () => {
    /**
     * ΕΥΔΑΠ always prints both figures. When the subtotal cannot be read,
     * `chargeableAmount` goes out null, `confirmBills` correctly falls back to
     * `totalAmount` — the payable — and the landlord's arrears are split among the tenants
     * with nothing on any surface saying so. Same defect as the dropped schema path,
     * reached by a different route: the figure is missing rather than deleted.
     */
    // No subtotal label AND an incomplete breakdown, so nothing can be derived.
    const src = OCR.split('\n')
      .filter(
        (l) =>
          !/ΜΕΡΙΚΟ\s+ΣΥΝΟΛΟ/.test(l) &&
          !/ΣΥΝΟΛΟ\s+ΤΙΜΗΜΑΤΟΣ/.test(l) &&
          !/ΠΑΓΙΟ\s+ΤΕΛΟΣ/.test(l)
      )
      .join('\n');
    const r = parseEydapBill(src);
    const b = r.bill ?? r.partial;
    expect(b.chargeableAmount ?? null).toBeNull();
    expect(b.warnings).toContain('subtotal-not-read-payable-charged');
  });

  it('a ΔΕΗ-shaped single-figure bill is NOT accused of this', () => {
    // ΔΕΗ states one figure, so an absent chargeableAmount is legitimate there and the
    // fallback is right. The warning is ΕΥΔΑΠ-specific for exactly that reason — firing it
    // on every ΔΕΗ bill would make it meaningless.
    const clean = parseEydapBill(OCR).bill;
    expect(clean.warnings ?? []).not.toContain('subtotal-not-read-payable-charged');
    expect(clean.chargeableAmount).toBe(89.94);
  });
});

describe('a ONE-LINE text layer must never yield a DIFFERENT amount', () => {
  /**
   * THE ROOT CAUSE behind the PNG-vs-PDF divergence, fixed upstream of the symptom.
   *
   * OCR emits one line per printed row. A PDF TEXT LAYER does not — pdfjs can hand back a
   * whole page as ONE line. The label helpers did `lines[i].replace(label, ' ')` and then
   * matched UNANCHORED, i.e. from index 0, so on a one-line document EVERY label returned
   * the first match on the page rather than the value printed beside it. That is how the
   * same ΕΥΔΑΠ bill could report the payable where the subtotal belongs — and the subtotal
   * is the figure the tenant-charge bridge splits.
   *
   * 698eb3da treated the symptom (prefer the itemised sum when the label disagrees). This
   * is the cause: each search is now bounded to SAME_LINE_REACH characters PAST the label's
   * own match position.
   */
  // The fixture prints 89,94 for BOTH ΜΕΡΙΚΟ ΣΥΝΟΛΟ and ΠΛΗΡΩΤΕΟ, so on the fixture as-is
  // a wrong pick is indistinguishable from a right one and the assertion cannot fail —
  // mutation-verified: with the unmodified fixture the regression passed. The arrears
  // variant is what gives it teeth.
  const ARREARS = OCR.replace(/(ΠΛΗΡΩΤΕΟ\(ΕΥΡΩ\) :\n)89,94/, '$1289,94').replace(
    /(ΠΛΗΡΩΤΕΟ\n)89,94€/,
    '$1289,94€'
  );
  const oneLine = ARREARS.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('  ');

  it('the arrears variant really differs from the fixture', () => {
    // A `.replace()` whose pattern does not match returns the input UNCHANGED and throws
    // nothing, which would leave every assertion below comparing the clean fixture to
    // itself. Pin the premise or the suite is decoration.
    expect(ARREARS).not.toBe(OCR);
    expect(ARREARS).toContain('289,94');
  });

  it('parses a one-line page to the SAME bill as the lined one', () => {
    const multi = parseEydapBill(ARREARS);
    const flat = parseEydapBill(oneLine);
    const shape = (r) => ({
      success: r.success,
      total: (r.bill ?? r.partial)?.totalAmount ?? null,
      chargeable: (r.bill ?? r.partial)?.chargeableAmount ?? null,
      from: (r.bill ?? r.partial)?.periodStart?.toISOString() ?? null,
      to: (r.bill ?? r.partial)?.periodEnd?.toISOString() ?? null
    });
    // Same document, two renderings, one answer. 289,94 is what the landlord owes and
    // 89,94 is what this period cost — the figure the tenant split is taken from.
    expect(shape(flat)).toEqual(shape(multi));
    expect(shape(multi)).toMatchObject({
      success: true,
      total: 289.94,
      chargeable: 89.94
    });
  });
});
