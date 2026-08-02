I have enough verification. The critic's gaps are confirmed at the code level:
- `_settlements` has no incoming/outgoing filter (line 290 vs 178/226).
- `lastRent` (line 241) uses `rents[length-1]` from a `$filter` (line 137-144) that preserves insertion order, with no sort — final balance can come from an arbitrary month.
- `_settlements` strict date parse `moment.utc(date, 'DD/MM/YYYY', true)` (line 322/365) → `Invalid Date` on a non-zero-padded legacy date.
- `totalYearRevenues` (dashboardmanager.ts:282-289) sums every `payment.amount` regardless of allocation category → counts VAT/deposit/prev-balance/extra-charge as revenue.
- Owner-statement PDF `paidAmount` is payments-only (ownerstatement.ts:443-465) → flag-paid charge prints outstanding on the legal document.

Now I'll write the final punch-list, deduplicating the strip-without-payment-guard cluster (one root cause appears in ~7 findings) and the discount-in-owed-lines cluster, and the flag-bridge cluster.

---

# MicroRealEstate — Maintainer Punch-List (HEAD `2a48a511`, branch `nas`)

Findings are deduplicated to root cause and ordered highest-money-risk × highest-confidence first. File:line citations are against current code on disk.

---

## CRITICAL — recorded owner money silently and permanently deleted

### C1. `_recomputeVacantOwnerCharges` strips owner-expense rows with NO `hasPayments` guard, deleting recorded καταβολές whenever the rebuild skips the unit
- **Root cause:** `services/api/src/managers/buildingmanager.ts:3888-3895` (unconditional `ownerMonthlyExpenses.pull(e._id)` over the source/term filter) + no post-loop re-attach of unconsumed `priorSettle` entries (function ends 3998). `priorSettle`/`carryOwnerPayments` only fire at the two re-push sites (owner-fixed 3898-3913; per-unit 3962-3997, gated by `occupied.has` 3966, `!isResident && !flagOn` 3970, `share<=0` 3977, non-billable 3959-3961) and the early-return 3935-3940.
- **This single root cause produces six of the audit findings** — they are the same strip-without-guard bug reached by different triggers:
  - flip `chargeOwnerWhenVacant` OFF on a paid vacant expense (updateExpense 3234-3239 → recompute current term);
  - tenant moves into a previously-vacant paid unit (occupantmanager.ts:1136/1573 → `recomputeVacantOwnerForProperties` ±12-mo window 4030-4071 → `occupied.has` skip);
  - flip a unit `owner_occupied → vacant` while the source expense has `chargeOwnerWhenVacant=false` (updateUnit 2076-2081/2137-2142 → `!isResident && !flagOn` skip);
  - expense set inactive / amount→0; `share<=0`.
- **Impact:** dropped-money. A recorded owner καταβολή (`payOwner` pushes into `row.payments`, ownermanager.ts:776) is physically `.pull`'d and `_saveBuildingWithVersionCheck`'d with no audit trail; vanishes from ledger, dashboard, breakdown, tile, and the PDF simultaneously. Violates the schema invariant at `building.ts:325-328` that every read path already enforces (`isOwnerExpenseRowStale` hasPayments guard, ownerstatement.ts:137-140).
- **Minimal fix:** exclude payment-carrying rows from the strip filter at 3888-3894 (`&& !(Array.isArray(e.payments) && e.payments.some(p => Number(p&&p.amount) > 0))`), mirroring the read-side guard at 2642-2645/4268-4271. (Equivalently, add a post-loop re-push of any `priorSettle` entry with payments that the rebuild loop did not re-create.)

