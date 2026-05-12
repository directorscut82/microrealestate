#!/usr/bin/env bash
###############################################################################
# validate-nas-deploy.sh — sanity checks on docker-compose.nas.yml
#
# Called by deploy-nas.sh before pushing. Fails the deploy if the compose
# file is missing required values, uses wrong images, or accidentally has
# debug/dev-only settings.
###############################################################################

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
err() { echo -e "${RED}[FAIL] $*${NC}" >&2; }
ok()  { echo -e "${GREEN}[PASS] $*${NC}"; }

FILE="docker-compose.nas.yml"
errors=0
check() {
  local msg="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    ok "$msg"
  else
    err "$msg"
    errors=$((errors+1))
  fi
}

# 1. File exists
[[ -f "$FILE" ]] || { err "Missing $FILE"; exit 1; }

# 2. Uses fork image namespace (not upstream)
check "Images come from your fork (ghcr.io/directorscut82/...)" \
  grep -q 'ghcr.io/directorscut82/microrealestate/' "$FILE"

check "No upstream image references remain" \
  bash -c "! grep -q 'ghcr.io/microrealestate/microrealestate' $FILE"

# 3. Image tags are :nas (not :latest)
check "All images pin to :nas tag" \
  bash -c "! grep -E 'ghcr.io/directorscut82/microrealestate/[a-z-]+:(latest|dev)' $FILE"

# 4. Multi-origin APP_DOMAIN is set (includes comma list)
check "APP_DOMAIN uses multi-origin comma-list" \
  bash -c "grep -E 'APP_DOMAIN:.*192\.168\.0\.96.*100\.121\.85\.7' $FILE"

# 5. Port 1350 is exposed (and not 8080)
check "Gateway exposes port 1350 to host" \
  grep -q "'1350:8080'" "$FILE"

# 6. No resetservice (never in prod)
check "No resetservice container defined" \
  bash -c "! grep -q 'resetservice:' $FILE"

# 7. No debug ports (9225-9240 range)
check "No Node debug ports exposed" \
  bash -c "! grep -E ':922[0-9]|:9240' $FILE"

# 8. All 9 expected services present
for svc in redis mongo gateway authenticator api tenantapi emailer pdfgenerator landlord-frontend; do
  check "Service present: $svc" \
    bash -c "grep -qE '^  ${svc}:' $FILE"
done

# 9. Volumes use absolute Synology paths
check "Volumes use /volume1/docker/mre paths" \
  grep -q '/volume1/docker/mre/' "$FILE"

# 10. No placeholder secrets
check "No placeholder 'change_this' values" \
  bash -c "! grep -qi 'change_this' $FILE"

check "No empty REDIS_PASSWORD" \
  bash -c "! grep -qE 'REDIS_PASSWORD:\s*$|REDIS_PASSWORD:\s*\"\"' $FILE"

check "No empty ACCESS_TOKEN_SECRET" \
  bash -c "! grep -qE 'ACCESS_TOKEN_SECRET:\s*$|ACCESS_TOKEN_SECRET:\s*\"\"' $FILE"

# 11. Memory limits present on every service (9 services)
mem_limit_count=$(grep -c 'mem_limit:' "$FILE" || true)
check "All 9 services have mem_limit (found $mem_limit_count)" \
  bash -c "[[ '$mem_limit_count' == '9' ]]"

# 12. restart policy on every service
restart_count=$(grep -c 'restart: unless-stopped' "$FILE" || true)
check "All 9 services have restart: unless-stopped (found $restart_count)" \
  bash -c "[[ '$restart_count' == '9' ]]"

echo
if (( errors > 0 )); then
  err "$errors check(s) failed"
  exit 1
fi
ok "All checks passed"
