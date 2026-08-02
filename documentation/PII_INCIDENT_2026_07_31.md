# PII exposure — 2026-07-31 (public repository)

> Written by the agent that caused it. Kept in the repo because the next agent to work here needs
> to know that this repository is public, that real family data has been committed to it before,
> and what the guards in `scripts/scan-pii.mjs` + `scripts/scan-push.mjs` are defending against.
>
> **This file deliberately contains no unmasked personal data or credential values.**
>
> **Corrected 2026-08-02.** Two claims in the original version of this file were wrong, and both
> were wrong in the same direction — asserting *absence* from a check that could not have proven it.
> See "Corrections" at the end. If you are reading this file to learn one thing, learn that: a scan
> that reports nothing is only as trustworthy as its coverage, and the burden is on you to show the
> coverage was real.

## What happened

At 23:00:53 EEST the agent ran `git add -A` instead of staging named files. That swept the scratch
directory `.scratch-adv-tests/` into commit `dded622e` and pushed it to `origin/nas`. The repository
is public (`"visibility": "public"`, 0 forks, 0 stars).

The commit contained a **real ΔΕΗ electricity bill PDF** (7 MB) plus its full OCR text — the account
holder's name, the provision number, amounts and dates.

At 23:04 the agent noticed, rebuilt the commit as `f6972d06` with 5 explicitly-named files, and
force-pushed at 23:06. Exposure window for the branch tip: **~3 minutes**.

## What the force-push did NOT fix

1. **The old commit object survives.** `dded622e` is unreachable from any ref but still served:
   `api.github.com/repos/<owner>/<repo>/commits/dded622e` returns **200** (re-verified 2026-08-02,
   two days later). Any object can also be fetched by SHA via
   `/git/blobs/<sha>` regardless of reachability. GitHub does not garbage-collect unreachable
   objects on demand and exposes no API to force it.

   This SHA is a *pre-rewrite* one and deliberately left un-translated here: it names an object that
   only ever existed on the published remote. Every other SHA in this repository's docs was
   re-pointed after `git filter-repo` rewrote them; this one has no successor by design.

2. **The SHA is published, not secret.** It appears twice in the repository's own public events
   feed (`/repos/{owner}/{repo}/events`) — once as the `head` of the original push, once as the
   `before` of the force-push. Anyone can read that feed unauthenticated, so "nobody knows the SHA"
   was never true. Events age out after roughly 90 days / 300 events.

3. **A much larger pre-existing exposure was already there.** Tonight's accident was the *smaller*
   half. A sweep found real personal data across ~20 tracked files and 18 commits reaching back to
   the first Greek-PDF import work — committed gradually as illustrative examples in code comments,
   UI mockups, audit documents, jest fixtures and Playwright specs. Classes involved:

   | Class | Where it lived |
   |---|---|
   | Family surnames + given names | code comments, mockups, audit docs, fixtures, specs |
   | Greek tax IDs (ΑΦΜ) | HTML mockups, jest fixtures, E9/lease parser tests, specs |
   | Real property street addresses | code comments, mockups, docs, parser tests |
   | Utility provision number + bill serials | bill-identity code comments and its test |
   | Scanned documents (bill PDF, OCR text) | the orphaned commit only |

   The single worst line was an HTML mockup that printed a named individual and their tax ID in the
   same sentence.

## Credentials — a live one IS exposed

The original version of this file claimed "**No credentials, ever**", citing
`git log --all -- '.secrets/*'` returning 0 commits. That command is still true and still
irrelevant: it proves the `.secrets/` **directory** was never committed. It says nothing about a
credential *value* pasted into application code. That is exactly what happened.

**Confirmed exposed (verified 2026-08-02, four independent ways):**

| | |
|---|---|
| Credential | sms-gate.app **Cloud** account — username + password |
| How | hardcoded as a Next.js `defaultValue` in `webapps/landlord/src/components/organization/ThirdPartiesForm.js` |
| Introduced | 2026-04-20, commit `94a5c6bb` "feat: SMS Gateway integration via sms-gate.app" |
| Reachability | `94a5c6bb` is an **ancestor of `origin/nas` AND `origin/master`** — not an orphan |
| Also pinned by | `refs/pull/1/head` (`36f94570`), which is server-owned and read-only |
| Blob | `5a078831740ec82b73458f6ede21cbf2ffd019ef`, anonymously fetchable: **http 200**, 14693 bytes, both values present |
| Exposure window | ~3.5 months, and **still open** |