### C2. `_distributeRepairCharge` drops recorded payments on `repair` / `repair-vacant` owner rows on repair edit (reclassify-to-tenant, post-move-in, OR chargeTerm change)
- **Root cause:** `services/api/src/managers/buildingmanager.ts` — two unguarded strips: `repair` at 3563-3565 (re-push only `if (ownerPortion>0)` at 3567), `repair-vacant` at 3639-3645 (re-push only in the vacant else-branch 3705-3727). Plus a **term-keying bug**: snapshots key by the row's OWN term (`priorRepairSettle` 3554; `priorRepairVacantSettle` 3623) but the rebuild looks up by the NEW `chargeTerm` (`term` 3541; lookups 3568 / 3714), so any chargeTerm A→B edit misses → `carryOwnerPayments(undefined)` → empty payments (ownermanager.ts:103-105). Caller: updateRepair 4744-4749.
- **Impact:** dropped-money. (a) Reclassify a paid owner-borne repair to `chargeableTo:'tenants'` → `ownerPortion=0` → payment discarded. (b) Repair-vacant unit becomes tenant-occupied, then repair edited → share routes to a tenant `monthlyCharge` (3697-3704), owner payment discarded (double-loss). (c) Move chargeTerm A→B → carry lookup misses → payment wiped.
- **Minimal fix:** add the same `hasPayments` exclusion to both strips (3563-3565, 3639-3645); and key the carry snapshots/lookups by repair+propertyId (single row per repair / per propertyId-per-repair) rather than by `chargeTerm`, so a term change still matches.

---

## HIGH — wrong money recorded, double-counted, or dropped on read surfaces

### H1. Express-pay records the UNDISCOUNTED owed-line sum + DESTROYS existing partial payments (one root cause, two coupled defects in `bulkExpressPayment`)
- **Root cause:** `services/api/src/managers/rentmanager.ts`. `_computeOwedLines` (103-189) never subtracts `rent.discounts[]` (the principal; VAT is already netted via `rent.total.vat`), while `grandTotal` does (7_total.ts:64-67). `bulkExpressPayment` (548-557) uses that gross sum as the recorded `amount` with no clamp (596-611), and builds `paymentData.payments` as a SINGLE fresh transfer that does NOT include `targetRent.payments` — and `_updateByTerm` REPLACES the array (731-737, 1052 → computeRent payments:[] index.ts:28 → 6_payments.ts:50).
- **Impact:** wrong-money + dropped-money. For any tenant with `occupant.discount>0`: dialog shows discounted €900 (frontdata.ts:128-129), server records €1000 → next-month phantom −€100 carry-in (5_balance.ts:17-20). For any partially-paid term: dialog shows the remaining (e.g. €300), server records the gross €500 AND wipes the prior €200 cash payment (date/method/reference/promo destroyed).
- **Minimal fix:** in `bulkExpressPayment`, (1) compute `monthlyOwed` net of `sum(rent.discounts[].amount)` and `targetRent.total.payment` so it equals what the dialog showed; (2) prepend `targetRent.payments` (mapped to persisted shape) into `paymentData.payments` so the REPLACE preserves prior rows.

### H2. Owner-expense `paid` flag (set via `setOwnerExpensePaid`) is honored by tiles/chart/PDF but ignored by the owner ledger — same charge shows PAID and OUTSTANDING simultaneously (FOUR surfaces)
- **Root cause:** `setOwnerExpensePaid` (buildingmanager.ts:2922-2923) sets `entry.paid=true` with NO payment record and NO `recomputeOwnerExpensePaid`. The owner ledger `_aggregateOwners` (ownermanager.ts:346-366) and `OwnerStatement.buildOwnerStatement` (ownerstatement.ts:443-465) derive `paidAmount` from `payments[]` only and never read `row.paid`. The Building Overview tile (BuildingDashboard.js:393-399) and dashboard Έξοδα chart (buildingmanager.ts:4298-4304) bridge `paid?amount:0` via `Math.max`.
- **Impact:** wrong-money / contradictory state across **four** surfaces, including the printed **owner-statement PDF** (`services/pdfgenerator/data/owner_statement/index.js:157`, `payment = Σ paidAmount`) which prints the charge as fully outstanding (`newBalance=grand`) on a legal document while the tile shows it paid. The payment dialog still offers the "paid" charge for settlement (double-count risk). For a partially-paid row (`payments=[60]`, then flag→true) the tile over-reports €100 collected vs €60 in the ledger.
- **Minimal fix (make the outliers match the ledger):** make `setOwnerExpensePaid` write a synthetic settling payment (or call `recomputeOwnerExpensePaid`), so all surfaces derive paid from `payments[]`. Alternatively reject `paid=true` when `0 < Σpayments < amount`.

