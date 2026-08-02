---
inclusion: always
---

# MRE — Architecture & Coding Patterns

## Microservices Architecture

The backend follows a microservices pattern where each service is an independent Express app running in its own Docker container. All services communicate over a Docker bridge network (`net`).

### Service Bootstrap Pattern

Every backend service follows the same initialization pattern using the shared `Service` class from `@microrealestate/common`:

```js
const service = Service.getInstance(new EnvironmentConfig({ /* env vars */ }));
await service.init({
  name: 'ServiceName',
  useMongo: true,      // optional: connect to MongoDB
  useRedis: true,      // optional: connect to Redis
  useAxios: true,      // optional: configure axios interceptors
  onStartUp,           // async (expressApp) => { /* register routes */ }
  onShutDown            // async () => { /* cleanup */ }
});
await service.startUp();
```

The `Service` class is a singleton that handles Express setup, MongoDB/Redis connections, request parsing, logging middleware, health checks, and graceful shutdown.

### Gateway Routing

The gateway (`services/gateway`) acts as the single entry point. It proxies requests to backend services:
- `/api/v2/authenticator/*` → authenticator service
- `/api/v2/documents/*`, `/api/v2/templates/*` → pdfgenerator service
- `/api/v2/*` → api service (landlord API)
- `/tenantapi/*` → tenantapi service
- `/api/reset/*` → resetservice (non-production only)
- `/landlord/*` → landlord frontend
- `/tenant/*` → tenant frontend

### Authentication Flow

- JWT-based authentication with access tokens and refresh tokens
- Access tokens are short-lived, refresh tokens stored in Redis
- Landlord API: access token sent in `Authorization: Bearer <token>` header
- Tenant API: access token sent in `sessionToken` cookie
- Middleware chain: `needAccessToken` → `checkOrganization` → role checks
- Three principal types: `user` (human), `application` (API client), `service` (internal)
- Roles: `administrator`, `renter`, `tenant`

### Multi-tenancy (Organizations/Realms)

- Each landlord account can belong to multiple organizations (called "Realms" in the database)
- The `organizationId` header identifies the current organization context
- The `checkOrganization` middleware resolves the realm and validates membership
- All data queries are scoped by `realmId`

## Data Layer

### Mongoose Collections

**12 collections**, all exported from `services/common/src/collections/index.ts` (regenerate this list
with `ls services/common/src/collections/` — do not trust a hand-maintained copy):

- `Account` — user accounts (email, password hash)
- `Realm` — organizations with members, addresses, bank info, third-party configs
- `Tenant` (model name: `Occupant`) — tenant records with contract details and rent history
- `Property` — rental properties
- `Lease` — lease templates (duration, time range)
- `Building` — polykatoikia with units[], expenses[], contractors[], repairs[], ownerMonthlyExpenses[]
- `Bill` — utility bill records (ΔΕΗ, ΕΥΔΑΠ, etc.) linked to building expenses, with IRIS QR codes
- `InboxItem` — bills that arrived via the Telegram bot, awaiting confirmation (backs `/api/v2/inbox`)
- `TelegramOffset` — the Telegram poller's `update_id` cursor, so restarts don't re-ingest
- `Document` — generated documents (contracts, notices)
- `Template` — document templates (HTML/text)
- `Email` — email sending records

⚠️ **`InboxItem` and `TelegramOffset` are NOT in `COLLECTIONS_TO_BACKUP`**
(`services/api/src/managers/databasemanager.ts:13` — it names 10 of the 12, and `accounts` is
deliberately emptied for per-realm backups since it has no `realmId`, so 9 are really captured). A
backup/restore cycle silently drops every pending Telegram-inbox bill and resets the poller cursor,
which then re-ingests old messages. Check that list before relying on a backup.

Types are defined in `types/src/common/collections.ts` as `CollectionTypes` namespace.

### Important: Tenant model is named "Occupant" in MongoDB

The Mongoose model for tenants is registered as `'Occupant'` (`mongoose.model('Occupant', TenantSchema)`), but the TypeScript type and API routes use `Tenant`. Keep this in mind when querying the database directly.

## Frontend Patterns

### Landlord App (Pages Router)

- Uses Next.js Pages Router with `src/pages/[organization]/` for org-scoped routes
- `@tanstack/react-query` v5.29 for all server state (data fetching/mutations)
- API calls via `src/utils/restcalls.js` (plain async functions) wrapped in `useQuery`/`useMutation`
- Auth/session state in store classes (`src/store/`): Organization, User, AppHistory with subscribe/notify reactivity
- `StoreContext` provides auth/org context to components via React Context + `useSyncExternalStore`
- `getStoreInstance()` singleton used by `fetch.js` interceptor for token refresh and by `withAuthentication` for redirect checks
- All forms use react-hook-form + zod (Formik+Yup fully removed, MUI fully removed)
- Data flows as props from pages to child components (no global observable state)