A Next.js `defaultValue` compiles into the **client bundle**, so the credential was additionally
served to every browser that opened the settings page — not merely present in git.

Two properties make this unfixable by rewriting:

1. The same blob is pinned by `refs/pull/1/head`. That ref is server-owned and read-only; you cannot
   delete or rewrite it, and GitHub Support cannot purge it either.
2. GitHub serves any object by SHA whether or not a ref reaches it.

**ROTATION IS THE ONLY REMEDY.** Rewriting history, deleting branches, or making the repo private do
not retract a value that has already been served. As of this writing rotation has **not** been
authorized by the owner, so this credential must be treated as public.

The branch *tips* are clean — one carrier commit, one blob. A full-tree sweep of all 19,738 objects
reachable from `origin/nas` found 10 needles present; the other 9 are non-secret (service URLs,
bucket names, a bot username, test-realm names, a GCP project ID).

## What was NOT exposed

Verified, not assumed:

- **No fork copied the objects.** 0 forks, `network_count: 0` — objects in a fork network survive
  GC, so this matters.
- **No other credential value.** The sweep above covers every value under `.secrets/`, matched
  literally against the full tree of every reachable commit — not against diffs. See "Corrections".

## Evidence of access

- 14-day traffic: 603 clones / 57 uniques, but **0 clones on the three days around the incident**.
  Every clone-heavy day matches CI activity at ~11–22 clones per Actions run (the runner fleet).
- Human page views over the same window: **10, from 3 uniques, all before the incident**.
- No evidence anyone fetched the bill. This cannot be proven either way — GitHub provides no
  per-object fetch log.

## Why `.gitignore` was not a defence

The ignore rules for `.scratch-adv-tests/` were written *after* the accident. More fundamentally:

- `.gitignore` prevents *accidental pickup*; it does not prevent `git add -f`, and it does nothing
  about data already tracked.
- Adding a path to `.gitignore` **does not untrack it**. Four mockup files stayed tracked, and kept
  serving a real tax ID publicly, despite a matching ignore rule.
- 18 underscore-prefixed scratch directories under `e2e-playwright/` holding **151 screenshots of
  the live production realm** were untracked *and unignored* — one `add -A` from publication.

## The guards

There are two, and the split matters — the first one cannot see the failure that caused the
credential exposure above.

### `scripts/scan-pii.mjs` — pre-commit, scans the STAGING AREA

Wired into `.husky/pre-commit` ahead of `yarn lint`.

It scans **staged content** (`git show :<file>`), so it judges what would actually be committed
rather than what happens to be in the worktree. `--all` sweeps every tracked file instead.

Because it reads the staging area, it can only ever see content being written *right now*. It is
structurally incapable of stopping `git push origin <branch-whose-commits-already-exist>`.

### `scripts/scan-push.mjs` — pre-push, scans commit TREES

Wired into `.husky/pre-push`. This exists because of the sms-gate credential: several branches
carried `94a5c6bb` for months, and no pre-commit hook can stop a push of a commit that is already
written.

It walks the full **TREE** of every commit in the push range, not the diff. That distinction is the
root cause of the whole 3.5-month miss: a secret introduced in commit A and still present at commit
Z appears in **A's diff only**, yet Z's tree still serves it. Every earlier audit of this incident
examined diffs and reported clean. Blobs are deduped, so a file unchanged across 200 commits is read
once.

Two traps it is built to avoid, both of which produced confidently-false clean reports before:

- `git cat-file --batch` reports **byte** counts. The stream must be parsed as a `Buffer` with each
  body decoded separately. Slicing a UTF-8-decoded string by those offsets desyncs the parser on the
  first multibyte (Greek) blob — that bug made one pass read 12 of 7,659 objects and call it success.
- **git silently ignores a non-executable hook.** It prints a `hint:` and pushes anyway. A mode-644
  copy of `.husky/pre-push` is indistinguishable from having no guard. It is committed `100755`;
  verify with `git push --dry-run origin <a branch known to carry a secret>` → must exit 1.

Detects:

- **Greek tax IDs** structurally, via the mod-11 check digit — not by matching known values, so a
  *new* real tax ID is caught too. Synthetic fixtures live in a reserved `9990000xx` band that is
  checksum-valid on purpose (the parsers validate the check digit, so a bogus-checksum fixture would
  not exercise the real code path — meaning the checksum alone cannot separate real from fake).
