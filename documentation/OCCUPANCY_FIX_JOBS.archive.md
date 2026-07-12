# Occupancy / ιδιοκατοίκηση — Job List with Verifiable Acceptance Tests

> All 7 bugs independently re-confirmed (refute-by-default, file:line) this session.
> Decision locked: **more than one owner CAN reside** in a unit → `isResident` is a
> per-owner boolean (0..N true). Occupant portion of an expense splits among the
> resident owners by their ownership % (normalised among residents). Owner portion
> splits among ALL co-owners by %.
>
> Every job below has an ACCEPTANCE TEST that is objectively checkable — a jest
> assertion, a curl/response value, or a Playwright screenshot readback in Greek.
> A job is not done until its acceptance test is shown green/screenshotted.

## Worked example (the numbers every money job must reproduce)

Unit owned A 40% / B 30% / C 30%. A and C both reside; B does not.
Expense €100, split 50 occupant / 50 owner.
- Owner part €50 → by ownership %: A 20, B 15, C 15.
- Occupant part €50 → among residents A,C by their % (40:30 → 4/7 : 3/7):
  A 28.57, C 21.43, B 0.
- **Totals: A 48.57, B 15.00, C 36.43. Σ = 100.00.**
(Single-resident case, C only: occupant €50 all to C → A 20, B 15, C 65.)

---

## TIER 1 — control + data + integrity (no money-split change yet)

### J1 — Schema: record which owner(s) reside  [B-F prerequisite]
- **Change:** add `isResident: { type: Boolean, default: false }` to `UnitOwnerSchema`
  (`services/common/src/collections/building.ts:5-25`). Add the TS type in
  `types/src/common/collections.ts`.
- **Acceptance test:** jest — insert a building whose unit has owners with
  `isResident:true`; read it back; assert the flag round-trips. `common` + `types`
  build clean (`yarn workspace @microrealestate/common build`).

### J2 — API guard: block owner_occupied on an occupied unit  [B-C, CONFIRMED]
- **Change:** in `buildingmanager.updateUnit` (and `addUnit`), before persisting
  `occupancyType==='owner_occupied'`, reject 422 if the unit's property has an
  ACTIVE tenant. Use the date-aware definition (non-terminated/non-archived,
  current window) — NOT removeUnit's date-blind `properties.propertyId` query.
- **Acceptance test:** jest — (a) property with active tenant + PATCH occupancyType
  owner_occupied → 422 with a Greek message; (b) property whose only tenant is
  TERMINATED → 200 (does NOT falsely block). Both assertions in one test file.

### J3 — API: broaden owner-recompute to ANY occupancy change  [B-A, CONFIRMED]
- **Change:** `buildingmanager.ts:2233` — `occupancyChanged = unit.occupancyType !==
  oldOccupancyType` (drop the owner_occupied-only clause) so rented↔vacant also
  refires `recomputeVacantOwnerForProperties`.
- **Acceptance test:** jest — flip a unit rented→vacant via updateUnit; assert
  `ownerMonthlyExpenses` for that property/term is rebuilt (row present/absent as
  the transition dictates), not stale.

### J4 — API: validate isResident coherence
- **Change:** reject `isResident:true` on any owner when `occupancyType !==
  'owner_occupied'`; allow 0..N residents when it is. (Multi-resident permitted.)
- **Acceptance test:** jest — isResident:true + occupancyType:vacant → 422;
  isResident on 2 owners + owner_occupied → 200.

### J5 — UI: replace the 4-option dropdown with the «Ιδιοκατοίκηση» switch  [user spec]
- **Change:** `UnitList.js` — delete the `occupancyType` Select + `OCCUPANCY_TYPES`;
  render ONE `Switch` «Ιδιοκατοίκηση». rented/vacant are never user-set (derived
  from tenant links); parking is derived from property.type (see J9).
- **Acceptance test (UI, browser):** open the unit dialog on NAS in Greek; screenshot
  shows a single «Ιδιοκατοίκηση» switch and NO dropdown with rented/vacant/parking.
  Read the screenshot.

