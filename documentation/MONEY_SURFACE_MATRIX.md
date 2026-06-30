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
5. **Step-7 adversarial review** for any change to a money COMPUTATION path (not display-only).
