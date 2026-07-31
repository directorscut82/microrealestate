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
    // Identity-less on BOTH sides (no proofUrl, no ocrText) — this is the case
    // that still falls back to the amount + calendar-day heuristic, and it must
    // keep letting a second genuine installment through.
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

  it('identity-less, SAME day → still deduped by the legacy amount+day guard', async () => {
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [{ amount: 50, date: new Date('2026-07-10') }]
    });
    const out = await run({
      payments: [
        { kind: 'bill', billId: BILL_ID, amount: 50, date: '2026-07-10' }
      ]
    });
    expect(state.bill.receipts).toHaveLength(1);
    expect(out.updated[0]).toMatchObject({ duplicate: true });
  });

  // The receipt-identity bug: mkReceipt defaults `date` to the SERVER CLOCK when
  // the OCR read no date and the user typed none. Keying dedup on that field
  // meant a retry crossing midnight — or any retry at all, since each POST gets
  // a fresh stamp — recorded the same απόδειξη twice and double-counted
  // Σ(receipts), silently flipping a bill to 'paid'. Identity is the proof
  // (proofUrl, else the OCR text), never a server-defaulted field.
  //
  // Seeded 5 days back rather than at a literal date so "a different calendar
  // day from the server clock" holds on every date this suite is ever run on —
  // a hardcoded '2026-07-10' would false-green on 2026-07-10 itself.
  const FIVE_DAYS_AGO = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

  it('an UNDATED retry of the same proofUrl is deduped across a day boundary', async () => {
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [{ amount: 50, date: FIVE_DAYS_AGO, proofUrl: 'b2://proof-A' }]
    });
    const out = await run({
      payments: [
        {
          kind: 'bill',
          billId: BILL_ID,
          amount: 50,
          // no date → server-clock stamp, i.e. TODAY, not FIVE_DAYS_AGO
          proofUrl: 'b2://proof-A'
        }
      ]
    });
    expect(state.bill.receipts).toHaveLength(1);
    expect(state.bill.status).toBe('pending');
    expect(out.updated[0]).toMatchObject({ duplicate: true });
  });

  it('an UNDATED retry of the same ocrText is deduped across a day boundary', async () => {
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [
        { amount: 50, date: FIVE_DAYS_AGO, ocrText: 'ΔΕΗ RF12 3456 ΑΠΟΔΕΙΞΗ' }
      ]
    });
    const out = await run({
      payments: [
        {
          kind: 'bill',
          billId: BILL_ID,
          amount: 50,
          ocrText: 'ΔΕΗ RF12 3456 ΑΠΟΔΕΙΞΗ'
        }
      ]
    });
    expect(state.bill.receipts).toHaveLength(1);
    expect(out.updated[0]).toMatchObject({ duplicate: true });
  });

  // The other direction of the same asymmetry: one copy dated, the other not.
  it('a DATED submit of an already-recorded undated proof is deduped', async () => {
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [{ amount: 50, date: new Date(), proofUrl: 'b2://proof-A' }]
    });
    const out = await run({
      payments: [
        {
          kind: 'bill',
          billId: BILL_ID,
          amount: 50,
          date: FIVE_DAYS_AGO.toISOString(),
          proofUrl: 'b2://proof-A'
        }
      ]
    });
    expect(state.bill.receipts).toHaveLength(1);
    expect(out.updated[0]).toMatchObject({ duplicate: true });
  });

  it('two DIFFERENT proofs on the same day are both recorded (dedup must not eat money)', async () => {
    // Relaxing the day check must NOT collapse two genuine same-amount
    // installments that carry distinct proof. Dropping money silently is worse
    // than double-recording it visibly, so this is the guard on the fix itself.
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [{ amount: 50, date: FIVE_DAYS_AGO, proofUrl: 'b2://proof-A' }]
    });
    await run({
      payments: [
        {
          kind: 'bill',
          billId: BILL_ID,
          amount: 50,
          proofUrl: 'b2://proof-B'
        }
      ]
    });
    expect(state.bill.receipts).toHaveLength(2);
    expect(state.bill.status).toBe('paid');
  });

  it('same proof, DIFFERENT amount is not a duplicate (a corrected amount is real)', async () => {
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [{ amount: 50, date: FIVE_DAYS_AGO, proofUrl: 'b2://proof-A' }]
    });
    await run({
      payments: [
        { kind: 'bill', billId: BILL_ID, amount: 30, proofUrl: 'b2://proof-A' }
      ]
    });
    expect(state.bill.receipts).toHaveLength(2);
  });
});

