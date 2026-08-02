# PUNCH-LIST — MicroRealEstate Round-2 Audit (HEAD 2a48a511, branch nas)

Deduped to **24 distinct root causes**. The PDF-VAT, multi-property-address, accounting-Owners-tab, incoming-tenants-date, settlements-CSV-date, typeless-payment-crash, month-locale, CSV-injection, surplus-badge, payment-toast, owner-toast, and emailer-Total findings each appeared 2-4x in the source set — collapsed to one entry apiece.

---

## CRITICAL — wrong/dropped/double-counted money on a write path

### C1. Express settle records GROSS bill on a partially-paid term AND destroys the prior payment
- **Root cause:** `services/api/src/managers/rentmanager.ts:103-189` (`_computeOwedLines` never subtracts `targetRent.payments`/`total.payment`) + `:548-611` (records gross) + `:1052` (`settlements.payments = paymentData.payments` — no merge of existing payments); client shows NET at `webapps/landlord/src/components/rents/ExpressPaymentDialog.js:55-71`.
- **Trigger:** Term with €500 bill + €200 recorded payment → drawer shows "Monthly €300" → Record → server writes one €500 transfer dated today; the €200 payment (date/type/reference) is permanently overwritten.
- **Impact:** Over-records by the already-paid amount AND deletes a real payment record; toast reports only a count, so it's silent. Double-hit to ledger + audit trail.
- **Fix direction:** In `bulkExpressPayment`, net `targetRent.total.payment` out of `monthlyOwed` AND include existing `targetRent.payments` in `paymentData.payments` — mirror `PaymentTabs.js:596` (`[...savedPayments, ...drafts]`).

### C2. Express settle ignores the standing lease discount — over-charges every discounted tenant
- **Root cause:** `services/api/src/managers/rentmanager.ts:103-189` (`_computeOwedLines` sums preTax+charges+buildingCharges+vat+debts, never subtracts `rent.discounts`) vs `7_total.ts:64-67` (`grandTotal` does subtract discount).
- **Trigger:** Tenant with `occupant.discount=50` on €500 rent, fully unpaid → drawer shows "Monthly €450" → Record → server records €500 transfer → +€50 phantom credit cascades to next term.
- **Impact:** Over-records by the full standing discount on every Express settle of a discounted tenant (independent of payments — fires on a clean term).
- **Fix direction:** Make `_computeOwedLines` net `rent.discounts` into the rent/preTax owed lines, matching `7_total.ts`'s `- discount`.

---

## HIGH — wrong money / reject-valid-data / lockout / surface-down

### H1. Property expense-sum collapses an entire property's Additional charges to €0 when any one expense lacks a numeric amount
- **Root cause:** `services/api/src/managers/frontdata.ts:495-501` — `item.expenses.reduce((acc,{amount})=>acc+amount,0)` has no `Number()||0`; an `undefined` amount → NaN → `(length && NaN)||0` → **0**. Engine (`1_base.ts:906-908`) correctly coerces.
- **Trigger:** PATCH a tenant with a property holding `[{amount:100},{title:'Legacy'/*no amount*/},{amount:30}]` (validator accepts it; `occupantmanager.ts:670` only checks amount when present), or any legacy row. Overview shows Additional charges €0 / Total = rent-only; ledger bills €130.
- **Impact:** Tenant Rental overview silently under-states the whole property's expense sum (and Pre-tax/VAT/Total); diverges from the ledger in the same payload.
- **Fix direction:** Coerce in the reduce: `(acc,{amount})=>acc+(Number(amount)||0)` — match the engine at `1_base.ts:906`. (Fires only on `undefined`/missing, not literal `null`.)

