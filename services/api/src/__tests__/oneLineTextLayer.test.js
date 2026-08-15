/* eslint-env node, jest */
/**
 * ONE PROPERTY, BOTH PROVIDERS: a page delivered as ONE line must parse to the same bill
 * as the same page delivered one row per line.
 *
 * WHY THIS IS A SUITE OF ITS OWN. `extractTextFromPdf` (pdfjs) joins a page's text items
 * with spaces, so a bill that arrives as a digital PDF reaches the parsers as a single
 * line, while the OCR path emits one line per printed row. Every "same line" branch in
 * both parsers used `line.replace(label, ' ')` and then matched an UNANCHORED pattern,
 * which on a one-line page returns the FIRST match anywhere on the document instead of
 * the value printed beside the label. The measured consequences were a wrong MONTH on ΔΕΗ
 * (charging every tenant in the building for April on a March bill) and, on ΕΥΔΑΠ, the
 * payable appearing where the subtotal belongs — and the subtotal is the figure the
 * tenant-charge bridge splits.
 *
 * Both were found by adversarial review rather than by these suites, because every
 * fixture on disk is line-per-row: the format that breaks was the one never exercised.
 * This file exercises it for both providers from the SAME fixtures, so the two paths
 * cannot drift apart again.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseEydapBill } from '../managers/billparser/eydap.js';
import { parseDehBill } from '../managers/billparser/deh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) =>
  fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8');

/** Exactly what `extractTextFromPdf` does to a page: join the items with spaces. */
const asOneLine = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');

/** Only the fields a δαπάνη is built from — the ones a wrong value would cost money. */
const money = (r) => {
  const b = r.bill ?? r.partial ?? {};
  return {
    success: r.success,
    total: b.totalAmount ?? null,
    chargeable: b.chargeableAmount ?? null,
    periodStart: b.periodStart?.toISOString() ?? null,
    periodEnd: b.periodEnd?.toISOString() ?? null,
    issueDate: b.issueDate?.toISOString() ?? null,
    billingIdNormalized: b.billingIdNormalized ?? null
  };
};

describe('ΔΕΗ — every scan fixture, both renderings', () => {
  const FIXTURES = fs
    .readdirSync(path.join(HERE, 'fixtures'))
    .filter((f) => /^deh-scan-.*\.txt$/.test(f))
    .sort();

  it('has fixtures to run — an empty list would pass silently', () => {
    // A `readdirSync().filter()` that matches nothing yields zero `it()` bodies and a
    // green suite. Pin the count so a renamed fixture is a failure, not a no-op.
    expect(FIXTURES.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of FIXTURES) {
    it(`${name}: one line === one row per line`, () => {
      const lined = parseDehBill(fixture(name));
      const flat = parseDehBill(asOneLine(fixture(name)));
      // The month is the assertion that matters: periodEnd decides which δαπάνη month
      // the bill posts to, and a wrong month bills the wrong set of tenants.
      expect(money(flat)).toEqual(money(lined));
    });
  }
});

describe('ΕΥΔΑΠ — both renderings, including the arrears case', () => {
  const OCR = fixture('eydap-ocr.synthetic.txt');
  // The fixture prints the same figure for ΜΕΡΙΚΟ ΣΥΝΟΛΟ and ΠΛΗΡΩΤΕΟ, so on it a wrong
  // pick is indistinguishable from a right one. The arrears variant separates them.
  const ARREARS = OCR.replace(/(ΠΛΗΡΩΤΕΟ\(ΕΥΡΩ\) :\n)89,94/, '$1289,94').replace(
    /(ΠΛΗΡΩΤΕΟ\n)89,94€/,
    '$1289,94€'
  );

  it('the arrears variant really differs — a non-matching replace is silent', () => {
    expect(ARREARS).not.toBe(OCR);
  });

  for (const [label, text] of [
    ['no arrears', OCR],
    ['with arrears', ARREARS]
  ]) {
    it(`${label}: one line === one row per line`, () => {
      expect(money(parseEydapBill(asOneLine(text)))).toEqual(
        money(parseEydapBill(text))
      );
    });
  }

  it('with arrears, the chargeable figure is this period only — on BOTH', () => {
    for (const text of [ARREARS, asOneLine(ARREARS)]) {
      const r = parseEydapBill(text);
      expect({
        total: r.bill?.totalAmount,
        chargeable: r.bill?.chargeableAmount
      }).toEqual({ total: 289.94, chargeable: 89.94 });
    }
  });
});
