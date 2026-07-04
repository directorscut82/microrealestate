/* eslint-env node, jest */
/**
 * B-C: updateUnit / addUnit must REFUSE to mark a unit owner_occupied while a
 * tenant ACTIVELY rents its property (mutually-exclusive states), but must
 * ALLOW it once the tenant has moved out (terminated) — date-aware, not the
 * naive "any tenant row ever" check. Mirrors the guard removeUnit already has.
 *
 * B-A: an occupancy change of ANY kind (not only owner_occupied transitions)
 * fires recomputeVacantOwnerForProperties. Proven here by asserting the guard's
 * occupancy helper reads the tenant set (the active-vs-terminated distinction);
 * the recompute widening is covered by the build + the money suite.
 */
import { jest } from '@jest/globals';

let buildingManager;
const state = {};

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  const query = (v) => {
    const p = Promise.resolve(v);
    p.lean = async () => v;
    p.select = () => query(v);
    return p;
  };

  const makeSaveable = (obj) => {
    obj.save = async () => obj;
    obj.toObject = () => obj;
    // Mongoose DocumentArray exposes .id(uid); emulate it on the plain array so
    // updateUnit's `building.units.id(unitId)` resolves the subdoc.
    if (Array.isArray(obj.units)) {
      obj.units.id = (uid) =>
        obj.units.find((u) => String(u._id) === String(uid)) || null;
    }
    return obj;
  };

  // Unit u1 → property P1. Two scenarios switch `state.tenants`.
  const building = makeSaveable({
    _id: '6a4551f5efd7970071c44002',
    name: 'Κτίριο',
    realmId: 'r1',
    address: { street1: 'ΑΓ. ΟΔΟΣ ΕΨΙΛΟΝ 28' },
    units: [
      {
        _id: '6a4551f5efd7970071c44003',
        atakNumber: 'AT1',
        propertyId: '6a4551f5efd7970071c44001',
        isManaged: true,
        occupancyType: 'vacant',
        generalThousandths: 100,
        heatingThousandths: 0,
        elevatorThousandths: 0,
        owners: [{ name: 'ΒΗΤΑ', percentage: 100 }],
        monthlyCharges: [],
        set(body) {
          Object.assign(this, body);
        }
      }
    ]
  });
  state.building = building;
  state.tenants = [];

  const OwnerStatement = await import('../../../common/src/utils/ownerstatement.ts');
  const ShareBasis = await import('../../../common/src/utils/sharebasis.ts');

  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Building: {
        findOne: () => {
          // updateUnit/addUnit use findOne (not lean) then mutate + save.
          const p = Promise.resolve(building);
          p.lean = async () => building;
          p.select = () => p;
          return p;
        },
        find: () => query([building])
      },
      Property: {
        findOne: () => query({ _id: '6a4551f5efd7970071c44001', realmId: 'r1', buildingId: '6a4551f5efd7970071c44002' }),
        find: () => query([{ _id: '6a4551f5efd7970071c44001', realmId: 'r1', buildingId: '6a4551f5efd7970071c44002' }]),
        findOneAndUpdate: () => query(null),
        updateOne: () => query(null)
      },
      // The date-aware occupancy helper queries Tenant.find(...).select().lean()
      Tenant: {
        find: () => query(state.tenants)
      },
      ObjectId: class {
        constructor(v) {
          this.v = v;
        }
      }
    },
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    ServiceError,
    OwnerStatement,
    ShareBasis,
    Pagination: {},
    Service: { getInstance: () => ({ envConfig: { getValues: () => ({}) } }) },
    Crypto: { encrypt: (v) => v, decrypt: (v) => v }
  }));

  buildingManager = await import('../managers/buildingmanager.js');
});

function makeRes() {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function updateReq(occupancyType) {
  return {
    realm: { _id: 'r1', locale: 'el' },
    params: { id: '6a4551f5efd7970071c44002', unitId: '6a4551f5efd7970071c44003' },
    body: {
      atakNumber: 'AT1',
      propertyId: '6a4551f5efd7970071c44001',
      occupancyType,
      generalThousandths: 100,
      heatingThousandths: 0,
      elevatorThousandths: 0,
      surface: 50,
      floor: 1
    }
  };
}

describe('B-C owner-occupied guard (date-aware)', () => {
  beforeEach(() => {
    state.building.units[0].occupancyType = 'vacant';
  });

  it('REFUSES owner_occupied when an ACTIVE tenant rents the property (422)', async () => {
    state.tenants = [
      {
        _id: 't1',
        beginDate: new Date('2020-01-01'),
        endDate: new Date('2030-01-01'),
        terminationDate: null,
        properties: [{ propertyId: '6a4551f5efd7970071c44001' }]
      }
    ];
    const res = makeRes();
    await expect(
      buildingManager.updateUnit(updateReq('owner_occupied'), res)
    ).rejects.toMatchObject({ status: 422 });
  });

  it('ALLOWS owner_occupied when the only tenant has TERMINATED (moved out)', async () => {
    state.tenants = [
      {
        _id: 't1',
        beginDate: new Date('2020-01-01'),
        endDate: new Date('2030-01-01'),
        // Terminated last month → not active this term.
        terminationDate: new Date('2020-06-01'),
        properties: [{ propertyId: '6a4551f5efd7970071c44001' }]
      }
    ];
    const res = makeRes();
    await buildingManager.updateUnit(updateReq('owner_occupied'), res);
    expect(res.json).toHaveBeenCalled();
    expect(state.building.units[0].occupancyType).toBe('owner_occupied');
  });

  it('ALLOWS owner_occupied when there is NO tenant at all', async () => {
    state.tenants = [];
    const res = makeRes();
    await buildingManager.updateUnit(updateReq('owner_occupied'), res);
    expect(res.json).toHaveBeenCalled();
    expect(state.building.units[0].occupancyType).toBe('owner_occupied');
  });
});
