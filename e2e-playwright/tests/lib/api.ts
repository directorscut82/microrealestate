import { APIRequestContext, expect } from '@playwright/test';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';

/**
 * Sign in via the authenticator API and return an access token. We do not use
 * a UI session here — the seed data setup runs before the browser flow under
 * test, so it must be independently callable.
 */
export async function getAccessToken(request: APIRequestContext): Promise<string> {
  const email = process.env.TEST_EMAIL!;
  const password = process.env.TEST_PASSWORD!;
  const r = await request.post(`${GATEWAY}/api/v2/authenticator/landlord/signin`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' }
  });
  expect(r.status(), 'signin status').toBe(200);
  const body = await r.json();
  expect(body.accessToken, 'accessToken').toBeTruthy();
  return body.accessToken as string;
}

export interface SeedHandles {
  token: string;
  realmId: string;
  realmName: string;
  buildingId: string;
  expenseId: string;
}

/**
 * Idempotent seed: ensures the test account has at least one realm, one
 * building inside it, and one recurring expense on that building. Returns the
 * IDs so the spec can navigate the UI directly to the expense edit dialog.
 *
 * Subsequent runs reuse existing fixtures. Names are namespaced with E2E- so a
 * human looking at the NAS UI can tell what is test data.
 */
export async function ensureSeed(request: APIRequestContext): Promise<SeedHandles> {
  const token = await getAccessToken(request);
  const orgName = process.env.TEST_ORG_NAME || 'CYPRESS-TEST-DO-NOT-USE';

  const auth = (organizationId?: string) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(organizationId ? { organizationid: organizationId } : {})
  });

  // 1. Realm — list and find by name; create if missing.
  let realms = await request.get(`${GATEWAY}/api/v2/realms`, { headers: auth() });
  expect(realms.status(), 'list realms').toBe(200);
  let realmList = (await realms.json()) as Array<{ _id: string; name: string }>;
  let realm = realmList.find((r) => r.name === orgName);
  if (!realm) {
    const created = await request.post(`${GATEWAY}/api/v2/realms`, {
      headers: auth(),
      data: {
        name: orgName,
        locale: process.env.TEST_LOCALE || 'el',
        currency: process.env.TEST_CURRENCY || 'EUR',
        isCompany: false,
        addresses: [{}],
        bankInfo: {},
        contacts: []
      }
    });
    // realmManager.add uses res.json() which defaults to 200.
    expect([200, 201], 'create realm').toContain(created.status());
    realm = (await created.json()) as { _id: string; name: string };
  }
  const realmId = realm._id;

  // 2. Building — find one starting with E2E-, create if none.
  const buildingsResp = await request.get(`${GATEWAY}/api/v2/buildings`, {
    headers: auth(realmId)
  });
  expect(buildingsResp.status(), 'list buildings').toBe(200);
  const buildings = (await buildingsResp.json()) as Array<{ _id: string; name: string }>;
  let building = buildings.find((b) => b.name?.startsWith('E2E-'));
  if (!building) {
    const created = await request.post(`${GATEWAY}/api/v2/buildings`, {
      headers: auth(realmId),
      data: {
        name: 'E2E-Building',
        atakPrefix: 'E2E',
        address: { street1: 'Test', city: 'Test', zipCode: '00000' }
      }
    });
    expect(
      [200, 201],
      `create building (status=${created.status()}, body: ${await created.text().catch(() => '')})`
    ).toContain(created.status());
    building = (await created.json()) as { _id: string; name: string };
  }
  const buildingId = building._id;

  // 3. Expense — fetch the building (expenses live nested), find one with a
  // known E2E name + recurring, create if missing. Recurring is the trigger
  // for the wave-21 server guard that demands startTerm.
  const buildingResp = await request.get(`${GATEWAY}/api/v2/buildings/${buildingId}`, {
    headers: auth(realmId)
  });
  expect(buildingResp.status(), 'fetch building').toBe(200);
  const fullBuilding = (await buildingResp.json()) as {
    _id: string;
    expenses?: Array<{ _id: string; name: string; isRecurring?: boolean }>;
  };

  let expense = fullBuilding.expenses?.find(
    (e) => e.name === 'E2E-Expense' && e.isRecurring
  );
  if (!expense) {
    const created = await request.post(
      `${GATEWAY}/api/v2/buildings/${buildingId}/expenses`,
      {
        headers: auth(realmId),
        data: {
          name: 'E2E-Expense',
          type: 'other',
          amount: 100,
          allocationMethod: 'general_thousandths',
          isRecurring: true,
          startTerm: Number(
            new Date().getFullYear().toString() +
              String(new Date().getMonth() + 1).padStart(2, '0') +
              '0100'
          )
        }
      }
    );
    expect(
      [200, 201],
      `create expense (status=${created.status()}, body: ${await created.text().catch(() => '')})`
    ).toContain(created.status());
    const updatedBuilding = (await created.json()) as {
      expenses: Array<{ _id: string; name: string }>;
    };
    expense = updatedBuilding.expenses.find((e) => e.name === 'E2E-Expense');
    if (!expense) throw new Error('Created expense not present in response');
  }

  return { token, realmId, realmName: realm.name, buildingId, expenseId: expense._id };
}

