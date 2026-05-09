# Task 03 — Missing Database Indexes

> **Status:** ✅ COMPLETE
> **Severity:** High
> **Category:** Performance
> **Completed:** 2026-05-09
> **Commit:** fdc3062

---

## Problem

Mongoose schemas declared indexes via `.index()` but they were **never actually created in MongoDB**. The `autoIndex` feature failed silently because models were compiled before the connection was established, and no explicit `syncIndexes()` was called. Every API call performed full collection scans (COLLSCAN).

Additionally, the reset service used `dropCollection()` which destroys indexes — so even if indexes were somehow created, they'd be lost on every test reset.

## Root Causes Found

1. **Mongoose `autoIndex` race condition** — Models compiled at import time (before `mongoose.connect()`) don't reliably trigger `ensureIndexes()` in Mongoose 6.
2. **`dropCollection()` destroys indexes** — Reset service wiped collections including all indexes, requiring recreation on next service restart (which never happened since services stayed running).

---

## Solution Implemented

### Fix 1: `syncIndexes()` on startup (`services/common/src/utils/mongoclient.ts`)

Added explicit `syncIndexes()` call after successful MongoDB connection:

```typescript
async connect() {
  // ... connect ...
  await this._syncIndexes();  // NEW
}

private async _syncIndexes() {
  const modelNames = mongoose.modelNames();
  for (const name of modelNames) {
    await mongoose.model(name).syncIndexes();
  }
}
```

This ensures all schema-defined indexes are created (or synced) on every service startup. `syncIndexes()` is idempotent — it creates missing indexes and drops stale ones.

### Fix 2: `deleteMany` instead of `dropCollection` (`services/resetservice/src/routes.ts`)

Changed reset endpoint from:
```typescript
mongoClient?.dropCollection(collection)  // DESTROYS indexes
```
To:
```typescript
db?.collection(collection).deleteMany({})  // PRESERVES indexes
```

Also added `connection` getter to `MongoClient` for direct db access.

---

## Indexes Created (all schemas)

| Collection | Index | Purpose |
|------------|-------|---------|
| occupants | `{ realmId: 1 }` | Realm-scoped queries |
| occupants | `{ realmId: 1, name: 1 }` | Sorted tenant lists |
| occupants | `{ leaseId: 1 }` | Lease-tenant lookups |
| occupants | `{ 'properties.propertyId': 1 }` | Property-tenant lookups |
| properties | `{ realmId: 1 }` | Realm-scoped queries |
| properties | `{ realmId: 1, name: 1 }` | Sorted property lists |
| leases | `{ realmId: 1 }` | Realm-scoped queries |
| templates | `{ realmId: 1 }` | Realm-scoped queries |
| documents | `{ realmId: 1 }` | Realm-scoped queries |
| documents | `{ tenantId: 1 }` | Tenant document lookups |
| documents | `{ realmId: 1, tenantId: 1 }` | Compound tenant+realm |
| buildings | `{ realmId: 1 }` | Realm-scoped queries |
| buildings | `{ realmId: 1, atakPrefix: 1 }` | ATAK prefix uniqueness |
| buildings | `{ realmId: 1, name: 1 }` | Sorted building lists |
| accounts | `{ email: 1 }` (unique) | Email lookup on signin |
| emails | `{ recordId: 1 }` | Email history by record |
| emails | `{ templateName: 1, recordId: 1 }` | Template+record lookup |
| bills | `{ realmId: 1, buildingId: 1, expenseId: 1, term: 1 }` | Bill upsert |
| bills | `{ realmId: 1, status: 1 }` | Status filtering |
| bills | `{ realmId: 1, billingId: 1 }` | Billing lookups |
| bills | `{ realmId: 1, rfCode: 1 }` | RF code lookups |

---

## Verification

- [x] Indexes exist in MongoDB after service startup (confirmed via `getIndexes()`)
- [x] Indexes survive `DELETE /api/reset/` (deleteMany preserves them)
- [x] Query plan uses IXSCAN for `find({ realmId }).sort({ name: 1 })` (confirmed via `.explain()` with hint)
- [x] Unit tests pass (278/278)
- [x] E2E tests pass (42/42) — auth, first access, contracts, properties, pagination
- [x] No stale indexes (cleaned up `properties.property.*` artifacts)

---

## Notes

- MongoDB optimizer may choose COLLSCAN for very small collections (<10 docs) — this is normal and correct behavior. The index is used at scale.
- `syncIndexes()` runs on every service startup. It's idempotent and fast (no-op if indexes already exist). On first run with large datasets, initial index build may take a few seconds.
- The schema `.index()` definitions were already present since commit `ae32745` (TS migration) — the bug was that they were never materialized in MongoDB.
