#!/usr/bin/env node
/**
 * PRE-PUSH GUARD — scan the commits actually being published.
 *
 * Why this exists, specifically:
 *
 * `scripts/scan-pii.mjs` runs pre-commit and reads the STAGING AREA. It can only
 * see content being written right now, so it is structurally incapable of
 * stopping the thing that published this repo's secrets — a push of commits that
 * were made before the guard existed. In April 2026 a live sms-gate.app
 * credential was hardcoded as a Next.js `defaultValue` in ThirdPartiesForm.js;
 * several branches then carried that commit for months. A pre-commit hook cannot
 * stop `git push origin <such a branch>` — the commits are already written. Only
 * a pre-push hook can. See documentation/PII_INCIDENT_2026_07_31.md.
 *
 * WHAT IT SCANS — and why it is the TREE, not the diff.
 *
 * Every earlier audit of this incident examined commit DIFFS and reported clean.
 * A secret introduced in commit A and still present at commit Z appears in the
 * diff of A alone; Z merely carries it. Push Z and you publish it. So this scans
 * the full TREE of each commit being pushed, then dedupes by blob so a file that
 * is unchanged across 200 commits is read once.
 *
 * Git passes ref updates on stdin as:  <local ref> <local sha> <remote ref> <remote sha>
 * A remote sha of all-zeros means the branch is new to the remote, so its entire
 * history is being published — that case gets `--not --remotes`, not a range.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8'
}).trim();

const ZERO = /^0{40,}$/;

/** Ref updates from stdin. Empty stdin (manual run) → scan nothing, exit clean. */
function refUpdates() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line
        .trim()
        .split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter((u) => u.localSha && !ZERO.test(u.localSha)); // deletions publish nothing
}

/**
 * Commits this push would add to the remote.
 *
 * For an existing branch that is `remoteSha..localSha`. For a NEW branch the
 * remote has no tip, so the honest question is "what does this branch contain
 * that the remote does not already have anywhere" — hence `--not --remotes`.
 * Using the full history instead would rescan the entire repo on every new
 * branch and get itself disabled for being slow.
 */
function commitsBeingPushed(update) {
  const args = ['rev-list'];
  if (update.remoteSha && !ZERO.test(update.remoteSha)) {
    args.push(`${update.remoteSha}..${update.localSha}`);
  } else {
    args.push(update.localSha, '--not', '--remotes');
  }
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      cwd: REPO,
      maxBuffer: 64 * 1024 * 1024
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Needles. Same source and same exclusions as scan-pii.mjs — see the long
// comment there for why `.js`/`.md`/`.sh` files in `.secrets/` are skipped (a
// harvest that included the helper scripts turned ordinary code tokens into
// needles and produced a confidently false "your secrets are public" report).
// ---------------------------------------------------------------------------
const SECRETS_DIR = path.join(REPO, '.secrets');

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
      /* next */
    }
  }
  return '';
}

function isNonSecretValue(value) {
  if (
    /^(true|false|null|undefined|localhost|production|development)$/i.test(
      value
    )
  )
    return true;
  if (/^[0-9]+$/.test(value)) return true;
  if (
    /^(change_?this|change_?me|your_?|example|placeholder|sample|dummy|redacted|xxx+|\*+|<.*>)/i.test(
      value
    )
  )
    return true;
  if (/(_here|_goes_here|password_here)$/i.test(value)) return true;
  if (/^\$\{|^\$[A-Z_]|process\.env|^%[A-Z_]+%$/.test(value)) return true;
  if (
    /^(https?|mongodb(\+srv)?|redis|amqp|postgres(ql)?|mysql|smtp|ws{1,2}):\/\//i.test(
      value
    )
  )
    return true;
  if (/^[a-z0-9.-]+\.(com|org|net|io|gr|dev|app|local)$/i.test(value))
    return true;
  if (/^\.?\/|^[A-Za-z]:\\/.test(value)) return true;
  return false;
}

