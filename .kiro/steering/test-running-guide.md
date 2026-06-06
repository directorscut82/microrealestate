---
inclusion: always
---
# MRE — Test Running Guide

## Two test surfaces

1. **Unit tests** — `services/<svc>/jest` per service. Run on local Node, no containers needed.
2. **E2E tests** — Playwright at `e2e-playwright/`, runs against the **live NAS** (not a local stack).

The old Cypress suite at `e2e/` was deleted in commit `e478a59` (May 2026). Don't look for it. The historic context is captured in [`documentation/E2E_TESTING.md`](../../documentation/E2E_TESTING.md).

## Definition of "done" (non-negotiable, READ FIRST)

**Nothing is "done", "fixed", "working", "shipped", or "verified" until a real Playwright browser drives the actual user flow end-to-end through deployed NAS UI and the assertions hold.** A green test suite is NOT proof of correctness. Five categories of evidence are required for every claim:

1. **A spec exists for the user flow** — not just the underlying API call, the actual click-by-click journey a landlord takes (open page → click button → fill form → submit → see result → re-open and verify).
2. **The spec asserts set-narrowing or value-delta** — not existence. `expect(rows).toHaveCount(N)` after a search, `expect(balance).toBe(grandTotal - paid)` after a payment. **`toBeVisible()` on a single row when the unfiltered list also contains that row is a tautology and does not count as coverage.** This is what spec 03 was for two months and what shipped the search bug.
3. **The spec exercises refetch resilience for any UI that holds state** — type → wait past staleTime / blur+focus / trigger mutation → re-assert state holds. React Query background refetch is the #1 footgun in this codebase; flows that don't simulate it haven't tested anything that matters in production.
4. **The spec runs against the deployed revision** — verify Portainer revision matches the commit BEFORE running the spec (see "Verifying a deploy" below). A spec that passes against stale code is worse than no spec.
5. **Manual browser spot-check of the same flow** — at least once per substantive change. Open the deployed app at http://192.168.0.96:1350/landlord/, sign in, do the thing the user would do. Five minutes of human use beats every test suite.

**No test counts as a pass if it was made green by:**
- Loosening assertions (`toBeTruthy()` on a status, `toBeVisible().or(...)` on outcomes that should be deterministic).
- Conditional pass-on-either-outcome (`if (patchHappened) annotate else assert button enabled`).
- Hacks like overly-long timeouts that mask races.
- Skipping an assertion because "the test itself was wrong" without writing the correct assertion in the same PR.
- Reverting to a baseline that "had this passing" without verifying the revert actually restores the user flow.

**No claim of "fixed" or "shipped" without:**
- Naming the spec(s) that prove it.
- Showing the green run output AND the deployed revision they ran against.
- A second pair of eyes (or workflow) that didn't write the fix doing the verification.

**These are the surfaces that MUST have refetch-resilience coverage** (the surfaces that have been bitten in production):
- Tenants index search by name / phone / email
- Tenants index filter chips (Lease running / Lease ended / archived toggle)
- Properties index search by name / atak / address / surface
- Properties index filter chips (vacant / occupied / by type)
- Buildings index search by name / address
- Buildings index filter chips (hasElevator / hasCentralHeating)
- Rents index search by tenant name / payment reference
- Rents index filter chips (notpaid / partiallypaid / paid)
- Payment dialog: open / fill / record / re-open / edit / delete / record again
- Express drawer: open / multi-tenant settle / verify each row
- Cross-page invalidation: record on /rents → /dashboard / /accounting / /tenants/:id within same session

If you ship a change to any of those surfaces and the spec covering it doesn't exist or doesn't assert refetch resilience, **write the spec in the same PR or the change is not done.** This is the rule that would have caught the search/filter bug on day 1 instead of day 3.

## Search / filter scenario catalog (REQUIRED coverage)

