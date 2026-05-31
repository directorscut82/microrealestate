# UI Coverage Backlog (from workflow ww0gn2vsh)

## Summary

- 622 UI controls enumerated
- 391 gaps
- CRITICAL: 36, HIGH: 44
- 70 scenarios designed (not yet written as specs)

## Per surface coverage gaps

- rents-and-payment-dialog: 80 controls
- tenants-pages-and-dialogs: 103 controls
- properties-and-buildings: 177 controls
- dashboard-and-accounting: 73 controls
- settings-leases-templates: 164 controls
- auth-firstaccess-shared: 25 controls

## Designed scenarios (UC01..UC70)

### UC01: Tenant ActionBar Delete shortcut opens confirm dialog (no payments)
**Target:** ShortcutButton[data-cy=removeResourceButton] on /tenants/[id]
**Why:** Protects the irreversible tenant-removal entry-point from a regression that would either disable, hide or wire the wrong handler to the ShortcutButton — currently exercised only via API.

### UC02: Delete tenant dialog: 'Delete anyway' fires DELETE and navigates back
**Target:** Button[variant=destructive] with text 'Delete anyway' inside delete-tenant Dialog
**Why:** Validates the destructive removeMutation path end-to-end through the actual button — no spec currently clicks it.

### UC03: Delete tenant dialog: 'Terminate lease and delete' performs both actions
**Target:** Button[variant=outline] with text 'Terminate lease and delete'
**Why:** Combined terminate-and-delete is irreversible AND alters lease history; failing silently here would leave tenants in zombie states.

### UC04: ActionBar Terminate opens TerminateLeaseDialog and zod blocks empty terminationDate
**Target:** ShortcutButton 'Terminate' (LuStopCircle) on /tenants/[id]
**Why:** Specs explicitly bypass this dialog via API; the zod min(1) on terminationDate would silently drift if no UI test ever opens the dialog.

### UC05: TerminateLeaseDialog accepts a valid date and submits guarantyPayback
**Target:** Input#terminationDate (type=date) + Input#guarantyPayback (type=number) inside TerminateLeaseDialog
**Why:** Termination drives rent generation and ledger; the DD/MM/YYYY conversion at submit must round-trip correctly via the actual UI.

### UC06: Lease tab Termination section: deposit refund (guarantyPayback) writes via UI
**Target:** Input#guarantyPayback (type=number) inside LeaseContractForm Termination Section
**Why:** Deposit refund changes the ledger; LeaseContractForm's UI write path is unverified.

### UC07: Property page Delete button opens ConfirmDialog and confirms removal
**Target:** Button[data-cy=removeResourceButton] on /properties/[id] + ConfirmDialog Confirm
**Why:** Property delete is destructive and only API-covered; UI confirmation flow has no test.

### UC08: Property delete on OCCUPIED property shows 422 toast and keeps row
**Target:** Button[data-cy=removeResourceButton] on /properties/[id] when seed tenant occupies it
**Why:** Referential-integrity error path on property delete has no UI assertion — the toast message would silently disappear.

### UC09: Building page Delete: ConfirmDialog opens with cascade subtitle
**Target:** Button[data-cy=removeResourceButton] on /buildings/[id]
**Why:** Cascade delete subtitle is the only visible warning before destructive action; no spec opens this dialog.

### UC10: Building unit-row Delete (LuTrash) opens ConfirmDialog and removes unit
**Target:** Button[aria-label=Delete] (LuTrash) inside Units tab table row
**Why:** Per-unit destructive delete + cache invalidation never tested via UI; cascade affects building math.

### UC11: Documents tab UploadFileItem delete: ConfirmDialog removes uploaded document
**Target:** Button (LuTrash ghost icon) inside DocumentsForm UploadFileItem
**Why:** Destructive document removal + ConfirmDialog have no UI coverage.

### UC12: ExpressPaymentDialog: ticking ONLY 'Prior balance' sub-option (carry without monthly)
**Target:** Checkbox 'Prior balance' inside per-tenant row of ExpressPaymentDialog
**Why:** Prior-balance-only allocation is a distinct money-movement mode never tested; affects ledger reconciliation.

