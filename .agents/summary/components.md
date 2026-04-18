# MicroRealEstate Components

## Backend Services

### Gateway (`services/gateway`)

Reverse proxy using `http-proxy-middleware`. Single entry point on port 8080. Routes requests to backend services. TypeScript.

### Authenticator (`services/authenticator`)

Login/logout, JWT token management, password reset, OTP for tenants. Uses bcrypt for password hashing, Redis for token storage. TypeScript.

Routes: `signin`, `signup`, `signout`, `forgotpassword`, `resetpassword`, `refreshtoken`.

### API Service (`services/api`)

Landlord REST API. CRUD for tenants (Occupant model), properties, leases, rents. TypeScript.

- `src/businesslogic/` — rent computation pipeline (7 steps)
- `src/managers/` — data access layer
- Presence API: `POST/GET /api/v2/presence/:type/:id` with Redis 60s TTL

### Tenant API (`services/tenantapi`)

Read-only API for tenant portal. Session-based auth via cookies. TypeScript.

### Emailer (`services/emailer`)

Email generation and sending. Supports Gmail, Mailgun, SMTP. Uses EJS templates. TypeScript.

### PDF Generator (`services/pdfgenerator`)

Document generation using Puppeteer (headless Chrome). EJS + Handlebars templates. Generates contracts, rent notices, invoices. TypeScript.

### Reset Service (`services/resetservice`)

DEV/CI only. Database reset, seed API (`POST /api/reset/seed`), OTP generation (`POST /api/reset/otp`). TypeScript.

### Common Library (`services/common`)

Shared library: `Service` class (singleton, Express setup, MongoDB/Redis connections), Mongoose collections, middleware (auth, error handling), crypto utilities, logging. TypeScript.

## Frontend Apps

### Landlord App (`webapps/landlord`)

Next.js 14 Pages Router. JavaScript (JSX).

- `@tanstack/react-query` v5.29 for server state
- Plain class stores for auth/session (Organization, User, AppHistory) with subscribe/notify + `useSyncExternalStore`
- shadcn/ui + Tailwind CSS
- react-hook-form + zod for all 22 forms
- TipTap rich text editor, Recharts for dashboard, pigeon-maps for maps, sonner for toasts

Key directories:

| Directory | Purpose |
|-----------|---------|
| `src/pages/[organization]/` | Org-scoped routes |
| `src/components/` | Feature components + `ui/` (shadcn primitives) |
| `src/hooks/` | React Query hooks |
| `src/store/` | Auth/session store classes |
| `src/utils/` | `restcalls.js` (API functions), `fetch.js` (axios interceptor) |

### Tenant App (`webapps/tenant`)

Next.js 14 App Router. TypeScript (TSX). React Server Components. shadcn/ui + Tailwind. react-hook-form + zod. OTP-based sign-in.

### Common UI (`webapps/commonui`)

Shared utilities (`isClient`, `isServer`, env helpers), contract helpers, localization strings, runtime scripts.

## Types Package (`types/`)

Shared TypeScript type definitions. `CollectionTypes` namespace for Mongoose models. API response types.

## E2E Tests (`e2e/`)

Cypress 14. Custom commands: `seedTestData`, `seedAndComputeRents`, `getTenantOTP`, `recordPayment`, `selectByLabel`.

## CLI (`cli/`)

Node.js CLI for managing the app: `dev`, `build`, `start`, `stop`, `configure`.
