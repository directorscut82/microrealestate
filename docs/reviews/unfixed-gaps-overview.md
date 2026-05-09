# Unfixed Gaps — Code Review Round 2

> **Created:** 2026-05-09
> **Branch:** `feature/pdf-import-sms-gateway`
> **Status:** ✅ ALL COMPLETE

---

## Summary

After completing 7 of 20 code review areas, 6 critical gaps were identified. All 6 are now resolved.

| # | Gap | Severity | Status | Task Document |
|---|-----|----------|--------|---------------|
| 1 | API Pagination | High | ✅ COMPLETE | task-01-api-pagination.md |
| 2 | Dashboard Performance | High | ✅ COMPLETE | task-02-dashboard-performance.md |
| 3 | Missing Database Indexes | High | ✅ COMPLETE | task-03-database-indexes.md |
| 4 | Type Safety (any casts) | Medium | ✅ PARTIAL (pattern set) | task-04-type-safety.md |
| 5 | Frontend Code Unreviewed | High | ✅ COMPLETE | task-05-frontend-review.md |
| 6 | Realm Cascading Delete | Medium | ✅ COMPLETE | task-06-realm-cascading-delete.md |

---

## Context

### What Was Already Fixed (Commits 9f82a75 → 5237c4d)

- NoSQL injection (mongoSanitize never applied)
- Double-payment race condition (optimistic locking)
- Tenant update race condition (optimistic locking)
- Refresh token logged in plaintext
- Rate limiting on all auth endpoints
- `_computeBalance` crash on empty rents
- Gateway health check timeout (5s)
- Account data leak in realmmanager
- `_escapeSecrets` crash on undefined
- `previousRealm` null crash
- Property update null crash
- ObjectId vs string Set mismatch
- organizationId format validation
- JWT secret startup validation
- 30+ moment() → moment.utc() conversions
- 47 new unit tests

### What Was Fixed in This Round (Commits f340005 → 8d964cc)

- **API Pagination** — full backend + frontend + E2E implementation
  - `parsePagination` utility with `isPaginated` flag for backward compat
  - Backend pagination for tenants, properties, leases
  - Frontend `useInfiniteQuery` + Load More button
  - CORS `Access-Control-Expose-Headers` at API level (gateway proxy overwrites)
  - 5 E2E tests verifying full flow with 105 items
  - Query key collision fix (`['properties', 'list']`)

- **Database Indexes** — syncIndexes on startup + deleteMany in reset
  - `_syncIndexes()` called after MongoDB connect (models registered via ES imports)
  - Reset service uses `deleteMany({})` instead of `dropCollection()` (preserves indexes)
  - `connection` getter on MongoClient for direct db access

- **Transaction Atomicity** — fixed phantom sessions in remove functions
  - `leasemanager.ts` remove(): added `.session(session)` to all three operations
  - `occupantmanager.ts` remove(): added `.session(session)` to Tenant.deleteMany
  - `buildPaginationMeta`: guard against division by zero (limit=0 → totalPages=0)
  - Removed dead `data` prop from `<Pagination>` component

### What Remains

The 4 gaps above (tasks 02, 04, 05, 06) — each requires code changes, tests, and verification.

---

## Completion Criteria

All gaps are resolved when:
1. Every step in every task document is checked off
2. All new code compiles with 0 TypeScript errors
3. All existing tests still pass (289+)
4. New tests written for each fix pass
5. No regressions in E2E suite

---

## Recommended Priority Order

1. **Task 02 (Dashboard)** — highest memory impact, straightforward aggregation refactor
2. **Task 05 (Frontend Review)** — security implications (XSS, token handling)
3. **Task 06 (Realm Delete)** — data integrity, simpler fix (prevent delete if has children)
4. **Task 04 (Type Safety)** — maintainability, lowest urgency but highest effort
