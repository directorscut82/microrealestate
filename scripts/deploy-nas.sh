#!/usr/bin/env bash
###############################################################################
# deploy-nas.sh — one-command deploy to NAS
#
# What it does:
#   1. Asks upfront about CI wait and NAS redeploy
#   2. Validates local state (clean tree, nas branch exists, compose file OK)
#   3. Merges master -> nas
#   4. Pushes nas to GitHub (triggers CI to build :nas images)
#   5. Waits for CI to finish (if requested)
#   6. Redeploys the Portainer stack (if requested)
#
# Note: upstream sync is NOT automated. This fork has rewritten commit history
# (authorship rewrite), so upstream and this fork have unrelated git histories.
# To pull specific upstream fixes, use git cherry-pick manually.
#
# Requirements on your Mac:
#   - .secrets/github-pat     (GitHub PAT with repo+workflow+write:packages)
#   - .secrets/portainer-token  (Portainer API key from Portainer > My account)
#   - docker-compose.nas.yml  (local, gitignored)
#
# Usage:
#   yarn deploy:nas
###############################################################################

set -euo pipefail

# ---- colors ----
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
err() { echo -e "${RED}[ERR] $*${NC}" >&2; }
ok()  { echo -e "${GREEN}[OK]  $*${NC}"; }
warn(){ echo -e "${YELLOW}[--]  $*${NC}"; }
info(){ echo -e "${CYAN}[**]  $*${NC}"; }

# ---- config ----
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NAS_IP="192.168.0.96"
PORTAINER_URL="http://${NAS_IP}:9000"
PORTAINER_ENDPOINT_ID=3       # "local" docker endpoint inside Portainer
PORTAINER_STACK_NAME="mre"
FORK="directorscut82/microrealestate"
COMPOSE_FILE="docker-compose.nas.yml"
GH_PAT_FILE=".secrets/github-pat"
PORTAINER_TOKEN_FILE=".secrets/portainer-token"
CI_POLL_INTERVAL=20       # seconds between CI status polls
CI_MAX_WAIT=1800          # 30 min cap

# ---- sanity: required tools ----
for cmd in git curl jq python3; do
  command -v "$cmd" >/dev/null || { err "missing required tool: $cmd"; exit 1; }
done

# ---- sanity: token files exist ----
if [[ ! -f "$GH_PAT_FILE" ]]; then
  err "Missing $GH_PAT_FILE"
  echo "  Create it with: echo 'your-github-pat' > $GH_PAT_FILE && chmod 600 $GH_PAT_FILE"
  echo "  Needed scopes: repo, workflow, write:packages"
  exit 1
fi
if [[ ! -f "$PORTAINER_TOKEN_FILE" ]]; then
  err "Missing $PORTAINER_TOKEN_FILE"
  echo "  Create it with: echo 'ptr_...' > $PORTAINER_TOKEN_FILE && chmod 600 $PORTAINER_TOKEN_FILE"
  echo "  Get it from: $PORTAINER_URL > My account > Access tokens"
  exit 1
fi
GH_PAT="$(cat "$GH_PAT_FILE" | tr -d '\n\r ')"
PORTAINER_TOKEN="$(cat "$PORTAINER_TOKEN_FILE" | tr -d '\n\r ')"

# ---- ask all questions upfront ----
echo
info "============================================"
info "   NAS DEPLOY — $FORK"
info "============================================"
echo

read -r -p "1/2  Wait for GitHub Actions to finish building images? [Y/n] " answer_wait_ci
read -r -p "2/2  Redeploy the NAS stack after images are ready? [Y/n] " answer_redeploy
echo

# normalise answers (use tr for bash 3 compat on macOS)
to_lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
wait_ci="yes"; a="$(to_lower "${answer_wait_ci:-}")"; [[ "$a" == "n" || "$a" == "no" ]] && wait_ci="no"
redeploy="yes"; a="$(to_lower "${answer_redeploy:-}")"; [[ "$a" == "n" || "$a" == "no" ]] && redeploy="no"

info "Plan:"
echo "  - Wait for CI:     $wait_ci"
echo "  - Redeploy NAS:    $redeploy"
echo

# ---- validate working tree is clean ----
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  err "Working tree has uncommitted changes. Commit or stash first."
  git status --short
  exit 1
fi
ok "Working tree is clean (current branch: $current_branch)"

# ---- validate nas branch exists ----
if ! git show-ref --quiet refs/heads/nas; then
  err "nas branch doesn't exist locally. Create it first: git checkout -b nas master"
  exit 1
fi
ok "nas branch exists"

