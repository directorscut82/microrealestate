# MicroRealEstate — Documentation Index

> **For AI Assistants:** This file is the primary entry point for understanding the MicroRealEstate codebase. Read this file first to determine which detailed documentation files to consult for specific questions.

## How to Use This Documentation

1. **Start here** — this index describes what each file contains and when to consult it
2. **Follow cross-references** — each file links to related documentation
3. **Use the query guide** below to find the right file for your question

## Query Guide

| If you need to know about... | Consult |
|------------------------------|---------|
| Project metadata, packages, scripts | [codebase_info.md](codebase_info.md) |
| System design, service communication, Docker, CI/CD | [architecture.md](architecture.md) |
| What each service/app does, directory layout | [components.md](components.md) |
| REST API endpoints, authentication headers | [interfaces.md](interfaces.md) |
| MongoDB collections, entity relationships, rent pipeline | [data_models.md](data_models.md) |
| Auth flow, rent computation, tenant lifecycle, onboarding | [workflows.md](workflows.md) |
| Third-party libraries, framework versions | [dependencies.md](dependencies.md) |

## File Summaries

### [codebase_info.md](codebase_info.md)
Basic project metadata: name, version, license, author, repository URL. Lists all 14 workspace packages with paths and descriptions. Documents data stores (MongoDB 7, Redis 7.4), key scripts (`yarn dev/build/start/stop/ci`), and environment configuration (`base.env` vs `.env`).

### [architecture.md](architecture.md)
System architecture with Mermaid diagrams. Covers: microservices topology (9 services + 2 frontends behind a gateway), gateway routing table, the shared `Service` bootstrap pattern, JWT authentication architecture (access/refresh tokens, middleware chain, principal types), multi-tenancy via Realms with `realmId` scoping, Docker Compose overlay strategy (dev/prod/test/standalone), and the GitHub Actions CI/CD pipeline.

### [components.md](components.md)
Detailed description of each backend service (gateway, authenticator, API, tenantapi, emailer, pdfgenerator, resetservice, common library) and frontend app (landlord with Pages Router + React Query + shadcn/ui, tenant with App Router + RSC, commonui utilities). Includes the landlord app's key directory structure and the E2E test infrastructure.

### [interfaces.md](interfaces.md)
Complete REST API reference organized by service. Landlord API routes for tenants, properties, leases, rents, documents, organizations, presence, and accounting. Authenticator API routes. Tenant API routes. Reset Service API routes. Documents authentication headers and internal service communication patterns.

### [data_models.md](data_models.md)
MongoDB collections with an ER diagram. Detailed field descriptions for Account, Realm, Tenant (Occupant), Property, Lease, Template, Document, and Email. Documents the rent entry structure within `tenant.rents[]` and the 7-step rent computation pipeline. Notes the Tenant/Occupant naming discrepancy.

### [workflows.md](workflows.md)
Key business workflows with Mermaid sequence diagrams: landlord authentication, authenticated API requests, tenant OTP sign-in, rent computation pipeline, document generation (Puppeteer), email sending, tenant lifecycle (create → pay → terminate), first access onboarding, and token refresh flow.

### [dependencies.md](dependencies.md)
Complete external dependency inventory organized by category: runtime infrastructure, package management, backend core libraries, document generation, email, security, frontend dependencies for both landlord and tenant apps, testing frameworks, code quality tools, and CI/CD infrastructure.

## Key Architectural Decisions

- **Microservices with shared library** — all services use `@microrealestate/common` for consistent Express/Mongoose/Redis setup
- **Multi-tenancy via Realms** — all data scoped by `realmId`, resolved from `organizationId` header
- **Tenant model named Occupant** — Mongoose model is `'Occupant'` but TypeScript/API uses `Tenant`
- **Frontend state split** — React Query for server state, plain class stores with `useSyncExternalStore` for auth/session only
- **No MobX** — fully removed; all data fetching via `@tanstack/react-query`
- **shadcn/ui + Tailwind** — Material UI v4 fully removed
- **react-hook-form + zod** — Formik + Yup fully removed
