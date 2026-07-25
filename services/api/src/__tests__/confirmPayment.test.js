/**
 * confirmPayment (Slice 6) — the receipt-installment money path. These lock the
 * review-caught money bugs that a green suite previously did NOT cover:
 *   1. a missing/zero amount must NOT fabricate the full total + auto-mark paid;
 *   2. a 0-cost repair must NOT be instantly "fully paid";
 *   3. a double-submitted απόδειξη must NOT double-count (idempotent dedup);
 *   4. installments correctly transition partial → paid with sub-cent tolerance.
 *
 * The handler uses Collections.Bill.findOne (returns a doc with .save()) and
 * Collections.Building.findOne (for repair installments). We mock common so the
 * import chain doesn't touch mongoose/redis, then drive the exported handler
 * with a fake req/res.
 */
import { jest } from '@jest/globals';

// Mutable handles the mocked Collections close over, so each test seeds its own.
const state = {
  bill: null,
  building: null,
  saved: []
};

jest.unstable_mockModule('@microrealestate/common', () => ({
  Collections: {
    Bill: {
      findOne: async () => state.bill
    },
    Building: {
      findOne: async () => state.building
    }
  },
  Service: { getInstance: () => ({ envConfig: { getValues: () => ({}) } }) },
  Crypto: { encrypt: (v) => v, decrypt: (v) => v },
  logger: { error() {}, debug() {}, warn() {}, info() {} },
  ServiceError: class ServiceError extends Error {
    constructor(message, code) {
      super(message);
      this.statusCode = code;
    }
  }
}));

const { confirmPayment } = await import('../managers/billmanager.js');

const REALM = '_id-realm-1';
// validateObjectId requires 24-char hex ids.
const BILL_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REPAIR_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const BUILDING_ID = 'cccccccccccccccccccccccc';

function makeBillDoc(overrides = {}) {
  const doc = {
    _id: BILL_ID,
    realmId: REALM,
    totalAmount: 100,
    status: 'pending',
    receipts: [],
    ...overrides,
    async save() {
      state.saved.push({ kind: 'bill', status: this.status, receipts: this.receipts });
    }
  };
  return doc;
}

function makeBuildingWithRepair(repairOverrides = {}) {
  const repair = {
    _id: REPAIR_ID,
    actualCost: 500,
    receipts: [],
    ...repairOverrides
  };
  return {
    _id: BUILDING_ID,
    realmId: REALM,
    repairs: [repair],
    markModified() {},
    async save() {
      state.saved.push({ kind: 'building' });
    },
    _repair: repair
  };
}

function run(body) {
  const req = { realm: { _id: REALM }, body };
  const captured = {};
  const res = { json: (x) => (captured.body = x) };
  return confirmPayment(req, res).then(() => captured.body);
}

async function runExpectThrow(body) {
  const req = { realm: { _id: REALM }, body };
  const res = { json: () => {} };
  try {
    await confirmPayment(req, res);
    return null;
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  state.bill = null;
  state.building = null;
  state.saved = [];
});

