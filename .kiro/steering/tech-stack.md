---
inclusion: always
---

# MRE — Tech Stack Reference

## Runtime & Language

- Node.js v20 (required, enforced in package.json `engines`)
- Mixed JavaScript (ES Modules) and TypeScript codebase
- **`"type": "module"` in 9 of the 14 workspaces** — `types` + all 8 `services/*`. The five that are
  NOT ESM-by-default: `cli`, `e2e-playwright`, `webapps/commonui`, `webapps/landlord`, `webapps/tenant`
  (the Next.js apps rely on the bundler, not the node loader). This asymmetry is why the api jest
  mocks must be `.cjs` — see Testing below.
- TypeScript 5.5.4 for all backend services and types package
- Landlord frontend: JavaScript (JSX), Tenant frontend: TypeScript (TSX)

## Package Management

- Yarn 3.3.0 (Berry) with PnP disabled (uses node_modules)
- Yarn Workspaces for monorepo management
- `.yarnrc.yml` for Yarn configuration
- `yarn workspaces focus` used in Dockerfiles for selective dependency installation

## Backend

- Express 4.21 — HTTP framework (configured via `@microrealestate/common` Service class)
- Mongoose 6.13 — MongoDB ODM (collections defined in `services/common/src/collections/`)
- MongoDB 4.4 — primary database (pinned in every compose file; legacy `mongo` shell, not `mongosh`)
- Redis 7.4 — session/token storage. **Four services open a client** (`useRedis: true` in each
  `src/index.ts`): authenticator, api, tenantapi, resetservice — not just the authenticator. The
  client is the shared singleton in `services/common/src/utils/redisclient.ts`, configured from
  `REDIS_URL`.
- JSON Web Tokens (jsonwebtoken 9.0) — authentication
- bcrypt — password hashing
- axios — inter-service HTTP communication
- http-proxy-middleware — gateway reverse proxy
- cors — CORS handling in gateway
- winston + express-winston — structured logging
- Puppeteer 23 — headless Chrome for PDF generation
- EJS + Handlebars — email and PDF templating
- nodemailer — email sending (Gmail, SMTP)
- nodemailer-mailgun-transport — Mailgun integration
- The **emailer service is multi-channel** (not email-only): email (Gmail/SMTP/Mailgun via nodemailer), SMS (`services/emailer/src/sms.ts` → sms-gate.app), and Telegram (`services/emailer/src/telegram.ts` → Telegram Bot API). All channel configs + secrets live in `realm.thirdParties` (also holds B2 storage + multiple Gmail-API mail-reader configs), AES-256-GCM encrypted at rest.
- multer — file upload handling (pdfgenerator, api PDF import)
- pdfjs-dist 4.0 — PDF text extraction for lease import (api service)
- express-mongo-sanitize — NoSQL injection prevention
- **No rate-limiting library.** `express-rate-limit` has never been a dependency of this repo (not in
  any `package.json`, not in `yarn.lock`, not installed) — earlier versions of this doc listed it,
  which is worse than listing nothing because it reads as a control that exists. The real limiter is
  hand-rolled — `authRateLimit`, an in-memory `Map` in `services/authenticator/src/routes/index.ts`.
  Grep `authRateLimit` for the current call sites; as of 2026-08 it guards landlord
  `/signup` `/signin` `/apptoken` `/forgotpassword` and tenant `/signin` `/signedin`, and deliberately
  NOT `/refreshtoken` or `/session` so an attacker cannot lock active users out. Design points that
  matter if you touch it:
  - **20 attempts / 60 s**, and the bucket is keyed `email:` → else `clientId:` → else `ip:`. The IP
    key is the last resort on purpose: behind the gateway every request shares one `remoteAddress`,
    so an IP-only key gave all M2M auth a single global bucket (20 bad attempts would DoS every app).
  - **Only failures count.** The increment is deferred to `res.on('finish')` and skipped for
    `statusCode < 400`, so successful sign-ins don't consume the budget.
  - **Process-local**: resets on restart, does not coordinate across replicas. A `setInterval` sweeps
    expired keys every 5 min to bound the map.
