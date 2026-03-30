---
inclusion: always
---
# MRE — UI Migration Tracker

Last updated: 2026-03-30 20:55

## Goal
Remove all legacy Material UI v4, Formik+Yup, and MobX patterns from the landlord app per `frontend-patterns.md`. Replace with shadcn/ui+Tailwind, react-hook-form+zod, and React Query.

## Status Summary
- **MUI removal:** ✅ COMPLETE — zero @material-ui imports remain
- **Form migration:** ✅ COMPLETE — all 22 forms migrated from Formik+Yup to react-hook-form+zod
- **Dependency cleanup:** ✅ COMPLETE — formik, yup, @material-ui/*, @date-io/*, material-ui-formik-components removed
- **formfields/ directory:** ✅ DELETED — 10 legacy Formik wrapper files removed
- **E2E tests:** ✅ 100/100 passing (9 suites, 2m34s) — BUT shallow: only happy paths and basic validation. No multi-tenant, payment, edit, termination, error state, or role-based tests. Not indicative of real usage. 50+ deeper tests still needed.
- **MobX→React Query:** 🔄 IN PROGRESS — migrating stores one by one

## MobX → React Query Migration Plan
12 MobX stores (1,427 lines), 71 consumer files, 155 store references.
`@tanstack/react-query` v5.29 already installed.

Migration order (simplest → most impactful):
| # | Store | Lines | Consumer files | Status |
|---|-------|-------|----------------|--------|
| 1 | Dashboard | 41 | 4 | ✅ |
| 2 | Accounting | 60 | 4 | ✅ |
| 3 | Lease | 91 | 10 | ✅ |
| 4 | Property | 136 | 6 | 🔄 IN PROGRESS |
| 5 | Tenant | 162 | 16 | ⬜ |
| 6 | Rent | 250 | 7 | ⬜ |
| 7 | Template + Document | 193 | 9 | ⬜ |
| 8 | Organization + User | 254 | 55 | ⬜ |
| 9 | AppHistory | 16 | 9 | ⬜ |
| 10 | Remove MobX deps | — | — | ⬜ |

## Future Tasks
- **Landlord app → TypeScript:** Migrate all JS files to TS after MobX removal is complete (touching all files anyway)

## Installed Dependencies
- `react-hook-form@7.54.2`, `@hookform/resolvers@3.3.2`, `zod@3.24.2` added to landlord package.json

## Established Migration Patterns

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

## Phase A — MUI Component Replacements ✅ MOSTLY DONE

| # | Task | Status | Notes |
|---|------|--------|-------|
| A1 | Delete dead code (styles/styles.js, unused toJS import) | ✅ | Zero regression risk |
| A2 | Map.js — replace MUI useTheme() with hardcoded color | ✅ | `#2563eb` replaces `theme.palette.info.main` |
| A3 | Remove MuiPickersUtilsProvider from Application.js | ⏳ BLOCKED | Needs DateField forms migrated first (5 forms use it) |
| A4 | TenantStepper.js — replace MUI Stepper with shadcn Stepper | ✅ | Used existing `components/Stepper.js` |
| A5 | LeaseStepper.js — replace MUI Stepper with shadcn Stepper | ✅ | Same as A4 |
| A6 | RentHistoryDialog.js — replace MUI Accordion with shadcn Collapsible | ✅ | |
| A7 | RichTextEditorDialog.js — replace MUI Dialog+withStyles with shadcn Dialog | ✅ | |

## Phase B — MUI Infrastructure Removal ✅ MOSTLY DONE

| # | Task | Status | Notes |
|---|------|--------|-------|
| B1 | Remove MUI ThemeProvider/CssBaseline from _app.js | ✅ | |
| B2 | Remove ServerStyleSheets from _document.js | ✅ | Also removed getInitialProps |
| B3 | Delete styles/theme.js | ✅ | |
| B4 | Update E2E commands (muiSelect/muiSelectText → shadcn selectors) | ❌ TODO | Blocked until forms use shadcn Select |
| B5 | Remove @material-ui/* deps from package.json | ❌ TODO | After A3 + all form migrations |

## Phase C — Form Migration (Formik+Yup → react-hook-form+zod)

### Simple auth forms (no MobX store dependency for data)
| # | File | Fields | Status |
|---|------|--------|--------|
| C1 | pages/signin.js | email, password | ✅ |
| C2 | pages/signup.js | firstName, lastName, email, password | ✅ |
| C3 | pages/forgotpassword.js | email | ✅ |
| C4 | pages/resetpassword/[resetToken].js | password, confirmationPassword | ✅ |

### Simple dialog forms (single field)
| # | File | Fields | Status |
|---|------|--------|--------|
| C5 | NewPropertyDialog.js | name, isCopyFrom, copyFrom | ✅ |
| C6 | NewTenantDialog.js | name, isCopyFrom, copyFrom | ✅ |
| C7 | NewLeaseDialog.js | name | ✅ |

### Medium forms
| # | File | Fields | Status |
|---|------|--------|--------|
| C8 | PropertyForm.js | name, type, description, surface, phone, digicode, address, rent | ✅ |
| C9 | UploadDialog.js | file upload | ❌ TODO |
| C10 | LandlordForm.js | org settings (already uses React Query mutations) | ✅ |
| C11 | BillingForm.js (org) | billing settings (already uses React Query mutations) | ✅ |
| C13 | MemberFormDialog.js | member management | ✅ |
| C14 | ApplicationFormDialog.js | API credentials | ✅ |
| C15 | LeaseForm.js | lease settings | ✅ |
| C16 | FileDescriptorDialog.js | file descriptor in lease | ✅ |
| C20 | BillingForm.js (tenant) | VAT toggle, billing | ✅ |
| C21 | TerminateLeaseDialog.js | termination date | ✅ |
| C22 | firstaccess.js | delegates to LandlordForm | ❌ TODO (done when C10 done) |

### Complex forms
| # | File | Fields | Status |
|---|------|--------|--------|
| C12 | ThirdPartiesForm.js | ~400 lines, third-party configs | ✅ |
| C17 | PaymentTabs.js | multi-tab payment form | ❌ TODO |
| C18 | TenantForm.js | contacts array | ✅ |
| C19 | LeaseContractForm.js | ~400 lines, properties array, dates, expenses | ❌ TODO |

### Cleanup
| # | Task | Status |
|---|------|--------|
| C23 | Remove formik, yup deps; delete formfields/ dir and commonui FormFields | ❌ TODO |

## Phase D — E2E Tests

| # | Task | Status |
|---|------|--------|
| D1 | Create 100 E2E tests covering all UI functionality | ❌ TODO |
| D2 | Run all E2E tests and fix failures | ❌ TODO |

---

## Files Still Importing @material-ui (as of 2026-03-30)

### Landlord app
- `src/components/Application.js` — MuiPickersUtilsProvider (blocked on form migration)

### Commonui (separate package, used by landlord)
- `components/Loading.js` — CircularProgress
- `components/FormFields/*.js` — All 15 form field wrappers (Input, Select, DateField, etc.)

### Dependencies to remove (after all migrations)
- `@material-ui/core`
- `@material-ui/icons`
- `@material-ui/pickers`
- `@date-io/moment`
- `material-ui-chip-input`
- `material-ui-formik-components`
- `formik`
- `yup`

---

## Migration Pattern for Forms

Each form migration follows this pattern:
1. Replace `import { Formik, Form } from 'formik'` with `import { useForm } from 'react-hook-form'`
2. Replace `import * as Yup from 'yup'` with `import { z } from 'zod'`
3. Replace Yup schema with zod schema
4. Replace `<Formik>` wrapper with `useForm({ resolver: zodResolver(schema) })`
5. Replace `<Form>` with `<form onSubmit={handleSubmit(onSubmit)}>`
6. Replace `<TextField name="x">` (Formik) with `<Input {...register('x')} />` (shadcn)
7. Replace `<SelectField>` (MUI) with `<Select>` (shadcn)
8. Replace `<DateField>` (MUI pickers) with shadcn Calendar/Popover or native date input
9. Replace `<SubmitButton>` (commonui) with shadcn `<Button type="submit">`
10. Keep all business logic (onSubmit handlers, store calls) unchanged

## Known Blockers
- A3 blocked on: C9, C14, C17, C19, C21 (forms using commonui DateField)
- B4 blocked on: C10, C22 (firstaccess form uses muiSelect for locale/currency)
- B5 blocked on: A3 + C23
- C22 is just firstaccess.js which delegates to LandlordForm (C10)

## Detailed Notes for Remaining Forms

### C8: PropertyForm.js (126 lines)
- Uses: TextField, SelectField, NumberField from commonui + local formfields
- Has address sub-fields (address.street1, address.street2, etc.)
- Uses `useFormikContext()` for external submit (parent calls submit)
- Needs: shadcn Input, Select, Textarea for description
- Complexity: Medium — address fields are nested objects

### C9: UploadDialog.js (193 lines)
- Uses: SelectField, DateField, UploadField from commonui
- Has custom Yup .test() validators for file size/mimetype
- Conditional expiryDate validation based on template.hasExpiryDate
- Needs: Custom file input, shadcn Calendar/Popover for date
- Complexity: High — file upload + conditional date + custom validation

### C10: LandlordForm.js (272 lines)
- Uses: TextField, SelectField, NumberField, RadioFieldGroup, RadioField, SubmitButton from commonui
- Has conditional company fields via Yup .when('isCompany')
- Uses react-query mutations (already modern)
- Has complex onSubmit with redirect logic
- Needs: shadcn Input, Select, RadioGroup for isCompany toggle
- Complexity: High — conditional fields, radio groups, currency/locale selects
- NOTE: firstaccess.js (C22) delegates to this component

### C11: BillingForm.js org (131 lines)
- Uses: TextField, AddressField, ContactField, SubmitButton from commonui
- Has conditional required fields based on org.isCompany
- Uses react-query mutations
- Needs: Replace AddressField and ContactField with inline shadcn fields
- Complexity: Medium — composite address/contact fields

### C12: ThirdPartiesForm.js (448 lines)
- LARGEST settings form
- Uses: TextField, SwitchField, SubmitButton from commonui
- Has sections for Gmail, SMTP, Mailgun, B2 storage configs
- Uses react-query mutations
- Complexity: High — many fields, multiple sections, but straightforward

### C13: MemberFormDialog.js (118 lines)
- Uses: TextField, SelectField from commonui
- Has dynamic validation (email notOneOf existing members)
- Uses react-query mutations
- Complexity: Low-Medium

### C14: ApplicationFormDialog.js (174 lines)
- Uses: TextField, DateField from commonui
- Has app credentials display
- Uses react-query mutations
- Complexity: Medium — has DateField (blocks A3)

### C15: LeaseForm.js (120 lines)
- Uses: TextField, SelectField, NumberField from commonui
- Has validate export used by LeaseStepper
- Complexity: Low-Medium

### C16: FileDescriptorDialog.js (148 lines)
- Uses: TextField, SwitchField, RadioFieldGroup, RadioField from commonui
- Has radio group for required/optional/requiredOnceContractTerminated
- Complexity: Medium — radio group needs shadcn RadioGroup

### C17: PaymentTabs.js (330 lines)
- Uses: DateField, NumberField, TextField from commonui
- Has multiple tabs (payment, promo, extra charges)
- Complex payment settlement logic
- Complexity: High — multi-tab, DateField (blocks A3)

### C18: TenantForm.js (232 lines)
- Uses: TextField, CheckboxField, AddressField, ContactField from commonui
- Has contacts array (dynamic add/remove)
- Has validate export used by TenantStepper
- Complexity: High — dynamic array fields

### C19: LeaseContractForm.js (458 lines)
- MOST COMPLEX FORM
- Uses: DateField, NumberField, SelectField, TextField from commonui
- Has properties array with nested expenses
- Has validate export used by TenantStepper
- Complex date calculations
- Complexity: Very High — nested arrays, dates, computed fields

### C20: BillingForm.js tenant (113 lines)
- Uses: NumberField, SwitchField from commonui
- Has VAT toggle with conditional vatRatio field
- Has validate export used by TenantStepper
- Complexity: Low

### C21: TerminateLeaseDialog.js (197 lines)
- Uses: DateField, NumberField, SelectField from commonui
- Has min/max date constraints
- Has tenant selection with dynamic date range update
- Complexity: Medium-High — DateField with constraints (blocks A3)
