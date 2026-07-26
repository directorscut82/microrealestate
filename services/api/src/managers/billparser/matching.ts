/**
 * Receipt matching — Slice 6 (§15 of the bill-OCR plan).
 *
 * Deterministic (no ML), unit-tested. The scorer is SOFT-TF-IDF over token
 * bags — NO hard categories: every token from the bill's text is compared
 * against every token from the receipt, weighted by how rare/discriminating it
 * is across the candidate corpus (IDF). A token counts because it appears on
 * both sides, not because it was tagged "an RF" or "a name" — so an invoice
 * number, a contractor surname, or an amount can all carry a match.
 *
 * Pieces:
 *   1. checksum validators (RF ISO 11649, IBAN ISO 13616 mod-97) — a
 *      checksum-failed long token is NEVER trusted as a strong key.
 *   2. transliterateGreek / canonicalName / nameTokens — Greek↔Latin phonetic
 *      canonical so a firm printed in Greek matches its Latin romanization.
 *   3. extractElements(text) → BillElements incl. the full `tokens` bag.
 *   4. computeIdf(corpus) + scoreTokens(candidate, receipt, idf) — the match.
 *      THREE strong unique IDs (RF, IBAN, αριθμός παροχής/billingId) get a
 *      rank-guaranteeing boost on exact match, but none is REQUIRED.
 */

// ── Checksum validators ─────────────────────────────────────────────────────

// mod-97 over an arbitrary-length numeric string (chunked, no BigInt needed).
function mod97(numeric: string): number {
  let remainder = 0;
  for (const d of numeric) {
    remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder;
}

function lettersToDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch >= 'A' && ch <= 'Z') {
      out += (ch.charCodeAt(0) - 55).toString(); // A=10 … Z=35
    } else if (ch >= '0' && ch <= '9') {
      out += ch;
    } else {
      return ''; // illegal char → caller treats as invalid
    }
  }
  return out;
}

/**
 * ISO 11649 Creditor Reference (the "RFxx…" a Greek utility bill carries).
 * Structure: 'RF' + 2 check digits + up to 21 alphanumeric. Valid when moving
 * 'RF'+checkdigits to the end and taking mod-97 == 1.
 */
