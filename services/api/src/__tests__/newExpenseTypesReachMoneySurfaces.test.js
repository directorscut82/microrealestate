/**
 * ABSENT-REPRESENTATION sweep for the 2026-08-12 additions: the five `_private`
 * / telecom expense types and the `isVariable` (κυμαινόμενο) flag.
 *
 * documentation/MONEY_SURFACE_MATRIX.md § "An ABSENT representation hides money
 * as effectively as a wrong number": the question is not only «does a surface
 * show it wrong», it is «is there any surface that CAN show it at all». A type
 * with no mapping and a flag with no reader are invisible, and invisible reads
 * as correct everywhere. This suite walks the new type/flag from the schema out
 * to each money surface that has to carry them:
 *
 *   1. propertymanager.getExpenses  → the per-property panel CATEGORY TOTALS
 *      (the sibling suite propertymanager.classifyExpense.test.js already locks
 *      the type→category function; this one locks the euros that land in each
 *      bucket, which is what the landlord actually reads).
 *   2. common/buildingprojection.computeBuildingProjection → annualOwnerExpenses
 *      + annualOwnerExpensesProjected, across isVariable true/false/ABSENT ×
 *      amount 0/>0 × recurring true/false.
 *   3. billmanager.buildStatementEntries → a confirmed bill of a new type must
 *      reach the monthly-statement entry set at its full amount.
 *   4/5. The type→label map (landlord lineLabels.js + pdfgenerator
 *      invoicebody.ejs) and all six PDF locales.
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isRecurringExpense,
  isVariableExpense
} from '@microrealestate/common/dist/utils/variableexpense.js';
import { computeBuildingProjection } from '@microrealestate/common/dist/utils/buildingprojection.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');

// ---------------------------------------------------------------------------
// The schema enum, parsed from the schema. Never mirrored: a hand-copied list
// cannot detect drift in the thing it guards (that is exactly how the five new
// types were added on 2026-08-12 with the sibling suite still green).
// ---------------------------------------------------------------------------
const SCHEMA_EXPENSE_TYPES = (() => {
  const src = fs.readFileSync(
    path.join(REPO, 'services/common/src/collections/building.ts'),
    'utf8'
  );
  const start = src.indexOf('const BuildingExpenseSchema');
  if (start < 0) throw new Error('BuildingExpenseSchema not found');
  const enumStart = src.indexOf('enum: [', start);
  const enumEnd = src.indexOf(']', enumStart);
  if (enumStart < 0 || enumEnd < 0) throw new Error('type enum not found');
  // Comments in this enum body contain commas AND quoted words; strip them
  // before harvesting literals or the parse silently loses a value.
  const body = src
    .slice(enumStart + 'enum: ['.length, enumEnd)
    .replace(/\/\/[^\n]*/g, '');
  const values = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  if (values.length < 16) {
    throw new Error(`parsed only ${values.length} expense types`);
  }
  return values;
})();

const NEW_2026_08_TYPES = [
  'electricity_private',
  'water_private',
  'gas_private',
  'telecom_private',
  'telecom_common'
];

// The category each schema type must land in on the property panel. Kept here
// (not read from the code) on purpose: this is the SPEC side of the assertion —
// a euro moving bucket has to break a test, not update one.
const TYPE_TO_CATEGORY = {
  heating: 'heating',
  gas_private: 'heating',
  water_common: 'water',
  water_private: 'water',
  electricity_common: 'electricity',
  electricity_private: 'electricity',
  insurance: 'insurance',
  cleaning: 'cleaning',
  garden: 'cleaning',
  pest_control: 'cleaning',
  elevator: 'repairs',
  repairs_fund: 'repairs',
  management_fee: 'other',
  telecom_private: 'other',
  telecom_common: 'other',
  other: 'other'
};

const CATEGORIES = [
  'heating',
  'water',
  'electricity',
  'insurance',
  'cleaning',
  'repairs',
  'other'
];

