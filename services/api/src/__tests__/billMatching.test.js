/* eslint-env node, jest */
// Slice 6 — receipt matching: checksum validators, element extraction, and the
// soft-TF-IDF token-bag scorer (no hard categories). Pure logic, no mocks.
import {
  isValidRF,
  isValidIBAN,
  extractRFs,
  extractIBANs,
  extractElements,
  nameTokens,
  nameSimilarity,
  transliterateGreek,
  repairMatchKeys,
  computeIdf,
  scoreTokens
} from '../managers/billparser/matching.js';

describe('isValidRF (ISO 11649)', () => {
  it('accepts a real checksum-valid RF from the DEH bill', () => {
    // From the real getbill fixture (RF + 15..): validated mod-97 == 1.
    expect(isValidRF('RF33999000000000000000001')).toBe(true);
  });
  it('accepts with internal spaces (OCR groups digits)', () => {
    expect(isValidRF('RF36 9990 0000 0000 0009 59050')).toBe(true);
  });
  it('rejects a one-digit-off RF (checksum fails)', () => {
    expect(isValidRF('RF36999000000000000959051')).toBe(false);
  });
  it('rejects non-RF garbage', () => {
    expect(isValidRF('RF')).toBe(false);
    expect(isValidRF('XY36999000000000000000001')).toBe(false);
    expect(isValidRF(12345)).toBe(false);
    expect(isValidRF(undefined)).toBe(false);
  });
});

describe('extractRFs / extractIBANs — span→validate, no greedy swallow', () => {
  it('extracts a grouped IBAN without swallowing the next word', () => {
    // The bug: /(?:\s?[A-Z0-9]){11,30}/ ate " amount 7" → invalid. span→prefix fix:
    expect(
      extractIBANs('to GR06 0109 9999 9000 0000 0000 125 amount 749,99')
    ).toEqual(['GR3301109999990000000000001']);
  });
  it('extracts a compact IBAN mid-text', () => {
    expect(extractIBANs('IBAN GR3301109999990000000000001 end')).toEqual([
      'GR3301109999990000000000001'
    ]);
  });
  it('extracts a grouped RF without swallowing following text', () => {
    expect(extractRFs('Κωδ RF36 9990 0000 0000 0009 59050 ΠΛΗΡΩΜΗ')).toEqual([
      'RF33999000000000000000001'
    ]);
  });
  it('returns [] when no checksum-valid key is present', () => {
    expect(extractIBANs('GR060109999990000000000012 short')).toEqual([]);
    expect(extractRFs('RF99 0000 0000 nope')).toEqual([]);
  });
});

describe('isValidIBAN (ISO 13616)', () => {
  it('accepts the real payee IBAN from the worked example', () => {
    expect(isValidIBAN('GR3301109999990000000000001')).toBe(true);
  });
  it('accepts with spaces', () => {
    expect(isValidIBAN('GR06 0109 9999 9000 0000 0000 125')).toBe(true);
  });
  it('rejects a 26-digit GR IBAN (OCR dropped a digit — 27 needed)', () => {
    expect(isValidIBAN('GR060109999990000000000012')).toBe(false);
  });
});

describe('extractElements', () => {
  const RECEIPT = `ΕΘΝΙΚΗ ΤΡΑΠΕΖΑ
  Μεταφορά προς GR06 0109 9999 9000 0000 0000 125
  Ποσό 749,99 €
  Ημ/νία 15/04/2026
  Τιμ Πωλ 391
  DOKIMASTIS KOSTAS MARIOS
  Α.Φ.Μ. 123456789`;

  it('extracts a checksum-valid IBAN', () => {
    const el = extractElements(RECEIPT);
    expect(el.ibans).toContain('GR3301109999990000000000001');
  });
  it('extracts the amount as a number', () => {
    const el = extractElements(RECEIPT);
    expect(el.amounts).toContain(749.99);
  });
  it('extracts the date in UTC', () => {
    const el = extractElements(RECEIPT);
    const iso = el.dates.map((d) => d.toISOString());
    expect(iso).toContain('2026-04-15T00:00:00.000Z');
  });
  it('extracts a marked ΑΦΜ', () => {
    const el = extractElements(RECEIPT);
    expect(el.afm).toContain('123456789');
  });
  it('does NOT surface a checksum-failed IBAN', () => {
    const el = extractElements('to GR060109999990000000000012 amount 5,00');
    expect(el.ibans).toHaveLength(0);
  });
  it('folds hint fields (amount/dates/name) into the bag', () => {
    const el = extractElements('', {
      amount: 100,
      dates: [new Date(Date.UTC(2026, 0, 15))],
      name: 'ΔΕΗ Α.Ε.'
    });
    expect(el.amounts).toContain(100);
    expect(el.dates.map((d) => d.toISOString())).toContain(
      '2026-01-15T00:00:00.000Z'
    );
    expect(el.nameTokens.length).toBeGreaterThan(0);
  });
});

