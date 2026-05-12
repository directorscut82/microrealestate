#!/usr/bin/env bash
###############################################################################
# deploy-nas.sh — one-command deploy to NAS
#
# What it does:
#   1. Asks upfront about upstream sync, CI wait, NAS redeploy
#   2. Validates local state (clean master, nas branch exists, compose file OK)
#   3. Fast-forwards master from upstream if requested
#   4. Merges master -> nas
#   5. Pushes nas to GitHub (triggers CI to build :nas images)
#   6. Waits for CI to finish (if requested)
#   7. Redeploys the Portainer stack (if requested)
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

read -r -p "1/3  Pull latest from upstream into master before deploying? [y/N] " answer_upstream
read -r -p "2/3  Wait for GitHub Actions to finish building images? [Y/n] " answer_wait_ci
read -r -p "3/3  Redeploy the NAS stack after images are ready? [Y/n] " answer_redeploy
echo

# normalise answers
sync_upstream="no"; [[ "${answer_upstream,,}" == "y" || "${answer_upstream,,}" == "yes" ]] && sync_upstream="yes"
wait_ci="yes"; [[ "${answer_wait_ci,,}" == "n" || "${answer_wait_ci,,}" == "no" ]] && wait_ci="no"
redeploy="yes"; [[ "${answer_redeploy,,}" == "n" || "${answer_redeploy,,}" == "no" ]] && redeploy="no"

info "Plan:"
echo "  - Sync upstream:   $sync_upstream"
echo "  - Wait for CI:     $wait_ci"
echo "  - Redeploy NAS:    $redeploy"
echo

# ---- validate master is clean ----
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

# ---- validate upstream remote if needed ----
if [[ "$sync_upstream" == "yes" ]]; then
  if ! git remote | grep -q '^upstream$'; then
    err "No 'upstream' remote configured. Add it: git remote add upstream <url>"
    exit 1
  fi
fi

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

# ---- optional: sync from upstream ----
if [[ "$sync_upstream" == "yes" ]]; then
  info "Fetching from upstream..."
  git fetch upstream master
  git checkout master
  git merge --ff-only upstream/master || {
    err "Cannot fast-forward master from upstream. Resolve manually."
    exit 1
  }
  ok "master synced with upstream"
fi

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

  # Update the stack with local compose content + pull new images
  info "Pushing updated compose content to Portainer (and pulling images)..."
  compose_content=$(jq -Rs . < "$COMPOSE_FILE")
  update_payload=$(jq -n --argjson content "$compose_content" \
    '{StackFileContent: $content, Env: [], Prune: false, PullImage: true}')

  http_code=$(curl -sS -o /tmp/portainer-update.json -w "%{http_code}" -X PUT \
    -H "X-API-Key: $PORTAINER_TOKEN" \
    -H "Content-Type: application/json" \
    "$PORTAINER_URL/api/stacks/${stack_id}?endpointId=$PORTAINER_ENDPOINT_ID" \
    -d "$update_payload")
  if [[ "$http_code" != "200" ]]; then
    err "Portainer update failed (HTTP $http_code)"
    cat /tmp/portainer-update.json 2>/dev/null
    exit 1
  fi
  ok "Stack updated and images pulled"

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

  # Final sanity check
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
else
  warn "Skipping NAS redeploy. Go to Portainer and 'Pull and redeploy' manually when ready."
fi

# return to original branch
git checkout "$current_branch" >/dev/null 2>&1 || true

echo
ok "All done."
