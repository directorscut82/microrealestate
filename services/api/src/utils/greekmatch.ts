/**
 * Noise-tolerant Greek matching for the voice/text command protocol.
 *
 * THE DESIGN PRINCIPLE (owner requirement, verbatim intent): quick messaging
 * and voice dictation are real-time constructs — names arrive misspelt from
 * the ASR, months arrive with typos when typed, and the first message may be
 * GREEKLISH («plhrwmh enoikiou Mantas» is how the owner actually types). No
 * resolver in this file may demand exact spelling; every one takes noisy input
 * and returns {value, confidence} or null — and null means ASK AGAIN, never
 * guess.
 *
 * THE MECHANISM, in matching order:
 *   1. greeklishToGreek — Latin keyboard transliteration (h→η, w→ω, 8→θ …).
 *   2. phonetic skeleton — Modern Greek spells one sound many ways
 *      (ι/η/υ/ει/οι → i, ο/ω → o, ε/αι → e); the ASR does not misHEAR, it
 *      picks a homophone, so collapsing both sides makes «ενικίου» equal
 *      «ενοικίου» at distance ZERO. Measured on real speech: intent and tenant
 *      name both matched exactly through this fold where raw edit distance
 *      needed fuzz.
 *   3. bounded edit distance over SPACE-FREE skeletons — word boundaries drift
 *      in ASR output («δω κιμή» for «Δοκιμή»), so the needle is searched as an
 *      approximate substring of the whole utterance, boundaries ignored.
 *
 * WHAT IS DELIBERATELY NOT HERE: the fuzzy AMOUNT parser. Its ancestor
 * produced €130 for €80.50 (postprocess.mjs, condemned by the expert review);
 * amounts from TEXT are digits-only here (typed digits are unambiguous, cents
 * included), and amounts from VOICE go through the voiceasr container's
 * grammar decoder with its likelihood-ratio guard.
 */

/** Latin/greeklish → Greek, longest-first so digraphs win («th»→θ before «t»→τ). */
const GREEKLISH: [string, string][] = [
  ['th', 'θ'],
  ['ch', 'χ'],
  ['ps', 'ψ'],
  ['ks', 'ξ'],
  ['ou', 'ου'],
  ['ai', 'αι'],
  ['ei', 'ει'],
  ['oi', 'οι'],
  ['mp', 'μπ'],
  ['nt', 'ντ'],
  ['gk', 'γκ'],
  ['a', 'α'],
  ['b', 'β'],
  ['g', 'γ'],
  ['d', 'δ'],
  ['e', 'ε'],
  ['z', 'ζ'],
  ['h', 'η'],
  ['i', 'ι'],
  ['k', 'κ'],
  ['l', 'λ'],
  ['m', 'μ'],
  ['n', 'ν'],
  ['x', 'ξ'],
  ['o', 'ο'],
  ['p', 'π'],
  ['r', 'ρ'],
  ['s', 'σ'],
  ['t', 'τ'],
  ['y', 'υ'],
  ['u', 'υ'],
  ['f', 'φ'],
  ['v', 'β'],
  ['w', 'ω'],
  ['c', 'κ'],
  ['j', 'τζ'],
  ['q', 'κ'],
  ['8', 'θ'],
  ['9', 'θ']
];

export function greeklishToGreek(s: string): string {
  // Only transliterate when the text is DOMINANTLY latin — a Greek message
  // with one latin char (a unit, an emoji fallback) must pass through intact.
  const latin = (s.match(/[a-zA-Z]/g) || []).length;
  const greek = (s.match(/[Ͱ-Ͽἀ-῿]/g) || []).length;
  if (latin === 0 || latin < greek) return s;
  let t = s.toLowerCase();
  for (const [from, to] of GREEKLISH) {
    t = t.split(from).join(to);
  }
  return t;
}

/** Strip diacritics, case-fold, final-sigma fold. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/ς/g, 'σ');
}

/**
 * Phonetic skeleton. Order matters: digraphs are consumed before the single
 * letters they contain, or «ου» becomes /o/+/i/.
 */
