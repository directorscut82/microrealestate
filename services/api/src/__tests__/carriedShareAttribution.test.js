/* eslint-env node, jest */
/**
 * A payment attributed to a share that was carried into a month (DEFERRED_DECISIONS
 * D-10: a share of a building charge whose own month was closed for the tenant is
 * billed on the tenant's next open month, as one more line after the month's own).
 *
 * Attributions name the line they pay by a key. The lines of the month itself are
 * named by position (`building:<i>`), as they always were. A carried line can be
 * joined or left by others at any time — another late bill arrives, a figure is saved
 * as 0 — so a position would end up naming another line: it is named by what it is,
 * `building:<propertyId>:<expenseId>:<YYMM of the month it is for>`
 * (managers/chargecarry.ts `buildingLineKey`).
 *
 * Runs the REAL updateByTerm → _updateByTerm → Contract.payTerm, and the real engine
 * for the ledger, against a mocked database (same harness as
 * paymentPathsWithCarriedCredit.test.js).
 */
import { jest } from '@jest/globals';
import moment from 'moment';

let rentManager;
let dashboardManager;
let Contract;
let chargeCarry;
let TENANT;
let BUILDING;
const writes = [];

beforeAll(async () => {
  const real = await import('@microrealestate/common');
  jest.unstable_mockModule('@microrealestate/common', () => ({
    ...real,
    Collections: {
      ...(real.Collections || {}),
      // A database, as far as these tests go: a read hands out a copy and a write
      // stores one, so a second save sees what the first one stored and nothing
      // else (the handlers re-order the rents they answer with, in place).
      Tenant: {
        find: () => ({ lean: async () => [copy(TENANT)] }),
        findOne: () => ({ lean: async () => copy(TENANT) }),
        findOneAndUpdate: (query, update) => {
          TENANT = {
            ...TENANT,
            rents: copy(update?.$set?.rents || TENANT.rents)
          };
          writes.push(copy(TENANT.rents));
          return { lean: async () => copy(TENANT) };
        }
      },
      Building: {
        find: () => ({
          lean: async () => [JSON.parse(JSON.stringify(BUILDING))]
        })
      }
    },
    // `...real` would leave the real Service singleton in place (see the mock-factory
    // note in test-running-guide.md); same override as the suites next to this one.
    Service: { getInstance: () => ({ envConfig: { getValues: () => ({}) } }) }
  }));
  rentManager = await import('../managers/rentmanager.js');
  dashboardManager = await import('../managers/dashboardmanager.js');
  Contract = await import('../managers/contract.js');
  chargeCarry = await import('../managers/chargecarry.js');
});

beforeEach(() => {
  writes.length = 0;
});

// Dates survive as dates (the engine reads the tenant's own, not their text).
const copy = (value) =>
  value instanceof Date
    ? new Date(value.getTime())
    : Array.isArray(value)
      ? value.map(copy)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, copy(v)])
          )
        : value;

const m0 = moment.utc().startOf('month');
const termOf = (mo) => Number(`${mo.format('YYYYMM')}0100`);
const CURRENT = termOf(m0);
const LAST = termOf(m0.clone().subtract(1, 'months'));
const TWO_AGO = termOf(m0.clone().subtract(2, 'months'));
const TODAY = m0.format('DD/MM/YYYY');
const TID = '507f1f77bcf86cd799439011';
const BEGIN = m0.clone().subtract(3, 'months');
const END = m0.clone().add(8, 'months').endOf('month');

const expense = (id, name, type) => ({
  _id: id,
  name,
  type,
  amount: 0,
  allocationMethod: 'general_thousandths',
  isRecurring: true,
  startTerm: 2020010100,
  customAllocations: []
});
const row = (id, month, amount, expenseId, description) => ({
  _id: id,
  term: month,
  amount,
  inputAmount: amount,
  description,
  expenseId,
  repairId: null,
  carry: true
});
const building = (rows) => ({
  _id: 'b1',
  name: 'Building 1',
  units: [
    {
      _id: 'u1',
      propertyId: 'prop1',
      isManaged: true,
      surface: 80,
      generalThousandths: 1000,
      heatingThousandths: 0,
      elevatorThousandths: 0,
      owners: [],
      monthlyCharges: rows
    }
  ],
  expenses: [
    expense('water', 'Water', 'water_common'),
    expense('power', 'Common power', 'electricity_common')
  ],
  repairs: [],
  contractors: []
});
const properties = () => [
  {
    propertyId: 'prop1',
    rent: 200,
    expenses: [],
    entryDate: BEGIN.toDate(),
    exitDate: END.toDate(),
    property: { name: 'Apt 1', price: 200 }
  }
];

