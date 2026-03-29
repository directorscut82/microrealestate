# TypeScript Migration Guide

## Current State

| Service | Language | Files | tsconfig.json | Notes |
|---------|----------|-------|---------------|-------|
| common | TypeScript | ✅ | ✅ | Already migrated, publishes types |
| gateway | TypeScript | ✅ | ✅ | Already migrated |
| tenantapi | TypeScript | ✅ | ✅ | Already migrated |
| resetservice | TypeScript | ✅ | ✅ | Already migrated |
| authenticator | JavaScript | 4 | ❌ | Smallest JS service |
| pdfgenerator | JavaScript | 11 | ❌ | Medium complexity |
| emailer | JavaScript | 23 | ❌ | Medium-high complexity |
| api | JavaScript | 35 | ❌ | Largest, most critical |

## Recommended Migration Order

1. **authenticator** — Only 4 files. Quick win, builds confidence.
2. **pdfgenerator** — 11 files, self-contained PDF logic.
3. **emailer** — 23 files, similar patterns to pdfgenerator.
4. **api** — 35 files, most complex. Migrate last when patterns are established.

## Infrastructure Already in Place

All JS services already have:
- `typescript` as a devDependency
- `@typescript-eslint/*` parser and plugin
- Build scripts that transpile `@microrealestate/common` (TS → JS)
- ESM (`"type": "module"`) in package.json

What's missing per JS service:
- A `tsconfig.json` (copy from gateway/tenantapi and adjust)
- Build script to compile the service's own TS files
- Updated `main` entry point to `dist/index.js`

## Migration Steps Per Service

1. **Add tsconfig.json** — Copy from an existing TS service:
   ```json
   {
     "compilerOptions": {
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "outDir": "dist",
       "skipLibCheck": true,
       "strict": true,
       "target": "ESNext",
       "declaration": true
     },
     "include": ["src/**/*"]
   }
   ```

2. **Rename files** — `*.js` → `*.ts`, one directory at a time.

3. **Fix imports** — Change `.js` extensions to `.js` in imports (NodeNext resolution requires `.js` even for `.ts` files).

4. **Add types** — Start with `any` where needed, tighten incrementally. Use types from `@microrealestate/types`.

5. **Update package.json** — Change `main` to `dist/index.js`, add a `transpile:service` script:
   ```json
   "transpile:service": "tsc --build",
   "watch:service": "nodemon -w dist --inspect=0.0.0.0:9226 ./dist/index.js"
   ```

6. **Update dev scripts** — Add the service transpile step to the `dev` and `build` scripts.

7. **Test** — Run existing tests, verify the service starts correctly.

## Tips

- Migrate one directory at a time, not the whole service at once.
- Use `// @ts-expect-error` or `as any` sparingly for untyped third-party modules.
- The `moment` library has built-in types. `lodash` needs `@types/lodash` (already in common).
- Run `tsc --noEmit` to check types without building.
