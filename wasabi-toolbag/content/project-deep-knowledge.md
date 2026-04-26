# MicroRealEstate — Deep Project Knowledge

> **Purpose:** Critical working knowledge for writing correct code. Complements `workspace-summary.md` (structure, tech stack, build, style, testing basics). This file covers API routes, data models, architecture patterns, gotchas, frontend conventions, current state, and roadmap.

---

## Service Topology & Gateway Routing

```
Caddy (HTTPS) → Gateway :8080 → backend services
```

Gateway routes (first match wins):
1. `/api/v2/authenticator/*` → Authenticator :8000
2. `/api/v2/documents/*`, `/api/v2/templates/*` → PDFGenerator :8300
3. `/api/v2/*` → API :8200 (landlord, catch-all)
4. `/tenantapi/*` → TenantAPI :8250
5. `/api/reset/*` → ResetService :8900 (non-prod only)
6. `/landlord/*` → Landlord Frontend :8180
7. `/tenant/*` → Tenant Frontend :8190

Inter-service communication: HTTP over Docker bridge network (`net`).
- API → Emailer (send emails/SMS), API → PDFGenerator (generate documents)
- Authenticator → Emailer (password reset emails)

---

## API Reference

### Landlord API (`:8200`, prefix `/api/v2/`)
Requires `Authorization: Bearer {accessToken}` + `organizationId` header.

**Tenants** (Mongoose model: `Occupant`):
- `GET /tenants` — list all for realm
- `GET /tenants/:id` — get by ID
- `POST /tenants` — create (triggers rent computation)
- `POST /tenants/import-pdf` — import from Greek AADE lease PDF (multipart/form-data)
- `PATCH /tenants/:id` — update (triggers rent recomputation)
- `DELETE /tenants/:id` — delete (422 if has payments, active lease, or unpaid balance)

**Properties:**
- `GET|POST /properties`, `GET|PATCH|DELETE /properties/:id`
- DELETE returns 422 if occupied by tenant

**Leases:**
- `GET|POST /leases`, `GET|PATCH|DELETE /leases/:id`
- DELETE returns 422 if used by tenants

**Rents:**
- `GET /rents/:year` — rents for year
- `GET /rents/:tenantId/:term` — specific rent
- `PATCH /rents/payment/:id/:term` — record payment

**Documents & Templates** (proxied to PDFGenerator):
- `GET /documents/:id`, `POST /documents`
- `GET|POST /templates`

**Organizations:**
- `GET /realms`, `GET|PATCH /realms/:id`
- `POST /realms/:id/members`, `DELETE /realms/:id/members/:memberId`

**Presence** (Redis 60s TTL):
- `POST|GET /presence/:type/:id`

**Accounting:**
- `GET /accounting/:year`

### Authenticator API (`:8000`)
- `POST /signin` — email/password login
- `POST /signup` — register
- `POST /signout` — invalidate refresh token
- `POST /forgotpassword`, `POST /resetpassword`
- `POST /refreshtoken` — new access token

### Tenant API (`:8250`, auth via `sessionToken` cookie)
- `POST /signin` — OTP-based sign-in
- `GET /tenants`, `GET /rents`, `GET /documents`

### Reset Service API (`:8900`, non-prod only)
- `DELETE /` — wipe database
- `POST /seed` — create user + org + leases + properties + tenants
- `POST /otp` — generate tenant OTP directly

---

## Data Models

### Collections (in `services/common/src/collections/`)

**Account** — `_id`, `firstname`, `lastname`, `email` (unique), `password` (bcrypt hash)

**Realm** (Organization) — `_id`, `name`, `isCompany`, `locale`, `currency`, `members[]` (name, email, role, registered), `addresses`, `bankInfo`, `thirdParties` (gmail, smtp, mailgun, b2, smsGateway)

**Tenant** (⚠️ Mongoose model name: `'Occupant'`) — `_id`, `realmId`, `name`, `firstName`, `lastName`, `taxId`, `leaseId`, `beginDate`, `endDate`, `isCompany`, `contacts[]`, `properties[]` (propertyId), `rents[]`, `coTenants[]`, `declarationNumber`, `amendsDeclaration`, `originalLeaseStartDate`, `leaseNotes`