### H3. Building Overview "owner expenses paid vs unpaid" tile counts raw `ownerMonthlyExpenses` with NO staleness filter — 5th surface over-counts/double-counts owner liability
- **Root cause:** `webapps/landlord/src/components/buildings/BuildingDashboard.js:383-409` filters only by calendar year; no `isOwnerExpenseRowStale` / source / occupancy / flag-off drop. Server feeds the raw array (`_toBuildingData`, buildingmanager.ts:99-104). The other 4 surfaces drop stale rows (breakdown 2641-2655; dashboard eksoda 4265-4291; ledger ownermanager.ts:336-344; predicate ownerstatement.ts:122-151).
- **Impact:** double-count. Because `updateExpense` recomputes only `_currentTerm()` (3234-3238), flipping `chargeOwnerWhenVacant` OFF leaves the other 11 in-year terms' rows physically present; the tile inflates `ownerLedgerTotal`/`Outstanding` while the chart/breakdown/ledger show €0 for the same expense — opposite values side-by-side. Same euro can be both the tenant's rent and this tile.
- **Minimal fix:** the same file already excludes `source` vacant/owner-resident/owner-fixed for `recordedOwnerEksoda` (335-340); apply that same source-routing + staleness drop to the tile filter at 383-409. Since the frontend lacks per-(propertyId,term) occupancy, best fixed server-side by having `_toBuildingData` prune or by feeding the pre-filtered eksoda series.

### H4. Recording a payment on a CLOSED PAST term re-prices that month's building/property charges at CURRENT rates (payTerm freeze-skip exempts the target term)
- **Root cause:** `services/api/src/managers/contract.ts:270` (`rent.term !== targetTerm && _isFrozen(...)` exempts the term being paid) + 283 (recompute via `BL.computeRent` against live `contract.buildings` injected at rentmanager.ts:774-795). Recurring building expenses bill the live `expense.amount` (1_base.ts:968-989; no per-term snapshot), and `updateExpense` mutates amount in place (3232). The protective freeze (`Contract.update`, contract.ts:104-207) runs only on the expense-edit path, never on payTerm.
- **Impact:** wrong-money. Pay a late March rent after the cleaning expense was raised in May → March grandTotal jumps, the Settled month flips to underpaid, phantom arrears carry forward. Also triggered by editing/deleting any saved payment tile on a past term (PaymentTabs.js:596 re-submits with in-month dates that pass the backdate guard).
- **Minimal fix:** in payTerm, when the target term is past/frozen, restore its stored billed `preTaxAmounts/charges/buildingCharges/vats` and replay only the new payment, instead of recomputing against live state (mirror `Contract.update`'s freeze-restore for the target term).

### H5. Per-payment settlement discount double-credited in carry-forward check → underpaid month wrongly flips to "paid"
- **Root cause:** `services/api/src/managers/frontdata.ts:34,39-43,55`. `monthlyBill = grandTotal - carryIn` is already net of the discount (7_total.ts:65), but `cashIn = paymentsSum + settlementDiscounts` (42) re-adds the discount → the running deficit drops by the discount twice.
- **Impact:** accept-invalid. Rent 1000, promo 100, payment 800 → `running` hits 0 → `_isSettledByCarryForward` returns true → status "paid" while €100 is still owed; the row drops out of "In arrears" on both the rents list and the PATCH response.
- **Minimal fix:** remove `settlementDiscounts` from `cashIn` at frontdata.ts:42 (the discount is a bill reduction already in `monthlyBill`, not received cash).

### H6. Express settlement on a PAST-month rents page 422s every row (dated today, rejected by backdate guard) with an opaque "N failed" toast
- **Root cause:** `services/api/src/managers/rentmanager.ts:504/603` hardcodes the payment date to today while using the viewed-month term (528); `_updateByTerm`'s guard rejects any payment after `endOf('month')+7d` (1016-1030). Client `ExpressPaymentDialog.js` has no date control and discards the server's per-item `error`, showing only a generic warning (166-172).
- **Impact:** reject-valid. The arrears-settlement action is impossible via Express on any month >~7 days in the past; user sees "Recorded 0 of N (N failed)" with no cause.
- **Minimal fix:** date express payments to a term-anchored value (`min(today, termLastDay)`) instead of always today; and surface the server's per-item `error`.

### H7. Un-terminate (clearing `terminationDate`) silently fails — Mongoose `$set` drops `undefined`, leaving a tenant terminated-but-active and double-billing vacant-owner expenses
- **Root cause:** `services/api/src/managers/occupantmanager.ts:1529-1536` writes `{$set: occupantPatch, $inc:{__v}}` with no `$unset`; `_stringToDate('')` → `undefined` (31), and Mongoose 6.13.6 strips undefined keys from `$set`, so the stale `terminationDate` survives. Only `extendLease` (2161) `$unset`s it.
- **Impact:** double-count. Tenant reads terminated/stopped (frontdata.ts:446-451) while its rent ledger is rebuilt active (Contract.update called with `termination:undefined`, 1463); for a `chargeOwnerWhenVacant=true` expense the unit's share is billed to BOTH the (active) tenant rent and a `source:'vacant'` owner row for every post-termination term (the post-write recompute reads the stale date as vacant; the dashboard STALE-VACANT guard 4281-4291 doesn't drop it because its occupancy check reads the same stale date).
- **Minimal fix:** in `update()`, when incoming `terminationDate` is empty, add `$unset:{terminationDate:''}` (or send `terminationDate:null`).

