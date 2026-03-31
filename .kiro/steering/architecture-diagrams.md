---
inclusion: always
---

# MRE — Architecture Diagrams

## 1. High-Level System Architecture

```mermaid
graph TB
    subgraph Clients["Clients (Browser)"]
        Landlord["Landlord User"]
        TenantUser["Tenant User"]
    end

    subgraph ReverseProxy["Reverse Proxy"]
        Caddy["Caddy<br/>(auto HTTPS)"]
    end

    subgraph Gateway["Gateway :8080"]
        GW["Gateway Service<br/>(http-proxy-middleware)"]
    end

    subgraph Frontends["Frontend Apps"]
        LF["Landlord Frontend :8180<br/>Next.js 14 Pages Router<br/>React + React Query + Tailwind"]
        TF["Tenant Frontend :8190<br/>Next.js 14 App Router<br/>React + RSC + Tailwind"]
    end

    subgraph BackendServices["Backend Services"]
        AUTH["Authenticator :8000<br/>JWT + bcrypt"]
        API["API :8200<br/>Landlord REST API"]
        TAPI["Tenant API :8250<br/>Tenant REST API"]
        EMAIL["Emailer :8400<br/>Gmail / Mailgun / SMTP"]
        PDF["PDFGenerator :8300<br/>Puppeteer + EJS"]
        RESET["ResetService :8900<br/>(DEV/CI only)"]
    end

    subgraph DataStores["Data Stores"]
        MONGO[("MongoDB 7<br/>:27017")]
        REDIS[("Redis 7.4<br/>:6379")]
    end

    Landlord -->|HTTPS| Caddy
    TenantUser -->|HTTPS| Caddy
    Caddy --> GW

    GW -->|/landlord/*| LF
    GW -->|/tenant/*| TF
    GW -->|/api/v2/authenticator/*| AUTH
    GW -->|/api/v2/*| API
    GW -->|/api/v2/documents/*<br/>/api/v2/templates/*| PDF
    GW -->|/tenantapi/*| TAPI
    GW -.->|/api/reset/* non-prod| RESET

    AUTH --> MONGO
    AUTH --> REDIS
    AUTH --> EMAIL
    API --> MONGO
    API --> EMAIL
    API --> PDF
    TAPI --> MONGO
    EMAIL --> MONGO
    EMAIL --> PDF
    PDF --> MONGO
    RESET --> MONGO
    RESET --> REDIS
```

## 2. Service Dependency Graph

```mermaid
graph LR
    subgraph Infrastructure
        MONGO[("MongoDB")]
        REDIS[("Redis")]
    end

    subgraph Services
        GW[Gateway]
        AUTH[Authenticator]
        API[API]
        TAPI[TenantAPI]
        EMAIL[Emailer]
        PDF[PDFGenerator]
        RESET[ResetService]
    end

    subgraph Frontends
        LF[Landlord Frontend]
        TF[Tenant Frontend]
    end

    MONGO --> PDF
    MONGO --> EMAIL
    PDF --> EMAIL
    MONGO --> AUTH
    REDIS --> AUTH
    EMAIL --> AUTH
    MONGO --> API
    EMAIL --> API
    PDF --> API
    MONGO --> TAPI
    REDIS --> RESET
    MONGO --> RESET
    AUTH --> GW
    API --> GW
    TAPI --> GW
    PDF --> GW
    EMAIL --> GW
    GW --> LF
    GW --> TF
```

Note: arrows point from dependency to dependent (X → Y means Y depends on X).

