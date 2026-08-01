#!/bin/bash
# Comprehensive test account seeder
# Realm: COMPREHENSIVE-TEST
# Creates: 30 buildings, ~100 apartments, ~40 tenants, 3 years of data
# Exercises ALL expense/repair/behaviour combinations
#
# Credentials are read from .secrets/comprehensive-test-account (gitignored):
#   EMAIL= PASSWORD= REALM= REALM_ID=
# This repo is PUBLIC — never inline a credential here.

set -e
NAS="http://192.168.0.96:1350"

ACCOUNT_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.secrets/comprehensive-test-account"
if [ ! -f "$ACCOUNT_FILE" ]; then
  echo "FATAL: $ACCOUNT_FILE not found. Create it with EMAIL/PASSWORD/REALM_ID." >&2
  exit 1
fi
set -a; . "$ACCOUNT_FILE"; set +a
if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ] || [ -z "$REALM_ID" ]; then
  echo "FATAL: $ACCOUNT_FILE must define EMAIL, PASSWORD and REALM_ID." >&2
  exit 1
fi

echo "=== Signing in as $EMAIL ==="
TOKEN=$(curl -s -X POST "$NAS/api/v2/authenticator/landlord/signin" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('accessToken',''))")

if [ -z "$TOKEN" ]; then echo "FAILED to sign in"; exit 1; fi

AUTH="-H 'Authorization: Bearer $TOKEN' -H 'organizationid: $REALM_ID' -H 'Content-Type: application/json'"

# Helper: POST and return response
api_post() {
  curl -s -X POST "$NAS/api/v2/$1" \
    -H "Authorization: Bearer $TOKEN" \
    -H "organizationid: $REALM_ID" \
    -H "Content-Type: application/json" \
    -d "$2"
}

api_patch() {
  curl -s -X PATCH "$NAS/api/v2/$1" \
    -H "Authorization: Bearer $TOKEN" \
    -H "organizationid: $REALM_ID" \
    -H "Content-Type: application/json" \
    -d "$2"
}

echo "=== Phase 1: Creating lease template ==="
LEASE=$(api_post "leases" '{
  "name":"Standard-3yr","timeRange":"months","numberOfTerms":36,
  "active":true,"system":false
}')
LEASE_ID=$(echo "$LEASE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('_id',''))" 2>/dev/null)
echo "lease: $LEASE_ID"

echo "=== Phase 2: Creating 30 buildings ==="
# 10 categories of buildings to cover different scenarios:
# A: 5 buildings with 5 units each (small, mixed occupancy)
# B: 5 buildings with 3 units each (all rented)
# C: 5 buildings with 4 units each (2 rented, 2 vacant)
# D: 5 buildings with 2 units each (owner-occupied + vacant)
# E: 5 buildings with 6 units each (large, co-owned 50/50)
# F: 5 buildings with 1 unit each (single-unit, various states)

BUILDING_IDS=()
UNIT_PROPIDS=()

create_building() {
  local name="$1" street="$2" zip="$3" city="$4" units="$5"
  local data="{\"name\":\"$name\",\"address\":{\"street1\":\"$street\",\"zipCode\":\"$zip\",\"city\":\"$city\",\"country\":\"Ελλάδα\"}}"
  local resp=$(api_post "buildings" "$data")
  local bid=$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('_id',''))" 2>/dev/null)
  echo "$bid"
}

# Create buildings
for i in $(seq 1 5); do
  BID=$(create_building "Κτήριο-Α$i" "Λιοσίων $((i*10))" "1114$i" "Αθήνα")
  BUILDING_IDS+=("$BID")
  echo "  A$i: $BID"
done
for i in $(seq 1 5); do
  BID=$(create_building "Κτήριο-Β$i" "Πατησίων $((i*20))" "1121$i" "Αθήνα")
  BUILDING_IDS+=("$BID")
  echo "  B$i: $BID"
done
for i in $(seq 1 5); do
  BID=$(create_building "Κτήριο-Γ$i" "Σταδίου $((i*5))" "1052$i" "Αθήνα")
  BUILDING_IDS+=("$BID")
  echo "  C$i: $BID"
done
for i in $(seq 1 5); do
  BID=$(create_building "Κτήριο-Δ$i" "Ερμού $((i*15))" "1056$i" "Αθήνα")
  BUILDING_IDS+=("$BID")
  echo "  D$i: $BID"
done
for i in $(seq 1 5); do
  BID=$(create_building "Κτήριο-Ε$i" "Κηφισίας $((i*30))" "1152$i" "Μαρούσι")
  BUILDING_IDS+=("$BID")
  echo "  E$i: $BID"
done
for i in $(seq 1 5); do
  BID=$(create_building "Κτήριο-ΣΤ$i" "Βουλιαγμένης $((i*25))" "1167$i" "Γλυφάδα")
  BUILDING_IDS+=("$BID")
  echo "  F$i: $BID"
done

echo ""
echo "Created ${#BUILDING_IDS[@]} buildings"
echo "=== Phase 2 complete ==="

