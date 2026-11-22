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
HEAD `6e771282`; code drifts — grep the symbol if a number is off.)
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

**Status:** Fixed in `5cc27004` (June 1 2026). `ResourceList/List.js`'s
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

**Earlier history.** A first attempt at the fix shipped as `e11a4bc8`
introduced a race that clobbered the user's search on every data
reference change, breaking 60+ payment dialog tests in suite #7-#10. That
attempt was reverted in `4b5c18c2` to restore dialog tests. The
`5cc27004` fix avoids the race by deleting the init effect rather than
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

## D-8 — A payment on a past month did not reach the months after it — RESOLVED (2026-11, owner decision)

**What was wrong.** `_isFrozen` (contract.ts) closes every past month, and the
current month once it is paid in full, so that a later edit to a rent or a building
expense cannot re-price a month that is over. The freeze also held what a month
CARRIES IN from the month before it («Προηγούμενο υπόλοιπο»), which is not a price.
So a payment recorded on a past month's page was saved on that month and went no
further. Rent 400 €, three unpaid past months: 400 € recorded on each month's own
page (1.600 € in all) left the current month showing 800 € still owed, and next
month opening with 800 €, while the same 1.600 € recorded once on the current
month's page settled the tenant (watched on the NAS, 2026-11-22). The same stale
carry produced three more symptoms: extending a lease whose end had passed (or
removing a termination) brought back every euro ever paid as «Προηγούμενο
υπόλοιπο»; moving the begin date earlier left the new months' debt out of the later
months; moving it later left a removed month's debt in them.

**Decision (owner, 2026-11-22).**
- Payments on older months stay allowed, and the months after them then owe less.
- More than a month owed is not refused and not lost: it is carried forward, as a
  credit where it exceeds what the later months carry. Never floored at zero.
- A rent notice or receipt reprinted for a past month shows the carried balance as
  it stands now.
- What a closed month BILLED stays frozen, exactly as before.

**The rule now (contract.ts).** `_isFrozen` is unchanged:

```
  future term  → never frozen
  PAST term    → ALWAYS frozen (paid OR unpaid, settled or clean)
  current term → frozen only if fully paid
```

What a frozen month billed (line items, payments, note) never changes. What it
carries in follows the month before it, in two situations only:
- `payTerm`: a payment, write-off or extra charge saved on an older month. Each
  closed month after it is SET to carry in what the month before it now leaves
  unpaid (`previous.grandTotal − previous.payment`, as `5_balance.ts`), and only
  where the month before it actually moved.
- `update`: lease dates edited so that closed months were added or removed in front
  of it. Every other recompute (expenses, units, sibling tenants, repairs) leaves
  every closed month exactly as stored, even one whose stored carry-in does not add
  up.

Two kinds of row are outside this, both absent from every realm on the NAS (audited
2026-11-22: 0 of each) and both older than this decision:
- a row whose total (or carried balance) is not a figure — text that is not a plain
  number, `true`, a list, a date — or is a number so large that the arithmetic on
  it overflows. It is left exactly as stored, the closed months after it do not
  follow through it, and no closed month is written with anything but a finite
  amount (`_figure`, `_leftUnpaid`, `_followPreviousRent`). An OPEN month after
  such a row starts, in `update`, from what the row leaves with its total counted
  as nothing; in `payTerm` it is priced by the pipeline (`5_balance.ts`), and the
  month a payment is recorded on is rebuilt by `_freezeBilledCharges`, both as
  before.
- a row whose MONTH is stored as text. The restore pass in `update` has always
  skipped such a row (it is rebuilt as if nothing had been paid on it) and
  `payTerm` treats it as an open month (it is re-priced); the closed months after
  it then follow the rebuilt row. The defect is how such a row is read; it is not
  fixed here.

The rule that closes the CURRENT month (`_isFullyPaid`) is unchanged. What that
leaves open is D-11.

**The windows that read the ledger.** Written when a carried balance could only
be a debt, and a row could be read on its own:
- «Τερματισμός μίσθωσης»: what is still unpaid (before and after the termination
  date) comes from the ledger read as one account, oldest month first
  (`webapps/landlord/src/utils/leaseArrears.js`). Reading each row on its own
  offered to write off money already received. What stays unpaid is read from the
  months that stay, and from nothing else: a credit or a payment on a month the
  termination deletes pays for nothing that is kept. The write-off reads the ledger
  again before each month (`nextWriteOff`), never asks for more than that month's
  total still shows, and writes nothing when a month after the termination carries
  something the server will not delete — a payment, a discount, an extra charge or
  a note (`recordedAfterTermination`, the mirror of `contract.ts` `_isPayment`).
  The server can still refuse a termination for another reason (a refund above the
  deposit) AFTER the write-offs have landed; they stay, the window then shows the
  ledger as it stands, and a second press terminates (`terminateLease`). Every
  request of the run — each write-off and the termination — is sent at the version
  this window knows the tenant at (the copy it holds, then what each confirmed
  write-off left), and the server refuses one that names a version which is not
  the tenant's. So a save from another window that moves the tenant's version, at
  any point of the run, stops it (409, «Ο ενοικιαστής τροποποιήθηκε από άλλο
  παράθυρο…»; also shown when a write-off of this window was saved and its answer
  never arrived) instead of being overwritten by the termination, which saves the
  whole tenant the window holds. Two limits, both older than this: a save that
  does not move the version (archiving, the marks of the lease-expiry notices) is
  not seen; and a tenant stored WITHOUT a version cannot pin its first write-off
  (the app creates no such tenant; on the production database of 22/11 none of the
  125 tenants that belong to an organisation is one).
