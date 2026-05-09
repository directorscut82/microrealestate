# Task 02 — Dashboard Performance

> **Status:** NOT STARTED
> **Severity:** High
> **Category:** Performance
> **Files to modify:** `services/api/src/managers/dashboardmanager.ts`

---

## Problem

The dashboard endpoint loads **all tenants with their full embedded `rents[]` arrays** into Node.js memory. Each tenant can have years of rent history (60+ entries for 5 years monthly). With 200 tenants, that's 12,000+ rent objects loaded just to compute a summary.

## Impact

- Memory: ~2-5MB per dashboard request for moderate datasets
- Latency: 500ms+ response times as data grows
- Concurrency: Multiple simultaneous dashboard loads can spike heap to hundreds of MB
- MongoDB: Full document transfer over wire (no projection)

---

## Steps

### 1. Audit current dashboard queries

- [ ] Read `services/api/src/managers/dashboardmanager.ts` fully
- [ ] Identify all Mongoose queries and what fields they actually USE from results
- [ ] Document which fields from `rents[]` are needed (likely: current term's `grandTotal`, `payment`, `balance`)
- [ ] Identify if other tenant fields beyond rents are needed (name, properties, leaseId, beginDate, endDate)
- [ ] Check if dashboard has multiple query paths (first-connection vs normal mode)

### 2. Design optimized query strategy

- [ ] Option A: **Projection** — `.select('name properties leaseId beginDate endDate rents.$')` (partial array via `$elemMatch`)
- [ ] Option B: **Aggregation pipeline** — `$match` realm → `$project` only needed fields → `$unwind` rents → `$match` current term → `$group` for totals
- [ ] Option C: **Two queries** — one for tenant metadata (no rents), one aggregation for rent summaries
- [ ] Choose approach based on what dashboard actually renders
- [ ] Document chosen approach with rationale

### 3. Implement optimized query

- [ ] Replace `find()` with chosen approach
- [ ] If using aggregation:
  ```ts
  const pipeline = [
    { $match: { realmId } },
    { $project: {
      name: 1, beginDate: 1, endDate: 1, properties: 1,
      currentRent: {
        $filter: {
          input: '$rents',
          as: 'rent',
          cond: { $eq: ['$$rent.term', currentTerm] }
        }
      }
    }}
  ];
  ```
- [ ] If using projection: add `.select()` with only needed fields
- [ ] Ensure response shape matches what frontend expects

### 4. Handle the "overview" computations

- [ ] Identify summary calculations (total revenue, total unpaid, occupancy rate)
- [ ] Move these to aggregation `$group` stage if possible:
  ```ts
  { $group: {
    _id: null,
    totalRevenue: { $sum: '$currentRent.payment' },
    totalDue: { $sum: '$currentRent.grandTotal' },
    occupiedCount: { $sum: { $cond: [{ $gt: ['$endDate', now] }, 1, 0] } }
  }}
  ```
- [ ] Compare results with current implementation to ensure correctness

### 5. Memory usage verification

- [ ] Add temporary logging: `process.memoryUsage().heapUsed` before and after query
- [ ] Test with current data: measure memory before optimization
- [ ] Test with current data: measure memory after optimization
- [ ] Document improvement (should be 5-10x reduction)
- [ ] Remove temporary logging after verification

### 6. Write unit tests

- [ ] Mock Mongoose model with aggregation support
- [ ] Test: dashboard returns correct summary for single tenant
- [ ] Test: dashboard handles tenant with no rents for current term
- [ ] Test: dashboard handles empty realm (no tenants)
- [ ] Test: dashboard correctly computes occupancy (active vs expired leases)
- [ ] Test: response shape matches expected frontend contract

### 7. Response shape compatibility

- [ ] Compare old response shape with new response shape
- [ ] If shape changes: update frontend `useDashboard` hook or equivalent
- [ ] If shape preserved: verify with existing E2E dashboard tests
- [ ] Document any breaking changes

### 8. E2E verification

- [ ] Run dashboard-related E2E tests
- [ ] Verify dashboard page loads correctly
- [ ] Verify numbers displayed match expected values from seed data

---

## Verification Checklist

- [ ] TypeScript compiles with 0 errors
- [ ] Dashboard query no longer loads full rents arrays
- [ ] Memory usage per request reduced (measured)
- [ ] Response time improved for datasets > 50 tenants
- [ ] All existing unit tests pass
- [ ] New dashboard unit tests pass
- [ ] Dashboard E2E tests pass
- [ ] Frontend displays correct data (no visual regressions)

---

## Notes

- If aggregation approach is chosen, ensure MongoDB 7 supports all operators used
- The `$filter` operator on arrays is available since MongoDB 3.2 — safe to use
- Consider caching dashboard response in Redis (60s TTL) as future optimization
- First-connection mode (no data) should short-circuit before any query
- Monitor: after deploying, compare response times in logs (express-winston)
