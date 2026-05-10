import taskBase from '../tasks/1_base.js';
import taskDebts from '../tasks/2_debts.js';
import taskDiscounts from '../tasks/3_discounts.js';
import taskVATs from '../tasks/4_vats.js';
import taskBalance from '../tasks/5_balance.js';
import taskPayments from '../tasks/6_payments.js';
import taskTotal from '../tasks/7_total.js';
import { computeRent } from '../index.js';

function makeRent() {
  return {
    term: 0,
    month: 0,
    year: 0,
    preTaxAmounts: [],
    charges: [],
    discounts: [],
    debts: [],
    vats: [],
    payments: [],
    description: '',
    total: {
      balance: 0,
      preTaxAmount: 0,
      charges: 0,
      discount: 0,
      vat: 0,
      grandTotal: 0,
      payment: 0
    }
  };
}

function makeContract(overrides = {}) {
  return {
    frequency: 'months',
    properties: [],
    vatRate: 0,
    discount: 0,
    ...overrides
  };
}

function makeProperty(name, rent, entryDate, exitDate, expenses = []) {
  return {
    property: { name },
    rent,
    entryDate,
    exitDate,
    expenses
  };
}

const RENT_DATE = '01/01/2024 00:00';

describe('Task 1: Base', () => {
  test('sets term, month, year from rentDate', () => {
    const contract = makeContract({ frequency: 'months' });
    const rent = taskBase(contract, RENT_DATE, null, null, makeRent());
    expect(rent.term).toBe(2024010100);
    expect(rent.month).toBe(1);
    expect(rent.year).toBe(2024);
  });

  test('adds preTaxAmounts for active properties', () => {
    const contract = makeContract({
      properties: [makeProperty('Apt A', 1000, '2023-01-01', '2025-12-31')]
    });
    const rent = taskBase(contract, RENT_DATE, null, null, makeRent());
    expect(rent.preTaxAmounts).toEqual([
      { description: 'Apt A', amount: 1000 }
    ]);
  });

  test('excludes properties outside date range', () => {
    const contract = makeContract({
      properties: [makeProperty('Apt A', 1000, '2025-01-01', '2025-12-31')]
    });
    const rent = taskBase(contract, RENT_DATE, null, null, makeRent());
    expect(rent.preTaxAmounts).toEqual([]);
  });

  test('adds charges from active expenses', () => {
    const contract = makeContract({
      properties: [
        makeProperty('Apt A', 1000, '2023-01-01', '2025-12-31', [
          {
            title: 'Water',
            amount: 50,
            beginDate: '01/01/2023',
            endDate: '31/12/2025'
          }
        ])
      ]
    });
    const rent = taskBase(contract, RENT_DATE, null, null, makeRent());
    expect(rent.charges).toEqual([{ description: 'Water', amount: 50 }]);
  });

  test('excludes expenses outside date range', () => {
    const contract = makeContract({
      properties: [
        makeProperty('Apt A', 1000, '2023-01-01', '2025-12-31', [
          {
            title: 'Water',
            amount: 50,
            beginDate: '01/01/2025',
            endDate: '31/12/2025'
          }
        ])
      ]
    });
    const rent = taskBase(contract, RENT_DATE, null, null, makeRent());
    expect(rent.charges).toEqual([]);
  });

  test('sets description from settlements', () => {
    const contract = makeContract();
    const rent = taskBase(
      contract,
      RENT_DATE,
      null,
      { description: 'Note' },
      makeRent()
    );
    expect(rent.description).toBe('Note');
  });
});

describe('Task 2: Debts', () => {
  test('adds debts from settlements', () => {
    const settlements = {
      debts: [{ description: 'Late fee', amount: 100 }]
    };
    const rent = taskDebts(
      makeContract(),
      RENT_DATE,
      null,
      settlements,
      makeRent()
    );
    expect(rent.debts).toEqual([{ description: 'Late fee', amount: 100 }]);
  });

  test('no debts when settlements is null', () => {
    const rent = taskDebts(makeContract(), RENT_DATE, null, null, makeRent());
    expect(rent.debts).toEqual([]);
  });
});