#### Hidden Details / Gotchas
- **Store reactivity**: Store class has `subscribe(listener)` and `notify()`. Every mutation method in Organization, User, AppHistory calls `notify()`. `InjectStoreContext` uses `useSyncExternalStore` to re-render on changes. Context value is `{ user, organization, appHistory }` — a new object each version so `useContext` consumers re-render.
- **`withAuthentication` reads from singleton**: Uses `getStoreInstance()` directly, NOT `useContext(StoreContext)`. This avoids a race condition where the context value hasn't propagated yet after page reload.
- **`useFillStore` also reads from singleton**: Same reason as above.
- **`index.js` uses `getServerSideProps` redirects**: NOT client-side `router.push()`. The `InjectStoreContext` renders children during SSR, so `router.push()` would crash on the server.
- **Dialog navigation must pass locale**: `NewPropertyDialog`, `NewTenantDialog`, `NewLeaseDialog` all pass `{ locale: store.organization.selected?.locale }` to `router.push()`. Without this, the page renders in English instead of the org's locale.
- **`LandlordForm` firstAccess mode**: Must structure company data as `companyInfo: { name, ein, ... }` for the API. The form fields are flat (`company`, `ein`, etc.) but the API expects nested `companyInfo`.
- **Stepper renders ALL non-done steps' children**: The `Stepper` component renders children for the active step AND all future steps. This means `[data-cy=submit]` finds multiple buttons. Use `.filter(':visible').first()` or scope to the active step.
- **Dashboard has two modes**: First-connection (wizard with steps) and normal (shortcut bar). `shortcutAddProperty`/`shortcutAddTenant`/`shortcutCreateContract` exist in BOTH modes. `isFirstConnection` is true when any of: no leases, no properties, no tenants.
- **Presence awareness**: API routes `POST/GET /api/v2/presence/:type/:id` store viewer info in Redis with 60s TTL. Frontend `usePresence` hook polls every 30s. `PresenceBanner` component shows on tenant/property/contract detail pages.

#### Referential Integrity

Re-measured 2026-08-02 against the handlers. The previous version of this block was headed "verified
working" and was **wrong on three of its five claims** — the heading invited trust without checking.
Cite the handler, not this list, if it matters:

- **Property deletion** (`propertymanager.ts:297`) — 422 on **two** blockers, reported together in one
  message: a tenant referencing it (`properties.propertyId`) **and/or** a building unit linking it
  (`units.propertyId`, "detach the unit first"). The building-unit blocker was missing from this doc.
  404 if nothing matched.
- **Contract/lease deletion** (`leasemanager.ts:235`) — 422 `Contract is used by tenants`. ✓
- **Tenant deletion** (`occupantmanager.ts:~1726`) — 422 only when the tenant has **recorded money**:
  a rent payment `> 0`, a `settlement`-origin discount, or a `settlement`-origin debt `> 0`. It is
  **not** blocked by "active lease" or "unpaid balance" as this doc used to claim. `?force=true`
  **archives** instead of deleting (sets `terminationDate` + `archived=true`) so `rents[]` survives as
  the audit trail.
- **Realm deletion** (`realmmanager.ts:650`) — `administrator` role only (403 otherwise), then 422 with
  counts of tenants / properties / leases / buildings. On success it cascade-deletes Template,
  Document, Email, **Bill** — but **not `InboxItem` or `TelegramOffset`**, which are left orphaned.
- **Duplicate names** — split, not uniform: **lease** names ARE refused case-insensitively within the
  realm on both add and update (`leasemanager.ts:77` / `:159`, Wave-24 B11); **property** names have no
  such check. The old blanket "API allows duplicate property and lease names" was half wrong.

#### Test Infrastructure (resetservice extensions)

**On this fork the resetservice is NOT deployed to NAS** (see `scripts/deploy-nas.sh`). The endpoints below exist in the codebase for local Finch dev/CI but Playwright E2E specs (which target the live NAS) cannot rely on them. E2E specs use idempotent API-driven seeds in `e2e-playwright/tests/lib/api.ts` instead.

Local-dev only:
- `POST /api/reset/seed` — creates user + org + leases + properties + tenants in one API call. Bypasses rent pipeline.
- `POST /api/reset/otp` — generates OTP for tenant email, returns it directly (bypasses email delivery). The OTP-driven `tenant/me` resolution test in `11_tenantapi_me.spec.ts` is fixme'd because this endpoint is unreachable from NAS.

### Tenant App (App Router)

- Uses Next.js App Router with `src/app/[lang]/` for locale-based routing
- TypeScript throughout
- React Server Components for data fetching
- Client components for interactive UI
- `src/middleware.ts` handles locale detection and routing
- Form handling with react-hook-form + zod validation

