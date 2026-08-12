/**
 * The BROWSER-side pure logic of the bill-import surface, driven as a CROSS-PRODUCT.
 *
 * The three helpers under test are the only place where a bill becomes money: the
 * prefill decides HOW an amount will be split (χιλιοστά vs equal vs one flat), the
 * labels decide WHICH building the operator picks it onto, and the κυμαινόμενο
 * predicate decides whether the amount is billed to tenants at all. The existing
 * suites (billExpensePrefill.test.js, entityLabels.test.js, variableExpense.test.js)
 * pin the happy paths one cell at a time. This one enumerates every provider × every
 * match kind × every building shape and re-derives the answer from an INDEPENDENT
 * model, so a single-branch edit anywhere in the three-way cannot pass by only
 * breaking the cells nobody wrote down.
 *
 * Provider values come from the server's own allowed sets — `deh|eydap|epa|other`
 * (billmanager `VALID_PROVIDERS`, buildingmanager `ALLOWED_PROVIDERS`) plus `nova`,
 * which the browser maps but the server does not yet validate. Casing and blanks are
 * included because `sharedMatch.provider` is a free `String` in the InboxItem schema
 * and `detectedProvider` can be absent on a failed parse.
 */
import {
  billTargetLabel,
  buildingLabel,
  buildingOptionLabels,
  unitLabel
} from '../utils/entityLabels';
import {
  buildExpensePrefill,
  providerExpenseType,
  providerLabel,
  sharedThousandthsMethod
} from '../utils/billExpensePrefill';
import {
  isRecurringExpense,
  isVariableExpense
} from '../utils/variableExpense';

// ---------------------------------------------------------------------------
// An INDEPENDENT model of the prefill. Deliberately a second statement of the
// rule rather than a call into the helper: the whole value of a cross-product is
// that both statements have to agree, so flipping a branch in the helper shows up
// as a diff instead of as a matching wrong answer on both sides.
// ---------------------------------------------------------------------------
const TYPE_SHARED = {
  deh: 'electricity_common',
  eydap: 'water_common',
  epa: 'heating',
  nova: 'telecom_common'
};
const TYPE_PRIVATE = {
  deh: 'electricity_private',
  eydap: 'water_private',
  epa: 'gas_private',
  nova: 'telecom_private'
};
const GREEK_BRAND = { deh: 'ΔΕΗ', eydap: 'ΕΥΔΑΠ', epa: 'ΕΠΑ', nova: 'NOVA' };

function modelPrefill({
  building,
  provider,
  billingId,
  sharedMatch,
  unitMatch
}) {
  const effective = (sharedMatch && sharedMatch.provider) || provider || '';
  const key = String(effective).trim().toLowerCase();
  const kind = sharedMatch ? 'shared' : unitMatch ? 'private' : null;
  const type =
    kind === 'shared'
      ? TYPE_SHARED[key] || 'other'
      : kind === 'private'
        ? TYPE_PRIVATE[key] || 'other'
        : 'other';

  let allocationMethod;
  if (kind === 'shared') {
    const field =
      type === 'heating' ? 'heatingThousandths' : 'generalThousandths';
    const units = building && building.units;
    const total = (Array.isArray(units) ? units : []).reduce(
      (sum, u) => sum + (Number(u && u[field]) || 0),
      0
    );
    allocationMethod =
      total > 0
        ? type === 'heating'
          ? 'heating_thousandths'
          : 'general_thousandths'
        : 'equal';
  } else if (kind === 'private') {
    allocationMethod = 'single_unit';
  } else {
    allocationMethod = 'equal';
  }

  return {
    name:
      (sharedMatch && sharedMatch.label) ||
      GREEK_BRAND[key] ||
      (effective ? String(effective).toUpperCase() : ''),
    type,
    amount: 0,
    allocationMethod,
    customAllocations:
      unitMatch && !sharedMatch
        ? [{ propertyId: unitMatch.propertyId, value: 0 }]
        : [],
    isRecurring: true,
    chargeOwnerWhenVacant: true,
    billingId: billingId || ''
  };
}

const PROVIDERS = [
  ['deh', 'deh'],
  ['eydap', 'eydap'],
  ['epa', 'epa'],
  ['nova', 'nova'],
  ['other', 'other'], // a REAL stored value: ALLOWED_PROVIDERS includes it
  ['DEH-upper', 'DEH'],
  ['Deh-mixed', 'Deh'],
  ['deh-padded', ' deh '],
  ['empty', ''],
  ['null', null],
  ['undefined', undefined],
  ['unknown-word', 'unknown'],
  ['zero', 0],
  ['false', false]
];

// Building shapes. The two single-vector ones exist so that a swap of
// heatingThousandths ↔ generalThousandths cannot pass: on ΕΠΑ each shape gives a
// DIFFERENT answer depending on which field is read.
const BUILDINGS = [
  [
    'four-units-both-vectors',
    {
      _id: 'b1',
      units: [
        { _id: 'u1', generalThousandths: 400, heatingThousandths: 500 },
        { _id: 'u2', generalThousandths: 300, heatingThousandths: 300 },
        { _id: 'u3', generalThousandths: 200, heatingThousandths: 200 },
        { _id: 'u4', generalThousandths: 100, heatingThousandths: 0 }
      ]
    }
  ],
  // E9-imported: χιλιοστά are optional, so Σ === 0 and a thousandths split would
  // write a 0 share for every unit — the amount lands on no surface at all.
  ['all-zero-implicit', { _id: 'b2', units: [{ _id: 'v1' }, { _id: 'v2' }] }],
  [
    'all-zero-explicit',
    {
      _id: 'b3',
      units: [
        { generalThousandths: 0, heatingThousandths: 0 },
        { generalThousandths: 0, heatingThousandths: 0 }
      ]
    }
  ],
  [
    'general-only',
    { _id: 'b4', units: [{ generalThousandths: 1000, heatingThousandths: 0 }] }
  ],
  [
    'heating-only',
    { _id: 'b5', units: [{ generalThousandths: 0, heatingThousandths: 1000 }] }
  ],
  ['no-units', { _id: 'b6', units: [] }],
  ['units-undefined', { _id: 'b7' }],
  [
    'a-null-unit',
    {
      _id: 'b8',
      units: [
        null,
        { generalThousandths: 500, heatingThousandths: 500 },
        undefined
      ]
    }
  ],
  // Mongo/JSON round-trips have handed the UI numeric strings before.
  [
    'string-thousandths',
    {
      _id: 'b9',
      units: [
        { generalThousandths: '400', heatingThousandths: '400' },
        { generalThousandths: '600', heatingThousandths: '600' }
      ]
    }
  ],
  // Σ === 0 by cancellation. A thousandths split here divides by zero-ish and a
  // NEGATIVE share would credit a unit for a bill it owes.
  [
    'negatives-cancel',
    {
      _id: 'b10',
      units: [
        { generalThousandths: 500, heatingThousandths: 500 },
        { generalThousandths: -500, heatingThousandths: -500 }
      ]
    }
  ],
  ['building-null', null],
  ['building-undefined', undefined]
];

// `units` as a non-array is kept OUT of the table above: on a shared match the
// helper calls `.reduce` on it and throws. Pinned separately so the cross-product
// stays a value comparison.
const UNITS_NOT_ARRAY = {
  _id: 'bX',
  units: { u1: { generalThousandths: 500 } }
};

const KINDS = ['sharedOnly', 'unitOnly', 'both', 'neither'];

