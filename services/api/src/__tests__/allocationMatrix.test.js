/**
 * The ALLOCATION MONEY MATRIX.
 *
 * Every κοινόχρηστο euro the landlord recovers passes through
 * _computeBuildingChargeRaw's `switch (allocationMethod)`. There is no second
 * allocator: the rent bill (taskBase), the ΧΡΕΩΣΕΙΣ breakdown, the owner
 * statement and the vacant-owner recompute all call the SAME
 * computeBuildingChargeForProperty. So a one-line drift in any branch
 * mis-bills every tenant in every building on every surface at once, and the
 * only witness is a number that looks plausible.
 *
 * Seam: computeBuildingChargeForProperty, the exported wrapper over
 * _computeBuildingChargeRaw (1_base.ts:70). It is the real engine — the €
 * assertions below are not a model of the allocator, they ARE the allocator.
 * The absent-representation cases additionally drive computeRent() end to end,
 * because "what does the engine return" and "does a charge row exist on the
 * bill" are different questions: taskBase gates every row behind `share > 0`.
 */
import * as BL from '../businesslogic/index.js';
import { computeBuildingChargeForProperty } from '../businesslogic/tasks/1_base.js';

/**
 * The canonical 4-unit building of this slice.
 *   generalThousandths  400 / 300 / 200 / 100   (Σ 1000)
 *   heatingThousandths  500 / 300 / 200 /   0   (Σ 1000 — pD has no radiator)
 *   surface             120 /  60 /  40 /  30   (Σ  250 m²)
 * Surfaces deliberately do NOT mirror the general thousandths: if by_surface
 * ever started reading generalThousandths (or vice versa) the numbers must
 * disagree, otherwise the matrix cannot see the swap.
 */
const UNITS = [
  { id: 'pA', general: 400, heating: 500, surface: 120 },
  { id: 'pB', general: 300, heating: 300, surface: 60 },
  { id: 'pC', general: 200, heating: 200, surface: 40 },
  { id: 'pD', general: 100, heating: 0, surface: 30 }
];

const makeUnit = (u) => ({
  _id: `unit-${u.id}`,
  propertyId: u.id,
  atakNumber: '01234567890',
  isManaged: true,
  surface: u.surface,
  generalThousandths: u.general,
  heatingThousandths: u.heating,
  elevatorThousandths: u.elevator ?? 0,
  owners: [],
  monthlyCharges: []
});

const makeBuilding = (units, expenses = []) => ({
  _id: 'bld-alpha',
  name: 'ΟΔΟΣ ΑΛΦΑ 1',
  atakPrefix: '011172',
  units: units.map(makeUnit),
  expenses,
  address: {},
  blockStreets: [],
  hasElevator: true,
  hasCentralHeating: true,
  contractors: [],
  repairs: []
});

const makeExpense = (allocationMethod, amount, overrides = {}) => ({
  _id: 'exp-koinoxrista',
  name: 'ΚΟΙΝΟΧΡΗΣΤΑ',
  type: 'cleaning_common',
  amount,
  allocationMethod,
  isRecurring: true,
  startTerm: 2020010100,
  customAllocations: [],
  ...overrides
});

/** Per-unit share for every unit in the building, keyed by propertyId. */
const shares = (building, expense, term) =>
  Object.fromEntries(
    building.units.map((u) => [
      String(u.propertyId),
      computeBuildingChargeForProperty(
        building,
        String(u.propertyId),
        expense,
        term
      )
    ])
  );

const sum = (map) =>
  Math.round(Object.values(map).reduce((s, v) => s + v, 0) * 100) / 100;

/** Labelled matrix assertion — jest's expect() takes exactly one argument. */
const expectMatrix = (label, actual, expected) =>
  expect({ case: label, shares: actual }).toEqual({
    case: label,
    shares: expected
  });

const AMOUNT = 200;