The bug that shipped on suite #6 and lived through 12 suite runs was caught by zero of 155 tests because the canary asserted `toBeVisible()` on a row that was visible in the unfiltered list anyway. The catalog below MUST be implemented as actual specs. Each one is a separate `test(...)` block.

### Tenants index (`/[org]/tenants`)

1. Type 6 chars of a phone1 → list narrows to 1 row by `toHaveCount(1)` (NOT `toBeVisible`). Assert a known non-matching tenant is `not.toBeVisible`.
2. Type 6 chars of a phone1, wait 30s past React Query staleTime → list still shows the same 1 row. Assert search input still has the typed text.
3. Type a substring in name → list narrows. Then trigger a mutation in another tab (or `page.evaluate(queryClient.invalidateQueries)`) → list still narrows.
4. Type, then click "Lease running" filter chip → list narrows further (filter AND search compose). Assert toHaveCount.
5. Click "Lease running" filter chip with empty search → list filters by status. Toggle off → full list returns.
6. Click "Lease ended" filter chip when 0 tenants are terminated → list shows empty state.
7. Click "Show archived" toggle → archived tenants appear. Toggle off → archived disappear.
8. Type a substring, click on a tenant card → navigate to detail. Click Back → search input still populated, list still narrowed.
9. Type a query that matches 0 tenants → empty state visible, paginator absent.
10. Type, then clear the input → full list restored.

### Properties index (`/[org]/properties`)

11. Type 4 chars of property name → list narrows by toHaveCount.
12. Type 4 chars of `atakNumber` → list narrows.
13. Type 4 chars of `address.street1` → list narrows.
14. Type a 2-digit `surface` value → list narrows.
15. Click "vacant" filter chip → only vacant properties (server `status='vacant'`).
16. Click "occupied" filter chip → only occupied.
17. Click an apartment-type filter (e.g. "apartment") → only that type.
18. Click multiple filter chips (multi-select) → AND'd filter.
19. Type a substring + click a filter chip → both apply, count is intersection.
20. Type, navigate to detail, Back → state preserved.
21. Type → wait past staleTime → search still active.

### Buildings index (`/[org]/buildings`)

22. Type 3 chars of building name → toHaveCount narrows.
23. Type a city → narrows.
24. Click "hasElevator" filter chip → only buildings with elevator.
25. Click "hasCentralHeating" filter chip → only those with heating.
26. Both chips selected → intersection.
27. Type + chip → both apply.
28. Type → trigger refetch → narrowing holds.

### Rents index (`/[org]/rents/:yyyy.mm`)

29. Type tenant name in search → row narrows.
30. Click "In arrears" filter chip → only `status='notpaid'` rows.
31. Click "Partially settled" → only `status='partiallypaid'`.
32. Click "Settled" → only `status='paid'`.
33. Multi-select 2 status chips → union.
34. Type a payment reference → row matching that reference is shown.
35. Type, then record a payment via the cash icon → after drawer closes and rents refetch, search input still populated AND the row reflects the new payment AND list still narrowed.
36. Type, navigate to next month, navigate back → search preserved.
37. Click filter chip → record a payment that flips status of one tenant → that tenant's row leaves the filtered list (status changed) → assert.

### Cross-surface (where the bug actually compounds)