export interface UnitSeed extends SeedHandles {
  unitId: string;
}

/**
 * Extends ensureSeed with a unit on the seeded building. Used by specs that
 * exercise unit-level UI (occupancy type, propertyId linking, etc).
 */
export async function ensureSeedWithUnit(
  request: APIRequestContext
): Promise<UnitSeed> {
  const seed = await ensureSeed(request);
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };
  const buildingResp = await request.get(`${GATEWAY}/api/v2/buildings/${seed.buildingId}`, {
    headers: auth
  });
  expect(buildingResp.status(), 'fetch building for unit seed').toBe(200);
  const fullBuilding = (await buildingResp.json()) as {
    _id: string;
    units?: Array<{ _id: string; atakNumber: string }>;
  };
  let unit = fullBuilding.units?.find((u) => u.atakNumber === 'E2E-Unit');
  if (!unit) {
    const created = await request.post(
      `${GATEWAY}/api/v2/buildings/${seed.buildingId}/units`,
      {
        headers: auth,
        data: {
          atakNumber: 'E2E-Unit',
          isManaged: true,
          occupancyType: 'vacant'
        }
      }
    );
    expect(
      [200, 201],
      `create unit (status=${created.status()}, body: ${await created.text().catch(() => '')})`
    ).toContain(created.status());
    const updated = (await created.json()) as {
      units: Array<{ _id: string; atakNumber: string }>;
    };
    unit = updated.units.find((u) => u.atakNumber === 'E2E-Unit');
    if (!unit) throw new Error('Created unit not present in response');
  }
  return { ...seed, unitId: unit._id };
}

export interface LeaseSeed extends SeedHandles {
  leaseId: string;
}

/**
 * Ensures a lease ("contract" in UI) exists under the test realm. Used by
 * spec 09 which verifies that PATCH /leases/:id treats the URL :id as
 * authoritative even when the body claims a different _id.
 */
export async function ensureSeedLease(
  request: APIRequestContext
): Promise<LeaseSeed> {
  const seed = await ensureSeed(request);
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };
  const leasesResp = await request.get(`${GATEWAY}/api/v2/leases`, { headers: auth });
  expect(leasesResp.status(), 'list leases').toBe(200);
  const leases = (await leasesResp.json()) as Array<{ _id: string; name: string }>;
  let lease = leases.find((l) => l.name === 'E2E-Lease');
  if (!lease) {
    const created = await request.post(`${GATEWAY}/api/v2/leases`, {
      headers: auth,
      data: {
        name: 'E2E-Lease',
        description: 'E2E lease',
        timeRange: 'years',
        numberOfTerms: 1
      }
    });
    expect(
      [200, 201],
      `create lease (status=${created.status()}, body: ${await created.text().catch(() => '')})`
    ).toContain(created.status());
    lease = (await created.json()) as { _id: string; name: string };
  }
  return { ...seed, leaseId: lease._id };
}

