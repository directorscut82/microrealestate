---
inclusion: always
---

# Frontend Patterns for New Pages (Landlord App)

This project has completed its migration from Material UI v4, Formik+Yup to shadcn/ui, react-hook-form+zod. MobX has been fully removed — all data fetching uses React Query, auth/session uses store classes with subscribe/notify reactivity via `useSyncExternalStore`. **Follow the patterns below for all new code.**

## UI Framework

Use **shadcn/ui + Tailwind CSS** (already configured in `components.json`).

- Import from `src/components/ui/` (e.g., `Button`, `Card`, `Dialog`, `Table`)
- Style with Tailwind utility classes, not CSS-in-JS or MUI's `sx`/`makeStyles`
- Do NOT import from `@material-ui/*`

### Styling: `cn()` and tailwind-merge — DO NOT extend globally

`cn()` (`src/components/ui/../utils` → `webapps/landlord/src/utils/index.js`) is
`twMerge(clsx(inputs))` using **stock** tailwind-merge. Stock tailwind-merge does
NOT know this project's custom font-size tokens (`text-label`, `text-title`,
`text-headline`, etc.), so when a custom size is combined with a text-colour via
`cn()`/`cva`, twMerge silently DROPS the size and the element renders at the 16px
browser default.

**The rule (learned the hard way — the "huge pills" saga, June 2026):** do NOT
"teach" `cn()` the custom tokens globally. Dozens of components had been silently
rendering a dropped custom size at 16px for months; extending the merge made every
one of them snap to its real (smaller) size at once and the whole UI looked tiny.
When a component must combine a custom font-size with a colour, use an
**arbitrary-value** size class (e.g. `text-[0.6875rem]`) — stock tailwind-merge
keeps that alongside the colour. See `badge.js` and the tenant-tile pills, and the
load-bearing comment at the top of `webapps/landlord/src/utils/index.js`.

## State Management

| Concern | Use | Do NOT use |
|---------|-----|------------|
| Server state (API data) | `@tanstack/react-query` (`useQuery`, `useMutation`) | Direct fetch without caching |
| Auth/session state | `StoreContext` (Organization, User with subscribe/notify + `useSyncExternalStore`) | — |
| Local/UI state | `useState`, `useReducer`, React Context | — |

## Forms

Use **react-hook-form + zod** for all new forms.

```js
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1, 'Required'),
});

function MyForm({ onSubmit }) {
  const { register, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(schema),
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Input {...register('name')} />
      {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      <Button type="submit">Save</Button>
    </form>
  );
}
```

Do NOT use Formik, `<Field>`, `<Form>`, or Yup. (The legacy `src/components/formfields/` directory was deleted along with the formik/yup/@material-ui deps.)

## API Calls

Use `apiFetcher()` from `src/utils/fetch.js` (axios instance with auth/refresh handling) wrapped in React Query:

```js
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetcher } from '../utils/fetch';

// Read
export function useBuildings() {
  return useQuery({
    queryKey: ['buildings'],
    queryFn: async () => {
      const { data } = await apiFetcher().get('/buildings');
      return data;
    },
  });
}

// Write
export function useCreateBuilding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (building) => {
      const { data } = await apiFetcher().post('/buildings', building);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['buildings'] }),
  });
}
```

## Paginated Lists (Load More pattern)

For paginated endpoints, use `useInfiniteQuery`:

```js
import { useInfiniteQuery } from '@tanstack/react-query';

export function useTenants() {
  return useInfiniteQuery({
    queryKey: ['tenants'],
    queryFn: async ({ pageParam = 1 }) => {
      const { data, headers } = await apiFetcher().get(`/tenants?page=${pageParam}&limit=25`);
      const totalPages = parseInt(headers['x-total-pages'] || '1');
      return { data, totalPages, page: pageParam };
    },
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    initialPageParam: 1,
  });
}
```

## File Structure for New Pages

