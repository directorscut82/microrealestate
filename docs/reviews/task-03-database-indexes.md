# Task 03 — Missing Database Indexes

> **Status:** NOT STARTED
> **Severity:** High
> **Category:** Performance
> **Files to modify:** `services/common/src/collections/occupant.ts`, `services/common/src/collections/property.ts`, `services/common/src/collections/lease.ts`, `services/common/src/collections/template.ts`, `services/common/src/collections/document.ts`

---

## Problem

Mongoose schemas declare **no indexes** beyond the automatic `_id`. Every query filtering by `realmId` (which is every single API call) performs a **full collection scan**. Queries filtering by `rents.term` (rent lookups) also scan every document.

## Impact

- O(n) query time on every request instead of O(log n)
- MongoDB CPU usage scales linearly with data
- Invisible at dev scale (10 records), catastrophic at production scale (10,000+ records)
- Compounds with pagination issue (Task 01): even with LIMIT, MongoDB scans all matching docs without index

---

## Steps

### 1. Audit existing schemas

- [ ] Read all schema files in `services/common/src/collections/`
- [ ] List every schema and its current index definitions (expect: none beyond _id)
- [ ] Identify the primary query patterns from manager files:
  - `Occupant.find({ realmId })` — every tenant list
  - `Occupant.findOne({ realmId, _id })` — tenant by ID
  - `Property.find({ realmId })` — every property list
  - `Lease.find({ realmId })` — every lease list
  - `Template.find({ realmId })` — template list
  - `Occupant.find({ realmId, 'rents.term': term })` — rent lookups

### 2. Design index strategy

- [ ] Define required indexes:
  ```
  Occupant: { realmId: 1, _id: 1 }       — compound for scoped lookups
  Occupant: { realmId: 1, name: 1 }       — sorted tenant lists
  Occupant: { realmId: 1, 'rents.term': 1 } — rent term lookups
  Property: { realmId: 1, name: 1 }       — sorted property lists
  Lease:    { realmId: 1 }                 — lease list by realm
  Template: { realmId: 1 }                 — template list by realm
  Document: { realmId: 1, tenantId: 1 }   — documents by tenant
  ```
- [ ] Verify no index exceeds MongoDB's 64 index limit per collection
- [ ] Consider unique constraints where appropriate (e.g., property name within realm?)
- [ ] Evaluate index size impact (each index adds ~8KB per 1000 docs minimum)

### 3. Add indexes to Occupant schema

- [ ] Open `services/common/src/collections/occupant.ts`
- [ ] Add index definitions after schema declaration:
  ```ts
  OccupantSchema.index({ realmId: 1 });
  OccupantSchema.index({ realmId: 1, name: 1 });
  OccupantSchema.index({ realmId: 1, 'rents.term': 1 });
  ```
- [ ] Verify TypeScript compiles

### 4. Add indexes to Property schema

- [ ] Open `services/common/src/collections/property.ts`
- [ ] Add:
  ```ts
  PropertySchema.index({ realmId: 1 });
  PropertySchema.index({ realmId: 1, name: 1 });
  ```
- [ ] Verify TypeScript compiles

### 5. Add indexes to Lease schema

- [ ] Open `services/common/src/collections/lease.ts`
- [ ] Add:
  ```ts
  LeaseSchema.index({ realmId: 1 });
  ```
- [ ] Verify TypeScript compiles

### 6. Add indexes to Template schema

- [ ] Open `services/common/src/collections/template.ts`
- [ ] Add:
  ```ts
  TemplateSchema.index({ realmId: 1 });
  ```
- [ ] Verify TypeScript compiles

### 7. Add indexes to Document schema

- [ ] Open `services/common/src/collections/document.ts` (if exists)
- [ ] Add:
  ```ts
  DocumentSchema.index({ realmId: 1, tenantId: 1 });
  ```
- [ ] Verify TypeScript compiles

### 8. Index creation behavior

- [ ] Verify Mongoose `autoIndex` setting (default: true in development)
- [ ] For production: consider setting `autoIndex: false` and running `ensureIndexes()` in migration
- [ ] Add a note about `createIndexes()` being called on connection in service startup
- [ ] Check if `services/common/src/utils/service.ts` has any index-related configuration

### 9. Test index effectiveness

- [ ] Start MongoDB locally (via Finch)
- [ ] Run the API service
- [ ] Use `db.occupants.getIndexes()` in mongo shell to verify indexes created
- [ ] Run `.explain('executionStats')` on a typical query to confirm index usage:
  ```
  db.occupants.find({ realmId: ObjectId("...") }).explain('executionStats')
  ```
- [ ] Confirm `winningPlan` uses `IXSCAN` not `COLLSCAN`

### 10. Write verification test

- [ ] Write integration-style test or script that:
  - Connects to test MongoDB
  - Calls `Model.listIndexes()`
  - Asserts expected indexes exist
- [ ] This serves as a regression guard against accidentally removing indexes

---

## Verification Checklist

- [ ] TypeScript compiles with 0 errors across all services
- [ ] All existing unit tests pass
- [ ] MongoDB shell shows indexes created on service startup
- [ ] `.explain()` confirms IXSCAN for realmId queries
- [ ] No duplicate index warnings in MongoDB logs
- [ ] Service startup time not noticeably affected
- [ ] E2E tests pass (indexes are transparent to application logic)

---

## Notes

- Indexes are created asynchronously on first connection — won't block startup
- For large existing datasets, initial index build can take time (background: true is default in MongoDB 4.2+)
- The `{ realmId: 1, _id: 1 }` compound index is redundant if queries always include `_id` (MongoDB uses `_id` index). Only add if queries filter by realmId without _id.
- Consider TTL index on sessions/tokens if stored in MongoDB (currently Redis)
- Monitor index hit ratio after deployment via MongoDB Atlas metrics or `db.serverStatus().indexCounters`