- qrcode — IRIS QR code generation for utility bill payments
- i18n — server-side internationalization
- moment.js — date handling (backend)
- lodash — utility functions
- json2csv — CSV export for accounting

## Frontend — Landlord App (`webapps/landlord`)

- Next.js 14.2 with Pages Router (`src/pages/`)
- React 18.2
- @tanstack/react-query v5.29 — all server state (data fetching/mutations)
- Plain class store for auth/session only (Organization, User, AppHistory — no MobX)
- Radix UI primitives — modern UI components
- shadcn/ui pattern (components.json, `src/components/ui/`)
- Tailwind CSS 3.4 with CSS variables for theming
- TipTap 2.6 — rich text editor for contract templates
- react-hook-form + zod — form handling and validation (all forms)
- next-translate — i18n (locales in `locales/` directory)
- next-themes — dark mode support
- Recharts — dashboard charts
- @react-pdf-viewer — PDF viewing
- pigeon-maps — map display
- sonner — toast notifications
- date-fns — date utilities (frontend)
- jose — JWT handling (client-side)

## Frontend — Tenant App (`webapps/tenant`)

- Next.js 14.2 with App Router (`src/app/[lang]/`)
- React 18.2 with TypeScript
- React Server Components enabled (`rsc: true` in components.json)
- Radix UI primitives + shadcn/ui pattern
- Tailwind CSS 3.4
- react-hook-form + zod — form handling and validation
- lucide-react — icons
- next-runtime-env — runtime environment variables
- date-fns — date utilities
- input-otp — OTP input for tenant sign-in
- No MobX (uses server components + react-hook-form instead)

## Shared UI (`webapps/commonui`)

- Shared utilities (isClient, isServer, env helpers)
- Shared contract helpers (contractEndMoment, durationEndMoment)
- Shared localization strings
- Runtime scripts: `generateruntimeenvfile.js`, `replacebasepath.js`, `runner.js`
- No React components exported (FormFields deleted, Loading/Illustration moved to landlord app)

## Testing

- Jest 29.7 (with `@swc/jest`) — unit tests (api service, common library, landlord frontend)
  - **No count is quoted here on purpose.** Every historical figure in this repo's docs (431, 609,
    628, 644, 875, …) was a point-in-time snapshot that then read as current for months. The one
    dated baseline lives in `test-running-guide.md`; anything else, measure:
    ```bash
    export PATH="/usr/local/opt/node@20/bin:$PATH"
    cd services/api && node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --no-coverage
    ```
  - ⚠️ Runs ONLY under **node@20** (system node drifted to v25 and breaks the suite; node@20 at `/usr/local/opt/node@20/bin/node`). `services/api` is `type: module`, so the winston/express-winston/jsonwebtoken mocks are `.cjs` and `jest.mock` suites import `jest` from `@jest/globals`. See `documentation/E2E_TESTING.md` / test-running-guide.
  - Frontend: a handful of test files (ErrorBoundary, token refresh, payment double-submit, fetch errors)
- Playwright 1.60 — end-to-end tests, NAS-targeted, in the `e2e-playwright/` workspace
  - Counts drift constantly and have been wrong in three docs at once. Measure instead of quoting:
    ```bash
    git ls-files 'e2e-playwright/tests/*.spec.ts' | wc -l   # tracked
    ls e2e-playwright/tests/*.spec.ts | wc -l               # on disk, incl. untracked scratch
    ```
    **A tracked count that DROPS is not necessarily deleted tests** — `1ff11f4c` (the PII scrub)
    removed 16 force-added `_tier*`/`_verify*` debug specs from tracking, taking the tracked count
    67 → 55. From the number alone that is indistinguishable from deleting coverage.
  - **The scratch specs are NOT excluded from a bare run.** `playwright.config.ts` sets only
    `testDir: './tests'` — no `testIgnore`, `testMatch`, `grep` or `grepInvert`. There are 87
    untracked `tests/_*.spec.ts` files, so a bare `yarn test:nas` / `npx playwright test` collects
    **484 tests across 142 files** (measured 2026-08-02), most of it untracked scratch that writes to
    the live NAS. Always pass explicit paths: `npx playwright test --project=chromium tests/NN_*.spec.ts`.
  - Replaced the 68-spec Cypress 14 suite in May 2026 (`447db44e`) — see `documentation/E2E_TESTING.md`
