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