/**
 * Drive the FULL rent pipeline for one tenant so we can ask the question the
 * matrix cannot: does a buildingCharges row exist? taskBase writes a row only
 * `if (share > 0)` (1_base.ts:1137), so a zero share is not "€0 charged" — it is
 * nothing at all: no line, no total, no audit trail.
 */
const rentFor = (building, propertyId = 'pA') =>
  BL.computeRent(
    {
      begin: new Date('2024-01-01'),
      end: new Date('2024-12-31'),
      frequency: 'months',
      properties: [
        {
          propertyId,
          rent: 500,
          expenses: [],
          entryDate: new Date('2024-01-01'),
          exitDate: new Date('2024-12-31')
        }
      ],
      buildings: [building],
      rents: []
    },
    '01/03/2024 00:00',
    null
  );

describe('allocation matrix — exact € per unit for every allocationMethod', () => {
  const building = makeBuilding(UNITS);

  it('general_thousandths: 400/300/200/100 of €200 → 80/60/40/20, Σ = €200', () => {
    const got = shares(building, makeExpense('general_thousandths', AMOUNT));
    expectMatrix('general_thousandths', got, {
      pA: 80,
      pB: 60,
      pC: 40,
      pD: 20
    });
    // Σ must equal the expense: a denominator that counts the wrong unit set
    // (managed-only instead of all-units) under-collects and the landlord eats
    // the gap silently — the E19/Wave-14 F2 class of bug.
    expect(sum(got)).toBe(AMOUNT);
  });

  it('heating_thousandths: pD has 0 heating → pays nothing, siblings absorb nothing extra', () => {
    const got = shares(building, makeExpense('heating_thousandths', AMOUNT));
    expectMatrix('heating_thousandths', got, {
      pA: 100,
      pB: 60,
      pC: 40,
      pD: 0
    });
    // A unit with 0 thousandths among non-zero siblings is a real Greek shape
    // (ground floor with no radiator). It must be excluded from the charge but
    // NOT from the denominator — Σ still bills exactly the €200.
    expect(sum(got)).toBe(AMOUNT);
  });

  it('elevator_thousandths: 0/400/300/300 → ground floor pays €0, Σ = €200', () => {
    const elevBuilding = makeBuilding([
      { ...UNITS[0], elevator: 0 },
      { ...UNITS[1], elevator: 400 },
      { ...UNITS[2], elevator: 300 },
      { ...UNITS[3], elevator: 300 }
    ]);
    const got = shares(
      elevBuilding,
      makeExpense('elevator_thousandths', AMOUNT)
    );
    expectMatrix('elevator_thousandths', got, {
      pA: 0,
      pB: 80,
      pC: 60,
      pD: 60
    });
    expect(sum(got)).toBe(AMOUNT);
  });

  it('equal (no _tenantGroups): €200 / 4 managed units → 50 each', () => {
    const got = shares(building, makeExpense('equal', AMOUNT));
    expectMatrix('equal', got, { pA: 50, pB: 50, pC: 50, pD: 50 });
    expect(sum(got)).toBe(AMOUNT);
  });

  it('by_surface: 120/60/40/30 m² of €200 → 96/48/32/24, Σ = €200', () => {
    const got = shares(building, makeExpense('by_surface', AMOUNT));
    expectMatrix('by_surface', got, { pA: 96, pB: 48, pC: 32, pD: 24 });
    expect(sum(got)).toBe(AMOUNT);
  });

  it('fixed: per-unit € values, negative clamped to 0, expense.amount ignored', () => {
    const got = shares(
      building,
      makeExpense('fixed', AMOUNT, {
        customAllocations: [
          { propertyId: 'pA', value: 70 },
          { propertyId: 'pB', value: 30.5 },
          { propertyId: 'pC', value: 0 },
          // Misconfiguration: a negative "fixed share" would otherwise pay the
          // tenant, netting money OFF their rent total.
          { propertyId: 'pD', value: -15 }
        ]
      })
    );
    expectMatrix('fixed', got, { pA: 70, pB: 30.5, pC: 0, pD: 0 });
    // `fixed` is the one method that does NOT distribute expense.amount, so Σ
    // is whatever the landlord typed per unit — €100.50, not €200. Anyone
    // adding a "shares must sum to amount" invariant must exempt `fixed`.
    expect(sum(got)).toBe(100.5);
  });

  it('custom_ratio 3:2:1:0 of €200 → 100/66.67/33.33/0, remainder on lex-max non-zero ratio', () => {
    const got = shares(
      building,
      makeExpense('custom_ratio', AMOUNT, {
        customAllocations: [
          { propertyId: 'pA', value: 3 },
          { propertyId: 'pB', value: 2 },
          { propertyId: 'pC', value: 1 },
          { propertyId: 'pD', value: 0 }
        ]
      })
    );
    // pC is the lex-max id with a non-zero ratio, so it absorbs the carry:
    // 200 − (100 + 66.67) = 33.33 rather than its raw 33.333…
    expectMatrix('custom_ratio', got, {
      pA: 100,
      pB: 66.67,
      pC: 33.33,
      pD: 0
    });
    expect(sum(got)).toBe(AMOUNT);
  });

  it('custom_percentage summing to 100% → carry-corrected 66.68/66.66/66.66, Σ = €200', () => {
    const got = shares(
      building,
      makeExpense('custom_percentage', AMOUNT, {
        customAllocations: [
          { propertyId: 'pA', value: 33.34 },
          { propertyId: 'pB', value: 33.33 },
          { propertyId: 'pC', value: 33.33 }
        ]
      })
    );
    expectMatrix('custom_percentage/full-split', got, {
      pA: 66.68,
      pB: 66.66,
      pC: 66.66,
      pD: 0
    });
    expect(sum(got)).toBe(AMOUNT);
  });

  it('custom_percentage NOT summing to 100% → each carrier bills its own %, the rest is unbilled', () => {
    const got = shares(
      building,
      makeExpense('custom_percentage', AMOUNT, {
        customAllocations: [{ propertyId: 'pB', value: 35 }]
      })
    );
    expectMatrix('custom_percentage/partial', got, {
      pA: 0,
      pB: 70,
      pC: 0,
      pD: 0
    });
    // Deliberate: a single carrier at 35% must bill €70, NOT the whole €200
    // via carry-correction. The €130 balance is the landlord's own share by
    // construction — but note it is recovered from nobody, so a typo'd 35 (for
    // 100) silently under-collects with no error anywhere.
    expect(sum(got)).toBe(70);
  });

  it('single_unit: the whole €200 lands on the chosen unit, everyone else €0', () => {
    const got = shares(
      building,
      makeExpense('single_unit', AMOUNT, {
        customAllocations: [{ propertyId: 'pC', value: 0 }]
      })
    );
    expectMatrix('single_unit', got, { pA: 0, pB: 0, pC: 200, pD: 0 });
    expect(sum(got)).toBe(AMOUNT);
  });

  it('an unknown allocationMethod charges nobody rather than falling back to equal', () => {
    const got = shares(building, makeExpense('by_the_moon', AMOUNT));
    expectMatrix('unknown-method', got, { pA: 0, pB: 0, pC: 0, pD: 0 });
  });
});