### J6 — UI: disable the switch when the unit is occupied  [user spec + B-C mirror]
- **Change:** dialog fetches tenants, computes `isOccupied` for this unit's property
  (same rule as `BuildingDashboard.js:336` — skip terminated/archived); switch
  `disabled` + Greek hint «Η μονάδα είναι ενοικιασμένη» when occupied.
- **Acceptance test (UI, browser):** on a rented unit → switch is disabled + hint
  visible (screenshot). On a vacant unit → switch enabled (screenshot). Both read.

### J7 — UI: resident-owner picker for multi-owner units  [multi-resident decision]
- **Change:** when the switch is ON and the unit has >1 owner, show a checkbox per
  owner «μένει εδώ»; ≥1 must be checked. Single-owner unit auto-marks that owner.
  Submit sends `owners[].isResident`.
- **Acceptance test (UI, browser):** owner_occupied on a 3-owner unit → 3 «μένει εδώ»
  checkboxes; check 2, save; re-open dialog → the same 2 are checked (round-trip
  screenshot). Mongo readback: `owners` array has isResident on exactly those 2.

### J8 — UI: unit-edit invalidates ALL money caches  [B-B, CONFIRMED]
- **Change:** `UnitList.js:113-119` `_invalidateAllUnitDependents` adds
  `[OWNERS]`, `[ACCOUNTING]`, `['expense-breakdown']`.
- **Acceptance test (UI, browser):** on NAS, mark a unit owner_occupied; WITHOUT
  reloading, switch to the Ιδιοκτήτες tab / Έξοδα ΧΡΕΩΣΕΙΣ / Τιμολόγια → the change
  is reflected (screenshot each). Before the fix these are stale; after, fresh.

### J9 — B-D + B-E: one shared occupancy derivation; parking off the status enum
- **Change:** (B-D) `BuildingDashboard.js` counts AND rows derive occupancy from ONE
  helper so they cannot disagree. (B-E) drop `parking` from the occupancyType enum
  (`building.ts:73`); derive parking from `property.type` like storage already is.
- **Acceptance test:** jest for the shared helper (vacant+tenant→rented in BOTH count
  and row; parking from property.type). UI: screenshot ΜΟΝΑΔΕΣ counts == the pills
  on the rows for the real building (Στάθμευση N matches N parking pills).

### TIER 1 gate (must all pass before Tier 2)
- `yarn workspace @microrealestate/{types,common,api} build` + landlord build clean.
- api jest suite green (delta only the new tests).
- Deploy to NAS; Portainer revision == pushed commit.
- Browser: J5/J6/J7/J8/J9 screenshots read on the REAL landlord building.

---

## TIER 2 — the money split (occupant→residents, owner→all co-owners)  [B-F, B-G]

### J10 — [CANCELLED — my earlier misread; corrected]
The split field ALREADY EXISTS. `BuildingExpenseSchema` (building.ts:110/136-137)
carries `amount` (the OCCUPANT/tenant-side pool, allocated to the unit and billed
to whoever occupies it) and `trackOwnerExpense`+`ownerAmount` (the OWNER-side pool,
split among co-owners by %, never billed to a tenant). So "€100 = €50 occupant +
€50 owner" is `amount:50` + `ownerAmount:50`. NO new expense field is needed.
The only missing datum is `isResident` (J1). The bug (B-F) is purely that an
owner_occupied unit routes the OCCUPANT pool (`amount`) to all co-owners by % rather
than to the resident owner(s). J11 does that routing. This job is void.

### J11 — Engine: attribute occupant pool to residents  [B-F core, 1_base.ts:186-266]
- **Change:** for an owner_occupied unit, split the unit share into occupant pool
  (→ resident owners by normalised %) and owner pool (→ all co-owners by %). Emit
  per-owner rows accordingly instead of one whole-amount owner-slice.
