# Money-Surface Validation Matrix

> **Why this exists** (user, June 2026): "I don't know how many times when you change money surfaces, ALL THE TABS WHICH TOUCH MONEY CAN BE AFFECTED AND NEED TO BE CHECKED/VALIDATED/TESTED." When you change anything that computes or displays money, walk this matrix: every surface that reads the changed field must be re-checked (render + value) and the relevant spec re-run on live NAS.

## The shared money concepts

| Concept | Server source of truth | Notes |
|---------|------------------------|-------|
| Tenant rent + building charges | `tenant.rents[].buildingCharges[]`, `preTaxAmounts`, `charges`, `discounts`, `debts` (`rentmanager` / `frontdata.toRentData`) | `charges` (Δαπάνη επί ενοικίου) is OMITTED from receipts, INCLUDED in rent-calls |
| Tenant owed / collected (YTD) | `building.tenantRentYTD {collected, owed}` | per-building rollup |
| Owner liabilities | `building.ownerMonthlyExpenses[]` (`source` ∈ expense / owner-fixed / vacant / owner-resident / repair / repair-vacant / credit) | each row: `amount`, `paidAmount`, `outstanding`, `paid`, `payments[]`, `coOwners[]` |
| Owner statement (derived) | `common/OwnerStatement.buildOwnerStatement()` | the SINGLE owner-money function; PDF + owner detail + accounting all go through it |
| ΧΡΕΩΣΕΙΣ per-unit breakdown + calc basis | `computeBuildingExpenseBreakdown` + `getExpenseBreakdown` route (`buildingmanager`) | the `basis` object (`equal`/`surface`/`thousandths`/`repair_split`/`repair_vacant`/…) |
| Αχρέωτα (uncollected) | `building.uncollected {total, paidTotal, outstanding}` + `uncollectedPayments[]` | vacant-unit shares billed to nobody; subdoc-only |

## Surfaces that READ money — re-check ALL that read a field you changed

| Surface | File | Reads | React Query key(s) |
|---------|------|-------|--------------------|
| Building Overview (Ετήσια προβολή, ΑΠΟ ΑΡΧΗΣ, ΑΚΑΛΥΠΤΑ, Επισκευές tile) | `components/buildings/BuildingDashboard.js` | ownerMonthlyExpenses, tenantRentYTD, uncollected, repairs | `[BUILDINGS, id]` |
| Building Έξοδα tab (Μηνιαία Καταχώρηση + ΧΡΕΩΣΕΙΣ breakdown) | `components/buildings/BuildingExpensePanel.js` | monthlyCharges, breakdown rows + `basis` | `[BUILDINGS, id]`, `['expense-breakdown']` |
| Building expense list / repairs | `ExpenseList.js`, `RepairList.js` | expenses, repairs | `[BUILDINGS]`, `[BUILDINGS, id]` |
| Property «Έξοδα ακινήτου» card | `components/properties/PropertyExpensesCard.js` | per-property expense lines (`useFetchPropertyExpenses`) | property-expenses |
| Owner list | `components/owners/OwnerList.js`, `OwnerListItem.js` | totalOutstanding | `[OWNERS]` |
| Owner detail (ΧΡΕΩΣΕΙΣ ledger + payments) | `pages/[organization]/owners/[id].js` | buildOwnerStatement charges (`amount`/`paidAmount`/`outstanding`/`coOwners`) | `[OWNERS, ownerKey]` |
| Owner payment dialog | `components/owners/OwnerPaymentDialog.js` | owner charges | `[OWNERS]` |
| Main dashboard — rent chart | `components/dashboard/MonthFigures.js`, `YearFigures.js` | rent paid/owed per month + breakdown | `[DASHBOARD]` |
| Main dashboard — owner-expense chart (tooltip breakdown) | `components/dashboard/ExpensesYearFigures.js` | dashboardData.expenses + per-owner breakdown | `[DASHBOARD]` |
| Accounting — tenant settlements (xlsx) | `components/accounting/TenantSettlements.js` + `accountingmanager.settlementsAsXlsx` | per-month paid/owed | `[ACCOUNTING]` |
| Accounting — owner settlements (xlsx) | `components/accounting/OwnerStatements.js` + `accountingmanager` owner xlsx | per-month owner paid/owed | `[ACCOUNTING]` |
| Rents grid + payment | `pages/.../rents`, `RentTable.js`, `RentDetails.js`, `RentOverview.js`, `payment/*` | rent totals, allocation | `[RENTS]` |
| Tenant detail | `pages/[organization]/tenants/[id].js`, `tenants/RentOverviewCard.js` | rent + buildingCharges | `[TENANTS]` |
| Receipt PDF (ΑΠΟΔΕΙΞΗ) | `pdfgenerator/templates/invoice.ejs` + `data/invoice` | rent.buildingCharges (+ basis, item 6) | n/a (server render) |
| Owner statement PDF | `pdfgenerator/templates/owner_statement.ejs` + `data/owner_statement` | buildOwnerStatement charges (+ basis, item 6) | n/a |

