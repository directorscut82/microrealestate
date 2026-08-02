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

## 2. Storage (Backblaze B2) — PERSISTS uploaded file-documents

Section: **«Backblaze B2 Cloud Storage»**. 4 fields: `KeyId`, `ApplicationKey`, `Bucket`, `Bucket endpoint`.

- **This is what actually SAVES uploaded file-documents** (signed leases, payment proofs, scanned bills — anything the landlord attaches via `POST /api/v2/documents/upload`). `services/pdfgenerator/src/routes/documents.ts` gates upload/download/delete on `s3.isEnabled(realm.thirdParties.b2)`: configured → B2, not configured → local disk under `UPLOADS_DIRECTORY`. (Note: on-the-fly *rendered* receipt/rentcall PDFs are generated per request; it's these attached files that B2 persists.)
- Generate: backblaze.com → B2 Cloud Storage (free tier 10 GB, effectively free at this volume) → create a **bucket** (Private) → **App Keys → Add a New Application Key** scoped to that bucket, **Read and Write** (do NOT use the all-powerful Master key) → gives **keyID + applicationKey** (shown once — copy immediately). Endpoint is the S3-compatible host shown on the bucket page, e.g. `s3.eu-central-003.backblazeb2.com`.
- Verify a key BEFORE trusting the UI "saved" toast: a real S3 put/get/delete round-trip (boto3 or aws-sdk against the endpoint) is the only proof the key + bucket + endpoint agree. Then upload a real file via `POST /api/v2/documents/upload` (multipart: `folder`, `fileName`, `file`) → a `201` with a Backblaze `versionId` means the app writes to B2 end-to-end.

## 3. SMS gateway (optional)

Section: **«SMS Gateway»**. Fields: `Server URL`, `Username`, `Password`, `SMS Country Code` (e.g. `+30`). Generic HTTP SMS gateway.

## 4. Telegram notifications (push / admin self-notify) — chosen messenger

Section: **«Ειδοποιήσεις Telegram»**. 2 fields: `Bot token`, `Admin chat ID`. `botToken` is encrypted at rest (realmmanager, `botTokenUpdated` flag — same preserve-on-resave pattern as the SMS password). The app posts to `https://api.telegram.org/bot<token>/sendMessage`; reader/sender code: `services/emailer/src/telegram.ts` (`sendTelegram`), api proxy `emailmanager.sendTelegramNotification` → `POST /api/v2/emails/telegram`.

**Why Telegram** (not WhatsApp/Viber/Signal): free, no business verification, setup is two pasted values. WhatsApp needs a Meta Business account + verified templates; Viber a partner account; Signal has no bot API (self-host signal-cli).

**Generate (2 steps, ~30s, FREE):**
1. In Telegram, search **@BotFather** (blue ✓) → `/newbot` → name + a username ending in `bot` → he replies with a **bot token** (`123456:ABC-…`).
2. Open your new bot and **send it any message** (bots can't message you until you message them first). Then the **chat id** is fetched from `https://api.telegram.org/bot<token>/getUpdates` → `result[].message.chat.id`.

**Scope today:** admin/self-notifications to `adminChatId` (the plumbing + the `/rents` "Telegram: configured" banner). Per-tenant delivery (storing each tenant's chat id) and automated triggers (overdue-rent alerts) are future extensions — the channel and the send path exist; nothing schedules them yet.

**Verify:** `curl -s "https://api.telegram.org/bot<token>/getMe"` → `ok:true` proves the token; a real `sendMessage` to the chat id (200 `ok:true`) proves the whole loop.

## 5. Mail reading (auto-detect incoming bills) — MULTIPLE mailboxes

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
| Telegram | botToken, adminChatId | @BotFather + getUpdates (above) |
| Mail reader (per mailbox) | email, clientId, clientSecret, refreshToken | Google Cloud + OAuth playground (above) |

**Already-generated creds (local, gitignored — never commit):**
- `.secrets/gmail-oauth-e2elandlord82` — e2elandlord82@gmail.com READER creds (project `microrealestate-502214`, Web OAuth client, refresh token verified working + app Published so it's permanent). Enter these 5 values in Settings → Mail reading, or read them for any future inbox-poller.
- `.secrets/gmail-send-e2elandlord82` — e2elandlord82@gmail.com SENDING creds (Gmail App Password + from/reply-to). Verified: a real SMTP send succeeded (`250 OK`).
- `.secrets/sms-gateway-sms-gate-app` — SMS-Gate for Android (sms-gate.app) device creds, BOTH modes (Local LAN + Cloud relay). NAS uses **Cloud** (`https://api.sms-gate.app`); the account name and password are in that file — **do not repeat either in any tracked doc.** This doc used to print the username inline, which published half the credential in a public repo for no benefit. Verified: a real SMS sent through the app (`POST /api/v2/emails/sms`) reached the phone, state `Delivered`. The realm `smsGateway.url` is the BASE url only — the emailer appends `/3rdparty/v1/messages`.
- `.secrets/b2-microrealestate` — Backblaze B2 storage (bucket `MicroRealEstateDocuments`, endpoint `s3.eu-central-003.backblazeb2.com`, bucket-scoped Read+Write key). Verified: real S3 round-trip + a real app upload (`201` + Backblaze `versionId`).
- `.secrets/telegram-microrealestate-bot` — Telegram bot **@MicroRealEstateBot** (`botToken` + `adminChatId`). Verified: a real `sendMessage` reached the phone (`ok:true`). Enter both in Settings → Ειδοποιήσεις Telegram.
- `.secrets/landlord-account`, `.secrets/comprehensive-test-account` — realm admin logins.
- `.secrets/portainer-token` — NAS Portainer API (deploy/inspect).

---

# DISASTER RECOVERY — back-fill everything after a reset

> Read this if the DB was wiped, a realm/account was deleted, or you're standing up a fresh instance. Order matters. Secrets live in `.secrets/` (gitignored) — this doc references them by filename, never by value.

## Who does the back-fill — AGENT-AUTONOMOUS by default

**An agent can restore all of this WITHOUT the user entering anything, PROVIDED two conditions hold:**
1. the `.secrets/` files still exist (they hold every credential value), AND
2. `CIPHER_KEY` is unchanged (see below).

The agent reads each value from `.secrets/` and writes it either by **calling the API** (preferred — no browser needed) or by driving the UI with Playwright. Both run `Crypto.encrypt`, so the stored secret is valid.

**The agent CANNOT self-serve only these (require the user + Google/provider login):**
- Regenerating a Gmail **App Password** or the OAuth **Client ID/secret/refresh token** — only if `.secrets/` is LOST. If `.secrets/` survives, no regeneration needed; the agent just re-enters the existing values. (Refresh token is permanent since the app is Published — see §Mail reading.)
- Creating a Backblaze/SMS account from scratch.

So: **secrets present → fully agent-autonomous. Secrets lost → user regenerates at Google/provider, then agent enters them.**

### Agent method (API, no browser) — the fast path

Sign in, then `PATCH /api/v2/realms` with the realm `_id` + a `thirdParties` block; the api encrypts on write. Read the values from the `.secrets/` files named in each step below. Example shape (values from `.secrets/gmail-send-*` and `.secrets/gmail-oauth-*`):
```
PATCH /api/v2/realms   (Authorization: Bearer <token>, organizationid: <realmId>)
{ "_id": "<realmId>",
  "thirdParties": {
    "gmail":       { "selected": true, "email": "…", "appPassword": "…", "appPasswordUpdated": true, "fromEmail": "…", "replyToEmail": "…" },
    "mailReaders": [ { "provider":"gmail", "email":"…", "clientId":"…", "clientSecret":"…", "clientSecretUpdated": true, "refreshToken":"…", "refreshTokenUpdated": true, "label":"" } ]
  } }
```
The `*Updated: true` flags tell realmmanager to encrypt the supplied value (omit/false → it preserves the previously-stored encrypted value). Then run the §Step 4 verify. (UI back-fill in §Step 3 is the equivalent manual path.)

## CRITICAL: the encryption key must not change

Every third-party secret (`gmail.appPassword`, `mailReaders[].clientSecret/refreshToken`, `smtp.password`, `mailgun.apiKey`, `b2.*`, `smsGateway.password`, `telegram.botToken`) is **AES-256-GCM encrypted with `CIPHER_KEY`**. On NAS that key is in `docker-compose.nas.yml` (local-only, NOT committed) under each service's env.

- **If `CIPHER_KEY` stays the same:** existing encrypted secrets in mongo keep decrypting; nothing to redo.
- **If `CIPHER_KEY` changes / is regenerated:** ALL previously-stored secrets become undecryptable garbage. You must re-enter every third-party secret via the UI (which re-encrypts with the new key). So: **do not regenerate `CIPHER_KEY` unless you intend to re-enter all secrets.**
- **Consequence for back-fill:** third-party secrets can ONLY be restored through the **UI or the `PATCH /api/v2/realms` API** (both run `Crypto.encrypt`). A raw `mongo` insert of plaintext will store an unencrypted string that `decrypt()` then throws on → email/reading silently fails. NEVER seed thirdParties secrets by direct mongo write.

## Settings → Database backup/restore — what it does and doesn't cover

The JSON backup (`Settings → Database → Save backup`, `GET /api/v2/database/backup`) exports ALL 10 per-realm collections: realms, leases, occupants, properties, buildings, templates, documents, emails, bills. Embedded money data (tenant `rents[]`, building `ownerMonthlyExpenses[]`, `uncollectedPayments[]`, repairs, units) rides inside occupants/buildings — nothing money-related is lost. Verified July 2026.

- **Third-party secrets ARE in the backup** — inside the realm doc as AES-256-GCM **ciphertext**. Restoring on the SAME deployment (same `CIPHER_KEY`): everything works, nothing to re-enter. Restoring on a rebuilt deployment with a NEW `CIPHER_KEY`: the settings restore but decrypt to garbage → re-enter from `.secrets/` per Step 3 above. **Back up `docker-compose.nas.yml` (holds CIPHER_KEY) alongside the JSON backup to avoid this entirely.**
- **`accounts` is intentionally NOT in the backup** (global collection, no realmId). On a fresh instance restore the login first (Step 1 above), then restore the JSON.
- **Uploaded file BYTES are NOT in the backup** — only the Document records (name, B2 key, versionId). The bytes live in B2 under stable keys, so a same-bucket restore re-links them.
- **Restore reconciles B2 in DRY-RUN** (July 2026, `2dba43c0`, hardened by audit-2026-07 D1): after the mongo wipe-and-insert it calls `POST /api/v2/documents/reconcile-storage` with `{"dryRun":true}`, which diffs B2 objects under the realm prefix against `Document.url` + repair `invoiceDocumentId` + Bill URLs and **reports** unreferenced files and missing bytes — it **never deletes anything automatically** (restoring an older backup makes every file uploaded since then "unreferenced"; auto-deleting them would be permanent data loss). The Settings UI toasts both counts. Actual cleanup is a deliberate, admin-only call: `POST /documents/reconcile-storage {}` (no dryRun) — administrator role required, objects modified in the last 10 minutes are never deleted (in-flight-upload guard).
- Renames are safe across backups: rename only changes `Document.name` (the B2 key is immutable), so a restore reverts the label at most, never breaks the download.
- Redis (sessions/OTP) is not backed up — by design; users just sign in again.

## Step 1 — Account (login) restoration

Accounts (`accounts` collection) hold a **bcrypt** password hash, not plaintext.
- **Normal path:** sign up via the UI/authenticator (`POST /api/v2/authenticator/landlord/signup`) with the email+password from `.secrets/landlord-account` (or `comprehensive-test-account`). This creates the account + bcrypt hash correctly.
- **If the account row is missing/corrupt:** reset the hash directly. `mre-mongo-1` is mongo 4.4 (`mongo` shell). Generate the hash inside a node container: `bcrypt.hash('<password from .secrets>', 10)`, then `db.accounts.updateOne({email:'...'},{ $set:{ password:'<hash>' }})`. (See the CLAUDE.md "signin 500" triage — this is the documented bcrypt path.)

Known accounts (passwords in `.secrets/`): `e2elandlord82@gmail.com` → `.secrets/landlord-account`; `seed@example.com` → `.secrets/comprehensive-test-account`.

## Step 2 — Realm restoration

A realm is created via the UI (first-run onboarding) or `POST /api/v2/realms` as the signed-in account. Landlord realm should be **name `landlord`, locale `el`, currency `EUR`**, member `e2elandlord82@gmail.com` (administrator). If the realm exists but is empty of buildings/tenants (the usual "reset" state), skip this — just re-add data.

## Step 3 — Third-party services (UI back-fill) — the whole point of this doc

Sign in as the realm admin → **Ρυθμίσεις → Πάροχοι τρίτων** and re-enter, reading values from `.secrets/`:

1. **Email delivery → Gmail** (from `.secrets/gmail-send-e2elandlord82`): toggle on, pick Gmail, `Email` = EMAIL, `Κωδικός εφαρμογής` = APP_PASSWORD, `Από Email` = FROM_EMAIL, `Απάντηση σε email` = REPLY_TO_EMAIL. Save.
2. **Backblaze B2** (from `.secrets/b2-microrealestate`): keyId / applicationKey / bucket / endpoint. **This is what persists uploaded file-documents** — without it uploads fall back to local disk.
3. **SMS Gateway** (from `.secrets/sms-gateway-sms-gate-app`): url (BASE only) / username / password / countryCode. NAS uses the Cloud creds.
4. **Ειδοποιήσεις Telegram** (from `.secrets/telegram-microrealestate-bot`): toggle on, `Bot token` = BOT_TOKEN, `Admin chat ID` = ADMIN_CHAT_ID. Save.
5. **Ανάγνωση email (mail readers)** (from `.secrets/gmail-oauth-e2elandlord82`): toggle on, Γραμματοκιβώτιο 1 → Email = EMAIL, Client ID = CLIENT_ID, Client secret = CLIENT_SECRET, Refresh token = REFRESH_TOKEN, Label optional. «+ Προσθήκη γραμματοκιβωτίου» for more mailboxes. Save.

## Step 4 — Verify (don't trust "saved")

- **Config persisted:** query mongo (values stay masked/encrypted) — `db.realms.findOne({_id:ObjectId('<realmId>')},{thirdParties:1})` → `gmail.selected:true`, `gmail.appPassword` set, `mailReaders[0].{clientId,clientSecret,refreshToken}` set.
- **Sending actually works:** raw SMTP test with nodemailer using EMAIL+APP_PASSWORD (`service:'gmail'`) → `transport.verify()` + `sendMail` should return `250 OK`. (This is the real end-to-end check; a saved config that fails auth is common with a wrong/expired App Password or 2FA off.)
- **Reading creds valid:** `POST https://oauth2.googleapis.com/token` with `client_id/client_secret/refresh_token/grant_type=refresh_token` → 200 + `access_token` means the refresh token is live.

## Step 5 — Data back-fill (buildings/tenants/etc.)

App data is NOT encrypted and can be seeded either via the app UI or, for bulk/malformed-legacy fixtures, direct `mongo` insert into `buildings`/`occupants`/`properties`/`leases` (keyed by `realmId` as a **string**, not ObjectId — see the reset scripts). The comprehensive-test realm has a seeder: `scripts/seed-comprehensive.py` (creds in `.secrets/comprehensive-test-account`).

## Quick reference — what lives where

| Thing | Where | Notes |
|---|---|---|
| Realm/account logins | `.secrets/landlord-account`, `.secrets/comprehensive-test-account` | plaintext, local only |
| Gmail send | `.secrets/gmail-send-e2elandlord82` | App Password |
| Gmail read (OAuth) | `.secrets/gmail-oauth-e2elandlord82` | client id/secret/refresh token |
| NAS Portainer token | `.secrets/portainer-token` | deploy/inspect |
| `CIPHER_KEY` (encrypts all thirdParties secrets) | `docker-compose.nas.yml` (local, uncommitted) | do NOT change without re-entering all secrets |
| Third-party secrets (encrypted) | mongo `realms.thirdParties` | via UI/API only, never raw insert |
