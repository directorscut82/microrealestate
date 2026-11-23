// A tenant's share of a building charge, when the month it belongs to is CLOSED for that
// tenant (DEFERRED_DECISIONS D-10).
//
// A closed month is never priced again — it is over, or the tenant has paid it in full
// (contract.ts `_isFrozen`). A share written for such a month was stored on the building,
// listed there as charged, and reached no rent: the landlord paid the utility and
// recovered nothing. The common case is not a late import. A bill issued on the 20th is
// charged to its issue month, and by then most tenants have paid that month.
//
// The rule (owner, 2026-11-22): the share goes on the tenant's next open month, as a line
// that says which month it is for.
//
// How (1_base.ts `_carriedInto`, contract.ts `_ledgerFacts`): the building row stays in
// its own month and is only MARKED (`carry: true`) by the statement save. Where it is
// billed is stored nowhere. Every time a month is priced, the engine reads the tenant's
// stored ledger — which months are closed, and which shares closed rents already hold —
// and bills on the tenant's first open month the marked shares that no closed rent holds.
// A first design stored the month on the row; it was reviewed on paper and dropped: a
// stored month goes stale when a lease is terminated or extended or a payment is removed,
// one row cannot name a month for two tenants, and a share already billed on its own
// month was billed again when that month was saved again.
//
// Plain-import pattern, as contract-carry-through-closed-months.test.js.
import { jest } from '@jest/globals';
import * as BL from '../index.js';
import * as Contract from '../../managers/contract.js';

const term = (yyyymm) => Number(`${yyyymm}0100`);
const JUL = term(202607);
const AUG = term(202608);
const SEP = term(202609);
const OCT = term(202610);
const NOV = term(202611);
const DEC = term(202612);
const JAN = term(202701);

const at = (iso) => jest.useFakeTimers().setSystemTime(new Date(iso));
afterEach(() => jest.useRealTimers());
const MID_NOVEMBER = '2026-11-15T12:00:00Z';
const MID_DECEMBER = '2026-12-15T12:00:00Z';

// One unit of the tenant's lease: its window on that unit.
function unitOf(id, begin = '2026-07-01', end = '2027-06-30', rent = 400) {
  return {
    propertyId: id,
    rent,
    expenses: [],
    entryDate: new Date(`${begin}T00:00:00Z`),
    exitDate: new Date(`${end}T23:59:59Z`),
    property: { name: `Apt ${id}`, price: rent }
  };
}

// «power» and «water» are variable expenses (amount 0: their figure is typed every
// month, so they bill nothing on their own); «cleaning» is a fixed one.
const variable = (id, name, type) => ({
  _id: id,
  name,
  type,
  amount: 0,
  allocationMethod: 'general_thousandths',
  isRecurring: true,
  startTerm: 2026010100,
  customAllocations: []
});
const POWER = variable('power', 'Common power', 'electricity_common');
const WATER = variable('water', 'Water', 'water_common');
const cleaning = (amount) => ({
  ...variable('cleaning', 'Cleaning', 'cleaning'),
  amount
});

// A building with units A and B; `rows` = the stored monthly-charge rows per unit.
function building({
  A = [],
  B = [],
  expenses = [POWER, WATER],
  name = 'Building 1'
} = {}) {
  const unit = (id, rows) => ({
    _id: `unit-${id}`,
    propertyId: id,
    atakNumber: '01234567890',
    isManaged: true,
    surface: 80,
    generalThousandths: 500,
    heatingThousandths: 0,
    elevatorThousandths: 0,
    owners: [],
    monthlyCharges: rows
  });
  return {
    _id: 'building1',
    name,
    atakPrefix: '011172',
    units: [unit('A', A), unit('B', B)],
    expenses,
    address: {},
    blockStreets: [],
    hasElevator: false,
    hasCentralHeating: false,
    contractors: [],
    repairs: []
  };
}

// A stored row: a unit's share of an expense for a month. `share` is marked by the
// statement save (it may be billed on a later month); `oldShare` is a row from before
// the mark existed.
let created = 0;
const oldShare = (month, amount, expense = POWER, extra = {}) => ({
  _id: `row-${String(++created).padStart(5, '0')}`,
  term: month,
  amount,
  inputAmount: amount * 2,
  description: expense.name,
  expenseId: expense._id,
  repairId: null,
  ...extra
});
const share = (month, amount, expense = POWER, extra = {}) =>
  oldShare(month, amount, expense, { carry: true, ...extra });

// The lease as it is stored in mid November: July to October are closed, November is
// the current month, nothing has been paid, and the building holds `rows`.
function lease({
  units = [unitOf('A')],
  rows = {},
  today = MID_NOVEMBER,
  ...contract
} = {}) {
  at(today);
  return Contract.create({
    begin: Date.parse('2026-07-01T00:00:00Z'),
    end: Date.parse('2027-06-30T23:59:59Z'),
    frequency: 'months',
    properties: units,
    buildings: [building(rows)],
    ...contract
  });
}
// The tenant is recomputed with the building as it is now (what every save of a
// building, a tenant or a payment ends in).
const recompute = (c, rows = {}, more = {}) =>
  Contract.update(c, {
    properties: c.properties,
    buildings: [building(rows)],
    ...more
  });

const rentOf = (contract, month) =>
  contract.rents.find((r) => r.term === month);
// The building lines of a month: [description, amount] and, for a share carried in, the
// month it is for.
const lines = (contract, month) =>
  (rentOf(contract, month).buildingCharges || []).map((l) =>
    l.forTerm === undefined
      ? [l.description, l.amount]
      : [l.description, l.amount, l.forTerm]
  );
const ownBill = (contract, month) =>
  rentOf(contract, month).total.grandTotal -
  rentOf(contract, month).total.balance;
const total = (contract, month) => rentOf(contract, month).total.grandTotal;
const cash = (amount) => ({
  payments: [{ amount, type: 'cash', date: '15/11/2026', reference: '' }]
});
const payInFull = (c, month) =>
  Contract.payTerm(c, String(month), cash(total(c, month)));
// Everywhere a share of (expense, month) is billed in a ledger.
const whereBilled = (contract, expenseId, month) =>
  contract.rents.flatMap((r) =>
    (r.buildingCharges || [])
      .filter(
        (l) => l.expenseId === expenseId && (l.forTerm ?? r.term) === month
      )
      .map(() => r.term)
  );

describe('a share whose month is closed for the tenant', () => {
  it('goes on the current month when the tenant has not paid it, and says which month it is for', () => {
    const c = lease();
    const octoberBefore = JSON.stringify(rentOf(c, OCT));

    const now = recompute(c, { A: [share(OCT, 30)] });
    expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);
    expect(rentOf(now, NOV).buildingCharges[0]).toEqual({
      description: 'Common power',
      amount: 30,
      buildingName: 'Building 1',
      type: 'electricity_common',
      propertyId: 'A',
      expenseId: 'power',
      forTerm: OCT
    });
    // October is not touched; November's own bill holds the share; December carries it.
    expect(JSON.stringify(rentOf(now, OCT))).toBe(octoberBefore);
    expect(ownBill(now, NOV)).toBe(430);
    expect(rentOf(now, DEC).total.balance).toBe(total(now, NOV));
    expect(lines(now, DEC)).toEqual([]);
  });

  it('goes on next month when the tenant has paid the current one in full', () => {
    const c = lease();
    payInFull(c, NOV);
    const novemberPaid = JSON.stringify(rentOf(c, NOV));

    const now = recompute(c, { A: [share(OCT, 30)] });
    expect(JSON.stringify(rentOf(now, NOV))).toBe(novemberPaid);
    expect(lines(now, DEC)).toEqual([['Common power', 30, OCT]]);
    expect(lines(now, JAN)).toEqual([]);
  });

  it('a share for the current month the tenant has already paid goes on next month too', () => {
    // The bill of the 20th: charged to its issue month, which most tenants have paid.
    const c = lease();
    payInFull(c, NOV);
    const now = recompute(c, { A: [share(NOV, 30)] });
    expect(lines(now, NOV)).toEqual([]);
    expect(lines(now, DEC)).toEqual([['Common power', 30, NOV]]);
  });

  it('is on no rent when the tenant has no open month left', () => {
    // The lease ended with October.
    const c = lease({ end: Date.parse('2026-10-31T23:59:59Z') });
    const now = recompute(c, { A: [share(OCT, 30)] });
    expect(now.rents.map((r) => r.term)).toEqual([JUL, AUG, SEP, OCT]);
    now.rents.forEach((r) => expect(r.buildingCharges).toEqual([]));
  });

  it('several of them come after the month’s own lines, in the order they were written', () => {
    const c = lease();
    const october = share(OCT, 31);
    const september = share(SEP, 29, WATER);
    const now = recompute(c, {
      A: [september, share(NOV, 20), october],
      expenses: [POWER, WATER, cleaning(100)]
    });
    // November: its own share and the fixed expense first; then October's (written
    // first), then September's.
    expect(lines(now, NOV)).toEqual([
      ['Common power', 20],
      ['Cleaning', 50],
      ['Common power', 31, OCT],
      ['Water', 29, SEP]
    ]);
  });
});

describe('a share whose month is open is billed on that month, as it always was', () => {
  it('the current month, not paid', () => {
    const c = lease();
    const now = recompute(c, { A: [share(NOV, 30)] });
    expect(lines(now, NOV)).toEqual([['Common power', 30]]);
    expect(rentOf(now, NOV).buildingCharges[0]).toEqual({
      description: 'Common power',
      amount: 30,
      buildingName: 'Building 1',
      type: 'electricity_common',
      propertyId: 'A',
      expenseId: 'power'
    });
    expect(lines(now, DEC)).toEqual([]);
  });

  it('a month to come', () => {
    const c = lease();
    const now = recompute(c, { A: [share(JAN, 30)] });
    expect(whereBilled(now, 'power', JAN)).toEqual([JAN]);
  });

  it('a brand-new lease prices every month from its rows, closed or not', () => {
    const c = lease({ rows: { A: [share(SEP, 30), oldShare(OCT, 31)] } });
    expect(lines(c, SEP)).toEqual([['Common power', 30]]);
    expect(lines(c, OCT)).toEqual([['Common power', 31]]);
    expect(lines(c, NOV)).toEqual([]);
  });

  it('a fixed expense keeps billing its own share, with the ids of what it is', () => {
    const c = lease({ rows: { expenses: [cleaning(100)] } });
    expect(rentOf(c, NOV).buildingCharges).toEqual([
      {
        description: 'Cleaning',
        amount: 50,
        buildingName: 'Building 1',
        type: 'cleaning',
        propertyId: 'A',
        expenseId: 'cleaning'
      }
    ]);
  });

  it('a repair row says it is a repair', () => {
    const c = lease({
      rows: {
        A: [
          oldShare(NOV, 60, POWER, {
            expenseId: null,
            repairId: 'repair-1',
            description: 'Repair: roof'
          })
        ]
      }
    });
    expect(rentOf(c, NOV).buildingCharges).toEqual([
      {
        description: 'Repair: roof',
        amount: 60,
        buildingName: 'Building 1',
        type: 'repair',
        propertyId: 'A',
        repairId: 'repair-1'
      }
    ]);
  });
});

