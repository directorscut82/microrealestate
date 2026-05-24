---
inclusion: always
---
# MRE — Test Running Guide

## Rules

1. **NEVER run tests without guardrails.** Use `--config defaultCommandTimeout=15000,pageLoadTimeout=30000` to fail fast.
2. **Read the test file before running it.** Identify obvious issues first.
3. **Fix root causes before running.** If multiple suites share a broken command, fix the command first.
4. **Lower timeouts for debugging.** Don't wait 60s for something that should appear in 5s.
5. **NEVER use `DELETE /api/reset` as a smoke test.** It wipes the entire database. Use `curl http://localhost:8080/landlord/signin | head -1` instead.

## Environment Setup

Before running any E2E tests:

```bash
# Verify all 11 containers are up
finch ps -a --format '{{.Names}} {{.Status}}'

# Verify gateway is healthy
finch logs microrealestate-gateway-1 2>&1 | tail -3
# Must show: "Gateway ready and listening on port 8080"

# Smoke test
curl -s http://localhost:8080/landlord/signin | head -c 50
```

## Running Tests

### Single suite with guardrails

```bash
cd /Users/epitrogi/Development/microrealestate/e2e
npx cypress run \
  --spec "cypress/e2e/XX_suite_name.cy.js" \
  --config defaultCommandTimeout=15000,pageLoadTimeout=30000 \
  2>&1 | tail -40
```

- `defaultCommandTimeout=15000` — fail assertions after 15s, not 60s
- `pageLoadTimeout=30000` — fail page loads after 30s

### Incremental testing within a suite

When debugging a suite with sequential tests (testIsolation: false):

**Important:** `.only` on test N runs ONLY test N, skipping all others. With sequential tests this breaks dependencies. Instead:

1. Temporarily add `it.skip()` to all tests AFTER the first one — run just before hook + test 1
2. Remove `skip` from test 2 (now tests 1+2 run in order) — verify
3. Continue removing `skip` one test at a time until you find the failure
4. Remove all `skip` when done

### Batch run (verified suites only)

```bash
cd /Users/epitrogi/Development/microrealestate/e2e
npx cypress run \
  --spec "cypress/e2e/01_authentication.cy.js,cypress/e2e/02_first_access.cy.js,..." \
  --config defaultCommandTimeout=15000,pageLoadTimeout=30000 \
  2>&1 | tail -40
```

- Only batch suites that are already verified passing

### Using --bail

Not available as a CLI flag in Cypress 14. Use the `cypress-fail-fast` plugin or check results after each suite.

## Debugging Failures

1. Read the error message — is it a timeout? Wrong selector? Missing element?
2. Read the test code — what does it expect?
3. Read the app code — does the app actually do what the test expects?
4. Determine: **code bug** or **test bug**
5. If code bug → fix the app, re-run
6. If test bug → fix the test, re-run
7. **Never weaken assertions to make tests pass**
8. **Check backend logs** when failures are unexpected:
   ```bash
   finch logs microrealestate-api-1 2>&1 | tail -20
   finch logs microrealestate-gateway-1 2>&1 | tail -20
   finch logs microrealestate-authenticator-1 2>&1 | tail -20
   ```

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `shortcutAddProperty` not found | Dashboard not in first-connection mode | Use page buttons instead of dashboard shortcuts |
| `cy.contains(text)` fails on form page | Text is in an input value, not visible text | Use `cy.get('input').should('have.value', text)` |
| `ol.toaster > li` not found | Toast didn't appear or wrong selector | Check if the API actually returns an error |
| `[data-cy=orgMenu]` not found after reload | Store reactivity issue | Verify InjectStoreContext uses useSyncExternalStore |
| Page redirects to firstaccess after reload | Auth flow race condition | Verify Authentication.js uses getStoreInstance() |
| Next.js serves stale code | Dev server compilation cache | Restart landlord-frontend container |
| Gateway container "Exited" | `API_URL` missing from `.env` | Add `API_URL=http://api:8200/api/v2` to `.env` |
| Tests pass locally but code changes not reflected | Running from GHCR images (prod mode) | Stop all, restart with dev compose overlay |
| `finch: command not found` | Wrong shell or PATH | Use `/usr/local/bin/finch` |
| Next.js serves stale code after file changes | Dev server compilation cache | Restart landlord-frontend container |

## How to Run Tests (without getting stuck)

### Prerequisites — MUST verify before running E2E
1. **Container runtime is `finch`** (not docker). All commands use `finch compose`.
2. **`.env` must contain `API_URL=http://api:8200/api/v2`** — docker compose does NOT read `base.env` for variable substitution. If `API_URL` is missing, the gateway crashes silently with `Missing "target" option`.
3. **`.env` must have `MONGO_URL=mongodb://mongo/mredb`** — base.env defaults to `demodb` which is wrong. All real data is in `mredb`.
4. **Dev mode required for code changes** — GHCR images don't pick up local changes. Always start with dev compose overlay.

### Start services (dev mode)
```bash
cd /Users/epitrogi/Development/microrealestate
finch compose -f docker-compose.microservices.base.yml -f docker-compose.microservices.dev.yml up -d
```

### Verify before running tests
```bash
# All 11 containers must be "Up" (not "Exited")
finch ps -a --format '{{.Names}} {{.Status}}'

# Gateway must NOT have errors in logs
finch logs microrealestate-gateway-1 2>&1 | tail -5
# Should end with: "Gateway ready and listening on port 8080"

# Quick smoke test — SAFE, does NOT modify data
curl -s http://localhost:8080/landlord/signin | head -1   # Should return HTML
```

### Run unit tests (no Docker needed)
```bash
cd services/api && npx jest --no-coverage
# Expects: 14 suites, 319 tests (309 passing, 10 failing as of May 2026)
```

