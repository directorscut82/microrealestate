# Third-party services setup (email, storage, SMS, mail-reading)

> Everything here is configured **from the landlord UI**: **Ρυθμίσεις → Πάροχοι τρίτων** (`/{org}/settings/thirdparties`), rendered by `webapps/landlord/src/components/organization/ThirdPartiesForm.js`. Values save to `realm.thirdParties` (secrets encrypted at rest by `services/api/src/managers/realmmanager.ts` via `Crypto.encrypt`; the API returns `**********` placeholders and only re-encrypts a secret when its `*Updated` flag is true, so re-saving the form never wipes or double-encrypts an untouched secret). No container env vars are needed for any of this — the emailer/pdfgenerator read `realm.thirdParties` at runtime.
>
> **This is the source of truth for reconfiguring after a reset.** Each section lists the exact UI fields and where to generate the values.

## 1. Email delivery (SENDING) — pick ONE provider

Section: **«Υπηρεσία αποστολής email»**. Toggle on, choose Gmail / SMTP / Mailgun, fill From/Reply-to. The emailer container already has `ALLOW_SENDING_EMAILS=true`, so a saved provider sends immediately.

- **Gmail** (2 fields): `Email` + `Application password`.
  - Generate the App Password: a Google account with **2-Step Verification ON** → myaccount.google.com/apppasswords → create → 16-char password. (Regular account password will NOT work.)
- **SMTP** (server/port/secure/auth/username/password) — any SMTP host.
- **Mailgun** (Private API key + domain) — from a verified Mailgun domain.

Reader code: `services/emailer/src/emailengine.ts` (`_selectEmailDeliveryService` reads `realm.thirdParties.{gmail,smtp,mailgun}`; decrypts the secret; `gmail`/`smtp` → nodemailer SMTP, `mailgun` → mailgun transport).

## 2. Storage (Backblaze B2) — PERSISTS generated PDFs

Section: **«Backblaze B2 Cloud Storage»**. 4 fields: `KeyId`, `ApplicationKey`, `Bucket`, `Bucket endpoint`.

- **This is what actually SAVES the generated PDFs.** `services/pdfgenerator/src/utils/s3.ts` uploads to B2 only when b2 is configured; without it, PDFs are generated on the fly and **not stored**.
- Generate: backblaze.com → B2 Cloud Storage (free tier 10 GB) → create a **bucket** → **App Keys → Add a New Application Key** (scoped to that bucket) → gives **keyID + applicationKey** (shown once). Endpoint is the S3-compatible host shown on the bucket, e.g. `s3.eu-central-003.backblazeb2.com`.

## 3. SMS gateway (optional)

Section: **«SMS Gateway»**. Fields: `Server URL`, `Username`, `Password`, `SMS Country Code` (e.g. `+30`). Generic HTTP SMS gateway.

## 4. Mail reading (auto-detect incoming bills) — MULTIPLE mailboxes

Section: **«Ανάγνωση email (αυτόματος εντοπισμός λογαριασμών)»**. A repeatable list — **«+ Προσθήκη γραμματοκιβωτίου»** adds another account. This is for READING an inbox (e.g. auto-detecting ΔΕΗ/utility bills → run through the bill parser → notify in-app). Separate from §1 (sending). Uses the **Gmail API (read-only)**, so it needs OAuth credentials, NOT an App Password.

Per mailbox, 5 fields: `Email`, `Label (optional)`, `Client ID`, `Client secret`, `Refresh token`. `clientSecret`/`refreshToken` are encrypted at rest; matched to the prior reader by `email` on re-save so untouched secrets survive.

### How to generate Client ID / Client secret / Refresh token (one-time, free, per Google account)

**Client ID + Client secret** — at console.cloud.google.com:
1. Create a project (top bar → New Project).
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → **External** → app name + your email; under **Test users** add your own Gmail (this avoids Google's verification review since it's just you).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID → type "Desktop app"** → copy the **Client ID** + **Client secret**.

**Refresh token** — consent once with that client:
- developers.google.com/oauthplayground → gear (top-right) → tick **"Use your own OAuth credentials"** → paste Client ID + secret → left panel select scope `https://www.googleapis.com/auth/gmail.readonly` → **Authorize APIs** → sign in as that Gmail, Allow → **"Exchange authorization code for tokens"** → copy the **Refresh token**.

Scope `gmail.readonly` = read-only (list/read messages, filter by sender e.g. ΔΕΗ), cannot send/delete. Repeat per mailbox.

> **NOTE (status):** the UI + storage schema for mail-readers exists; the actual inbox-polling/bill-detection worker is NOT yet implemented — the fields capture the credentials so the feature can be built against them. Near-real-time delivery would use Gmail push (watch → Pub/Sub) rather than polling.

## Data model + code anchors

- Schema: `services/common/src/collections/realm.ts` → `thirdParties.{gmail,smtp,mailgun,b2,smsGateway,mailReaders[]}`.
- Types: `types/src/common/collections.ts` → `Realm.thirdParties`.
- Encryption/redaction: `services/api/src/managers/realmmanager.ts` (`_escapeSecrets`, the `add`/`update` handlers; per-secret `*Updated` flag preserves untouched values).
- Form: `webapps/landlord/src/components/organization/ThirdPartiesForm.js`.
- Bill parser (what a read bill would feed): `services/api/src/managers/billparser/index.ts` (`parseBillPdf`, `generateIrisQr`), `billmanager.ts` (`parseBills` → `POST /api/v2/bills`, multer ≤5 files). QR = `rfCode + paymentCode` PNG (verified scannable in a real IRIS banking app against a real ΔΕΗ bill).

## Keys inventory (fill in after configuring; store secrets in `.secrets/`, NEVER commit)

| Service | Field | Where generated |
|---|---|---|
| Gmail send | email, appPassword | Google App Passwords (2FA on) |
| SMTP | server, port, username, password | your SMTP host |
| Mailgun | apiKey, domain | Mailgun dashboard |
| Backblaze B2 | keyId, applicationKey, bucket, endpoint | backblaze.com B2 |
| SMS | url, username, password, countryCode | SMS gateway provider |
| Mail reader (per mailbox) | email, clientId, clientSecret, refreshToken | Google Cloud + OAuth playground (above) |
