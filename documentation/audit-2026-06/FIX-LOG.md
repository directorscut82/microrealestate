# Audit 2026-06 — Fix Log (branch nas, base HEAD 2a48a511)

> Status: DEPLOYED to NAS as commit 62f8ad95 (2026-06-17) + live-verified on the real
> account — see "DEPLOYED + LIVE-VERIFIED" at the end of this file.
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

## DEPLOYED + LIVE-VERIFIED (2026-06-17)
- Commit `62f8ad95` deployed to NAS; all 9 app containers verified on revision 62f8ad95 (independent Portainer poll); landlord HTTP 200.
- Live Playwright `_verify_money_batch.spec.ts` on the REAL `landlord` account PASSED: Accounting page renders (no ErrorBoundary blank — H7/H5-acc crash class confirmed fixed); 4 owners checked, every owner totalPaid ≤ totalAmount (C2 no-over-pay invariant holds on real data); dashboard/owners/accounting XHR all 200; no NaN/undefined/{{}} leak in rendered text; M4 incoming-tenants show no fabricated today-end-date. Screenshots read + confirmed.
- mongodump backup taken pre-verify: e2e-playwright/backup/mredb_pre_test_20260617_214627.archive.

## HIGH BATCH (post-62f8ad95, base 2885c54a) — round-1 + round-2 HIGH findings

> Re-verified every open HIGH against current code first (workflow): R2-H1
> FIXED-ALREADY by 62f8ad95; R1-H2 NOT-A-BUG (ledger/statement/PDF already
> agree on payments[]-only — the finding misread which surface was the
> outlier; only the dashboard tile bridges the legacy flag by design); R1-H13
> mostly fixed by 62f8ad95's M5/H5 (residual demoted to LOW). The rest were
> STILL-BROKEN and are fixed below, each jest red→green, then Step-7'd.

### Fixed + proven (jest):
- **R1-H7** un-terminate `$unset` — occupantmanager.update() now `$unset:{terminationDate:''}` (and deletes the undefined key from $set so no path-conflict) when clearing termination. `lifecycleUnsetGuards.test.js`.
- **R1-H9** extendLease double-occupancy — now calls `_assertNoDoubleOccupancy(...,tenantId)` before the write. `lifecycleUnsetGuards.test.js`.
- **R1-H11** fixed-allocation amount-0 dropped from breakdown — `1_base.ts` guard now `total<=0 && method!=='fixed'`. `expenseBreakdown.test.js`.
- **R2-H6 + R2-L1** currency lockout — replaced static `CURRENCIES` enum with `validateCurrency` that PROBES `Intl.NumberFormat` (the real downstream consumer); add() now validates currency too. Accepts the 9 fund codes (CHE/CHW/…) the dropdown offers, rejects garbage. `realmmanager.test.js`.
- **R2-H8** CSV formula-injection — `_sanitizeCsvText` now applied on the rawData=false (CSV) branches of all 3 builders (name/reference/property/composite/payment-ref). `accountingCsvInjection.test.js`.
- **R2-H9** Owners tab all-time totals — `_aggregateOwners(…, year)` filters charges by `floor(term/1e6)===year`; `all()` reads `?year=`; `fetchOwners(year)`+queryKey on `[year].js` (standalone Owners page unchanged, absent year = all-time). `ownerYearScope.test.js`.
- **R1-H4** payTerm re-prices closed past term — payTerm now snapshots a frozen TARGET term's billed line-items before BL.computeRent and restores them via `_freezeBilledCharges` (base charges + contract discount + contract VAT + carry-in balance frozen; NEW settlement items still apply; grandTotal re-derived). 78 freeze/pipeline tests green. `payterm-past-freeze.test.js`.
- **R1-H10** E9 cross-building property steal — addUnit's guard mirrored into importFromE9 on BOTH the else-branch and the E11000 concurrent-race catch-branch. `e9CrossBuildingSteal.test.js`.
- **R1-H3** owner-tile staleness (frontend) — BuildingDashboard owner paid/unpaid tile now drops stale vacant/owner-resident rows (expense-gone / flag-off / inactive-for-month), NEVER payment-carrying rows, and does NOT use current-occupancy (server is term-anchored authority). Month-granularity active check matches server `isExpenseActiveForTermMonth`. Frontend (no jest harness) — verified by direct predicate-equality + deploy-verify.
- **R1-H12** bulk rent-notice month-stale (frontend) — `useEffect(()=>setRentSelected([]),[yearMonth])` resets selection on month nav. Frontend — deploy-verify.