// ---------------------------------------------------------------------------
// Surface 1 — the per-property Έξοδα ακινήτου panel's category TOTALS.
// ---------------------------------------------------------------------------
const propertyFindOne = jest.fn();
const buildingFindOne = jest.fn();
const chargeForProperty = jest.fn();
let getExpenses;

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Realm: {},
      Tenant: {},
      Property: { findOne: propertyFindOne },
      Lease: {},
      Building: { findOne: buildingFindOne },
      Template: {},
      Document: {},
      Email: {},
      Bill: {},
      Account: {}
    },
    ServiceError,
    Crypto: { encrypt: (v) => v, decrypt: (v) => v },
    logger: { info() {}, error() {}, debug() {}, warn() {} },
    Pagination: { paginate: jest.fn(), defaultPageSize: 50 },
    Middlewares: {},
    Service: { getInstance: jest.fn() }
  }));
  jest.unstable_mockModule('../validators.js', () => ({
    validateObjectId: jest.fn(),
    validateFiniteNumber: jest.fn(),
    validateEnum: jest.fn(),
    sanitizeMongoObject: jest.fn((v) => v),
    isValidGreekPostalCode: jest.fn(() => true),
    isValidATAK: jest.fn(() => true),
    isValidDEH: jest.fn(() => true),
    isValidPhone: jest.fn(() => true),
    PROPERTY_TYPES: ['apartment', 'store', 'office', 'storage', 'parking']
  }));
  jest.unstable_mockModule('../managers/occupantmanager.js', () => ({
    _attachTenantGroupsToBuildings: jest.fn()
  }));
  jest.unstable_mockModule('../businesslogic/tasks/1_base.js', () => ({
    computeBuildingChargeForProperty: chargeForProperty
  }));
  ({ getExpenses } = await import('../managers/propertymanager.js'));
});

const PROPERTY_ID = 'p-alfa';
// Single-month window == the current UTC month, so getExpenses' `isCurrent`
// branch fires and currentMonth.byCategory is populated deterministically.
const nowUtc = () => {
  const d = new Date();
  return {
    ym: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
    term:
      d.getUTCFullYear() * 1000000 + (d.getUTCMonth() + 1) * 10000 + 100
  };
};

async function panelFor(expenses, sharePerExpense = 10) {
  const { ym, term } = nowUtc();
  propertyFindOne.mockReturnValue({
    lean: async () => ({ _id: PROPERTY_ID, name: 'ΟΔΟΣ ΑΛΦΑ 1' })
  });
  buildingFindOne.mockReturnValue({
    lean: async () => ({
      _id: 'b1',
      name: 'ΟΔΟΣ ΑΛΦΑ',
      units: [{ _id: 'u1', propertyId: PROPERTY_ID, monthlyCharges: [] }],
      expenses: expenses.map((e, i) => ({
        _id: `e${i}`,
        name: e.name || `Έξοδο ${i}`,
        type: e.type,
        amount: 100,
        isRecurring: true,
        startTerm: term
      })),
      ownerMonthlyExpenses: [],
      repairs: []
    })
  });
  chargeForProperty.mockReturnValue(sharePerExpense);
  const res = { json: jest.fn((payload) => payload) };
  await getExpenses(
    {
      realm: { _id: 'r1', currency: 'EUR' },
      params: { id: PROPERTY_ID },
      query: { from: ym, to: ym }
    },
    res
  );
  return res.json.mock.calls[0][0];
}

