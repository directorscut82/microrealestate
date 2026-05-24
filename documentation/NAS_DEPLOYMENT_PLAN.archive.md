# [ARCHIVED] MRE → Synology DS920+ NAS Deployment — Revised Plan

> **This is a historical execution plan.** The work described here is complete.
> For the current workflow, see [DEV_AND_DEPLOY.md](./DEV_AND_DEPLOY.md).
> Kept for reference (decisions made, why we did what we did).

**Target:** Self-hosted MicroRealEstate on Synology DS920+ via Portainer stack,
accessed on port **1350** via LAN and Tailscale.

**Starting point:** Fresh NAS deployment, no existing data to migrate.

**Workflow principle:** One step at a time. I execute, then stop at each
checkpoint and show you the result before moving on. You approve, we continue.

---

## Overview

| Phase | Summary | Who | Duration |
|-------|---------|-----|----------|
| A | Local git preparation (safety tag + authorship rewrite) | Me, with your approval | 5 min |
| B | Create empty GitHub repo under your account | You | 1 min |
| C | Remote reconfig, strip failing CI jobs, push to fork | Me | 5 min |
| D | GitHub Actions builds 8 Docker images | Automatic | ~10 min wait |
| E | Create `/volume1/docker/mre` folder on NAS | You | 30 sec |
| F | Generate secrets, write NAS compose file | Me | 2 min |
| G | Write `NAS_DEPLOYMENT.md` user guide | Me | 3 min |
| H | Deploy stack in Portainer, create admin account | You | 15-20 min |

Total hands-on time: ~30 min of your attention, ~1 hour wall-clock including CI
and image pull wait.

---

## Key Decisions (Locked)

- **Fork:** `github.com/directorscut82/microrealestate` (public repo)
- **Git identity for new commits:** `directorscut82 <devilblaster82@gmail.com>`
- **Commit authorship rewrite:** all commits on `feature/pdf-import-sms-gateway`
  are rewritten to the identity above (original timestamps and messages preserved)
