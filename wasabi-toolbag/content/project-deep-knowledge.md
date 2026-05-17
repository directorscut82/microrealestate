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

**Buildings** (κοινόχρηστα):
- `GET|POST /buildings`, `GET|PATCH|DELETE /buildings/:id`
- Sub-resources: `units`, `expenses`, `contractors`, `repairs`
- Monthly statement generation per building/month

**Bills** (utility bill imports — DEH etc.):
- `POST /bills/parse` — extract bill data from PDF (returns parsed payload)
- `POST /bills/confirm` — persist after user review, auto-match to building expense
- `POST /bills/parse-payment` / `POST /bills/confirm-payment` — payment receipt import

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

**Building** — `_id`, `realmId`, `name`, `address`, `atakPrefix`, `blockNumber`, `totalFloors`, `heatingType`, `manager`, `bankInfo`, sub-documents `units[]` (atakNumber, floor, surface, thousandths {general/heating/elevator}, owners, occupancyType, propertyId link, monthlyCharges), `expenses[]` (name, type, amount, allocationMethod, customAllocations, isRecurring, billingId), `contractors[]`, `repairs[]`, `ownerMonthlyExpenses[]`. CRUD at `/api/v2/buildings` with sub-resource routes for units, expenses, contractors, repairs.

**Bill** — `_id`, `realmId`, `buildingId`, `expenseId`, `provider` (DEH etc.), `totalAmount`, `term`, `status`, IRIS QR code + RF payment code fields. Imported via `POST /api/v2/bills/parse` → `POST /api/v2/bills/confirm`.

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

11. **`useMediaQuery` is SSR-unsafe by default:** Always pass `{ initializeWithValue: false }`. Without it, the hook reads `window.matchMedia` on the first render — server returns `false` (no window), client returns the real value, producing a hydration error like "Did not expect server HTML to contain a `<div>` in `<div>`". With the option set, both server and client return the default on first render and the client updates after mount via `useEffect`.

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

## Current State (2026-05)

### Completed Migrations
- ✅ MUI v4 → shadcn/ui + Tailwind (zero @material-ui imports)
- ✅ Formik + Yup → react-hook-form + zod (all 22 forms)
- ✅ MobX → React Query (all 12 stores resolved, MobX removed)
- ✅ All backend services migrated to TypeScript (58 files, 0 errors)
- ✅ Store reactivity: subscribe/notify + useSyncExternalStore

### Major Features Shipped
- Greek AADE lease PDF import (parser + API + frontend dialog, 13 unit tests)
- Greek DEH utility-bill PDF import + IRIS QR code generation (`Bill` collection)
- SMS Gateway integration (via Android sms-gate.app cloud API)
- Building entity (`Building` collection) with units, expenses, contractors, repairs, plus κοινόχρηστα monthly statement generation and 8 expense allocation methods
- Database backup/restore in Settings UI with triple-layer production protection (`assertTestDatabase` guard in resetservice, Cypress before-hook URL check, pre-test backup script)
- Server-side pagination on tenant/property/lease lists (`useInfiniteQuery` Load More pattern)
- Dashboard performance: MongoDB aggregation pipeline replacing full-array loads
- Presence awareness (Redis-backed, 30s polling)
- Tenant archive (archive instead of delete, toggle visibility)
- Extended property fields (ATAK, DEH, energy certificate, land surface)
- Extended tenant fields (co-tenants, declaration, amendment, lease notes)
- Delete tenant safety checks + options dialog
- Resetservice seed + OTP APIs
- Frontend hardening: ErrorBoundary, token refresh queue fix, payment double-submit prevention, auth header leak fix
- Multi-origin self-hosted deployment (NAS): same landlord frontend served from LAN IP and Tailscale IP simultaneously, applied on the `nas` branch only

### Test Coverage
- Unit: 14 suites, 319 tests in `services/api` (309 passing, 10 failing as of May 2026); 4 frontend test files in `webapps/landlord/src/__tests__/`
- E2E: 67 Cypress suites, 583 tests, ~523-551 pass per run depending on `selectByLabel` non-determinism

### Known Non-deterministic Failures
`selectByLabel` Cypress command occasionally fails when Radix Select opens before React Query data loads. Retry logic (5 attempts) mitigates but doesn't eliminate. Affects suites 20, 22, 25, 27, 28.