### UI Component Strategy

Both apps use shadcn/ui pattern:
- `components.json` configures shadcn/ui CLI
- `src/components/ui/` contains primitive UI components (Button, Dialog, Select, etc.)
- Tailwind CSS with CSS variables for theming (HSL color system)
- Radix UI primitives for accessible, unstyled components

## Docker Build Pattern

Multi-stage Dockerfile pattern used across all services:
1. `base` — Node.js base image
2. `build` — Install deps, transpile TypeScript, build
3. `deps` — Production-only dependencies
4. Runtime — Minimal image (distroless or alpine), copy built artifacts

TypeScript services build chain: types → common → service (in that order).

## Error Handling

- `ServiceError` class for typed HTTP errors with status codes
- `Middlewares.asyncWrapper()` wraps async route handlers to catch errors
- `Middlewares.errorHandler` is the Express error middleware (registered last)
- Non-production environments include stack traces in error responses

## Security Middleware

- `express-mongo-sanitize` — strips `$` from request bodies/params/query to prevent NoSQL injection
- **Rate limiting on auth endpoints** — hand-rolled `authRateLimit` (an in-memory `Map` in
  `services/authenticator/src/routes/index.ts`), **not** a library: `express-rate-limit` has never
  been a dependency here. 20 attempts / 60 s; bucket keyed `email:` → `clientId:` → `ip:` (IP last
  because behind the gateway every request shares one `remoteAddress`); **only failures count**
  (increment deferred to `res.on('finish')`, skipped for `statusCode < 400`); process-local, resets on
  restart. Guards landlord `/signup` `/signin` `/apptoken` `/forgotpassword` and tenant `/signin`
  `/signedin` — deliberately **not** `/refreshtoken` or `/session`, so an attacker can't lock out
  active users. Grep `authRateLimit` for current call sites; the old "(signin, signup,
  forgot-password)" parenthetical was already three routes short.
- `organizationId` header validated as valid MongoDB ObjectId format before query
- Input validation: percentage sums, enum/range checks, NaN guards on financial fields
- **CSV formula-injection guard** (`accountingmanager.ts:_sanitizeCsvText`): prefixes leading `= + - @ \t \r` with a single quote on free-text fields (description / notepromo / noteextracharge) flowing into rawData JSON. Mitigates the Excel/Sheets formula-execution vector for spreadsheet-readable exports. json2csv handles the standard quote/newline escaping but does NOT handle formula prefix; this is the workaround.
- **Per-payment field validation** in PATCH `/rents/payment/:id/:term`: each entry of `paymentData.payments[]` is validated for `amount, type, reference, description, allocation, date` (existing) and `promo / extracharge / notepromo / noteextracharge` (round-3j fields). Number caps at 10M, string caps at 1000 chars — matches the rent-level guards. `Schema.Types.Mixed` storage offers no persistence-layer enforcement, so the API is the single validation layer.
- **Backdate guard** in PATCH `/rents/payment/:id/:term`: payment dates < the rent term's first day are rejected (422) so a misclick on the wrong month's rents page can't silently record against the wrong term. Mirrored client-side in `PaymentTabs.js` for early UX surface.

### CORS allowlist — how the origin regex is built

The gateway's `configureCORS()` (in `services/gateway/src/index.ts`) builds its allowlist from two sources (as of `2fdedd13`): the comma-separated `APP_DOMAIN` list **plus** `new URL(config.DOMAIN_URL).host` — which **preserves the port**. Each host is regex-escaped and turned into an exact-match origin regex `^https?://<host>$` (no subdomain-capture group). `URLUtils.destructUrl()` is only reached in the `catch` fallback for a malformed `DOMAIN_URL`.

**For any non-default port:** set `APP_DOMAIN` to the full `host:port` string (e.g., `APP_DOMAIN=localhost:8080`). It's used as-is in the regex and supports comma-separated lists for multi-origin deploys (LAN + Tailscale). (Historically `destructUrl()` stripped the port on the fallback path, causing `CORS blocked origin: http://localhost:8080` 500s; that was fixed in `59e37bda` — `destructUrl` now returns `url.host` with the port.)

**Required plumbing:** `docker-compose.microservices.base.yml` must export `- APP_DOMAIN` in the gateway service environment. This was missing for a long time even though the gateway code referenced it; fixed in commit `e77d3e3`. NAS deployment uses a standalone `docker-compose.nas.yml` and was never affected.

**Note:** `finch restart` does NOT reload env vars — you must `finch rm -f` and `finch compose ... up -d <service>` to pick up `.env` changes.

## Pagination

- List endpoints (tenants, properties, leases) support `?page=N&limit=M` query params
- When paginated, response includes `x-total-count` and `x-total-pages` headers
- Frontend uses `useInfiniteQuery` + Load More button (NOT traditional page numbers)
