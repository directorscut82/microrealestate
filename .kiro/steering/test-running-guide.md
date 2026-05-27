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

## Test inventory

See `e2e-playwright/tests/`. Every spec file's leading comment names the wave-24 bug it covers and the trigger condition. The PR description on master (search PR title "Add Playwright E2E harness") summarizes coverage.

When the count grows past ~30 specs, consider extracting Page Object classes (one per landlord screen) — until then the duplication is cheaper than the abstraction.
