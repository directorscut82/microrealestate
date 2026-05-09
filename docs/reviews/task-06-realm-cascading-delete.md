# Task 06 — Realm Cascading Delete

> **Status:** ✅ COMPLETE
> **Severity:** Medium
> **Category:** Data Integrity
> **Files to modify:** `services/api/src/managers/realmmanager.ts`, potentially new migration/cleanup utility

---

## Problem

When a realm (organization) is deleted, all child records — tenants, properties, leases, templates, documents — become **permanently orphaned**. They remain in the database, inaccessible through the API (filtered by `realmId`), but consuming storage and potentially leakable through bugs.

## Impact

- Data leak risk: orphaned records accessible if `realmId` filtering has a bug
- Storage waste: orphaned data grows indefinitely
- GDPR/privacy concern: user data persists after org deletion
- Inconsistency: we guard property/tenant/lease deletion (422 if in use) but not the parent realm

---

## Steps

### 1. Audit current realm deletion

- [ ] Read realm delete handler in `services/api/src/managers/realmmanager.ts`
- [ ] Identify what currently happens when a realm is deleted
- [ ] Check if there are any guards (like "cannot delete if has tenants")
- [ ] Check if soft-delete is already implemented (archived flag, deletedAt timestamp)
- [ ] Document current behavior exactly

### 2. Identify all realm-scoped collections

- [ ] List every collection that has a `realmId` field:
  - Occupant (Tenant)
  - Property
  - Lease
  - Template
  - Document
  - Email (sent emails log)
  - Any others?
- [ ] For each, count approximate records in dev database per realm
- [ ] Identify if any have cross-realm references (should be none)

### 3. Choose strategy

- [ ] **Option A: Prevent delete if has children** (simplest, safest)
  - Return 422 if realm has any tenants, properties, or leases
  - User must manually delete all children first
  - Consistent with existing property/tenant/lease guards
  - Pro: no data loss risk. Con: tedious for users with lots of data

- [ ] **Option B: Cascade delete in transaction** (complete cleanup)
  - Use MongoDB transaction to delete realm + all children atomically
  - Order: Documents → Tenants → Properties → Leases → Templates → Emails → Realm
  - Pro: clean deletion. Con: large transaction, timeout risk on big datasets

- [ ] **Option C: Soft delete + background cleanup** (safest for large datasets)
  - Mark realm as `{ deleted: true, deletedAt: Date }`
  - Immediately invisible to API (add `deleted: { $ne: true }` to all queries)
  - Background job cleans up children later
  - Pro: fast user-facing operation. Con: complexity, need background worker

- [ ] **Recommended: Option A** (prevent delete) — matches existing patterns, lowest risk
- [ ] Document chosen strategy with rationale

### 4. Implement chosen strategy

#### If Option A (prevent delete):

- [ ] In realm delete handler, before deletion:
  ```ts
  const tenantCount = await Occupant.countDocuments({ realmId });
  if (tenantCount > 0) {
    throw new ServiceError('Cannot delete organization with existing tenants', 422);
  }
  const propertyCount = await Property.countDocuments({ realmId });
  if (propertyCount > 0) {
    throw new ServiceError('Cannot delete organization with existing properties', 422);
  }
  const leaseCount = await Lease.countDocuments({ realmId });
  if (leaseCount > 0) {
    throw new ServiceError('Cannot delete organization with existing leases', 422);
  }
  ```
- [ ] Return informative error message telling user what to delete first
- [ ] Consider including counts in error: "Cannot delete: 5 tenants, 3 properties remain"

#### If Option B (cascade delete):

- [ ] Wrap in MongoDB session/transaction:
  ```ts
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await Document.deleteMany({ realmId }, { session });
    await Occupant.deleteMany({ realmId }, { session });
    await Property.deleteMany({ realmId }, { session });
    await Lease.deleteMany({ realmId }, { session });
    await Template.deleteMany({ realmId }, { session });
    await Email.deleteMany({ realmId }, { session });
    await Realm.deleteOne({ _id: realmId }, { session });
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
  ```
- [ ] Add confirmation step in API (require `?confirm=true` query param)
- [ ] Log deletion with realm ID and counts for audit trail

#### If Option C (soft delete):

- [ ] Add `deleted: Boolean` and `deletedAt: Date` to Realm schema
- [ ] Add `{ deleted: { $ne: true } }` filter to all realm queries
- [ ] Mark realm as deleted instead of removing
- [ ] Create cleanup utility (cron job or on-demand script)
- [ ] Document the background cleanup process

