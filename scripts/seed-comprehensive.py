#!/usr/bin/env python3
"""
Comprehensive test account seeder for MicroRealEstate.
Account: seed@example.com / Redact3d!
Realm: COMPREHENSIVE-TEST

Creates: 30 buildings, ~100 apartments, ~40 tenants, expenses, repairs,
payments across 3 years — exhausting all allocation/behaviour combinations.
"""
import json
import random
import requests
from datetime import datetime, timedelta

NAS = "http://192.168.0.96:1350"
EMAIL = "seed@example.com"
PASSWORD = "Redact3d!"

# Sign in
r = requests.post(f"{NAS}/api/v2/authenticator/landlord/signin",
                  json={"email": EMAIL, "password": PASSWORD})
TOKEN = r.json()["accessToken"]

# Get realm
realms = requests.get(f"{NAS}/api/v2/realms",
                      headers={"Authorization": f"Bearer {TOKEN}"}).json()
REALM_ID = next(r["_id"] for r in realms if "COMPREHENSIVE" in r.get("name", ""))
print(f"Realm: {REALM_ID}")

H = {"Authorization": f"Bearer {TOKEN}", "organizationid": REALM_ID,
     "Content-Type": "application/json"}

def post(path, data):
    r = requests.post(f"{NAS}/api/v2/{path}", headers=H, json=data)
    if r.status_code != 200:
        print(f"  WARN {path}: {r.status_code} {r.text[:100]}")
        return None
    return r.json()

def patch(path, data):
    r = requests.patch(f"{NAS}/api/v2/{path}", headers=H, json=data)
    if r.status_code != 200:
        print(f"  WARN PATCH {path}: {r.status_code} {r.text[:100]}")
        return None
    return r.json()

# ═══════════════════════════════════════════════════════════════════════════
# Phase 1: Lease template
# ═══════════════════════════════════════════════════════════════════════════
print("=== Phase 1: Lease ===")
leases = requests.get(f"{NAS}/api/v2/leases", headers=H).json()
if leases:
    LEASE_ID = leases[0]["_id"]
else:
    lease = post("leases", {"name": "Μηνιαίο-3ετές", "timeRange": "months",
                            "numberOfTerms": 36, "active": True})
    LEASE_ID = lease["_id"] if lease else None
print(f"  lease: {LEASE_ID}")

# ═══════════════════════════════════════════════════════════════════════════
# Phase 2: Buildings (30)
# ═══════════════════════════════════════════════════════════════════════════
print("\n=== Phase 2: Buildings ===")
STREETS = ["Οδος ζητά", "Πατησίων", "Σταδίου", "Ερμού", "Κηφισίας",
           "Βουλιαγμένης", "Λεωφ. Αλεξάνδρας", "Πανεπιστημίου",
           "Μεσογείων", "Ηλιουπόλεως"]
CITIES = ["Αθήνα", "Μαρούσι", "Γλυφάδα", "Πειραιάς", "Χαλάνδρι"]

buildings = []
for i in range(30):
    street = STREETS[i % len(STREETS)]
    num = (i + 1) * 5
    city = CITIES[i % len(CITIES)]
    prefix = f"{(i+1):06d}"
    b = post("buildings", {
        "name": f"{street} {num}",
        "atakPrefix": prefix,
        "address": {
            "street1": f"{street} {num}",
            "zipCode": f"{11100 + i}",
            "city": city,
            "country": "Ελλάδα"
        }
    })
    if b:
        buildings.append(b)
        print(f"  [{i+1}/30] {b['name']} ({b['_id'][:8]})")
    else:
        print(f"  [{i+1}/30] FAILED")

print(f"\n  Buildings created: {len(buildings)}")