function loadNeedles() {
  if (!existsSync(SECRETS_DIR)) return [];
  const publicDefaults = committedPublicDefaults();
  const out = [];
  const seen = new Set();

  const consider = (file, key, rawValue) => {
    const value = String(rawValue)
      .trim()
      .replace(/\s+#.*$/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    if (!value || value.length < 6 || value.length > 512) return;
    if (isNonSecretValue(value)) return;
    if (publicDefaults.includes(value)) return;
    const keyNamesACredential =
      /(PASS|PASSWD|PWD|SECRET|TOKEN|KEY|CRED|AUTH|USERNAME|USER_?NAME|EMAIL|LOGIN|ACCOUNT|APIKEY|BOT|SESSION|COOKIE|SALT|CIPHER|PRIVATE|REALM_ID)/i.test(
        key
      );
    if (value.length < 10 && !keyNamesACredential) return;
    // PUBLIC IDENTIFIERS — must match scan-pii.mjs's list exactly.
    //
    // Some fields in a credential file are not credentials: a bot's public
    // @handle, a bucket name, a cloud project id, a test-realm display name.
    // They grant nothing alone, they are MEANT to appear in setup docs and in
    // the ~30 e2e specs that scope writes to the test realm by name, and they
    // are >=10 chars so the length rule above cannot filter them.
    //
    // This exemption was added to scan-pii.mjs (the pre-COMMIT hook) on
    // 2026-08-02 but NOT here, so the pre-PUSH hook kept reporting them: 5 of
    // its 6 findings on the very next push were this class. A guard that is
    // 83% noise is a guard that gets bypassed with PII_SCAN_SKIP by reflex,
    // and the 6th finding on that run was real. Precision is a security
    // property — keep the two loaders in sync.
    //
    // Deliberately NOT exempted: anything matching the credential-key regex
    // above. BOT_USERNAME is a public @handle but BOT_TOKEN is the secret, and
    // CLOUD_USERNAME stays a needle because half a credential pair is still
    // worth withholding.
    const keyIsPublicIdentifier =
      /^(BOT_USERNAME|PROJECT_ID|BUCKET|BUCKET_ID|ENDPOINT|ORG_NAME|REALM|REALM_NAME|LOCALE|CURRENCY|FROM|REPLY_?TO|URL|HOST|PORT|COUNTRY_?CODE)$/i.test(
        key
      );
    if (keyIsPublicIdentifier) return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ label: `${file}:${key}`, value });
  };

  let files;
  try {
    files = readdirSync(SECRETS_DIR);
  } catch {
    return [];
  }
  for (const name of files) {
    if (
      /\.(js|mjs|cjs|ts|tsx|json|md|txt|png|jpe?g|gif|pdf|zip|sh|py|log|html?)$/i.test(
        name
      )
    )
      continue;
    const abs = path.join(SECRETS_DIR, name);
    let text;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > 1024 * 1024) continue;
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
      const bare = line.trim();
      if (/^[A-Za-z0-9_\-./+=:]{20,}$/.test(bare))
        consider(name, '(bare)', bare);
    }
  }
  return out;
}

const NEEDLES = loadNeedles();
const mask = (v) =>
  v.length <= 3 ? '***' : `${v.slice(0, 2)}***${v.slice(-1)}`;

const updates = refUpdates();
if (updates.length === 0 || NEEDLES.length === 0) {
  if (NEEDLES.length === 0) {
    process.stderr.write(
      '\n  ! scan-push: no credential values found under .secrets/ — literal matching is OFF.\n\n'
    );
  }
  process.exit(0);
}

// Collect every (blob, path) pair reachable from the commits being pushed.
// Deduped by blob: an unchanged file across 200 commits is one read, not 200.
const blobPaths = new Map();
const commitOf = new Map();
let commitCount = 0;

for (const update of updates) {
  const commits = commitsBeingPushed(update);
  commitCount += commits.length;
  for (const sha of commits) {
    let listing;
    try {
      listing = execFileSync('git', ['ls-tree', '-r', '-z', sha], {
        encoding: 'utf8',
        cwd: REPO,
        maxBuffer: 256 * 1024 * 1024
      });
    } catch {
      continue;
    }
    for (const entry of listing.split('\0')) {
      if (!entry) continue;
      // <mode> SP <type> SP <sha> TAB <path>
      const m = entry.match(/^\d+ (\w+) ([0-9a-f]{40})\t(.*)$/);
      if (!m || m[1] !== 'blob') continue;
      const [, , blob, file] = m;
      if (
        /\.(png|jpe?g|gif|pdf|zip|woff2?|ttf|eot|ico|mp4|webm|so|dylib|node)$/i.test(
          file
        )
      )
        continue;
      if (!blobPaths.has(blob)) blobPaths.set(blob, new Set());
      blobPaths.get(blob).add(file);
      if (!commitOf.has(blob)) commitOf.set(blob, sha);
    }
  }
}