function argsFor(kindName, providerValue, building) {
  const shared = { provider: providerValue };
  const unit = { propertyId: 'u3' };
  return {
    building,
    provider: providerValue,
    billingId: '999900001',
    sharedMatch:
      kindName === 'sharedOnly' || kindName === 'both' ? shared : undefined,
    unitMatch: kindName === 'unitOnly' || kindName === 'both' ? unit : undefined
  };
}

/** Every field the create-expense form reads, plus the flag that must be absent. */
function snapshot(p) {
  return {
    name: p.name,
    type: p.type,
    amount: p.amount,
    allocationMethod: p.allocationMethod,
    customAllocations: p.customAllocations,
    isRecurring: p.isRecurring,
    chargeOwnerWhenVacant: p.chargeOwnerWhenVacant,
    billingId: p.billingId,
    hasIsVariableKey: 'isVariable' in p
  };
}

describe('buildExpensePrefill — full provider × kind × building cross-product', () => {
  for (const [providerName, providerValue] of PROVIDERS) {
    for (const kindName of KINDS) {
      it(`${providerName} / ${kindName} agrees with the model on every building shape`, () => {
        let cells = 0;
        for (const [buildingName, building] of BUILDINGS) {
          const cell = `${providerName}/${kindName}/${buildingName}`;
          const args = argsFor(kindName, providerValue, building);
          const actual = snapshot(buildExpensePrefill(args));
          const expected = {
            ...modelPrefill(args),
            hasIsVariableKey: false
          };
          expect({ cell, ...actual }).toEqual({ cell, ...expected });
          cells += 1;
        }
        // Guards against a silently empty loop — a test that asserts nothing is
        // decoration, and this file's whole claim is the cell count.
        expect(cells).toBe(BUILDINGS.length);
      });
    }
  }
});

describe('the invariants that must hold in EVERY cell', () => {
  const allCells = [];
  for (const [providerName, providerValue] of PROVIDERS) {
    for (const kindName of KINDS) {
      for (const [buildingName, building] of BUILDINGS) {
        allCells.push({
          cell: `${providerName}/${kindName}/${buildingName}`,
          kindName,
          building,
          args: argsFor(kindName, providerValue, building)
        });
      }
    }
  }

  it('enumerates the whole cross-product', () => {
    expect(allCells.length).toBe(
      PROVIDERS.length * KINDS.length * BUILDINGS.length
    );
  });

  it('a κοινόχρηστος hit NEVER yields single_unit or a targeted allocation', () => {
    // `single_unit` on a shared meter bills the building's entire supply to one
    // apartment (1_base.ts allocates 100% of the amount to the customAllocation),
    // and every other unit pays zero.
    let checked = 0;
    for (const { cell, kindName, args } of allCells) {
      if (kindName !== 'sharedOnly' && kindName !== 'both') continue;
      const p = buildExpensePrefill(args);
      expect({
        cell,
        isSingleUnit: p.allocationMethod === 'single_unit',
        targeted: p.customAllocations.length
      }).toEqual({ cell, isSingleUnit: false, targeted: 0 });
      checked += 1;
    }
    // Both shared kinds, every provider, every building shape: a filter that
    // stopped matching would make the invariant hold over nothing at all.
    expect(checked).toBe(PROVIDERS.length * 2 * BUILDINGS.length);
  });

  it('a *_private type is NEVER paired with a *_thousandths split', () => {
    // The mirror error: one flat's own meter split across the building charges
    // every other owner for a bill they did not incur.
    let privateSeen = 0;
    for (const { cell, args } of allCells) {
      const p = buildExpensePrefill(args);
      const isPrivate = /_private$/.test(p.type);
      if (isPrivate) privateSeen += 1;
      expect({
        cell,
        privateWithThousandths:
          isPrivate && /thousandths/.test(p.allocationMethod)
      }).toEqual({ cell, privateWithThousandths: false });
    }
    // MEASURED: emptying PROVIDER_TYPE_PRIVATE makes the pairing above hold
    // VACUOUSLY — no `_private` type exists to pair wrongly, and «every apartment
    // bill is now typed `other`» reads as a pass. The private types must be
    // PRESENT as well as correctly split: 7 of the 14 provider spellings fold to a
    // mapped code, and only the unit-meter kind yields the private type (on `both`
    // the κοινόχρηστος meter wins).
    expect(privateSeen).toBe(7 * BUILDINGS.length);
  });

  it('a shared hit on a zero-χιλιοστά building degrades to equal, never to thousandths', () => {
    // Σ‰ === 0 → a 0 share per unit → no monthlyCharge row → the amount is on NO
    // surface. Invisible money reads as correct everywhere (MONEY_SURFACE_MATRIX).
    // `_assertThousandthsAvailable` cannot catch it: it is gated on amount > 0 and
    // this prefill deliberately sends 0.
    const zeroVector = [
      'all-zero-implicit',
      'all-zero-explicit',
      'no-units',
      'units-undefined',
      'negatives-cancel',
      'building-null',
      'building-undefined'
    ];
    let checked = 0;
    for (const { cell, kindName, args } of allCells) {
      if (kindName !== 'sharedOnly' && kindName !== 'both') continue;
      if (!zeroVector.some((n) => cell.endsWith(`/${n}`))) continue;
      expect({
        cell,
        method: buildExpensePrefill(args).allocationMethod
      }).toEqual({
        cell,
        method: 'equal'
      });
      checked += 1;
    }
    expect(checked).toBe(PROVIDERS.length * 2 * zeroVector.length);
  });

  it('amount is exactly 0 everywhere — a salvaged total is never pre-committed', () => {
    // On a failed parse the total may include a prior balance (§17.5.2). Pre-filling
    // it would have the operator confirm a figure that is not this month's bill.
    for (const { cell, args } of allCells) {
      const p = buildExpensePrefill(args);
      expect({
        cell,
        amount: p.amount,
        isZero: Object.is(p.amount, 0)
      }).toEqual({
        cell,
        amount: 0,
        isZero: true
      });
    }
  });

  it('no output string ever contains «undefined» or «null»', () => {
    for (const { cell, args } of allCells) {
      const p = buildExpensePrefill(args);
      const strings = [p.name, p.type, p.allocationMethod, p.billingId];
      expect({
        cell,
        leaked: strings.filter((s) => /undefined|null/.test(String(s)))
      }).toEqual({ cell, leaked: [] });
    }
  });

  it('never arrives pre-marked κυμαινόμενο, in any cell', () => {
    // The prefill is `amount: 0, isRecurring: true`, which the LEGACY inference
    // reads as "variable". If the flag were present here the operator would type
    // the bill's amount and save `isVariable: true` WITH an amount — billed to
    // tenants, excluded from the owner projection, unenterable on the statement.
    for (const { cell, args } of allCells) {
      const p = buildExpensePrefill(args);
      expect({ cell, present: 'isVariable' in p, value: p.isVariable }).toEqual(
        {
          cell,
          present: false,
          value: undefined
        }
      );
    }
  });

  it('type and allocationMethod are always values the form can render', () => {
    const TYPES = new Set([
      'other',
      ...Object.values(TYPE_SHARED),
      ...Object.values(TYPE_PRIVATE)
    ]);
    const METHODS = new Set([
      'equal',
      'single_unit',
      'general_thousandths',
      'heating_thousandths'
    ]);
    for (const { cell, args } of allCells) {
      const p = buildExpensePrefill(args);
      expect({
        cell,
        knownType: TYPES.has(p.type),
        knownMethod: METHODS.has(p.allocationMethod)
      }).toEqual({ cell, knownType: true, knownMethod: true });
    }
  });
});

