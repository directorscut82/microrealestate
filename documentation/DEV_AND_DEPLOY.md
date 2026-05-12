# Dev and Deploy Workflow

This project uses a **two-branch strategy** to keep local development and
production deployment cleanly separated.

## Branches at a glance

| Branch | Purpose | Who pulls it |
|--------|---------|--------------|
| `master` | Day-to-day development. Behaves like upstream. | You, locally via `yarn dev`. CI builds `:latest` but nothing deploys it. |
| `nas` | Production layer for the Synology NAS. Adds multi-origin support and the NAS-specific stack. | Portainer on the NAS (pulls `:nas` images). |

The `nas` branch is a thin layer on top of `master`. Only 3 source files are
modified there:
- `services/gateway/src/index.ts` — multi-origin CORS
- `services/authenticator/src/index.ts` — host-only cookies (no `domain` attr)
- `webapps/landlord/src/utils/fetch.js` — use `window.location.origin` as
  API base URL on the client

Plus:
- `.github/workflows/nas-ci.yml` — CI that builds `:nas` and `:nas-<sha>` images
- `scripts/deploy-nas.sh` + `scripts/validate-nas-deploy.sh` — the deploy tool

## Daily dev workflow

Nothing changes. Work on `master` as before.

```bash
git checkout master
# edit files
yarn dev                  # starts the full dev stack via Finch
# app at http://localhost:8080/landlord
```

Commit, push to master, move on.

## Deploying to the NAS

When you want your latest master changes live on the NAS, run:

```bash
yarn deploy:nas
```

The script asks three questions up-front and then does the rest:

1. **Pull from upstream first?** — merges the original MicroRealEstate upstream
   into your master. Skip if you don't want upstream changes.
2. **Wait for CI to finish?** — polls GitHub Actions until images are built.
3. **Redeploy the NAS stack?** — calls Portainer API to pull new images and
   restart containers.

After you answer, the script:

- Validates master is clean (no uncommitted changes)
- Runs `scripts/validate-nas-deploy.sh` against `docker-compose.nas.yml`
  (catches common mistakes — wrong image tags, missing secrets, dev-only
  services, etc.)
- Merges `master` → `nas`
- Pushes `nas` to GitHub (CI starts)
- Waits for CI (if you said yes)
- Calls Portainer API to redeploy (if you said yes)
- Verifies the landlord endpoint returns 200
- Prints access URLs

## Prerequisites (one-time)

Create two files that the deploy script reads (both gitignored):

```bash
mkdir -p .secrets
chmod 700 .secrets

# GitHub PAT with scopes: repo, workflow, write:packages
echo 'github_pat_...' > .secrets/github-pat
chmod 600 .secrets/github-pat

# Portainer API token from Portainer > My account > Access tokens
echo 'ptr_...' > .secrets/portainer-token
chmod 600 .secrets/portainer-token
```

Also make sure you have a local `docker-compose.nas.yml` with your real secrets
inlined. This file is gitignored — it never leaves your Mac.

## Validation checks that run before every deploy

Defined in `scripts/validate-nas-deploy.sh`. All 22 must pass before the push
happens. Highlights:

- Images come from `ghcr.io/directorscut82/microrealestate/*` (your fork)
- All images pin to `:nas` tag (not `:latest`)
- `APP_DOMAIN` contains both LAN IP and Tailscale IP
- Gateway exposes port 1350 to host
- No `resetservice` container (dev/CI only)
- No Node debug ports exposed
- All 9 expected services present
- `mem_limit` on every service
- `restart: unless-stopped` on every service
- No placeholder `change_this_*` secrets
- Volumes use `/volume1/docker/mre/` paths

If any check fails, the script aborts with a clear error.

## Rolling back a bad deploy

Every deploy produces both `:nas` (floating) and `:nas-<sha>` (pinned) image
tags. If a deploy breaks the NAS:

1. Edit `docker-compose.nas.yml` locally
2. Change image tags from `:nas` to `:nas-<previous-sha>`
3. Run `yarn deploy:nas` and answer `n` to "sync upstream" and `n` to "wait
   for CI" — the script will just re-upload the compose file and tell
   Portainer to pull the pinned images.

Find previous SHAs at https://github.com/directorscut82/microrealestate/actions.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Missing $GH_PAT_FILE` | You haven't set up `.secrets/github-pat` | See Prerequisites above |
| `Compose validation failed` | `docker-compose.nas.yml` doesn't match expected pattern | Read the FAIL messages, fix the file |
| `refusing to merge unrelated histories` | This fork's master was rewritten (authorship change) so git sees no common ancestor with upstream | Answer `n` to "Pull from upstream?" — cherry-pick or manually copy changes from upstream when you want them |
| `Merge conflict` | nas and master diverged | Fix conflicts on nas, commit, re-run |
| `CI timeout after 1800s` | Build stuck (very rare) | Check GitHub Actions page, retry |
| `Stack 'mre' not found in Portainer` | Stack was deleted or renamed | Recreate it via Portainer UI first, then re-run |
| `Connection timed out` calling Portainer | NAS is asleep or you're off LAN | Wake the NAS (open `http://<nas-ip>:5000`), or connect to the LAN Wi-Fi, or use Tailscale |
| Dev gateway crashes with `[HPM] Missing "target" option` | `API_URL` missing from `.env` | Already fixed in `cli/src/commands.js` on master. If it ever comes back: `echo 'API_URL=http://api:8200/api/v2' >> .env` |
| Sign-in works on LAN but fails from phone via Tailscale | `APP_DOMAIN` in compose doesn't include the Tailscale IP | Edit `docker-compose.nas.yml`, add the IP to the comma-list in both gateway and authenticator services, redeploy |

## Historical gotchas (already fixed, here for context)

These tripped us up during initial setup. They're all fixed now but kept for
reference if they ever resurface.

### `.env` kept losing `API_URL`
The CLI's `writeDotEnv()` runs on every `mre dev`/`mre start` call and
regenerates `.env` from a template. The template didn't include `API_URL`,
and the cleanup phase explicitly deleted it from the carry-over env. So the
gateway started every time with an empty `API_URL`, causing
`[HPM] Missing "target" option`. Fixed by adding `API_URL=http://api:8200/api/v2`
to the template and removing the `delete envConfig.API_URL;` line.

### Cross-origin login silently failed
With `APP_DOMAIN=192.168.0.96`, the gateway's CORS regex only allowed that one
hostname. When a family member hit the app via Tailscale IP `100.121.85.7`,
the preflight `OPTIONS` returned without an `Access-Control-Allow-Origin`
matching the phone's origin, so the browser silently refused to send the
actual sign-in POST. The gateway logs showed only `OPTIONS 204` with no
follow-up `POST`. Fixed by making APP_DOMAIN accept a comma-separated list of
allowed domains.

### Cookies bound to one domain
Authenticator set `domain: APP_DOMAIN` on session cookies. Even if CORS
allowed multiple origins, the browser wouldn't send a cookie set for
`192.168.0.96` when visiting `100.121.85.7`. Fixed by removing the `domain`
attribute entirely — cookies become host-only, each origin gets its own
session cookie automatically.

### Frontend hardcoded GATEWAY_URL at build time
`webapps/landlord/src/utils/fetch.js` used `config.GATEWAY_URL` as the axios
`baseURL` in the browser. Even with CORS and cookies fixed, the frontend was
still trying to talk back to the baked-in hostname. Fixed by using
`window.location.origin` on the client so the frontend always calls back to
whichever origin served the page.

### Portainer-managed stack vs "limited" stack
Initially we created the NAS stack by pasting into Portainer's web editor,
and Synology Container Manager raced to register the containers first. The
stack showed up as "created outside of Portainer — control is limited" with
no Editor tab. Fixed by removing the stack + containers + network and
redeploying via Portainer's REST API (what `scripts/deploy-nas.sh` now does).