describe('nameTokens', () => {
  it('canonicalizes to phonetic Latin tokens, strips stopwords, dedupes', () => {
    const toks = nameTokens('ΔΕΗ Α.Ε. Ρεύμα Ρεύμα');
    // Ρεύμα → REYMA → canonical "reima" (/i/ sounds folded); Greek form gone.
    expect(toks).toContain('reima');
    expect(toks).not.toContain('ρευμα');
    expect(new Set(toks).size).toBe(toks.length); // deduped
  });
});

// Soft-TF-IDF token-bag scorer. Built + scored the way production does:
// bill/receipt TEXT → extractElements → scoreTokens over a corpus IDF. No hard
// categories — a token counts because it appears on both sides.
describe('scoreTokens — soft-TF-IDF, no hard categories', () => {
  // A small realm corpus of candidate bills (as their extracted element bags).
  const water = extractElements(
    'ΕΥΔΑΠ Νερό Αριθμός παροχής 999000935032 Ποσό 749,99 € 15/04/2026',
    { amount: 749.99, billingIds: ['999000935032'] }
  );
  const power = extractElements(
    'ΔΕΗ Ρεύμα RF33999000000000000000001 Ποσό 186,21 € 22/04/2026',
    { amount: 186.21, billingIds: ['RF33999000000000000000001'] }
  );
  const misc = extractElements('ΟΤΕ Τηλεφωνία Ποσό 45,00 € 10/03/2026', {
    amount: 45
  });
  const corpus = [water, power, misc];
  const idf = computeIdf(corpus);

  it('STRONG billingId (αναγνωριστικό/παροχή) match → strong + top score', () => {
    // A receipt printing the same παροχή number — no RF/IBAN needed.
    const receipt = extractElements('ΕΞΟΦΛΗΣΗ παροχη 999000935032 ποσο 749,99');
    const rWater = scoreTokens(water, receipt, idf);
    const rPower = scoreTokens(power, receipt, idf);
    expect(rWater.strong).toBe(true);
    expect(rWater.score).toBeGreaterThan(rPower.score);
    expect(rWater.matchedOn).toContain('999000935032');
  });

  it('STRONG RF match → strong', () => {
    const receipt = extractElements('Πληρωμη RF33999000000000000000001');
    const r = scoreTokens(power, receipt, idf);
    expect(r.strong).toBe(true);
  });

  it('INVOICE NUMBER carries a match with NO RF/IBAN/name (category-free)', () => {
    // The plan's worked example: invoice # 391 appears on both. It is not "an
    // RF" or "a name" — a bucketed scorer would ignore it. Soft-TF-IDF matches
    // it because it is a rare shared token.
    const inv = extractElements('Τιμολόγιο 391 DOKIMASTIS 749,99 €', {
      amount: 749.99
    });
    const idf2 = computeIdf([inv, misc, power]);
    const receipt = extractElements('Τραπεζα εμβασμα Τιμ Πωλ 391 ποσο 749,99');
    const r = scoreTokens(inv, receipt, idf2);
    expect(r.score).toBeGreaterThan(0);
    expect(r.matchedOn).toContain('391');
  });

  it('a rare shared token outranks a common one (IDF works)', () => {
    // "749,99" is unique to `water`; "ποσο/€" noise is everywhere. A receipt
    // sharing only the rare amount must rank water top.
    const receipt = extractElements('αποδειξη ποσο 749,99 ευρω');
    const scored = corpus
      .map((c) => ({ c, ...scoreTokens(c, receipt, idf) }))
      .sort((a, b) => b.score - a.score);
    expect(scored[0].c).toBe(water);
  });

  it('empty / no-overlap receipt scores 0 (no false match)', () => {
    const receipt = extractElements('εντελως ασχετο κειμενο ΞΨΩ');
    const r = scoreTokens(water, receipt, idf);
    expect(r.score).toBe(0);
  });

  it('null candidate is safe', () => {
    expect(scoreTokens(null, extractElements('749,99'), idf).score).toBe(0);
  });
});