describe('the χιλιοστά vector is chosen by the SHARED type string itself', () => {
  const HEATING_ONLY = BUILDINGS.find(([n]) => n === 'heating-only')[1];
  const GENERAL_ONLY = BUILDINGS.find(([n]) => n === 'general-only')[1];

  it("ΕΠΑ's shared type is exactly the string sharedThousandthsMethod treats as heating", () => {
    // The coupling is by string equality across two functions. Rename the shared
    // ΕΠΑ type to `gas_common` and only this assertion notices: gas would then read
    // the GENERAL vector and bill unheated units for heating, a combination the
    // expense picker does not even offer (ALLOCATION_METHODS_BY_TYPE.heating).
    const epaShared = providerExpenseType('epa', 'shared');
    expect(epaShared).toBe('heating');
    expect(sharedThousandthsMethod(epaShared, HEATING_ONLY)).toBe(
      'heating_thousandths'
    );
    // …and a building with only GENERAL χιλιοστά has no heating vector, so gas
    // degrades rather than borrowing the wrong one.
    expect(sharedThousandthsMethod(epaShared, GENERAL_ONLY)).toBe('equal');
  });

  it('every non-heating shared type reads the GENERAL vector', () => {
    for (const provider of ['deh', 'eydap', 'nova', 'other', 'unknown']) {
      const type = providerExpenseType(provider, 'shared');
      expect({
        provider,
        onGeneralOnly: sharedThousandthsMethod(type, GENERAL_ONLY),
        onHeatingOnly: sharedThousandthsMethod(type, HEATING_ONLY)
      }).toEqual({
        provider,
        onGeneralOnly: 'general_thousandths',
        onHeatingOnly: 'equal'
      });
    }
  });

  it('reads the vector the type names even when the two disagree per unit', () => {
    // 400/300/200/100 general vs 500/300/200/0 heating: u4 pays a fifth of the
    // stairwell electricity and nothing for heating. Reading the wrong field is a
    // per-unit money error that never sums wrong at the building level, so no total
    // check can catch it.
    const B = BUILDINGS[0][1];
    expect(sharedThousandthsMethod('electricity_common', B)).toBe(
      'general_thousandths'
    );
    expect(sharedThousandthsMethod('heating', B)).toBe('heating_thousandths');
  });

  it('a negative or NaN vector is refused, not divided by', () => {
    // A negative Σ‰ would hand a unit a CREDIT for a bill the building owes.
    expect(
      sharedThousandthsMethod('electricity_common', {
        units: [{ generalThousandths: -100 }, { generalThousandths: -200 }]
      })
    ).toBe('equal');
    expect(
      sharedThousandthsMethod('electricity_common', {
        units: [{ generalThousandths: 'χιλιοστά' }, { generalThousandths: NaN }]
      })
    ).toBe('equal');
    // One real vector among junk still splits by χιλιοστά — the junk contributes 0.
    expect(
      sharedThousandthsMethod('electricity_common', {
        units: [{ generalThousandths: 'abc' }, { generalThousandths: 1000 }]
      })
    ).toBe('general_thousandths');
  });

  it('survives a missing building on the create path', () => {
    for (const b of [null, undefined, {}, { units: null }, { units: [] }]) {
      expect(sharedThousandthsMethod('electricity_common', b)).toBe('equal');
    }
  });

  // CURRENT BEHAVIOUR, documented: a non-array `units` throws instead of degrading.
  // Not reachable from the two live callers (both pass an API building, where
  // `units` is an array or absent), so this is pinned rather than fixed — but the
  // asymmetry matters: the SAME malformed building is harmless on the unit and
  // fallback branches and fatal on the shared one, i.e. the crash depends on the
  // bill, not on the building the operator picked.
  it('THROWS on a non-array units, and only on the shared branch', () => {
    expect(() =>
      buildExpensePrefill({
        building: UNITS_NOT_ARRAY,
        provider: 'deh',
        billingId: '999900001',
        sharedMatch: { provider: 'deh' }
      })
    ).toThrow(TypeError);
    // `amount` is 0 in every cell, so asserting it here would prove only that the
    // call returned — the branch has to be shown producing its own split.
    for (const [extra, method] of [
      [{ unitMatch: { propertyId: 'u3' } }, 'single_unit'],
      [{}, 'equal'] // neither
    ]) {
      const p = buildExpensePrefill({
        building: UNITS_NOT_ARRAY,
        provider: 'deh',
        billingId: '999900001',
        ...extra
      });
      expect({ method: p.allocationMethod, amount: p.amount }).toEqual({
        method,
        amount: 0
      });
    }
  });
});