describe('only what the statement save marked is carried', () => {
  it('a row from before the mark existed reaches no rent, as before', () => {
    const c = lease();
    const now = recompute(c, { A: [oldShare(OCT, 30)] });
    now.rents.forEach((r) => expect(r.buildingCharges).toEqual([]));
  });

  it.each([
    ['the text «true»', 'true'],
    ['the number 1', 1],
    ['an object', {}],
    ['a list', [true]],
    ['false', false],
    ['null', null]
  ])('nor a row whose mark is %s', (_what, carry) => {
    const c = lease();
    const now = recompute(c, { A: [oldShare(OCT, 30, POWER, { carry })] });
    now.rents.forEach((r) => expect(r.buildingCharges).toEqual([]));
  });

  it('nor a repair row, nor a row of no expense, even if marked', () => {
    const c = lease();
    const now = recompute(c, {
      A: [
        share(OCT, 60, POWER, { expenseId: null, repairId: 'repair-1' }),
        // a row that names an expense AND a repair is a repair row
        share(OCT, 61, POWER, { repairId: 'repair-2' }),
        share(OCT, 25, POWER, { expenseId: null })
      ]
    });
    now.rents.forEach((r) => expect(r.buildingCharges).toEqual([]));
  });

  it.each([
    ['zero', 0],
    ['negative', -30],
    ['not-a-number', NaN],
    ['infinite', Infinity],
    ['missing', undefined],
    ['a text that is no amount', 'thirty']
  ])('nor a row whose amount is %s', (_what, amount) => {
    const c = lease();
    const now = recompute(c, { A: [share(OCT, amount)] });
    expect(lines(now, NOV)).toEqual([]);
  });

  it.each([
    ['a text', 'October'],
    ['not-a-number', NaN],
    ['a fraction', OCT + 0.5],
    ['a month before the lease', term(202601)],
    ['a month to come', JAN]
  ])('nor a row whose month is %s', (_what, month) => {
    const c = lease();
    const now = recompute(c, { A: [share(month, 30)] });
    expect(lines(now, NOV)).toEqual([]);
  });

  it('a lease by the day is left alone, even with a marked row for a day that is over', () => {
    // Nothing writes such a row. If one existed, a daily lease must not start
    // carrying it: the rule is written for months.
    at(MID_NOVEMBER);
    const c = Contract.create({
      begin: Date.parse('2026-11-10T00:00:00Z'),
      end: Date.parse('2026-11-20T23:59:59Z'),
      frequency: 'days',
      properties: [unitOf('A', '2026-11-10', '2026-11-20')],
      buildings: [building()]
    });
    const now = recompute(c, { A: [share(2026111200, 30)] });
    expect(now.rents.length).toBe(11);
    expect(
      now.rents.flatMap((r) => r.buildingCharges.filter((l) => l.forTerm))
    ).toEqual([]);
  });

  it('a lease that is not monthly is left alone', () => {
    at(MID_NOVEMBER);
    const c = Contract.create({
      begin: Date.parse('2026-01-01T00:00:00Z'),
      end: Date.parse('2028-12-31T23:59:59Z'),
      frequency: 'years',
      properties: [unitOf('A', '2026-01-01', '2028-12-31')],
      buildings: [building()]
    });
    const now = recompute(c, { A: [share(term(202601), 30)] });
    expect(
      now.rents.flatMap((r) => r.buildingCharges.filter((l) => l.forTerm))
    ).toEqual([]);
  });
});

describe('who is billed', () => {
  it('not a tenant who moved into the unit later', () => {
    const c = lease({ units: [unitOf('A', '2026-11-01')] });
    const now = recompute(c, { A: [share(OCT, 30)] });
    now.rents.forEach((r) => expect(r.buildingCharges).toEqual([]));
  });

  it('a tenant who has left that unit but still rents another one', () => {
    // Unit A until the end of October, unit B all along. October's share of A is
    // billed on the November rent although A is no longer theirs.
    const c = lease({
      units: [unitOf('A', '2026-07-01', '2026-10-31'), unitOf('B')]
    });
    const now = recompute(c, { A: [share(OCT, 30)] });
    expect(rentOf(now, NOV).preTaxAmounts.map((p) => p.description)).toEqual([
      'Apt B'
    ]);
    expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);
    expect(rentOf(now, NOV).buildingCharges[0].propertyId).toBe('A');
  });

  it('both units of a tenant who has two', () => {
    const c = lease({ units: [unitOf('A'), unitOf('B')] });
    const now = recompute(c, {
      A: [share(OCT, 30)],
      B: [share(OCT, 20)]
    });
    expect(
      rentOf(now, NOV).buildingCharges.map((l) => [l.propertyId, l.amount])
    ).toEqual([
      ['A', 30],
      ['B', 20]
    ]);
  });

  it('a unit listed twice on the lease is billed once', () => {
    const c = lease({ units: [unitOf('A'), unitOf('A')] });
    const now = recompute(c, { A: [share(OCT, 30)] });
    expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);
  });

  it('two tenants of one unit in the same month, each on their own next open month', () => {
    // The unit changed hands in November: one tenant left on the 15th and has not
    // paid November; the other arrived on the 16th and has. A November share:
    const leaving = lease({ units: [unitOf('A', '2026-07-01', '2026-11-15')] });
    const arriving = lease({ units: [unitOf('A', '2026-11-16')] });
    payInFull(arriving, NOV);

    const rows = () => ({ A: [share(NOV, 30)] });
    // …is on November for the one who has not paid it,
    expect(whereBilled(recompute(leaving, rows()), 'power', NOV)).toEqual([
      NOV
    ]);
    // …and on December for the one who has.
    expect(whereBilled(recompute(arriving, rows()), 'power', NOV)).toEqual([
      DEC
    ]);
  });
});

describe('a share is never billed twice', () => {
  it('billed on its own month, which was then paid: saving that month again bills nothing more', () => {
    // Water is charged on the 5th, the tenant pays November on the 10th, the power bill
    // arrives on the 21st — and its import posts the WHOLE month again.
    const c = lease();
    const water = share(NOV, 20, WATER);
    let now = recompute(c, { A: [water] });
    expect(lines(now, NOV)).toEqual([['Water', 20]]);
    payInFull(now, NOV);

    now = recompute(now, { A: [water, share(NOV, 30)] });
    expect(lines(now, NOV)).toEqual([['Water', 20]]);
    // only the power share is new: it alone goes on December
    expect(lines(now, DEC)).toEqual([['Common power', 30, NOV]]);
    expect(whereBilled(now, 'water', NOV)).toEqual([NOV]);
  });

  it('carried to a month that was then paid: the figure saved as 0 and typed again bills nothing more', () => {
    const c = lease();
    let now = recompute(c, { A: [share(OCT, 30)] });
    payInFull(now, NOV);
    const novemberPaid = JSON.stringify(rentOf(now, NOV));

    // 0: the row is gone. Typed again: a new row, marked again.
    now = recompute(now, { A: [] });
    now = recompute(now, { A: [share(OCT, 90)] });
    expect(JSON.stringify(rentOf(now, NOV))).toBe(novemberPaid);
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
  });

  it('nor when the expense or the building has been renamed since', () => {
    const c = lease();
    let now = recompute(c, { A: [share(OCT, 30)] });
    payInFull(now, NOV);

    const renamed = { ...POWER, name: 'Stairwell lights' };
    now = recompute(now, {
      A: [share(OCT, 30, renamed)],
      expenses: [renamed, WATER],
      name: 'Building renamed'
    });
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
  });

  it('nor when the share of a tenant with two units now sits on the other unit', () => {
    // An equal split gives a tenant with two units ONE share, on one of them; run
    // again it can land on the other.
    const c = lease({ units: [unitOf('A'), unitOf('B')] });
    let now = recompute(c, { A: [share(OCT, 30)] });
    payInFull(now, NOV);

    now = recompute(now, { B: [share(OCT, 30)] });
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
  });

  it('…while a second unit that really has a share of its own is still billed', () => {
    const c = lease({ units: [unitOf('A'), unitOf('B')] });
    let now = recompute(c, { A: [share(OCT, 30)] });
    payInFull(now, NOV);

    now = recompute(now, { A: [share(OCT, 30)], B: [share(OCT, 20)] });
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV, DEC]);
    expect(rentOf(now, DEC).buildingCharges).toEqual([
      expect.objectContaining({ propertyId: 'B', amount: 20, forTerm: OCT })
    ]);
  });

  it('…and it is the unit that was NOT billed that is, whatever the order of the units', () => {
    // B's share was billed (20) and its month paid. A then gets a share of its own.
    const c = lease({ units: [unitOf('A'), unitOf('B')] });
    let now = recompute(c, { B: [share(OCT, 20)] });
    payInFull(now, NOV);

    now = recompute(now, { A: [share(OCT, 30)], B: [share(OCT, 20)] });
    expect(rentOf(now, DEC).buildingCharges).toEqual([
      expect.objectContaining({ propertyId: 'A', amount: 30, forTerm: OCT })
    ]);
  });

  it('a closed month stored before lines carried ids: the same name on it counts as billed', () => {
    const c = lease({ rows: { A: [oldShare(OCT, 30)] } });
    // as such a month is stored today: no ids on its lines
    rentOf(c, OCT).buildingCharges = [
      {
        description: 'Common power',
        amount: 30,
        buildingName: 'Building 1',
        type: 'electricity_common'
      }
    ];
    const now = recompute(c, { A: [share(OCT, 30)] });
    expect(lines(now, NOV)).toEqual([]);
  });

  it('a repair on that closed month that happens to have the same name is not the share', () => {
    const c = lease();
    rentOf(c, OCT).buildingCharges = [
      {
        description: 'Common power',
        amount: 60,
        buildingName: 'Building 1',
        type: 'repair',
        propertyId: 'A',
        repairId: 'repair-1'
      }
    ];
    const now = recompute(c, { A: [share(OCT, 30)] });
    expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);
  });

  it('…and a different name on it does not', () => {
    const c = lease();
    rentOf(c, OCT).buildingCharges = [
      {
        description: 'Water',
        amount: 30,
        buildingName: 'Building 1',
        type: 'water_common'
      }
    ];
    const now = recompute(c, { A: [share(OCT, 30)] });
    expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);
  });
});

