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
- Auth/session state in plain class store (`src/store/`): Organization, User, AppHistory (no MobX)
- `StoreContext` provides auth/org context to components via React Context
- `getStoreInstance()` singleton used by `fetch.js` interceptor for token refresh
- All forms use react-hook-form + zod (Formik+Yup fully removed, MUI fully removed)
- Data flows as props from pages to child components (no global observable state)

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