```
src/
├── pages/[organization]/
│   └── buildings.js              # Page component (Next.js Pages Router)
├── components/buildings/
│   ├── BuildingList.js           # Feature components
│   └── BuildingForm.js
└── hooks/
    └── useBuildings.js           # React Query hooks for this feature
```

- Pages go under `src/pages/[organization]/` (all org-scoped routes use this dynamic segment)
- Feature components go in `src/components/<feature>/`
- React Query hooks go in `src/hooks/`

## New Page Skeleton

```js
// src/pages/[organization]/buildings.js
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import Page from '../../components/Page';
import { apiFetcher } from '../../utils/fetch';

function useBuildings() {
  return useQuery({
    queryKey: ['buildings'],
    queryFn: async () => {
      const { data } = await apiFetcher().get('/buildings');
      return data;
    },
  });
}

export default function Buildings() {
  const { data: buildings, isLoading } = useBuildings();

  if (isLoading) return <p>Loading...</p>;

  return (
    <Page>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Buildings</h1>
        <Button>Add Building</Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {buildings?.map((b) => (
          <Card key={b._id}>
            <CardHeader>
              <CardTitle>{b.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{b.address}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </Page>
  );
}
```

## SSR Gotchas (Pages Router)

The landlord app uses Next.js Pages Router and renders pages on the server. Anything that reads from `window`, browser APIs, or media queries on first render produces a server/client mismatch and a hydration error like `Did not expect server HTML to contain a <div> in <div>`.

Common offenders and fixes:

### `useMediaQuery` from `usehooks-ts`

Always pass `{ initializeWithValue: false }`. The hook then returns the default (`false`) on the first render in both server and client, and updates after mount via `useEffect`.

```js
// ❌ Hydration mismatch on screens that match the query
const isDesktop = useMediaQuery('(min-width: 768px)');

// ✅ SSR-safe
const isDesktop = useMediaQuery('(min-width: 768px)', {
  initializeWithValue: false
});
```

### Anything that reads `window`, `document`, `localStorage`, `navigator`

Either guard with `typeof window !== 'undefined'` or move the access into a `useEffect`. The store classes use `useSyncExternalStore` for this reason — initial server render returns the initial snapshot, the client picks up the real value after mount.

### Date/time formatting

`moment().format(...)` and similar can produce different output on server vs client if locales aren't pinned. Pass `locale` explicitly or do the formatting inside `useEffect`.

### Vaul Drawer + Radix Popover (date-picker click-through)