# ---- validate compose file exists ----
if [[ ! -f "$COMPOSE_FILE" ]]; then
  err "Missing $COMPOSE_FILE. This file should exist locally (gitignored)."
  exit 1
fi
ok "Compose file present: $COMPOSE_FILE"

# ---- validate compose file has what we expect (no checked-in secrets etc.) ----
info "Validating $COMPOSE_FILE..."
bash scripts/validate-nas-deploy.sh || {
  err "Compose validation failed. Fix $COMPOSE_FILE and retry."
  exit 1
}
ok "Compose file validated"

# ---- merge master -> nas ----
info "Switching to nas branch..."
git checkout nas
info "Merging master into nas..."
git merge --no-edit master || {
  err "Merge conflict. Resolve and re-run."
  exit 1
}
ok "master merged into nas"

# ---- push nas branch ----
info "Pushing nas to fork..."
git -c credential.helper='!f() { echo "username=directorscut82"; echo "password='"$GH_PAT"'"; }; f' push origin nas 2>&1 | tail -5
NEW_SHA="$(git rev-parse HEAD)"
ok "Pushed nas at commit $NEW_SHA"

# ---- optional: wait for CI ----
if [[ "$wait_ci" == "yes" ]]; then
  info "Waiting for GitHub Actions to finish (this may take ~10 min)..."
  sleep 10  # give CI a moment to register the push

  elapsed=0
  while (( elapsed < CI_MAX_WAIT )); do
    run_json=$(curl -sS \
      -H "Authorization: Bearer $GH_PAT" \
      "https://api.github.com/repos/${FORK}/actions/runs?branch=nas&per_page=1&head_sha=${NEW_SHA}")
    status=$(echo "$run_json" | jq -r '.workflow_runs[0].status // "queued"')
    conclusion=$(echo "$run_json" | jq -r '.workflow_runs[0].conclusion // "null"')

    if [[ "$status" == "completed" ]]; then
      if [[ "$conclusion" == "success" ]]; then
        ok "CI passed ✓"
        break
      else
        err "CI failed with conclusion: $conclusion"
        run_url=$(echo "$run_json" | jq -r '.workflow_runs[0].html_url // ""')
        echo "  View: $run_url"
        exit 1
      fi
    fi

    printf "\r  status=%s (%ds elapsed)      " "$status" "$elapsed"
    sleep $CI_POLL_INTERVAL
    elapsed=$(( elapsed + CI_POLL_INTERVAL ))
  done
  echo

  if (( elapsed >= CI_MAX_WAIT )); then
    err "CI timeout after ${CI_MAX_WAIT}s"
    exit 1
  fi
else
  warn "Skipping CI wait. Check status manually at:"
  echo "  https://github.com/${FORK}/actions"
fi

