# Task 01 — API Pagination

> **Status:** ✅ COMPLETE
> **Severity:** High
> **Category:** Scalability
> **Completed:** 2026-05-09
> **Commits:** f340005, fe5bc81, 8f3c332, 93feb25

---

## Problem

`GET /tenants`, `GET /properties`, and `GET /leases` return **all records** for a realm with no limit. A landlord with hundreds of records gets the entire dataset on every request, consuming memory and bandwidth.

## Impact

- Node.js heap spikes on large datasets
- Slow API responses (linear scaling with data size)
- Frontend renders massive lists (performance degrades)
- Potential OOM under concurrent requests from multiple users

---

## Solution Implemented

### Design Decisions

1. **`isPaginated` flag** — pagination ONLY activates when `page` or `limit` query params are present. Without params, endpoints return full datasets for backward compatibility.
2. **Response headers** (not body) for metadata — `X-Total-Count`, `X-Page`, `X-Limit`, `X-Total-Pages` set via `Access-Control-Expose-Headers` so browsers can read them.
3. **CORS headers set at API level** — not gateway, because `http-proxy-middleware` overwrites response headers set by earlier Express middleware.
4. **Separate query keys** for infinite queries to avoid React Query cache collisions with existing `useQuery` callers.

### Files Created/Modified

| File | Change |
|------|--------|
| `services/common/src/utils/pagination.ts` | Created: `parsePagination`, `setPaginationHeaders`, `buildPaginationMeta` |
| `services/api/src/managers/occupantmanager.ts` | Paginated path with `Promise.all` (parallel ID fetch + count) |
| `services/api/src/managers/propertymanager.ts` | Paginated path with `skip/limit + countDocuments` |
| `services/api/src/managers/leasemanager.ts` | Same pattern as properties |
| `services/gateway/src/index.ts` | Removed dead `exposedHeaders` config (proxy overwrites it) |
| `webapps/landlord/src/utils/restcalls.js` | Added `fetchTenantsPage`, `fetchPropertiesPage` |
| `webapps/landlord/src/pages/[organization]/tenants/index.js` | `useInfiniteQuery` with Load More |
| `webapps/landlord/src/pages/[organization]/properties/index.js` | `useInfiniteQuery` with Load More |
| `webapps/landlord/src/components/ResourceList/List.js` | Load More button (`data-cy=loadMoreBtn`) |
| `e2e/cypress/e2e/78_pagination_load_more.cy.js` | Created: 5 E2E tests for full pagination flow |

---

## Steps (all completed)

### 1. Pagination utility
- [x] `PaginationParams` and `PaginationMeta` interfaces
- [x] `parsePagination(req)` — returns `isPaginated: false` when no params (backward compat)
- [x] Input clamping: `page < 1` → 1, `limit` clamped to `[1, 500]`, default 100
- [x] `setPaginationHeaders(res, meta)` — sets 4 headers + `Access-Control-Expose-Headers`
- [x] Exported from `@microrealestate/common`

### 2. Backend — GET /tenants (occupantmanager)
- [x] `isPaginated` branch: count + fetch paginated subset in parallel (`Promise.all`)
- [x] Non-paginated branch: unchanged behavior (returns all)
- [x] Headers set only when paginated

### 3. Backend — GET /properties (propertymanager)
- [x] Same pattern: `isPaginated` → `skip/limit` + `countDocuments`

### 4. Backend — GET /leases (leasemanager)
- [x] Same pattern, `usedByTenants` flag still computed per lease

### 5. Backward compatibility
- [x] No `page`/`limit` params → full dataset, no headers (identical to pre-pagination behavior)
- [x] Response shape unchanged (array of items)
- [x] All existing callers (dashboard, NewTenantDialog, ImportTenantDialog) unaffected

### 6. Frontend — Load More UX
- [x] `fetchTenantsPage` / `fetchPropertiesPage` — always pass `page`/`limit`, read `x-total-count` header
- [x] `useInfiniteQuery` with `getNextPageParam` — computes `hasNextPage` from total/limit
- [x] Query keys: `['tenants', showArchived]` and `['properties', 'list']` — no collision with existing `useQuery(['tenants'])` / `useQuery(['properties'])`
- [x] `List` component: Load More button with spinner, disappears when all pages loaded
- [x] Client-side pagination (21/page chunks) + server-side Load More (100/page) coexist

### 7. CORS fix
- [x] `Access-Control-Expose-Headers` set in `setPaginationHeaders()` at API service level
- [x] Gateway `exposedHeaders` removed (was dead code — proxy overwrites it)

### 8. E2E tests
- [x] Suite 78: seeds 105 tenants + 105 properties
- [x] Verifies paginated request (`?page=1&limit=100`) returns 100 items + correct headers
- [x] Verifies Load More click triggers page 2 request, returns 5 items
- [x] Verifies button disappears after all pages loaded
- [x] Verifies search finds items from page 2 (proves data in memory)
- [x] Same for properties

---

## Verification (all passing)

- [x] TypeScript compiles with 0 errors
- [x] All existing unit tests pass (278 tests, 11 suites)
- [x] Pagination unit tests pass (`src/__tests__/pagination.test.js`)
- [x] E2E suites 01-05 pass (37/37) — no regression
- [x] E2E suite 78 passes (5/5) — pagination Load More verified
- [x] curl: no params → returns all data, no pagination headers
- [x] curl: `?page=1&limit=2` with 5 items → returns 2 items, headers show total=5, pages=3
- [x] curl: `?page=3&limit=2` → returns 1 item (last page partial)
- [x] curl: `?page=4&limit=2` → returns empty array (beyond last page)
- [x] curl: invalid `page=0` → clamps to 1, `limit=-1` → clamps to 1
- [x] curl with `Origin` header → `Access-Control-Expose-Headers` present in response
- [x] CORS preflight (OPTIONS) → 204 with correct allow headers
- [x] No data overlap between pages (pages 1+2+3 contain all unique items)

---

## Key Lessons Learned

1. **http-proxy-middleware overwrites response headers** — any CORS headers set by Express middleware before the proxy will be lost. Set them at the upstream service.
2. **React Query cache collision** — `useQuery(['properties'])` and `useInfiniteQuery(['properties'])` share the same cache key and store data in incompatible formats. Use distinct keys like `['properties', 'list']`.
3. **Finch containers don't propagate filesystem events** — `tsx --watch` won't detect host file changes. Use `finch compose up -d --force-recreate <service>`.
4. **`isPaginated` flag** — applying pagination by default breaks all callers expecting full datasets. Only paginate when explicitly requested.

---

## Notes

- Dashboard endpoint needs separate optimization (Task 02) — loads full rents arrays
- `GET /rents/:year` already scoped by year — doesn't need pagination
- Database indexes (Task 03) will make `skip/limit` queries efficient at scale
- PAGE_LIMIT=100 means Load More only appears for landlords with >100 tenants/properties