### H8. `unarchive()` never clears the force-archive-invented `terminationDate` → tenant returns permanently flagged terminated, no UI path to fix
- **Root cause:** `services/api/src/managers/occupantmanager.ts:1914-1917` only `$set:{archived:false}`; force-archive invented a past `terminationDate` (1647-1666). Same Mongoose-drops-undefined trap blocks clearing it via the edit form (1529-1536).
- **Impact:** stale-state / read-time blank-render. Unarchived tenant reads terminated/stopped (frontdata.ts:442-452), goes read-only ([id].js:113), with no working UI to un-terminate. (Reachable only via raw `?force=true` API — UI deleteTenant sends no force and the Delete button is disabled when `hasPayments`.)
- **Minimal fix:** add `$unset:{terminationDate:''}` to `unarchive()` at 1914-1917 (mirror how force-archive set it).

### H9. `extendLease` skips the double-occupancy guard → extending a lease past a successor tenant's entry creates overlapping occupancy
- **Root cause:** `services/api/src/managers/occupantmanager.ts` — `_assertNoDoubleOccupancy` (773-864) is called only in add (1022) and update (1355); `extendLease` (1993-2211) sets `endDate` (2090) with no overlap check. `_checkLostPayments` only inspects the tenant's own rents.
- **Impact:** double-count. Tenant A (Jan-Jun) + successor B (Jul-Dec); extend A to September → A and B both occupy the unit Jul-Sep, corrupting equal-allocation party counts, occupancy, and per-unit rent attribution.
- **Minimal fix:** call `_assertNoDoubleOccupancy(realm._id, {...existingDoc, beginDate:newBeginDate, endDate:newEndDate, properties}, tenantId)` between the date/taxId validation (after 2057) and the write (2158).

### H10. E9 re-import steals a Property from its existing building and double-counts its expenses across two buildings
- **Root cause:** `services/api/src/managers/buildingmanager.ts` — by-ATAK `Property.findOne({realmId, atakNumber})` (1495-1498) is realm-scoped not building-scoped; `property.buildingId` reassigned UNCONDITIONALLY (1575, not forceOverwrite-gated); a fresh unit is pushed onto the new building (1634-1647) while building A keeps its orphan unit (no cleanup). The manual addUnit path guards exactly this at 1948-1963 ("Otherwise rent computation walks both buildings and double-bills").
- **Impact:** double-count. A re-imported E9 whose street1 misses all three address matchers (1182-1223) creates building B; the property is then referenced by units in both A and B. `_aggregateOwners` counts it in both (unitCount/buildingCount inflated) and per-building expense breakdown bills the koinochrista twice.
- **Minimal fix:** before reassigning `buildingId`/pushing the unit (1575/1634), run the addUnit guard (`Building.findOne({realmId,'units.propertyId': propertyId})` → refuse or `$pull` the prior unit from the old building).