# ---- optional: redeploy NAS stack ----
if [[ "$redeploy" == "yes" ]]; then
  info "Redeploying NAS stack '$PORTAINER_STACK_NAME'..."

  # Find stack ID
  stack_json=$(curl -sS -H "X-API-Key: $PORTAINER_TOKEN" "$PORTAINER_URL/api/stacks")
  stack_id=$(echo "$stack_json" | jq -r ".[] | select(.Name == \"$PORTAINER_STACK_NAME\") | .Id")
  if [[ -z "$stack_id" || "$stack_id" == "null" ]]; then
    err "Stack '$PORTAINER_STACK_NAME' not found in Portainer. Check name and try again."
    exit 1
  fi
  ok "Found stack id=$stack_id"

  # ---- explicit image pulls ----
  # Portainer's PullImage:true flag is unreliable with mutable tags like :nas.
  # The local Docker daemon may consider an existing :nas image "up to date"
  # even when the remote SHA has changed, leaving the stack on a stale image.
  # We pull each image explicitly via the Docker API to guarantee freshness.
  info "Force-pulling all :nas images via Docker API..."
  IMAGES=(authenticator api gateway emailer pdfgenerator tenantapi landlord-frontend resetservice)
  for img in "${IMAGES[@]}"; do
    pull_status=$(curl -sS -X POST \
      -H "X-API-Key: $PORTAINER_TOKEN" \
      "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/images/create?fromImage=ghcr.io/${FORK}/${img}&tag=nas" \
      --max-time 180 2>&1 | tail -1)
    if echo "$pull_status" | grep -qE 'Downloaded newer image|Image is up to date'; then
      printf "  %-20s ✓\n" "$img"
    else
      err "Failed to pull $img:nas"
      echo "$pull_status"
      exit 1
    fi
  done
  ok "All 8 images pulled"

  # ---- Update the stack — Portainer will recreate containers using the pulled images ----
  info "Updating stack (recreates containers)..."
  compose_content=$(jq -Rs . < "$COMPOSE_FILE")
  update_payload=$(jq -n --argjson content "$compose_content" \
    '{StackFileContent: $content, Env: [], Prune: false, PullImage: true}')

  http_code=$(curl -sS -o /tmp/portainer-update.json -w "%{http_code}" -X PUT \
    -H "X-API-Key: $PORTAINER_TOKEN" \
    -H "Content-Type: application/json" \
    "$PORTAINER_URL/api/stacks/${stack_id}?endpointId=$PORTAINER_ENDPOINT_ID" \
    -d "$update_payload" --max-time 240)
  if [[ "$http_code" != "200" ]]; then
    err "Portainer update failed (HTTP $http_code)"
    cat /tmp/portainer-update.json 2>/dev/null
    exit 1
  fi
  ok "Stack updated"

  # Poll container status
  info "Waiting for containers to be running..."
  for i in {1..30}; do
    sleep 3
    containers=$(curl -sS -H "X-API-Key: $PORTAINER_TOKEN" \
      "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/containers/json?all=true")
    total=$(echo "$containers" | jq -r '[.[] | select(.Names[] | test("mre-"))] | length')
    running=$(echo "$containers" | jq -r '[.[] | select(.Names[] | test("mre-")) | select(.State == "running")] | length')
    printf "\r  %d/%d containers running (try %d/30)...      " "$running" "$total" "$i"
    if [[ "$running" -eq 9 ]]; then
      echo
      ok "All 9 containers running"
      break
    fi
  done
  echo

  # ---- VERIFY: containers are actually running the new revision ----
  # Without this check, Portainer happily reports "9 running" even when the
  # containers are running stale images. Compare each app container's image
  # revision label to $NEW_SHA — fail loudly if any don't match.
  info "Verifying running containers match revision $NEW_SHA..."
  containers=$(curl -sS -H "X-API-Key: $PORTAINER_TOKEN" \
    "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/containers/json?all=true")
  mismatch=0
  for cname in mre-authenticator-1 mre-api-1 mre-gateway-1 mre-emailer-1 mre-pdfgenerator-1 mre-tenantapi-1 mre-landlord-frontend-1 mre-resetservice-1; do
    imgid=$(echo "$containers" | jq -r ".[] | select(.Names[] | test(\"$cname\")) | .ImageID" | head -1)
    if [[ -z "$imgid" || "$imgid" == "null" ]]; then
      err "  $cname: not found"
      mismatch=$((mismatch + 1))
      continue
    fi
    revision=$(curl -sS -H "X-API-Key: $PORTAINER_TOKEN" \
      "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/images/${imgid}/json" \
      | jq -r '.Config.Labels."org.opencontainers.image.revision" // "unknown"')
    if [[ "$revision" == "$NEW_SHA" ]]; then
      printf "  %-30s ✓ %s\n" "$cname" "${revision:0:8}"
    else
      err "  $cname: running revision ${revision:0:8}, expected ${NEW_SHA:0:8}"
      mismatch=$((mismatch + 1))
    fi
  done
  if (( mismatch > 0 )); then
    err "$mismatch container(s) are running the wrong revision."
    err "This usually means the local Docker image cache is stale despite a successful pull."
    err "To recover, force-recreate the affected containers in Portainer UI, or re-run this script."
    exit 1
  fi
  ok "All 8 app containers run revision ${NEW_SHA:0:8}"

  # Final sanity check: landlord HTTP responds + serves expected content
  info "Checking landlord app responds..."
  for i in {1..10}; do
    code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "http://${NAS_IP}:1350/landlord/en/signin" || true)
    if [[ "$code" == "200" ]]; then
      ok "Landlord app responds 200 ✓"
      break
    fi
    printf "\r  landlord still booting (status=%s, try %d/10)...      " "$code" "$i"
    sleep 5
  done
  echo

  echo
  ok "Deploy complete!"
  echo "  LAN:       http://${NAS_IP}:1350/landlord"
  echo "  Tailscale: http://100.121.85.7:1350/landlord"
  echo
  warn "Remind users to hard-reload (Ctrl+Shift+R) — Next.js chunks are cached"
  warn "for 1 year. Browsers may show old design until then."
else
  warn "Skipping NAS redeploy. Go to Portainer and 'Pull and redeploy' manually when ready."
fi

# return to original branch
git checkout "$current_branch" >/dev/null 2>&1 || true

echo
ok "All done."
