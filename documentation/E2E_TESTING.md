# E2E Testing — MRE

> Canonical reference for the Playwright E2E suite at `e2e-playwright/`.
> This is a live, NAS-targeted harness. The old Cypress suite at `e2e/`
> was deleted in commit `e478a59` (May 2026); its history lives in the git
> log and a brief postmortem appears in [Why Playwright?](#why-playwright)
> below.

## Quick start

```bash
cd e2e-playwright
yarn test:nas              # backup + run full suite headless
yarn test:nas:ui           # backup + Playwright UI mode (debug)
yarn test:nas:headed       # backup + run with visible browser
```

A single spec:

```bash
cd e2e-playwright
bash ./backup-nas-before-tests.sh
yarn playwright test tests/01_expense_edit.spec.ts --reporter=list
```

The mandatory mongodump backup runs before every invocation. The runner
refuses to start if a valid archive isn't on disk.

## Architecture

### Layout

```
e2e-playwright/
├── package.json                       # @microrealestate/e2e-playwright workspace
├── playwright.config.ts               # baseURL = NAS landlord, viewport 1440x1200
├── tsconfig.json
├── backup-nas-before-tests.sh         # Portainer-exec mongodump → local Mac
├── backup/                            # gitignored archives
└── tests/
    ├── lib/
    │   └── api.ts                     # idempotent seed helpers
    ├── 00_nas_smoke.spec.ts
    ├── 01_expense_edit.spec.ts        # wave-24 bug 1
    ├── 02_unit_occupancy.spec.ts      # wave-24 bug 9
    ├── 03_tenant_search.spec.ts
    ├── 04_property_energy_cert.spec.ts
    ├── 05_rent_tile_dimming.spec.ts   # wave-24 bug 8
    ├── 06_dashboard_finance.spec.ts   # wave-24 bug 10
    ├── 07_repair_past_term_guard.spec.ts  # wave-24 bug 4
    ├── 09_lease_id_authoritative.spec.ts
    ├── 10_last_admin_guard.spec.ts
    ├── 11_tenantapi_me.spec.ts
    └── 12_validators.spec.ts
```

`08_email_dedup` was attempted and dropped — the email dedup gate requires
a fully-leased tenant + configured SMTP, which isn't worth the seed
scaffolding cost yet.

### Where tests run

Specs target **the live NAS at `http://192.168.0.96:1350`**. They do NOT
require a local Finch stack. The reasons:

- The bugs that escape unit tests (frozen rent ledgers, locale-aware
  rendering, real CORS, real Redis/MongoDB) only reproduce against the
  same stack the user actually uses. A local stack with seeded data hides
  these failure modes.
- macOS 26 + Cypress 14/15 + Electron 37 has an upstream code-signing
  regression (no fix shipped). Running E2E in a different runtime against
  a different stack would reintroduce the "works on my machine" gap.

### Test isolation

All writes go to a dedicated realm named **`CYPRESS-TEST-DO-NOT-USE`**
under a bot account whose credentials live in `.secrets/cypress-test-account`
(gitignored). The bot has zero membership in your real org. Every API
call from a spec carries `organizationid: <test_realm_id>`, so even if a
spec malfunctions it cannot read or modify your real data.

The mandatory pre-test backup is a second line of defense — if anything
ever does go wrong, the most recent backup at
`e2e-playwright/backup/mredb_pre_test_<ts>.archive` is the recovery
artifact.

## Discipline rules

These are non-negotiable. Every existing spec follows them; reviewers
should reject specs that don't.

### 1. Status assertion on every awaited HTTP response

```ts
const r = await page.waitForResponse(url => url.includes('/expenses/'));
expect(r.status(), 'expense PATCH must succeed').toBe(200);
```

The old Cypress suite had `cy.wait('@updateExpense')` and called it done
— a 422 made that line pass without complaint. That's how the
expense-edit bug survived 30+ Cypress cycles.

### 2. Round-trip read-back after every write

After submitting a form, **re-open the dialog or re-GET the resource and
assert the value is what you submitted**. Saving and rendering are
distinct failure modes:

```ts
// Wrong (what the old suite did): assume submit = persist
await page.locator('input[name=amount]').fill('300');
await page.click('button:has-text("Update")');
// done — but did it actually persist?

// Right:
await page.locator('input[name=amount]').fill('300');
const resp = await page.waitForResponse(...);
expect(resp.status()).toBe(200);
// Re-open the dialog and verify
await page.click('button[aria-label=edit]');
await expect(page.locator('input[name=amount]')).toHaveValue('300');
```

### 3. No arbitrary `waitForTimeout`

`waitForTimeout(N)` is almost always a bandaid for a race condition.
Wait for an event the app actually emits:

- `page.waitForResponse(predicate)` — for an API call
- `expect(locator).toBeVisible()` — for a DOM change
- `expect.poll(() => somePredicate, { timeout: N })` — for a derived condition

If you can't express the wait without a wall clock, you've found a real
race in the app. Surface it; don't paper over it.

### 4. No weakening assertions to make a test pass

When a spec fails:

1. Read the error.
2. Decide: real app bug, test-shape mismatch, environment problem, or
   real test bug.
3. Fix the right thing.

Removing the assertion is **never** the right thing. The old Cypress
suite has commits literally titled `fix: simplify suite N — remove flaky
intermediate checks`. We don't do that.

If a test exposes a real bug, file/fix the bug. If a test asserts the
wrong contract (like spec 09's initial `toBe(200)` where the actual fix
returned `toBe(422)` — both correct security properties, different
shapes), update the assertion to match the **actual** contract and
document why.

### 5. No `force: true` on clicks

A click that needs `force: true` to land is hiding a real problem:
viewport too small, parent has `pointer-events: none`, animation in
progress, etc. Find and fix the cause. Often the right fix is
`scrollIntoViewIfNeeded()`, sometimes a viewport bump in
`playwright.config.ts`.

### 6. Idempotent seeds

Specs reuse fixture entities by name (`E2E-Building`, `E2E-Expense`,
`E2E-Property`, `E2E-LeasedTenant`, `E2E-Lease`, etc.). The
`ensureSeedX` helpers in `lib/api.ts` are find-or-create. Re-running a
spec twice in a row must produce the same result. Specs that mutate a
fixture should restore it (or assert idempotency another way) so
ordering doesn't matter.

## Adding a new spec

1. **Identify the trigger condition.** Read the source file containing
   the fix. What state is needed for the bug to fire?
2. **Find or write the seed helper.** If existing helpers don't cover
   the state, add one to `lib/api.ts`. Don't inline 50 lines of seed
   code per spec.
3. **Write the spec following the canonical pattern** in
   `01_expense_edit.spec.ts`:
   ```ts
   test.beforeAll(() => {
     if (!TEST_EMAIL || !TEST_PASSWORD) throw new Error(...);
   });

   test('descriptive name', async ({ page }) => {
     // arrange
     const apiCtx = await request.newContext();
     const seed = await ensureSeedX(apiCtx);
     await apiCtx.dispose();

     // act
     await page.goto('signin');
     // ... sign in, navigate, perform the action

     // assert: status code on the response
     const resp = await ...waitForResponse(...);
     expect(resp.status(), 'descriptive message').toBe(200);

     // assert: round-trip read-back
     // ... navigate or re-open, assert value is what we submitted
   });
   ```
4. **Run it.** It must pass on first try, or fail with a clear,
   actionable error. If you find yourself adding `force: true`,
   `waitForTimeout`, or weakening an assertion to make it pass —
   stop and re-read this doc.
5. **Run the whole suite** to confirm no regressions, then commit.

## Common gotchas

### Timezone mismatches break date guards silently (June 2026 incident)

The form-side and server-side date guards both convert `'YYYY-MM-DD'` strings to moments and compare. **If one anchor uses `moment.utc(...)` and the other uses `moment(...)`** (local), the same calendar day parses to two absolute instants that disagree by hours. On Athens (UTC+2/+3), that's enough to flip an `isBefore` check around midnight or month boundary.

The June 2026 instance:

- `services/api/src/managers/rentmanager.ts` F3 guard — `parsed = moment.utc(p.date,'DD/MM/YYYY',true)` ✓
- `webapps/landlord/src/components/payment/PaymentTabs.js` `_handleSubmit` — pre-`a9d3fbab` had `_parsed = moment(...)` while `_termFirstDay = moment.utc(...)` — bug. Fixed to `moment.utc(...)`. Symptom: every payment dialog test fired a "Payment date is before this rent month" toast and the PATCH never reached the server.
- `e2e-playwright/tests/lib/api.ts` `ensureSeedLeasedTenantWithPayment` — uses `getMonth()` / `getFullYear()` (LOCAL) so the URL term matches the test's UI navigation (also LOCAL). Don't change to UTC.

**Rule:** when reviewing a spec or a guard, grep for `moment\(` next to `moment\.utc\(` in the same function. They MUST match.

### Substring-trap on tenant name selectors

If two tenants exist where one's name is a prefix of another's (e.g. `E2E-LeasedTenant` and `E2E-LeasedTenant-B`), `page.locator('span', { hasText: 'E2E-LeasedTenant' })` matches BOTH. The `.first()` may pick the wrong one depending on render order. Use exact-match: `page.locator('span:text-is("E2E-LeasedTenant")')`.

This bit suite #7 hard when spec 19's L07 created tenant B and a panic mid-test left it in the realm. Every subsequent test that opened "the seed tenant's dialog" actually opened B's dialog and timed out asserting against A.

### Realm leakage — terminationDate gets stuck

Spec 19 L02 sets `terminationDate` on the seed tenant via API. The test's afterAll cleanup PATCHes `terminationDate: null` to undo, but the server's `_stringToDate(null) → undefined` makes Mongoose preserve the existing value. If the test panics before cleanup, the canonical seed tenant ends up permanently terminated → disappears from current+future rent grids → every dialog test downstream times out finding the row.

Recovery: drop into mongo directly (4.4 shell, not mongosh; database is `mredb`, collection is `occupants` — Mongoose model name is `'Occupant'` even though TypeScript types call it `Tenant`):

```js
db.occupants.updateOne(
  { _id: ObjectId("<seed_tenant_id>") },
  { $unset: { terminationDate: "", guarantyPayback: "" } }
)
```

Triggered via Portainer's docker-exec API (see `.kiro/steering/test-running-guide.md` for the curl recipe).

### `baseURL` must end with `/landlord/`

The trailing slash matters. Without it, `page.goto('signin')` would
replace the `/landlord` segment and hit the gateway 404. With the slash,
it appends correctly.

### `[organization]` URL segment is the realm NAME, not `_id`

The landlord SPA uses the realm name as the URL slug. The test realm is
named `CYPRESS-TEST-DO-NOT-USE` — note the dashes. Always wrap with
`encodeURIComponent(realmName)` in case future realm names contain
characters needing escape.

### API date format is `DD/MM/YYYY`, not ISO

The API's `_stringToDate` parser (`services/api/src/managers/occupantmanager.ts:34`)
is strict on `moment(input, 'DD/MM/YYYY', true)`. ISO `YYYY-MM-DD` from
`Date.toISOString().substring(0,10)` returns 422 with `Invalid date: ...`.
The `toDDMMYYYY` shim in `lib/api.ts` converts.

### Status codes for create endpoints

Most managers use `res.json(...)` rather than `res.status(201).json(...)`,
so creates return 200 not 201. Use `expect([200, 201]).toContain(resp.status())`
in seed helpers.

### Tenants render as Cards, not table rows

The tenants index and rents page render each tenant as a Card-style
`div`, not a `<tr>`. `page.locator('tr', { has: ... })` won't match.
Use `page.locator('div', { has: page.locator('text=...') }).first()`.

### Form viewports

The default Playwright viewport is `1280x720`. The landlord app's edit
dialogs are tall (e.g. unit form has ~12 inputs). The submit button
falls below the dialog's internal scroll container at the default
height. We use `1440x1200` globally — set in `playwright.config.ts`.
If you ever need to scroll within a dialog, use
`element.scrollIntoViewIfNeeded()` before clicking.

## Surfacing real production bugs

The harness is also a passive monitor. Specs that fail with HTTP 504,
500, or unexpected non-app errors are surfacing real NAS issues — not
test bugs. **Investigate before "fixing" the spec.**

The first such finding (May 2026): spec 11's `tenantapi/tenant/me`
test failed with 504. Root cause was a 41-hour-old config bug —
`docker-compose.nas.yml` was missing `REDIS_URL` and `depends_on:redis`
on the tenantapi block. The container had been crash-looping against
Redis at `127.0.0.1:6379` since startup. Compose patched, redeployed,
container healthy, spec green.

When a spec fails this way:

1. **Independently confirm the failure mode** with `curl` or Portainer
   logs — don't trust the test runner alone.
2. **Read the failing service's logs** via Portainer container API.
3. **Find root cause** (env var, network, dependency, image revision).
4. **Patch + redeploy**, then re-run the spec.

## Running locally vs CI

Right now the suite runs **only on the developer's Mac** against the
NAS. There's no CI integration yet. Adding it requires either:

- A self-hosted GitHub Actions runner with LAN access to the NAS, or
- Tailscale-connected runner, or
- Exposing the NAS gateway publicly behind auth (not recommended).

This is deferred until the suite has enough specs to make CI valuable
(currently ~17, target before CI is ~50-100).

## Why Playwright?

The repo originally had 68 Cypress 14 specs that were systematically
broken:

- **Only 2 of 68 specs (3%) asserted HTTP status codes** on
  `cy.wait('@alias')`. A 422 silently passed `cy.wait` so the assertion
  shape made the entire suite incapable of catching API failures.
- **Twenty-plus commits in git history** weakening or deleting tests
  (`fix: simplify suite N — remove flaky intermediate checks`,
  `fix: suite 56 — remove termination tests`). The "agent gets stuck and
  weakens the test" anti-pattern was institutional.
- **The fork stripped E2E from CI** — the suite hadn't run on push for
  months.
- **Cypress 14.4.1 + 15.16.0 both fail to start on macOS 26.5** due to
  an upstream Electron 37 + Apple code-signing regression with no fix
  shipped (cypress-io/cypress#33793, #33423).

Switching to Playwright was a forcing function: re-establishing the
discipline rules in a fresh codebase made it impossible to import the
old anti-patterns.

The deletion is preserved in commit `e478a59` if anyone needs to
reference an old custom command.
