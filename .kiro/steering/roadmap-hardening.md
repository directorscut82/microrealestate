---
inclusion: always
---
# MRE Hardening & Extensibility Roadmap

This document lists all changes needed to make the codebase ready for major
feature work (online payments, webhooks, third-party document ingestion/OCR, etc.).

Changes are grouped into phases. Each phase should be completed before the next.

---

## Phases 1–3 — ARCHIVED (all completed, 2026-Q1/Q2)

These phases closed long ago and their line-items are now just history; they were being re-read
every session as if they were live work. One-line summary each, no detail:

1. **Critical fixes** — ServiceError bug, `RESTORE_DB` disabled in `base.env`, MongoDB indexes added.
2. **Data integrity** — referential-integrity guards + Redis TTL alignment. ⚠️ Both of those lists
   were **factually wrong** where they were quoted: the guards are described (re-measured
   2026-08-02) in `architecture-patterns.md` § Referential Integrity — the tenant-delete guard is
   **recorded money only**, not "active lease or unpaid balance", and property delete has a second
   building-unit blocker. Live TTLs, measured in `services/authenticator/src/routes/`: access token
   **15m** (`landlord.ts:37`), refresh **3600s prod / 12h dev** (`:33`), tenant session **30m prod /
   12h dev** (`tenant.ts:165`), app M2M token **300s** (`landlord.ts:185`), reset-password token
   **5m** signed + **300s** in Redis (`:412`/`:417`), password-reset link **1h** (`:478`). The old
   "Access tokens: 5min" line was the M2M token, not the user access token.
3. **Codebase consistency** — 4 services migrated to TypeScript (58 files); MobX fully removed
   (12 stores, all 22 forms on react-hook-form + zod); MUI v4 removed; `frontend-patterns.md`
   created. Still open from 3.1: locale arrays duplicated across ~15 files (never centralised).

---

## Phase 4 — Architecture Extensions ✅ MOSTLY COMPLETE

### 4.1 Building entity ✅ COMPLETE
- **Collection:** `Building` — comprehensive Greek polykatoikia model
  - Top level: name, address, atakPrefix, blockNumber, totalFloors, heatingType, manager, bankInfo
  - Sub-documents: units[], expenses[], contractors[], repairs[], ownerMonthlyExpenses[]
- **Unit model:** atakNumber, floor, surface, thousandths (general/heating/elevator), owners[], occupancyType, propertyId link, monthlyCharges[]
- **Expense model:** name, type (11 types), amount, allocationMethod (**9** methods — `single_unit` was added later and this line said 8 for months; `building.ts:113`), customAllocations[], isRecurring, billingId, trackOwnerExpense. Note the **unit-level** `monthlyCharges` allocationMethod enum (`building.ts:249`) still has only the original 8 — no `single_unit`.
- **Contractor model:** name, company, specialty (8 types), contact info
- **Repair model:** title, category, status, urgency, cost, contractor link, affected units, chargeable allocation
- **API:** Full CRUD at `/api/v2/buildings` with sub-resource routes for units, expenses, contractors, repairs
- **UI:** Building management page with tabs (units, expenses, contractors, repairs)

### 4.2 Building Services (κοινόχρηστα) ✅ COMPLETE
- Monthly statement generation with expense allocation per unit
- Owner expense tracking per building expense with monthly amounts
- 9 allocation methods: general/heating/elevator thousandths, equal, by_surface, fixed, custom_ratio, custom_percentage, single_unit
- Variable vs recurring expense distinction with Ναι(κυμαινόμενο) badge
- Unified expense panel: one calendar-driven tile (monthly statement + history merged) with per-month "who is charged" breakdown (renter / owner-vacant-billed / uncollected / owner-direct)
- Safe expense deletion dialog with soft/hard delete and impact warning
- Retroactive rent recalculation on expense changes