### H2. Receipt PDF "Σύνολο πληρωμής" (Total with VAT) understated by full VAT for any VAT-liable tenant
- **Root cause:** `services/pdfgenerator/data/index.js:122-133` — receipt (`omitCharges`) branch `invoiceGrandTotal = round(subTotal + balance)` with **no VAT addend**, while the rent-call branch (`:134`) uses canonical `grandTotal` (which includes VAT). `...rent.total` spread still prints the VAT line at `invoicetotal.ejs:6-11`.
- **Trigger:** Any tenant with `vatRatio>0`; rent 1000 / 24% → receipt prints Σύνολο πριν ΦΠΑ 1000, ΦΠΑ 240, **Σύνολο πληρωμής 1000** (should be 1240). `newBalance=1000−payment` → a full-1240 payer shows €240 phantom credit; a 1000 payer shows €0 due while owing VAT.
- **Impact:** Greek tax receipt does not foot; understates collected gross/VAT; phantom credit/debt on the balance line.
- **Fix direction:** `data/index.js:133` — add `(rent.total.vat||0)` to the receipt branch (or reuse canonical `grandTotal`), so the headline matches the printed VAT line and `newBalance` follows.

### H3. Reminder/last-reminder dunning emails bill GROSS `grandTotal`, not remaining-after-partial-payment
- **Root cause:** `rentcall_reminder/body_html.ejs:22` + `body_text.ejs:9`; `rentcall_last_reminder/body_html.ejs:30` + `body_text.ejs:15` — all quote `tenant.rents[0].total.grandTotal`, which never subtracts `rent.total.payment` (`7_total.ts:69`). **All four** template files affected.
- **Trigger:** Tenant pays €600 of a €1000 term → landlord sends reminder/last-reminder → email demands the full €1000 ("current amount of unpaid rents is 1.000,00 €") instead of €400.
- **Impact:** Over-dunns every partially-paid tenant by the amount already paid, on a legally-sensitive pre-eviction notice; contradicts the landlord's own "Owed remaining" UI.
- **Fix direction:** Quote `Math.max(0, grandTotal − total.payment)` in all four reminder templates. Leave the initial `rentcall` body (gross) alone.

### H4. Empty post-filter `rents[]` 422s every rentcall/reminder email for an out-of-window term
- **Root cause:** `services/emailer/src/emailparts/data/invoice/index.ts:22` guards `!dbTenant.rents.length` (FULL ledger, pre-filter), then `:52-54` filters to `params.term`; templates deref `rents[0].total.grandTotal`. Reminder builders reuse `Invoice.get`.
- **Trigger:** `POST /emailer` rentcall/reminder for a term outside the materialized rent window (terminated tenant later month, future-month before lease begins, automated caller). → TypeError → caught → `ServiceError('missing content', 422)`; no email sent.
- **Impact:** Landlord believes a notice/dunning was sent; it silently 422s. For last-reminder, can break the eviction timeline. (`lease_expiry_notice` already wraps `Invoice.get` in try/catch — proof the failure mode is known.)
- **Fix direction:** Move the empty-check to AFTER the term filter (re-check `tenant.rents.length` post-filter and throw a clear handled error / skip gracefully).

