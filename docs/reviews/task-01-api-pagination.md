# Task 01 — API Pagination

> **Status:** BACKEND COMPLETE
> **Severity:** High
> **Category:** Scalability
> **Files to modify:** `services/api/src/managers/occupantmanager.ts`, `services/api/src/managers/propertymanager.ts`, `services/api/src/managers/leasemanager.ts`, `types/src/common/collections.ts`

---

## Problem

`GET /tenants`, `GET /properties`, and `GET /leases` return **all records** for a realm with no limit. A landlord with hundreds of records gets the entire dataset on every request, consuming memory and bandwidth.

## Impact

- Node.js heap spikes on large datasets
- Slow API responses (linear scaling with data size)
- Frontend renders massive lists (performance degrades)
- Potential OOM under concurrent requests from multiple users

---

## Steps

### 1. Define pagination types

- [x] Created `PaginationParams` and `PaginationMeta` interfaces in `services/common/src/utils/pagination.ts`
- [x] Defaults: page=1, limit=100, max=500

### 2. Create pagination utility

- [x] Created `services/common/src/utils/pagination.ts`:
  - `parsePagination(req)` → `{ page, limit, skip }`
  - `buildPaginationMeta(total, page, limit)` → `PaginationMeta`
  - `setPaginationHeaders(res, meta)` → sets X-Total-Count, X-Page, X-Limit, X-Total-Pages
- [x] Exported as `Pagination` from `services/common/src/index.ts`

### 3. Apply pagination to GET /tenants

- [x] In `occupantmanager.ts` `all()`:
  - Aggregation pipeline with `$match`, `$sort`, `$skip`, `$limit`
  - `countDocuments()` for total (respects archived filter)
  - `_fetchTenants()` extended to accept `string[]` for batch fetch
  - Only fetches full data (with $lookup) for paginated subset
  - Response still returns array (backward-compatible)
  - Pagination metadata via response headers

Remaining:
  - Import `parsePagination` utility
  - Extract pagination from request
  - Add `.skip(skip).limit(limit)` to Mongoose query
  - Run `countDocuments()` with same filter for total
  - Return `PaginatedResponse` shape
- [ ] Verify existing tests still pass
- [ ] Write unit test: default pagination returns max 50
- [ ] Write unit test: page=2 skips first page
- [ ] Write unit test: limit > 100 gets clamped to 100
- [ ] Write unit test: limit < 1 gets clamped to 1

### 4. Apply pagination to GET /properties

- [x] In `propertymanager.ts` `all()`:
  - `Promise.all([find().skip().limit().lean(), countDocuments()])`
  - Headers set via `setPaginationHeaders()`
  - Response still returns array

### 5. Apply pagination to GET /leases

- [x] In `leasemanager.ts` `all()`:
  - Same pattern as properties
  - `_leaseUsedByTenant` still enriches each lease with `usedByTenants` flag

### 6. Backward compatibility

- [ ] Verify: when no `page`/`limit` params sent, defaults apply (page=1, limit=50)
- [ ] Verify: response still includes `results` array (not breaking shape for frontend)
- [ ] Consider: add `X-Total-Count` header for easy frontend consumption
- [ ] Document: note in response whether there are more pages

### 7. Frontend coordination

- [ ] Check `webapps/landlord/src/utils/restcalls.js` — identify which calls use these endpoints
- [ ] Determine if frontend currently paginates client-side (if so, can switch to server-side)
- [ ] If frontend renders all items: add pagination or infinite scroll component
- [ ] Update React Query hooks to pass pagination params

### 8. E2E test verification

- [ ] Run E2E suites that test tenant/property/lease listing
- [ ] Verify no E2E tests break (they seed small datasets, should be under limit)
- [ ] Add E2E test: verify pagination response shape

---

## Verification Checklist

- [x] TypeScript compiles with 0 errors (all 5 services)
- [x] All existing unit tests pass (255 tests)
- [x] All new pagination unit tests pass (19 tests)
- [ ] E2E tests pass without regression
- [ ] Manual test: `curl` endpoint with no params returns max 100 results
- [ ] Manual test: `curl` endpoint with `?page=2&limit=10` returns correct slice
- [ ] Manual test: response includes `total`, `page`, `limit`, `totalPages`
- [ ] No performance regression on small datasets (overhead of countDocuments is minimal)

---

## Notes

- The dashboard endpoint may need a separate optimization (Task 02) since it loads rents differently
- `GET /rents/:year` is already scoped by year — may not need pagination
- Consider adding sorting params (`?sort=name&order=asc`) in same pass
- Frontend may need a loading state for pagination transitions