### H11. Fixed-allocation expense with top-level `amount===0` is billed by the rent engine + counted by the dashboard, but DROPPED from the building Expenses breakdown tile
- **Root cause:** `services/api/src/businesslogic/tasks/1_base.ts:337-338` (`const total = Number(expense.amount)||0; if (total<=0) continue;`) has no fixed-allocation exemption, unlike the money engine (475), the materialiser (buildingmanager.ts:3959-3961), and the dashboard gap-fill (4362-4366) which all special-case `allocationMethod==='fixed' || amount>0`.
- **Impact:** blank-render / surfaces disagree. A fixed expense with amount=0 + customAllocations (canonical config, accepted by validators.ts:393-419) bills the tenant €40 (rent table/receipt PDF) and is counted on the dashboard, but the renter row (every term) and owner-billed row (any term lacking a persisted ledger row) vanish from the Overview/Expenses breakdown — the materialiser's own comment (3949-3958) names "the breakdown panel" as a surface that MUST agree.
- **Minimal fix:** skip only when `total <= 0 && (expense.allocationMethod||'equal') !== 'fixed'` at 1_base.ts:337-338.

### H12. Bulk rent-notice selection survives month navigation and sends the PREVIOUS month's documents
- **Root cause:** `webapps/landlord/src/pages/[organization]/rents/[yearMonth]/index.js:282` holds `rentSelected` with no reset on `yearMonth` change (only cleared on send success, 284-286). Month navigation (RentOverview.js:99-100 router.push to the same `[yearMonth]` route) does not remount the page; rows re-tick by occupant `_id` (RentTable.js:666-668; frontdata.ts:345), and the send payload carries the stale captured `terms` (index.js:160), which the server honors over `defaultTerm` (emailmanager.ts:189).
- **Impact:** wrong-money document. Select 3 tenants on April, navigate to May, click Send → April invoices/notices are emailed while the May grid is displayed.
- **Minimal fix:** `useEffect(() => setRentSelected([]), [yearMonth])` in `Rents` (or have the server derive term from request year/month, ignoring client `terms`).

### H13. Accounting CSV settlements: no incoming/outgoing filter + unsorted `lastRent` final-balance + strict date parse emitting "Invalid date" (un-audited export, ships wrong money on the filed document)
- **Root cause:** `services/api/src/managers/accountingmanager.ts` — `_settlements` (290 `tenants.map`) has NO `incoming`/`outgoing` filter (contrast 178/226), so it includes unrelated tenants; `_outgoingTenants` final-balance uses `lastRent = rents[length-1]` (241) from a `$filter` that preserves insertion order (137-144) with no term sort, so "Final balance" can be computed from an arbitrary month; payment dates are strict-parsed `moment.utc(date,'DD/MM/YYYY',true)` (322, 365) → a legacy non-zero-padded date (`5/6/2026`) emits `"Invalid date"` / `null` into the CSV cell.
- **Impact:** wrong-money / wrong-render on the accountant's filed export.
- **Minimal fix:** filter `_settlements` to the intended set (or document the breadth); sort `tenant.rents` by `term` before taking `lastRent`; loosen the date parse to accept un-padded `D/M/YYYY` (or pre-normalize stored dates).

---

## MEDIUM

### M1. Owner-payment partial-commit across buildings: a mid-save 409 leaves building #1 paid while the UI reports total failure; a CUSTOM partial-slice retry double-pays
- **Root cause:** `ownermanager.ts:787-801` saves touched buildings sequentially with no transaction (comment 764-771 admits the "v1" partial-commit edge); `OwnerPaymentDialog.js:206-238` tracks commits per-draft (push only on resolve), so a single cross-building draft that 409s skips the "Some payments recorded" branch and re-posts the whole draft on retry. The custom-mode cap (695) is recomputed from fresh outstanding, so an exact settle 422s safely but a PARTIAL slice re-applies.
- **Impact:** wrong-reported-state (auto/exact) → double-count (custom partial). 
- **Minimal fix:** wrap the per-building saves in a mongo session/transaction, OR have the server return a partial-commit signal the client surfaces (and force re-derive from fresh outstanding before retry).

