# Task 04 — Type Safety (Eliminate `any`)

> **Status:** NOT STARTED
> **Severity:** Medium
> **Category:** Maintainability
> **Files to modify:** `services/api/src/managers/*.ts`, `services/common/src/utils/middlewares.ts`

---

## Problem

Manager files use `any` extensively for request objects, query results, function parameters, and return types. This defeats the TypeScript migration's purpose — bugs that the compiler could catch (like the ObjectId/string mismatch and double-payment race) slip through silently.

## Impact

- Compiler cannot catch type mismatches (proven by 2 bugs already found)
- IDE autocomplete/refactoring broken for `any`-typed variables
- Future developers can introduce type errors without warning
- Code review effectiveness reduced (can't rely on compiler for correctness)

---

## Steps

### 1. Inventory `any` usage

- [ ] Run: `grep -rn ': any' services/api/src/managers/ | wc -l` — count occurrences
- [ ] Run: `grep -rn ': any' services/common/src/ | wc -l`
- [ ] Categorize by pattern:
  - `req: any` — Express request objects
  - `result: any` — Mongoose query results
  - `param: any` — Function parameters
  - `as any` — Type assertions
- [ ] Prioritize files with most `any` usage

### 2. Define request/response types

- [ ] Create `services/api/src/types/requests.ts`:
  ```ts
  import { Request } from 'express';
  import { CollectionTypes } from '@microrealestate/types';

  interface AuthenticatedRequest extends Request {
    realm: CollectionTypes.Realm;
    user: { email: string; role: string };
  }

  interface TenantCreateRequest extends AuthenticatedRequest {
    body: Pick<CollectionTypes.Tenant, 'name' | 'leaseId' | 'properties' | ...>;
  }

  interface TenantUpdateRequest extends AuthenticatedRequest {
    params: { id: string };
    body: Partial<CollectionTypes.Tenant>;
  }
  ```
- [ ] Export these types for use in managers

### 3. Type the occupantmanager

- [ ] Replace `req: any` with specific request types
- [ ] Replace Mongoose query results with proper model types:
  ```ts
  const tenant = await Occupant.findOne({ ... }).lean<CollectionTypes.Tenant>();
  ```
- [ ] Type function return values
- [ ] Remove `as any` assertions where proper typing makes them unnecessary
- [ ] Verify compilation

### 4. Type the propertymanager

- [ ] Same pattern as step 3
- [ ] Pay attention to `.populate()` results — may need intersection types
- [ ] Verify compilation

### 5. Type the leasemanager

- [ ] Same pattern as step 3
- [ ] Verify compilation

### 6. Type the rentmanager

- [ ] Same pattern as step 3
- [ ] Special attention to rent computation pipeline return types
- [ ] The `rents[]` embedded array has complex nested structure — type fully
- [ ] Verify compilation

### 7. Type the realmmanager

- [ ] Same pattern as step 3
- [ ] `members[]` array operations need proper typing
- [ ] Verify compilation

### 8. Type the dashboardmanager

- [ ] Same pattern as step 3
- [ ] Aggregation pipeline results need explicit output types
- [ ] Verify compilation

### 9. Type middlewares

- [ ] In `services/common/src/utils/middlewares.ts`:
  - Type `req.realm` augmentation on Express Request
  - Type `req.user` augmentation
  - Use module augmentation:
    ```ts
    declare global {
      namespace Express {
        interface Request {
          realm?: CollectionTypes.Realm;
          user?: { email: string; role: string; };
        }
      }
    }
    ```
- [ ] Verify all services compile with augmented types

### 10. Reduce `as any` assertions

- [ ] Search for `as any` in all TS files
- [ ] For each occurrence, determine if proper typing eliminates the need
- [ ] Acceptable remaining `as any`: third-party library gaps, test mocks
- [ ] Document any intentional `as any` with `// eslint-disable-next-line` comment explaining why

### 11. Enable stricter tsconfig (optional, scope carefully)

- [ ] Consider adding to `tsconfig.json`:
  ```json
  "noImplicitAny": true  // only if manageable
  ```
- [ ] If too many errors, skip this — the manual fixes above are sufficient
- [ ] Alternative: add `// @ts-strict` per-file as files are cleaned up

### 12. Verify no regressions

- [ ] TypeScript compiles with 0 errors (all services)
- [ ] All unit tests pass
- [ ] E2E tests pass
- [ ] No runtime behavior changes (types are compile-time only)

---

## Verification Checklist

- [ ] `grep -c ': any' services/api/src/managers/*.ts` reduced by >50%
- [ ] `grep -c 'as any' services/api/src/managers/*.ts` reduced by >50%
- [ ] TypeScript compiles with 0 errors
- [ ] All existing tests pass (types don't affect runtime)
- [ ] IDE shows proper autocomplete on typed functions
- [ ] No new `@ts-ignore` comments added

---

## Notes

- Start with the files where bugs were found (rentmanager, occupantmanager) — proven value
- Don't aim for 100% elimination — some `any` is acceptable for dynamic third-party interactions
- Mongoose `.lean()` returns `any` by default — use `.lean<Type>()` generic
- Express middleware augmentation affects all services sharing `@microrealestate/common`
- If `CollectionTypes` in `types/` package is incomplete, extend it as needed
- Consider `unknown` instead of `any` for truly dynamic inputs — forces explicit narrowing