### Known Limitations
- Seed API bypasses rent pipeline — use `seedAndComputeRents` command
- Seeded tenants don't have `usedByTenants` flag computed
- Payment form requires date field (validates but won't submit without it)
- Tenant portal suite 59 has pre-existing React hydration error (#418, separate from the landlord SSR fix shipped May 2026)
- `next-translate-plugin` shows non-fatal "Debug Failure" warning during build
- Lint debt: `@typescript-eslint/no-explicit-any` and `sort-imports` are temporarily disabled across several services. Tracked in `documentation/LINT_DEBT.md` with concrete fix plan; must be paid down before new feature work merges.

### Upstream Sync — Not Automated
The fork's git history was rewritten (authorship change), so `git merge upstream/main` fails with "refusing to merge unrelated histories". To pull in specific upstream fixes, use `git cherry-pick <sha>` manually. Documented in `documentation/DEV_AND_DEPLOY.md`.

---

## Roadmap

### Completed Phases
- **Phase 1** — Critical fixes (ServiceError, RESTORE_DB, MongoDB indexes) ✅
- **Phase 2** — Data integrity (referential guards, Redis TTL alignment) ✅
- **Phase 3** — Codebase consistency (TS migration, MobX removal, frontend patterns) ✅

### Phase 4 — Architecture Extensions
- **4.1 Building entity** ✅ — `Building` collection with units, expenses, contractors, repairs
- **4.2 Building Services** ✅ — κοινόχρηστα with 8 allocation methods, monthly statements, retroactive rent recalc
- **4.3 Webhooks** — NOT STARTED (event system for external integrations: payments, OCR)
- **4.4 Payment gateway** — NOT STARTED (online rent payments: Stripe, Viva Wallet)
- **4.5 Document ingestion/OCR** ✅ — Greek AADE lease + DEH bill imports, IRIS QR codes
- **4.6 SMS Gateway** ✅ — Android sms-gate.app integration
- **4.7 Database Backup/Restore** ✅ — Full backup with triple-layer production protection
- **4.8 Security Hardening** ✅ — express-mongo-sanitize, validation, rate limiting, race fixes
- **4.9 Server-Side Pagination** ✅ — `page`/`limit` query params, `useInfiniteQuery` Load More
- **4.10 Dashboard Performance** ✅ — MongoDB aggregation pipeline, transaction atomicity
- **4.11 Multi-Origin NAS Deployment** ✅ — `nas` branch, Portainer stack, comma-separated `APP_DOMAIN`, host-only cookies, `window.location.origin` on the client

### Phase 5 — Quality & Operations
- **5.1 Unit tests** — IN PROGRESS (14 suites, 319 tests)
- **5.2 E2E coverage** — EXTENSIVE (67 suites, 583 tests)
- **5.3 API documentation (OpenAPI/Swagger)** — NOT STARTED
- **5.4 Finch support in CLI** — NOT STARTED (CLI's `findCRI()` only detects docker/docker-compose/podman)

### Implementation Order
```
Phase 1-3 ✅ → 4.1-4.2 ✅ → 4.5-4.6 ✅ → 4.7-4.10 ✅ → 4.11 ✅
                → 4.3 (Webhooks) → 4.4 (Payments)
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

**Disk reclaim:** Finch's VM uses a 50 GB raw disk image at `~/.finch/.disks/` that doesn't auto-shrink. Run periodically:
```bash
finch system prune -a -f && finch volume prune -a -f
export LIMA_HOME=/Applications/Finch/lima/data
/Applications/Finch/lima/bin/limactl shell finch sudo fstrim -v /mnt/lima-finch
```
See `documentation/FINCH_SETUP.md`.

---

## NAS Deployment (`nas` branch)

Two-branch model:
- `master` — local dev, source code mirrors upstream.
- `nas` — production layer with 3 source modifications for multi-origin support and `.github/workflows/nas-ci.yml` building `:nas` + `:nas-<sha>` images to GHCR.

The 3 nas-only source changes:
1. `services/gateway/src/index.ts` — `configureCORS()` accepts comma-separated `APP_DOMAIN` and builds a CORS regex per origin.
2. `services/authenticator/src/index.ts` — removed cookie `domain` attribute (cookies become host-only, work on multiple hostnames).
3. `webapps/landlord/src/utils/fetch.js` — `apiFetcher()` uses `window.location.origin` on the client instead of build-time `GATEWAY_URL`, so the browser always calls back to the origin that served the page.

`docker-compose.nas.yml` and `.secrets/{github-pat,portainer-token}` are local-only (gitignored). Deploy with `yarn deploy:nas`. See `documentation/DEV_AND_DEPLOY.md` for full workflow + troubleshooting.

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
