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

## How to capture (Greek, readable, deployed)

The harness is `e2e-playwright/tests/_greek_sweep.spec.ts` (visual sweep; not
pass/fail, writes PNGs to `e2e-playwright/_greek/`). To review your own change:

1. Deploy your change to NAS and verify the container revision matches your
   commit (see test-running-guide "Verifying a deploy"). The UI must be the
   deployed one, not local.
2. Run the Greek sweep (or add your surface to it):
   ```bash
   cd e2e-playwright
   export PATH="/usr/local/opt/node@20/bin:$PATH"
   npx playwright test --project=chromium tests/_greek_sweep.spec.ts
   ```
   It signs in, forces the `el` locale via the `http://192.168.0.96:1350/landlord/el`
   base, navigates each surface, and screenshots at a 2× device scale so Greek is
   legible. Seed a building/tenant/owner with REAL data first (mongoExec) so the
   surface isn't empty — an empty screen hides every defect.
3. **Read every PNG with the Read tool.** Look, don't skim. For each surface,
   write down what is wrong before you touch code.

For a single sub-state (a dialog, a specific tab, a breakdown panel), capture
that element: click into it, `scrollIntoViewIfNeeded`, screenshot. Empty tabs
prove nothing — seed the rows.

## The three passes (per surface, all required)

- **Pass 1 — defect catalogue.** Looking at the Greek screenshot, list every
  visible problem: raw template strings (`{{...}}`), truncated/clipped text,
  misaligned figures, ugly/broken progress bars, overflowing columns, cramped
  spacing, inconsistent wording, wrong number/currency format (must be
  `1.234,56 €`), control misalignment.
- **Pass 2 — DESIGN.md + mockup conformance.** Re-check against
  `DESIGN.md` laws and any approved mockup in `documentation/mockups/`. The
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