- **Acceptance test:** jest running the REAL engine on the worked example →
  A 48.57 / B 15.00 / C 36.43, Σ 100.00 (multi-resident) AND the single-resident
  case A 20 / B 15 / C 65. Exact numbers asserted.

### J12 — Persist the split on owner rows  [writer, buildingmanager _recomputeVacantOwnerCharges]
- **Change:** owner-resident rows carry occupant vs owner portion + resident
  attribution so BOTH readers below produce identical numbers.
- **Acceptance test:** jest — after recompute, `ownerMonthlyExpenses` rows for the
  worked example sum to the per-owner totals above; mongo readback on NAS matches.

### J13 — Owner ledger reader (xlsx/owner-tab path)  [_aggregateOwners, B-G path 1]
- **Acceptance test:** jest on `_aggregateOwners` for the worked example → per-owner
  owed matches J11 exactly.

### J14 — Owner statement reader (PDF path)  [buildOwnerStatement, B-G path 2]
- **Change:** apply the SAME resident-attribution rule; ideally extract one shared
  fn so PDF and xlsx cannot diverge (B-G root).
- **Acceptance test:** GENERATE the real owner PDF for C on NAS
  (`GET /api/v2/documents/owner-statement/:ownerKey/:term`) and READ it → C's line
  shows the occupant+owner amount, A/B show owner-only. AND assert the xlsx
  (J13) equals the PDF number for each owner (B-G no-divergence).

### J15 — ΧΡΕΩΣΕΙΣ breakdown render  [BuildingExpensePanel.js:952-964]
- **Acceptance test (UI, browser):** ΙΔΙΟΚΤΗΤΕΣ section for the term shows the
  occupant part on resident lines only + owner part split; per-owner subtotals ==
  J11. Screenshot read in Greek.

### J16 — Επισκόπηση owner tile  [BuildingDashboard.js:614-737]
- **Acceptance test (UI, browser):** owner paid/unpaid tile per-owner reflects the
  split (C higher, A/B owner-only); building total unchanged. Screenshot read.

### J17 — Owner detail ΙΔΙΟΚΤΗΤΕΣ tab  [owners/[id].js:270-315]
- **Acceptance test (UI, browser):** open owner C and owner A; C's charge line shows
  the higher (occupant+owner) amount, A's shows owner-only; co-owner split label is
  correct. Screenshot both, read.

### J18 — OwnerPaymentDialog guard
- **Change:** a non-resident co-owner cannot allocate a payment against the occupant
  portion (they don't owe it).
- **Acceptance test (UI, browser):** dialog for A offers only A's owner-share; dialog
  for C includes the occupant part. Screenshot read.

### J19 — PropertyExpensesCard tag
- **Acceptance test (UI, browser):** the per-property card tags the resident's
  occupant line. Screenshot read.

### TIER 2 gate
- Step-7 adversarial refutation on the money computation (J11-J14) comes back clean.
- Every J1x acceptance test shown (jest numbers + PDF read + each UI screenshot).
- Full api jest green; deploy; browser-verify on the real ΑΓ. ΟΔΟΣ ΕΨΙΛΟΝ 28 building.

---

## Confirmed-unaffected (do NOT touch; verified this session)
- Tenant rent/income chart (reads `tenant.rents` only) — owner_occupied has no tenant.
- Tenant settlements + tenant receipt PDF — no tenant on owner_occupied units.
  (Caveat: this invariant is enforced ONLY by the J2 guard — nothing on the read
  path filters owner_occupied out of tenant surfaces.)
- `ownerSlicesOf` utility itself — a correct % splitter; the fix is in its callers.

## Resolved (was "open decision blocking J10")
The split is already modelled: expense `amount` = occupant/tenant pool,
`ownerAmount` (with `trackOwnerExpense`) = owner pool. No new field. J10 void.
The B-F fix (J11) routes the OCCUPANT pool of an owner_occupied unit to the
resident owner(s) instead of splitting it across all co-owners by %.
