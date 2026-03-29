# MRE — Architecture Diagrams

## 1. High-Level System Architecture

```mermaid
graph TB
    subgraph Clients["Clients - Browser"]
        Landlord["Landlord User"]
        TenantUser["Tenant User"]
    end

    subgraph ReverseProxy["Reverse Proxy"]
        Caddy["Caddy - auto HTTPS"]
    end

    subgraph Gateway["Gateway :8080"]
        GW["Gateway Service"]
    end

    subgraph Frontends["Frontend Apps"]
        LF["Landlord Frontend :8180\nNext.js 14 Pages Router\nReact + MobX + Tailwind"]
        TF["Tenant Frontend :8190\nNext.js 14 App Router\nReact + RSC + Tailwind"]
    end

    subgraph BackendServices["Backend Services"]
        AUTH["Authenticator :8000\nJWT + bcrypt"]
        API["API :8200\nLandlord REST API"]
        TAPI["Tenant API :8250\nTenant REST API"]
        EMAIL["Emailer :8400\nGmail / Mailgun / SMTP"]
        PDF["PDFGenerator :8300\nPuppeteer + EJS"]
        RESET["ResetService :8900\nDEV/CI only"]
    end

    subgraph DataStores["Data Stores"]
        MONGO[("MongoDB 7\n:27017")]
        REDIS[("Redis 7.4\n:6379")]
    end

    Landlord -->|HTTPS| Caddy
    TenantUser -->|HTTPS| Caddy
    Caddy --> GW

    GW -->|"/landlord/*"| LF
    GW -->|"/tenant/*"| TF
    GW -->|"/api/v2/authenticator/*"| AUTH
    GW -->|"/api/v2/*"| API
    GW -->|"/api/v2/documents/*\n/api/v2/templates/*"| PDF
    GW -->|"/tenantapi/*"| TAPI
    GW -.->|"/api/reset/* non-prod"| RESET

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

Note: arrows point from dependency to dependent (X to Y means Y depends on X).

## 3. Authentication and Request Flow

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
    AUTH->>AUTH: verify password with bcrypt
    AUTH->>R: store refresh token
    AUTH-->>GW: accessToken + refreshToken cookie
    GW-->>B: response

    Note over B,R: Authenticated API Request
    B->>GW: GET /api/v2/tenants with Bearer token
    GW->>API: proxy request
    API->>API: needAccessToken middleware - verify JWT
    API->>DB: checkOrganization middleware
    API->>API: notRoles tenant middleware
    API->>DB: query tenants by realmId
    API-->>GW: tenants list
    GW-->>B: response

    Note over B,R: Tenant Sign-In Flow
    B->>GW: POST /tenantapi/signin
    GW->>AUTH: proxy to authenticator
    AUTH->>AUTH: generate magic link or OTP
    AUTH->>GW: call emailer
    GW->>B: check your email
    B->>GW: GET /tenantapi with sessionToken cookie
    GW->>TAPI: proxy request
    TAPI->>TAPI: verify sessionToken cookie
    TAPI-->>B: tenant data
```

## 4. Data Model - Entity Relationships

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

    Tenant }o--o{ Property : rents

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
        Lint["Lint\nall workspaces"]
        Build["Build and Push\nDocker Images\n9 images in parallel"]
        Deploy["Deploy to\nCI Server"]
        Health["Health Check"]
        E2E["Cypress E2E\nTests"]
    end

    subgraph Registry
        GHCR["GitHub Container\nRegistry ghcr.io"]
    end

    Push --> Lint --> Build --> Deploy --> Health --> E2E
    Build --> GHCR
    GHCR --> Deploy
```

Images built: gateway, api, tenantapi, authenticator, pdfgenerator, emailer, resetservice, landlord-frontend, tenant-frontend.

## 6. Docker Compose Overlay Strategy

```mermaid
graph TD
    BASE["docker-compose.microservices.base.yml\nall service definitions, env vars, networking"]

    DEV["docker-compose.microservices.dev.yml\nvolume mounts, debug ports,\nhot reload, resetservice"]
    PROD["docker-compose.microservices.prod.yml\nrestart policies, resource limits,\nmulti-stage Dockerfiles"]
    TEST["docker-compose.microservices.test.yml\nresetservice for DB cleanup"]
    STANDALONE["docker-compose.yml\nstandalone prod with Caddy reverse proxy"]

    BASE --> DEV
    BASE --> PROD
    BASE --> TEST

    DEV -->|yarn dev| DevMode["DEV Mode\nNODE_ENV=development"]
    PROD -->|yarn start| ProdMode["PROD Mode\nNODE_ENV=production"]
    TEST -->|yarn ci| CIMode["CI Mode\nNODE_ENV=test"]
    STANDALONE -->|docker compose up| StandaloneMode["Standalone\nSelf-hosted"]
```
