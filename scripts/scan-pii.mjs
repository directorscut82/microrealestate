#!/usr/bin/env node
/**
 * PII guard for a PUBLIC repository.
 *
 * Why this exists: on 2026-07-31 a `git add -A` swept a real ΔΕΗ bill PDF (and
 * its OCR text) out of a scratch directory and into a commit that was pushed to
 * this repo — which is public. `.gitignore` was useless as a defence because the
 * ignore rules were written AFTER the accident, and because `add -A` is exactly
 * the command that makes "I only meant to commit 4 files" untrue.
 *
 * A `.gitignore` says "don't pick this up by accident". This says "do not let a
 * real person's tax ID, name, address or scanned document leave this machine".
 * The two are not substitutes.
 *
 * Scope: STAGED content only (so it is fast and blocks the commit that matters).
 * Run with --all to sweep every tracked file instead — useful after a scrub.
 *
 * Exit 0 = clean. Exit 1 = something matched; the commit is refused.
 *
 * Escape hatch: PII_SCAN_SKIP=1 git commit …  (recorded here deliberately — a
 * guard nobody can bypass gets deleted the first time it is wrong, and then
 * there is no guard at all. Bypassing is a decision the human makes knowingly.)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8'
}).trim();

/** Greek ΑΦΜ check digit: (Σ digit[i] · 2^(8−i) mod 11) mod 10 === digit[8]. */
function isChecksumValidAFM(value) {
  if (!/^[0-9]{9}$/.test(value)) return false;
  if (/^(\d)\1{8}$/.test(value)) return false; // 000000000, 111111111 — sentinels
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(value[i]) * 2 ** (8 - i);
  return ((sum % 11) % 10) === Number(value[8]);
}

/**
 * Synthetic ΑΦΜ used by fixtures live in a reserved band. They are
 * checksum-valid on purpose (the parsers validate the check digit, so a
 * fixture with a bogus checksum would not exercise the real code path), which
 * means the checksum alone cannot tell real from fake — hence the band.
 */
const SYNTHETIC_AFM_PREFIX = /^9990000/;

/**
 * Structurally-obvious synthetic 9-digit values that the reserved band does not
 * cover. Every entry here was flagged by the --all sweep of 2026-08-01 and then
 * read in situ; all 48 hits reduced to these shapes, and NONE collides with a
 * confirmed-real value (checked explicitly).
 *
 * This matters more than it looks: 48 false positives is how a guard teaches
 * people to reach for PII_SCAN_SKIP by reflex, and a guard that is always
 * bypassed is a guard that is not running. Precision IS a security property.
 *
 * Each rule is structural, not a literal list, so a new fixture that follows an
 * existing convention does not need this file edited.
 */
const SYNTHETIC_AFM_SHAPES = [
  // Check-digit arithmetic worked out in comments: N followed by zeros then the
  // resulting check digit (100000003, 200000006 … 600000007, 700000000).
  /^[1-9]0{7}[0-9]$/,
  // Ascending/descending keyboard runs — the canonical textbook ΑΦΜ examples.
  /^12345678[0-9]$/,
  /^98765432[0-9]$/,
  // ΔΕΗ's own published corporate ΑΦΜ. A utility's company tax number is public
  // company data, not a natural person's — and the bill parser tests need it.
  /^090000045$/
];

/**
 * A hand-typed placeholder has almost no digit variety: `444555667`,
 * `999888777`, `099887766`, `999000018`, `669999660`. A real issued ΑΦΜ does
 * not look like that.
 *
 * Rule: at most 4 DISTINCT digits across the 9, or a 4+ run of one digit. Both
 * measures are needed — `099887766` uses 5 distinct digits but is built from
 * descending pairs, so it is caught by the pair-structure test below instead.
 */
function looksHandTyped(value) {
  const distinct = new Set(value).size;
  if (distinct <= 4) return true;
  if (/(\d)\1{3,}/.test(value)) return true;
  // Runs of repeated digits: 3+ groups of length >= 2 means a typed pattern
  // (0-99-88-77-66, 444-555-66-7) rather than an issued number.
  const groups = value.match(/(\d)\1+/g) ?? [];
  return groups.filter((g) => g.length >= 2).length >= 3;
}

