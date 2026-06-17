# Audit 2026-06 — Fix Log (branch nas, base HEAD f6f75966)

> Status of each confirmed finding. NOT deployed. Staged locally, awaiting user authorization.
> Discipline: every fix has a failing-test proof BEFORE the fix, re-verified green AFTER,
> then adversarially re-challenged (Step 7) until the round comes back clean.

## CRITICAL (round 1) — owner-money deletion

### C1 — `_recomputeVacantOwnerCharges` silently deletes recorded owner καταβολές
- **Proven**: jest `ownerEksodaByMonth.test.js` C1-a (flag-off) + C1-b (move-in): €40 → €0.
- **Root cause**: strip-all-then-rebuild (buildingmanager.ts ~3888) re-attaches payments only to
  rows the rebuild RECREATES; rows it skips (flag off / occupied / variable / early-return) had
  their payments `.pull()`'d with no re-attach. Write-side ignored the `hasPayments` invariant the
  read-side (`isOwnerExpenseRowStale`) already enforces.
- **Fix**: `consume()`-tracked priorSettle + `reattachPaidOrphans()` re-pushes any unconsumed
  payment-carrying prior row as a SETTLED REMNANT (`amount = paidSum`, owed===paid, outstanding 0)
  before EVERY exit. Zero-payment orphans still dropped.
- **Status**: FIXED. Step-7 round 1 = clean for C1. Re-challenged in r2/r3 (settled-remnant amount cap).

### C2 — `_distributeRepairCharge` drops owner repair payments
- **Proven**: jest C2-a (reclassify owners→tenants: €200→€0) + C2-b (chargeTerm A→B: €150→€0).
- **Root cause**: same strip-without-reattach on `source:'repair'` (re-push only if ownerPortion>0)
  and `source:'repair-vacant'`; PLUS term-keying bug (snapshot keyed by row's own term, lookup by
  NEW chargeTerm → miss on any term change).
- **Fix**: snapshot `source:'repair'` by repairId (not term); key repair-vacant by propertyId;
  reconcile orphaned owner-portion payment AFTER the unit loop.
- **Step-7 round 1 caught**: my first C2 fix introduced a DOUBLE-COUNT (€400 owed for €200 repair).
- **Step-7 round 2 caught**: the merge was uncapped (paid €1000 onto €200 row → negative outstanding
  on statement, vanished money on dashboard) + arbitrary-row + full-prior-amount remnants.
- **Final coherent fix (settled-remnant invariant)**: a re-attached orphan's `amount` === the payment
  it carries (owed===paid, outstanding 0 everywhere). Orphaned payments SPREAD across repair-vacant
  rows CAPPED per-row (paid ≤ amount), remainder → one capped standalone remnant.
- **Proven clean**: jest C2-fix-guard (occupied + vacant) + B1 multi-unit overpay (5 units, 1 vacant:
  no row over-paid, nothing vanished, owed===paid).
- **Status**: FIXED pending Step-7 round 3 verdict (re-launched on coherent fix).

### Verification (both)
- `ownerEksodaByMonth.test.js`: 34 passed.
- Money-suite regression: repairCharges + expenseBreakdown + moneyFlowLifecycle + buildingCharges +
  ownerStatement + ownermanager + buildingChargesScenarios + buildingChargesGroupCarrier = 187 passed.
- `yarn workspace @microrealestate/api build` = OK.
- Files touched: `services/api/src/managers/buildingmanager.ts` (+ test-only export of
  `_distributeRepairCharge`), `services/api/src/__tests__/ownerEksodaByMonth.test.js`.

