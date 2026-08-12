/**
 * Shared-meter (κοινόχρηστος) validation guards.
 *
 * Every case below is a defect adversarial review found in the shared-meter
 * feature itself, and each one routes money. The two that matter most:
 *
 * · DEDUP KEY vs MATCH KEY. The schema tells the operator to store the παροχή
 *   "as printed" (with the ΔΕΗ `-016` check suffix) while E9-imported unit values
 *   are bare 9 digits — so «999935585» and «999935585-016» are two spellings of
 *   ONE meter. A dedup key narrower than the match key saved BOTH rows;
 *   findSharedMeter then saw two hits, correctly refused as ambiguous, and the
 *   caller fell through to the per-unit lookup — which proposes `single_unit` and
 *   bills the building's whole shared supply to ONE apartment.
 *
 * · SHARED vs UNIT collision. Identical fall-through, and it is the state a
 *   landlord migrating to this feature is already in, because putting the shared
 *   παροχή on a unit was the only prior workaround.
 */
import { validateSharedMeters } from '../managers/buildingmanager.js';

// The apartment's OWN meter, stored bare exactly as the E9 import writes it.
const UNITS = [
  { name: 'Α2', atakNumber: '00999900001', electricitySupplyNumber: '999935585' },
  { name: 'Β1', atakNumber: '00999900002', electricitySupplyNumber: '999935587' }
];

const errOf = (meters, units = UNITS) => {
  try {
    validateSharedMeters(meters, units);
    return null;
  } catch (e) {
    return e;
  }
};

describe('validateSharedMeters', () => {
  it('refuses two SPELLINGS of the same meter (bare vs check-suffixed)', () => {
    const e = errOf([
      { provider: 'deh', supplyNumber: '999935588' },
      { provider: 'deh', supplyNumber: '999935588-016' }
    ]);
    expect(e?.statusCode).toBe(422);
    expect(e.message).toMatch(/already listed/i);
  });

  it("refuses a shared meter that is an APARTMENT's own meter", () => {
    // Both conventions must be refused, or the collision walks back in via the
    // other spelling.
    for (const v of ['999935585', '999935585-016', '999 935 585']) {
      const e = errOf([{ provider: 'deh', supplyNumber: v }]);
      expect({ v, status: e?.statusCode }).toEqual({ v, status: 422 });
      expect(e.message).toMatch(/Α2/);
    }
  });

  it('refuses a value with no usable digits', () => {
    for (const bad of ['------', '......', '- - - - - -', '1 2 3 4 5 6']) {
      const e = errOf([{ provider: 'deh', supplyNumber: bad }]);
      expect({ bad, status: e?.statusCode }).toEqual({ bad, status: 422 });
      expect(e.message).toMatch(/9-12 digits/);
    }
  });

  it('refuses an unknown provider but ACCEPTS epa (gas) and nova (telecom)', () => {
    // 'nova' was the refusal case here until the telecom_* expense types landed. It is
    // now a legitimate provider — 3 of the 7 real sample bills are NOVA — so the
    // refusal case needs a genuinely unknown value instead.
    expect(
      errOf([{ provider: 'wattever', supplyNumber: '999900001' }])?.statusCode
    ).toBe(422);
    // A κοινόχρηστη telecom line (building internet, entry-phone) must be recordable,
    // or the telecom types are unreachable for the provider they were added for.
    expect(errOf([{ provider: 'nova', supplyNumber: '999900005' }])).toBeNull();
    // ΕΠΑ must be accepted: bills already accept it, so a κοινόχρηστο gas supply
    // needs somewhere to live.
    expect(errOf([{ provider: 'epa', supplyNumber: '999900002' }])).toBeNull();
  });

  it('refuses a non-array payload', () => {
    expect(errOf('nope')?.statusCode).toBe(422);
  });

  it('accepts genuine meters, drops blank rows, trims and defaults', () => {
    const out = validateSharedMeters(
      [
        { provider: 'deh', supplyNumber: ' 999900003 ', label: ' Κλιμακοστάσιο ' },
        { supplyNumber: '999900004' }, // provider omitted → deh
        { provider: 'deh', supplyNumber: '   ' } // abandoned empty row → dropped
      ],
      UNITS
    );
    expect(out).toEqual([
      {
        provider: 'deh',
        supplyNumber: '999900003',
        label: 'Κλιμακοστάσιο'
      },
      { provider: 'deh', supplyNumber: '999900004', label: '' }
    ]);
  });

  it('validates the CREATE path against the units in the same request', () => {
    // add() previously neither validated nor persisted sharedMeters — a POST
    // carrying them dropped them silently. It now runs THIS validator against
    // req.body.units, so a create cannot smuggle in a meter that collides with an
    // apartment it is creating in the same payload.
    const e = errOf(
      [{ provider: 'deh', supplyNumber: '999935585-016' }],
      // Same shape add() passes: the units from the request body.
      [{ name: 'Α2', electricitySupplyNumber: '999935585' }]
    );
    expect(e?.statusCode).toBe(422);
    expect(e.message).toMatch(/Α2/);
  });

  it('allows the SAME number on two DIFFERENT buildings (no cross-building block)', () => {
    // Units passed empty = a different building. The realm-wide ambiguity refusal
    // lives in findSharedMeter; this validator is per-building by design.
    expect(errOf([{ provider: 'deh', supplyNumber: '999935585' }], [])).toBeNull();
  });
});