function isSyntheticAFM(value) {
  if (SYNTHETIC_AFM_PREFIX.test(value)) return true;
  if (SYNTHETIC_AFM_SHAPES.some((re) => re.test(value))) return true;
  return looksHandTyped(value);
}

/**
 * DIGIT-STREAM MATCHING.
 *
 * Every literal-string scrub this repo has attempted was defeated by SPACING.
 * A real IBAN written `GR06 0109 9999 9000 0000 0000 125` survived three
 * separate passes that were searching for `GR3301109999990000000000001`, and a
 * real ΕΥΔΑΠ document number survived as `2026 0999 9000 0006 74`. The regexes
 * above have the same blind spot: `[0-9]{9}` never sees `999 000 565`.
 *
 * So each line is ALSO reduced to its bare digit sequence and the sensitive
 * numerics are searched in that stream. Offsets are meaningless there, which is
 * why this reports at line granularity and runs as a separate pass.
 */
function digitStream(text) {
  return text.replace(/[^0-9]/g, '');
}

/**
 * SCRIPT / HOMOGLYPH FOLDING.
 *
 * `ΜΙΣΘΩΤΗΣ` is Latin K (U+004B) followed by Greek ΡΑΝΤΑΣ. It renders
 * identically to the all-Greek spelling and is the same person's name, but no
 * Greek-only matcher will ever see it. OCR output is full of these because the
 * recognizer picks whichever codepoint scored higher per glyph.
 *
 * Fold the Greek letters that share a glyph with a Latin one onto the Latin
 * form, uppercase, and strip accents — then match tokens in that space too.
 */
const HOMOGLYPH_MAP = {
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M',
  Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X'
};

function foldScript(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ΄-΅]/g, '')
    .toUpperCase()
    .replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/g, (c) => HOMOGLYPH_MAP[c] ?? c);
}

// Real-world documents. A scanned bill or contract is never test data.
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.xlsx',
  '.eml',
  '.msg'
]);

/**
 * Paths that legitimately contain the tokens below and must NOT trip the guard.
 * Kept deliberately short: every entry here is a hole in the net.
 */
const ALLOWLIST_PATHS = [
  'scripts/scan-pii.mjs', // this file names the patterns it hunts
  '.husky/pre-commit'
];

/**
 * Lockfiles are machine-generated and packed with long hex checksums; any 9
 * consecutive digits inside a SHA-512 will satisfy the ΑΦΜ check digit roughly
 * 1 in 11 times. Scanning them produced 60+ false positives on the first run,
 * which is precisely how a guard earns a reputation for crying wolf and gets
 * bypassed by reflex. Lockfiles cannot contain hand-entered personal data.
 */
const GENERATED_FILES = /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml)$/;

/**
 * Long hex/base64 runs (checksums, integrity hashes, git SHAs, JWTs, base64
 * blobs). A digit run that sits inside one of these is not a tax ID.
 *
 * CAREFUL — this is a muzzle as much as a filter. It applies ONLY to the
 * unstructured 9-digit tax-ID patterns (see `hashBlind` below). Applying it to
 * everything is what made the `iban` and `rf-payment-code` patterns dead code
 * from the day they were written: a bare `GR3301109999990000000000001` is 25
 * alphanumerics and `RF10999000000000000648051` is 23 hex-ish characters, so
 * both were blanked to spaces before matching, and a canary test planting the
 * REAL leaked IBAN sailed straight through the guard. The spaced forms matched,
 * the raw forms did not — the exact inverse of what anyone would assume.
 */
const HEXISH_RUN = /[0-9a-fA-F]{24,}|[A-Za-z0-9+/=_-]{40,}/g;

/** Blank out hash-like runs before pattern matching, preserving line offsets. */
function stripHashLikeRuns(text) {
  return text.replace(HEXISH_RUN, (m) => ' '.repeat(m.length));
}

