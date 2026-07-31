import { test, expect, request } from '@playwright/test';
import { ensureSeedWithUnit } from './lib/api';

/**
 * Wave-24 bug 9: editing a unit's occupancyType (vacant → owner_occupied →
 * etc.) must persist across reload. Pre-fix the Select wasn't wired into
 * react-hook-form so the value was lost on submit.
 *
 * Discipline: status assertion on PATCH + round-trip read-back of the Select
 * value after re-opening the dialog.
 */

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';
// playwright.config.ts sets NAS_GATEWAY_URL before any spec loads (and honours
// a GATEWAY_URL override), so there is no fallback to add here. Hardcoding the
// production IP as a default would silently pin this spec to prod if the config
// ever stopped running.
const GATEWAY = process.env.NAS_GATEWAY_URL as string;

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD.');
  }
});

test('changing unit occupancy to owner_occupied PATCHes 200 and persists', async ({ page }) => {
  const apiCtx = await request.newContext();
  const { realmName, buildingId, token, realmId } =
    await ensureSeedWithUnit(apiCtx);

  // FIXTURE FIX (2026-07): this used the shared `E2E-Unit`, which other specs
  // (06, 30) PATCH a propertyId onto — and that property has an ACTIVE tenant.
  // The server enforces TWO correct rules here, and the old fixture violated
  // both in turn:
  //   1. owner_occupied REQUIRES a linked property
  //      («Η ιδιοκατοίκηση απαιτεί συνδεδεμένο ακίνητο…»)
  //   2. owner_occupied is mutually exclusive with an ACTIVE tenant on that
  //      property («Η μονάδα είναι ενοικιασμένη — τερματίστε πρώτα τη μίσθωση…»)
  // So the fixture needs a dedicated unit linked to its OWN property that no
  // tenant rents. Both rules then hold and owner_occupied is legitimate.
  const OCC_ATAK = 'E2E-OccUnit';
  const OCC_PROP = 'E2E-OccProperty';
  const occHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    organizationid: realmId
  };

  // A property of its own, never assigned to a tenant.
  const propsResp = await apiCtx.get(`${GATEWAY}/api/v2/properties`, {
    headers: occHeaders
  });
  expect(propsResp.status(), 'list properties').toBe(200);
  const allProps = (await propsResp.json()) as Array<{
    _id: string;
    name: string;
  }>;
  let occProp = allProps.find((p) => p.name === OCC_PROP);
  if (!occProp) {
    const createdProp = await apiCtx.post(`${GATEWAY}/api/v2/properties`, {
      headers: occHeaders,
      data: {
        name: OCC_PROP,
        type: 'apartment',
        surface: 40,
        address: { street1: 'Test', zipCode: '00000', city: 'Test' }
      }
    });
    expect(
      [200, 201],
      `create ${OCC_PROP} (body: ${await createdProp.text().catch(() => '')})`
    ).toContain(createdProp.status());
    const again = await apiCtx.get(`${GATEWAY}/api/v2/properties`, {
      headers: occHeaders
    });
    occProp = ((await again.json()) as Array<{ _id: string; name: string }>).find(
      (p) => p.name === OCC_PROP
    );
  }
  if (!occProp) throw new Error(`Could not seed/find ${OCC_PROP}`);
  const readBuilding = async () => {
    const r = await apiCtx.get(`${GATEWAY}/api/v2/buildings/${buildingId}`, {
      headers: occHeaders
    });
    expect(r.status(), 'read building').toBe(200);
    return (await r.json()) as {
      __v?: number;
      units?: Array<{
        _id: string;
        atakNumber: string;
        propertyId?: string;
        occupancyType?: string;
      }>;
    };
  };
  let building = await readBuilding();
  let occUnit = (building.units || []).find((u) => u.atakNumber === OCC_ATAK);
  if (!occUnit) {
    const created = await apiCtx.post(
      `${GATEWAY}/api/v2/buildings/${buildingId}/units`,
      {
        headers: occHeaders,
        data: {
          atakNumber: OCC_ATAK,
          isManaged: true,
          occupancyType: 'vacant',
          propertyId: occProp._id
          // No thousandths on purpose: 0 cannot trip the building-wide ≤1000
          // cap that the other units already consume.
        }
      }
    );
    expect(
      [200, 201],
      `create ${OCC_ATAK} (body: ${await created.text().catch(() => '')})`
    ).toContain(created.status());
    building = await readBuilding();
    occUnit = (building.units || []).find((u) => u.atakNumber === OCC_ATAK);
  }
  if (!occUnit) throw new Error(`Could not seed/find ${OCC_ATAK}`);

  // Reset UNCONDITIONALLY, then re-read. Two reasons this must not be an
  // `else if`:
  //   - other specs in the same run (06, 30) PATCH units on this building and
  //     can leave OCC_ATAK unlinked, and an unlinked unit cannot legally become
  //     owner-occupied → the save 422s with «…απαιτεί συνδεδεμένο ακίνητο…»
  //     (this is the group-run flake: the Linked-property combobox rendered
  //     EMPTY in the failure snapshot);
  //   - a previous run may have left it owner_occupied, which would make the
  //     'unchecked' precondition below accidentally already-true.
  // Re-reading afterwards matters too: the PATCH bumps the building's __v, and
  // a stale in-memory copy would carry the wrong version into later calls.
  {
    const reset = await apiCtx.patch(
      `${GATEWAY}/api/v2/buildings/${buildingId}/units/${occUnit._id}`,
      {
        headers: occHeaders,
        data: {
          isManaged: true,
          occupancyType: 'vacant',
          propertyId: occProp._id,
          __v: building.__v
        }
      }
    );
    expect(
      reset.status(),
      `reset unit to vacant+linked (body: ${await reset.text().catch(() => '')})`
    ).toBeLessThan(400);
    building = await readBuilding();
    occUnit = (building.units || []).find((u) => u.atakNumber === OCC_ATAK);
    if (!occUnit) throw new Error(`${OCC_ATAK} vanished after reset`);
    expect(
      String(occUnit.propertyId || ''),
      'precondition: the fixture unit is linked to its own property'
    ).toBe(String(occProp._id));
    expect(
      occUnit.occupancyType,
      'precondition: the fixture unit starts vacant'
    ).not.toBe('owner_occupied');
  }
  const unitId = occUnit._id;
  await apiCtx.dispose();

  // Sign in.
  await page.goto('signin');
  await page.locator('input[name=email]').fill(TEST_EMAIL);
  await page.locator('input[name=password]').fill(TEST_PASSWORD);
  await page.locator('[data-cy=submit]').first().click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/(firstaccess|dashboard)/);

  await page.goto(`${encodeURIComponent(realmName)}/buildings/${buildingId}`);
  await page.locator('[data-cy=unitsTab]').click();

  // `:text-is` = EXACT match. A substring `hasText: 'E2E-Unit'` also matched
  // leaked `E2E-UNIT-<timestamp>` fixtures and resolved to several rows.
  const unitRow = page.locator('tr', {
    has: page.locator(`td:text-is("${OCC_ATAK}")`)
  });
  await expect(unitRow).toBeVisible({ timeout: 15_000 });
  await unitRow.locator('button').first().click(); // pencil

  await expect(page.locator('[role=dialog]')).toBeVisible();

  // STALE-SPEC FIX (2026-07): occupancy is no longer a `#occupancyType` Select.
  // It is derived state driven by the `#ownerOccupied` Switch — ON sets
  // occupancyType='owner_occupied', OFF reverts to the derived value ('parking'
  // is preserved, otherwise 'vacant'; 'rented' is re-derived server-side from
  // the linked tenant). The old Select-based clicks hung for 15s on a locator
  // that no longer exists.
  const ownerOccupiedSwitch = page.locator('[role=dialog] #ownerOccupied');
  await expect(ownerOccupiedSwitch, '#ownerOccupied switch present').toBeVisible({
    timeout: 10_000
  });
  await expect(
    ownerOccupiedSwitch,
    'switch must be enabled (unit is not tenant-occupied)'
  ).toBeEnabled();
  await expect(
    ownerOccupiedSwitch,
    'precondition: unit is not yet owner-occupied'
  ).toHaveAttribute('data-state', 'unchecked');
  await ownerOccupiedSwitch.click();
  await expect(
    ownerOccupiedSwitch,
    'switch flipped ON before saving'
  ).toHaveAttribute('data-state', 'checked');

  const patchPromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/v2/buildings/${buildingId}/units/${unitId}`) &&
      r.request().method() === 'PATCH'
  );
  // Form is taller than viewport in this dialog — scroll the button into
  // view before clicking. We do not weaken the click with force:true because
  // a force-clicked button can fire on an inert element and pass the test
  // even when the button is broken.
  const updateBtn = page
    .locator('[role=dialog]')
    .getByRole('button', { name: /update|αποθή|save/i });
  await updateBtn.scrollIntoViewIfNeeded();
  await updateBtn.click();
  const patchResp = await patchPromise;
  expect(patchResp.status(), 'unit PATCH must return 200').toBe(200);

  // Round-trip: dialog closes, re-open, the switch must come back ON — i.e.
  // occupancyType='owner_occupied' actually PERSISTED, not just set in form
  // state. Asserting the switch's data-state is the equivalent of the old
  // Select-text check, and it reads the value the server sent back.
  await expect(page.locator('[role=dialog]')).toBeHidden({ timeout: 10_000 });
  await unitRow.locator('button').first().click();
  await expect(page.locator('[role=dialog]')).toBeVisible();
  await expect(
    page.locator('[role=dialog] #ownerOccupied'),
    'owner_occupied persisted across dialog close/re-open'
  ).toHaveAttribute('data-state', 'checked', { timeout: 10_000 });

  // Belt-and-braces: confirm via the API too, so a UI-only regression (switch
  // renders ON from stale form state while mongo still says 'vacant') fails.
  const verifyCtx = await request.newContext();
  const bResp = await verifyCtx.get(
    `${GATEWAY}/api/v2/buildings/${buildingId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        organizationid: realmId
      }
    }
  );
  expect(bResp.status(), 'read building back').toBe(200);
  const bJson = (await bResp.json()) as {
    units?: Array<{ _id: string; occupancyType?: string }>;
  };
  const persisted = (bJson.units || []).find(
    (u) => String(u._id) === String(unitId)
  );
  expect(
    persisted?.occupancyType,
    'server-side occupancyType is owner_occupied'
  ).toBe('owner_occupied');
  await verifyCtx.dispose();
});
