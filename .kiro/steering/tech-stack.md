---
inclusion: always
---

# MRE — Tech Stack Reference

## Runtime & Language

- Node.js v20 (required, enforced in package.json `engines`)
- Mixed JavaScript (ES Modules) and TypeScript codebase
- All packages use `"type": "module"` (ESM imports throughout)
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
- MongoDB 7 — primary database
- Redis 7.4 — session/token storage (used by authenticator)
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
- multer — file upload handling (pdfgenerator)
- express-mongo-sanitize — NoSQL injection prevention
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
- react-hook-form + zod — form handling and validation (all 22 forms)
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

- Jest 29.7 — unit tests (api service, common library)
- Cypress 14.4 — end-to-end tests
- supertest — HTTP assertion testing (api service)
- No test framework for frontend apps currently

## DevOps & Infrastructure

- Docker with multi-stage builds (build → deps → runtime)
- Production images use `gcr.io/distroless/nodejs20-debian12` (gateway, landlord, tenant) or `node:20-alpine` (api)
- Docker Compose with multiple overlay files:
  - `docker-compose.microservices.base.yml` — base service definitions
  - `docker-compose.microservices.dev.yml` — dev overrides (volume mounts, debug ports, hot reload)
  - `docker-compose.microservices.prod.yml` — prod overrides (resource limits, restart policies)
  - `docker-compose.microservices.test.yml` — CI overrides (adds resetservice)
  - `docker-compose.yml` — standalone production deployment
- Caddy — reverse proxy for standalone deployment (auto HTTPS)
- GitHub Actions CI/CD pipeline: lint → build & push images to GHCR → deploy → healthcheck → e2e tests
- GitHub Container Registry (ghcr.io) for Docker images

## Code Quality

- ESLint 8.57 with `eslint:recommended`, `plugin:import/recommended`, `prettier`
- Prettier 3.5 (single quotes, semicolons, 2-space tabs, no trailing commas)
- Husky 9 + lint-staged — pre-commit hooks (lint + format)
- Sorted imports enforced by ESLint

## Internationalization

- 6 supported locales: `en`, `fr-FR`, `pt-BR`, `de-DE`, `es-CO`, `el`
- Backend: `i18n` package with JSON locale files
- Landlord frontend: `next-translate` with per-page namespace JSON files
- Tenant frontend: custom i18n with `@formatjs/intl-localematcher` and `negotiator`