describe('allocation matrix — absent representation (money with no row anywhere)', () => {
  it('E9-imported building with ALL thousandths zero: every share €0 AND no charge row is written', () => {
    // An E9/AADE PDF import that carried no χιλιοστά leaves every unit at 0.
    // The building's real €200 bill then has NO representation on ANY surface:
    // not on the rent, not in the breakdown, not on the owner ledger. It reads
    // as "nothing to charge" — indistinguishable from a building with no
    // expenses. This is the absent-representation shape, asserted loudly.
    const zeroed = makeBuilding(
      UNITS.map((u) => ({ ...u, general: 0, heating: 0, elevator: 0 }))
    );
    const expense = makeExpense('general_thousandths', AMOUNT);

    const got = shares(zeroed, expense);
    expectMatrix('all-thousandths-zero', got, {
      pA: 0,
      pB: 0,
      pC: 0,
      pD: 0
    });
    expect(sum(got)).toBe(0);

    const rent = rentFor(
      makeBuilding(
        UNITS.map((u) => ({ ...u, general: 0, heating: 0, elevator: 0 })),
        [expense]
      )
    );
    // Nothing anywhere: the €200 is invisible, not zero.
    expect(rent.buildingCharges).toEqual([]);
    expect(rent.total.charges).toBe(0);
  });

  it('the same building with thousandths present DOES write a row — proves the empty array above is the bug, not the harness', () => {
    const rent = rentFor(
      makeBuilding(UNITS, [makeExpense('general_thousandths', AMOUNT)])
    );
    expect(rent.buildingCharges).toEqual([
      {
        description: 'ΚΟΙΝΟΧΡΗΣΤΑ',
        amount: 80,
        buildingName: 'ΟΔΟΣ ΑΛΦΑ 1',
        type: 'cleaning_common'
      }
    ]);
  });

  it('€0 variable expense (statement not yet arrived) charges nobody on any distributing method', () => {
    const building = makeBuilding(UNITS);
    for (const method of [
      'general_thousandths',
      'heating_thousandths',
      'elevator_thousandths',
      'equal',
      'by_surface',
      'custom_ratio',
      'custom_percentage',
      'single_unit'
    ]) {
      const got = shares(
        building,
        makeExpense(method, 0, {
          customAllocations: [
            { propertyId: 'pA', value: 50 },
            { propertyId: 'pB', value: 50 }
          ]
        })
      );
      expectMatrix(`zero-amount/${method}`, got, {
        pA: 0,
        pB: 0,
        pC: 0,
        pD: 0
      });
    }
  });

  it('a non-numeric amount (string from an import, NaN from a bad parse) charges nobody instead of spreading NaN', () => {
    // The €0 loop above passes with the amount guard DELETED — 0 × any share is
    // 0 either way (measured: removing `!Number.isFinite(amount) || amount <= 0`
    // leaves it green). These are the values that make the guard load-bearing:
    // an amount that reached the allocator as the STRING '200', or as NaN from a
    // failed OCR parse, would otherwise put NaN on a rent line, and NaN
    // propagates — rent.total.charges, the ΧΡΕΩΣΕΙΣ breakdown and every
    // dashboard sum downstream all become NaN off one bad expense.
    for (const bad of ['200', NaN, undefined, null, Infinity]) {
      expectMatrix(
        `bad-amount/${String(bad)}`,
        shares(makeBuilding(UNITS), makeExpense('general_thousandths', bad)),
        { pA: 0, pB: 0, pC: 0, pD: 0 }
      );
    }
  });

  it('€0 expense on `fixed` STILL charges — fixed bypasses the amount<=0 guard by design', () => {
    // A κυμαινόμενο (variable) expense left at €0 but configured `fixed` bills
    // the per-unit values regardless. Whoever adds a "skip empty expenses"
    // shortcut must not route it through `fixed`, or per-unit fixed charges
    // vanish the month the statement figure is blank.
    const got = shares(
      makeBuilding(UNITS),
      makeExpense('fixed', 0, {
        customAllocations: [{ propertyId: 'pA', value: 12.34 }]
      })
    );
    expectMatrix('zero-amount/fixed', got, {
      pA: 12.34,
      pB: 0,
      pC: 0,
      pD: 0
    });
  });

  it('negative expense amount charges nobody (a credit note is not an allocation)', () => {
    const got = shares(
      makeBuilding(UNITS),
      makeExpense('general_thousandths', -200)
    );
    expectMatrix('negative-amount', got, { pA: 0, pB: 0, pC: 0, pD: 0 });
  });

  it('single_unit pointing at a propertyId that is in no unit of this building: €200 charges nobody', () => {
    // Happens when the target unit is deleted, or the expense is copied to
    // another building. Every unit returns 0 and the querying of the orphan id
    // itself returns 0, so the expense exists with no charge row anywhere.
    const building = makeBuilding(UNITS);
    const expense = makeExpense('single_unit', AMOUNT, {
      customAllocations: [{ propertyId: 'p-DELETED', value: 0 }]
    });
    const got = shares(building, expense);
    expectMatrix('single_unit/orphan-target', got, {
      pA: 0,
      pB: 0,
      pC: 0,
      pD: 0
    });
    expect(
      computeBuildingChargeForProperty(building, 'p-DELETED', expense)
    ).toBe(0);

    const rent = rentFor(makeBuilding(UNITS, [expense]));
    expect(rent.buildingCharges).toEqual([]);
  });

  it('single_unit with no customAllocations at all charges nobody', () => {
    const got = shares(makeBuilding(UNITS), makeExpense('single_unit', AMOUNT));
    expectMatrix('single_unit/no-target', got, {
      pA: 0,
      pB: 0,
      pC: 0,
      pD: 0
    });
  });

  it('custom_ratio with no ratios set: multi-unit building charges nobody, single-unit building takes it all', () => {
    const got = shares(
      makeBuilding(UNITS),
      makeExpense('custom_ratio', AMOUNT)
    );
    expectMatrix('custom_ratio/no-ratios/4-units', got, {
      pA: 0,
      pB: 0,
      pC: 0,
      pD: 0
    });
    // The documented single-unit fallback: the lone unit absorbs the whole
    // expense so a one-apartment building isn't silently un-billed.
    const solo = makeBuilding([UNITS[0]]);
    expectMatrix(
      'custom_ratio/no-ratios/1-unit',
      shares(solo, makeExpense('custom_ratio', AMOUNT)),
      { pA: 200 }
    );
  });

  it('a unit with no propertyId (unmanaged) stays out of the equal/by_surface denominators', () => {
    // Unmanaged units must not inflate the `equal` or `by_surface`
    // denominator; if they leak in, every managed tenant's share shrinks and
    // the building under-collects with no visible error (the E19 shape). The
    // unmanaged unit here carries a fat 250 m² / 500 χιλιοστά precisely so a
    // leak would move the managed numbers.
    const withUnmanaged = makeBuilding(UNITS);
    withUnmanaged.units.push({
      ...makeUnit({ id: 'ignored', general: 500, heating: 500, surface: 250 }),
      _id: 'unit-unmanaged',
      propertyId: undefined
    });
    const managedOnly = (building, expense) =>
      Object.fromEntries(
        ['pA', 'pB', 'pC', 'pD'].map((pid) => [
          pid,
          computeBuildingChargeForProperty(building, pid, expense)
        ])
      );
    expectMatrix(
      'unmanaged/equal',
      managedOnly(withUnmanaged, makeExpense('equal', AMOUNT)),
      { pA: 50, pB: 50, pC: 50, pD: 50 }
    );
    expectMatrix(
      'unmanaged/by_surface',
      managedOnly(withUnmanaged, makeExpense('by_surface', AMOUNT)),
      { pA: 96, pB: 48, pC: 32, pD: 24 }
    );
    // …but general_thousandths deliberately uses the FULL building denominator
    // (Wave-14 F2): the unmanaged unit's 500 χιλιοστά DO dilute the managed
    // shares, because the owner absorbs that unit's share. 1000 → 1500.
    expectMatrix(
      'unmanaged/general_thousandths',
      managedOnly(withUnmanaged, makeExpense('general_thousandths', AMOUNT)),
      { pA: 53.33, pB: 40, pC: 26.67, pD: 13.33 }
    );
  });

  it('BUG (documented, not fixed): querying with a nullish propertyId MATCHES an unmanaged unit and bills it', () => {
    // The unit lookup is `String(u.propertyId) === String(propertyId)`, so
    // undefined === undefined coerces to 'undefined' === 'undefined' and finds
    // the unmanaged unit. It is then excluded from the denominator (correctly)
    // but still handed a share (wrongly): a €200 `equal` expense over 4 managed
    // units returns a FIFTH €50 share, and by_surface returns the whole €200.
    // taskBase's `if (!property.propertyId) return;` is the only thing keeping
    // this off a rent bill today — any new caller that forgets that guard
    // over-collects.
    const withUnmanaged = makeBuilding(UNITS);
    withUnmanaged.units.push({
      ...makeUnit({ id: 'ignored', general: 500, heating: 500, surface: 250 }),
      _id: 'unit-unmanaged',
      propertyId: undefined
    });
    expect(
      computeBuildingChargeForProperty(
        withUnmanaged,
        undefined,
        makeExpense('equal', AMOUNT)
      )
    ).toBe(50);
    expect(
      computeBuildingChargeForProperty(
        withUnmanaged,
        undefined,
        makeExpense('by_surface', AMOUNT)
      )
    ).toBe(AMOUNT);
  });
});