# ═══════════════════════════════════════════════════════════════════════════
# Phase 3: Units (3-6 per building = ~105 total)
# ═══════════════════════════════════════════════════════════════════════════
print("\n=== Phase 3: Units ===")
OWNER_NAMES = [
    "ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΕΩΡΓΙΟΣ", "ΝΙΚΟΛΑΟΥ ΜΑΡΙΑ", "ΑΓΓΕΛΟΠΟΥΛΟΣ ΔΗΜΗΤΡΗΣ",
    "ΒΑΣΙΛΕΙΟΥ ΕΛΕΝΗ", "ΓΕΩΡΓΙΟΥ ΚΩΣΤΑΣ", "ΔΗΜΗΤΡΙΟΥ ΑΝΝΑ",
    "ΚΩΝΣΤΑΝΤΙΝΟΥ ΝΙΚΟΣ", "ΑΘΑΝΑΣΙΟΥ ΣΟΦΙΑ", "ΘΗΤΑΝΙΔΗΣ ΠΑΝΑΓΙΩΤΗΣ",
    "ΜΑΡΚΟΥ ΑΙΚΑΤΕΡΙΝΗ", "ΠΕΤΡΟΥ ΙΩΑΝΝΗΣ", "ΣΤΑΜΑΤΙΟΥ ΧΡΙΣΤΙΝΑ",
    "ΧΡΗΣΤΟΥ ΑΝΤΩΝΗΣ", "ΑΛΕΞΙΟΥ ΒΑΣΙΛΙΚΗ", "ΘΕΟΔΩΡΟΥ ΣΠΥΡΟΣ"
]

unit_count = 0
for bi, b in enumerate(buildings):
    bid = b["_id"]
    # 3-6 units per building
    n_units = 3 + (bi % 4)  # 3,4,5,6 cycling

    # Ownership pattern:
    # First 10 buildings: single owner
    # Next 10: 2 co-owners 50/50
    # Last 10: 3 co-owners 40/35/25
    if bi < 10:
        owners = [{"name": OWNER_NAMES[bi], "percentage": 100,
                   "type": "external", "taxId": f"{100000000 + bi:09d}"}]
    elif bi < 20:
        o1 = OWNER_NAMES[bi % len(OWNER_NAMES)]
        o2 = OWNER_NAMES[(bi + 1) % len(OWNER_NAMES)]
        owners = [
            {"name": o1, "percentage": 50, "type": "external",
             "taxId": f"{200000000 + bi:09d}"},
            {"name": o2, "percentage": 50, "type": "external",
             "taxId": f"{300000000 + bi:09d}"}
        ]
    else:
        o1 = OWNER_NAMES[bi % len(OWNER_NAMES)]
        o2 = OWNER_NAMES[(bi + 1) % len(OWNER_NAMES)]
        o3 = OWNER_NAMES[(bi + 2) % len(OWNER_NAMES)]
        owners = [
            {"name": o1, "percentage": 40, "type": "external",
             "taxId": f"{400000000 + bi:09d}"},
            {"name": o2, "percentage": 35, "type": "external",
             "taxId": f"{500000000 + bi:09d}"},
            {"name": o3, "percentage": 25, "type": "external",
             "taxId": f"{600000000 + bi:09d}"}
        ]

    for u in range(n_units):
        atak = f"{b['atakPrefix']}{(u+1)*111:05d}"
        surface = 40 + u * 15 + random.randint(0, 10)
        floor = u
        gen_thousandths = 1000 // n_units + (1 if u < (1000 % n_units) else 0)

        resp = post(f"buildings/{bid}/units", {
            "atakNumber": atak,
            "isManaged": True,
            "floor": floor,
            "surface": surface,
            "generalThousandths": gen_thousandths,
            "heatingThousandths": gen_thousandths,
            "elevatorThousandths": gen_thousandths // 2,
            "owners": owners
        })
        if resp:
            unit_count += 1

    if (bi + 1) % 10 == 0:
        print(f"  [{bi+1}/30] {unit_count} units total so far")

print(f"\n  Total units: {unit_count}")

# ═══════════════════════════════════════════════════════════════════════════
# Phase 4: Properties + Tenants (40)
# ═══════════════════════════════════════════════════════════════════════════
print("\n=== Phase 4: Tenants ===")
# Get all properties (units should have auto-created them OR we need to create)
props = requests.get(f"{NAS}/api/v2/properties", headers=H).json()
print(f"  Properties available: {len(props)}")

