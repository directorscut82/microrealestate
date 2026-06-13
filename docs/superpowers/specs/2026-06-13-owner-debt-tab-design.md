# Owner-debt tab (Ιδιοκτήτες / owner καταβολές) — design spec

Status: DRAFT for user review (user away; built from decisions already given this session).
Date: 2026-06-13. Author: agent. Branch: `nas`.

## Why

Owners incur building expenses (vacant-unit shares, owner-portion of repairs,
owner-tracked monthly amounts) but the app has **no way to track what an owner
has actually PAID** against those liabilities — only a per-row `paid` boolean
toggled one row at a time. The user wants a first-class owner-debt surface that
mirrors the tenant rent experience: a top-level page, an owner detail view, and
a payment dialog with full fields + allocation, but for owner-paid expenses
(no rent).

User decisions already locked (this session):
- **Placement:** a top-level page like Tenants (left nav: …Buildings | **Owners**).
- **Model:** reuse `building.ownerMonthlyExpenses` (do NOT create a new
  collection); add owner payments to it.
- **Payments:** full fields + allocation, mirroring the tenant rent payment
  dialog exactly, but only for expenses paid by owners.
- **Settlement lives on this tab** (the building Έξοδα breakdown had its paid
  pill removed in batch 1b).

## What already exists (Step-0 map — verified in code)

Owner liabilities all live in `building.ownerMonthlyExpenses[]`
(`services/common/src/collections/building.ts:239`), one subdoc per
unit-share-per-term, with four `source` values:

| source | meaning | expenseId → | propertyId | writer |
|---|---|---|---|---|
| `expense` | owner-tracked variable monthly amount (typed in MonthlyStatement) | building expense | null | `saveMonthlyStatement` |
| `repair` | owner-borne portion of a repair | repair | null | `_distributeRepairCharge` |
| `vacant` | vacant unit's building-expense share routed to owner | building expense | yes | `_recomputeVacantOwnerCharges` |
| `repair-vacant` | vacant unit's tenant-portion of a repair routed to owner | repair | yes | `_distributeRepairCharge` |

Plus a projection (NOT persisted): `BuildingExpense.ownerAmount` +
`trackOwnerExpense` = the fixed owner-only monthly portion, summed live in the
dashboard (`fixedOwnerProrated`). It is unsettleable today (no row, no paid).

Settlement state today: a `paid` boolean + `paidDate` per row, toggled via
`PATCH /buildings/:id/owner-expense/:ownerExpenseId/paid`
(`buildingManager.setOwnerExpensePaid`). As of commit `6e1fae9a` all four
sources preserve `paid` across their rebuilds.

Tenant payment model being mirrored: `tenant.rents[].payments[]` =
`{date, amount, type, reference, description?, promo?, extracharge?, allocation:[{category, lineKey, amount}]}`.
Allocation engine is shared client/server: `paymentAllocation.js` ↔
`rentmanager._computeOwedLines` (auto-spread oldest-first; specific; custom).
Record route: `PATCH /rents/payment/:id/:term` (replaces the whole payments[]
array, `__v` optimistic lock).

## The gap to close

There is no owner PAYMENT record, no owner-level aggregation across buildings,
no owner detail page, no owner payment dialog. The `ownerAmount` projection
cannot be settled.

## Proposed design

### 1. Data model — owner payments on the ledger

Add a `payments[]` array to `OwnerMonthlyExpenseSchema` (per liability row),
mirroring the tenant payment shape:

```
payments: [{
  date: Date,
  amount: Number,
  type: enum ['cash','transfer','cheque'],   // reuse PAYMENT_TYPES minus levy/import
  reference: String,
  description: String
}]
```

Settlement is then DERIVED: `paidAmount = Σ payments.amount`,
`outstanding = amount − paidAmount`, `paid = outstanding <= 0.005`. The existing
`paid` boolean becomes a derived convenience (kept for the dashboard tile;
recomputed on every payment write). This avoids a parallel truth.

