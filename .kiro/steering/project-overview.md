---
inclusion: always
---

# MicroRealEstate (MRE) — Project Overview

MicroRealEstate is an open-source property management application for landlords. It follows a microservices architecture, containerized with Docker, and uses a Yarn 3 monorepo.

## Repository Structure

```
microrealestate/
├── cli/                  # Node.js CLI tool for managing the app (dev/build/start/stop/configure)
├── services/             # Backend microservices (Node.js, all TypeScript)
│   ├── common/           # Shared library (Express, Mongoose, Redis, JWT, logging, crypto)
│   ├── gateway/          # API gateway & reverse proxy (TypeScript)
│   ├── authenticator/    # Auth service: login/logout, JWT tokens, password reset (TypeScript)
│   ├── api/              # Landlord REST API: CRUD for tenants, properties, leases, rents (TypeScript)
│   ├── tenantapi/        # Tenant REST API: read-only tenant access (TypeScript)
│   ├── emailer/          # Email generation & sending via Gmail/Mailgun/SMTP (TypeScript)
│   ├── pdfgenerator/     # PDF document generation using Puppeteer (TypeScript)
│   └── resetservice/     # Database reset service (DEV/CI only) (TypeScript)
├── webapps/
│   ├── commonui/         # Shared utilities, locales, runtime scripts (JavaScript)
│   ├── landlord/         # Landlord web app — Next.js 14 Pages Router (JavaScript)
│   └── tenant/           # Tenant web app — Next.js 14 App Router (TypeScript)
├── types/                # Shared TypeScript type definitions
├── e2e-playwright/       # End-to-end tests (Playwright, NAS-targeted)
├── docker-compose*.yml   # 7 compose files: standalone (Caddy), microservices.{base,dev,prod,test}, monitoring, nas
├── base.env              # Default environment variables (versioned)
└── .env                  # Local overrides with secrets (not versioned)
```

## Workspace Packages (Yarn Workspaces)

All packages are scoped under `@microrealestate/*`:
- `@microrealestate/types` — shared TypeScript types
- `@microrealestate/common` — shared backend library
- `@microrealestate/gateway`, `api`, `tenantapi`, `authenticator`, `emailer`, `pdfgenerator`, `resetservice` — services
- `@microrealestate/commonui`, `landlord`, `tenant` — frontend apps
- `@microrealestate/e2e-playwright` — end-to-end tests (Playwright, NAS-targeted)
- `@microrealestate/cli` — CLI tool (not published, used internally)

## Key Commands

- `yarn dev` — Start all services in development mode (Docker + hot reload)
- `yarn build` — Build all Docker images for production
- `yarn start` — Start in production mode
- `yarn stop` — Stop all containers
- `yarn ci` — Start in CI mode (for automated testing)
- `yarn lint` — Lint all workspaces
- `yarn format` — Format all workspaces with Prettier
- `yarn e2e:nas` — Backup NAS Mongo + run Playwright suite against the live NAS (see `documentation/E2E_TESTING.md`).
  From the repo root this is the alias; **inside `e2e-playwright/` the script is named `test:nas`** (the
  root `e2e:nas` just delegates to it). Both names are real — `E2E_TESTING.md` documents the in-workspace
  form, so don't "correct" either one to match the other.
- `yarn deploy:nas` — Push `nas` (GHCR builds `:nas` images), optionally trigger Portainer redeploy on the
  Synology NAS (self-hosted fork only). It **used to** merge `master` → `nas` first; that step is now
  conditional on a local `master` existing (`scripts/deploy-nas.sh:123-140`) and is **skipped in the normal
  case**, since local `master` was deleted 2026-08-02 and all work lands directly on `nas`. Before that
  guard, a deleted `master` made `git merge master` fail and the script reported it as a *merge conflict* —
  a wrong diagnosis for a branch that simply isn't there.

## Branches

**History was rewritten with `git filter-repo` on 2026-08-01** (the PII scrub). Every commit SHA on the
branch changed. Any SHA quoted in a doc, a commit message, or an agent memory file from before that
date is suspect — and an abbreviated one may now resolve to a *different* object, which is worse than
failing outright. Verify with `git cat-file -e <sha>^{commit}` before citing.

