// Tier I-3: lock the per-property expense panel category map.
//
// `_classifyExpenseType` (services/api/src/managers/propertymanager.ts) folds
// the 11-value `BuildingExpenseSchema.type` enum into one of 7 panel headline
// categories (heating / water / electricity / insurance / cleaning / repairs /
// other). The function is the single point where elevator/garden/pest_control
// expenses get rolled into a sensible bucket — a silent fall-through to
// 'other' would leave the panel undercounting in a way only visible when the
// user happens to add one of those types.
//
// This jest unit asserts:
//   1. Every value in the BuildingExpenseSchema.type enum maps to a non-default
//      EXPENSE_CATEGORIES value (the function MUST handle each schema enum
//      explicitly; a future schema addition will fail here loudly).
//   2. Specific load-bearing mappings (elevator → repairs, garden → cleaning,
//      pest_control → cleaning, management_fee → other) hold.
//   3. The canonical 1:1 mappings (heating/water_common/electricity_common/
//      insurance/cleaning/repairs_fund) resolve to their headline category.
//   4. Unknown enum values trigger logger.warn AND default to 'other'
//      (so future schema drift surfaces in CloudWatch instead of silently
//      misbucketing).
//   5. undefined / null / empty-string return 'other' without warning
//      (these are valid no-op inputs from optional schema reads, not drift).
//
// The pre-existing winston ESM noise is sidestepped by mocking
// '@microrealestate/common' before importing propertymanager (same pattern as
// services/api/src/__tests__/realmmanager.test.js). The auxiliary modules
// propertymanager pulls in transitively (occupantmanager via mongoose, etc.)
// don't touch winston once Collections/logger are stubbed.

// `type: module` package → test files run as ESM. The legacy hoisted
// `jest.mock(factory)` API does not work under ESM (the factory runs after
// the mocked module already loaded). Use jest.unstable_mockModule + a dynamic
// import() inside beforeAll so the mocks register first.
import { jest } from '@jest/globals';

const warnMock = jest.fn();
let _classifyExpenseType;

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
      Property: {},
      Lease: {},
      Building: {},
      Template: {},
      Document: {},
      Email: {},
      Bill: {},
      Account: {}
    },
    ServiceError,
    Crypto: { encrypt: (v) => v, decrypt: (v) => v },
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      warn: warnMock
    },
    Pagination: { paginate: jest.fn(), defaultPageSize: 50 },
    Middlewares: {},
    Service: { getInstance: jest.fn() }
  }));
  // Stub validators.js — propertymanager.ts imports several helpers from it at
  // module-eval time. No-ops keep the import cheap and avoid dragging in
  // ServiceError-throwing paths that aren't under test.
  jest.unstable_mockModule('../validators.js', () => ({
    validateObjectId: jest.fn(),
    validateFiniteNumber: jest.fn(),
    validateEnum: jest.fn(),
    sanitizeMongoObject: jest.fn((v) => v),
    isValidGreekPostalCode: jest.fn(() => true),
    PROPERTY_TYPES: ['apartment', 'store', 'office', 'storage', 'parking']
  }));
  // Stub occupantmanager.js — it imports axios/nanoid and is irrelevant to a
  // pure classification helper.
  jest.unstable_mockModule('../managers/occupantmanager.js', () => ({
    _attachTenantGroupsToBuildings: jest.fn()
  }));
  // Stub businesslogic — same rationale.
  jest.unstable_mockModule('../businesslogic/tasks/1_base.js', () => ({
    computeBuildingChargeForProperty: jest.fn(() => 0)
  }));
  ({ _classifyExpenseType } = await import('../managers/propertymanager.js'));
});

// Mirror of services/common/src/collections/building.ts BuildingExpenseSchema.type.
// If a new value lands in the schema and a developer forgets to update
// _classifyExpenseType, item (1) below will catch it via the per-value
// assertion AND item (4) will catch the runtime fall-through.
const BUILDING_EXPENSE_SCHEMA_TYPES = [
  'heating',
  'elevator',
  'cleaning',
  'water_common',
  'electricity_common',
  'insurance',
  'management_fee',
  'garden',
  'repairs_fund',
  'pest_control',
  'other'
];

