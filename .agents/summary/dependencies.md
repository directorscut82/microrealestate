# External Dependencies

## Runtime Infrastructure

- **Node.js v20** — required, enforced in `package.json` engines
- **MongoDB 7** — primary database
- **Redis 7.4** — session/token storage
- **Docker** — containerization
- **Caddy** — reverse proxy for standalone deployment (auto HTTPS)

## Package Management

- **Yarn 3.3.0** (Berry) with PnP disabled (uses `node_modules`)
- **Yarn Workspaces** for monorepo structure

## Backend Core

| Dependency | Purpose |
|------------|---------|
| Express 4.21 | HTTP framework |
| Mongoose 6.13 | MongoDB ODM |
| jsonwebtoken 9.0 | JWT authentication |
| bcrypt | Password hashing |
| axios | Inter-service HTTP |
| http-proxy-middleware | Gateway reverse proxy |
| cors | CORS handling |
| winston + express-winston | Structured logging |
| redis (@redis) | Redis client |
| express-mongo-sanitize | NoSQL injection prevention |

## Document Generation

| Dependency | Purpose |
|------------|---------|
| Puppeteer 23 | Headless Chrome for PDF rendering |
| EJS | Template engine |
| Handlebars | Template engine |
| multer | File upload handling |

## Email

| Dependency | Purpose |
|------------|---------|
| nodemailer | Email sending |
| nodemailer-mailgun-transport | Mailgun integration |

## Frontend — Landlord App

| Dependency | Purpose |
|------------|---------|
| Next.js 14.2 | Pages Router framework |
| React 18.2 | UI library |
| @tanstack/react-query v5.29 | Server state management |
| Radix UI | Accessible component primitives |
| Tailwind CSS 3.4 | Utility-first styling |
| TipTap 2.6 | Rich text editor |
| react-hook-form 7.54 + zod 3.24 | Form handling + validation |
| next-translate | i18n |
| next-themes | Dark mode |
| Recharts | Charts |
| pigeon-maps | Maps |
| sonner | Toast notifications |
| date-fns | Date utilities |
| jose | JWT (client-side) |
| lucide-react | Icons |

## Frontend — Tenant App

| Dependency | Purpose |
|------------|---------|
| Next.js 14.2 | App Router framework |
| React 18.2 + TypeScript | UI library |
| Radix UI + Tailwind CSS | Components + styling |
| react-hook-form + zod | Forms + validation |
| next-runtime-env | Runtime env vars |
| input-otp | OTP input component |

## Testing

| Dependency | Purpose |
|------------|---------|
| Jest 29.7 | Unit tests |
| Cypress 14.4 | E2E tests |
| supertest | HTTP assertion testing |

## Code Quality

| Tool | Configuration |
|------|---------------|
| ESLint 8.57 | `eslint:recommended`, `plugin:import/recommended`, `prettier` |
| Prettier 3.5 | Single quotes, semicolons, 2-space indent, no trailing commas |
| Husky 9 + lint-staged | Pre-commit: lint + format |
| TypeScript 5.5.4 | Type checking |

## CI/CD

- **GitHub Actions** — CI pipeline
- **GitHub Container Registry** (`ghcr.io`) — Docker image registry
