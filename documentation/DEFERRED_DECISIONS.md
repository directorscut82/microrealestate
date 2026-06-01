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

**Hooks the audit identified if we eventually do this.**
- `services/api/src/businesslogic/tasks/1_base.ts:315` — explicit
  comment stating proration is not implemented.
- `services/api/src/managers/occupantmanager.ts:47` —
  `property.exitDate` defaults to `tenant.endDate` without considering
  `terminationDate`.
- `services/api/src/managers/occupantmanager.ts:1337` —
  `_syncOccupancyForProperties` is only called for added/removed
  properties, not for `terminationDate` changes (separate occupancy
  metric bug; a property terminated mid-cycle stays marked `rented`
  and the dashboard `occupancyRate` is inflated).

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

## D-3 — Repair charges flow as `monthly_charge` not `repair` (lifecycle L-3/L-4)

**Current behavior.** `_distributeRepairCharge` pushes
`unit.monthlyCharges` entries with no `type` field. The pipeline at
`1_base.ts:427` then hardcodes `type: 'monthly_charge'` on those
entries when promoting them to `rent.buildingCharges`.

**Effects.**
- `rentmanager.ts:108`'s repair bucket
  (`buildingCharges.filter(c => c.type === 'repair')`) is permanently
  empty. The whole `repairs` allocation category in
  `_computeOwedByCategory` and the `'repairs'` arm of auto-spread are
  dead code.
- Dashboard pie shows the repair charge under the slate "monthly_charge"
  color instead of the copper "repair" color.

**Why deferred.** Real fix needs three coordinated changes (schema +
distribute + pipeline) and a migration to re-tag historical
`unit.monthlyCharges` entries that originated from repairs. Best done
in one sequenced commit with a verification script.

## D-4 — Edit of expense `startTerm` after distribution (lifecycle L-9)

**Current behavior.** Editing a one-time expense's `startTerm` from May
to June recomputes June rents (gain charge) but does NOT remove the
charge from May if May is frozen (paid). The tenant is billed twice.

**Why deferred.** Need to decide: should the API refuse the edit, or
allow it with a warning? Both are defensible; both require a UX
decision and a confirmation modal.

## D-5 — Revenue aggregate clamp + balance subtraction interaction (L-10)

**Current behavior.** `dashboardmanager.ts:359` clamps
`tenantDue = Math.max(0, grandTotal)`. For a month where overpayment
carry-forward made `grandTotal` negative, this clamps to 0. But
`tenantMonthDue = grandTotal - balance` (line 388) is computed AFTER
clamping in some paths and produces nonsensical values.

**Why deferred.** The audit suggests storing both `clampedDue` (for the
pie) and `realMonthlyBill` (for revenue calc) separately. That's a
schema change and needs cross-checking with how the bar chart and
yearly aggregates consume it. Worth doing carefully, not as a quick
patch.

---

## D-6 — Tenant search clears on data refetch (spec 03)

**Current behavior.** When the tenants page's `useInfiniteQuery` refetches
in the background (window focus, mutation invalidation), the typed search
text in the box stays but the filter resets to "all tenants" until the
user types another character.

**History.** Fixed once in `fb024ed4` via an init useEffect in
`webapps/landlord/src/components/ResourceList/List.js`. That fix
introduced a race condition where the init effect overwrote the user's
search on every data reference change, breaking 60+ payment dialog tests
in suite #7-#10. Reverted in `e1fe87d3` to restore dialog tests.

**Why deferred.** A correct fix needs to call `handleSearch` with the
*current* `searchText` and `selectedFilterIds` (not empty defaults) when
data changes. That requires either lifting search state into the parent
or passing it down to the init effect. Both are a refactor; one-line fix
isn't safe.

**Hooks if we eventually fix this.**
- `webapps/landlord/src/components/ResourceList/List.js`
- `webapps/landlord/src/components/SearchFilterBar.js` (line 92-97 — its
  own useEffect already calls `onSearch` with current state on
  `searchText` change; the gap is when *data* changes without
  `searchText` changing).

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

---

When a deferred decision becomes urgent, move it from this file to an
open issue and prioritise alongside the live audit queue.
