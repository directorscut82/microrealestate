/* eslint-env node */
/**
 * The SERVER-SIDE EXPENSE INPUT MATRIX.
 *
 * An expense is the only object in this system where a landlord's typed value
 * becomes a recurring charge on somebody else's rent, every month, forever. The
 * browser form is not the gate — `services/api/src/validators.ts` is: the
 * ExpenseFormDialog filters its own dropdowns, but a direct REST call, a stale
 * client bundle, or a partial PATCH from another tab reaches these functions with
 * whatever it likes. Everything the form would have prevented has to be prevented
 * here or it is not prevented.
 *
 * Two seams, deliberately both:
 *
 *   A. THE VALIDATORS THEMSELVES (exported, pure). Every expense field × the full
 *      hostile input row: valid / absent / null / '' / 0 / negative / >1e7 /
 *      non-numeric string / Greek decimal comma / padded whitespace / wrong JS
 *      type / outside-the-enum. Each rejection must be a ServiceError carrying
 *      statusCode 422 (not a TypeError, not a 500), and each acceptance must
 *      return the NORMALISED value, because the manager writes the validator's
 *      return value in several places.
 *
 *   B. THE WIRING (the real addExpense / updateExpense in buildingmanager.ts).
 *      A validator that exists and is never called is decoration. Layer B drives
 *      the real handlers and makes `Collections.Building.findOne` throw a
 *      sentinel: a rejection proves the guard fired BEFORE the database, and the
 *      sentinel proves the input was accepted all the way through the validation
 *      phase. This is the only layer that can see the min/max OPTIONS
 *      (amount ≤ €10.000.000), the required-ness, and the ORDER — and the order
 *      is load-bearing: two of the findings below are ordering defects.
 *
 * The enum lists are PARSED OUT OF THE SCHEMA (services/common/collections/
 * building.ts), never mirrored — on 2026-08-12 five expense types were added and
 * a sibling suite stayed green because it held a hand-copied list. A test that
 * mirrors the thing it guards cannot see drift in the thing it guards.
 *
 * Synthetic data only (public repo): ΟΔΟΣ ΑΛΦΑ/ΒΗΤΑ placeholders, 999-prefixed
 * supply numbers.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Collections } from '@microrealestate/common';
import {
  ALLOCATION_METHODS,
  EXPENSE_TYPES,
  validateAllocationValues,
  validateArrayMaxLength,
  validateBooleanField,
  validateCurrency,
  validateEnum,
  validateFiniteNumber,
  validateFixedAllocations,
  validatePercentageAllocations,
  validateRatioAllocations,
  validateSingleUnitAllocations,
  validateStringField,
  validateStringLength,
  validateTerm,
  validateTypeAllocationCompatible
} from '../validators.js';
import { addExpense, updateExpense } from '../managers/buildingmanager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(
  path.resolve(HERE, '../../../common/src/collections/building.ts'),
  'utf8'
);

// ---------------------------------------------------------------------------
// Schema enum parse. Technique lifted from propertymanager.classifyExpense
// .test.js, including its integrity guard: the schema's own comments contain
// commas AND apostrophes, and an earlier version of that parse silently dropped
// `electricity_private` while still passing. Strip comments, harvest literals,
// then prove nothing was lost.
// ---------------------------------------------------------------------------
function schemaEnum(fieldMarker, floor) {
  const schemaStart = SCHEMA.indexOf('const BuildingExpenseSchema');
  if (schemaStart < 0) throw new Error('BuildingExpenseSchema not found');
  const fieldStart = SCHEMA.indexOf(fieldMarker, schemaStart);
  if (fieldStart < 0) throw new Error(`${fieldMarker} not found`);
  const enumStart = SCHEMA.indexOf('enum: [', fieldStart);
  if (enumStart < 0) throw new Error(`enum for ${fieldMarker} not found`);
  // Strip the comments BEFORE looking for the closing bracket, not after: the
  // allocationMethod enum's own comment contains «customAllocations[0]», and
  // cutting on the first ']' truncated the parse at 8 of 9 values — with the
  // quoted-literal count agreeing, because it counted the truncated body. Only
  // the floor check below caught it.
  const decommented = SCHEMA.slice(enumStart + 'enum: ['.length).replace(
    /\/\/[^\n]*/g,
    ''
  );
  const enumEnd = decommented.indexOf(']');
  if (enumEnd < 0) throw new Error(`enum end for ${fieldMarker} not found`);
  const body = decommented.slice(0, enumEnd);
  const values = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const quoted = (body.match(/'/g) || []).length / 2;
  if (values.length !== quoted) {
    throw new Error(
      `${fieldMarker}: parsed ${values.length} values but found ${quoted} quoted literals`
    );
  }
  if (values.length < floor) {
    throw new Error(
      `${fieldMarker}: parsed only ${values.length} values (floor ${floor})`
    );
  }
  return values;
}

const SCHEMA_TYPES = schemaEnum('type: {', 16);
const SCHEMA_METHODS = schemaEnum('allocationMethod: {', 9);

const PRIVATE_TYPES = SCHEMA_TYPES.filter((t) => t.endsWith('_private'));
const COMMON_TYPES = SCHEMA_TYPES.filter((t) => t.endsWith('_common'));
const THOUSANDTHS_METHODS = SCHEMA_METHODS.filter((m) =>
  m.endsWith('_thousandths')
);

// ---------------------------------------------------------------------------
// Labelled outcome helpers. jest's expect() takes exactly ONE argument, so the
// case name travels inside the compared object (`expect(x, 'msg')` is the
// Playwright API and throws here).
// ---------------------------------------------------------------------------
const outcome = (fn) => {
  try {
    return { threw: false, value: fn() };
  } catch (e) {
    return {
      threw: true,
      kind: e?.constructor?.name,
      status: e?.statusCode,
      message: String(e?.message)
    };
  }
};

/** A refusal is only correct if it is a 422 ServiceError naming the field. */
const expectRejected = (label, fn, messageRe) => {
  const r = outcome(fn);
  expect({ case: label, threw: r.threw, status: r.status }).toEqual({
    case: label,
    threw: true,
    status: 422
  });
  if (messageRe) {
    expect({ case: label, message: r.message }).toEqual({
      case: label,
      message: expect.stringMatching(messageRe)
    });
  }
};

/** An acceptance must return the NORMALISED value the manager will persist. */
const expectAccepted = (label, fn, value) => {
  const r = outcome(fn);
  expect({
    case: label,
    threw: r.threw,
    value: r.value,
    why: r.message
  }).toEqual({ case: label, threw: false, value, why: undefined });
};

/**
 * A NON-422 throw. Reserved for the documented ordering defects: an input that
 * blows up inside a validator instead of being refused by it reaches the express
 * error handler as a 500, so the landlord sees «κάτι πήγε λάθος» rather than
 * which field is wrong — and a 500 is what a monitoring alert reads as an outage.
 */
const expectCrash = (label, fn, kind = 'TypeError') => {
  const r = outcome(fn);
  expect({
    case: label,
    threw: r.threw,
    kind: r.kind,
    status: r.status
  }).toEqual({ case: label, threw: true, kind, status: undefined });
};

// ---------------------------------------------------------------------------
// The hostile input row, shared by every field so no field gets a softer test
// than its neighbour.
// ---------------------------------------------------------------------------
const WRONG_TYPES = [
  ['array', []],
  ['array-of-one', ['heating']],
  ['object', {}],
  ['true', true],
  ['false', false]
];

describe("the enum lists are the SCHEMA's, not a copy of it", () => {
  it('EXPENSE_TYPES is exactly BuildingExpenseSchema.type — all 16, no extras', () => {
    // validators.ts keeps its own copy of the enum (it cannot import the
    // mongoose schema without dragging mongoose into every handler). The copy is
    // the drift risk: a type accepted by the schema but missing here is refused
    // with 422 at the API even though the database would store it, and a type
    // present here but not in the schema is accepted by the API and then dropped
    // by mongoose — money with no row, on the type that was added to carry it.
    expect([...EXPENSE_TYPES].sort()).toEqual([...SCHEMA_TYPES].sort());
  });

  it('ALLOCATION_METHODS is exactly BuildingExpenseSchema.allocationMethod — all 9', () => {
    expect([...ALLOCATION_METHODS].sort()).toEqual([...SCHEMA_METHODS].sort());
  });

  it('the parse itself is non-trivial (an empty parse would pass everything above)', () => {
    // Both lists were harvested by regex. If the harvest silently returned [] the
    // two assertions above become vacuous, so pin the shapes the rest of this
    // file depends on.
    expect(SCHEMA_TYPES).toHaveLength(16);
    expect(SCHEMA_METHODS).toHaveLength(9);
    expect(PRIVATE_TYPES.sort()).toEqual([
      'electricity_private',
      'gas_private',
      'telecom_private',
      'water_private'
    ]);
    expect(COMMON_TYPES.sort()).toEqual([
      'electricity_common',
      'telecom_common',
      'water_common'
    ]);
    expect(THOUSANDTHS_METHODS.sort()).toEqual([
      'elevator_thousandths',
      'general_thousandths',
      'heating_thousandths'
    ]);
  });
});

describe('expense.type — validateEnum(value, EXPENSE_TYPES, required)', () => {
  SCHEMA_TYPES.forEach((type) => {
    it(`'${type}' is accepted and returned verbatim`, () => {
      // Verbatim matters: addExpense pushes req.body (not the return value), so
      // the string the validator blessed is the string mongoose stores and every
      // type→category / type→label map keys on.
      expectAccepted(
        `type/${type}`,
        () => validateEnum(type, EXPENSE_TYPES, 'type', { required: true }),
        type
      );
    });
  });

  it('absent / null / empty-string are all «type is required» 422s', () => {
    // `type` is required:true on the CREATE path. If any of these three returned
    // undefined instead, mongoose's own `required: true` would 500 on save
    // instead of 422-ing the field.
    for (const [label, v] of [
      ['undefined', undefined],
      ['null', null],
      ['empty-string', '']
    ]) {
      expectRejected(
        `type/${label}`,
        () => validateEnum(v, EXPENSE_TYPES, 'type', { required: true }),
        /type is required/
      );
    }
  });

  it('a value outside the enum is 422 and the message lists the legal set', () => {
    for (const bad of [
      'heating_private',
      'water',
      'electricity',
      'κοινόχρηστα',
      'by_the_moon'
    ]) {
      expectRejected(
        `type/outside/${bad}`,
        () => validateEnum(bad, EXPENSE_TYPES, 'type', { required: true }),
        /Invalid type/
      );
    }
  });

  it('0 and negative numbers are 422, not coerced', () => {
    for (const [label, v] of [
      ['zero', 0],
      ['negative', -1],
      ['huge', 99999999]
    ]) {
      expectRejected(`type/${label}`, () =>
        validateEnum(v, EXPENSE_TYPES, 'type', { required: true })
      );
    }
  });

  WRONG_TYPES.forEach(([label, v]) => {
    it(`a ${label} type is 422 (never unwrapped to its first element)`, () => {
      // ['heating'] is the shape a duplicated form field produces. Accepting it
      // would store an array in a String field: mongoose casts it to 'heating'
      // and the money is right by luck, or to 'heating,elevator' and every
      // consumer's switch falls through to «Λοιπά».
      expectRejected(`type/${label}`, () =>
        validateEnum(v, EXPENSE_TYPES, 'type', { required: true })
      );
    });
  });

  it('DOCUMENTS: the enum check neither trims nor case-folds', () => {
    // ' heating ' is what a copy-paste out of a spreadsheet column carries, and
    // 'Heating' is what a hand-written REST call sends. Both are refused. That is
    // the SAFE direction (nothing malformed is stored) but it is inconsistent
    // with validateStringField, which trims the expense name — so the same
    // padded payload gets a clean name and a 422 type. Pinned so a future
    // «be lenient, trim it» change is a deliberate one.
    for (const bad of [
      ' heating',
      'heating ',
      ' heating ',
      'Heating',
      'HEATING'
    ]) {
      expectRejected(
        `type/untrimmed/${JSON.stringify(bad)}`,
        () => validateEnum(bad, EXPENSE_TYPES, 'type', { required: true }),
        /Invalid type/
      );
    }
  });
});

describe('expense.allocationMethod — validateEnum(value, ALLOCATION_METHODS)', () => {
  SCHEMA_METHODS.forEach((method) => {
    it(`'${method}' is accepted and returned verbatim`, () => {
      expectAccepted(
        `method/${method}`,
        () =>
          validateEnum(method, ALLOCATION_METHODS, 'allocationMethod', {
            required: true
          }),
        method
      );
    });
  });

  it('absent / null / empty-string are required-422 on CREATE but a NO-OP on PATCH', () => {
    // The asymmetry is real and intentional: addExpense passes {required:true},
    // updateExpense gates the call behind `if (req.body.allocationMethod)`. A
    // PATCH that omits the method keeps the persisted one — which is why the
    // merged-method block exists in updateExpense, and why the compatibility
    // hole further down is reachable.
    for (const [label, v] of [
      ['undefined', undefined],
      ['null', null],
      ['empty-string', '']
    ]) {
      expectRejected(
        `method/create/${label}`,
        () =>
          validateEnum(v, ALLOCATION_METHODS, 'allocationMethod', {
            required: true
          }),
        /allocationMethod is required/
      );
      expectAccepted(
        `method/patch/${label}`,
        () => validateEnum(v, ALLOCATION_METHODS, 'allocationMethod'),
        undefined
      );
    }
  });

  it('near-miss and unknown methods are 422', () => {
    // 'thousandths' / 'percentage' are the names a human would guess. An
    // unknown method is not inert: 1_base's switch has no default branch, so it
    // charges NOBODY (allocationMatrix.test.js «unknown-method»). A €200
    // κοινόχρηστο would exist with no charge row anywhere.
    for (const bad of [
      'thousandths',
      'percentage',
      'general',
      'per_surface',
      'single',
      'GENERAL_THOUSANDTHS'
    ]) {
      expectRejected(
        `method/outside/${bad}`,
        () => validateEnum(bad, ALLOCATION_METHODS, 'allocationMethod'),
        /Invalid allocationMethod/
      );
    }
  });

  WRONG_TYPES.forEach(([label, v]) => {
    it(`a ${label} allocationMethod is 422`, () => {
      expectRejected(`method/${label}`, () =>
        validateEnum(v, ALLOCATION_METHODS, 'allocationMethod', {
          required: true
        })
      );
    });
  });
});

describe("type × allocationMethod — one flat's bill must never split across the building", () => {
  // The full cross-product, generated from the parsed schema: every future
  // `*_private` type and every future `*_thousandths` method joins this matrix
  // automatically. 4 × 3 = 12 refusals today.
  PRIVATE_TYPES.forEach((type) => {
    THOUSANDTHS_METHODS.forEach((method) => {
      it(`${type} × ${method} is REFUSED`, () => {
        expectRejected(
          `${type}×${method}`,
          () => validateTypeAllocationCompatible(type, method),
          /χιλιοστά/
        );
      });
    });
  });

  COMMON_TYPES.forEach((type) => {
    THOUSANDTHS_METHODS.forEach((method) => {
      it(`${type} × ${method} is ACCEPTED (this is what χιλιοστά are for)`, () => {
        // The refusal must key on the `_private` suffix and nothing else. A guard
        // that over-fired here would break the single most common Greek expense
        // shape — κοινόχρηστο ρεύμα split by general χιλιοστά.
        expectAccepted(
          `${type}×${method}`,
          () => validateTypeAllocationCompatible(type, method),
          undefined
        );
      });
    });
  });

  it('every non-private type is ACCEPTED on every thousandths method', () => {
    for (const type of SCHEMA_TYPES.filter((t) => !t.endsWith('_private'))) {
      for (const method of THOUSANDTHS_METHODS) {
        expectAccepted(
          `${type}×${method}`,
          () => validateTypeAllocationCompatible(type, method),
          undefined
        );
      }
    }
  });

  it('every private type is ACCEPTED on every non-thousandths method', () => {
    // single_unit is the shape the bill-import prefill proposes for a private
    // bill; `equal`/`by_surface`/`fixed`/`custom_*` are legitimate too (two flats
    // sharing one meter). Only the χιλιοστά family is wrong.
    const others = SCHEMA_METHODS.filter((m) => !m.endsWith('_thousandths'));
    for (const type of PRIVATE_TYPES) {
      for (const method of others) {
        expectAccepted(
          `${type}×${method}`,
          () => validateTypeAllocationCompatible(type, method),
          undefined
        );
      }
    }
  });

  it('BUG (documented, not fixed): a HALF-payload passes the compatibility check', () => {
    // `if (typeof type !== 'string' || typeof allocationMethod !== 'string')
    // return;` — the pair is unvalidated whenever either half is absent. Both
    // call sites (buildingmanager.ts:4661 add, :4789 update) pass the RAW BODY,
    // and updateExpense's merged-method block (which re-runs the percentage /
    // ratio / fixed / single_unit validators against the EFFECTIVE method) does
    // NOT re-run this one. So a PATCH carrying only `{type:'electricity_private'}`
    // on a stored general_thousandths expense — the exact scenario this
    // validator's own docstring says it exists to prevent — is accepted, and one
    // apartment's €87,40 keeps splitting across the building every month.
    // Layer B drives that end to end through the real handler.
    for (const [label, args] of [
      ['type only', ['electricity_private', undefined]],
      ['type only/null method', ['electricity_private', null]],
      ['method only', [undefined, 'general_thousandths']],
      ['method only/null type', [null, 'general_thousandths']],
      ['both absent', [undefined, undefined]]
    ]) {
      expectAccepted(
        `compat/half/${label}`,
        () => validateTypeAllocationCompatible(args[0], args[1]),
        undefined
      );
    }
  });

  it('a non-string half is ignored rather than refused', () => {
    // Same bail-out, reached by a wrong TYPE instead of an absence. Harmless in
    // composition (validateEnum 422s these first) — recorded so nobody «fixes»
    // the enum order and assumes this guard is a second line of defence.
    for (const [label, v] of WRONG_TYPES) {
      expectAccepted(
        `compat/wrongtype/${label}`,
        () => validateTypeAllocationCompatible(v, 'general_thousandths'),
        undefined
      );
      expectAccepted(
        `compat/wrongmethod/${label}`,
        () => validateTypeAllocationCompatible('electricity_private', v),
        undefined
      );
    }
  });
});

describe('expense.isVariable — κυμαινόμενο accepts ONLY a real boolean', () => {
  // This flag is the difference between «€0 means the statement has not arrived»
  // and «€0 means this expense is free». Mongoose would cast 'no', '0', 0 and []
  // to a boolean happily, so one typo in a payload silently reclassifies owner
  // money on the Ετήσια προβολή tile (newExpenseTypesReachMoneySurfaces
  // .test.js: the same row is €1440 or €0 depending on this flag).
  it('true and false round-trip unchanged', () => {
    expectAccepted(
      'isVariable/true',
      () => validateBooleanField(true, 'isVariable'),
      true
    );
    expectAccepted(
      'isVariable/false',
      () => validateBooleanField(false, 'isVariable'),
      false
    );
  });

  it('ABSENT is the third legal state and returns undefined', () => {
    // Not false — absent means «legacy row, use the old recurring && amount===0
    // inference». building.ts documents why the schema default is `undefined`:
    // stamping false onto legacy subdocs reclassified every κυμαινόμενο row in
    // the building the next time an unrelated expense was deleted.
    expectAccepted(
      'isVariable/absent',
      () => validateBooleanField(undefined, 'isVariable'),
      undefined
    );
  });

  it("the brief's five truthy impostors are every one of them 422", () => {
    for (const [label, v] of [
      ['"yes"', 'yes'],
      ['1', 1],
      ['[]', []],
      ['"false"', 'false'],
      ['{}', {}]
    ]) {
      expectRejected(
        `isVariable/${label}`,
        () => validateBooleanField(v, 'isVariable'),
        /isVariable must be true or false/
      );
    }
  });

  it('every other near-boolean spelling is 422 too', () => {
    for (const v of [
      'true',
      'no',
      'on',
      'off',
      '0',
      '1',
      0,
      -1,
      NaN,
      [true],
      { value: true }
    ]) {
      expectRejected(`isVariable/${JSON.stringify(v) ?? String(v)}`, () =>
        validateBooleanField(v, 'isVariable')
      );
    }
  });

  it('NULL is 422 even though ABSENT is fine — the JSON trap', () => {
    // JSON has no `undefined`: a form that clears the checkbox by sending
    // `isVariable: null` gets a 422 while one that omits the key succeeds. Both
    // read as «not set» to the person filling the form. Pinned because the fix,
    // if ever wanted, is a one-word change here (`=== undefined` →
    // `== null`) and it must be a deliberate one.
    expectRejected(
      'isVariable/null',
      () => validateBooleanField(null, 'isVariable'),
      /must be true or false/
    );
    expectRejected(
      'isVariable/empty-string',
      () => validateBooleanField('', 'isVariable'),
      /must be true or false/
    );
  });
});

describe('expense.amount / expense.ownerAmount — validateFiniteNumber(min 0, max 1e7)', () => {
  const MONEY = { min: 0, max: 10000000 };
  const amount = (v) => validateFiniteNumber(v, 'amount', MONEY);

  it('a plain number and its STRING spelling both normalise to the number', () => {
    // The manager stores req.body.amount, not this return value — but four other
    // call sites do use the return, and the CSV/PDF path formats it. A validator
    // that returned the string would put "200" into arithmetic.
    expectAccepted('amount/number', () => amount(200), 200);
    expectAccepted('amount/decimal', () => amount(87.4), 87.4);
    expectAccepted('amount/string', () => amount('200'), 200);
    expectAccepted('amount/string-decimal', () => amount('87.40'), 87.4);
  });

  it('absent / null / empty-string return undefined (amount defaults to 0 in the schema)', () => {
    for (const [label, v] of [
      ['undefined', undefined],
      ['null', null],
      ['empty-string', '']
    ]) {
      expectAccepted(`amount/${label}`, () => amount(v), undefined);
    }
  });

  it('0 is ACCEPTED — it is the κυμαινόμενο state, not a missing value', () => {
    // Refusing €0 here would make it impossible to record an electricity expense
    // before the ΔΕΗ statement arrives, which is precisely the case isVariable
    // was added for.
    expectAccepted('amount/zero', () => amount(0), 0);
    expectAccepted('amount/zero-string', () => amount('0'), 0);
  });

  it('negative is 422 — a negative expense pays the tenant', () => {
    for (const v of [-0.01, -1, -200, '-200']) {
      expectRejected(`amount/negative/${v}`, () => amount(v), /at least 0/);
    }
  });

  it('the €10.000.000 ceiling holds exactly, and above it is 422', () => {
    // The bound is not decoration: a mistyped ΔΕΗ figure (a pasted meter reading
    // instead of a total) becomes a monthly recurring charge, and by_surface /
    // χιλιοστά will happily distribute €1e12 across four flats.
    expectAccepted('amount/max-exact', () => amount(10000000), 10000000);
    expectRejected(
      'amount/max+1cent',
      () => amount(10000000.01),
      /at most 10000000/
    );
    expectRejected('amount/1e8', () => amount(1e8), /at most 10000000/);
    expectRejected(
      'amount/1e8-string',
      () => amount('1e8'),
      /at most 10000000/
    );
    expectRejected(
      'amount/huge',
      () => amount(99999999999),
      /at most 10000000/
    );
  });

  it('non-numeric strings are 422 and never reach the allocator as NaN', () => {
    // allocationMatrix.test.js «bad-amount»: NaN on a rent line propagates into
    // rent.total.charges and every dashboard sum downstream.
    for (const v of [
      'abc',
      'δεν υπάρχει',
      '200€',
      '€200',
      'Infinity',
      '--200'
    ]) {
      expectRejected(
        `amount/nonnumeric/${v}`,
        () => amount(v),
        /must be a valid number/
      );
    }
    expectRejected('amount/NaN', () => amount(NaN), /must be a valid number/);
    expectRejected(
      'amount/Infinity',
      () => amount(Infinity),
      /must be a valid number/
    );
    expectRejected(
      'amount/-Infinity',
      () => amount(-Infinity),
      /must be a valid number/
    );
  });

  it('the GREEK DECIMAL COMMA is refused — «12,50» is not €12.50 here', () => {
    // The landlord's keyboard and every Greek statement write 12,50. Number()
    // returns NaN, so the server 422s. The client must convert; if a future form
    // stops converting, the failure is a visible 422 rather than a silent NaN —
    // that is the right direction, and it is asserted so nobody «helpfully»
    // adds a comma-tolerant parse without also fixing the Σ-reconciliation
    // tests that assume 2-decimal cents.
    for (const v of ['12,50', '1.234,56', '0,01', '87,40']) {
      expectRejected(
        `amount/greek-comma/${v}`,
        () => amount(v),
        /must be a valid number/
      );
    }
  });

  it('DOCUMENTS: padded whitespace is silently accepted and normalised', () => {
    // Number(' 200 ') === 200. Harmless for money, but it means the padded
    // spreadsheet paste that 422s on `type` succeeds on `amount` — the same
    // payload gets two different answers from two validators.
    expectAccepted('amount/padded', () => amount(' 200 '), 200);
    expectAccepted('amount/newline', () => amount('200\n'), 200);
  });

  it('BUG (documented, not fixed): [] / [200] / true / "  " all become MONEY', () => {
    // Number() coerces before Number.isFinite() ever sees the shape, so:
    //   []      → €0   an expense that reads as κυμαινόμενο on every surface
    //   [200]   → €200 an array field is unwrapped and billed
    //   true    → €1   a boolean field becomes one euro
    //   false   → €0
    //   '   '   → €0   a whitespace-only amount silently bills nothing
    // The €0 cases are the dangerous half: with isRecurring true, a €0 amount is
    // inferred as «κυμαινόμενο» (isVariableExpense's legacy fallback), so a
    // malformed payload does not fail — it creates an expense the landlord will
    // be told is variable and will never see a figure for.
    expectAccepted('amount/empty-array', () => amount([]), 0);
    expectAccepted('amount/array-of-one', () => amount([200]), 200);
    expectAccepted('amount/array-of-one-string', () => amount(['200']), 200);
    expectAccepted('amount/true', () => amount(true), 1);
    expectAccepted('amount/false', () => amount(false), 0);
    expectAccepted('amount/whitespace-only', () => amount('   '), 0);
  });

  it('an object or a multi-element array IS refused', () => {
    // Number({}) and Number([1,2]) are NaN, so the coercion hole above is only
    // open for shapes that stringify to a number. Pinned so the boundary of the
    // hole is recorded, not just its existence.
    for (const [label, v] of [
      ['object', {}],
      ['nested', { amount: 200 }],
      ['array-of-two', [1, 2]],
      ['array-of-object', [{}]]
    ]) {
      expectRejected(
        `amount/${label}`,
        () => amount(v),
        /must be a valid number/
      );
    }
  });

  it('ownerAmount carries the IDENTICAL contract (same bounds, same holes)', () => {
    // Both call sites pass the same {min:0,max:1e7}. Asserted as a pair so a
    // future edit that loosens one and not the other shows up here: ownerAmount
    // is the owner's slice of the same euro, and the two are compared as a ratio.
    const owner = (v) => validateFiniteNumber(v, 'ownerAmount', MONEY);
    expectAccepted('ownerAmount/number', () => owner(50), 50);
    expectAccepted('ownerAmount/zero', () => owner(0), 0);
    expectAccepted('ownerAmount/absent', () => owner(undefined), undefined);
    expectRejected(
      'ownerAmount/negative',
      () => owner(-1),
      /ownerAmount must be at least 0/
    );
    expectRejected(
      'ownerAmount/over-max',
      () => owner(10000001),
      /ownerAmount must be at most 10000000/
    );
    expectRejected(
      'ownerAmount/greek-comma',
      () => owner('50,00'),
      /must be a valid number/
    );
  });

  it('BUG (documented, not fixed): ownerAmount may EXCEED amount — nothing cross-checks them', () => {
    // The owner ratio is ownerAmount/amount (buildingprojection). €500 of €100
    // is a ratio of 5, so the Ετήσια προβολή tile projects five times the
    // building's actual charges as owner debt. Each field is independently valid,
    // and no exported validator takes both — the pair is unguarded by
    // construction, which is why it needs a test rather than a comment.
    expectAccepted('cross/amount', () => amount(100), 100);
    expectAccepted(
      'cross/ownerAmount',
      () => validateFiniteNumber(500, 'ownerAmount', MONEY),
      500
    );
  });
});

describe('expense.startTerm / endTerm — validateTerm(YYYYMMDDHH)', () => {
  it('a number and its string spelling both normalise to the NUMBER', () => {
    // Terms are compared with `>=` against other terms all over the pipeline. A
    // string '2026010100' compares lexicographically in some paths and
    // numerically in others; normalising here is what keeps the active-term test
    // honest.
    expectAccepted(
      'term/number',
      () => validateTerm(2026010100, 'startTerm'),
      2026010100
    );
    expectAccepted(
      'term/string',
      () => validateTerm('2026010100', 'startTerm'),
      2026010100
    );
  });

  it('the [2020010100, 2099123100] window holds at both edges', () => {
    expectAccepted(
      'term/min',
      () => validateTerm(2020010100, 'startTerm'),
      2020010100
    );
    expectAccepted(
      'term/max',
      () => validateTerm(2099123100, 'endTerm'),
      2099123100
    );
    expectRejected(
      'term/below',
      () => validateTerm(2019123100, 'startTerm'),
      /out of valid range/
    );
    expectRejected(
      'term/above',
      () => validateTerm(2100010100, 'startTerm'),
      /out of valid range/
    );
  });

  it('absent / null / empty / 0 are 422 — the caller must gate the call', () => {
    // validateTerm has no `required` option: String(undefined) is 'undefined'
    // and fails the shape test. Both handlers therefore wrap it in
    // `if (req.body.startTerm)`, and a separate explicit guard supplies the real
    // «startTerm is required» message (Layer B).
    for (const [label, v] of [
      ['undefined', undefined],
      ['null', null],
      ['empty-string', ''],
      ['zero', 0],
      ['negative', -2026010100]
    ]) {
      expectRejected(
        `term/${label}`,
        () => validateTerm(v, 'startTerm'),
        /Invalid startTerm format/
      );
    }
  });

  it('wrong digit counts, dates and separators are 422', () => {
    for (const bad of [
      '202601',
      '20260101',
      '202601010',
      '20260101000',
      '2026-01-01',
      '01/01/2026',
      '2026010100.5',
      ' 2026010100',
      '2026010100 ',
      '2026,010100'
    ]) {
      expectRejected(
        `term/shape/${JSON.stringify(bad)}`,
        () => validateTerm(bad, 'startTerm'),
        /Invalid startTerm format/
      );
    }
  });

  WRONG_TYPES.filter(([l]) => l !== 'array-of-one').forEach(([label, v]) => {
    it(`a ${label} term is 422`, () => {
      expectRejected(`term/${label}`, () => validateTerm(v, 'startTerm'));
    });
  });

  it('DOCUMENTS: a one-element ARRAY passes, because the check is String()-based', () => {
    // String([2026010100]) === '2026010100'. It normalises to the right number,
    // so this is benign today — but it is the same String()-coercion that lets
    // the impossible dates below through, and it means `validateTerm` cannot be
    // relied on as a type guard by a new caller.
    expectAccepted(
      'term/array-of-one',
      () => validateTerm([2026010100], 'startTerm'),
      2026010100
    );
  });

  it('BUG (documented, not fixed): month 13, month 00 and day 32 are ACCEPTED terms', () => {
    // TERM_RE is `^\d{10}$` and the only other test is a numeric range, so any
    // 10-digit number inside the window passes. The rent pipeline compares terms
    // as YYYYMM integers, so 2026133100 sorts after December 2026 and matches no
    // rent month: the expense exists, is active «from month 13», and bills
    // nobody, on every surface, with no error anywhere. That is the
    // absent-representation shape — invisible reads as correct.
    for (const impossible of [
      '2026133100', // month 13
      '2026003100', // month 00
      '2026013200', // day 32
      '2026019900', // day 99
      '2026999900'
    ]) {
      expectAccepted(
        `term/impossible/${impossible}`,
        () => validateTerm(impossible, 'startTerm'),
        Number(impossible)
      );
    }
  });

  it('the field name travels into the message (startTerm vs endTerm)', () => {
    // Two term fields on one form: a message that always said «term» would send
    // the landlord to the wrong input.
    expectRejected(
      'term/name/start',
      () => validateTerm('x', 'startTerm'),
      /startTerm/
    );
    expectRejected(
      'term/name/end',
      () => validateTerm('x', 'endTerm'),
      /endTerm/
    );
    expectRejected(
      'term/name/end-range',
      () => validateTerm(2100010100, 'endTerm'),
      /endTerm out of valid range/
    );
  });
});

describe('expense.name / notes / billingId — the string validators', () => {
  // NOTE ON WIRING: neither addExpense nor updateExpense calls these for an
  // expense. `name` is guarded by an inline `if (!req.body.name?.trim())`, and
  // `notes` / `billingId` are unvalidated free `String` schema fields. The
  // contracts below are therefore the contract of the guard that SHOULD be
  // reachable — locked here so that wiring it later is a one-line change with
  // its behaviour already pinned, and so the gap is documented in a place that
  // runs. Layer B measures what the inline guard actually does with a non-string
  // name (it is not a 422).
  it('a Greek name round-trips TRIMMED — the normalisation the manager needs', () => {
    // The trimmed value matters beyond tidiness: _stampLegacyChargesBeforeRename
    // and the bill matcher compare expense names by exact string, so a padded
    // «ΚΟΙΝΟΧΡΗΣΤΑ » is a different expense from «ΚΟΙΝΟΧΡΗΣΤΑ» and the legacy
    // monthly charges never get stamped with its id.
    expectAccepted(
      'name/greek',
      () => validateStringField('ΚΟΙΝΟΧΡΗΣΤΑ ΟΔΟΣ ΑΛΦΑ', 'name', { max: 200 }),
      'ΚΟΙΝΟΧΡΗΣΤΑ ΟΔΟΣ ΑΛΦΑ'
    );
    expectAccepted(
      'name/padded',
      () => validateStringField('  ΟΔΟΣ ΒΗΤΑ 3  ', 'name', { max: 200 }),
      'ΟΔΟΣ ΒΗΤΑ 3'
    );
  });

  it('absent / null / empty are undefined when optional and 422 when required', () => {
    for (const [label, v] of [
      ['undefined', undefined],
      ['null', null],
      ['empty-string', '']
    ]) {
      expectAccepted(
        `name/${label}`,
        () => validateStringField(v, 'name'),
        undefined
      );
      expectRejected(
        `name/required/${label}`,
        () => validateStringField(v, 'name', { required: true }),
        /name is required/
      );
    }
  });

  it("a whitespace-only required name is 422; optional, it collapses to ''", () => {
    expectRejected(
      'name/blank-required',
      () => validateStringField('   ', 'name', { required: true }),
      /name is required/
    );
    // Returned as an EMPTY STRING, not undefined — so a caller that writes the
    // return value stores '' and a caller that writes req.body stores '   '.
    expectAccepted(
      'name/blank-optional',
      () => validateStringField('   ', 'name'),
      ''
    );
  });

  it('every non-string name is a clean 422 (this is the guard the manager does NOT use)', () => {
    // 0 is in the list on purpose: it is neither `== null` nor `=== ''`, so it
    // falls through to the type check and reports «must be a string» rather than
    // «is required». Measured, not assumed — the first draft of this case
    // expected the required-message and was wrong.
    for (const [label, v] of [...WRONG_TYPES, ['number', 200], ['zero', 0]]) {
      expectRejected(
        `name/${label}`,
        () => validateStringField(v, 'name', { required: true }),
        /name must be a string/
      );
    }
  });

  it('min / max bounds fire on the name', () => {
    expectRejected(
      'name/too-short',
      () => validateStringField('Α', 'name', { min: 2 }),
      /at least 2 characters/
    );
    expectRejected(
      'name/too-long',
      () => validateStringField('Α'.repeat(201), 'name', { max: 200 }),
      /at most 200 characters/
    );
    expectAccepted(
      'name/exact-max',
      () => validateStringField('Α'.repeat(200), 'name', { max: 200 }),
      'Α'.repeat(200)
    );
  });

  it('BUG (documented, not fixed): max is measured on the UNTRIMMED value', () => {
    // `min` reads trimmed.length but `max` reads value.length, and the function
    // RETURNS the trimmed string. So a name whose trimmed form is exactly at the
    // limit is refused for being over it — the validator rejects a value it
    // would itself have normalised into a legal one.
    expectRejected(
      'name/padded-at-limit',
      () => validateStringField(' ' + 'Α'.repeat(200), 'name', { max: 200 }),
      /at most 200 characters/
    );
  });

  it('notes / billingId via validateStringLength: NOT trimmed, non-strings 422', () => {
    // The sibling validator with the {maxLength, minLength} shape. It returns the
    // value VERBATIM — the two string validators normalise differently, which is
    // why a field must not be moved between them casually.
    expectAccepted(
      'notes/padded',
      () => validateStringLength('  σημείωση  ', 1000, 'notes'),
      '  σημείωση  '
    );
    expectAccepted(
      'notes/absent',
      () => validateStringLength(undefined, 1000, 'notes'),
      undefined
    );
    expectAccepted(
      'notes/null',
      () => validateStringLength(null, 1000, 'notes'),
      undefined
    );
    expectAccepted(
      'notes/empty',
      () => validateStringLength('', 1000, 'notes'),
      undefined
    );
    expectRejected(
      'notes/too-long',
      () => validateStringLength('α'.repeat(1001), 1000, 'notes'),
      /at most 1000 characters/
    );
    for (const [label, v] of [...WRONG_TYPES, ['number', 999935585]]) {
      expectRejected(
        `notes/${label}`,
        () => validateStringLength(v, 1000, 'notes'),
        /notes must be a string/
      );
    }
    // A παροχή pasted with its ΔΕΗ check suffix is a legal billingId string.
    expectAccepted(
      'billingId/supply',
      () => validateStringLength('999935585-016', 40, 'billingId'),
      '999935585-016'
    );
  });
});

describe('expense.customAllocations — validateAllocationValues', () => {
  it('non-negative numbers and their string spellings pass', () => {
    expectAccepted(
      'values/ok',
      () =>
        validateAllocationValues([
          { propertyId: 'pA', value: 0 },
          { propertyId: 'pB', value: 70 },
          { propertyId: 'pC', value: 30.5 }
        ]),
      undefined
    );
    // NOTE: strings pass but are NOT normalised — nothing writes back, so '70'
    // is what mongoose casts. The allocator's Number() reads it correctly today.
    expectAccepted(
      'values/string',
      () => validateAllocationValues([{ propertyId: 'pA', value: '70' }]),
      undefined
    );
  });

  it('absent / null / empty array are all no-ops', () => {
    for (const [label, v] of [
      ['undefined', undefined],
      ['null', null],
      ['empty', []]
    ]) {
      expectAccepted(
        `values/${label}`,
        () => validateAllocationValues(v),
        undefined
      );
    }
  });

  it('a negative or non-finite value is 422 and names the INDEX', () => {
    // A negative share is a credit: the tenant's rent total goes DOWN by it, and
    // the `share > 0` row gate means no line explains why.
    expectRejected(
      'values/negative',
      () =>
        validateAllocationValues([
          { propertyId: 'pA', value: 10 },
          { propertyId: 'pB', value: -1 }
        ]),
      /index 1 must be a non-negative number/
    );
    for (const bad of [NaN, 'abc', '12,50', Infinity, {}, [1, 2]]) {
      expectRejected(
        `values/nonfinite/${String(bad)}`,
        () => validateAllocationValues([{ propertyId: 'pA', value: bad }]),
        /index 0 must be a non-negative number/
      );
    }
  });

  it('a row with NO value key is 422 — so the documented single_unit shape is refused', () => {
    // Number(undefined) is NaN. `[{propertyId}]` is exactly what
    // validateSingleUnitAllocations describes as sufficient, and what a REST
    // caller reading that docstring would send: it dies here instead, with a
    // message about a numeric value rather than about the missing one.
    expectRejected(
      'values/no-value-key',
      () => validateAllocationValues([{ propertyId: 'pA' }]),
      /index 0 must be a non-negative number/
    );
  });

  it('a DUPLICATE propertyId is 422 (the pipeline honours only the first row)', () => {
    // [{P,0.004},{P,0.006}] summed to a billable €0.01 for validateFixedAllocations
    // while billing €0, because 1_base resolves a unit's share with .find().
    expectRejected(
      'values/duplicate',
      () =>
        validateAllocationValues([
          { propertyId: 'pA', value: 0.004 },
          { propertyId: 'pA', value: 0.006 }
        ]),
      /duplicate entry for propertyId pA/
    );
    expectAccepted(
      'values/distinct',
      () =>
        validateAllocationValues([
          { propertyId: 'pA', value: 1 },
          { propertyId: 'pB', value: 1 }
        ]),
      undefined
    );
  });

  it('DOCUMENTS: an OBJECT customAllocations is a silent no-op here', () => {
    // `{}` is truthy and `{}.length` is undefined, so the `for i < length` loop
    // never runs. Nothing is validated and nothing is refused — the shape guard
    // is validateArrayMaxLength, and it runs LAST (see the crash case below).
    expectAccepted(
      'values/object',
      () => validateAllocationValues({}),
      undefined
    );
    expectAccepted(
      'values/number',
      () => validateAllocationValues(5000),
      undefined
    );
    expectAccepted(
      'values/true',
      () => validateAllocationValues(true),
      undefined
    );
  });

  it('a STRING customAllocations happens to 422 (its characters have no .value)', () => {
    expectRejected(
      'values/string',
      () => validateAllocationValues('pA'),
      /index 0 must be a non-negative number/
    );
  });
});

describe('customAllocations × fixed — the silent-€0 family', () => {
  const fixed = (a) => validateFixedAllocations(a, 'fixed');

  it('at least one cent of billable money passes; nothing does not', () => {
    expectAccepted(
      'fixed/ok',
      () => fixed([{ propertyId: 'pA', value: 70 }]),
      undefined
    );
    expectAccepted(
      'fixed/one-cent',
      () => fixed([{ propertyId: 'pA', value: 0.005 }]),
      undefined
    );
    for (const [label, a] of [
      ['absent', undefined],
      ['null', null],
      ['empty', []],
      [
        'all-zero',
        [
          { propertyId: 'pA', value: 0 },
          { propertyId: 'pB', value: 0 }
        ]
      ],
      [
        'sub-cent',
        [
          { propertyId: 'pA', value: 0.0001 },
          { propertyId: 'pB', value: 0.004 }
        ]
      ]
    ]) {
      expectRejected(
        `fixed/${label}`,
        () => fixed(a),
        /fixed allocation requires at least one unit with a non-zero amount/
      );
    }
  });

  it('is a NO-OP for every other allocationMethod', () => {
    // Nine methods, one validator each: a guard that fired on the wrong method
    // would 422 every κοινόχρηστο save.
    for (const m of SCHEMA_METHODS.filter((m) => m !== 'fixed')) {
      expectAccepted(
        `fixed/skip/${m}`,
        () => validateFixedAllocations([], m),
        undefined
      );
    }
    expectAccepted(
      'fixed/skip/undefined',
      () => validateFixedAllocations([], undefined),
      undefined
    );
  });

  it('DOCUMENTS: a NEGATIVE row passes this validator on its own', () => {
    // billableTotal is a SUM: −€50 + €60 is €10, which clears the €0.01 bar. Only
    // validateAllocationValues (called first by both handlers) refuses the
    // negative. Any new call site that uses one without the other re-opens the
    // credit-to-tenant hole.
    expectAccepted(
      'fixed/negative-row',
      () =>
        fixed([
          { propertyId: 'pA', value: -50 },
          { propertyId: 'pB', value: 60 }
        ]),
      undefined
    );
  });

  it('DOCUMENTS: fixed per-unit values are NOT bounded by the €1e7 amount ceiling', () => {
    // `fixed` is the one method that ignores expense.amount entirely
    // (allocationMatrix.test.js: Σ is what the landlord typed per unit). So the
    // ceiling that guards `amount` guards nothing here — a €1.000.000.000 fixed
    // share is accepted and billed.
    expectAccepted(
      'fixed/1e9',
      () => fixed([{ propertyId: 'pA', value: 1e9 }]),
      undefined
    );
  });

  it('BUG (documented, not fixed): a non-array crashes instead of 422-ing', () => {
    // `!allocations` is false for {} and `{}.length === 0` is false, so control
    // reaches `allocations.reduce` → TypeError → HTTP 500. validateArrayMaxLength
    // is the guard that would have caught it, and in addExpense it runs AFTER all
    // five allocation validators; updateExpense never calls it at all. The order
    // is the defect, not the missing check.
    for (const [label, v] of [
      ['object', {}],
      ['number', 5000],
      ['true', true],
      ['string', 'pA']
    ]) {
      expectCrash(`fixed/crash/${label}`, () => fixed(v));
    }
  });
});

describe('customAllocations × custom_percentage', () => {
  const pct = (a) => validatePercentageAllocations(a, 'custom_percentage');

  it('a set summing to 100 passes, with the ±0.01 rounding tolerance', () => {
    expectAccepted(
      'pct/exact',
      () => pct([{ value: 60 }, { value: 40 }]),
      undefined
    );
    expectAccepted(
      'pct/thirds',
      () => pct([{ value: 33.34 }, { value: 33.33 }, { value: 33.33 }]),
      undefined
    );
    expectAccepted(
      'pct/tolerance-low',
      () => pct([{ value: 99.995 }]),
      undefined
    );
    expectAccepted(
      'pct/tolerance-high',
      () => pct([{ value: 100.005 }]),
      undefined
    );
    expectAccepted(
      'pct/strings',
      () => pct([{ value: '60' }, { value: '40' }]),
      undefined
    );
  });

  it('anything not summing to 100 is 422 and the message shows the total', () => {
    // A typo'd 35 (for 100) bills €70 of a €200 expense and the €130 balance is
    // recovered from nobody — allocationMatrix.test.js «custom_percentage/partial»
    // proves the allocator does not carry-correct it.
    for (const [label, a, re] of [
      ['short', [{ value: 35 }], /currently 35\.00%/],
      ['over', [{ value: 60 }, { value: 60 }], /currently 120\.00%/],
      ['zero', [{ value: 0 }], /currently 0\.00%/],
      ['just-outside-low', [{ value: 99.98 }], /currently 99\.98%/],
      ['just-outside-high', [{ value: 100.02 }], /currently 100\.02%/]
    ]) {
      expectRejected(`pct/${label}`, () => pct(a), re);
    }
  });

  it('absent / null / empty are 422 for custom_percentage but no-ops elsewhere', () => {
    for (const [label, v] of [
      ['absent', undefined],
      ['null', null],
      ['empty', []]
    ]) {
      expectRejected(
        `pct/${label}`,
        () => pct(v),
        /requires at least one allocation/
      );
    }
    for (const m of SCHEMA_METHODS.filter((m) => m !== 'custom_percentage')) {
      expectAccepted(
        `pct/skip/${m}`,
        () => validatePercentageAllocations([], m),
        undefined
      );
    }
  });

  it('DOCUMENTS: a NaN row is swallowed as 0 — a garbage row rides along at 100%', () => {
    // `Number(a.value) || 0` turns 'abc' into 0. If the other rows already sum to
    // 100 the set passes with a row nobody can price. validateAllocationValues
    // refuses it first in both handlers; standalone this validator does not.
    expectAccepted(
      'pct/nan-row',
      () => pct([{ value: 100 }, { value: 'abc' }]),
      undefined
    );
    expectAccepted(
      'pct/negative-row',
      () => pct([{ value: 150 }, { value: -50 }]),
      undefined
    );
    // …and a Greek-comma percentage becomes 0, so it fails for the RIGHT reason
    // (does not sum to 100) rather than for its shape.
    expectRejected(
      'pct/greek-comma',
      () => pct([{ value: '99,50' }]),
      /currently 0\.00%/
    );
  });

  it('BUG (documented, not fixed): a non-array crashes instead of 422-ing', () => {
    for (const [label, v] of [
      ['object', {}],
      ['number', 100],
      ['string', 'pA']
    ]) {
      expectCrash(`pct/crash/${label}`, () => pct(v));
    }
  });
});

describe('customAllocations × custom_ratio', () => {
  const ratio = (a) => validateRatioAllocations(a, 'custom_ratio');

  it('at least one positive ratio passes', () => {
    expectAccepted(
      'ratio/ok',
      () => ratio([{ value: 3 }, { value: 2 }, { value: 0 }]),
      undefined
    );
    expectAccepted('ratio/strings', () => ratio([{ value: '3' }]), undefined);
  });

  it('an all-zero or negative-total set is 422', () => {
    for (const [label, a] of [
      ['all-zero', [{ value: 0 }, { value: 0 }]],
      ['negative', [{ value: -5 }]],
      ['cancelling', [{ value: 5 }, { value: -5 }]],
      ['nan-only', [{ value: 'abc' }]]
    ]) {
      expectRejected(
        `ratio/${label}`,
        () => ratio(a),
        /at least one non-zero ratio/
      );
    }
  });

  it('BUG (documented, not fixed): NO allocations at all is ACCEPTED for custom_ratio', () => {
    // Unlike fixed and custom_percentage, this validator returns early on an
    // empty set (`if (!allocations || allocations.length === 0) return`). The
    // allocator then charges NOBODY in a multi-unit building
    // (allocationMatrix.test.js «custom_ratio/no-ratios/4-units»), so the expense
    // is saved, is active, and has no representation on any money surface. Three
    // sibling validators guard exactly this shape; this one does not.
    for (const [label, v] of [
      ['absent', undefined],
      ['null', null],
      ['empty', []]
    ]) {
      expectAccepted(`ratio/${label}`, () => ratio(v), undefined);
    }
  });

  it('is a NO-OP for every other allocationMethod', () => {
    for (const m of SCHEMA_METHODS.filter((m) => m !== 'custom_ratio')) {
      expectAccepted(
        `ratio/skip/${m}`,
        () => validateRatioAllocations([{ value: 0 }], m),
        undefined
      );
    }
  });

  it('BUG (documented, not fixed): a non-array crashes instead of 422-ing', () => {
    for (const [label, v] of [
      ['object', {}],
      ['number', 3],
      ['string', 'pA']
    ]) {
      expectCrash(`ratio/crash/${label}`, () => ratio(v));
    }
  });
});

describe('customAllocations × single_unit — the whole bill lands on ONE flat', () => {
  const single = (a) => validateSingleUnitAllocations(a, 'single_unit');

  it('a target propertyId passes, with or without a value', () => {
    expectAccepted(
      'single/target',
      () => single([{ propertyId: 'pA', value: 0 }]),
      undefined
    );
    expectAccepted(
      'single/no-value',
      () => single([{ propertyId: 'pA' }]),
      undefined
    );
  });

  it('ZERO allocations is 422 — without a target the expense bills €0 every term', () => {
    // 1_base's single_unit branch matches customAllocations[0].propertyId; with
    // nothing there it matches no unit and the whole amount evaporates
    // (allocationMatrix.test.js «single_unit/no-target»).
    for (const [label, v] of [
      ['absent', undefined],
      ['null', null],
      ['empty', []]
    ]) {
      expectRejected(
        `single/${label}`,
        () => single(v),
        /single_unit allocation requires a target unit/
      );
    }
  });

  it('an EMPTY-STRING propertyId is 422, and so is every other falsy target', () => {
    for (const [label, pid] of [
      ['empty-string', ''],
      ['null', null],
      ['undefined', undefined],
      ['zero', 0],
      ['false', false],
      ['no-key', undefined]
    ]) {
      expectRejected(
        `single/target/${label}`,
        () => single([{ propertyId: pid, value: 0 }]),
        /requires a target unit/
      );
    }
  });

  it('BUG (documented, not fixed): TWO allocations pass and the second unit is silently ignored', () => {
    // Only `[0]` is examined here, and 1_base bills only `[0]` too — so a
    // landlord who managed to select two units sees the entire amount on the
    // first one and nothing on the second, with no warning on any surface. The
    // validators and the allocator agree, which is why nothing catches it: the
    // defect is that a two-unit single_unit payload is meaningless and accepted.
    expectAccepted(
      'single/two-targets',
      () =>
        single([
          { propertyId: 'pA', value: 0 },
          { propertyId: 'pB', value: 0 }
        ]),
      undefined
    );
  });

  it('DOCUMENTS: a whitespace-only propertyId passes this validator', () => {
    // Truthy, so the target check is satisfied. The building-level guard
    // (_assertCustomAllocationPropertyIds) is what refuses it, and only when the
    // method is one of the four allocation kinds — so this validator alone is not
    // a target-existence check.
    expectAccepted(
      'single/blank-target',
      () => single([{ propertyId: '   ' }]),
      undefined
    );
  });

  it('a non-array is 422 here rather than a crash (the [0] read is safe)', () => {
    for (const [label, v] of [
      ['object', {}],
      ['number', 5],
      ['string', 'pA'],
      ['true', true]
    ]) {
      expectRejected(
        `single/nonarray/${label}`,
        () => single(v),
        /requires a target unit/
      );
    }
  });

  it('is a NO-OP for every other allocationMethod', () => {
    for (const m of SCHEMA_METHODS.filter((m) => m !== 'single_unit')) {
      expectAccepted(
        `single/skip/${m}`,
        () => validateSingleUnitAllocations([], m),
        undefined
      );
    }
  });
});

describe('customAllocations length — validateArrayMaxLength(200)', () => {
  const rows = (n) =>
    Array.from({ length: n }, (_, i) => ({ propertyId: `p${i}`, value: 1 }));

  it('200 rows pass and 201 are 422', () => {
    expectAccepted(
      'len/200',
      () => validateArrayMaxLength(rows(200), 200, 'customAllocations'),
      undefined
    );
    expectRejected(
      'len/201',
      () => validateArrayMaxLength(rows(201), 200, 'customAllocations'),
      /customAllocations exceeds maximum of 200 items/
    );
  });

  it('absent / null are no-ops; every non-array is a 422 «must be an array»', () => {
    expectAccepted(
      'len/absent',
      () => validateArrayMaxLength(undefined, 200, 'customAllocations'),
      undefined
    );
    expectAccepted(
      'len/null',
      () => validateArrayMaxLength(null, 200, 'customAllocations'),
      undefined
    );
    expectAccepted(
      'len/empty',
      () => validateArrayMaxLength([], 200, 'customAllocations'),
      undefined
    );
    for (const [label, v] of [
      ['object', {}],
      ['fake-length', { length: 300 }],
      ['string', 'pA'],
      ['empty-string', ''],
      ['number', 0],
      ['true', true],
      ['false', false]
    ]) {
      expectRejected(
        `len/${label}`,
        () => validateArrayMaxLength(v, 200, 'customAllocations'),
        /customAllocations must be an array/
      );
    }
  });
});

describe('realm.currency — the formatter every expense figure passes through', () => {
  it('ISO codes pass, including the fund codes Intl accepts', () => {
    // The rule is «probe Intl.NumberFormat», not a static list: a static list is
    // narrower than the org-settings dropdown and 422-locks those realms on
    // every save.
    for (const c of ['EUR', 'USD', 'GBP', 'BOV', 'XUA']) {
      expectAccepted(`currency/${c}`, () => validateCurrency(c), c);
    }
  });

  it('absent / null / empty return undefined', () => {
    for (const [label, v] of [
      ['undefined', undefined],
      ['null', null],
      ['empty', '']
    ]) {
      expectAccepted(`currency/${label}`, () => validateCurrency(v), undefined);
    }
  });

  it('junk, wrong lengths, padded values and non-strings are 422', () => {
    for (const bad of [
      'NOTACURRENCY',
      'EU',
      'EURO',
      '$',
      '1',
      ' EUR',
      'EUR ',
      'Ε',
      'ΕΥΡ'
    ]) {
      expectRejected(
        `currency/${JSON.stringify(bad)}`,
        () => validateCurrency(bad),
        /Must be a valid ISO-4217/
      );
    }
    for (const [label, v] of [...WRONG_TYPES, ['number', 978]]) {
      expectRejected(
        `currency/${label}`,
        () => validateCurrency(v),
        /Must be a valid ISO-4217/
      );
    }
  });

  it('DOCUMENTS: case is accepted but NOT normalised', () => {
    // Intl folds case, so 'eur' formats correctly — but the string persisted is
    // 'eur', and anything that compares realm.currency to 'EUR' as a string
    // (rather than handing it to Intl) will disagree.
    expectAccepted('currency/lower', () => validateCurrency('eur'), 'eur');
    expectAccepted('currency/mixed', () => validateCurrency('Eur'), 'Eur');
  });
});

// ---------------------------------------------------------------------------
// LAYER B — the real handlers.
//
// `Collections.Building.findOne` is replaced with a sentinel throw. addExpense
// runs its ENTIRE validation phase before touching the database, so:
//   · a 422 ServiceError  → the guard fired, and fired first
//   · the sentinel        → every guard passed (the input was accepted)
// Nothing here writes to mongo; the mutation is on the imported model object and
// jest's per-file module registry keeps it out of every other suite.
// ---------------------------------------------------------------------------
const SENTINEL = 'REACHED_THE_DATABASE';
const REACHED_SET = 'REACHED_EXPENSE_SET';

const VALID_EXPENSE = {
  name: 'ΚΟΙΝΟΧΡΗΣΤΑ',
  type: 'cleaning',
  allocationMethod: 'equal',
  amount: 200,
  ownerAmount: 0,
  isRecurring: true,
  startTerm: 2026010100
};

const res = { json: () => undefined };

/** 'ACCEPTED' | {status, message} | 'CRASH:<kind>' */
const handlerOutcome = async (handler, body, params = { id: 'b1' }) => {
  try {
    await handler({ realm: { _id: 'r1' }, params, body }, res);
    return 'RESOLVED-WITHOUT-TOUCHING-THE-DB';
  } catch (e) {
    if (e?.message === SENTINEL || e?.message === REACHED_SET)
      return 'ACCEPTED';
    if (e?.statusCode === undefined) return `CRASH:${e?.constructor?.name}`;
    return { status: e.statusCode, message: String(e.message) };
  }
};

const add = (patch) =>
  handlerOutcome(addExpense, { ...VALID_EXPENSE, ...patch });

describe('LAYER B — addExpense actually CALLS these guards, before any DB access', () => {
  beforeAll(() => {
    Collections.Building.findOne = () => {
      throw new Error(SENTINEL);
    };
  });

  it('the valid fixture reaches the database — every rejection below is therefore real', () => {
    // Without this the whole layer is a tautology: a handler that threw 422 on
    // everything would pass every negative case.
    return expect(add({})).resolves.toBe('ACCEPTED');
  });

  const REJECTS = [
    // field, body patch, expected message fragment — one row per wired guard.
    [
      'isVariable is validated as a strict boolean',
      { isVariable: 'yes' },
      /isVariable must be true or false/
    ],
    ['isVariable rejects 1', { isVariable: 1 }, /must be true or false/],
    ['isVariable rejects []', { isVariable: [] }, /must be true or false/],
    [
      'type/allocationMethod compatibility is wired',
      { type: 'electricity_private', allocationMethod: 'general_thousandths' },
      /χιλιοστά/
    ],
    [
      'type enum is wired and required',
      { type: 'by_the_moon' },
      /Invalid type/
    ],
    ['type is required', { type: undefined }, /type is required/],
    [
      'allocationMethod enum is wired',
      { allocationMethod: 'thousandths' },
      /Invalid allocationMethod/
    ],
    [
      'allocationMethod is required',
      { allocationMethod: undefined },
      /allocationMethod is required/
    ],
    ['amount min 0 is wired', { amount: -1 }, /amount must be at least 0/],
    [
      'amount max 1e7 is wired',
      { amount: 10000001 },
      /amount must be at most 10000000/
    ],
    [
      'amount rejects a Greek decimal comma',
      { amount: '87,40' },
      /amount must be a valid number/
    ],
    [
      'ownerAmount min 0 is wired',
      { ownerAmount: -50 },
      /ownerAmount must be at least 0/
    ],
    [
      'ownerAmount max 1e7 is wired',
      { ownerAmount: 20000000 },
      /ownerAmount must be at most 10000000/
    ],
    [
      'startTerm shape is wired',
      { startTerm: '2026-01-01' },
      /Invalid startTerm format/
    ],
    [
      'startTerm range is wired',
      { startTerm: 2019010100 },
      /startTerm out of valid range/
    ],
    ['endTerm shape is wired', { endTerm: 'χθες' }, /Invalid endTerm format/],
    [
      'a recurring expense must be anchored',
      { startTerm: undefined },
      /startTerm is required for recurring expenses/
    ],
    [
      'a one-off expense must be anchored',
      { isRecurring: false, startTerm: undefined },
      /startTerm is required for non-recurring expenses/
    ],
    [
      'startTerm must precede endTerm',
      { startTerm: 2026060100, endTerm: 2026010100 },
      /startTerm must be before endTerm/
    ],
    ['a blank name is refused', { name: '   ' }, /Expense name is required/],
    [
      'an absent name is refused',
      { name: undefined },
      /Expense name is required/
    ],
    [
      'fixed with no allocations is refused',
      { allocationMethod: 'fixed', customAllocations: [] },
      /at least one unit with a non-zero amount/
    ],
    [
      'fixed with all-zero allocations is refused',
      {
        allocationMethod: 'fixed',
        customAllocations: [{ propertyId: 'pA', value: 0 }]
      },
      /at least one unit with a non-zero amount/
    ],
    [
      'custom_percentage that misses 100 is refused',
      {
        allocationMethod: 'custom_percentage',
        customAllocations: [{ propertyId: 'pA', value: 35 }]
      },
      /must sum to 100%/
    ],
    [
      'custom_ratio all-zero is refused',
      {
        allocationMethod: 'custom_ratio',
        customAllocations: [{ propertyId: 'pA', value: 0 }]
      },
      /at least one non-zero ratio/
    ],
    [
      'single_unit with no target is refused',
      { allocationMethod: 'single_unit', customAllocations: [] },
      /requires a target unit/
    ],
    [
      'single_unit with a blank target is refused',
      {
        allocationMethod: 'single_unit',
        customAllocations: [{ propertyId: '', value: 0 }]
      },
      /requires a target unit/
    ],
    [
      'a negative allocation value is refused',
      {
        allocationMethod: 'fixed',
        customAllocations: [{ propertyId: 'pA', value: -5 }]
      },
      /index 0 must be a non-negative number/
    ],
    [
      'a duplicate propertyId is refused',
      {
        customAllocations: [
          { propertyId: 'pA', value: 1 },
          { propertyId: 'pA', value: 2 }
        ]
      },
      /duplicate entry for propertyId/
    ],
    [
      'the 200-row cap is wired',
      {
        customAllocations: Array.from({ length: 201 }, (_, i) => ({
          propertyId: `p${i}`,
          value: 1
        }))
      },
      /customAllocations exceeds maximum of 200/
    ]
  ];

  REJECTS.forEach(([label, patch, re]) => {
    it(`422: ${label}`, async () => {
      const got = await add(patch);
      expect({ case: label, status: got.status }).toEqual({
        case: label,
        status: 422
      });
      expect({ case: label, message: got.message }).toEqual({
        case: label,
        message: expect.stringMatching(re)
      });
    });
  });

  const ACCEPTS = [
    ['a €0 κυμαινόμενο expense', { amount: 0, isVariable: true }],
    ['isVariable ABSENT (legacy row)', { isVariable: undefined }],
    ['amount at the exact ceiling', { amount: 10000000 }],
    ['a padded numeric amount', { amount: ' 200 ' }],
    [
      'every private type on single_unit',
      {
        type: 'electricity_private',
        allocationMethod: 'single_unit',
        customAllocations: [{ propertyId: 'pA', value: 0 }]
      }
    ],
    [
      'a κοινόχρηστο type on χιλιοστά',
      { type: 'electricity_common', allocationMethod: 'general_thousandths' }
    ],
    [
      'exactly 200 allocation rows',
      {
        customAllocations: Array.from({ length: 200 }, (_, i) => ({
          propertyId: `p${i}`,
          value: 1
        }))
      }
    ],
    [
      'a one-off expense WITH a startTerm',
      { isRecurring: false, startTerm: 2026030100 }
    ],
    [
      'notes and billingId, unvalidated free strings',
      { notes: 'ΟΔΟΣ ΑΛΦΑ, 1ος', billingId: '999935585-016' }
    ]
  ];

  ACCEPTS.forEach(([label, patch]) => {
    it(`accepted: ${label}`, async () => {
      expect({ case: label, got: await add(patch) }).toEqual({
        case: label,
        got: 'ACCEPTED'
      });
    });
  });

  it('BUG (documented, not fixed): a non-string NAME is a 500, not a 422', () => {
    // The guard is `if (!req.body.name?.trim())`. Optional chaining protects
    // against null/undefined only — `['ΟΔΟΣ ΑΛΦΑ'].trim` and `(200).trim` are
    // undefined, so calling them is a TypeError and express answers 500. Every
    // OTHER field on this form answers 422 with the field name; this one answers
    // «κάτι πήγε λάθος» and pages whoever watches the 5xx rate.
    // validateStringField (asserted above) is the 422 that is not wired here.
    return Promise.all(
      [['ΟΔΟΣ ΑΛΦΑ'], 200, { el: 'ΚΟΙΝΟΧΡΗΣΤΑ' }, true].map(async (name) => {
        expect({
          name: JSON.stringify(name),
          got: await add({ name })
        }).toEqual({
          name: JSON.stringify(name),
          got: 'CRASH:TypeError'
        });
      })
    );
  });

  it('BUG (documented, not fixed): a non-array customAllocations is a 500, not a 422', async () => {
    // validateArrayMaxLength — the ONLY shape guard — is the LAST of the six
    // allocation validators in addExpense, so validateFixedAllocations reaches
    // `.reduce` on an object first. Reordering it to the front turns all three of
    // these into the 422 they should already be.
    for (const [label, customAllocations] of [
      ['object', {}],
      ['number', 5000],
      ['true', true]
    ]) {
      expect({
        case: label,
        got: await add({ allocationMethod: 'fixed', customAllocations })
      }).toEqual({ case: label, got: 'CRASH:TypeError' });
    }
    // A STRING is the one non-array shape that answers 422 — and by accident:
    // validateAllocationValues iterates its characters and finds no `.value`, so
    // the landlord is told «Allocation value at index 0 must be a non-negative
    // number» about a payload that has no allocations at all.
    const asString = await add({
      allocationMethod: 'fixed',
      customAllocations: 'pA'
    });
    expect({ case: 'string', status: asString.status }).toEqual({
      case: 'string',
      status: 422
    });
    expect(asString.message).toMatch(/index 0 must be a non-negative number/);
  });

  it('DOCUMENTS: ownerAmount may be five times the amount and the save proceeds', () => {
    // ownerRatio = ownerAmount/amount = 5 on the Ετήσια προβολή tile.
    return expect(add({ amount: 100, ownerAmount: 500 })).resolves.toBe(
      'ACCEPTED'
    );
  });

  it('DOCUMENTS: an impossible startTerm (month 13) is accepted by the handler too', () => {
    // Not just by validateTerm in isolation — the whole handler waves it through,
    // so the expense is created and then matches no rent month, forever.
    return expect(add({ startTerm: 2026133100 })).resolves.toBe('ACCEPTED');
  });
});

describe('LAYER B — updateExpense: a PARTIAL PATCH escapes the χιλιοστά guard', () => {
  // The stored expense is the one the guard was written for: one apartment's own
  // electricity bill. The fake building lets the handler run its ENTIRE
  // post-load validation block (merged method + merged allocations + the
  // thousandths-availability check) and sentinels at `expense.set`, which is the
  // last statement before the write.
  const storedExpense = (over) => ({
    _id: 'e1',
    name: 'Ρεύμα Α1',
    type: 'electricity_private',
    allocationMethod: 'equal',
    amount: 87.4,
    customAllocations: [],
    set: () => {
      throw new Error(REACHED_SET);
    },
    ...over
  });

  const fakeBuilding = (expense) => {
    const expenses = [expense];
    expenses.id = (id) => (String(id) === String(expense._id) ? expense : null);
    return {
      _id: 'b1',
      // A real denominator for ALL THREE χιλιοστά dimensions, so
      // _assertThousandthsAvailable cannot be the thing that refuses the PATCH —
      // the point is what the TYPE guard does. (Omitting elevatorThousandths
      // here made the elevator row fail on that other guard instead, which is
      // the harness proving both guards are live.)
      units: [
        {
          propertyId: 'pA',
          generalThousandths: 600,
          heatingThousandths: 600,
          elevatorThousandths: 600
        },
        {
          propertyId: 'pB',
          generalThousandths: 400,
          heatingThousandths: 400,
          elevatorThousandths: 400
        }
      ],
      expenses
    };
  };

  const patch = async (body, over) => {
    Collections.Building.findOne = async () =>
      fakeBuilding(storedExpense(over));
    return handlerOutcome(updateExpense, body, { id: 'b1', expenseId: 'e1' });
  };

  it('the CONTROL: both halves in one body ARE refused (the guard does work)', async () => {
    const got = await patch({
      type: 'electricity_private',
      allocationMethod: 'general_thousandths'
    });
    expect({ case: 'full-body', status: got.status }).toEqual({
      case: 'full-body',
      status: 422
    });
    expect(got.message).toMatch(/χιλιοστά/);
  });

  it('FIXED: PATCH {allocationMethod: *_thousandths} on a stored *_private expense is REFUSED', async () => {
    // WAS ACCEPTED. `req.body.type` is undefined on a partial PATCH, so
    // validateTypeAllocationCompatible bailed at its `typeof type !== 'string'`
    // line, and the merged-method block that re-runs the other four allocation
    // validators did not re-run this one. One apartment's €87,40 then split across
    // the whole building, every month — the exact outcome the validator's docstring
    // says it exists to prevent. It now runs on the MERGED type, like its four
    // siblings.
    for (const method of THOUSANDTHS_METHODS) {
      const got = await patch({ allocationMethod: method });
      expect({ case: `method-only/${method}`, status: got.status }).toEqual({
        case: `method-only/${method}`,
        status: 422
      });
      expect(got.message).toMatch(/χιλιοστά/);
    }
  });

  it('FIXED: the mirror PATCH {type: *_private} on a stored χιλιοστά expense is REFUSED', async () => {
    // The direction the docstring describes verbatim: «an existing
    // electricity_common + general_thousandths expense [is] switched to
    // electricity_private while KEEPING the χιλιοστά split». Now caught on the
    // merged allocation method.
    for (const type of PRIVATE_TYPES) {
      const got = await patch(
        { type },
        { type: 'electricity_common', allocationMethod: 'general_thousandths' }
      );
      expect({ case: `type-only/${type}`, status: got.status }).toEqual({
        case: `type-only/${type}`,
        status: 422
      });
      expect(got.message).toMatch(/χιλιοστά/);
    }
  });

  it('the PATCH path still enforces the guards it does wire', async () => {
    // Proves the harness is not simply accepting everything: the same fake
    // building refuses these, so «ACCEPTED» above is a statement about the
    // compatibility check specifically.
    for (const [label, body, re] of [
      [
        'bad method',
        { allocationMethod: 'thousandths' },
        /Invalid allocationMethod/
      ],
      ['bad type', { type: 'by_the_moon' }, /Invalid type/],
      ['isVariable', { isVariable: 'no' }, /must be true or false/],
      ['amount ceiling', { amount: 10000001 }, /at most 10000000/],
      [
        'negative allocation',
        { customAllocations: [{ propertyId: 'pA', value: -1 }] },
        /non-negative/
      ],
      ['bad term', { startTerm: 'χθες' }, /Invalid startTerm format/]
    ]) {
      const got = await patch(body);
      expect({ case: label, status: got.status }).toEqual({
        case: label,
        status: 422
      });
      expect({ case: label, message: got.message }).toEqual({
        case: label,
        message: expect.stringMatching(re)
      });
    }
  });

  it('a PATCH that flips a stored FIXED expense to zero allocations is still refused', async () => {
    // The FIXED-ZERO-PATCH fix: the merged block validates the EFFECTIVE method,
    // so a body carrying only customAllocations is checked against the stored
    // `fixed`. This is the pattern the compatibility check above is missing.
    const got = await patch(
      { customAllocations: [] },
      {
        allocationMethod: 'fixed',
        type: 'other',
        customAllocations: [{ propertyId: 'pA', value: 70 }]
      }
    );
    expect({ case: 'fixed-zero-patch', status: got.status }).toEqual({
      case: 'fixed-zero-patch',
      status: 422
    });
  });
});