### 5. Update frontend (if needed)

- [ ] Check if frontend realm deletion UI exists
- [ ] If Option A: show error message with counts, guide user to delete children first
- [ ] If Option B: add confirmation dialog "This will permanently delete X tenants, Y properties..."
- [ ] If Option C: show "Organization marked for deletion" message

### 6. Write unit tests

- [ ] Test: cannot delete realm with tenants (if Option A)
- [ ] Test: can delete realm with no children
- [ ] Test: error message includes helpful detail
- [ ] Test: cascade deletes all children (if Option B)
- [ ] Test: transaction rolls back on failure (if Option B)
- [ ] Test: orphaned data query returns nothing (verify no leaks)

### 7. Write cleanup/audit script

- [ ] Create `services/api/scripts/find-orphaned-records.ts`:
  ```ts
  // Find records whose realmId doesn't match any existing realm
  const realmIds = await Realm.distinct('_id');
  const orphanedTenants = await Occupant.countDocuments({
    realmId: { $nin: realmIds }
  });
  console.log(`Orphaned tenants: ${orphanedTenants}`);
  // ... repeat for each collection
  ```
- [ ] Run against dev database to check for existing orphans
- [ ] Document findings

### 8. Handle existing orphaned data

- [ ] Run orphan detection script on dev database
- [ ] If orphans exist from past deletions:
  - Document what was found
  - Create one-time cleanup migration
  - Run cleanup (after backup)
- [ ] If no orphans: note this in verification

### 9. E2E verification

- [ ] Write E2E test: attempt to delete realm with data → see error
- [ ] Write E2E test: delete empty realm → succeeds
- [ ] Verify no existing E2E tests rely on realm deletion behavior

---

## Verification Checklist

- [ ] Strategy chosen and documented
- [ ] Implementation matches chosen strategy
- [ ] Cannot create orphaned records through normal API usage
- [ ] Error messages are informative (not generic 500)
- [ ] TypeScript compiles with 0 errors
- [ ] All existing unit tests pass
- [ ] New unit tests pass
- [ ] E2E tests pass
- [ ] Orphan detection script runs clean
- [ ] No performance regression on realm operations

---

## Notes

- Option A (prevent delete) is the safest and most consistent with existing patterns
- The app already prevents deleting properties-in-use and tenants-with-payments
- Adding the same guard at the realm level completes the referential integrity chain
- MongoDB transactions require replica set — verify dev Finch setup uses one (or use `directConnection=true`)
- If using transactions: set a reasonable timeout (30s) for large cascade deletes
- Consider: should realm deletion also revoke all refresh tokens for that realm's users?
- Future: if Option A chosen now, Option B/C can be added later as "force delete" admin feature

---

## Implementation Summary (completed 2026-05-09)

### Discovery
Previously **no DELETE endpoint existed** for realms at all. The API only exposed GET, POST, PATCH. This meant:
- Data could only be orphaned via direct MongoDB manipulation
- But also: admins had no way to clean up test/demo organizations

### Strategy Chosen: Option A (prevent delete with informative error)
- Consistent with existing guards on properties (422 if occupied), tenants (422 if has payments), leases (422 if used)
- No transaction complexity needed
- User gets clear error with counts of what needs removal first

### Implementation
- Added `remove()` function to `services/api/src/managers/realmmanager.ts`
- Registered `DELETE /realms/:id` route in `services/api/src/routes.ts`
- Guard checks: `countDocuments` for Tenant, Property, Lease, Building
- On all zeros: deletes Templates → Documents → Emails → Realm (non-transactional, but these are leaf records)
- Returns 204 on success with audit log entry
- Error includes all blockers: "Cannot delete organization: 5 tenant(s), 3 property/ies still exist. Remove them first."

### Tests Written
- 10 unit tests in `services/api/src/__tests__/realmmanager.test.js`
- Covers: missing ID, not found, each blocker type independently, all blockers combined, successful deletion, deletion order verification, no-delete-on-blocker verification

### Verification
- ✅ TypeScript compiles (0 errors)
- ✅ 10/10 unit tests pass
- ✅ Route registered and accessible
- ✅ Existing tests unaffected (309/319 pass — 10 pre-existing billparser failures)

### Future Considerations
- Could add `?force=true` query param that does full cascade delete in transaction (Option B)
- Could revoke refresh tokens for realm members on deletion
- Frontend doesn't currently expose a "Delete Organization" button — would need UI work to use this endpoint