// Which line of a closed rent stands for which row (carriedshares.ts `coverRows`). Every
// case below was found by a reviewer on the first version of this change, which counted
// «already billed» per expense and month and looked only at the marked rows.
describe('one line of a closed rent stands for one share, its own', () => {
  // Every line of the ledger that is for (description, month), with the rent it is on.
  const billedFor = (contract, description, month) =>
    contract.rents.flatMap((r) =>
      (r.buildingCharges || [])
        .filter(
          (l) => l.description === description && (l.forTerm ?? r.term) === month
        )
        .map((l) => [r.term, l.propertyId, l.amount])
    );
  // October as it is stored for a tenant today: priced before lines carried ids.
  const withoutIds = (contract, month) => {
    rentOf(contract, month).buildingCharges = rentOf(
      contract,
      month
    ).buildingCharges.map(({ description, amount, buildingName, type }) => ({
      description,
      amount,
      buildingName,
      type
    }));
  };
  const POWER_AGAIN = { ...POWER, _id: 'power2' };

  it('an expense deleted and created again: a share its month already billed is not billed again', () => {
    // October's power was billed on October. The landlord deletes the expense for good
    // (its rows go with it), creates it again and types October once more.
    const c = lease({ rows: { A: [oldShare(OCT, 30)] } });
    expect(billedFor(c, 'Common power', OCT)).toEqual([[OCT, 'A', 30]]);

    const now = recompute(c, {
      A: [share(OCT, 30, POWER_AGAIN)],
      expenses: [POWER_AGAIN, WATER]
    });
    expect(billedFor(now, 'Common power', OCT)).toEqual([[OCT, 'A', 30]]);
    expect(lines(now, NOV)).toEqual([]);
  });

  it('…nor one that was carried to a month that is closed now', () => {
    const c = lease();
    let now = recompute(c, { A: [share(OCT, 30)] });
    payInFull(now, NOV);
    expect(billedFor(now, 'Common power', OCT)).toEqual([[NOV, 'A', 30]]);

    now = recompute(now, {
      A: [share(OCT, 30, POWER_AGAIN)],
      expenses: [POWER_AGAIN, WATER]
    });
    expect(billedFor(now, 'Common power', OCT)).toEqual([[NOV, 'A', 30]]);
  });

  it('…and of two units it is the one that was billed that is left alone', () => {
    // Only A was billed for October. After the expense is created again both units get
    // a share: A's is the one the closed month holds, B's is new.
    const c = lease({
      units: [unitOf('A'), unitOf('B')],
      rows: { A: [oldShare(OCT, 30)] }
    });
    const now = recompute(c, {
      B: [share(OCT, 20, POWER_AGAIN)],
      A: [share(OCT, 30, POWER_AGAIN)],
      expenses: [POWER_AGAIN, WATER]
    });
    expect(billedFor(now, 'Common power', OCT)).toEqual([
      [OCT, 'A', 30],
      [NOV, 'B', 20]
    ]);
  });

  it('an expense that still exists is never recognised by its name', () => {
    // «Common power» was billed on October and still exists. A second expense with the
    // same name gets a share for October: that one was never billed.
    const c = lease({ rows: { A: [oldShare(OCT, 30)] } });
    const namesake = { ...POWER, _id: 'power-of-the-yard' };
    const now = recompute(c, {
      A: [oldShare(OCT, 30), share(OCT, 12, namesake)],
      expenses: [POWER, WATER, namesake]
    });
    expect(billedFor(now, 'Common power', OCT)).toEqual([
      [OCT, 'A', 30],
      [NOV, 'A', 12]
    ]);
  });

  it('…also when its own row has gone since: its line is still its own, not the namesake’s', () => {
    // «Common power» was billed on October; its figure was then cleared (the row is
    // gone, the expense lives on). The namesake's new October share was never billed.
    const c = lease({ rows: { A: [oldShare(OCT, 30)] } });
    const namesake = { ...POWER, _id: 'power-of-the-yard' };
    const now = recompute(c, {
      A: [share(OCT, 12, namesake)],
      expenses: [POWER, WATER, namesake]
    });
    expect(billedFor(now, 'Common power', OCT)).toEqual([
      [OCT, 'A', 30],
      [NOV, 'A', 12]
    ]);
  });

  it('a second unit gets its new share although the first unit’s old one was billed', () => {
    // A's October row is from before the mark existed and was billed on October. B gets
    // a share of its own for October now (its thousandths were set, say).
    const c = lease({
      units: [unitOf('A'), unitOf('B')],
      rows: { A: [oldShare(OCT, 30)] }
    });
    const A = oldShare(OCT, 30);
    const now = recompute(c, { A: [A], B: [share(OCT, 20)] });
    expect(billedFor(now, 'Common power', OCT)).toEqual([
      [OCT, 'A', 30],
      [NOV, 'B', 20]
    ]);
  });

  // A ledger line stored before lines carried ids says «Common power 30» and no more.
  // It is A's here — but nothing in the ledger says so. Two earlier versions guessed
  // («the row that was there before», then «the nearest amount») and billed the other
  // row; a review showed each of them a history in which the guess was wrong and a
  // tenant was billed twice. So the engine does not guess: a row that such a line MAY
  // be for is not billed again. B's share stays unbilled, as it was before this change
  // — and the building page says so («δεν χρεώθηκε», chargeCarry.test.js), where it
  // used to call it charged.
  it('…but on a ledger stored before lines carried ids the old line does not say whose it is: B’s share is not billed', () => {
    const c = lease({
      units: [unitOf('A'), unitOf('B')],
      rows: { A: [oldShare(OCT, 30)] }
    });
    withoutIds(c, OCT);
    const now = recompute(c, { A: [oldShare(OCT, 30)], B: [share(OCT, 20)] });
    expect(lines(now, OCT)).toEqual([['Common power', 30]]);
    expect(lines(now, NOV)).toEqual([]);
  });

  it('…whatever the order the two rows were written in', () => {
    const c = lease({
      units: [unitOf('A'), unitOf('B')],
      rows: { A: [oldShare(OCT, 30)] }
    });
    withoutIds(c, OCT);
    const newer = share(OCT, 20);
    const older = oldShare(OCT, 30);
    const now = recompute(c, { A: [older], B: [newer] });
    expect(lines(now, NOV)).toEqual([]);
  });

  it('…while a share of ANOTHER name for that month is not in doubt, and is billed', () => {
    const c = lease({
      units: [unitOf('A'), unitOf('B')],
      rows: { A: [oldShare(OCT, 30)] }
    });
    withoutIds(c, OCT);
    const now = recompute(c, {
      A: [oldShare(OCT, 30)],
      B: [share(OCT, 20), share(OCT, 9, WATER)]
    });
    expect(lines(now, NOV)).toEqual([['Water', 9, OCT]]);
  });

  it('one old line, two expenses of one name on the unit: it could be either’s, and neither is billed again', () => {
    // October (stored before ids) holds ONE «Common power» line. Two expenses carry
    // that name, and each has a share for October now.
    const namesake = { ...POWER, _id: 'power-of-the-yard' };
    const priced = () => {
      const c = lease({ rows: { A: [oldShare(OCT, 30)] } });
      withoutIds(c, OCT);
      return c;
    };
    // both typed in after the deploy
    let now = recompute(priced(), {
      A: [share(OCT, 30), share(OCT, 12, namesake)],
      expenses: [POWER, WATER, namesake]
    });
    expect(lines(now, NOV)).toEqual([]);
    // the row that was billed is still there (not marked), the namesake's is new —
    // written first, or last
    now = recompute(priced(), {
      A: [share(OCT, 12, namesake), oldShare(OCT, 30)],
      expenses: [POWER, WATER, namesake]
    });
    expect(lines(now, NOV)).toEqual([]);
    now = recompute(priced(), {
      A: [oldShare(OCT, 30), share(OCT, 12, namesake)],
      expenses: [POWER, WATER, namesake]
    });
    expect(lines(now, NOV)).toEqual([]);
    expect(lines(now, OCT)).toEqual([['Common power', 30]]);
  });

  it('an old repair line with the same name is not a share (no repair id on it either)', () => {
    const c = lease();
    rentOf(c, OCT).buildingCharges = [
      {
        description: 'Common power',
        amount: 60,
        buildingName: 'Building 1',
        type: 'repair'
      }
    ];
    const now = recompute(c, { A: [share(OCT, 30)] });
    expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);
  });

  it('a share billed twice by an older fault does not cost the other unit its share', () => {
    // A's October share sits on October AND, wrongly, on a closed November. That is
    // one share too many for A — not a reason to drop B's.
    const c = lease({
      units: [unitOf('A'), unitOf('B')],
      rows: { A: [oldShare(OCT, 30)] }
    });
    payInFull(c, NOV);
    rentOf(c, NOV).buildingCharges.push({
      description: 'Common power',
      amount: 30,
      buildingName: 'Building 1',
      type: 'electricity_common',
      propertyId: 'A',
      expenseId: 'power',
      forTerm: OCT
    });
    const now = recompute(c, { A: [oldShare(OCT, 30)], B: [share(OCT, 20)] });
    expect(lines(now, DEC)).toEqual([['Common power', 20, OCT]]);
  });

  // ── found by the second review ──────────────────────────────────────────────────
  describe('an old line with no ids, and two rows that read the same: nothing is billed again', () => {
    // October was stored before lines carried ids and holds ONE line, 30. The tenant
    // has A and B. Whatever is then typed, typed again, corrected or moved, no row
    // that this line could be for is billed again — every history below billed a
    // tenant twice (or lost a share that had been billed right) in one of the three
    // earlier versions.
    const everyOctoberLine = (contract) =>
      billedFor(contract, 'Common power', OCT).map(([term, , amount]) => [
        term,
        amount
      ]);
    const billedBeforeIds = (amount = 30, units = [unitOf('A'), unitOf('B')]) => {
      const c = lease({ units, rows: { A: [oldShare(OCT, amount)] } });
      withoutIds(c, OCT);
      return c;
    };

    it('October saved as 0 and typed again, B’s row written first (the second version billed A again)', () => {
      const now = recompute(billedBeforeIds(), {
        B: [share(OCT, 20)],
        A: [share(OCT, 30)]
      });
      expect(everyOctoberLine(now)).toEqual([[OCT, 30]]);
    });

    it('…also when both shares are the same amount, and through a second recompute', () => {
      let now = recompute(billedBeforeIds(), {
        B: [share(OCT, 30)],
        A: [share(OCT, 30)]
      });
      expect(everyOctoberLine(now)).toEqual([[OCT, 30]]);
      now = recompute(now, { B: [share(OCT, 30)], A: [share(OCT, 30)] });
      expect(everyOctoberLine(now)).toEqual([[OCT, 30]]);
    });

    it('the tenant moved from A to B, October was B’s, both rows are typed again (the third version billed B again)', () => {
      // the tenant held A until 30/09 and B from 01/10; A's October row is the next
      // occupant's share
      const moved = [
        unitOf('A', '2026-07-01', '2026-09-30'),
        unitOf('B', '2026-10-01')
      ];
      const c = lease({ units: moved, rows: { B: [oldShare(OCT, 30)] } });
      expect(lines(c, OCT)).toEqual([['Common power', 30]]);
      withoutIds(c, OCT);
      let now = recompute(c, { A: [share(OCT, 30)], B: [share(OCT, 30)] });
      expect(everyOctoberLine(now)).toEqual([[OCT, 30]]);
      // …with unequal shares too: 40/60, typed again as 50/75
      const d = lease({ units: moved, rows: { B: [oldShare(OCT, 60)] } });
      withoutIds(d, OCT);
      now = recompute(d, { A: [share(OCT, 50)], B: [share(OCT, 75)] });
      expect(everyOctoberLine(now)).toEqual([[OCT, 60]]);
    });

    it('the billed figure is corrected afterwards and the other unit gets a new share', () => {
      // A's row keeps its id: 30 → 20. B's new 28 is nearer the old line than A's 20.
      let now = recompute(billedBeforeIds(), {
        A: [oldShare(OCT, 20)],
        B: [share(OCT, 28)]
      });
      expect(everyOctoberLine(now)).toEqual([[OCT, 30]]);
      now = recompute(billedBeforeIds(), {
        A: [oldShare(OCT, 60)],
        B: [share(OCT, 20)]
      });
      expect(everyOctoberLine(now)).toEqual([[OCT, 30]]);
    });

    it('two expenses of one name, the one that was billed deleted and created again', () => {
      // «Common power» is two expenses here. A's October share of the yard's (30) is
      // on the old line; B has a share of the other one (20). The yard's expense is
      // deleted, created again, and A's October typed again.
      const YARD = { ...POWER, _id: 'yard' };
      const YARD_AGAIN = { ...POWER, _id: 'yard-again' };
      const c = lease({
        units: [unitOf('A'), unitOf('B')],
        rows: { A: [oldShare(OCT, 30, YARD)], expenses: [POWER, WATER, YARD] }
      });
      withoutIds(c, OCT);
      const b = share(OCT, 20);
      let now = recompute(c, {
        A: [oldShare(OCT, 30, YARD)],
        B: [b],
        expenses: [POWER, WATER, YARD]
      });
      expect(everyOctoberLine(now)).toEqual([[OCT, 30]]);
      now = recompute(now, {
        A: [share(OCT, 30, YARD_AGAIN)],
        B: [b],
        expenses: [POWER, WATER, YARD_AGAIN]
      });
      expect(everyOctoberLine(now)).toEqual([[OCT, 30]]);
    });
  });

  describe('lines that name their unit and their expense are not in doubt', () => {
    // Everything billed from now on. October is A's, with ids; B's new share goes on
    // November.
    const start = () => {
      const c = lease({
        units: [unitOf('A'), unitOf('B')],
        rows: { A: [oldShare(OCT, 30)] }
      });
      const now = recompute(c, {
        A: [oldShare(OCT, 30)],
        B: [share(OCT, 20)]
      });
      expect(billedFor(now, 'Common power', OCT)).toEqual([
        [OCT, 'A', 30],
        [NOV, 'B', 20]
      ]);
      return now;
    };

    it('October saved as 0 and typed again, in either order: each line is still its own unit’s', () => {
      for (const rows of [
        { B: [share(OCT, 20)], A: [share(OCT, 30)] },
        { A: [share(OCT, 30)], B: [share(OCT, 20)] }
      ]) {
        const now = recompute(start(), rows);
        expect(billedFor(now, 'Common power', OCT)).toEqual([
          [OCT, 'A', 30],
          [NOV, 'B', 20]
        ]);
      }
    });

    it('…and when November has closed with B’s share on it and the expense was created again', () => {
      let now = start();
      payInFull(now, NOV);
      now = recompute(now, {
        B: [share(OCT, 20, POWER_AGAIN)],
        A: [share(OCT, 30, POWER_AGAIN)],
        expenses: [POWER_AGAIN, WATER]
      });
      // each line names its unit: A's is A's, B's is B's
      expect(billedFor(now, 'Common power', OCT)).toEqual([
        [OCT, 'A', 30],
        [NOV, 'B', 20]
      ]);
    });

    it('a share that moved to the other unit while the first unit has ANOTHER expense of that name: not billed again', () => {
      // Two expenses are called «Common power». October billed both for A: power 30
      // and the yard's 12. The yard's expense is deleted and created again, and its
      // share is on B now. A's power row reads like the yard's old line, but it has
      // a line of its own: the old line is the moved share's. (It covered nothing,
      // and B's 12 was billed on top of the 12 already billed: found by review.)
      const YARD = { ...POWER, _id: 'yard' };
      const YARD_AGAIN = { ...POWER, _id: 'yard-again' };
      const c = lease({
        units: [unitOf('A'), unitOf('B')],
        rows: {
          A: [oldShare(OCT, 30), oldShare(OCT, 12, YARD)],
          expenses: [POWER, WATER, YARD]
        }
      });
      expect(billedFor(c, 'Common power', OCT)).toEqual([
        [OCT, 'A', 30],
        [OCT, 'A', 12]
      ]);
      const now = recompute(c, {
        A: [oldShare(OCT, 30)],
        B: [share(OCT, 12, YARD_AGAIN)],
        expenses: [POWER, WATER, YARD_AGAIN]
      });
      expect(billedFor(now, 'Common power', OCT)).toEqual([
        [OCT, 'A', 30],
        [OCT, 'A', 12]
      ]);
    });

    it('…nor when A’s other expense of that name gets its share only afterwards: the old line could be either’s, and neither is billed', () => {
      // October billed the yard's 12 for A. The yard's expense is deleted and created
      // again, its share is on B now — and A's power share (30) arrives after that.
      // The yard's old line names A, where the only row that reads like it is the
      // power row; kept to A's rows it took that one, and B's 12 was billed a second
      // time (found by review). With two expenses of one name the unit says too
      // little: the line could be for either row, and neither is billed again.
      const YARD = { ...POWER, _id: 'yard' };
      const YARD_AGAIN = { ...POWER, _id: 'yard-again' };
      const c = lease({
        units: [unitOf('A'), unitOf('B')],
        rows: { A: [oldShare(OCT, 12, YARD)], expenses: [POWER, WATER, YARD] }
      });
      expect(billedFor(c, 'Common power', OCT)).toEqual([[OCT, 'A', 12]]);
      const now = recompute(c, {
        A: [share(OCT, 30)],
        B: [share(OCT, 12, YARD_AGAIN)],
        expenses: [POWER, WATER, YARD_AGAIN]
      });
      expect(billedFor(now, 'Common power', OCT)).toEqual([[OCT, 'A', 12]]);
    });

    it('a share that moved to the other unit, its figure corrected, the expense created again: not billed again', () => {
      // A's October 30 is billed. Then A has no October row and B has one of 31 (a
      // split per tenant moved the share; the figure was corrected by 1). With the
      // expense alive, A's line stands in for it. With the expense deleted and created
      // again under the same name it must too (the third version wanted the exact
      // amount, and billed the 31 on top of the 30).
      const c = lease({
        units: [unitOf('A'), unitOf('B')],
        rows: { A: [oldShare(OCT, 30)] }
      });
      let now = recompute(c, { B: [share(OCT, 31)] });
      expect(billedFor(now, 'Common power', OCT)).toEqual([[OCT, 'A', 30]]);
      now = recompute(c, {
        B: [share(OCT, 31, POWER_AGAIN)],
        expenses: [POWER_AGAIN, WATER]
      });
      expect(billedFor(now, 'Common power', OCT)).toEqual([[OCT, 'A', 30]]);
    });
  });

  describe('a unit the tenant is said, afterwards, not to have had that month', () => {
    it('the exit date of A is recorded late: A’s October line is still A’s, and B’s new share is billed', () => {
      // A's October share was billed on October. A's exit date is then recorded as
      // 30/09. October, closed, keeps A's rent and A's 30 — and A's row is no longer
      // «the tenant's» for October. Left out of the question, A's line looked like a
      // share that had moved to B, and B's new share was on no rent.
      const c = lease({
        units: [unitOf('A'), unitOf('B')],
        rows: { A: [oldShare(OCT, 30)] }
      });
      const A = oldShare(OCT, 30);
      const now = recompute(
        c,
        { A: [A], B: [share(OCT, 20)] },
        { properties: [unitOf('A', '2026-07-01', '2026-09-30'), unitOf('B')] }
      );
      expect(billedFor(now, 'Common power', OCT)).toEqual([
        [OCT, 'A', 30],
        [NOV, 'B', 20]
      ]);
    });

    it('…on a ledger stored before lines carried ids the old line could be either’s: B’s share is not billed', () => {
      const c = lease({
        units: [unitOf('A'), unitOf('B')],
        rows: { A: [oldShare(OCT, 30)] }
      });
      withoutIds(c, OCT);
      const now = recompute(
        c,
        { A: [oldShare(OCT, 30)], B: [share(OCT, 20)] },
        { properties: [unitOf('A', '2026-07-01', '2026-09-30'), unitOf('B')] }
      );
      expect(
        billedFor(now, 'Common power', OCT).map(([term, , amount]) => [term, amount])
      ).toEqual([[OCT, 30]]);
    });

    it('…and a marked share of A for that month is not carried: the tenant was not there', () => {
      const c = lease({ units: [unitOf('A'), unitOf('B')] });
      const now = recompute(
        c,
        { A: [share(OCT, 30)], B: [share(OCT, 20)] },
        { properties: [unitOf('A', '2026-07-01', '2026-09-30'), unitOf('B')] }
      );
      expect(billedFor(now, 'Common power', OCT)).toEqual([[NOV, 'B', 20]]);
    });

    it('A is taken off the lease altogether: its line does not stand in for B’s new share', () => {
      const c = lease({
        units: [unitOf('A'), unitOf('B')],
        rows: { A: [oldShare(OCT, 30)] }
      });
      const now = recompute(
        c,
        { A: [oldShare(OCT, 30)], B: [share(OCT, 20)] },
        { properties: [unitOf('B')] }
      );
      expect(billedFor(now, 'Common power', OCT)).toEqual([
        [OCT, 'A', 30],
        [NOV, 'B', 20]
      ]);
    });
  });

  it('a line whose unit lost its row stands in for one other row, not for two', () => {
    // A was billed (30) and paid; A's row is gone and B AND a third row of the same
    // expense appear. One line, one share: the other is billed.
    const c = lease({ units: [unitOf('A'), unitOf('B')] });
    let now = recompute(c, { A: [share(OCT, 30)] });
    payInFull(now, NOV);
    now = recompute(now, { B: [share(OCT, 30), share(OCT, 7)] });
    expect(lines(now, DEC)).toEqual([['Common power', 7, OCT]]);
  });
});

