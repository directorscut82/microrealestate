# Codebase Info

## Basic Metadata

- **Name:** MicroRealEstate (MRE)
- **Version:** 1.0.0-alpha.1
- **License:** MIT
- **Author:** Camel Aissani
- **Repository:** https://github.com/microrealestate/microrealestate
- **Description:** Open-source property management application for landlords
- **Node.js:** v20 (required, enforced in `package.json` engines)
- **Package Manager:** Yarn 3.3.0 (Berry) with PnP disabled (uses `node_modules`)
- **Monorepo:** Yarn Workspaces
- **Languages:** TypeScript (all backend services, tenant frontend, types), JavaScript (landlord frontend, CLI, commonui)
- **Locales:** en, fr-FR, pt-BR, de-DE, es-CO, el

## Workspace Packages

All scoped under `@microrealestate/*`:

| Package | Path | Description |
|---------|------|-------------|
| types | `types/` | Shared TypeScript type definitions |
| common | `services/common/` | Shared backend library (Express, Mongoose, Redis, JWT, logging) |
| gateway | `services/gateway/` | API gateway & reverse proxy (:8080) |
| authenticator | `services/authenticator/` | Auth service: JWT, bcrypt, password reset (:8000) |
| api | `services/api/` | Landlord REST API: CRUD for tenants, properties, leases, rents (:8200) |
| tenantapi | `services/tenantapi/` | Tenant REST API: read-only tenant access (:8250) |
| emailer | `services/emailer/` | Email generation & sending via Gmail/Mailgun/SMTP (:8400) |
| pdfgenerator | `services/pdfgenerator/` | PDF document generation using Puppeteer (:8300) |
| resetservice | `services/resetservice/` | Database reset service, DEV/CI only (:8900) |
| commonui | `webapps/commonui/` | Shared frontend utilities, locales, runtime scripts |
| landlord | `webapps/landlord/` | Landlord web app — Next.js 14 Pages Router (JavaScript) |
| tenant | `webapps/tenant/` | Tenant web app — Next.js 14 App Router (TypeScript) |
| e2e | `e2e/` | End-to-end tests (Cypress 14) |
| cli | `cli/` | CLI tool for managing the app |

## Data Stores

- **MongoDB 7** — primary database (port 27017)
- **Redis 7.4** — session/token storage (port 6379)

## Environment Configuration

- `base.env` — Default values, versioned in git
- `.env` — Local overrides with secrets (not versioned)
- Secrets include: `REDIS_PASSWORD`, `CIPHER_KEY`, `CIPHER_IV_KEY`, `AUTHENTICATOR_*_TOKEN_SECRET`
