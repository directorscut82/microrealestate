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
  providerExpenseType,
  providerLabel,
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
    // GREEK brand name, not «EYDAP» — the screens are Greek and
    // `provider.toUpperCase()` is what put an expense called «DEH» in a live
    // building.
    expect({ name: p.name, type: p.type }).toEqual({
      name: 'ΕΥΔΑΠ',
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
      name: 'ΕΥΔΑΠ'
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
    // An apartment's own ΔΕΗ bill is a PRIVATE cost, not common-area electricity.
    // Typing it `electricity_common` is what the landlord had to correct by hand.
    expect(p.type).toBe('electricity_private');
    expect(p.name).toBe('ΔΕΗ');
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

describe('providerLabel + providerExpenseType', () => {
  it('gives the Greek brand name, case- and whitespace-tolerantly', () => {
    for (const v of ['deh', 'DEH', ' Deh ']) {
      expect(providerLabel(v)).toBe('ΔΕΗ');
    }
    expect(providerLabel('eydap')).toBe('ΕΥΔΑΠ');
    expect(providerLabel('epa')).toBe('ΕΠΑ');
    expect(providerLabel('nova')).toBe('NOVA');
  });

  it('returns empty (never «undefined») for an unknown or absent provider', () => {
    for (const v of ['', null, undefined, 'wat', 0, false]) {
      expect(providerLabel(v)).toBe('');
    }
  });

  it('maps every provider × kind to the right type — all cells', () => {
    const cells = [
      ['deh', 'private', 'electricity_private'],
      ['deh', 'shared', 'electricity_common'],
      ['eydap', 'private', 'water_private'],
      ['eydap', 'shared', 'water_common'],
      ['epa', 'private', 'gas_private'],
      ['epa', 'shared', 'heating'],
      ['nova', 'private', 'telecom_private'],
      ['nova', 'shared', 'telecom_common']
    ];
    for (const [provider, kind, expected] of cells) {
      expect({ provider, kind, type: providerExpenseType(provider, kind) }).toEqual(
        { provider, kind, type: expected }
      );
    }
  });

  it('an UNIDENTIFIED bill gets `other`, never a guessed utility type', () => {
    // Guessing electricity_common for a bill we could not place would file it as a
    // common-area cost on whatever building the landlord happens to pick.
    for (const kind of [null, undefined, 'neither', '']) {
      expect(providerExpenseType('deh', kind)).toBe('other');
    }
  });

  it('an unknown provider is `other` even when the kind is known', () => {
    expect(providerExpenseType('wat', 'private')).toBe('other');
    expect(providerExpenseType('', 'shared')).toBe('other');
  });
});

describe('the new private types keep full parity', () => {
  it('a unit-meter bill is single_unit and targets that flat, for every provider', () => {
    const expected = {
      deh: 'electricity_private',
      eydap: 'water_private',
      epa: 'gas_private',
      nova: 'telecom_private'
    };
    for (const [provider, type] of Object.entries(expected)) {
      const p = buildExpensePrefill({
        building: BUILDING,
        provider,
        billingId: 'x',
        unitMatch: { propertyId: 'u2' }
      });
      expect({ provider, type: p.type, method: p.allocationMethod }).toEqual({
        provider,
        type,
        method: 'single_unit'
      });
      expect(p.customAllocations).toEqual([{ propertyId: 'u2', value: 0 }]);
      // Parity: the owner/recurring options must keep working on the new types.
      expect(p.isRecurring).toBe(true);
      expect(p.chargeOwnerWhenVacant).toBe(true);
    }
  });

  it('a private type is NEVER given a χιλιοστά split', () => {
    // One flat's bill split by χιλιοστά charges the whole building for it.
    for (const provider of ['deh', 'eydap', 'epa', 'nova']) {
      const p = buildExpensePrefill({
        building: BUILDING,
        provider,
        billingId: 'x',
        unitMatch: { propertyId: 'u1' }
      });
      expect(p.allocationMethod).not.toMatch(/thousandths/);
    }
  });
});

describe('the prefill must not arrive pre-marked κυμαινόμενο', () => {
  it('leaves isVariable UNSET — the form decides, and only for existing rows', () => {
    // THE BUG (adversarial review, 2026-08-12): the prefill is deliberately
    // `amount: 0, isRecurring: true`, which the LEGACY inference reads as "variable".
    // The form seeded its switch from that inference for NEW rows too, so «Κυμαινόμενο
    // ποσό» came up ON; the operator then typed the bill's amount and saved
    // `isVariable: true` WITH an amount — billed to tenants by the allocation engine,
    // excluded from the owner projection, and impossible to enter on the monthly
    // statement. The prefill itself must stay silent about the flag.
    for (const args of [
      { building: BUILDING, provider: 'deh', billingId: 'x' },
      {
        building: BUILDING,
        provider: 'deh',
        billingId: 'x',
        sharedMatch: { provider: 'deh' }
      },
      {
        building: BUILDING,
        provider: 'deh',
        billingId: 'x',
        unitMatch: { propertyId: 'u1' }
      }
    ]) {
      const p = buildExpensePrefill(args);
      expect('isVariable' in p).toBe(false);
      expect(p.isVariable).toBeUndefined();
      // …and it still carries the deliberate zero amount for the operator to fill.
      expect(p.amount).toBe(0);
    }
  });
});
