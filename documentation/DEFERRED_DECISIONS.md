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

## D-10 — A building charge for a month that is closed for a tenant reached no rent — RESOLVED for statement shares (2026-11-23, owner decision); repairs and the import window's wording still open

**What it was (watched on the NAS, 2026-11-22).** A utility bill charged to tenants
for a month that is over, or that a tenant has already paid in full, was written on
the building, listed there as the tenant's share, reported as charged, and added to
that tenant's rent in no month. The common case is not a late import: a bill issued
on the 20th is charged to its issue month, and by then most tenants have paid that
month. Same loss through the bill upload window, the Telegram bell card and the
monthly panel on the building page (a figure saved for a past month). On the real
data it was the rule, not the exception: every tenant share that had been typed in
for a month that was already over had reached no rent (read-only audit, 2026-11-23).

**Decision (owner, 2026-11-22).** The tenant's share is added automatically to that
tenant's next open month, labelled with the month it belongs to, and the import says
so. A repair is the exception: its form refuses a charge month that is closed and
says why. Screens approved 2026-11-22.

**How it works now** (W3a, 2026-11-23).

- **Where a share is billed is DERIVED, never stored.** Every time a month is priced,
  the engine reads the tenant's stored ledger — which months are closed, and which
  shares closed rents already hold (`contract.ts` `_ledgerFacts`) — and bills, on the
  tenant's FIRST OPEN month (this month when it is not paid in full, otherwise the
  next), the marked shares of earlier closed months that no closed rent holds
  (`businesslogic/tasks/1_base.ts` `_carriedInto`). A first design stored the month on
  the building row; it was reviewed on paper and dropped: a stored month goes stale
  when a lease is terminated or extended or a payment is removed, one row cannot name
  a month for two tenants, and a share already billed on its own month was billed
  again when that month was saved again.
- **Two small facts ARE stored.** On the building row: `carry: true`, set by the
  statement save on a share that did not exist before that save (`chargecarry.ts`
  `statementRowIdentity`); a row that is rebuilt keeps its `_id` and its mark as they
  were. On every building line of a rent: `propertyId` and `expenseId` (or
  `repairId`), and `forTerm` when the line is billed on a later month than the one it
  is for. The ledger itself now says what was billed, for which unit and which month;
  renaming an expense or a building cannot confuse it.
- **A share is billed once: one line of a closed rent stands for one row, its own.**
  Which line stands for which row is decided in ONE place, for the engine and for
  the screens alike (`businesslogic/carriedshares.ts` `coverRows`). EVERY row of the
  tenant's units goes into the question — not marked, or of a month the tenant is
  now said not to have held the unit in (an exit date recorded after the month was
  billed): such a row is never carried, but it is what a line of its month was
  billed for, and left out that line would be taken for another row's. In this order:
  1. a line of an expense that still exists covers the row of ITS OWN unit for that
     expense and month;
  2. an OLD line — of no living expense: stored before lines carried ids, or of an
     expense that was deleted since and perhaps created again — that names a unit is
     for a row of that unit, same month, that reads the same (building name,
     description) and that no line covers yet — unless the rows that read like it
     are of two or more expenses (namesakes): the unit then says too little, the
     share may have moved to another unit while a namesake's row sits on this one,
     and the line goes on to 4;
  3. a line of rule 1 whose unit has no row for it (any more) stands in for one other
     row of that expense and month, of a unit that is the tenant's: a split per
     tenant gives a tenant with two units ONE share, on one of them, and can move it
     to the other when it is run again. This goes by count, whatever the split: a
     tenant is never billed more shares of an expense and month than there are rows.
     Of several rows it takes the one that would otherwise be billed: of a month the
     tenant held the unit, not in doubt (below), and marked;
  4. what is left of the old lines — the ones that name no unit, and the ones whose
     unit has no free row that reads the same (none at all, or only rows that their
     own lines cover) — is for a row of the same month that reads the same, of any
     unit: a share that moved. So a unit with more old lines than rows for them hands
     the lines left over on to the other units.
  One line covers one row.