export function skeleton(s: string): string {
  let t = fold(greeklishToGreek(s));
  const rules: [RegExp, string][] = [
    [/ου/g, 'u'],
    [/ει|οι|υι/g, 'i'],
    [/αι/g, 'e'],
    [/αυ/g, 'af'],
    [/ευ/g, 'ef'],
    [/μπ/g, 'b'],
    [/ντ/g, 'd'],
    [/γκ|γγ/g, 'g'],
    [/τσ/g, 'ts'],
    [/τζ/g, 'dz'],
    [/[ιηυ]/g, 'i'],
    [/[οω]/g, 'o'],
    [/ε/g, 'e'],
    [/α/g, 'a'],
    [/β/g, 'v'],
    [/γ/g, 'g'],
    [/δ/g, 'd'],
    [/ζ/g, 'z'],
    [/θ/g, 'th'],
    [/κ/g, 'k'],
    [/λ/g, 'l'],
    [/μ/g, 'm'],
    [/ν/g, 'n'],
    [/ξ/g, 'ks'],
    [/π/g, 'p'],
    [/ρ/g, 'r'],
    [/σ/g, 's'],
    [/τ/g, 't'],
    [/φ/g, 'f'],
    [/χ/g, 'x'],
    [/ψ/g, 'ps']
  ];
  for (const [re, to] of rules) t = t.replace(re, to);
  // collapse doubles («κάππα» → kapa); drop everything that is not skeleton
  return t.replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

export interface Match<T> {
  value: T;
  /** 1 - relativeDistance; 1.0 is a skeleton-exact hit. */
  confidence: number;
  matched: string;
}

/**
 * Best vocabulary entry INSIDE an utterance, on space-free skeletons —
 * approximate substring search, because the entry is one part of a longer
 * message and the ASR's spacing is unreliable.
 *
 * `minConfidence` is the honesty floor: below it the answer is null and the
 * protocol asks again. A wrong-but-confident name still reaches the human
 * confirmation step, so the floor trades dialogue rounds against annoyance,
 * not against money.
 */
export function findBest<T>(
  utterance: string,
  vocab: { value: T; labels: string[] }[],
  minConfidence = 0.66
): Match<T> | null {
  const hay = skeleton(utterance);
  if (!hay) return null;
  let best: Match<T> | null = null;
  for (const entry of vocab) {
    for (const label of entry.labels) {
      const needle = skeleton(label);
      if (!needle) continue;
      let bestD = Infinity;
      for (
        let w = Math.max(1, needle.length - 2);
        w <= needle.length + 2 && bestD > 0;
        w++
      ) {
        for (let i = 0; i + w <= hay.length; i++) {
          const d = levenshtein(needle, hay.slice(i, i + w));
          if (d < bestD) bestD = d;
          if (bestD === 0) break;
        }
      }
      const conf = 1 - bestD / needle.length;
      if (conf >= minConfidence && (!best || conf > best.confidence)) {
        best = { value: entry.value, confidence: +conf.toFixed(3), matched: label };
      }
    }
  }
  return best;
}

// ── slot resolvers ───────────────────────────────────────────────────────────

export type MoneyIntent = 'rentPayment' | 'commonChargesPayment' | 'ownerPayment';

const INTENTS: { value: MoneyIntent; labels: string[] }[] = [
  {
    value: 'rentPayment',
    labels: ['καταβολή ενοικίου', 'πληρωμή ενοικίου', 'ενοίκιο', 'πλήρωσε το ενοίκιο']
  },
  {
    value: 'commonChargesPayment',
    labels: ['πληρωμή κοινοχρήστων', 'κοινόχρηστα', 'καταβολή κοινοχρήστων']
  },
  {
    value: 'ownerPayment',
    labels: ['καταβολή ιδιοκτήτη', 'πληρωμή ιδιοκτήτη', 'απόδοση ιδιοκτήτη']
  }
];

export function matchIntent(utterance: string): Match<MoneyIntent> | null {
  // Intents are long, distinctive phrases; a slightly higher floor keeps a
  // stray «πληρωμή» in an unrelated sentence from starting a money dialogue.
  return findBest(utterance, INTENTS, 0.72);
}

// NOTE: services/voiceasr/src/pipeline.py carries the SAME month table for the
// container's closed-set decode. Two runtimes, no shared source — if you add a
// form here (e.g. another colloquial genitive), add it there too.
const MONTHS: { value: number; labels: string[] }[] = [
  { value: 1, labels: ['Ιανουάριος', 'Ιανουαρίου', 'Γενάρης', 'Γενάρη'] },
  { value: 2, labels: ['Φεβρουάριος', 'Φεβρουαρίου', 'Φλεβάρης', 'Φλεβάρη'] },
  { value: 3, labels: ['Μάρτιος', 'Μαρτίου', 'Μάρτης', 'Μάρτη'] },
  { value: 4, labels: ['Απρίλιος', 'Απριλίου', 'Απρίλης', 'Απρίλη'] },
  { value: 5, labels: ['Μάιος', 'Μαΐου', 'Μάης', 'Μάη'] },
  { value: 6, labels: ['Ιούνιος', 'Ιουνίου'] },
  { value: 7, labels: ['Ιούλιος', 'Ιουλίου'] },
  { value: 8, labels: ['Αύγουστος', 'Αυγούστου'] },
  { value: 9, labels: ['Σεπτέμβριος', 'Σεπτεμβρίου', 'Σεπτέμβρης', 'Σεπτέμβρη'] },
  { value: 10, labels: ['Οκτώβριος', 'Οκτωβρίου', 'Οκτώβρης', 'Οκτώβρη'] },
  { value: 11, labels: ['Νοέμβριος', 'Νοεμβρίου', 'Νοέμβρης', 'Νοέμβρη'] },
  { value: 12, labels: ['Δεκέμβριος', 'Δεκεμβρίου', 'Δεκέμβρης', 'Δεκέμβρη'] }
];

export function matchMonth(utterance: string): Match<number> | null {
  // Months are short; June/July («Ιούνιος»/«Ιούλιος») differ by one skeleton
  // character, so the floor must be strict enough that a typo in one cannot
  // fall into the other. 0.75 on a 5-6 char skeleton allows one edit — and
  // one edit keeps iunios/iulios DISTINCT (they differ in exactly one char, so
  // the true month always scores strictly higher).
  return findBest(utterance, MONTHS, 0.75);
}

export function matchYesNo(utterance: string): 'yes' | 'no' | null {
  // Check BOTH the plain fold and the greeklish-transliterated fold, and take
  // the union. «oxi» transliterates to «οξι» (x→ξ), losing the match, so the
  // raw-latin form must also be tested — short yes/no tokens are exactly where
  // transliteration corrupts more than it helps.
  const raw = fold(utterance).trim();
  const gr = fold(greeklishToGreek(utterance)).trim();
  const has = (re: RegExp) => re.test(raw) || re.test(gr);
  const yes = has(/(^|\s)(ναι|νε|ok|οκ|μαλιστα|σωστα|σωστο|ενταξει|yes)(\s|$|[.,!;])/);
  const no = has(/(^|\s)(οχι|οξι|λαθοσ|no)(\s|$|[.,!;])/);
  // BOTH present («όχι, ναι σωστά») is a self-correction mid-message —
  // ambiguous, so return null and let the bot ask again rather than pick one.
  if (yes && no) return null;
  if (yes) return 'yes';
  if (no) return 'no';
  return null;
}

/**
 * Amount from TYPED text: digits only, cents allowed.
 *
 * Typed digits are the one unambiguous modality («350», «80,50», «30 ευρώ»,
 * «350€», greeklish «350 eyrw»), so cents are SAFE here — unlike voice, where
 * the grammar is integers 1..9999 and cents are refused by the LR guard.
 * Greek number WORDS in text are deliberately not parsed: the fuzzy word
 * parser is the ancestor that produced €130 for €80.50, and anyone typing
 * words can be asked to type the digits.
 */
export function parseAmountText(
  utterance: string
): { value: number; cents: boolean } | null {
  const t = utterance.replace(/\u00a0/g, ' ');
  const matches = [...t.matchAll(/(\d{1,3}(?:\.\d{3})+|\d+)(?:[,.](\d{1,2}))?/g)];
  // A message with TWO independent numbers («300 όχι 400») is a correction in
  // one breath — ambiguous, so ask. One number, possibly with cents, is an amount.
  const distinct = new Set(matches.map((m) => m[0]));
  if (matches.length === 0 || distinct.size > 1) return null;
  const m = matches[0];
  const whole = parseInt(m[1].replace(/\./g, ''), 10);
  const cents = m[2] ? parseInt(m[2].padEnd(2, '0'), 10) : 0;
  if (!Number.isFinite(whole) || whole <= 0 || whole > 100000) return null;
  return { value: +(whole + cents / 100).toFixed(2), cents: cents > 0 };
}
