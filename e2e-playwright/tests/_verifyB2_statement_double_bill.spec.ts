/**
 * VERIFY B2 — saveMonthlyStatement equal-allocation tenant grouping.
 *
 * Pre-fix bug: saveMonthlyStatement called computeBuildingChargeForProperty
 * with `(building as any).toObject()` per iteration. The plain-object
 * snapshot had no `_tenantGroups` attached, so the equal-allocation
 * branch fell through to the per-managed-unit fallback (1_base.ts:209-219)
 * — a tenant occupying two units in the same building (apartment + storage)
 * was billed 50/50 across the two properties = double-charged.
 *
 * Fix: build a buildingPlain snapshot, attach _tenantGroups via the same
 * occupantmanager helper used in the live recompute path, pass that
 * snapshot to computeBuildingChargeForProperty inside the loop. The
 * "equal" branch then groups by unique tenant: one share per tenant on
 * the carrier propertyId (sorted-min) and 0€ on the other.
 *
 * Verification scenario:
 *   - Build a 2-unit building, each unit linked to a different property.
 *   - Make one tenant occupy BOTH properties (one tenant group).
 *   - Add a 100€ "equal" allocation building expense.
 *   - POST /buildings/:id/monthly-statement for the current term.
 *   - Read the building back via GET. Sum monthlyCharges across BOTH
 *     of this tenant's units for this term → must be exactly 100, NOT 200.
 *   - The carrier (sorted-min propertyId) should hold 100; the other 0.
 *
 * Cleanup: clear monthlyCharges back to baseline by re-issuing a
 * monthly-statement with empty expenses[].
 */
import { expect, request, test } from '@playwright/test';
import { ensureSeedLeasedTenant } from './lib/api';

const GATEWAY = process.env.NAS_GATEWAY_URL || 'http://192.168.0.96:1350';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

test.beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD');
  }
});