describe('Surface 1 — property panel CATEGORY TOTALS carry every schema type', () => {
  it('the parsed schema enum still holds all five 2026-08 private/telecom types', () => {
    // If this drifts the whole suite is asserting about types that no longer
    // exist (or missing ones that do) — fail loudly here instead.
    for (const t of NEW_2026_08_TYPES) {
      expect(SCHEMA_EXPENSE_TYPES).toContain(t);
    }
    expect(Object.keys(TYPE_TO_CATEGORY).sort()).toEqual(
      [...SCHEMA_EXPENSE_TYPES].sort()
    );
  });

  SCHEMA_EXPENSE_TYPES.forEach((type) => {
    it(`a €10 '${type}' expense lands €10 in byCategory.${TYPE_TO_CATEGORY[type]} and nowhere else`, async () => {
      const payload = await panelFor([{ type }]);
      const expected = CATEGORIES.reduce(
        (acc, c) => ({ ...acc, [c]: c === TYPE_TO_CATEGORY[type] ? 10 : 0 }),
        {}
      );
      // Whole-object compare: a type that silently leaks into 'other' shows up
      // as a diff on BOTH buckets, not just a missing euro in one.
      expect({ type, byCategory: payload.currentMonth.byCategory }).toEqual({
        type,
        byCategory: expected
      });
    });
  });

  it('all 16 types together conserve the money — Σ(byCategory) === Σ(shares)', () => {
    // The absent-representation check proper: any type that fails to reach a
    // bucket makes the panel UNDER-report, and an under-report looks like «that
    // month was cheap», not like a bug.
    return panelFor(SCHEMA_EXPENSE_TYPES.map((type) => ({ type }))).then(
      (payload) => {
        const sum = CATEGORIES.reduce(
          (s, c) => s + payload.currentMonth.byCategory[c],
          0
        );
        expect(sum).toBe(SCHEMA_EXPENSE_TYPES.length * 10);
        expect(payload.lifetime.byCategory.electricity).toBe(20); // common + private
        expect(payload.lifetime.byCategory.water).toBe(20); // common + private
        expect(payload.lifetime.byCategory.heating).toBe(20); // heating + gas_private
        expect(payload.lifetime.byCategory.cleaning).toBe(30); // cleaning+garden+pest
        expect(payload.lifetime.byCategory.repairs).toBe(20); // elevator+repairs_fund
        // management_fee + telecom_private + telecom_common + other
        expect(payload.lifetime.byCategory.other).toBe(40);
      }
    );
  });

  it('the panel LINES label each private type distinctly (no merged rows)', async () => {
    const payload = await panelFor([
      { type: 'electricity_common', name: 'Κοινόχρηστο ρεύμα' },
      { type: 'electricity_private', name: 'Ρεύμα Α1' }
    ]);
    const lines = payload.currentMonth.lines;
    expect(lines).toHaveLength(2);
    // Same bucket by design; the DESCRIPTION is what tells the landlord whose
    // meter it is. Collapsing these to one row hides a whole bill.
    expect(lines.map((l) => l.description).sort()).toEqual([
      'Κοινόχρηστο ρεύμα',
      'Ρεύμα Α1'
    ]);
    expect(lines.every((l) => l.category === 'electricity')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Surface 2 — computeBuildingProjection owner-expense matrix.
// ---------------------------------------------------------------------------
const YEAR = 2026;
const NOW_YM = { year: 2026, month: 6 }; // June — 6 elapsed, 6 remaining
const OWNER_AMOUNT = 50;

// One owner-tracked expense, χιλιοστά-free, active Jan..Dec of YEAR, with the
// landlord's typed statement figure (inputAmount 120) recorded for Jan/Feb/Mar.
// inputAmount is the field that stops repeated saves from sum-eroding a variable
// expense (see building.ts:28-37), so the variable branch must read it.
function projectionBuilding({ amount, isRecurring, isVariable }) {
  const expense = {
    _id: 'e-owner',
    name: 'Έξοδο ιδιοκτήτη',
    type: 'electricity_private',
    amount,
    isRecurring,
    startTerm: 2026010100,
    trackOwnerExpense: true,
    ownerAmount: OWNER_AMOUNT
  };
  if (isVariable !== undefined) expense.isVariable = isVariable;
  return {
    _id: 'b1',
    units: [
      {
        propertyId: PROPERTY_ID,
        monthlyCharges: [2026010100, 2026020100, 2026030100].map((term) => ({
          term,
          expenseId: 'e-owner',
          amount: 60,
          inputAmount: 120
        }))
      }
    ],
    expenses: [expense],
    ownerMonthlyExpenses: [],
    repairs: []
  };
}

const project = (opts) =>
  computeBuildingProjection(
    projectionBuilding(opts),
    new Map(),
    YEAR,
    NOW_YM
  );

// isVariable: absent → legacy inference (recurring && cost === 0). The ABSENT
// rows are the landlord's REAL pre-flag data (the «Πετρέλαιο (κυμαινόμενο)»
// rows); if they stop matching their true/false twin below, owner money either
// vanishes or is invented on the Ετήσια προβολή tile.
//
// variable path : Σ(inputAmount) × ownerRatio, + 3-month-avg × remaining months
//                 ownerRatio = ownerAmount/amount, or 1 when amount is 0
// fixed   path : ownerAmount × 12, of which × 6 is still projected (June)
const PROJECTION_MATRIX = [
  // isVariable EXPLICIT TRUE — variable whatever the amount says, and the
  // variable branch does not care about `recurring` at all.
  { isVariable: true, amount: 0, isRecurring: true, total: 1440, projected: 1080 },
  { isVariable: true, amount: 0, isRecurring: false, total: 1440, projected: 1080 },
  { isVariable: true, amount: 200, isRecurring: true, total: 360, projected: 270 },
  { isVariable: true, amount: 200, isRecurring: false, total: 360, projected: 270 },
  // isVariable EXPLICIT FALSE — «I have not typed the amount yet», NOT free.
  // At €0 it must contribute NOTHING: this is the single distinction the flag
  // was added for. Pre-flag this same row projected €1440 of owner money that
  // the landlord had never entered.
  { isVariable: false, amount: 0, isRecurring: true, total: 0, projected: 0 },
  { isVariable: false, amount: 0, isRecurring: false, total: 0, projected: 0 },
  { isVariable: false, amount: 200, isRecurring: true, total: 600, projected: 300 },
  { isVariable: false, amount: 200, isRecurring: false, total: 0, projected: 0 },
  // isVariable ABSENT — legacy rows. MUST equal the pre-flag numbers.
  { isVariable: undefined, amount: 0, isRecurring: true, total: 1440, projected: 1080 },
  { isVariable: undefined, amount: 0, isRecurring: false, total: 0, projected: 0 },
  { isVariable: undefined, amount: 200, isRecurring: true, total: 600, projected: 300 },
  { isVariable: undefined, amount: 200, isRecurring: false, total: 0, projected: 0 }
];

describe('Surface 2 — computeBuildingProjection owner expenses × κυμαινόμενο', () => {
  PROJECTION_MATRIX.forEach(
    ({ isVariable, amount, isRecurring, total, projected }) => {
      const name = `isVariable=${String(isVariable)} amount=${amount} recurring=${isRecurring}`;
      it(name, () => {
        const r = project({ amount, isRecurring, isVariable });
        expect({
          case: name,
          annualOwnerExpenses: r.annualOwnerExpenses,
          annualOwnerExpensesProjected: r.annualOwnerExpensesProjected
        }).toEqual({
          case: name,
          annualOwnerExpenses: total,
          annualOwnerExpensesProjected: projected
        });
      });
    }
  );

  it('ABSENT reproduces the pre-flag inference exactly (both directions)', () => {
    // Paired, not just tabulated: a change that shifted the legacy fallback
    // would move BOTH the absent row and its twin in the table above and could
    // stay green. Comparing them to each other cannot.
    const legacyVariable = project({
      amount: 0,
      isRecurring: true,
      isVariable: undefined
    });
    const explicitVariable = project({
      amount: 0,
      isRecurring: true,
      isVariable: true
    });
    expect(legacyVariable).toEqual(explicitVariable);

    const legacyFixed = project({
      amount: 200,
      isRecurring: true,
      isVariable: undefined
    });
    const explicitFixed = project({
      amount: 200,
      isRecurring: true,
      isVariable: false
    });
    expect(legacyFixed).toEqual(explicitFixed);
  });

  it('an explicit isVariable=false at €0 is NOT the same as absent at €0', () => {
    // The two states the landlord could not tell apart before the flag. If
    // these ever return equal numbers the flag has stopped being read.
    const unfinished = project({
      amount: 0,
      isRecurring: true,
      isVariable: false
    });
    const legacy = project({ amount: 0, isRecurring: true, isVariable: undefined });
    expect(unfinished.annualOwnerExpenses).toBe(0);
    expect(legacy.annualOwnerExpenses).toBe(1440);
  });

  it('a vacant-unit owner row of a VARIABLE expense is counted once, not ×12', () => {
    // The flag also gates the owner-ledger rollup: a recurring FIXED expense's
    // vacant share is projected across its active months, a κυμαινόμενο one is
    // an actual for that month only. Getting this backwards multiplies a real
    // €80 vacant share into €960 of owner debt on the tile.
    const mk = (isVariable) => ({
      _id: 'b1',
      units: [],
      expenses: [
        {
          _id: 'e-var',
          name: 'Ρεύμα Α1',
          type: 'electricity_private',
          amount: 0,
          isRecurring: true,
          isVariable,
          startTerm: 2026010100
        }
      ],
      ownerMonthlyExpenses: [
        { term: 2026060100, amount: 80, source: 'vacant', expenseId: 'e-var' }
      ],
      repairs: []
    });
    const variable = computeBuildingProjection(
      mk(true),
      new Map(),
      YEAR,
      NOW_YM
    );
    const notVariable = computeBuildingProjection(
      mk(false),
      new Map(),
      YEAR,
      NOW_YM
    );
    const legacy = computeBuildingProjection(
      mk(undefined),
      new Map(),
      YEAR,
      NOW_YM
    );
    expect(variable.annualOwnerExpenses).toBe(80); // one month's actual
    expect(notVariable.annualOwnerExpenses).toBe(960); // fixed → × 12 months
    expect(legacy.annualOwnerExpenses).toBe(80); // legacy row keeps 80
  });

  // ---- DOCUMENTED CURRENT BEHAVIOUR (reported, production left alone) ----
  // Both rows below are absent-representation shapes found while deriving the
  // matrix. They are asserted as-is so a future fix is a deliberate, visible
  // change to these expectations rather than an accidental one.
  it('DOCUMENTS: a ONE-OFF owner-tracked expense contributes €0 to the annual owner figure', () => {
    // `_recurringFixed` filters on isRecurringExpense, and the ownerMonthlyExpenses
    // rollup only reads source 'vacant'/'owner-resident' — so a non-recurring
    // trackOwnerExpense row (€200 with a €50 owner slice) is counted by NO branch.
    // The owner owes it; the Ετήσια προβολή tile reports zero.
    const r = project({ amount: 200, isRecurring: false, isVariable: false });
    expect(r.annualOwnerExpenses).toBe(0);
    expect(r.annualOwnerExpensesProjected).toBe(0);
  });

  it('DOCUMENTS: a κυμαινόμενο expense charges the owner the FULL figure, ignoring ownerAmount', () => {
    // ownerRatio = amount > 0 ? ownerAmount/amount : 1. A variable expense is
    // precisely the case where `amount` is 0, so the ratio is forced to 1 and the
    // owner's declared slice (€50 of €120) has no effect: all €120/month is
    // projected as owner money. Contrast the amount=200 rows, where the ratio
    // scales the same charges down to 25%.
    const variableAtZero = project({
      amount: 0,
      isRecurring: true,
      isVariable: true
    });
    expect(variableAtZero.annualOwnerExpenses).toBe(1440); // 3×120 + 9×120
    const variableWithBase = project({
      amount: 200,
      isRecurring: true,
      isVariable: true
    });
    expect(variableWithBase.annualOwnerExpenses).toBe(360); // same charges × 0.25
  });

  it('DOCUMENTS: the variable branch projects a NON-recurring expense forward anyway', () => {
    // The variable path applies no recurring and no active-term test, and
    // expenseActiveMonths returns 12 for a startTerm-Jan row with no endTerm — so
    // a one-off κυμαινόμενο expense still projects a 3-month average across the
    // remaining 9 months. Identical numbers to its recurring twin.
    const oneOff = project({ amount: 0, isRecurring: false, isVariable: true });
    const recurring = project({ amount: 0, isRecurring: true, isVariable: true });
    expect(oneOff).toEqual(recurring);
    expect(oneOff.annualOwnerExpensesProjected).toBe(1080);
  });

  it('the predicate the projection depends on agrees with these fixtures', () => {
    // Guards against the matrix above passing for the wrong reason (e.g. every
    // branch returning 0 because the fixture is malformed).
    expect(isVariableExpense({ isVariable: false, isRecurring: true }, 0)).toBe(
      false
    );
    expect(isVariableExpense({ isRecurring: true }, 0)).toBe(true);
    expect(isVariableExpense({ isRecurring: true }, 200)).toBe(false);
    expect(isRecurringExpense({ recurring: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Surface 3 — bill → monthly-statement entries.
// ---------------------------------------------------------------------------
const BILL_TERM = 2026070100;
let buildStatementEntries;

beforeAll(async () => {
  ({ buildStatementEntries } = await import('../managers/billmanager.js'));
});

describe('Surface 3 — a confirmed bill of a NEW type reaches the statement', () => {
  NEW_2026_08_TYPES.forEach((type) => {
    it(`'${type}': the bill's full amount arrives as its own entry`, () => {
      const building = {
        // A per-apartment bill must never be χιλιοστά-split (validators
        // .validateTypeAllocationCompatible), so single_unit is the real shape.
        expenses: [
          {
            _id: 'e-new',
            name: 'Λογαριασμός Α1',
            type,
            allocationMethod: 'single_unit'
          },
          {
            _id: 'e-old',
            name: 'Κοινόχρηστα',
            allocationMethod: 'equal'
          }
        ],
        units: [
          {
            propertyId: PROPERTY_ID,
            monthlyCharges: [
              {
                expenseId: 'e-old',
                term: BILL_TERM,
                amount: 30,
                inputAmount: 60,
                description: 'Κοινόχρηστα'
              }
            ]
          }
        ]
      };
      const entries = buildStatementEntries(
        building,
        'e-new',
        87.4,
        'Λογαριασμός Α1',
        BILL_TERM
      );
      const byId = Object.fromEntries(entries.map((e) => [e.expenseId, e]));
      expect({ type, entry: byId['e-new'] }).toEqual({
        type,
        entry: {
          expenseId: 'e-new',
          amount: 87.4,
          description: 'Λογαριασμός Α1'
        }
      });
      // …and the sibling κοινόχρηστο charge survives at its FULL figure.
      // saveMonthlyStatement strips the term and rebuilds from this set, so a
      // dropped sibling is silent data loss for the whole month.
      expect(byId['e-old'].amount).toBe(60);
      expect(entries).toHaveLength(2);
    });
  });

  it('a single_unit new-type expense is NOT scaled by the thousandths ratio', () => {
    // reconstructLegacy scales a legacy shareSum up by total/managed χιλιοστά.
    // A per-apartment bill has no χιλιοστά basis; scaling it would invent money
    // on the very type introduced to stop a private bill being split.
    const entries = buildStatementEntries(
      {
        expenses: [
          {
            _id: 'e-priv',
            name: 'Ρεύμα Α1',
            type: 'electricity_private',
            allocationMethod: 'single_unit'
          }
        ],
        units: [
          {
            propertyId: PROPERTY_ID,
            generalThousandths: 300,
            monthlyCharges: [
              // legacy row: no inputAmount → reconstruction path
              { expenseId: 'e-priv', term: BILL_TERM, amount: 87.4 }
            ]
          },
          { generalThousandths: 700 } // unmanaged
        ]
      },
      'other',
      10,
      'Άλλο',
      BILL_TERM
    );
    expect(entries.find((e) => e.expenseId === 'e-priv').amount).toBe(87.4);
  });

  it('a repair row (expenseId null / repairId set) is never echoed as an expense', () => {
    // A repair sibling sent as {expenseId:'null'} 422s the whole statement save,
    // which would leave the confirmed bill charged to nobody.
    const entries = buildStatementEntries(
      {
        expenses: [
          { _id: 'e-new', name: 'Νερό Α1', type: 'water_private' }
        ],
        units: [
          {
            propertyId: PROPERTY_ID,
            monthlyCharges: [
              {
                expenseId: null,
                repairId: 'r1',
                term: BILL_TERM,
                amount: 70,
                description: 'Επισκευή'
              },
              // a repair row that (legacy) also carries an expenseId must still
              // be skipped — repairId is the discriminator, not a null id.
              {
                expenseId: 'e-legacy-repair',
                repairId: 'r2',
                term: BILL_TERM,
                amount: 40,
                description: 'Επισκευή 2'
              }
            ]
          }
        ]
      },
      'e-new',
      45.5,
      'Νερό Α1',
      BILL_TERM
    );
    expect(entries).toEqual([
      { expenseId: 'e-new', amount: 45.5, description: 'Νερό Α1' }
    ]);
    expect(entries.some((e) => String(e.expenseId) === 'null')).toBe(false);
    expect(entries.some((e) => e.expenseId === 'e-legacy-repair')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Surfaces 4 + 5 — the type→label map and the six PDF locales.
//
// lineLabels.js lives in the landlord workspace. It IS importable from here
// (plain ESM, no browser globals at module scope) and is imported for real
// below; invoicebody.ejs is an EJS template, so its copy of the map is parsed
// as text. Both must agree with each other AND with the schema enum.
// ---------------------------------------------------------------------------
const LOCALE_DIR = path.join(REPO, 'services/pdfgenerator/templates/locales');
const LOCALE_FILES = fs
  .readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json'));

const parseLabelMap = (src, marker) => {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`marker ${marker} not found`);
  const open = src.indexOf('{', start);
  const close = src.indexOf('};', open);
  if (open < 0 || close < 0) throw new Error('label map body not found');
  const body = src.slice(open + 1, close).replace(/\/\/[^\n]*/g, '');
  const map = {};
  for (const m of body.matchAll(/([a-z_]+)\s*:\s*'([^']+)'/g)) {
    map[m[1]] = m[2];
  }
  return map;
};

let LINE_LABEL_MAP;
let EJS_LABEL_MAP;

beforeAll(async () => {
  const mod = await import(
    '../../../../webapps/landlord/src/utils/lineLabels.js'
  );
  // Cross-workspace import: the landlord file sits outside this package's
  // rootDir, so jest transforms it through the CJS interop and the named
  // exports arrive under `default`. Accept either shape — this is the REAL
  // module, not a text parse.
  LINE_LABEL_MAP =
    mod.BUILDING_TYPE_LABEL_KEY || mod.default?.BUILDING_TYPE_LABEL_KEY;
  EJS_LABEL_MAP = parseLabelMap(
    fs.readFileSync(
      path.join(REPO, 'services/pdfgenerator/templates/partials/invoicebody.ejs'),
      'utf8'
    ),
    'var BUILDING_TYPE_LABEL_KEY'
  );
});

describe('Surfaces 4+5 — every type has a label, in every locale', () => {
  it('the parses are non-trivial (an emptied map would pass everything below)', () => {
    expect(LINE_LABEL_MAP).toBeDefined();
    expect(Object.keys(LINE_LABEL_MAP).length).toBeGreaterThanOrEqual(16);
    expect(Object.keys(EJS_LABEL_MAP).length).toBeGreaterThanOrEqual(16);
    expect(LOCALE_FILES).toHaveLength(6);
  });

  it('BUILDING_TYPE_LABEL_KEY covers all 16 schema types', () => {
    const missing = SCHEMA_EXPENSE_TYPES.filter((t) => !LINE_LABEL_MAP[t]);
    // An unmapped type falls back to 'Other', so «Ρεύμα διαμερίσματος» would
    // print as «Λοιπά» on a payment line and on the receipt — the amount is
    // right and the reason is gone.
    expect(missing).toEqual([]);
  });

  it('the PDF template map is IDENTICAL to the landlord map', () => {
    // Two copies of one label rule is one edit away from two answers: the same
    // charge would read «Κοινόχρηστο Ρεύμα» on screen and «Ηλεκτρισμός» on the
    // receipt the tenant receives.
    const shared = {};
    for (const k of Object.keys(LINE_LABEL_MAP)) shared[k] = LINE_LABEL_MAP[k];
    expect(EJS_LABEL_MAP).toEqual(shared);
  });

  LOCALE_FILES.forEach((file) => {
    it(`${file} translates every label key used by invoicebody.ejs`, () => {
      const dict = JSON.parse(
        fs.readFileSync(path.join(LOCALE_DIR, file), 'utf8')
      );
      const labels = [...new Set(Object.values(EJS_LABEL_MAP))];
      const missing = labels.filter(
        (l) => typeof dict[l] !== 'string' || dict[l].trim() === ''
      );
      // i18n returns the key verbatim on a miss, so a missing el.json entry
      // does not throw — it prints "Electricity Private" on a Greek receipt
      // sent to a Greek tenant. Only a test can see that.
      expect({ locale: file, missing }).toEqual({ locale: file, missing: [] });
    });
  });

  it('el.json gives the five new types DISTINCT Greek labels', () => {
    // A copy-paste that leaves two types sharing one label reproduces the
    // shipped identical-dropdown-options bug: the tenant cannot tell which
    // bill they are being charged for.
    const dict = JSON.parse(
      fs.readFileSync(path.join(LOCALE_DIR, 'el.json'), 'utf8')
    );
    const greek = NEW_2026_08_TYPES.map((t) => dict[LINE_LABEL_MAP[t]]);
    expect(new Set(greek).size).toBe(NEW_2026_08_TYPES.length);
    // …and distinct from their κοινόχρηστο counterparts.
    expect(dict[LINE_LABEL_MAP.electricity_private]).not.toBe(
      dict[LINE_LABEL_MAP.electricity_common]
    );
    expect(dict[LINE_LABEL_MAP.water_private]).not.toBe(
      dict[LINE_LABEL_MAP.water_common]
    );
    // Greek receipts must not leak a Latin label.
    for (const g of greek) expect(/[Α-Ωα-ωίΐόάέύϊήώ]/.test(g)).toBe(true);
  });
});