OPEN QUESTION FOR USER: allocation granularity. The tenant model allocates a
payment across MANY owed lines (rent/charges/building/vat). An owner liability
row is a SINGLE charge, so per-row a payment is trivially "this charge". The
"allocation like rent" decision most likely means: at the OWNER level, a single
payment can be split across that owner's MULTIPLE outstanding charges (across
units/terms/buildings). That implies the payment is recorded at owner scope and
allocated down to specific `ownerMonthlyExpenses` rows. Two model options:

- **Option A (owner-scoped payments, recommended):** a payment is recorded
  against an OWNER (memberId/owner identity) with `allocation:[{ownerExpenseId,
  amount}]`; the engine settles oldest-first when allocation omitted. Requires
  resolving owner identity across buildings (units[].owners[].memberId/name).
- **Option B (row-scoped payments):** payments attach to each
  ownerMonthlyExpenses row; "allocation" is just which rows a lump sum covers,
  recorded by splitting at entry time. Simpler; less like the rent dialog.

This is the one decision that materially changes the schema; flagged for the
user. The rest of the design is identical either way.

### 2. Owner identity

Owners are not first-class documents — they live as `units[].owners[]`
(`{type:'member'|'external', memberId, name, taxId, percentage, ...}`). An
"owner" for the page = a distinct owner identity (by memberId when present,
else by name+taxId) aggregated across every unit/building they own. The Owners
list = that aggregation; each owner's outstanding = Σ unpaid
ownerMonthlyExpenses across their units.

### 3. API

- `GET /owners` — aggregated owner list (name, taxId, # units, total
  outstanding, # buildings). Server-paginated like `/tenants`.
- `GET /owners/:ownerKey` — one owner: their units, their ledger rows grouped
  by building/term, their payment history.
- `PATCH /owners/:ownerKey/payment` (or per-row) — record a payment with
  allocation, mirroring `PATCH /rents/payment/:id/:term` semantics (replace
  payments, `__v` lock). Recompute derived `paid`/`paidAmount`.

### 4. UI — mirror the tenant surface

- Top-level **Owners** page (`pages/[organization]/owners/index.js`) — list with
  occupancy/status pills (owner who ALSO rents a unit gets a pill, per the
  user's note), search + filter chips (has-outstanding / settled), reusing the
  `ResourceList` shell.
- Owner **detail** page (`owners/[id].js`) — owner info + ledger table grouped
  by building/term + payment history, side cards mirroring
  RentOverviewCard/ContractOverviewCard.
- **Payment dialog** — a parallel of `components/payment/` (PaymentTabs +
  AllocationBlock) but for owner charges: fields date/amount/type/reference/
  description + allocation across the owner's outstanding rows.
- Shared: a `useFetchOwners`/restcalls additions; a `QueryKeys.OWNERS` key.

### 5. Overview wiring (the user's "extra stuff on episkopisi")

- Building Επισκόπηση: the owner paid/unpaid progress tile already exists and is
  correct as of batch 1; verify its numbers now derive from
  `Σ payments` not just the boolean once payments land.
- Global/main dashboard: add the esoda/eksoda + progress-bar treatment the user
  asked for (right side, bars underneath). Scope TBD with user.

## Testing

- jest: owner aggregation, payment settlement math (oldest-first + allocation),
  derived paid recompute, paid-survives-rebuild (extends 49.x).
- e2e (NAS): Owners list renders + pills; record an owner payment via the
  dialog → mongo readback confirms payments[] + derived paid; Overview tile
  moves by the paid amount. Non-vacuous (assert the positive + the delta).
- Adversarial refute every sub-batch before deploy (standing rule).

## Risk / sequencing

This is multi-day. Suggested sub-batches, each its own spec→plan→ship→verify:
1. Owner payments model + settlement engine + API (no UI) — jest-provable.
2. Owners list page + pills.
3. Owner detail + payment dialog + allocation.
4. Overview extras (global esoda/eksoda + bars).

## Decisions needed from user before build

1. **Allocation model: Option A (owner-scoped, recommended) vs B (row-scoped).**
2. Should the unsettleable `ownerAmount` fixed projection become a real
   materialised ledger row so it can be paid? (Currently it can't.)
3. Global-dashboard Overview scope (what exactly goes "on the right + bars").