// This month's own water (25) and last month's power (30), which arrived after last
// month was over.
const WATER_NOW = row('row-2', CURRENT, 25, 'water', 'Water');
const POWER_LAST = row('row-3', LAST, 30, 'power', 'Common power');
// …and, later still, the water of two months ago (15). Its row is older than the power
// row, so its line comes before the power line.
const WATER_TWO_AGO = row('row-1', TWO_AGO, 15, 'water', 'Water');

// «2610» for 2026100100. Cut out of the text of the month, on purpose not the way the
// app works it out: the two must agree.
const yymm = (month) => String(month).slice(2, 6);
const POWER_KEY = `building:prop1:power:${yymm(LAST)}`;
const WATER_TWO_AGO_KEY = `building:prop1:water:${yymm(TWO_AGO)}`;

// The tenant as the database holds it: the ledger the real engine gives for a lease
// that began three months ago with every past month paid, recomputed with the
// building's rows.
function tenantWith(rows, payments = undefined) {
  BUILDING = building(rows);
  let contract = Contract.create({
    begin: BEGIN.toDate(),
    end: END.toDate(),
    frequency: 'months',
    properties: properties(),
    buildings: [building([])],
    autoPayThroughTerm: CURRENT
  });
  delete contract.autoPayThroughTerm;
  contract = Contract.update(contract, {
    properties: properties(),
    buildings: [building(rows)]
  });
  if (payments) {
    contract.rents.find((r) => r.term === CURRENT).payments = payments;
  }
  return {
    _id: TID,
    __v: 3,
    name: 'ProbeTenant',
    frequency: 'months',
    beginDate: BEGIN.toDate(),
    endDate: END.toDate(),
    discount: 0,
    properties: properties(),
    rents: contract.rents,
    contacts: [{ email: 'x@x.com' }]
  };
}

const response = () => {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};

async function save(payments) {
  await rentManager.updateByTerm(
    {
      realm: { _id: 'r1' },
      headers: {},
      params: { id: TID, term: String(CURRENT) },
      body: { _id: TID, payments }
    },
    response()
  );
}

// The month as the last write stored it.
const storedMonth = () =>
  (writes[writes.length - 1] || []).find((r) => r.term === CURRENT);
const storedAllocations = () =>
  storedMonth()?.payments.map((p) => [p.amount, p.allocation]);
const storedLines = () =>
  storedMonth()?.buildingCharges.map((l) =>
    l.forTerm === undefined
      ? [l.description, l.amount]
      : [l.description, l.amount, l.forTerm]
  );

const cash = (amount, extra = {}) => ({
  amount,
  date: TODAY,
  type: 'cash',
  reference: '',
  ...extra
});
const line = (category, lineKey, amount) => ({ category, lineKey, amount });