### Run E2E tests
```bash
cd e2e && npx cypress run
# Full run: 67 suites, 583 tests (~523-551 pass per run)
# Runtime: ~15-20 minutes in dev mode
```

### Run single E2E suite (for debugging)
```bash
cd e2e && npx cypress run --spec cypress/e2e/04_contracts.cy.js
```

### Common failures and fixes
| Symptom | Cause | Fix |
|---------|-------|-----|
| Gateway container "Exited" | `API_URL` missing from `.env` | Add `API_URL=http://api:8200/api/v2` to `.env` |
| App shows signup page but user exists | `MONGO_URL` pointing to wrong database | Verify `.env` has `MONGO_URL=mongodb://mongo/mredb` |
| Tests pass locally but code changes not reflected | Running from GHCR images (prod mode) | Stop all, restart with dev compose overlay |
| `finch: command not found` | Wrong shell or PATH | Use `/usr/local/bin/finch` |
| Next.js serves stale code after file changes | Dev server compilation cache | Restart landlord-frontend container |

### Stop everything
```bash
finch compose -f docker-compose.microservices.base.yml -f docker-compose.microservices.dev.yml down
```

---

## Production Database Protection (Triple-Layer)

The test infrastructure has three layers preventing accidental production data loss:

1. **Layer 1 — resetservice `assertTestDatabase` guard**: The resetservice checks its own `MONGO_URL` and returns 403 if connected to `mredb` (production). Tests use `mredb_test`. This is enforced at the application level regardless of which compose overlay is active.

2. **Layer 2 — Cypress `before()` hook**: The `resetAppData` command verifies the reset endpoint URL points to the expected test database before wiping.

3. **Layer 3 — Pre-test backup script** (`backup-before-tests.sh`): Takes a mongodump before E2E runs as a safety net.

**Key behavior:**
- E2E tests wipe `mredb_test` (NOT `mredb`)
- Production data in `mredb` is NEVER touched by tests
- If resetservice is accidentally pointed at `mredb`, it refuses with HTTP 403
- The `docker-compose.microservices.test.yml` sets `MONGO_URL=mongodb://mongo/mredb_test`
- Dev mode (`docker-compose.microservices.dev.yml`) uses `mredb` for the app but `mredb_test` for resetservice

---

## Running Unit Tests (no Docker needed)

```bash
cd services/api && npx jest --no-coverage
# Expects: 14 suites, 319 tests (309 passing, 10 failing as of May 2026)
```

## Container Management

### Start services (dev mode)
```bash
cd /Users/epitrogi/Development/microrealestate
finch compose -f docker-compose.microservices.base.yml -f docker-compose.microservices.dev.yml up -d
```

### Stop everything
```bash
finch compose -f docker-compose.microservices.base.yml -f docker-compose.microservices.dev.yml down
```

### Restart landlord frontend (after code changes)
```bash
finch restart microrealestate-landlord-frontend-1
```

### Reclaim Finch disk space (run periodically)
The Finch VM uses a 50GB raw disk image at `~/.finch/.disks/`. Pulling/rebuilding accumulates layer data that macOS doesn't auto-reclaim. If `du -sh ~/.finch` is in the tens of gigabytes:

```bash
# Stop the dev stack first
finch compose -f docker-compose.microservices.base.yml -f docker-compose.microservices.dev.yml down

# Remove unused images/containers/build cache + all unused volumes
finch system prune -a -f
finch volume prune -a -f

# Tell macOS to reclaim freed blocks (this is the step that actually shrinks the file)
export LIMA_HOME=/Applications/Finch/lima/data
/Applications/Finch/lima/bin/limactl shell finch sudo fstrim -v /mnt/lima-finch
```

A typical reclaim after months of dev use is 30+ GB. `finch vm disk resize` can only grow, not shrink, so trimming is the correct approach. See `documentation/FINCH_SETUP.md` for full details.

---

## Test Suite Status

| Suite | Tests | Status |
|-------|-------|--------|
| 01-09 | 100 | ✅ Verified passing |
| 10-17 | 57 | ✅ Verified passing |
| 20 | 22 | ✅ Passes, occasionally fails (selectByLabel timing) |
| 21 | 19 | ✅ Verified passing (fixed: data-cy for Customize dates) |
| 22-23 | 31 | ✅ Passes, 22 occasionally fails (selectByLabel timing) |
| 24 | 7 | ✅ Verified passing (fixed: firstName field) |
| 25 | 22 | ⚠️ 20/22 — "Copie de" name check fails when before hook has selectByLabel timing issue |
| 26-27 | 42 | ✅ Verified passing |
| 28 | 15 | ⚠️ Occasionally fails in before hook (selectByLabel timing) |
| 30-42 | 129 | ✅ Verified passing |
| 50-57 | 61 | ✅ Verified passing |
| 58 | 14 | ✅ Verified passing |
| 59 | 5 | ❌ 2/5 — pre-existing React hydration error #418 (not related to feature branch) |
| 60-62 | 26 | ✅ Verified passing |
| 63-68 | 30 | ✅ Verified passing |
| 70 | 6 | ✅ Verified passing (archive feature) |

### Non-deterministic selectByLabel failures
Some suites (20, 22, 25, 27, 28) occasionally fail because the Radix Select dropdown opens before React Query data loads. The `selectByLabel` command retries up to 5 times (close/reopen), which helps but doesn't eliminate the issue. These suites pass on re-run.

## Before Running Suites 20-28

1. Read ALL 9 test files first
2. Fix the `addPropertyFromStepper` / `addTenantFromStepper` commands to work outside first-connection mode
3. Check each suite's `before` hook for the same issue
4. Run incrementally with guardrails