// ── Fuzzy name matching — the επισκευές / no-RF-IBAN case: a repair receipt
// whose ONLY key is the business name (Greek↔Latin, OCR variants).
describe('transliterateGreek (letter-by-letter base)', () => {
  it('romanizes Greek letters + strips accents', () => {
    expect(transliterateGreek('ΠΑΠΑ')).toBe('PAPA');
    expect(transliterateGreek('Ρεύμα')).toBe('REYMA');
  });
});

describe('nameSimilarity (fuzzy)', () => {
  it('matches Greek vs Latin spelling of the same firm', () => {
    // "ΔΟΚΙΜΑΣΤΗΣ" (Greek) vs "DOKIMASTIS" (Latin receipt)
    const a = nameTokens('ΔΟΚΙΜΑΣΤΗΣ ΚΩΝ/ΝΟΣ');
    const b = nameTokens('DOKIMASTIS KOSTAS');
    expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(0.5);
  });
  it('tolerates an OCR variant (dokimastis/dokimastis)', () => {
    expect(
      nameSimilarity(nameTokens('DOKIMASTIS'), nameTokens('DOKIMASTIS'))
    ).toBeGreaterThanOrEqual(0.8);
  });
  it('scores 0 for unrelated names', () => {
    expect(nameSimilarity(nameTokens('ΔΟΚΙΜΗΣ'), nameTokens('ΕΥΔΑΠ'))).toBe(0);
  });
});

describe('scoreTokens — NAME carries a match with no RF/IBAN (επισκευές)', () => {
  it('a repair receipt matches a repair on contractor NAME alone (Greek↔Latin)', () => {
    const repairKeys = repairMatchKeys(
      {
        title: 'Επισκευή ασανσέρ',
        actualCost: 450,
        completionDate: new Date(Date.UTC(2026, 3, 10))
      },
      {
        name: 'ΔΟΚΙΜΗΣ ΤΕΧΝΙΚΗ',
        company: 'ΔΟΚΙΜΗΣ ΤΕΧΝΙΚΗ ΕΠΕ',
        taxId: '999888777'
      }
    );
    const otherBill = extractElements('ΔΕΗ Ρεύμα 186,21 €', { amount: 186.21 });
    const idf = computeIdf([repairKeys, otherBill]);
    // receipt: a POS/handwritten slip — no RF, no IBAN, just the firm (in Latin)
    const receipt = extractElements('DOKIMIS TEXNIKI ΠΛΗΡΩΜΗ 450,00 EUR');
    const rRepair = scoreTokens(repairKeys, receipt, idf);
    const rOther = scoreTokens(otherBill, receipt, idf);
    expect(rRepair.score).toBeGreaterThan(0);
    expect(rRepair.score).toBeGreaterThan(rOther.score); // name+amount beats nothing
    // the contractor name token carried it (DOKIMIS canonical)
    expect(rRepair.matchedOn.join(' ')).toMatch(/bab|texnik/i);
  });

  it('name + amount together beat amount alone (ranking sanity)', () => {
    const keys = repairMatchKeys(
      { title: 'Βαφή', actualCost: 300 },
      { name: 'ΠΑΠΑΔΟΠΟΥΛΟΣ ΒΑΦΕΣ' }
    );
    const idf = computeIdf([keys]);
    const both = scoreTokens(
      keys,
      extractElements('PAPADOPULOS VAFES 300,00', { amount: 300 }),
      idf
    );
    const amountOnly = scoreTokens(
      keys,
      extractElements('τυχαίο κειμενο 300,00', { amount: 300 }),
      idf
    );
    expect(both.score).toBeGreaterThan(amountOnly.score);
  });
});

describe('repairMatchKeys', () => {
  it('derives name tokens from contractor + title, cost as amount, taxId as afm', () => {
    const k = repairMatchKeys(
      {
        title: 'Υδραυλικά',
        actualCost: 120.5,
        completionDate: new Date(Date.UTC(2026, 1, 3))
      },
      { company: 'ΔΟΚΙΜΗΣ ΑΕ', taxId: '123456789' }
    );
    expect(k.amounts).toContain(120.5);
    expect(k.afm).toContain('123456789');
    expect(k.nameTokens).toContain('dokimis'); // ΔΟΚΙΜΗΣ → DOKIMIS
    expect(k.dates.map((d) => d.toISOString())).toContain(
      '2026-02-03T00:00:00.000Z'
    );
  });
});