// Read blobs in bulk. `git cat-file --batch` emits BYTE counts, so the stream is
// parsed as a Buffer and each body decoded individually. Slicing a UTF-8-decoded
// string by those byte offsets desyncs the parser on the first multibyte (Greek)
// blob — that bug made an earlier audit of this very incident read 12 of 7,659
// objects while reporting success.
const violations = [];
const blobs = [...blobPaths.keys()];
const CHUNK = 800;

for (let i = 0; i < blobs.length; i += CHUNK) {
  const batch = blobs.slice(i, i + CHUNK);
  const res = spawnSync('git', ['-C', REPO, 'cat-file', '--batch'], {
    input: batch.join('\n') + '\n',
    maxBuffer: 1024 * 1024 * 1024
  });
  const buf = res.stdout;
  if (!buf) continue;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    if (header[1] !== 'blob') {
      pos = nl + 1;
      continue;
    }
    const sha = header[0];
    const size = parseInt(header[2], 10);
    const body = buf.subarray(nl + 1, nl + 1 + size);
    pos = nl + 1 + size + 1;
    if (!size || size > 8 * 1024 * 1024) continue;
    if (body.subarray(0, 8192).includes(0)) continue; // binary
    const text = body.toString('utf8');
    for (const needle of NEEDLES) {
      if (text.includes(needle.value)) {
        violations.push({
          paths: [...(blobPaths.get(sha) || [])],
          commit: commitOf.get(sha),
          label: needle.label,
          value: needle.value
        });
      }
    }
  }
}

if (violations.length === 0) {
  process.exit(0);
}

console.error('');
console.error(
  '╔══════════════════════════════════════════════════════════════════════╗'
);
console.error(
  '║  PUSH BLOCKED — live credential found in the commits being pushed    ║'
);
console.error(
  '║  This repository is PUBLIC. Pushing is IRREVERSIBLE: GitHub keeps    ║'
);
console.error(
  '║  the object fetchable by SHA even after a force-push, and a PR ref   ║'
);
console.error(
  '║  (refs/pull/N/head) pins it permanently — Support cannot remove it.  ║'
);
console.error(
  '║  Once pushed, ROTATION is the only remedy. Do not push.              ║'
);
console.error(
  '╚══════════════════════════════════════════════════════════════════════╝'
);
console.error('');

const byLabel = new Map();
for (const v of violations) {
  if (!byLabel.has(v.label)) byLabel.set(v.label, []);
  byLabel.get(v.label).push(v);
}
for (const [label, vs] of byLabel) {
  const paths = [...new Set(vs.flatMap((v) => v.paths))];
  console.error(
    `  .secrets/${label}  (${vs[0].value.length}ch, ${mask(vs[0].value)})`
  );
  for (const p of paths.slice(0, 6)) console.error(`      ${p}`);
  if (paths.length > 6)
    console.error(`      … and ${paths.length - 6} more path(s)`);
  console.error(
    `      first seen in commit ${(vs[0].commit || '').slice(0, 12)}`
  );
}

console.error('');
console.error(
  `  ${byLabel.size} credential(s) across ${commitCount} commit(s) being pushed.`
);
console.error('');
console.error(
  '  These commits already exist, so editing your worktree will not help. Either:'
);
console.error(
  '    · drop the branch if the work is superseded  (git branch -D <branch>)'
);
console.error(
  '    · rewrite it before pushing                  (git rebase -i / filter-repo)'
);
console.error(
  '    · rotate the credential and re-run           (it is no longer a secret)'
);
console.error('');
console.error(
  '  Deliberate override (you accept publishing this):  PII_SCAN_SKIP=1 git push …'
);
console.error('');
process.exit(1);