/**
 * Images that ship WITH the product (UI logos, upstream documentation
 * screenshots) are not scans of the owner's paperwork. Real-world documents are
 * the ones that arrive from a bank, a utility, or a tax authority.
 */
const PRODUCT_ASSET_DIRS = [
  'services/pdfgenerator/templates/img/',
  'services/emailer/documentation/pictures/',
  // Upstream README/architecture screenshots, authored by the original project
  // owner between 2017 and 2023 and inherited by this fork. They show the demo
  // realm, not this landlord's data — verified via `git log --format='%an'`.
  // Every file here predates the fork; anything NEW dropped into this directory
  // should be treated with suspicion rather than added to this list.
  'documentation/pictures/',
  'webapps/landlord/public/',
  'webapps/tenant/public/',
  'webapps/commonui/'
];

/**
 * Literal strings that must never be committed. Populated with the real values
 * that leaked, so a copy-paste of the same data is caught verbatim.
 *
 * NOTE: this list is itself sensitive. It lives in the repo because a guard that
 * depends on an uncommitted file silently stops working on a fresh clone — but
 * only the SURNAMES and STREET NAMES are listed, never a full identity, and the
 * tax IDs are matched structurally (checksum + not-synthetic) rather than by
 * literal value, so no real tax ID appears in this file.
 */
const FORBIDDEN_TOKENS = [
  // Family surnames of the repo owner's real landlords/owners/tenants.
  'ΔΟΚΙΜΗ',
  'ΔΟΚΙΜΑΣΤΗ',
  // Real property street names.
  'ΟΔΟΣ ΗΤΑ',
  'ΟΔΟΣ ΕΨΙΛΟΝ',
  'ΟΔΟΣ ΖΗΤΑ',
  'ΠΕΡΙΟΧΗ ΘΗΤΑ',
  // Found by the 2026-08-01 folded/digit-stream sweeps AFTER the first scrub
  // had been declared complete. Each one had survived at least one pass that
  // was searching case-sensitively, or searching only for the Greek spelling,
  // or searching the literal text while the value sat in \uXXXX escapes.
  // ΠΕΡΙΟΧΗ ΘΗΤΑ above is here for exactly that reason: it lived on as
  // "ΛΑΓ..." in an e9parser comment.
  'ΔΟΚΙΜΑΣΤΗΣ',
  'ΔΟΚΙΜΑΣΤΗΣ',
  'ΔΟΚΙΜΑΚΗ',
  'ΔΟΚΙΜΑΡΗΣ',
  'ΔΟΚΙΜΙΩΤΗΣ',
  'ΜΙΣΘΩΤΡΙΑ',
  'ΒΗΤΑ',
  'ΔΟΚΙΜΕΖΟΥ',
  'ΔΟΚΙΜΙΩΡΟΣ',
  'ΔΟΚΙΜΗΣ',
  'ΜΙΣΘΩΤΗΣ',
  'ΟΔΟΣ ΖΗΤΑ',
  // Latin forms of the above that actually appeared in this repo.
  'DOKIMASTIS',
  'DOKIMASTIS',
  'DOKIMAKI',
  'DOKIMARIS',
  'DOKIMIOTIS',
  'DOKIMIOROS',
  'DOKIMIS',
  'MISTHOTIS',
  'ODOS ZITA',
  'ODOS ZITA',
  // Test-realm identity that leaked as a plaintext credential pair.
  'E2ETEST',
  // LATIN TRANSLITERATIONS. A Greek-only token list is trivially defeated by
  // writing the same surname in Latin script, and this repo did exactly that
  // without anyone intending to: "DOKIMASTI" sat in a buildingmanager comment and
  // in three spec headers while every Greek spelling had been scrubbed. Matched
  // case-insensitively (see TOKEN_MATCHERS), so Dokimasti/dokimasti/DOKIMASTI all trip.
  'DOKIMASTI',
  'DOKIMI',
  'ODOS ITA',
  'ODOS EPSILON',
  'ODOS ZITA',
  'PERIOCHI THITA'
];

