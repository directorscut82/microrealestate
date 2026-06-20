# Fix Plan — UI Consistency Across Expense/Charge Panels

## Problem

Every panel that shows building charges renders them in a different format. The landlord sees the same data presented inconsistently depending on which page they're on.

## Current state (broken)

### Building Eksoda breakdown (right panel ΧΡΕΩΣΕΙΣ)

ΕΝΟΙΚΙΑΣΤΕΣ section — each charge line:
- Line 1: `Θέρμανση (τεστε2) (66.75 τ.μ. ÷ 493.25 τ.μ. × 0.36 € = 0.05 €)  0,05 €` — has name + full formula
- Line 2: `Ασφάλιση (τεστε)  0,04 €` — has name, NO formula
- Line 3: `Επισκευή (Repair: ασανσερτ)  10,00 €` — English "Repair:" mixed in, NO formula

ΙΔΙΟΚΤΗΤΕΣ section:
- `Ιδιοκτήτες· Ιδιοκτήτης: ΔΟΚΙΜΗ ΛΑΜΔΑ, ΔΟΚΙΜΗ ΚΑΠΠΑ  50,00 €`
- Sub-line: `Επισκευή (ασανσερτ) (μερίδιο ιδιοκτήτη) (ΔΟΚΙΜΗ ΛΑΜΔΑ 50% = 25,00 €, ΕΠΙΤΡΟΠΟ...  50,00 €`

### Owner detail page — Χρεώσεις section

- `06/2026 · ΟΔΟΣ ΗΤΑ 24 · Επισκευή (ασανσερτ) (ΔΟΚΙΜΗ ΛΑΜΔΑ 50% = 25,00 €, ΔΟΚΙΜΗ ΚΑΠΠΑ 50% = 25,00 €)  25,00 €  Οφειλές 25,00 €`
- Same line repeated 3x with different amounts (25€, 5€, 5€) — one per unit distribution

### Dashboard tooltip

- Shows summary per owner/category, not per-unit breakdown. Less detail, which is correct for a tooltip.

## Issues

1. **Inconsistent format** — formula shown on some lines, not others
2. **Redundant labels** — "Ιδιοκτήτες· Ιδιοκτήτης:" prefix is noise
3. **English mixed with Greek** — "Repair:" in Greek UI
4. **Internal names shown** — "(τεστε2)" is a test name, "(d6aa8660a511)" is an ObjectId
5. **(κενή μονάδα) / (μερίδιο ιδιοκτήτη)** — labels that add clutter
6. **Co-owner split repeated on every line** — "(ΔΟΚΙΜΗ ΛΑΜΔΑ 50% = 25€, ΔΟΚΙΜΗ ΚΑΠΠΑ 50% = 25€)" on each of 3 lines

## Proposed fix — consistent format on all panels

### Building Eksoda breakdown (ΧΡΕΩΣΕΙΣ right panel)

ΕΝΟΙΚΙΑΣΤΕΣ — each charge line:
```
Θέρμανση (τεστε2)  (66.75 τ.μ. ÷ 493.25 τ.μ. × 0.36 € = 0.05 €)    0,05 €
Ασφάλιση (τεστε)   (66.75 τ.μ. ÷ 493.25 τ.μ. × 0.04 € = 0.04 €)    0,04 €
Επισκευή (ασανσέρ) (10.00 € ÷ 1 μονάδα = 10.00 €)                   10,00 €
```

Every line: **expense name (label) + (calculation basis) + amount**. Basis always present.

ΙΔΙΟΚΤΗΤΕΣ — group header:
```
ΔΟΚΙΜΗ ΛΑΜΔΑ, ΔΟΚΙΜΗ ΚΑΠΠΑ                               50,00 €
  Επισκευή (ασανσέρ) (ΛΑΜΔΑ 50% = 25€, ΚΑΠΠΑ 50% = 25€)       50,00 €
```

No "Ιδιοκτήτες· Ιδιοκτήτης:" prefix. Just the owner names as header.

### Owner detail page — Χρεώσεις

Group by month, then by building:
```
06/2026 · ΟΔΟΣ ΗΤΑ 24
  Επισκευή (ασανσέρ) — Ολόκληρο κτίριο    25,00 €   Οφειλές 25,00 €
  Επισκευή (ασανσέρ) — Όροφος 4            5,00 €    Οφειλές 5,00 €
  Επισκευή (ασανσέρ) — Ισόγειο             5,00 €    Οφειλές 5,00 €
```

Co-owner split shown ONCE at the group header (not per line). RESOLVED 2026-06-20: the split IS shown, once per month+building group header (e.g. `Συνιδιοκτησία: ΛΑΜΔΑ 50% · ΚΑΠΠΑ 50%`), NOT repeated on each charge line. (Earlier this line said "show none"; that was the outlier — OD3 + the user-approved render both show it once at group level. Implemented in `owners/[id].js` `_groupCharges`.)

### Dashboard tooltip

Stays as-is — summary level, no per-unit breakdown. Correct for its context.

## Files to change

1. `webapps/landlord/src/components/buildings/BuildingExpensePanel.js` — ΧΡΕΩΣΕΙΣ breakdown render
2. `webapps/landlord/src/pages/[organization]/owners/[id].js` — Owner Χρεώσεις section
3. `services/api/src/businesslogic/tasks/1_base.ts` — `computeBuildingExpenseBreakdown` must return basis for ALL row types (currently repairs return `{kind: 'none'}`)

## Delete behavior — expenses and repairs (bug fix + repair soft delete)

### Expense delete (existing options, owner payment bug fix)

**Soft (end from current month):**
- Future months: no charge generated for anyone
- Past months renter side: persisted monthlyCharges stay → tenant rents unchanged, payments untouched
- Past months owner side: persisted ownerMonthlyExpenses stay → owner ledger unchanged, payments untouched

**Hard (delete permanently):**
- Renter side: strips monthlyCharges → tenant rents recomputed → if tenant already paid, credit appears on their balance
- Owner side: strips the CHARGE (amount owed) but **keeps recorded payments** → owner shows a credit/overpayment on their ledger. Payment never disappears.

### Repair delete (NEW: add soft option, fix owner payment bug)

**Soft (stop charging from current month) — NEW:**
- Future months: no charge generated for anyone
- Past months renter side: persisted monthlyCharges stay → tenant rents unchanged, payments untouched
- Past months owner side: persisted ownerMonthlyExpenses stay → owner ledger unchanged, payments untouched
- Repair stays visible in the list as inactive/ended

**Hard (delete permanently):**
- Renter side: strips monthlyCharges → tenant rents recomputed → if tenant already paid, credit appears on their balance
- Owner side: strips the CHARGE (amount owed) but **keeps recorded payments** → owner shows a credit/overpayment on their ledger. Payment never disappears.
- Repair removed from list entirely

### BUG: owner payments lost on hard delete (both expenses and repairs)

Currently both expense and repair hard delete call `.pull()` on the entire `ownerMonthlyExpenses` entry — which deletes the `payments[]` array inside it. Recorded money vanishes.

**Fix:** Before pulling an ownerMonthlyExpenses entry that has payments, migrate the payments into a credit entry (amount=0, payments preserved, source='credit') so the owner ledger retains the payment record as an overpayment/credit.

### Changes required

| # | File | What |
|---|------|------|
| 1 | `buildingmanager.ts` `removeExpense` hard path ~line 3339 | Before pulling ownerMonthlyExpenses entries, check for payments. If payments exist, zero the amount instead of pulling (keeps payment record as credit) |
| 2 | `buildingmanager.ts` `_removeRepairCharges` ~line 3532 | Same: before pulling owner entries with payments, preserve as credit |
| 3 | `buildingmanager.ts` `removeRepair` | Add soft-delete path: set repair `endTerm` (or equivalent) so `_distributeRepairCharge` skips future months but leaves past charges intact |
| 4 | `RepairList.js` | Add delete dialog with soft/hard options + impact warning (same UI as expense delete dialog) |
| 5 | `RepairList.js` | Change current `status:'cancelled'` behavior — cancelled should NOT strip charges (it currently calls `_removeRepairCharges`). Cancelled = soft delete semantics |

---

## Building flags (Ανελκυστήρας / Κεντρική Θέρμανση) must gate options

Currently the `hasElevator` and `hasCentralHeating` toggles only affect the buildings-list filter chips. They don't gate anything in forms. This means:

- You can pick `elevator_thousandths` allocation on a building with no elevator
- You can create an elevator repair on a building with no elevator
- You can pick `heating_thousandths` allocation on a building with no central heating
- Toggling "Κεντρική Θέρμανση" ON shows 4 heating types including "Autonomous" and "None" which contradict central heating

### Fixes

