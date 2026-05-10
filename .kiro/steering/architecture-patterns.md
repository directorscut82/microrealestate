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

Defined in `services/common/src/collections/`:
- `Account` — user accounts (email, password hash)
- `Realm` — organizations with members, addresses, bank info, third-party configs
- `Tenant` (model name: `Occupant`) — tenant records with contract details and rent history
- `Property` — rental properties
- `Lease` — lease templates (duration, time range)
- `Building` — polykatoikia with units[], expenses[], contractors[], repairs[], ownerMonthlyExpenses[]
- `Bill` — utility bill records (DEH, EYDAP, etc.) linked to building expenses, with IRIS QR codes
- `Document` — generated documents (contracts, notices)
- `Template` — document templates (HTML/text)
- `Email` — email sending records

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

#### Referential Integrity (verified working)
- **Property deletion**: API returns 422 when property is occupied by a tenant. UI shows toast error.
- **Contract deletion**: API returns 422 when contract is used by tenants. UI shows toast error.
- **Tenant deletion**: API returns 422 when tenant has recorded payments, active lease, or unpaid balance. UI shows options dialog with archive/force-delete.
- **Realm deletion**: API returns 422 when child records exist (tenants, properties, leases, buildings). Returns counts in error.
- **Duplicate names**: API allows duplicate property and lease names (no unique constraint).

#### Test Infrastructure (resetservice extensions)
- `POST /api/reset/seed` — creates user + org + leases + properties + tenants in one API call. Bypasses rent pipeline — use `seedAndComputeRents` Cypress command to trigger rent computation via PATCH.
- `POST /api/reset/otp` — generates OTP for tenant email, returns it directly (bypasses email delivery).
- **Limitation**: Seeded tenants don't have `usedByTenants` flag computed (frontdata manager not triggered). Seeded data may skip stepper steps if billing/lease data is pre-populated.
- **Limitation**: Payment form requires a date field — without it, the form validates but doesn't submit to the API.

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
- Rate limiting on auth endpoints (signin, signup, forgot-password)
- `organizationId` header validated as valid MongoDB ObjectId format before query
- Input validation: percentage sums, enum/range checks, NaN guards on financial fields

## Pagination

- List endpoints (tenants, properties, leases) support `?page=N&limit=M` query params
- When paginated, response includes `x-total-count` and `x-total-pages` headers
- Frontend uses `useInfiniteQuery` + Load More button (NOT traditional page numbers)