- supertest — HTTP assertion testing (api service unit tests)

## DevOps & Infrastructure

- Docker with multi-stage builds (build → deps → runtime)
- Production images use `gcr.io/distroless/nodejs20-debian12` (gateway, landlord, tenant) or `node:20-alpine` (api)
- Docker Compose with multiple overlay files:
  - `docker-compose.microservices.base.yml` — base service definitions
  - `docker-compose.microservices.dev.yml` — dev overrides (volume mounts, debug ports, hot reload)
  - `docker-compose.microservices.prod.yml` — prod overrides (resource limits, restart policies)
  - `docker-compose.microservices.test.yml` — CI overrides (adds resetservice)
  - `docker-compose.yml` — standalone production deployment
- Caddy — reverse proxy for standalone deployment. Note the root `Caddyfile` global block sets
  **`auto_https off`** (L1-4), so the "auto HTTPS" upstream advertises is disabled in this fork's
  standalone compose; TLS is whatever fronts it.
- GitHub Actions CI/CD (this fork): **4 workflows build images, 3 of them push to GHCR** — `ci.yml`
  (push to `master` → `:<sha>` + `:latest`), `nas-ci.yml` (push to `nas` → `:nas` + `:nas-<sha>`;
  this is the one the NAS deploy waits on), `release.yml` (on `release` → `:<tag>` + **overwrites
  `:latest`**), and `pr-ci.yml` (on `pull_request` → builds with `push: false`, never publishes).
  `codeql-analysis.yml` builds no images. Reasoning "only master and nas publish" misses `release.yml`.
  E2E does NOT run in CI on this fork — Playwright specs run on the developer Mac against the live NAS.
- GitHub Container Registry (ghcr.io) for Docker images

## Code Quality

- ESLint 8.57 with `eslint:recommended`, `plugin:import/recommended`, `prettier`
- Prettier 3.5 (single quotes, semicolons, 2-space tabs, no trailing commas)
- Husky 9 + lint-staged — pre-commit (PII scan + lint/format) and **pre-push** (commit-tree credential
  scan). Both hooks must stay mode `100755`: git silently ignores a non-executable hook.
- **Sorted imports are NOT enforced repo-wide.** `sort-imports` is explicitly `"off"` in 8 of the 13
  `.eslintrc.json` files (root, types, landlord, and services common/api/emailer/gateway/tenantapi)
  and only enabled in 2 (`webapps/tenant`, `services/resetservice`); `cli`, `services/`, and
  `webapps/commonui` set no rule. No config uses `import/order`. Don't reorder imports in a file to
  "satisfy lint" — outside those 2 workspaces nothing is asking you to.
- **`scripts/*.mjs` is in no lint gate at all.** The lint-staged globs cover
  `*.{js,ts,tsx,jsx}` / `*.{json,md,html,…}` (no `.mjs`), and root `lint` is
  `yarn workspaces foreach … run lint` while `scripts/` is not a workspace. The two security guards
  live there, so they are unlinted by construction — run `node --check` and `prettier --write` on them
  by hand after editing.

## Internationalization

- 6 supported locales: `en`, `fr-FR`, `pt-BR`, `de-DE`, `es-CO`, `el`
- Backend: `i18n` package with JSON locale files
- Landlord frontend: `next-translate` with per-page namespace JSON files
- Tenant frontend: custom i18n with `@formatjs/intl-localematcher` and `negotiator`
