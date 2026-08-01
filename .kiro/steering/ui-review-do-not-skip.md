---
inclusion: always
---

# UI Review — DO NOT SKIP (read before claiming any UI work is done)

This document exists because the agent repeatedly claimed UI work was "reviewed",
"clean", "verified", or "done" after only checking **API/JSON values** and
**never looking at a single rendered pixel** — and never in the user's actual
language. The user had to say "review for UI slop" more than a dozen times across
a weekend and still opened the app to find raw `{{year}}` template strings, a
black-blob progress bar, clipped columns, banned card grids, inconsistent Greek,
and mismatched buttons. A green Playwright suite asserting numbers is **NOT** a UI
review. This is the rule that breaks that cycle.

## STOP — the five hard rules

1. **You must LOOK at the rendered screen.** Capture a screenshot of every UI
   surface you changed and actually read the image. A test that asserts a JSON
   field or `toBeVisible()` is not looking at the UI. "I reviewed the code / the
   API response" is not a UI review and must never be reported as one.

2. **Review in the realm's ACTUAL locale, which is `el` (Greek).** The default
   render path is English (`/landlord/en/...`); the production realm is Greek
   (`/landlord/el/...`). Reviewing the English render is reviewing a screen the
   user never sees. Force the `/el/` path (see "How to capture" below). Read the
   Greek: wording, grammar, accents, truncation, term consistency
   (Ενοικιαστές vs Ιδιοκτήτες surfaces must use parallel terminology).

3. **The word "clean" is banned until you have looked.** Do not call any surface
   "clean", "fine", "good", or "looks right" from code or from an empty/English
   view. If a list is empty, seed data and look again. If you didn't open the
   exact sub-tab/state the user named, you have not reviewed it.

4. **Triple-review every UI change, all aspects** (the user's explicit standing
   instruction). Three independent passes per surface — see "The three passes".

5. **NEVER regress a feature or delete information to make a layout work.** If a
   figure, column, breakdown line, label, or control does not fit, redesign the
   container to hold it (wrap, stack, scroll the right region, shrink type within
   the scale, paginate). Dropping data because the design is hard is itself a
   regression and is forbidden. Every value/feature present before your change
   MUST still be present and correct after it. Diff the information content, not
   just the looks.

6. **ALWAYS show the proposed change as an ASCII or HTML render BEFORE writing
   code, and get explicit approval.** The agent has a documented track record of
   building UI changes the user never approved, then showing them after the fact
   (black button, repair-formula wording, owner-tab grid collapse — all rejected
   as "who approved this junk"). The agent is NOT trusted to choose layout or
   wording on its own. For any change to a rendered surface (a label, a formula
   line, a row layout, a column, a tab): first paste a concrete ASCII mock (or
   an HTML snippet) of the BEFORE and AFTER in the chat, let the user pick/edit,
   and only then implement the approved version verbatim. "Build it then show a
   screenshot" is the banned anti-pattern — show the mock first.

## How to capture — the FAST local-dev loop (proven 2026-06-22)

DO NOT deploy to NAS just to *look* at a UI change. A NAS deploy is ~10 min
(CI build + image pull + stack update) and is the slowest possible way to
iterate on layout. Use the **local dev server** instead: it reads your live
source files (hot reload, ~1s/edit) and proxies API/data to NAS so screens show
REAL Greek data. Seconds per look, not minutes. Deploy to NAS ONCE at the end.

### Why it's safe
The local server runs on your machine (`localhost:8180`); it only READS NAS data
through a proxy. It cannot write to or break production. The proxy is env-gated
(`LOCAL_UI_PROXY` unset in CI/prod → no effect) and the `next.config.js` rewrite
block + the `impeccable` devDep stay LOCAL (do not commit them to a NAS deploy).

### Setup (one time per session)
1. `next.config.js` has an env-gated `rewrites()` that proxies `/api/*` +
   `/tenantapi/*` to the NAS gateway when `LOCAL_UI_PROXY` is set. The rewrite
   rules MUST carry `basePath: false` — the app's `basePath:/landlord` would
   otherwise turn `/api/...` into `/landlord/api/...` and the browser's real
   `/api/v2` call (fetch.js builds `window.location.origin + /api/v2`) 404s.
2. Start the dev server (reads live source, hot-reloads on save):
   ```bash
   cd webapps/landlord
   export PATH="/usr/local/opt/node@20/bin:$PATH"
   LOCAL_UI_PROXY="http://192.168.0.96:1350" BASE_PATH="/landlord" PORT=8180 \
     nohup yarn dev > /tmp/landlord_dev.log 2>&1 &
   ```

### Auth (the /signin form is dead in dev — work around it)
The `/signin` page hits a Next.js dev **hydration error** (server/client markup
mismatch under basePath+externalDir), so its submit handler never attaches and
clicking does nothing. EVERY OTHER in-app interaction works once authenticated
(tabs, dialogs, buttons — verified). So bypass the form: API-signin to get the
`refreshToken` cookie and inject it into the browser; the app's refresh effect
authenticates on load.
- The refresh JWT expires (~10 min) — fetch a FRESH cookie before EACH
  navigation, or stale sessions bounce to the crashing signin page.
- Cookie is host-only (no domain) → set `domain:'localhost'`.

