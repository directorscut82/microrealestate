---
inclusion: always
---
# MRE Hardening & Extensibility Roadmap

This document lists all changes needed to make the codebase ready for major
feature work (online payments, webhooks, third-party document ingestion/OCR, etc.).

Changes are grouped into phases. Each phase should be completed before the next.

---

## Phase 1 — Critical Fixes ✅ COMPLETED

### 1.1 Fix ServiceError bug ✅
### 1.2 Disable RESTORE_DB in base.env ✅
### 1.3 Add MongoDB indexes ✅

---

## Phase 2 — Data Integrity ✅ COMPLETED

### 2.1 Referential integrity guards ✅
- Property deletion blocked when tenants reference it (422)
- Lease deletion error message fixed
- Nonexistent tenant/property now return 404 (was 500)
- Tenant deletion blocked when has payments, active lease, or unpaid balance (422)
- Realm deletion blocked when child records exist (422 with counts)

### 2.2 Redis TTL alignment ✅
- Access tokens: 5min (was 30s)
- Refresh tokens: 600s prod / 12h dev
- OTP codes: 5min
- Session tokens: 30min prod / 12h dev
- Reset tokens: 1h

---

## Phase 3 — Codebase Consistency ✅ COMPLETED

### 3.1 Centralize locale configuration
- **Status:** Deferred — functional but locale arrays duplicated across 15 files

### 3.2 Standardize frontend patterns ✅
- Created `.kiro/steering/frontend-patterns.md`

### 3.3 Migrate JS services to TypeScript ✅
- All 4 services migrated: authenticator (4), pdfgenerator (11), emailer (23), api (20)
- 58 files converted, 0 compilation errors

### 3.4 Remove MobX from landlord frontend ✅
- All 12 MobX stores resolved: 9 deleted, 3 converted to plain classes
- `mobx` and `mobx-react-lite` removed from package.json
- All data fetching migrated to `@tanstack/react-query`
- All 22 forms on react-hook-form + zod
- Material UI v4 fully removed

---

## Phase 4 — Architecture Extensions ✅ MOSTLY COMPLETE

### 4.1 Building entity ✅ COMPLETE
- **Collection:** `Building` — comprehensive Greek polykatoikia model
  - Top level: name, address, atakPrefix, blockNumber, totalFloors, heatingType, manager, bankInfo
  - Sub-documents: units[], expenses[], contractors[], repairs[], ownerMonthlyExpenses[]
- **Unit model:** atakNumber, floor, surface, thousandths (general/heating/elevator), owners[], occupancyType, propertyId link, monthlyCharges[]
- **Expense model:** name, type (11 types), amount, allocationMethod (8 methods), customAllocations[], isRecurring, billingId, trackOwnerExpense
- **Contractor model:** name, company, specialty (8 types), contact info
- **Repair model:** title, category, status, urgency, cost, contractor link, affected units, chargeable allocation
- **API:** Full CRUD at `/api/v2/buildings` with sub-resource routes for units, expenses, contractors, repairs
- **UI:** Building management page with tabs (units, expenses, contractors, repairs)

### 4.2 Building Services (κοινόχρηστα) ✅ COMPLETE
- Monthly statement generation with expense allocation per unit
- Owner expense tracking per building expense with monthly amounts
- 8 allocation methods: general/heating/elevator thousandths, equal, by_surface, fixed, custom_ratio, custom_percentage
- Variable vs recurring expense distinction with Ναι(κυμαινόμενο) badge
- Expense history panel with month picker and allocation tooltips
- Safe expense deletion dialog with soft/hard delete and impact warning
- Retroactive rent recalculation on expense changes

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
- API routes: `POST /api/v2/bills/parse`, `POST /api/v2/bills/confirm`
- Payment receipt import: `POST /api/v2/bills/parse-payment`, `POST /api/v2/bills/confirm-payment`
- Frontend: BillImportDialog, PaymentReceiptDialog
- 13 unit tests for PDF parser

### 4.6 SMS Gateway integration ✅ COMPLETE
- Uses Android SMS Gateway app (sms-gate.app) as bridge
- Config: Realm.thirdParties.smsGateway (url, username, password — encrypted)
- Sends SMS to all tenant contacts' phone numbers alongside email

### 4.7 Database Backup/Restore ✅ COMPLETE (added May 2026)
- Full MongoDB backup of all 10 collections to JSON (with type markers for ObjectId, Date, Binary)
- Restore with atomic wipe-and-replace per collection
- Triple-layer production protection (legacy Cypress era):
  1. resetservice `assertTestDatabase` guard (403 if connected to mredb)
  2. Cypress `before()` hook URL verification (no longer applicable — Cypress suite was removed in May 2026)
  3. Pre-test backup shell script
- **Current Playwright equivalent**: `e2e-playwright/backup-nas-before-tests.sh` runs `mongodump` via the Portainer exec API before every E2E run. Realm-scoping (CYPRESS-TEST-DO-NOT-USE) replaces the test-database guard since NAS doesn't deploy resetservice. See `documentation/E2E_TESTING.md`.
- 50MB body parser limit for large restores
- Settings UI panel with download/upload

### 4.8 Security Hardening ✅ COMPLETE (added April-May 2026)
- NoSQL injection prevention (express-mongo-sanitize)
- Input validation (percentage sums, enum/range checks, NaN guards)
- Rate limiting on auth endpoints
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
- Transaction atomicity for multi-document updates
- 20 unit tests for aggregation logic

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
- **Out of scope (deferred)**:
  - Wiring imported TAXIS PDF into "Uploaded documents" — Backblaze B2 storage required first. Document model only stores metadata pointers, not local file blobs.
  - SMS bulk-send actions on /rents — server-side `_sendSms` exists but no UI surface yet.
  - Accounting CSV export of notes — only the in-app accounting view shows them.

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

