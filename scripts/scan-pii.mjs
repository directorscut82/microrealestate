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
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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
  return (sum % 11) % 10 === Number(value[8]);
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
 * A real IBAN written `GR99 9999 9999 9999 9999 9999 999` survived three
 * separate passes that were searching for the unspaced `GR9999…` form, and a
 * real ΕΥΔΑΠ document number survived the same way. The regexes above have the
 * same blind spot: `[0-9]{9}` never sees `999 999 999`.
 *
 * (The examples here are deliberately synthetic. An earlier version of this
 * comment illustrated the point with the actual leaked IBAN and an actual ΔΕΗ
 * provision, which made the guard's own documentation a publisher of the data.)
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
 * `KΑΠΠΑΣ` written with a Latin K (U+004B) followed by Greek ΑΠΠΑΣ renders
 * identically to the all-Greek spelling and is the same person's name, but no
 * Greek-only matcher will ever see it. OCR output is full of these because the
 * recognizer picks whichever codepoint scored higher per glyph. One real
 * surname in this repo's fixtures was mixed-script for exactly that reason.
 *
 * Fold the Greek letters that share a glyph with a Latin one onto the Latin
 * form, uppercase, and strip accents — then match tokens in that space too.
 */
const HOMOGLYPH_MAP = {
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X'
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
  // scripts/scan-pii.mjs used to be exempt here, because it held ~30 real
  // surnames and 7 real bill identifiers as plaintext and would otherwise have
  // blocked every commit by reporting itself. The exemption was the direct
  // consequence of the plaintext, and it meant the one file guaranteed to
  // contain real PII was the one file never checked.
  //
  // Both are gone: the values now live in an uncommitted denylist, and this file
  // is scanned like anything else. It is the regression test for its own leak —
  // paste a real name into it and the commit is refused. Do not re-add it.
  '.husky/pre-commit'
];

/**
 * Lockfiles are machine-generated and packed with long hex checksums; any 9
 * consecutive digits inside a SHA-512 will satisfy the ΑΦΜ check digit roughly
 * 1 in 11 times. Scanning them produced 60+ false positives on the first run,
 * which is precisely how a guard earns a reputation for crying wolf and gets
 * bypassed by reflex. Lockfiles cannot contain hand-entered personal data.
 */
const GENERATED_FILES =
  /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml)$/;

/**
 * Long hex/base64 runs (checksums, integrity hashes, git SHAs, JWTs, base64
 * blobs). A digit run that sits inside one of these is not a tax ID.
 *
 * CAREFUL — this is a muzzle as much as a filter. It applies ONLY to the
 * unstructured 9-digit tax-ID patterns (see `hashBlind` below). Applying it to
 * everything is what made the `iban` and `rf-payment-code` patterns dead code
 * from the day they were written: a bare `GR99……` IBAN is 25 alphanumerics and
 * an `RF99……` creditor reference is 23 hex-ish characters, so both were blanked
 * to spaces before matching, and a canary test planting the REAL leaked IBAN
 * sailed straight through the guard. The spaced forms matched, the raw forms did
 * not — the exact inverse of what anyone would assume.
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
 * LITERAL DENYLIST — loaded from an UNCOMMITTED file, by design.
 *
 * This array used to hold ~30 real surnames and street names of real third
 * parties as plaintext, plus 7 digit runs off real bills, and its own comment
 * conceded "this list is itself sensitive". That was a real leak, not a
 * theoretical one: on a PUBLIC repo the guard had become the single largest
 * remaining publisher of the exact data it was written to protect — 53 real
 * values, helpfully annotated as belonging to real people. A denylist of
 * victims' names is not a mitigation when the denylist is world-readable.
 *
 * The old justification was "a guard that depends on an uncommitted file
 * silently stops working on a fresh clone". Two things are wrong with it:
 *
 *  1. SILENTLY is the fixable part, not the dependency. Missing file now prints
 *     a loud warning (see loadLocalDenylist) instead of passing quietly.
 *  2. A fresh clone on someone else's machine has none of this data to
 *     re-introduce. The literal layer exists to catch THIS machine copy-pasting
 *     from its own scratch files and mongodumps. Every check that a stranger's
 *     clone actually needs is STRUCTURAL — tax-ID checksum, IBAN, RF code,
 *     provision, mobile, document-by-extension — and none of those needs a
 *     secret. They all keep running with no denylist present.
 *
 * Hashing the tokens instead was considered and rejected: surnames and 6-digit
 * tails are tiny search spaces, so a committed hash falls to a wordlist in
 * seconds. It would have republished the same PII with better branding.
 *
 * The file is generated from the same replace map that drives the history
 * rewrite, so the guard and the scrub cannot drift apart.
 */
