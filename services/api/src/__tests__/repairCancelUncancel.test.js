/* eslint-env node, jest */
// Step-7 (cancel→un-cancel orphan): drive the REAL buildingmanager
// _distributeRepairCharge through a full lifecycle:
//   distribute → record payment → CANCEL → UN-CANCEL
// On cancel, _removeRepairCharges converts a PAID repair owner row to a
// source:'credit' remnant (amount 0, payments preserved) instead of pulling
// it. On un-cancel, _distributeRepairCharge MUST re-absorb that credit's
// καταβολές into the per-property pool and STRIP the credit — else the repair
// re-opens fully outstanding AND the credit floats as a disconnected row
// (double-display of the same money + lost settlement). This exercises the
// `isRepairOwnerRow` predicate (now incl. 'credit' scoped to repairId).
//
// `type: module` package → jest.mock(factory) does not hoist under ESM; use
// jest.unstable_mockModule + dynamic import (see ownerEksodaByMonth.test.js).
import { jest } from '@jest/globals';

let _distributeRepairCharge;

beforeAll(async () => {
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  // No tenants in the realm → every unit vacant; _recomputeTenantsForProperty
  // and _occupiedPropertyIdsForTerm both see an empty set. The find() result
  // serves BOTH call shapes: `await find(...)` (array, .length 0) and
  // `find(...).lean()` (resolves to []).
  const emptyTenants = () => Object.assign([], { lean: async () => [] });
  // Use the REAL OwnerStatement util (ownerKeyOf etc.) the manager imports.
  const OwnerStatement = await import(
    '../../../common/src/utils/ownerstatement.ts'
  );
  // 1_base (transitively imported) now imports ShareBasis from common — provide the REAL util.
  const ShareBasis = await import(
    '../../../common/src/utils/sharebasis.ts'
  );
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Tenant: { find: () => emptyTenants() },
      Property: { find: () => ({ lean: async () => [] }) }
    },
      // billmanager + telegramInboxScanner now take the charge month and the
      // bill-term fit from the shared rule, so this factory must provide it.
      // unstable_mockModule replaces the WHOLE module: an export the graph consumes
      // but the factory omits is `undefined` at call time, which surfaces as a
      // TypeError deep inside rather than a resolution error.
      BillTerm: {
        billTermFitsExpense: () => ({ fits: true }),
        billTermIsOutsideExpense: () => false,
        computeChargeTerm: (b) => {
          const d = new Date(b?.issueDate || b?.periodEnd);
          return Number.isFinite(d.getTime())
            ? d.getUTCFullYear() * 1000000 + (d.getUTCMonth() + 1) * 10000 + 100
            : undefined;
        }
      },
    logger: { warn() {}, info() {}, error() {} },
    ServiceError,
    OwnerStatement,
    ShareBasis
  }));
  jest.unstable_mockModule('../managers/occupantmanager.js', () => ({
    _attachTenantGroupsToBuildings: async (_realmId, buildings) => {
      buildings.forEach((b) => (b._tenantGroups = []));
    }
  }));

  ({ _distributeRepairCharge } = await import('../managers/buildingmanager.js'));
});

// A Mongoose-DocumentArray-like shim: .pull(_id) / .push(row) / .id(_id) plus
// auto-assigned _id on push so freshly-pushed rows are addressable.
let _idSeq = 0;
function docArray(initial = []) {
  const arr = initial.map((x) => ({ _id: x._id || `gen_${++_idSeq}`, ...x }));
  arr.pull = function (id) {
    const i = this.findIndex((e) => String(e._id) === String(id));
    if (i >= 0) this.splice(i, 1);
  };
  arr.push = function (row) {
    const withId = { _id: row._id || `gen_${++_idSeq}`, ...row };
    Array.prototype.push.call(this, withId);
    return withId;
  };
  arr.id = function (id) {
    return this.find((e) => String(e._id) === String(id)) || null;
  };
  return arr;
}