describe('buildExpensePrefill — hostile sharedMatch and unitMatch shapes', () => {
  const B = BUILDINGS[0][1];

  it('an empty sharedMatch object still counts as a κοινόχρηστος hit', () => {
    // `{}` is truthy, so the bill is shared and the PARSED provider is what remains.
    // If this ever became falsy, a κοινόχρηστο bill with no stored provider would
    // fall to the unit/equal branch and could be billed to one flat.
    const p = buildExpensePrefill({
      building: B,
      provider: 'deh',
      billingId: '999900001',
      sharedMatch: {}
    });
    expect({ type: p.type, method: p.allocationMethod, name: p.name }).toEqual({
      type: 'electricity_common',
      method: 'general_thousandths',
      name: 'ΔΕΗ'
    });
  });

  it('falsy labels fall through to the Greek brand name', () => {
    for (const label of ['', null, undefined, 0, false, NaN]) {
      const p = buildExpensePrefill({
        building: B,
        provider: 'deh',
        billingId: 'x',
        sharedMatch: { provider: 'deh', label }
      });
      expect({ label: String(label), name: p.name }).toEqual({
        label: String(label),
        name: 'ΔΕΗ'
      });
    }
  });

  it('a whitespace-only meter label is kept verbatim (documented, untrimmed)', () => {
    // The stored label wins over the brand name by design; a blank-but-truthy label
    // therefore names the expense with spaces. Pinned so a future trim is a
    // deliberate change and not a surprise.
    const p = buildExpensePrefill({
      building: B,
      provider: 'deh',
      billingId: 'x',
      sharedMatch: { provider: 'deh', label: '   ' }
    });
    expect(p.name).toBe('   ');
  });

  it("the stored meter's provider beats the parse in every direction", () => {
    const cells = [
      ['eydap', 'deh', 'electricity_common', 'ΔΕΗ'], // parse said ΕΥΔΑΠ, meter says ΔΕΗ
      ['deh', 'eydap', 'water_common', 'ΕΥΔΑΠ'],
      ['deh', '', 'electricity_common', 'ΔΕΗ'], // meter blank → parse survives
      ['', 'epa', 'heating', 'ΕΠΑ'], // parse failed → meter survives
      ['', '', 'other', ''] // neither knows: `other`, and no invented name
    ];
    for (const [parsed, stored, type, name] of cells) {
      const p = buildExpensePrefill({
        building: B,
        provider: parsed,
        billingId: 'x',
        sharedMatch: { provider: stored }
      });
      expect({ parsed, stored, type: p.type, name: p.name }).toEqual({
        parsed,
        stored,
        type,
        name
      });
    }
  });

  it('a unitMatch with no propertyId still emits single_unit targeting nothing', () => {
    // CURRENT BEHAVIOUR. Both callers guard this (`rawSuggestion?.unitPropertyId &&
    // …`), and the amount is 0, so nothing is mis-billed — but the form would open
    // `single_unit` with no apartment selected.
    const p = buildExpensePrefill({
      building: B,
      provider: 'deh',
      billingId: 'x',
      unitMatch: {}
    });
    expect(p.allocationMethod).toBe('single_unit');
    expect(p.customAllocations).toEqual([{ propertyId: undefined, value: 0 }]);
  });

  it('carries the propertyId through verbatim, without stringifying it', () => {
    // The server matches customAllocations by propertyId; a coerced ObjectId would
    // miss the unit and the whole bill would allocate to nobody.
    const oid = { toString: () => '00000000000000000000dead' };
    const p = buildExpensePrefill({
      building: B,
      provider: 'deh',
      billingId: 'x',
      unitMatch: { propertyId: oid }
    });
    expect(p.customAllocations[0].propertyId).toBe(oid);
    expect(p.customAllocations[0].value).toBe(0);
  });

  it('billingId: falsy in → empty out, never «undefined»', () => {
    for (const billingId of [undefined, null, 0, false, '', NaN]) {
      const p = buildExpensePrefill({
        building: B,
        provider: 'deh',
        billingId,
        sharedMatch: { provider: 'deh' }
      });
      expect({ input: String(billingId), billingId: p.billingId }).toEqual({
        input: String(billingId),
        billingId: ''
      });
    }
    // A real αριθμός παροχής survives untouched — the dialog re-finds the created
    // expense by comparing this value to the bill's.
    expect(
      buildExpensePrefill({
        building: B,
        provider: 'deh',
        billingId: '999 935-585',
        sharedMatch: { provider: 'deh' }
      }).billingId
    ).toBe('999 935-585');
  });

  it('exposes exactly the expected key set — nothing extra reaches the form', () => {
    // ExpenseFormDialog treats an `_id` as EDIT mode. A stray one here would have
    // the operator overwrite an existing expense instead of creating one.
    const keys = Object.keys(
      buildExpensePrefill({
        building: B,
        provider: 'deh',
        billingId: 'x',
        sharedMatch: { provider: 'deh' },
        unitMatch: { propertyId: 'u1' }
      })
    ).sort();
    expect(keys).toEqual(
      [
        'allocationMethod',
        'amount',
        'billingId',
        'chargeOwnerWhenVacant',
        'customAllocations',
        'isRecurring',
        'name',
        'type'
      ].sort()
    );
  });

  it('a fresh customAllocations array per call — no shared mutable state', () => {
    // Two bills open the same dialog in one session; a shared array would let the
    // first bill's target follow the second.
    const a = buildExpensePrefill({
      building: B,
      provider: 'deh',
      billingId: 'x',
      unitMatch: { propertyId: 'u1' }
    });
    const b = buildExpensePrefill({
      building: B,
      provider: 'deh',
      billingId: 'y',
      unitMatch: { propertyId: 'u2' }
    });
    a.customAllocations.push({ propertyId: 'u9', value: 999 });
    expect(b.customAllocations).toEqual([{ propertyId: 'u2', value: 0 }]);
  });
});

describe('providerLabel / providerExpenseType — hostile inputs', () => {
  it('a Greek-spelled provider code is NAMED but not TYPED', () => {
    // CURRENT BEHAVIOUR, documented. The maps are keyed on the latin codes the
    // parser emits, so «ΔΕΗ» arrives unmapped: the raw-uppercase fallback makes the
    // NAME look right while the type silently degrades to `other`. If a Greek code
    // ever reaches the prefill, the expense is filed against the wrong category
    // while reading perfectly on screen.
    expect(providerLabel('ΔΕΗ')).toBe('');
    expect(providerExpenseType('ΔΕΗ', 'shared')).toBe('other');
    const p = buildExpensePrefill({
      building: BUILDINGS[0][1],
      provider: 'ΔΕΗ',
      billingId: 'x',
      sharedMatch: { provider: 'ΔΕΗ' }
    });
    expect({ name: p.name, type: p.type }).toEqual({
      name: 'ΔΕΗ',
      type: 'other'
    });
  });

  it('«other» — a valid stored provider — yields a Latin «OTHER» expense name', () => {
    // CURRENT BEHAVIOUR, documented. `other` is in the server's ALLOWED_PROVIDERS,
    // and the poller sends `sharedLabel: label || ''`, so a κοινόχρηστος meter saved
    // as «other» with no label names the expense «OTHER» in a Greek-only UI — the
    // same shape as the «DEH» expense the brand map was added to fix.
    expect(providerLabel('other')).toBe('');
    const p = buildExpensePrefill({
      building: BUILDINGS[0][1],
      provider: 'other',
      billingId: 'x',
      sharedMatch: { provider: 'other', label: '' }
    });
    expect({ name: p.name, type: p.type }).toEqual({
      name: 'OTHER',
      type: 'other'
    });
  });

  it('normalises case and padding identically in both functions', () => {
    for (const v of ['DEH', ' deh', 'deh ', '\tDeh\n', 'dEh']) {
      expect({
        input: JSON.stringify(v),
        label: providerLabel(v),
        shared: providerExpenseType(v, 'shared'),
        private: providerExpenseType(v, 'private')
      }).toEqual({
        input: JSON.stringify(v),
        label: 'ΔΕΗ',
        shared: 'electricity_common',
        private: 'electricity_private'
      });
    }
  });

  it('an unrecognised KIND is `other` for every provider — never a guess', () => {
    // Guessing `electricity_common` for a bill that matched nothing would file it as
    // a common-area cost on whatever building the operator happens to select.
    for (const provider of ['deh', 'eydap', 'epa', 'nova']) {
      for (const kind of [
        null,
        undefined,
        '',
        'Shared',
        'SHARED',
        'Private',
        'shared ',
        0,
        false,
        true,
        {}
      ]) {
        expect({
          provider,
          kind: String(kind),
          type: providerExpenseType(provider, kind)
        }).toEqual({ provider, kind: String(kind), type: 'other' });
      }
    }
  });

  it('never returns a label containing «undefined» or «null»', () => {
    for (const v of [undefined, null, '', 0, false, NaN, [], {}, 'wat']) {
      const out = providerLabel(v);
      expect({
        input: String(v),
        out,
        clean: !/undefined|null/.test(out)
      }).toEqual({
        input: String(v),
        out: '',
        clean: true
      });
    }
  });
});

// ---------------------------------------------------------------------------
// entityLabels — the «X — X» class of defect, driven over colliding lists.
// ---------------------------------------------------------------------------

/** The test's own fold, so a change to the module's private one shows up here. */
function fold(v) {
  return (
    String(v ?? '')
      .trim()
      .toLocaleUpperCase('el-GR')
      .normalize('NFD')
      // Explicit escapes: literal combining marks are invisible in an editor.
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
  );
}

/**
 * True when a qualified label just repeats itself — «ΟΔΟΣ ΑΛΦΑ 1 — ΟΔΟΣ ΑΛΦΑ 1» or
 * «009991 (009991)». Compared FOLDED, because an accent- or spacing-only difference
 * between the two halves is still a doubled label to the reader; a literal
 * /^(.+) — \1$/ would pass «ΟΔΟΣ ΑΛΦΑ 1 — Οδός Άλφα 1».
 */