echo ""
echo "=== Phase 3: Adding units to buildings ==="
# Will add units via API and create properties simultaneously
# This is a long-running phase — each unit needs a property + link

PROP_COUNT=0
add_unit() {
  local bid="$1" atak="$2" floor="$3" surface="$4" gthousandths="$5"
  local owners="$6"
  local data="{\"atakNumber\":\"$atak\",\"isManaged\":true,\"floor\":$floor,\"surface\":$surface,\"generalThousandths\":$gthousandths"
  if [ -n "$owners" ]; then
    data="$data,\"owners\":$owners"
  fi
  data="$data}"
  local resp=$(api_post "buildings/$bid/units" "$data")
  PROP_COUNT=$((PROP_COUNT+1))
}

# Category A: 5 buildings × 5 units = 25 units
for i in $(seq 0 4); do
  bid="${BUILDING_IDS[$i]}"
  for u in $(seq 1 5); do
    atak="A${i}${u}$(printf '%05d' $RANDOM)"
    add_unit "$bid" "$atak" "$u" "$((40+u*15))" "$((200*u))" \
      '[{"name":"ΙΔΙΟΚΤΗΤΗΣ-Α'$i'","percentage":100,"type":"external","taxId":"'$(printf '%09d' $((100000000+i*10+u)))'"}]'
  done
  echo "  A$((i+1)): 5 units added"
done

# Category B: 5 buildings × 3 units = 15 units
for i in $(seq 5 9); do
  bid="${BUILDING_IDS[$i]}"
  for u in $(seq 1 3); do
    atak="B${i}${u}$(printf '%05d' $RANDOM)"
    add_unit "$bid" "$atak" "$u" "$((60+u*20))" "$((333*u))" \
      '[{"name":"ΙΔΙΟΚΤΗΤΗΣ-Β'$((i-5))'","percentage":100,"type":"external","taxId":"'$(printf '%09d' $((200000000+i*10+u)))'"}]'
  done
  echo "  B$((i-4)): 3 units added"
done

# Category C: 5 buildings × 4 units = 20 units
for i in $(seq 10 14); do
  bid="${BUILDING_IDS[$i]}"
  for u in $(seq 1 4); do
    atak="C${i}${u}$(printf '%05d' $RANDOM)"
    add_unit "$bid" "$atak" "$u" "$((50+u*10))" "250" \
      '[{"name":"ΙΔΙΟΚΤΗΤΗΣ-Γ'$((i-10))'","percentage":100,"type":"external","taxId":"'$(printf '%09d' $((300000000+i*10+u)))'"}]'
  done
  echo "  C$((i-9)): 4 units added"
done

# Category D: 5 buildings × 2 units = 10 units
for i in $(seq 15 19); do
  bid="${BUILDING_IDS[$i]}"
  for u in $(seq 1 2); do
    atak="D${i}${u}$(printf '%05d' $RANDOM)"
    add_unit "$bid" "$atak" "$u" "$((80+u*30))" "500" \
      '[{"name":"ΙΔΙΟΚΤΗΤΗΣ-Δ'$((i-15))'","percentage":100,"type":"external","taxId":"'$(printf '%09d' $((400000000+i*10+u)))'"}]'
  done
  echo "  D$((i-14)): 2 units added"
done

# Category E: 5 buildings × 6 units = 30 units (CO-OWNED 50/50)
for i in $(seq 20 24); do
  bid="${BUILDING_IDS[$i]}"
  for u in $(seq 1 6); do
    atak="E${i}${u}$(printf '%05d' $RANDOM)"
    add_unit "$bid" "$atak" "$u" "$((45+u*12))" "$((166*u))" \
      '[{"name":"ΣΥΝΙΔ-Α'$((i-20))'","percentage":50,"type":"external","taxId":"'$(printf '%09d' $((500000000+i*10)))'"},{"name":"ΣΥΝΙΔ-Β'$((i-20))'","percentage":50,"type":"external","taxId":"'$(printf '%09d' $((600000000+i*10)))'"}]'
  done
  echo "  E$((i-19)): 6 units (co-owned 50/50) added"
done

# Category F: 5 buildings × 1 unit = 5 units (single-unit)
for i in $(seq 25 29); do
  bid="${BUILDING_IDS[$i]}"
  atak="F${i}1$(printf '%05d' $RANDOM)"
  add_unit "$bid" "$atak" "0" "120" "1000" \
    '[{"name":"ΜΟΝΟΙΔ-'$((i-25))'","percentage":100,"type":"external","taxId":"'$(printf '%09d' $((700000000+i)))'"}]'
  echo "  F$((i-24)): 1 unit added"
done

echo ""
echo "Total units/properties created: $PROP_COUNT"
echo "=== Phase 3 complete ==="
echo ""
echo "=== SEED SUMMARY ==="
echo "Account: $EMAIL (from .secrets/comprehensive-test-account)"
echo "Realm: COMPREHENSIVE-TEST ($REALM_ID)"
echo "Buildings: ${#BUILDING_IDS[@]}"
echo "Units: $PROP_COUNT"
echo ""
echo "Next phases (tenants + expenses + repairs + payments) will run separately."
