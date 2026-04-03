---
inclusion: always
---
# MRE — UI Migration Tracker

Last updated: 2026-04-03 17:30

## Goal
Remove all legacy Material UI v4, Formik+Yup, and MobX patterns from the landlord app per `frontend-patterns.md`. Replace with shadcn/ui+Tailwind, react-hook-form+zod, and React Query.

## Status Summary
- **MUI removal:** ✅ COMPLETE — zero @material-ui imports remain
- **Form migration:** ✅ COMPLETE — all 22 forms migrated from Formik+Yup to react-hook-form+zod
- **Dependency cleanup:** ✅ COMPLETE — formik, yup, @material-ui/*, @date-io/*, material-ui-formik-components removed
- **formfields/ directory:** ✅ DELETED — 10 legacy Formik wrapper files removed
- **E2E tests:** Suites 01-09 (100 tests) verified passing. Suites 10-17 (57 tests) verified passing. Suites 20-28: 158 tests, all passing. Suites 30-67: business logic, presence, multi-landlord, tenant portal. Total: 601 tests across 57 suites.
- **MobX→React Query:** ✅ COMPLETE — all 12 stores resolved, MobX fully removed
- **Store reactivity:** ✅ FIXED — subscribe/notify pattern with useSyncExternalStore (replaced counter hack)

## How to Run Tests (without getting stuck)

### Prerequisites — MUST verify before running E2E
1. **Container runtime is `finch`** (not docker). All commands use `finch compose`.
2. **`.env` must contain `API_URL=http://api:8200/api/v2`** — docker compose does NOT read `base.env` for variable substitution. If `API_URL` is missing, the gateway crashes silently with `Missing "target" option`.
3. **Dev mode required for code changes** — GHCR images don't pick up local changes. Always start with dev compose overlay.

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

# Quick smoke test
curl -s http://localhost:8080/landlord/signin | head -1   # Should return HTML
curl -s -X DELETE http://localhost:8080/api/reset          # Should return "success"
```

### Run unit tests (no Docker needed)
```bash
cd services/api && npx jest --no-coverage
# Expects: 3 suites, 48 tests, all passing
```

### Run E2E tests
```bash
cd e2e && npx cypress run
# Expects: 9 suites, 100 tests (suites 01-09)
# Runtime: ~5 minutes in dev mode
```

### Run single E2E suite (for debugging)
```bash
cd e2e && npx cypress run --spec cypress/e2e/04_contracts.cy.js
```

### Common failures and fixes
| Symptom | Cause | Fix |
|---------|-------|-----|
| Gateway container "Exited" | `API_URL` missing from `.env` | Add `API_URL=http://api:8200/api/v2` to `.env` |
| Tests pass locally but code changes not reflected | Running from GHCR images (prod mode) | Stop all, restart with dev compose overlay |
| `finch: command not found` | Wrong shell or PATH | Use `/usr/local/bin/finch` |
| Next.js serves stale code after file changes | Dev server compilation cache | Restart landlord-frontend container |

### Stop everything
```bash
finch compose -f docker-compose.microservices.base.yml -f docker-compose.microservices.dev.yml down
```

---

## MobX → React Query Migration ✅ COMPLETE
All 12 MobX stores resolved. `mobx` and `mobx-react-lite` removed from package.json. Zero MobX imports remain.

| # | Store | Lines | Status |
|---|-------|-------|--------|
| 1 | Dashboard | 41 | ✅ Store deleted (zero refs, data via RQ) |
| 2 | Accounting | 60 | ✅ Store deleted (zero refs, data via RQ) |
| 3 | Lease | 91 | ✅ Store deleted (data via RQ, passed as props) |
| 4 | Property | 136 | ✅ Store deleted (data via RQ, passed as props) |
| 5 | Tenant | 162 | ✅ Store deleted (data via RQ, passed as props to 14 child components) |
| 6 | Rent | 250 | ✅ Store deleted (zero refs, data via RQ) |
| 7 | Template + Document | 193 | ✅ Stores deleted (data via RQ in DocumentsForm + TemplateList) |
| 8 | Organization + User | 254 | ✅ Converted to plain classes with subscribe/notify. `useSyncExternalStore` in StoreContext for auth/session reactivity. |
| 9 | AppHistory | 16 | ✅ Converted to plain class with subscribe/notify |
| 10 | Remove MobX deps | — | ✅ mobx, mobx-react-lite removed from package.json |

## Future Tasks
- **Landlord app → TypeScript:** Migrate all JS files to TS after MobX removal is complete (touching all files anyway)

## Installed Dependencies
- `react-hook-form@7.54.2`, `@hookform/resolvers@3.3.2`, `zod@3.24.2` added to landlord package.json

## Established Migration Patterns

### MobX→RQ Bridge Pattern (HISTORICAL — no longer needed, MobX fully removed)
When migrating a page from MobX to React Query, child components may still read from the MobX store. You MUST sync RQ data back to the store:
```js
// In the page component:
const { data } = useQuery({ queryKey: [...], queryFn: fetchX });

// 1. Sync query data to store via useEffect
useEffect(() => {
  if (data) store.x.setSelected(data);
}, [data, store.x]);

// 2. Sync mutation results IMMEDIATELY in onSuccess (not just invalidateQueries)
const mutation = useMutation({
  mutationFn: updateX,
  onSuccess: (data) => {
    store.x.setSelected(data);  // <-- sync BEFORE invalidateQueries
    queryClient.invalidateQueries({ queryKey: [...] });
  }
});
```
Without step 2, child components see stale store data between mutation completion and query refetch. This caused the contract stepper bug.

### Auth form pattern (C1-C4):
```js
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
// useForm({ resolver: zodResolver(schema), defaultValues: {...} })
// <form onSubmit={handleSubmit(handler)}>
// <Input {...register('field')} />
// {errors.field && <p className="text-sm text-destructive">{errors.field.message}</p>}
// <Button type="submit" disabled={isSubmitting}>
```

### Dialog form pattern (C5-C7):
```js
// useForm + formRef for external submit
const formRef = useRef();
// <form ref={formRef} onSubmit={handleSubmit(handler)}>
// Footer: <Button onClick={() => formRef.current?.requestSubmit()}>
// Switch: <Switch checked={watch('field')} onCheckedChange={(v) => setValue('field', v)} />
// Select: <Select onValueChange={(v) => setValue('field', v)}>
// Conditional validation: z.refine((data) => !data.flag || data.field.length > 0, ...)
```

---

## Phase A — MUI Component Replacements ✅ COMPLETE

| # | Task | Status | Notes |
|---|------|--------|-------|
| A1 | Delete dead code (styles/styles.js, unused toJS import) | ✅ | |
| A2 | Map.js — replace MUI useTheme() with hardcoded color | ✅ | `#2563eb` replaces `theme.palette.info.main` |
| A3 | Remove MuiPickersUtilsProvider from Application.js | ✅ | Done in commit a95731f |
| A4 | TenantStepper.js — replace MUI Stepper with shadcn Stepper | ✅ | |
| A5 | LeaseStepper.js — replace MUI Stepper with shadcn Stepper | ✅ | |
| A6 | RentHistoryDialog.js — replace MUI Accordion with shadcn Collapsible | ✅ | |
| A7 | RichTextEditorDialog.js — replace MUI Dialog+withStyles with shadcn Dialog | ✅ | |

## Phase B — MUI Infrastructure Removal ✅ COMPLETE

| # | Task | Status | Notes |
|---|------|--------|-------|
| B1 | Remove MUI ThemeProvider/CssBaseline from _app.js | ✅ | |
| B2 | Remove ServerStyleSheets from _document.js | ✅ | Also removed getInitialProps |
| B3 | Delete styles/theme.js | ✅ | |
| B4 | Update E2E commands (muiSelect/muiSelectText → shadcn selectors) | ✅ | muiSelect/muiSelectText now alias to selectByLabel (shadcn combobox) |
| B5 | Remove @material-ui/* deps from package.json | ✅ | @material-ui/core, @material-ui/pickers, @date-io/*, formik, yup, material-ui-formik-components all removed |

## Phase C — Form Migration (Formik+Yup → react-hook-form+zod) ✅ COMPLETE

### Simple auth forms
| # | File | Status |
|---|------|--------|
| C1 | pages/signin.js | ✅ |
| C2 | pages/signup.js | ✅ |
| C3 | pages/forgotpassword.js | ✅ |
| C4 | pages/resetpassword/[resetToken].js | ✅ |

### Dialog forms
| # | File | Status |
|---|------|--------|
| C5 | NewPropertyDialog.js | ✅ |
| C6 | NewTenantDialog.js | ✅ |
| C7 | NewLeaseDialog.js | ✅ |

### Medium forms
| # | File | Status |
|---|------|--------|
| C8 | PropertyForm.js | ✅ |
| C9 | UploadDialog.js | ✅ |
| C10 | LandlordForm.js | ✅ |
| C11 | BillingForm.js (org) | ✅ |
| C13 | MemberFormDialog.js | ✅ |
| C14 | ApplicationFormDialog.js | ✅ |
| C15 | LeaseForm.js | ✅ |
| C16 | FileDescriptorDialog.js | ✅ |
| C20 | BillingForm.js (tenant) | ✅ |
| C21 | TerminateLeaseDialog.js | ✅ |
| C22 | firstaccess.js | ✅ (delegates to LandlordForm) |

### Complex forms
| # | File | Status |
|---|------|--------|
| C12 | ThirdPartiesForm.js | ✅ |
| C17 | PaymentTabs.js | ✅ |
| C18 | TenantForm.js | ✅ |
| C19 | LeaseContractForm.js | ✅ |

### Cleanup
| # | Task | Status |
|---|------|--------|
| C23 | Remove formik, yup deps; delete formfields/ dir | ✅ |

## Phase D — E2E Tests

| # | Task | Status |
|---|------|--------|
| D1 | Create 100 E2E tests covering all UI functionality | ✅ | 100/100 passing (9 suites, 2m34s) |
| D2 | Deepen E2E coverage (edit, delete, payment, termination, error states) | ✅ | 6 new suites: 10_edit_flows, 11_lease_toggle, 12_payments, 13_termination, 14_delete_integrity, 15_validation_errors |

---

## Refactoring Review (2026-03-30) — Updated 2026-04-01

### Overall Assessment: Migration complete. MobX fully removed.

All HIGH and MEDIUM bugs fixed. `restcalls.js` standardized (no more MobX dependencies). E2E test coverage expanded with 6 new suites covering edit, toggle, payment, termination, delete integrity, and validation flows. These tests will catch the exact class of regressions that the MobX→RQ migration produces.

### What was fixed (2026-03-31):
- Lease toggle: `{ store, lease }` → `{ ...lease, active }`
- 4 stale forms: added `values: initialValues` to PropertyForm, TenantForm, LeaseContractForm, BillingForm
- Router singleton: `import router` → `useRouter()` hook
- LandlordForm validation: `.refine()` → `.superRefine()` with per-field errors
- TemplateForm Section: added `visible` prop
- Dead MUI cleanup: removed `useEffect` from `_app.js`
- Dead code: deleted `commonui/components/FormFields/` (17 files)
- `restcalls.js`: all 4 store-dependent functions rewritten as direct API calls

### Remaining known issues (non-blocking):
- LeaseContractForm expenses bypass `useFieldArray` (manual `setValue` with array splice)
- `store.organization.selected` used in 40 files for auth/session context (plain class, not MobX — acceptable as-is)

---

## Bugs Found During Code Review (2026-03-30)

Every bug below was introduced during the MUI→shadcn and Formik→RHF migrations.

### 🔴 HIGH — Lease active toggle ✅ FIXED (2026-03-31)
**Fix:** Changed `{ store, lease }` to `{ ...lease, active }` — eliminates cache mutation and passes correct arg to `updateLease()`.

### 🟡 MEDIUM — Stale `defaultValues` in 4 forms ✅ FIXED (2026-03-31)
**Fix:** Added `values: initialValues` to `useForm()` in PropertyForm, TenantForm, LeaseContractForm, BillingForm (tenant).

### 🟡 MEDIUM — Lease detail page router singleton ✅ FIXED (2026-03-31)
**Fix:** Replaced `import router from 'next/router'` with `const router = useRouter()` hook.

### 🟢 LOW — LandlordForm company validation ✅ FIXED (2026-03-31)
**Fix:** Replaced `.refine()` with `.superRefine()` for per-field error paths. Added error display for legalStructure, ein, capital.

### 🟢 LOW — TemplateForm Section visibility ✅ FIXED (2026-03-31)
**Fix:** Added `visible` prop to Section component.

### 🟢 LOW — Dead MUI jss-server-side cleanup ✅ FIXED (2026-03-31)
**Fix:** Removed dead `useEffect` from `_app.js`.

### 🟢 LOW — LeaseForm stale defaultValues ✅ FIXED (2026-03-31)
**Fix:** Added `values: initialValues` to `useForm()` call.

### 🟡 MEDIUM — Contract stepper submit button missing ✅ FIXED (2026-03-31)
**Root cause:** Lease store migration to RQ broke the contract stepper. `TemplateForm` read `stepperMode` from `store.lease.selected` (stale after RQ migration). The submit button only renders when `stepperMode` is true.
**Fix:** Pass `stepperMode` as prop to `TemplateForm` instead of reading from store. Lease data now flows from RQ `useQuery` → page → child components as props.

### 🟡 MEDIUM — Gateway crash from missing API_URL ✅ FIXED (2026-03-31)
**Root cause:** `.env` was missing `API_URL`. Docker compose doesn't read `base.env` for variable substitution. Gateway started with empty proxy target and crashed.
**Fix:** Added `API_URL=http://api:8200/api/v2` to `.env`.

### 🟡 MEDIUM — computeRent.test..js double-dot filename ✅ FIXED (2026-03-31)
**Root cause:** Typo in filename hid the test from Jest. The test was also failing because expense objects lacked `beginDate`/`endDate` (required since the Multiple Expenses feature).
**Fix:** Renamed file, added date fields to all 6 expense objects in `computeRent.test.js` and `contract.test.js`. All 48 unit tests now pass.

---

## Code Quality Issues

1. **Double/triple fetch in rents:** ✅ FIXED — `Actions` component now uses `useMutation` with `sendRentEmails` from `restcalls.js` and `queryClient.invalidateQueries()` in `onSuccess`. No more MobX `store.rent.sendEmail()` or `store.rent.fetch()`.

2. **Legacy MUI cleanup in `_app.js`:** ✅ FIXED (2026-03-31) — removed dead `useEffect` for `#jss-server-side`.

3. **commonui FormFields are dead code:** ✅ FIXED (2026-03-31) — deleted entire `commonui/components/FormFields/` directory (17 files) and removed re-export from `commonui/components/index.js`.

4. **Hybrid MobX+RQ dual source of truth:** ✅ RESOLVED — all stores migrated. `TerminateLeaseDialog` now uses `useMutation` + `updateTenant` from restcalls, no MobX. Rents page `Actions` uses `useMutation` + `sendRentEmails`, no MobX.

5. **`store.organization.selected` dependency everywhere:** 40 files still import `StoreContext`, 33 use `store.` — all for auth/session context only (`store.organization.selected`, `store.user`, `store.appHistory`). These are plain classes, not MobX. Acceptable as-is; could be refactored to React Context hooks later.

6. **`restcalls.js` inconsistency:** ✅ FIXED (2026-03-31) — all 4 store-dependent functions rewritten as direct API calls. Every function now takes plain data and returns `response.data`.

---

## Required Stabilization Before Continuing Migration

### ✅ COMPLETED (2026-03-31)

1. ✅ Fix the HIGH bug — lease active toggle
2. ✅ Fix the 5 MEDIUM stale-form bugs — add `values:` prop (including LeaseForm)
3. ✅ Fix the router singleton in lease detail page
4. ✅ Standardize `restcalls.js` — all functions now take plain data objects
5. ✅ Add E2E tests for: edit property, edit tenant, toggle lease active, record payment, terminate lease, delete with referential integrity, validation errors
6. ✅ Fix contract stepper bridge sync (TemplateForm stepperMode prop + onSuccess sync)
7. ✅ Fix gateway crash (API_URL in .env)
8. ✅ Fix computeRent.test..js (rename + add expense dates)
9. ✅ Fix commonui dead code (delete Loading.js, Illustration.js, remove dead deps)
10. ✅ All tests green: 48 unit tests, 100 E2E tests
11. ✅ MobX→RQ migration complete — all 12 stores resolved

---