function isDoubled(label) {
  const dash = String(label).split(' — ');
  if (dash.length === 2 && fold(dash[0]) === fold(dash[1])) return true;
  const paren = /^(.*) \((.*)\)$/.exec(String(label));
  return !!(paren && fold(paren[1]) === fold(paren[2]));
}

const DOUBLED_LITERAL = /^(.+) — \1$/;

describe('isDoubled (the test’s own detector) actually detects', () => {
  it('flags the reported shape and the accent-variant of it', () => {
    expect(isDoubled('ΟΔΟΣ ΑΛΦΑ 1 — ΟΔΟΣ ΑΛΦΑ 1')).toBe(true);
    expect(isDoubled('ΟΔΟΣ ΑΛΦΑ 1 — Οδός Άλφα 1')).toBe(true);
    expect(isDoubled('ΟΔΟΣ ΑΛΦΑ 1 — ΟΔΟΣ  ΑΛΦΑ  1')).toBe(true);
    expect(isDoubled('009991 (009991)')).toBe(true);
    expect(isDoubled('ΟΔΟΣ ΑΛΦΑ 1 — ΟΔΟΣ ΒΗΤΑ 9')).toBe(false);
    expect(isDoubled('ΟΔΟΣ ΑΛΦΑ 1 (009991)')).toBe(false);
    expect(isDoubled('ΟΔΟΣ ΑΛΦΑ 1')).toBe(false);
  });
});