| # | What | Where |
|---|------|-------|
| 1 | Hide `elevator_thousandths` from allocation dropdown when `building.hasElevator === false` | `ExpenseList.js` `getAllocationMethodsForType` + `RepairList.js` allocation dropdown |
| 2 | Hide `heating_thousandths` from allocation dropdown when `building.hasCentralHeating === false` | Same |
| 3 | Hide elevator-related repair categories when `building.hasElevator === false` | `RepairList.js` category dropdown |
| 4 | Hide heating-related expense types when `building.hasCentralHeating === false` | `ExpenseList.js` expense type dropdown |
| 5 | Remove "Autonomous" and "None" from heating type options | `BuildingForm.js` `heatingTypes` array — only keep `central_oil` and `central_gas` (both are actual central heating types) |

---

## Remove: "Πληρωμή από ταμείο επισκευών" toggle (AI slop)

The `isPaidFromRepairsFund` field on repairs and its UI toggle ("Paid from repairs fund") is AI slop that was added without purpose. It's "informational" — doesn't affect any computation, doesn't connect to any fund balance, doesn't change billing. It's a dead toggle that confuses the UI.

**Remove:**
- `isPaidFromRepairsFund` from the zod schema in RepairList.js
- The Switch + Label UI in the repair form
- The `isPaidFromRepairsFund` default in form reset values
- The validation bypass at line 109 (`!data.isPaidFromRepairsFund`)

**Do NOT remove** from the Mongoose schema (existing docs may carry the field; removing from DB schema would require a migration). Just stop reading/writing it in the UI.

## New feature: Αχρέωτα tracking + voluntary payment

Currently Αχρέωτα are computed live in the ΧΡΕΩΣΕΙΣ panel and not persisted or surfaced anywhere else. They represent money that evaporates because vacant units have no tenant and chargeOwnerWhenVacant is OFF.

### Surfaces that must show Αχρέωτα

1. **Building Επισκόπηση** — new tile/section underneath Έσοδα/Έξοδα showing cumulative Αχρέωτα (sum across all months). Shows total money lost to vacant units. Reduces when someone voluntarily pays toward it.

2. **ΧΡΕΩΣΕΙΣ breakdown panel** — existing Αχρέωτα warning (already there). Amount reduces when a payment covers it.

3. **Payment dialog (renter AND owner) — manual κατανεμημένη πληρωμή** — when landlord chooses manual allocation, show an additional Αχρέωτα bucket. Landlord can direct part of the payment to cover building αχρέωτα. This is VOLUNTARY — it does NOT count as χρέος/debt for anyone.

### Key principle: Αχρέωτα is NOT a liability

- Nobody owes it. It's not a debt.
- A payment toward it is a voluntary contribution, not a settlement of debt.
- It should never appear in Οφειλές for any renter or owner.

### When someone pays toward Αχρέωτα, surfaces that update

1. **Building Επισκόπηση Αχρέωτα tile** — total reduces (cumulative αχρέωτα - cumulative paid toward αχρέωτα)
2. **ΧΡΕΩΣΕΙΣ breakdown panel** — Αχρέωτα warning amount reduces or disappears for that term
3. **Payer's own ledger** — payment shows in their history (renter: rent history; owner: Χρεώσεις/Καταβολές). Labeled as voluntary contribution to building expenses, NOT as debt settlement.
4. **Τιμολόγια** — if a receipt is generated, it notes "κάλυψη κοινοχρήστων κτιρίου" (building expenses cover), not rent or owner-debt.

### Data model implication

The payment lives on the PAYER (renter's `rent.payments[]` or owner's `ownerMonthlyExpenses[].payments[]`) but must link to the BUILDING's uncollected pool. Needs:
- A new allocation category (e.g. `'building_uncollected'`) in the payment's `allocation[]` array
- The building ID + term so the Επισκόπηση tile can sum payments directed at αχρέωτα
- OR a new subdocument on the Building (e.g. `uncollectedPayments[]`) that records who paid what toward which term's αχρέωτα

## Move repairs into Έξοδα tab + simplify repair form

Since the ΧΡΕΩΣΕΙΣ breakdown already shows repairs alongside recurring expenses in one unified panel, repairs should be listed and created from the same Έξοδα tab.

### Current state
- **Έξοδα tab**: "Προσθήκη Δαπάνης" + "Εισαγωγή Λογαριασμού" + "Αποδείξεις Πληρωμής" buttons, expense table, monthly statement panel, ΧΡΕΩΣΕΙΣ breakdown
- **Επισκευές & Εργολάβοι tab**: "Προσθήκη Επισκευής" button, repair table (status/urgency/category/contractor/cost/chargeTerm columns), ContractorList

### Target state
- **Έξοδα tab**: "Προσθήκη Δαπάνης" + **"Προσθήκη Επισκευής"** + "Εισαγωγή Λογαριασμού" + "Αποδείξεις Πληρωμής". Expense table + Repair table (unified row format) + monthly statement panel + ΧΡΕΩΣΕΙΣ breakdown
- **Εργολάβοι tab** (renamed): only ContractorList

### Repair form simplification (remove AI slop dates)

Current form has 4 date fields: reportedDate, startDate (labeled "Scheduled date"), completionDate, chargeTerm. This is overengineered.

**New model:**
- **chargeTerm** = the month the repair starts being charged (implicit: the month you add it, or manually chosen)
- **completionDate** (optional) = if set, the cost is split evenly across months from chargeTerm to completionDate

Example: 100€ repair, chargeTerm June 2026, completionDate August 2026 → 33.33€/month for June, July, August. No completionDate → full 100€ charged in June.

**Remove from form:** reportedDate, startDate (scheduledDate). Keep only chargeTerm + completionDate.

### Unified repair row in expense table

Repairs listed in the same visual format as expenses:
```
Όνομα          Τύπος        Ποσό       Κατανομή    Χρέωση         Επαναλ.    Ενέργειες
Κοιν. Νερό     Κοιν. Νερό   1,70 €     Ισομερής   06/2026 →      Ναι        ✏️ 🗑️
Ρεύμα          Κοιν. Ρεύμα  —          Ισομερής   06/2026 →      Ναι (κυμ.) ✏️ 🗑️
Ασανσέρ        Επισκευή     100,00 €   Ισομερής   06–08/2026     Όχι        ✏️ 🗑️
```

- Repairs show as one-off (Επαναλ. = Όχι)
- Charge column shows single month or range (chargeTerm–completionDate)
- Clicking edit opens the repair dialog (with cost, chargeableTo, allocation, affected units, contractor, completionDate)

### Changes required

| # | File | What |
|---|------|------|
| 1 | `pages/[organization]/buildings/[id].js` | Move RepairList into expenses TabsContent. Rename "Επισκευές & Εργολάβοι" → "Εργολάβοι" |
| 2 | `RepairList.js` | Remove reportedDate, startDate from zod schema and form UI. Keep only chargeTerm + completionDate |
| 3 | `RepairList.js` | Remove `isPaidFromRepairsFund` toggle (AI slop) |
| 4 | `RepairList.js` | Add `chargeOwnerWhenVacant` toggle (real functionality) |
| 5 | `RepairList.js` table render | Change table columns to match expense table format (Name, Type, Amount, Allocation, Charge period, Recurring=Όχι) |
| 6 | `buildingmanager.ts` `_distributeRepairCharge` | When completionDate set, split cost across months (chargeTerm to completionDate). Create one `monthlyCharge` per unit per term in the range + one `ownerMonthlyExpenses` entry per term for owner-side charges |
| 7 | `buildingmanager.ts` `_distributeRepairCharge` | Respect `chargeOwnerWhenVacant` flag — when OFF, don't create `source:'repair-vacant'` entries |
| 8 | `locales/el/common.json` | Update tab label, remove unused date labels |

### Multi-month repair: surfaces affected + verification

When a repair spans multiple months (chargeTerm to completionDate), `_distributeRepairCharge` creates N entries (one per month). All downstream surfaces filter by term, so they should pick up only the correct month's portion:

| Surface | How it reads the data | Verification needed |
|---------|----------------------|-------------------|
| Left panel monthly statement | `buildRowsForTerm` reads `unit.monthlyCharges` filtered by `charge.term === selectedTerm` | Only shows the per-month portion for the viewed month ✓ |
| Right panel ΧΡΕΩΣΕΙΣ | `computeBuildingExpenseBreakdown` iterates `unit.monthlyCharges` where `term === requestedTerm` | Only shows that month's charges ✓ |
| Tenant rent (`1_base.ts`) | Reads `unit.monthlyCharges.filter(c => c.term === rent.term)` | Only bills the per-month portion on each rent ✓ |
| Owner detail Χρεώσεις | Reads `ownerMonthlyExpenses` — one entry per term exists | Shows one line per month in the owner's charge list ✓ |
| Τιμολόγια 12-month grid | Owner settlements built from charges grouped by term → month | Payment cells appear only in active months ✓ |
| Building Επισκόπηση tiles | Sums from `ownerMonthlyExpenses` per term | Repair counted only in active months ✓ |
| Dashboard bar charts | Rolls up per-term from the rent pipeline output | Repair portion in correct month bars ✓ |
| Calendar month picker (green dot) | Checks if any monthlyCharge/ownerExpense exists for term | Dot shows for active months only ✓ |
| Αχρέωτα | Computed from `computeBuildingExpenseBreakdown` per term | Vacant shares appear only in active months ✓ |