### M2. Thousandths calc-basis tooltip prints the MANAGED-unit denominator while the billed share uses the FULL-building denominator → `part ÷ whole × total ≠ share`
- **Root cause:** `services/api/src/businesslogic/tasks/1_base.ts:171-174` (`_shareBasis` reduces `whole` over `managed` units only, 146) vs engine 489/496/503 (reduces over ALL `building.units`). Rendered at BuildingExpensePanel.js:707-713.
- **Impact:** blank-render / self-contradictory equation when a building has an unmanaged unit carrying thousandths (addUnit allows it, 1897-1929). Billed amount is correct.
- **Minimal fix:** make `_shareBasis`'s thousandths `whole` reduce over `building.units` (the full set), matching the engine denominator.

### M3. Payment-dialog allocation preview omits the VAT owed line for VAT-rated tenants → "Total owed" understates the balance and VAT can't be targeted
- **Root cause:** `webapps/landlord/src/utils/paymentAllocation.js:115` reads `rent.vat`/`rent.vats`, which the frontdata shape does not expose — it only has `vatAmount` (frontdata.ts:197-209). The server `_computeOwedLines` does emit the VAT line (rentmanager.ts:169).
- **Impact:** wrong-render on the AllocationBlock preview + missing VAT row in Specific/Custom mode for commercial leases (auto-spread still works server-side).
- **Minimal fix:** read `rent.vatAmount` in `computeOwedLines` (or add `vats`/`vat` to `toRentData`).

### M4. Pie "Receipts" (Εισπράξεις) vs "Owed" (Οφειλές) on inconsistent bases → Receipts can exceed Owed and the colored arcs undercount
- **Root cause:** `webapps/landlord/src/components/dashboard/MonthFigures.js:416-422` (`totalDue` = baseRent+charges+building, excludes VAT/debts/balance) vs 423 (`totalPaid` = `rent.total.payment`, includes everything; 7_total.ts:52-57). The colored arcs use `paidByBucket` which drops vat/previousBalance/extracharge (dashboardmanager.ts:90-95,150).
- **Impact:** wrong/misleading render whenever a tenant pays VAT or a carried previous-balance.
- **Minimal fix:** compute `totalDue` and `totalPaid` on the same category basis (either both include VAT/debts/balance, or net them out of both).

### M5. Dashboard rent bar over-reports `notPaid` for a month settled by overpayment carry-credit
- **Root cause:** `services/api/src/managers/dashboardmanager.ts:448-451` — `tenantMonthDue = tenantDue - tenantBalance` reconstructs the gross bill when `tenantBalance` is negative (a credit), but the carry-credit is never added to `tenantPaid`. `_isSettledByCarryForward` is applied to `topUnpaid` (357) but NOT this aggregator.
- **Impact:** wrong-money. A month covered by a prior overpayment shows phantom `notPaid` = the credit while `/rents` shows it paid; clicking the bar routes to a notpaid list that doesn't contain the tenant.
- **Minimal fix:** clamp the credit out of `tenantMonthDue` for negative-balance terms (or apply `_isSettledByCarryForward` to the revenues aggregator).

### M6. `totalYearRevenues` headline KPI counts VAT/deposit/previous-balance/extra-charge payments as revenue (un-audited Overview tile, same class as M4)
- **Root cause:** `services/api/src/managers/dashboardmanager.ts:282-289` sums every `payment.amount` in the year with no allocation-category filter.
- **Impact:** wrong-money on the headline revenue number (over-counts).
- **Minimal fix:** sum only rent/charge allocation categories (reuse the `_computePaidByBucket` category exclusion), so the KPI matches the pie "Owed" basis.