describe('nothing is remembered, so nothing goes stale', () => {
  it('the payment of the current month is removed: the share comes back to it, at once', () => {
    const c = lease();
    payInFull(c, NOV);
    let now = recompute(c, { A: [share(OCT, 30)] });
    expect(whereBilled(now, 'power', OCT)).toEqual([DEC]);

    // The payment alone, as the payment window saves it — no recompute yet. Left on
    // December until «the next recompute», November showed 400, the landlord recorded
    // 400, and that payment's own pricing then put the share on November: paid, and
    // 30 short.
    now.buildings = [building({ A: [share(OCT, 30)] })];
    Contract.payTerm(now, String(NOV), { payments: [] });
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
    expect(ownBill(now, NOV)).toBe(430);
    expect(lines(now, DEC)).toEqual([]);
    // July to October were never paid (4 × 400), and now November with the share
    expect(rentOf(now, DEC).total.balance).toBe(1600 + 430);
    expect('ledgerFacts' in now).toBe(false);

    // …and the recompute that follows finds nothing to move
    const before = JSON.stringify(now.rents);
    now = recompute(now, { A: [share(OCT, 30)] });
    expect(JSON.stringify(now.rents)).toBe(before);
  });

  it('…also when the payment is only made smaller', () => {
    const c = lease();
    payInFull(c, NOV);
    const now = recompute(c, { A: [share(OCT, 30)] });
    now.buildings = [building({ A: [share(OCT, 30)] })];
    Contract.payTerm(now, String(NOV), cash(150));
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
    expect(rentOf(now, NOV).total.payment).toBe(150);
    expect(ownBill(now, NOV)).toBe(430);
    expect(lines(now, DEC)).toEqual([]);
  });

  it('…and the amount the screen then shows is the amount that settles the month', () => {
    const c = lease();
    payInFull(c, NOV);
    const now = recompute(c, { A: [share(OCT, 30)] });
    now.buildings = [building({ A: [share(OCT, 30)] })];
    Contract.payTerm(now, String(NOV), { payments: [] });
    payInFull(now, NOV);
    expect(rentOf(now, NOV).total.payment).toBe(total(now, NOV));
    expect(rentOf(now, DEC).total.balance).toBe(0);
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
  });

  it('the lease ends with the current month: a share that had no month left gets this one as soon as it re-opens', () => {
    // November is the last month and is paid; October's share is on no rent (there is
    // no month after November). No carried line exists anywhere — the share is
    // waiting. The payment of November is removed.
    const c = lease({
      end: Date.parse('2026-11-30T23:59:59Z'),
      units: [unitOf('A', '2026-07-01', '2026-11-30')]
    });
    payInFull(c, NOV);
    const rows = () => ({ A: [share(OCT, 30)] });
    const now = recompute(c, rows(), {
      properties: [unitOf('A', '2026-07-01', '2026-11-30')]
    });
    expect(whereBilled(now, 'power', OCT)).toEqual([]);

    now.buildings = [building(rows())];
    Contract.payTerm(now, String(NOV), { payments: [] });
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
    expect(ownBill(now, NOV)).toBe(430);
    expect('ledgerFacts' in now).toBe(false);
  });

  it('a month that re-opens while it holds a carried share whose row has gone drops it at once', () => {
    // November took October's share and was paid. The figure is then cleared (the row
    // is gone) — November, closed, keeps what it billed. Its payment is removed.
    const c = lease();
    let now = recompute(c, { A: [share(OCT, 30)] });
    payInFull(now, NOV);
    now = recompute(now, { A: [] });
    expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);

    now.buildings = [building({ A: [] })];
    Contract.payTerm(now, String(NOV), { payments: [] });
    expect(lines(now, NOV)).toEqual([]);
    expect(ownBill(now, NOV)).toBe(400);
  });

  it('a month that re-opens with no carried share anywhere is left exactly as it always was', () => {
    // No share is carried: the second pricing must not run. (It would price November
    // again from the building as it is NOW — here a new figure — which a payment on
    // its own has never done.)
    const c = lease({ rows: { A: [oldShare(NOV, 20, WATER)] } });
    payInFull(c, NOV);
    const billed = JSON.stringify(rentOf(c, NOV).buildingCharges);
    c.buildings = [building({ A: [oldShare(NOV, 55, WATER)] })];
    Contract.payTerm(c, String(NOV), { payments: [] });
    expect(JSON.stringify(rentOf(c, NOV).buildingCharges)).toBe(billed);
    expect(ownBill(c, NOV)).toBe(420);
  });

  it('…also when a unit of the building that is NOT the tenant’s holds a marked row', () => {
    const c = lease({
      rows: { A: [oldShare(NOV, 20, WATER)], B: [share(OCT, 30)] }
    });
    payInFull(c, NOV);
    const billed = JSON.stringify(rentOf(c, NOV).buildingCharges);
    c.buildings = [
      building({ A: [oldShare(NOV, 55, WATER)], B: [share(OCT, 30)] })
    ];
    Contract.payTerm(c, String(NOV), { payments: [] });
    expect(JSON.stringify(rentOf(c, NOV).buildingCharges)).toBe(billed);
    expect(ownBill(c, NOV)).toBe(420);
  });

  it('…while a marked row on a unit of the tenant’s means the months are priced again: the ledger says at once what the next recompute makes it say', () => {
    // Carrying is in play for this tenant (a marked row — here of a month that is
    // still to come, so nothing is carried): the months are priced once more. That
    // changes WHEN the re-opened month takes the building's figures as they are now —
    // in the same save, not at the next recompute — and nothing else.
    const rows = () => ({ A: [oldShare(NOV, 55, WATER), share(DEC, 5)] });
    const c = lease({
      rows: { A: [oldShare(NOV, 20, WATER), share(DEC, 5)] }
    });
    payInFull(c, NOV);
    c.buildings = [building(rows())];
    Contract.payTerm(c, String(NOV), { payments: [] });
    expect(lines(c, NOV)).toEqual([['Water', 55]]);
    const whole = (contract) =>
      JSON.stringify(
        contract.rents.map((r) => [r.term, r.buildingCharges, r.total])
      );
    const after = whole(c);
    expect(whole(recompute(c, rows()))).toBe(after);
  });

  it('a payment on a month that stays closed moves nothing', () => {
    const c = lease();
    payInFull(c, NOV);
    const now = recompute(c, { A: [share(OCT, 30)] });
    now.buildings = [building({ A: [share(OCT, 30)] })];
    // the same amount again, another date: November is still paid in full
    Contract.payTerm(now, String(NOV), {
      payments: [
        {
          amount: total(now, NOV),
          type: 'transfer',
          date: '16/11/2026',
          reference: 'x'
        }
      ]
    });
    expect(whereBilled(now, 'power', OCT)).toEqual([DEC]);
  });

  it('the lease ends before the month the share was on: it is on no rent, and the ledger does not claim otherwise', () => {
    const c = lease();
    payInFull(c, NOV);
    let now = recompute(c, { A: [share(OCT, 30)] });
    expect(whereBilled(now, 'power', OCT)).toEqual([DEC]);

    now = recompute(
      now,
      { A: [share(OCT, 30)] },
      { termination: new Date('2026-11-30T23:59:59Z') }
    );
    expect(now.rents.map((r) => r.term)).toEqual([JUL, AUG, SEP, OCT, NOV]);
    expect(whereBilled(now, 'power', OCT)).toEqual([]);
  });

  it('a lease that had ended is extended: the share that had no month gets one', () => {
    const c = lease({ end: Date.parse('2026-10-31T23:59:59Z') });
    let now = recompute(c, { A: [share(OCT, 30)] });
    expect(whereBilled(now, 'power', OCT)).toEqual([]);

    now = recompute(
      now,
      { A: [share(OCT, 30)] },
      {
        end: Date.parse('2026-12-31T23:59:59Z'),
        properties: [unitOf('A', '2026-07-01', '2026-12-31')]
      }
    );
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
  });

  it('a month goes by unpaid: the share stays where it was billed', () => {
    const c = lease();
    let now = recompute(c, { A: [share(OCT, 30)] });
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
    const november = JSON.stringify(rentOf(now, NOV).buildingCharges);

    at(MID_DECEMBER);
    now = recompute(now, { A: [share(OCT, 30)] });
    expect(JSON.stringify(rentOf(now, NOV).buildingCharges)).toBe(november);
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
  });

  it('a recompute that never happened before the month was paid: the next one bills the share on the next month', () => {
    // The statement was saved, the tenant's recompute failed, the tenant paid November.
    const c = lease();
    payInFull(c, NOV);
    const now = recompute(c, { A: [share(NOV, 30)] });
    expect(whereBilled(now, 'power', NOV)).toEqual([DEC]);
  });
});

