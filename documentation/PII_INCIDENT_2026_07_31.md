# PII exposure — 2026-07-31 (public repository)

> Written by the agent that caused it. Kept in the repo because the next agent to work here needs
> to know that this repository is public, that real family data has been committed to it before,
> and what the guard in `scripts/scan-pii.mjs` is defending against.
>
> **This file deliberately contains no unmasked personal data.**

## What happened

At 23:00:53 EEST the agent ran `git add -A` instead of staging named files. That swept the scratch
directory `.scratch-adv-tests/` into commit `dded622e` and pushed it to `origin/nas`. The repository
is public (`"visibility": "public"`, 0 forks, 0 stars).

The commit contained a **real ΔΕΗ electricity bill PDF** (7 MB) plus its full OCR text — the account
holder's name, the provision number, amounts and dates.

At 23:04 the agent noticed, rebuilt the commit as `8f10fb5c` with 5 explicitly-named files, and
force-pushed at 23:06. Exposure window for the branch tip: **~3 minutes**.

## What the force-push did NOT fix

1. **The old commit object survives.** `dded622e` is unreachable from any ref but still served:
   `raw.githubusercontent.com/<owner>/<repo>/dded622e/...` returns **200**. GitHub does not
   garbage-collect unreachable objects on demand and exposes no API to force it; the documented
   remedy is a Support request.

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

## What was NOT exposed

Verified, not assumed:

- **No credentials, ever.** `.secrets/` has **0 commits across all history**
  (`git log --all -- '.secrets/*'`). No tokens, keys, or passwords in any tracked file.
- **No fork copied the objects.** 0 forks, `network_count: 0` — objects in a fork network survive
  GC, so this matters.

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

## The guard

`scripts/scan-pii.mjs`, wired into `.husky/pre-commit` ahead of `yarn lint`.

It scans **staged content** (`git show :<file>`), so it judges what would actually be committed
rather than what happens to be in the worktree. `--all` sweeps every tracked file instead.

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

- The orphaned commit's objects remain fetchable until GitHub garbage-collects them. **Requires a
  Support request** — no API, no local command reaches server-side unreachable objects.
- Scrubbing files at HEAD does not remove data from the 18 historical commits. Removing it from
  history requires `git filter-repo` + force-push, which rewrites every SHA on the branch. Note the
  ordering hazard: CI tags images `:nas-<sha>` and the deploy verifies a container revision label,
  so a rewrite must not orphan the SHA production is currently running.
- Any third-party mirror, cache, or code-search index that fetched the repo while the data was
  present is outside the owner's control.

## Rules for any agent working in this repository

1. **This repository is PUBLIC.** Treat every commit as a publication.
2. **Never `git add -A` / `git add .`** Stage explicit paths. This incident is what that command
   costs.
3. **Never put real data in a fixture, mockup, comment, or spec.** Use synthetic values — the
   `9990000xx` tax-ID band and `ΟΔΟΣ ΑΛΦΑ/ΒΗΤΑ/ΓΑΜΑ` street placeholders exist for this.
4. **Real documents (bills, contracts, E9 statements) stay outside the repository.**
5. **Never bypass the PII guard** to make a commit go through.