### M7. Owner-expense `paid`-flag concurrent write has no retry budget (asymmetry with rent-rebuild)
- **Root cause:** `setOwnerExpensePaid` / `payOwner` / `updateExpense` all mutate `building.ownerMonthlyExpenses[]` under `optimisticConcurrency`; the paid-flag save (buildingmanager.ts:~2918-2925) has no `withVersionRetry` wrapper, unlike the rent-rebuild paths.
- **Impact:** reject-valid. Two concurrent paid-flag toggles (or the documented test-account double-write): one 409s and is reported as a generic failure.
- **Minimal fix:** wrap `setOwnerExpensePaid`'s save in the same bounded optimistic-lock retry the building-rebuild paths use. **(UNVERIFIED — needs read of the exact save call for a retry wrapper.)**

### M8. Payment write vs sibling/building recompute `__v` race: payment has a one-shot 409, recompute retries 8× → valid payment rejected
- **Root cause:** `rentmanager.ts:765` captures stale `occupant.__v`, commits with a single `findOneAndUpdate({__v})` (1235-1243), throws 409 with no retry (1245-1250); sibling recompute retries 8× (occupantmanager.ts:285-403) and wins.
- **Impact:** reject-valid (user-recoverable by manual retry).
- **Minimal fix:** give the payment write the same bounded optimistic-lock retry (re-read + re-run payTerm + re-commit).

### M9. `bulkExpressPayment` fans out concurrent `__v`-guarded writes with no per-tenant uniqueness guard
- **Root cause:** `rentmanager.ts:484-502` (no tenantId-uniqueness check) + 625-628 (concurrent `Promise.allSettled`) + 1245-1250 (no retry). Two items for the same tenant race; one valid payment is dropped (`failed:true`). **API-only** — the shipped dialog emits one item per tenant.
- **Minimal fix:** reject duplicate tenantIds in the batch validation loop (484-502), or serialize same-tenant items.

### M10. Bulk selection not reconciled against the refetched rent list after a payment status flip
- **Root cause:** `RentTable.js`/parent — no `useEffect` prunes `rentSelected` against current `rents` after a row-payment refetch; the master-checkbox ternary (653-657) mis-renders when `selected.length > selectableRentNum`.
- **Impact:** stale tenant included in a subsequent bulk send + visibly wrong select-all box. (No money written.)
- **Minimal fix:** prune `selected` to the intersection with current `rents._id` on refetch; clamp the checkbox comparison to currently-visible selected rows.

### M11. Owner-statement PDF and `emailmanager` term-pairing fragilities
- **`emailmanager.send`/`sendSmsOnly` positional `$in` mismatch:** `emailmanager.ts:157-160` queries `find({_id:{$in:tenantIds}})` (unordered) but reads `terms[index]` by result position (189, and SMS 132). Harmless while `terms[]` is homogeneous (current UI), but a heterogeneous bulk-send pairs a tenant with another's term. **Fix:** build a `_id → original-index` map and read `terms[thatIndex]`.
- **Owner-statement PDF `subTerms.startsWith`** (owner_statement/index.js:49-50): a 2-digit user term input would mis-match; term-expansion isn't validated. **Fix:** validate term length before prefix match.

---

## LOW