- **An old line that could be for several rows: the app does not guess.** Such a
  line says a name and an amount and no more. With one row that reads like it there
  is nothing to decide — that is every tenant with one unit in a building whose
  expenses have different names, which is every tenant in the data today. With
  several (a tenant with two units of the building, two expenses of one name) nothing
  in the ledger says which row it was billed for, so NONE of them is billed again
  (`coverRows` answers `unsure` for them). A share that was in fact never billed
  stays unbilled, as it was before this change; the building page says «⚠ δεν
  χρεώθηκε» for it, and it can be charged by hand. The line is shown against the row
  it most likely was billed for (exactly its amount, then a month the tenant held
  the unit, then a row from before the mark, then the nearest amount, then the
  oldest): that is what the page says, and no money depends on it. It only concerns
  months billed before 2026-11-23 and expenses that are deleted: the line of a
  statement share written from now on names its unit and its expense.
  Each version was reviewed independently before anything shipped (one to three
  reviewers a round). The first counted «already billed» per expense and month and
  looked only at the marked rows: a tenant's second unit lost its new share to the
  first unit's line, an expense deleted and created again was billed twice, one old
  line swallowed every new share with its name. The second left out rows outside the
  tenant's window and guessed «the row that was there before»: an exit date recorded
  late made a unit's own line swallow the other unit's share, and an old line took
  the wrong one of two rows that were typed again. The third guessed «the nearest
  amount»: a tenant who had moved from one unit to the other was billed twice when
  the month was typed again, and a corrected figure lost the other unit's share.
  Every guess had a history in which it billed a tenant twice. The versions after
  that do not guess. The fourth and fifth each still had a way around the rule in a
  shape with namesakes or a month built again (a moved share next to a namesake's
  row, a month built again skipping a row from before the mark, a stand-in spending a
  doubt): closed in the sixth, against which a reviewer's own random histories (3,500
  of them, with two and three units, namesakes, shares moving, expenses created
  again, dates moving) found no share billed twice. The cases that are left are
  listed under «What it deliberately does not do» and «Still open».
- **A month that is built again does not bill what a later rent holds.** A month that
  is priced although it is over — the begin date was moved later and then earlier
  again, so the month was dropped and is built again — does not bill from its row a
  share that a later, closed rent already holds as a carried line. Only a MARKED row
  can be such a share (a line is carried for no other), or one the line names
  outright; a row from before the mark is the month's own, and the month bills it
  again as it always did.
- **The answer is read back, with the same rule.** After the recomputes the
  statement save reads the tenants' rents and answers, per tenant and share: on its
  own month, on a later month (which, and how much), on no rent (the lease has
  ended; or a share from before this change), or missing (`statementOutcome`; per
  bill `chargeOutcome` from `/bills/confirm` and the inbox confirm). A share is
  never called charged on the strength of another unit's line, and one line is
  never reported for two shares. (On top of that rule, for reporting only: a line
  from before lines carried ids that no row has taken — because the expense or the
  building was RENAMED since — is recognised by its exact amount on the share's own
  month. Not a line that names a unit, and not one that reads like an expense that
  is billed live that month — by the engine's own rule, worked out on the building
  as it is today: either is taken to be somebody else's line of the same amount,
  which can be wrong both ways — see «A rename breaks the thread to an old line».) A line that names a unit of ANOTHER building is
  not looked at (two buildings can have the same name and expenses of the same
  name); a rent whose month is stored as text still counts for what it holds. The
  building's «Χρεώσεις» of a month does the same
  when it is read (`chargecarry.ts` `placeTenantShares`): «✓ χρεώθηκε στο ενοίκιο
  Νοεμβρίου 2026», «⚠ δεν χρεώθηκε, η μίσθωση έχει λήξει», «⚠ δεν χρεώθηκε». A row
  is given such a line whenever its share is not simply on that month's rent at the
  amount shown — every tenant who held the unit that month is then named, the one
  who WAS billed there included. The month that bills a share lists it under the
  tenant who is billed, marked «για Οκτώβριο 2026». The tenant total the page's
  answer carries (`tenantTotal`) is what the rents of that month hold for the rows
  it lists. Two things it does not count, both older than this change: a unit that
  changed hands inside the month has BOTH tenants billed its whole share (D-1) and,
  while each is billed the amount shown, the row counts once; and a line whose row
  was removed after its rent closed stays on that rent but is no longer listed.
