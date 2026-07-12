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

### How to generate Client ID / Client secret / Refresh token (one-time, FREE, per Google account)

**Cost:** all steps are free — no billing account or card required. Gmail API's free quota (≈1B units/day) is far beyond reading one inbox.

**IMPORTANT (2025 rebrand):** Google renamed **"APIs & Services → OAuth consent screen"** to **"Google Auth platform"**. If the old paths aren't there, that's why. Verified against Google's live docs (developers.google.com/workspace/guides/configure-oauth-consent and .../create-credentials, 2025). The Cloud Console **search bar** is the reliable navigator — type "Gmail API", "Google Auth platform", or "Clients".

At console.cloud.google.com (create/select a project first, top bar → project picker → New Project):

1. **Enable the API:** menu → **APIs & Services → Library** → search **Gmail API** → **Enable**.
2. **Configure Google Auth platform:** menu → **Google Auth platform → Branding** → if "not configured yet", **Get Started** →
   - **Branding / App Information:** App name + User support email → **Next**.
   - **Audience:** choose **External** (Internal is only offered on a paid Google **Workspace** domain; a personal @gmail.com must use External) → **Next**.
   - **Contact Information:** your email → **Next** → **Finish** → agree → **Create**.
3. **Add yourself as a test user:** **Google Auth platform → Audience → Test users → Add users** → your Gmail → **Save**. (Skips Google's verification review for personal use.)
4. **Add the read scope:** **Google Auth platform → Data Access → Add or Remove Scopes** → add `https://www.googleapis.com/auth/gmail.readonly` → **Update/Save**.
5. **Create the OAuth client — MUST be "Web application", NOT "Desktop app"** (a Desktop client only allows `http://localhost` redirects → the OAuth Playground fails with `Error 400: redirect_uri_mismatch`). **Google Auth platform → Clients → Create Client** → Application type **Web application** → name it → under **Authorized redirect URIs → Add URI** paste exactly `https://developers.google.com/oauthplayground` (leave "Authorized JavaScript origins" empty) → **Create** → copy **Client ID** + **Client secret**.

**Refresh token** — consent once with that client:
- developers.google.com/oauthplayground → gear (top-right) → tick **"Use your own OAuth credentials"** → paste the Web client's Client ID + secret → Step 1: left panel select scope `https://www.googleapis.com/auth/gmail.readonly` → **Authorize APIs** → sign in as that Gmail, Allow → Step 2: **"Exchange authorization code for tokens"** → copy the **Refresh token**. (Step 3 "Configure request" is an optional test — skip it.)

Scope `gmail.readonly` = read-only (list/read messages, filter by sender e.g. ΔΕΗ), cannot send/delete. Repeat per mailbox. To verify a saved refresh token works, `POST https://oauth2.googleapis.com/token` with `client_id/client_secret/refresh_token/grant_type=refresh_token` → a 200 with `access_token` means it's good.

**Token longevity — two DIFFERENT limits, don't confuse them:**
- *Playground 24h revocation:* only applies if you used the Playground's OWN credentials. If you ticked "Use your own OAuth credentials" (as above), this does NOT apply.
- *Testing-mode 7-day expiry:* while the app is in **"Testing"** status, the refresh token expires after ~7 days. Fix: **Google Auth platform → Audience → Publish app** → confirm "push to production". The warning "Your app will be available to any user with a Google Account" is benign here — the app is unlisted and only usable by whoever holds the (secret) Client ID+secret; publishing just removes the 7-day expiry. A sensitive scope (`gmail.readonly`) would show external users an "unverified app" screen, but for your own single account you click through it, no verification submission needed. Publishing does NOT invalidate an already-working refresh token (verified). Internal/Workspace apps have neither limit.

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

**Already-generated creds (local, gitignored — never commit):**
- `.secrets/gmail-oauth-e2elandlord82` — e2elandlord82@gmail.com reader creds (project `microrealestate-502214`, Web OAuth client, refresh token verified working + app Published so it's permanent). Enter these 5 values in Settings → Mail reading, or read them for any future inbox-poller.
- Other secrets alongside it: `.secrets/portainer-token`, `.secrets/landlord-account`, `.secrets/comprehensive-test-account`.