- **L1. E9 bare-ownership/usufruct (`rightType` code 2/3) billed identically to full owners.** `rightType` is parsed (e9parser.ts:544-559) and persisted (buildingmanager.ts:1640-1646) but read by ZERO money code; the owner-billing engine (1_base.ts:298/368) never branches on it. A vacant bare-owner unit with `chargeOwnerWhenVacant` is billed common expenses the bare owner doesn't legally owe. **Fix:** add a `rightType`-aware branch at 1_base.ts:298/368.
- **L2. Repair/owner-expense with `chargeTerm` day≠01 vanishes from the dashboard rollup.** `validators.ts:99-108` accepts any 10-digit term; `dashboardmanager.ts:639-654` seeds `termToKey` only at `YYYYMM0100` and `if(!bucket)continue` drops it. API-only (UI emits day-01). **Fix:** normalize `chargeTerm` to `YYYYMM0100` in addRepair/updateRepair (mirror expense `startTerm` normalization at buildingmanager.ts:2999).
- **L3. Mid-batch E9 import failure rolls back created Building/Property but not already-recomputed tenant rents.** `buildingmanager.ts:1676-1678` persists rents per building inside the try; catch (1802-1829) deletes only Property/Building. On a re-import into an existing building with tenants, those tenants keep post-import rents while the buildings are deleted. **Fix:** snapshot affected tenants' `rents[]` before recompute and restore in the catch, or defer all recompute persistence until the batch succeeds.
- **L4. Single-payment auto-spread leaves a phantom owed line = discount after a full-balance payment.** Same omitted-discount root cause as H1, on the regular PATCH path (`_computeOwedLines` 103-189 + client `paymentAllocation.js:43-139`). Display/attribution only — balance/paid-status are correct. **Fix:** same as H1 (net the discount in owed-line construction).
- **L5. Owner-row persisted `amount` vs grafted live `basis` can disagree** for an out-of-window term whose divisor changed (buildingmanager.ts:2739/2787 persisted amount vs 2792-2794 live basis). Display-only. **Fix:** null the grafted basis when `basis.share != rowAmount`, or recompute the term's rows on read.
- **L6. Owner "Outstanding" / co-owner split rendered with browser locale + hardcoded EUR** (`OwnerListItem.js:130-133`; `owners/[id].js:157-160`) while every sibling value uses `NumberFormat`/`useFormatNumber` (org locale + org currency). Wrong grouping/symbol on a non-el-GR browser; wrong currency symbol on a non-EUR realm. **Fix:** replace the raw `Intl.NumberFormat(undefined,{currency:'EUR'})` with `<NumberFormat>`.
- **L7. Accounting owners search matches `taxId` case-sensitively/un-normalized** (`accounting/[year].js:79-84`) while the Owners page normalizes both (owners/index.js:19-26). Same query yields different owner sets across surfaces; a separator-containing taxId fragment hides the owner on the accounting tab. **Fix:** reuse the `norm()` helper for taxId in the accounting filter.
- **L8. Accounting search `.toLowerCase()` on tenant name with no null-coercion** (`accounting/[year].js:94/99/103`) → render-time throw + ErrorBoundary blank if a row has a null name. **Fix:** `String(x ?? '').toLowerCase()` (match owners/index.js).
- **L9. Express settlement operates only on the current filtered/paginated rent page (≤21 rows).** `RentTable.js:645` is fed `chunks[safePageIndex-1]` (List.js:112, pageSize 21); the dialog's eligible set is page-bounded with no "all pages" control and copy that reads month-wide. **Fix:** fetch the full month's eligible rents for the dialog, or warn when arrears span >1 page.

---

## UNVERIFIED — needs live E2E / further read

- **Tenant receipt/invoice PDF body math for discounted/VAT tenants** — `frontdata.ts:128-130` feeds `totalAmount`/`totalToPay = grandTotal` to the EJS `invoicebody` partial; the printed per-line table (consuming `buildingCharges[]`/`preTaxAmounts[]`/`vats[]`) was not traced. If the same undiscounted-owed-line bug (H1) reaches the printed per-line total, the document and recorded cash disagree. Needs a browser/PDF render on a discounted + VAT tenant.
- **Deposit / guaranty money (`guaranty`, `guarantyPayback`)** — appears in the outgoing CSV final-balance (accountingmanager.ts:253-258) and tenant schema but is untouched by the audit. A `guarantyPayback > guaranty`, or a deposit recorded as a `payment` of type deposit, would mis-state finalBalance with zero coverage. Needs a live deposit-refund flow.
- **`el` (Greek) locale completeness for the new owner-source enum labels** (`repair-vacant`, `owner-resident`, `owner-fixed`) and payment `type` strings (`i18n.__(type)`, accountingmanager.ts:367) end-to-end into the CSV/PDF — a missing `el` key prints the raw enum. Needs a render check of each label in the CSV/PDF catalogs.
- **M7 (`setOwnerExpensePaid` retry wrapper)** — the exact save call (~buildingmanager.ts:2918-2925) was not read for a `withVersionRetry`; confirm before fixing.
- **Concurrent paid-flag double-write** producing a generic 409 with no retry — needs a two-writer E2E against the building doc.