export function isValidRF(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.replace(/\s+/g, '').toUpperCase();
  if (!/^RF[0-9]{2}[A-Z0-9]{1,21}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  const numeric = lettersToDigits(rearranged);
  if (!numeric) return false;
  return mod97(numeric) === 1;
}

/**
 * ISO 13616 IBAN. Same algorithm as validators.isValidIBAN — duplicated here so
 * the parser module has no dependency on the api validators layer (keeps the
 * matching logic self-contained + unit-testable in isolation).
 */
export function isValidIBAN(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  const numeric = lettersToDigits(rearranged);
  if (!numeric) return false;
  return mod97(numeric) === 1;
}

// ── Strong-key extraction (span → validate, prefix-tolerant) ────────────────
//
// A grouped IBAN/RF ("GR06 0110 …") sits between spaces, so a naive greedy
// regex swallows the following word ("… 125 amount" → invalid). Instead we
// grab a generous candidate span, strip separators, and validate the string
// AND its progressively-shorter prefixes — the longest checksum-valid prefix
// is the real key. This also recovers cases where OCR appended noise.

const IBAN_SPAN = /[A-Z]{2}[0-9]{2}[A-Z0-9 ]{11,40}/gi;
const RF_SPAN = /RF[0-9][0-9][A-Z0-9 ]{1,30}/gi;

function validPrefix(
  compact: string,
  minLen: number,
  isValid: (s: string) => boolean
): string | null {
  // Try the full compact string, then trim one trailing char at a time down to
  // minLen; return the longest that passes the checksum.
  for (let len = compact.length; len >= minLen; len--) {
    const cand = compact.slice(0, len);
    if (isValid(cand)) return cand;
  }
  return null;
}

/** All checksum-valid IBANs in text (span→strip→longest-valid-prefix). */
export function extractIBANs(text: string): string[] {
  const out = new Set<string>();
  for (const span of text.match(IBAN_SPAN) || []) {
    const compact = span.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const v = validPrefix(compact, 15, isValidIBAN);
    if (v) out.add(v);
  }
  return [...out];
}

/** All checksum-valid RF references in text. */
export function extractRFs(text: string): string[] {
  const out = new Set<string>();
  for (const span of text.match(RF_SPAN) || []) {
    const compact = span.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const v = validPrefix(compact, 5, isValidRF);
    if (v) out.add(v);
  }
  return [...out];
}

// ── Element extraction ──────────────────────────────────────────────────────

export interface BillElements {
  // Three STRONG, deterministically-saved unique identifiers. An exact match on
  // ANY of these is near-certainty and gets a rank-guaranteeing floor in the
  // scorer — RF (ISO-11649), IBAN (ISO-13616), and the αναγνωριστικό/αριθμός
  // παροχής (billingId, normalized). All are validated/normalized before entry.
  rfCodes: string[];
  ibans: string[];
  billingIds: string[]; // normalized (spaces/dashes/dots stripped)
  // Kept for display + as hints; the SCORER no longer buckets these — they are
  // folded into the token bag below and compared all-against-all.
  amounts: number[];
  afm: string[];
  dates: Date[];
  nameTokens: string[];
  // The full token bag (soft-TF-IDF). EVERY meaningful token from the whole
  // text — names, numbers, invoice refs, dates, amounts — canonicalized. This
  // is what makes matching category-free: a token participates because it
  // appears on both sides, not because it was tagged "an RF" or "a name".
  tokens: string[];
}

// Money-token matcher. Two alternatives, grouped-first so a properly separated
// figure is consumed whole:
//   1) N.NNN,NN / N NNN,NN — an integer with EXPLICIT thousands groups.
//   2) N…,NN / N….NN — a plain (ungrouped) integer of any length + 2 decimals.
// O2 (destructive-write audit 2026-07): the old single pattern
// `\d{1,3}(?:[.\s]\d{3})*[.,]\d{2}` required 3-digit groups, so an unseparated
// "1234,56" (common on POS/OCR output) matched only "234,56" — the leading
// digit(s) were dropped and the amount came out mod-1000 (~1000x low).
const MONEY_TOKEN_RE = /\d{1,3}(?:[.\s]\d{3})+[.,]\d{2}|\d+[.,]\d{2}/g;

// Greek money: 1.234,56 or 1234,56 or 1234.56 → number. Returns NaN on garbage.
function parseGreekMoney(raw: string): number {
  let s = raw.replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  // Whichever separator is rightmost is the decimal separator.
  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    s = s.replace(/,/g, '');
  } else {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

const STOPWORDS = new Set([
  'the',
  'and',
  'gia',
  'tou',
  'tis',
  'ton',
  'kai',
  'sto',
  'sti',
  'apo',
  'pros',
  'poso',
  'euro',
  'eur',
  'ae',
  'oe',
  'epe',
  'ike',
  'ltd',
  'sa'
]);

// Greek → Latin base transliteration (letter by letter). Χ→CH, Θ→TH, etc.
const GR_SINGLES: Record<string, string> = {
  Α: 'A',
  Β: 'V',
  Γ: 'G',
  Δ: 'D',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'I',
  Θ: 'TH',
  Ι: 'I',
  Κ: 'K',
  Λ: 'L',
  Μ: 'M',
  Ν: 'N',
  Ξ: 'X',
  Ο: 'O',
  Π: 'P',
  Ρ: 'R',
  Σ: 'S',
  Τ: 'T',
  Υ: 'Y',
  Φ: 'F',
  Χ: 'CH',
  Ψ: 'PS',
  Ω: 'O'
};

export function transliterateGreek(input: string): string {
  const s = (input || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); // strip accents/diacritics
  let out = '';
  for (const ch of s) out += GR_SINGLES[ch] ?? ch;
  return out;
}

/**
 * Phonetic canonical key — the fuzzy core for names. A Greek business name and
 * its Latin romanization on a receipt seldom match character-for-character
 * ("ΔΟΚΙΜΗΣ" vs "DOKIMIS", "ΔΟΚΙΜΑΣΤΗΣ" vs "DOKIMASTIS"). Collapsing the
 * common Greek↔Latin digraph/phoneme ambiguities makes BOTH sides converge on
 * one key, so a plain comparison (plus a little edit tolerance) matches them.
 * Applied to every name token on both the stored bill and the OCR'd receipt.
 */
export function canonicalName(raw: string): string {
  let s = transliterateGreek(raw).replace(/[^A-Z]/g, '');
  s = s
    .replace(/MP/g, 'B') // μπ → b
    .replace(/NT/g, 'D') // ντ → d
    .replace(/GK/g, 'G') // γκ → g
    .replace(/OU/g, 'U')
    .replace(/OY/g, 'U')
    .replace(/AU/g, 'AV')
    .replace(/EU/g, 'EV')
    .replace(/PH/g, 'F')
    .replace(/CH/g, 'X')
    .replace(/KH/g, 'X')
    .replace(/TH/g, 'T') // θ ~ τ for fuzzy purposes
    .replace(/[HYI]/g, 'I') // all /i/ sounds
    .replace(/[KC]/g, 'K') // k/c
    .replace(/W/g, 'V')
    .replace(/(.)\1+/g, '$1'); // collapse doubled letters
  return s;
}

/**
 * Normalize a name into comparable CANONICAL tokens. Both a bill's stored name
 * and a receipt's OCR'd name go through this, so Greek and Latin spellings land
 * in the same phonetic space. Stopwords (legal-form suffixes, articles)
 * removed. Filters on the pre-canonical romanized length so short canonical
 * forms (e.g. DOKIMIS) aren't dropped.
 */
export function nameTokens(raw: string): string[] {
  if (!raw) return [];
  const romanized = transliterateGreek(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');
  const out = new Set<string>();
  for (const w of romanized.split(/\s+/)) {
    const word = w.trim();
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    const c = canonicalName(word).toLowerCase();
    if (c.length >= 2) out.add(c);
  }
  return Array.from(out);
}

// Levenshtein (bounded, iterative) → normalized similarity 0..1.
function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  const dist = prev[n];
  return 1 - dist / Math.max(m, n);
}

// Two tokens "match" if identical, one is a prefix of the other (≥4 chars — an
// OCR often truncates), or edit-similarity ≥ 0.8 ("dokimastis"/"dokimastis").
function tokensMatch(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) {
    return 0.9;
  }
  const sim = editSimilarity(a, b);
  return sim >= 0.8 ? sim : 0;
}

/**
 * Graded name similarity 0..1 between two token sets. For each receipt token we
 * take its best match among the bill's tokens (fuzzy), then normalize by the
 * SMALLER set size so a short receipt name that fully matches part of a long
 * stored name still scores high. This is the fuzzy core the user asked for —
 * names are frequently the ONLY key on a repair/POS receipt.
 */
export function nameSimilarity(aTokens: string[], bTokens: string[]): number {
  if (!aTokens.length || !bTokens.length) return 0;
  const [shorter, longer] =
    aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  let sum = 0;
  for (const t of shorter) {
    let best = 0;
    for (const u of longer) best = Math.max(best, tokensMatch(t, u));
    sum += best;
  }
  return sum / shorter.length;
}

/**
 * Extract every reliably-findable element from a bill/receipt's text. Long
 * digit strings (RF/IBAN) are checksum-validated here so only trustworthy
 * tokens enter the strong-key lists; everything else (amounts/dates/afm/names)
 * is collected as-is and scored softly.
 */
export function extractElements(
  text: string,
  hints?: {
    amount?: number;
    dates?: Array<Date | undefined>;
    name?: string;
    billingIds?: string[];
  }
): BillElements {
  const t = text || '';

  // RF codes + IBANs — span→strip→longest-valid-prefix (see extractRFs/IBANs),
  // so a grouped key doesn't greedily swallow the following word.
  const rfCodes = extractRFs(t);
  const ibans = extractIBANs(t);

  // ΑΦΜ / VAT — 9 digits, often after ΑΦΜ/Α.Φ.Μ/VAT.
  const afmSet = new Set<string>();
  const afmMarked = t.match(/(?:Α\.?Φ\.?Μ\.?|VAT)\s*:?\s*([0-9]{9})/gi) || [];
  for (const m of afmMarked) {
    const d = m.match(/[0-9]{9}/);
    if (d) afmSet.add(d[0]);
  }
  const afm = Array.from(afmSet);

  // Amounts — every N,NN / N.NNN,NN money-looking token.
  const amountSet = new Set<number>();
  const moneyTokens = t.match(MONEY_TOKEN_RE) || [];
  for (const tok of moneyTokens) {
    const n = parseGreekMoney(tok);
    if (Number.isFinite(n) && n > 0) amountSet.add(Math.round(n * 100) / 100);
  }
  if (hints?.amount && hints.amount > 0) {
    amountSet.add(Math.round(hints.amount * 100) / 100);
  }
  const amounts = Array.from(amountSet);

  // Dates — DD/MM/YYYY or DD-MM-YYYY tokens → UTC dates (avoid TZ drift).
  const dateSet = new Map<number, Date>();
  const dateTokens = t.match(/\b(\d{2})[/.-](\d{2})[/.-](\d{4})\b/g) || [];
  for (const tok of dateTokens) {
    const m = tok.match(/(\d{2})[/.-](\d{2})[/.-](\d{4})/);
    if (!m) continue;
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    if (!Number.isNaN(d.getTime())) dateSet.set(d.getTime(), d);
  }
  for (const h of hints?.dates || []) {
    if (h instanceof Date && !Number.isNaN(h.getTime())) {
      dateSet.set(h.getTime(), h);
    }
  }
  const dates = Array.from(dateSet.values());

  // billingId (αναγνωριστικό / αριθμός παροχής) — a STRONG saved key. On a bill
  // it comes from the hint (the stored, normalized value). On a receipt we
  // can't reliably know which digit-run IS the παροχή, so we don't guess a
  // "billingId" from receipt text; instead the normalized digit-runs enter the
  // token bag (below) and match the bill's billingId there. The hint list holds
  // the bill's own known ids.
  const billingIds = Array.from(
    new Set((hints?.billingIds || []).map((b) => normalizeBillingIdLocal(b)))
  ).filter(Boolean);

  const nameHint = hints?.name ? nameTokens(hints.name) : [];

  return {
    rfCodes,
    ibans,
    billingIds,
    amounts,
    afm,
    dates,
    nameTokens: Array.from(
      new Set([
        ...nameHint,
        ...nameTokens(t.replace(/[0-9]/g, ' ')).filter((w) => w.length >= 4)
      ])
    ),
    tokens: tokenizeAll(t, hints)
  };
}

function normalizeBillingIdLocal(id: string): string {
  return String(id || '').replace(/[\s\-.]/g, '');
}

/**
 * Build the full soft-TF-IDF token bag from a document's text + structured
 * hints. EVERY meaningful token participates — no categories:
 *   • alphabetic words → phonetic canonical (Greek↔Latin), stopwords dropped;
 *   • numeric runs (invoice refs, meter numbers, the παροχή, RF/IBAN digits) →
 *     kept verbatim AND the RF/IBAN/billingId strong keys are added so an exact
 *     ID match lands in the bag too;
 *   • money amounts → a normalized `amt:NN.NN` token so 749,99 on both sides is
 *     one comparable token;
 *   • dates → `date:YYYY-MM-DD` tokens.
 * Duplicates collapse (Set) — TF is effectively binary, which is what we want
 * for short bill/receipt records.
 */
function tokenizeAll(
  text: string,
  hints?: {
    amount?: number;
    dates?: Array<Date | undefined>;
    name?: string;
    billingIds?: string[];
  }
): string[] {
  const bag = new Set<string>();
  const t = text || '';

  // Alphabetic words → canonical name tokens (fuzzy-comparable).
  for (const tok of nameTokens(t)) bag.add(`w:${tok}`);
  if (hints?.name)
    for (const tok of nameTokens(hints.name)) bag.add(`w:${tok}`);

  // Numeric runs of length >=3 (invoice #, παροχή, codes). Short runs (<3) are
  // too common to help. Keep the raw digits — value proximity is handled for
  // amounts separately; identity match is what matters for reference numbers.
  for (const m of t.match(/\d{3,}/g) || []) bag.add(`n:${m}`);

  // Money amounts as normalized tokens.
  const moneyTokens = t.match(MONEY_TOKEN_RE) || [];
  for (const tok of moneyTokens) {
    const n = parseGreekMoney(tok);
    if (Number.isFinite(n) && n > 0) bag.add(`amt:${n.toFixed(2)}`);
  }
  if (hints?.amount && hints.amount > 0)
    bag.add(`amt:${hints.amount.toFixed(2)}`);

  // Dates.
  for (const m of t.match(/\b\d{2}[/.-]\d{2}[/.-]\d{4}\b/g) || []) {
    const g = m.match(/(\d{2})[/.-](\d{2})[/.-](\d{4})/);
    if (g) bag.add(`date:${g[3]}-${g[2]}-${g[1]}`);
  }
  for (const h of hints?.dates || []) {
    if (h instanceof Date && !Number.isNaN(h.getTime())) {
      bag.add(`date:${h.toISOString().slice(0, 10)}`);
    }
  }

  // Strong keys as their own high-signal tokens (exact identity).
  for (const rf of extractRFs(t)) bag.add(`rf:${rf}`);
  for (const ib of extractIBANs(t)) bag.add(`iban:${ib}`);
  // The bill's KNOWN billingId (αριθμός παροχής) gets TWO tokens:
  //   n:<c>  → participates in the soft cosine (a receipt digit-run lines up).
  //   pn:<c> → a strong-ID MARKER used only by scoreTokens' strong detection.
  // pn: is emitted ONLY for the real billingId (from hints), NEVER for arbitrary
  // numeric runs — so the strong +floor fires on the παροχή, not on a shared
  // "2026"/"100". The receipt has no hints.billingIds, so it emits no pn:; the
  // strong billingId match is asymmetric (candidate pn:X ∧ receipt n:X).
  for (const b of hints?.billingIds || []) {
    const c = normalizeBillingIdLocal(b);
    if (c) {
      bag.add(`n:${c}`);
      bag.add(`pn:${c}`);
    }
  }

  return Array.from(bag);
}

/**
 * Build a matchKeys bag for a REPAIR from its own fields + linked contractor.
 * A repair has no stored element bag (it predates Slice 6), so we derive one
 * live: contractor/company name (the primary key for an επισκευές receipt),
 * ΑΦΜ, actualCost, dates, and any invoiceReference digits as an amount-ish key.
 */
export function repairMatchKeys(
  repair: any,
  contractor?: { name?: string; company?: string; taxId?: string } | null
): BillElements {
  const dates: Array<Date | undefined> = [
    repair?.completionDate,
    repair?.startDate,
    repair?.reportedDate
  ].map((d) => (d ? new Date(d) : undefined));

  // A repair's "text" = its title/description + contractor name/company + ΑΦΜ +
  // invoiceReference. Run it through the same extractor so it produces the same
  // shape of token bag a bill/receipt does — one comparison path for all.
  const text = [
    repair?.title,
    repair?.description,
    contractor?.name,
    contractor?.company,
    // Mark the taxId as ΑΦΜ so extractElements routes it into the afm list (the
    // extractor keys ΑΦΜ off the ΑΦΜ:/VAT marker); the digits also enter the
    // token bag either way.
    contractor?.taxId ? `ΑΦΜ ${contractor.taxId}` : '',
    repair?.invoiceReference
  ]
    .filter(Boolean)
    .join(' ');

  return extractElements(text, {
    amount: Number(repair?.actualCost) || undefined,
    dates,
    name: [contractor?.name, contractor?.company, repair?.title]
      .filter(Boolean)
      .join(' '),
    billingIds: repair?.invoiceReference
      ? [String(repair.invoiceReference)]
      : []
  });
}

// ── Scoring: soft TF-IDF over token bags (no hard categories) ────────────────

export interface MatchScore {
  score: number; // cosine-normalized soft-TF-IDF similarity, 0..1-ish + boosts
  matchedOn: string[]; // human-readable tokens/keys that carried the match
  strong: boolean; // an exact strong-ID (RF/IBAN/billingId) matched
}

// Strong-ID detection (see scoreTokens): an exact match on a checksum-valid
// RF/IBAN token, or the stored αριθμός παροχής (candidate pn:X ∧ receipt n:X),
// is a deliberately-saved unique identifier → near-certain, gets the rank
// floor. The generic `n:` numeric-run namespace is deliberately NOT strong on
// its own — it carries every ≥3-digit token (years, amounts, codes), so a
// coincidental shared number must never fire the floor.

/**
 * Compute IDF over the candidate corpus. df = number of candidates whose bag
 * contains the token; idf = ln(1 + N/df). Rare tokens (a surname, invoice #,
 * a specific amount) weigh far more than ubiquitous ones (ΕΥΡΩ, ΠΟΣΟ) — the
 * DATA decides importance, not a hand-assigned category weight.
 */
export function computeIdf(corpus: BillElements[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of corpus) {
    for (const tok of new Set(doc.tokens || [])) {
      df.set(tok, (df.get(tok) || 0) + 1);
    }
  }
  const n = Math.max(1, corpus.length);
  const idf = new Map<string, number>();
  for (const [tok, d] of df) idf.set(tok, Math.log(1 + n / d));
  return idf;
}

// Similarity between two bag tokens of the SAME namespace. Alphabetic word
// tokens (w:) get fuzzy edit similarity (Greek↔Latin canonical already applied,
// so this only mops up OCR slips); everything else must match exactly.
function bagTokenSim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.startsWith('w:') && b.startsWith('w:')) {
    return tokensMatch(a.slice(2), b.slice(2)); // 0 | 0.8..1
  }
  return 0;
}