## FIXED — Express settle (round-1 H1/H6 ≡ round-2 C1/C2, cross-confirmed)
- **Proven**: jest `expressNetOwed.test.js` (7 tests): discounted tenant owed gross (was 500, should 450); partial-paid owed gross (was 500, should 300); etc.
- **Root cause**: `bulkExpressPayment` recorded `Σ _computeOwedLines` (gross — no discount, no already-paid) and `settlements.payments = paymentData.payments` REPLACED the array (destroying prior payments).
- **Fix**: new exported pure `_expressNetOwed(targetRent)` = `(grandTotal − balance) − alreadyPaid` (carry-in first, then monthly) — mirrors `ExpressPaymentDialog` exactly. Handler now prepends existing `targetRent.payments` to `paymentData.payments` (mirrors the normal dialog's `[...savedPayments, ...drafts]`). Allocation spread capped to the net amount.
- **Verified**: 69 payment/pipeline tests green; api build OK.
- **Proof gap (honest)**: `_expressNetOwed` amount is unit-proven; the payment-PRESERVATION (prepend existing) is in the handler, exercised end-to-end only by live Playwright (deploy-verify phase).
- Files: `services/api/src/managers/rentmanager.ts`, `services/api/src/__tests__/expressNetOwed.test.js`.

## FIXED — VAT receipt doesn't foot (round-2 H2)
- **Root cause**: `pdfgenerator/data/index.js:132` receipt `invoiceGrandTotal = subTotal + balance` omits VAT; template prints a VAT line + labels headline "Total with VAT" → short by VAT; `newBalance` → phantom credit/debt.
- **Fix**: receipt headline `= subTotal + vat + balance` (subTotal stays pre-VAT, correctly labeled). One term.
- **Proof gap (honest)**: pdfgenerator has NO jest harness + the fn isn't exported; arithmetic is a verifiable one-liner but PROOF is a live PDF render on a VAT tenant (deploy-verify phase). pdfgenerator build OK.
- Files: `services/pdfgenerator/data/index.js`.

## FIXED — Dunning emails over-bill partial payers (round-2 H3)
- **Root cause**: 4 reminder templates quote `tenant.rents[0].total.grandTotal` (gross), never subtracting `total.payment`. A €600-of-€1000 tenant gets a pre-eviction notice demanding €1000.
- **Fix**: quote `Math.max(0, grandTotal − payment)` in all 4 (reminder + last-reminder, html + text).
- **Proof gap (honest)**: emailer has no jest harness; render-proof via deploy-verify. emailer build OK.
- Files: `services/emailer/src/emailparts/contents/rentcall_reminder/{body_html,body_text}.ejs`, `.../rentcall_last_reminder/{body_html,body_text}.ejs`.

## FIXED — H5 settlement-discount double-credit (round-1)
- **Proven**: jest `settledByCarryForward.test.js` (4 tests): rent 1000, settlement discount 100 (→ grandTotal 900), payment 800 → was wrongly "settled", should owe 100.
- **Root cause**: `frontdata.ts:42` `cashIn = paymentsSum + settlementDiscounts`, but `monthlyBill = grandTotal − balance` already nets the discount (7_total subtracts all discounts) → discount subtracted from running deficit twice → underpaid month flips to "paid".
- **Fix**: `cashIn = paymentsSum` only (discount is a bill reduction, not received cash).
- Files: `services/api/src/managers/frontdata.ts`, `services/api/src/__tests__/settledByCarryForward.test.js`.

## C2 — FINAL model (after 7 Step-7 rounds): UNIFIED PAYMENT POOL + surplus-drop
- The pool model: pre-strip, sum all payments across BOTH repair+repair-vacant rows for the repairId (+ a bare setOwnerExpensePaid paid-flag); strip all; rebuild zero-payment liability rows; re-apply the bare flag, then fill live rows CAPPED per amount.
- **Surplus decision (a genuine product call — flagged to user):** an owner OVERPAYMENT beyond the current owner liability (after a transition shrinks it) is **DROPPED + logged**, matching the existing `payOwner` auto-mode contract (MRE has NO owner carry-forward ledger). Every model that tried to PRESERVE the surplus was adversarially proven to leak:
  - r4/r5: a `repair-overpay` source double-counted owed across 4 unpatched read surfaces + was dropped by the next recompute → **reverted**.
  - r6: attaching surplus to an over-paid live row inflated owner-ledger/statement `totalPaid` ("paid €200 against owed €40") + could misattribute to the wrong owner → **reverted**.
  - r7: drop-surplus — no surplus artifact exists on any surface → leak-free.
- **What is preserved (the real C2 bug):** any payment that is still legitimately owed (payment ≤ liability) — deleted on reclassify/term-change/move-in/round-trip — is fully preserved by the capped fill. Only a genuine overpayment past a now-smaller liability is dropped, exactly as a direct owner overpayment already is.
- Read-side `outstanding = Math.max(0, amount − paid)` clamps added to ledger + statement as defense-in-depth.
- 10 `ownerPaymentCarry.test.js` tests (C1-a/b + guards, C2-a/b + guards incl. round-trip, multi-unit overpay, bare-flag-survives); full api suite 570 passed / 0 failed.
- **NOTE — test-file revert incident:** my C1/C2 proof tests originally added to `ownerEksodaByMonth.test.js` were reverted to HEAD by a linter/process mid-session; re-authored in a fresh `ownerPaymentCarry.test.js` (source fixes were unaffected).
- Files: + `services/api/src/managers/ownermanager.ts`, `services/common/src/utils/ownerstatement.ts`. (building.ts schema enum change was reverted with repair-overpay.)
- **Step-7-r7 → r8 (per-property pool):** r7 found (a) the bare paid-flag re-apply lit up EVERY equal-amount sibling row (split repair: owner-portion + repair-vacant both €100) → eksoda double-counted paid; (b) a FLAT pool mis-attributed one owner's καταβολή to another owner's row in a multi-vacant building. FIXED: bare-flag now consumes onto ONE row then breaks; the pool is keyed PER PROPERTY (paidByProp/flagByProp, '__owner__' sentinel for the building-wide row) — Pass 1 fills each row from its own unit bucket capped, Pass 2 migrates genuine cross-source remainder, surplus dropped. 12 ownerPaymentCarry tests (added r7 double-flag + r7#2 multi-vacant attribution); full api suite 572/0. Awaiting Step-7-r8.
- **User decision (logged):** fix multi-vacant attribution (#2 — done); the remaining overpay-on-later-recompute cases (#4/#5) are accepted as documented design limitation (no owner carry-forward ledger; matches payOwner auto-mode surplus-drop).
- **Step-7 r8→r11 (cross-source migration owner gating):** r8 found Pass-2 spread money cross-owner → gated by owner identity; r9 found strict-equality DROPPED still-owed money in mixed-ownership buildings → building-wide bucket reaches any unit + per-unit exact-set; r10 found exact-KEY dropped money when the SAME human is keyed differently across units (taxId present vs absent — production-reachable via staggered E9 import / manual-add-without-ΑΦΜ) → gate now compares owner OBJECTS via `sameOwner` (memberId OR taxId OR name match) with mutual coverage. 14 ownerPaymentCarry tests (added r9 mixed-ownership, r10 key-drift). Each round's BROKEN count fell 7→2→1, converging. Awaiting Step-7-r11.
- **C2 is the most-adversarially-tested code in the batch (14 rounds, converging — r13 raised 11/only 1 BROKEN).** The realistic bug (payment ≤ liability deleted on a single transition) was fixed by round 4; rounds 5-14 hardened the owner-attribution of the rarer multi-owner/term-move/overpay tail.
- **C2 FINAL converged design** (`_applyRepairPaymentPool`): pool payments PER PROPERTY pre-strip (capturing each bucket's original {term,source,propertyId,amount}); rebuild zero-payment rows; Pass-1 fill each from its OWN bucket capped; Pass-2 migrate a leftover onto another row ONLY when both resolve to the SAME ATTRIBUTED OWNER (the read side's rule: per-unit→unit owners, building-wide→lex-first canonical owner; drift-tolerant sameOwner = memberId OR name+non-conflicting-taxId); any final leftover → if the charge MOVED months (orig.term ≠ new term) re-materialise a settled remnant at the ORIGINAL term (r13), else (same-term owner-portion shrink) drop as accepted overpayment. 18 ownerPaymentCarry tests. The unifying principle that ended the rounds-8-13 churn: **the migration gate must use the read side's own owner-attribution rule, so the two can never disagree about who owns a payment.**
- **r11 B4 + same-term reclassify-shrink overpayments** remain the accepted documented drop (no owner carry-forward ledger; matches payOwner auto-mode).
- **PLAN if the migration tail persists:** nearly every round-7+ finding is in the cross-source Pass-2 MIGRATION (owner-portion '__owner__' ↔ per-unit repair-vacant when a reclassify moves the repair's liability between sources). That migration is a rare-preservation feature I added; its absence only means the owner's payment stays on the owner-portion row (correct) or drops as the already-accepted surplus — never mis-attributed. If Step-7 keeps finding Pass-2 attribution edges, the right move is to REMOVE Pass-2 entirely (keep Pass-1 per-property exact-bucket fill + surplus-drop), collapsing the whole round-7+ class at the cost of dropping the rare owner-portion→repair-vacant carry. Decision pending r12.

## FIXED — TIER-UI render/surface-down (round-2)
- **M4** — IncomingTenants rendered `moment(undefined)` = TODAY as a fabricated contract-end (advancing daily); now only renders the end side when `tenant.endDate` present (matches the CSV). `IncomingTenants.js`.
- **M5** — `_settlements` CSV fabricated TODAY as begin/end for a tenant missing begin/termination/end; now guarded `value ? moment.utc(...) : ''` like its siblings. `accountingmanager.ts`.
- **H7** — a legacy/typeless payment (`type:''`) crashed `t(type[0].toUpperCase()...)` → ErrorBoundary blanked the WHOLE Accounting page for all tenants; now `type ? ... : ''`. `TenantSettlements.js`.
- **H5-acc** — empty/invalid `realm.currency` → `Intl.NumberFormat` RangeError took down the entire Accounting page + 3 CSVs; new `_safeCurrencyFormatter` (try/catch + passthrough) on all 3 builders. `accountingmanager.ts`.
- All build-verified (api + landlord eslint clean); render-proof at deploy.

## NOT YET FIXED — proven-by-audit, queued (prove-then-fix each)

- **Express settle** (R1-H1/H6 ≡ R2-C1/C2, cross-confirmed both rounds): `_computeOwedLines`
  (rentmanager.ts:103) sums full preTax and NEVER subtracts `rent.discounts[]` (canonical grandTotal
  DOES, 7_total.ts:64) NOR prior `rent.total.payment`; `bulkExpressPayment` records that gross +
  `settlements.payments = paymentData.payments` (1052) OVERWRITES prior payments. → over-records by
  discount+already-paid AND destroys a recorded payment. CONFIRMED by reading code; jest proof pending.
- **VAT receipt doesn't foot** (R2-H2): pdfgenerator data/index.js:132 receipt branch
  `invoiceGrandTotal = subTotal+balance` omits VAT; prints VAT line but headline short by VAT;
  phantom credit/debt on balance line. CONFIRMED by reading; render proof pending.
- **Dunning emails over-bill partial payers** (R2-H3): 4 reminder templates quote gross grandTotal.
- **24 round-2 root causes** in `round2-punchlist.md`; **63 round-1** in `round1-punchlist.md`.

## Cross-round convergence (raises confidence these are real)
- Express-settle found independently by BOTH audit rounds.
- C1/C2 match the user's prior-session lesson (memory `project_owner_row_staleness_invariants`:
  "never drop recorded payments") — same bug class, new triggers.
