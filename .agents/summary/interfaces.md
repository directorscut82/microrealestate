# MicroRealEstate — APIs & Interfaces

## Landlord API

**Service:** `services/api` · **Port:** 8200

All routes prefixed `/api/v2/`. Requires `Authorization: Bearer {accessToken}` header and `organizationId` header.

### Tenants (Occupants)

| Method | Path | Description |
|--------|------|-------------|
| GET | /tenants | List all tenants for realm |
| GET | /tenants/:id | Get tenant by ID |
| POST | /tenants | Create tenant |
| POST | /tenants/import-pdf | Import tenant from Greek AADE lease PDF (multipart/form-data) |
| PATCH | /tenants/:id | Update tenant (triggers rent recomputation) |
| DELETE | /tenants/:id | Delete tenant (422 if has payments, active lease, or unpaid balance) |

### Properties

| Method | Path | Description |
|--------|------|-------------|
| GET | /properties | List properties |
| GET | /properties/:id | Get property |
| POST | /properties | Create property |
| PATCH | /properties/:id | Update property |
| DELETE | /properties/:id | Delete property (422 if occupied) |

### Leases

| Method | Path | Description |
|--------|------|-------------|
| GET | /leases | List lease templates |
| GET | /leases/:id | Get lease |
| POST | /leases | Create lease template |
| PATCH | /leases/:id | Update lease |
| DELETE | /leases/:id | Delete lease (422 if used by tenants) |

### Rents

| Method | Path | Description |
|--------|------|-------------|
| GET | /rents/:year | Get rents for year |
| GET | /rents/:tenantId/:term | Get specific rent |
| PATCH | /rents/payment/:id/:term | Record payment |

### Documents & Templates

Proxied to the pdfgenerator service.

| Method | Path | Description |
|--------|------|-------------|
| GET | /documents/:id | Get document |
| POST | /documents | Generate document |
| GET | /templates | List templates |
| POST | /templates | Create template |

### Organizations

| Method | Path | Description |
|--------|------|-------------|
| GET | /realms | List user's organizations |
| GET | /realms/:id | Get organization |
| PATCH | /realms/:id | Update organization |
| POST | /realms/:id/members | Add member |
| DELETE | /realms/:id/members/:memberId | Remove member |

### Presence

Uses Redis with 60-second TTL.

| Method | Path | Description |
|--------|------|-------------|
| POST | /presence/:type/:id | Register viewer |
| GET | /presence/:type/:id | Get current viewers |

### Accounting

| Method | Path | Description |
|--------|------|-------------|
| GET | /accounting/:year | Get accounting data for year |

---

## Authenticator API

**Port:** 8000

| Method | Path | Description |
|--------|------|-------------|
| POST | /signin | Login with email/password |
| POST | /signup | Register new account |
| POST | /signout | Logout (invalidate refresh token) |
| POST | /forgotpassword | Send reset email |
| POST | /resetpassword | Reset with token |
| POST | /refreshtoken | Get new access token |

---

## Tenant API

**Port:** 8250 · Authenticated via `sessionToken` cookie.

| Method | Path | Description |
|--------|------|-------------|
| POST | /signin | Tenant sign-in (magic link / OTP) |
| GET | /tenants | Get tenant's own data |
| GET | /rents | Get tenant's rent history |
| GET | /documents | Get tenant's documents |

---

## Reset Service API

**Port:** 8900 · **Non-production only.**

| Method | Path | Description |
|--------|------|-------------|
| DELETE | / | Wipe entire database |
| POST | /seed | Create user + org + leases + properties + tenants |
| POST | /otp | Generate tenant OTP directly |

---

## Internal Service Communication

Services communicate via HTTP over the Docker bridge network:

- **API** → emailer — sends tenant/landlord emails and SMS notifications
- **API** → pdfgenerator — generates documents and templates
- **Authenticator** → emailer — sends password reset emails

## Authentication Headers

| Header / Token | Used By | Purpose |
|----------------|---------|---------|
| `Authorization: Bearer {accessToken}` | Landlord API | Identifies authenticated user |
| `organizationId: {realmId}` | Landlord API | Identifies current organization |
| `sessionToken` cookie | Tenant API | Identifies authenticated tenant |