export interface PropertySeed extends SeedHandles {
  propertyId: string;
}

/**
 * Ensures a property exists under the test realm. Property edits are
 * exercised by spec 06 (energy certificate fields).
 */
export async function ensureSeedProperty(
  request: APIRequestContext
): Promise<PropertySeed> {
  const seed = await ensureSeed(request);
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };
  const propsResp = await request.get(`${GATEWAY}/api/v2/properties`, { headers: auth });
  expect(propsResp.status(), 'list properties').toBe(200);
  const props = (await propsResp.json()) as Array<{ _id: string; name: string }>;
  let prop = props.find((p) => p.name === 'E2E-Property');
  if (!prop) {
    const created = await request.post(`${GATEWAY}/api/v2/properties`, {
      headers: auth,
      data: {
        name: 'E2E-Property',
        type: 'apartment',
        rent: 0,
        surface: 50,
        address: { street1: 'Test', city: 'Test', zipCode: '00000' }
      }
    });
    expect(
      [200, 201],
      `create property (status=${created.status()}, body: ${await created.text().catch(() => '')})`
    ).toContain(created.status());
    prop = (await created.json()) as { _id: string; name: string };
  }
  return { ...seed, propertyId: prop._id };
}

export interface TenantSeed extends SeedHandles {
  tenantId: string;
  tenantName: string;
  tenantPhone1: string;
}

export interface LeasedTenantSeed extends SeedHandles {
  tenantId: string;
  tenantName: string;
  propertyId: string;
  leaseId: string;
  /** YYYY-MM-DD, six months in the past. */
  beginDate: string;
  /** YYYY-MM-DD, six months in the future. */
  endDate: string;
}

/**
 * Heaviest seed: a tenant with a property assignment and a lease whose date
 * range straddles the current month — six months in the past, six months in
 * the future. The rent computation pipeline produces a rents[] array
 * covering past, current, and future terms, which is exactly what
 * specs 04, 05 and the repair past-term spec exercise.
 *
 * Idempotent. The fixture tenant is named E2E-LeasedTenant so it survives
 * across runs and rapid re-seeds don't churn the realm.
 */
