# MicroRealEstate — Key Workflows

## Authentication Flow (Landlord)

```mermaid
sequenceDiagram
    participant B as Browser
    participant GW as Gateway
    participant Auth as Authenticator
    participant Mongo as MongoDB
    participant Redis as Redis

    B->>GW: POST /signin (email, password)
    GW->>Auth: forward
    Auth->>Mongo: find account by email
    Auth->>Auth: bcrypt.compare(password, hash)
    Auth->>Redis: store refresh token
    Auth-->>GW: { accessToken } + Set-Cookie: refreshToken
    GW-->>B: response
```

## Authenticated API Request

```mermaid
sequenceDiagram
    participant B as Browser
    participant GW as Gateway
    participant API as API Service
    participant Mongo as MongoDB

    B->>GW: GET /api/v2/resource (Bearer token, organizationId)
    GW->>API: forward
    API->>API: needAccessToken — verify JWT
    API->>Mongo: checkOrganization — find Realm, verify membership
    API->>API: role check
    API->>Mongo: query resource by realmId
    API-->>GW: JSON response
    GW-->>B: response
```

## Tenant Sign-In Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant GW as Gateway
    participant Auth as Authenticator
    participant Email as Emailer

    B->>GW: POST /signin (tenant email)
    GW->>Auth: forward
    Auth->>Auth: generate OTP
    Auth->>Email: send OTP email
    Auth-->>GW: OTP sent
    GW-->>B: prompt for OTP

    B->>GW: POST /verify (email, OTP)
    GW->>Auth: forward
    Auth->>Auth: verify OTP
    Auth-->>GW: Set-Cookie: sessionToken
    GW-->>B: authenticated
```

## Rent Computation

Triggered when a tenant is created or updated (PATCH). Pipeline computes the final amount for each rent period.

```mermaid
sequenceDiagram
    participant API as API Service
    participant Pipe as Rent Pipeline
    participant Mongo as MongoDB

    API->>Pipe: compute(tenant, term)
    Pipe->>Pipe: 1. base rent (Property.price)
    Pipe->>Pipe: 2. + debts (previous balance)
    Pipe->>Pipe: 3. + expenses/charges
    Pipe->>Pipe: 4. − discounts
    Pipe->>Pipe: 5. + VAT
    Pipe->>Pipe: 6. − settlements (payments)
    Pipe->>Pipe: 7. = grand total
    Pipe-->>API: computed rent object
    API->>Mongo: update tenant.rents[]
```

## Document Generation

```mermaid
sequenceDiagram
    participant API as API Service
    participant PDF as PDFGenerator
    participant Puppet as Puppeteer

    API->>PDF: POST /generate (templateId, data)
    PDF->>PDF: load template (EJS/Handlebars)
    PDF->>PDF: populate with tenant/property data
    PDF->>Puppet: render HTML → PDF
    Puppet-->>PDF: PDF buffer
    PDF-->>API: PDF document
```

## Email Sending

```mermaid
sequenceDiagram
    participant Caller as API / Authenticator
    participant Email as Emailer
    participant PDF as PDFGenerator
    participant SMTP as Mail Transport

    Caller->>Email: send email (type, data)
    Email->>Email: load template, populate data
    alt attachments needed
        Email->>PDF: generate rent notice / invoice
        PDF-->>Email: PDF attachment
    end
    Email->>SMTP: send (Gmail / Mailgun / SMTP)
    SMTP-->>Email: delivery status
```

## Tenant Lifecycle

1. Create tenant with lease, property, expenses → rent computation triggered
2. Monthly: view rents, record payments → settlements applied, balance updated
3. Generate/send notices and receipts via emailer + pdfgenerator
4. Terminate lease (set termination date) → tenant marked terminated, property vacant

## First Access / Onboarding

1. User signs up → account created
2. First login → redirected to `/firstaccess`
3. Fill landlord info (name, company details) → Organization (Realm) created
4. Dashboard shows first-connection wizard: create lease → add property → add tenant

## Token Refresh

Access tokens expire after ~5 minutes. The frontend interceptor (`fetch.js`) automatically calls `/refreshtoken` with the refresh token cookie. New access token returned. If refresh token expired, user redirected to `/signin`.
