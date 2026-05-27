#!/usr/bin/env bash
###############################################################################
# backup-nas-before-tests.sh
#
# Mandatory pre-flight for any Cypress run that targets the production NAS.
# Streams a mongodump archive of the NAS database back to this Mac via the
# Portainer container-exec API. Exits non-zero on any failure so the test
# runner refuses to start without a backup on disk.
#
# Backups land in e2e/backup/mredb_pre_test_<timestamp>.archive
###############################################################################

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
err()  { echo -e "${RED}[ERR] $*${NC}" >&2; }
ok()   { echo -e "${GREEN}[OK]  $*${NC}"; }
warn() { echo -e "${YELLOW}[--]  $*${NC}"; }
info() { echo -e "${CYAN}[**]  $*${NC}"; }

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${REPO_ROOT}/e2e-playwright/backup"
PORTAINER_TOKEN_FILE="${REPO_ROOT}/.secrets/portainer-token"
NAS_IP="${NAS_IP:-192.168.0.96}"
PORTAINER_URL="${PORTAINER_URL:-http://${NAS_IP}:9000}"
PORTAINER_ENDPOINT_ID="${PORTAINER_ENDPOINT_ID:-3}"
MONGO_CONTAINER_NAME_PATTERN="${MONGO_CONTAINER_NAME_PATTERN:-mongo}"
DB_NAME="${MRE_DB_NAME:-mredb}"

for cmd in curl jq tar; do
  command -v "$cmd" >/dev/null || { err "missing required tool: $cmd"; exit 1; }
done

if [[ ! -f "$PORTAINER_TOKEN_FILE" ]]; then
  err "Missing $PORTAINER_TOKEN_FILE"
  echo "  Get a token from $PORTAINER_URL > My account > Access tokens"
  echo "  Then: echo 'ptr_...' > $PORTAINER_TOKEN_FILE && chmod 600 $PORTAINER_TOKEN_FILE"
  exit 1
fi
PORTAINER_TOKEN="$(tr -d '\n\r ' < "$PORTAINER_TOKEN_FILE")"

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/mredb_pre_test_${TIMESTAMP}.archive"

info "Locating Mongo container on NAS via Portainer..."
containers_json=$(curl -sS --max-time 20 \
  -H "X-API-Key: $PORTAINER_TOKEN" \
  "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/containers/json?all=false")

CONTAINER_ID=$(echo "$containers_json" \
  | jq -r --arg pat "$MONGO_CONTAINER_NAME_PATTERN" \
    '.[] | select(.Names[]? | test($pat; "i")) | .Id' \
  | head -1)

if [[ -z "$CONTAINER_ID" || "$CONTAINER_ID" == "null" ]]; then
  err "No running container with name matching '$MONGO_CONTAINER_NAME_PATTERN' on NAS endpoint $PORTAINER_ENDPOINT_ID"
  echo "  Available container names:"
  echo "$containers_json" | jq -r '.[].Names[]?' | sed 's/^/    /'
  exit 1
fi
ok "Mongo container: $CONTAINER_ID"

# Step 1: dump to /tmp inside the container via exec API.
info "Running mongodump inside container..."
DUMP_PATH="/tmp/mre_e2e_backup_${TIMESTAMP}.archive"

# Try mongodump with auth first. mongodump understands a connection URI;
# fall back to no-auth if MONGO_ROOT_USER isn't set. The dev/NAS deployment
# typically runs Mongo without auth on the docker network — adjust if your
# stack adds creds.
exec_create_payload=$(jq -n --arg path "$DUMP_PATH" --arg db "$DB_NAME" '{
  AttachStdin: false,
  AttachStdout: true,
  AttachStderr: true,
  Tty: false,
  Cmd: ["sh", "-c", ("mongodump --db=" + $db + " --archive=" + $path + " 2>&1; ls -l " + $path)]
}')

exec_id_json=$(curl -sS --max-time 20 -X POST \
  -H "X-API-Key: $PORTAINER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$exec_create_payload" \
  "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/containers/$CONTAINER_ID/exec")
EXEC_ID=$(echo "$exec_id_json" | jq -r '.Id')
if [[ -z "$EXEC_ID" || "$EXEC_ID" == "null" ]]; then
  err "Failed to create exec instance"
  echo "$exec_id_json"
  exit 1
fi

start_payload='{"Detach":false,"Tty":false}'
exec_output=$(curl -sS --max-time 600 -X POST \
  -H "X-API-Key: $PORTAINER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$start_payload" \
  "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/exec/$EXEC_ID/start" || true)

exec_inspect=$(curl -sS --max-time 20 \
  -H "X-API-Key: $PORTAINER_TOKEN" \
  "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/exec/$EXEC_ID/json")
EXIT_CODE=$(echo "$exec_inspect" | jq -r '.ExitCode')
if [[ "$EXIT_CODE" != "0" ]]; then
  err "mongodump failed inside container (ExitCode=$EXIT_CODE)"
  echo "  exec output (may contain framing bytes):"
  echo "$exec_output" | tr -d '\000-\010\013-\037' | sed 's/^/    /' | head -30
  exit 1
fi
ok "mongodump completed inside container"

# Step 2: pull the archive out via Docker's GetArchive (tar stream).
info "Streaming archive to Mac..."
TMP_TAR="${BACKUP_DIR}/.pull_${TIMESTAMP}.tar"
http_code=$(curl -sS -o "$TMP_TAR" -w "%{http_code}" --max-time 600 \
  -H "X-API-Key: $PORTAINER_TOKEN" \
  --get \
  --data-urlencode "path=$DUMP_PATH" \
  "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/containers/$CONTAINER_ID/archive")

if [[ "$http_code" != "200" ]]; then
  err "Failed to fetch archive from container (HTTP $http_code)"
  rm -f "$TMP_TAR"
  exit 1
fi

# The container archive endpoint returns a tar containing the file. Extract
# just the archive payload to BACKUP_FILE.
tar -xOf "$TMP_TAR" "$(basename "$DUMP_PATH")" > "$BACKUP_FILE"
rm -f "$TMP_TAR"

if [[ ! -s "$BACKUP_FILE" ]]; then
  err "Backup file is empty: $BACKUP_FILE"
  rm -f "$BACKUP_FILE"
  exit 1
fi
SIZE_KB=$(( $(wc -c <"$BACKUP_FILE") / 1024 ))
ok "Backup saved: $BACKUP_FILE (${SIZE_KB} KB)"

# Step 3: clean up dump file inside container so /tmp doesn't bloat.
cleanup_payload=$(jq -n --arg path "$DUMP_PATH" '{
  AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false,
  Cmd: ["rm", "-f", $path]
}')
cleanup_id=$(curl -sS --max-time 10 -X POST \
  -H "X-API-Key: $PORTAINER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$cleanup_payload" \
  "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/containers/$CONTAINER_ID/exec" \
  | jq -r '.Id' || true)
if [[ -n "$cleanup_id" && "$cleanup_id" != "null" ]]; then
  curl -sS --max-time 10 -X POST \
    -H "X-API-Key: $PORTAINER_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"Detach":false,"Tty":false}' \
    "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/exec/$cleanup_id/start" >/dev/null || true
fi

echo
ok "NAS backup complete. Test runner is cleared to start."
echo "  Restore (if disaster): copy archive into the NAS Mongo container, then"
echo "    mongorestore --archive=/tmp/<archive> --drop"
echo "  Local copy: $BACKUP_FILE"