export async function ensureSeedLeasedTenant(
  request: APIRequestContext
): Promise<LeasedTenantSeed> {
  const seedLease = await ensureSeedLease(request);
  const seedProperty = await ensureSeedProperty(request);

  const auth = {
    Authorization: `Bearer ${seedLease.token}`,
    'Content-Type': 'application/json',
    organizationid: seedLease.realmId
  };

  // Fixed deterministic date window so re-runs don't shift the rent ledger.
  // begin = first of the month six months ago; end = last day of the month
  // six months from now. Use Date.UTC so positive-offset timezones don't
  // slip a day backwards. The API's _stringToDate parser is strict on
  // 'DD/MM/YYYY' (see occupantmanager.ts:34), so we format that way for the
  // request even though we surface ISO YYYY-MM-DD on the LeasedTenantSeed
  // for callers that need to compare to JS Date arithmetic.
  const today = new Date();
  const beginUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, 1));
  const endUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 7, 0));
  const beginDate = beginUtc.toISOString().substring(0, 10); // YYYY-MM-DD
  const endDate = endUtc.toISOString().substring(0, 10);
  const toDDMMYYYY = (iso: string) => {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  };
  const beginDateApi = toDDMMYYYY(beginDate);
  const endDateApi = toDDMMYYYY(endDate);

  // Find or create the leased tenant.
  const tenantsResp = await request.get(`${GATEWAY}/api/v2/tenants`, { headers: auth });
  expect(tenantsResp.status(), 'list tenants').toBe(200);
  const tenants = (await tenantsResp.json()) as Array<{ _id: string; name: string }>;
  let tenant = tenants.find((t) => t.name === 'E2E-LeasedTenant');

  if (!tenant) {
    const created = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: auth,
      data: {
        name: 'E2E-LeasedTenant',
        isCompany: false,
        manager: 'E2E-LeasedTenant',
        contacts: [{ contact: 'E2E-LeasedTenant', email: '', phone1: '6900000000', phone: '', phone2: '' }],
        leaseId: seedLease.leaseId,
        beginDate: beginDateApi,
        endDate: endDateApi,
        properties: [{ propertyId: seedProperty.propertyId, rent: 500, expenses: [] }]
      }
    });
    expect(
      [200, 201],
      `create leased tenant (status=${created.status()}, body: ${await created.text().catch(() => '')})`
    ).toContain(created.status());
    tenant = (await created.json()) as { _id: string; name: string };
  } else {
    // PATCH to make sure the lease + property assignment + dates are current
    // (a previous failed run might have left the tenant in a partial state).
    const patched = await request.patch(`${GATEWAY}/api/v2/tenants/${tenant._id}`, {
      headers: auth,
      data: {
        leaseId: seedLease.leaseId,
        beginDate: beginDateApi,
        endDate: endDateApi,
        properties: [{ propertyId: seedProperty.propertyId, rent: 500, expenses: [] }]
      }
    });
    // PATCH may 200 or no-op depending on diff; both are fine, only fail loud
    // on a 4xx/5xx that isn't 422 "no rents to recompute" or similar.
    if (patched.status() >= 400 && patched.status() !== 422) {
      throw new Error(
        `failed to refresh leased tenant: HTTP ${patched.status()} ${await patched.text().catch(() => '')}`
      );
    }
  }

  return {
    token: seedLease.token,
    realmId: seedLease.realmId,
    realmName: seedLease.realmName,
    buildingId: seedLease.buildingId,
    expenseId: seedLease.expenseId,
    tenantId: tenant._id,
    tenantName: tenant.name,
    propertyId: seedProperty.propertyId,
    leaseId: seedLease.leaseId,
    beginDate,
    endDate
  };
}

/**
 * Seeds a tenant under the test realm with a known phone1. Used by the
 * tenant-search spec (wave-24) which verifies the search-by-phone1 fix.
 *
 * The phone1 is randomized per run so a stale tenant from a prior failed
 * run cannot accidentally satisfy the assertion.
 */
export async function ensureSeedTenant(
  request: APIRequestContext
): Promise<TenantSeed> {
  const seed = await ensureSeed(request);
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };

  // Random phone1 so this run's assertion can't pass on a stale tenant from
  // a previous run. Use a 9-digit number prefixed with 6 (Greek mobile range).
  const phone1 = `69${Math.floor(10000000 + Math.random() * 89999999)}`;
  const tenantName = `E2E-Tenant-${Date.now()}`;

  const created = await request.post(`${GATEWAY}/api/v2/tenants`, {
    headers: auth,
    data: {
      name: tenantName,
      isCompany: false,
      manager: tenantName,
      contacts: [{ contact: tenantName, phone1, email: '', phone: '', phone2: '' }]
    }
  });
  expect(
    [200, 201],
    `create tenant (status=${created.status()}, body: ${await created.text().catch(() => '')})`
  ).toContain(created.status());
  const tenant = (await created.json()) as { _id: string; name: string };

  return { ...seed, tenantId: tenant._id, tenantName: tenant.name, tenantPhone1: phone1 };
}

export interface PaidLeasedTenantSeed extends LeasedTenantSeed {
  /** The term the payment was recorded against, in YYYYMMDDHH form. */
  paymentTerm: string;
  /** The amount of the seeded payment in EUR. */
  paymentAmount: number;
}