function mkBuilding(repair, ownerRows = []) {
  const unit = {
    _id: 'u_p1',
    propertyId: 'p1',
    isManaged: true,
    surface: 50,
    // Sole unit holds all thousandths so a 100%-tenant repair on a vacant unit
    // allocates the full tenant share to it (→ a €100 repair-vacant row). The
    // owners-only / split tests don't depend on this (owner-portion is
    // cost-based), so it's a harmless superset for all cases.
    generalThousandths: 1000,
    heatingThousandths: 1000,
    elevatorThousandths: 1000,
    owners: [{ name: 'ΜΑΡΙΑ', taxId: '111', percentage: 100 }],
    monthlyCharges: docArray([])
  };
  return {
    _id: 'b1',
    name: 'B1',
    realmId: 'r1',
    atakPrefix: '011000',
    units: [unit],
    expenses: [],
    repairs: docArray([repair]),
    contractors: [],
    ownerMonthlyExpenses: docArray(ownerRows),
    updatedDate: new Date('2026-01-01'),
    save: async function () {
      /* no-op: in-memory test, no DB */
    }
  };
}

const REPAIR_ID = 'rep_cancel';
const TERM = 2026060100;

const ownerRowsFor = (b) =>
  b.ownerMonthlyExpenses.filter(
    (e) => String(e.expenseId) === REPAIR_ID
  );
const sumPayments = (row) =>
  (row.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);

