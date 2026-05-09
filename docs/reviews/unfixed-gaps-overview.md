# Unfixed Gaps — Code Review Round 2

> **Created:** 2026-05-09
> **Branch:** `feature/pdf-import-sms-gateway`
> **Status:** IN PROGRESS

---

## Summary

After completing 7 of 20 code review areas, 6 critical gaps were identified. 1 is now fully resolved; 5 remain.

| # | Gap | Severity | Status | Task Document |
|---|-----|----------|--------|---------------|
| 1 | API Pagination | High | ✅ COMPLETE | task-01-api-pagination.md |
| 2 | Dashboard Performance | High | ❌ NOT STARTED | task-02-dashboard-performance.md |
| 3 | Missing Database Indexes | High | ❌ NOT STARTED | task-03-database-indexes.md |
| 4 | Type Safety (any casts) | Medium | ❌ NOT STARTED | task-04-type-safety.md |
| 5 | Frontend Code Unreviewed | High | ❌ NOT STARTED | task-05-frontend-review.md |
| 6 | Realm Cascading Delete | Medium | ❌ NOT STARTED | task-06-realm-cascading-delete.md |

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

### What Was Fixed in This Round (Commits f340005 → 93feb25)

- **API Pagination** — full backend + frontend + E2E implementation
  - `parsePagination` utility with `isPaginated` flag for backward compat
  - Backend pagination for tenants, properties, leases
  - Frontend `useInfiniteQuery` + Load More button
  - CORS `Access-Control-Expose-Headers` at API level (gateway proxy overwrites)
  - 5 E2E tests verifying full flow with 105 items
  - Query key collision fix (`['properties', 'list']`)

### What Remains

The 5 gaps above (tasks 02–06) — each requires code changes, tests, and verification.

---

## Completion Criteria

All gaps are resolved when:
1. Every step in every task document is checked off
2. All new code compiles with 0 TypeScript errors
3. All existing tests still pass (278+)
4. New tests written for each fix pass
5. No regressions in E2E suite

---

## Recommended Priority Order

1. **Task 03 (Indexes)** — pairs with Task 01; pagination with `skip/limit` does full collection scan without indexes
2. **Task 02 (Dashboard)** — highest memory impact, straightforward aggregation refactor
3. **Task 05 (Frontend Review)** — security implications (XSS, token handling)
4. **Task 06 (Realm Delete)** — data integrity, simpler fix (prevent delete if has children)
5. **Task 04 (Type Safety)** — maintainability, lowest urgency but highest effort
