# MicroRealEstate — Workspace Summary

## Overview

MicroRealEstate is a **property rental management platform** built as a **Yarn 3 monorepo** with a microservices architecture. It provides landlord management and tenant self-service portals backed by containerized API services.

This is a fork (`directorscut82/microrealestate`) self-hosted on a Synology NAS. Two-branch workflow:
- `master` — local development, mirrors upstream source code.
- `nas` — production layer for the NAS (multi-origin support: LAN + Tailscale, NAS-specific CI building `:nas` and `:nas-<sha>` images to GHCR).

---

## Workspace Structure

```
microrealestate/
├── cli/                  # CLI tool for dev orchestration (Node.js)
├── e2e/                  # Cypress E2E test suite
├── services/
│   ├── api/              # Main business logic API (Express)
│   ├── authenticator/    # JWT authentication service
│   ├── common/           # Shared backend utilities & middleware
│   ├── emailer/          # Email generation & sending
│   ├── gateway/          # API gateway / reverse proxy orchestrator
│   ├── pdfgenerator/     # PDF document generation (Puppeteer)
│   ├── resetservice/     # Database reset utility
│   └── tenantapi/        # Tenant-specific API endpoints
├── types/                # Shared TypeScript type definitions
├── webapps/
│   ├── commonui/         # Shared UI components (React)
│   ├── landlord/         # Landlord portal (Next.js Pages Router)
│   └── tenant/           # Tenant portal (Next.js App Router)
└── docker-compose.yml    # Container orchestration
```

### Service Architecture

```
Caddy (reverse proxy) → gateway:8080 → {
  authenticator:8000, api:8200, tenantapi:8250,
  pdfgenerator:8300, emailer:8400,
  landlord:8180, tenant:8190
}
MongoDB:27017, Redis:6379 (shared data layer)
```

---

## Languages & Frameworks

| Component | Language | Runtime | Key Frameworks |
|-----------|----------|---------|----------------|
| Backend services | TypeScript 5.5 | Node.js 20 | Express 4.21, Mongoose 6.13 |
| Landlord webapp | JavaScript (JSX) | Node.js 20 | Next.js 14.2 (Pages Router), React 18.2 |
| Tenant webapp | TypeScript (TSX) | Node.js 20 | Next.js 14.2 (App Router), React 18.2 |
| CLI | JavaScript | Node.js 20 | Commander |
| E2E tests | JavaScript | Node.js 20 | Cypress 14.4 |
| Types | TypeScript 5.5 | — | Shared type definitions |

**All services use ES Modules** (`"type": "module"` in package.json).

---

## Critical Dependencies

### Backend
- **Express 4.21.1** — HTTP server framework (via `@microrealestate/common`)
- **Mongoose 6.13.6** — MongoDB ODM
- **Redis 4.6.10** — Session/cache client
- **jsonwebtoken 9.0.0** — JWT authentication
- **axios 1.8.4** — HTTP client (enforced via resolutions)
- **moment 2.29.4** — Date/time manipulation
- **lodash 4.17.21** — Utility functions
- **bcrypt 5.1.1** — Password hashing
- **Puppeteer 23.2.1** — Headless Chrome (PDF generation)
- **aws-sdk 2.1677.0** — AWS S3 (pdfgenerator only)

### Frontend
- **React 18.2.0** — UI library
- **Next.js 14.2.26** — React framework
- **Tailwind CSS 3.4.10** — Utility-first CSS
- **Radix UI** — Accessible component primitives
- **TanStack Query 5.29.0** — Server state management (landlord)
- **Recharts 2.13.3** — Data visualization (landlord)

### Infrastructure
- **MongoDB 7** — Document database
- **Redis 7.4** — In-memory data store
- **Caddy** — Reverse proxy
- **ELK Stack** (Elasticsearch/Logstash/Kibana 6.2.4) — Optional monitoring
- **cAdvisor** — Container resource metrics

---

## Build System

### Package Management
- **Yarn 3.3.0** (Berry) with `nodeLinker: node-modules` (PnP disabled)
- Yarn Workspace Tools plugin for monorepo commands
- No Amazon internal build systems (Brazil/Peru)