- `nas` — **the only branch that matters.** It is the self-hosted deployment branch and where all work
  lands. `origin/master` and `origin/nas` are currently **the same commit** (`752e6e20`), 887 commits
  ahead of `upstream/master`. Do not develop on `master`; see `documentation/DEV_AND_DEPLOY.md`.
  `.github/workflows/nas-ci.yml` builds `:nas` + `:nas-<sha>` images to GHCR on push, and
  `docker-compose.nas.yml` is the deploy target. Deployment is automated via `scripts/deploy-nas.sh`
  (non-interactive: `printf 'n\ny\n' | bash scripts/deploy-nas.sh`; aliased `yarn deploy:nas`).
- **A merge-base with upstream DOES exist** — `git merge-base nas upstream/master` resolves to
  `88ad6787` (upstream/master itself), so `git merge` works. An earlier version of this doc claimed
  authorship rewriting had destroyed the common ancestor and that only `git cherry-pick` was possible;
  that is not true today. Check before assuming either way.
- Local branches: only `nas` exists. The 8 stale ones (`main`, `style_experiments`, and 6 merged
  feature branches) were deleted 2026-08-02; their tips are recorded in
  `~/mre-pii-backup-2026-08-01/deleted-local-branch-tips-2026-08-02.txt` if one is ever needed back.
  `origin` still carries `e2e-hardening`, `feat/bill-ocr-import`, `master`, `nas`, and the
  server-owned `refs/pull/1/head`.

## Environment Configuration

- `base.env` — Default values, versioned in git
- `.env` — Local overrides with secrets (generated by `mre configure` CLI)
- Environment variables are merged: base.env values are overridden by .env values
- Secrets include: `REDIS_PASSWORD`, `CIPHER_KEY`, `CIPHER_IV_KEY`, `AUTHENTICATOR_*_TOKEN_SECRET`

## Where to find more

This repo uses a single source of truth for agent-readable documentation: the steering files in `.kiro/steering/`. Other agent tools read the same content via symlinks — never edit the symlinks, edit the steering file.

| Tool | Reads from | Backed by |
|------|-----------|-----------|
| Kiro | `.kiro/steering/*.md` (auto-loaded) | original |
| Claude Code | `CLAUDE.md` at repo root | symlink → `AGENTS.md` |
| Generic agents | `AGENTS.md` at repo root | original (~380 lines — a reference, not a pointer) |
| Wasabi (Amazon Q) | `wasabi-toolbag/content/0N-*.md` | symlinks → **all 10** steering files |

All 10 steering files are `inclusion: always` and load automatically alongside this one. The three
`*-do-not-skip.md` files are the behavioural gates — they exist because the listed failure modes
actually happened, repeatedly:

- `tech-stack.md` — runtime, package versions, backend/frontend libraries
- `architecture-patterns.md` — service bootstrap, auth flow, multi-tenancy, frontend gotchas (Tenant=Occupant, store reactivity, etc.)
- `architecture-diagrams.md` — Mermaid diagrams of system, service dependencies, auth flow, ER, CI
- `frontend-patterns.md` — UI/state/forms patterns + SSR gotchas for the landlord app
- `roadmap-hardening.md` — what's done, what's pending, in what order
- `test-running-guide.md` — Playwright + jest commands, discipline rules, container management, disk reclaim
- **`fix-discipline-do-not-skip.md`** — read FIRST on any bug report. Read the system before proposing;
  artifacts not claims; adversarially refute your own fix before the word "fixed".
- **`ui-review-do-not-skip.md`** — no UI work is done until you have screenshotted the rendered **Greek**
  screen and read the image. A green API-assertion suite is not a UI review.
- **`no-fabrication-do-not-skip.md`** — never render an unsourced number, label, or element; and never
  report an **absence** you did not measure.

Non-steering documentation (read on-demand):
- `AGENTS.md` (repo root) — first-read reference for new agents/contributors
- `README.md` (repo root) — project description
- `documentation/DEV_AND_DEPLOY.md` — two-branch dev/NAS workflow, deploy script, troubleshooting, historical gotchas
- `documentation/FINCH_SETUP.md` — Finch installation, env config, disk-space reclaim
- `documentation/LINT_DEBT.md` — open lint debt with concrete fix plan (must be paid down before new feature merges)
- `documentation/DEVELOPER.md` — upstream-style dev guide (Docker, debugging). E2E sections are stale (refer to upstream Cypress); use `documentation/E2E_TESTING.md` instead.
- `documentation/E2E_TESTING.md` — canonical Playwright E2E reference: harness layout, discipline rules, common gotchas
- `documentation/NAS_DEPLOYMENT_PLAN.archive.md` — historical execution plan, archived