const IDF_FALLBACK = 1.0; // token unseen in corpus (e.g. only on the receipt)

/**
 * Soft-TF-IDF cosine similarity between a candidate's token bag and the
 * receipt's, using corpus IDF weights. For every receipt token we take its
 * best (possibly fuzzy) match among the candidate's tokens, contribute
 * sim × idf_r × idf_c, and cosine-normalize by both bag magnitudes so a long
 * verbose bill can't out-score a terse one on length alone.
 *
 * On top of the cosine, an exact match on ANY strong ID (RF / IBAN / billingId
 * / invoice ref, the `n:`/`rf:`/`iban:` namespaces) adds a large boost and sets
 * `strong` — these are deliberately-saved unique identifiers, so an exact hit
 * is near-certain and must rank first. Nothing is REQUIRED though: a receipt
 * with none of them still scores purely on weighted token overlap (a repair
 * receipt matching on the contractor name, the case that motivated this).
 */
export function scoreTokens(
  candidate: BillElements | undefined | null,
  receipt: BillElements,
  idf: Map<string, number>
): MatchScore {
  // pn: tokens are strong-ID MARKERS, not cosine terms — the same billingId is
  // already represented by its n: token, so counting pn: would double-weight it
  // and skew the magnitude. Exclude pn: from the cosine bags entirely.
  const cand = (candidate?.tokens || []).filter((t) => !t.startsWith('pn:'));
  const rec = (receipt.tokens || []).filter((t) => !t.startsWith('pn:'));
  if (!cand.length || !rec.length) {
    return { score: 0, matchedOn: [], strong: false };
  }
  const w = (tok: string) => idf.get(tok) ?? IDF_FALLBACK;

  // Cosine magnitudes (each token weighted by its idf; TF is binary here).
  const mag = (bag: string[]) =>
    Math.sqrt(bag.reduce((s, tok) => s + w(tok) * w(tok), 0)) || 1;
  const candMag = mag(cand);
  const recMag = mag(rec);

  let dot = 0;
  const matchedOn: string[] = [];
  let strong = false;
  const candSet = new Set(cand);

  for (const rt of rec) {
    // best match for this receipt token among candidate tokens
    let best = 0;
    let bestTok = '';
    if (candSet.has(rt)) {
      best = 1;
      bestTok = rt;
    } else if (rt.startsWith('w:')) {
      for (const ct of cand) {
        const s = bagTokenSim(rt, ct);
        if (s > best) {
          best = s;
          bestTok = ct;
        }
      }
    }
    if (best <= 0) continue;
    dot += best * w(rt) * w(bestTok);

    // Strong-ID detection: rf:/iban: match on an exact identical token; the
    // billingId is asymmetric (candidate holds pn:X, receipt holds the digits
    // as n:X), handled separately below — so a plain `n:` shared number does
    // NOT set strong.
    if (best === 1 && (rt.startsWith('rf:') || rt.startsWith('iban:'))) {
      strong = true;
    }
    if (best >= 0.8) {
      const label = rt.replace(/^(w:|n:|amt:|date:|rf:|iban:)/, '');
      if (label && !matchedOn.includes(label)) matchedOn.push(label);
    }
  }

  // Strong billingId: the candidate's stored παροχή (pn:X) appears as a numeric
  // run (n:X) in the receipt text. Uses the ORIGINAL candidate tokens (pn: was
  // filtered out of `cand`), matched against the receipt's n: tokens.
  const recNumeric = new Set(rec.filter((t) => t.startsWith('n:')));
  for (const ct of candidate?.tokens || []) {
    if (ct.startsWith('pn:')) {
      const digits = ct.slice(3);
      if (recNumeric.has(`n:${digits}`)) {
        strong = true;
        if (!matchedOn.includes(digits)) matchedOn.unshift(digits);
      }
    }
  }

  const cosine = dot / (candMag * recMag);
  // Strong exact-ID hit → guarantee top rank with a big additive floor.
  const score = cosine + (strong ? 10 : 0);
  return { score, matchedOn: matchedOn.slice(0, 6), strong };
}