### Key Scripts (root)
| Command | Purpose |
|---------|---------|
| `yarn dev` | Start all services in development mode |
| `yarn build` | Build all services |
| `yarn start` / `yarn stop` | Start/stop services via CLI |
| `yarn lint` | Lint all workspaces in parallel |
| `yarn format` | Format all workspaces |
| `yarn e2e:run` | Run Cypress E2E tests headless |
| `yarn e2e:open` | Open Cypress interactive runner |
| `yarn ci` | CI orchestration |
| `yarn deploy:nas` | Merge master → nas, push (CI builds `:nas` images), trigger Portainer stack redeploy on the NAS |

### Service Build Pattern
Backend services use TypeScript compilation with `@swc/jest` for testing:
```bash
yarn transpile    # Compile TS (types → common → service)
yarn clean        # Remove dist/
yarn dev          # Build + watch with debug ports (9225-9240)
yarn test         # Jest with --experimental-vm-modules
```

### Docker Compose Overlays
- `docker-compose.yml` — Standalone production config with Caddy
- `docker-compose.microservices.base.yml` — Env-driven base
- `docker-compose.microservices.dev.yml` — Hot-reload, debug ports, volume mounts
- `docker-compose.microservices.prod.yml` — Memory limits, production Dockerfiles
- `docker-compose.microservices.test.yml` — CI/E2E testing config
- `docker-compose.nas.yml` — Local-only (gitignored), NAS production stack with inlined secrets, used by Portainer on the Synology NAS

### Container Runtime — Finch (not Docker)
Local development on macOS uses **Finch**, not Docker Desktop. All compose commands use `finch compose`. The CLI auto-detects Finch when present. See `documentation/FINCH_SETUP.md` for setup, including the periodic disk reclaim procedure (`finch system prune -a -f && finch volume prune -a -f` followed by `fstrim` inside the VM via `limactl shell`).

### Deploying to NAS — `yarn deploy:nas`
Runs `scripts/deploy-nas.sh` which merges `master` → `nas`, pushes (CI builds the `:nas` images), and triggers a Portainer stack redeploy via the Portainer REST API. Reads tokens from `.secrets/github-pat` and `.secrets/portainer-token` (both gitignored). See `documentation/DEV_AND_DEPLOY.md` for the full flow.

---

## Code Style Rules

### Prettier (enforced via pre-commit hook)
- **Semicolons:** Always required
- **Indentation:** 2 spaces (never tabs)
- **Quotes:** Single quotes
- **Trailing commas:** None
- **Line length:** 80 characters (Prettier default)
- **Line endings:** Unix (LF)

### ESLint
- **Root:** `eslint:recommended` + `plugin:import/recommended` + `prettier`
- **TypeScript services:** Adds `@typescript-eslint/recommended` + `plugin:import/typescript`
- **Next.js webapps:** `next/core-web-vitals` + `prettier`
- **E2E:** `plugin:cypress/recommended`
- **Import sorting:** Alphabetical, case-insensitive; order: side-effects → namespace → named → default
- **`@ts-ignore` allowed** (`ban-ts-comment: off`)
- **Rest siblings ignored** for unused vars

### Pre-commit Hook (Husky)
Runs `yarn lint` on commit, which triggers lint-staged:
1. ESLint `--quiet --fix` on `*.{js,ts,tsx,jsx}`
2. Prettier `--write` on `*.{json,md,html,js,jsx,ts,tsx}`

### Tailwind CSS
- **Dark mode:** Class-based
- **Design system:** HSL-based CSS variables for colors (primary, secondary, destructive, muted, accent, etc.)
- **Border radius:** CSS variable `--radius`
- **Plugin:** `tailwindcss-animate`
- **Landlord:** Roboto font, broader content glob
- **Tenant:** Sans font, `info` color variant, TSX-only content glob

---

## Testing

### Unit Tests (Jest 29.7)
- **Config:** `v8` coverage provider, `@swc/jest` transform
- **Pattern:** `**/src/**/__tests__/**/*.test.js`
- **Location:** `src/__tests__/` or `src/<module>/__tests__/`
- **Coverage:** Always enabled, collected from `src/**/*.{js,ts}`

**Conventions:**
- Factory functions for test data with sensible defaults and overrides
- Direct module imports (minimal mocking)
- `describe`/`it` blocks with descriptive "should" names
- Error testing via `expect(() => ...).toThrow()`
- Complex logic tested via step-by-step task validation

**Example pattern:**
```javascript
import * as BL from '../businesslogic/index.js';

function makeContract(overrides = {}) {
  return { frequency: 'months', properties: [], vatRate: 0, discount: 0, ...overrides };
}

describe('Contract', () => {
  it('should compute rent correctly', () => {
    const contract = makeContract({ properties: [makeProp()] });
    const result = BL.computeRent(contract);
    expect(result.total).toEqual(expected);
  });
});
```