/**
 * Every token is matched in the FOLDED space: uppercased, accents stripped, and
 * homoglyph-Greek mapped onto Latin. One comparison space for all tokens.
 *
 * The previous version special-cased Greek tokens as `text.includes(token)` —
 * case-SENSITIVE, on the reasoning that "Greek tokens are already uppercase in
 * every real occurrence". That reasoning was wrong, and it was wrong in this
 * repo: a lowercase `("dokimastis"/"dokimastis")` in a matching.ts comment
 * survived a scrub whose grep was case-sensitive, and was only found later by a
 * folded scan. Folding both sides removes the entire class.
 *
 * Cost: `ΡΑΝΤΑΣ` folds to `PANTAS`, so a Latin word could in principle collide
 * with a folded Greek token. With these tokens (8+ chars, all distinctive
 * surnames) that has not produced a single false positive across the tree.
 */
const FOLDED_TOKENS = FORBIDDEN_TOKENS.map((token) => ({
  token,
  folded: foldScript(token)
}));

/**
 * Decode \uXXXX escapes before matching. A name written as an escape sequence
 * is still a published name, and source files legitimately contain escapes, so
 * a scanner that only reads literal characters can be sidestepped — deliberately
 * or (more likely here) by a tool that escaped non-ASCII on the way out.
 * Length is not preserved, so this feeds a SECOND pass over each line rather
 * than replacing the raw text used for line-offset reporting.
 */
function decodeUnicodeEscapes(text) {
  if (!text.includes('\\u')) return null;
  const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return decoded === text ? null : decoded;
}

/**
 * Digit sequences from the REAL utility bills and bank receipts. These are the
 * values the 2026-08-01 sweep found still sitting in tracked files: a ΔΕΗ RF
 * creditor reference, a ΕΥΔΑΠ document/registry/barcode triple, and a payee
 * IBAN off a bank transfer confirmation.
 *
 * Listed as digit streams WITHOUT their prefixes precisely so the spaced forms
 * are caught: `GR06 0109 9999 9000 0000 0000 125` and
 * `GR3301109999990000000000001` reduce to the same stream, and the spaced form
 * is the one that survived three literal-string scrubs.
 *
 * These are identifiers, not secrets in the password sense — they cannot be used
 * to authenticate. They are in this file for the same reason the surnames are:
 * a guard that depends on an uncommitted denylist silently stops working on a
 * fresh clone. Truncated to a distinctive interior run so the file does not
 * itself republish a complete account number.
 */
const REAL_BILL_DIGIT_RUNS = [
  '999000000000000', // ΔΕΗ RF creditor reference body (shared across months)
  '9999000000', // ΕΥΔΑΠ document number interior
  '9990001', // ΕΥΔΑΠ ΑΡ. ΜΗΤΡΩΟΥ (stable per-meter id)
  '1099999900000000000', // payee IBAN interior
  '000565', // ΔΕΗ παροχή A tail — see note below
  '000286', // ΔΕΗ παροχή B tail — same failure mode, found 2026-08-01
  '9990000000000000000' // NOVA RF interior
];

/**
 * The παροχή values are listed as 6-digit TAILS, not the full 9 digits, because
 * of a failure mode worth naming: a comment in billidentity.ts had "scrubbed" a
 * real provision by masking its first three digits and leaving the last six
 * intact. A denylist holding only the complete value would have called that
 * clean. Partial scrubs are the norm, not the exception, so match the part that
 * survives them.
 *
 * Both tails are here because BOTH mistakes were made in this repo, and the
 * second one was made by the very commit that added this comment: the AADE
 * fixture's provision was masked to `999000286`, which is the real tail with a
 * `999` bolted on. It sailed past the guard because only the first tail was
 * listed. Writing down a failure mode is not the same as being immune to it —
 * the entry in this array is what makes the guard immune, not the paragraph
 * above it. If you mask a value, add its surviving tail here in the same edit.
 *
 * 6 digits is short enough to collide by chance (~1 in 10^6 per position), which
 * is why the digit-stream pass reports rather than hard-fails on its own: a hit
 * is a prompt to look, and the surrounding context makes the call obvious.
 */

