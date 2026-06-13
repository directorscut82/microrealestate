# Deferred product decisions

Findings from the audit waves that are real but deferred for a separate
product / architecture discussion. Each entry includes the concrete
behavior, the EUR/UX impact, and what would need to change.

## D-1 — Mid-month termination billing (lifecycle audit L-6)

**Current behavior.** When a tenant has `terminationDate` set in the
middle of a month (e.g. 2026-06-15), the rent for that month is still
billed in full. Building charges (κοινόχρηστα) for the same month are
also billed in full.

**Why this might matter.**
- Greek lease practice is mixed: many leases bill the full month
  regardless of mid-month exit (the tenant signed for the month);
  others pro-rate.
- The audit (3-skeptic majority) flagged a 250–400€ "overcharge" per
  terminated tenant — but that label assumes pro-ration is the
  expected answer.

**Why deferred.** Changing this requires:

1. A schema decision: should `terminationDate` clamp `property.exitDate`
   automatically, or be stored separately?
2. A pipeline change: `1_base.ts` currently normalises every term to
   `startOf('month')` (line 321). Pro-ration would need a per-month
   day-fraction multiplier on `preTaxAmount` and possibly on
   `buildingCharges` (the latter is contentious — building expenses are
   monthly fixed costs).
3. UX: should the rent-table row show a "(pro-rated 15/30 days)"
   annotation? Should past frozen rents be re-priced or stay frozen at
   full month?
4. Migration: existing terminated tenants with full-month historical
   bills would need a decision: leave alone, or re-price (would mutate
   historical ledger).

**Hooks the audit identified if we eventually do this.** (line anchors as of
HEAD `4a55ddc4`; code drifts — grep the symbol if a number is off.)
- `services/api/src/businesslogic/tasks/1_base.ts:~705` — the `startOf('month')`
  NOTE block stating proration is not implemented (normalization at ~712).
- `services/api/src/managers/occupantmanager.ts` —
  `property.exitDate` defaults to `tenant.endDate` without considering
  `terminationDate`.
- `services/api/src/managers/occupantmanager.ts` —
  `_syncOccupancyForProperties` (defined ~line 435, called ~1126/1555/1718
  on link/unlink) is only invoked for added/removed properties, not for
  `terminationDate` changes (separate occupancy metric bug; a property
  terminated mid-cycle stays marked `rented` and the dashboard
  `occupancyRate` is inflated).

## D-2 — VAT on κοινόχρηστα (building charges)

**Current behavior.** `4_vats.ts` deliberately skips
`rent.buildingCharges` when applying contract VAT. Comment H6 admits
"whether κοινόχρηστα should carry VAT depends on Greek tax law context
I don't have."

**Why deferred.** This is a tax-law question, not a code question.
κοινόχρηστα billed by the building manager are typically pass-through
reimbursements that don't carry VAT (the manager doesn't add value).
But if the landlord is a company invoicing the tenant directly for
κοινόχρηστα, VAT may apply.

**What's needed.** Confirmation from the user's accountant on the
correct treatment for *their* leases. Then either:
- Apply VAT to buildingCharges in `4_vats.ts` (mirror how `rent.charges`
  is treated), or
- Add an opt-in flag at the building or expense level.

## D-3 — Repair charges flow as `monthly_charge` not `repair` (lifecycle L-3/L-4) — ✅ RESOLVED

**Resolution (June 2026).** `_distributeRepairCharge` now sets `repairId`
on each `unit.monthlyCharges` entry (`buildingmanager.ts`). The pipeline
no longer hardcodes `monthly_charge`: `1_base.ts:820-825` reads
`const _isRepair = !!charge.repairId` and emits `type: _isRepair ? 'repair'
: 'monthly_charge'`. Downstream, `rentmanager.ts:_computeOwedLines`
(formerly `_computeOwedByCategory`) at lines 151-153 does
`const isRepair = c?.type === 'repair'` → `category: isRepair ? 'repair'
: 'buildingCharge'`, so the repair bucket is populated and the dashboard
pie shows the copper "repair" colour. No migration was needed (existing
distributions already carry `repairId`).

## D-4 — Edit of expense `startTerm` after distribution (lifecycle L-9)

**Current behavior.** Editing a one-time expense's `startTerm` from May
to June recomputes June rents (gain charge) but does NOT remove the
charge from May if May is frozen (paid). The tenant is billed twice.