### Step-7 (TIER-MONEY adversarial refutation):
- **Round 1** (11 fixes): 6 HOLDS (H7,H9,H11,H12,R2-H8,R2-H9), 5 BROKEN — each a real bug in my OWN fix:
  - H8 — unconditional unarchive $unset DESTROYS a real move-out date (normally-terminated→archived→unarchived) → owner vacant charges vanish. **WITHDREW H8** (the original edge is raw-API-only; the revert's lesser evil preserves real dates).
  - H4 — `_freezeBilledCharges` restored base charges but not the contract discount → a shrunk discount inflated the closed month's grandTotal. **Fixed**: restore billed `origin:'contract'` discount, keep recompute's settlement discounts + debts verbatim.
  - R2-H6 — `Intl.supportedValuesOf` omits 9 fund codes the dropdown offers → still 422-locks them. **Fixed**: probe `Intl.NumberFormat` directly instead.
  - H10 — the guard covered only the else-branch; the E11000 catch-branch still stole. **Fixed**: guard added to both.
  - H3 — client current-occupancy drop wrongly erased a genuinely-owed past-term owner-resident row on a move-IN. **Fixed**: removed the occupancy clause (server is the term-anchored authority).
- **Round 2** (5 re-fixes): 4 HOLDS (H4-v2,R2-H6-v2,H10-v2,H8-v2), 1 BROKEN — H3-v2: the tile's full-YYYYMMDDHH active check dropped a recurring/mid-month-startTerm row the server keeps at YYYYMM. **Fixed**: month-granularity check; verified predicate-equality with server.
- **THE LESSON (again):** Step-7 caught 6 money bugs in my own "done" fixes that jest-green + self-review missed. Never claim a money fix done without an adversarial round coming back clean.

### Verification:
- Full api jest: **599 passed, 0 failed** (+21 over the 578 baseline). New: lifecycleUnsetGuards, accountingCsvInjection, ownerYearScope, e9CrossBuildingSteal, payterm-past-freeze; extended expenseBreakdown + realmmanager.
- `yarn workspace @microrealestate/{common,api} build` OK; `landlord lint` OK.
- **Known sibling (logged, not in this batch):** `BuildingExpensePanel.js:91` has the same full-granularity `isExpenseActiveForTerm` as the old tile helper — a display-only breakdown divergence for recurring mid-month-startTerm expenses. Queued.
- Deploy + live-verify: PENDING user authorization.

## MEDIUM BATCH (base bcfb93b5) — round-1 + round-2 MEDIUM findings

> Re-verified every open MEDIUM against current code first (workflow): all 14
> STILL-BROKEN. Fixed the tractable ones; deferred 2 infra/concurrency-bound.

### Fixed + proven (jest, where a harness exists):
- **R2-M1** property expense-sum now WINDOWS each expense by [beginDate,endDate] at MONTH granularity matching the engine (frontdata.ts) — a one-time / sub-period / past expense no longer inflates the recurring monthly Total. `occupantExpenseSum.test.js` (+6 cases incl. mid-current-month begin/end via fake timers).
- **R1-M2** thousandths basis `whole` now reduces over ALL building.units (engine denominator) so the printed part÷whole×total reconciles to the billed share. `expenseBreakdown.test.js` (+1, basis.whole == full-building).
- **R1-M5** dashboard notPaid: a NEGATIVE carry-in balance (overpayment credit) no longer inflates this month's due — `tenantMonthDue = tenantDue − Math.max(0, balance)`. (Step-7 caught my first attempt using `_isSettledByCarryForward`, which also hid an arrears-paid-later month; reverted to the surgical clamp.) Dashboard handler — deploy-verify + logic re-read.
- **R1-M6** `totalYearRevenues` now counts `amount − Σ non-revenue allocation` (excludes vat/deposit/previousBalance/extracharge) — and PRESERVES an overpayment's unallocated surplus (Step-7 caught my first income-line-sum attempt dropping it). Dashboard handler — deploy-verify.
- **R1-M9** bulkExpressPayment rejects a duplicate tenantId in the batch (fail-fast 422). `mediumBatch.test.js`.
- **R1-M11** emailmanager send + sendSmsOnly pair tenant→term by id-map, not by ($in-unordered) result position. `mediumBatch.test.js`.
- **R2-M3 + R2-L14** rentcall email itemized table now renders discount/debts/VAT/previous-balance rows so it reconciles to the bold Total; added Σύνολο/Έκπτωση/ΦΠΑ/Προηγούμενο υπόλοιπο/Πρόσθετες χρεώσεις to all 6 emailer locales (fixes the English "Total" leak too). Emailer — deploy-verify.
- **R2-M6** payment/owner toasts + allocation warnings format via `useFormatNumber` (org locale/currency), €-free keys added to all 6 landlord locales (PaymentTabs + OwnerPaymentDialog). Frontend — deploy-verify.
- **R2-M7** RentTable surplus badge + RentSelector "Remaining"/surplus render via NumberFormat/useFormatNumber, €-free key. Frontend — deploy-verify.

### Step-7 (TIER-MONEY): round 1 = 3 HOLDS (R1-M2,M9,M11) + 3 BROKEN (R2-M1 day-vs-month granularity [same class as H3], R1-M5 broad-gate hid arrears-paid-later, R1-M6 dropped overpayment surplus). All 3 re-fixed; round 2 = 3 HOLDS. The granularity bug (R2-M1) and the surplus bug (R1-M6) were both real money-drops in my own fixes that jest-green missed — Step-7 earned its keep a 9th and 10th time this campaign.

### Deferred (documented, NOT shipped):
- **R1-M1** owner-payment cross-building partial-commit — the verdict's fix is a mongo `withTransaction`, but the deployed mongo is SINGLE-NODE (roadmap-hardening §4.10: transactions require a replica set — an infra change, not a code fix). The "v1 partial-commit edge" is an already-documented limitation. Alternative (server returns a partial-commit signal the client surfaces) is an owner-flow change deferred.
- **R1-M8** payment-write vs recompute `__v` race (one-shot 409, no retry) — concurrency hardening, user-recoverable by manual retry (low severity); the retry loop interacts with a per-attempt `_getEmailStatus` network call. Deferred to a focused concurrency PR.
- **R1-M3** (allocation VAT preview), **R1-M4** (pie Receipts-vs-Owed basis), **R2-M2** (express drawer page-bound ≤21 rows), **R1-M10** (bulk-selection refetch-prune) — frontend display findings, queued for the frontend follow-up.

### Verification: api jest **610 passed / 0 failed** (+11 over the HIGH-batch 599). common+api+emailer build OK; landlord lint OK.

## LOW BATCH (base 4db27c46) — selected round-1 + round-2 LOW findings

> Fixed the LOWs that are real crash-guards / money-correctness / cross-surface
> consistency; the rest (pure cosmetic / UI-binding / legal-question) are noted
> as queued. Several LOWs were already closed by the HIGH/MED batches.

### Already fixed by earlier batches (no action):
- **R2-L1** (add() currency validation) — fixed with R2-H6.
- **R2-L5** (toOccupantData no-expenses crash) — fixed in 62f8ad95.
- **R2-L14** (English "Total"/"Building charges" in Greek email) — fixed with R2-M3 (added Σύνολο/Έκπτωση/ΦΠΑ/… to all 6 emailer locales).
- **R1-L4** (auto-spread phantom discount owed-line) — display-only, same root as the shipped express/H1 discount fix.
- **R1-L9 ≡ R2-M2** (express drawer page-bound) — deferred frontend (queued).

### Fixed this batch:
- **R2-L9** receipt/invoice PDF body crashed (500/blank) on a legacy rent missing `preTaxAmounts`/`discounts`/`debts` arrays — added `|| []` guards on the 3 forEach + the empty-row length math (mirrors the existing buildingCharges/charges guards). `invoicebody.ejs`. pdfgenerator build OK; render-proof at deploy.
- **R1-L7** accounting Owners-tab taxId search now normalized (lowercase + strip space/dot/dash) like the Owners page, so the same query yields the same owner set on both surfaces. `accounting/[year].js`.
- **R1-L8** accounting tenant search coerces name/tenant via `String(x ?? '')` — a null name no longer throws → ErrorBoundary-blanks the whole Accounting page. `accounting/[year].js`.
- **R1-L2** repair `chargeTerm` normalized to YYYYMM0100 (day=01) in add/updateRepair so a day≠01 term doesn't vanish from the dashboard rollup (mirrors the one-time expense startTerm normalization). `buildingmanager.ts`. (API/script-only; UI emits day-01.)
- **R1-L6** owner "Outstanding" badge (OwnerListItem) + co-owner split (owners/[id].js) now format via `useFormatNumber` (org locale + currency) instead of `Intl.NumberFormat(undefined,{currency:'EUR'})` — correct grouping/symbol on non-el / non-EUR realms.

### Verification: api jest 609/0; api + pdfgenerator build OK; landlord lint OK.

### Queued LOWs (documented, lower-value — cosmetic / UI-binding / legal):
- R2-L2 (JPY zero-decimal forced 2dp), R2-L3 (multi-property PDF names first address), R2-L4/L12 (expense date inputs bound to lease vs property entry/exit), R2-L6 (IRIS QR write-only), R2-L7 (express UTC vs local date off-by-one), R2-L8 (DEH bare-thousands-dot parse), R2-L10 (DEH €0 em-dash + OS-locale dates), R2-L11 (tenant-app USD default), R2-L13 (`{{count}} tenants` plural for count=1), R2-L15 (settlement month labels frozen at module-load locale), R2-L16 (empty-IBAN dangling line + no IBAN validation), R1-L1 (E9 bare-ownership/usufruct billed as full owner — needs legal confirmation), R1-L3 (E9 mid-batch rents not rolled back), R1-L5 (owner persisted-amount vs grafted-basis display disagree).