- «Έξπρες εξόφληση» offers, and the server records, what the month still needs
  after a carried credit (`utils/expressOwed.js`, `rentmanager._expressNetOwed`).
- The payment window lists what is still owed after the carried credit and after
  EVERY euro already saved on the month, whatever line it was attributed to when it
  was saved (`utils/paymentAllocation.js` `owedLinesOf`) — on a month whose lines
  hold its whole bill (`listsWholeBill`: the row bills no VAT, and its lines less
  its discounts add up to its own bill; true of all 1.110 month rows without VAT
  that the API returns on a copy of the production database of 22/11). Any other
  month is left out: the window lists no VAT line (the row carries `vatAmount`,
  not `vat`), and a VAT lease in a month with no rent line bills the VAT of an
  extra charge without the row saying so, so money cannot be spread over the
  lines. Such a month is listed exactly as before (checked against the old code on
  49.315 random months of five kinds: identical): approximate, not made worse.
  Listing it properly needs the VAT line on the screen.

The attribution the SERVER stores with a payment is unchanged: a payment is
attributed to the lines of the month it is saved on, credit or no credit. The
dashboard reads those attributions, and shrinking the lines by the credit made the
same month read differently depending on whether it was paid before or after the
credit arrived (`paymentPathsWithCarriedCredit.test.js`).

**Not rebuilt.** A ledger whose carried balances were already wrong before this
shipped is not repaired by itself: it stays as stored until a payment is saved or
changed on an older month, and is then put right from that month on. The landlord's
realm was audited before the deploy and held none.

**Pinned by.**
- `services/api/src/businesslogic/__tests__/contract-carry-through-closed-months.test.js`
- `services/api/src/__tests__/paymentPathsWithCarriedCredit.test.js`,
  `expressNetOwed.test.js`, `expressStaleBaseline.test.js`
- `webapps/landlord/src/__tests__/leaseArrears.test.js`,
  `creditAndCarryInTheWindows.test.js`
- `e2e-playwright/tests/68_past_month_payment_carry.spec.ts`,
  `70_terminate_writeoff_after_payments.spec.ts`,
  `71_lease_dates_keep_the_ledger.spec.ts`, `51_terminate_outstanding.spec.ts`

**Hooks.** `grep -n '_isFrozen\|_isFullyPaid\|_followPreviousRent\|_leftUnpaid' services/api/src/managers/contract.ts`
(line numbers in this file drift; do not trust a written one).

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

## D-10 — A building charge for a month that is closed for a tenant reaches no rent — OPEN

**Current behavior (watched on the NAS, 2026-11-22).** A utility bill charged to
tenants for a month that is over, or that a tenant has already paid in full, is
written on the building, listed there as the tenant's share, reported as charged,
and added to that tenant's rent in no month. The common case is not a late import:
a bill issued on the 20th is charged to its issue month, and by then most tenants
have paid that month. Same loss through the bill upload window, the Telegram bell
card, the monthly panel on the building page (a figure saved for a past month) and
a repair whose charge month nobody has paid yet. Pinned as expected failures by
`e2e-playwright/tests/69_bill_charge_closed_month.spec.ts`.

The monthly panel warns when the month is over. Its warning for a month a tenant
has already paid exists in the source but can never render: the `isCurrentTerm`
block sits inside the `isPastTerm` banner (`BuildingExpensePanel.js`, search for
`isCurrentTerm &&`), and the two are never true together. The bill import window
warns in neither case (watched); the Telegram bell's card has no such warning in
its source (read, not watched).

**Decision (owner, 2026-11-22).** The tenant's share is added automatically to that
tenant's next open month, labelled with the month it belongs to, and the import
says so. A repair is the exception: its form refuses a charge month that is closed
and says why. The owner approved the screens on 2026-11-22; no code yet.

## D-11 — A paid current month can be reopened by a change on an older month — OPEN

**Current behavior (measured 2026-11-22, engine tests and the local old-vs-new
harness).** The current month is closed once it is paid in full
(`contract.ts` `_isFullyPaid`: payments cover the total, and a total of nothing is
never "paid in full"). Since D-8 a change on an older month moves what the current
month carries in, so it can change the answer for a month the tenant has paid:

- a payment on an older month is removed or reduced, an extra charge is added there,
  or the begin date moves earlier: the paid month now carries a debt, counts as
  part paid, and is open;
- so much more than was owed is recorded on an older month that the credit brings
  the paid month's total down to nothing or below: a total of nothing is not "paid
  in full" for the rule, so the month is open (as a month covered by a credit alone
  always was). A smaller overpayment does not do this: the month's total stays
  above zero, its payment more than covers it, and it stays closed.

An open month takes the prices in force at the next recompute. If the rent or a
building expense was changed after the tenant paid, that change now reaches the
month: its own bill moves by the difference. Nothing is lost and the row shows it,
but it is a paid month being re-priced, which the freeze exists to prevent. Past
months are not affected (they are closed whatever is paid).

**Why it is not fixed with D-8.** Both obvious rules were built, reviewed and
withdrawn. "Paid in full when the payments cover the month's own bill" closes the
month of a tenant in arrears who pays only this month's amount, and of a tenant who
is a month ahead and keeps paying: for both, a building charge entered later for
that month then reaches no rent (D-10). Until D-10 is fixed that trades a visible
re-pricing for money that goes missing silently.

**Direction.** Decide it together with D-10: once a charge for a closed month is
carried to the tenant's next open month, "closed" can safely mean "its own bill is
settled". Telling a month that WAS closed from one that never was needs a fact the
ledger does not hold today (what the month carried in when it was closed).

---

When a deferred decision becomes urgent, move it from this file to an
open issue and prioritise alongside the live audit queue.