## 3. Authentication & Request Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant GW as Gateway
    participant AUTH as Authenticator
    participant API as API Service
    participant DB as MongoDB
    participant R as Redis

    Note over B,R: Login Flow
    B->>GW: POST /api/v2/authenticator/signin
    GW->>AUTH: proxy request
    AUTH->>DB: find account by email
    AUTH->>AUTH: verify password (bcrypt)
    AUTH->>R: store refresh token
    AUTH-->>GW: { accessToken } + refreshToken cookie
    GW-->>B: response

    Note over B,R: Authenticated API Request
    B->>GW: GET /api/v2/tenants<br/>Authorization: Bearer {token}<br/>organizationId: {realmId}
    GW->>API: proxy request
    API->>API: needAccessToken middleware<br/>(verify JWT)
    API->>DB: checkOrganization middleware<br/>(find Realm, verify membership)
    API->>API: notRoles(['tenant']) middleware
    API->>DB: query tenants by realmId
    API-->>GW: { tenants: [...] }
    GW-->>B: response

    Note over B,R: Tenant Sign-In Flow
    B->>GW: POST /tenantapi/signin
    GW->>AUTH: proxy to authenticator
    AUTH->>AUTH: generate magic link / OTP
    AUTH->>GW: call emailer
    GW->>B: check your email
    B->>GW: GET /tenantapi/... (sessionToken cookie)
    GW->>TAPI: proxy request
    TAPI->>TAPI: verify sessionToken cookie
    TAPI-->>B: tenant data
```

## 4. Data Model (Entity Relationships)

```mermaid
erDiagram
    Account {
        string _id PK
        string firstname
        string lastname
        string email UK
        string password
    }

    Realm {
        string _id PK
        string name
        boolean isCompany
        string locale
        string currency
    }

    Realm ||--o{ Member : has
    Member {
        string name
        string email
        string role
        boolean registered
    }

    Realm ||--o{ Property : contains
    Property {
        string _id PK
        string realmId FK
        string type
        string name
        number price
        number surface
    }

    Realm ||--o{ Lease : defines
    Lease {
        string _id PK
        string realmId FK
        string name
        number numberOfTerms
        string timeRange
        boolean active
    }

    Realm ||--o{ Tenant : manages
    Tenant {
        string _id PK
        string realmId FK
        string name
        string leaseId FK
        date beginDate
        date endDate
        boolean isCompany
    }

    Tenant ||--o{ PartRent : "has rent history"
    PartRent {
        number term
        number grandTotal
        number payment
        number balance
    }

    Tenant }o--o{ Property : "rents"

    Realm ||--o{ Template : has
    Template {
        string _id PK
        string realmId FK
        string name
        string type
        string html
    }

    Tenant ||--o{ Document : "generated for"
    Document {
        string _id PK
        string realmId FK
        string tenantId FK
        string templateId FK
        string type
        string name
    }

    Email {
        string _id PK
        string templateName
        string sentTo
        date sentDate
        string status
    }
```

## 5. CI/CD Pipeline

```mermaid
graph LR
    subgraph Trigger
        Push["Push to master"]
    end

    subgraph Pipeline
        Lint["Lint<br/>(all workspaces)"]
        Build["Build & Push<br/>Docker Images<br/>(9 images in parallel)"]
        Deploy["Deploy to<br/>CI Server"]
        Health["Health Check"]
        E2E["Cypress E2E<br/>Tests"]
    end

    subgraph Registry
        GHCR["GitHub Container<br/>Registry (ghcr.io)"]
    end

    Push --> Lint --> Build --> Deploy --> Health --> E2E
    Build --> GHCR
    GHCR --> Deploy
```

Images built: gateway, api, tenantapi, authenticator, pdfgenerator, emailer, resetservice, landlord-frontend, tenant-frontend.

## 6. Docker Compose Overlay Strategy

```mermaid
graph TD
    BASE["docker-compose.microservices.base.yml<br/>(all service definitions, env vars, networking)"]

    DEV["docker-compose.microservices.dev.yml<br/>(volume mounts, debug ports,<br/>hot reload, resetservice)"]
    PROD["docker-compose.microservices.prod.yml<br/>(restart policies, resource limits,<br/>multi-stage Dockerfiles)"]
    TEST["docker-compose.microservices.test.yml<br/>(resetservice for DB cleanup)"]
    STANDALONE["docker-compose.yml<br/>(standalone prod with Caddy reverse proxy)"]

    BASE --> DEV
    BASE --> PROD
    BASE --> TEST

    DEV -->|"yarn dev"| DevMode["DEV Mode<br/>NODE_ENV=development"]
    PROD -->|"yarn start"| ProdMode["PROD Mode<br/>NODE_ENV=production"]
    TEST -->|"yarn ci"| CIMode["CI Mode<br/>NODE_ENV=test"]
    STANDALONE -->|"docker compose up"| StandaloneMode["Standalone<br/>Self-hosted"]
```