/**
 * Builds on ensureSeedLeasedTenant: makes sure the leased tenant's
 * CURRENT-MONTH rent has exactly ONE recorded payment of the requested
 * amount (cash, dated today). Idempotent — if a different payment ledger
 * is already recorded for this term, it is replaced with the canonical
 * single-payment baseline so re-runs always start from the same state.
 *
 * Used by the payment-dialog locked-tile spec, which needs an existing
 * saved payment to drive the add/edit/delete flows over.
 */
/**
 * Wave-26 round-3u: building seeded with FIVE distinct expense types
 * (heating, elevator, cleaning, insurance, repairs) plus a unit linked
 * to the seed property. Idempotent — re-runs reuse the existing seeded
 * expenses by name. Used by spec 17 (combinatorial UI matrix) so each
 * tenant's rent picks up real building-charges with real type values
 * the dashboard pie can color independently.
 */
export interface RichBuildingSeed extends LeasedTenantSeed {
  expenseHeatingId: string;
  expenseElevatorId: string;
  expenseCleaningId: string;
  expenseInsuranceId: string;
  expenseRepairId: string;
  unitId: string;
}

export async function ensureSeedRichBuilding(
  request: APIRequestContext
): Promise<RichBuildingSeed> {
  const seed = await ensureSeedLeasedTenant(request);
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };

  // Need a unit on the building, linked to the seed property, with
  // generalThousandths populated so pro-rata methods produce non-zero
  // shares.
  const buildingResp = await request.get(
    `${GATEWAY}/api/v2/buildings/${seed.buildingId}`,
    { headers: auth }
  );
  expect(buildingResp.status(), 'fetch building rich').toBe(200);
  const fullBuilding = (await buildingResp.json()) as {
    _id: string;
    expenses?: Array<{ _id: string; name: string; type?: string }>;
    units?: Array<{
      _id: string;
      atakNumber: string;
      propertyId?: string;
      generalThousandths?: number;
      heatingThousandths?: number;
      elevatorThousandths?: number;
    }>;
  };

  // Ensure unit linked to seed.propertyId with generalThousandths=1000.
  let unit = fullBuilding.units?.find(
    (u) => String(u.propertyId) === String(seed.propertyId)
  );
  if (!unit) {
    // Create or PATCH first managed unit to link to seed.propertyId.
    const candidate = fullBuilding.units?.find(
      (u) => u.atakNumber === 'E2E-RichUnit'
    );
    if (!candidate) {
      const created = await request.post(
        `${GATEWAY}/api/v2/buildings/${seed.buildingId}/units`,
        {
          headers: auth,
          data: {
            atakNumber: 'E2E-RichUnit',
            isManaged: true,
            occupancyType: 'rented',
            propertyId: seed.propertyId,
            generalThousandths: 1000,
            heatingThousandths: 1000,
            elevatorThousandths: 1000
          }
        }
      );
      expect(
        [200, 201],
        `create rich unit (status=${created.status()})`
      ).toContain(created.status());
      const updated = (await created.json()) as {
        units: Array<{
          _id: string;
          atakNumber: string;
          propertyId?: string;
        }>;
      };
      unit = updated.units.find((u) => u.atakNumber === 'E2E-RichUnit');
    } else {
      // PATCH the existing unit to link
      const patched = await request.patch(
        `${GATEWAY}/api/v2/buildings/${seed.buildingId}/units/${candidate._id}`,
        {
          headers: auth,
          data: {
            isManaged: true,
            occupancyType: 'rented',
            propertyId: seed.propertyId,
            generalThousandths: 1000,
            heatingThousandths: 1000,
            elevatorThousandths: 1000
          }
        }
      );
      if (patched.status() < 400) {
        unit = candidate;
      }
    }
  }
  if (!unit) throw new Error('Could not seed/find rich unit');
  const unitId = unit._id;

  // Helper to ensure a recurring expense by name exists on the building.
  const ensureExpense = async (
    name: string,
    type: string,
    amount: number,
    method = 'general_thousandths'
  ): Promise<string> => {
    const cur = fullBuilding.expenses?.find((e) => e.name === name);
    if (cur) return cur._id;
    const created = await request.post(
      `${GATEWAY}/api/v2/buildings/${seed.buildingId}/expenses`,
      {
        headers: auth,
        data: {
          name,
          type,
          amount,
          allocationMethod: method,
          isRecurring: true,
          startTerm: (() => {
            // 6 months before today, normalized to a real YYYYMMDDHH.
            const d = new Date();
            const past = new Date(
              Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, 1)
            );
            return Number(
              `${past.getUTCFullYear()}${String(
                past.getUTCMonth() + 1
              ).padStart(2, '0')}0100`
            );
          })()
        }
      }
    );
    expect(
      [200, 201],
      `create ${name} expense (status=${created.status()}, body: ${await created.text().catch(() => '')})`
    ).toContain(created.status());
    const body = (await created.json()) as {
      expenses: Array<{ _id: string; name: string }>;
    };
    const e = body.expenses.find((e) => e.name === name);
    if (!e) throw new Error(`Created ${name} expense not in response`);
    return e._id;
  };

  const expenseHeatingId = await ensureExpense('E2E-Heating', 'heating', 80);
  const expenseElevatorId = await ensureExpense('E2E-Elevator', 'elevator', 40);
  const expenseCleaningId = await ensureExpense('E2E-Cleaning', 'cleaning', 30);
  const expenseInsuranceId = await ensureExpense(
    'E2E-Insurance',
    'insurance',
    25
  );
  // Note: dashboard pie has a 'repair' bucket but the building-expense
  // type whitelist exposes 'repairs_fund' (validators.ts EXPENSE_TYPES).
  // The pipeline maps repairs_fund → 'repair' bucket via type matching.
  const expenseRepairId = await ensureExpense(
    'E2E-Repair',
    'repairs_fund',
    50
  );

  // Trigger a tenant PATCH so their rents[] array picks up the new
  // building expenses (occupantmanager re-runs the contract pipeline).
  await request.patch(`${GATEWAY}/api/v2/tenants/${seed.tenantId}`, {
    headers: auth,
    data: {
      properties: [
        { propertyId: seed.propertyId, rent: 500, expenses: [] }
      ]
    }
  });

  return {
    ...seed,
    expenseHeatingId,
    expenseElevatorId,
    expenseCleaningId,
    expenseInsuranceId,
    expenseRepairId,
    unitId
  };
}