## Write-side: mutations and what they MUST invalidate

Every money mutation must invalidate the keys for the surfaces above. The established set (see `RepairList._invalidateAllRepairDependents`, `ExpenseList`, `BuildingExpensePanel`):

```
[BUILDINGS, id], [BUILDINGS], [RENTS], [DASHBOARD], [TENANTS],
['expense-breakdown'], [OWNERS], [ACCOUNTING]
```

| Mutation | File | Must invalidate |
|----------|------|-----------------|
| Add/edit/delete expense | `ExpenseList.js` | full set |
| Add/edit/delete repair | `RepairList.js` | full set |
| Save monthly statement (variable amounts) | `BuildingExpensePanel.js` | full set |
| Owner payment (καταβολή) | `OwnerPaymentDialog.js` | `[OWNERS]`, `[BUILDINGS,id]`, `[DASHBOARD]`, `[ACCOUNTING]` |
| Set owner-expense paid flag | `setOwnerExpensePaid` (server) | refetch building |
| Uncollected coverage payment | `UncollectedPaymentDialog.js` | `[BUILDINGS,id]`, `[DASHBOARD]` |
| Tenant rent payment | `payment/PaymentTabs.js` | `[RENTS]`, `[DASHBOARD]`, `[TENANTS]` |

## Re-test checklist (run on a money change)

1. **Build**: `yarn workspace @microrealestate/landlord build` (dev server misses compile errors).
2. **jest** (node@20): `services/api` suite green — proves no backend money-path regression.
3. **Playwright money specs** on live NAS (serial): `49_vacant_owner_money`, `54_repair_vacant_flag_credit`, `56_uncollected_coverage_payment`, `48_building_expense_panel`, `50_owner_expenses_paid_tile`, `58_settlements_xlsx_owed_strip`, `61_breakdown_ownerbilled_dedup`.
4. **Render-review** (Greek, `/landlord/el/...`) every surface in the table above that reads the field you touched — value AND layout.
5. **For any change to a PDF or xlsx: generate the REAL artifact from live data and READ it.** A green unit suite and a static-HTML mock are NOT enough — the July 2026 PDF-basis work shipped two arithmetically-false equations that only a real generated PDF exposed («100 € ÷ 4 = 33,33 €» and «100 € × 50% = 25,00 €»). Owner-statement PDF: `GET /api/v2/documents/owner-statement/:ownerKey/:term`; tenant receipt: `GET /api/v2/documents/invoice/:tenantId/:term` (both via the authenticated gateway).
6. **Step-7 adversarial review** for any change to a money COMPUTATION path (not display-only).

## Standing invariants

### An ABSENT representation hides money as effectively as a wrong number

When you ask "does any surface show this wrong?", also ask **"is there any surface that CAN show it at all?"** A quantity with no field, no enum value, and no query that selects it is invisible — and invisible reads as correct on every screen. The 2026-07 bill-OCR audit found overpayment (Σ(receipts) > owed) had *no representation anywhere*:

- `bill.status` enum is exactly `['pending','partial','paid']` (`bill.ts:32-38`) — no overpay value existed.
- the dashboard **clamped** it away: `Math.max(0, total - paidSoFar)` (`dashboardmanager.ts:974`).
- **two** queries filter `status: {$in:['pending','partial']}` (`dashboardmanager.ts:929`, `billmanager.ts:1143`), so an overpaid bill (now `'paid'`) *disappeared from both* the dashboard tile and the receipt-candidate list.

Net effect: a receipt matched to the WRONG bill, or an amount typed with a slipped decimal, rendered as a clean payment on every surface. The three shapes to grep for on any money change:

1. **`Math.max(0, …)` / `Math.min(…)` clamps** — a clamp is a deliberate decision to discard a signed quantity. Confirm the discarded direction is truly impossible, not merely unrepresented.
2. **`status: {$in: [...]}` (and any enum-membership filter)** — enumerate EVERY such query before adding a state. In this codebase: `dashboardmanager.ts:929`, `billmanager.ts:1143`, `billmanager.ts:1371`, `buildingmanager.ts:4685`. A new enum value is silently excluded from all of them.
3. **A total with no signed counterpart** — if `remaining` can go negative but nothing reads the negative branch, the excess is being dropped.

Rules that follow:

- **Derive, never persist.** Persisting an excess (or any restatement of existing arithmetic) creates a second source of truth that will drift. Compute it at read/response time.
- **Do not add an enum value to represent it.** See (2) — the cure is worse than the disease.
- **Report at the moment it is created**, where the operator still has the context to act (for overpay: `confirmPayment`, where they are still looking at the receipt they matched).
- **Flag, don't refuse.** Dropping money the landlord actually paid is worse than recording it visibly and flagging it. Same rule the receipt dedup guard follows.
- **Tolerances are DIRECTIONAL.** The `+0.005` that makes `99,995` count as `100,00` is a SHORTFALL tolerance. Reused in the excess direction it fires on `33,34+33,34+33,33 = 100,01` — the ordinary artifact of splitting an odd total across installments, not a mis-match. Pick the threshold per direction, and per the *class of error* you're catching (wrong bill / slipped decimal are euros, not cents).

### Idempotency keys must contain ONLY fields the source document carries

Three separate 2026-07 audit findings were this one bug in three places (receipt dedup, bill dedup, rename backfill). The failure mode is always the same: a dedup/identity key includes a field the **server defaults**, so two submissions of the same physical document produce two different keys → the same money is recorded twice → a total silently crosses a threshold (`partial` → `paid`).

- **Never key on a server-defaultable field.** `mkReceipt` defaults `date` to the server clock, so *every* retry got a fresh stamp — not just one crossing midnight. Identity is the proof (`proofUrl`, else `ocrText`), i.e. something the document itself carries.
- **For every server-defaulted field, there must be a test that OMITS it.** A suite that always passes `date` cannot see this class of bug. Omission is the test case.
- **Proximity, not interval overlap, discriminates physical-document identity.** Two bills for the same service are the same physical bill if their `periodEnd` are within ~10 days; billing intervals routinely overlap between genuinely different bills.
- **A description-keyed identity must be re-keyed AT RENAME TIME, while the old name still exists.** Once the rename lands, the link to the old key is unrecoverable. (The 2026-07 fix site: `buildingmanager.ts:3016-3035` + the strip at `:3054-3061`.)
- **Ask which DIRECTION a "safer" dedup fails in.** Tightening a dedup makes it drop real money; loosening it double-counts. Dropping is worse — it is silent and unrecoverable, while a double-count is visible on the ledger.

### `moment(undefined)` is NOW — an unguarded date parse converts a loud failure into a silent lie

A locale/format swap at a site with no validity guard doesn't throw; it yields the current date and the money lands on the wrong term. Any `moment(x)` on external input needs `moment.utc(x, FORMAT, true)` (strict) plus an `isValid()` branch. See also the timezone section in `CLAUDE.md` — mixing `moment()` and `moment.utc()` in one comparison is the same class of defect.

### Dual-role: a person can be BOTH a tenant AND an owner

The same person (keyed by `name+ΑΦΜ` or `memberId`) can simultaneously **rent** unit X (an `Occupant` record) and **own / co-own** unit Y (`building.units[].owners[]`). "renter" and "owner" are roles, NOT mutually-exclusive identities. Audited July 1 2026 (4-dimension workflow + adversarial verify: 19 findings / 0 real). The invariant holds because:

- **Recipient is decided PER-UNIT, PER-TERM — never per-person.** `1_base.ts` `computeBuildingExpenseBreakdown` does `recipient = unit.tenant ? 'renter' : 'owner'`, and `unit.tenant` is re-derived for each term by **propertyId** occupancy before the breakdown runs (`getExpenseBreakdown` nulls it for un-occupied units; the 12-month rollup sets it per-term from `_occupiedFromOccupancyRows`). Owning unit Y never makes you the owner-recipient of unit X you rent, and renting X never suppresses Y's owner charge.
- **The two ledgers are physically disjoint and never netted.** Rent → `Occupant.rents[]`; owner liabilities → `building.ownerMonthlyExpenses[]`. `netOwnerChargeOutstanding` nets strictly WITHIN the owner ledger (same `expenseId|term|propertyId`), never against rent. A dual-role person correctly gets a tenant receipt for X AND an owner statement for Y — two separate obligations, not a double-count.
- **Owner identity is built only from `units[].owners[]`**, never matched from tenant records. The one tenant↔owner match (`ownermanager._markAlsoRents`) sets a **display-only** «Also a tenant» badge and feeds zero money logic.
- **Occupancy keys (`occupiedPropertyTermKeys`) are `propertyId+term`, not person** — a co-owner who rents a different unit doesn't wrongly mark their co-owned unit occupied.

**Latent caveat (not a live bug):** `unit.tenant` is attached date-blind in `_toBuildingData` and only nulled per-term by the two current breakdown consumers. Any FUTURE consumer of `unit.tenant` for a renter-vs-owner decision MUST re-derive per-term occupancy by propertyId first, or it will misclassify a dual-role person.