### UC13: ExpressPaymentDialog: ticking ONLY 'Monthly' sub-option (no prior)
**Target:** Checkbox 'Monthly' inside per-tenant row of ExpressPaymentDialog
**Why:** Monthly-only allocation distinct from carry settlement — without this test, mis-routing 'monthly' to 'previousBalance' would silently miscredit.

### UC14: AllocationBlock: select Custom split radio reveals per-category numeric inputs
**Target:** Radio[data-cy=allocMode-0-custom] inside NewPaymentDialog -> AllocationBlock
**Why:** Selecting Custom split is the gateway to per-category numeric allocation — without this test, the radio could silently fail to render the inputs.

### UC15: AllocationBlock Custom split: per-category amount inputs split a payment correctly
**Target:** Input[data-cy=allocCustom-0-rent] + Input[data-cy=allocCustom-0-previousBalance]
**Why:** Custom split per-category numeric inputs directly drive ledger; mis-mapping would silently miscredit.

### UC16: AllocationBlock Specific category: select 'Repairs' from dropdown
**Target:** SelectTrigger[data-cy=allocSpecificCategory-0]
**Why:** Four of six categories (repairs, vat, previousBalance, extracharge) are never selected via UI. Mis-allocation here is direct money-misposting.

### UC17: RentHistoryDialog: clicking a past month tile opens NewPaymentDialog
**Target:** Card[data-current-tile] on RentHistoryDialog month grid
**Why:** Month-tile click is the primary entrypoint to retroactive payment editing; never clicked in any spec.

### UC18: RentHistoryDialog: pencil icon on a month tile opens edit-mode for historical payment
**Target:** Button[aria-label=Edit] (LuPencil) inside RentListItem
**Why:** Pencil-edit on historical month is critical for retroactive ledger correction; never tested.

### UC19: SavedPaymentEditForm: change Date via DatePickerInput re-attributes the payment
**Target:** DatePickerInput inside SavedPaymentEditForm
**Why:** Editing a saved payment date affects rent-period attribution; previously specs only edited the amount.

### UC20: SavedPaymentEditForm: change Type from cash to cheque reveals reference and persists
**Target:** Select 'Type' inside SavedPaymentEditForm
**Why:** Type drives reference-field validation and audit trail; show/hide-by-type and persistence have zero UI coverage in saved-edit form.

### UC21: SavedPaymentEditForm: change Reference for a transfer payment
**Target:** Input 'IBAN or transaction id' inside SavedPaymentEditForm (visible when type=transfer)
**Why:** Reference is the audit trail for cheque/transfer payments; never edited in saved-edit form.

### UC22: TenantForm: 'A business or an institution' radio reveals legal/tax fields
**Target:** Radio inside label[data-cy=tenantIsBusinessAccount]
**Why:** isCompany=true reveals legal/tax/EIN fields used on invoices and lease docs — branch never rendered under any spec.

### UC23: BillingForm: toggle 'Subject to VAT' switch enables VAT inputs
**Target:** Switch[id=isVat] inside BillingForm
**Why:** VAT toggle materially changes invoice math; never toggled in any spec.

### UC24: BillingForm: typed 'VAT percentage' persists with /100 transform
**Target:** Input#vatRatio (type=number) inside BillingForm
**Why:** The /100 transform on submit is the locale-conversion bug zone — mis-saved value silently miscomputes every rent.

### UC25: BillingForm: 'Monthly discount' field affects rent computation
**Target:** Input#discount (type=number) inside BillingForm
**Why:** Monthly recurring discount affects every rent term — UI write path unverified.

### UC26: LeaseContractForm: open the 'Lease' (contract) Select and pick a contract auto-derives endDate
**Target:** SelectTrigger 'Lease' inside LeaseContractForm Lease section
**Why:** Contract selection auto-derives endDate AND term frequency — drives every rent term; never opened in any spec.

### UC27: LeaseContractForm: Start date + End date fields fill via UI and submit converts YYYY-MM-DD → DD/MM/YYYY
**Target:** Input#beginDate (type=date) and Input#endDate (type=date) inside Lease section
**Why:** Locale conversion at submit is the silent-bug zone for rent generation; the UI write path is unverified.