**Key implementation rule:** `_distributeRepairCharge` must create per-term entries for BOTH sides:
- Renter side: one `monthlyCharge` per unit per term (amount = total ÷ months ÷ units allocation)
- Owner side: one `ownerMonthlyExpenses` entry per term for `source:'repair'` + one per vacant unit per term for `source:'repair-vacant'`

On UPDATE (cost/completionDate changes): the existing pool mechanism (strip all, rebuild, reapply payments) handles this — it already works per-property. Extending to multi-term means the pool spans all terms and redistributes across the new N entries.

## FULL LIST OF ALL CHANGES

### 1. ΧΡΕΩΣΕΙΣ breakdown — consistent format (ΕΝΟΙΚΙΑΣΤΕΣ + ΙΔΙΟΚΤΗΤΕΣ)

| # | What | File | What changes |
|---|------|------|-------------|
| 1.1 | Every charge line must show basis | `BuildingExpensePanel.js` | Repairs currently return `basis: {kind:'none'}` from server → show no formula. Server must return a real basis for repairs too. |
| 1.2 | Server: repair rows need calculation basis | `buildingmanager.ts` `getExpenseBreakdown` ~line 2846 | When `source:'repair'` or `source:'repair-vacant'`, compute and return a basis like `{kind:'repair_split', total:100, ownerPct:50, result:50}` or `{kind:'repair_vacant', total:100, tenantPct:50, units:5, result:10}` |
| 1.3 | Frontend: render repair basis | `BuildingExpensePanel.js` `formatBasis()` | Add cases for the new basis kinds so they render as `(100 € × 50% μερίδιο ιδιοκτητών = 50.00 €)` and `(100 € × 50% ÷ 5 μονάδες, Όροφος 4 = 10.00 €)` |
| 1.4 | Remove "Ιδιοκτήτες· Ιδιοκτήτης:" prefix | `BuildingExpensePanel.js` ~line 899 | Group header shows just owner names, no prefix |
| 1.5 | Remove "(μερίδιο ιδιοκτήτη)" / "(κενή μονάδα)" inline labels | `BuildingExpensePanel.js` ~line 914-927 | Remove the source-indicator spans |
| 1.6 | Co-owner split shown ONCE per group, not per line | `BuildingExpensePanel.js` | Move `CoOwnerSplit` from each item line to after the last item in the group |
| 1.7 | Expense name fallback when hex ObjectId | `BuildingExpensePanel.js` + `ExpenseList.js` | Already partially done — extend to monthly statement rows |
| 1.8 | Αχρέωτα section shows repairs too (when flag disabled) | `BuildingExpensePanel.js` ~line 942 | Currently only shows expenses. With the new repair flag, repair-vacant rows with flag OFF go here too |

### 2. New feature: `chargeOwnerWhenVacant` flag on repairs

| # | What | File | What changes |
|---|------|------|-------------|
| 2.1 | Add field to repair schema | `services/common/src/collections/building.ts` | Add `chargeOwnerWhenVacant: Boolean` to RepairSchema |
| 2.2 | Add toggle to repair form UI | `RepairList.js` | Switch + Label next to chargeableTo/chargeTerm fields |
| 2.3 | `_distributeRepairCharge` respects the flag | `buildingmanager.ts` ~line 3750 | When `chargeOwnerWhenVacant === false`, do NOT create `source:'repair-vacant'` entries. Those amounts go to Αχρέωτα (computed live, not persisted) |
| 2.4 | `getExpenseBreakdown` routes repair-vacant to uncollected when flag OFF | `buildingmanager.ts` ~line 2853 | Filter repair-vacant rows into `ownerVacantRows` instead of `ownerDirect` when the repair's flag is OFF |

### 3. Remove "Πληρωμή από ταμείο επισκευών" toggle (AI slop)

| # | What | File | What changes |
|---|------|------|-------------|
| 3.1 | Remove from zod schema | `RepairList.js` line 94 | Delete `isPaidFromRepairsFund: z.boolean().optional()` |
| 3.2 | Remove Switch UI | `RepairList.js` ~line 959 | Delete the Switch + Label + description text |
| 3.3 | Remove from form defaults | `RepairList.js` line 282 | Delete `isPaidFromRepairsFund: selectedRepair?.isPaidFromRepairsFund ?? false` |
| 3.4 | Remove validation bypass | `RepairList.js` line 109 | Change `data.status === 'completed' && !data.isPaidFromRepairsFund` to just `data.status === 'completed'` |

### 4. Move "Προσθήκη Επισκευής" to Έξοδα tab

| # | What | File | What changes |
|---|------|------|-------------|
| 4.1 | Move RepairList into expenses tab | `pages/[organization]/buildings/[id].js` | Move `<RepairList>` from repairs TabsContent to expenses TabsContent (below ExpenseList) |
| 4.2 | Rename tab | `pages/[organization]/buildings/[id].js` | "Επισκευές & Εργολάβοι" → "Εργολάβοι" |
| 4.3 | Update tab i18n | `locales/el/common.json` | Update label |

### 5. Αχρέωτα tracking + voluntary payment

| # | What | File | What changes |
|---|------|------|-------------|
| 5.1 | Building Επισκόπηση tile | `BuildingOverview.js` (or new component) | New tile showing cumulative αχρέωτα = sum of uncollected amounts across all terms, minus any voluntary payments |
| 5.2 | Persist voluntary payments | `Building` schema | New subdocument array `uncollectedPayments: [{term, amount, paidBy, paidByType:'renter'|'owner', payerId, date}]` |
| 5.3 | API route to record payment | `buildingmanager.ts` | `POST /buildings/:id/uncollected-payment` |
| 5.4 | Payment dialog — αχρέωτα bucket | `PaymentTabs.js` + `OwnerPaymentDialog.js` | In manual allocation mode, add "Κάλυψη αχρέωστων κτιρίου" bucket. Amount goes to building's `uncollectedPayments[]` |
| 5.5 | ΧΡΕΩΣΕΙΣ panel reads voluntary payments | `BuildingExpensePanel.js` | Subtract paid amounts from αχρέωτα total per term |
| 5.6 | Receipt label | PDF template / accountingmanager | When payment has allocation to `building_uncollected`, receipt prints "κάλυψη κοινοχρήστων κτιρίου" |

### 6. Tooltip scroll fix

| # | What | File | What changes |
|---|------|------|-------------|
| 6.1 | Outer tooltip div scrollable | `YearFigures.js` | `max-h-[400px] overflow-y-auto scrollbar-branded` on outer div |
| 6.2 | Same for expenses chart | `ExpensesYearFigures.js` | Same change |

### 7. Owner detail Ακίνητα — address

| # | What | File | What changes |
|---|------|------|-------------|
| 7.1 | Fetch Property docs for address | `ownermanager.ts` `one()` | Query Properties by the unit propertyIds to populate address (already done in local commit) |

### 8. Τιμολόγια owner tab — identical layout to tenants

| # | What | File | What changes |
|---|------|------|-------------|
| 8.1 | Server returns per-month settlements | `ownermanager.ts` `_serializeOwnerSummary` | Build 12-slot settlements array from charges (already done in local commit) |
| 8.2 | OwnerStatements uses 12-month grid | `OwnerStatements.js` | Rewritten to match TenantSettlements layout (already done in local commit) |

### 9. Owner detail Χρεώσεις — clean presentation

| # | What | File | What changes |
|---|------|------|-------------|
| 9.1 | Group by repair/expense, not by unit | `pages/[organization]/owners/[id].js` | Currently one line per unit-distribution. Should group by expense/repair with sub-lines per unit |
| 9.2 | Remove co-owner split repetition | Same | Show co-owner split once at group level, not on every line |
| 9.3 | Consistent basis format | Same | Each sub-line shows its calculation like the ΧΡΕΩΣΕΙΣ panel |

## Understanding the ΙΔΙΟΚΤΗΤΕΣ charges (NOT a double-count)

After reading `_distributeRepairCharge` (line 3750+):