- **The line says its month wherever the tenant or the landlord reads it**
  («… · για Οκτώβριο 2026»): the rents page, the rent schedule, the payment window
  and its saved payments (also a payment saved with a category and no line, which is
  shown as the month's first building line), the dashboard tooltip, the printed
  notice and receipt (whose calculation line uses the figures of the month the share
  is FOR), and the rent-call e-mail. Where a name is cut for lack of room the month
  is not (`components/LineName.js`). The SMS is the exception: see «Still open».
- **A payment attributed to a carried line** names it by what it is
  (`building:<propertyId>:<expenseId>:<YYMM>`, `chargecarry.ts` `buildingLineKey`,
  mirrored in the landlord app's `paymentAllocation.js`), not by its position:
  another late share can arrive, or one can be removed, without the payment sliding
  onto another line. The month's own lines keep their positional keys. **The key is
  short on purpose** (63 characters with database ids): every version of the app
  refuses an attribution key longer than 64 when a month's payments are saved again,
  so the first version's key (the whole ten-digit month, 69 characters) would have
  locked the payments of such a month after a rollback. The limit was put back to 64.
- **A payment taken off a paid current month re-opens it, and the shares follow at
  once.** A share that went on next month because this month was paid comes back to
  this month in the same save (`contract.ts` `payTerm` prices the months once more
  against the ledger as it then stands) — otherwise the screen showed the month
  without the share, the landlord recorded the amount on the screen, and the month
  was left short by exactly the share. Only when carrying is in play for the tenant
  — a carried line on that month or after it, or a marked row on one of the tenant's
  units: a month that re-opens with neither is left as it always was until the next
  recompute. What the months say after that second pricing is what the next
  recompute would have made them — lines and totals, measured over the random
  histories below: only the moment changes. (A payment on an OLDER month that
  re-opens the paid current month is D-11, below: the share then moves at the next
  recompute, not at once.)
- **A statement lists an expense once.** Two entries for one expense made two rows
  of it on every unit; carried to another month, two shares of one unit, expense and
  month have one attribution key. `saveMonthlyStatement` refuses such a body (422).
  No screen and no bill import sends one. Rows stored that way before are billed
  once each, and the building page gives each its own answer.

**What it deliberately does not do.**

- **Nothing is billed retroactively.** Rows written before 2026-11-23 carry no mark
  and are never carried, also when their month is saved again. The building page
  marks them «⚠ δεν χρεώθηκε» when their month's rent holds no line for them (with
  one exception, in the next point: an unexplained old line of exactly the share's
  amount). To bill such a share: clear the figure, save, type it again (a share that
  did not exist before the save is marked).
- **A rename breaks the thread to an old line.** A line from before lines carried
  ids is recognised by the building's name and the expense's name. After either is
  renamed, a share that was billed before this change and is then saved as 0 and
  typed again reads unlike its old line, and is carried: billed a second time. The
  same when a statement is saved with another description for the expense (the bill
  import writes the provider's name when it is given no expense name). The PAGE
  still recognises such a line, by its exact amount on the share's own month — unless
  the line names a unit, or reads like an expense that is billed live that month (one
  the engine bills from its own definition — a monthly amount, or fixed amounts per
  unit — and not from a figure typed in for the month: the line is taken to be that
  expense's, whatever building name it carries).
  What it cannot tell from a line from before a rename: the line of an expense that
  was DELETED, of a fixed expense that was itself renamed, of a manual charge or a
  repair from before lines carried ids — so a share of the same amount that was never
  billed can read «χρεώθηκε» there; and, the other way, a share that was billed under
  a name that an expense billed live that month has today reads «⚠ δεν χρεώθηκε» —
  after its own expense was renamed and the old name reused, or, when two expenses of
  the building share a name and one of them is billed live, after the BUILDING alone
  was renamed (a live-billed name is taken for that expense's line under any building
  name: otherwise a renamed building would free every old line of its fixed expenses).
  «Billed live» is asked of the building, not of the share's own unit, and of the
  building as it is today.
  (Measured 2026-11-23 on a copy of the data: of the 32 statement shares of 2026 the
  page answers for, none is recognised by its amount, under this rule or the ones
  before it; every stored line names a building that exists and none is a manual
  charge's or a repair's.)
- **A closed month is never rewritten.** When a figure is changed after the rent
  that holds a share was closed — its own month's, or the later one it went to —
  that rent keeps what it billed and the difference is not charged (or refunded);
  the building page then shows the amount that was charged in brackets (while the
  row exists: a figure that is cleared takes its row off the page, see above).
- **The app cannot tell that two expenses are the same utility.** An expense that is
  deleted and created again under the SAME name is recognised (rules 2 and 4 above). Under
  another name it is a new expense: typing a closed month again under it bills that
  month's share again. Ending an expense («Τερματισμός από τον τρέχοντα μήνα») keeps
  its history and has no such edge.
- Leases that are not monthly are left alone. Rows of no expense (manual rows; a
  statement entry that names no expense) and repair rows are never marked and never
  carried.
- **`carry` is never taken from a request**, and no request can move it. What the
  doors do, each found open by a review that drove the real handlers through the real
  schema (`__tests__/unitDoorsRealSchema.test.js`):
  - the unit endpoints (create a building with its units, add a unit, update a unit —
    which take a unit's rows from the request as they are) give every row the mark
    its stored row has and no other, one row per stored mark (`chargecarry.ts`
    `chargesWithStoredMarks`), and refuse (422, `unitRowsProblem`): rows that are not
    a list of row objects (the schema turns a single row object into a list of one);
    rows addressed by path (`set()` follows «monthlyCharges.0.carry»); a row whose
    `_id`, `expenseId`, `repairId` or `term` is not a plain value (the schema casts
    `{ _id: X }` back to X: the row kept its identity and lost its mark); two rows
    with one `_id` (a row is removed by its id, and that removed both);
    a row `_id` that is not 24 hex characters (the schema reads twelve characters as
    an id too);
  - a row that carries the mark can only change its AMOUNT through a request — the
    unit endpoints and the manual-row edit refuse (422, `markedRowProblem`) another
    month, another expense, a repair or another description for it. A description
    changed by hand made the row read unlike the old line that covered it (billed
    twice); taking the mark off a row that was moved lost it for good when the move
    was undone. Left out of a unit's rows the row is removed; sent back without its
    `_id` it is a new row, with no mark;
  - the manual-row endpoints ignore `carry` and `_id` — the add as well as the edit:
    with the id of a stored row, a new row made the next statement save remove both;
  - the statement save takes an expense by its id as TEXT and stores the id as the
    building holds it (`expenses.id()` casts: `{ _id: X }` and the id in upper case
    found the expense too, and passed the once-per-expense check as another one).
  Restoring a backup restores the marks that are in it: it replaces the data
  wholesale, by design.
- **Rolling back to the version before this change** breaks nothing that is stored:
  the marks and the ids on lines are ignored, the keys fit its limit. What it does:
  an OPEN month loses its carried line at the next recompute (back to the old
  loss); a closed month keeps it; its dashboard books a payment attributed to a
  carried line under «Λοιπά»; and a statement saved by the old version rebuilds its
  month's rows as new rows, so their mark is gone: a share of that month that no
  closed rent holds yet is not carried after rolling forward again — the page then
  says «⚠ δεν χρεώθηκε» for it.

**Still open.**

- The bill upload window and the Telegram bell still answer only «εισήχθη με
  επιτυχία»; they do not yet list where each share went (the answer carries it:
  `chargeOutcome`). The bell's switch still says «αυτόν τον μήνα».
- Repairs: a charge month that is closed is refused only when a tenant has paid
  something for it; otherwise the tenants' part is charged to no one.
- A tenant share that is charged nowhere (the lease has ended) is in no total: not
  the tenants', not the yearly «Αχρέωτα».
- The building page says «⚠ δεν χρεώθηκε» for a share an old line may be for, and
  for a share from before the mark, without saying why; and the note on a past month
  promises the carry for every share. Wording to be decided by the owner.
- The read-back looks at ONE building. For a tenant with units in two buildings that
  have the SAME NAME and expenses of the same name, an old line that names no unit is
  answered on both buildings' pages (the engine, which sees both, bills neither row
  again). Building names are not required to be unique. No such pair exists in the
  data.
- Two units of one building that name the SAME property (no such pair in the data;
  the engine reads the first): the page can put an answer on the wrong one of the two
  entries when the first has a live share and the second a stored one.
- `ownerExpenses` listed twice in one statement (no screen sends that) keeps one of
  the two rows' recorded payments: same before this change.
- A rent line whose `forTerm` is stored as TEXT (a hand-edited ledger) is read as a
  line of its rent's own month.
- An expense row written WITHOUT the mark after this change — the unit endpoints
  write one when a request sends a new row with an expense id (no screen sends rows),
  and so does the old version after a rollback — for a month whose share of the
  deleted and re-created expense sits on a later, closed rent: when the begin date is
  then moved later and back, the month that is built again bills that row too.
- For a tenant with units in two same-named buildings (above), a line of a deleted
  expense that names a unit of the OTHER building is dropped by the read-back while
  the engine counts it: the page says «⚠ δεν χρεώθηκε» as if a recompute had failed.
- For a tenant with units in two buildings (no such tenant in the data), an old line
  of the OTHER building that names no unit can be taken, by its amount, for a share
  of this one that reached no rent: to this page it looks like a line from before a
  rename.
- A share that was billed on its own month while that month was open (it is marked,
  like every share written from now on): when that month is built again — the begin
  date moved later and back — while a later, closed rent holds an old line of a
  DELETED namesake that names the share's unit, the month does not bill the share
  again: it stays unbilled. Needs two expenses of one name, one of them deleted.
- The unit endpoints refuse two rows with one `_id` inside a unit; the same id on
  rows of two different units is accepted (rows are removed unit by unit, and
  nothing reads a row by its id across units).
- The building page names a unit's latest tenant on past months, and a future month
  cannot be opened there: a share billed on next month's rent shows on that month's
  page only when the month comes (the bill's own month says where it went).
- On the building page the bold amount next to a unit is the sum of the rows listed
  under it, as approved: on the month a bill is FOR that is the unit's share, also
  when the line under it says the share was charged on another month's rent.
- The SMS rent notice adds a carried share into «Κοινόχρ» of the month it is billed
  on and names no month (`emailmanager.ts`); the amount is right, the PDF it comes
  with says the month. Wording to be decided by the owner.
- The dashboard tooltip spreads what was collected for a kind of expense over the
  lines of that kind in proportion (as it always did). A month now routinely has
  two lines of one kind — its own and a carried one — so a payment attributed to
  one of them shows partly on the other.
- D-11, below.

**Pinned by.** `businesslogic/__tests__/carried-shares-cover.test.js` (which line
stands for which row, rule by rule; which rows are in doubt; 2,000 random cases that
check it from both sides — every row a line could be for is covered or in doubt, and a
row that no line of its month names or reads like is neither), `building-charge-carried.test.js` (the engine; and 250
random histories of a tenant with one or two units — held together or one after the
other — that share two expenses and, in most of them, a third with the name of the
first: rows from before the mark, ledgers stored before lines carried ids, figures
changed by a little or a lot, a month saved as 0 and typed again, any expense deleted
and created again, the rows written back in any order and sometimes on the other
unit, a share moved from one unit to the other, payments on the current month and on
older ones, entry and exit dates recorded late, the begin date moved and moved back,
a termination set and removed, months going by; a fifth of the histories put all of
it in three months so that the rare coincidences happen. Against what every line was
REALLY billed for, which the test keeps for itself: no unit, and not the units
together, ever has more lines for an expense and a month than rows at once; a share
that is owed has a line of its own, unless an old line could be for it or a line that
outlived its row stands in for it, by count; a share with no mark that was there
when the lease was first priced, or that arrived while its month was open, is on its
own month; a closed month never changes; after a payment on the current month
the whole ledger is what the next recompute makes it. NOT in the histories: an
expense created again under another name, a unit taken off the lease, three units,
repairs, amounts. Versions one to four fail it; three of the later engine fixes it
does not reach on its own — a month built again, a stand-in next to a doubt, a moved
share next to a free row of a namesake — and those rest on their own tests),
`__tests__/chargeCarry.test.js` (the mark through the REAL schema, the read-back,
the building page), `__tests__/unitDoorsRealSchema.test.js` (the unit endpoints, the
statement save and the manual-row edit, driven through the real schema),
`ownerOccupiedGuard.test.js`,
`carriedShareAttribution` (keys, their length, server and browser in step),
`carriedShareOnPaper` (the real PDF partial and e-mail templates), the landlord app's
`carriedShareLines`, `buildingPageShares`, `savedPaymentBullet` and
`rentsHoverCarriedShare`, and `e2e-playwright/tests/69_bill_charge_closed_month.spec.ts`.

**A trap worth remembering.** The building schema is strict. The first end-to-end run
on the laptop carried nothing while every unit test was green: the api was running a
build of `services/common` from before the `carry` field existed, and Mongoose
dropped the mark on save without a word. See `test-running-guide.md` («A new schema
field needs a rebuilt shared library»).

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

**With carried shares (D-10) it also moves a line.** When the paid current month is
re-opened this way, a share that had gone on next month because this month was paid
comes back to this month at the next recompute (billed once either way). Until that
recompute the screen shows this month without it; recording the amount on the screen
then leaves the month short by the share. A payment taken off the current month
ITSELF does not have this gap (D-10 prices again at once); a change on an older
month does, until this decision is built.

**Why it was not fixed with D-8.** Both obvious rules were built, reviewed and
withdrawn. "Paid in full when the payments cover the month's own bill" closes the
month of a tenant in arrears who pays only this month's amount, and of a tenant who
is a month ahead and keeps paying: for both, a building charge entered later for
that month then reached no rent (D-10). Until D-10 was fixed that traded a visible
re-pricing for money that went missing silently.

**Decision (owner, 2026-11-23).** A paid month keeps what it billed: once a month is
paid in full its own bill stays as billed, and a later change on an older month only
changes what it carries in. Now possible, because a charge for a closed month is
carried to the tenant's next open month (D-10): "closed" can safely mean "its own
bill is settled". Not built yet. Telling a month that WAS closed from one that never
was needs a fact the ledger does not hold today (what the month carried in when it
was closed).

---

When a deferred decision becomes urgent, move it from this file to an
open issue and prioritise alongside the live audit queue.
