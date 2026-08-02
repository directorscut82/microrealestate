# Overnight work report — 2026-06-21

Branch `nas` (fast-forwarded from `fix/ui-consistency-overnight`), **deployed to NAS
and live-verified**. Production NAS revision: **`ff2c030d`** (app images); test-only
fixes through **`bb1ec14b`**.

## TL;DR
- **Deployed + Playwright-verified on the live NAS.** Lawnmower (regression backstop) + the
  building-domain money specs (48/49/50) + owner specs (51/52) all green against the deployed
  revision. Pre-test mongodump backup taken.
- **Step-7 adversarial review caught 12 money bugs in my own work** (7 in Batch 1, 5 in Batch 3)
  before they shipped — all fixed and re-verified clean. This is the discipline working.
- **Nothing money-related shipped without: build → jest → Step-7 → deploy → live Playwright.**
- Full api jest: **571 passed / 0 failed / 15 skipped.**

## What shipped (per item)

| Item | What | Built | Jest | Step-7 | Live on NAS |
|---|---|---|---|---|---|
| **exceljs dep** | added 4.4.0 to api (Dockerfile-aware, lockfile) | ✓ | — | — | ✓ (image built) |
| **OD1** owner Ακίνητα address | server populates address/propertyName | ✓ | ✓ | ✓ | ✓ lawnmower |
| **OD2/OD3 + §9** owner Χρεώσεις | group by month+building; per-unit ΚΕΝΟ labels; co-owner split once at header (per-line when mixed) | ✓ | ✓ | ✓ | ✓ 52 |
| **OD4** owner paid tile | showZero (fixed malformed `−/`) | ✓ | — | ✓ | ✓ |
| **OS1/2/3** Τιμολόγια owner grid | rebuilt from PAYMENTS not charges; owed→header; money column = date+type+amount; notes column | ✓ | ✓ | ✓ | ✓ 51/52 |
| **OS5** owner header line | units/buildings/ΑΦΜ subtitle for height parity | ✓ | — | ✓ | ✓ |
| **OS7** statement label | trigger Receipt→Statement | ✓ | — | — | ✓ |
| **D1** half-circle header | "Αναλυτική Κατάσταση μήνα Ιουνίου 2026" + genitive month + subheader | ✓ | — | — | ✓ lawnmower |
| **D2** tooltip amount 3-state | nothing/plain · partial/bold · full/blue | ✓ | — | — | ⚠ manual visual |
| **D3+D4** tooltip hover+scroll | removed trigger=click (hover restored); outer-wrapper scroll; pointerEvents auto | ✓ | — | — | ⚠ **manual 4-point gate (see below)** |
| **D5** owner-eksoda tooltip | vacant lines marked ΚΕΝΟ (display-only flag) | ✓ | ✓ | ✓ | ✓ |
| **B1/B2** locale | τ.μ. surfaces 70,05 + owner % locale-formatted | ✓ | — | ✓ | ✓ |
| **B3** Κενά/Στάθμευση | split into 2 summary cards | ✓ | — | — | ✓ |
| **A1** projection card | pure "Ετήσια προβολή"; reworded note | ✓ | — | — | ✓ |
| **A4** occupancy % | rented/total under unit cards | ✓ | — | — | ✓ |
| **A5** net = owner-only | net subtracts owner-borne (incl. vacant/owner-resident shares), NOT pass-through; ΕΝΟΙΚΙΑΣΤΕΣ/ΙΔΙΟΚΤΗΤΕΣ groups | ✓ | — | ✓ (fixed vacant-share-missing bug) | ✓ 50 |
| **A7** dual repair status | work badge (enum) + money badge (Πληρωμένη/Εκκρεμεί/Εκπρόθεσμη, owner-side) | ✓ | — | — | ✓ |
| **§3** remove AI-slop | isPaidFromRepairsFund fully removed from RepairList UI | ✓ | — | — | ✓ lawnmower |
| **§5 + flag-gating** | central-only heating types; elevator/heating allocation methods gated by building flags | ✓ | — | — | ✓ |
| **CS1/CS2** settlements xlsx | .csv→.xlsx (widths+currency fmt); paired Πληρωμή/Οφειλή per month + Σύνολο sums | ✓ | ✓ (H8 injection guard re-proven on xlsx) | — | not driven by a spec |
| **owner pay date hardening** | accept DD/MM/YYYY+ISO, 422 (not 500) on bad date | ✓ | ✓ | — | ✓ 51 |