// OVERPAY (bill-OCR audit 2026-07): Σ(receipts) past the total had NO
// representation anywhere. `status` only knows paid|partial|pending, the
// dashboard clamps outstanding with Math.max(0, …), and both the tile query and
// the receipt-candidate query drop 'paid' bills — so the excess left no trace
// and a receipt matched to the WRONG bill looked like a clean payment. This
// handler is the only moment the excess is created and the only moment the
// operator is still looking at the receipt, so it reports it here.
describe('confirmPayment — overpayment is reported, not hidden', () => {
  it('reports the excess when a single receipt exceeds the bill total', async () => {
    state.bill = makeBillDoc({ totalAmount: 100 });
    const out = await run({
      payments: [{ kind: 'bill', billId: BILL_ID, amount: 150 }]
    });
    expect(out.updated[0]).toMatchObject({
      status: 'paid',
      paidSoFar: 150,
      remaining: -50,
      overpaid: 50
    });
  });

  it('still RECORDS the overpaying receipt (never drops money it flags)', async () => {
    // Refusing would lose a payment the landlord actually made. Flag + record.
    state.bill = makeBillDoc({ totalAmount: 100 });
    await run({ payments: [{ kind: 'bill', billId: BILL_ID, amount: 150 }] });
    expect(state.bill.receipts).toHaveLength(1);
    expect(state.saved).toHaveLength(1);
  });

  it('reports the excess when INSTALLMENTS cumulatively pass the total', async () => {
    // The realistic path: two receipts each below the total, the second tips it.
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [{ amount: 80, date: new Date('2026-07-01'), proofUrl: 'b2://A' }]
    });
    const out = await run({
      payments: [
        { kind: 'bill', billId: BILL_ID, amount: 40, proofUrl: 'b2://B' }
      ]
    });
    expect(out.updated[0]).toMatchObject({ paidSoFar: 120, overpaid: 20 });
  });

  it('does NOT report an overpayment on an exact payment', async () => {
    state.bill = makeBillDoc({ totalAmount: 100 });
    const out = await run({
      payments: [{ kind: 'bill', billId: BILL_ID, amount: 100 }]
    });
    expect(out.updated[0].status).toBe('paid');
    expect(out.updated[0].overpaid).toBeUndefined();
  });

  it('does NOT report an overpayment on a partial payment', async () => {
    state.bill = makeBillDoc({ totalAmount: 100 });
    const out = await run({
      payments: [{ kind: 'bill', billId: BILL_ID, amount: 40 }]
    });
    expect(out.updated[0].overpaid).toBeUndefined();
  });

  it('stays SILENT on a one-cent split artifact (33,34+33,33+33,34)', async () => {
    // A €100 bill split three ways cannot land exactly, so the landlord's own
    // installments routinely sum to 100,01. Warning on that would train the
    // operator to ignore the banner that matters. Note this is ABOVE the +0.005
    // tolerance the paid/partial decision uses — that half-cent is for the
    // SHORTFALL direction and is the wrong unit here.
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [
        { amount: 33.34, date: new Date('2026-07-01'), proofUrl: 'b2://A' },
        { amount: 33.33, date: new Date('2026-07-02'), proofUrl: 'b2://B' }
      ]
    });
    const out = await run({
      payments: [
        { kind: 'bill', billId: BILL_ID, amount: 33.34, proofUrl: 'b2://C' }
      ]
    });
    expect(out.updated[0].paidSoFar).toBe(100.01);
    expect(out.updated[0].overpaid).toBeUndefined();
  });

  it('does NOT report an overpayment on a DEDUPED re-submit', async () => {
    // The dedup skipped the write, so Σ(receipts) did not move — reporting an
    // excess here would blame the operator for a payment that never landed.
    state.bill = makeBillDoc({
      totalAmount: 100,
      receipts: [{ amount: 150, date: new Date('2026-07-01'), proofUrl: 'b2://A' }]
    });
    const out = await run({
      payments: [
        { kind: 'bill', billId: BILL_ID, amount: 150, proofUrl: 'b2://A' }
      ]
    });
    expect(out.updated[0]).toMatchObject({ duplicate: true });
    expect(out.updated[0].overpaid).toBeUndefined();
  });

  it('rounds the excess to cents (never a float tail)', async () => {
    state.bill = makeBillDoc({ totalAmount: 100.1 });
    const out = await run({
      payments: [{ kind: 'bill', billId: BILL_ID, amount: 100.2 }]
    });
    // 100.2 − 100.1 = 0.09999999999999432 in IEEE-754.
    expect(out.updated[0].overpaid).toBe(0.1);
  });

  it('reports the excess on a REPAIR too (shared code path)', async () => {
    state.building = makeBuildingWithRepair({ actualCost: 200 });
    const out = await run({
      payments: [
        {
          kind: 'repair',
          repairId: REPAIR_ID,
          buildingId: BUILDING_ID,
          amount: 250
        }
      ]
    });
    expect(out.updated[0]).toMatchObject({
      kind: 'repair',
      fullyPaid: true,
      overpaid: 50
    });
    expect(state.building._repair.receipts).toHaveLength(1);
  });

  it('does NOT report an overpayment on an exactly-covered repair', async () => {
    state.building = makeBuildingWithRepair({ actualCost: 200 });
    const out = await run({
      payments: [
        {
          kind: 'repair',
          repairId: REPAIR_ID,
          buildingId: BUILDING_ID,
          amount: 200
        }
      ]
    });
    expect(out.updated[0].fullyPaid).toBe(true);
    expect(out.updated[0].overpaid).toBeUndefined();
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

  // Mirror of the bill-side receipt-identity case: the repair branch shares
  // isDuplicateReceipt, so it needs its own coverage or a regression that only
  // breaks building.repairs[].receipts sails through.
  it('an UNDATED repair retry of the same proofUrl is deduped across a day boundary', async () => {
    state.building = makeBuildingWithRepair({
      actualCost: 500,
      receipts: [
        {
          amount: 100,
          date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
          proofUrl: 'b2://r-A'
        }
      ]
    });
    const out = await run({
      payments: [
        {
          kind: 'repair',
          repairId: REPAIR_ID,
          buildingId: BUILDING_ID,
          amount: 100,
          // no date → server-clock stamp
          proofUrl: 'b2://r-A'
        }
      ]
    });
    expect(state.building._repair.receipts).toHaveLength(1);
    expect(state.building._repair.isPaidFromRepairsFund).toBeUndefined();
    expect(out.updated[0]).toMatchObject({ duplicate: true });
  });
});