describe('allocation matrix — negative and non-numeric thousandths', () => {
  it('NaN thousandths degrade to 0 for the unit AND for the denominator', () => {
    // A χιλιοστά field arriving as a string from an import ("400,0" or "—")
    // must not poison the whole building's allocation with NaN.
    const dirty = makeBuilding([
      { ...UNITS[0], general: 400 },
      { ...UNITS[1], general: 300 },
      { ...UNITS[2], general: 200 },
      { ...UNITS[3], general: 'δεν υπάρχει' }
    ]);
    const got = shares(dirty, makeExpense('general_thousandths', AMOUNT));
    // Denominator = 900 (not NaN), pD = 0.
    expectMatrix('nan-thousandths', got, {
      pA: 88.89,
      pB: 66.67,
      pC: 44.44,
      pD: 0
    });
    // A dirty χιλιοστά value must not cost the building money either: the three
    // clean units still absorb the whole €200 between them.
    expect(sum(got)).toBe(AMOUNT);
  });

  it('BUG (documented, not fixed): a NEGATIVE thousandth over-bills the building', () => {
    // generals 400/300/200/−100 → denominator shrinks to 800, so pA/pB/pC are
    // each inflated, and pD's offsetting −€25 credit is DROPPED by taskBase's
    // `share > 0` gate. The building bills €225 for a €200 expense and the
    // three paying tenants never see why. The engine itself returns the
    // negative (asserted here so the behaviour cannot change unnoticed); it is
    // the `share > 0` row gate that turns it into over-collection.
    const negativeUnits = [
      { ...UNITS[0], general: 400 },
      { ...UNITS[1], general: 300 },
      { ...UNITS[2], general: 200 },
      { ...UNITS[3], general: -100 }
    ];
    const got = shares(
      makeBuilding(negativeUnits),
      makeExpense('general_thousandths', AMOUNT)
    );
    expectMatrix('negative-thousandths', got, {
      pA: 100,
      pB: 75,
      pC: 50,
      pD: -25
    });
    // Algebraically Σ is still the expense…
    expect(sum(got)).toBe(AMOUNT);
    // …but the €225 must be read off the REAL bills, not off a test-side
    // re-implementation of the `share > 0` gate: one rent per unit, summing only
    // the rows taskBase actually wrote. pD's −€25 gets no row at all, so the
    // credit that balances the algebra never reaches a tenant.
    const expense = makeExpense('general_thousandths', AMOUNT);
    const rowsPerUnit = ['pA', 'pB', 'pC', 'pD'].map(
      (pid) => rentFor(makeBuilding(negativeUnits, [expense]), pid).buildingCharges
    );
    expect(rowsPerUnit[3]).toEqual([]);
    expect(rowsPerUnit.map((rows) => rows.map((r) => r.amount))).toEqual([
      [100],
      [75],
      [50],
      []
    ]);
    const billedByPipeline =
      Math.round(
        rowsPerUnit.flat().reduce((s, r) => s + r.amount, 0) * 100
      ) / 100;
    expect(billedByPipeline).toBe(225);
  });

  it('thousandths that sum to 0 via cancellation (+100/−100) charge nobody', () => {
    // The `if (total === 0) return 0` guard is a divide-by-zero shield, but it
    // also swallows this misconfiguration whole: no row, no warning.
    const cancelling = makeBuilding([
      { ...UNITS[0], general: 100 },
      { ...UNITS[1], general: -100 },
      { ...UNITS[2], general: 0 },
      { ...UNITS[3], general: 0 }
    ]);
    expectMatrix(
      'cancelling-thousandths',
      shares(cancelling, makeExpense('general_thousandths', AMOUNT)),
      { pA: 0, pB: 0, pC: 0, pD: 0 }
    );
  });
});