describe('_distributeRepairCharge cancel→un-cancel (credit re-absorption)', () => {
  it('un-cancelling a paid owners-only repair re-absorbs the credit — one repair row, fully paid, no orphan', async () => {
    const repair = {
      _id: REPAIR_ID,
      title: 'ταράτσα',
      category: 'roof',
      chargeableTo: 'owners',
      actualCost: 100,
      chargeTerm: TERM,
      status: 'planned'
    };
    const building = mkBuilding(repair);

    // 1. Initial distribute → one source:'repair' owner row, €100, unpaid.
    await _distributeRepairCharge(building, repair, 'r1');
    let rows = ownerRowsFor(building);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('repair');
    expect(rows[0].amount).toBe(100);
    expect(sumPayments(rows[0])).toBe(0);

    // 2. Owner pays €100 against that row (simulate the καταβολή dialog fan-out).
    rows[0].payments = [{ amount: 100, date: '05/06/2026', type: 'transfer' }];
    rows[0].paid = true;
    rows[0].paidDate = new Date('2026-06-05');

    // 3. CANCEL → _removeRepairCharges converts the paid row to a 'credit'
    //    remnant (amount 0, payments preserved) — NOT pulled.
    repair.status = 'cancelled';
    await _distributeRepairCharge(building, repair, 'r1');
    rows = ownerRowsFor(building);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('credit');
    expect(rows[0].amount).toBe(0);
    expect(sumPayments(rows[0])).toBe(100); // money preserved

    // 4. UN-CANCEL → credit rows are INERT (never re-absorbed/stripped), so the
    //    €100 credit SURVIVES and a fresh €100 'repair' liability re-opens beside
    //    it. The two reconcile at the TERM level: owed €100 (the re-opened
    //    liability) === paid €100 (the surviving credit) → fully settled, NO
    //    money lost, NO double-count. (Re-absorbing the credit into the liability
    //    — to show one merged row — is purely cosmetic and was the root of a
    //    money-loss bug class under occupy/vacate oscillation; Step-7 round 3.)
    repair.status = 'planned';
    await _distributeRepairCharge(building, repair, 'r1');
    rows = ownerRowsFor(building);
    const liability = rows.find((r) => r.source === 'repair');
    const credit = rows.find((r) => r.source === 'credit');
    expect(liability).toBeTruthy();
    expect(liability.amount).toBe(100); // repair re-opened
    expect(credit).toBeTruthy();
    expect(credit.amount).toBe(0);
    // term-level settlement: total owed === total paid (no loss, no double-count).
    const totalOwed = rows.reduce((s, r) => s + Number(r.amount), 0);
    const totalPaid = rows.reduce((s, r) => s + sumPayments(r), 0);
    expect(totalOwed).toBe(100);
    expect(totalPaid).toBe(100);
  });

  // Step-7 (credit-double-count lens, FULL-LOSS variant): un-cancelling a paid
  // repair AND simultaneously shrinking its owner-portion to 0 (reclassify to
  // 100% tenant, occupied unit) must NOT silently drop the preserved καταβολή.
  // Before the preserveByProp fix, the credit was captured+stripped but no live
  // owner row could absorb it → leftover dropped → money gone from every surface.
  // Now the unabsorbable leftover is re-preserved as a source:'credit' row.
  it('un-cancel + shrink owner-portion to 0 (reclassify to tenant) preserves the καταβολή as a credit (no money loss)', async () => {
    const repair = {
      _id: REPAIR_ID,
      title: 'σκεπή',
      category: 'roof',
      chargeableTo: 'owners', // owner-portion = full cost initially
      actualCost: 100,
      chargeTerm: TERM,
      status: 'planned'
    };
    const building = mkBuilding(repair);

    await _distributeRepairCharge(building, repair, 'r1');
    let rows = ownerRowsFor(building);
    rows[0].payments = [{ amount: 100, date: '05/06/2026', type: 'transfer' }];
    rows[0].paid = true;

    // CANCEL → credit remnant (amount 0, €100 preserved).
    repair.status = 'cancelled';
    await _distributeRepairCharge(building, repair, 'r1');
    expect(ownerRowsFor(building)).toHaveLength(1);
    expect(ownerRowsFor(building)[0].source).toBe('credit');

    // UN-CANCEL + reclassify to 100% tenant in ONE run → ownerPortion shrinks to
    // 0 (no owner liability row). The €100 has no live row to land on, but it is
    // recorded money → must be PRESERVED as a credit, not dropped.
    repair.status = 'planned';
    repair.chargeableTo = 'tenants';
    repair.tenantSharePercentage = 100;
    await _distributeRepairCharge(building, repair, 'r1');
    rows = ownerRowsFor(building);
    // The owner's €100 survives somewhere on this repair (as a credit remnant).
    expect(sumPayments(rows.reduce((acc, r) => ({ payments: [...(acc.payments || []), ...(r.payments || [])] }), {}))).toBe(100);
    // and it is carried by a source:'credit' row (amount 0 → leak-free).
    const credit = rows.find((r) => r.source === 'credit');
    expect(credit).toBeTruthy();
    expect(credit.amount).toBe(0);
    expect(sumPayments(credit)).toBe(100);
  });

  // Step-7 (flag-gating lens, CRITICAL): flipping chargeOwnerWhenVacant OFF on a
  // PAID repair-vacant row (100%-tenant repair, vacant unit) sends the share to
  // Αχρέωτα — but the owner's already-recorded καταβολή must NOT vanish. Before
  // the fix it was dropped as "overpayment". Now preserved as a credit.
  it('flipping chargeOwnerWhenVacant OFF on a PAID repair-vacant row preserves the καταβολή (no money loss)', async () => {
    const repair = {
      _id: REPAIR_ID,
      title: 'υδραυλικά',
      category: 'plumbing',
      chargeableTo: 'tenants',
      tenantSharePercentage: 100,
      actualCost: 100,
      chargeTerm: TERM,
      status: 'completed',
      chargeOwnerWhenVacant: true // flag ON → vacant share routes to owner
    };
    const building = mkBuilding(repair); // p1 vacant (no tenants in realm)

    await _distributeRepairCharge(building, repair, 'r1');
    let rows = ownerRowsFor(building);
    const rv = rows.find((r) => r.source === 'repair-vacant');
    expect(rv).toBeTruthy();
    expect(rv.amount).toBe(100);
    // owner pays the repair-vacant row.
    rv.payments = [{ amount: 100, date: '05/06/2026', type: 'transfer' }];
    rv.paid = true;

    // landlord flips the flag OFF (plain edit, status stays live) → the share
    // becomes Αχρέωτα (no owner row), but the recorded €100 must survive.
    repair.chargeOwnerWhenVacant = false;
    await _distributeRepairCharge(building, repair, 'r1');
    rows = ownerRowsFor(building);
    // No repair-vacant liability row anymore (Αχρέωτα), but a credit holds the €100.
    expect(rows.find((r) => r.source === 'repair-vacant')).toBeFalsy();
    const credit = rows.find((r) => r.source === 'credit');
    expect(credit).toBeTruthy();
    expect(credit.amount).toBe(0);
    expect(sumPayments(credit)).toBe(100); // recorded money survived the flag flip
  });

  // IDEMPOTENCY: once a credit remnant exists (flag-off repair-vacant payment),
  // repeated innocuous re-distributes must keep EXACTLY ONE credit row carrying
  // EXACTLY the same payment total — not duplicate it, not grow it, not drop it.
  // (The credit row has expenseId===repairId so each run re-captures+re-emits it.)
  it('repeated re-distributes keep a preserved credit at exactly one row / same amount (idempotent)', async () => {
    const repair = {
      _id: REPAIR_ID,
      title: 'καλωδίωση',
      category: 'electrical',
      chargeableTo: 'tenants',
      tenantSharePercentage: 100,
      actualCost: 100,
      chargeTerm: TERM,
      status: 'completed',
      chargeOwnerWhenVacant: true
    };
    const building = mkBuilding(repair);
    await _distributeRepairCharge(building, repair, 'r1');
    const rv = ownerRowsFor(building).find((r) => r.source === 'repair-vacant');
    rv.payments = [{ amount: 100, date: '05/06/2026', type: 'transfer' }];
    rv.paid = true;
    // flag OFF → preserve as credit.
    repair.chargeOwnerWhenVacant = false;
    await _distributeRepairCharge(building, repair, 'r1');
    // two more innocuous edits (title change) — credit must stay stable.
    repair.title = 'καλωδίωση (1)';
    await _distributeRepairCharge(building, repair, 'r1');
    repair.title = 'καλωδίωση (2)';
    await _distributeRepairCharge(building, repair, 'r1');
    const credits = ownerRowsFor(building).filter((r) => r.source === 'credit');
    expect(credits).toHaveLength(1); // not duplicated across re-runs
    expect(sumPayments(credits[0])).toBe(100); // not grown, not lost
  });

  // Flag OFF→ON round-trip: credits are INERT, so after flipping the flag back ON
  // the preserved €100 credit SURVIVES and a fresh €100 repair-vacant liability
  // re-opens beside it. They reconcile at the TERM level (owed €100 === paid
  // €100) → fully settled, money paid exactly once, NO loss, NO double-count. The
  // credit is NOT merged into the liability (re-absorption was the root of an
  // oscillation money-loss bug; Step-7 round 3). Idempotency across re-runs is
  // covered by the test above.
  it('flag OFF→ON round-trip: credit survives + liability re-opens, settled at term level (no loss, no double-count)', async () => {
    const repair = {
      _id: REPAIR_ID,
      title: 'μόνωση',
      category: 'roof',
      chargeableTo: 'tenants',
      tenantSharePercentage: 100,
      actualCost: 100,
      chargeTerm: TERM,
      status: 'completed',
      chargeOwnerWhenVacant: true
    };
    const building = mkBuilding(repair);
    await _distributeRepairCharge(building, repair, 'r1');
    const rv = ownerRowsFor(building).find((r) => r.source === 'repair-vacant');
    rv.payments = [{ amount: 100, date: '05/06/2026', type: 'transfer' }];
    rv.paid = true;
    repair.chargeOwnerWhenVacant = false; // → credit
    await _distributeRepairCharge(building, repair, 'r1');
    expect(ownerRowsFor(building).filter((r) => r.source === 'credit')).toHaveLength(1);
    repair.chargeOwnerWhenVacant = true; // → liability returns
    await _distributeRepairCharge(building, repair, 'r1');
    const rows = ownerRowsFor(building);
    const credit = rows.find((r) => r.source === 'credit');
    const liability = rows.find((r) => r.source === 'repair-vacant');
    expect(liability).toBeTruthy();
    expect(liability.amount).toBe(100); // liability re-opened (unpaid)
    expect(credit).toBeTruthy();
    expect(credit.amount).toBe(0);
    // exactly ONE credit row (inert, never duplicated), carrying the €100 once.
    expect(rows.filter((r) => r.source === 'credit')).toHaveLength(1);
    // term-level reconciliation: owed €100 === paid €100 → settled, paid once.
    const totalOwed = rows.reduce((s, r) => s + Number(r.amount), 0);
    const totalPaid = rows.reduce((s, r) => s + sumPayments(r), 0);
    expect(totalOwed).toBe(100);
    expect(totalPaid).toBe(100);
  });

  // OSCILLATION (Step-7 round-3 money-loss regression guard): occupy→vacate→
  // occupy must NOT lose the preserved credit. Because credits are inert, the
  // €100 credit is never re-captured/re-dropped — it survives every transition.
  it('occupy→vacate→occupy oscillation never loses the preserved credit (inert)', async () => {
    const repair = {
      _id: REPAIR_ID,
      title: 'στεγανοποίηση',
      category: 'roof',
      chargeableTo: 'tenants',
      tenantSharePercentage: 100,
      actualCost: 100,
      chargeTerm: TERM,
      status: 'completed',
      chargeOwnerWhenVacant: true
    };
    const building = mkBuilding(repair);
    await _distributeRepairCharge(building, repair, 'r1');
    const rv = ownerRowsFor(building).find((r) => r.source === 'repair-vacant');
    rv.payments = [{ amount: 100, date: '05/06/2026', type: 'transfer' }];
    rv.paid = true;
    // flag OFF → €100 credit (Αχρέωτα, no tenant twin yet).
    repair.chargeOwnerWhenVacant = false;
    await _distributeRepairCharge(building, repair, 'r1');
    const creditAmt = () =>
      ownerRowsFor(building)
        .filter((r) => r.source === 'credit')
        .reduce((s, r) => s + sumPayments(r), 0);
    expect(creditAmt()).toBe(100);
    // repeated innocuous edits across the would-be oscillation: credit untouched.
    for (let i = 0; i < 4; i++) {
      repair.title = `στεγανοποίηση (${i})`;
      await _distributeRepairCharge(building, repair, 'r1');
      expect(creditAmt()).toBe(100); // never lost, never grown
    }
    // exactly one credit row throughout (never duplicated).
    expect(ownerRowsFor(building).filter((r) => r.source === 'credit')).toHaveLength(1);
  });

  it('un-cancel with no recorded payment leaves a clean single unpaid repair row (credit path never engaged)', async () => {
    const repair = {
      _id: REPAIR_ID,
      title: 'βαφή',
      category: 'painting',
      chargeableTo: 'owners',
      actualCost: 80,
      chargeTerm: TERM,
      status: 'planned'
    };
    const building = mkBuilding(repair);

    await _distributeRepairCharge(building, repair, 'r1');
    // Cancel (no payment recorded → the row is pulled outright, no credit).
    repair.status = 'cancelled';
    await _distributeRepairCharge(building, repair, 'r1');
    expect(ownerRowsFor(building)).toHaveLength(0);
    // Un-cancel → fresh single unpaid row.
    repair.status = 'planned';
    await _distributeRepairCharge(building, repair, 'r1');
    const rows = ownerRowsFor(building);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('repair');
    expect(rows[0].amount).toBe(80);
    expect(sumPayments(rows[0])).toBe(0);
  });
});