**Property** — `_id`, `realmId`, `type`, `name`, `description`, `surface`, `landSurface`, `phone`, `building`, `level`, `location` (lat/lng), `price`, `expense` (title, amount), `tax`, `atakNumber`, `dehNumber`, `energyCertificate` (number, issueDate, energyClass, inspectorNumber)

**Lease** — `_id`, `realmId`, `name`, `numberOfTerms`, `timeRange` (months/weeks/days/years), `active`, `system`, `templateIds[]`, `expenses[]`

**Template** — `_id`, `realmId`, `name`, `type` (text/fileDescriptor), `description`, `hasExpiryDate`, `required`, `contents` (html/css), `linkedResourceIds[]`

**Document** — `_id`, `realmId`, `tenantId`, `templateId`, `type`, `name`, `description`, `mimeType`, `expiryDate`, `url`, `versionId`

**Email** — `_id`, `templateName`, `sentTo`, `sentDate`, `status`, `params`

### Critical Data Notes
- All data scoped by `realmId` — `checkOrganization` middleware resolves from `organizationId` header
- Rent terms use `YYYYMMDDHH` format (e.g., `2026040100` for April 2026)
- Rent history embedded in `tenant.rents[]` — NOT a separate collection
- Each rent entry: `term`, `grandTotal`, `payment`, `balance`, `description`, `preTaxAmounts`, `charges`, `vats`, `discounts`, `debts`, `settlements`

### Rent Computation Pipeline (7 steps, `services/api/src/businesslogic/`)
1. **Base rent** — from `Property.price`
2. **Debts** — unpaid balances from previous terms
3. **Expenses/charges** — from `Lease.expenses` and `Property.expense`
4. **Discounts** — applied reductions
5. **VAT** — tax computation
6. **Settlements** — payments recorded against the term
7. **Grand total** — final amount due

Triggered on tenant create or update (PATCH). Types in `types/src/common/collections.ts` as `CollectionTypes` namespace.

---

## Authentication Architecture

| Token | Lifetime | Storage |
|---|---|---|
| Access token | ~5 min | Client memory / Authorization header |
| Refresh token | 600s prod / 12h dev | Redis |
| OTP code | 5 min | Redis |
| Session token | 30min prod / 12h dev | Cookie |
| Reset token | 1h | Redis |

**Middleware chain:** `needAccessToken` → `checkOrganization` → role checks
**Principal types:** `user`, `application`, `service`
**Roles:** `administrator`, `renter`, `tenant`
**Landlord API:** Bearer token header | **Tenant API:** `sessionToken` cookie

---

## Service Bootstrap Pattern

All backend services use the shared `Service` singleton from `@microrealestate/common`:

```ts
const service = Service.getInstance(new EnvironmentConfig({ /* env vars */ }));
await service.init({
  name: 'ServiceName',
  useMongo: true, useRedis: true, useAxios: true,
  onStartUp: async (expressApp) => { /* register routes */ },
  onShutDown: async () => { /* cleanup */ }
});
await service.startUp();
```

Handles: Express setup, MongoDB/Redis connections, request parsing, logging middleware, `/health` endpoint, graceful shutdown.

---

## Frontend Patterns & Gotchas

### Landlord App (Next.js 14 Pages Router, JavaScript)

**State management:**
- Server state → `@tanstack/react-query` v5.29 (`useQuery`, `useMutation`)
- Auth/session → plain class stores (Organization, User, AppHistory) with `subscribe()`/`notify()` + `useSyncExternalStore`
- Forms → `react-hook-form` + `zod` + `zodResolver` (all 22 forms)
- UI → shadcn/ui (`src/components/ui/`) + Tailwind CSS
- API calls → `apiFetcher()` from `src/utils/fetch.js` (axios with token refresh)