describe('the key of a building line', () => {
  it('a line of the month itself is named by its position, a carried one by what it is', () => {
    const own = {
      description: 'Water',
      amount: 25,
      propertyId: 'p',
      expenseId: 'e'
    };
    const carried = { ...own, forTerm: LAST };
    expect(chargeCarry.buildingLineKey(own, 0)).toBe('building:0');
    expect(chargeCarry.buildingLineKey(own, 7)).toBe('building:7');
    expect(chargeCarry.buildingLineKey(carried, 7)).toBe(
      `building:p:e:${yymm(LAST)}`
    );
  });

  it.each([
    ['no unit', { expenseId: 'e', forTerm: LAST }],
    ['no expense', { propertyId: 'p', forTerm: LAST }],
    [
      'a month that is a text',
      { propertyId: 'p', expenseId: 'e', forTerm: 'x' }
    ],
    [
      'a month that is a fraction',
      { propertyId: 'p', expenseId: 'e', forTerm: 1.5 }
    ],
    ['nothing at all', undefined]
  ])('a line with %s falls back to its position', (_what, damaged) => {
    expect(chargeCarry.buildingLineKey(damaged, 3)).toBe('building:3');
  });

  it('a key finds its line; a position never finds a carried line', () => {
    const rent = {
      buildingCharges: [
        { description: 'Water', amount: 25 },
        {
          description: 'Power',
          amount: 30,
          propertyId: 'p',
          expenseId: 'e',
          forTerm: LAST
        }
      ]
    };
    expect(chargeCarry.buildingLineOf(rent, 'building:0').description).toBe(
      'Water'
    );
    expect(
      chargeCarry.buildingLineOf(rent, `building:p:e:${yymm(LAST)}`).description
    ).toBe('Power');
    // position 1 is the carried line: a saved `building:1` named a line of the month
    // itself that has since gone
    expect(chargeCarry.buildingLineOf(rent, 'building:1')).toBe(null);
    expect(chargeCarry.buildingLineOf(rent, 'building:2')).toBe(null);
    expect(chargeCarry.buildingLineOf(rent, `building:p:e:${yymm(TWO_AGO)}`)).toBe(
      null
    );
    expect(chargeCarry.buildingLineOf(rent, undefined)).toBe(null);
    expect(chargeCarry.buildingLineOf({}, 'building:0')).toBe(null);
    // a position is read as the number it is, as it always was
    expect(chargeCarry.buildingLineOf(rent, 'building:00').description).toBe(
      'Water'
    );
    expect(chargeCarry.buildingLineOf(rent, 'building:01')).toBe(null);
    expect(chargeCarry.buildingLineOf(null, 'building:0')).toBe(null);
  });
});

