# Proposed E2E Tests — Real Landlord Scenarios

## Suite 30: Monthly Rent Lifecycle (12 tests)
1. Navigate to rents page for current month
2. All tenants show "Not paid" status
3. Record full payment for tenant A — status changes to "Paid"
4. Record partial payment for tenant B (50 of 110) — status shows "Partially paid"
5. Navigate to next month's rents
6. Tenant B shows previous balance carried forward
7. Record remaining payment for tenant B — balance clears
8. Navigate back to previous month — statuses unchanged
9. Filter rents by "Paid" — only fully paid tenants show
10. Filter rents by "Not paid" — only unpaid tenants show
11. Filter rents by "Partially paid" — only partial tenants show
12. Clear filters — all tenants show

## Suite 31: Multi-Month Payment Tracking (10 tests)
1. Record payment for January
2. Navigate to February rents
3. Verify previous balance from January appears
4. Record payment for February
5. Navigate to March
6. Verify clean balance (no carryover)
7. Navigate back to January — payment still recorded
8. Navigate to accounting page for current year
9. Settlements tab shows recorded payments
10. Incoming tenants tab shows tenant data

## Suite 32: Tenant Lifecycle — Onboard to Terminate (10 tests)
1. Create tenant with lease, property, expenses
2. Verify tenant appears in tenants list
3. Verify property shows "occupied by tenant"
4. Record 3 months of payments
5. Terminate lease with termination date
6. Verify tenant shows "Terminated" status
7. Verify property shows "vacant" after termination
8. Verify tenant cannot be deleted (has payments)
9. Verify terminated tenant still visible in tenants list
10. Verify rents page no longer shows terminated tenant for future months

## Suite 33: Property Management (10 tests)
1. Create property with full details (type, address, rent, surface)
2. Edit property rent amount
3. Verify rent change persists after navigation
4. Edit property address
5. Verify address change persists
6. View property detail — shows map with address
7. Property with tenant shows occupant name
8. Property without tenant shows "vacant"
9. Search properties by name — correct results
10. Search properties by partial name — correct results

## Suite 34: Contract/Lease Templates (12 tests)
1. Create contract with name, schedule type, number of terms
2. Add text template to contract
3. Verify text template appears in templates list
4. Edit text template content via rich text editor
5. Verify edit persists after closing editor
6. Add file descriptor template (required, with expiry)
7. Verify file descriptor appears in templates list
8. Add second text template
9. Verify both templates listed
10. Delete one text template
11. Verify only remaining template shows
12. Contract used by tenant — verify "in use" warning shown

## Suite 35: Landlord Settings (10 tests)
1. Navigate to landlord settings
2. Verify org name displayed
3. Change org name — verify persists
4. Restore original org name
5. Verify company info fields (name, legal structure, EIN, capital)
6. Edit company legal representative
7. Verify edit persists after navigation
8. Change locale to English
9. Verify UI switches to English
10. Change locale back to French

## Suite 36: Billing & Third-Party Settings (8 tests)
1. Navigate to billing settings
2. Fill all required fields (contact, email, phone, address)
3. Fill bank details (name, IBAN)
4. Save billing form
5. Verify all fields persist after navigation
6. Navigate to third-parties settings
7. Verify email delivery service section exists
8. Verify cloud storage section exists

## Suite 37: Access Control — Members (10 tests)
1. Navigate to access settings
2. Current user shows as administrator
3. Add new collaborator (renter role)
4. Verify collaborator appears in members list
5. Verify collaborator shows "renter" role
6. Edit collaborator role (not possible for self)
7. Remove collaborator
8. Verify collaborator removed from list
9. Add application credential
10. Verify credential shows in applications list

## Suite 38: Dashboard Accuracy (10 tests)
1. Create contract, property, tenant
2. Dashboard shows correct tenant count (1)
3. Dashboard shows correct property count (1)
4. Dashboard shows occupancy rate
5. Record a payment
6. Dashboard shows revenue data updated
7. Dashboard shows "top unpaid" section
8. Create second tenant
9. Dashboard counts update (2 tenants)
10. Terminate one tenant — dashboard updates

## Suite 39: Multi-Organization (8 tests)
1. Create first organization during first access
2. Navigate to organizations settings
3. Current org visible in list
4. Verify org details (name, locale, currency)
5. Sign out and sign back in
6. Dashboard loads with correct org
7. All data intact after sign out/in
8. Org menu shows user name and avatar

## Suite 40: Rent Computation Verification (12 tests)
1. Create tenant with rent 100, expenses 10 (charges)
2. Navigate to rents — verify total shows 110 (rent + expenses)
3. Create tenant with VAT 20%
4. Verify rent shows pre-tax, VAT, and total amounts
5. Create tenant with discount
6. Verify discount applied to rent total
7. Create tenant with multiple expenses
8. Verify all expenses summed in total
9. Record partial payment — verify balance shows remainder
10. Record overpayment — verify credit balance
11. Next month shows credit carried forward
12. Verify accounting page totals match rent page

## Suite 41: Search & Filter (8 tests)
1. Create 3 tenants with different names
2. Search tenants by full name — exact match
3. Search tenants by partial name — partial match
4. Clear search — all tenants show
5. Create 3 properties with different names
6. Search properties by name
7. Search properties by partial name
8. Clear search — all properties show

## Suite 42: Navigation & State Persistence (10 tests)
1. Navigate tenant → property → rents → dashboard rapidly
2. No errors or blank pages during rapid navigation
3. Edit property, navigate away, come back — edit persisted
4. Edit tenant info, navigate away, come back — edit persisted
5. Page reload on tenant detail — data intact
6. Page reload on property detail — data intact
7. Page reload on rents page — data intact
8. Page reload on settings page — data intact
9. Browser back button works correctly
10. Deep link to tenant detail page works

## Total: 130 tests across 13 suites
