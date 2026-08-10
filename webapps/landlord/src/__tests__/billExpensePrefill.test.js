/**
 * The create-expense prefill shared by BOTH bill-ingest surfaces.
 *
 * WHY THIS EXISTS: the upload dialog (BillImportDialog) and the Telegram inbox
 * bell (InboxBell) both open ExpenseFormDialog for the same bills, and only the
 * upload path had the thousandths-aware allocation three-way. The bell hardcoded
 * `allocationMethod: 'equal'`, so a κοινόχρηστο bill arriving by bot split equally
 * where the same bill uploaded split by χιλιοστά — a silent per-unit money error,
 * repeated monthly because these expenses are recurring. One helper now serves
 * both; these tests pin the branches that carry the money.
 */
import {
  buildExpensePrefill,
  sharedThousandthsMethod
} from '../utils/billExpensePrefill';

// Four units with UNEQUAL χιλιοστά — the whole point is that equal ≠ χιλιοστά.
const BUILDING = {
  _id: 'b1',
  units: [
    { _id: 'u1', generalThousandths: 400, heatingThousandths: 500 },
    { _id: 'u2', generalThousandths: 300, heatingThousandths: 300 },
    { _id: 'u3', generalThousandths: 200, heatingThousandths: 200 },
    { _id: 'u4', generalThousandths: 100, heatingThousandths: 0 }
  ]
};
// An E9-imported building: no χιλιοστά recorded at all.
const NO_THOUSANDTHS = {
  _id: 'b2',
  units: [{ _id: 'v1' }, { _id: 'v2' }]
};

describe('buildExpensePrefill — shared (κοινόχρηστος) meter', () => {
  it('splits ΔΕΗ by GENERAL χιλιοστά, not equally', () => {
    const p = buildExpensePrefill({
      building: BUILDING,
      provider: 'deh',
      billingId: '999935585',
      sharedMatch: { provider: 'deh', label: 'Κλιμακοστάσιο' }
    });
    expect(p.allocationMethod).toBe('general_thousandths');
    expect(p.type).toBe('electricity_common');
    // The meter's own label names the expense better than the bare provider.
    expect(p.name).toBe('Κλιμακοστάσιο');
    // A shared bill must NEVER target one apartment.
    expect(p.customAllocations).toEqual([]);
  });

  it('splits ΕΠΑ gas by HEATING χιλιοστά (general is not offered for heating)', () => {
    // Pairing type `heating` with `general_thousandths` is a combination the
    // expense picker itself forbids; it would bill unheated units for heating.
    const p = buildExpensePrefill({
      building: BUILDING,
      provider: 'epa',
      billingId: '999900123',
      sharedMatch: { provider: 'epa' }
    });
    expect({ type: p.type, method: p.allocationMethod }).toEqual({
      type: 'heating',
      method: 'heating_thousandths'
    });
  });

  it('degrades to equal when the building has NO χιλιοστά (invisible money)', () => {
    // Σ thousandths === 0 → 1_base.ts returns a 0 share for every unit, writes no
    // monthlyCharge row, and the amount lands on no surface at all. An equal split
    // is wrong-ish but VISIBLE; silence is worse.
    for (const provider of ['deh', 'eydap', 'epa']) {
      const p = buildExpensePrefill({
        building: NO_THOUSANDTHS,
        provider,
        billingId: '999900999',
        sharedMatch: { provider }
      });
      expect({ provider, method: p.allocationMethod }).toEqual({
        provider,
        method: 'equal'
      });
    }
  });

  it('names the expense after the STORED meter, not the parsed provider', () => {
    // The extraction fixed an inconsistency in the upload path: `type` was derived
    // from the meter's provider while `name` came from the PARSE, so a ΕΥΔΑΠ shared
    // meter on a bill the OCR read as ΔΕΗ was labelled «DEH» and typed
    // water_common. A differential run over 750 input combinations showed `name` is
    // the ONLY field that changed, and only in this direction.
    const p = buildExpensePrefill({
      building: BUILDING,
      provider: 'deh', // what the parse thought
      billingId: 'x',
      sharedMatch: { provider: 'eydap' } // what the landlord recorded
    });
    expect({ name: p.name, type: p.type }).toEqual({
      name: 'EYDAP',
      type: 'water_common'
    });
  });

  it("prefers the STORED meter's provider over the parsed one", () => {
    // The landlord recorded the meter; the OCR guessed. On a failed parse the
    // parsed provider may be absent or wrong.
    const p = buildExpensePrefill({
      building: BUILDING,
      provider: '',
      billingId: '',
      sharedMatch: { provider: 'eydap' }
    });
    expect({ type: p.type, name: p.name }).toEqual({
      type: 'water_common',
      name: 'EYDAP'
    });
  });
});

