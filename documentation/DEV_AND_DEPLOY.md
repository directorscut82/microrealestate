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
| `Cannot fast-forward master from upstream` | You have local commits on master not in upstream | Rebase or merge manually, then re-run |
| `Merge conflict` | nas and master diverged | Fix conflicts, commit, re-run |
| `CI timeout after 1800s` | Build stuck (very rare) | Check GitHub Actions page, retry |
| `Stack 'mre' not found in Portainer` | Stack was deleted or renamed | Recreate it via Portainer UI first, then re-run |
