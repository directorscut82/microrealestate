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

Do NOT use Formik, `<Field>`, `<Form>`, Yup, or components from `src/components/formfields/`.

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

## Quick Reference: Legacy → Current

| Legacy (avoid) | Current (use) |
|----------------|---------------|
| `import { Box, Typography } from '@material-ui/core'` | `<div className="...">`, `<p>`, shadcn components |
| `import { useStores } from '../store'` | `useQuery()` / `useMutation()` |
| `import { Formik, Form, Field }` | `useForm()` + `zodResolver()` |
| `makeStyles()` / `withStyles()` | Tailwind utility classes |
| `observer()` / `makeObservable()` | Regular React components |
| `store.X.fetch()` / `store.X.items` | `useQuery({ queryKey, queryFn })` |