/**
 * Wave-26 round-3u: seeds a SECOND tenant (E2E-LeasedTenant-B) on a
 * different property in the same realm. Used to exercise multi-tenant
 * scenarios in the dashboard, top-unpaid, express drawer, and bar
 * chart aggregation. Idempotent.
 */
export interface SecondTenantSeed extends LeasedTenantSeed {
  tenantBId: string;
  tenantBName: string;
  propertyBId: string;
}

export async function ensureSeedSecondTenant(
  request: APIRequestContext
): Promise<SecondTenantSeed> {
  const seed = await ensureSeedLeasedTenant(request);
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };

  // Find or create a second property.
  const propsResp = await request.get(`${GATEWAY}/api/v2/properties`, {
    headers: auth
  });
  expect(propsResp.status(), 'list props for second').toBe(200);
  const props = (await propsResp.json()) as Array<{ _id: string; name: string }>;
  let propB = props.find((p) => p.name === 'E2E-Property-B');
  if (!propB) {
    const created = await request.post(`${GATEWAY}/api/v2/properties`, {
      headers: auth,
      data: {
        name: 'E2E-Property-B',
        type: 'apartment',
        rent: 0,
        surface: 60,
        address: { street1: 'Test', city: 'Test', zipCode: '00000' }
      }
    });
    expect([200, 201]).toContain(created.status());
    propB = (await created.json()) as { _id: string; name: string };
  }

  // Tenant B with a 6m past begin → 6m future end window.
  const today = new Date();
  const beginUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, 1)
  );
  const endUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 7, 0)
  );
  const toDDMMYYYY = (iso: string) => {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  };
  const beginApi = toDDMMYYYY(beginUtc.toISOString().substring(0, 10));
  const endApi = toDDMMYYYY(endUtc.toISOString().substring(0, 10));

  const tenants = (await (
    await request.get(`${GATEWAY}/api/v2/tenants`, { headers: auth })
  ).json()) as Array<{ _id: string; name: string }>;
  let tenantB = tenants.find((t) => t.name === 'E2E-LeasedTenant-B');
  if (!tenantB) {
    const created = await request.post(`${GATEWAY}/api/v2/tenants`, {
      headers: auth,
      data: {
        name: 'E2E-LeasedTenant-B',
        isCompany: false,
        manager: 'E2E-LeasedTenant-B',
        contacts: [
          {
            contact: 'E2E-LeasedTenant-B',
            email: '',
            phone1: '6900000001',
            phone: '',
            phone2: ''
          }
        ],
        leaseId: seed.leaseId,
        beginDate: beginApi,
        endDate: endApi,
        properties: [{ propertyId: propB._id, rent: 750, expenses: [] }]
      }
    });
    expect([200, 201]).toContain(created.status());
    tenantB = (await created.json()) as { _id: string; name: string };
  } else {
    await request.patch(`${GATEWAY}/api/v2/tenants/${tenantB._id}`, {
      headers: auth,
      data: {
        leaseId: seed.leaseId,
        beginDate: beginApi,
        endDate: endApi,
        properties: [{ propertyId: propB._id, rent: 750, expenses: [] }]
      }
    });
  }

  return {
    ...seed,
    tenantBId: tenantB._id,
    tenantBName: tenantB.name,
    propertyBId: propB._id
  };
}