### UC28: LeaseContractForm: Deposit (guaranty) numeric input persists
**Target:** Input#guaranty (type=number) inside Lease section
**Why:** Deposit/guaranty within the 0–10M zod range is a financial figure never typed via UI.

### UC29: LeaseContractForm Properties section: 'Rent' input + 'Property' Select roundtrip
**Target:** Input properties.0.rent (type=number) + first SelectTrigger inside the property card
**Why:** Rent and Property selection are the primary money/identity bindings; both UI write paths unverified.

### UC30: LeaseContractForm Save submit: 'Saving' state appears and Save persists with locale conversion
**Target:** Button[data-cy=submit] (type=submit) at LeaseContractForm footer
**Why:** Lease save is the conversion gate (YYYY-MM-DD → DD/MM/YYYY) and double-click is a known dialog footgun; the disabled-during-submit guarantee has no UI test.

### U01: Draft payment row — discount description (notepromo) round-trips visibly
**Target:** Textarea (Discount description) — id=payments.0.notepromo
**Why:** Discount description is tenant-visible on invoices/PDFs. Spec 16 fills only amount; description never round-tripped via UI.

### U02: Draft payment row — extra-charge description (noteextracharge) round-trips visibly
**Target:** Textarea (Extra charge description) — id=payments.0.noteextracharge
**Why:** Extra-charge description appears on tenant-visible documents; the textarea has zero UI coverage.

### U03: Rents Actions popover → Email Invoice PDF triggers ConfirmDialog and POSTs send
**Target:** Popover menu item — Invoice (Email)
**Why:** Email-invoice from the rents page is a daily core action with zero UI coverage.

### U04: Rents Actions popover → First payment notice (rentcall) confirm + send
**Target:** Popover menu item — First payment notice
**Why:** Rentcall (first notice) collections email — UI path entirely uncovered.

### U05: Rents Actions popover → Second payment notice (rentcall_reminder)
**Target:** Popover menu item — Second payment notice (text-warning class)
**Why:** Reminder collections email — UI path uncovered.

### U06: Rents Actions popover → Last payment notice (rentcall_last_reminder) sends with destructive styling
**Target:** Popover menu item — Last payment notice (text-destructive)
**Why:** Last notice precedes legal action; UI path uncovered.

### U07: Rents Actions — 'Send by email' popover trigger disabled-when-empty selection
**Target:** Button (popover trigger) 'Send by email'
**Why:** Disabled-when-empty is a UX guard; never asserted under test.

### U08: Rents Actions — Send SMS triggers POST and toast
**Target:** Button — Send SMS
**Why:** SMS rentcall channel has zero UI coverage — collections-critical path.

### U09: Confirm dialog Cancel keeps email un-sent
**Target:** ConfirmDialog Cancel for email send
**Why:** Cancel path of the gating dialog never tested — without it, mistaken sends are silent risks.

### U10: Per-row checkbox toggles selection set
**Target:** Checkbox (per-row select) on RentRow
**Why:** Bulk-action targeting depends on this checkbox; never ticked in UI tests.

### U11: Header select-all + indeterminate state
**Target:** Checkbox (Select-all) at top of RentTable
**Why:** Select-all + indeterminate is non-trivial state machine; never tested.

### U12: Rents page tenant search filters the list
**Target:** Search box [data-cy=globalSearchField] on /rents
**Why:** Daily collections filter; existing test searches /tenants not /rents.

### U13: Filter chip 'In arrears' (notpaid) narrows rents list
**Target:** Filter chip in ToggleMenu — id='notpaid'
**Why:** Primary collections filter; chip click never exercised.

### U14: Filter chip 'Partially settled' (partiallypaid)
**Target:** Filter chip — id='partiallypaid'
**Why:** Partial filter is key for ledger reconciliation; never clicked.

### U15: Filter chip 'Settled' (paid)
**Target:** Filter chip — id='paid'
**Why:** Settled filter completes the chip group; never tested.

### U16: RentOverview Previous-month chevron navigates back
**Target:** Button aria-label='Previous month' (chevron-left)
**Why:** Primary month navigation never clicked — tests only goto with explicit yearMonth.