describe('buildExpensePrefill — apartment meter and fallback', () => {
  it('bills a unit meter entirely to that apartment', () => {
    const p = buildExpensePrefill({
      building: BUILDING,
      provider: 'deh',
      billingId: '999935587',
      unitMatch: { propertyId: 'u3' }
    });
    expect(p.allocationMethod).toBe('single_unit');
    expect(p.customAllocations).toEqual([{ propertyId: 'u3', value: 0 }]);
  });

  it('a SHARED hit wins over a unit hit — never single_unit for κοινόχρηστο', () => {
    const p = buildExpensePrefill({
      building: BUILDING,
      provider: 'deh',
      billingId: '999935585',
      sharedMatch: { provider: 'deh' },
      unitMatch: { propertyId: 'u1' }
    });
    expect(p.allocationMethod).toBe('general_thousandths');
    expect(p.customAllocations).toEqual([]);
  });

  it('drops single_unit when the landlord overrides the building', () => {
    // The bell scopes unitMatch to the resolved building before calling this: a
    // propertyId belonging to another building fails the server's cross-building
    // guard with an undiagnosable generic toast. Mirrors the upload path's scoping.
    const p = buildExpensePrefill({
      building: BUILDING,
      provider: 'deh',
      billingId: '999935587',
      unitMatch: null // caller scoped it out
    });
    expect(p.allocationMethod).toBe('equal');
    expect(p.customAllocations).toEqual([]);
  });

  it('falls back to an equal split when nothing is identified', () => {
    const p = buildExpensePrefill({
      building: BUILDING,
      provider: '',
      billingId: ''
    });
    expect(p.allocationMethod).toBe('equal');
    expect(p.type).toBe('other');
    expect(p.name).toBe('');
  });

  it('never pre-commits an amount, and always marks the expense recurring', () => {
    const p = buildExpensePrefill({
      building: BUILDING,
      provider: 'deh',
      billingId: '999935585',
      sharedMatch: { provider: 'deh' }
    });
    // A salvaged total may include a prior balance — the operator types it in.
    expect(p.amount).toBe(0);
    expect(p.isRecurring).toBe(true);
    expect(p.chargeOwnerWhenVacant).toBe(true);
  });
});

describe('the money delta this helper exists to prevent', () => {
  it('χιλιοστά and equal disagree by €30/unit on a €200 bill', () => {
    // Mirrors 1_base.ts: general_thousandths → amount * (unit‰ / Σ‰);
    // equal → amount / unitCount.
    const total = 200;
    const sum = BUILDING.units.reduce((s, u) => s + u.generalThousandths, 0);
    const byThousandths = BUILDING.units.map(
      (u) => (total * u.generalThousandths) / sum
    );
    const equal = BUILDING.units.map(() => total / BUILDING.units.length);
    expect(byThousandths).toEqual([80, 60, 40, 20]);
    expect(equal).toEqual([50, 50, 50, 50]);
    // The bell used to pick `equal` for this bill. The 400‰ owner was under-billed
    // €30 and the 100‰ owner over-billed €30, every month.
    const delta = byThousandths.map((v, i) => v - equal[i]);
    expect(delta).toEqual([30, 10, -10, -30]);
    // And the helper picks the correct one.
    expect(
      buildExpensePrefill({
        building: BUILDING,
        provider: 'deh',
        billingId: 'x',
        sharedMatch: { provider: 'deh' }
      }).allocationMethod
    ).toBe('general_thousandths');
  });
});

describe('sharedThousandthsMethod', () => {
  it('maps type → vector, and refuses a zero vector', () => {
    expect(sharedThousandthsMethod('electricity_common', BUILDING)).toBe(
      'general_thousandths'
    );
    expect(sharedThousandthsMethod('heating', BUILDING)).toBe(
      'heating_thousandths'
    );
    expect(sharedThousandthsMethod('heating', NO_THOUSANDTHS)).toBe('equal');
    // Defensive: a missing building must not throw on the create path.
    expect(sharedThousandthsMethod('other', undefined)).toBe('equal');
  });
});
