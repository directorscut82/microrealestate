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

## Locked decisions (user, 2026-06-13)

- **Q1 — Owner-scoped payments + allocation.** A καταβολή is recorded against
  an OWNER and split across that owner's outstanding charges (auto oldest-first
  / specific / custom), mirroring the tenant rent payment dialog exactly.
- **Q2 — Everything settleable.** ALL owner-borne amounts must be payable via
  owner καταβολές — including the fixed `ownerAmount` ("Καταγραφή εξόδων
  ιδιοκτήτη"), which today is a live projection and the ONE owner charge that
  can't be paid. It will be MATERIALISED into a real monthly owner ledger row.
  Repairs included.
- **Q3 — Main landlord dashboard.** Add the esoda/eksoda summary on the right
  with progress bars underneath, across all buildings/tenants. The owner-side
  bar is owner-expenses paid-vs-unpaid driven by καταβολές, mirroring the
  renter bar. ALL expenses including επισκευές.
- **D-9 deferred** (see `documentation/DEFERRED_DECISIONS.md`): receipt-driven
  both-sides settlement (a PDF receipt fanning "paid" to both owner AND renter
  shares) is OUT of scope — the receipt flow is structurally disjoint
  (`Bill.status` flip only, RF-code matched, no expense linkage) and the renter
  side has no per-charge paid field. Owner καταβολές are built standalone; a UI
  TODO marker points to D-9.

## Proposed design

### 1. Data model — owner payments on the ledger

Add a `payments[]` array to `OwnerMonthlyExpenseSchema` (per liability row),
mirroring the persisted tenant payment shape:

```
payments: [{
  date: Date,            // stored DD/MM/YYYY like rents, or Date — match rents
  amount: Number,
  type: enum ['cash','transfer','cheque'],   // PAYMENT_TYPES minus levy/import
  reference: String,
  description: String
}]
```

Settlement is DERIVED, not stored as truth: `paidAmount = Σ payments.amount`,
`outstanding = amount − paidAmount`, and the existing `paid` boolean +
`paidDate` are RECOMPUTED from payments on every write (kept so the dashboard
tile + breakdown read a simple flag). One source of truth = the payments array.

**Owner-scoped recording with allocation (Q1).** A payment is entered against
an owner and carries `allocation:[{ownerExpenseId, amount}]` resolving to
specific `ownerMonthlyExpenses` rows (across the owner's units/terms/buildings).
When allocation is omitted, the server auto-spreads oldest-term-first across the
owner's outstanding rows — mirroring `rentmanager._computeAutoSpreadLines`.
The payment objects are pushed onto the matched rows' `payments[]` (each row
records the slice allocated to it), so the per-row derived `paid` stays correct
and the building document remains the single home (no new collection).

Carry-forward note: all four owner sources already preserve `paid` across their
rebuilds (commit `6e1fae9a`). The `payments[]` array must likewise be carried
forward by every rebuild (`_recomputeVacantOwnerCharges`,
`_distributeRepairCharge`, `saveMonthlyStatement`, and the new ownerAmount
materialiser) — same snapshot-by-(expenseId|propertyId|term) pattern, extended
to carry `payments` not just `paid`. This is a load-bearing invariant; the
adversarial gate must probe payment-loss-on-rebuild.

### 2. Materialise the fixed ownerAmount (Q2)

A new recompute (or an extension of `_recomputeVacantOwnerCharges`) writes, for
each active month, a `source:'expense'` owner ledger row of `amount =
expense.ownerAmount` for every expense with `trackOwnerExpense && ownerAmount>0`
— so the fixed owner portion becomes a real, payable, settleable charge instead
of a display-only projection. The dashboard's `fixedOwnerProrated` projection is
then REMOVED (it would double-count once the rows exist) and the dashboard reads
the materialised rows like every other owner charge. Idempotent strip+rebuild,
carrying `paid`/`payments` forward.

### 3. Owner identity

Owners live as `units[].owners[]`
(`{type:'member'|'external', memberId, name, taxId, percentage, ...}`). An
"owner" for the page = a distinct identity (by memberId when present, else
name+taxId) aggregated across every unit/building they own. An owner's
outstanding = Σ (charge.amount − Σ charge.payments) across their units' ledger
rows. Co-ownership (percentage) is a display concern for v1 (the ledger row's
amount is the unit's whole owner share; per-owner % split is a follow-on if the
user wants it).

### 4. API (mirror the rents router)

- `GET /owners` — aggregated owner list (name, taxId, # units, # buildings,
  total outstanding, total paid). Server-paginated like `/tenants`.
- `GET /owners/:ownerKey` — one owner: units, ledger rows grouped by
  building/term, payment history, occupancy (does this owner also RENT a unit →
  pill).
- `POST /owners/:ownerKey/payment` — record an owner payment with allocation,
  mirroring `PATCH /rents/payment/:id/:term` semantics (`__v` optimistic lock;
  recompute derived paid). Owner-scoped; the handler fans the allocation onto
  the right buildings' `ownerMonthlyExpenses[].payments`.

### 5. UI — mirror the tenant surface

- Top-level **Owners** page (`pages/[organization]/owners/index.js`) — list with
  occupancy/status pills (owner who ALSO rents a unit gets a pill, per the
  user), search + filter chips (has-outstanding / settled), reusing the
  `ResourceList` shell exactly like `tenants/index.js`.
- Owner **detail** page (`owners/[id].js`) — owner info + ledger grouped by
  building/term + payment history; side cards mirroring
  RentOverviewCard/ContractOverviewCard.
- **Payment dialog** — a parallel of `components/payment/` (PaymentTabs +
  AllocationBlock) for owner charges: date/amount/type/reference/description +
  allocation across the owner's outstanding rows (auto/specific/custom). A
  shared allocation util mirroring `paymentAllocation.js` keyed by
  `ownerExpenseId`.
- Shared: `restcalls.js` additions (`fetchOwnersPage`, `fetchOwner`,
  `payOwner`), a `QueryKeys.OWNERS` key.

### 6. Overview wiring (Q3)

- **Main landlord dashboard** (the landing dashboard): add an esoda/eksoda
  summary on the right with progress bars underneath — rent collected vs owed
  (renter), and owner-expenses paid vs unpaid (driven by καταβολές), across all
  buildings/tenants. Mirror the renter bar's computation for the owner bar. ALL
  expenses incl. repairs.
- **Building Επισκόπηση**: the owner paid/unpaid tile already exists; once
  payments land, its `ownerPaid`/`ownerUnpaid` derive from `Σ payments` (the
  derived paid recompute), not the lone boolean. Verify the numbers.

## Testing

- jest: owner aggregation; allocation settlement math (auto oldest-first +
  specific + custom); derived `paid`/`paidAmount` recompute; **payments survive
  every rebuild** (extends 49.5/49.7 to cover payments, not just the flag);
  ownerAmount materialisation is idempotent + carries payments.
- e2e (NAS): Owners list renders + pills (owner-who-rents); record an owner
  payment via the dialog with a specific allocation → mongo readback confirms
  the slice landed on the right row's `payments[]` + derived paid; main
  dashboard owner bar moves by the paid amount (value-delta, non-vacuous).
- Adversarial refute every sub-batch before deploy (standing rule).

## Risk / sequencing — sub-batches, each spec→plan→ship→verify

1. **Owner payments model + settlement engine + ownerAmount materialiser + API**
   (no UI) — jest-provable, the riskiest money logic; ships + verifies first.
2. **Owners list page + pills.**
3. **Owner detail + payment dialog + allocation** (mirror rent dialog).
4. **Main dashboard esoda/eksoda + owner paid/unpaid bars.**

## Follow-ons (explicitly deferred)

- D-9 receipt-driven both-sides settlement (see DEFERRED_DECISIONS.md).
- Per-owner percentage split of a co-owned unit's share (v1 attributes the
  whole unit owner-share to the unit; co-owner % is display-only).