**Key directories:**
- `src/pages/[organization]/` — org-scoped routes
- `src/components/<feature>/` — feature components, `src/components/ui/` — shadcn primitives
- `src/hooks/` — React Query hooks
- `src/store/` — auth/session store classes
- `src/utils/restcalls.js` — all API functions, `src/utils/fetch.js` — axios interceptor

**DO NOT USE:** `@material-ui/*`, Formik, Yup, MobX, `makeStyles()`, `observer()`

### ⚠️ Critical Gotchas

1. **Store reactivity:** Store classes use `subscribe(listener)` / `notify()`. `InjectStoreContext` uses `useSyncExternalStore`. Context value is new object each version: `{ user, organization, appHistory }`.

2. **`withAuthentication` reads from singleton:** Uses `getStoreInstance()` directly, NOT `useContext(StoreContext)` — avoids race condition after page reload.

3. **`useFillStore` also reads from singleton:** Same reason as above.

4. **SSR redirects:** `index.js` uses `getServerSideProps` redirects, NOT client-side `router.push()` (would crash during SSR).

5. **Dialog navigation must pass locale:** `NewPropertyDialog`, `NewTenantDialog`, `NewLeaseDialog` all pass `{ locale: store.organization.selected?.locale }` to `router.push()`.

6. **`LandlordForm` firstAccess mode:** Form fields are flat (`company`, `ein`) but API expects nested `companyInfo: { name, ein, ... }`.

7. **Stepper renders ALL future steps' children:** `[data-cy=submit]` finds multiple buttons. Use `.filter(':visible').first()` or scope to active step.

8. **Dashboard has two modes:** First-connection wizard (no leases/properties/tenants) and normal (shortcut bar). `isFirstConnection` checks for empty data.

9. **Tenant/Occupant naming:** Mongoose model registered as `'Occupant'` but TypeScript/API uses `Tenant`. Use `Occupant` for direct MongoDB queries.

10. **Presence awareness:** `POST/GET /api/v2/presence/:type/:id`, Redis 60s TTL, frontend `usePresence` hook polls every 30s, `PresenceBanner` component on detail pages.

### Referential Integrity (enforced)
- DELETE property → 422 if occupied by tenant
- DELETE lease → 422 if used by tenants
- DELETE tenant → 422 if has recorded payments, active lease, or unpaid balance

### Tenant App (Next.js 14 App Router, TypeScript)
- `src/app/[lang]/` for locale-based routing
- React Server Components for data fetching
- `src/middleware.ts` handles locale detection
- OTP-based sign-in, `sessionToken` cookie auth
- react-hook-form + zod, shadcn/ui + Tailwind

### New Page Template
```
src/pages/[organization]/newfeature.js    # Page
src/components/newfeature/Component.js     # Feature components
src/hooks/useNewFeature.js                 # React Query hooks
```

---

## Current State (2026-04-22)

### Completed Migrations
- ✅ MUI v4 → shadcn/ui + Tailwind (zero @material-ui imports)
- ✅ Formik + Yup → react-hook-form + zod (all 22 forms)
- ✅ MobX → React Query (all 12 stores resolved, MobX removed)
- ✅ All backend services migrated to TypeScript (58 files, 0 errors)
- ✅ Store reactivity: subscribe/notify + useSyncExternalStore

### Features Built on Feature Branch
- Greek AADE lease PDF import (parser + API + frontend dialog, 13 unit tests)
- SMS Gateway integration (via Android sms-gate.app cloud API)
- Presence awareness (Redis-backed, 30s polling)
- Tenant archive (archive instead of delete, toggle visibility)
- Extended property fields (ATAK, DEH, energy certificate, land surface)
- Extended tenant fields (co-tenants, declaration, amendment, lease notes)
- Delete tenant safety checks + options dialog
- Separate SMS button on Rents page
- Resetservice seed + OTP APIs
- 15 app code bugs fixed

### Test Coverage: 583 tests across 59 suites
- Unit: 61 passing (4 suites)
- E2E 01-17: 157 tests ✅
- E2E 20-28: 158 tests (2-5 non-deterministic failures per run)
- E2E 30-42: 129 tests ✅
- E2E 50-57: 61 tests ✅
- E2E 58-62: 43 tests (suite 59 has pre-existing React hydration error)
- E2E 63-70: 36 tests ✅
- Full run: ~523-551 out of 583 pass