### 4.11 Multi-Origin Self-Hosted Deployment ✅ COMPLETE (added May 2026)
- **Purpose:** Serve the same landlord frontend simultaneously from LAN (`http://192.168.x.x:PORT`) and Tailscale IP (`http://100.x.x.x:PORT`) so family/staff can use the app over a shared Tailnet without DNS setup.
- **Code changes (applied on `nas` branch only):**
  1. `services/gateway/src/index.ts` — `configureCORS()` accepts comma-separated `APP_DOMAIN`, builds a CORS regex per origin.
  2. `services/authenticator/src/index.ts` — removed explicit cookie `domain` attribute so cookies become host-only and work across multiple hostnames.
  3. `webapps/landlord/src/utils/fetch.js` — `apiFetcher()` uses `window.location.origin` on the client instead of the build-time `GATEWAY_URL`, so the browser always talks to the same origin it loaded from.
- **Branch strategy:** `master` mirrors upstream for local dev. `nas` adds the 3 source changes above plus `.github/workflows/nas-ci.yml` which builds `:nas` + `:nas-<sha>` images to GHCR on every push.
- **Local-only files (gitignored, never pushed):** `docker-compose.nas.yml` (stack definition with inlined secrets), `.secrets/github-pat`, `.secrets/portainer-token`, `.env.nas-secrets`.
- **Deployment automation:** `scripts/deploy-nas.sh` (invoked via `yarn deploy:nas`) asks 2 questions upfront (wait for CI? redeploy stack?), merges master → nas, pushes, and triggers a Portainer stack redeploy using the local `.secrets/portainer-token`. `scripts/validate-nas-deploy.sh` runs 22 sanity checks on the local `docker-compose.nas.yml` before push.
- **Known limitation:** The deploy script does not sync from upstream (microrealestate/microrealestate). The fork's git history was rewritten during the initial authorship change, so `git merge upstream/main` fails with "refusing to merge unrelated histories". Use `git cherry-pick <sha>` manually to pull in specific upstream fixes.
- **Docs:** `documentation/DEV_AND_DEPLOY.md` (dev + deploy workflow, troubleshooting, historical gotchas).

---

## Phase 5 — Quality & Operations

### 5.1 Unit tests for critical paths — IN PROGRESS
- **Current state:** 14 suites, 319 tests (309 passing, 10 failing)
- **Covered:** Rent computation pipeline, building expense allocation, dashboard aggregation, PDF parsers, auth token refresh, payment double-submit, ErrorBoundary
- **Frontend tests:** 4 test files in webapps/landlord/src/__tests__/
- **Remaining:** Auth flows (JWT refresh full cycle, OTP, M2M)

### 5.2 E2E test coverage — REBUILT (May–June 2026)
- **Current state:** 17 Playwright specs (UI + API), `e2e-playwright/`, 17 passed + 1 fixme, ~17s against live NAS
- **Replaced** the 68-spec Cypress 14 suite, which was structurally incapable of catching API failures (only 3% asserted HTTP status codes; pattern of weakening tests rather than fixing them — see `documentation/E2E_TESTING.md` § "Why Playwright?").
- **Coverage so far:** signin, expense edit (bug 1), unit occupancy (bug 9), tenant phone search, property energy cert, rent tile dimming (bug 8), dashboard finance card (bug 10), repair past-term guard (bug 4), lease URL :id authoritative, last-admin guard, tenantapi auth chain, validators (capital/email/year).
- **Known fixme:** `tenantapi/tenant/me` body-shape test — needs OTP plumbing not currently reachable from NAS.
- **Roadmap:** ~20–30 more specs before Page-Object extraction. CI integration deferred until ≥50 specs (would need self-hosted runner with LAN access to NAS).

### 5.3 API documentation — NOT STARTED
- **Tool:** OpenAPI/Swagger

### 5.4 Finch support in CLI — NOT STARTED
- **Problem:** CLI's `findCRI()` only detects docker/docker-compose/podman

### 5.5 `destructUrl()` should preserve the port — NOT STARTED
- **Problem:** `services/common/src/utils/url.ts:destructUrl()` returns `domain = url.hostname` (port goes into a separate `port` field). Callers that build CORS regexes or domain strings — primarily `services/gateway/src/index.ts:configureCORS()` — silently drop the port, so `DOMAIN_URL=http://localhost:8080` produces an allowlist that rejects `http://localhost:8080`.
- **Workaround in place:** Set `APP_DOMAIN=localhost:8080` (or whatever `host:port`) in `.env`. `APP_DOMAIN` is used verbatim and is the documented escape hatch for any non-default port.
- **Proposed fix:** Make `destructUrl()` return `domain = url.host` (which includes the port) when a port is present, OR have `configureCORS()` build the regex from `host` not `domain`. ~5 lines, but touches shared utility code used by other services — verify no caller relies on port-less `domain` first.

---

## Implementation Order

```
Phase 1-3 ✅ → Phase 4.1-4.2 ✅ (Building + κοινόχρηστα)
                → Phase 4.5-4.6 ✅ (OCR + SMS)
                → Phase 4.7-4.10 ✅ (Backup, Security, Pagination, Performance)
                → Phase 4.11 ✅ (Multi-origin NAS deployment)
                → Phase 4.3 (Webhooks) → Phase 4.4 (Payments)
Phase 5 ongoing in parallel
```