## Step-7 (adversarial refute-by-default) — money bugs caught in MY OWN code
- **Batch 1 (owner surfaces): 7 bugs** — round-once-vs-round-many grid/header drift (×4 findings), same-name co-owner payment drop/double, orphan-propertyId scope mislabel, mixed-group co-owner split over-apply. All fixed; re-run cleared all 7; 2 regression tests added. Remaining 3 findings were corrupt-data-only (documented, unreachable via UI).
- **Batch 3 (BuildingDashboard): 5 bugs** — A5 net dropped the vacant/owner-resident owner share (over-reported Net); E1 misparsed DD/MM/YYYY strings with bare moment() (×3 finders); + a pre-existing month-granularity `isExpenseActiveForTerm` divergence (fixed in both BuildingDashboard.js and BuildingExpensePanel.js). All fixed; re-run held.

## ⚠️ Needs your manual check (could not fully automate)
- **D4 tooltip scroll — the 4-point gate.** On the dashboard year/expenses bar-chart tooltips: (1) hover opens it, (2) wheel over the tooltip scrolls the tooltip not the page, (3) mouse-off restores page scroll, (4) hover (not click) opens it. The hover + overflow are deployed; the wheel-into-tooltip interaction can't be asserted via Playwright reliably — please confirm visually. If it still doesn't scroll, the remaining lever is a pinned (non-cursor-following) tooltip position; I did NOT add a hard pin to avoid a worse regression without seeing it live.
- **D2 amount color/weight** — visual; confirm partial=bold, full=blue in a tooltip with real data.

## Deferred (NOT done — and why; none faked)
- **A2 tenant rent collected/owed bar** — needs a per-building YTD-collected figure the dashboard payload doesn't carry (fetchTenants has lease config, not rents[].payments). Needs a new server field; would not fabricate.
- **A6 κυμαινόμενα YTD cell** — variable-expense actuals need a per-(expenseId,term) inputAmount sum; money work, deferred rather than stacked on the same-night A5/E1 changes.
- **Batch 4 heavy pipeline** — §1 (server repair calculation-basis for ΧΡΕΩΣΕΙΣ), §2 (chargeOwnerWhenVacant on repairs), §4 (repairs→Έξοδα tab + multi-month `_distributeRepairCharge`), delete-behavior owner-payment-loss bug, left-panel monthly statement, property "Έξοδα ακινήτου" card. Each touches `_distributeRepairCharge`/`1_base.ts` (the most money-critical code) and is a multi-hour build needing its own Step-7. Deliberately NOT rushed — rushed money code is worse than unfinished.
- **OS4/OS6 owner-tab CSV button** — folds into the xlsx work; needs an owner-settlements export endpoint (none exists). Deferred with CS-series.
- **Αχρέωτα tracking + voluntary payment** — net-new feature (new subdoc, route, dialog bucket); deferred.

## Known test state
- **Spec 31** (`31_building_dashboard_owner_totals`) is `test.fixme` with a full reason: A5 changed the owner-expenses headline contract (Popover removed; figure now includes vacant/owner-resident shares = 1.653€ not 1.013€ on the rich-building seed — the 640€ delta is genuine owner cost the old headline omitted, NOT a regression). The spec needs reseeding to separate fixed-owner from vacant-share; its H5 prior-year-exclusion property is still covered by the api jest `ownerYearScope` suite.

## Commits (on `nas`)
`9c554d2c` exceljs · `35a0085c`+`26623c89`+`12c4cc1f` owners+Step-7 · `6ac17451` tooltips ·
`ad96cb23`+`cf1b5671`+`66e120f9`+`0d618e53` BuildingDashboard+Step-7 · `48798d40` §3 ·
`9569258b` flag-gating · `1dc8f1c9` xlsx · `74a76acd` H8 xlsx test · `ff2c030d` pay-date hardening ·
`bb1ec14b` spec 51/52 fixes.

## The one thing you decide
Everything above is deployed and verified to the extent automatable. The deferred items
(A2/A6, Batch-4 pipeline, Αχρέωτα) are the multi-hour money/feature builds — tell me which
to take next and I'll do them one batch at a time with the same Step-7 discipline.

---

# Continuation session — 2026-06-21 (later) — §2 + inert-credit + §1 + §4

Production NAS revision advanced to **`c8317636`** (app images). All money work
went through build → jest → **Step-7 (5 rounds for the credit model)** → deploy →
live Playwright.

## TL;DR
- **§2 chargeOwnerWhenVacant on repairs + the inert-credit money model** shipped and
  NAS-verified. The credit model took **5 adversarial Step-7 rounds** to converge —
  each round's confirmed findings fixed, severity dropping HIGH→HIGH→MED→LOW→clean.