const PATTERNS = [
  {
    id: 'greek-tax-id',
    // 9 consecutive digits, not part of a longer number.
    re: /(?<![0-9])[0-9]{9}(?![0-9])/g,
    // Needs hash-blanking: a bare 9-digit run is the one pattern here that
    // genuinely collides with checksum/SHA content (~1 in 11 satisfies the ΑΦΜ
    // check digit).
    hashBlind: true,
    // Structural test: a real ΑΦΜ satisfies the check digit. Synthetic fixture
    // values are recognised structurally (reserved band + placeholder shapes)
    // and allowed through — see isSyntheticAFM for why precision matters here.
    accept: (m) => isChecksumValidAFM(m) && !isSyntheticAFM(m),
    describe: 'checksum-valid Greek tax ID (ΑΦΜ) outside the synthetic bands'
  },
  {
    id: 'labelled-tax-id',
    // The checksum test alone is not enough: a real ΑΦΜ that was mistyped when
    // copied off a screenshot fails the check digit but is still that person's
    // tax number (this repo shipped exactly one such value in an HTML mockup).
    // So ANY 9-digit run explicitly labelled as a tax ID is suspect, checksum
    // or not — unless it sits in the reserved synthetic band.
    re: /(?:ΑΦΜ|Α\.Φ\.Μ\.|AFM|taxId|vatNumber)["'\s:=>]{0,12}([0-9]{9})(?![0-9])/gi,
    hashBlind: true,
    extract: (m) => m.match(/([0-9]{9})(?![0-9])/)?.[1] ?? m,
    accept: (m) => {
      const v = m.match(/([0-9]{9})(?![0-9])/)?.[1];
      if (!v) return false;
      // A run of one repeated digit is a sentinel, not a person. '000000000'
      // is the documented "missing ΑΦΜ" marker that isValidAfm() rejects by
      // name (greekleaseparser.ts), and fixtures use it to mean absent. The
      // structural pattern above already skips these; this one has to as well,
      // or the guard reports the very value the code uses to say "no tax ID".
      if (/^(\d)\1{8}$/.test(v)) return false;
      return !isSyntheticAFM(v);
    },
    describe: 'value explicitly labelled as a Greek tax ID (ΑΦΜ)'
  },
  {
    id: 'iban',
    // NO leading \b. `\b` requires a word/non-word transition, and `_` plus every
    // ASCII letter and digit is a word character — so in a JS/JSON string literal
    // holding an ESCAPED newline (`…001\nGR16011…`), the `n` of `\n` sits
    // immediately before `GR` and there is no boundary to match. A real IBAN hid
    // at billparser.test.js:300 behind exactly that for as long as this pattern
    // existed. The trailing (?![0-9A-Z]) is kept: it must not truncate-match the
    // head of a longer alphanumeric run.
    re: /GR[0-9]{2}[0-9]{7}[0-9A-Z]{16}(?![0-9A-Z])/g,
    // Reserved-band fixture IBANs. Structure is GR + 2 check + 3 bank + 4 branch
    // + 16 account, so the synthetic marker lands at the BRANCH code (offset
    // 7-10) and again at the head of the account body — NOT at offset 4, which is
    // the real bank code 011 deliberately kept so branch handling stays
    // exercised. Anchoring on the branch is what the earlier
    // /^GR\d{2}\d{3}999/ got wrong: it looked for 999 three digits too early and
    // flagged every fixture IBAN in the repo as real.
    accept: (m) => !/^GR[0-9]{2}[0-9]{3}0999999/.test(m),
    describe: 'Greek IBAN'
  },
  {
    id: 'rf-payment-code',
    // No leading \b, for the same escaped-newline reason as `iban` above.
    re: /RF[0-9]{2}[0-9]{10,}(?![0-9])/g,
    // Fixtures use a reserved 999… body. Real ΔΕΗ/NOVA references do not, and
    // the synthetic ones are still mod-97 valid so isValidRF() is exercised for
    // real — see billMatching.test.js. Sequential runs (RF12345678901234567) and
    // all-zero bodies (RF12000…0) are placeholders in tests that exercise a
    // volume/shape gate and never call the checksum at all; a real creditor
    // reference is never a constant digit.
    accept: (m) =>
      !/^RF[0-9]{2}999/.test(m) &&
      !/^RF1234567890/.test(m) &&
      !/^RF[0-9]{2}0{10,}$/.test(m),
    describe: 'RF electronic payment code from a real utility bill'
  },
  {
    id: 'utility-provision',
    // ΔΕΗ provision number: 9 digits + '-' + 3 digits (e.g. NNNNNNNNN-NNN).
    re: /(?<![0-9])[0-9]{9}-[0-9]{3}(?![0-9])/g,
    accept: (m) => !isSyntheticAFM(m.slice(0, 9)),
    describe: 'utility provision/meter number (ΔΕΗ/ΕΥΔΑΠ/ΕΠΑ παροχή)'
  },
  {
    id: 'greek-mobile',
    re: /(?<![0-9])(?:\+30|0030)?69[0-9]{8}(?![0-9])/g,
    // Fixtures use 69 followed by a run of zeros then a sentinel tail
    // (6900000000, 6900000099, 6900099999). A real mobile has digit variety;
    // reuse the same hand-typed test as the tax IDs rather than a bespoke regex
    // that has to be widened every time a spec invents another placeholder.
    accept: (m) => {
      const digits = m.replace(/^(?:\+30|0030)/, '');
      if (/^690{3,}/.test(digits)) return false;
      return !looksHandTyped(digits.slice(-9));
    },
    describe: 'Greek mobile number'
  }
];

function stagedFiles() {
  const out = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { encoding: 'utf8', cwd: REPO }
  );
  return out.split('\0').filter(Boolean);
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    cwd: REPO
  });
  return out.split('\0').filter(Boolean);
}

