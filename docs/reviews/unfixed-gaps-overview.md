# Unfixed Gaps — Code Review Round 2

> **Created:** 2026-05-09
> **Branch:** `feature/pdf-import-sms-gateway`
> **Status:** IN PROGRESS

---

## Summary

After completing 7 of 20 code review areas, 6 critical gaps remain unfixed. Each gap has a dedicated task document with step-by-step resolution plan.

| # | Gap | Severity | Category | Task Document |
|---|-----|----------|----------|---------------|
| 1 | API Pagination | High | Scalability | [task-01-api-pagination.md](./task-01-api-pagination.md) |
| 2 | Dashboard Performance | High | Performance | [task-02-dashboard-performance.md](./task-02-dashboard-performance.md) |
| 3 | Missing Database Indexes | High | Performance | [task-03-database-indexes.md](./task-03-database-indexes.md) |
| 4 | Type Safety (any casts) | Medium | Maintainability | [task-04-type-safety.md](./task-04-type-safety.md) |
| 5 | Frontend Code Unreviewed | High | Security/Quality | [task-05-frontend-review.md](./task-05-frontend-review.md) |
| 6 | Realm Cascading Delete | Medium | Data Integrity | [task-06-realm-cascading-delete.md](./task-06-realm-cascading-delete.md) |

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

### What Remains (This Document)

The 6 gaps above — each requires code changes, tests, and verification.

---

## Completion Criteria

All 6 gaps are resolved when:
1. Every step in every task document is checked off
2. All new code compiles with 0 TypeScript errors
3. All existing tests still pass (259+)
4. New tests written for each fix pass
5. No regressions in E2E suite