describe('the engine on its own, told what the stored ledger says', () => {
  // The managers never ask for a closed month to be priced and kept. The engine does
  // not rely on that: told that the current month is closed, it does not bill a carried
  // share on it.
  const priced = (currentIsClosed) => {
    const c = lease();
    c.buildings = [building({ A: [share(OCT, 30)] })];
    c.ledgerFacts = {
      currentTerm: NOV,
      currentIsClosed,
      closedTerms: new Set(
        currentIsClosed ? [JUL, AUG, SEP, OCT, NOV] : [JUL, AUG, SEP, OCT]
      ),
      held: [],
      placed: []
    };
    const carriedOn = (date, previous) =>
      BL.computeRent(c, date, rentOf(c, previous))
        .buildingCharges.filter((l) => l.forTerm)
        .map((l) => [l.amount, l.forTerm]);
    return {
      october: carriedOn('01/10/2026 00:00', SEP),
      november: carriedOn('01/11/2026 00:00', OCT),
      december: carriedOn('01/12/2026 00:00', NOV),
      january: carriedOn('01/01/2027 00:00', DEC)
    };
  };

  it('the current month is open: it takes the share, no other month does', () => {
    expect(priced(false)).toEqual({
      october: [],
      november: [[30, OCT]],
      december: [],
      january: []
    });
  });

  it('the current month is closed: the month after it takes the share, no other month does', () => {
    expect(priced(true)).toEqual({
      october: [],
      november: [],
      december: [[30, OCT]],
      january: []
    });
  });

  it('with no stored ledger to read, nothing is carried', () => {
    const c = lease();
    c.buildings = [building({ A: [share(OCT, 30)] })];
    expect(
      BL.computeRent(
        c,
        '01/11/2026 00:00',
        rentOf(c, OCT)
      ).buildingCharges.filter((l) => l.forTerm)
    ).toEqual([]);
  });
});

describe('when the dates of the lease move', () => {
  it('the begin date moves earlier: the months that are added are priced with their own shares, once', () => {
    // The lease began in September; a marked share for August sits on the building.
    const c = lease({
      begin: Date.parse('2026-09-01T00:00:00Z'),
      units: [unitOf('A', '2026-09-01')]
    });
    expect(c.rents[0].term).toBe(SEP);
    const rows = () => ({ A: [share(AUG, 30)] });
    let now = recompute(c, rows());
    expect(whereBilled(now, 'power', AUG)).toEqual([]);

    // The begin date is put back to July. August is a new month of this ledger: it
    // is priced with its own share and nothing is carried on top of it.
    now = recompute(now, rows(), {
      begin: Date.parse('2026-07-01T00:00:00Z'),
      properties: [unitOf('A', '2026-07-01')]
    });
    expect(now.rents[0].term).toBe(JUL);
    expect(whereBilled(now, 'power', AUG)).toEqual([AUG]);
  });

  it('the begin date moves later: a share of a month the lease no longer has is not carried', () => {
    const c = lease();
    // July leaves the lease; the unit's own window is left as it was.
    const now = recompute(
      c,
      { A: [share(JUL, 30)] },
      { begin: Date.parse('2026-09-01T00:00:00Z') }
    );
    expect(now.rents[0].term).toBe(SEP);
    expect(whereBilled(now, 'power', JUL)).toEqual([]);
  });

  it('the begin date moves later, then back: a share that went on a later month is not billed again on its own', () => {
    // August's share was carried to November, which is paid. The begin date is moved
    // to September (July and August are dropped; November, closed, keeps the line),
    // then back to July: August is built again, from its row. Found by review: it
    // took the share as its own line too.
    const c = lease();
    const rows = () => ({ A: [share(AUG, 30)] });
    let now = recompute(c, rows());
    payInFull(now, NOV);
    expect(whereBilled(now, 'power', AUG)).toEqual([NOV]);

    now = recompute(now, rows(), {
      begin: Date.parse('2026-09-01T00:00:00Z'),
      properties: [unitOf('A', '2026-09-01')]
    });
    expect(now.rents.map((r) => r.term)[0]).toBe(SEP);
    expect(whereBilled(now, 'power', AUG)).toEqual([NOV]);

    now = recompute(now, rows(), {
      begin: Date.parse('2026-07-01T00:00:00Z'),
      properties: [unitOf('A')]
    });
    expect(now.rents.map((r) => r.term)[0]).toBe(JUL);
    expect(lines(now, AUG)).toEqual([]);
    expect(whereBilled(now, 'power', AUG)).toEqual([NOV]);
  });

  it('…while a month that is built again takes a share that is on no later rent, as before', () => {
    const c = lease();
    const rows = () => ({ A: [oldShare(AUG, 30)] });
    let now = recompute(c, rows(), {
      begin: Date.parse('2026-09-01T00:00:00Z'),
      properties: [unitOf('A', '2026-09-01')]
    });
    now = recompute(now, rows(), {
      begin: Date.parse('2026-07-01T00:00:00Z'),
      properties: [unitOf('A')]
    });
    expect(lines(now, AUG)).toEqual([['Common power', 30]]);
  });

  it('…also next to a share of its month that IS on a later rent: only that one is skipped', () => {
    // August has two shares. Water was there before the mark and was billed on August
    // itself; power came later and went on November, which is paid. Built again,
    // August bills its water and not its power.
    const c = lease({ rows: { A: [oldShare(AUG, 12, WATER)] } });
    const rows = () => ({ A: [oldShare(AUG, 12, WATER), share(AUG, 30)] });
    let now = recompute(c, rows());
    payInFull(now, NOV);
    expect(whereBilled(now, 'power', AUG)).toEqual([NOV]);
    expect(whereBilled(now, 'water', AUG)).toEqual([AUG]);

    now = recompute(now, rows(), {
      begin: Date.parse('2026-09-01T00:00:00Z'),
      properties: [unitOf('A', '2026-09-01')]
    });
    now = recompute(now, rows(), {
      begin: Date.parse('2026-07-01T00:00:00Z'),
      properties: [unitOf('A')]
    });
    expect(lines(now, AUG)).toEqual([['Water', 12]]);
    expect(whereBilled(now, 'power', AUG)).toEqual([NOV]);
    expect(whereBilled(now, 'water', AUG)).toEqual([AUG]);
  });

  it('…nor a row that the later rent’s line MAY be for: its expense was deleted since, and two rows read like it', () => {
    // August's share (30) went on November, which is paid. The expense is then
    // deleted and created again and August typed again; a second expense has the
    // same name, and an August row of its own. November's line could be for either:
    // built again, August bills neither (the app does not guess).
    const YARD = { ...POWER, _id: 'yard' };
    const AGAIN = { ...POWER, _id: 'power-again' };
    const c = lease({ rows: { expenses: [POWER, WATER, YARD] } });
    let now = recompute(c, {
      A: [share(AUG, 30)],
      expenses: [POWER, WATER, YARD]
    });
    payInFull(now, NOV);
    expect(whereBilled(now, 'power', AUG)).toEqual([NOV]);

    const typedAgain = share(AUG, 30, AGAIN);
    const ofTheYard = share(AUG, 12, YARD);
    const rows = () => ({
      A: [typedAgain, ofTheYard],
      expenses: [AGAIN, WATER, YARD]
    });
    now = recompute(now, rows(), {
      begin: Date.parse('2026-09-01T00:00:00Z'),
      properties: [unitOf('A', '2026-09-01')]
    });
    now = recompute(now, rows(), {
      begin: Date.parse('2026-07-01T00:00:00Z'),
      properties: [unitOf('A')]
    });
    expect(lines(now, AUG)).toEqual([]);
    // …and at the next recompute neither is carried
    now = recompute(now, rows());
    expect(
      now.rents.flatMap((r) =>
        (r.buildingCharges || [])
          .filter((l) => (l.forTerm ?? r.term) === AUG)
          .map((l) => [r.term, l.amount])
      )
    ).toEqual([[NOV, 30]]);
  });

  // Only a MARKED row can be what a carried line was billed for. A row that is not
  // marked is the month's own share: built again, the month bills it — whatever a
  // later rent holds for another share. (It was skipped, and so lost for good: the
  // month is over, and an unmarked row is never carried. Found by review.)
  it('a month that is built again bills its own unmarked share next to a later rent’s line of a deleted namesake', () => {
    // August: power 30 from before the mark, billed on August. A share of the yard's
    // expense — same name — came later and went on November, which is paid. The begin
    // date moves to September, the yard's expense is deleted, the begin date moves back.
    const YARD = { ...POWER, _id: 'yard' };
    const power = oldShare(AUG, 30);
    const ofTheYard = share(AUG, 25, YARD);
    const c = lease({ rows: { A: [power], expenses: [POWER, WATER, YARD] } });
    expect(lines(c, AUG)).toEqual([['Common power', 30]]);
    let now = recompute(c, {
      A: [power, ofTheYard],
      expenses: [POWER, WATER, YARD]
    });
    payInFull(now, NOV);
    expect(lines(now, NOV)).toEqual([['Common power', 25, AUG]]);

    now = recompute(
      now,
      { A: [power, ofTheYard], expenses: [POWER, WATER, YARD] },
      {
        begin: Date.parse('2026-09-01T00:00:00Z'),
        properties: [unitOf('A', '2026-09-01')]
      }
    );
    now = recompute(
      now,
      { A: [power] },
      { begin: Date.parse('2026-07-01T00:00:00Z'), properties: [unitOf('A')] }
    );
    expect(lines(now, AUG)).toEqual([['Common power', 30]]);
    expect(lines(now, NOV)).toEqual([['Common power', 25, AUG]]);
  });

  it('…and next to a later rent’s line of ANOTHER unit whose row has gone since', () => {
    // A's marked August share (30) went on November, which is paid; B's own August
    // share (20, from before the mark) was billed on August. The begin date moves to
    // September, A's August row is removed, the begin date moves back.
    const ofB = oldShare(AUG, 20);
    const ofA = share(AUG, 30);
    const both = [unitOf('A'), unitOf('B')];
    const c = lease({ units: both, rows: { B: [ofB] } });
    let now = recompute(c, { A: [ofA], B: [ofB] });
    payInFull(now, NOV);
    expect(lines(now, AUG)).toEqual([['Common power', 20]]);
    expect(lines(now, NOV)).toEqual([['Common power', 30, AUG]]);

    now = recompute(
      now,
      { A: [ofA], B: [ofB] },
      {
        begin: Date.parse('2026-09-01T00:00:00Z'),
        properties: [unitOf('A', '2026-09-01'), unitOf('B', '2026-09-01')]
      }
    );
    now = recompute(
      now,
      { B: [ofB] },
      { begin: Date.parse('2026-07-01T00:00:00Z'), properties: both }
    );
    expect(lines(now, AUG)).toEqual([['Common power', 20]]);
    expect(lines(now, NOV)).toEqual([['Common power', 30, AUG]]);
  });

  it('…while a row that the later rent’s line names outright is skipped, marked today or not', () => {
    // the mark of A's August row was lost since (a row sent back without its id
    // through the unit endpoint): November's line still names that unit and expense
    const marked = share(AUG, 30);
    const c = lease();
    let now = recompute(c, { A: [marked] });
    payInFull(now, NOV);
    const unmarked = { ...marked, carry: undefined };
    now = recompute(
      now,
      { A: [unmarked] },
      {
        begin: Date.parse('2026-09-01T00:00:00Z'),
        properties: [unitOf('A', '2026-09-01')]
      }
    );
    now = recompute(
      now,
      { A: [unmarked] },
      { begin: Date.parse('2026-07-01T00:00:00Z'), properties: [unitOf('A')] }
    );
    expect(lines(now, AUG)).toEqual([]);
    expect(lines(now, NOV)).toEqual([['Common power', 30, AUG]]);
  });

  it('…and a fixed expense is not billed live in place of the share that is skipped', () => {
    // the row of August stands for the expense that month; with the row left out
    // because a later rent holds it, the expense's own (live) share must not step in
    const c = lease();
    const august = share(AUG, 30);
    let now = recompute(c, { A: [august] });
    payInFull(now, NOV);
    expect(whereBilled(now, 'power', AUG)).toEqual([NOV]);
    // the expense gets a fixed amount (80: 40 for this unit) before the dates move
    const fixed = { ...POWER, amount: 80 };
    const rows = () => ({ A: [august], expenses: [fixed, WATER] });
    now = recompute(now, rows(), {
      begin: Date.parse('2026-09-01T00:00:00Z'),
      properties: [unitOf('A', '2026-09-01')]
    });
    now = recompute(now, rows(), {
      begin: Date.parse('2026-07-01T00:00:00Z'),
      properties: [unitOf('A')]
    });
    expect(lines(now, AUG)).toEqual([]);
    // July, built again too, has no row: the fixed expense bills its live share there
    expect(lines(now, JUL)).toEqual([['Common power', 40]]);
  });
});

