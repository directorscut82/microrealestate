# TypeScript Migration Guide

## Current State — ✅ ALL SERVICES MIGRATED

All backend services are now TypeScript. Migration completed in Phase 3.
58 files converted across 4 services, 0 compilation errors, 200+ integration tests verified 0 regressions.

| Service | Language | Files | Notes |
|---------|----------|-------|-------|
| common | TypeScript | ✅ | Shared library, publishes types |
| gateway | TypeScript | ✅ | Reverse proxy |
| tenantapi | TypeScript | ✅ | Tenant read-only API |
| resetservice | TypeScript | ✅ | Dev/CI DB reset |
| authenticator | TypeScript | ✅ | Migrated: 4 files |
| pdfgenerator | TypeScript | ✅ | Migrated: 11 files |
| emailer | TypeScript | ✅ | Migrated: 23 files |
| api | TypeScript | ✅ | Migrated: 20 files |

## Future: Landlord App → TypeScript

The landlord frontend (`webapps/landlord`) is still JavaScript (JSX). It can be migrated to TypeScript after the MobX removal is complete (which it now is).

**⚠️ Known issue:** Bulk renaming `.js` → `.tsx` causes Next.js SWC compiler to generate different CSS output, specifically affecting `next/image` with `fill` prop (creates `position: absolute` elements that overlap form inputs). The migration must be done incrementally — file by file — with E2E testing after each batch. The `Illustrations.tsx` component specifically needs the `next/image` `fill` prop replaced with a plain `<img>` tag.

Steps:
1. Add `tsconfig.json` to `webapps/landlord` (already exists with `allowJs: true`)
2. Rename `.js` → `.tsx` files incrementally, one directory at a time
3. Run E2E tests after each batch to catch CSS rendering regressions
4. Add types for props, state, and API responses
5. Use types from `@microrealestate/types`

## Tips

- Migrate one directory at a time, not the whole service at once.
- Use `// @ts-expect-error` or `as any` sparingly for untyped third-party modules.
- The `moment` library has built-in types. `lodash` needs `@types/lodash` (already in common).
- Run `tsc --noEmit` to check types without building.