const LOCAL_DENYLIST_PATH = path.join(REPO, '.secrets/pii-denylist.json');

function loadLocalDenylist() {
  if (!existsSync(LOCAL_DENYLIST_PATH)) {
    process.stderr.write(
      `\n  ! scan-pii: no local denylist at .secrets/pii-denylist.json\n` +
        `    Structural checks (tax ID, IBAN, RF, provision, mobile, documents)\n` +
        `    are ACTIVE. Literal known-value matching is OFF.\n` +
        `    Regenerate it before scrubbing history or trusting a clean result.\n\n`
    );
    return { tokens: [], digitRuns: [], patterns: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(LOCAL_DENYLIST_PATH, 'utf8'));
    return {
      tokens: Array.isArray(raw.tokens) ? raw.tokens : [],
      digitRuns: Array.isArray(raw.digitRuns) ? raw.digitRuns : [],
      patterns: Array.isArray(raw.patterns) ? raw.patterns : []
    };
  } catch (err) {
    // Do NOT fall through to "no denylist" on a parse error. A corrupt file is
    // indistinguishable from an empty one at match time, and the failure mode of
    // guessing wrong here is a silent publish.
    process.stderr.write(
      `\n  ! scan-pii: .secrets/pii-denylist.json is unreadable: ${err.message}\n` +
        `    Refusing to run with a half-loaded denylist.\n\n`
    );
    process.exit(1);
  }
}

const LOCAL_DENYLIST = loadLocalDenylist();
const FORBIDDEN_TOKENS = LOCAL_DENYLIST.tokens;

/**
 * Every token is matched in the FOLDED space: uppercased, accents stripped, and
 * homoglyph-Greek mapped onto Latin. One comparison space for all tokens.
 *
 * The previous version special-cased Greek tokens as `text.includes(token)` —
 * case-SENSITIVE, on the reasoning that "Greek tokens are already uppercase in
 * every real occurrence". That reasoning was wrong, and it was wrong in this
 * repo: a real surname written lowercase in a matching.ts comment (in both of
 * its two transliterations) survived a scrub whose grep was case-sensitive, and
 * was only found later by a folded scan. Folding both sides removes the class.
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
 * Digit sequences off the REAL utility bills and bank receipts — RF creditor
 * references, ΕΥΔΑΠ document/registry ids, payee IBAN interiors, ΔΕΗ provision
 * tails. Also loaded from the uncommitted denylist; see FORBIDDEN_TOKENS above
 * for why these are no longer written down in a public file.
 *
 * Stored as bare digit streams WITHOUT their prefixes, because that is the form
 * that survives spacing: the spaced and unspaced writings of the same IBAN
 * reduce to one stream, and the spaced form is the one that walked past three
 * separate literal-string scrubs.
 *
 * The provision entries are 6-digit TAILS rather than full values, for a failure
 * mode worth naming: this repo twice "scrubbed" a real provision by masking its
 * leading three digits and leaving the last six intact (`999` bolted onto a real
 * tail — the second instance committed by the very change that documented the
 * first, which is why this is a class and not an anecdote). A
 * denylist holding only complete values calls both of those clean. Partial
 * scrubs are the norm, so match the part that survives them, and add the
 * surviving tail in the same edit that masks a value.
 *
 * 6 digits collides by chance (~1 in 10^6 per position), which is why a
 * digit-stream hit reports for a human to look at rather than claiming
 * certainty. Values shorter than that (5-digit postcodes) are matched
 * word-bounded via DENY_PATTERNS instead — in the digit stream they fire on any
 * 5-digit window of a longer number, and that noise is precisely what teaches a
 * human to reach for PII_SCAN_SKIP by reflex.
 */
const REAL_BILL_DIGIT_RUNS = LOCAL_DENYLIST.digitRuns;