describe('payments', () => {
  const withShare = () => {
    const c = lease();
    const now = recompute(c, { A: [share(OCT, 30)] });
    now.buildings = [building({ A: [share(OCT, 30)] })];
    return now;
  };

  it('a part payment on the month the share is on keeps it there', () => {
    const now = withShare();
    Contract.payTerm(now, String(NOV), cash(100));
    expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);
    expect(rentOf(now, NOV).total.payment).toBe(100);
  });

  it('paying that month in full closes it with the share on it', () => {
    let now = withShare();
    payInFull(now, NOV);
    expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);
    expect(rentOf(now, NOV).total.payment).toBe(total(now, NOV));

    now = recompute(now, { A: [share(OCT, 30)] });
    expect(whereBilled(now, 'power', OCT)).toEqual([NOV]);
  });

  it('a payment recorded on the closed month the share is for does not put it there', () => {
    const now = withShare();
    Contract.payTerm(now, String(OCT), cash(400));
    expect(lines(now, OCT)).toEqual([]);
    expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);
  });

  it('a payment that comes first, with the share not yet on the month: the month is priced with it', () => {
    // The stored November does not hold the share yet. Its exact old total is paid:
    // November is priced as the open month it still is, gets the share, and is left
    // 30 short — the payment does not close it over a share it never held.
    const c = lease();
    c.buildings = [building({ A: [share(OCT, 30)] })];
    const before = total(c, NOV);
    Contract.payTerm(c, String(NOV), cash(before));
    expect(lines(c, NOV)).toEqual([['Common power', 30, OCT]]);
    expect(total(c, NOV)).toBe(before + 30);
    expect(rentOf(c, NOV).total.payment).toBe(before);
  });

  it('the facts of the stored ledger are not left on the contract', () => {
    const now = withShare();
    expect('ledgerFacts' in now).toBe(false);
    Contract.payTerm(now, String(NOV), cash(100));
    expect('ledgerFacts' in now).toBe(false);
  });
});

describe('ledgers that are damaged or old-shaped', () => {
  it.each([
    ['no lines at all', undefined],
    ['null', null],
    ['a text', 'none'],
    ['a list holding null and a number', [null, 5]],
    ['lines without ids or names', [{ amount: 30 }]]
  ])(
    'a closed month whose building lines are %s stops nothing',
    (_what, value) => {
      const c = lease();
      rentOf(c, OCT).buildingCharges = value;
      let now;
      expect(() => {
        now = recompute(c, { A: [share(OCT, 30)] });
      }).not.toThrow();
      expect(lines(now, NOV)).toEqual([['Common power', 30, OCT]]);
    }
  );

  it('a building without that unit, or no building, bills nothing and stops nothing', () => {
    const c = lease();
    expect(() =>
      Contract.update(c, { properties: c.properties, buildings: [] })
    ).not.toThrow();
    expect(() =>
      Contract.update(c, { properties: c.properties, buildings: undefined })
    ).not.toThrow();
    const other = building({ A: [share(OCT, 30)] });
    other.units.forEach((u) => (u.propertyId = `other-${u.propertyId}`));
    const now = Contract.update(c, {
      properties: c.properties,
      buildings: [other]
    });
    now.rents.forEach((r) => expect(r.buildingCharges).toEqual([]));
  });
});