/** Staged content, not worktree content — the commit is what gets published. */
function readStaged(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], {
      encoding: 'utf8',
      cwd: REPO,
      maxBuffer: 64 * 1024 * 1024
    });
  } catch {
    return null;
  }
}

function readTracked(file) {
  const abs = path.join(REPO, file);
  if (!existsSync(abs)) return null;
  try {
    if (statSync(abs).size > 8 * 1024 * 1024) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function mask(value) {
  if (value.length <= 3) return '***';
  return `${value.slice(0, 2)}***${value.slice(-1)}`;
}

function scan(files, read) {
  const violations = [];

  for (const file of files) {
    if (ALLOWLIST_PATHS.includes(file)) continue;
    if (GENERATED_FILES.test(file)) continue;

    // A real scanned document is a violation by existence, not by content —
    // unless it is a product asset that ships with the app.
    if (DOCUMENT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      if (!PRODUCT_ASSET_DIRS.some((d) => file.startsWith(d))) {
        violations.push({
          file,
          line: 0,
          id: 'real-world-document',
          detail: `${path.extname(file)} binary/document — scanned real-world documents must never be committed to a public repo`
        });
      }
      continue;
    }

    const content = read(file);
    if (content === null) continue;
    // Skip anything that looks binary.
    if (content.includes(' ')) continue;

    const lines = content.split('\n');
    lines.forEach((text, i) => {
      // Bare-9-digit patterns match against a copy with hash-like runs blanked
      // out (same length, so offsets are preserved). A 9-digit sequence inside a
      // SHA-512 satisfies the ΑΦΜ check digit ~1 time in 11; scanning raw text
      // produced 60+ false hits in yarn.lock alone on the first run, and a
      // guard that cries wolf is a guard that gets bypassed by reflex.
      //
      // Patterns with their own structural prefix (GR.., RF..) and the
      // digit-stream pass read the RAW line instead — they cannot collide with a
      // checksum, and blanking was silently disabling them (see HEXISH_RUN).
      const blanked = stripHashLikeRuns(text);

      // Identity tokens are checked in the FOLDED space (case-insensitive,
      // accent-stripped, homoglyph-normalised) against BOTH the literal line and
      // — when the line carries \uXXXX escapes — its decoded form. A name
      // spelled as escape sequences is still a published name: ΠΕΡΙΟΧΗ ΘΗΤΑ lived on
      // in an e9parser comment as ΛΑΓ... through an entire scrub.
      const decoded = decodeUnicodeEscapes(text);
      const foldedText = foldScript(text);
      const foldedDecoded = decoded === null ? null : foldScript(decoded);
      for (const { token, folded } of FOLDED_TOKENS) {
        if (
          foldedText.includes(folded) ||
          (foldedDecoded !== null && foldedDecoded.includes(folded))
        ) {
          violations.push({
            file,
            line: i + 1,
            id: 'real-identity-token',
            detail: `real name/address token ${mask(token)}`
          });
        }
      }

      for (const p of PATTERNS) {
        const matches = (p.hashBlind ? blanked : text).match(p.re);
        if (!matches) continue;
        for (const m of matches) {
          if (p.accept && !p.accept(m)) continue;
          const value = p.extract ? p.extract(m) : m;
          violations.push({
            file,
            line: i + 1,
            id: p.id,
            detail: `${p.describe}: ${mask(value)}`
          });
        }
      }

      // DIGIT-STREAM pass. Strip every non-digit and look for the known real
      // identifiers. This is what catches `GR06 0109 9999 9000 0000 0000 125`
      // and `2026 0999 9000 0006 74` — spaced forms that the regexes above and
      // three rounds of literal-string grep all walked straight past.
      const stream = digitStream(text);
      if (stream.length >= 7) {
        for (const run of REAL_BILL_DIGIT_RUNS) {
          if (stream.includes(run)) {
            violations.push({
              file,
              line: i + 1,
              id: 'real-bill-identifier',
              detail: `digit sequence from a real utility bill / bank receipt (${mask(run)}) — matched ignoring spaces and punctuation`
            });
          }
        }
      }
    });
  }

  return violations;
}

const all = process.argv.includes('--all');
const files = all ? trackedFiles() : stagedFiles();
const violations = scan(files, all ? readTracked : readStaged);

if (violations.length === 0) {
  if (all) console.log(`PII scan: clean (${files.length} tracked files).`);
  process.exit(0);
}

console.error('');
console.error(
  '╔══════════════════════════════════════════════════════════════════════╗'
);
console.error(
  '║  COMMIT BLOCKED — real personal data detected                         ║'
);
console.error(
  '║  This repository is PUBLIC. Anything committed here is world-readable ║'
);
console.error(
  '║  and remains readable in git history even after you delete it.        ║'
);
console.error(
  '╚══════════════════════════════════════════════════════════════════════╝'
);
console.error('');

const byFile = new Map();
for (const v of violations) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file).push(v);
}
for (const [file, vs] of byFile) {
  console.error(`  ${file}`);
  for (const v of vs.slice(0, 8)) {
    const where = v.line ? `:${v.line}` : '';
    console.error(`      ${file}${where} — [${v.id}] ${v.detail}`);
  }
  if (vs.length > 8) console.error(`      … and ${vs.length - 8} more`);
}

console.error('');
console.error(`  ${violations.length} violation(s) in ${byFile.size} file(s).`);
console.error('');
console.error('  Fix by replacing real data with synthetic equivalents:');
console.error('    · names/addresses → E2E-* or ΟΔΟΣ ΔΟΚΙΜΗΣ style placeholders');
console.error('    · tax IDs → the reserved synthetic band 9990000xx (checksum-valid,');
console.error('      so parser tests still exercise the real validation path)');
console.error('    · scanned documents → keep them OUTSIDE the repo entirely');
console.error('');
console.error('  Deliberate override (you are publishing this):  PII_SCAN_SKIP=1 git commit …');
console.error('');
process.exit(1);
