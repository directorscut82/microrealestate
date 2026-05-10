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
- Triple-layer production protection:
  1. resetservice `assertTestDatabase` guard (403 if connected to mredb)
  2. Cypress `before()` hook URL verification
  3. Pre-test backup shell script
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

---

## Phase 5 — Quality & Operations

### 5.1 Unit tests for critical paths — IN PROGRESS
- **Current state:** 14 suites, 319 tests (309 passing, 10 failing)
- **Covered:** Rent computation pipeline, building expense allocation, dashboard aggregation, PDF parsers, auth token refresh, payment double-submit, ErrorBoundary
- **Frontend tests:** 4 test files in webapps/landlord/src/__tests__/
- **Remaining:** Auth flows (JWT refresh full cycle, OTP, M2M)

### 5.2 E2E test coverage — EXTENSIVE
- **Current state:** 67 suites, 583 tests (~523-551 pass per run)
- **Known non-deterministic:** selectByLabel timing in suites 20, 22, 25, 27, 28
- **Known pre-existing:** React hydration error in suite 59

### 5.3 API documentation — NOT STARTED
- **Tool:** OpenAPI/Swagger

### 5.4 Finch support in CLI — NOT STARTED
- **Problem:** CLI's `findCRI()` only detects docker/docker-compose/podman

---

## Implementation Order

```
Phase 1-3 ✅ → Phase 4.1-4.2 ✅ (Building + κοινόχρηστα)
                → Phase 4.5-4.6 ✅ (OCR + SMS)
                → Phase 4.7-4.10 ✅ (Backup, Security, Pagination, Performance)
                → Phase 4.3 (Webhooks) → Phase 4.4 (Payments)
Phase 5 ongoing in parallel
```