describe('Task 3: Discounts', () => {
  test('adds contract-level discount', () => {
    const contract = makeContract({ discount: 200 });
    const rent = taskDiscounts(contract, RENT_DATE, null, null, makeRent());
    expect(rent.discounts).toEqual([
      { origin: 'contract', description: 'Remise exceptionnelle', amount: 200 }
    ]);
  });

  test('adds settlement discounts', () => {
    const settlements = {
      discounts: [{ description: 'Promo', amount: 50 }]
    };
    const rent = taskDiscounts(
      makeContract(),
      RENT_DATE,
      null,
      settlements,
      makeRent()
    );
    expect(rent.discounts).toEqual([
      { origin: 'settlement', description: 'Promo', amount: 50 }
    ]);
  });

  test('combines contract and settlement discounts', () => {
    const contract = makeContract({ discount: 100 });
    const settlements = {
      discounts: [{ description: 'Promo', amount: 50 }]
    };
    const rent = taskDiscounts(
      contract,
      RENT_DATE,
      null,
      settlements,
      makeRent()
    );
    expect(rent.discounts).toHaveLength(2);
  });
});

describe('Task 4: VATs', () => {
  test('no vats when vatRate is 0', () => {
    const r = makeRent();
    r.preTaxAmounts = [{ description: 'Apt', amount: 1000 }];
    const rent = taskVATs(
      makeContract({ vatRate: 0 }),
      RENT_DATE,
      null,
      null,
      r
    );
    expect(rent.vats).toEqual([]);
  });

  test('computes vat on preTaxAmounts', () => {
    const r = makeRent();
    r.preTaxAmounts = [{ description: 'Apt', amount: 1000 }];
    const rent = taskVATs(
      makeContract({ vatRate: 0.2 }),
      RENT_DATE,
      null,
      null,
      r
    );
    expect(rent.vats).toEqual([
      {
        origin: 'contract',
        description: 'Apt T.V.A. (20%)',
        amount: 200,
        rate: 0.2
      }
    ]);
  });

  test('computes vat on charges and discounts (not debts)', () => {
    const r = makeRent();
    r.preTaxAmounts = [{ description: 'Apt', amount: 1000 }];
    r.charges = [{ description: 'Water', amount: 100 }];
    r.debts = [{ description: 'Late', amount: 50 }];
    r.discounts = [{ origin: 'contract', description: 'Disc', amount: 200 }];
    const rent = taskVATs(
      makeContract({ vatRate: 0.2 }),
      RENT_DATE,
      null,
      null,
      r
    );
    // VAT on: preTaxAmounts, charges, discounts (NOT debts - they already include VAT)
    expect(rent.vats).toHaveLength(3);
    const discountVat = rent.vats.find((v) => v.description.includes('Disc'));
    expect(discountVat.amount).toBe(-40);
  });
});

describe('Task 5: Balance', () => {
  test('zero balance when no previous rent', () => {
    const rent = taskBalance(makeContract(), RENT_DATE, null, null, makeRent());
    expect(rent.total.balance).toBe(0);
  });

  test('carries forward unpaid balance from previous rent', () => {
    const previousRent = {
      total: { grandTotal: 1000, payment: 700 }
    };
    const rent = taskBalance(
      makeContract(),
      RENT_DATE,
      previousRent,
      null,
      makeRent()
    );
    expect(rent.total.balance).toBe(300);
  });

  test('negative balance when overpaid', () => {
    const previousRent = {
      total: { grandTotal: 1000, payment: 1200 }
    };
    const rent = taskBalance(
      makeContract(),
      RENT_DATE,
      previousRent,
      null,
      makeRent()
    );
    expect(rent.total.balance).toBe(-200);
  });
});

describe('Task 6: Payments', () => {
  test('adds payments from settlements', () => {
    const payment = {
      date: '2024-01-15',
      amount: 500,
      type: 'transfer',
      reference: 'REF1'
    };
    const settlements = { payments: [payment] };
    const rent = taskPayments(
      makeContract(),
      RENT_DATE,
      null,
      settlements,
      makeRent()
    );
    expect(rent.payments).toEqual([payment]);
  });

  test('no payments when settlements is null', () => {
    const rent = taskPayments(
      makeContract(),
      RENT_DATE,
      null,
      null,
      makeRent()
    );
    expect(rent.payments).toEqual([]);
  });
});

