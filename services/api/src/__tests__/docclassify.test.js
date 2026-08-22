/* eslint-env node, jest */
/**
 * The Telegram document-routing decision, against the REAL corpus texts the
 * three lanes were built on — not synthetic strings shaped to pass:
 *   · the greekleaseparser suite's AADE lease receipt text (amendment form,
 *     the harder variant);
 *   · the committed redacted E9 fixture (structure intact, ΑΦΜ scrubbed);
 *   · the ΔΕΗ + ΕΥΔΑΠ OCR fixtures the bill parser runs on.
 * A misroute here is not cosmetic: a bill classified as a lease dead-ends in
 * a parseError card instead of the working OCR lane.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyDocumentText } from '../utils/docclassify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

const read = (rel) => fs.readFileSync(path.join(FIXTURES, rel), 'utf8');

// Same text the greekleaseparser tests parse (managers/greekleaseparser.test.js) —
// the ΤΡΟΠΟΠΟΙΗΤΙΚΗ (amendment) header, which is the harder variant because it
// differs most from the original-declaration header.
const LEASE_TEXT =
  'Σελίδα 1 .  ΑΠΟΔΕΙΞΗ ΥΠΟΒΟΛΗΣ ΤΡΟΠΟΠΟΙΗΤΙΚΗΣ ΔΗΛΩΣΗΣ ΠΛΗΡΟΦΟΡΙΑΚΩΝ ΣΤΟΙΧΕΙΩΝ ' +
  'ΜΙΣΘΩΣΗΣ ΑΚΙΝΗΤΗΣ ΠΕΡΙΟΥΣΙΑΣ (ΗΜΕΡΟΜΗΝΙΑ ΔΗΜΙΟΥΡΓΙΑΣ ΤΗΣ ΑΠΟΔΕΙΞΗΣ 19/04/2026)  ' +
  'ΑΡ. ΔΗΛΩΣΗΣ   999532166   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   01/03/2026 ' +
  'ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   ΔΟΚΙΜΗ ΚΑΠΠΑ (ΑΦΜ Δηλούντος:999000018)';

describe('classifyDocumentText — the orchestrator routing decision', () => {
  it('routes the AADE lease receipt to the lease lane', () => {
    expect(classifyDocumentText(LEASE_TEXT)).toBe('lease');
  });

  it('routes the redacted E9 fixture to the e9 lane', () => {
    const e9 = read('e9/odos-epsilon-redacted.txt');
    expect(classifyDocumentText(e9)).toBe('e9');
  });

  it('routes real bill OCR texts to the bill lane (ΔΕΗ ×3, ΕΥΔΑΠ, ΔΕΥΑ)', () => {
    for (const f of [
      'deh-scan-2026-04.txt',
      'deh-scan-2026-05.txt',
      'deh-scan-2026-06.txt',
      'eydap-ocr.synthetic.txt',
      'deuaTinou-ocr-sample.txt'
    ]) {
      expect(classifyDocumentText(read(f))).toBe('bill');
    }
  });

  it('a lease that MENTIONS Ε9 stays a lease (header outranks the token)', () => {
    expect(
      classifyDocumentText(
        LEASE_TEXT + ' ΑΤΑΚ ακινήτου όπως δηλώθηκε στο Ε9 12345678901'
      )
    ).toBe('lease');
  });

  it('the bare Ε9 token only matches as a word, never inside a code', () => {
    // Greek ε adjacent to 9 inside an alphanumeric run — OCR-noise shape.
    expect(classifyDocumentText('ΚΩΔΙΚΑΣ ΠΛΗΡΩΜΗΣ ΡΕ912345 ΛΟΓΑΡΙΑΣΜΟΣ')).toBe(
      'bill'
    );
    expect(classifyDocumentText('ΕΝΤΥΠΟ Ε9 ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΩΝ')).toBe('e9');
  });

  it('empty / no-text-layer extraction falls through to the bill lane', () => {
    expect(classifyDocumentText('')).toBe('bill');
    expect(classifyDocumentText('   \n  ')).toBe('bill');
    expect(classifyDocumentText('random english text only')).toBe('bill');
  });
});
