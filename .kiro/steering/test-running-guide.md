---
inclusion: always
---
# MRE — Test Running Guide

## Rules

1. **NEVER run tests without guardrails.** Use `--config defaultCommandTimeout=15000,pageLoadTimeout=30000` to fail fast.
2. **Read the test file before running it.** Identify obvious issues first.
3. **Fix root causes before running.** If multiple suites share a broken command, fix the command first.
4. **Lower timeouts for debugging.** Don't wait 60s for something that should appear in 5s.

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
curl -s -X DELETE http://localhost:8080/api/reset
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
| Next.js serves stale code | Dev server cache | Restart landlord-frontend container |
| Gateway container "Exited" | `API_URL` missing from `.env` | Add `API_URL=http://api:8200/api/v2` to `.env` |
| Tests pass locally but code changes not reflected | Running from GHCR images (prod mode) | Stop all, restart with dev compose overlay |
| `finch: command not found` | Wrong shell or PATH | Use `/usr/local/bin/finch` |

## Running Unit Tests (no Docker needed)

```bash
cd services/api && npx jest --no-coverage
# Expects: 3 suites, 48 tests, all passing
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

---

## Test Suite Status

| Suite | Tests | Status |
|-------|-------|--------|
| 01-09 | 100 | ✅ Verified passing |
| 10-17 | 57 | ✅ Verified passing |
| 20-28 | ~200 | ❌ Not verified — known issue: addPropertyFromStepper uses dashboard shortcuts |

## Before Running Suites 20-28

1. Read ALL 9 test files first
2. Fix the `addPropertyFromStepper` / `addTenantFromStepper` commands to work outside first-connection mode
3. Check each suite's `before` hook for the same issue
4. Run incrementally with guardrails