### U17: RentOverview Next-month chevron advances
**Target:** Button aria-label='Next month' (chevron-right)
**Why:** Forward navigation chevron never clicked.

### U18: Reminder paperclip badge downloads invoice PDF
**Target:** Button (paperclip) Reminder/Invoice on RentRow
**Why:** Tenant-facing PDF artifact path from a row never exercised.

### U19: Tenants list — 'Add a tenant' opens NewTenantDialog and submits
**Target:** Button 'Add a tenant'
**Why:** Primary tenant-creation entry point — covered only via API seeding.

### U20: Tenants list — 'Import PDF' opens ImportTenantDialog
**Target:** Button 'Import PDF' (LuFileUp)
**Why:** Greek-lease bulk-import flow has zero UI coverage.

### U21: Tenants list — Filters popover trigger opens ToggleMenu
**Target:** Filter popover trigger (FilterBar Button)
**Why:** Filter popover open path untested.

### U22: Tenants Filter — selecting 'Lease running' updates URL
**Target:** Checkbox menu item — Lease running
**Why:** URL sync of multi-select filters never verified.

### U23: Tenants list — 'Show archived' toggle refetches with includeArchived=true
**Target:** Switch [data-cy=showArchivedToggle]
**Why:** Archived visibility toggle never clicked under test.

### U24: TenantListItem card click navigates to tenant detail
**Target:** TenantListItem card header [data-cy=openResourceButton]
**Why:** Primary navigation from list to detail never exercised in UI.

### U25: Tenant detail — Lease tab activation
**Target:** TabsTrigger value='lease'
**Why:** Lease tab gateway never clicked.

### U26: Tenant detail — Billing tab activation
**Target:** TabsTrigger value='billing'
**Why:** Billing tab gates VAT/discount form; never clicked.

### U27: Tenant detail — Documents tab + missing-doc warning indicator
**Target:** TabsTrigger value='documents'
**Why:** Documents tab + amber warning never asserted.

### U28: Tenant detail — Tenant tab default + activation
**Target:** TabsTrigger value='tenant'
**Why:** Tenant tab activation path not tested.

### U29: Tenant detail — Edit ShortcutButton + ConfirmDialog flips readOnly
**Target:** ShortcutButton 'Edit' on tenant ActionBar
**Why:** Edit gate is the only path from readOnly→editable; never clicked.

### U30: Tenant form — Save (submit) writes name change
**Target:** Button [data-cy=submit] 'Save' on TenantForm
**Why:** Form submit was never clicked; rename happens via API only.

### U31: Tenant form — First name required validation
**Target:** Input #firstName
**Why:** Required-field validation never exercised through the UI.

### U32: Tenant form — Last name required validation
**Target:** Input #lastName
**Why:** Required validation never exercised.

### U33: Tenant form — Contact email format validation
**Target:** Input #contacts.0.email
**Why:** Email format validation never exercised through the form.

### U34: Tenant form — Phone 1 PHONE_REGEX validation
**Target:** Input #contacts.0.phone1
**Why:** Phone regex validation never exercised through the input.

### U35: Documents tab — Upload icon opens UploadDialog
**Target:** Button (ghost icon, LuUploadCloud) aria-label='Upload'
**Why:** UploadDialog never opened; document attachment flow uncovered.

### U36: Documents tab — Create a document opens drawer + RichTextEditorDialog
**Target:** Button 'Create a document' [data-cy=addTenantTextDocument]
**Why:** Drawer + RichTextEditorDialog flow never opened.

### U37: Properties list — search updates URL ?search=
**Target:** Search input [data-cy=globalSearchField] on /properties
**Why:** Properties search + URL sync never exercised.

### U38: Properties — 'Add a property' opens NewPropertyDialog
**Target:** Button 'Add a property'
**Why:** Property creation entry replaced by API seeding; UI path uncovered.

### U39: New Property dialog — Add submits POST /properties
**Target:** Button [data-cy=submitProperty] 'Add'
**Why:** POST through the UI never exercised.

### U40: Buildings — 'Add a building' opens NewBuildingDialog
**Target:** Button 'Add a building'
**Why:** Primary building-creation entry never clicked.