Symptom: a Radix `Popover` (e.g. `DatePickerInput`'s calendar) opened from inside a Vaul `Drawer` (e.g. the payment-recording dialog) appears to render correctly, but clicks on items inside the popover (calendar day cells, select options, etc.) register on whatever sat underneath in the drawer.

Root cause: Vaul sets `pointer-events: none` on `<body>` while the drawer is open. Radix portals popover content to `document.body`, so the popover subtree inherits `pointer-events: none` and clicks fall through to the drawer's dialog layer.

**Fix**: pass `modal` on the Popover root — NOT on `PopoverContent`, NOT `data-vaul-no-drag` (which only opts out of drag, not pointer capture). `<Popover modal>` makes Radix render its own focus/dismissable layer with its own pointer-event context.

```jsx
<Popover modal open={open} onOpenChange={setOpen}>
  <PopoverTrigger>...</PopoverTrigger>
  <PopoverContent>
    <Calendar mode="single" ... />
  </PopoverContent>
</Popover>
```

Refs: shadcn-ui/ui#7652, vaul#482. Applied in `webapps/landlord/src/components/ui/date-picker-input.js`.

### Branded scrollbar (`.scrollbar-branded`)

Long content inside a Drawer/Dialog body should opt into the branded scrollbar utility instead of the OS-native one (cream-on-grey on macOS, blue on Windows). Defined once in `webapps/landlord/src/styles/globals.css` — thin track, ink thumb at 25–50% alpha, cross-browser via both `scrollbar-*` (Firefox) and `::-webkit-scrollbar*` (Chromium/Safari).

```jsx
<div className="overflow-y-auto scrollbar-branded ...">
```

Applied across the payment dialogs and dashboard figure panels (`NewPaymentDialog`, `ResponsiveDialog`, `dashboard/MonthFigures.js`, `rents/ExpressPaymentDialog.js`). New scrollable surfaces inside dialogs should use it.

### Per-payment fields (note / discount / extra-charge)

`tenant.rents[i].payments[j]` carries optional `description / promo / notepromo / extracharge / noteextracharge`. The dialog's draft rows have inline collapsibles for these — they belong to the SPECIFIC payment, not to the rent month. Saved tiles render the attached values inline (italic note, olive discount, oxide extra-charge).

When you add a new payment-attached field, mirror the round-3j approach:

1. Add to the per-payment shape in `services/api/src/managers/rentmanager.ts:settlements.payments.map(...)` so it persists.
2. Add validation under the `paymentData.payments.forEach(...)` loop with a finite-number cap (10M) or string-length cap (1000) that matches the rent-level guards.
3. If the field aggregates into rent totals, push one entry into `settlements.discounts[]` / `settlements.debts[]` per non-empty payment, then let `frontdata.toRentData` aggregate them on serialise.
4. Render in `PaymentTabs.js` saved-tile JSX (read-only) and inside each draft row's Collapse (editable).

Backward-compat: rent-level `paymentData.promo / extracharge / description` paths are still honored when no per-payment fields are present, so legacy callers don't break.

### `rent.status` is the single source of truth

Anywhere the UI needs to classify a rent as paid / partiallypaid / notpaid, read `rent.status` (set by `services/api/src/managers/frontdata.ts:toRentData()`). Do NOT re-classify from raw fields like `totalAmount <= 0 || newBalance >= 0` — that heuristic misses retroactive carry-forward settlement and direct-pay coverage logic, and a parallel classifier WILL drift from the row UI.

The `_listRents` overview classifier was on a different code path until round-3p; both surfaces now share `rent.status`.

### Date-picker `paymentContext` mode

`DatePickerInput` accepts a `paymentContext` prop. When true, the popover shows a footer help-strip explaining the payment-date vs rent-term distinction. Used inside `PaymentTabs.js` (both new-draft entry and saved-tile inline edit). NOT used elsewhere in the app — the help text is payment-specific.

For the dashboard's "Πληρωμή ενοικίου" shortcut, pair `paymentContext={false}` with `disabled` to lock the date to today (NewPaymentDialog → PaymentTabs `lockDateToToday` prop).

### Submit button stuck on "Saving" after silent zod failure

When you call `formRef.current.requestSubmit()` from an outer drawer/dialog and the form's `zodResolver` rejects, `_handleSubmit` is never called — so any "saving" state owned by the OUTER dialog never resets. Two fixes used by `NewPaymentDialog`:

1. After triggering submit, schedule a short timeout that resets `saving` if `formRef.current.isSubmitting()` reports false.
2. Wire a second-arg error callback to `handleSubmit(_handleSubmit, onValidationError)` so failures surface as a toast and call the parent's `onError?.()`.

## Quick Reference: Legacy → Current

| Legacy (avoid) | Current (use) |
|----------------|---------------|
| `import { Box, Typography } from '@material-ui/core'` | `<div className="...">`, `<p>`, shadcn components |
| `import { useStores } from '../store'` | `useQuery()` / `useMutation()` |
| `import { Formik, Form, Field }` | `useForm()` + `zodResolver()` |
| `makeStyles()` / `withStyles()` | Tailwind utility classes |
| `observer()` / `makeObservable()` | Regular React components |
| `store.X.fetch()` / `store.X.items` | `useQuery({ queryKey, queryFn })` |