describe('buildingOptionLabels — collisions of every kind', () => {
  it('a name-only collision is separated by street, and neighbours stay plain', () => {
    const list = [
      {
        _id: '1',
        name: 'Πολυκατοικία',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
        atakPrefix: '009991'
      },
      {
        _id: '2',
        name: 'Πολυκατοικία',
        address: { street1: 'ΟΔΟΣ ΒΗΤΑ 9' },
        atakPrefix: '009992'
      },
      {
        _id: '3',
        name: 'Πολυκατοικία',
        address: { street1: 'ΟΔΟΣ ΓΑΜΑ 12' },
        atakPrefix: '009993'
      },
      {
        _id: '4',
        name: 'ΟΔΟΣ ΑΛΦΑ 7',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 7' },
        atakPrefix: '009994'
      }
    ];
    const m = buildingOptionLabels(list);
    expect(m.get('1')).toBe('Πολυκατοικία — ΟΔΟΣ ΑΛΦΑ 1');
    expect(m.get('2')).toBe('Πολυκατοικία — ΟΔΟΣ ΒΗΤΑ 9');
    expect(m.get('3')).toBe('Πολυκατοικία — ΟΔΟΣ ΓΑΜΑ 12');
    // The building nobody collides with must NOT be decorated — that decoration
    // applied unconditionally is the reported «ΟΔΟΣ ΑΛΦΑ 1 — ΟΔΟΣ ΑΛΦΑ 1» bug.
    expect(m.get('4')).toBe('ΟΔΟΣ ΑΛΦΑ 7');
    const labels = [...m.values()];
    expect(new Set(labels).size).toBe(4);
    for (const l of labels) expect(isDoubled(l)).toBe(false);
  });

  it('a street that merely REPEATS the name never becomes a qualifier', () => {
    // Every spelling of "the street is the name": exact, accented, extra spacing,
    // and street-contains-name. All four must fall through to the ΑΤΑΚ instead of
    // producing «X — X».
    const list = [
      {
        _id: '1',
        name: 'ΟΔΟΣ ΑΛΦΑ 1',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
        atakPrefix: '009991'
      },
      {
        _id: '2',
        name: 'ΟΔΟΣ ΑΛΦΑ 1',
        address: { street1: 'Οδός Άλφα 1' },
        atakPrefix: '009992'
      },
      {
        _id: '3',
        name: 'ΟΔΟΣ ΑΛΦΑ 1',
        address: { street1: 'ΟΔΟΣ  ΑΛΦΑ  1' },
        atakPrefix: '009993'
      },
      {
        _id: '4',
        name: 'ΟΔΟΣ ΑΛΦΑ 1',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1, ΑΘΗΝΑ' },
        atakPrefix: '009994'
      }
    ];
    const m = buildingOptionLabels(list);
    expect([...m.values()]).toEqual([
      'ΟΔΟΣ ΑΛΦΑ 1 (009991)',
      'ΟΔΟΣ ΑΛΦΑ 1 (009992)',
      'ΟΔΟΣ ΑΛΦΑ 1 (009993)',
      'ΟΔΟΣ ΑΛΦΑ 1 (009994)'
    ]);
    for (const l of m.values()) {
      expect(isDoubled(l)).toBe(false);
      expect(l).not.toMatch(DOUBLED_LITERAL);
    }
  });

  it('a dialytika-only difference is the SAME name, so both options are qualified', () => {
    // MEASURED: el-GR uppercasing already drops the tonos («Οδός Άλφα» → «ΟΔΟΣ
    // ΑΛΦΑ»), so the combining-mark strip in the fold is load-bearing for exactly
    // one thing — the DIALYTIKA, which Greek typists routinely omit. Without it
    // these two are judged distinct, left unqualified, and the landlord sees two
    // options that differ by one dot pair while picking which building to charge.
    const m = buildingOptionLabels([
      { _id: '1', name: 'ΟΔΟΣ ΑΪ ΑΛΦΑ 1', atakPrefix: '009991' },
      { _id: '2', name: 'ΟΔΟΣ ΑΙ ΑΛΦΑ 1', atakPrefix: '009992' }
    ]);
    expect([...m.values()]).toEqual([
      'ΟΔΟΣ ΑΪ ΑΛΦΑ 1 (009991)',
      'ΟΔΟΣ ΑΙ ΑΛΦΑ 1 (009992)'
    ]);
  });

  it('a street spelled without the dialytika is still the name repeated', () => {
    const m = buildingOptionLabels([
      {
        _id: '1',
        name: 'ΟΔΟΣ ΑΪ ΑΛΦΑ 1',
        address: { street1: 'ΟΔΟΣ ΑΙ ΑΛΦΑ 1' },
        atakPrefix: '009991'
      },
      {
        _id: '2',
        name: 'ΟΔΟΣ ΑΪ ΑΛΦΑ 1',
        address: { street1: 'ΟΔΟΣ ΑΙ ΑΛΦΑ 1' },
        atakPrefix: '009992'
      }
    ]);
    expect([...m.values()]).toEqual([
      'ΟΔΟΣ ΑΪ ΑΛΦΑ 1 (009991)',
      'ΟΔΟΣ ΑΪ ΑΛΦΑ 1 (009992)'
    ]);
    for (const l of m.values()) expect(isDoubled(l)).toBe(false);
  });

  it('a name that CONTAINS the street is not qualified by it either', () => {
    // The landlord typed the whole address as the name while `street1` holds just
    // the street. Appending it repeats a substring the option already shows.
    const m = buildingOptionLabels([
      {
        _id: '1',
        name: 'ΟΔΟΣ ΑΛΦΑ 1, ΑΘΗΝΑ',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
        atakPrefix: '009991'
      },
      {
        _id: '2',
        name: 'ΟΔΟΣ ΑΛΦΑ 1, ΑΘΗΝΑ',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
        atakPrefix: '009992'
      }
    ]);
    expect([...m.values()]).toEqual([
      'ΟΔΟΣ ΑΛΦΑ 1, ΑΘΗΝΑ (009991)',
      'ΟΔΟΣ ΑΛΦΑ 1, ΑΘΗΝΑ (009992)'
    ]);
  });

  it('accent/case/whitespace-only variants all collide, and each keeps its own spelling', () => {
    const list = [
      { _id: '1', name: 'Οδός Άλφα 1', atakPrefix: '009991' },
      { _id: '2', name: 'ΟΔΟΣ ΑΛΦΑ 1', atakPrefix: '009992' },
      { _id: '3', name: ' οδος  αλφα 1 ', atakPrefix: '009993' },
      { _id: '4', name: 'ΟΔΟΣ ΑΛΦΆ 1', atakPrefix: '009994' }
    ];
    const m = buildingOptionLabels(list);
    // Every one is qualified: two options that differ only by accents read as
    // duplicates in a select, which is the same shipped bug from the other side.
    // The DISPLAY keeps the landlord's own spelling (double space and all) — the
    // fold is for comparison only and must never rewrite what is shown.
    expect([...m.values()]).toEqual([
      'Οδός Άλφα 1 (009991)',
      'ΟΔΟΣ ΑΛΦΑ 1 (009992)',
      'οδος  αλφα 1 (009993)',
      'ΟΔΟΣ ΑΛΦΆ 1 (009994)'
    ]);
    expect(new Set(m.values()).size).toBe(4);
  });

  it('a nameless building is identified by street, then ΑΤΑΚ, and still de-duped', () => {
    const list = [
      { _id: '1', address: { street1: 'ΟΔΟΣ ΒΗΤΑ 9' }, atakPrefix: '009991' },
      { _id: '2', address: { street1: 'ΟΔΟΣ ΒΗΤΑ 9' }, atakPrefix: '009992' },
      { _id: '3', atakPrefix: '009993' }
    ];
    const m = buildingOptionLabels(list);
    expect([...m.values()]).toEqual([
      'ΟΔΟΣ ΒΗΤΑ 9 (009991)',
      'ΟΔΟΣ ΒΗΤΑ 9 (009992)',
      '009993'
    ]);
    expect(new Set(m.values()).size).toBe(3);
  });

  it('50 buildings: every distinguishable option is distinct and undoubled', () => {
    // Realistic realm scale, with names deliberately repeating in threes so all 50
    // collide. MEASURED on this fixture: `street1` is `${name} ${i%7}`, so it
    // CONTAINS the name and is judged redundant every time — all 50 options take
    // the ΑΤΑΚ branch and none takes the street branch. That is the branch the
    // dropdown's uniqueness actually rests on at realm scale, so the assertion
    // that matters is global distinctness, not «no label was dropped».
    const streets = ['ΟΔΟΣ ΑΛΦΑ', 'ΟΔΟΣ ΒΗΤΑ', 'ΟΔΟΣ ΓΑΜΑ'];
    const list = Array.from({ length: 50 }, (_, i) => ({
      _id: `b${i}`,
      name: streets[i % 3],
      address: { street1: `${streets[i % 3]} ${i % 7}` },
      atakPrefix: `0099${String(i).padStart(4, '0')}`
    }));
    const m = buildingOptionLabels(list);
    const labels = [...m.values()];
    expect(m.size).toBe(50);
    expect(labels.length).toBe(50);
    for (const l of labels) {
      expect(isDoubled(l)).toBe(false);
      expect(l).not.toMatch(/undefined|null/);
    }
    // 50 buildings, 3 distinct names, 50 distinct labels. Dropping the `(ΑΤΑΚ)`
    // suffix would leave 17 identical «ΟΔΟΣ ΑΛΦΑ» options in the select and the
    // operator picking a κοινόχρηστο bill onto a coin-flip building — the counted
    // `m.size` cannot see that, because 50 keys still map to 3 strings.
    expect(new Set(labels).size).toBe(50);
    expect(labels.filter((l) => l.includes(' — ')).length).toBe(0);
  });

  it('50 buildings with fully distinct names are all left plain', () => {
    const list = Array.from({ length: 50 }, (_, i) => ({
      _id: `b${i}`,
      name: `ΟΔΟΣ ΑΛΦΑ ${i}`,
      address: { street1: `ΟΔΟΣ ΑΛΦΑ ${i}` },
      atakPrefix: `0099${String(i).padStart(4, '0')}`
    }));
    const labels = [...buildingOptionLabels(list).values()];
    expect(new Set(labels).size).toBe(50);
    expect(labels.every((l, i) => l === `ΟΔΟΣ ΑΛΦΑ ${i}`)).toBe(true);
  });

  // ---- documented gaps -----------------------------------------------------

  it('DOCUMENTED GAP: same name AND same street, differing ΑΤΑΚ → two IDENTICAL options', () => {
    // The qualifier is chosen by asking «does the street add anything to the NAME?»
    // instead of «does it separate the colliding SET?». When the name is not the
    // street (a landlord-typed name like «Πολυκατοικία Α»), the street is judged
    // non-redundant and is used — even though both buildings share it — so the ΑΤΑΚ
    // branch that exists precisely for this case is never reached. The operator gets
    // two options reading exactly the same and picks the bill onto a coin-flip
    // building. Reported, not fixed here.
    const list = [
      {
        _id: '1',
        name: 'Πολυκατοικία Α',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
        atakPrefix: '009991'
      },
      {
        _id: '2',
        name: 'Πολυκατοικία Α',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
        atakPrefix: '009992'
      }
    ];
    const m = buildingOptionLabels(list);
    expect(m.get('1')).toBe('Πολυκατοικία Α — ΟΔΟΣ ΑΛΦΑ 1');
    expect(m.get('2')).toBe('Πολυκατοικία Α — ΟΔΟΣ ΑΛΦΑ 1');
    // The distinguishing data WAS available and went unused.
    expect(m.get('1')).toBe(m.get('2'));
    expect(new Set(m.values()).size).toBe(1);
  });

  it('DOCUMENTED: nothing distinguishes them → identical labels, honestly', () => {
    // Same name, same street, no ΑΤΑΚ on either: there is no displayable field left,
    // so the fallback returns the bare name. Distinct from the gap above — here the
    // data really is identical.
    const list = [
      { _id: '1', name: 'ΟΔΟΣ ΑΛΦΑ 1', address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' } },
      { _id: '2', name: 'ΟΔΟΣ ΑΛΦΑ 1', address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' } }
    ];
    const m = buildingOptionLabels(list);
    expect([...m.values()]).toEqual(['ΟΔΟΣ ΑΛΦΑ 1', 'ΟΔΟΣ ΑΛΦΑ 1']);
    for (const l of m.values()) expect(isDoubled(l)).toBe(false);
  });

  it('DOCUMENTED: a nameless, streetless collision renders «ΑΤΑΚ (ΑΤΑΚ)»', () => {
    // base falls back to the ΑΤΑΚ prefix, and the ΑΤΑΚ branch appends it again
    // without the redundancy check the street branch gets. Cosmetic (the two
    // buildings genuinely share a prefix), but it is the doubled shape the module
    // exists to prevent, so it is pinned rather than left to be discovered on screen.
    const list = [
      { _id: '1', atakPrefix: '009991' },
      { _id: '2', atakPrefix: '009991' }
    ];
    const m = buildingOptionLabels(list);
    expect([...m.values()]).toEqual(['009991 (009991)', '009991 (009991)']);
    expect(isDoubled(m.get('1'))).toBe(true);
  });

  it('DOCUMENTED: a duplicate _id silently drops one option', () => {
    // The return is keyed by _id, so the second write wins and the select would
    // render the LAST building's name for both. Mongo _ids are unique, so this
    // pins the contract rather than a live defect.
    const m = buildingOptionLabels([
      { _id: 'same', name: 'ΟΔΟΣ ΑΛΦΑ 1' },
      { _id: 'same', name: 'ΟΔΟΣ ΒΗΤΑ 9' }
    ]);
    expect(m.size).toBe(1);
    expect(m.get('same')).toBe('ΟΔΟΣ ΒΗΤΑ 9');
  });

  it('keys are strings, so an ObjectId-shaped _id still matches the select value', () => {
    const oid = { toString: () => '00000000000000000000beef' };
    const m = buildingOptionLabels([{ _id: oid, name: 'ΟΔΟΣ ΑΛΦΑ 1' }]);
    expect(m.get('00000000000000000000beef')).toBe('ΟΔΟΣ ΑΛΦΑ 1');
    expect([...m.keys()].every((k) => typeof k === 'string')).toBe(true);
  });

  it('junk entries are skipped, not rendered', () => {
    const m = buildingOptionLabels([
      null,
      undefined,
      false,
      0,
      '',
      { _id: '1', name: 'ΟΔΟΣ ΑΛΦΑ 1' }
    ]);
    expect(m.size).toBe(1);
    expect(m.get('1')).toBe('ΟΔΟΣ ΑΛΦΑ 1');
  });

  it('a building with no displayable field at all yields an empty label, not «undefined»', () => {
    const m = buildingOptionLabels([{ _id: '1' }, { _id: '2', name: '   ' }]);
    // Both fold to the same empty key, so they collide and the qualifier branch
    // runs with nothing to qualify by. `typeof l === 'string'` would hold for any
    // return the function can make, so the exact value is what gets pinned.
    expect([...m.values()]).toEqual(['', '']);
  });
});

describe('buildingLabel — hostile shapes', () => {
  it('prefers name, then street, then ΑΤΑΚ, trimming each', () => {
    const cells = [
      [
        { name: '  ΟΔΟΣ ΑΛΦΑ 1  ', address: { street1: 'ΟΔΟΣ ΒΗΤΑ 9' } },
        'ΟΔΟΣ ΑΛΦΑ 1'
      ],
      [{ name: '   ', address: { street1: '  ΟΔΟΣ ΒΗΤΑ 9 ' } }, 'ΟΔΟΣ ΒΗΤΑ 9'],
      [
        { name: '', address: { street1: '' }, atakPrefix: ' 009991 ' },
        '009991'
      ],
      [{ address: null, atakPrefix: '009991' }, '009991'],
      // DOCUMENTED: `??` only guards null/undefined, so a non-string falsy name is
      // stringified and shown. `name` is a String in the Building schema, so these
      // are unreachable from the API — pinned because the module's own promise is
      // "never renders «undefined»", and that promise does not extend to `false`.
      [{ name: false, atakPrefix: '009991' }, 'false'],
      [{ name: 0, atakPrefix: '009991' }, '0']
    ];
    for (const [input, expected] of cells) {
      expect({
        input: JSON.stringify(input),
        label: buildingLabel(input)
      }).toEqual({
        input: JSON.stringify(input),
        label: expected
      });
    }
  });

  it('never leaks «undefined» or «null» for any junk building', () => {
    for (const input of [
      null,
      undefined,
      {},
      0,
      '',
      false,
      { name: null, address: { street1: null }, atakPrefix: null },
      { address: undefined, atakPrefix: undefined }
    ]) {
      const out = buildingLabel(input);
      expect({
        input: String(input),
        out,
        ok: !/undefined|null/.test(out)
      }).toEqual({
        input: String(input),
        out: '',
        ok: true
      });
    }
  });
});

describe('unitLabel — the flat that the money is billed to', () => {
  it('shows «name (ΑΤΑΚ)» but never repeats the ΑΤΑΚ', () => {
    const cells = [
      [{ name: 'Α2', atakNumber: '00999900001' }, 'Α2 (00999900001)'],
      // name IS the ΑΤΑΚ → one copy, not «00999900001 (00999900001)».
      [{ name: '00999900001', atakNumber: '00999900001' }, '00999900001'],
      // name already contains it → no second copy.
      [{ name: 'Α2 00999900001', atakNumber: '00999900001' }, 'Α2 00999900001'],
      [{ name: '  Α2  ', atakNumber: '  00999900001  ' }, 'Α2 (00999900001)'],
      [{ unitLabel: 'Β1', atakNumber: '00999900002' }, 'Β1 (00999900002)'],
      [{ name: '   ', atakNumber: '00999900003' }, '00999900003'],
      [{ atakNumber: '00999900004' }, '00999900004'],
      [{ name: 'Α2' }, 'Α2'],
      [{ name: 'Α2', atakNumber: null }, 'Α2'],
      [{}, ''],
      [{ name: null, unitLabel: null, atakNumber: null }, '']
    ];
    for (const [input, expected] of cells) {
      const out = unitLabel(input);
      expect({ input: JSON.stringify(input), out }).toEqual({
        input: JSON.stringify(input),
        out: expected
      });
      expect(isDoubled(out)).toBe(false);
      expect(out).not.toMatch(/undefined|null/);
    }
  });

  it('`name` wins over `unitLabel` when both exist', () => {
    // Two field spellings for one concept; a swap here would relabel every row on
    // the single_unit surfaces at once.
    expect(unitLabel({ name: 'Α2', unitLabel: 'Β1' })).toBe('Α2');
  });

  it('survives non-object input', () => {
    for (const junk of [null, undefined, 0, '', false, 'Α2']) {
      expect({ input: String(junk), out: unitLabel(junk) }).toEqual({
        input: String(junk),
        out: ''
      });
    }
  });
});

describe('billTargetLabel — the sentence the operator confirms', () => {
  const building = {
    name: 'ΟΔΟΣ ΑΛΦΑ 1',
    address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
    atakPrefix: '009999'
  };
  const unit = { name: 'Α2', atakNumber: '00999900001' };

  it('every truthy `shared` hides the flat — a κοινόχρηστο is never one apartment', () => {
    // The label is what the operator reads before confirming; naming a single flat
    // on a building-wide bill invites them to accept a single_unit charge.
    for (const shared of [true, 1, 'yes', 'false', {}, [], 'shared']) {
      expect({
        shared: String(shared),
        out: billTargetLabel({ building, unit, shared })
      }).toEqual({ shared: String(shared), out: 'ΟΔΟΣ ΑΛΦΑ 1' });
    }
  });

  it('every falsy `shared` shows the flat and its ΑΤΑΚ', () => {
    for (const shared of [false, 0, '', null, undefined, NaN]) {
      expect({
        shared: String(shared),
        out: billTargetLabel({ building, unit, shared })
      }).toEqual({
        shared: String(shared),
        out: 'ΟΔΟΣ ΑΛΦΑ 1 · Α2 (00999900001)'
      });
    }
  });

  it('degrades cleanly when either half is missing', () => {
    const cells = [
      [{ building, unit: null }, 'ΟΔΟΣ ΑΛΦΑ 1'],
      [{ building, unit: {} }, 'ΟΔΟΣ ΑΛΦΑ 1'],
      [
        { building, unit: { atakNumber: '00999900002' } },
        'ΟΔΟΣ ΑΛΦΑ 1 · 00999900002'
      ],
      // No building resolved: the flat alone, with no orphan separator.
      [{ unit }, 'Α2 (00999900001)'],
      [{ building: null, unit }, 'Α2 (00999900001)'],
      [{ building: {}, unit }, 'Α2 (00999900001)'],
      // A shared bill whose building did not resolve has nothing to say.
      [{ shared: true }, ''],
      [{ building: null, unit, shared: true }, ''],
      [{}, ''],
      [{ building: null, unit: null }, '']
    ];
    for (const [args, expected] of cells) {
      const out = billTargetLabel(args);
      expect({ args: JSON.stringify(args), out }).toEqual({
        args: JSON.stringify(args),
        out: expected
      });
      expect(out).not.toMatch(/undefined|null/);
      expect(out.startsWith(' ·')).toBe(false);
      expect(out.endsWith('· ')).toBe(false);
    }
  });

  it('called with nothing at all, returns empty rather than throwing', () => {
    expect(billTargetLabel()).toBe('');
    expect(billTargetLabel(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// variableExpense — hostile inputs only; the truth table is already pinned by
// variableExpense.test.js against the shared JSON both suites read.
// ---------------------------------------------------------------------------
describe('isVariableExpense — non-boolean flags and resolved costs', () => {
  it('only a REAL boolean flag wins; anything else falls to the legacy inference', () => {
    // A form or API that submits the string 'false' would have its flag ignored and
    // the €0 inference applied instead — the expense reads κυμαινόμενο again.
    const cells = [
      [{ isVariable: true, isRecurring: true, amount: 500 }, true],
      [{ isVariable: false, isRecurring: true, amount: 0 }, false],
      [{ isVariable: 'true', isRecurring: true, amount: 500 }, false],
      [{ isVariable: 'false', isRecurring: true, amount: 0 }, true],
      [{ isVariable: 1, isRecurring: true, amount: 500 }, false],
      [{ isVariable: 0, isRecurring: true, amount: 0 }, true],
      [{ isVariable: null, isRecurring: true, amount: 0 }, true],
      [{ isVariable: undefined, isRecurring: true, amount: 0 }, true]
    ];
    for (const [expense, expected] of cells) {
      expect({
        expense: JSON.stringify(expense),
        variable: isVariableExpense(expense)
      }).toEqual({ expense: JSON.stringify(expense), variable: expected });
    }
  });

  it('a resolved monthlyCost overrides the stored amount in both directions', () => {
    // The caller's resolved cost is the figure the surfaces actually show. A €500
    // amount that resolves to €0 this month is variable; a €0 amount that resolves
    // to €500 is not.
    expect(isVariableExpense({ isRecurring: true, amount: 500 }, 0)).toBe(true);
    expect(isVariableExpense({ isRecurring: true, amount: 0 }, 500)).toBe(
      false
    );
    expect(isVariableExpense({ isRecurring: true, amount: 0 }, -0)).toBe(true);
    expect(isVariableExpense({ isRecurring: true, amount: 0 }, 0.001)).toBe(
      false
    );
    expect(isVariableExpense({ isRecurring: true, amount: 0 }, -5)).toBe(false);
  });

  it('DOCUMENTED: a NaN or string monthlyCost is not a zero cost', () => {
    // NaN === 0 is false, so a cost that failed to compute reads as FIXED — the
    // opposite of the €0 case it came from. A string is ignored entirely (typeof
    // guard) and the stored amount decides.
    expect(isVariableExpense({ isRecurring: true, amount: 0 }, NaN)).toBe(
      false
    );
    expect(isVariableExpense({ isRecurring: true, amount: 0 }, '0')).toBe(true);
    expect(isVariableExpense({ isRecurring: true, amount: 500 }, '0')).toBe(
      false
    );
  });

  it('an unparseable amount counts as €0 — including a Greek-formatted one', () => {
    // «1.000,50» is how the figure is WRITTEN on a Greek bill. Number() gives NaN,
    // the ||0 makes it zero, and a recurring expense with a real amount reads
    // κυμαινόμενο. Pinned so the coercion is a decision, not an accident.
    for (const amount of [
      '',
      'abc',
      '1.000,50',
      null,
      undefined,
      NaN,
      {},
      []
    ]) {
      expect({
        amount: String(amount),
        variable: isVariableExpense({ isRecurring: true, amount })
      }).toEqual({ amount: String(amount), variable: true });
    }
    // Numeric strings DO parse, so they are not variable.
    for (const amount of ['500', ' 500 ', '500.5']) {
      expect({
        amount,
        variable: isVariableExpense({ isRecurring: true, amount })
      }).toEqual({ amount, variable: false });
    }
  });

  it('a non-recurring expense is never variable, whatever the amount', () => {
    for (const amount of [0, 500, '', null]) {
      expect({
        amount: String(amount),
        variable: isVariableExpense({ amount })
      }).toEqual({ amount: String(amount), variable: false });
    }
  });

  it('falsy expense objects are false, not a throw', () => {
    for (const junk of [null, undefined, 0, '', false, NaN]) {
      expect({ junk: String(junk), variable: isVariableExpense(junk) }).toEqual(
        {
          junk: String(junk),
          variable: false
        }
      );
    }
  });
});

describe('isRecurringExpense — the two field spellings', () => {
  it('isRecurring shadows recurring whenever it is not nullish', () => {
    // `??` not `||`: an explicit `false`/`0` on the new field must NOT fall back to
    // a stale legacy `recurring: true`, or a one-off expense re-appears every month.
    const cells = [
      [{ isRecurring: true }, true],
      [{ isRecurring: false, recurring: true }, false],
      [{ isRecurring: 0, recurring: true }, false],
      [{ isRecurring: '', recurring: true }, false],
      [{ isRecurring: null, recurring: true }, true],
      [{ isRecurring: undefined, recurring: true }, true],
      [{ recurring: true }, true],
      [{ recurring: false }, false],
      [{ isRecurring: 'yes' }, true],
      [{}, false],
      [null, false],
      [undefined, false]
    ];
    for (const [expense, expected] of cells) {
      expect({
        expense: JSON.stringify(expense),
        recurring: isRecurringExpense(expense)
      }).toEqual({ expense: JSON.stringify(expense), recurring: expected });
    }
  });

  it('always returns a real boolean, never the field value', () => {
    for (const e of [{ isRecurring: 'yes' }, { recurring: 1 }, {}, null]) {
      expect(typeof isRecurringExpense(e)).toBe('boolean');
    }
  });
});

describe('the prefill × the κυμαινόμενο predicate — why the flag must stay absent', () => {
  it('the LEGACY inference calls every prefill variable, in every cell', () => {
    // This is the hazard, not the desired UI state: `amount: 0, isRecurring: true`
    // is exactly the legacy signature of «κυμαινόμενο». So the create-expense form
    // must NOT seed its switch from this inference for a NEW row — the operator
    // would then type the bill's amount over a flag that says the amount is
    // meaningless, and the saved row is billed to tenants while being excluded from
    // the owner projection. The prefill's job is only to stay silent (asserted
    // above); this pins WHY silence is not enough on its own.
    for (const kindName of KINDS) {
      const p = buildExpensePrefill(argsFor(kindName, 'deh', BUILDINGS[0][1]));
      expect({ kindName, legacyInference: isVariableExpense(p) }).toEqual({
        kindName,
        legacyInference: true
      });
      // With the amount the operator actually types, the inference flips — which is
      // the pre-flag behaviour the explicit boolean exists to replace.
      expect({
        kindName,
        withAmount: isVariableExpense({ ...p, amount: 120 })
      }).toEqual({ kindName, withAmount: false });
    }
  });
});