describe('whatever happens in whatever order (250 histories)', () => {
  // The first version of this test gave every share an expense of its own; the second
  // counted lines per expense and month only; the third kept the two units' amounts
  // apart, never let the tenant hold the units in turn, and left out whatever its own
  // code could only guess at. Each time a reviewer then found, by hand, what the
  // generator could not make or the count could not see. This one has every axis they
  // used:
  //   · a tenant with one or two units — held together, or one after the other — that
  //     share two expenses, and in some histories a THIRD expense with the name of the
  //     first; shares of the same amount on both units, or of different ones;
  //   · rows from before the mark, and ledgers stored before lines carried ids (also
  //     with the namesake);
  //   · a figure changed by a little or by a lot; a month saved as 0 and typed again;
  //     any expense deleted and created again; the rows written back in any order,
  //     and sometimes on the OTHER unit; a share moved from one unit to the other;
  //   · payments saved on their own, on the current month and on older ones;
  //   · a unit's entry or exit date recorded late; the lease's begin date moved and
  //     moved back, a termination set and removed;
  //   · months going by.
  // What it holds the engine to, against the TRUTH the test keeps for itself (which
  // unit and which expense every line was really billed for, also when the line no
  // longer says):
  //   · never twice: no unit ever has more lines for an expense and a month than it
  //     had rows at once — and all the units together never have more than they had
  //     rows at once together (a share that moved to the other unit is one share);
  //   · never lost, share by share: a share that is owed has a line of its own. A share
  //     with no mark (there when the lease was first priced, or arrived while its month
  //     was open) always, on its own month. A marked
  //     one unless (a) an OLD line of a closed rent could be for it (same month, same
  //     name; stored without ids, or of a deleted expense): then the app does not
  //     guess, and the share is left unbilled — the test counts how often; or (b) a
  //     line of its expense and month has outlived its own row: such a line stands in
  //     for one share, by count;
  //   · a share that is not marked is never on another month than its own;
  //   · a closed month never changes;
  //   · after a payment on the current month the whole ledger is what the recompute
  //     right after makes it.
  // What it does NOT have, on purpose: an expense created again under another name
  // (billed again, documented), a unit taken off the lease, three units, repairs.
  it('never twice (unit by unit), never lost, a closed month never changes, and a payment on the current month leaves the ledger as the next recompute would', () => {
    // Small deterministic generator: the test must fail the same way every run.
    let seed = 20261123;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    const shuffled = (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };
    const months = [JUL, AUG, SEP, OCT, NOV, DEC, JAN];
    const clock = ['2026-11-15', '2026-12-15', '2027-01-15'];
    const lastDayOf = (month) =>
      new Date(
        Date.UTC(Math.floor(month / 1000000), (Math.floor(month / 10000) % 100), 0, 23, 59, 59)
      );
    const firstDayOf = (month) =>
      new Date(
        Date.UTC(Math.floor(month / 1000000), (Math.floor(month / 10000) % 100) - 1, 1)
      );
    const reached = {
      carried: 0,
      outlived: 0,
      windows: 0,
      dates: 0,
      older: 0,
      namesakes: 0,
      sameAmounts: 0,
      heldInTurn: 0,
      moved: 0,
      dense: 0,
      datesTouched: 0,
      reopenedFromBehind: 0,
      mustBeBilled: 0,
      leftInDoubt: 0,
      stoodIn: 0,
      wholeLedger: 0,
      asItAlwaysWas: 0
    };

    for (let n = 0; n < 250; n++) {
      // what this history plays with, on top of the basics
      // (each on its own cycle: every pair of them meets in some history)
      // A fifth of the histories are DENSE: two units, the namesake, the lease's dates
      // moving, and every share in one of three months — so that what needs several
      // things to coincide (a share that moved while its first unit holds a namesake,
      // a month built again next to a later rent's line) happens often, not once.
      const dense = n % 5 === 4;
      const withNamesake = dense || n % 2 === 1;
      const withWindows = !dense && n % 3 === 0;
      const withDates = dense || n % 3 === 1;
      const withOlderPayments = n % 4 < 2;
      const rowMonths = dense ? [AUG, SEP, OCT] : months;
      let today = 0;
      const currentTerm = () =>
        Number(`${clock[today].slice(0, 7).replace('-', '')}0100`);

      // the expenses, by what they are («lineage»): an expense that is deleted and
      // created again keeps its lineage and its name, and gets another id
      const lineages = withNamesake ? ['power', 'water', 'yard'] : ['power', 'water'];
      const nameOf = { power: 'Common power', water: 'Water', yard: 'Common power' };
      const base = { power: POWER, water: WATER, yard: POWER };
      const liveId = {};
      const generation = {};
      lineages.forEach((l) => {
        generation[l] = 0;
        liveId[l] = `${l}-${n}-0`;
      });
      const expenseOf = (l) => ({ ...base[l], _id: liveId[l], name: nameOf[l] });
      // an expense is known by its lineage here: the id says it (`power-7-2`), and a
      // line that was stored without ids is remembered below with the one it had
      const lineageOf = (expenseId) => String(expenseId).split('-')[0];

      const twoUnits = dense || withWindows || rnd() < 0.6;
      const unitIds = twoUnits ? ['A', 'B'] : ['A'];
      // in a third of the histories the two units' shares are the same amount: an old
      // line then says nothing at all about which unit it was for
      const sameAmounts = n % 3 === 0;
      const baseAmount = sameAmounts ? { A: 30, B: 30 } : { A: 30, B: 100 };
      // …and in a fifth the tenant holds the units one after the other: A until the
      // end of September, B from October
      const heldInTurn = twoUnits && n % 5 === 0;
      const rows = { A: [], B: [] };
      const lease0 = {
        begin: '2026-07-01',
        termination: null,
        windows: {
          A: {
            entry: '2026-07-01',
            exit: heldInTurn ? '2026-09-30' : '2027-06-30'
          },
          B: {
            entry: heldInTurn ? '2026-10-01' : '2026-07-01',
            exit: '2027-06-30'
          }
        }
      };
      const st = JSON.parse(JSON.stringify(lease0));
      const properties = () =>
        unitIds.map((u) => unitOf(u, st.windows[u].entry, st.windows[u].exit));
      const inWindow = (u, month) => {
        const m = firstDayOf(month).getTime();
        return (
          m >= Date.parse(`${st.windows[u].entry.slice(0, 7)}-01T00:00:00Z`) &&
          m <= Date.parse(`${st.windows[u].exit}T23:59:59Z`)
        );
      };
      const world = () => ({
        A: rows.A.map(({ billedAtFirst: _b, lineage: _l, ...r }) => ({ ...r })),
        B: rows.B.map(({ billedAtFirst: _b, lineage: _l, ...r }) => ({ ...r })),
        expenses: lineages.map(expenseOf)
      });
      const has = (unit, lineage, month) =>
        rows[unit].some((r) => r.lineage === lineage && r.term === month);
      const addRow = (unit, lineage, month, marked, extra = {}) => {
        const amount = baseAmount[unit] + (lineage === 'water' ? 3 : lineage === 'yard' ? 6 : 0);
        rows[unit].push({
          ...(marked ? share : oldShare)(month, amount, expenseOf(lineage)),
          lineage,
          ...extra
        });
      };

      // rows the building already holds when the lease is first priced: every month
      // takes its own, so these ARE billed
      const first = (dense ? 3 : 0) + Math.floor(rnd() * 4);
      for (let i = 0; i < first; i++) {
        const unit = pick(unitIds);
        const lineage = pick(lineages);
        const month = pick(rowMonths);
        if (!has(unit, lineage, month)) {
          // (billed when the lease is first priced — if the tenant holds the unit
          // that month)
          addRow(unit, lineage, month, false, {
            billedAtFirst: inWindow(unit, month)
          });
        }
      }
      let c = lease({
        units: properties(),
        rows: world(),
        today: `${clock[today]}T12:00:00Z`
      });
      // half the ledgers are as the real ones are today: no ids on any line. The unit
      // and the expense each such line was billed for are remembered here, for the
      // counts.
      const billedFor = new Map();
      if (rnd() < (dense ? 0.25 : 0.5)) {
        c.rents.forEach((r) => {
          r.buildingCharges = (r.buildingCharges || []).map(
            ({ description, amount, buildingName, type, propertyId, expenseId }, i) => {
              billedFor.set(`${r.term}|${i}|${description}|${amount}`, {
                unit: propertyId,
                lineage: lineageOf(expenseId)
              });
              return { description, amount, buildingName, type };
            }
          );
        });
      }
      const whatLineIs = (r, l, i) =>
        l.expenseId
          ? { unit: l.propertyId, lineage: lineageOf(l.expenseId) }
          : billedFor.get(`${r.term}|${i}|${l.description}|${l.amount}`);

      const recomputeNow = (contract) =>
        Contract.update(contract, {
          begin: Date.parse(`${st.begin}T00:00:00Z`),
          termination: st.termination
            ? new Date(`${st.termination}T23:59:59Z`)
            : undefined,
          properties: properties(),
          buildings: [building(world())]
        });

      // the units whose dates were touched in this history: a month can then have
      // closed while the tenant was said not to hold the unit, and a row from before
      // the mark that it did not bill then is billed by nothing later (as it always
      // was) — such a unit's unmarked rows are not held to «on its own month»
      const datesTouched = new Set();
      const trail = [`first rows ${JSON.stringify(world())}`];
      const closedBefore = new Map();
      const isClosed = (r) =>
        r.term < currentTerm() ||
        (r.term === currentTerm() &&
          r.total.grandTotal > 0 &&
          r.total.payment >= r.total.grandTotal - 0.01);
      const mostRowsOfUnit = {};
      const mostRows = {};
      const count = () => {
        lineages.forEach((lineage) =>
          months.forEach((month) => {
            let all = 0;
            unitIds.forEach((u) => {
              const mine = rows[u].filter(
                (r) => r.lineage === lineage && r.term === month
              ).length;
              all += mine;
              const key = `${u}|${lineage}|${month}`;
              mostRowsOfUnit[key] = Math.max(mostRowsOfUnit[key] || 0, mine);
            });
            const key = `${lineage}|${month}`;
            mostRows[key] = Math.max(mostRows[key] || 0, all);
          })
        );
      };
      // every month's lines and totals
      const wholeLedger = (contract) =>
        JSON.stringify(
          contract.rents.map((r) => [r.term, r.buildingCharges, r.total])
        );
      const carriedLines = (contract) =>
        JSON.stringify(
          contract.rents.flatMap((r) =>
            (r.buildingCharges || [])
              .filter((l) => l.forTerm !== undefined)
              .map((l) => [r.term, l.propertyId, l.description, l.forTerm])
          )
        );
      const check = (contract, where) => {
        const inAll = {};
        const perUnit = {};
        contract.rents.forEach((r) =>
          (r.buildingCharges || []).forEach((l, i) => {
            const month = l.forTerm ?? r.term;
            const its = whatLineIs(r, l, i);
            expect([where, r.term, i, !!its]).toEqual([where, r.term, i, true]);
            inAll[`${its.lineage}|${month}`] =
              (inAll[`${its.lineage}|${month}`] || 0) + 1;
            const key = `${its.unit}|${its.lineage}|${month}`;
            perUnit[key] = (perUnit[key] || 0) + 1;
          })
        );
        const inLedger = new Set(contract.rents.map((r) => r.term));
        const firstOpen = contract.rents.find(
          (r) => r.term >= currentTerm() && !isClosed(r)
        );
        // The OLD lines of closed rents: stored without ids, or of an expense that
        // was deleted since. Such a line says a month and a name, and perhaps a unit.
        // The app does not guess which row it was billed for: it bills none of the
        // rows it could be for. Which rows are those — said here by COUNTING, not with
        // the code's own steps:
        //   · a line that names no unit: every row of that month with that name;
        //   · a line that names a unit: that unit's rows of that month with that name
        //     that have no line of their own expense. When a unit has more such lines
        //     than such rows, the lines left over are for a row of ANY unit (a share
        //     that moved): every row of that month with that name. And when the rows
        //     of that month with that name are of TWO expenses, the unit says too
        //     little: every one of them.
        const live = new Set(Object.values(liveId));
        const closedLines = contract.rents.filter(isClosed).flatMap((r) =>
          (r.buildingCharges || []).map((l) => ({
            month: l.forTerm ?? r.term,
            description: l.description,
            unit: l.propertyId || '',
            expenseId: l.expenseId ? String(l.expenseId) : ''
          }))
        );
        const isOld = (l) => !l.expenseId || !live.has(l.expenseId);
        const freeRowsOf = (u, l) =>
          (rows[u] || []).filter(
            (row) =>
              row.term === l.month &&
              row.description === l.description &&
              !closedLines.some(
                (own) =>
                  !isOld(own) &&
                  own.unit === u &&
                  own.month === l.month &&
                  own.expenseId === String(row.expenseId)
              )
          ).length;
        const oldLinesNaming = (u, l) =>
          closedLines.filter(
            (other) =>
              isOld(other) &&
              other.unit === u &&
              other.month === l.month &&
              other.description === l.description
          ).length;
        const namesakesReadLike = (l) =>
          new Set(
            unitIds.flatMap((u) =>
              rows[u]
                .filter(
                  (row) =>
                    row.term === l.month && row.description === l.description
                )
                .map((row) => String(row.expenseId))
            )
          ).size > 1;
        const inDoubt = (u, row) =>
          closedLines.some(
            (l) =>
              isOld(l) &&
              l.month === row.term &&
              l.description === row.description &&
              (!l.unit ||
                l.unit === u ||
                namesakesReadLike(l) ||
                oldLinesNaming(l.unit, l) > freeRowsOf(l.unit, l))
          );
        lineages.forEach((lineage) =>
          months.forEach((month) => {
            const key = `${lineage}|${month}`;
            const lines = inAll[key] || 0;
            // never twice: all the units together have no more lines than they ever
            // had rows at once — a share that is billed, whose row then goes while a
            // row of the other unit arrives, is taken for a share that moved…
            expect([where, key, lines <= (mostRows[key] || 0), lines]).toEqual([
              where,
              key,
              true,
              lines
            ]);
            // …and no unit has more lines than it ever had rows at once
            unitIds.forEach((u) => {
              const mine = perUnit[`${u}|${key}`] || 0;
              const most = mostRowsOfUnit[`${u}|${key}`] || 0;
              expect([where, `${u}|${key}`, mine <= most, mine, most]).toEqual([
                where,
                `${u}|${key}`,
                true,
                mine,
                most
              ]);
            });
            // never lost, share by share. (With no open month left, a marked share of
            // a closed month has nowhere to go; a share from before the mark is on its
            // own month whether a month is open or not.)
            if (!inLedger.has(month)) return;
            // the lines that were really billed for this expense and month and have
            // outlived their own row (the unit has none for it any more): each stands
            // in for ONE other share — a share that moved. The rule goes by count.
            let standIns = 0;
            contract.rents.forEach((r) =>
              (r.buildingCharges || []).forEach((l, i) => {
                const its = whatLineIs(r, l, i);
                if (
                  (l.forTerm ?? r.term) === month &&
                  its.lineage === lineage &&
                  !has(its.unit, lineage, month)
                ) {
                  standIns += 1;
                }
              })
            );
            let stoodInFor = 0;
            unitIds.forEach((u) =>
              rows[u]
                .filter(
                  (r) =>
                    r.lineage === lineage &&
                    r.term === month &&
                    inWindow(u, month) &&
                    (r.carry === true || r.billedAtFirst)
                )
                .forEach((r) => {
                  if (perUnit[`${u}|${key}`]) {
                    reached.mustBeBilled += 1;
                  } else if (r.carry === true && !firstOpen) {
                    // nowhere to go
                  } else if (r.carry === true && inDoubt(u, r)) {
                    reached.leftInDoubt += 1;
                  } else if (r.carry === true) {
                    stoodInFor += 1;
                  } else if (datesTouched.has(u)) {
                    reached.datesTouched += 1;
                  } else {
                    // a share from before the mark has no other month to go to
                    expect([where, `${u}|${key}`, 'on no rent']).toEqual([
                      where,
                      `${u}|${key}`,
                      'on its own month'
                    ]);
                  }
                })
            );
            expect([where, key, stoodInFor <= standIns, stoodInFor, standIns]).toEqual([
              where,
              key,
              true,
              stoodInFor,
              standIns
            ]);
            reached.stoodIn += stoodInFor;
          })
        );
        // a share that was not marked is never put on another month: on the months
        // that are still open, no carried line without a marked row
        contract.rents
          .filter((r) => !isClosed(r))
          .forEach((r) =>
            (r.buildingCharges || [])
              .filter((l) => l.forTerm !== undefined)
              .forEach((l) => {
                const marked = rows[l.propertyId].some(
                  (row) =>
                    row.carry === true &&
                    row.lineage === lineageOf(l.expenseId) &&
                    row.term === l.forTerm
                );
                expect([where, r.term, l.expenseId, marked]).toEqual([
                  where,
                  r.term,
                  l.expenseId,
                  true
                ]);
              })
          );
      };

      count();
      for (let step = 0; step < 14; step++) {
        const actions = [
          'a share arrives',
          'a share arrives',
          'a share arrives',
          'a share arrives',
          'a figure is changed',
          'a share is removed',
          ...(twoUnits ? ['a share moves to the other unit'] : []),
          'a month is saved as 0 and typed again',
          'an expense is deleted and created again',
          'the current month is paid in full',
          'the current month is paid in full',
          'the current month is part paid',
          'the payments of the current month are removed',
          'a month goes by',
          'nothing but a recompute'
        ];
        if (withOlderPayments) {
          actions.push('an older month is paid in full', 'the payments of an older month are removed');
        }
        if (withWindows) {
          actions.push('an exit date is recorded', 'an exit date is recorded', 'an entry date is recorded', 'the dates of the units are put back');
        }
        if (withDates) {
          actions.push('the begin date moves later', 'the begin date moves back', 'the lease is terminated', 'the termination is removed');
        }
        if (dense) {
          actions.push(
            'the begin date moves later',
            'the begin date moves back',
            'an expense is deleted and created again',
            'a share moves to the other unit',
            'the current month is paid in full'
          );
        }
        const action = pick(actions);
        let said = action;
        let paidCurrentOnItsOwn = false;
        let paidAnOlderMonth = false;
        // Is carrying in play for this tenant — a marked row, or a carried line on
        // the current month or after it? With neither, a paid month that a payment
        // re-opens keeps what it showed until the next recompute, as it always did.
        const currentBefore = c.rents.find((r) => r.term === currentTerm());
        const asItAlwaysWas =
          !!currentBefore &&
          isClosed(currentBefore) &&
          ![...rows.A, ...rows.B].some((r) => r.carry === true) &&
          !c.rents.some(
            (r) =>
              r.term >= currentTerm() &&
              (r.buildingCharges || []).some((l) => l.forTerm !== undefined)
          );
        const hasCurrent = () => c.rents.some((r) => r.term === currentTerm());
        if (action === 'a share arrives') {
          const unit = pick(unitIds);
          const lineage = pick(lineages);
          const month = pick(rowMonths);
          const marked = rnd() < 0.8;
          said = `${marked ? 'a marked' : 'an unmarked'} share arrives (${unit}, ${lineage}, ${month})`;
          // a row that is not marked and arrives while its month is OPEN is billed on
          // that month by the recompute that follows: owed there from now on
          const itsRent = c.rents.find((r) => r.term === month);
          const billedOnArrival =
            !marked && !!itsRent && !isClosed(itsRent) && inWindow(unit, month);
          if (!has(unit, lineage, month)) {
            addRow(unit, lineage, month, marked, {
              billedAtFirst: billedOnArrival
            });
          }
        } else if (action === 'a figure is changed') {
          // by a little, or by enough to pass the other unit's share
          const all = [...rows.A, ...rows.B];
          if (all.length) {
            const changed = pick(all);
            const by = pick([1, -10, 15, 70, -70]);
            if (changed.amount + by > 0) changed.amount += by;
            said = `a figure is changed (${changed.lineage}, ${changed.term}: ${changed.amount})`;
          }
        } else if (action === 'a share is removed') {
          const unit = pick(unitIds);
          if (rows[unit].length) {
            const gone = rows[unit].splice(
              Math.floor(rnd() * rows[unit].length),
              1
            )[0];
            said = `a share is removed (${unit}, ${gone.lineage}, ${gone.term})`;
          }
        } else if (action === 'a share moves to the other unit') {
          // the tenant's share of an expense and month sits on the other unit now (a
          // split per tenant run again): the row goes, a new row comes — at the same
          // amount, or a corrected one
          const all = [...rows.A, ...rows.B];
          if (all.length) {
            const moving = pick(all);
            const from = rows.A.includes(moving) ? 'A' : 'B';
            const to = from === 'A' ? 'B' : 'A';
            if (!has(to, moving.lineage, moving.term)) {
              rows[from] = rows[from].filter((r) => r !== moving);
              rows[to].push({
                ...share(
                  moving.term,
                  moving.amount + pick([0, 0, 1]),
                  expenseOf(moving.lineage)
                ),
                lineage: moving.lineage
              });
              said = `a share moves from ${from} to ${to} (${moving.lineage}, ${moving.term})`;
              reached.moved += 1;
            }
          }
        } else if (action === 'a month is saved as 0 and typed again') {
          // the rows of one expense and month go, and come back as new rows — in
          // whatever order the units happen to be written
          const all = [...rows.A, ...rows.B];
          if (all.length) {
            const { lineage, term: month } = pick(all);
            const units = unitIds.filter((u) => has(u, lineage, month));
            const kept = {};
            units.forEach((u) => {
              kept[u] = rows[u].find((r) => r.lineage === lineage && r.term === month).amount;
              rows[u] = rows[u].filter((r) => !(r.lineage === lineage && r.term === month));
            });
            c = recomputeNow(c);
            const order = shuffled(units);
            order.forEach((u) => {
              rows[u].push({ ...share(month, kept[u], expenseOf(lineage)), lineage });
            });
            said = `${lineage} of ${month} is saved as 0 and typed again (${order.join(', ')})`;
          }
        } else if (action === 'an expense is deleted and created again') {
          // a hard delete takes every row of the expense with it; then the landlord
          // types some of the months again under the new expense, in any order
          const lineage = pick(lineages);
          const before = unitIds.flatMap((u) =>
            rows[u]
              .filter((r) => r.lineage === lineage)
              .map((r) => [u, r.term, r.amount])
          );
          unitIds.forEach((u) => {
            rows[u] = rows[u].filter((r) => r.lineage !== lineage);
          });
          generation[lineage] += 1;
          liveId[lineage] = `${lineage}-${n}-${generation[lineage]}`;
          // …on the unit they were on, or (a share that moved) on the other one
          const again = shuffled(before.filter(() => rnd() < 0.6)).map(
            ([u, month, amount]) => [
              twoUnits && rnd() < 0.3 ? (u === 'A' ? 'B' : 'A') : u,
              month,
              amount
            ]
          );
          const typed = [];
          again.forEach(([u, month, amount]) => {
            if (has(u, lineage, month)) return;
            rows[u].push({ ...share(month, amount, expenseOf(lineage)), lineage });
            typed.push(u);
          });
          said = `«${lineage}» is deleted and created again, ${typed.length} of ${before.length} rows typed again (${typed.join('')})`;
        } else if (action === 'the current month is paid in full' && hasCurrent()) {
          c.buildings = [building(world())];
          Contract.payTerm(c, String(currentTerm()), cash(total(c, currentTerm())));
          paidCurrentOnItsOwn = true;
        } else if (action === 'the current month is part paid' && hasCurrent()) {
          c.buildings = [building(world())];
          Contract.payTerm(c, String(currentTerm()), cash(50));
          paidCurrentOnItsOwn = true;
        } else if (action === 'the payments of the current month are removed' && hasCurrent()) {
          c.buildings = [building(world())];
          Contract.payTerm(c, String(currentTerm()), { payments: [] });
          paidCurrentOnItsOwn = true;
        } else if (
          action === 'an older month is paid in full' ||
          action === 'the payments of an older month are removed'
        ) {
          const older = c.rents.filter((r) => r.term < currentTerm());
          if (older.length) {
            const month = pick(older).term;
            c.buildings = [building(world())];
            Contract.payTerm(
              c,
              String(month),
              action.startsWith('an older') ? cash(total(c, month)) : { payments: [] }
            );
            said = `${action} (${month})`;
            paidAnOlderMonth = true;
            reached.older += 1;
          }
        } else if (action === 'an exit date is recorded') {
          const unit = pick(unitIds);
          const month = pick([SEP, OCT, NOV, DEC]);
          st.windows[unit].exit = lastDayOf(month).toISOString().slice(0, 10);
          if (st.windows[unit].exit < st.windows[unit].entry) {
            st.windows[unit].exit = lease0.windows[unit].exit;
          }
          said = `the exit date of ${unit} is recorded: ${st.windows[unit].exit}`;
          datesTouched.add(unit);
          reached.windows += 1;
        } else if (action === 'an entry date is recorded') {
          const unit = pick(unitIds);
          st.windows[unit].entry = pick(['2026-08-01', '2026-09-01', '2026-10-01']);
          if (st.windows[unit].exit < st.windows[unit].entry) {
            st.windows[unit].entry = lease0.windows[unit].entry;
          }
          said = `the entry date of ${unit} is recorded: ${st.windows[unit].entry}`;
          datesTouched.add(unit);
          reached.windows += 1;
        } else if (action === 'the dates of the units are put back') {
          st.windows = JSON.parse(JSON.stringify(lease0.windows));
        } else if (action === 'the begin date moves later') {
          st.begin = '2026-09-01';
        } else if (action === 'the begin date moves back') {
          st.begin = '2026-07-01';
        } else if (action === 'the lease is terminated') {
          st.termination = lastDayOf(currentTerm()).toISOString().slice(0, 10);
        } else if (action === 'the termination is removed') {
          st.termination = null;
        } else if (action === 'a month goes by' && today < clock.length - 1) {
          today += 1;
          at(`${clock[today]}T12:00:00Z`);
        }
        trail.push(said);
        count();
        const where = `history ${n}: ${trail.join(' → ')}`;

        // a payment on the current month saved on its own (no recompute yet) already
        // leaves every carried share where the recompute puts it
        const afterPayment = paidCurrentOnItsOwn ? carriedLines(c) : null;
        const wholeAfterPayment = paidCurrentOnItsOwn ? wholeLedger(c) : null;
        if (paidCurrentOnItsOwn) check(c, `${where} [before the recompute]`);
        const kept = JSON.stringify(st);
        try {
          c = recomputeNow(c);
          if (withDates && JSON.stringify(st) !== JSON.stringify(lease0)) reached.dates += 1;
        } catch (e) {
          // the app refuses to drop a month that holds a payment (or to end a lease
          // before its begin): the edit is not made
          if (!/payments will be lost|termination date|duration/.test(String(e.message))) {
            throw new Error(`${where}: ${e.message}`);
          }
          st.begin = c.begin && new Date(c.begin).toISOString().slice(0, 10);
          st.termination = c.termination
            ? new Date(c.termination).toISOString().slice(0, 10)
            : null;
          trail.push(`(refused: ${String(e.message).split('\n')[0]}; was ${kept})`);
          c = recomputeNow(c);
        }
        // D-11 (open, decided, the next change): something on an OLDER month — a
        // payment there, or months before it built again by a begin date moved back —
        // changes what the paid current month carries in and can re-open it. The
        // shares that were waiting for an open month are put right by the NEXT
        // recompute, not by this one: the checks below look at the ledger after it.
        const currentAfter = c.rents.find((r) => r.term === currentTerm());
        if (
          !paidCurrentOnItsOwn &&
          !!currentBefore &&
          currentBefore.term === currentTerm() &&
          isClosed(currentBefore) &&
          !!currentAfter &&
          !isClosed(currentAfter)
        ) {
          c = recomputeNow(c);
          reached.reopenedFromBehind += 1;
        }
        if (paidCurrentOnItsOwn) {
          expect([where, carriedLines(c)]).toEqual([where, afterPayment]);
          // …and not only the carried shares: every month's lines and totals are
          // already what the recompute makes them. (So pricing the months once more
          // after such a payment changes WHEN the ledger is right, not what it says.)
          if (asItAlwaysWas) {
            reached.asItAlwaysWas += 1;
          } else {
            reached.wholeLedger += 1;
            expect([where, wholeLedger(c)]).toEqual([where, wholeAfterPayment]);
          }
        }

        // a month that was closed after the step before, and is still closed, holds
        // the lines it held. One known exception (DEFERRED_DECISIONS D-11, open, the
        // owner has decided it): a payment on an OLDER month changes what the paid
        // current month carries in, which can re-open it — it is then priced again,
        // and can end up paid, with other lines. The share is billed once all the same
        // (the counts below hold); the month is left out of this one comparison.
        c.rents.forEach((r) => {
          const was = closedBefore.get(r.term);
          if (paidAnOlderMonth && r.term === currentTerm()) return;
          if (was !== undefined && isClosed(r)) {
            expect([where, r.term, JSON.stringify(r.buildingCharges)]).toEqual([
              where,
              r.term,
              was
            ]);
          }
        });
        closedBefore.clear();
        c.rents
          .filter(isClosed)
          .forEach((r) =>
            closedBefore.set(r.term, JSON.stringify(r.buildingCharges))
          );
        check(c, where);
        if (carriedLines(c) !== '[]') reached.carried += 1;
        if (withNamesake && carriedLines(c) !== '[]') reached.namesakes += 1;
        if (sameAmounts && twoUnits) reached.sameAmounts += 1;
        if (heldInTurn) reached.heldInTurn += 1;
        if (dense) reached.dense += 1;
        if (
          c.rents.some((r) =>
            (r.buildingCharges || []).some(
              (l) =>
                l.propertyId &&
                !rows[l.propertyId].some(
                  (row) =>
                    row.lineage === lineageOf(l.expenseId) &&
                    row.term === (l.forTerm ?? r.term)
                )
            )
          )
        ) {
          reached.outlived += 1;
        }
      }
    }
    // the generator really gets there
    expect(
      Object.entries(reached).filter(
        ([what, times]) =>
          ![
            'asItAlwaysWas',
            'leftInDoubt',
            'stoodIn',
            'datesTouched',
            'reopenedFromBehind'
          ].includes(what) &&
          times < 100
      )
    ).toEqual([]);
    // (a paid month re-opened with no carrying in play: rare here, and left alone)
    expect(reached.asItAlwaysWas).toBeGreaterThan(0);
    // (a share left unbilled because an old line could be for it: it happens, and it
    // is rare even here, where everything is arranged to make it happen)
    expect(reached.leftInDoubt).toBeGreaterThan(0);
    expect(reached.leftInDoubt).toBeLessThan(reached.mustBeBilled / 10);
    expect(reached.carried).toBeGreaterThan(1000);
  });
});