describe('allocation matrix — rounding: does Σ(shares) reconcile to the expense?', () => {
  const three = [
    { id: 'pA', general: 1, heating: 1, surface: 1 },
    { id: 'pB', general: 1, heating: 1, surface: 1 },
    { id: 'pC', general: 1, heating: 1, surface: 1 }
  ];

  it('equal: €100 over 3 units → 33.33/33.33/33.34, lex-max absorbs the cent', () => {
    const got = shares(makeBuilding(three), makeExpense('equal', 100));
    expectMatrix('rounding/equal', got, {
      pA: 33.33,
      pB: 33.33,
      pC: 33.34
    });
    expect(sum(got)).toBe(100);
  });

  it('by_surface: €100 over 3 equal surfaces → lex-max absorbs the cent', () => {
    const got = shares(makeBuilding(three), makeExpense('by_surface', 100));
    expectMatrix('rounding/by_surface', got, {
      pA: 33.33,
      pB: 33.33,
      pC: 33.34
    });
    expect(sum(got)).toBe(100);
  });

  it('custom_ratio 1:1:1: €100 → lex-max absorbs the cent', () => {
    const got = shares(
      makeBuilding(three),
      makeExpense('custom_ratio', 100, {
        customAllocations: [
          { propertyId: 'pA', value: 1 },
          { propertyId: 'pB', value: 1 },
          { propertyId: 'pC', value: 1 }
        ]
      })
    );
    expectMatrix('rounding/custom_ratio', got, {
      pA: 33.33,
      pB: 33.33,
      pC: 33.34
    });
    expect(sum(got)).toBe(100);
  });

  it('BUG (documented, not fixed): thousandths methods have NO carrier-remainder — €100/3 collects only €99.99', () => {
    // equal / by_surface / custom_ratio / custom_percentage all route the
    // rounding remainder to a lex-max carrier so Σ bills the full amount. The
    // three *_thousandths branches do not: each returns its own rounded share
    // and the leftover cent is never charged to anyone. On a monthly recurring
    // κοινόχρηστο that is €0.12/year per affected building, invisible on every
    // surface because each individual share looks correct.
    const got = shares(
      makeBuilding(three),
      makeExpense('general_thousandths', 100)
    );
    expectMatrix('rounding/general_thousandths', got, {
      pA: 33.33,
      pB: 33.33,
      pC: 33.33
    });
    expect(sum(got)).toBe(99.99);
    expect(Math.round((100 - sum(got)) * 100) / 100).toBe(0.01);
  });

  it('heating_thousandths loses the same cent (same missing carrier, second branch)', () => {
    const got = shares(
      makeBuilding(three),
      makeExpense('heating_thousandths', 100)
    );
    expect(sum(got)).toBe(99.99);
  });

  it('elevator_thousandths loses the same cent (third branch)', () => {
    const got = shares(
      makeBuilding(three.map((u) => ({ ...u, elevator: 1 }))),
      makeExpense('elevator_thousandths', 100)
    );
    expect(sum(got)).toBe(99.99);
  });

  it('custom_percentage 33.33/33.33/33.34: Σ bills exactly €100', () => {
    const got = shares(
      makeBuilding(three),
      makeExpense('custom_percentage', 100, {
        customAllocations: [
          { propertyId: 'pA', value: 33.33 },
          { propertyId: 'pB', value: 33.33 },
          { propertyId: 'pC', value: 33.34 }
        ]
      })
    );
    expect(sum(got)).toBe(100);
    expectMatrix('rounding/custom_percentage', got, {
      pA: 33.33,
      pB: 33.33,
      pC: 33.34
    });
  });

  it('prime 7/11/13 weights of €100: every method emits exact 2-decimal cents', () => {
    // Indivisible weights are where fractional cents appear. Asserting "v equals
    // its own 2-decimal rounding" is not coverage — that holds for 0, so it
    // survives an allocator that charges nobody. Pin the euros instead: a
    // fractional cent, a lost cent, or a branch cross-wire all move a literal.
    const building = makeBuilding([
      { id: 'pA', general: 7, heating: 7, surface: 7 },
      { id: 'pB', general: 11, heating: 11, surface: 11 },
      { id: 'pC', general: 13, heating: 13, surface: 13 }
    ]);
    const EXPECTED = {
      // 100 × 7/31, 11/31, 13/31 — the thousandths branches round each share
      // independently and here the three happen to reconcile to €100 exactly.
      general_thousandths: { pA: 22.58, pB: 35.48, pC: 41.94 },
      heating_thousandths: { pA: 22.58, pB: 35.48, pC: 41.94 },
      // by_surface reads the SAME 7/11/13 as surfaces but reaches 41.94 the
      // other way: carrier-remainder on lex-max pC (100 − 22.58 − 35.48).
      by_surface: { pA: 22.58, pB: 35.48, pC: 41.94 },
      equal: { pA: 33.33, pB: 33.33, pC: 33.34 },
      custom_ratio: { pA: 33.33, pB: 33.33, pC: 33.34 },
      custom_percentage: { pA: 33.33, pB: 33.33, pC: 33.34 }
    };
    for (const [method, expected] of Object.entries(EXPECTED)) {
      const got = shares(
        building,
        makeExpense(method, 100, {
          customAllocations: [
            { propertyId: 'pA', value: 33.33 },
            { propertyId: 'pB', value: 33.33 },
            { propertyId: 'pC', value: 33.34 }
          ]
        })
      );
      expectMatrix(`primes/${method}`, got, expected);
      expect({ case: `primes/${method}`, sum: sum(got) }).toEqual({
        case: `primes/${method}`,
        sum: 100
      });
    }
  });
});

