---
inclusion: always
---
# MRE Hardening & Extensibility Roadmap

This document lists all changes needed to make the codebase ready for major
feature work (Building entity, κοινόχρηστα, online payments, webhooks,
third-party document ingestion/OCR, etc.).

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
- 200+ integration tests verified 0 regressions

### Additional fixes during migration
- `.trim()` null safety on all auth validation
- Property name validation added
- VAT computed on tenant creation (was missing vatRate in Contract.create)
- Email whitespace trimmed before login
- Tenant middleware locale crash fixed (try/catch)
- Locale cookie for sign-in page language persistence
- Finch CLI support added

### 3.4 Remove MobX from landlord frontend ✅
- All 12 MobX stores resolved: 9 deleted, 3 converted to plain classes
- `mobx` and `mobx-react-lite` removed from package.json
- All data fetching migrated to `@tanstack/react-query`
- Organization, User, AppHistory remain as plain class contexts (no MobX)
- All 22 forms on react-hook-form + zod
- Material UI v4 fully removed
- 100 E2E tests passing, 48 unit tests passing

### Additional fixes during migration
- `.trim()` null safety on all auth validation
- Property name validation added
- VAT computed on tenant creation (was missing vatRate in Contract.create)
- Email whitespace trimmed before login
- Tenant middleware locale crash fixed (try/catch)
- Locale cookie for sign-in page language persistence
- Finch CLI support added

---

## Phase 4 — Architecture Extensions (enables new features)

### 4.1 Building entity
- **New collection:** `Building`
  ```
  Building {
    _id, realmId, name, address,
    floors: number,
    totalUnits: number,
    properties: [propertyId],  // links to existing Property collection
    metadata: {}               // extensible
  }
  ```
- **Property changes:** Add `buildingId`, `floor`, `millesimes` (χιλιοστά) fields
- **API:** CRUD routes for buildings under `/api/v2/buildings`
- **UI:** Building management page, property-to-building assignment

### 4.2 Building Services (plugin model for κοινόχρηστα etc.)
- **New collection:** `BuildingService`
  ```
  BuildingService {
    _id, realmId, buildingId,
    type: string,              // 'shared-expenses', 'heating', 'elevator', etc.
    name: string,
    allocationMethod: string,  // 'equal', 'millesimes', 'floor', 'consumption', 'custom'
    participatingProperties: [{
      propertyId, weight: number  // allocation weight
    }],
    active: boolean
  }
  ```
- **New collection:** `BuildingExpense`
  ```
  BuildingExpense {
    _id, realmId, buildingId, serviceId,
    term: number,              // YYYYMMDDHH format (like rents)
    totalAmount: number,
    description: string,
    allocations: [{            // computed per property
      propertyId, amount: number
    }]
  }
  ```
- **Rent pipeline integration:** New step between step 1 (base) and step 2 (debts)
  that adds building expense allocations to the rent

### 4.3 Event/Webhook system
- **Purpose:** Receive notifications from external services (payment gateways,
  third-party systems, OCR services)
- **New collection:** `Webhook`
  ```
  Webhook {
    _id, realmId,
    event: string,             // 'payment.completed', 'document.processed', etc.
    source: string,            // 'stripe', 'viva', 'ocr-service', etc.
    payload: {},
    status: string,            // 'pending', 'processed', 'failed'
    receivedDate: Date,
    processedDate: Date
  }
  ```
- **New service or route:** Webhook receiver endpoint (authenticated via HMAC or
  shared secret per source)
- **Processing:** Queue-based or simple polling — process webhooks and update
  relevant records (mark rent as paid, import lease data, etc.)

### 4.4 Payment gateway integration
- **Purpose:** Online rent payments (Stripe, Viva Wallet, etc.)
- **New collection:** `Payment`
  ```
  Payment {
    _id, realmId, tenantId,
    term: number,
    amount: number,
    method: string,            // 'stripe', 'viva', 'bank-transfer', 'cash', etc.
    externalId: string,        // payment gateway transaction ID
    status: string,            // 'pending', 'completed', 'failed', 'refunded'
    metadata: {},
    createdDate: Date,
    completedDate: Date
  }
  ```
- **Flow:** Tenant portal → initiate payment → redirect to gateway → webhook
  confirms → rent marked as paid
- **Rent pipeline:** Step 6 (payments) reads from both settlements AND Payment collection

### 4.5 Document ingestion / OCR
- **Purpose:** Import lease documents from third parties (PDF → OCR → structured data)
- **Flow:** Upload PDF → send to OCR service (external) → receive webhook with
  extracted data → create/update lease record
- **Depends on:** Webhook system (4.3)
- **New API routes:** Document upload endpoint, OCR status tracking
- **UI:** Upload interface with progress, review/confirm extracted data before saving

---

## Phase 5 — Quality & Operations

### 5.1 Unit tests for critical paths
- **Priority areas:**
  - Rent computation pipeline (7 steps) — most complex business logic
  - Auth flows (JWT refresh, OTP, M2M)
  - Building expense allocation calculations
- **Framework:** Jest (already in common package.json)

### 5.2 API documentation
- **Tool:** OpenAPI/Swagger
- **Purpose:** Document all REST endpoints for third-party integrations and
  future mobile app development

### 5.3 Finch support in CLI
- **Problem:** CLI's `findCRI()` only detects docker/docker-compose/podman
- **Change:** Add finch detection to `cli/src/utils.js`

---

## Implementation Order

For any new feature, follow this dependency chain:

```
Phase 1 (fixes) → Phase 2 (integrity) → Phase 3 (consistency)
    ↓
Phase 4.1 (Building) → Phase 4.2 (Services/κοινόχρηστα)
    ↓
Phase 4.3 (Webhooks) → Phase 4.4 (Payments) + Phase 4.5 (OCR)
    ↓
Phase 5 (quality) — ongoing, in parallel with Phase 4
```

Phase 1-2 can be done in a single session. Phase 3 is incremental.
Phase 4 items are independent features but share the Building foundation.