38. Tenants page filter active → record a payment for the FIRST tenant in the filtered list (via the row's cash icon if exposed there, or via deep-link to /rents) → return to /tenants → filter still active.
39. Open Express drawer with rents-page filter active → only filtered tenants appear in Express list.
40. Search active on tenants → click a tenant → terminate them → Back → tenant either still in filtered set (if filter doesn't include status) or removed (if it does). Either way, deterministic, asserted.

The catalog targets ~40 distinct scenarios. Group them into specs `25_search_filter_tenants.spec.ts`, `26_search_filter_properties.spec.ts`, `27_search_filter_buildings.spec.ts`, `28_search_filter_rents.spec.ts`, `29_search_filter_cross_surface.spec.ts` to parallelize and keep file sizes manageable. Each spec must use `toHaveCount` / `not.toBeVisible` set-narrowing assertions, NOT `toBeVisible` on a single matching row.

These scenarios are NOT optional. If you change anything in `ResourceList/List.js`, `SearchFilterBar.js`, or any consumer's `_filterData`, the relevant scenarios from this catalog must run green against the deployed revision before the change ships. If they don't exist yet, write them in the same PR.

## Rules (non-negotiable)

1. **Never weaken assertions to make a test pass.** If a test fails, decide whether it's a real app bug or a real test-shape problem before touching anything. Both fix paths exist; "delete the assertion" is not one of them.
2. **Never call `cy.resetAppData()` or `DELETE /api/reset` against NAS.** The endpoint doesn't exist on NAS (resetservice isn't deployed) but if it did, it would wipe production data.
3. **The mandatory mongodump backup must run before every Playwright invocation.** The backup script (`e2e-playwright/backup-nas-before-tests.sh`) exits non-zero on any failure; the runner refuses to start if a valid archive isn't on disk in `e2e-playwright/backup/`.
4. **Test data lives in a dedicated realm** (`CYPRESS-TEST-DO-NOT-USE`) under a bot account. Credentials are in `.secrets/cypress-test-account` (gitignored). Specs scope all writes by `realmId`.
5. **Status assertions on every awaited HTTP response.** `expect(resp.status(), 'descriptive label').toBe(200)` — never `toBeTruthy()` on a status. A 422 silently passing `cy.wait('@alias')` is what made the old Cypress suite useless.
6. **Round-trip read-back after every write.** Edit → submit → re-open the dialog or re-GET the resource → assert the value is what you submitted. Saving and rendering are two failure modes; assert both.
7. **No arbitrary `waitForTimeout(N)`.** Wait on `page.waitForResponse(...)`, locator visibility, or `expect.poll()`. If you need a wall-clock wait, you have a real race condition in the app — surface it, don't paper over it.

## Running E2E tests

### Prereqs (one-time)

- `~/Development/microrealestate/.secrets/portainer-token` — Portainer API token used by the backup script.
- `~/Development/microrealestate/.secrets/cypress-test-account` — bot account credentials. Created by the harness; if missing, ask before regenerating.
- The NAS must be reachable on LAN (`http://192.168.0.96:1350`).

### Backup + run the full suite

```bash
cd /Users/epitrogi/Development/microrealestate/e2e-playwright
yarn test:nas
# script chains: backup-nas-before-tests.sh && playwright test
# typical runtime: ~17s, 17 passed + 1 fixme as of June 2026
```

### Run a single spec

```bash
cd /Users/epitrogi/Development/microrealestate/e2e-playwright
bash ./backup-nas-before-tests.sh
yarn playwright test tests/01_expense_edit.spec.ts --reporter=list
```

The backup is required even for a single spec. Don't skip it.

### Open the Playwright UI

```bash
cd /Users/epitrogi/Development/microrealestate/e2e-playwright
yarn test:nas:ui
```

Useful for selector-debugging. Same backup gate.

### Open a failure trace

When a spec fails, Playwright drops a trace at `e2e-playwright/test-results/<spec>/trace.zip`.

```bash
cd /Users/epitrogi/Development/microrealestate/e2e-playwright
yarn playwright show-trace test-results/01_expense_edit.../trace.zip
```

Trace UI shows DOM at every step + network + console — usually enough to identify the failure mode in 30 seconds.

## Writing a new spec

Use the canonical example: `e2e-playwright/tests/01_expense_edit.spec.ts`. The pattern is:

1. **Arrange** — call an `ensureSeedX` helper from `tests/lib/api.ts` to set up test data idempotently. Add a new helper if no existing one fits; don't inline 50 lines of seed code per spec.
2. **Act** — sign in via UI (or call `getAccessToken` for API-only specs), navigate, perform the user action.
3. **Assert** — status code on the response, then a round-trip read-back of the persisted state.

### Test categories — UI vs API-only

- **UI specs** drive the browser: `await page.goto(...)`, `page.locator(...)`, `page.waitForResponse(...)`. Use when the bug is in the form-to-API wiring (e.g., RHF dropping a field).
- **API specs** call `request.newContext()` then `apiCtx.post/patch/get(...)`. Use when the bug is purely server-side (validators, auth guards, response shape). Same harness, no browser, ~10× faster per spec.

### Common URL gotcha

The Playwright `baseURL` ends with `/landlord/` (trailing slash matters — without it, `goto('signin')` would replace the `/landlord` segment instead of appending). The `[organization]` URL segment is the realm **name** (not its `_id`); use `encodeURIComponent(realmName)` because the test realm name contains dashes.

### Common API gotcha

The API's `_stringToDate` parser is strict on `DD/MM/YYYY`. ISO `YYYY-MM-DD` will return 422 with `Invalid date: ...`. Use the `toDDMMYYYY` shim in `lib/api.ts` for any date field on tenant/lease/property POSTs.

## Running unit tests

```bash
cd services/api && npx jest --no-coverage
```

Per-service jest, no Docker. Run from the service directory.

**Notable suites under `services/api/src/businesslogic/__tests__/`:**

- `rent.test.js` — full computation pipeline (taskBase → taskDebts → taskDiscounts → taskVATs → taskBalance → taskPayments → taskTotal)
- `paymentEdgeCases.test.js` — settlement edge cases, allocation surplus, partial-payment carry-forward
- `dashboardManagerComputePaidByBucket.test.js` — round-3i accuracy: walks `rent.payments[]` with allocation-aware spreading or oldest-debt-first auto-spread, distributes per `rent` / `charges` / `building:<type>` buckets. Run when changing `dashboardmanager.ts:_computePaidByBucket()` or the rent-pipeline category mapping.

Imports in the test files reference the **source** TS files (`../../managers/dashboardmanager.js`); jest resolves them through the workspace's TS preset, no separate build step needed.

## Production database protection

E2E tests target the **live NAS**, but writes are scoped to a dedicated test realm. Three independent layers prevent collateral damage to your real data:

1. **Pre-test mongodump backup** — runs before every spec invocation; archive saved to `e2e-playwright/backup/mredb_pre_test_<ts>.archive`. Backups are local-only (gitignored).
2. **Realm scoping** — every API call from a spec carries `organizationid: <test_realm_id>`. The test account is the only admin of that realm and has zero membership in your real org.
3. **Discipline** — never POST `DELETE /api/reset` from a spec. The endpoint isn't deployed on NAS, but the harness has no business calling it regardless.

If a spec ever appears to write to your real data: **stop, restore from the most recent backup**:

```bash
finch cp e2e-playwright/backup/<archive> mongo-container:/tmp/restore.archive
finch exec mongo-container mongorestore --archive=/tmp/restore.archive --drop
```

(On NAS, replace `finch exec` with the Portainer container-exec API or SSH.)

## Discipline rule audit (when reviewing a spec)

Before merging a new spec, grep it for:

- `cy.wait(` — should be 0 occurrences (Cypress-ism, the file should use Playwright APIs).
- `waitForTimeout(` — should be 0; if present, the author is papering over a race.
- `\.toBeTruthy\(\)` on a `.status()` — should be 0; demand a numeric status.
- A `page.waitForResponse(...)` that isn't followed by an `expect(resp.status(), ...).toBe(...)` — that's a toothless test, the old Cypress trap.
- `force: true` on a click — should be 0; if a click is unstable, find the real cause (viewport, hidden parent, animation).
- `hasText: '<tenantName>'` on a span locator — substring-match. Use `:text-is("<tenantName>")` instead. **The June 2026 substring-trap incident**: when spec 19 leaves `E2E-LeasedTenant-B` in the realm, a `hasText: 'E2E-LeasedTenant'` selector matches the *wrong* tenant first; the dialog opens on B, the seed clear-PATCH targets A, and every assertion downstream is wrong.
- `moment(date, 'YYYY-MM-DD', true)` next to a `moment.utc(other, ...)` — timezone mismatch. Both anchors must use `.utc(...)` OR neither.
- `getUTCMonth()` next to a URL navigation that uses `getMonth()` — the seed and the test's UI navigation must agree on which month they target.

## Suite-level realm hygiene

E2E tests target the live NAS. The realm `CYPRESS-TEST-DO-NOT-USE` accumulates state across runs:

- `ensureSeedLeasedTenant` is idempotent on tenant *creation* but does NOT reset all fields on every run. If a prior spec set `terminationDate`, `guarantyPayback`, etc., those persist.
- The Mongoose update path doesn't `$unset` when you PATCH a field with `null` — `_stringToDate(null) → undefined → setOps drop the field → Mongoose preserves existing value`. Workaround for stuck state: drop into mongo directly:

```bash
PT=$(cat .secrets/portainer-token)
MONGOID=$(curl -s "http://192.168.0.96:9000/api/endpoints/3/docker/containers/json?all=true" \
  -H "X-API-Key: $PT" | jq -r '.[] | select(.Names[0] | test("mongo")) | .Id')
PAYLOAD=$(jq -n '{
  AttachStdout: true, AttachStderr: true,
  Cmd: ["mongo", "mredb", "--quiet", "--eval",
        "printjson(db.occupants.updateOne({_id: ObjectId(\"<TID>\")}, {$unset: {terminationDate: \"\"}}))"]
}')
EXEC=$(curl -s -X POST -H "X-API-Key: $PT" -H "Content-Type: application/json" \
  "http://192.168.0.96:9000/api/endpoints/3/docker/containers/$MONGOID/exec" \
  -d "$PAYLOAD" | jq -r .Id)
curl -s -X POST -H "X-API-Key: $PT" -H "Content-Type: application/json" \
  "http://192.168.0.96:9000/api/endpoints/3/docker/exec/$EXEC/start" \
  -d '{"Detach":false,"Tty":false}'
```

The mongo container ships mongo 4.4's legacy `mongo` CLI (not `mongosh`). Database is `mredb`. Collection is `occupants` (Mongoose-side, the model name is `'Occupant'`; even though TypeScript types call it `Tenant`).

## Verifying a deploy actually landed before running E2E

`yarn deploy:nas` is a foreground script that orchestrates merge-to-nas → push → CI wait → image pull → Portainer stack update → container revision verification. If you background it (`& yarn deploy:nas`), bash returns exit 0 the instant it backgrounds — the actual deploy may still be in CI wait for ~5 minutes. **Never run E2E against a stale revision.**

```bash
# Always verify the running revision matches the commit you pushed:
PT=$(cat .secrets/portainer-token)
curl -s "http://192.168.0.96:9000/api/endpoints/3/docker/containers/json?all=true" -H "X-API-Key: $PT" \
  | jq -r '.[] | select(.Names[0] | test("landlord-frontend|mre-api-1")) | "\(.Names[0]) \(.Labels."org.opencontainers.image.revision"[0:8])"'
```

Both the API and frontend containers must be on the same revision before re-running tests.

## Known stable failures (June 2026 baseline = 133/155 pass)

The following 5 tests fail on the current `a9d3fbab` build and they are **test-side bugs**, not app bugs. Don't "fix" them by changing app code:

- **spec 03 `tenant search by partial phone1`** — RESOLVED on master in `49040d15` (June 1 2026). Re-running this spec against any revision ≥ `49040d15` should pass. The note about the `fb024ed4` race is preserved for archaeology only — the resolved fix takes a different shape (delete the init useEffect rather than feed it current state).
- **spec 15 S36/S37** — assert that a date `last day of current month` and `5 days into next month` pass the server's F3 guard. They pass when run near month-end but fail when run on day 1-22 of the month because the date is ≥7 days away → "too far in future" guard fires. Test should compute the date dynamically against `today + 5d` instead of "month end".
- **spec 17 C28 `double-clicking Record does not double-fire PATCH`** — flaky timing race against the 80ms submittingRef fallback. Don't tighten the timeout (see AGENTS.md "saga"); accept the flake.
- **spec 19 L06 `adding a building expense lifts next-rent grandTotal`** — test logic computes the wrong expected delta. Expense isn't reflected in the next month because `Contract.payTerm` only generates rent for the requested term (not future months); the assertion needs to PATCH the next month explicitly to trigger regeneration.

If a NEW failure appears outside that list, it's a real regression and you should investigate.

## Verified-clean summary (June 2026 audit waves A–F)

The audit waves run between late May and early June 2026 catalogued
behaviors as either "fix required" (shipped under batches A–E) or
"verified clean / behavior is correct as-is". The clean list is recorded
here so future agents don't re-investigate already-confirmed behavior
and don't accidentally regress it during cleanup work.

**Behaviors verified correct as-is (do NOT change without re-running the
relevant probe first):**

- **Past-month overpayment propagation** — has two regimes documented in
  `documentation/DEFERRED_DECISIONS.md` D-8. T4 probes confirmed:
  surplus DOES cascade through unfrozen downstream months naturally;
  surplus is locked in the touched term only when downstream months
  have their own settlements (the `_isFrozen` guard in
  `services/api/src/managers/contract.ts:271-276` is intentional and
  load-bearing).
- **Payment dialog `submittingRef` 80ms reset fallback** — load-bearing.
  Several attempts to tighten or remove this timeout broke the entire
  dialog flow. The C28 double-click race remains a known test flake;
  accept it. See AGENTS.md "saga" section.
- **Greek lease parser, IRIS QR generation, RF payment codes** — covered
  by the 13 unit tests in `services/api/src/managers/__tests__/`. Don't
  rewrite the parser regexes without re-running those.
- **Frontend store reactivity (`InjectStoreContext` /
  `useSyncExternalStore`)** — current shape (subscribe + notify, plain
  classes) is a deliberate replacement for MobX. Don't reintroduce
  `mobx` or `mobx-react-lite`.
- **`destructUrl()` port-stripping** — known limitation tracked under
  Phase 5.5. The `APP_DOMAIN=host:port` workaround is the documented
  escape hatch; CORS regex builder consumes `APP_DOMAIN` verbatim.
- **Dashboard pie tooltip layout** — kept as 3-column table per round-3o
  decision. Pie segments themselves still use the `paidRatio` estimate
  (per explicit instruction). Don't change segment math without
  re-running `dashboardManagerComputePaidByBucket.test.js`.
- **Auto-spread payment allocation order (oldest-debt-first)** — used by
  both `paymentAllocation.js` (frontend) and `_computePaidByBucket`
  (backend). They operate on different bucket spaces (rent-pipeline
  category space vs dashboard-display category space) — kept separate
  intentionally. See round-3i comment block in
  `services/api/src/managers/dashboardmanager.ts`.
- **Multi-document updates without MongoDB transactions** — see §4.10
  note in roadmap-hardening.md. The deployed Mongo is a single-node,
  not a replica set; transactions cannot be enabled without a
  topology change. Optimistic concurrency on individual documents is
  the current correctness mechanism.

If you read this list and are about to "fix" one of these items: stop,
re-run the probe that validated the existing behavior first, and confirm
the regression you think you see is real. The audit waves spent a lot of
time confirming these are correct; the cost of re-verification is
cheaper than the cost of regressing them.

## Test inventory

See `e2e-playwright/tests/`. Every spec file's leading comment names the wave-24 bug it covers and the trigger condition. The PR description on master (search PR title "Add Playwright E2E harness") summarizes coverage.

When the count grows past ~30 specs, consider extracting Page Object classes (one per landlord screen) — until then the duplication is cheaper than the abstraction.