- `source:'repair'` (50€, propertyId: null) = the OWNER-DIRECT portion of the repair (when chargeableTo='owners', the full cost; when 'split', the owner's percentage)
- `source:'repair-vacant'` (10€ each, with propertyId) = the TENANT share of individual vacant units that falls to the owner because no tenant occupies them

These are SEPARATE charges that DO add up: total owner liability = 50 + 10 + 10 = 70€. NOT a double-count.

The problem: the UI presents them as three incomprehensible groups with repeated owner names and co-owner splits on every line. The landlord cannot tell:
1. What's the total they owe
2. Why there are 3 separate entries for the same repair
3. What "μερίδιο ιδιοκτήτη" vs "κενή μονάδα" means

**Correct presentation:**

Reference format from ΕΝΟΙΚΙΑΣΤΕΣ (this is the standard all lines must follow):
```
Θέρμανση (τεστε2) (66.75 τ.μ. ÷ 493.25 τ.μ. × 0.36 € = 0.05 €)    0,05 €
Ασφάλιση (τεστε)  (66.75 τ.μ. ÷ 493.25 τ.μ. × 0.04 € = 0.04 €)    0,04 €
Επισκευή (ασανσέρ) (10.00 € ÷ 1 μονάδα = 10.00 €)                   10,00 €
```
Pattern: Name (label) (calculation basis appropriate to allocation method) amount

ΙΔΙΟΚΤΗΤΕΣ — consistent with above, NOT identical.

**chargeOwnerWhenVacant flag on repairs — ENABLED (owner is charged for vacant units):**

Case 1: Multiple owners, repair split 50% tenant / 50% owner, total cost 100€, single month:
```
ΔΟΚΙΜΗ ΛΑΜΔΑ, ΔΟΚΙΜΗ ΚΑΠΠΑ (50%/50%)                              70,00 €
  Επισκευή (ασανσέρ) (100 € × 50% μερίδιο ιδιοκτητών = 50.00 €)          50,00 €
  Επισκευή (ασανσέρ) (100 € × 50% ÷ 5 μονάδες, Όροφος 4 = 10.00 €) *    10,00 €
  Επισκευή (ασανσέρ) (100 € × 50% ÷ 5 μονάδες, Ισόγειο = 10.00 €) *     10,00 €

* κενές μονάδες — οι ιδιοκτήτες χρεώνονται
```

Case 1b: Same repair but spread over 3 months (completionDate set), viewing ONE month:
```
ΔΟΚΙΜΗ ΛΑΜΔΑ, ΔΟΚΙΜΗ ΚΑΠΠΑ (50%/50%)                                   23,33 €
  Επισκευή (ασανσέρ) (100 € ÷ 3 μήνες × 50% μερίδιο ιδιοκτητών = 16.67 €)     16,67 €
  Επισκευή (ασανσέρ) (100 € ÷ 3 μήνες × 50% ÷ 5 μονάδες, Όροφος 4 = 3.33 €) * 3,33 €
  Επισκευή (ασανσέρ) (100 € ÷ 3 μήνες × 50% ÷ 5 μονάδες, Ισόγειο = 3.33 €) *  3,33 €

* κενές μονάδες — οι ιδιοκτήτες χρεώνονται
```

Case 2: Single owner (ΒΗΤΑ 50%), one expense (Νερό), equal allocation:
```
ΔΟΚΙΜΗ ΒΗΤΑ (50%)                                                    0,21 €
  Κοιν. Νερό (τεστε) (1.7 € ÷ 11 μονάδες × 50% = 0.11 €)                0,21 €
```

**chargeOwnerWhenVacant flag on repairs — DISABLED (vacant units go to Αχρέωτα):**

Single month:
```
ΙΔΙΟΚΤΗΤΕΣ
ΔΟΚΙΜΗ ΛΑΜΔΑ, ΔΟΚΙΜΗ ΚΑΠΠΑ (50%/50%)                              50,00 €
  Επισκευή (ασανσέρ) (100 € × 50% μερίδιο ιδιοκτητών = 50.00 €)          50,00 €

⚠ Αχρέωτα (κενές μονάδες)                                                 20,15 €
Ενεργοποίησε «Χρέωση ιδιοκτήτη για κενές μονάδες» σε αυτές τις επισκευές ώστε να χρεωθούν στον ιδιοκτήτη αντί να μένουν αχρέωτα.
  Επισκευή (ασανσέρ), Όροφος 4                                            10,00 €
  Επισκευή (ασανσέρ), Ισόγειο                                             10,00 €
  Θέρμανση (τεστε2), Όροφος 4                                              0,11 €
  Θέρμανση (τεστε2), Ισόγειο                                               0,04 €
```

Spread over 3 months, viewing ONE month:
```
ΙΔΙΟΚΤΗΤΕΣ
ΔΟΚΙΜΗ ΛΑΜΔΑ, ΔΟΚΙΜΗ ΚΑΠΠΑ (50%/50%)                                   16,67 €
  Επισκευή (ασανσέρ) (100 € ÷ 3 μήνες × 50% μερίδιο ιδιοκτητών = 16.67 €)     16,67 €

⚠ Αχρέωτα (κενές μονάδες)                                                       6,81 €
  Επισκευή (ασανσέρ), Όροφος 4                                                   3,33 €
  Επισκευή (ασανσέρ), Ισόγειο                                                    3,33 €
  Θέρμανση (τεστε2), Όροφος 4                                                    0,11 €
  Θέρμανση (τεστε2), Ισόγειο                                                     0,04 €
```

## Left panel (monthly statement) — fix

**Current (garbage):**
```
Ιούνιος 2026                    55,14 €
                            Ενοικιαστές

d6aa8660a511 (Ισομερής)          1,70 €
Ρευμα (Ισομερής)            [53,44] € 💾

ΙΔΙΟΚΤΗΤΕΣ                      0,21 €
d6aa8660a511 (Ισομερής)     [0,21]  € 💾
```

**Should be (including repairs after the tab merge):**
```
Ιούνιος 2026

Ενοικιαστές                               55,14 €
  Κοιν. Νερό (d6aa8660a511)                1,70 €
  Κοιν. Ρεύμα (Ρευμα)                [53,44] € 💾
  Επισκευή (ασανσέρ)                       10,00 €

Ιδιοκτήτες                                50,21 €
  Κοιν. Νερό (d6aa8660a511)           [0,21] € 💾
  Επισκευή (ασανσέρ)                       50,00 €
```

Changes:
- Each line: **Type label (expense name)** — type label from `BUILDING_TYPE_LABEL_KEY`, expense name in parentheses always (even when it's an ObjectId — the landlord created it, they should see it)
- NO allocation method in parentheses — "(Ισομερής)" is noise, the landlord doesn't need to see HOW it's split here
- "Ενοικιαστές" / "Ιδιοκτήτες" as consistent section headers (same case, same style, same position)
- Totals inline with the section headers, not floating above with a detached label underneath
- Repairs appear as fixed lines (not editable — cost set in repair form). Same format: Type label (name) + amount. If a repair spans multiple months (completionDate set), shows only the per-month portion for the selected month.

## Property detail page — "Έξοδα ακινήτου" card

This card lives on the Property detail page (Ακίνητο). Shows all building expenses for this specific unit — both tenant-borne and owner-borne. Totals include both. Calculates correctly across 13 months (past 12 + current).

**Current (broken):**
```
Τρέχων μήνας (Ιουν 2026)              5,01 €
  Ύδρευση (d6aa8660a511asdas)           0,15 €
  (ενοικιαστής)
  Ηλεκτρισμός (Ρευμα) (ενοικιαστής)    4,86 €

Σύνολο διαστήματος (Ιουν 2025 — Ιουν 2026)    5,01 €
```

Issues:
- ObjectId as expense name
- "(ενοικιαστής)" on separate line for first item, inline for second — inconsistent
- Total only shows tenant portion (5,01€), missing owner's 0,11€
- Owner charges not shown at all

**Should be:**
```
Έξοδα ακινήτου

Τρέχων μήνας (Ιουν 2026)                5,12 €
  Ύδρευση (d6aa8660a511)                 0,15 €
  Ηλεκτρισμός (Ρευμα)                   4,86 €
  Ύδρευση (d6aa8660a511) — ιδιοκτήτης   0,11 €

Σύνολο διαστήματος (Ιουν 2025 — Ιουν 2026)    5,12 €
```

- Total includes ALL charges for this property (tenant + owner)
- Owner lines marked with "— ιδιοκτήτης" at end
- Type label (expense name) format, consistent with other panels
- No separate-line "(ενοικιαστής)" — tenant lines are unmarked (default), owner lines are marked

### Changes required

| # | File | What |
|---|------|------|
| 1 | `propertymanager.ts` `getExpenses` | Ensure owner charges (source:'vacant', 'owner-resident', 'repair', 'repair-vacant') for this propertyId are included in the totals, not excluded |
| 2 | `PropertyExpensesCard.js` | Remove inline "(ενοικιαστής)" / "(ιδιοκτήτης)" per-line payer labels. Instead: owner lines get "— ιδιοκτήτης" suffix, tenant lines unmarked |
| 3 | `PropertyExpensesCard.js` | Consistent format: Type label (expense name) + amount. No separate-line wrapping |

## Open questions for the user — RESOLVED 2026-06-20

- ~~For the owner detail Χρεώσεις: is grouping by month+building correct, or should it be a flat list?~~ → **RESOLVED: group by month + building** (user-approved render + implemented in `owners/[id].js` `_groupCharges`).
- ~~Should the co-owner split show at all on the owner's own page?~~ → **RESOLVED: show it ONCE at the group header**, not per line (and only when the group is uniformly co-owned; mixed groups show per-line — Step-7 batch1 OWN-1). Fixed the contradicting line 69 above.

---

# AI-SLOP INVESTIGATION (in progress, 2026-06-20) — DO NOT EXECUTE ANY FIX YET

> Findings are being accumulated surface-by-surface from the user's screenshots. **No code change,
> no deploy, until the investigation is declared complete by the user.** When it is, the confirmed
> findings below (and the rest of this plan) execute as one batch. Every finding must be sourced
> to a file:line read this session before it is written here (no-fabrication rule); first-pass
> misreads are retracted in place, not silently deleted.

## Owner detail page (`owners/[id].js`) — findings from screenshot `2026-06-20 20.34.33` (ΔΟΚΙΜΗ ΚΑΠΠΑ)

> Tier: UI (presentation of already-computed owner-debt data). Every line below is sourced
> from the screenshot and confirmed against `webapps/landlord/src/pages/[organization]/owners/[id].js`
> (read 2026-06-20). Two of my first-pass screenshot reads were WRONG and are retracted at the
> bottom so they don't get "fixed" by mistake. Reference render is in the chat for this session.

### Confirmed defects

| # | What's on screen | Root cause (file:line) | Fix |
|---|------------------|------------------------|-----|
| OD1 | Ακίνητα rows show only the **raw ATAK number** (`00112233465` …); the address column is blank for all 9 even though `ΟΔΟΣ ΗΤΑ 24` exists in Χρεώσεις | `owners/[id].js:159-165` renders `prop.address.street1/city/zipCode` else `prop.propertyName`. The deployed NAS revision predates the worktree `ownermanager.ts` which now populates `address`/`propertyName` (`ownermanager.ts:682-683`, the local edit). So the JSX is correct; the **deployed server isn't sending `address`** yet. | Deploy the worktree `ownermanager.ts` change (the `Property.findOne` populate at ~`ownermanager.ts:649-690`). No frontend change needed. This is FIX_PLAN item 7.1, **already coded locally, not yet deployed.** |
| OD2 | Three Χρεώσεις rows are **visually identical** (`06/2026 · ΟΔΟΣ ΗΤΑ 24 · Επισκευή (ασανσερτ) …`); only the amounts (25 / 5 / 5) differ. Landlord can't tell which unit each is. | `owners/[id].js:191-193` renders `term · buildingName · ownerChargeLabel(t, c)` with NO per-unit discriminator. `ownerChargeLabel` (`lineLabels.js:85-97`) returns only type-label + description. | Add a per-unit suffix to each charge row (e.g. `— ολόκληρο κτίριο` / `— <όροφος/μονάδα>`). Needs the server to send a unit/scope label on the charge object (the building-wide `source:'repair'` row vs the per-`propertyId` `source:'repair-vacant'` rows). FIX_PLAN item 9.1. |
| OD3 | Co-owner split `(ΔΟΚΙΜΗ ΛΑΜΔΑ 50% = X, ΔΟΚΙΜΗ ΚΑΠΠΑ 50% = X)` repeated on **all three** rows of the same repair, on the owner's OWN page | `owners/[id].js:194-209` renders the `c.coOwners` split inline per charge row | Show the co-owner split ONCE at a group header (per month+building group), not per line. FIX_PLAN item 9.2. Gated by the open question below (should it show at all on his own page?). |
| OD4 | Top tile pair renders as malformed `−/ 35,00 €` (a `—` glued to ` / ` with no left value) | `owners/[id].js:112-118`: `<NumberFormat value={paid} />` with `paid=0` → `NumberFormat.js:53-58` returns `'—'` (no `showZero`), then literal `' / '`, then total | Pass `showZero` to the paid `<NumberFormat>` at `:113` so it renders `0,00 € / 35,00 €`. One-prop change. (`NumberFormat` already supports `showZero` — `NumberFormat.js:23`.) |

### Retracted (first-pass screenshot misreads — do NOT action)

- ~~"Tile label `ΕΣΟΔΑ`/income is backwards"~~ — WRONG. Label is `t('Owner expenses paid')` → el.json:578 `"Πληρωμένα έξοδα ιδιοκτήτη"` (έξοδα = expenses, correct). I misread uppercase Ξ as Σ in the screenshot.
- ~~"Blank percentages on Ακίνητα rows #6–#9 are a bug"~~ — NOT a bug. `owners/[id].js:167-169` deliberately hides `percentage >= 100` (blank = sole owner). Same intentional rule as the header `(50%)` at `:73-78` (only shown when `< 100`). This is a possible UX-clarity tweak (show "100%" explicitly?), not a defect.

### Net: only OD4 is a pure frontend one-liner. OD1 is already-coded-locally-pending-deploy. OD2/OD3 need a server-side per-unit/scope label on the owner charge object (touches `ownermanager.ts` charge serialization → reclassify to TIER-MONEY if it changes how charges are grouped/summed).

## Τιμολόγια → Εκκαθαριστικά ιδιοκτητών tab (`OwnerStatements.js`) — findings from screenshots `2026-06-20 20.40.xx` (owner tab) compared with the tenant tab (DOKIMASTI E2ETEST) + `TenantSettlements.js`

> Tier: presentation, BUT the root fix is in `ownermanager.ts` settlement serialization → treat with TIER-MONEY caution
> (the totals must still reconcile; do not change how money is computed, only what the monthly grid is built from).
> User instruction (verbatim, 2026-06-20): "I told you to create the owners with identical layout… The right part is
> for notes during the καταβολές (confirm), not for putting the money." Confirmed against
> `TenantSettlements.js` + `OwnerStatements.js` + `ownermanager.ts` (read 2026-06-20).
> This is the IDENTICAL-LAYOUT mandate from FIX_PLAN item 8 — the owner tab diverges from the tenant tab in the ways below.

### The tenant card layout (the reference the owner tab must match — `TenantSettlements.js`)

Card header (`TenantSettlements.js:204-211`): title `Καταβολές` (Payments) on the left, **CSV icon button on the right** (`:207-209`). Per-tenant block header (`:218-235`): name + **`Απόδειξη` receipt button** on one line, then a **second line with the lease date range** `beginDate - endDate` (`:232-235`). Then the 6-col month grid:
- **Left** `col-span-1` (`:140-142`): month name.
- **Middle** `col-span-3` (`:143-178`): the MONEY — each καταβολή renders date (`:164`) + payment type Μεταφορά/Μετρητά (`:171`) + amount (`:173`). Multi-payment months wrap (DOKIMASTI E2ETEST May = 6 payments).
- **Right** `col-span-2` (`:179-190`): payment NOTES only — `Note`/`Discount`/`Extra charge` text (`:128-137`). Empty when no notes (as in the tenant screenshot).

### Confirmed defects in the owner tab (ordered: most visually obvious first)

| # | What's visibly wrong in the screenshot | Root cause (file:line) | Fix |
|---|----------------------------------------|------------------------|-----|
| OS1 | **The money is in the WRONG column.** The only money on screen, `ΟΦΕΙΛΕΣ 35,00 €`, renders in the FAR-RIGHT cell — the column the tenant uses for payment notes. And it is OWED, not a payment, inside a card titled `Καταβολές` (payments made). The tenant grid never shows owed in the grid at all. | `OwnerStatements.js:131-143` renders `Owed` = `Σ s.owed` in the right `col-span-2`; tenant's right `col-span-2` (`TenantSettlements.js:179-190`) is notes-only. | REMOVE the owed block from the right column. Right column = notes recorded during the owner καταβολή, mirroring the tenant. Owed/outstanding belongs in a header total (as on the owner DETAIL page `owners/[id].js:106-131`), NOT in the monthly grid. |
| OS2 | **The middle (money) column is EMPTY for every month** — Ιαν–Μάι show nothing, June shows only the owed on the right. No payment date/type/amount anywhere, unlike the tenant whose middle column is full of payments. | `OwnerStatements.js:110-129` only renders when `s.amount>0` and shows `s.description || t(s.type)` where `type`=charge SOURCE (`ownermanager.ts:549`), `date`=paidDate (`:546`) — charge metadata, not a payment. | Middle column must render each recorded owner καταβολή like the tenant: date + payment type (cash/transfer/cheque) + amount. Depends on OS3. |
| OS3 | **ROOT CAUSE of OS1+OS2 — the owner grid is built from DEBT, the tenant grid from PAYMENTS.** Tenant grid is built from `rent.payments[]` (date/type/amount + notes); owner grid is built from `agg.charges` (paidAmount/owed/source). Opposite information → money in the wrong column + empty middle. | `ownermanager.ts:536-552` builds `settlements[month].push({date: paidDate, amount: paidAmount, owed, type: source, description})`. | Build the owner `settlements[]` from the owner `payments[]` recorded against that owner's charges (each payment → `{date, amount, type, reference, description-as-note}`), keyed into the month grid by payment date/term — structurally mirroring how `TenantSettlements` consumes `rent.payments[]`. Owed leaves the grid (→ header total). **VERIFY: totals (`totalPaid`/`totalOutstanding` `:562-563`) still reconcile; touches money serialization → run money-suite + live readback.** |
| OS4 | **CSV button is MISSING from the owner card header** — the tenant card header has the csv icon top-right; the owner card header has nothing there. | Parent `accounting/[year].js:251-254` does NOT pass `onCSVClick` to `<OwnerStatements>` (passes `getSettlementsAsCsv` to `<TenantSettlements>` at `:246`), and `OwnerStatements.js:156` gates the button on `onCSVClick &&`, so it never renders. | Wire an owner-settlements CSV getter (mirror `getSettlementsAsCsv`) and pass as `onCSVClick`. **VERIFY a server owner-CSV endpoint exists; if not, that is a separate build, not just wiring.** |
| OS5 | **Owner name header has NO date-range line** — the tenant shows a 2nd line (`08/06/2026 - 07/06/2028`); the owner name is a single line, so the block is SHORTER. | `OwnerStatements.js:169-175` renders only the name row, no subtitle line; tenant renders the date range at `TenantSettlements.js:232-235`. | Add a second header line for the owner so the block matches the tenant's height. Owners have no lease range, so use an owner-appropriate subtitle (e.g. # units / # buildings, or ΑΦΜ) — a placeholder line is still needed to keep the heights identical. |
| OS6 | **HEIGHT/ALIGNMENT INCONSISTENCY (consequence of OS4+OS5).** Because the owner header is missing the CSV icon AND the date-range line, the owner header collapses from 2 lines to 1; this shifts the `Απόδειξη` button up and starts the month grid at a different vertical position than the tenant tab, so the two tabs do not line up row-for-row. | Same as OS4 (`accounting/[year].js:251-254`) + OS5 (`OwnerStatements.js:169-175`). | Fixing OS4 + OS5 restores the header to the tenant's height and re-aligns everything below. No separate change — verify alignment visually after OS4/OS5. |
| OS7 | **Receipt-button label mismatch** — the month-picker trigger says `Απόδειξη` (Receipt) but the action downloads an εκκαθαριστικό (statement). | `OwnerStatements.js:43` reuses `t('Receipt')` ("Απόδειξη"); submit button says `Download {{count}} statements` → "Λήψη {{count}} εκκαθαριστικών" (`:86`, el.json:260). | Use a statement label (e.g. `t('Statement')` → "Εκκαθαριστικό") on the owner trigger so button and action agree. (Tenant correctly uses `Απόδειξη` for receipts.) |

### Net
- **OS1+OS2+OS3** are one coupled fix (rebuild the owner grid from payments, owed out of the grid). OS3 is the server change → TIER-MONEY caution: reconcile totals + live readback.
- **OS4+OS5 → OS6**: add the CSV button and the header subtitle line; that alone restores header height and re-aligns the tab. OS4 needs an owner-CSV endpoint verified/built first.
- **OS7** is a one-key label fix.

## Settlements CSV export (`accountingmanager.ts` `settlementsAsCsv`) — findings from screenshot `2026-06-20` (tenant settlements opened in Excel)

> Tier: **MONEY** — the owed figures and the two summary sums are money. Even though these are "just"
> spreadsheet cells, the fix-discipline TIER-MONEY gate applies in full: Step-7 adversarial refutation +
> the exported numbers must reconcile against the in-app totals (user instruction, verbatim 2026-06-20:
> "YOU NEED TO CONFIRM THE MONEY… as it applies for all even for the cells of CSV").
> Confirmed against `accountingmanager.ts:512-582` (the CSV builder) + `:43-82` (`_fetchData` projection
> carries `total` per rent) (read 2026-06-20). User decisions locked 2026-06-20: **layout A** + "everything
> must fit nicely, don't care how it's done."

### Confirmed defects / requested changes

| # | What's wrong / requested | Root cause / fact (file:line) | Fix |
|---|--------------------------|-------------------------------|-----|
| CS1 | **Columns are too narrow / headers truncated in Excel** (`Ημερομηνία έ…`, clipped month headers). | NOT an app bug that can be fixed in CSV: a `.csv` is plain text (`Parser({delimiter:';', withBOM:true})`, `accountingmanager.ts:578`) and carries **no column-width or number-format metadata** — Excel auto-widths on open. Excel's own banner in the screenshot ("save it in an Excel file format") confirms this. | **User decision: "fit nicely, don't care how" → change the export from `.csv` to a real `.xlsx`** (a sheet writer that sets per-column widths + a currency number-format), so widths/formatting are controllable. This replaces the json2csv `Parser` path for this export. **VERIFY: pick an xlsx writer dependency already acceptable to the repo, or confirm adding one; the el-GR currency format (`1.234,56 €`) must be preserved.** |
| CS2 | **No "owed" anywhere + no summary totals.** Each month column shows ONLY the paid total; there is no owed figure and no per-tenant paid/owed sum. | `accountingmanager.ts:539-555` builds `monthTotals[m]` = Σ `payments[].amount` only. The `total` object (with `grandTotal`/`payment`) IS in the projection (`:73`) and is already read for owed elsewhere (`:277-284`), so per-month owed is computable WITHOUT a new query. | **Layout A:** for each month emit a PAIR of columns — `<Μήνας> (πληρωμή)` and `<Μήνας> (οφειλή)` — where owed = `max(0, total.grandTotal − total.payment)` for that month's rent. Then add **two summary columns per tenant row: `Σύνολο πληρωμών` (Σ paid across 12) and `Σύνολο οφειλών` (Σ owed across 12)**. **MONEY: the summary sums must equal the row's 12 paid / 12 owed cells, and the paid total must reconcile with the in-app `total.payment`; Step-7 + jest + live readback required.** |

### Coupling / sequencing
- CS1 (→ xlsx) and CS2 (paired columns + sums) are naturally done together — once the export is an xlsx writer, the 26 columns (Name/Ref/Properties/begin/end/deposit + 12×2 month pairs + 2 sums) get explicit widths so they "fit nicely" (CS1's goal).
- **Open verification before build:** does the repo already have (or accept) an xlsx writer? If not, that dependency choice is a prerequisite, not part of the fix. (Logged, not assumed.)
- This is the tenant settlements CSV. If the owner tab gets its own CSV (OS4), apply the same xlsx + paired-column + sums treatment there for consistency.

## Building Επισκόπηση (dashboard) — tooltip + chart findings from 5 user-reported issues (2026-06-20)

> Surfaces (all read 2026-06-20): the main-dashboard half-circle `MonthFigures.js`; the two stacked
> horizontal bar charts `YearFigures.js` (έσοδα) + `ExpensesYearFigures.js` (έξοδα); the owner-eksoda
> computation `computeOwnerEksodaByMonth` (`buildingmanager.ts:4498+`) → `_expensesRollup`
> (`dashboardmanager.ts:666-744`). "Progress bars" in the user's wording = the two BAR CHARTS, confirmed.
> Tier: mostly UI, EXCEPT D5 (owner-eksoda) which touches the eksoda computation → TIER-MONEY.

### D1 — Half-circle (`MonthFigures`) header copy

| What | Source | Fix |
|---|---|---|
| Title currently `t('Rents of {{monthYear}}')` → renders "Ενοίκια Ιούνιος 2026" | `MonthFigures.js:476`, month via `moment().format('MMMM YYYY')` | Change to **"Αναλυτική Κατάσταση μήνα Ιουνίου 2026"**. |
| Subheader currently `t('Pie chart subheader')` → "Εισπράξεις μηνός ανά κατηγορία" | `MonthFigures.js:479` | Change to **"(Δεν περιλαμβάνονται ΦΠΑ και προηγούμενα υπόλοιπα)"**. |
| **GENITIVE month required** | `moment().format('MMMM …')` yields NOMINATIVE "Ιούνιος"; the new copy needs GENITIVE "Ιουνίου" | Use moment's genitive form (e.g. `format('D MMMM')` extract, or a genitive month map) so it reads "μήνα Ιουνίου", never "μήνα Ιούνιος". Apply for every month, not just June. |

### D2 — Tooltip money amount: 3-state weight/color (USER-CLARIFIED — applies to ALL chart tooltips)

The collected/paid amount in a tooltip row must signal payment state by **weight + color**, three states:
- **nothing paid** → normal weight, plain/muted color
- **partially paid** (0 < paid < owed) → **BOLD**, same color (not the blue yet)
- **fully paid** (paid ≥ owed) → the **blue paid color** (`paidColor(...)`)

| Surface | Source (current behavior) | Fix |
|---|---|---|
| Half-circle tooltip "Receipts" amount | `MonthFigures.js:392-403` — colors the amount ONLY when `fullyPaid` (`:369-370`), else muted; NO partial-bold state | Apply the 3-state rule: add the partial→bold branch; keep full→`paidColor(entry.type)`; nothing-paid→plain. |
| Bar-chart tooltip Collected/Paid amount | `YearFigures.js:102` & `ExpensesYearFigures.js:102` — plain `text-ink`, no weight/color distinction from Owed | Apply the same 3-state rule to the per-month Paid value and the per-row paid side. |

> NOTE: the user did NOT report the bottom-total hardcoded-color thing I previously raised; that was my own
> over-reach and is OUT of scope. D2 is strictly about the amount shown INSIDE the tooltip.

### D3 — Bar-chart tooltips open only on CLICK, must be HOVER

| What | Source | Fix |
|---|---|---|
| Both bar charts force `trigger="click"` so the tooltip won't appear on hover | `YearFigures.js:217`, `ExpensesYearFigures.js:223` (each paired with `wrapperStyle={{pointerEvents:'auto'}}`) | Restore hover behavior (match the pie, which has no `trigger` and shows on hover). **Coupled with D4** — `trigger:click` + `pointerEvents:auto` was the previous failed attempt at making the tooltip scrollable; D4 must solve scroll WITHOUT forcing click. |

### D4 — Tooltip scrolling MUST work, NO MORE REGRESSIONS (recurring; multiple prior failed attempts)

**The requirement, stated exactly (user, 2026-06-20):** when the mouse is over the tooltip and a scrollbar is present, the wheel scrolls the TOOLTIP; when the mouse leaves the tooltip, normal page scroll resumes. Nothing more.

**Why prior attempts regressed:** a recharts `<Tooltip>` FOLLOWS THE CURSOR — you cannot move the mouse INTO it to scroll, so the wheel hits the page. The earlier fix added `pointerEvents:auto` + `trigger="click"` to make it enterable, which broke hover (D3) and STILL didn't give reliable wheel-scroll. The containers already have `max-h-[400px] overflow-y-auto scrollbar-branded` (`YearFigures.js:96`, `ExpensesYearFigures.js:96`, `MonthFigures.js:352`) — the overflow is set; the problem is the tooltip is unreachable/cursor-tracking.

**Fix direction (the ONLY shape that satisfies the requirement without the click regression):** the tooltip content must be a **pinned, non-cursor-following** panel (fixed placement, `pointer-events:auto`) so the mouse can rest on it; the scroll container then receives the wheel natively, and on `mouseleave` the page scrolls again. Keep `trigger` on HOVER (D3). Do NOT re-introduce `trigger="click"`. Verify on all three tooltips (pie + 2 bar charts).

**Regression gate (mandatory before declaring D4 done):** in a browser, on each of the 3 tooltips, with a tooltip taller than 400px — (1) hover opens it, (2) wheel over the tooltip scrolls the tooltip and NOT the page, (3) moving the mouse off the tooltip restores page scroll, (4) hover (not click) still opens it. All four must hold. This is the exact behavior that has regressed repeatedly; it is not "done" until all four are observed live.

### D5 — Owner-eksoda tooltip (`ExpensesYearFigures`): inconsistent owner grouping + paid not carried — TIER-MONEY — REPORT + PROPOSE (user-approved mockup)

**What's wrong (sourced):** the tooltip groups breakdown lines by `line.ownerName` and buckets null-owner lines under the literal `t('Building')` (`ExpensesYearFigures.js:116-127`). But `ownerName` is set by THREE different rules upstream: per-unit lines use the unit's owners (`buildingmanager.ts:4561-4569`), building-wide lines use ALL building owners joined (`:4580-4591`), live gap-fill lines emit `ownerName:null` AND `paid:0` (`:4507-4508`). Result: the SAME owner can appear as a named group AND inside the "Building" bucket in one tooltip, and a settled live line renders `0,00 / X`.

**Approved presentation (user confirmed the mockup; label is ΚΕΝΟ, not ΚΕΝΗ):**

```
PROPOSED owner-eksoda tooltip — one named group per owner, no "Κτίριο" bucket,
paid carried for live lines, D2 3-state weight/color on the amount.
(amounts below are [example] from the owner-detail screenshot, NOT live-queried)
┌─────────────────────────────────────────────┐
│ Ιούνιος 2026                                  │
│ Πληρωμένα                          [exΧ] €    │
│ Οφειλές                            [exΥ] €    │
│ ───────────────────────────────────────────  │
│ ΔΟΚΙΜΗ ΛΑΜΔΑ, ΔΟΚΙΜΗ ΚΑΠΠΑ            │
│   Επισκευή (ασανσερτ)            [50,00] €    │  fully paid → blue
│   Επισκευή (ασανσερτ) — ΚΕΝΟ     [10,00] €    │  partial → bold (NOT "κενή" — ΚΕΝΟ)
│   Κοιν. Νερό (‹name›)            ‹x› €        │  unpaid → plain
└─────────────────────────────────────────────┘
```

**Fix (3 parts):**
1. Resolve every breakdown line's owner through the SINGLE owner-identity rule the owner ledger already uses (`sameOwner`/owner-key in `ownermanager`), so building-wide + per-unit lines for the same person collapse into ONE named group; nothing falls into a generic "Κτίριο" bucket unless there is genuinely no owner.
2. Carry `paid` for live gap-fill lines too (so a settled line stops reading `0,00`), OR hide the `/X` paid side when paid is unknown.
3. Vacant-unit lines use the label **ΚΕΝΟ** (neuter — "κενό διαμέρισμα/ακίνητο"), NOT "κενή". Audit any "κενή"/"(κενή μονάδα)" string on this surface and the related owner/building panels and switch to ΚΕΝΟ.

**TIER-MONEY:** touches `computeOwnerEksodaByMonth` attribution + the totals must still reconcile → Step-7 adversarial refutation + jest + live readback before it ships.

### Net (Επισκόπηση batch)
- D1 (copy + genitive month) and D2 (3-state amount) and D3 (hover) are UI; D2/D3 span all 3 tooltips.
- **D3+D4 are coupled** — fix scroll via a pinned non-cursor-following tooltip, keep hover; the 4-point regression gate is mandatory.
- D5 is TIER-MONEY (owner attribution + reconcile). Also fixes the ΚΕΝΟ wording.

## Building Επισκόπηση screen (`BuildingDashboard.js`) — full redesign (USER-APPROVED 2026-06-20)

> Method: 5 region reviewers found 21 candidate inconsistencies (workflow wf_da3fcbe4); refute-by-default
> verification killed 16 (intentional/not-a-bug — listed at the bottom so they are NOT re-investigated), 5 survived.
> Beyond those micro-defects, the screen's INFORMATION ARCHITECTURE is the real problem (mixed time-bases,
> 4× duplication, asymmetry, missing info). User reviewed two HTML mockup iterations and approved v2.
> **Reference mockup (the agreed target): `documentation/mockups/building-overview-redesign.html`** — open it; it
> renders the redesign with the REAL values from the screenshot (the one figure not on the screenshot — rent
> collected YTD — is a marked placeholder, never invented).
> Tier: UI for B-series; E1 + A2 touch money the card already computes (no recompute change) → verify the
> surfaced euros reconcile. All anchors read 2026-06-20.

### Model facts confirmed (answers to the user's occupancy questions — NOT bugs, recorded so the design rests on truth)

- **occupancyType** is an explicit enum `['rented','owner_occupied','vacant','parking']` (`building.ts:71-75`), set TWO ways: manually via the unit-form Select (`UnitList.js:60-62`), AND auto-set to `rented` when a tenant is linked to the unit's property (`occupantmanager._syncOccupancyForProperties` `:435-455`, called on link/unlink). The auto-sync **skips units already `owner_occupied`/`parking`** (`:451`) so it never clobbers them. It is **NOT** derived from ΑΦΜ — there is zero taxId-based occupancy logic anywhere. (Possible future enhancement: suggest `owner_occupied` when a unit owner's ΑΦΜ matches a resident — does not exist today.)
- **Ιδιοκατοίκηση (owner_occupied) is handled correctly**: NO rent charged (rent only from a linked tenant's `properties[].rent`; owner-occupied units have no tenant → skipped in `monthlyEsoda`, `BuildingDashboard.js:216-218`), and the unit's building-expense share IS routed to the owner as `source:'owner-resident'` (`buildingmanager.ts:2919-2922`). owner-occupied = no ενοίκιο, only έξοδα ιδιοκτήτη. ✓ — NO change needed; only the Κενά/Στάθμευση display (B3) does.

### Micro-defects (verified by adversarial audit)

| # | What's inconsistent (verified) | Anchor | Fix (approved) |
|---|--------------------------------|--------|----------------|
| B1 | τ.μ. surfaces render dot-decimal (`70.05`,`66.75`,`104.05`,`148.35`) while all money uses el-GR comma — `unit.surface` printed raw, no formatter | `BuildingDashboard.js:856` | Format surface via locale → `70,05 τ.μ.`. |
| B2 | Owner % rendered raw `${o.percentage}%` — integer 50 fine, but fractional (33.33) would print dot-decimal. Sibling idiom also `BuildingExpensePanel.js:736` | `BuildingDashboard.js:816` | Locale-format the % so fractional reads `33,33%`. NOTE: `useFormatNumber` percent path ×100-scales (stored 50 = 50%) → NOT a drop-in; format number with locale decimal + literal `%`. Apply to sibling panel too. |
| B3 | "Κενά / Στάθμευση" summary card MERGES vacant apartments + parking (`stats.vacant + stats.parking`) — two distinct enum categories as one | `BuildingDashboard.js:733` (+ grid `:712-739`) | Split into separate cards: `Κενά` + `Στάθμευση`. Grid 4 → 5 cards. |
| B4 | Repair line label "Ενοικιαστές 50% · Ιδιοκτήτες 50%" contradicts the real 30/70 euro split in the same card (vacant units' tenant-share routes to owner) — label shows CONFIGURED %, not what's paid | `:626-633` (label) vs `:572-598` (euros) | Show BOTH: `Ενοικιαστές 50% (30,00 €) · Ιδιοκτήτες 50% (70,00 €)`. Verify printed euros reconcile with the breakdown totals (no recompute change). |

### Information-architecture changes (the substance — approved from the v2 mockup)

| # | Problem | Approved change |
|---|---------|-----------------|
| E1 | **Έσοδα omits δαπάνες επί ενοικίου** — the projection counts only base rent (`monthlyEsoda` sums `tenantInfo.rent` only, `:216-219`), not the rent-surcharge charges the tenant also pays. | Έσοδα label → `Έσοδα (ενοίκια + δαπάνες επί ενοικίου) ×12`, and `monthlyEsoda` MUST add each rented unit's δαπάνες-επί-ενοικίου to the base rent. **MONEY: the new Έσοδα total changes — verify it reconciles with the rent pipeline's per-unit charge.** (Mockup keeps the screenshot's rent-only 7.800 as a placeholder; real value will be higher.) |
| A1 | **Mixed time-bases with no labels + self-contradicting header.** ΕΣΟΔΑ=×12 projection, but ΕΞΟΔΑ mixed ×12 projection with YTD actuals; a "Ιούνιος 2026" month chip sat on an "Ετήσια προβολή" card. | PURE annual projection titled **"Ετήσια προβολή 2026"** — **remove the month chip**. Expense breakdown is now a **4-cell grid of the THREE real recurrence types + tenant repairs** (see A6). Note: **"Ετήσια προβολή με βάση τη σημερινή κατάσταση: νέα ή τροποποιημένα έξοδα, επισκευές ή ενοίκια σε επιμέρους μήνες μεταβάλλουν την προβολή."** |
| A2 | **Asymmetry** — owner paid/unpaid bar exists, no tenant rent collected/owed bar. | Add **"Φέτος μέχρι σήμερα — 2026"** with TWO bars: tenant rent εισπράχθηκαν/προβλ. (NEW) above the existing owner-expenses bar. **Tenant-collected figure NOT on screenshot → needs a server YTD-collected value; marked placeholder in mockup, must be wired, never faked.** |
| A3 | **Repair "ασανσερτ" appears 4× with no cross-link; 3 lines; status "Ανοιχτή" meaningless Greek; sat after unit cards.** | Repair shown ONCE, **2 lines**, with **DUAL status** (A7); line 1 = name · recurrence/term · 2 badges · amount; line 2 = the split (B4). Folds the op-status in (kills the separate Άνοιγμα card + the 4× dup). **Move Repairs ABOVE Μονάδες/floor.** |
| A4 | **Missing info**: no occupancy %, no floor totals. | Floor table **totals row** (Σ `493,25 τ.μ.` / Σ `650,00 €`); Μονάδες card **"Πληρότητα 60% (3 από 5)"**. Repeated floor labels stay (blank-floor dedup intentional). |
| **A5** | **`Καθαρό` subtracted ALL expenses (104,32), but κοινόχρηστα + tenant-repairs are PASS-THROUGH** — paid by tenants, remitted to providers, never the owner's money. Subtracting them understated net (7.695,68). **USER DECISION: net subtracts ONLY owner-borne expenses.** | `Καθαρό = Σύνολο εσόδων − έξοδα ιδιοκτήτη` (here `… − 70,00`, NOT − 104,32). Expense breakdown is grouped under TWO plural-noun headers: **ΕΝΟΙΚΙΑΣΤΕΣ** (κοινόχρηστα + εφάπαξ + κυμαινόμενα + επισκευές ενοικιαστών — *"δεν αφαιρούνται από το Καθαρό"*) and **ΙΔΙΟΚΤΗΤΕΣ** (έξοδα ιδιοκτήτη — *"αφαιρούνται από το Καθαρό"*). Future: a φόρος line subtracted too (placeholder note only). **MONEY: net formula change → reconcile.** |
| **A6** | **Recurrence types conflated** — the breakdown lumped fixed-recurring + variable(κυμαινόμενο) into one "Επαναλαμβανόμενα ×12" cell, but κυμαινόμενα have `amount=0` and the landlord types a different figure each month, so ×12 is wrong for them. | Show the THREE real types as separate cells: **Σταθερά επαναλαμβανόμενα ×12** (`isRecurring && amount>0`, `ExpenseList.js:1044`), **Κυμαινόμενα** (`isRecurring && amount===0` → variable, `:419`; label "φέτος μέχρι σήμερα", NOT ×12 — sum the actual monthly `inputAmount`s YTD, `building.ts:30-37`), **Εφάπαξ** (`!isRecurring`, one-time, `:88`). Plus **Επισκευές ενοικιαστών**. (Confirmed: εφάπαξ ≠ κυμαινόμενα — they are distinct; κυμαινόμενα ARE recurring.) |
| **A7** | **Repair needs status that reflects work AND money over time.** The `status` enum (`building.ts:201` `planned/in_progress/completed/cancelled`) is a MANUAL work-state with NO payment link. | **USER DECISION (option b): TWO independent badges.** (1) **Work badge** = the manual enum (Προγραμματισμένη / Σε εξέλιξη / Ολοκληρωμένη / Ακυρωμένη). (2) **Money badge** = DERIVED: **Πληρωμένη** (all collected) / **Εκκρεμεί** (uncollected, term/completionDate not passed) / **Εκπρόθεσμη** (uncollected AND time passed). Also show recurrence: **Εφάπαξ** or **MM/YYYY – MM/YYYY** span (`chargeTerm`..`completionDate`). |

### Rejected by adversarial verification (do NOT re-investigate)

- Blank floor label on the 66.75 row — intentional floor-grouping dedup (`:854`).
- "Κενό" (singular badge) vs "Κενά" (plural count) — grammatically correct Greek, intentional.
- Same repair billed AND counted "open" — NOT a contradiction (financial line vs op-status independent); A3 co-locates them.
- Repair full 100€ with 50/50 / "double-count" — verified NOT double-counted; headline math reconciles.
- Card 1 "Έξοδα ιδιοκτήτη 70" vs Card 2 ledger 70 from different row sets — legitimately equal via correct paths.
- Repair name "ασανσερτ" — landlord typo of "ασανσέρ", USER DATA, do NOT auto-correct.

### Decisions RESOLVED (2026-06-20)
1. **Net** → A5: subtract only owner-borne (έξοδα ιδιοκτήτη), pass-through grouped under ΕΝΟΙΚΙΑΣΤΕΣ; future φόρος line. ✓
2. **Repair status** → A7: dual badges (work enum + derived money Πληρωμένη/Εκκρεμεί/Εκπρόθεσμη). ✓

### BUILD SPEC — when implementation starts, the new Επισκόπηση form MUST match the reference mockup

**The reference mockup `documentation/mockups/building-overview-redesign.html` is the authoritative target render.** Build the form to match it, in this order top-to-bottom:
1. **Ετήσια προβολή 2026 card** — Έσοδα shown as TWO component lines (Ενοίκια ×12 + Δαπάνες επί ενοικίου ×12) and their **Σύνολο εσόδων** (E1: `monthlyEsoda` must add each rented unit's δαπάνες-επί-ενοικίου, not rent alone); then `− Έξοδα ιδιοκτήτη`; then **Καθαρό = Σύνολο εσόδων − έξοδα ιδιοκτήτη** (A5). Below it, **Ανάλυση εξόδων κτιρίου** with the two plural-noun groups (ΕΝΟΙΚΙΑΣΤΕΣ 4-cell A6 / ΙΔΙΟΚΤΗΤΕΣ 1-cell) + the note (no "Μόνο τα έξοδα…" sentence — removed per user).
2. **Φέτος μέχρι σήμερα — 2026** — tenant rent bar (A2, needs server YTD-collected) + owner-expenses bar.
3. **Επισκευές** (A3, moved up) — one repair, 2 lines, dual badges (A7), split label (B4).
4. **Μονάδες** — 5 cards (B3: Κενά + Στάθμευση split) + Πληρότητα % (A4).
5. **Μονάδες ανά όροφο** table — comma surfaces (B1), localized owner % (B2), totals row (A4).

**Money touch-points (reconcile + Step-7 before ship):** E1 (new Έσοδα total), A5 (net formula), A6 (κυμαινόμενα YTD sum), A7-money-badge (derived from payments), A2 (tenant collected), B4 (surfaced euros).

**Known build constraint (do NOT paper over):** the repair money badge needs BOTH sides collected to read "Πληρωμένη". Owner-side paid lives in `ownerMonthlyExpenses[].payments`, but the **tenant repair-share has NO per-charge paid field** (`monthlyCharges`, deferred-decisions D-9). So "Πληρωμένη=both sides" is only fully computable once D-9's renter-side paid field exists; until then the money badge can reflect the OWNER side only — state this in the implementation, don't fake tenant-side collection.