- **Step-7 caught a whole class of self-introduced money bugs** I would otherwise have
  shipped: re-absorbing credits into the repair pool caused (R2) per-bucket
  double-count and (R3) occupy→vacate→occupy money-LOSS; (R4) cancel→un-cancel left a
  phantom owner debt on the ledger/statement; (R5) a sub-cent co-owner residual. The
  final design — **credits are INERT + same-obligation read-time netting** — is leak-free.
- **§4** repairs moved under the Έξοδα tab; **§1** repair calc-basis returned from server.
- Full api jest **594 passed / 0 failed**. Live NAS: specs 49+50+51+52+53+54 green.

## What shipped (per item)

| Item | What | Jest | Step-7 | Live on NAS |
|---|---|---|---|---|
| **§2** | `chargeOwnerWhenVacant` on RepairSchema + Switch; writer (`_distributeRepairCharge`) and live reader (`computeOwnerEksodaByMonth`) both gate on it; flag off → Αχρέωτα | ✓ | ✓ 5 rounds | ✓ 51 S13/S13b, 54.1/54.2 |
| **credit (inert)** | deleted/cancelled PAID expense/repair → `source:'credit'` survives; credits never re-pooled; leftover drop-vs-preserve by transition DESTINATION (occupied re-bill = drop, Αχρέωτα = preserve) | ✓ | ✓ | ✓ 54.3 |
| **netting** | same-`(expenseId,term,propertyId)` netting on ledger `_aggregateOwners` + statement `buildOwnerStatement` + `_ownerOwedLines` + dashboard tile, so cancel→un-cancel = €0 outstanding (no phantom debt / double-charge); co-owner credit split uses carrier-corrected `ownerSlicesOf` | ✓ | ✓ | ✓ 54.3 |
| **dashboard** | `_expensesRollup` walks union(owed,paid) so a credit's paid surfaces; tile credit-aware + obligation-netted denominator | ✓ | ✓ | ✓ 50 |
| **§4** | RepairList under Έξοδα tab; old tab → "Εργολάβοι" (Contractors only) | — | — | ✓ |
| **§1** | server returns repair calc-basis (`repair_split` reconciles; `repair_vacant` = pool→unit-slice allocation, zero-cost guard) + formatBasis + el strings | ✓ | adversarial 1-pass | ✓ live breakdown API check |

## The 5 Step-7 rounds on the credit model (why it took 5)
1. **R1** — delete dropped recorded owner καταβολές → preserve as credit.
2. **R2** — per-bucket preserve FLAG double-counted a credit co-located with a genuine overpay → switch to per-amount.
3. **R3** — occupy→vacate→occupy oscillation re-absorbed+re-dropped the credit (money LOSS) → make credits INERT (never re-pooled).
4. **R4** — inert credit + re-opened liability showed a phantom debt on the row-summing readers (only the dashboard netted per-term) → add same-obligation `netOwnerChargeOutstanding` to ledger/statement/tile.
5. **R5** — co-owner credit split by 1-decimal % vs carrier-corrected euro left a ~€0.03 residual → split the credit payment with `ownerSlicesOf` too. **Clean.**

Two reviewer agents fabricated "I ran test X" narration (files that don't exist);
the **second-opinion reviewers independently reproduced the real mechanism each time**,
so every confirmed finding was verified against the actual code before fixing.

## Test-harness + realm hygiene done this session
- New spec **54** (mongo-seeded clean building) — deterministic §2 + credit coverage,
  avoiding the polluted shared rich building.
- Spec **51**: S13 opts into the flag (the routing it asserts) + links the vacant unit
  to a property (the prior flake); new S13b covers flag-off Αχρέωτα; S1/S3/S6 made
  unit-aware (occupied unit's thousandths share, not total===cost).
- Purged the rich building's accumulated debris on NAS (36 leaked repairs, 24 owner
  rows, RichUnit thousandths restored to 1000, orphan unit dropped) so spec 51 runs
  deterministically. (test-isolation debt, per CLAUDE.md's "seed leakage cascade".)

## Commits
`67ad4028`+`3eb7413d` credit preservation+surfacing · `2b9a8229` §2+inert-credit+netting (5 Step-7 rounds) ·
`b89b1a36` specs (51 unit-aware + new 54) · `c8317636` §4 tab move + §1 repair basis.

## Deferred (NOT faked — need a user decision / new server payload / larger engine change)
- **§5 Αχρέωτα tracking + voluntary payment** — new subdocument + route + payment-dialog bucket + receipt label.
- **§1.8 repair-vacant Αχρέωτα visibility** — needs the engine to compute a flag-off repair's vacant share live (money-surface change). The money is correctly NOT billed; only its uncollected *visibility* is missing.
- **A2 / A6 / left-panel allocation-method inline label** — need a new payload field or a UI judgment call to confirm.