/**
 * Boundary-matched regexes for values too short or too collision-prone for the
 * substring/digit-stream passes.
 *
 * Two categories, both learned the hard way:
 *  · A short Latin token collides with hash interiors. One 3-letter given name,
 *    folded, matches base64 and sha512 bodies in the Yarn release binary and both
 *    lockfiles — bounding it is the difference between a guard and a corrupted
 *    dependency tree.
 *  · A short GREEK token is a substring of ordinary Greek words (one real given
 *    name here is a substring of the common word for "lively"). Bounded, it
 *    matches the name and not the vocabulary.
 *
 * These are matched against the RAW line, so the patterns are written in raw
 * script — a folded pattern would match nothing, since the folded spelling
 * (Latin letters around a Greek one) appears in no real file.
 */
const DENY_PATTERNS = LOCAL_DENYLIST.patterns
  .map((src) => {
    try {
      // Flags, both load-bearing:
      //   no `g` — these are membership tests, and a sticky lastIndex across two
      //            .test() calls on the same regex object is a classic silent miss.
      //   `u`    — the short-token patterns use \p{L} lookarounds, which are a
      //            syntax error without it. JS \b is ASCII-only and cannot
      //            express a boundary next to a Greek letter.
      return { src, re: new RegExp(src, 'iu') };
    } catch (err) {
      // Hard-fail. Dropping an uncompilable pattern would silently disable one
      // value's only check while the run still reports "clean" — the same
      // failure shape as the muzzled iban/rf patterns that made a canary planting
      // the real leaked IBAN pass for as long as those patterns existed.
      process.stderr.write(
        `\n  ! scan-pii: denylist pattern does not compile: ${src}\n` +
          `    ${err.message}\n` +
          `    Refusing to run with a check silently disabled.\n\n`
      );
      process.exit(1);
    }
  })
  .filter(Boolean);

/**
 * CREDENTIALS — the class this guard was structurally blind to until 2026-08-01.
 *
 * Everything above matches PII: names, tax IDs, IBANs, bill identifiers. That is
 * what the denylist holds, so that is all the guard could ever see. The
 * consequence, on the record: through a two-day scrub every scan of this repo
 * truthfully reported "0 PII remaining" while a WORKING production login sat in
 * `.kiro/steering/test-running-guide.md` and three e2e specs, and the sms-gate
 * account sat hardcoded as a react-hook-form fallback in ThirdPartiesForm.js.
 * A scanner cannot report what its denylist has no word for, and "clean" from a
 * scanner with a category-shaped hole reads exactly like "clean".
 *
 * Two passes, because the failure had two halves:
 *
 *  1. LITERAL — every value in `.secrets/` is matched exactly. This is the pass
 *     that would have caught both leaks on the commit that introduced them.
 *  2. STRUCTURAL — a high-entropy literal assigned to a credential-shaped key,
 *     which catches a NEW secret that is not in `.secrets/` yet (the sms-gate
 *     password was hardcoded in a component before it was ever written down).
 *
 * `.secrets/` is gitignored and local-only, so this is the same "the guard reads
 * a private file the repo never carries" arrangement as FORBIDDEN_TOKENS, for
 * the same reason: writing the values into a public script would republish them.
 * The structural pass needs no local file and keeps working in a fresh clone.
 */
const LOCAL_SECRETS_DIR = path.join(REPO, '.secrets');

/**
 * Values that are public BY DESIGN and must never become needles.
 *
 * `base.env` is committed and ships upstream's placeholders —
 * `change_this_access_token_secret`, `gmail_password`, `mongodb://mongo/mredb`.
 * A local `.env` that never overrode them holds those same strings, so
 * harvesting `.env` naively turns three upstream defaults into "leaked
 * secrets" and buries the two real ones in noise. That is not hypothetical:
 * it is exactly the false-positive set the first credential scan produced.
 *
 * So: anything literally present in the committed base.env is a public default,
 * not a secret. Read it from the INDEX/HEAD rather than the worktree — the
 * worktree copy may hold real values a developer typed in locally.
 */
