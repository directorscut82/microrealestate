# Task 05 — Frontend Code Review

> **Status:** NOT STARTED
> **Severity:** High
> **Category:** Security / Quality
> **Files to review:** `webapps/landlord/src/utils/fetch.js`, `webapps/landlord/src/utils/restcalls.js`, `webapps/landlord/src/store/`, `webapps/landlord/src/hooks/`, key form components

---

## Problem

Zero frontend files have been reviewed in any code review round. The landlord app has 189 source files covering auth token handling, API calls, state management, forms, and user-facing logic. Any of these could contain security vulnerabilities (XSS, token leaks), data handling bugs, or reliability issues.

## Impact

- Token handling bugs → account hijacking
- XSS in rich text editor → stored XSS attacks
- Stale cache after mutations → user sees wrong data
- Missing error boundaries → white screen crashes
- Race conditions in auth refresh → intermittent 401 errors

---

## Steps

### 1. Review auth/token layer (`src/utils/fetch.js`)

- [ ] Read `webapps/landlord/src/utils/fetch.js` fully
- [ ] Check: access token stored in memory only (NOT localStorage/sessionStorage)
- [ ] Check: refresh token handling — does it queue concurrent requests during refresh?
- [ ] Check: expired token detection — does interceptor retry after refresh?
- [ ] Check: does failed refresh redirect to login?
- [ ] Check: are tokens leaked in URL query params or logs?
- [ ] Check: CORS headers — is withCredentials set appropriately?
- [ ] Check: error responses — are 401/403 handled distinctly?
- [ ] Document any issues found
- [ ] Fix any issues found

### 2. Review API call layer (`src/utils/restcalls.js`)

- [ ] Read `webapps/landlord/src/utils/restcalls.js` fully
- [ ] Check: all endpoints use correct HTTP methods (GET for reads, POST/PATCH for writes)
- [ ] Check: request bodies are properly constructed (no extra fields leaked)
- [ ] Check: error handling — are API errors properly surfaced or silently swallowed?
- [ ] Check: organizationId header included on all realm-scoped calls
- [ ] Check: no hardcoded URLs or ports
- [ ] Check: sensitive data not logged via console.log
- [ ] Document any issues found
- [ ] Fix any issues found

### 3. Review store/session management (`src/store/`)

- [ ] Read all files in `webapps/landlord/src/store/`
- [ ] Check: store singleton pattern — is there a memory leak risk?
- [ ] Check: `subscribe`/`notify` — are listeners cleaned up on unmount?
- [ ] Check: organization switching — is stale data from previous org cleared?
- [ ] Check: user state after logout — is all sensitive data wiped?
- [ ] Check: `useSyncExternalStore` — does snapshot function return stable reference?
- [ ] Document any issues found
- [ ] Fix any issues found

### 4. Review React Query hooks (`src/hooks/`)

- [ ] Read all files in `webapps/landlord/src/hooks/`
- [ ] Check: mutation `onSuccess` — does it invalidate related queries?
- [ ] Check: staleTime/cacheTime — are they reasonable (not infinite)?
- [ ] Check: error handling — do hooks surface errors to UI?
- [ ] Check: optimistic updates — if used, are they properly rolled back on failure?
- [ ] Check: query keys — are they properly scoped (include org ID, resource ID)?
- [ ] Document any issues found
- [ ] Fix any issues found

### 5. Review form handling (sample forms)

- [ ] Pick 3 representative forms (tenant create, property create, payment record)
- [ ] Check: zod schema validates all required fields
- [ ] Check: form submission handles loading state (prevents double-submit)
- [ ] Check: server-side validation errors displayed to user
- [ ] Check: file upload forms (PDF import) validate file type/size client-side
- [ ] Check: number fields properly parsed (no NaN passed to API)
- [ ] Document any issues found
- [ ] Fix any issues found

### 6. Review for XSS vulnerabilities

- [ ] Search for `dangerouslySetInnerHTML` usage
- [ ] Check rich text editor (`src/components/RichTextEditor/`) — is output sanitized?
- [ ] Check if any user input is rendered without escaping
- [ ] Check if template content (HTML) is sandboxed when displayed
- [ ] Document any issues found
- [ ] Fix any issues found (use DOMPurify or similar)

### 7. Review error boundaries

- [ ] Check: does `_app.js` or layout have a top-level error boundary?
- [ ] Check: do individual pages/features have error boundaries?
- [ ] Check: what happens when a component throws during render?
- [ ] Check: are async errors (in useEffect, event handlers) caught?
- [ ] If missing: add error boundary at minimum to `_app.js`
- [ ] Document any issues found
- [ ] Fix any issues found

### 8. Review loading/empty states

- [ ] Check: do list pages show loading skeleton/spinner?
- [ ] Check: do list pages show empty state when no data?
- [ ] Check: do detail pages handle 404 (deleted resource)?
- [ ] Check: is there a global loading indicator for navigation?
- [ ] Document any issues found (these are UX issues, lower priority)

### 9. Review accessibility basics

- [ ] Check: do forms have proper labels associated with inputs?
- [ ] Check: do buttons have accessible names?
- [ ] Check: do modals trap focus and have aria-labels?
- [ ] Check: is color used alone to convey information (no colorblind support)?
- [ ] Document findings (informational, not blocking)

### 10. Write tests for critical fixes

- [ ] For each security issue fixed: write a test proving the fix
- [ ] For auth refresh race: write test showing queued requests succeed
- [ ] For XSS fix: write test showing HTML is sanitized
- [ ] For error boundary: write test showing graceful error display

---

## Verification Checklist

- [ ] No tokens stored in localStorage/sessionStorage
- [ ] No console.log of sensitive data
- [ ] No unescaped user input rendered as HTML
- [ ] Auth refresh handles concurrent requests
- [ ] Failed refresh redirects to login
- [ ] Mutations invalidate related queries
- [ ] At least one error boundary exists
- [ ] All fixes compile without errors
- [ ] E2E tests pass after fixes
- [ ] No new security vulnerabilities introduced

---

## Notes

- This is a REVIEW task — not every finding needs an immediate fix
- Security issues (XSS, token handling) MUST be fixed
- UX issues (loading states, empty states) can be documented for later
- The rich text editor is a high-risk area for XSS — prioritize that review
- `withAuthentication` HOC uses singleton store — verify it doesn't leak across sessions
- Tenant portal (`webapps/tenant/`) also needs review but is lower priority (less attack surface, server components)