test.describe('verify B2 · saveMonthlyStatement equal-allocation grouping', () => {
  test('one tenant occupying 2 properties in same building gets ONE 100€ share, not 200€', async () => {
    test.setTimeout(180_000);

    const api = await request.newContext();
    try {
      const seed = await ensureSeedLeasedTenant(api);

      const signin = await api.post(
        `${GATEWAY}/api/v2/authenticator/landlord/signin`,
        {
          data: { email: TEST_EMAIL, password: TEST_PASSWORD },
          headers: { 'Content-Type': 'application/json' }
        }
      );
      expect(signin.status(), 'signin').toBe(200);
      const { accessToken: token } = await signin.json();

      const auth = {
        Authorization: `Bearer ${token}`,
        organizationid: seed.realmId,
        'Content-Type': 'application/json'
      };

      // STEP 1: ensure a second property "E2E-Property-Storage" exists.
      const propsResp = await api.get(`${GATEWAY}/api/v2/properties`, { headers: auth });
      expect(propsResp.status(), 'list properties').toBe(200);
      const props = (await propsResp.json()) as Array<{ _id: string; name: string }>;
      let propStorage = props.find((p) => p.name === 'E2E-Property-Storage');
      if (!propStorage) {
        const created = await api.post(`${GATEWAY}/api/v2/properties`, {
          headers: auth,
          data: {
            name: 'E2E-Property-Storage',
            type: 'parking',
            rent: 0,
            surface: 10,
            address: { street1: 'Storage', city: 'Test', zipCode: '00000' }
          }
        });
        expect([200, 201]).toContain(created.status());
        propStorage = (await created.json()) as { _id: string; name: string };
      }

      // STEP 2: ensure two units on the building, each linked to
      // seed.propertyId (apartment) and propStorage._id (storage).
      const bldResp = await api.get(`${GATEWAY}/api/v2/buildings/${seed.buildingId}`, { headers: auth });
      expect(bldResp.status(), 'fetch building').toBe(200);
      const fullBld = (await bldResp.json()) as {
        _id: string;
        units?: Array<{
          _id: string;
          atakNumber?: string;
          propertyId?: string;
          isManaged?: boolean;
        }>;
      };

      // Apartment unit linked to seed.propertyId.
      let aptUnit = (fullBld.units || []).find(
        (u) => String(u.propertyId) === String(seed.propertyId)
      );
      if (!aptUnit) {
        const c = await api.post(`${GATEWAY}/api/v2/buildings/${seed.buildingId}/units`, {
          headers: auth,
          data: {
            atakNumber: 'E2E-Unit-Apt',
            isManaged: true,
            occupancyType: 'rented',
            propertyId: seed.propertyId
          }
        });
        expect([200, 201], `create apt unit (${c.status()}: ${await c.text().catch(() => '')})`).toContain(c.status());
        const j = (await c.json()) as { units: Array<{ _id: string; propertyId?: string }> };
        aptUnit = j.units.find((u) => String(u.propertyId) === String(seed.propertyId));
        expect(aptUnit, 'apt unit').toBeTruthy();
      }

      // Storage unit linked to propStorage._id.
      let stoUnit = (fullBld.units || []).find(
        (u) => String(u.propertyId) === String(propStorage!._id)
      );
      if (!stoUnit) {
        const c = await api.post(`${GATEWAY}/api/v2/buildings/${seed.buildingId}/units`, {
          headers: auth,
          data: {
            atakNumber: 'E2E-Unit-Storage',
            isManaged: true,
            occupancyType: 'rented',
            propertyId: propStorage!._id
          }
        });
        expect([200, 201], `create storage unit (${c.status()}: ${await c.text().catch(() => '')})`).toContain(c.status());
        const j = (await c.json()) as { units: Array<{ _id: string; propertyId?: string }> };
        stoUnit = j.units.find((u) => String(u.propertyId) === String(propStorage!._id));
        expect(stoUnit, 'storage unit').toBeTruthy();
      }

      // STEP 3: PATCH the seed tenant to occupy BOTH properties (one group).
      // Pull the canonical record first so the PATCH carries name/contacts/
      // leaseId/dates intact (the update validator wants name as string).
      // E15 requires __v on the PATCH body — capture it from the freshly
      // fetched doc and re-read after each PATCH so the second restore
      // PATCH still satisfies the optimistic lock.
      const tFetch = await api.get(`${GATEWAY}/api/v2/tenants/${seed.tenantId}`, { headers: auth });
      expect(tFetch.status(), 'fetch tenant pre-PATCH').toBe(200);
      const tCur = (await tFetch.json()) as {
        name: string;
        manager?: string;
        contacts?: any[];
        leaseId?: string;
        beginDate?: string;
        endDate?: string;
        isCompany?: boolean;
        __v?: number;
      };

      // Format dates as DD/MM/YYYY (occupantmanager._stringToDate strict).
      const fmtDate = (iso?: string): string | undefined => {
        if (!iso) return undefined;
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
        if (m) return `${m[3]}/${m[2]}/${m[1]}`;
        // Already DD/MM/YYYY ish
        return iso.length === 10 ? iso : undefined;
      };

      const patchTenant = await api.patch(`${GATEWAY}/api/v2/tenants/${seed.tenantId}`, {
        headers: auth,
        data: {
          name: tCur.name,
          isCompany: !!tCur.isCompany,
          manager: tCur.manager || tCur.name,
          contacts: tCur.contacts || [
            { contact: tCur.name, email: '', phone1: '6900000000', phone: '', phone2: '' }
          ],
          leaseId: tCur.leaseId || seed.leaseId,
          beginDate: fmtDate(tCur.beginDate) || fmtDate(seed.beginDate),
          endDate: fmtDate(tCur.endDate) || fmtDate(seed.endDate),
          properties: [
            { propertyId: seed.propertyId, rent: 500, expenses: [] },
            { propertyId: propStorage!._id, rent: 0, expenses: [] }
          ],
          __v: tCur.__v
        }
      });
      expect(
        patchTenant.status(),
        `tenant occupies both properties (${await patchTenant.text().catch(() => '')})`
      ).toBe(200);

      // STEP 4: ensure an "equal" allocation expense exists, type "other".
      const bld2Resp = await api.get(`${GATEWAY}/api/v2/buildings/${seed.buildingId}`, { headers: auth });
      expect(bld2Resp.status(), 'fetch building 2').toBe(200);
      const fullBld2 = (await bld2Resp.json()) as {
        _id: string;
        expenses?: Array<{ _id: string; name: string; allocationMethod?: string; amount?: number }>;
      };
      let equalExpense = (fullBld2.expenses || []).find(
        (e) => e.name === 'E2E-Equal-100'
      );
      if (!equalExpense) {
        const d = new Date();
        const past = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, 1));
        const startTerm = Number(
          `${past.getUTCFullYear()}${String(past.getUTCMonth() + 1).padStart(2, '0')}0100`
        );
        const c = await api.post(`${GATEWAY}/api/v2/buildings/${seed.buildingId}/expenses`, {
          headers: auth,
          data: {
            name: 'E2E-Equal-100',
            type: 'other',
            amount: 100,
            allocationMethod: 'equal',
            isRecurring: true,
            startTerm
          }
        });
        expect(
          [200, 201],
          `create equal expense (${c.status()}: ${await c.text().catch(() => '')})`
        ).toContain(c.status());
        const j = (await c.json()) as { expenses: Array<{ _id: string; name: string }> };
        equalExpense = j.expenses.find((e) => e.name === 'E2E-Equal-100');
        expect(equalExpense, 'created equal expense').toBeTruthy();
      } else if (equalExpense.allocationMethod !== 'equal' || Number(equalExpense.amount) !== 100) {
        // Drift correction — a previous run changed it.
        const c = await api.patch(
          `${GATEWAY}/api/v2/buildings/${seed.buildingId}/expenses/${equalExpense._id}`,
          {
            headers: auth,
            data: { allocationMethod: 'equal', amount: 100 }
          }
        );
        expect(c.status(), `realign equal expense (${await c.text().catch(() => '')})`).toBeLessThan(400);
      }

      // STEP 5: POST monthly-statement for current month.
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const term = Number(`${year}${month}0100`);

      const stmt = await api.post(
        `${GATEWAY}/api/v2/buildings/${seed.buildingId}/monthly-statement`,
        {
          headers: auth,
          data: {
            term,
            expenses: [
              {
                expenseId: equalExpense!._id,
                amount: 100,
                allocationMethod: 'equal',
                description: 'E2E-Equal-100'
              }
            ]
          }
        }
      );
      expect(
        stmt.status(),
        `monthly-statement (${await stmt.text().catch(() => '')})`
      ).toBe(200);

      // STEP 6: re-read the building, sum monthlyCharges for term across
      // BOTH the tenant's units. Must be 100, not 200.
      const bld3Resp = await api.get(`${GATEWAY}/api/v2/buildings/${seed.buildingId}`, { headers: auth });
      expect(bld3Resp.status(), 'fetch building 3').toBe(200);
      const fullBld3 = (await bld3Resp.json()) as {
        _id: string;
        units?: Array<{
          _id: string;
          atakNumber: string;
          propertyId?: string;
          monthlyCharges?: Array<{ term?: number; amount?: number; description?: string; expenseId?: string }>;
        }>;
      };

      const aptCharges = (fullBld3.units || []).find(
        (u) => String(u.propertyId) === String(seed.propertyId)
      )?.monthlyCharges?.filter(
        (c) => Number(c.term) === term && String(c.expenseId) === String(equalExpense!._id)
      ) || [];
      const stoCharges = (fullBld3.units || []).find(
        (u) => String(u.propertyId) === String(propStorage!._id)
      )?.monthlyCharges?.filter(
        (c) => Number(c.term) === term && String(c.expenseId) === String(equalExpense!._id)
      ) || [];

      const aptSum = Math.round(aptCharges.reduce((s, c) => s + (Number(c.amount) || 0), 0) * 100) / 100;
      const stoSum = Math.round(stoCharges.reduce((s, c) => s + (Number(c.amount) || 0), 0) * 100) / 100;
      const total = Math.round((aptSum + stoSum) * 100) / 100;

      console.log(
        `[verifyB2] apt charges term=${term}: ${aptSum.toFixed(2)} (count=${aptCharges.length})`
      );
      console.log(
        `[verifyB2] storage charges term=${term}: ${stoSum.toFixed(2)} (count=${stoCharges.length})`
      );
      console.log(`[verifyB2] sum across both units: ${total.toFixed(2)}`);

      // The headline assertion. Pre-fix: total = 200. Post-fix: total = 100.
      expect(
        total,
        `single tenant occupying 2 units must be billed ONCE for equal-allocation (got ${total}, expected 100)`
      ).toBe(100);

      // Carrier (sorted-min) should hold the full share, the other should
      // be 0. Determine which propertyId is the sorted-min carrier.
      const ids = [String(seed.propertyId), String(propStorage!._id)].sort();
      const carrierIsApt = ids[0] === String(seed.propertyId);
      console.log(
        `[verifyB2] carrier=${carrierIsApt ? 'apartment' : 'storage'} (sorted-min: ${ids[0]})`
      );
      if (carrierIsApt) {
        expect(aptSum, 'carrier (apt) holds 100€').toBe(100);
        expect(stoSum, 'non-carrier (storage) holds 0€').toBe(0);
      } else {
        expect(stoSum, 'carrier (storage) holds 100€').toBe(100);
        expect(aptSum, 'non-carrier (apt) holds 0€').toBe(0);
      }

      // STEP 7: cleanup — re-issue monthly-statement with empty expenses
      // to clear the monthlyCharges entries we wrote.
      const cleanup = await api.post(
        `${GATEWAY}/api/v2/buildings/${seed.buildingId}/monthly-statement`,
        {
          headers: auth,
          data: { term, expenses: [] }
        }
      );
      expect(
        cleanup.status(),
        `cleanup statement (${await cleanup.text().catch(() => '')})`
      ).toBe(200);

      // PATCH tenant back to single-property baseline so other specs can
      // run against the canonical seed. Re-fetch __v first — the previous
      // PATCH bumped the document version.
      const tFetch2 = await api.get(`${GATEWAY}/api/v2/tenants/${seed.tenantId}`, { headers: auth });
      expect(tFetch2.status(), 'fetch tenant pre-restore').toBe(200);
      const tCur2 = (await tFetch2.json()) as { __v?: number };
      const restore = await api.patch(`${GATEWAY}/api/v2/tenants/${seed.tenantId}`, {
        headers: auth,
        data: {
          name: tCur.name,
          isCompany: !!tCur.isCompany,
          manager: tCur.manager || tCur.name,
          contacts: tCur.contacts || [
            { contact: tCur.name, email: '', phone1: '6900000000', phone: '', phone2: '' }
          ],
          leaseId: tCur.leaseId || seed.leaseId,
          beginDate: fmtDate(tCur.beginDate) || fmtDate(seed.beginDate),
          endDate: fmtDate(tCur.endDate) || fmtDate(seed.endDate),
          properties: [{ propertyId: seed.propertyId, rent: 500, expenses: [] }],
          __v: tCur2.__v
        }
      });
      expect(
        restore.status(),
        `restore tenant single property (${await restore.text().catch(() => '')})`
      ).toBe(200);

      // STEP 8: deep-cleanup — drop the recurring "E2E-Equal-100" expense
      // AND the "E2E-Unit-Storage" unit. Recurring expenses back-apply
      // forever via the rent recompute pipeline, so leaving the expense
      // on the building pollutes every other spec's tenant.rents[]
      // buildingCharges. Same for the storage unit (it's only used by
      // this spec). The storage property is safe to leave (no unit
      // references it after the unit is dropped).
      const dExp = await api.delete(
        `${GATEWAY}/api/v2/buildings/${seed.buildingId}/expenses/${equalExpense!._id}`,
        { headers: { Authorization: `Bearer ${token}`, organizationid: seed.realmId } }
      );
      expect(
        [200, 204],
        `cleanup E2E-Equal-100 expense (${dExp.status()})`
      ).toContain(dExp.status());

      const dUnit = await api.delete(
        `${GATEWAY}/api/v2/buildings/${seed.buildingId}/units/${stoUnit!._id}`,
        { headers: { Authorization: `Bearer ${token}`, organizationid: seed.realmId } }
      );
      expect(
        [200, 204],
        `cleanup E2E-Unit-Storage unit (${dUnit.status()})`
      ).toContain(dUnit.status());

      const dProp = await api.delete(
        `${GATEWAY}/api/v2/properties/${propStorage!._id}`,
        { headers: { Authorization: `Bearer ${token}`, organizationid: seed.realmId } }
      );
      expect(
        [200, 204],
        `cleanup E2E-Property-Storage property (${dProp.status()})`
      ).toContain(dProp.status());

      // Read-back: realm restored to baseline expenses (no E2E-Equal-100)
      // and baseline unit count (1, just E2E-Unit).
      const finalBld = await api.get(`${GATEWAY}/api/v2/buildings/${seed.buildingId}`, { headers: auth });
      expect(finalBld.status(), 'fetch building post-cleanup').toBe(200);
      const finalFull = (await finalBld.json()) as {
        expenses?: Array<{ name: string }>;
        units?: Array<{ atakNumber: string }>;
      };
      const stillEqual = (finalFull.expenses || []).filter((e) => e.name === 'E2E-Equal-100');
      expect(stillEqual.length, 'no E2E-Equal-100 left').toBe(0);
      const stillStorage = (finalFull.units || []).filter((u) => u.atakNumber === 'E2E-Unit-Storage');
      expect(stillStorage.length, 'no E2E-Unit-Storage left').toBe(0);
    } finally {
      await api.dispose();
    }
  });
});