describe('allocation matrix — building/unit lookup preconditions', () => {
  it('a propertyId in no unit of the building gets €0 on every method', () => {
    const building = makeBuilding(UNITS);
    for (const method of [
      'general_thousandths',
      'heating_thousandths',
      'elevator_thousandths',
      'equal',
      'by_surface',
      'fixed',
      'custom_ratio',
      'custom_percentage',
      'single_unit'
    ]) {
      const v = computeBuildingChargeForProperty(
        building,
        'p-NOT-IN-THIS-BUILDING',
        makeExpense(method, AMOUNT, {
          customAllocations: [
            { propertyId: 'p-NOT-IN-THIS-BUILDING', value: 99 }
          ]
        })
      );
      // The unit-lookup guard must fire BEFORE any branch — otherwise `fixed`
      // and `single_unit` would happily bill a property that belongs to a
      // different building (the cross-building steal shape).
      expect({ case: method, value: v }).toEqual({ case: method, value: 0 });
    }
  });

  it('a building with no units array charges nobody instead of throwing', () => {
    const expense = makeExpense('general_thousandths', AMOUNT);
    expect(computeBuildingChargeForProperty({ _id: 'b' }, 'pA', expense)).toBe(
      0
    );
    expect(
      computeBuildingChargeForProperty({ _id: 'b', units: null }, 'pA', expense)
    ).toBe(0);
  });
});
