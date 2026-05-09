#!/bin/bash
# SAFETY: Automatically backup production database before any test run.
# This script is called by the E2E test runner to prevent unrecoverable data loss.

set -e

BACKUP_DIR="$(dirname "$0")/../backup"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/mredb_pre_test_${TIMESTAMP}.archive"

mkdir -p "$BACKUP_DIR"

echo "=== SAFETY BACKUP ==="
echo "Backing up mredb to ${BACKUP_FILE} before test run..."

# Try finch first, then docker
RUNTIME=""
if command -v finch &> /dev/null; then
  RUNTIME="finch"
elif command -v docker &> /dev/null; then
  RUNTIME="docker"
else
  echo "ERROR: No container runtime (finch/docker) found. Cannot backup."
  exit 1
fi

MONGO_CONTAINER=$($RUNTIME ps --format '{{.Names}}' | grep mongo | head -1)

if [ -z "$MONGO_CONTAINER" ]; then
  echo "ERROR: MongoDB container not running. Cannot backup."
  exit 1
fi

$RUNTIME exec "$MONGO_CONTAINER" mongodump --db=mredb --archive=/tmp/backup.archive 2>&1
$RUNTIME cp "$MONGO_CONTAINER:/tmp/backup.archive" "$BACKUP_FILE"

echo "Backup saved: ${BACKUP_FILE}"
echo "To restore: $RUNTIME exec $MONGO_CONTAINER mongorestore --archive=/tmp/backup.archive --drop"
echo "====================="

# Also verify resetservice is NOT connected to mredb
HEALTH=$(curl -s http://localhost:8080/api/reset/health 2>/dev/null || echo '{}')
DB=$(echo "$HEALTH" | grep -o '"database":"[^"]*"' | cut -d'"' -f4)

if [ "$DB" = "mredb" ]; then
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "FATAL: resetservice is connected to production database mredb!"
  echo "REFUSING TO RUN TESTS. Fix MONGO_URL for resetservice."
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  exit 1
fi

echo "Verified: resetservice connected to '$DB' (not production)"
echo "Safe to proceed with tests."