export async function ensureSeedLeasedTenantWithPayment(
  request: APIRequestContext,
  amount = 100
): Promise<PaidLeasedTenantSeed> {
  const seed = await ensureSeedLeasedTenant(request);
  const auth = {
    Authorization: `Bearer ${seed.token}`,
    'Content-Type': 'application/json',
    organizationid: seed.realmId
  };

  // Current month, term in YYYYMMDDHH form. Use LOCAL date (not UTC) —
  // tests navigate the UI via `${getFullYear()}.${getMonth()+1}` which
  // is local. Around midnight Athens (EEST = UTC+3), getUTCMonth and
  // getMonth disagree by a month, so a UTC-based seed lands a payment
  // in the prior month while the test's UI page is on the next month
  // — the rent table renders empty and every payment-dialog test
  // times out.
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const term = `${year}${month}0100`;

  // Today's date in DD/MM/YYYY (api expects strict format).
  const day = String(now.getDate()).padStart(2, '0');
  const todayDDMMYYYY = `${day}/${month}/${year}`;

  // PATCH /rents/payment/{tenantId}/{term} with a single-payment payload.
  // The handler replaces the rent's payments[] array wholesale.
  const payload = {
    _id: seed.tenantId,
    month: now.getMonth() + 1,
    year,
    payments: [
      {
        amount,
        date: todayDDMMYYYY,
        type: 'cash',
        reference: '',
        description: ''
      }
    ],
    description: '',
    extracharge: 0,
    noteextracharge: '',
    promo: 0,
    notepromo: ''
  };

  const resp = await request.patch(
    `${GATEWAY}/api/v2/rents/payment/${seed.tenantId}/${term}`,
    { headers: auth, data: payload }
  );
  expect(
    [200, 201],
    `seed payment (status=${resp.status()}, body: ${await resp.text().catch(() => '')})`
  ).toContain(resp.status());

  return {
    ...seed,
    paymentTerm: term,
    paymentAmount: amount
  };
}