- **Port on NAS:** `1350` (adjacent to SnapOtter's `1349`)
- **Host port mapping:** Gateway container port 8080 → NAS host port 1350
- **Tenant frontend:** DROPPED from both CI build matrix and NAS compose
- **Reset service:** only exists for dev/CI, DROPPED from NAS compose
- **Caddy reverse proxy:** DROPPED — Tailscale handles remote access
- **GHCR package visibility:** public (matches SnapOtter-style simplicity)
- **CI jobs on fork:** `deploy`, `healthcheck`, `test` stripped (they need
  infrastructure secrets that don't exist on your fork). Only `lint` and
  `build-push-images` remain.
- **Database:** fresh MongoDB 4.4 on the NAS (AVX-free, J4125-compatible)
- **Admin signup:** stays `true` during initial setup. You can flip to `false`
  after creating your account if you want extra safety, but it's optional.

## Memory Budget (NAS running MRE)

All values are `mem_limit` ceilings, NOT reservations. Actual idle usage is
30-40% of these numbers. Under load spikes toward the limits.

| Container | mem_limit | Idle | Active |
|-----------|-----------|------|--------|
| mongo | 512 MB | ~150 MB | ~250 MB |
| redis | 128 MB | ~15 MB | ~30 MB |
| gateway | 192 MB | ~70 MB | ~120 MB |
| authenticator | 192 MB | ~90 MB | ~130 MB |
| api | 384 MB | ~130 MB | ~220 MB |
| tenantapi | 192 MB | ~90 MB | ~130 MB |
| emailer | 192 MB | ~90 MB | ~130 MB |
| pdfgenerator | 768 MB | ~60 MB | ~500 MB (during render) |
| landlord-frontend | 384 MB | ~180 MB | ~280 MB |
| **Total** | **~2.9 GB ceiling** | **~880 MB** | **~1.8 GB** |

Adds ~10-20% to your NAS RAM usage idle. Leaves 5+ GB free for DSM, Plex, etc.

---

## Dropped Components (Will Not Exist on NAS)

| Component | Why dropped |
|-----------|-------------|
| `tenant-frontend` container | Not needed for personal single-landlord use |
| `tenant-frontend` CI image build | Don't pay CI time for an unused image |
| `resetservice` | Dev/test only, never for production |
| `reverse-proxy` (Caddy) | Tailscale provides remote access; DSM already on ports 80/443 |
| CI `deploy` job | Needs SSH secrets that don't exist on your fork |
| CI `healthcheck` job | Depends on `deploy` job output |
| CI `test` (Cypress e2e) job | Needs deployed environment |

---

## Phase A — Local Git Preparation

### A1. 🤖 Verify git state and create safety tag

**What I do:**
```
git status                         # verify clean working tree
git tag backup/pre-nas-rewrite     # anchor the pre-rewrite state
```

**Why:** If the authorship rewrite goes wrong, `git reset --hard backup/pre-nas-rewrite`
returns everything to exactly where it is now. Zero-risk undo.

**Shown to you:** tag created + current commit SHA.

### A2. 🤖 List all distinct commit authors

**What I do:**
```
git log --format='%an <%ae>' | sort -u
```

**Why:** You see exactly which name/email combos appear in history so you can
confirm the rewrite scope.

### A3. ⏸️ CHECKPOINT — you approve rewrite scope

I paste the author list. You say **"rewrite all"** or specify exceptions.

### A4. 🤖 Configure local git identity (repo-scoped only)

**What I do:**
```
git config user.name  "directorscut82"
git config user.email "devilblaster82@gmail.com"
```

**Why:** All future commits in this repo will be authored by you. Your global
git config (other projects) is untouched.

### A5. 🤖 Rewrite commit authorship

**What I do:** use `git filter-repo` (installing via Homebrew if needed) to
rewrite every commit's author and committer fields to your identity. Commit
messages, timestamps, and file contents stay identical. Only SHAs change.

**Why:** So when this lands on GitHub, every commit shows your avatar and
counts toward your GitHub contribution graph.

### A6. ⏸️ CHECKPOINT — you verify rewritten log

I show `git log --oneline -10` and `git log --format='%an <%ae>' -5`. You
confirm all commits now show `directorscut82 <devilblaster82@gmail.com>`.

---

## Phase B — GitHub Fork Creation (You)

### B1. 👤 You create an empty repo

1. Open https://github.com/new
2. **Owner:** `directorscut82`
3. **Repository name:** `microrealestate`
4. **Description:** (anything you like, or leave blank)
5. **Visibility:** Public
6. **Do NOT check** any of:
   - [ ] Add a README
   - [ ] Add .gitignore
   - [ ] Choose a license
   (Repo must be completely empty for us to push into it cleanly.)
7. Click **Create repository**

### B2. ⏸️ CHECKPOINT

You paste the URL of the new repo so I can confirm it exists and matches
`https://github.com/directorscut82/microrealestate`.

---

## Phase C — Remote Reconfiguration & Push

### C1. 🤖 Rename current remote origin → upstream

**What I do:**
```
git remote rename origin upstream
```

**Why:** Keeps the public MRE project URL accessible as `upstream` for future
syncs (`git fetch upstream`). Your fork becomes `origin`.

### C2. 🤖 Add your fork as new origin

**What I do:**
```
git remote add origin https://github.com/directorscut82/microrealestate.git
git remote -v        # confirm both remotes are correct
```

### C3. 🤖 Create `master` from feature branch

**What I do:**
```
git checkout -b master feature/pdf-import-sms-gateway
```

**Why:** Your fork's default branch will be `master` (matches upstream naming).
Feature branch contents become master. No merge commit, clean history.

### C4. 🤖 Strip failing CI jobs

**What I do:** Edit `.github/workflows/ci.yml` to:
- Remove `deploy` job
- Remove `healthcheck` job
- Remove `test` job
- Remove `tenant-frontend` from `build-push-images` matrix
- Keep `setup`, `lint`, `build-push-images` (with 8 services)

Commit: `ci: strip deploy/test jobs and tenant-frontend for personal fork`

### C5. ⏸️ CHECKPOINT — review CI changes

I show you the final `ci.yml`. You approve before I push.

### C6. 👤 Authenticate local git to GitHub

I'll walk you through this when we reach it. Either:
- **Option 1 (recommended):** install GitHub CLI and run `gh auth login` (browser flow)
- **Option 2:** create a classic Personal Access Token at
  https://github.com/settings/tokens/new with scopes `repo` + `write:packages`,
  and let git prompt for it on push (it saves to macOS keychain after first use).

### C7. 🤖 Push master to fork

**What I do:**
```
git push -u origin master
```

### C8. ⏸️ CHECKPOINT

You open `https://github.com/directorscut82/microrealestate` in browser and
confirm commits appear. Click **Actions** tab to see the CI workflow running.

---

## Phase D — CI Image Build (Wait)

### D1. ⏸️ Wait ~10 minutes

Monitor at https://github.com/directorscut82/microrealestate/actions.

Expected jobs:
- `setup` (30s)
- `lint` (1-2 min)
- `build-push-images` — 8 parallel matrix jobs (~8-10 min)

### D2. ⏸️ CHECKPOINT

You confirm all jobs green. If any fails, paste the error log and I diagnose
before proceeding.

### D3. 👤 Verify GHCR packages exist

Visit https://github.com/directorscut82?tab=packages

You should see 8 packages listed:
- gateway, api, tenantapi, authenticator, pdfgenerator, emailer, resetservice,
  landlord-frontend

(Yes, resetservice builds — it's in the release workflow. We just don't run it
on the NAS. Harmless to have the image available.)

### D4. 👤 Make each package public

For each of the 8 packages:
1. Click package name
2. **Package settings** (right sidebar)
3. Scroll to **Danger Zone** → **Change package visibility** → **Public**
4. Type package name to confirm

### D5. ⏸️ CHECKPOINT — all public

You confirm.

---

## Phase E — NAS Folder Setup (You)

### E1. 👤 Create one folder via File Station

1. DSM → **File Station**
2. Navigate to `docker` folder (at `/volume1/docker`)
3. Right-click → **Create folder**
4. Name: `mre` (all lowercase)
5. Click OK

**That's all you need.** MongoDB, Redis, and the compose service will
automatically create `data/mongodb`, `data/redis`, and `backup` subfolders on
first start.

### E2. ⏸️ CHECKPOINT

You confirm `/volume1/docker/mre/` exists and is empty.

---

## Phase F — Generate Secrets + Compose File

### F1. 🤖 Generate secrets

**What I do:** run `openssl rand -base64 32` (and 16 for IV) on your Mac
locally. No network involved. Save them to a file:

`/Users/epitrogi/Development/microrealestate/.env.nas-secrets`

(This filename matches the `.env*` pattern which is gitignored, so it can never
be committed by accident.)

File contents will look like:
```
REDIS_PASSWORD=<random base64 32 bytes>
ACCESS_TOKEN_SECRET=<random base64 32 bytes>
REFRESH_TOKEN_SECRET=<random base64 32 bytes>
RESET_TOKEN_SECRET=<random base64 32 bytes>
APPCREDZ_TOKEN_SECRET=<random base64 32 bytes>
CIPHER_KEY=<random 32 hex chars>
CIPHER_IV_KEY=<random 16 hex chars>
```

**You then move this file somewhere permanent** (password manager, encrypted
disk image, 1Password, Bitwarden, physical paper — your choice).

### F2. ⏸️ CHECKPOINT — secrets saved

You confirm you've moved the secrets somewhere safe. I can delete the
`.env.nas-secrets` file afterwards if you want.

### F3. 🤖 Write `docker-compose.nas.yml`

Placed in repo root. Contains:
- redis, mongo (4.4), gateway (port 1350 on host), authenticator, api,
  tenantapi, emailer, pdfgenerator, landlord-frontend
- All volumes point to absolute `/volume1/docker/mre/...` paths
- Images pinned to `ghcr.io/directorscut82/microrealestate/<service>:latest`
- `restart: unless-stopped` on every service
- `mem_limit` matching the budget table above
- Secrets embedded as defaults (so pasting into Portainer "just works")
- `APP_DOMAIN` parameterized — I'll ask you for your NAS local IP and fill it in

### F4. ⏸️ CHECKPOINT — review compose file

I show you the full file. You approve.

### F5. 🤖 Commit and push the compose file

Commit: `feat: add docker-compose.nas.yml for Synology deployment`

Pushed to your fork's master. CI re-runs (~10 min).

### F6. ⏸️ Wait for CI green, then continue.

---

## Phase G — Deployment Documentation

### G1. 🤖 Write `documentation/NAS_DEPLOYMENT.md`

Numbered STEPS in the Marius style, including:
- Prerequisites (Portainer with ghcr.io registry — already done by you)
- STEP 1: Create `/volume1/docker/mre` folder
- STEP 2: Open Portainer → Stacks → + Add stack
- STEP 3: Name `mre`
- STEP 4: Paste YAML (full compose file inline, copy-pasteable)
- STEP 5: Deploy the stack
- STEP 6: First-boot wait (~10 min for image pulls)
- STEP 7: Create admin account at `http://<nas-ip>:1350/landlord/signup`
- STEP 8: (Optional) Lock down signup
- STEP 9: Tailscale access via `http://<machine-name>:1350/landlord`
- Troubleshooting table
- How to update (push to master → Portainer Pull and redeploy)
- How to back up MongoDB

### G2. ⏸️ CHECKPOINT — you review doc

You approve.

### G3. 🤖 Commit & push doc

Commit: `docs: add NAS deployment guide`

CI re-runs (~10 min). When green, we move to deployment.

---

## Phase H — Deploy on NAS (You Drive, I Watch)

### H1. 👤 Open Portainer

`http://<nas-ip>:9000` → login → **Home** → **Live connect**.

### H2. 👤 Stacks → + Add stack

**Name:** `mre`

### H3. 👤 Paste compose YAML

Copy from `documentation/NAS_DEPLOYMENT.md` STEP 4 (or directly from
`docker-compose.nas.yml`).

### H4. 👤 Click Deploy the stack

Wait 5-15 min for images to pull and containers to start. Portainer shows
progress.

### H5. ⏸️ CHECKPOINT — all 9 containers running

Status should be green for:
- mre-redis-1, mre-mongo-1, mre-gateway-1, mre-authenticator-1, mre-api-1,
  mre-tenantapi-1, mre-emailer-1, mre-pdfgenerator-1, mre-landlord-frontend-1

If any container is restarting/unhealthy, paste logs and I diagnose.

### H6. 👤 Sanity check gateway

Browser: `http://<nas-ip>:1350/health` → should return `OK`.

### H7. 👤 Create admin account

Browser: `http://<nas-ip>:1350/landlord` → **Create an account** → fill in your
details → log in successfully.

### H8. 👤 Test Tailscale access

From another Tailscale-connected device:
`http://<nas-tailscale-hostname>:1350/landlord` → same login page loads.

### H9. 👤 (Optional) Lock down signup

Portainer → Stacks → `mre` → Editor → change `SIGNUP: 'true'` to
`SIGNUP: 'false'` in both `authenticator` and `landlord-frontend` services →
**Update the stack** button.

This removes the "Create account" link from the login page. Anyone reaching
the URL can only log in with existing credentials.

### H10. ⏸️ CHECKPOINT — deployment complete

You report any issues. We fix and iterate.

---

## Phase I — Future Maintenance (Reference, No Actions Now)

### Update MRE after code changes
1. Make changes on your Mac, test locally (your existing `yarn dev` workflow)
2. Commit and push to your fork's `master`
3. GitHub Actions builds new images (~10 min)
4. Portainer → Stacks → `mre` → **Pull and redeploy**
5. Old containers stop, new containers start, MongoDB volume preserved
6. ~30 seconds downtime

### Roll back to a previous version
1. Portainer → Stacks → `mre` → Editor
2. Change image tags from `:latest` to a specific commit SHA, e.g.
   `:abc1234def`
3. Update the stack

### Back up MongoDB
Portainer → Containers → `mre-mongo-1` → **Exec Console** → run:
```
mongodump --out /backup/$(date +%Y%m%d)
```
Or schedule via DSM Task Scheduler.

### Sync from upstream MRE project
```
git fetch upstream
git merge upstream/master
# resolve conflicts if any
git push origin master
```
CI builds → Portainer pulls → redeploy.

---

## Questions / Risks to Track

1. **DSM 7.x Container Manager dockerized Puppeteer.** Chromium inside the
   pdfgenerator container needs certain kernel capabilities (SYS_ADMIN or
   --no-sandbox flag). The upstream Dockerfile already sets this up correctly.
   If PDF generation fails on the NAS (blank PDF, crash), I'll add
   `cap_add: - SYS_ADMIN` to the service or adjust Chromium flags.

2. **CIPHER key change mid-deployment.** If you lose the .env.nas-secrets and
   redeploy with fresh secrets, existing MongoDB encrypted values break. Mitigate
   by saving the secrets file safely (see F2).

3. **Mongo 4.4 is EOL.** No security patches since Feb 2024. For a
   Tailscale-only personal deployment this is acceptable; if you ever expose
   publicly, plan a hardware upgrade to an AVX-capable NAS (DS923+/DS1522+) and
   Mongo 7.

4. **Port 1350 conflict.** If you later install something that wants 1350,
   change the host port in compose (left side of `"1350:8080"`) and redeploy.

---

## Ready?

When you say **"start Phase A"** I begin at A1. I stop at every ⏸️ CHECKPOINT
and show you the output before proceeding.