describe('a payment on a month that holds a carried share', () => {
  it('the ledger: the month’s own line, then the carried one', () => {
    TENANT = tenantWith([WATER_NOW, POWER_LAST]);
    const month = TENANT.rents.find((r) => r.term === CURRENT);
    expect(
      month.buildingCharges.map((l) => [l.description, l.amount, l.forTerm])
    ).toEqual([
      ['Water', 25, undefined],
      ['Common power', 30, LAST]
    ]);
    expect(month.total.grandTotal).toBe(255);
  });

  it('with no attribution, the payment is spread over the lines and names the carried one by what it is', async () => {
    TENANT = tenantWith([WATER_NOW, POWER_LAST]);
    await save([cash(255)]);

    expect(storedAllocations()).toEqual([
      [
        255,
        [
          line('rent', 'preTax:0', 200),
          line('buildingCharge', 'building:0', 25),
          line('buildingCharge', POWER_KEY, 30)
        ]
      ]
    ]);
    // the month still holds both lines, and is now paid
    expect(storedLines()).toEqual([
      ['Water', 25],
      ['Common power', 30, LAST]
    ]);
    expect(storedMonth().total.payment).toBe(255);
  });

  it('an attribution to the carried share is kept as given', async () => {
    TENANT = tenantWith([WATER_NOW, POWER_LAST]);
    await save([
      cash(30, { allocation: [line('buildingCharge', POWER_KEY, 30)] })
    ]);
    expect(storedAllocations()).toEqual([
      [30, [line('buildingCharge', POWER_KEY, 30)]]
    ]);
  });

  it('a second payment with no attribution is spread over what the first left', async () => {
    TENANT = tenantWith([WATER_NOW, POWER_LAST]);
    const first = cash(30, {
      allocation: [line('buildingCharge', POWER_KEY, 30)]
    });
    TENANT = tenantWith([WATER_NOW, POWER_LAST], [first]);
    await save([first, cash(225)]);
    expect(storedAllocations()[1]).toEqual([
      225,
      [line('rent', 'preTax:0', 200), line('buildingCharge', 'building:0', 25)]
    ]);
  });

  it('the dashboard books it under the kind of the share', async () => {
    TENANT = tenantWith([WATER_NOW, POWER_LAST]);
    await save([
      cash(30, { allocation: [line('buildingCharge', POWER_KEY, 30)] })
    ]);
    expect(dashboardManager._computePaidByBucket(storedMonth())).toEqual({
      'building:electricity_common': 30
    });
  });

  it('another late share arrives and takes the place before it: the attribution still names the same share', async () => {
    TENANT = tenantWith([WATER_NOW, POWER_LAST]);
    const paid = cash(30, {
      allocation: [line('buildingCharge', POWER_KEY, 30)]
    });
    // the water of two months ago arrives: the tenant is recomputed
    TENANT = tenantWith([WATER_NOW, POWER_LAST, WATER_TWO_AGO], [paid]);
    const month = TENANT.rents.find((r) => r.term === CURRENT);
    expect(
      month.buildingCharges.map((l) => [l.description, l.amount, l.forTerm])
    ).toEqual([
      ['Water', 25, undefined],
      ['Water', 15, TWO_AGO],
      ['Common power', 30, LAST]
    ]);
    // by position the payment would now be on the water of two months ago
    expect(dashboardManager._computePaidByBucket(month)).toEqual({
      'building:electricity_common': 30
    });

    // …and the next payment is spread over what is really left
    await save([paid, cash(240)]);
    expect(storedAllocations()[1]).toEqual([
      240,
      [
        line('rent', 'preTax:0', 200),
        line('buildingCharge', 'building:0', 25),
        line('buildingCharge', WATER_TWO_AGO_KEY, 15)
      ]
    ]);
  });

  it('a saved position that a carried line has slid into is not read as paying that line', async () => {
    // `building:1` was saved when the month had a second line of its own. That line
    // has gone; position 1 is now the carried power share.
    const stale = cash(30, {
      allocation: [line('buildingCharge', 'building:1', 30)]
    });
    TENANT = tenantWith([WATER_NOW, POWER_LAST], [stale]);
    const month = TENANT.rents.find((r) => r.term === CURRENT);
    expect(dashboardManager._computePaidByBucket(month)).toEqual({
      'building:other': 30
    });

    // the next payment still finds the power share owed in full
    await save([stale, cash(225)]);
    expect(storedAllocations()[1]).toEqual([
      225,
      [line('rent', 'preTax:0', 200), line('buildingCharge', 'building:0', 25)]
    ]);
    await save([stale, cash(255)]);
    expect(storedAllocations()[1]).toEqual([
      255,
      [
        line('rent', 'preTax:0', 200),
        line('buildingCharge', 'building:0', 25),
        line('buildingCharge', POWER_KEY, 30)
      ]
    ]);
  });
});

