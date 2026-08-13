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

  it('uses the ΑΡΙΘΜΟΣ ΛΟΓΑΡΙΑΣΜΟΥ as the primary key', () => {
    expect(r.bill.billingId).toBe('99900011122 003');
    expect(r.bill.billingIdNormalized).toBe('99900011122003');
  });

  it('carries the ΑΡΙΘΜΟΣ ΜΗΤΡΩΟΥ as an alternate', () => {
    // A landlord may have typed EITHER into the apartment's ΕΥΔΑΠ field or onto a
    // shared meter. Offering only one means the bill fails to match because they
    // chose the other — and the parser has no business deciding which is "correct".
    expect(r.bill.alternateBillingIds).toEqual(['999000133']);
  });

  it('reads the meter serial and the tariff class', () => {
    expect(r.bill.details.meterSerial).toBe('A99E90001');
    expect(r.bill.details.tariff).toBe('Β1');
  });

  it('reads the payment reference (ΕΥΔΑΠ prints no RF code)', () => {
    expect(r.bill.paymentCode).toBe('202699900001000203');
    expect(r.bill.rfCode).toBeUndefined();
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

  it('warns that the period spans more than one month', () => {
    // A ~3-month water bill charged to a single term is a distortion the landlord
    // must SEE. Refusing the bill instead is what left them typing it by hand.
    expect(r.bill.warnings).toContain('period-spans-multiple-months');
  });

  it('does not warn about a prior balance when there is none', () => {
    expect(r.bill.warnings).not.toContain('prior-balance-included-in-payable');
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
    expect(r.partial.billingId).toBe('99900011122 003');
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