describe('confirmPayment — bill installments', () => {
  it('REJECTS a payment with no amount (no full-total fabrication, no auto-paid)', async () => {
    state.bill = makeBillDoc();
    const err = await runExpectThrow({
      payments: [{ kind: 'bill', billId: BILL_ID /* no amount */ }]
    });
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(422);
    // NOTHING saved — the bad amount never mutated the bill.
    expect(state.saved).toHaveLength(0);
    expect(state.bill.status).toBe('pending');
    expect(state.bill.receipts).toHaveLength(0);
  });

  it('REJECTS a zero / negative amount', async () => {
    state.bill = makeBillDoc();
    const errZero = await runExpectThrow({
      payments: [{ kind: 'bill', billId: BILL_ID, amount: 0 }]
    });
    expect(errZero.statusCode).toBe(422);
    const errNeg = await runExpectThrow({
      payments: [{ kind: 'bill', billId: BILL_ID, amount: -5 }]
    });
    expect(errNeg.statusCode).toBe(422);
  });

  it('a partial amount → status partial, remaining is the shortfall', async () => {
    state.bill = makeBillDoc({ totalAmount: 100 });
    const out = await run({
      payments: [
        { kind: 'bill', billId: BILL_ID, amount: 40, date: '2026-07-10' }
      ]
    });
    expect(state.bill.status).toBe('partial');
    expect(out.updated[0]).toMatchObject({
      kind: 'bill',
      status: 'partial',
      paidSoFar: 40,
      remaining: 60
    });
  });

  it('installments sum to the total → paid (sub-cent tolerance)', async () => {
    // 33.34 + 33.33 + 33.33 = 100.00 exactly.
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [
        { amount: 33.34, date: new Date('2026-07-01') },
        { amount: 33.33, date: new Date('2026-07-02') }
      ]
    });
    const out = await run({
      payments: [
        { kind: 'bill', billId: BILL_ID, amount: 33.33, date: '2026-07-03' }
      ]
    });
    expect(state.bill.status).toBe('paid');
    expect(out.updated[0].status).toBe('paid');
  });

  it('DOUBLE-SUBMIT of the same receipt is deduped (no double-count)', async () => {
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [
        {
          amount: 50,
          date: new Date('2026-07-10'),
          proofUrl: 'b2://proof-A'
        }
      ]
    });
    const out = await run({
      payments: [
        {
          kind: 'bill',
          billId: BILL_ID,
          amount: 50,
          date: '2026-07-10',
          proofUrl: 'b2://proof-A'
        }
      ]
    });
    // Still ONE receipt, still partial (not fabricated to 100 → paid).
    expect(state.bill.receipts).toHaveLength(1);
    expect(state.bill.status).toBe('pending');
    expect(out.updated[0]).toMatchObject({ duplicate: true });
  });

  it('a DIFFERENT-day receipt with the same amount is NOT a duplicate', async () => {
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [{ amount: 50, date: new Date('2026-07-10') }]
    });
    await run({
      payments: [
        { kind: 'bill', billId: BILL_ID, amount: 50, date: '2026-07-20' }
      ]
    });
    expect(state.bill.receipts).toHaveLength(2);
    expect(state.bill.status).toBe('paid'); // 50+50 = 100
  });
});

describe('confirmPayment — repair installments', () => {
  it('REJECTS a 0-cost repair (never instantly fully-paid)', async () => {
    state.building = makeBuildingWithRepair({ actualCost: 0 });
    const err = await runExpectThrow({
      payments: [
        {
          kind: 'repair',
          repairId: REPAIR_ID,
          buildingId: BUILDING_ID,
          amount: 20
        }
      ]
    });
    expect(err.statusCode).toBe(422);
    // The repair was NOT marked paid, nothing saved.
    expect(state.building._repair.isPaidFromRepairsFund).toBeUndefined();
    expect(state.saved).toHaveLength(0);
  });

  it('a real-cost repair records an installment and marks paid when covered', async () => {
    state.building = makeBuildingWithRepair({ actualCost: 200 });
    await run({
      payments: [
        {
          kind: 'repair',
          repairId: REPAIR_ID,
          buildingId: BUILDING_ID,
          amount: 200,
          date: '2026-07-10'
        }
      ]
    });
    expect(state.building._repair.receipts).toHaveLength(1);
    expect(state.building._repair.isPaidFromRepairsFund).toBe(true);
  });

  it('DOUBLE-SUBMIT of the same repair receipt is deduped', async () => {
    state.building = makeBuildingWithRepair({
      actualCost: 500,
      receipts: [
        { amount: 100, date: new Date('2026-07-10'), proofUrl: 'b2://r-A' }
      ]
    });
    const out = await run({
      payments: [
        {
          kind: 'repair',
          repairId: REPAIR_ID,
          buildingId: BUILDING_ID,
          amount: 100,
          date: '2026-07-10',
          proofUrl: 'b2://r-A'
        }
      ]
    });
    expect(state.building._repair.receipts).toHaveLength(1);
    expect(out.updated[0]).toMatchObject({ duplicate: true });
  });
});