function committedPublicDefaults() {
  for (const rev of [':base.env', 'HEAD:base.env']) {
    try {
      return execFileSync('git', ['show', rev], {
        encoding: 'utf8',
        cwd: REPO,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      /* try the next rev */
    }
  }
  return '';
}

/** A value that grants nothing: placeholder, env reference, URL, or boolean. */
function isNonSecretValue(value) {
  if (
    /^(true|false|null|undefined|localhost|production|development)$/i.test(
      value
    )
  )
    return true;
  if (/^[0-9]+$/.test(value)) return true;
  // Upstream/scaffold placeholders. These are meant to be published.
  if (
    /^(change_?this|change_?me|your_?|example|placeholder|sample|dummy|redacted|xxx+|\*+|<.*>)/i.test(
      value
    )
  )
    return true;
  if (/(_here|_goes_here|password_here)$/i.test(value)) return true;
  // Env indirection and template holes are the CORRECT pattern, never a leak.
  if (/^\$\{|^\$[A-Z_]|process\.env|^%[A-Z_]+%$/.test(value)) return true;
  // Bare URLs, hostnames and connection strings are topology, not credentials.
  // A credential EMBEDDED in a URL is caught by the literal pass on its own
  // value, so skipping the whole URL here does not lose it.
  if (
    /^(https?|mongodb(\+srv)?|redis|amqp|postgres(ql)?|mysql|smtp|ws{1,2}):\/\//i.test(
      value
    )
  )
    return true;
  if (/^[a-z0-9.-]+\.(com|org|net|io|gr|dev|app|local)$/i.test(value))
    return true;
  if (/^\.?\/|^[A-Za-z]:\\/.test(value)) return true; // filesystem paths
  return false;
}

/**
 * Harvest the real credential values from `.secrets/`.
 *
 * Only CREDENTIAL files are read. The first version of this harvest globbed the
 * whole directory including the `.js` helper scripts that live there, which
 * turned ordinary code tokens — `MicroRealEstate`, a source filename, the word
 * `username` — into needles and produced a confident, entirely false "your
 * secrets are public" report. Helpers are code; code is not a credential file.
 */
function loadLocalCredentials() {
  if (!existsSync(LOCAL_SECRETS_DIR)) {
    process.stderr.write(
      `\n  ! scan-pii: no .secrets/ directory\n` +
        `    Structural credential detection is ACTIVE.\n` +
        `    Literal matching against your real credentials is OFF.\n\n`
    );
    return [];
  }

  const publicDefaults = committedPublicDefaults();
  const out = [];
  const seen = new Set();

  const consider = (label, key, rawValue) => {
    const value = String(rawValue)
      .trim()
      .replace(/\s+#.*$/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    if (!value || value.length < 6 || value.length > 512) return;
    if (isNonSecretValue(value)) return;
    // Public by design — see committedPublicDefaults().
    if (publicDefaults.includes(value)) return;
    // Short values collide with ordinary text, so require the KEY to name a
    // credential before trusting a sub-10-character needle. `CLOUD_USERNAME`
    // qualifies (that is the 6-char sms-gate account name); a 6-char
    // `ORG_NAME` or `REALM` does not, and those two are precisely the needles
    // that generated 3,017- and 122-blob false-positive storms when the first
    // harvest trusted length alone.
    const keyNamesACredential =
      /(PASS|PASSWD|PWD|SECRET|TOKEN|KEY|CRED|AUTH|USERNAME|USER_?NAME|EMAIL|LOGIN|ACCOUNT|APIKEY|BOT|SESSION|COOKIE|SALT|CIPHER|PRIVATE|REALM_ID)/i.test(
        key
      );
    if (value.length < 10 && !keyNamesACredential) return;
    // PUBLIC IDENTIFIERS. Some fields in a credential file are not credentials:
    // a bot's @handle, a bucket name, a cloud project id, a test-realm display
    // name. They grant nothing on their own, they are MEANT to appear in the
    // setup docs that tell you which resource to configure, and they are ≥10
    // characters so the length rule above cannot filter them.
    //
    // Left as needles they made the guard cry wolf on 12 of 13 findings in one
    // run — and a guard that cries wolf gets bypassed with PII_SCAN_SKIP by
    // reflex, which is exactly how the one REAL finding in that run (an
    // sms-gate account name printed inline in a tracked doc) would have sailed
    // through. Precision here is a security property, not a convenience.
    //
    // Deliberately NOT exempted: anything matching the credential-key regex
    // above. `BOT_USERNAME` is a public @handle, but `BOT_TOKEN` is the secret,
    // and `CLOUD_USERNAME` stays a needle because half a credential pair is
    // still worth withholding.
    const keyIsPublicIdentifier =
      /^(BOT_USERNAME|PROJECT_ID|BUCKET|BUCKET_ID|ENDPOINT|ORG_NAME|REALM|REALM_NAME|LOCALE|CURRENCY|FROM|REPLY_?TO|URL|HOST|PORT|COUNTRY_?CODE)$/i.test(
        key
      );
    if (keyIsPublicIdentifier) return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ label: `${label}:${key}`, value, key });
  };

  let files;
  try {
    files = readdirSync(LOCAL_SECRETS_DIR);
  } catch {
    return [];
  }

  for (const name of files) {
    // Helpers, notes, fixtures and binaries are not credential files.
    if (
      /\.(js|mjs|cjs|ts|tsx|json|md|txt|png|jpe?g|gif|pdf|zip|sh|py|log|html?)$/i.test(
        name
      )
    ) {
      continue;
    }
    const abs = path.join(LOCAL_SECRETS_DIR, name);
    let text;
    try {
      if (!statSync(abs).isFile() || statSync(abs).size > 1024 * 1024) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const kv = line.match(
        /^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/
      );
      if (kv) {
        consider(name, kv[1], kv[2]);
        continue;
      }
      // Token-only files (an API key alone on a line, no key= prefix).
      const bare = line.trim();
      if (/^[A-Za-z0-9_\-./+=:]{20,}$/.test(bare))
        consider(name, '(bare)', bare);
    }
  }

  return out;
}

const LOCAL_CREDENTIALS = loadLocalCredentials();

/**
 * Character-class variety, as a cheap stand-in for entropy.
 *
 * Used only by the STRUCTURAL pass, to separate `password: 'hunter2'` in a
 * fixture from a real 14-character account password. The literal pass needs no
 * such test — it already knows the exact value.
 */
function looksHighEntropy(value) {
  const classes =
    (/[a-z]/.test(value) ? 1 : 0) +
    (/[A-Z]/.test(value) ? 1 : 0) +
    (/[0-9]/.test(value) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(value) ? 1 : 0);
  if (value.length >= 24 && classes >= 2) return true;
  if (value.length >= 12 && classes >= 3) return true;
  // A long single-class run (hex key, base32 token) is still a credential.
  if (value.length >= 32 && /^[A-Za-z0-9]+$/.test(value)) return true;
  return false;
}

const PATTERNS = [
  {
    id: 'hardcoded-credential',
    /**
     * A high-entropy literal assigned to a credential-shaped key.
     *
     * Deliberately conservative. This file's own history is a catalogue of
     * guards that got bypassed by reflex once they cried wolf, so the accept
     * test demands real entropy and rejects the fixture vocabulary rather than
     * flagging every `password:` in the test suite. It is the backstop; the
     * literal pass over `.secrets/` is the primary check.
     *
     * The `||` case is here by name because that is the exact shape that
     * published the sms-gate account:
     *     smsUsername: organization.thirdParties?.smsGateway?.username || '<the real account name>',
     * A react-hook-form default is not obviously a secret when you are reading
     * a form component, which is why a machine has to be the one looking.
     */
    re: /(?:pass(?:word|wd)?|pwd|secret|token|api_?key|access_?key|private_?key|credential|bot_?token|cipher_?key)["'\]]?\s*(?:[:=]|=>|\|\|)\s*["'`]([^"'`\s]{8,200})["'`]/gi,
    extract: (m) => m.match(/["'`]([^"'`\s]{8,200})["'`]\s*$/)?.[1] ?? m,
    accept: (m) => {
      const v = m.match(/["'`]([^"'`\s]{8,200})["'`]\s*$/)?.[1];
      if (!v) return false;
      if (isNonSecretValue(v)) return false;
      // Fixture vocabulary. A real credential is not the word "password".
      if (
        /^(pass(word)?|secret|token|test|demo|foo|bar|baz|qwerty|admin|hunter2|letmein|abc+|123+|0+)$/i.test(
          v
        )
      )
        return false;
      if (/^(test|demo|fake|mock|stub|fixture|seed|e2e)[-_@.]/i.test(v))
        return false;
      // A hash/encoded blob in a fixture is not a live credential. bcrypt and
      // JWT shapes are the two that actually occur in this repo's tests.
      if (/^\$2[aby]\$[0-9]{2}\$/.test(v)) return false;
      if (/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(v)) return false;
      // A LOCALE TRANSLATION PAIR is a label, not an assignment. next-translate
      // JSON maps an English UI string to its translation, so a settings-form
      // label whose text happens to contain the word secret/token/password
      // matches the credential-key regex above with a "value" that is just the
      // same words in another language. Three such labels in the de-DE file
      // fired on a commit whose only real finding was elsewhere — and 3-of-4
      // noise is how a guard trains you to reach for PII_SCAN_SKIP.
      //
      // Detected STRUCTURALLY (quoted spaced-words, colon, quoted text), NOT by
      // exempting locale paths. That distinction is the point: a real credential
      // pasted into a locale file is still caught, because a credential is not
      // spaced English words on the left of the colon. Verified by positive
      // control — a real password planted under a `password` key in a .json
      // still blocks the commit.
      //
      // No example pair is spelled out here on purpose: this file is scanned
      // like any other, so an illustrative pair in a comment is itself a match.
      // The first version of this comment blocked its own commit.
      // `m` is only the tail from the keyword onward (the rule's `re` starts at
      // pass|secret|token…), so the pair must be recognised on that tail: a
      // quote, colon, then a quoted value made of letters/spaces/hyphens only.
      // A credential has digits or symbols; a UI label does not.
      if (/^[a-z_]*["']\s*:\s*["'][\p{L} .\-]+["']$/iu.test(m.trim())) {
        return false;
      }
      return looksHighEntropy(v);
    },
    describe: 'high-entropy literal assigned to a credential-shaped key'
  },
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
    // Skip anything that looks binary — but only on the evidence git itself
    // uses: a NUL byte within the first 8 KiB.
    //
    // This test used to read the WHOLE file, which exempted any source file that
    // so much as MENTIONS a NUL. The worked example is this very file: the line
    // below contains a NUL literal, so scan-pii.mjs classified ITSELF as binary
    // and skipped its own content — silently. Planting a real surname in it
    // raised nothing. A text file's NUL sits deep in its prose; a real binary's
    // sits in the header, which is why the window matters.
    if (content.slice(0, 8192).includes('\u0000')) continue;

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
      // spelled as escape sequences is still a published name: one real place
      // name survived an entire scrub as \uXXXX escapes in an e9parser comment.
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
      // identifiers. This is what catches the group-spaced writings of a real
      // IBAN and a real ΕΥΔΑΠ document number — forms that the regexes above and
      // three rounds of literal-string grep all walked straight past.
      const stream = digitStream(text);
      if (stream.length >= 6) {
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

      // LITERAL CREDENTIAL pass. Exact match against the real values in
      // `.secrets/`. This is the pass that would have blocked the production
      // landlord login and the sms-gate account on the commit that introduced
      // them, instead of two days later from an orphaned-commit audit.
      //
      // Matched case-SENSITIVELY and unfolded, unlike the identity tokens: a
      // credential is only that credential at its exact bytes, and folding would
      // invent collisions between a 6-character account name and ordinary words.
      // The \uXXXX-decoded form is checked too — a secret can be escaped on its
      // way into a JSON or JS literal just as a name can.
      for (const cred of LOCAL_CREDENTIALS) {
        if (
          text.includes(cred.value) ||
          (decoded !== null && decoded.includes(cred.value))
        ) {
          violations.push({
            file,
            line: i + 1,
            id: 'real-credential',
            detail: `LIVE CREDENTIAL from .secrets/${cred.label} (${cred.value.length}ch, ${mask(cred.value)}) — rotate it if this was ever pushed`
          });
        }
      }

      // Word-bounded denylist patterns: real postcodes, and Latin tokens that
      // occur inside checksums. Run against the RAW line (bounded, so a hash
      // interior cannot match) and its \uXXXX-decoded form.
      for (const { src, re } of DENY_PATTERNS) {
        const hit = re.test(text) || (decoded !== null && re.test(decoded));
        if (hit) {
          violations.push({
            file,
            line: i + 1,
            id: 'real-identity-pattern',
            detail: `real postcode/identifier matching ${src}`
          });
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
console.error(
  '    · names/addresses → E2E-* or ΟΔΟΣ ΔΟΚΙΜΗΣ style placeholders'
);
console.error(
  '    · tax IDs → the reserved synthetic band 9990000xx (checksum-valid,'
);
console.error('      so parser tests still exercise the real validation path)');
console.error('    · scanned documents → keep them OUTSIDE the repo entirely');
console.error('');
console.error(
  '  Deliberate override (you are publishing this):  PII_SCAN_SKIP=1 git commit …'
);
console.error('');
process.exit(1);