**Why deferred.** Need to decide: should the API refuse the edit, or
allow it with a warning? Both are defensible; both require a UX
decision and a confirmation modal.

## D-5 — Revenue aggregate clamp + balance subtraction interaction (L-10)

**Current behavior.** `dashboardmanager.ts:~425` clamps
`tenantDue = Math.max(0, rent.total?.grandTotal || 0)`. For a month where
overpayment carry-forward made `grandTotal` negative, this clamps to 0. But
`tenantMonthDue = tenantDue - tenantBalance` (~line 448, where
`tenantBalance` is read from `rent.total?.balance`) is computed AFTER
clamping in some paths and produces nonsensical values.

**Why deferred.** The audit suggests storing both `clampedDue` (for the
pie) and `realMonthlyBill` (for revenue calc) separately. That's a
schema change and needs cross-checking with how the bar chart and
yearly aggregates consume it. Worth doing carefully, not as a quick
patch.

---

## D-6 — Tenant search clears on data refetch (spec 03) — RESOLVED

**Status:** Fixed in `49040d15` (June 1 2026). `ResourceList/List.js`'s
init useEffect was removing the user's typed search on every data-reference
change because the parent's effect ran AFTER `SearchFilterBar`'s onMount
effect. The fix removes the init useEffect entirely and lets
`SearchFilterBar`'s existing `useEffect` (deps include `searchText`,
`selectedFilterIds`, `onSearch`) act as the single source of truth — it
fires on mount with current state and re-fires whenever `handleSearch`
identity changes when data lands or refetches. The null-data guard moved
inside `handleSearch` so consumer `filterFn`s don't dereference
`data.rents` when data is `undefined`. Tenants-page `_filterData` was also
normalized to match buildings/properties shape (`if (statuses?.length)
filter else all`).

**Earlier history.** A first attempt at the fix shipped as `fb024ed4`
introduced a race that clobbered the user's search on every data
reference change, breaking 60+ payment dialog tests in suite #7-#10. That
attempt was reverted in `e1fe87d3` to restore dialog tests. The
`49040d15` fix avoids the race by deleting the init effect rather than
trying to feed it current state.

**Anchors (for regression hunting).**
- `webapps/landlord/src/components/ResourceList/List.js`
- `webapps/landlord/src/components/SearchFilterBar.js` lines 92-97

## D-7 — Test bugs in the live Playwright suite

The following tests fail on a working baseline (suite #11, June 1 2026,
133/155 pass). They are test-side bugs, not app bugs. They need to be
re-authored, not "fixed" by changing app code:

- **`spec 15 S36` and `spec 15 S37`** — assert that a date `last day of
  current month` and `5 days into next month` pass the server's F3
  guard. These pass when run near month-end but fail when run on day
  1-22 of the month because the date is ≥7 days away in the FUTURE,
  hitting the "too far in the future" guard. The tests should compute
  the date dynamically against `today + 5d` instead of "month end".

- **`spec 17 C28 · double-clicking Record does not double-fire PATCH`**
  — flaky timing race against the dialog's 80ms `submittingRef` reset.
  Don't tighten the timeout (it has been load-bearing for the entire
  payment dialog flow — see AGENTS.md saga). The test should retry once
  on a 1-PATCH outcome rather than asserting strict 1.

- **`spec 19 L06 · adding a building expense lifts next-rent grandTotal`**
  — test computes the wrong expected delta. `Contract.payTerm` only
  generates rent records up to the requested term; future-month rents
  aren't pre-generated, so PATCH-ing an expense doesn't immediately
  change the next month's `totalAmount` until that month is touched.
  The assertion needs to PATCH the next month explicitly to trigger
  regeneration before reading.

- **16 `spec 19` tests after L06** are listed as "did not run" because
  Playwright runs spec 19 in serial mode and bails on the first failure.
  They are not failing — they just didn't get to execute. Once L06 is
  fixed, the rest of the spec will run.

If a NEW failure appears outside this catalog, treat it as a real
regression and investigate the deployed bundle revision via Portainer
before assuming the test is wrong.

## D-8 — Past-month overpayment does NOT propagate forward (term-based freeze)

**Update (Tier I-1, June 2026, commit `01d48c46`).** The two-regime behavior
this entry previously documented has COLLAPSED. `_isFrozen` was changed from
the old `_isPayment`-based check (frozen ⟺ has a payment/discount/debt/
description) to a purely TERM-based rule:

```
_isFrozen (services/api/src/managers/contract.ts:315):
  future term  → never frozen
  PAST term    → ALWAYS frozen (paid OR unpaid, settled or clean)
  current term → frozen only if fully paid
```

So a downstream PAST month is now frozen REGARDLESS of whether it carries
settlements. The old Regime A ("clean downstream → surplus cascades") no
longer happens for past terms: recording a 600€ payment on a past April
when `April.grandTotal=400` leaves the −200 surplus visible on April's
`newBalance` only — it does NOT flow into May/June even when those months
are clean. (Forward cascade still works for CURRENT/FUTURE unpaid terms,
which are not frozen.)

**Why the current behavior exists (intentional).** The term-based freeze
protects ALL historical rents from being silently re-priced when an
unrelated change cascades through the pipeline. The prior settlement-based
guard let a clean past month get rewritten; the Tier I-1 fix closed that by
freezing every past term unconditionally (the past-unpaid-freeze case is
regression-guarded by `services/api/src/businesslogic/__tests__/contract-freeze-past-unpaid.test.js`).

**Landlord-facing consequence (still a deferred UX choice).** A landlord
who overpays a back month after later months exist sees the surplus
marooned on the touched term as a negative `newBalance`. Applying that
credit forward is a manual step today (a `promo`/`discount` line on a
later term). A "carry the credit forward" affordance remains deferred —
it needs a UX decision (explicit credit-carry button? automatic with
confirmation?) and must not reopen the re-pricing hazard the freeze closes.

**Hooks.**
- `services/api/src/managers/contract.ts:315` — `_isFrozen` function (term-based);
  the guard CALL inside the pay path is ~line 270.
- `services/api/src/businesslogic/tasks/5_balance.ts` — already supports
  negative balance; no change needed there.

## D-9 — Receipt-driven both-sides expense settlement (owner-debt batch, June 2026)

**Current behavior.** The building PDF "payment receipt" flow
(`PaymentReceiptDialog` → `confirmBillPayment` →
`billManager.confirmPayment`, `services/api/src/managers/billmanager.ts:467`)
only flips a standalone `Bill` document's `status` from `'pending'` to
`'paid'`, matched purely by RF code. It is **structurally disjoint** from the
expense ledgers: it does NOT touch `ownerMonthlyExpenses.paid`, the tenant
`monthlyCharges` (which have no `paid` field at all), or any rent payment.
The `Bill` collection (`services/common/src/collections/bill.ts`) references an
expense by `expenseId`/`billingId` but has no hooks and no settlement linkage.

**What the user wants (deferred).** When a κοινόχρηστα bill is split between
renters and the owner and a receipt PDF proves the whole bill is paid, BOTH
the owner-side charge (`ownerMonthlyExpenses`) AND the renter-side share
should be markable paid from that one receipt (or a deliberate one-side
choice).

**Why deferred (out of scope for the owner-καταβολές batch).** Wiring this
needs net-new infrastructure the owner-debt feature does not otherwise
require:
1. A `Bill → expense` join (a paid Bill has no path back to the
   `ownerMonthlyExpenses`/`monthlyCharges` rows its `expenseId+term` generated).
2. A **renter-side per-expense paid field** — the tenant `monthlyCharges`
   subdoc has none today (`building.ts` MonthlyChargeSchema); the renter
   portion only settles by paying the whole rent term in the tenant ledger.
3. A matching policy: RF-code-only today; both-sides settlement would need
   amount/term/expense matching and a both-vs-one-side UX choice.

**Decision (June 2026):** build owner καταβολές standalone first; the owner
ledger settles via its own payments. Receipt-driven both-sides settlement is a
follow-on once (1) and (2) exist. A UI TODO marker sits on the building
PDF-import / receipt surface pointing here.

**Hooks.**
- `services/api/src/managers/billmanager.ts:467` — `confirmPayment` (the
  bill-status flip; where a fan-out to expense ledgers would hook in).
- `services/common/src/collections/bill.ts` — `Bill` schema (needs an expense
  back-link for D-9).
- `services/common/src/collections/building.ts` MonthlyChargeSchema — the
  renter-side `paid` field that does not yet exist.

---

When a deferred decision becomes urgent, move it from this file to an
open issue and prioritise alongside the live audit queue.