const EXPENSE_CATEGORIES = [
  'heating',
  'water',
  'electricity',
  'insurance',
  'cleaning',
  'repairs',
  'other'
];

describe('_classifyExpenseType', () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  describe('every BuildingExpenseSchema.type enum value resolves to a known panel category', () => {
    BUILDING_EXPENSE_SCHEMA_TYPES.forEach((schemaType) => {
      it(`'${schemaType}' maps to a value in EXPENSE_CATEGORIES`, () => {
        const category = _classifyExpenseType(schemaType);
        expect(EXPENSE_CATEGORIES).toContain(category);
        // Schema-known values must NEVER fall through the warn-and-default
        // branch — that branch exists only for unknown drift.
        expect(warnMock).not.toHaveBeenCalled();
      });
    });
  });

  describe('load-bearing rollup mappings (the I-3 cluster fix)', () => {
    it("'elevator' rolls up to 'repairs'", () => {
      expect(_classifyExpenseType('elevator')).toBe('repairs');
    });

    it("'garden' rolls up to 'cleaning'", () => {
      expect(_classifyExpenseType('garden')).toBe('cleaning');
    });

    it("'pest_control' rolls up to 'cleaning'", () => {
      expect(_classifyExpenseType('pest_control')).toBe('cleaning');
    });

    it("'management_fee' rolls up to 'other'", () => {
      expect(_classifyExpenseType('management_fee')).toBe('other');
    });
  });

  describe('canonical 1:1 mappings', () => {
    it("'heating' → 'heating'", () => {
      expect(_classifyExpenseType('heating')).toBe('heating');
    });

    it("'water_common' → 'water'", () => {
      expect(_classifyExpenseType('water_common')).toBe('water');
    });

    it("'electricity_common' → 'electricity'", () => {
      expect(_classifyExpenseType('electricity_common')).toBe('electricity');
    });

    it("'insurance' → 'insurance'", () => {
      expect(_classifyExpenseType('insurance')).toBe('insurance');
    });

    it("'cleaning' → 'cleaning'", () => {
      expect(_classifyExpenseType('cleaning')).toBe('cleaning');
    });

    it("'repairs_fund' → 'repairs'", () => {
      expect(_classifyExpenseType('repairs_fund')).toBe('repairs');
    });

    it("legacy 'repair' alias → 'repairs'", () => {
      // The switch also accepts 'repair' (singular) — there are pre-existing
      // documents that used this string before the schema settled on
      // 'repairs_fund'. Locking the behaviour prevents silent regression.
      expect(_classifyExpenseType('repair')).toBe('repairs');
    });

    it("'other' → 'other'", () => {
      expect(_classifyExpenseType('other')).toBe('other');
    });
  });

  describe('default + warn behaviour for unknown drift', () => {
    it("unknown values default to 'other' AND emit logger.warn exactly once", () => {
      const result = _classifyExpenseType('totally_unknown_type');
      expect(result).toBe('other');
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock).toHaveBeenCalledWith(
        expect.stringContaining('totally_unknown_type')
      );
      expect(warnMock).toHaveBeenCalledWith(
        expect.stringContaining("defaulted to 'other'")
      );
    });

    it('a second unknown value emits a second warn (no dedup)', () => {
      _classifyExpenseType('drift_a');
      _classifyExpenseType('drift_b');
      expect(warnMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('falsy inputs are silent and return other', () => {
    it("undefined → 'other' without warn", () => {
      expect(_classifyExpenseType(undefined)).toBe('other');
      expect(warnMock).not.toHaveBeenCalled();
    });

    it("null → 'other' without warn", () => {
      expect(_classifyExpenseType(null)).toBe('other');
      expect(warnMock).not.toHaveBeenCalled();
    });

    it("empty string → 'other' without warn", () => {
      expect(_classifyExpenseType('')).toBe('other');
      expect(warnMock).not.toHaveBeenCalled();
    });
  });
});