### Capture harness
`e2e-playwright/tests/_local_capture_all.spec.ts` does exactly this against the
real `landlord` realm + real Greek buildings (ΟΔΟΣ ΕΨΙΛΟΝ 28 etc.). It:
fresh-cookie per page, navigates, RETRIES if it lands on the error overlay, and
tags any shot that's the overlay/signin `_BROKEN_` so a crashed capture can
never be mistaken for a reviewed surface. Writes to `e2e-playwright/_ui/`.
```bash
cd e2e-playwright
export PATH="/usr/local/opt/node@20/bin:$PATH"
REAL_EMAIL="<account>" REAL_PASSWORD="<pw>" \
  npx playwright test --project=chromium tests/_local_capture_all.spec.ts
```
Watch the `OK / OVERLAY / SIGNIN` log line per surface — every surface MUST log
`OK`. An `OVERLAY`/`SIGNIN` (or a `_BROKEN_` filename) means that page did NOT
render and its screenshot is worthless; fix auth/timing and re-capture before
reviewing it. (Last run, 8/13 were silently the crash overlay — that's why the
guard exists.)

### Known capture-harness gotcha — the rents URL must be zero-padded

The rents page (`[organization]/rents/[yearMonth]/index.js`) validates
`yearMonth` in **strict** `moment(yearMonth, 'YYYY.MM', true)` mode and returns
`<ErrorPage 404 />` on any mismatch. So the term MUST be zero-padded:
`2026.06`, never `2026.6`. The real nav link (`AppMenu`) already builds the
padded form via `moment().format('YYYY.MM')`, so the app is fine — but a
hand-built capture URL with an unpadded month (`${yr}.${getMonth()+1}`) renders
the in-shell 404 and a critique agent will (correctly, from the pixels) flag it
as a P0 "rents is a dead page." **It is NOT a dead page — it's a harness bug.**
Two separate critique rounds flagged this; both times the page renders the full
RentTable at the padded URL. If you see the rents-404 finding, check the capture
URL's month padding before touching any route.

### Screenshot size gotcha
`fullPage` shots of long pages exceed the 2000px image-read limit. Use
viewport-only shots (no `fullPage`) at `deviceScaleFactor: 1.5`, or
`sips -Z 1400 in.png --out out.png` to downscale before reading. **Read every
PNG with the Read tool. Look, don't skim.**

## How to REVIEW — the impeccable critique fan-out (proven 2026-06-22)

Eyeballing one screenshot and self-certifying is exactly the failure that
shipped the ΚΑΘΑΡΟ-misaligned header twice. Instead, fan out INDEPENDENT
design-review agents — one per surface — that each read the screenshot + the
source file + DESIGN.md + (for the overview) the approved mockup, default to
finding problems, and return structured findings; then adversarially verify the
P0/P1 ones and synthesize a prioritised catalogue. The reusable workflow lives
at `.secrets/ui_critique.js` (Workflow tool). This is the `impeccable critique`
methodology; run it on the `_ui/` captures, not by hand.

Tooling notes:
- `impeccable detect` (the deterministic 27-pattern scanner) is the npm package
  `impeccable@3.1.0` — installed as a LOCAL devDep in `webapps/landlord` (do NOT
  ship it to NAS). `yarn impeccable detect --json <files>` scans SOURCE for
  static slop patterns (nested cards, side-stripes, gradient text, hero-metric).
- `impeccable detect <URL>` (live browser scan) does NOT work in this env: its
  bundled Puppeteer can't launch Chrome (x64 Node on arm64 Mac → Rosetta
  timeout) and can't auth. Use the agent critique + Playwright capture for
  rendered-pixel review instead.

For a single sub-state (a dialog, a specific tab, a breakdown panel), capture
that element: click into it, `scrollIntoViewIfNeeded`, screenshot. Empty tabs
prove nothing — use real data.

## The three passes (per surface, all required)

- **Pass 1 — defect catalogue.** Looking at the Greek screenshot, list every
  visible problem: raw template strings (`{{...}}`), truncated/clipped text,
  misaligned figures, ugly/broken progress bars, overflowing columns, cramped
  spacing, inconsistent wording, wrong number/currency format (must be
  `1.234,56 €`), control misalignment.
- **Pass 2 — DESIGN.md + mockup conformance.** Re-check against
  `DESIGN.md` laws and any approved mockup in `documentation/mockups/` (that
  directory is gitignored and local-only — the mockups render real tenant/owner
  figures, and this repo is public; ask for the file if you don't have it). The
  banned patterns are not suggestions: no identical card grids, no nested cards,
  no side-stripe borders, no drop shadows on cards, no gradient text, no
  `#000`/`#fff`, sea-accent ≤5%, display serif once per page, tabular mono for
  money. If an approved mockup exists for the surface, the shipped screen must
  match its structure; divergence is a defect.
- **Pass 3 — adversarial / no-regression.** Assume passes 1 and 2 missed
  something. Specifically hunt: did this change DROP any information that the
  prior version showed? Does any value now read differently than the ledger?
  Does the Greek read like a competent neighbor wrote it, or like a machine
  translation? Open the screen at a narrower width — does it still hold?

## Reporting rule

When you report UI work, show the screenshots (the actual images you read) and
the defect list, before and after. State plainly what you looked at and in what
locale. If you did not look, say "not yet reviewed" — never imply a review you
did not do. "The suite is green" is not a sentence that closes UI work.

## The specific failures this document encodes (do not repeat)

- Reviewed `/en` while the realm was `/el` — wrong language entirely.
- Called the Accounting page "clean" from an empty English view; never opened
  the owner-settlements tab that had the assigned button-inconsistency bug.
- Shipped `{{year}}` literal (broken interpolation) and a black-blob progress bar.
- Built tiles as identical card grids + nested cards (both DESIGN.md-banned).
- Left tenant vs owner settlements buttons inconsistent
  (Απόδειξη/"Receipt" vs "Statement") after being explicitly told to align them,
  and rationalized the inconsistency in a code comment.
- Wrote ~17 Playwright specs that all asserted API values; zero looked at pixels.