### H5. Empty/invalid `realm.currency` → 500 RangeError on the entire Accounting page + all CSV exports
- **Root cause:** `services/api/src/managers/accountingmanager.ts:282` — `_settlements` builds `Intl.NumberFormat(locale,{style:'currency',currency,...})` **unconditionally**, unlike `_incomingTenants:169-175` / `_outgoingTenants:217-223` which gate construction on `!rawData`. Reached by JSON `all()` at `:410` (rawData=true) and by `settlementsAsCsv:479`. Emitter side: emailer `templatefunctions.ts` / `routes.ts:41` (`currency || ''`) throws the same way for emails.
- **Trigger:** Realm with `currency:''`/`undefined` (direct-mongo/legacy seed; schema `realm.ts:114` has no default/required) or a malformed non-empty code slipping through `add()` (which doesn't validate currency). GET `/accounting/:year` → RangeError → 500. Money-bearing emails 422 likewise.
- **Impact:** Year-end reconciliation surface (settlements grid + all 3 CSVs) entirely unavailable; rentcall/reminder emails 422 for the realm (receipt still sends, masking it).
- **Fix direction:** Gate `accountingmanager.ts:282` like its siblings (`!rawData ? Intl.NumberFormat(...) : {format:v=>v}`); add `validateEnum(req.body.currency, CURRENCIES)` to `realmmanager.add()`; default/normalize `realm.currency` (e.g. `realm.ts:114` default 'EUR' or guard at `routes.ts:41`).

### H6. Org-settings PATCH permanently 422-locks any realm using one of ~150 valid ISO currencies the dropdown offers but the server whitelists out
- **Root cause:** Dropdown offers 167 ISO codes (`LandlordForm.js:63-79`), server whitelist `CURRENCIES` is 14 (`validators.ts:51-66`); `update()` runs `validateEnum(currency,CURRENCIES)` (`realmmanager.ts:227-229`) but `add()` does **not** (`:160-172`); `onSubmit` re-sends the stored currency on every PATCH (`LandlordForm.js:189`).
- **Trigger:** Create org with MXN/PLN/ZAR/TRY/AED (offered, valid ISO, renders fine). Then edit any setting (name/locale/company info) → Save → PATCH re-sends `currency:'MXN'` → 422 "Invalid currency". Org settings uneditable forever.
- **Impact:** Hard operational lockout for any of ~150 legitimate currencies; can never save name/locale/company/bank info again.
- **Fix direction:** Make the outlier match: align the dropdown to `CURRENCIES` (or widen `CURRENCIES` to the symbol-backed ISO set Intl accepts), and add the missing `validateEnum(currency,…)` to `add()`.

### H7. Legacy/typeless payment (`type:''` or omitted, `amount>0`) crashes the entire Accounting/Payments page on render
- **Root cause:** Render: `webapps/landlord/src/components/accounting/TenantSettlements.js:167` — `t(type[0].toUpperCase()+type.slice(1))` throws when `type===''`/undefined. Persist: `rentmanager.ts:820` guard nested inside `if (p?.type !== undefined && p.type !== null)` (omitted/null type skips the required check) → `:1108` stores `type: payment.type||''`. Read passes type through raw (`accountingmanager.ts:317-323`).
- **Trigger:** Any legacy/pre-Wave-26 payment with `amount>0` and `type===''`, or a crafted PATCH omitting `type`. Open Accounting → Payments for that year → ErrorBoundary blanks the whole page (not just one row).
- **Impact:** Entire year's Payments accounting view unusable for ALL tenants when one has a typeless positive payment; validation gap also lets such a payment persist.
- **Fix direction:** Guard the render: `type ? t(type[0].toUpperCase()+type.slice(1)) : ''` at `TenantSettlements.js:167`; also fire the required-type throw at `rentmanager.ts:820` when type is undefined/null with `amount>0`.

### H8. Accounting CSV exports ship formula-injection unsanitized — `_sanitizeCsvText` is wired only to the React-JSON path
- **Root cause:** `services/api/src/managers/accountingmanager.ts:31` guard; **only** call sites `:352-354` are inside the `if (rawData)` JSON branch (consumed by React, harmless). CSV handlers call builders with `rawData=false` and emit `tenant.name` (`:201/262`), `reference` (`:202/263`), property names (`_properties` `:160`), settlement cell (`:388-392`), payment reference (`:367-369`) raw into `json2csv`. Names/refs only length-validated (`validators.ts:226`), no formula-prefix strip.
- **Trigger:** Tenant named `=cmd|'/C calc'!A1` / `=HYPERLINK("http://evil","x")` (accepted by validators) → landlord exports incoming/outgoing/settlements CSV → opens in Excel/LibreOffice/Sheets → cell evaluates as formula/DDE.
- **Impact:** Arbitrary-formula execution / data exfiltration on the accountant's machine — the exact vector the guard was written to close, left open on the only path that reaches a spreadsheet.
- **Fix direction:** Run `_sanitizeCsvText` over name/reference/property-name/payment-reference whenever `rawData===false` (the three builders' false branches at `:160`, `:201-203`, `:262-264`, `:367-369`, `:388-392`), or move the call out of the `if(rawData)` block.

### H9. Owners sub-tab on the year-scoped Accounting page shows ALL-TIME owner totals
- **Root cause:** `webapps/landlord/src/pages/[organization]/accounting/[year].js:71-74` — `fetchOwners()` called with no year, queryKey `[QueryKeys.OWNERS]` has no year; `ownermanager.all` (`:512`) + `_aggregateOwners` (`:323`) iterate `ownerMonthlyExpenses` across ALL terms with no year filter. The per-owner statement PDF (`:174-189`) IS year-scoped.
- **Trigger:** Open Accounting 2024 → Incoming/Outgoing/Payments show 2024; Owners tab shows Paid/Outstanding summed over 2024+2025+2026; figures contradict the year-scoped statement PDF beside them.
- **Impact:** Owner Paid/Outstanding under a year heading include other years' charges; can't reconcile with the year's tabs or the downloadable statement.
- **Fix direction:** Pass the page `year`: `fetchOwners(year)` → `GET /owners?year=`, queryKey `[OWNERS, year]`, and filter `Number(row.term)` to that year's term window in `_aggregateOwners`.

### H10. Bill confirm-payment marks bills fully paid with ZERO amount reconciliation; shared-RF match is non-deterministic
- **Root cause:** `services/api/src/managers/billmanager.ts:397` (parses only RF, no receipt amount), `:409-413` (`findOne({rfCode,status:'pending'})` no `.sort()`; rfCode non-unique per `bill.ts:37`), `:467-477` (`confirmPayment` `$set status:'paid'`, no `totalAmount` comparison).
- **Trigger:** Upload a €40 partial-payment receipt whose RF matches a €400 pending bill (or, with two months sharing an RF, an arbitrary month) → Confirm → bill flips to fully paid.
- **Impact:** A partially-paid (or wrong-month) bill silently drops from the pending-bills dashboard tile; landlord stops chasing real debt. (Bill collection is decoupled from the rent ledger — severity is medium in practice, not high, but it's a real money-tracking defect.)
- **Fix direction:** Parse and return the receipt's paid amount; reject/flag confirm when it doesn't reconcile against `bill.totalAmount`; add a deterministic `.sort()` + disambiguation when an rfCode matches multiple pending bills.

---

## MEDIUM — wrong-render / silent under-coverage / locale on money surfaces

### M1. Property expense-sum ignores each expense's begin/end window — one-time/sub-period charges inflate the "recurring" monthly Total
- **Root cause:** `frontdata.ts:495-505` sums ALL `properties[].expenses[].amount` unconditionally (begin/end only string-formatted at `:479-486`); engine windows them (`businesslogic/tasks/1_base.ts:890-911`). `RentOverviewCard.js:22-29` labels it RECURRING monthly.
- **Trigger:** Tenant with a One-time expense (`begin===end`, `LeaseContractForm.js:211-220`) or custom sub-period → overview Additional charges/Total inflated by the full one-time amount every month, plus re-taxed via `vat=preTaxTotal*vatRatio` (`:507`).
- **Impact:** Overview overstates monthly liability vs the ledger; VAT compounds the error.
- **Fix direction:** Skip expenses whose `[beginDate,endDate]` window excludes the summarized period in the `:495` reduce (or relabel the figure as a lifetime total). Engine side is already correct.

### M2. Express drawer only settles the current 21-row pagination page; arrears on pages 2+ silently skipped
- **Root cause:** `ResourceList/List.js:36` (`pageSize=21`), `:112` (`renderList({data: chunks[safePageIndex-1]})`); `RentTable.js:645` passes that slice to `ExpressPaymentDialog rents={rents}`; dialog derives `eligible` solely from the prop (`ExpressPaymentDialog.js:39-76`), no independent fetch.
- **Trigger:** Month with >21 rent rows (or active filter). Landlord on page 1 opens Express settlement, Records → only the ≤21 visible tenants settled; "All tenants are up to date" / "Express settlement" imply month-wide.
- **Impact:** Silent under-collection masquerading as full collection.
- **Fix direction:** Feed the dialog the full `filteredData` (or unfiltered month) instead of the single page chunk at `List.js:112`.

### M3. Rent-call email itemized table never reconciles to its printed Total (VAT/discount/debts/balance rows omitted)
- **Root cause:** `services/emailer/src/emailparts/contents/rentcall/body_html.ejs:23-32` lists only preTaxAmounts+charges+buildingCharges then prints Total=`grandTotal`; `grandTotal` (`7_total.ts:64-67`) also includes vat − discount + debts + balance, none rendered. `body_text.ejs:7-15` same. Sibling PDF (`rentcalltotal.ejs:13-21`, `invoicebody.ejs:75-91`) DOES render them.
- **Trigger:** Tenant with the table-gate met (`:21`: ≥1 buildingCharge / >1 preTaxAmount / ≥1 charge) AND nonzero VAT/discount/debt/carried balance → visible rows don't sum to the bold Total.
- **Impact:** Tenant-facing payment demand looks like it mis-adds; disputes; disagrees with the attached PDF.
- **Fix direction:** Add VAT/discount(negative)/debts/Previous-balance rows before the Total (mirror `rentcalltotal.ejs`), or print a subtotal-of-listed-lines label.

### M4. Incoming-tenants tab renders TODAY's date as every tenant's contract end
- **Root cause:** `accountingmanager.ts:199-208` (`_incomingTenants` deliberately dropped `endDate` per Wave-24 B15) vs `webapps/landlord/src/components/accounting/IncomingTenants.js:37-38` which still renders `moment(tenant.endDate).format('L')`; `moment(undefined)` → now (valid).
- **Trigger:** Open Accounting → Incoming tenants → every row reads `<beginDate> - <today>`; the end date advances daily.
- **Impact:** Fabricated, non-deterministic contract-end on every incoming tenant; disagrees with the (correct) CSV which omits the column.
- **Fix direction:** Stop rendering the end-date side at `IncomingTenants.js:38` (match the CSV), or guard on `tenant.endDate` presence.

### M5. Settlements CSV fabricates TODAY's date as begin/end for a tenant missing beginDate/endDate/terminationDate
- **Root cause:** `accountingmanager.ts:294` (begin) and `:297-299` (end) — `moment.utc(undefined)` → today (valid), no falsy guard; embedded in the multiline "tenant" cell at `:388-392`. Siblings `_incomingTenants:193-197` / `_outgoingTenants:236-240` DO guard with `? … : ''`.
- **Trigger:** Tenant with a year-matching rent but no begin/termination/end (legacy/mongo-seed) → download Payments CSV → "tenant" cell shows `<today> - <today>`; drifts daily.
- **Impact:** Fabricated, drifting lease period in an accounting export; corrupts period-keyed reconciliation. (On-screen view fabricates the same value — CSV and UI actually agree on the wrong date.)
- **Fix direction:** Add the sibling guard `value ? moment.utc(value).format('YYYY-MM-DD') : ''` at `:294` and `:297-299`.

### M6. Tenant payment / owner payment success toasts + allocation warnings render dot-decimal + glued/hardcoded € ignoring org locale/currency
- **Root cause (same pattern, 3 surfaces):** `PaymentTabs.js:649-653` (`_sum.toFixed(2)` into key `'Payment of {{amount}}€ recorded'`); `OwnerPaymentDialog.js:138-140/214-217/474-480` (over-allocated / unallocated / success, `.toFixed(2)` into €-baked keys); locale values bake € (`el/common.json:566/618/1122`). These bypass `useFormatNumber`/`NumberFormat` used for every other amount in the same dialogs.
- **Trigger:** el (or non-EUR) org records a payment / over-allocates → toast shows `1234.45€` (dot decimal, glued €, wrong symbol on non-EUR) next to `1.234,45 €` siblings.
- **Impact:** Wrong-locale/wrong-currency money on money-write confirmations (value correct; presentation wrong & self-contradictory).
- **Fix direction:** Format via `useFormatNumber()` and drop the literal € from the keys, mirroring the `NumberFormat` path the same files already use.

### M7. Surplus-credit badge + RentSelector "Remaining" render dot-decimal/hardcoded € (or no symbol) ignoring locale
- **Root cause:** `RentTable.js:523` and `RentSelector.js:53` — `t('+{{surplus}}€ credit', {surplus: _surplus.toFixed(2)})` with €-baked key (`el/common.json:3`); `RentSelector.js:48` renders `{_remaining.toFixed(2)}` bare (no formatter imported at all). Sibling `RentTable.js:511` uses locale-aware `NumberFormat`.
- **Trigger:** el/non-EUR org, overpaid term → badge shows `+12.50€` beside `1.234,56 €`; RentSelector Remaining shows `1234.50` with no currency.
- **Impact:** Wrong-locale money on the rents grid and payment picker; visually inconsistent with same-row formatted amounts.
- **Fix direction:** Route both through `NumberFormat`/`useFormatNumber` and strip the literal € from the surplus key.

---

## LOW — config-integrity / rendering / rejected-valid-data / latent crash

### L1. `POST /realms` (`add`) never validates currency against the ISO whitelist that `update()` enforces
- **Root cause:** `realmmanager.ts:160-176` validates name+locale but no `validateEnum(currency,CURRENCIES)`; `_hasRequiredFields:51` checks truthiness only; schema `realm.ts:114` has no enum.
- **Trigger:** `POST /realms {currency:'NOTACURRENCY'}` → 200, persisted. Feeds H5 (accounting 500) and H6 (PATCH lockout).
- **Fix direction:** Mirror `update()`'s `validateEnum(req.body.currency, CURRENCIES, 'currency')` into `add()`.

### L2. Zero-decimal currencies (JPY) render with two forced decimals everywhere
- **Root cause:** `minimumFractionDigits:2` hardcoded in `accountingmanager.ts:172/220/284`, `pdfgenerator templatefunctions.ts:24`, `numberformat.js:5`; JPY whitelisted (`validators.ts:60`).
- **Trigger:** Realm with currency JPY → `¥1,234.50` instead of `¥1,235` on every receipt/CSV/screen.
- **Fix direction:** Don't force `minimumFractionDigits` for zero-fraction currencies (let Intl use the ISO-4217 default, or special-case KRW/JPY/etc).

### L3. Multi-property tenant PDF (receipt + rent-call) names only the first property's address while billing all
- **Root cause:** `services/pdfgenerator/data/index.js:146-152` (`propertyAddress` = `dbTenant.properties[0]` only, "First property only" comment); body loops all `preTaxAmounts` (`invoicebody.ejs:47-54`); single-row `customerreference.ejs:11-15`.
- **Trigger:** Tenant with ≥2 active properties (apartment+storage) → body lists both rents, address block names one.
- **Fix direction:** Join the addresses of all term-active properties in the `propertyAddress` builder (or iterate the row), matching the body's active set.

### L4. One-time/custom expense date inputs bound to LEASE range, not property entry/exit → server 422s valid mid-handover entries
- **Root cause:** `LeaseContractForm.js:215-216/281/285/512` bind expense dates + Add-expense seed to lease begin/end; server validates against property entry/exit (`occupantmanager.ts:686-696`).
- **Trigger:** Property with `entryDate` after lease begin → add any expense (defaults to lease begin) → Save → 422 "beginDate cannot be before property entryDate".
- **Fix direction:** Bind expense date min/max + the one-time pin + Add-expense seed to `property.entryDate`/`exitDate` (fallback to lease begin/end).

### L5. `toOccupantData` crashes (500, blank tenant page) on a property with no `expenses` array
- **Root cause:** `frontdata.ts:479` — `item.expenses.forEach(...)` unguarded, while the sum-loop at `:496` IS guarded and the engine guards (`1_base.ts:883`); aggregate/`.lean()` fetch paths skip the Mongoose `[]` default.
- **Trigger:** Tenant with a property entry lacking the `expenses` key (legacy/mongo-seed) → GET `/tenants/:id` or `/rents/tenant/:id` → 500, tenant Rental overview blanks.
- **Fix direction:** `(item.expenses || []).forEach(...)` at `:479`, matching the engine guard.

### L6. Saved IRIS QR is write-only and can never be regenerated
- **Root cause:** `billmanager.ts:296-298/315` persists `irisCodeUrl` but it has zero readers anywhere; `paymentCode` always stored null because `BillImportDialog.handleConfirm:176-190` never forwards it → `generateIrisQr` returns null (`index.ts:67`); `irisCodeBase64` schema field never written.
- **Trigger:** Import a DEH bill (QR shows in dialog), confirm, close → no surface renders the saved QR and it can't regenerate.
- **Fix direction:** Forward `paymentCode` in the confirm body (and surface the saved `irisCodeUrl` in a bill detail/list view), so the QR can render/regenerate.

### L7. Express settle records UTC date while drawer header shows LOCAL date — off-by-one near Athens midnight
- **Root cause:** `ExpressPaymentDialog.js:219` shows `moment().format('DD/MM/YYYY')` (local); `rentmanager.ts:504` stamps `moment.utc().format('DD/MM/YYYY')` (used `:603`); response carries no date back.
- **Trigger:** Record via Express at 01:30 Athens → header "16/06", payment persisted "15/06".
- **Fix direction:** Align the dialog's `moment()` with `moment.utc()` (or return the stamped date and display it). (Same mixed-moment class as `35af8ec0`.)

### L8. DEH bill amount parser misreads a bare thousands-dot (no comma) as a decimal point
- **Root cause:** `services/api/src/managers/billparser/deh.ts:5-8` — dot-thousands/comma-decimal normalization runs only `if (cleaned.includes(','))`; `parseFloat('1.234')` → 1.234.
- **Trigger:** DEH total printed as a round-thousands amount without cents, e.g. `1.234 €` → parses €1.23. (Low likelihood: Greek invoices conventionally always print `,NN`.)
- **Fix direction:** Handle the dot-only case at `:5` — strip grouping dots whenever no comma is present (or treat a lone dot before exactly 3 trailing digits as a thousands separator).

### L9. Receipt/invoice PDF body crashes on a rent missing `discounts`/`debts`/`preTaxAmounts` arrays
- **Root cause:** `services/pdfgenerator/templates/partials/invoicebody.ejs:47/75/84` (and the length math at `:110`) deref `.forEach`/`.length` with no `|| []`, while `buildingCharges:56` / `charges:94` ARE guarded; `getRentsData` spreads the Mixed-typed persisted rent without backfilling.
- **Trigger:** Generate a receipt/rent-call for a direct-mongo/legacy rent row that bypassed `BL.computeRent` → 500/blank PDF.
- **Fix direction:** Add `|| []` to lines 47, 75, 84, and the `:110` length terms — match the buildingCharges/charges pattern.

### L10. Zero-amount (credit) DEH bill renders an em-dash in the import preview; bill dates use browser OS locale
- **Root cause:** `BillImportDialog.js:64` (`<NumberFormat value={parsed.totalAmount}/>` with no `showZero` → `'—'` for 0 per `NumberFormat.js:50-56`); `:69-70/76` use `toLocaleDateString()` with no locale arg (browser/OS locale, not org locale).
- **Trigger:** Import a €0,00 DEH month → Amount shows `'—'` (indistinguishable from parse miss); el-GR org in en-US browser → US `M/D/Y` dates beside Greek euros.
- **Fix direction:** Pass `showZero` at `:64/:104`; format dates via `moment(...).format('L')` (the app convention), not `toLocaleDateString()`.

### L11. Tenant frontend falls back to USD currency when `lease.landlord.currency` is absent
- **Root cause:** `webapps/tenant/src/utils/formatnumber/index.ts:4` `DEFAULT_CURRENCY='USD'`, `:39` `currency || DEFAULT_CURRENCY`; landlord side defaults to EUR (`numberformat.js:3`).
- **Trigger:** Lease whose `landlord.currency` is nullish on the tenant payload (legacy/partial realm) → tenant sees `$` on euro invoice/contract amounts.
- **Fix direction:** Change tenant-side `DEFAULT_CURRENCY` to `'EUR'` to match the landlord side (and guard realm currency upstream per L1).

### L12. Frequency-dropdown flip silently widens a custom sub-period expense window to the full lease (over-bills)
- **Root cause:** `LeaseContractForm.js:219-220` (monthly branch) and `:215-216` (one-time) unconditionally overwrite expense begin/end with the lease range, discarding a custom window.
- **Trigger:** Set a Mar–Jun expense window, toggle Frequency one-time→monthly → window expands to full lease → engine bills every month.
- **Fix direction:** On frequency-flip, preserve/restore the expense's own prior persisted dates instead of overwriting with the lease range. (Requires an actual value change; mere re-select is a no-op.)

### L13. "+{{count}} tenants" footer uses the plural form for count=1 in all locales (no `_one` variant)
- **Root cause:** `ExpressPaymentDialog.js:297` `t('{{count}} tenants', {count})`; no `'{{count}} tenants_one'` key in any of the 6 locale files (sibling `'{{count}} tenants imported_one'` exists, proving the convention).
- **Trigger:** Select exactly one tenant → footer reads "1 ενοικιαστές" / "1 tenants".
- **Fix direction:** Add `'{{count}} tenants_one'` to each locale (el "1 ενοικιαστής", en "1 tenant").

### L14. Rent-call email prints English "Total" / "Building charges" amid Greek copy
- **Root cause:** `rentcall/body_html.ejs:32` `_.t('Total')` with no `'Total'` key in `el.json` (i18n `updateFiles:false` → verbatim source); `1_base.ts:959` `charge.description || 'Building charges'` is a hardcoded English literal rendered raw (`body_html.ejs:30`/`body_text.ejs:14`).
- **Trigger:** Greek-locale rent-call where the breakdown table renders → "Total" footer (common path) and any description-less building charge ("Building charges") show in English.
- **Fix direction:** Add `'Total':'Σύνολο'` (+ other locales) to `services/emailer/src/locales/*.json`; make the `1_base.ts:959` fallback translatable (leave blank / use a token translated at render).

### L15. On-screen settlement month-row labels frozen at module-load locale (Spanish), diverging from Greek dates + Greek CSV header
- **Root cause:** `TenantSettlements.js:13` `const months = moment.localeData().months()` evaluated at import (after `_app.js:2-6` imports set global locale to the LAST one, `es`); `_app.js:64` sets realm locale only in render. Server CSV header pins `realm.locale` (`accountingmanager.ts:480`).
- **Trigger:** el realm, hard-load Accounting → Payments → month rows render Spanish names beside Greek dates and a Greek CSV header.
- **Fix direction:** Derive `months` at render time from the realm locale inside the component (`moment.localeData(store.organization.selected.locale).months()`), not at module load.

### L16. Personal-account landlord can save bankName with empty IBAN → rent-call PDF prints a dangling empty "IBAN" line; no IBAN format validation
- **Root cause:** `BillingForm.js:52-53/108` (iban optional, always emits `bankInfo:{name,iban}`); `data/index.js:80` `hasBankInfo=!!landlord.bankInfo` (truthy on hydrated nested path even when empty); `paymentmodalities.ejs:5-9` renders `IBAN <%= ...iban %>` gated only on `hasBankInfo`; `isValidIBAN` never called on the realm path.
- **Trigger:** Personal account sets Bank name, leaves IBAN blank, Save → every rent-call/reminder PDF shows an empty "IBAN" line (typo'd IBANs likewise print unchallenged).
- **Fix direction:** Gate `paymentmodalities.ejs:5` on a non-empty IBAN+name; compute `hasBankInfo = !!(landlord.bankInfo && landlord.bankInfo.iban)` at `data/index.js:80`; call `isValidIBAN` in `realmmanager.update()`.

---

## Cross-cutting notes
- **Root-cause clusters worth one coordinated fix:** (a) **currency config** L1+H5+H6 all stem from `add()` not validating currency + dropdown/whitelist mismatch + unconditional `Intl.NumberFormat` — fix the three together. (b) **`toFixed(2)`+baked-€ locale leak** M6+M7+L14 share the "bypass `useFormatNumber`, hardcode €" anti-pattern across 5 files. (c) **`moment(undefined)`→today** M4+M5 are the same fabricated-date class. (d) **unguarded `.forEach`/missing `||[]`** H1+L5+L9 are the same defensive-coercion gap (engine guards, display path doesn't). (e) **Express settle** C1+C2+M2+L7 are all the same drawer; C1/C2 are the money-critical pair.
- **Highest money-risk, fix first:** C1, C2 (write-path money corruption), then H2/H3 (tax-receipt + dunning money), then H5/H6 (surface-down + lockout).