### E2E Tests (Cypress 14.4)
- **Viewport:** 1200×1200
- **Timeout:** 60s default
- **Test isolation:** Disabled (shared state within files)
- **Numbering:** `NN_description.cy.js` for execution order
- **Locale:** French (`fr-FR`) default in i18n assertions
- **Base URL:** `http://localhost:8080/landlord` (configurable)

**Key custom commands:**
- `cy.signIn()`, `cy.signOut()`, `cy.resetAppData()`
- `cy.seedTestData(data)`, `cy.seedAndComputeRents(seedData)`
- `cy.navAppMenu(page)`, `cy.navOrgMenu(page)`, `cy.checkPage(page)`
- `cy.createContractFromStepper()`, `cy.addPropertyFromStepper()`
- `cy.addTenantFromStepper()`, `cy.searchResource(text)`, `cy.openResource(name)`
- `cy.selectByLabel(label, option)` — Handles shadcn/Radix selects with retry
- `cy.recordPayment(tenantName, amount)`

**Patterns:**
- Retry logic for React controlled input re-renders (clear → type → verify → retry)
- API interception with `cy.intercept()` + `cy.wait('@alias')`
- `data-cy` attribute selectors: pages (`[data-cy=<page>Page]`), nav (`[data-cy=<page>Nav]`), actions (`[data-cy=submit]`)
- API shortcuts for setup; UI-driven tests for assertions
- Fixtures in `e2e/cypress/fixtures/` (contracts, properties, tenants, users)

---

## Logging

### Framework: Winston
**Import:**
```typescript
import { logger } from '@microrealestate/common';
```

**Log levels** (severity order): `error`, `warn`, `info`, `debug`, `silly`

**API:**
```typescript
logger.error(String(error));
logger.warn('Warning message');
logger.info(`Service ready on port ${port}`);
logger.debug('Debug details');
```

**Output format:**
```
2026-04-25T17:30:00.000 <E> Error message
2026-04-25T17:30:00.000 <I> Info message
```

**Configuration:** `LOGGER_LEVEL` env var (defaults to `debug`)

**HTTP logging:** express-winston middleware auto-logs `METHOD STATUS TIME URL`

**Test mocking:**
```javascript
// services/api/src/__mocks__/winston.js and express-winston.js exist
jest.mock('winston');
jest.mock('express-winston');
```

### Error Handling
The `errorHandler` middleware in `@microrealestate/common`:
- Logs all errors via `logger.error(String(error))`
- Returns `{ status, message }` (+ `stack` in non-production)
- Uses custom `ServiceError` class for typed HTTP errors

### Metrics
- No custom application metrics framework
- Container metrics via cAdvisor
- HTTP request metrics via express-winston (status codes, response times)
- Optional ELK stack for centralized log aggregation

---

## Environment & Configuration

### Config Hierarchy
- `base.env` — Base defaults
- `.env` — Local overrides (not version-controlled)
- `.env.ci` — CI-specific configuration

### Key Environment Variables
| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | development / production |
| `LOGGER_LEVEL` | Winston log level (default: debug) |
| `MONGO_URL` | MongoDB connection string |
| `REDIS_URL` / `REDIS_PASSWORD` | Redis connection |
| `ACCESS_TOKEN_SECRET` | JWT access token secret |
| `REFRESH_TOKEN_SECRET` | JWT refresh token secret |
| `CIPHER_KEY` / `CIPHER_IV_KEY` | Encryption for stored API keys |
| `SIGNUP` | Enable user registration (true/false) |
| `ALLOW_SENDING_EMAILS` | Email delivery toggle |
| `DEMO_MODE` | API demo mode |
| `APP_PROTOCOL` / `APP_DOMAIN` / `APP_PORT` | External URL construction |

### Service Discovery
- Internal: `http://servicename:port/path`
- External: `APP_PROTOCOL://APP_DOMAIN:APP_PORT/base-path`
- Debug: Ports 9224-9240 for Node.js inspector

---

## Internationalization

Six supported locales: **en**, **fr-FR**, **de-DE**, **el** (Greek), **es-CO**, **pt-BR**

- Backend: JSON locale files in each service's `src/locales/`
- Landlord: `next-translate` with locale files in `locales/<locale>/`
- Tenant: Custom i18n with server/client utilities
- E2E: `i18next` for assertion text (`fr-FR` default)