describe('the key as the server accepts it', () => {
  const ids = (n) => 'a'.repeat(n);
  // ids as the database writes them: 24 characters
  const PROPERTY = '507f1f77bcf86cd799439011';
  const EXPENSE = '507f191e810c19729de860ea';

  it('a carried line’s key, built from database ids, fits in the 64 characters every version of the app accepts', () => {
    // The first version of this change used the whole ten-digit month: 69 characters.
    // The version of the app that is deployed today refuses a key longer than 64 when
    // a month's payments are saved again — so after a rollback, any month holding
    // such a key could no longer have its payments edited at all.
    const key = chargeCarry.buildingLineKey(
      { propertyId: PROPERTY, expenseId: EXPENSE, forTerm: 2026100100 },
      3
    );
    expect(key).toBe(`building:${PROPERTY}:${EXPENSE}:2610`);
    expect(key.length).toBe(63);
    expect(key.length).toBeLessThanOrEqual(64);
  });

  it.each([
    ['January 2026', 2026010100, '2601'],
    ['December 2099', 2099120100, '9912'],
    ['January 2000', 2000010100, '0001']
  ])('the month in the key: %s', (_what, forTerm, tail) => {
    expect(
      chargeCarry.buildingLineKey({ propertyId: 'p', expenseId: 'e', forTerm }, 0)
    ).toBe(`building:p:e:${tail}`);
  });

  it('such a key is stored as it is sent', async () => {
    TENANT = tenantWith([WATER_NOW, POWER_LAST]);
    const key = `building:${PROPERTY}:${EXPENSE}:2610`;
    await save([cash(30, { allocation: [line('buildingCharge', key, 30)] })]);
    expect(storedAllocations()).toEqual([
      [30, [line('buildingCharge', key, 30)]]
    ]);
  });

  it('64 characters are accepted and 65 refused: the limit is the one earlier versions apply', async () => {
    TENANT = tenantWith([WATER_NOW, POWER_LAST]);
    const longest = `building:${ids(55)}`;
    expect(longest.length).toBe(64);
    await save([cash(30, { allocation: [line('buildingCharge', longest, 30)] })]);
    expect(storedAllocations()).toEqual([
      [30, [line('buildingCharge', longest, 30)]]
    ]);

    writes.length = 0;
    await expect(
      save([
        cash(30, {
          allocation: [line('buildingCharge', `building:${ids(56)}`, 30)]
        })
      ])
    ).rejects.toMatchObject({
      statusCode: 422,
      message: 'payments[0].allocation[0].lineKey exceeds maximum length of 64'
    });
    expect(writes).toHaveLength(0);
  });

  it('free text in its place is still refused', async () => {
    TENANT = tenantWith([WATER_NOW, POWER_LAST]);
    await expect(
      save([
        cash(30, {
          allocation: [line('buildingCharge', `building:${ids(120)}`, 30)]
        })
      ])
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(writes).toHaveLength(0);
  });
});

describe('the landlord app builds the same keys (paymentAllocation.js)', () => {
  let client;
  beforeAll(async () => {
    // cross-workspace import, as newExpenseTypesReachMoneySurfaces.test.js does
    const mod = await import(
      '../../../../webapps/landlord/src/utils/paymentAllocation.js'
    );
    client = mod.buildingLineKey ? mod : mod.default;
  });

  const LINES = [
    { description: 'Water', amount: 25 },
    { description: 'Water', amount: 25, propertyId: 'p', expenseId: 'e' },
    {
      description: 'P',
      amount: 30,
      propertyId: 'p',
      expenseId: 'e',
      forTerm: LAST
    },
    { description: 'P', amount: 30, expenseId: 'e', forTerm: LAST },
    { description: 'P', amount: 30, propertyId: 'p', forTerm: LAST },
    {
      description: 'P',
      amount: 30,
      propertyId: 'p',
      expenseId: 'e',
      forTerm: '1'
    },
    {
      description: 'P',
      amount: 30,
      propertyId: 'p',
      expenseId: 'e',
      forTerm: 1.5
    },
    {
      description: 'R',
      amount: 60,
      propertyId: 'p',
      repairId: 'r',
      forTerm: LAST
    },
    null,
    undefined
  ];

  it('for every kind of line', () => {
    LINES.forEach((l, index) => {
      expect(client.buildingLineKey(l, index)).toBe(
        chargeCarry.buildingLineKey(l, index)
      );
    });
  });

  it('and finds the same line for a key', () => {
    const rent = { buildingCharges: LINES.filter(Boolean) };
    [
      'building:0',
      'building:1',
      'building:2',
      'building:3',
      'building:9',
      'building:00',
      'building:01',
      'building:1x',
      `building:p:e:${yymm(LAST)}`,
      `building:p:e:${yymm(TWO_AGO)}`,
      'building:',
      '',
      undefined
    ].forEach((key) => {
      expect(client.buildingLineOf(rent, key)).toBe(
        chargeCarry.buildingLineOf(rent, key)
      );
    });
  });

  it('and lists the lines of a month under the keys the server spreads a payment over', async () => {
    TENANT = tenantWith([WATER_NOW, POWER_LAST, WATER_TWO_AGO]);
    const month = TENANT.rents.find((r) => r.term === CURRENT);
    const listed = client
      .computeOwedLines({
        ...month,
        // the row the window receives carries these two totals (frontdata.ts)
        totalToPay: month.total.grandTotal,
        balance: month.total.balance
      })
      .map((l) => [l.lineKey, l.amount]);
    await save([cash(270)]);
    expect(listed).toEqual(
      storedAllocations()[0][1].map((a) => [a.lineKey, a.amount])
    );
    expect(listed).toEqual([
      ['preTax:0', 200],
      ['building:0', 25],
      [WATER_TWO_AGO_KEY, 15],
      [POWER_KEY, 30]
    ]);
  });
});