if not props:
    print("  No properties — units may not auto-create properties. Creating manually...")
    # The addUnit endpoint on this app doesn't auto-create Property records.
    # We need to create properties and link them to units.
    # For now, create properties directly and link via building unit PATCH
    for bi, b in enumerate(buildings[:10]):  # first 10 buildings
        bid = b["_id"]
        bdata = requests.get(f"{NAS}/api/v2/buildings/{bid}", headers=H).json()
        for u in (bdata.get("units") or []):
            if u.get("propertyId"):
                continue
            floor_label = 'Ισόγειο' if u.get('floor', 0) == 0 else f"Όροφος {u.get('floor', 1)}"
            p = post("properties", {
                "name": f"{b['name']} - {floor_label}",
                "type": "apartment",
                "surface": u.get("surface", 60),
                "address": b.get("address", {}),
                "atakNumber": u.get("atakNumber", "")
            })
            if p:
                # Link property to unit
                patch(f"buildings/{bid}/units/{u['_id']}", {"propertyId": p["_id"]})

    props = requests.get(f"{NAS}/api/v2/properties", headers=H).json()
    print(f"  Properties after creation: {len(props)}")

# Create tenants
FIRST = ["ΓΙΩΡΓΟΣ","ΜΑΡΙΑ","ΔΗΜΗΤΡΗΣ","ΕΛΕΝΗ","ΚΩΣΤΑΣ","ΑΝΝΑ","ΝΙΚΟΣ",
         "ΣΟΦΙΑ","ΠΑΝΑΓΙΩΤΗΣ","ΑΙΚΑΤΕΡΙΝΗ","ΙΩΑΝΝΗΣ","ΧΡΙΣΤΙΝΑ","ΑΝΤΩΝΗΣ",
         "ΒΑΣΙΛΙΚΗ","ΣΠΥΡΟΣ","ΔΕΣΠΟΙΝΑ","ΜΙΧΑΛΗΣ","ΜΑΡΙΝΑ","ΘΑΝΑΣΗΣ","ΟΛΓΑ"]
LAST = ["ΚΟΝΤΟΣ","ΜΑΚΡΗΣ","ΛΙΑΚΟΣ","ΡΟΥΣΣΟΣ","ΚΑΛΛΕΡΓΗΣ",
        "ΣΤΕΦΑΝΟΥ","ΔΡΑΓΩΝΑΣ","ΖΑΧΑΡΙΟΥ","ΤΣΑΓΚΑΡΗΣ","ΒΛΑΧΟΣ"]

tenants_created = 0
for i in range(min(40, len(props))):
    prop = props[i % len(props)]
    name = f"{LAST[i % len(LAST)]} {FIRST[i % len(FIRST)]}"

    # Start dates spread across 2024-2026
    start_month = 1 + (i * 3) % 30  # months from Jan 2024
    start = datetime(2024, 1, 1) + timedelta(days=start_month * 30)
    duration = random.choice([12, 18, 24, 36])
    end = start + timedelta(days=duration * 30)

    rent = random.choice([350, 400, 500, 600, 700, 800, 1000])
    discount = rent * 0.1 if i % 7 == 0 else 0
    vat = 0.24 if i % 9 == 0 else 0

    t = post("tenants", {
        "name": name,
        "leaseId": LEASE_ID,
        "beginDate": start.strftime("%d/%m/%Y"),
        "endDate": end.strftime("%d/%m/%Y"),
        "frequency": "months",
        "discount": discount,
        "vatRatio": vat,
        "properties": [{
            "propertyId": prop["_id"],
            "rent": rent,
            "entryDate": start.strftime("%d/%m/%Y"),
            "exitDate": end.strftime("%d/%m/%Y"),
            "expenses": []
        }]
    })
    if t:
        tenants_created += 1

    if (i + 1) % 10 == 0:
        print(f"  [{i+1}/40] {tenants_created} tenants created")

print(f"\n  Tenants created: {tenants_created}")

# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("COMPREHENSIVE TEST ACCOUNT SEEDED")
print("=" * 60)
print(f"Email: {EMAIL}")
print(f"Password: {PASSWORD}")
print(f"Realm: COMPREHENSIVE-TEST ({REALM_ID})")
print(f"Buildings: {len(buildings)}")
print(f"Units: {unit_count}")
print(f"Properties: {len(props)}")
print(f"Tenants: {tenants_created}")
print(f"\nNext: run expenses + repairs + payments seed (Phase 5-8)")