describe('Task 7: Total', () => {
  test('computes grandTotal from all components', () => {
    const r = makeRent();
    r.preTaxAmounts = [{ description: 'Apt', amount: 1000 }];
    r.charges = [{ description: 'Water', amount: 100 }];
    r.debts = [{ description: 'Late', amount: 50 }];
    r.discounts = [{ origin: 'contract', description: 'Disc', amount: 200 }];
    r.vats = [{ description: 'VAT', amount: 190 }];
    r.payments = [{ amount: 800 }];
    r.total.balance = 300;

    const rent = taskTotal(makeContract(), RENT_DATE, null, null, r);
    // grandTotal = 1000 + 100 + 50 - 200 + 190 + 300 = 1440
    expect(rent.total.grandTotal).toBe(1440);
    expect(rent.total.preTaxAmount).toBe(1000);
    expect(rent.total.charges).toBe(100);
    expect(rent.total.debts).toBe(50);
    expect(rent.total.discount).toBe(200);
    expect(rent.total.vat).toBe(190);
    expect(rent.total.payment).toBe(800);
  });
});

describe('Full pipeline: computeRent', () => {
  test('basic rent - single property, no extras', () => {
    const contract = makeContract({
      properties: [makeProperty('Apt A', 1000, '2023-01-01', '2025-12-31')]
    });
    const rent = computeRent(contract, RENT_DATE, null, null);
    expect(rent.total.preTaxAmount).toBe(1000);
    expect(rent.total.grandTotal).toBe(1000);
    expect(rent.total.payment).toBe(0);
  });

  test('rent with VAT', () => {
    const contract = makeContract({
      vatRate: 0.2,
      properties: [makeProperty('Apt A', 1000, '2023-01-01', '2025-12-31')]
    });
    const rent = computeRent(contract, RENT_DATE, null, null);
    expect(rent.total.preTaxAmount).toBe(1000);
    expect(rent.total.vat).toBe(200);
    expect(rent.total.grandTotal).toBe(1200);
  });

  test('rent with contract discount', () => {
    const contract = makeContract({
      discount: 100,
      properties: [makeProperty('Apt A', 1000, '2023-01-01', '2025-12-31')]
    });
    const rent = computeRent(contract, RENT_DATE, null, null);
    expect(rent.total.discount).toBe(100);
    expect(rent.total.grandTotal).toBe(900);
  });

  test('rent with previous balance carried forward', () => {
    const contract = makeContract({
      properties: [makeProperty('Apt A', 1000, '2023-01-01', '2025-12-31')]
    });
    const previousRent = { total: { grandTotal: 1000, payment: 600 } };
    const rent = computeRent(contract, RENT_DATE, previousRent, null);
    expect(rent.total.balance).toBe(400);
    expect(rent.total.grandTotal).toBe(1400);
  });

  test('full scenario - rent + charges + debts + discount + VAT + balance + payments', () => {
    const contract = makeContract({
      vatRate: 0.1,
      discount: 50,
      properties: [
        makeProperty('Apt A', 1000, '2023-01-01', '2025-12-31', [
          {
            title: 'Parking',
            amount: 100,
            beginDate: '01/01/2023',
            endDate: '31/12/2025'
          }
        ])
      ]
    });
    const previousRent = { total: { grandTotal: 500, payment: 300 } };
    const settlements = {
      description: 'January settlement',
      debts: [{ description: 'Repair', amount: 75 }],
      discounts: [{ description: 'Loyalty', amount: 25 }],
      payments: [
        { date: '2024-01-10', amount: 900, type: 'check', reference: 'CHK1' }
      ]
    };

    const rent = computeRent(contract, RENT_DATE, previousRent, settlements);

    expect(rent.total.preTaxAmount).toBe(1000);
    expect(rent.total.charges).toBe(100);
    expect(rent.total.debts).toBe(75);
    expect(rent.total.discount).toBe(75); // 50 contract + 25 settlement
    expect(rent.total.balance).toBe(200); // 500 - 300
    // VAT: (1000 + 100 - 75) * 0.1 = 102.5 (debts no longer taxed)
    expect(rent.total.vat).toBe(102.5);
    // grandTotal = 1000 + 100 + 75 - 75 + 102.5 + 200 = 1402.5
    expect(rent.total.grandTotal).toBe(1402.5);
    expect(rent.total.payment).toBe(900);
    expect(rent.description).toBe('January settlement');
  });

  test('multiple properties', () => {
    const contract = makeContract({
      properties: [
        makeProperty('Apt A', 800, '2023-01-01', '2025-12-31'),
        makeProperty('Apt B', 600, '2023-06-01', '2025-12-31')
      ]
    });
    const rent = computeRent(contract, RENT_DATE, null, null);
    expect(rent.total.preTaxAmount).toBe(1400);
    expect(rent.total.grandTotal).toBe(1400);
  });
});