- **Labelled tax IDs** regardless of checksum. A real ΑΦΜ mistyped when copied off a screenshot
  fails the check digit but is still that person's tax number; the repo shipped exactly one such
  value, and a purely structural test missed it.
- **Real identity tokens** — the specific surnames and street names that leaked.
- **Utility provision numbers, RF payment codes, IBANs, Greek mobile numbers.**
- **Real-world documents by extension** (`.pdf`, `.png`, `.xlsx`, …) outside known product-asset
  directories. This is what catches a repeat of tonight: a bill PDF is a violation by *existence*,
  no content parsing needed.

Precision work that mattered — a guard that cries wolf gets bypassed by reflex:

- Lockfiles are skipped, and hash-like runs (≥24 hex chars, long base64) are blanked before numeric
  matching. Any 9 consecutive digits inside a SHA-512 satisfies the ΑΦΜ check digit about 1 time in
  11; the first run produced 60+ false positives in `yarn.lock` alone.
- Fixture phone numbers (`69` followed by a run of zeros) are excluded.
- Product assets (UI logos, upstream doc screenshots) are not treated as scanned paperwork.

Verified against the real thing: staging the exact PDF that leaked — with `git add -f`, defeating
`.gitignore` — is blocked. Bypass is `PII_SCAN_SKIP=1`, documented on purpose: a guard nobody can
override gets deleted the first time it is wrong, and then there is no guard at all.

## Residual risk that code cannot fix

- **The live sms-gate credential.** Pinned by `refs/pull/1/head` as well as reachable from
  `origin/nas`. Not removable by any rewrite, and not by Support. **Rotation only** — see above.
- The unreachable commit's objects remain fetchable until GitHub garbage-collects them; no API and no
  local command reaches server-side unreachable objects. Note that `refs/pull/N/head` refs mean
  "unreachable from a branch" is not the same as "unreachable" — a PR ref pins objects permanently.
- Scrubbing files at HEAD does not remove data from the 18 historical commits. Removing it from
  history requires `git filter-repo` + force-push, which rewrites every SHA on the branch. Note the
  ordering hazard: CI tags images `:nas-<sha>` and the deploy verifies a container revision label,
  so a rewrite must not orphan the SHA production is currently running.
- Any third-party mirror, cache, or code-search index that fetched the repo while the data was
  present is outside the owner's control.

## Rules for any agent working in this repository

1. **This repository is PUBLIC.** Treat every commit as a publication, and every push as
   irreversible. GitHub keeps objects fetchable by SHA after a force-push, and a `refs/pull/N/head`
   ref pins them permanently.
2. **Never `git add -A` / `git add .`** Stage explicit paths. This incident is what that command
   costs.
3. **Never put real data in a fixture, mockup, comment, or spec.** Use synthetic values — the
   `9990000xx` tax-ID band and `ΟΔΟΣ ΑΛΦΑ/ΒΗΤΑ/ΓΑΜΑ` street placeholders exist for this.
4. **Real documents (bills, contracts, E9 statements) stay outside the repository.**
5. **Never hardcode a credential as a form default.** A `defaultValue` in a Next.js component ships
   in the client bundle. Read config from `realm.thirdParties` (encrypted at rest) or env.
6. **Never bypass either guard** to make a commit or push go through.
7. **Review the TREE, not the diff.** When asked whether a secret is present, the question is "does
   any reachable commit's tree contain it", not "does any diff add it". These give different answers,
   and the diff answer is the one that was wrong here for 3.5 months.
8. **Never report absence you have not measured.** See "Corrections" — both errors in this file were
   claims that something was *not* there, from checks that could not have shown it.

## Corrections

Both original errors asserted absence. Recording them because the shape recurs:

1. **"No credentials, ever."** Evidence given: `git log --all -- '.secrets/*'` → 0 commits. That
   proves the directory was never committed; it cannot detect a credential *value* pasted into
   application code, which is what happened. **A live credential was, and still is, exposed.**

2. **"Orphaned commits — only GitHub Support can purge those."** Wrong twice. The sms-gate carrier is
   not an orphan (it is an ancestor of two published branches), and the objects are pinned by
   `refs/pull/1/head`, which Support cannot remove. The remedy is rotation, not a Support ticket.

An earlier scan of mine also reported this credential as `inOriginNow=0`. That figure was computed
against a stale ref set. When a scan reports zero, verify what it actually enumerated before
believing it.