### Known Non-deterministic Failures
`selectByLabel` Cypress command occasionally fails when Radix Select opens before React Query data loads. Retry logic (5 attempts) mitigates but doesn't eliminate. Affects suites 20, 22, 25, 27, 28.

### Known Limitations
- Seed API bypasses rent pipeline — use `seedAndComputeRents` command
- Seeded tenants don't have `usedByTenants` flag computed
- Payment form requires date field (validates but won't submit without it)
- Tenant portal has pre-existing React hydration error (#418)
- `next-translate-plugin` shows non-fatal "Debug Failure" warning during build

---

## Roadmap

### Completed Phases
- **Phase 1** — Critical fixes (ServiceError, RESTORE_DB, MongoDB indexes) ✅
- **Phase 2** — Data integrity (referential guards, Redis TTL alignment) ✅
- **Phase 3** — Codebase consistency (TS migration, MobX removal, frontend patterns) ✅

### Phase 4 — Architecture Extensions (in progress)
- **4.1 Building entity** — new collection, property links, CRUD API, UI
- **4.2 Building Services** — κοινόχρηστα, shared expenses, allocation methods, rent pipeline integration
- **4.3 Webhooks** — event system for external integrations (payments, OCR)
- **4.4 Payment gateway** — online rent payments (Stripe, Viva Wallet)
- **4.5 Document ingestion/OCR** — ✅ Greek PDF import done; remaining: other doc types, batch import
- **4.6 SMS Gateway** — ✅ Complete

### Phase 5 — Quality & Operations
- Unit tests for rent computation, auth flows, building expense allocation
- OpenAPI/Swagger documentation
- Finch support in CLI

### Implementation Order
```
Phase 1-3 ✅ → 4.1 (Building) → 4.2 (Services/κοινόχρηστα)
                → 4.3 (Webhooks) → 4.4 (Payments) + 4.5 (OCR)
Phase 5 ongoing in parallel
```

---

## Container Runtime

Local development uses **Finch** (not Docker). All compose commands use `finch compose`.

```bash
# Start dev mode
finch compose -f docker-compose.microservices.base.yml -f docker-compose.microservices.dev.yml up -d

# Verify (11 containers must be "Up")
finch ps -a --format '{{.Names}} {{.Status}}'

# Smoke test
curl -s http://localhost:8080/landlord/signin | head -1

# Stop
finch compose -f docker-compose.microservices.base.yml -f docker-compose.microservices.dev.yml down
```

**Critical .env requirements:**
- `API_URL=http://api:8200/api/v2` (gateway crashes without it)
- `MONGO_URL=mongodb://mongo/mredb` (NOT `demodb`)

---

## Error Handling Pattern

```ts
import { ServiceError, Middlewares } from '@microrealestate/common';

// Throw typed HTTP errors
throw new ServiceError('Not found', 404);
throw new ServiceError('Property is occupied', 422);

// Wrap async route handlers
router.get('/resource', Middlewares.asyncWrapper(async (req, res) => { ... }));

// Error middleware (registered last) returns { status, message } + stack in non-prod
```

---

## Key Entry Points for Code Navigation

| To understand... | Start at |
|---|---|
| Service bootstrap | `services/common/src/utils/service.ts` |
| API routes | `services/api/src/routes.ts` |
| Rent computation | `services/api/src/businesslogic/` (7 steps) |
| Auth middleware | `services/common/src/utils/middlewares.ts` |
| Gateway proxy | `services/gateway/src/index.ts` |
| Landlord pages | `webapps/landlord/src/pages/[organization]/` |
| Store/auth context | `webapps/landlord/src/store/` |
| API call layer | `webapps/landlord/src/utils/restcalls.js` |
| Axios interceptor | `webapps/landlord/src/utils/fetch.js` |
| Mongoose models | `services/common/src/collections/` |
| TypeScript types | `types/src/common/collections.ts` |