#### 4.2.1 Building-domain hardening wave (June 2026) ✅ COMPLETE
Shipped on `nas` (HEAD `6e771282`); ~83 commits since the prior reference rev `257ed94f`.
- **Owner-billing for vacant managed units** — a unit with no tenant covering the term has its building-expense share routed to the OWNER when the expense opts in via `chargeOwnerWhenVacant` (per-expense toggle; previously a disabled "coming soon" stub). `equal` allocation now counts vacant managed units as parties (`1_base.ts`), matching the thousandths/surface methods. `OwnerMonthlyExpenseSchema` gained a `source` enum (the distinct `repair-vacant` source prevents the expense-recompute from wiping a vacant unit's repair share) plus `paid`/`paidDate`. **The enum now has 7 members**, not the 4 this line used to list — `building.ts:380` = `expense`, `repair`, `vacant`, `repair-vacant`, `owner-fixed`, `owner-resident`, `credit`. A missing enum value is how the OVERPAY absent-representation bug hid money (see `documentation/MONEY_SURFACE_MATRIX.md`), so read the schema rather than this list. `MonthlyChargeSchema` gained `inputAmount`.
- **Money-correctness bugs fixed** (adversarially verified across 3 rounds): kymainomeno (variable) statement amount eroding to zero on re-save (`22316220` — `inputAmount` preserves the entered figure); fixed-zero server guard (`d652f3ca`) + method-flip bypass (`f9e54d68`) + single_unit/sub-cent (`7ed0e539`) + duplicate-propertyId (`6e771282`). New `validateSingleUnitAllocations` + duplicate-propertyId rejection + per-unit-rounded fixed check in `validators.ts`.
- **Owner-expenses paid/unpaid Overview tile** (`a6fd2567`) — progress tile under the income tile; per-charge paid checkbox in the breakdown; route `PATCH /buildings/:id/owner-expense/:ownerExpenseId/paid` → `setOwnerExpensePaid`.
- **Repairs/scheduled-work summary tile** on the building Overview (`4faf79da`); vacant-owner lifecycle recompute trigger + dashboard double-count fix (`c432f5bf`).
- **NAS specs**: `48_building_expense_panel`, `49_vacant_owner_money`, `50_owner_expenses_paid_tile`.

### 4.3 Event/Webhook system — NOT STARTED
- **Purpose:** Receive notifications from external services (payment gateways, OCR services)
- **Design:** Webhook receiver endpoint (authenticated via HMAC or shared secret per source)

### 4.4 Payment gateway integration — NOT STARTED
- **Purpose:** Online rent payments (Stripe, Viva Wallet, etc.)
- **Design:** Tenant portal → initiate payment → redirect to gateway → webhook confirms → rent marked as paid

### 4.5 Document ingestion / OCR ✅ COMPLETE
- Greek AADE Taxisnet lease PDF import (regex-based parser, pdfjs-dist text extraction)
- Greek DEH utility bill PDF import (parser + auto-match to building expenses)
- Bill collection with status tracking, IRIS QR code generation, RF payment codes
- API routes (verified against `services/api/src/routes.ts:474-525`): `POST /bills/parse`,
  `POST /bills/confirm`, `POST /bills/payment-receipt` → `billManager.parsePaymentReceipts`,
  `POST /bills/confirm-payment`, `POST /bills/recapture/start`, `GET /bills/recapture/:id`,
  `POST /bills/:id/attach-source`, `GET /bills`, `GET /bills/:id`, `DELETE /bills/:id`.
  ⚠️ **`/bills/parse-payment` does not exist** — this doc invented that path; the real one is
  `/bills/payment-receipt`. Read `routes.ts`, don't copy from here.
- Frontend: BillImportDialog, PaymentReceiptDialog
- PDF-parser unit tests: **14** in `services/api/src/__tests__/managers/e9parser.test.js` (this line
  said 13; elsewhere the E9 audit entry claims 42 — that figure counted the whole audit's assertions,
  not `it()` blocks. Measure: `grep -cE '^\s*(it|test)\(' <file>`.)

### 4.6 SMS Gateway integration ✅ COMPLETE
- Uses Android SMS Gateway app (sms-gate.app) as bridge
- Config: Realm.thirdParties.smsGateway (url, username, password — encrypted)
- Sends SMS to all tenant contacts' phone numbers alongside email

### 4.7 Database Backup/Restore ✅ COMPLETE (added May 2026)
- MongoDB backup to JSON (with type markers for ObjectId, Date, Binary) of the collections named
  in `COLLECTIONS_TO_BACKUP` (`services/api/src/managers/databasemanager.ts`) — which as of
  2026-08-22 is **all 12**, `inboxitems` and `telegramoffsets` included (this entry previously said
  they were excluded; that is stale). `accounts` is still deliberately emptied
  on a per-realm backup (no `realmId`), so 9 are really captured.
- Restore with atomic wipe-and-replace per collection
- Triple-layer production protection (legacy Cypress era):
  1. resetservice `assertTestDatabase` guard (403 if connected to mredb)
  2. Cypress `before()` hook URL verification (no longer applicable — Cypress suite was removed in May 2026)
  3. Pre-test backup shell script
- **Current Playwright equivalent**: `e2e-playwright/backup-nas-before-tests.sh` runs `mongodump` via the Portainer exec API before every E2E run. Realm-scoping (CYPRESS-TEST-DO-NOT-USE) replaces the test-database guard since NAS doesn't deploy resetservice. See `documentation/E2E_TESTING.md`.
- 50MB body parser limit for large restores
- Settings UI panel with download/upload

### 4.8 Security Hardening — ⚠️ REOPENED 2026-08-02 (was "✅ COMPLETE, April–May 2026")

**Why reopened:** the ✅ was applied in May 2026 and then sat, in the only open-items document, across
a live credential leak. It covered *application input hardening* only and never covered secret
handling, yet it read as "security: done" — which is precisely why nobody looked.

**What actually happened while this said COMPLETE:** real credentials and personal data were
committed to a **public** GitHub fork and stayed reachable for ~3.5 months. Full record:
`documentation/PII_INCIDENT_2026_08.md`. The mechanism that hid it is the diff-vs-tree distinction —
a secret introduced in commit A and never removed shows up only in A's diff, but every later
commit's *tree* still serves it, so `git log -p` review of recent work sees nothing.

**Open (as of 2026-08-02):**
- 🔴 **A live sms-gate.app credential is still public.** It is reachable from `origin/nas` and
  `origin/master`, and pinned by the server-owned, read-only, permanent `refs/pull/1/head`. No
  history rewrite and no Support ticket can remove that ref. **Rotation is the only remedy and has
  NOT been authorized.** Do not describe this as fixed.
- 🟡 Local-dev secret values in git history — rotation deferred by the user.
- 🟡 No secret-scanning in CI (the two guards are local git hooks only: `.husky/pre-commit` PII scan,
  `.husky/pre-push` commit-tree credential scan). A hook is bypassable with `--no-verify` and does
  nothing for anyone who clones.
- 🟡 `scripts/*.mjs` — where both guards live — is in **no lint gate** (see `tech-stack.md`).

**Done (application input hardening, the original scope):**
- NoSQL injection prevention (express-mongo-sanitize)
- Input validation (percentage sums, enum/range checks, NaN guards)
- Rate limiting on auth endpoints — hand-rolled `authRateLimit`, **not** a library; see `tech-stack.md`
  for the routes it does and does not cover (`/refreshtoken` and `/session` are deliberately excluded)
- Financial rounding fixes (precision errors)
- Race condition fixes (concurrent mutations)
- Error handling improvements (ServiceError propagation)
- Frontend: ErrorBoundary, token refresh queue fix, payment double-submit prevention, auth header leak fix

### 4.9 Server-Side Pagination ✅ COMPLETE (added May 2026)
- `isPaginated` flag in response headers
- `page`/`limit` query params on tenant, property, lease list endpoints
- Frontend: `useInfiniteQuery` + Load More button pattern
- Backward-compatible (no pagination when params omitted)
- CORS `Access-Control-Expose-Headers` set at API level (proxy overwrites gateway headers)

### 4.10 Dashboard Performance ✅ COMPLETE (added May 2026)
- MongoDB aggregation pipeline with `$filter` on rents by term (was loading full arrays)
- 20 unit tests for aggregation logic
- **NOT shipped despite earlier roadmap claim:** multi-document MongoDB
  transactions. `mongoose.startSession` is re-exported from
  `services/common/src/collections/index.ts:14` but no service ever
  imports or calls it; no `withTransaction` / `startTransaction` callsite
  exists anywhere under `services/`. Multi-document updates rely on
  per-document optimistic concurrency (`If-Match` / `__v` checks) and
  best-effort sequential writes. Real transaction support remains a
  future hardening item — would require a replica set on the deployed
  Mongo (currently a single-node), wrapping `rentmanager.update*`,
  `accountingmanager` settlements, and the dashboard rebuild path in
  `withTransaction`, plus retry-on-`TransientTransactionError`.

### 4.12 Payment + Rents UX Wave ✅ COMPLETE (May–June 2026)
- **Driven by**: real usage feedback from the deployed NAS — landlord couldn't tell at a glance whether a tenant had been paid, payment dialog was confusing, accounting/notes weren't surfaced, calendar inside the payment drawer was uncllickable.
- **Backend changes**:
  - `services/api/src/managers/rentmanager.ts`: payment subdocument gained an optional `allocation: [{category, amount}]` field (wave-25). Validators reject unknown categories or sums exceeding payment amount. Categories: `rent`, `expenses`, `repairs`, `vat`, `previousBalance`, `extracharge`. Per-rent `priorRents` summary now included in the `/rents/{year}/{month}` response so the UI's previous-balance hover can render a per-month breakdown.
  - `services/api/src/managers/accountingmanager.ts`: settlements payload now includes `notesByMonth[]` per tenant so the accounting tab can render rent-level notes (description / notepromo / noteextracharge) per month.
  - No schema changes; rent docs are `Mixed`.
- **Frontend changes (landlord)**:
  - **Payment dialog** (`PaymentTabs.js`, `NewPaymentDialog.js`): 3-mode allocation UI (Auto-spread / Specific category / Custom split) with live before/after preview and overpayment-as-credit visibility. Pre-fill banner ("Editing existing payment of €X" vs "No payment recorded yet"). Future-term safeguard: warn 1–3 months ahead, hard-block beyond. Success toast with the recorded amount. Validation errors now surface as a toast and reset the saving state — no more stuck "Saving" button. Submit button label is **Record / Εκτέλεση** (was "Save").
  - **/rents row** (`RentTable.js`): 4-state status pill (Paid / Partial / Owed / No charge) inline left of the tenant name. Tenant name no longer clickable — only the right-side cash-register icon opens the dialog. Hover the **Payment** column for "Total due / Paid / Owed remaining / Overpayment". Hover **Previous balance** for a per-prior-month breakdown (auto-bucketed into 6-month chunks when >6 months). Discount footnote when applicable.
  - **RentHistoryDialog**: current-month tile uses a `bg-primary/10` tint (no ring); auto-scrolls to the current month on open; past tiles muted; future tiles dashed + faded with bold "(estimate)".
  - **Tenant detail page**: Address section removed (the tenant's address of record is the property they rent — captured on the lease tab). "Contacts" → "Contact details", with a Notes textarea per contact and auto-prefilled placeholder rows for co-tenants the landlord may not have full info on. Property tile rectangle removed; tighter spacing. BillingForm renamed "Invoicing settings"; reference field hidden under Advanced; "Discount" → "Monthly discount" with help text. LeaseContractForm property block redesigned: per-expense **Frequency** dropdown (Monthly | One-time) replacing the silent badge, single source of truth for date pairs, "Mid-lease handover dates" + "Custom date range" collapsibles closed by default.
  - **Documents tab**: "Text documents" → "Documents from templates"; friendly empty state when no templates exist (the `templates` collection on a fresh realm is empty by default).
  - **Accounting tab**: per-month Notes column showing `rent.description` (private), `notepromo` (printed on receipts), `noteextracharge` (printed on receipts).
  - **Channel status banners on /rents** (`ChannelStatusBanners.js`): three thin stacked banners (Email / SMS / Messengers) replacing the single pink Email warning. Olive when configured, amber when not, slate for not-implemented (messengers). Dismissible per-session per-realm via sessionStorage. Backed by `Organization.canSendEmails` / `canSendSms` / `emailProviderName` derived getters.
  - **ErrorBoundary**: i18n strings + locale-aware Go Home button (preserves the realm's locale instead of dropping to defaultLocale=en).
- **Renames in 6 locales**: "Additional cost" → "Έκτακτη χρέωση" / "Extraordinary charge" (key unchanged so call sites still work). 30+ new i18n keys added across el / en / fr-FR / de-DE / es-CO / pt-BR.
- **Out of scope (deferred)** — ⚠️ two of these three **have since shipped** and were still listed as
  deferred on 2026-08-02, which is how a re-implementation request gets accepted:
  - ~~Wiring imported TAXIS PDF into "Uploaded documents"~~ — **SHIPPED.** B2 storage went live July
    2026; the import calls `uploadDocument()` at
    `webapps/landlord/src/components/tenants/ImportTenantDialog.js:1042-1060` (best-effort, creates the
    Document record).
  - ~~SMS bulk-send actions on /rents~~ — **SHIPPED.** `sendRentSms` is wired through a mutation at
    `webapps/landlord/src/pages/[organization]/rents/[yearMonth]/index.js:133` with a **Send SMS**
    button at `:222-236`.
  - Accounting CSV export of notes — **still open.** Only the in-app accounting view shows them.

### 4.13 Payment Dialog Approach A + Per-Payment Refactor ✅ COMPLETE (May–June 2026)
- **Driven by**: live UX feedback during landlord onboarding — re-opening the payment dialog on an already-paid rent showed the saved payment in editable inputs (so pressing Record looked like a no-op), Note/Discount/Extra-charge fields kept reseeding from the rent record, and several minor papercuts.
- **Approach A — locked saved payments** (round-3f, deployed before 3h):
  - Saved payments render as read-only "tiles" with ✏️ Edit / 🗑 Delete affordances. Form's `payments[]` array is drafts-only. Submit merges `[...savedPayments, ...drafts]` into the server payload. Idempotent — pressing Record with no drafts and no edits is a true no-op.
- **Round-3h (UX polish)**:
  - Filter chips on /rents use terser labels (Σε οφειλή / Μερικώς εξοφλ. / Εξοφλημένα). KPI tiles keep the longer "...this month" form.
  - `.scrollbar-branded` utility in `globals.css` replaces the OS-native scrollbar with a thin ink thumb. Applied to payment dialog body and ResponsiveDialog content.
  - "Paid this month" KPI flags partial sub-count: `2 (1 μερικώς)`. Parens hidden when `partialCount === 0`.
  - PriorBalanceBreakdown collapses single-month buckets (`Apr 2026 – Apr 2026` → `Apr 2026`).
  - Reference field label per payment type: `IBAN ή αρ. πράξης` for transfer, `Αρ. επιταγής` for cheque.
  - `Levy` removed from payment-types dropdown; `Import from file (soon)` placeholder disabled+italic.
  - Date-picker default = today; calendar selected day uses `bg-olive` (was near-invisible on `bg-primary` ink).
- **Round-3i (dashboard pie tooltip)**:
  - `dashboardmanager.ts:_computePaidByBucket()` walks `rent.payments[]` and uses each payment's `allocation[]` (wave-25) directly when present, else applies the same auto-spread (oldest-debt-first) logic used by the frontend. Bucket space is the dashboard-display category space (`rent`, `charges`, `building:<type>`) — distinct from the rent-pipeline category space the frontend's `paymentAllocation.js` uses (see comment block in dashboardmanager.ts for why these are NOT merged).
  - MonthFigures pie tooltip rebuilt as a 3-column `Tenant / Owed / Collected` table; per-tenant `paidByBucket` field exposed on the `currentRevenues.tenants[]` shape. Pie segments themselves still use the prior `paidRatio` estimate (per user's explicit instruction not to change the pie chart).
- **Round-3j (per-payment note / discount / extra-charge)** — see [architecture-patterns.md](architecture-patterns.md) and [frontend-patterns.md](frontend-patterns.md):
  - Each payment carries its own `description / promo / notepromo / extracharge / noteextracharge`. The dialog footer collapsibles for these fields are gone — they live inside each draft row, and saved tiles render the attached values inline.
  - rentmanager PATCH builds N entries in `settlements.discounts[]` / `settlements.debts[]` (one per payment that carries them) instead of one rent-level entry. Backward-compat: rent-level `paymentData.promo / extracharge / description` still honored when no per-payment fields present.
- **Round-3k (surface discount + extracharge end-to-end)**:
  - MonthlyBreakdown rent-table tooltip: Discount (olive) + Additional cost (oxide) lines when non-zero.
  - RentDetails (Πρόγραμμα ενοικίων): Additional cost no longer hidden when tenant has multiple properties.
  - Accounting projection now includes `description / notepromo / noteextracharge / discounts / debts` — the original projection was missing them and the Notes column had been silently empty since the feature shipped.
- **Round-3l (date-picker help note)**: `paymentContext` opt-in renders a footer strip with bold-label + plain-language explanations of what date means vs. rent term. Greek wording reviewed and corrected ("παρελθούσα" → "ημερομηνία πριν τον μήνα ενοικίου").
- **Round-3m (tenants page polish)**:
  - Co-tenants list dedup against the primary tenant (taxId + normalized-name) so single-renter imports don't list the primary as their own συνενοικιαστής.
  - Vestigial top-level Phone/Email inputs removed (per-contact phone1/phone2/email already handles this).
  - Tenant-card "Expenses" → "Additional charges" (Έξοδα → Πρόσθετες χρεώσεις) — distinct from the per-payment "Additional cost" / Έκτακτη χρέωση. The two are intentionally different keys.
- **Round-3n (Πρόγραμμα ενοικίων per-year totals)**:
  - YearTotals component renders Collected (sum of `min(payment, grandTotal)`) and Owed (sum of `max(0, grandTotal - payment)` for past + current terms) right of each year header. Future years suppress both numbers.
- **Round-3o (review-driven security + UX)**:
  - **Per-payment field validation**: caps for `promo / extracharge` (10M) and `notepromo / noteextracharge` (1000 chars) — round-3j had shipped these fields with no validation.
  - **CSV formula-injection sanitiser** in accountingmanager.ts (`_sanitizeCsvText`): prefixes leading `= + - @ \t \r` with a single quote on settlement notes flowing into rawData JSON.
  - **Backdate guard** (server + client): payment date < rent term first day → 422 with "switch to that month's rents page". Forces explicit page switch.
  - **Toast logic**: success only when something actually changed (drafts submitted OR saved-tile edit/delete); error surfaces the server's actual message instead of the generic "Something went wrong".
  - **YearTotals showZero**: `0` now renders as `0,00 €` (was `—`).
  - **YearTotals useMemo** depends on `tenant.rents` not `tenant` so a parent memoization doesn't go stale.
  - **PaymentTabs.js split**: AllocationBlock + SavedPaymentEditForm extracted; parent went 1111 → 734 lines.
  - **First jest test** for round-3i: `dashboardManagerComputePaidByBucket.test.js` (12 cases).
- **Round-3p (past-month partial flag + dashboard date lock)**:
  - rentmanager.ts overview classifier was using its own raw-field heuristic (`totalAmount <= 0 || newBalance >= 0 → paid`) that desynced from the row UI's `rent.status`. On past months a tenant who'd paid partially but later overpaid showed up correctly as "partial" in the row but as "paid" in the KPI tile. Both surfaces now read `rent.status` as the single source of truth.
  - Dashboard "Πληρωμή ενοικίου" shortcut: NewPaymentDialog gains a `lockDateToToday` prop that disables the date picker on draft rows. The shortcut is for "tenant just paid me cash today, record it" — landlord can't accidentally backdate or forward-date from this entry point.
- **Process change**: introduced six-pass review (logic / security / i18n / quality / coverage / UX) on every diff before commit. Memory persisted under `~/.claude/projects/.../memory/feedback_six_pass_review.md`.
- **Out of scope (deferred)**:
  - Pie tooltip layout to exactly match the rents-page MonthlyBreakdown style (3-col table vs flex rows). Cosmetic.
  - Remaining 4 of 5 high-value tests Pass-5 named (per-payment validation integration, backdate guard, toast logic, YearTotals math).
  - Sharing the auto-spread/prorated primitive between `paymentAllocation.js` and `_computePaidByBucket`. Documented inline as "different bucket spaces; revisit if a third caller appears".

### 4.14 Concurrency Hardening + Receipt PDF Rebrand + Audit Sweeps ✅ COMPLETE (June 2026)
- **Driven by:** Dokimasti June 2026 €35 grandTotal drift incident (concurrent payment PATCH + building-expense recompute racing on the same tenant doc), plus a 30-review audit of the May 2026 commits, plus deep audits of the import-PDF tenant and import-PDF building (E9) surfaces using user-supplied real AADE PDFs.
- **Concurrency:**
  - Added `optimisticConcurrency: true` to Building schema; mapped VersionError → 409 across the 22 Building.save() callsites.
  - `__v` filter + `$inc` + retry-with-fresh-read on `_recomputeTenantsForProperty`, `_recomputeTenantsForBuilding`, occupantmanager sibling-recompute. Retry budget: 8 attempts × exponential backoff (50/100/200/400/800/800/800/800ms).
  - All 4 rent-rebuilding paths now realm-scoped + `__v`-guarded.
  - All other rent-rebuilding callsites (rentmanager._updateByTerm, occupantmanager.update) already had the guards; verified clean.
  - Drift scanner sweep across all tenants returned 0 drift after fix.
- **Receipt PDF rebrand + per-line label rule:**
  - "Receipt" (was "Invoice") title in PDF — `t('Receipt')` → "ΑΠΟΔΕΙΞΗ ΕΙΣΠΡΑΞΗΣ" (uppercase no tonos). CSS `text-transform: uppercase` removed so locale string controls case.
  - Receipt body excludes `rent.charges` (paid by tenant to a third party); rent-call/reminder bodies INCLUDE them. Per-template `_omitCharges` flag in `data/index.js`.
  - Tenant block: ΑΦΜ + phone1/phone2/email surfaced; "ΕΝΟΙΚΙΑΣΤΗΣ" label.
  - Issuer block: building.manager (διαχειριστής) preferred over realm (ιδιοκτήτης); fallback to realm.name when companyInfo/contacts absent. "ΙΔΙΟΚΤΗΤΗΣ"/"ΔΙΑΧΕΙΡΙΣΤΗΣ" labels.
  - Per-line label rule applied identically to: Πρόγραμμα tile (`RentDetails.js`), MonthlyBreakdown tooltip (`RentTable.js`), saved-payment bullet (`PaymentTabs._allocationBullet`), AllocationBlock dropdown + Πριν/Μετά preview, PDF body (`invoicebody.ejs`).
  - New shared util: `webapps/landlord/src/utils/lineLabels.js` (rentLineLabel, chargeLineLabel, buildingLineLabel, debtLineLabel).
  - Status-pill labels: new keys `Rent paid`/`Rent partial`/`Rent owed` ("Εξοφλημένο"/"Μερικώς εξοφλημένο"/"Ανεξόφλητο") replace nouns-as-states.
  - Per-month receipt picker on accounting page (popover with 12 months); 10-digit term endpoint.
- **May 2026 audit batches A–H** — 41 findings across rent-call PDF math (was inconsistent for VAT realms), PDF locale gaps (23 keys × 5 locales), landlord-app locale gaps, OCC realmId scoping, retry budget, issuer key, and a long polish tail. All reproduced fixes verified live.
- **Search/filter scenario catalog (specs 25–29)** — 40 scenarios authored per `test-running-guide.md` mandate; resolved D-6 (search clears on data refetch); subsequent test-side mop-up batches landed `T_M1..T_M5`.
- **Import-PDF tenant audit** — 23 findings reproduced on the user's real AADE lease PDFs (kept
  outside the repo; ask for the path rather than recording it here — an on-disk path to real
  tax documents used to be printed on this line): H1 dehNumber dropped without energy cert (between() end-anchor missing), H2 multi-property merge wipe, M2 atakPrefix collision recovery, M4 mark-past-paid `/rents/tenant/:id` (was 404 on `/rents/:year`), M6 non-AADE PDF rejection at server, M7 `Αποθήκη` → 'storage' (was 'store'), M8 Greek company-tenant detection (`Α.Ε./Ε.Π.Ε./Ι.Κ.Ε./Ο.Ε./Ε.Ε./ΑΕΒΕ`), N4 `parsed.landlords` → `units[].owners[]` (6 of 11 PDFs had 50% co-ownership silently dropped), plus pluralisation `_one` variants and 41 untranslated labels in 4 locales.
- **Import-PDF E9 audit** — 47 findings on real `PeriousiakiKatastasi*.pdf` files: T0 owner.name compose + plural _one + FileDropZone i18n + surface server message; T1 multi-PDF preview dedup + empty-zip merge + cleanCity always + storage classification (cat 5/6) + auxSurface dup guard + yearBuilt 1600-2099 + cache invalidation + per-unit existing-property metadata + outcomes shape; T2 file cap + Promise.allSettled + transactional rollback + AbortController + co-owners + rightType + ΠΕΡΙΟΧΗ ΘΗΤΑ block-plot + force=false property overwrites + jest e9parser fixture suite (42 tests, 94% coverage); T3 blockStreets noise + ΑΓ. preservation + blockNumber aggregation + cleanState + district drop + error-shape + totalFloors/hasElevator auto-derive + idempotent re-import banner; L tier latents incl. fractional rights `1/2`, locale-aware floor names, legal-entity owner detection, KAEK schema field, rate-limit GC, accent-aware building dedup, ATAK regex extract, TOCTOU race recovery; L7 marker gate (with hotfix to accept genitive `ΠΕΡΙΟΥΣΙΑΚΗΣ`).
- **No-fabrication steering doc** — `.kiro/steering/no-fabrication-do-not-skip.md` added (loads on every session); bans rendering ASCII/mockups/numbers without source citation.

### 4.11 Multi-Origin Self-Hosted Deployment ✅ COMPLETE (added May 2026)
- **Purpose:** Serve the same landlord frontend simultaneously from LAN (`http://192.168.x.x:PORT`) and Tailscale IP (`http://100.x.x.x:PORT`) so family/staff can use the app over a shared Tailnet without DNS setup.
- **Code changes (applied on `nas` branch only):**
  1. `services/gateway/src/index.ts` — `configureCORS()` accepts comma-separated `APP_DOMAIN`, builds a CORS regex per origin.
  2. `services/authenticator/src/index.ts` — removed explicit cookie `domain` attribute so cookies become host-only and work across multiple hostnames.
  3. `webapps/landlord/src/utils/fetch.js` — `apiFetcher()` uses `window.location.origin` on the client instead of the build-time `GATEWAY_URL`, so the browser always talks to the same origin it loaded from.
- **Branch strategy (corrected 2026-08-02):** `master` **does not mirror upstream** — `origin/master`
  and `origin/nas` are the *same commit* (`752e6e20`), 887 commits ahead of `upstream/master`. That
  claim was true when written and has been false for a long time. `nas` is the only branch that
  matters; `.github/workflows/nas-ci.yml` builds `:nas` + `:nas-<sha>` images to GHCR on every push.
- **Local-only files (gitignored, never pushed):** `docker-compose.nas.yml` (stack definition with inlined secrets), `.secrets/github-pat`, `.secrets/portainer-token`, `.env.nas-secrets`.
- **Deployment automation:** `scripts/deploy-nas.sh` (invoked via `yarn deploy:nas`) asks 2 questions upfront (wait for CI? redeploy stack?), merges master → nas, pushes, and triggers a Portainer stack redeploy using the local `.secrets/portainer-token`. `scripts/validate-nas-deploy.sh` runs 22 sanity checks on the local `docker-compose.nas.yml` before push.
- **Known limitation (re-measured 2026-08-02):** the deploy script does not sync from upstream
  (microrealestate/microrealestate). But the "unrelated histories, cherry-pick only" claim is **no
  longer true** — `git merge-base nas upstream/master` resolves to `88ad6787`, so a common ancestor
  exists and `git merge upstream/master` works. Check before assuming either way.
- **Docs:** `documentation/DEV_AND_DEPLOY.md` (dev + deploy workflow, troubleshooting, historical gotchas).

---

## Phase 5 — Quality & Operations

### 5.1 Unit tests for critical paths — IN PROGRESS
- **No count is quoted here.** Five different figures (431 / 609 / 628 / 644 / 875) have each sat in
  this doc reading as current long after they were snapshots. The one dated baseline lives in
  `test-running-guide.md`; anything else, measure — and note a count that DROPS is not necessarily
  lost coverage (a `.skip`, a deleted duplicate, or an untracking can do it):
  ```bash
  export PATH="/usr/local/opt/node@20/bin:$PATH"
  cd services/api && node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --no-coverage
  ls services/api/src/__tests__/**/*.test.js | wc -l   # test files on disk
  ```
- **⚠️ Jest infra (repaired in `a6fd2567`):** `services/api` is `type: module`, so the suite ONLY runs under **node@20** (system node drifted to v25 and breaks it with `ERR_REQUIRE_ESM`; node@20 is at `/usr/local/opt/node@20/bin/node`). The winston/express-winston/jsonwebtoken mocks are `.cjs` under `services/api/src/__mocks__/*.cjs` (via `moduleNameMapper`); `jest.mock`-using suites need `import { jest } from '@jest/globals'`; `realmmanager.test.js` + `propertymanager.classifyExpense.test.js` use `jest.unstable_mockModule` + dynamic `import()`. Run: `export PATH="/usr/local/opt/node@20/bin:$PATH"; cd services/api && node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --no-coverage`.
- **Covered:** Rent computation pipeline, building expense allocation (incl. vacant-owner billing + repair distribution), dashboard aggregation, PDF parsers (lease + E9), auth token refresh, payment double-submit, ErrorBoundary, allocation validators.
- **Remaining:** Auth flows (JWT refresh full cycle, OTP, M2M).

### 5.2 E2E test coverage — REBUILT (May–June 2026)
- **Measure the fleet, don't quote it** (the "38 specs, 00..50" figure here was stale in three docs at
  once). From `e2e-playwright/`, with `export PATH="/usr/local/opt/node@20/bin:$PATH"`:
  ```bash
  git ls-files 'tests/*.spec.ts' | wc -l    # tracked, numbered specs
  ls tests/*.spec.ts | wc -l                # on disk, incl. untracked scratch
  npx playwright test --project=chromium tests/NN_*.spec.ts
  ```
  ⚠️ **Never run bare.** `playwright.config.ts` sets only `testDir: './tests'` — no `testIgnore` — so
  a bare `npx playwright test` / `yarn test:nas` also collects every untracked `tests/_*.spec.ts`
  scratch file and writes to the **live NAS**. Always pass explicit paths.
- **Replaced** the 68-spec Cypress 14 suite, which was structurally incapable of catching API failures (only 3% asserted HTTP status codes; pattern of weakening tests rather than fixing them — see `documentation/E2E_TESTING.md` § "Why Playwright?").
- **Coverage:** signin; expense edit; unit occupancy; tenant/property/building/rent search-filter catalog (specs 25-29); property energy cert; rent tile dimming; dashboard finance; repair past-term guard; lease URL :id authoritative; last-admin guard; tenantapi auth chain; validators; payment matrices (15-17); lifecycle UI scenarios (19); round-1 option catalogs (40-46); boundary/concurrency (47); building-domain money (48 expense panel, 49 vacant-owner money, 50 owner-expenses paid/unpaid tile).
- **Roadmap:** the fleet has passed the ~50-spec threshold the doc once gated CI integration on; CI integration still deferred (would need a self-hosted runner with LAN access to NAS). Page-Object extraction remains a candidate refactor.

### 5.3 API documentation — NOT STARTED
- **Tool:** OpenAPI/Swagger

### 5.4 Finch support in CLI — ✅ COMPLETE (Mar 2026, `a6f8cf92`)
`findCRI()` in `cli/src/utils.js` falls through to `['finch', 'compose']` when finch is on PATH (after docker-compose / docker / podman-compose / podman).

### 5.5 `destructUrl()` should preserve the port — ✅ COMPLETE (May 2026, `59e37bda`)
`services/common/src/utils/url.ts` now returns `domain = url.host` (includes the port) and appends `:${url.port}` in the subdomain branch. `services/gateway/src/index.ts:configureCORS()` additionally builds the CORS origin from `new URL(DOMAIN_URL).host` directly. `APP_DOMAIN=host:port` remains as the explicit multi-origin allowlist (LAN + Tailscale), not a workaround for a bug.

---

## What is actually still open

The old "Implementation Order" diagram was a wall of ✅ with two items at the end; it made the
document look like a completion record instead of a work list. The open items, all of them:

- 🔴 **4.8 Security — REOPENED.** A live sms-gate.app credential is still public and rotation is not
  authorized. No secret scanning in CI. See §4.8 above and `documentation/PII_INCIDENT_2026_08.md`.
- **4.3 Event/Webhook system** — not started.
- **4.4 Payment gateway integration** — not started.
- **4.5 Bill OCR, Slice 3** (ΕΥΔΑΠ/ΕΠΑ providers) — the sample bills exist on disk; see
  `documentation/BILL_OCR_INBOX_PLAN.md` §16.
- **4.10** — real multi-document Mongo transactions (needs a replica set on the deployed single-node).
- **3.1** — locale arrays still duplicated across ~15 files.
- **5.1** — auth-flow unit tests (JWT refresh full cycle, OTP, M2M).
- **5.2** — E2E in CI (needs a self-hosted runner with LAN access to the NAS); Page-Object extraction.
- **5.3 API documentation (OpenAPI/Swagger)** — not started.
- **4.12** — accounting CSV export of notes.
