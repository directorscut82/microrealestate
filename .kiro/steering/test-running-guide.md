---
inclusion: always
---
# MRE — Test Running Guide

## Two test surfaces

1. **Unit tests** — `services/<svc>/jest` per service. Run on local Node, no containers needed.
2. **E2E tests** — Playwright at `e2e-playwright/`, runs against the **live NAS** (not a local stack).

The old Cypress suite at `e2e/` was deleted in commit `e478a59` (May 2026). Don't look for it. The historic context is captured in [`documentation/E2E_TESTING.md`](../../documentation/E2E_TESTING.md).

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

- **spec 03 `tenant search by partial phone1`** — known regression from the List.js init useEffect revert; the search box doesn't refilter on data refetch. To re-fix, the search-clobbered fix must be done WITHOUT clobbering the user's typed search (the previous attempt fb024ed4 broke 60+ dialog tests).
- **spec 15 S36/S37** — assert that a date `last day of current month` and `5 days into next month` pass the server's F3 guard. They pass when run near month-end but fail when run on day 1-22 of the month because the date is ≥7 days away → "too far in future" guard fires. Test should compute the date dynamically against `today + 5d` instead of "month end".
- **spec 17 C28 `double-clicking Record does not double-fire PATCH`** — flaky timing race against the 80ms submittingRef fallback. Don't tighten the timeout (see AGENTS.md "saga"); accept the flake.
- **spec 19 L06 `adding a building expense lifts next-rent grandTotal`** — test logic computes the wrong expected delta. Expense isn't reflected in the next month because `Contract.payTerm` only generates rent for the requested term (not future months); the assertion needs to PATCH the next month explicitly to trigger regeneration.

If a NEW failure appears outside that list, it's a real regression and you should investigate.

## Test inventory

See `e2e-playwright/tests/`. Every spec file's leading comment names the wave-24 bug it covers and the trigger condition. The PR description on master (search PR title "Add Playwright E2E harness") summarizes coverage.

When the count grows past ~30 specs, consider extracting Page Object classes (one per landlord screen) — until then the duplication is cheaper than the abstraction.
