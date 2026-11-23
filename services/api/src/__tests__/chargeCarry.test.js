// The pieces around the rent engine for a share of a building charge whose own month is
// closed for the tenant (DEFERRED_DECISIONS D-10; the engine itself is pinned in
// businesslogic/__tests__/building-charge-carried.test.js):
//   · what the statement save notes on the rows it rebuilds;
//   · reading a tenant's ledger back, to report what is really on it.
// Plain functions, no database.
import { jest } from '@jest/globals';
import * as Contract from '../managers/contract.js';
import {
  chargesWithStoredMarks,
  unitRowsProblem,
  markedRowProblem,
  markedRowsProblem,
  heldUnitIn,
  placeTenantShares,
  shareOutcomes,
  sharesMovedInto,
  statementRowIdentity,
  statementRowsBefore
} from '../managers/chargecarry.js';
import { computeBuildingExpenseBreakdown } from '../businesslogic/tasks/1_base.js';

const term = (yyyymm) => Number(`${yyyymm}0100`);
const SEP = term(202609);
const OCT = term(202610);
const NOV = term(202611);
const DEC = term(202612);

const at = (iso) => jest.useFakeTimers().setSystemTime(new Date(iso));
afterEach(() => jest.useRealTimers());

// The mark must SURVIVE A SAVE. The building schema is strict: a field it does not
// declare is dropped without a word when the document is saved, and every plain-object
// test in this file would stay green while nothing was ever carried. (Watched on the
// local stack on 2026-11-23: the api was running a build of the shared library from
// before the field existed; the statement save «marked» its rows and stored none of it.)
// This reads the REAL schema the api loads — @microrealestate/common, as built.
describe('the mark on a building row, through the real schema', () => {
  let Building;
  beforeAll(async () => {
    ({
      Collections: { Building }
    } = await import('@microrealestate/common'));
  });
  const stored = (rows) =>
    new Building({
      realmId: 'r',
      name: 'Building 1',
      units: [{ atakNumber: '01234567890', monthlyCharges: rows }]
    }).toObject().units[0].monthlyCharges;

  it('a marked row is stored marked', () => {
    const [row] = stored([
      { term: OCT, amount: 30, description: 'x', expenseId: 'e', carry: true }
    ]);
    expect(row.carry).toBe(true);
  });

  it('a row that is not marked gets no mark by default', () => {
    const [row] = stored([
      { term: OCT, amount: 30, description: 'x', expenseId: 'e' }
    ]);
    expect(row.carry).toBeUndefined();
    expect('carry' in row).toBe(false);
  });

  it('a row keeps the id it is given (a rebuilt share keeps its own)', () => {
    const [first] = stored([{ term: OCT, amount: 30, expenseId: 'e' }]);
    const [again] = stored([
      { _id: first._id, term: OCT, amount: 35, expenseId: 'e', carry: true }
    ]);
    expect(String(again._id)).toBe(String(first._id));
  });
});

describe('what a rebuilt statement row keeps', () => {
  const before = () =>
    statementRowsBefore([
      { _id: 'r1', expenseId: 'power', carry: true },
      { _id: 'r2', expenseId: 'water' },
      { _id: 'r3', expenseId: 'power', carry: false },
      { _id: 'r4', expenseId: null },
      { _id: 'r5', expenseId: 'heating', carry: 'true' },
      null
    ]);

  it('one entry per expense, the first row of it, with its id and its mark', () => {
    expect([...before().entries()]).toEqual([
      ['power', { _id: 'r1', carry: true }],
      ['water', { _id: 'r2', carry: false }],
      ['heating', { _id: 'r5', carry: false }]
    ]);
    expect([...statementRowsBefore(undefined).entries()]).toEqual([]);
  });

  it('a share that was marked stays marked and keeps its id', () => {
    expect(statementRowIdentity(before(), 'power')).toEqual({
      _id: 'r1',
      carry: true
    });
  });

  it('a share from before the mark existed keeps its id and does NOT gain the mark', () => {
    const identity = statementRowIdentity(before(), 'water');
    expect(identity).toEqual({ _id: 'r2' });
    expect('carry' in identity).toBe(false);
  });

  it('a share that did not exist before this save is marked', () => {
    expect(statementRowIdentity(before(), 'elevator')).toEqual({ carry: true });
    expect(statementRowIdentity(new Map(), 'power')).toEqual({ carry: true });
    // …and a row of NO expense is not a share of one: it is never marked
    expect(statementRowIdentity(before(), undefined)).toEqual({});
    expect(statementRowIdentity(new Map(), null)).toEqual({});
    expect(statementRowIdentity(new Map(), '')).toEqual({});
  });

  it('each previous row is handed out once', () => {
    const rows = before();
    expect(statementRowIdentity(rows, 'power')).toEqual({
      _id: 'r1',
      carry: true
    });
    // a second row for the same expense in the same save is a new share
    expect(statementRowIdentity(rows, 'power')).toEqual({ carry: true });
  });

  it('a previous row without an id gives none', () => {
    const rows = statementRowsBefore([{ expenseId: 'power', carry: true }]);
    expect(statementRowIdentity(rows, 'power')).toEqual({ carry: true });
  });
});

// The unit endpoints take a unit's rows from the request as they are. The mark is not
// theirs to give: it would bill an old share out of the blue, or drop one that waits.
describe('rows that come from a client keep the mark the stored row has, and get no other', () => {
  const stored = [
    { _id: 'r1', term: OCT, amount: 30, expenseId: 'power', carry: true },
    { _id: 'r2', term: OCT, amount: 20, expenseId: 'water' },
    { _id: 'r3', term: SEP, amount: 10, expenseId: 'power', carry: true }
  ];

  it('a mark the client adds to a row that has none is dropped', () => {
    expect(
      chargesWithStoredMarks(
        [{ _id: 'r2', term: OCT, amount: 20, expenseId: 'water', carry: true }],
        stored
      )
    ).toEqual([{ _id: 'r2', term: OCT, amount: 20, expenseId: 'water' }]);
  });

  it.each([
    ['true', true],
    ['the text «true»', 'true'],
    ['1', 1],
    ['an object', { $ne: null }]
  ])('…whatever it is written as: %s', (_what, carry) => {
    expect(
      chargesWithStoredMarks(
        [{ _id: 'r2', term: OCT, amount: 20, expenseId: 'water', carry }],
        stored
      )
    ).toEqual([{ _id: 'r2', term: OCT, amount: 20, expenseId: 'water' }]);
  });

  it('a mark the client leaves out, or sets to false, stays on the row that has it', () => {
    expect(
      chargesWithStoredMarks(
        [
          { _id: 'r1', term: OCT, amount: 30, expenseId: 'power' },
          { _id: 'r3', term: SEP, amount: 10, expenseId: 'power', carry: false }
        ],
        stored
      )
    ).toEqual([
      { _id: 'r1', term: OCT, amount: 30, expenseId: 'power', carry: true },
      { _id: 'r3', term: SEP, amount: 10, expenseId: 'power', carry: true }
    ]);
  });

  it('a row that is not stored never has it', () => {
    expect(
      chargesWithStoredMarks(
        [
          { term: OCT, amount: 5, expenseId: 'power', carry: true },
          { _id: 'new', term: OCT, amount: 5, expenseId: 'power', carry: true }
        ],
        stored
      )
    ).toEqual([
      { term: OCT, amount: 5, expenseId: 'power' },
      { _id: 'new', term: OCT, amount: 5, expenseId: 'power' }
    ]);
    // a unit that is being created has no stored rows at all
    expect(
      chargesWithStoredMarks([{ term: OCT, amount: 5, carry: true }], [])
    ).toEqual([{ term: OCT, amount: 5 }]);
    expect(
      chargesWithStoredMarks([{ term: OCT, amount: 5, carry: true }], undefined)
    ).toEqual([{ term: OCT, amount: 5 }]);
  });

  it('the id of a marked row on another share does not carry the mark over', () => {
    // r1 is October's power. The same id on another month, or another expense, is
    // not that share.
    expect(
      chargesWithStoredMarks(
        [
          { _id: 'r1', term: SEP, amount: 30, expenseId: 'power', carry: true },
          { _id: 'r1', term: OCT, amount: 30, expenseId: 'water', carry: true }
        ],
        stored
      )
    ).toEqual([
      { _id: 'r1', term: SEP, amount: 30, expenseId: 'power' },
      { _id: 'r1', term: OCT, amount: 30, expenseId: 'water' }
    ]);
  });

  it('one stored mark, one row: the same id sent twice does not make a second marked share', () => {
    expect(
      chargesWithStoredMarks(
        [
          { _id: 'r1', term: OCT, amount: 30, expenseId: 'power' },
          { _id: 'r1', term: OCT, amount: 20, expenseId: 'power', carry: true },
          { _id: 'r1', term: OCT, amount: 5, expenseId: 'power' }
        ],
        stored
      )
    ).toEqual([
      { _id: 'r1', term: OCT, amount: 30, expenseId: 'power', carry: true },
      { _id: 'r1', term: OCT, amount: 20, expenseId: 'power' },
      { _id: 'r1', term: OCT, amount: 5, expenseId: 'power' }
    ]);
    // …and `stored` is not what is consumed: the next request finds the mark again
    expect(
      chargesWithStoredMarks(
        [{ _id: 'r1', term: OCT, amount: 30, expenseId: 'power' }],
        stored
      )
    ).toEqual([
      { _id: 'r1', term: OCT, amount: 30, expenseId: 'power', carry: true }
    ]);
  });

  it('…and an id is the same id in upper case (the database reads it so): the mark stays', () => {
    expect(
      chargesWithStoredMarks(
        [{ _id: 'R1', term: OCT, amount: 30, expenseId: 'power', carry: false }],
        stored
      )
    ).toEqual([
      { _id: 'R1', term: OCT, amount: 30, expenseId: 'power', carry: true }
    ]);
  });

  it('ids are compared as text: a stored ObjectId and the text a client sends are the same id', () => {
    const id = { toString: () => '507f1f77bcf86cd799439011' };
    expect(
      chargesWithStoredMarks(
        [{ _id: '507f1f77bcf86cd799439011', term: OCT, expenseId: 'power' }],
        [{ _id: id, term: OCT, expenseId: 'power', carry: true }]
      )
    ).toEqual([
      {
        _id: '507f1f77bcf86cd799439011',
        term: OCT,
        expenseId: 'power',
        carry: true
      }
    ]);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a text', 'rows'],
    ['an object', { 0: { carry: true } }]
  ])('rows that are %s are handed back as they came', (_what, incoming) => {
    expect(chargesWithStoredMarks(incoming, stored)).toBe(incoming);
  });

  it('entries that are not rows are handed back as they came, and nothing sent is changed', () => {
    const sent = [null, 5, 'x', [], { _id: 'r2', carry: true }];
    const copy = JSON.stringify(sent);
    expect(chargesWithStoredMarks(sent, stored)).toEqual([
      null,
      5,
      'x',
      [],
      { _id: 'r2' }
    ]);
    expect(JSON.stringify(sent)).toBe(copy);
  });
});

describe('who held a unit in a month', () => {
  const tenant = {
    properties: [
      {
        propertyId: 'A',
        entryDate: new Date('2026-07-01T00:00:00Z'),
        exitDate: new Date('2026-11-15T23:59:59Z')
      }
    ]
  };
  it.each([
    ['the first month', term(202607), true],
    ['a month in between', OCT, true],
    ['the month they left, part of it', NOV, true],
    ['the month after', DEC, false],
    ['the month before', term(202606), false]
  ])('%s', (_what, month, held) => {
    expect(heldUnitIn(tenant, 'A', month)).toBe(held);
  });
  it('another unit, no units, a month that is no month', () => {
    expect(heldUnitIn(tenant, 'B', OCT)).toBe(false);
    expect(heldUnitIn({}, 'A', OCT)).toBe(false);
    expect(heldUnitIn(undefined, 'A', OCT)).toBe(false);
    expect(heldUnitIn(tenant, 'A', 'October')).toBe(false);
  });
});

// Which line of a ledger stands for which share is decided in businesslogic/
// carriedshares.ts (its own tests: businesslogic/__tests__/carried-shares-cover.test.js).
// Here: what the ANSWER makes of it, on ledgers written by hand so that every shape a
// stored ledger can have is there — including the ones the engine no longer writes.
describe('where a ledger holds a share', () => {
  const line = (extra) => ({
    description: 'Common power',
    amount: 30,
    buildingName: 'Building 1',
    type: 'electricity_common',
    ...extra
  });
  const share = {
    propertyId: 'A',
    expenseId: 'power',
    term: OCT,
    description: 'Common power',
    buildingName: 'Building 1'
  };
  const ledger = (byMonth) =>
    [SEP, OCT, NOV, DEC].map((month) => ({
      term: month,
      buildingCharges: byMonth[month] || []
    }));
  const holds = (ids) =>
    ids.map((propertyId) => ({
      propertyId,
      entryDate: new Date('2026-07-01T00:00:00Z'),
      exitDate: new Date('2027-06-30T23:59:59Z')
    }));
  // The answer for one share (unit A's unless told otherwise) of a tenant who holds A
  // and B. `amount` 99 unless given: no line has it, so nothing is recognised by its
  // amount by accident. `others` = the other rows of the month, per unit.
  const where = (rents, s, others = {}) => {
    const row = (propertyId, r, i) => ({
      _id: `row-${propertyId}-${i}`,
      term: r.term ?? s.term,
      amount: r.amount ?? 99,
      description: r.description ?? s.description,
      expenseId: r.expenseId ?? s.expenseId,
      carry: r.carry === undefined ? true : r.carry
    });
    const found = shareOutcomes({
      term: s.term,
      currentTerm: NOV,
      buildingName: s.buildingName,
      units: ['A', 'B'].map((propertyId) => ({
        propertyId,
        rows: [
          ...(propertyId === s.propertyId ? [row(propertyId, s, 0)] : []),
          ...(others[propertyId] || []).map((r, i) => row(propertyId, r, i + 1))
        ]
      })),
      expenseIds: ['power', 'water'],
      // both are typed in every month: neither is billed live
      billedLiveNames: [],
      tenants: [
        {
          _id: 't',
          name: 'T',
          frequency: 'months',
          properties: holds(['A', 'B']),
          rents
        }
      ]
    });
    const mine = found.find(
      (o) => o.propertyId === s.propertyId && o.expenseId === s.expenseId
    );
    return mine && mine.billedTerm !== null
      ? {
          term: mine.billedTerm,
          amount: mine.billedAmount,
          moved: mine.status === 'moved'
        }
      : null;
  };

  it('on its own month', () => {
    expect(
      where(
        ledger({ [OCT]: [line({ propertyId: 'A', expenseId: 'power' })] }),
        share
      )
    ).toEqual({ term: OCT, amount: 30, moved: false });
  });

  it('on a later month, as a line that is for its month', () => {
    expect(
      where(
        ledger({
          [NOV]: [
            // November's own share of the same expense comes first and is not it
            line({ propertyId: 'A', expenseId: 'power', amount: 20 }),
            line({ propertyId: 'A', expenseId: 'power', forTerm: OCT })
          ]
        }),
        share
      )
    ).toEqual({ term: NOV, amount: 30, moved: true });
  });

  it('on the tenant’s other unit, when that unit has no row of its own for it', () => {
    // a split per tenant puts the one share of a tenant with two units on one of
    // them; run again, it can sit on the other
    expect(
      where(
        ledger({ [OCT]: [line({ propertyId: 'B', expenseId: 'power' })] }),
        share
      )
    ).toEqual({ term: OCT, amount: 30, moved: false });
  });

  it('NOT on the other unit’s line when that unit has a row of its own: that line is that row’s', () => {
    // A's share was never billed (a row from before shares were carried); B's is on
    // November. The answer used to say A's was «charged», with B's amount.
    const rents = ledger({
      [NOV]: [line({ propertyId: 'B', expenseId: 'power', forTerm: OCT })]
    });
    expect(
      where(rents, { ...share, carry: false, amount: 20 }, { B: [{ amount: 30 }] })
    ).toBe(null);
    // …and B's own answer is the line
    expect(
      where(rents, { ...share, propertyId: 'B', amount: 30 }, {
        A: [{ amount: 20, carry: false }]
      })
    ).toEqual({ term: NOV, amount: 30, moved: true });
  });

  it('one line is one share: it is not reported for two rows', () => {
    // one line on the other unit, which has no row; A has rows of two expenses that
    // read the same — only one of them can be what that line was
    const rents = ledger({
      [OCT]: [line({ propertyId: 'B', expenseId: 'power' })]
    });
    const both = shareOutcomes({
      term: OCT,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: [
        {
          propertyId: 'A',
          rows: [
            { _id: 'r1', term: OCT, amount: 30, description: 'Common power', expenseId: 'power', carry: true },
            { _id: 'r2', term: OCT, amount: 30, description: 'Common power', expenseId: 'power', carry: true }
          ]
        },
        { propertyId: 'B', rows: [] }
      ],
      expenseIds: ['power'],
      billedLiveNames: [],
      tenants: [
        { _id: 't', name: 'T', frequency: 'months', properties: holds(['A', 'B']), rents }
      ]
    });
    expect(both.map((o) => o.status)).toEqual(['billed', 'missing']);
  });

  it('a line for this unit is preferred to one for another', () => {
    expect(
      where(
        ledger({
          [OCT]: [line({ propertyId: 'B', expenseId: 'power', amount: 20 })],
          [DEC]: [line({ propertyId: 'A', expenseId: 'power', forTerm: OCT })]
        }),
        share
      )
    ).toEqual({ term: DEC, amount: 30, moved: true });
  });

  it('a line stored before lines carried ids, on the share’s own month, by its name', () => {
    expect(where(ledger({ [OCT]: [line({})] }), share)).toEqual({
      term: OCT,
      amount: 30,
      moved: false
    });
    // …not on another month, not under another name, not of another building
    expect(where(ledger({ [NOV]: [line({})] }), share)).toBe(null);
    expect(
      where(ledger({ [OCT]: [line({ description: 'Water' })] }), share)
    ).toBe(null);
    expect(
      where(ledger({ [OCT]: [line({ buildingName: 'Building 2' })] }), share)
    ).toBe(null);
  });

  it('a line of an expense that was deleted since, by its name (the expense came back under another id)', () => {
    expect(
      where(
        ledger({ [OCT]: [line({ propertyId: 'A', expenseId: 'power-before' })] }),
        share
      )
    ).toEqual({ term: OCT, amount: 30, moved: false });
    // …but a line of an expense that still exists is that expense's, whatever it reads
    expect(
      where(
        ledger({ [OCT]: [line({ propertyId: 'A', expenseId: 'water' })] }),
        share
      )
    ).toBe(null);
  });

  it('a line stored before lines carried ids, renamed since: recognised by its exact amount', () => {
    // the expense was called «Stairwell lights» when October was billed
    const renamed = ledger({
      [OCT]: [line({ description: 'Stairwell lights' })]
    });
    expect(where(renamed, share)).toBe(null);
    expect(where(renamed, { ...share, amount: 30 })).toEqual({
      term: OCT,
      amount: 30,
      moved: false
    });
    // …another amount is another line; a repair of that amount is not it; and an
    // amount of nothing recognises nothing
    expect(where(renamed, { ...share, amount: 31 })).toBe(null);
    expect(
      where(
        ledger({
          [OCT]: [line({ description: 'Roof', type: 'repair' })]
        }),
        { ...share, amount: 30 }
      )
    ).toBe(null);
    expect(
      where(ledger({ [OCT]: [line({ description: 'X', amount: 0 })] }), {
        ...share,
        amount: 0
      })
    ).toBe(null);
    // …and only on the share's own month
    expect(
      where(ledger({ [NOV]: [line({ description: 'Stairwell lights' })] }), {
        ...share,
        amount: 30
      })
    ).toBe(null);
    // …and only a line that names no expense: one of another expense that exists is
    // that expense's, whatever its amount
    expect(
      where(
        ledger({ [OCT]: [line({ propertyId: 'A', expenseId: 'water' })] }),
        { ...share, amount: 30 }
      )
    ).toBe(null);
    // …and once: two renamed shares of 30 and ONE old line of 30
    const two = shareOutcomes({
      term: OCT,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: [
        {
          propertyId: 'A',
          rows: [
            { _id: 'r1', term: OCT, amount: 30, description: 'Common power', expenseId: 'power' },
            { _id: 'r2', term: OCT, amount: 30, description: 'Water', expenseId: 'water' }
          ]
        }
      ],
      expenseIds: ['power', 'water'],
      billedLiveNames: [],
      tenants: [
        { _id: 't', name: 'T', frequency: 'months', properties: holds(['A']), rents: renamed }
      ]
    });
    expect(two.map((o) => o.status)).toEqual(['billed', 'notCharged']);
  });

  it('another expense, another month, a repair, or nothing: nowhere', () => {
    expect(
      where(
        ledger({
          [OCT]: [
            line({ propertyId: 'A', expenseId: 'water' }),
            line({ propertyId: 'A', repairId: 'repair-1' })
          ],
          [NOV]: [
            line({ propertyId: 'A', expenseId: 'power' }),
            line({ propertyId: 'A', expenseId: 'power', forTerm: SEP })
          ]
        }),
        share
      )
    ).toBe(null);
    expect(where([{ term: OCT, buildingCharges: [] }], share)).toBe(null);
  });

  it.each([
    [
      'months with no lines',
      [{ term: OCT }, { term: NOV, buildingCharges: null }]
    ],
    [
      'lines that are not lines',
      [{ term: OCT, buildingCharges: [null, 5, 'x', []] }]
    ]
  ])('%s: nowhere, and nothing breaks', (_what, rents) => {
    expect(where(rents, share)).toBe(null);
  });

  it.each([
    ['no ledger', undefined],
    ['a ledger that is a text', 'rents'],
    ['an empty ledger', []]
  ])('%s: the tenant was not billed for that month at all and is left out', (_what, rents) => {
    expect(where(rents, share)).toBe(null);
  });

  it('a line that names a unit of ANOTHER building is not this building’s, whatever it reads', () => {
    // The tenant also rents unit X in a second building that has the same name and an
    // expense of the same name; X's October share is on October. Seen from this
    // building that expense «does not exist» — and the line was taken for one of a
    // deleted expense and matched to A's row by name: A's lost share read «charged».
    const rents = ledger({
      [OCT]: [line({ propertyId: 'X', expenseId: 'power-of-the-other' })]
    });
    expect(where(rents, { ...share, carry: false, amount: 20 })).toBe(null);
    // …also when nothing else tells the two apart: the tenant's lease lists X (it is
    // the tenant's unit, in the other building) and both shares are 30
    const seenFromThisBuilding = shareOutcomes({
      term: OCT,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: [
        {
          propertyId: 'A',
          rows: [
            { _id: 'a', term: OCT, amount: 30, description: 'Common power', expenseId: 'power' }
          ]
        }
      ],
      expenseIds: ['power'],
      billedLiveNames: [],
      tenants: [
        { _id: 't', name: 'T', frequency: 'months', properties: holds(['A', 'X']), rents }
      ]
    });
    expect(
      seenFromThisBuilding.map((o) => [o.propertyId, o.status, o.billedTerm])
    ).toEqual([['A', 'notCharged', null]]);
    // the same line naming a unit of this building IS a deleted expense's: by name
    expect(
      where(
        ledger({
          [OCT]: [line({ propertyId: 'A', expenseId: 'power-before' })]
        }),
        { ...share, carry: false, amount: 20 }
      )
    ).toEqual({ term: OCT, amount: 30, moved: false });
  });

  it('a rent whose month is stored as text still holds its lines', () => {
    // a restored or hand-written ledger; the engine leaves such a rent alone, but a
    // share that IS on it must not be called «missing»
    const rents = ledger({});
    rents.find((r) => r.term === NOV).buildingCharges = [
      line({ propertyId: 'A', expenseId: 'power', forTerm: OCT })
    ];
    rents.find((r) => r.term === NOV).term = String(NOV);
    expect(where(rents, share)).toEqual({ term: NOV, amount: 30, moved: true });
  });

  it('a unit the tenant has but did not hold that month: its row is asked about, and not reported', () => {
    // A's exit date was recorded (30/09) after October was billed with A's share.
    // A's October line is A's row's — it must not stand in for B's new share.
    const found = shareOutcomes({
      term: OCT,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: [
        { propertyId: 'A', rows: [{ _id: 'a', term: OCT, amount: 30, description: 'Common power', expenseId: 'power' }] },
        { propertyId: 'B', rows: [{ _id: 'b', term: OCT, amount: 20, description: 'Common power', expenseId: 'power', carry: true }] }
      ],
      expenseIds: ['power'],
      billedLiveNames: [],
      tenants: [
        {
          _id: 't',
          name: 'T',
          frequency: 'months',
          properties: [
            { propertyId: 'A', entryDate: new Date('2026-07-01T00:00:00Z'), exitDate: new Date('2026-09-30T23:59:59Z') },
            ...holds(['B'])
          ],
          rents: ledger({ [OCT]: [line({ propertyId: 'A', expenseId: 'power' })] })
        }
      ]
    });
    expect(found.map((o) => [o.propertyId, o.status, o.billedTerm])).toEqual([
      ['B', 'missing', null]
    ]);
  });

  it('a unit that was taken off the tenant’s lease: its line does not stand in', () => {
    const found = shareOutcomes({
      term: OCT,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: [
        { propertyId: 'A', rows: [] },
        { propertyId: 'B', rows: [{ _id: 'b', term: OCT, amount: 20, description: 'Common power', expenseId: 'power', carry: true }] }
      ],
      expenseIds: ['power'],
      billedLiveNames: [],
      tenants: [
        {
          _id: 't',
          name: 'T',
          frequency: 'months',
          properties: holds(['B']),
          rents: ledger({ [OCT]: [line({ propertyId: 'A', expenseId: 'power' })] })
        }
      ]
    });
    expect(found.map((o) => [o.propertyId, o.status])).toEqual([['B', 'missing']]);
  });

  it('the tenant moved from A to B: an old line of October is shown against B, the unit the tenant held then', () => {
    // both rows were typed again and read the same, at the same amount; A's is the
    // older. Nothing is billed again either way — but the page should not say that
    // the share of the unit the tenant had left was the one charged.
    const moved = [
      {
        propertyId: 'A',
        entryDate: new Date('2026-07-01T00:00:00Z'),
        exitDate: new Date('2026-09-30T23:59:59Z')
      },
      {
        propertyId: 'B',
        entryDate: new Date('2026-10-01T00:00:00Z'),
        exitDate: new Date('2027-06-30T23:59:59Z')
      }
    ];
    const typedAgain = (id) => ({
      _id: id,
      term: OCT,
      amount: 30,
      description: 'Common power',
      expenseId: 'power',
      carry: true
    });
    const found = shareOutcomes({
      term: OCT,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: [
        { propertyId: 'A', rows: [typedAgain('a')] },
        { propertyId: 'B', rows: [typedAgain('b')] }
      ],
      expenseIds: ['power'],
      billedLiveNames: [],
      tenants: [
        {
          _id: 't',
          name: 'T',
          frequency: 'months',
          properties: moved,
          rents: ledger({ [OCT]: [line()] })
        }
      ]
    });
    expect(
      found.map((o) => [o.propertyId, o.status, o.billedTerm, o.billedAmount])
    ).toEqual([['B', 'billed', OCT, 30]]);
  });

  // On top of `coverRows`, and for reporting only, an old line that no row has taken
  // is recognised by its exact amount: what is left of a share after its expense, or
  // the building, was renamed. It must not be a line that is simply somebody else's.
  describe('an old line recognised by its amount: only one that was renamed since', () => {
    // October's power share of 15 was typed in after October closed: it is on no rent.
    // B is the tenant's other unit of the building; it has no row for October.
    const units = [
      {
        propertyId: 'A',
        rows: [{ _id: 'a', term: OCT, amount: 15, description: 'Common power', expenseId: 'power' }]
      },
      { propertyId: 'B', rows: [] }
    ];
    const answer = (octoberLines, more = {}) =>
      shareOutcomes({
        term: OCT,
        currentTerm: NOV,
        buildingName: 'Building 1',
        units,
        expenseIds: ['power', 'cleaning'],
        // «Cleaning» has an amount of its own: the engine bills it live every month
        billedLiveNames: ['Cleaning'],
        tenants: [
          {
            _id: 't',
            name: 'T',
            frequency: 'months',
            properties: holds(['A', 'B']),
            rents: ledger({ [OCT]: octoberLines })
          }
        ],
        ...more
      }).map((o) => [o.status, o.billedTerm, o.billedAmount, o.reason]);
    const notCharged = [['notCharged', null, null, 'notCarried']];
    const charged = [['billed', OCT, 15, undefined]];

    it('not the line of an expense that is billed LIVE that month, which happens to be the same amount', () => {
      // «Cleaning» is a fixed expense: it is billed live and has no row to take its
      // line. Its 15 was taken for the power share's, and the page dropped its
      // «δεν χρεώθηκε» (found by review — one unit and today's ledgers are enough).
      expect(
        answer([line({ description: 'Cleaning', amount: 15, type: 'cleaning' })])
      ).toEqual(notCharged);
    });

    it('not a line that names a unit: it was written after lines carried ids', () => {
      // a manual charge of the tenant's other unit, «Keys 15»
      expect(
        answer([{ description: 'Keys', amount: 15, buildingName: 'Building 1', propertyId: 'B' }])
      ).toEqual(notCharged);
      // (without the unit on it, the same line would be taken: that is what is pinned)
      expect(
        answer([{ description: 'Keys', amount: 15, buildingName: 'Building 1' }])
      ).toEqual(charged);
    });

    it('a line under a name the building no longer has: the expense was renamed (or deleted) since', () => {
      expect(
        answer([line({ description: 'Electricity of the stairs', amount: 15 })])
      ).toEqual(charged);
    });

    it('a line under the expense’s own name and ANOTHER building name: the building was renamed since', () => {
      expect(answer([line({ buildingName: 'The old name', amount: 15 })])).toEqual(
        charged
      );
    });

    it('…but the line of an expense billed live stays that expense’s own under the building’s OLD name too', () => {
      // after a building is renamed, EVERY old line of its fixed expenses is under the
      // old name: none of them is a share's
      expect(
        answer([
          line({ description: 'Cleaning', buildingName: 'The old name', amount: 15 })
        ])
      ).toEqual(notCharged);
    });

    it('…also when the share’s OWN name is one that an expense billed live has too: then the old building name tells nothing (a limit, written down)', () => {
      // Two expenses called «Common power», one of them billed live. After the BUILDING
      // is renamed, a line «Common power» under the old name is the live one's own — or
      // the share's, billed before the rename. Nothing in the ledger says which, and
      // the page does not call it charged on a guess.
      expect(
        answer([line({ buildingName: 'The old name', amount: 15 })], {
          billedLiveNames: ['Cleaning', 'Common power']
        })
      ).toEqual(notCharged);
    });

    it('…and a line that names an expense is that expense’s, with or without a unit on it', () => {
      // (a line written after lines carried ids always names its unit as well; one
      // that does not is a ledger edited by hand)
      expect(answer([line({ expenseId: 'cleaning', amount: 15 })])).toEqual(
        notCharged
      );
    });

    // The share WAS billed, as «Common power 15». Its expense is called «Stair lights»
    // now and October was saved again, so the row reads the new name — and ANOTHER
    // expense is called «Common power» today.
    const renamed = [
      {
        propertyId: 'A',
        rows: [{ _id: 'a', term: OCT, amount: 15, description: 'Stair lights', expenseId: 'power' }]
      },
      { propertyId: 'B', rows: [] }
    ];
    const billedAsCommonPower = [line({ description: 'Common power', amount: 15 })];

    it('a line under a name that another expense has TODAY, one that billed nothing live that month: still the renamed share’s', () => {
      // (a variable expense, a new one, one that had ended: none of them is in
      // `billedLiveNames`. Going by every name the building has today, the page said
      // «δεν χρεώθηκε» for a share its rent holds — found by the next review.)
      expect(answer(billedAsCommonPower, { units: renamed })).toEqual(charged);
    });

    it('…while a name that an expense billed LIVE that month has is taken to be that expense’s own line', () => {
      // a limit, written down: nothing in the ledger says which of the two it was
      expect(
        answer(billedAsCommonPower, {
          units: renamed,
          billedLiveNames: ['Cleaning', 'Common power']
        })
      ).toEqual(notCharged);
    });

    it('…and with no word on what is billed live, NO line is recognised by its amount', () => {
      expect(
        answer([line({ description: 'Electricity of the stairs', amount: 15 })], {
          billedLiveNames: undefined
        })
      ).toEqual(notCharged);
      expect(
        answer([line({ description: 'Electricity of the stairs', amount: 15 })], {
          billedLiveNames: []
        })
      ).toEqual(charged);
    });
  });

  describe('a share an old line may be for', () => {
    // October's old line reads «Common power 30». A's row is 30, B's new share is 20:
    // the line could be either's, B's is in doubt.
    const units = [
      {
        propertyId: 'A',
        rows: [{ _id: 'a', term: OCT, amount: 30, description: 'Common power', expenseId: 'power' }]
      },
      {
        propertyId: 'B',
        rows: [{ _id: 'b', term: OCT, amount: 20, description: 'Common power', expenseId: 'power', carry: true }]
      }
    ];
    const answer = (rents, currentTerm = NOV) =>
      shareOutcomes({
        term: OCT,
        currentTerm,
        buildingName: 'Building 1',
        units,
        expenseIds: ['power'],
        billedLiveNames: [],
        tenants: [
          { _id: 't', name: 'T', frequency: 'months', properties: holds(['A', 'B']), rents }
        ]
      }).map((o) => [o.propertyId, o.status, o.billedTerm, o.billedAmount, o.reason]);
    const inDoubt = [
      ['A', 'billed', OCT, 30, undefined],
      ['B', 'notCharged', null, null, 'unclear']
    ];

    it('is «not charged», and says why', () => {
      expect(answer(ledger({ [OCT]: [line()] }))).toEqual(inDoubt);
    });

    it('is not «charged» because an unrelated old line of the month happens to have its amount', () => {
      // «Water 20», whose row has gone, is no proof that B's power share was billed
      // (the pass that recognises an old line by its amount took it: found by review)
      expect(
        answer(
          ledger({
            [OCT]: [
              line(),
              line({ description: 'Water', amount: 20, type: 'water_common' })
            ]
          })
        )
      ).toEqual(inDoubt);
    });

    it('is not «missing» when its month is still open: no recompute has failed', () => {
      expect(answer(ledger({ [OCT]: [line()] }), OCT)).toEqual(inDoubt);
    });

    it('…nor when the rent of its month is stored with the month as text', () => {
      const rents = ledger({ [OCT]: [line()] });
      rents.find((r) => r.term === OCT).term = String(OCT);
      expect(answer(rents)).toEqual(inDoubt);
    });

    it('while a share of an open month that no line could be for IS «missing»', () => {
      expect(answer(ledger({}), OCT)).toEqual([
        ['A', 'missing', null, null, 'recomputeFailed'],
        ['B', 'missing', null, null, 'recomputeFailed']
      ]);
    });
  });

  it('a row of a unit that is NOT the tenant’s is not asked about: the tenant’s old line stays the tenant’s', () => {
    // The engine knows the rows of the tenant's own units and no others. A read-back
    // that also asked about the row of somebody else's unit would give the tenant's
    // old line (no ids) to that row — its amount is the closer one — and call the
    // tenant's own share «not charged» while the engine holds it billed.
    const found = shareOutcomes({
      term: OCT,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: [
        { propertyId: 'C', rows: [{ _id: 'c', term: OCT, amount: 30, description: 'Common power', expenseId: 'power' }] },
        { propertyId: 'A', rows: [{ _id: 'a', term: OCT, amount: 31, description: 'Common power', expenseId: 'power' }] }
      ],
      expenseIds: ['power'],
      billedLiveNames: [],
      tenants: [
        {
          _id: 't',
          name: 'T',
          frequency: 'months',
          properties: holds(['A']),
          rents: ledger({ [OCT]: [line()] })
        }
      ]
    });
    expect(
      found.map((o) => [o.propertyId, o.status, o.billedTerm, o.billedAmount])
    ).toEqual([['A', 'billed', OCT, 30]]);
  });
});

// The schema turns a single row object into a list of one, and `unit.set()` follows a
// path like «monthlyCharges.0.carry»: both reach a row's mark without ever passing
// through `chargesWithStoredMarks`. The unit endpoints refuse them (found by review:
// each of the three saved `carry: true` from such a request).
describe('a unit as a client sends it: its rows are a list, and nothing addresses them by path', () => {
  it.each([
    ['a single row object', { monthlyCharges: { term: OCT, amount: 5, carry: true } }],
    ['a text', { monthlyCharges: 'rows' }],
    ['null', { monthlyCharges: null }],
    ['a number', { monthlyCharges: 5 }]
  ])('rows that are %s are refused', (_what, body) => {
    expect(unitRowsProblem(body)).toBe('monthlyCharges must be a list of rows');
  });

  it.each([
    ['the mark of a row', { 'monthlyCharges.0.carry': true }],
    ['a whole row', { 'monthlyCharges.0': { carry: true } }],
    ['the mark, with the rows sent too', { monthlyCharges: [], 'monthlyCharges.0.carry': 'true' }]
  ])('a path to %s is refused', (_what, body) => {
    expect(unitRowsProblem(body)).toBe(
      'monthlyCharges cannot be addressed by path'
    );
  });

  it.each([
    ['a text among the rows', { monthlyCharges: [{ term: OCT, amount: 5 }, 'row'] }],
    ['null among the rows', { monthlyCharges: [null] }],
    ['a list among the rows', { monthlyCharges: [[{ term: OCT }]] }]
  ])('%s: refused', (_what, body) => {
    expect(unitRowsProblem(body)).toBe('monthlyCharges must be a list of rows');
  });

  // The schema casts `{ _id: X }` back to X: such a row kept its identity, while the
  // mark — looked up under the text «[object Object]» — was taken away (found by
  // review). What names a row must be a plain value.
  const R1 = 'aaaaaaaaaaaaaaaaaaaa40a1';
  const R2 = 'aaaaaaaaaaaaaaaaaaaa40a2';
  it.each([
    ['an _id that is an object', { _id: { _id: R1 }, term: OCT }],
    ['an _id that is a number', { _id: 5, term: OCT }],
    ['an expenseId that is an object', { expenseId: { _id: 'e1' }, term: OCT }],
    ['an expenseId that is a list', { expenseId: ['e1'], term: OCT }],
    ['a repairId that is an object', { repairId: {}, term: OCT }],
    ['a term that is an object', { term: { $gt: 0 } }],
    ['a term that is true', { term: true }]
  ])('a row with %s: refused', (_what, row) => {
    expect(unitRowsProblem({ monthlyCharges: [{ amount: 5 }, row] })).toBe(
      'the _id, expenseId, repairId and term of a monthlyCharges row must be plain values'
    );
  });

  // A row is removed by its id, and removing one of two rows that share it removes
  // both — the other one's share with it (found by review).
  it.each([
    ['the same id', [R1, R1]],
    ['the same id in another case', [R1, R1.toUpperCase()]],
    ['the same id, further down', [R1, R2, R1]]
  ])('two rows with %s: refused', (_what, ids) => {
    expect(
      unitRowsProblem({
        monthlyCharges: ids.map((_id, i) => ({ _id, term: OCT, amount: i }))
      })
    ).toBe('two monthlyCharges rows have the same _id');
  });

  // The schema reads a text of TWELVE characters as an id as well — another id than
  // the text says. Two rows could share an id that way, and a marked row could be sent
  // back under a spelling its mark was not found by (found by review).
  it.each([
    ['twelve characters', 'abcdefghijkl'],
    ['a short text', 'r1'],
    ['24 characters that are not hex', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
    ['an empty text', '']
  ])('a row whose _id is %s: refused', (_what, _id) => {
    expect(unitRowsProblem({ monthlyCharges: [{ _id, term: OCT }] })).toBe(
      'the _id of a monthlyCharges row must be 24 hex characters'
    );
  });

  it.each([
    ['a list of rows', { monthlyCharges: [{ term: OCT, amount: 5 }] }],
    ['rows with ids of their own, and rows with none', {
      monthlyCharges: [
        { _id: R1, term: OCT, expenseId: 'e1', repairId: null },
        { _id: R2.toUpperCase(), term: String(OCT), expenseId: null },
        { term: OCT },
        { term: OCT }
      ]
    }],
    ['an id as the database itself hands it over', {
      monthlyCharges: [{ _id: { toHexString: () => 'abc' }, term: OCT }]
    }],
    ['an empty list', { monthlyCharges: [] }],
    ['no rows at all', { atakNumber: 'AT1', generalThousandths: 100 }],
    ['other fields by path', { 'owners.0.name': 'ΒΗΤΑ', monthlyChargesNote: 'x' }],
    ['nothing', undefined],
    ['a list', [{ monthlyCharges: {} }]],
    ['a text', 'unit']
  ])('%s: nothing to refuse', (_what, body) => {
    expect(unitRowsProblem(body)).toBe(null);
  });
});

// A row that carries the mark is a share of a monthly statement. A request may change
// its amount and nothing that says WHICH share it is: a description changed by hand
// made the row read unlike the old rent line that covered it (it was billed again), and
// a month changed and changed back lost the mark (the share was billed nowhere). Found
// by review, each through the manual-row edit and through the unit endpoint.
describe('a marked row can only change its amount', () => {
  const stored = {
    _id: 'aaaaaaaaaaaaaaaaaaaa40a1',
    term: OCT,
    amount: 30,
    description: 'Common power',
    expenseId: 'power',
    repairId: null,
    carry: true
  };
  const refusal =
    'a share of a monthly statement can only change its amount here: its month, expense and description are changed by saving the monthly statement';

  it.each([
    ['its amount', { amount: 31 }],
    ['its amount, with everything else sent back as it is', { ...stored, amount: 31 }],
    ['the figure it was shared out of', { inputAmount: 80 }],
    ['its month, sent as the same month in text', { term: String(OCT) }],
    ['nothing', {}]
  ])('%s: allowed', (_what, changed) => {
    expect(markedRowProblem(changed, stored)).toBe(null);
  });

  it.each([
    ['its month', { term: SEP }],
    ['its expense', { expenseId: 'water' }],
    ['its expense, to none', { expenseId: null }],
    ['a repair', { repairId: 'r-1' }],
    ['its description', { description: 'Common power (corrected)' }],
    ['its description, to nothing', { description: '' }]
  ])('%s: refused', (_what, changed) => {
    expect(markedRowProblem(changed, stored)).toBe(refusal);
  });

  it('a row that carries no mark may be changed freely', () => {
    const unmarked = { ...stored, carry: undefined };
    expect(
      markedRowProblem({ term: SEP, description: 'x', expenseId: 'water' }, unmarked)
    ).toBe(null);
    expect(markedRowProblem({ term: SEP }, undefined)).toBe(null);
    expect(markedRowProblem({ term: SEP }, { ...stored, carry: 'true' })).toBe(null);
  });

  it('a unit’s rows as a request sends them: each against the stored row with its id', () => {
    const other = { ...stored, _id: 'aaaaaaaaaaaaaaaaaaaa40a2', carry: undefined };
    const rows = [stored, other];
    expect(markedRowsProblem([stored, other], rows)).toBe(null);
    expect(markedRowsProblem([{ ...stored, amount: 99 }], rows)).toBe(null);
    // the id in upper case is the same row
    expect(
      markedRowsProblem(
        [{ ...stored, _id: stored._id.toUpperCase(), term: SEP }],
        rows
      )
    ).toBe(refusal);
    expect(
      markedRowsProblem([{ ...stored, description: 'renamed by hand' }], rows)
    ).toBe(refusal);
    // the unmarked row, a row with no id (a new one) and a row with an unknown id: free
    expect(
      markedRowsProblem(
        [
          { ...other, term: SEP, description: 'x' },
          { term: SEP, amount: 5 },
          { _id: 'aaaaaaaaaaaaaaaaaaaa40ff', term: SEP }
        ],
        rows
      )
    ).toBe(null);
    // …and whatever is not a list of rows is another check's to refuse
    expect(markedRowsProblem({ ...stored, term: SEP }, rows)).toBe(null);
    expect(markedRowsProblem([null, 'row', stored], rows)).toBe(null);
  });

  // The unit endpoints replace a unit's rows by the ones sent: what a row leaves out,
  // it loses. (The manual-row edit merges: there, a field that is not sent stays.)
  it.each([
    ['its description', 'description'],
    ['its expense', 'expenseId'],
    ['its month', 'term']
  ])('a unit’s rows: a marked row sent back WITHOUT %s is refused', (_what, field) => {
    const { [field]: _leftOut, ...without } = stored;
    expect(markedRowsProblem([without], [stored])).toBe(refusal);
    // the manual-row edit, with the same fields: nothing changes, nothing to refuse
    expect(markedRowProblem(without, stored)).toBe(null);
  });

  it('a unit’s rows: a marked row of no repair may leave the repair out, or send none', () => {
    const { repairId: _leftOut, ...without } = stored;
    expect(markedRowsProblem([without], [stored])).toBe(null);
    expect(markedRowsProblem([{ ...stored, repairId: null }], [stored])).toBe(null);
    expect(markedRowsProblem([{ ...stored, repairId: '' }], [stored])).toBe(null);
  });
});

// ── the answer, on real ledgers ─────────────────────────────────────────────────────
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
const POWER = {
  _id: 'power',
  name: 'Common power',
  type: 'electricity_common',
  amount: 0,
  allocationMethod: 'general_thousandths',
  isRecurring: true,
  startTerm: 2026010100,
  customAllocations: []
};
function building(rows = []) {
  return {
    _id: 'building1',
    name: 'Building 1',
    atakPrefix: '011172',
    units: [
      {
        _id: 'unit-A',
        propertyId: 'A',
        atakNumber: '01234567890',
        isManaged: true,
        surface: 80,
        generalThousandths: 1000,
        heatingThousandths: 0,
        elevatorThousandths: 0,
        owners: [],
        monthlyCharges: rows
      }
    ],
    expenses: [POWER],
    address: {},
    blockStreets: [],
    hasElevator: false,
    hasCentralHeating: false,
    contractors: [],
    repairs: []
  };
}
let created = 0;
const share = (month, amount, extra = {}) => ({
  _id: `row-${String(++created).padStart(5, '0')}`,
  term: month,
  amount,
  description: 'Common power',
  expenseId: 'power',
  repairId: null,
  carry: true,
  ...extra
});
// A tenant as the database holds one: the lease stored in mid November (July to
// October closed, November current), then recomputed with the building's rows.
function tenant({
  id = 't1',
  name = 'Tenant one',
  units = [unitOf('A')],
  rows = [],
  paid = [],
  end = '2027-06-30',
  frequency = 'months',
  recomputed = true,
  // something recorded on the lease after that recompute: it is handed the contract
  afterwards = null
} = {}) {
  at('2026-11-15T12:00:00Z');
  let c = Contract.create({
    begin: Date.parse('2026-07-01T00:00:00Z'),
    end: Date.parse(`${end}T23:59:59Z`),
    frequency: 'months',
    properties: units,
    buildings: [building()]
  });
  paid.forEach((month) => {
    const rent = c.rents.find((r) => r.term === month);
    Contract.payTerm(c, String(month), {
      payments: [
        {
          amount: rent.total.grandTotal,
          type: 'cash',
          date: '15/11/2026',
          reference: ''
        }
      ]
    });
  });
  if (recomputed) {
    c = Contract.update(c, {
      properties: units,
      buildings: [building(rows)]
    });
  }
  if (afterwards) afterwards(c);
  return { _id: id, name, frequency, properties: units, rents: c.rents };
}
const outcomes = (rows, tenants, month = OCT) =>
  shareOutcomes({
    term: month,
    currentTerm: NOV,
    buildingName: 'Building 1',
    units: [{ propertyId: 'A', rows }],
    expenseIds: ['power'],
    billedLiveNames: [],
    tenants
  });

describe('what became of the shares of a statement, tenant by tenant', () => {
  it('a share for the current month the tenant has not paid: on that month', () => {
    const rows = [share(NOV, 30)];
    expect(outcomes(rows, [tenant({ rows })], NOV)).toEqual([
      {
        propertyId: 'A',
        tenantId: 't1',
        tenantName: 'Tenant one',
        expenseId: 'power',
        term: NOV,
        amount: 30,
        status: 'billed',
        billedTerm: NOV,
        billedAmount: 30
      }
    ]);
  });

  it('a share for a month that is over: on the current month, because that month is closed', () => {
    const rows = [share(OCT, 30)];
    expect(outcomes(rows, [tenant({ rows })])).toEqual([
      expect.objectContaining({
        status: 'moved',
        term: OCT,
        billedTerm: NOV,
        billedAmount: 30,
        reason: 'monthClosed'
      })
    ]);
  });

  it('a share for the current month the tenant has paid: on next month, because it is paid', () => {
    const rows = [share(NOV, 30)];
    expect(outcomes(rows, [tenant({ rows, paid: [NOV] })], NOV)).toEqual([
      expect.objectContaining({
        status: 'moved',
        billedTerm: DEC,
        reason: 'monthPaid'
      })
    ]);
  });

  it('a share for a month that is over, of a tenant who has paid the current month: on next month — and the reason is the paid month', () => {
    // (what the import window says under it: «έχει εξοφλήσει τον Νοέμβριο». The month
    // being over would not explain why the share is not on November.)
    const rows = [share(OCT, 30)];
    expect(outcomes(rows, [tenant({ rows, paid: [NOV] })])).toEqual([
      expect.objectContaining({
        status: 'moved',
        term: OCT,
        billedTerm: DEC,
        billedAmount: 30,
        reason: 'monthPaid'
      })
    ]);
  });

  it('a share that was carried onto the current month, which the tenant then paid in full: still «closed», not «paid»', () => {
    // October's share went on November while November was open; the tenant then paid
    // November, share and all. The share is on the CURRENT month — it is there
    // because October was over, and «the tenant has paid October» is not what the
    // app knows.
    const rows = [share(OCT, 30)];
    const payNovemberInFull = (c) => {
      const november = c.rents.find((r) => r.term === NOV);
      Contract.payTerm(c, String(NOV), {
        payments: [
          {
            amount: november.total.grandTotal,
            type: 'cash',
            date: '15/11/2026',
            reference: ''
          }
        ]
      });
    };
    const t = tenant({ rows, afterwards: payNovemberInFull });
    expect(
      Contract.isClosedRent(
        t.rents.find((r) => r.term === NOV),
        NOV
      )
    ).toBe(true);
    expect(outcomes(rows, [t])).toEqual([
      expect.objectContaining({
        status: 'moved',
        term: OCT,
        billedTerm: NOV,
        billedAmount: 30,
        reason: 'monthClosed'
      })
    ]);
  });

  it('…but once the current month has RE-OPENED, a share that still sits on next month is not «paid»', () => {
    // (found by review) November was paid in full, so October's share went on
    // December. Then a late fee is recorded on October: November carries it in and is
    // no longer paid in full (D-11). The share stays on December until the next
    // recompute moves it — and «the tenant has paid November» is not true meanwhile.
    const rows = [share(OCT, 30)];
    const lateFeeOnOctober = (c) =>
      Contract.payTerm(c, String(OCT), {
        payments: [],
        debts: [{ description: 'late fee', amount: 50 }]
      });
    const t = tenant({ rows, paid: [NOV], afterwards: lateFeeOnOctober });
    // the state this is about, as the engine leaves it: November open again, and the
    // share still on December
    const november = t.rents.find((r) => r.term === NOV);
    expect(Contract.isClosedRent(november, NOV)).toBe(false);
    expect(outcomes(rows, [t])).toEqual([
      expect.objectContaining({
        status: 'moved',
        term: OCT,
        billedTerm: DEC,
        billedAmount: 30,
        reason: 'monthClosed'
      })
    ]);
  });

  it('a tenant whose lease has ended: not charged', () => {
    const rows = [share(OCT, 30)];
    expect(
      outcomes(rows, [
        tenant({
          rows,
          end: '2026-10-31',
          units: [unitOf('A', '2026-07-01', '2026-10-31')]
        })
      ])
    ).toEqual([
      expect.objectContaining({
        status: 'notCharged',
        billedTerm: null,
        billedAmount: null,
        reason: 'leaseEnded'
      })
    ]);
  });

  it('a row from before shares were carried, for a closed month: not charged, as before', () => {
    const rows = [share(OCT, 30, { carry: undefined })];
    expect(outcomes(rows, [tenant({ rows })])).toEqual([
      expect.objectContaining({ status: 'notCharged', reason: 'notCarried' })
    ]);
  });

  it('the recompute did not happen: the share is reported missing, not charged', () => {
    // closed month, marked, the tenant has an open month — and no rent holds it
    const rows = [share(OCT, 30)];
    expect(outcomes(rows, [tenant({ rows, recomputed: false })])).toEqual([
      expect.objectContaining({
        status: 'missing',
        billedTerm: null,
        reason: 'recomputeFailed'
      })
    ]);
    // an open month that should hold its own share and does not
    const current = [share(NOV, 30)];
    expect(
      outcomes(current, [tenant({ rows: current, recomputed: false })], NOV)
    ).toEqual([
      expect.objectContaining({ status: 'missing', reason: 'recomputeFailed' })
    ]);
  });

  it('an open month must hold every expense row of its own, marked or not: one that is not there is missing', () => {
    const current = [share(NOV, 30, { carry: undefined })];
    expect(
      outcomes(current, [tenant({ rows: current, recomputed: false })], NOV)
    ).toEqual([
      expect.objectContaining({ status: 'missing', reason: 'recomputeFailed' })
    ]);
  });

  it('a paid current month is closed: a marked share it does not hold is missing while a later month is open', () => {
    const rows = [share(NOV, 30)];
    expect(
      outcomes(rows, [tenant({ rows, paid: [NOV], recomputed: false })], NOV)
    ).toEqual([
      expect.objectContaining({ status: 'missing', reason: 'recomputeFailed' })
    ]);
  });

  it('a paid current month is closed: an unmarked row for it was not charged', () => {
    const rows = [share(NOV, 30, { carry: undefined })];
    expect(
      outcomes(rows, [tenant({ rows, paid: [NOV], recomputed: false })], NOV)
    ).toEqual([
      expect.objectContaining({ status: 'notCharged', reason: 'notCarried' })
    ]);
  });

  it('the amount on the rent is reported next to the share the building holds', () => {
    // billed 30 on November, which was then paid; the figure is now 35
    const billed = [share(OCT, 30)];
    const t = tenant({ rows: billed });
    const november = t.rents.find((r) => r.term === NOV);
    november.payments = [{ amount: november.total.grandTotal }];
    november.total.payment = november.total.grandTotal;
    expect(outcomes([{ ...billed[0], amount: 35 }], [t])).toEqual([
      expect.objectContaining({
        status: 'moved',
        amount: 35,
        billedTerm: NOV,
        billedAmount: 30
      })
    ]);
  });

  it('two tenants of the unit in that month: one line each', () => {
    const rows = [share(NOV, 30)];
    const leaving = tenant({
      id: 'left',
      name: 'Leaving',
      rows,
      units: [unitOf('A', '2026-07-01', '2026-11-15')]
    });
    const arriving = tenant({
      id: 'came',
      name: 'Arriving',
      rows,
      paid: [NOV],
      units: [unitOf('A', '2026-11-16')]
    });
    expect(
      outcomes(rows, [leaving, arriving], NOV).map((o) => [
        o.tenantId,
        o.status,
        o.billedTerm
      ])
    ).toEqual([
      ['left', 'billed', NOV],
      ['came', 'moved', DEC]
    ]);
  });

  it('a property that two units of the building name: each row is reported once', () => {
    // a known shape of this data (two units linked to one property). The rewrite that
    // looks at all the units of a tenant together reported every such row twice.
    const first = [share(OCT, 30)];
    const second = [share(OCT, 12)];
    const t = tenant({ rows: [...first, ...second] });
    expect(
      shareOutcomes({
        term: OCT,
        currentTerm: NOV,
        buildingName: 'Building 1',
        units: [
          { propertyId: 'A', rows: first },
          { propertyId: 'A', rows: second }
        ],
        expenseIds: ['power'],
        billedLiveNames: [],
        tenants: [t]
      }).map((o) => [o.amount, o.status, o.billedTerm, o.billedAmount])
    ).toEqual([
      [30, 'moved', NOV, 30],
      [12, 'moved', NOV, 12]
    ]);
  });

  it('tenants and rows that are not concerned are left out', () => {
    const rows = [
      share(OCT, 30),
      share(OCT, 60, { expenseId: null, repairId: 'repair-1' }),
      // a row that names an expense AND a repair is a repair row
      share(OCT, 61, { repairId: 'repair-2' }),
      share(OCT, 25, { expenseId: null }),
      share(OCT, 0, { expenseId: 'water' }),
      share(SEP, 30, { expenseId: 'heating' })
    ];
    const t = tenant({ rows });
    expect(outcomes(rows, [t]).map((o) => o.expenseId)).toEqual(['power']);
    // a tenant who moved in later, one with no rent for that month, one whose lease
    // is not monthly, and garbage
    expect(
      outcomes(rows, [
        tenant({ rows, units: [unitOf('A', '2026-11-01')] }),
        { ...t, rents: t.rents.filter((r) => r.term !== OCT) },
        { ...t, frequency: 'years' },
        { ...t, properties: undefined },
        null
      ])
    ).toEqual([]);
    expect(outcomes(rows, undefined)).toEqual([]);
    expect(outcomes(undefined, [t])).toEqual([]);
  });
});

// ── the building page ───────────────────────────────────────────────────────────────
// The example the owner approved the screens with: one building, three apartments in
// equal thousandths, a 90,00 bill for October that arrives in November. Tenant A has
// not paid November. Tenant B has paid it in full. Tenant C's lease ended on 31 October.
describe('the building page of a month', () => {
  const unit3 = (id, rows = [], holder = null) => ({
    _id: `unit-${id}`,
    propertyId: id,
    atakNumber: '01234567890',
    isManaged: true,
    surface: 80,
    generalThousandths: 333,
    heatingThousandths: 0,
    elevatorThousandths: 0,
    owners: [],
    monthlyCharges: rows,
    property: { name: `Apt ${id}` },
    tenant: holder
  });
  const octoberShare = (extra = {}) =>
    share(OCT, 30, { inputAmount: 90, ...extra });
  // the building as the page has it (units with their tenant of the month looked at)
  const page = (rows, holders) => ({
    _id: 'building1',
    name: 'Building 1',
    units: ['A', 'B', 'C'].map((id) =>
      unit3(id, rows[id] || [], holders[id] || null)
    ),
    expenses: [POWER],
    repairs: []
  });
  // each tenant's ledger, from the real engine, priced with a building that holds
  // that tenant's unit and its rows (the thousandths play no part in the ledger)
  const tenantOn = (id, name, unitId, options) => {
    const t = tenant({
      id,
      name,
      units: [unitOf(unitId, '2026-07-01', options.end || '2027-06-30')],
      end: options.end || '2027-06-30',
      rows: [],
      paid: options.paid || [],
      recomputed: false
    });
    // recompute with a building that holds THIS tenant's unit
    at('2026-11-15T12:00:00Z');
    const c = Contract.update(
      {
        begin: Date.parse('2026-07-01T00:00:00Z'),
        end: Date.parse(`${options.end || '2027-06-30'}T23:59:59Z`),
        frequency: 'months',
        properties: t.properties,
        rents: t.rents
      },
      {
        properties: t.properties,
        buildings: [
          {
            ...building(options.rows || []),
            units: [
              {
                ...building(options.rows || []).units[0],
                propertyId: unitId
              }
            ]
          }
        ]
      }
    );
    return { ...t, rents: c.rents };
  };
  const world = () => {
    const rows = {
      A: [octoberShare()],
      B: [octoberShare()],
      C: [octoberShare()]
    };
    const tenants = [
      tenantOn('tA', 'Tenant A', 'A', { rows: rows.A }),
      tenantOn('tB', 'Tenant B', 'B', { rows: rows.B, paid: [NOV] }),
      tenantOn('tC', 'Tenant C', 'C', { rows: rows.C, end: '2026-10-31' })
    ];
    return { rows, tenants };
  };
  const holders = (month) =>
    month <= OCT
      ? {
          A: { _id: 'tA', name: 'Tenant A' },
          B: { _id: 'tB', name: 'Tenant B' },
          C: { _id: 'tC', name: 'Tenant C' }
        }
      : {
          A: { _id: 'tA', name: 'Tenant A' },
          B: { _id: 'tB', name: 'Tenant B' }
        };
  const placed = (month, { rows, tenants }, more = {}) => {
    const hydrated = page(rows, holders(month));
    return placeTenantShares({
      term: month,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: hydrated.units,
      expenseIds: hydrated.expenses.map((e) => e._id),
      // as the manager works them out: the expenses with an amount of their own
      billedLiveNames: hydrated.expenses
        .filter((e) => Number(e.amount) > 0)
        .map((e) => e.name),
      rows: computeBuildingExpenseBreakdown(hydrated, month).rows,
      tenants,
      rowOfItsMonth: (forTerm, propertyId, expenseId) =>
        computeBuildingExpenseBreakdown(
          page(rows, holders(forTerm)),
          forTerm
        ).rows.find(
          (r) => r.propertyId === propertyId && r.expenseId === expenseId
        ),
      ...more
    });
  };

  it('October: each share says where it went, and none of them is in October’s tenant total', () => {
    const { rows, tenantTotal } = placed(OCT, world());
    expect(
      rows.map((r) => [r.propertyId, r.recipientName, r.amount, r.billing])
    ).toEqual([
      [
        'A',
        'Tenant A',
        30,
        [
          {
            tenantId: 'tA',
            tenantName: 'Tenant A',
            status: 'moved',
            billedTerm: NOV,
            billedAmount: 30,
            reason: 'monthClosed'
          }
        ]
      ],
      [
        'B',
        'Tenant B',
        30,
        [
          {
            tenantId: 'tB',
            tenantName: 'Tenant B',
            status: 'moved',
            billedTerm: DEC,
            billedAmount: 30,
            reason: 'monthPaid'
          }
        ]
      ],
      [
        'C',
        'Tenant C',
        30,
        [
          {
            tenantId: 'tC',
            tenantName: 'Tenant C',
            status: 'notCharged',
            billedTerm: null,
            billedAmount: null,
            reason: 'leaseEnded'
          }
        ]
      ]
    ]);
    expect(tenantTotal).toBe(0);
  });

  it('November: A’s October share is listed under A, marked with its month, with October’s calculation', () => {
    const { rows, tenantTotal } = placed(NOV, world());
    expect(rows).toEqual([
      {
        expenseId: 'power',
        expenseName: 'Common power',
        expenseType: 'electricity_common',
        allocationMethod: 'general_thousandths',
        propertyId: 'A',
        propertyName: 'Apt A',
        recipient: 'renter',
        recipientName: 'Tenant A',
        tenantId: 'tA',
        groupKey: 'A',
        amount: 30,
        basis: {
          kind: 'thousandths',
          part: 333,
          whole: 999,
          total: 90,
          share: 30
        },
        forTerm: OCT
      }
    ]);
    // the page adds up to what the rents of November hold
    expect(tenantTotal).toBe(30);
  });

  it('December: B’s', () => {
    const { rows, tenantTotal } = placed(DEC, world());
    expect(rows.map((r) => [r.recipientName, r.amount, r.forTerm])).toEqual([
      ['Tenant B', 30, OCT]
    ]);
    expect(tenantTotal).toBe(30);
  });

  it('two expenses of one unit: each row says where ITS share went', () => {
    // October's power (30) is marked and goes on November; October's water (20) is a
    // share from before shares were carried, and reached no rent.
    const WATER = {
      ...POWER,
      _id: 'water',
      name: 'Water',
      type: 'water_common'
    };
    const rows = {
      A: [
        octoberShare(),
        share(OCT, 20, {
          inputAmount: 60,
          expenseId: 'water',
          description: 'Water',
          carry: undefined
        })
      ]
    };
    const tenants = [tenantOn('tA', 'Tenant A', 'A', { rows: rows.A })];
    const hydrated = {
      ...page(rows, holders(OCT)),
      expenses: [POWER, WATER]
    };
    const { rows: out, tenantTotal } = placeTenantShares({
      term: OCT,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: hydrated.units,
      expenseIds: ['power', 'water'],
      billedLiveNames: [],
      rows: computeBuildingExpenseBreakdown(hydrated, OCT).rows,
      tenants,
      rowOfItsMonth: () => undefined
    });
    expect(
      out.map((r) => [
        r.expenseId,
        r.amount,
        r.billing.map((b) => [b.status, b.billedTerm, b.billedAmount])
      ])
    ).toEqual([
      ['power', 30, [['moved', NOV, 30]]],
      ['water', 20, [['notCharged', null, null]]]
    ]);
    expect(tenantTotal).toBe(0);
  });

  it('a month with nothing moved and nothing lost: the engine’s rows and total, untouched', () => {
    // November's own share, on tenants who have not paid November
    const rows = { A: [share(NOV, 30, { inputAmount: 90 })] };
    const tenants = [tenantOn('tA', 'Tenant A', 'A', { rows: rows.A })];
    const hydrated = page(rows, holders(NOV));
    const engineRows = computeBuildingExpenseBreakdown(hydrated, NOV).rows;
    const result = placeTenantShares({
      term: NOV,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: hydrated.units,
      expenseIds: ['power'],
      billedLiveNames: [],
      rows: engineRows,
      tenants,
      rowOfItsMonth: () => undefined
    });
    expect(result.rows).toBe(engineRows);
    expect(result.tenantTotal).toBe(30);
  });

  it('a share from before shares were carried, never billed: marked, and out of the total', () => {
    const rows = { A: [octoberShare({ carry: undefined })] };
    const tenants = [tenantOn('tA', 'Tenant A', 'A', { rows: rows.A })];
    const { rows: out, tenantTotal } = placed(OCT, { rows, tenants });
    expect(out.map((r) => [r.amount, r.billing])).toEqual([
      [
        30,
        [
          {
            tenantId: 'tA',
            tenantName: 'Tenant A',
            status: 'notCharged',
            billedTerm: null,
            billedAmount: null,
            reason: 'notCarried'
          }
        ]
      ]
    ]);
    expect(tenantTotal).toBe(0);
    // …and November lists nothing of it
    expect(placed(NOV, { rows, tenants }).rows).toEqual([]);
  });

  it('a share from before, billed on its own month: nothing is said about it, as before', () => {
    const rows = { A: [octoberShare({ carry: undefined })] };
    const t = tenantOn('tA', 'Tenant A', 'A', { rows: rows.A });
    // October was priced with it, before lines carried ids
    t.rents.find((r) => r.term === OCT).buildingCharges = [
      {
        description: 'Common power',
        amount: 30,
        buildingName: 'Building 1',
        type: 'electricity_common'
      }
    ];
    const { rows: out, tenantTotal } = placed(OCT, { rows, tenants: [t] });
    expect(out.map((r) => r.billing)).toEqual([undefined]);
    expect(tenantTotal).toBe(30);

    // the expense is renamed and October saved again: still recognised, by its amount
    rows.A[0].description = 'Stairwell lights';
    expect(
      placed(OCT, { rows, tenants: [t] }).rows.map((r) => r.billing)
    ).toEqual([undefined]);
  });

  it('a tenant who has left the unit gets a group of their own on the month that bills them', () => {
    // A's October share is on A's November rent; in November the unit is B's.
    const rows = { A: [octoberShare()] };
    const tenants = [tenantOn('tA', 'Tenant A', 'A', { rows: rows.A })];
    const hydrated = page(rows, { A: { _id: 'tB', name: 'Tenant B' } });
    const { rows: out } = placeTenantShares({
      term: NOV,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: hydrated.units,
      expenseIds: ['power'],
      billedLiveNames: [],
      rows: [],
      tenants,
      rowOfItsMonth: () => undefined
    });
    expect(out.map((r) => [r.recipientName, r.groupKey, r.basis])).toEqual([
      ['Tenant A', 'A|tA', { kind: 'none' }]
    ]);
    // …and with the unit empty that month
    const empty = page(rows, {});
    expect(
      placeTenantShares({
        term: NOV,
        currentTerm: NOV,
        units: empty.units,
        expenseIds: ['power'],
        billedLiveNames: [],
        rows: [],
        tenants,
        rowOfItsMonth: () => undefined
      }).rows.map((r) => r.groupKey)
    ).toEqual(['A|tA']);
  });

  it('the figure of its month was changed after it was billed: the share is listed without a calculation', () => {
    const w = world();
    w.rows.A[0].amount = 35;
    w.rows.A[0].inputAmount = 105;
    const [row] = placed(NOV, w).rows;
    expect([row.amount, row.basis]).toEqual([30, { kind: 'none' }]);
  });

  it('owner rows are handed on as they are', () => {
    const w = world();
    const hydrated = page(w.rows, { A: { _id: 'tA', name: 'Tenant A' } });
    const engineRows = computeBuildingExpenseBreakdown(hydrated, OCT).rows;
    const { rows } = placeTenantShares({
      term: OCT,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: hydrated.units,
      expenseIds: ['power'],
      billedLiveNames: [],
      rows: engineRows,
      tenants: w.tenants,
      rowOfItsMonth: () => undefined
    });
    const owners = rows.filter((r) => r.recipient === 'owner');
    expect(owners.length).toBe(2);
    owners.forEach((r) => {
      expect(r.billing).toBeUndefined();
      expect(engineRows).toContain(r);
    });
  });

  it.each([
    ['no units', { units: [] }],
    ['units of no property', { units: [{ monthlyCharges: [] }] }],
    ['no tenants', { tenants: undefined }],
    [
      'tenants that are not tenants',
      { tenants: [null, 5, {}, { rents: 'x' }] }
    ],
    ['no rows', { rows: undefined }]
  ])('%s: nothing breaks, nothing is added', (_what, change) => {
    const hydrated = page({}, {});
    const result = placeTenantShares({
      term: NOV,
      currentTerm: NOV,
      units: hydrated.units,
      rows: [],
      tenants: [],
      rowOfItsMonth: () => undefined,
      ...change
    });
    expect(result.rows).toEqual([]);
    expect(result.tenantTotal).toBe(0);
  });

  it('what moved into a month is read from the ledgers: this building’s units, carried lines only', () => {
    const { tenants } = world();
    expect(
      sharesMovedInto({ term: NOV, propertyIds: ['A', 'B', 'C'], tenants })
    ).toEqual([
      {
        tenantId: 'tA',
        tenantName: 'Tenant A',
        propertyId: 'A',
        expenseId: 'power',
        forTerm: OCT,
        amount: 30,
        description: 'Common power',
        type: 'electricity_common'
      }
    ]);
    // another building's units, another month, nothing at all
    expect(sharesMovedInto({ term: NOV, propertyIds: ['Z'], tenants })).toEqual(
      []
    );
    expect(
      sharesMovedInto({ term: OCT, propertyIds: ['A', 'B', 'C'], tenants })
    ).toEqual([]);
    expect(
      sharesMovedInto({ term: NOV, propertyIds: undefined, tenants: undefined })
    ).toEqual([]);
    // a tenant with no rent for that month has nothing moved into it — a later
    // month's carried line is that month's
    expect(
      sharesMovedInto({
        term: OCT,
        propertyIds: ['A'],
        tenants: [
          {
            _id: 't',
            rents: [
              {
                term: NOV,
                buildingCharges: [
                  { propertyId: 'A', expenseId: 'e', amount: 30, forTerm: SEP }
                ]
              }
            ]
          }
        ]
      })
    ).toEqual([]);
    // lines that are not carried lines of an expense
    expect(
      sharesMovedInto({
        term: NOV,
        propertyIds: ['A'],
        tenants: [
          {
            _id: 't',
            rents: [
              {
                term: NOV,
                buildingCharges: [
                  null,
                  { propertyId: 'A', expenseId: 'e', amount: 30 },
                  { propertyId: 'A', expenseId: 'e', amount: 30, forTerm: 'x' },
                  { propertyId: 'A', repairId: 'r', amount: 30, forTerm: OCT },
                  { propertyId: 'A', expenseId: 'e', amount: 0, forTerm: OCT }
                ]
              }
            ]
          }
        ]
      })
    ).toEqual([]);
  });
});

// ── found by review of the first version ─────────────────────────────────────────────
// The first version asked, share by share, «is there a line of this expense and month
// anywhere on the ledger?» — so a share was reported charged on the strength of another
// unit's line, one line was reported for several shares, and the page dropped the
// tenant who WAS billed as soon as another tenant of the unit was not.
describe('a tenant with two units: each share has its own answer', () => {
  const two = (A = [], B = []) => {
    const one = building(A).units[0];
    return {
      ...building(A),
      units: [
        { ...one, generalThousandths: 500 },
        {
          ...one,
          _id: 'unit-B',
          propertyId: 'B',
          generalThousandths: 500,
          monthlyCharges: B
        }
      ]
    };
  };
  const units = () => [unitOf('A'), unitOf('B')];
  // the lease first priced with `before`, then recomputed with `after`
  const tenantOfTwo = ({ before = {}, after, withoutIds = false }) => {
    at('2026-11-15T12:00:00Z');
    let c = Contract.create({
      begin: Date.parse('2026-07-01T00:00:00Z'),
      end: Date.parse('2027-06-30T23:59:59Z'),
      frequency: 'months',
      properties: units(),
      buildings: [two(before.A, before.B)]
    });
    if (withoutIds) {
      c.rents.forEach((r) => {
        r.buildingCharges = r.buildingCharges.map(
          ({ description, amount, buildingName, type }) => ({
            description,
            amount,
            buildingName,
            type
          })
        );
      });
    }
    c = Contract.update(c, {
      properties: units(),
      buildings: [two(after.A, after.B)]
    });
    return {
      _id: 't1',
      name: 'Tenant one',
      frequency: 'months',
      properties: units(),
      rents: c.rents
    };
  };
  const answer = (rows, tenants, month = OCT) =>
    shareOutcomes({
      term: month,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: [
        { propertyId: 'A', rows: rows.A || [] },
        { propertyId: 'B', rows: rows.B || [] }
      ],
      expenseIds: ['power'],
      billedLiveNames: [],
      tenants
    }).map((o) => [o.propertyId, o.amount, o.status, o.billedTerm, o.billedAmount]);
  const old = (month, amount) => share(month, amount, { carry: undefined });

  it('A’s new share is on November; B’s old one, never billed, is NOT «charged» because of it', () => {
    const rows = { A: [share(OCT, 30)], B: [old(OCT, 20)] };
    const t = tenantOfTwo({ after: rows });
    expect(answer(rows, [t])).toEqual([
      ['A', 30, 'moved', NOV, 30],
      ['B', 20, 'notCharged', null, null]
    ]);
  });

  it('A’s old share was billed on October; B’s new one goes on November, and each says so', () => {
    const A = old(OCT, 30);
    const rows = { A: [A], B: [share(OCT, 20)] };
    const t = tenantOfTwo({ before: { A: [A] }, after: rows });
    expect(answer(rows, [t])).toEqual([
      ['A', 30, 'billed', OCT, 30],
      ['B', 20, 'moved', NOV, 20]
    ]);
  });

  it('…but on a ledger stored before lines carried ids the old line does not say whose it is: it is shown against A, and B’s share is «not charged»', () => {
    // «Common power 30» and no more: it could be A's or B's. The engine bills
    // neither again (building-charge-carried.test.js), and the answer says what is
    // true of B's share: it is on no rent, and none is going to take it — not
    // «missing», which would mean the recompute had failed.
    const A = old(OCT, 30);
    const rows = { A: [A], B: [share(OCT, 20)] };
    const t = tenantOfTwo({ before: { A: [A] }, after: rows, withoutIds: true });
    expect(t.rents.find((r) => r.term === NOV).buildingCharges).toEqual([]);
    expect(
      shareOutcomes({
        term: OCT,
        currentTerm: NOV,
        buildingName: 'Building 1',
        units: [
          { propertyId: 'A', rows: rows.A },
          { propertyId: 'B', rows: rows.B }
        ],
        expenseIds: ['power'],
        billedLiveNames: [],
        tenants: [t]
      }).map((o) => [o.propertyId, o.status, o.billedTerm, o.billedAmount, o.reason])
    ).toEqual([
      ['A', 'billed', OCT, 30, undefined],
      ['B', 'notCharged', null, null, 'unclear']
    ]);
  });

  it('…the same when it is B’s row that reads more like the line: one is shown as billed, the other is in doubt, never both', () => {
    // A's billed figure was corrected to 20 afterwards (the row keeps its id); B's
    // new share is 30, exactly the old line's amount. The page shows the line against
    // B — a guess, and it may be the wrong one — but nothing is billed on the
    // strength of it: A's row is not marked, B's is not carried.
    const billed = old(OCT, 30);
    const corrected = { ...billed, amount: 20 };
    const rows = { A: [corrected], B: [share(OCT, 30)] };
    const t = tenantOfTwo({
      before: { A: [billed] },
      after: rows,
      withoutIds: true
    });
    expect(t.rents.find((r) => r.term === NOV).buildingCharges).toEqual([]);
    expect(
      shareOutcomes({
        term: OCT,
        currentTerm: NOV,
        buildingName: 'Building 1',
        units: [
          { propertyId: 'A', rows: rows.A },
          { propertyId: 'B', rows: rows.B }
        ],
        expenseIds: ['power'],
        billedLiveNames: [],
        tenants: [t]
      }).map((o) => [o.propertyId, o.status, o.billedTerm, o.billedAmount, o.reason])
    ).toEqual([
      ['A', 'notCharged', null, null, 'unclear'],
      ['B', 'billed', OCT, 30, undefined]
    ]);
  });

  it('the building page of October and of November add up to the rents of those months', () => {
    const A = old(OCT, 30);
    const rows = { A: [A], B: [share(OCT, 20)] };
    const t = tenantOfTwo({ before: { A: [A] }, after: rows });
    const hydrated = {
      ...two(rows.A, rows.B),
      units: two(rows.A, rows.B).units.map((u) => ({
        ...u,
        property: { name: `Apt ${u.propertyId}` },
        tenant: { _id: 't1', name: 'Tenant one' }
      }))
    };
    const page = (month) =>
      placeTenantShares({
        term: month,
        currentTerm: NOV,
        buildingName: 'Building 1',
        units: hydrated.units,
        expenseIds: ['power'],
        billedLiveNames: [],
        rows: computeBuildingExpenseBreakdown(hydrated, month).rows,
        tenants: [t],
        rowOfItsMonth: () => undefined
      });
    const held = (month) =>
      t.rents
        .find((r) => r.term === month)
        .buildingCharges.reduce((sum, l) => sum + l.amount, 0);

    const october = page(OCT);
    expect(
      october.rows.map((r) => [
        r.propertyId,
        r.amount,
        (r.billing || []).map((b) => [b.status, b.billedTerm])
      ])
    ).toEqual([
      ['A', 30, []],
      ['B', 20, [['moved', NOV]]]
    ]);
    expect([october.tenantTotal, held(OCT)]).toEqual([30, 30]);

    const november = page(NOV);
    expect(november.rows.map((r) => [r.propertyId, r.amount, r.forTerm])).toEqual([
      ['B', 20, OCT]
    ]);
    expect([november.tenantTotal, held(NOV)]).toEqual([20, 20]);
  });
});

describe('the building page when a unit holds two rows of one expense for the month', () => {
  // Two entries for one expense in one statement made two rows on every unit (the
  // statement save refuses that now; such rows can still be stored). Each row has its
  // own line on the rent — and its own answer: handing both answers to both rows
  // doubled the month's total (found by review).
  it('each row takes its own answer, and the total is what the rent holds', () => {
    const rows = [share(NOV, 20), share(NOV, 30)];
    const t = tenant({ rows });
    const november = t.rents.find((r) => r.term === NOV);
    expect(november.buildingCharges.map((l) => l.amount)).toEqual([20, 30]);
    // the tenant then pays November; the first row's figure is changed to 25
    november.payments = [{ amount: november.total.grandTotal }];
    november.total.payment = november.total.grandTotal;
    const changed = [{ ...rows[0], amount: 25 }, rows[1]];
    const hydrated = {
      ...building(changed),
      units: [
        {
          ...building(changed).units[0],
          property: { name: 'Apt A' },
          tenant: { _id: 't1', name: 'Tenant one' }
        }
      ]
    };
    const { rows: out, tenantTotal } = placeTenantShares({
      term: NOV,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: hydrated.units,
      expenseIds: ['power'],
      billedLiveNames: [],
      rows: computeBuildingExpenseBreakdown(hydrated, NOV).rows,
      tenants: [t],
      rowOfItsMonth: () => undefined
    });
    expect(
      out.map((r) => [
        r.amount,
        (r.billing || []).map((b) => [b.status, b.billedAmount])
      ])
    ).toEqual([
      [25, [['billed', 20]]],
      [30, []]
    ]);
    expect(tenantTotal).toBe(50);
  });

  it('two units of the building that name one property: each row once, the total not doubled', () => {
    const first = [share(NOV, 20)];
    const second = [share(NOV, 30)];
    const t = tenant({ rows: [...first, ...second] });
    const november = t.rents.find((r) => r.term === NOV);
    november.payments = [{ amount: november.total.grandTotal }];
    november.total.payment = november.total.grandTotal;
    const unit = (rows) => ({
      ...building(rows).units[0],
      property: { name: 'Apt A' },
      tenant: { _id: 't1', name: 'Tenant one' }
    });
    // the first entry's figure is 25 now; the rent holds 20 for it
    const units = [unit([{ ...first[0], amount: 25 }]), unit(second)];
    const hydrated = { ...building(), units };
    const { rows: out, tenantTotal } = placeTenantShares({
      term: NOV,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units,
      expenseIds: ['power'],
      billedLiveNames: [],
      rows: computeBuildingExpenseBreakdown(hydrated, NOV).rows,
      tenants: [t],
      rowOfItsMonth: () => undefined
    });
    expect(
      out.map((r) => [
        r.amount,
        (r.billing || []).map((b) => [b.status, b.billedAmount])
      ])
    ).toEqual([
      [25, [['billed', 20]]],
      [30, []]
    ]);
    expect(tenantTotal).toBe(50);
  });
});

describe('the building page when a unit had two tenants in the month, or a figure was changed', () => {
  const hydratedWith = (rows, holder) => ({
    ...building(rows),
    units: [
      {
        ...building(rows).units[0],
        property: { name: 'Apt A' },
        tenant: holder
      }
    ]
  });
  const pageOf = (month, rows, tenants, holder) => {
    const hydrated = hydratedWith(rows, holder);
    return placeTenantShares({
      term: month,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: hydrated.units,
      expenseIds: ['power'],
      billedLiveNames: [],
      rows: computeBuildingExpenseBreakdown(hydrated, month).rows,
      tenants,
      rowOfItsMonth: () => undefined
    });
  };
  const rentHolds = (t, month) =>
    t.rents
      .find((r) => r.term === month)
      .buildingCharges.reduce((sum, l) => sum + l.amount, 0);

  it('one tenant billed on the month, the other on the next: both are named, and the total is what the month holds', () => {
    // The unit changed hands in November: one tenant left on the 15th and has not
    // paid November; the other arrived on the 16th and has. A November share of 30.
    const rows = [share(NOV, 30)];
    const leaving = tenant({
      id: 'left',
      name: 'Leaving',
      rows,
      units: [unitOf('A', '2026-07-01', '2026-11-15')]
    });
    const arriving = tenant({
      id: 'came',
      name: 'Arriving',
      rows,
      paid: [NOV],
      units: [unitOf('A', '2026-11-16')]
    });
    const { rows: out, tenantTotal } = pageOf(NOV, rows, [leaving, arriving], {
      _id: 'came',
      name: 'Arriving'
    });
    expect(out.map((r) => [r.amount, r.billing])).toEqual([
      [
        30,
        [
          {
            tenantId: 'left',
            tenantName: 'Leaving',
            status: 'billed',
            billedTerm: NOV,
            billedAmount: 30
          },
          {
            tenantId: 'came',
            tenantName: 'Arriving',
            status: 'moved',
            billedTerm: DEC,
            billedAmount: 30,
            reason: 'monthPaid'
          }
        ]
      ]
    ]);
    // November's rents hold 30 (the one who left) + 0 (the one who came)
    expect([rentHolds(leaving, NOV), rentHolds(arriving, NOV)]).toEqual([30, 0]);
    expect(tenantTotal).toBe(30);
  });

  it('both tenants billed on the month at the amount shown: nothing is said, as before', () => {
    const rows = [share(NOV, 30)];
    const leaving = tenant({
      id: 'left',
      name: 'Leaving',
      rows,
      units: [unitOf('A', '2026-07-01', '2026-11-15')]
    });
    const arriving = tenant({
      id: 'came',
      name: 'Arriving',
      rows,
      units: [unitOf('A', '2026-11-16')]
    });
    const hydrated = hydratedWith(rows, { _id: 'came', name: 'Arriving' });
    const engineRows = computeBuildingExpenseBreakdown(hydrated, NOV).rows;
    const result = placeTenantShares({
      term: NOV,
      currentTerm: NOV,
      buildingName: 'Building 1',
      units: hydrated.units,
      expenseIds: ['power'],
      billedLiveNames: [],
      rows: engineRows,
      tenants: [leaving, arriving],
      rowOfItsMonth: () => undefined
    });
    expect(result.rows).toBe(engineRows);
    expect(result.tenantTotal).toBe(30);
  });

  it('a share billed on its own month, then the figure changed: the page shows what the rent holds', () => {
    // billed 30 on November, which was then paid; the figure is now 35. The rent is
    // closed: it keeps 30, and the page says so instead of listing 35 as charged.
    const billed = [share(NOV, 30)];
    const t = tenant({ rows: billed });
    const november = t.rents.find((r) => r.term === NOV);
    november.payments = [{ amount: november.total.grandTotal }];
    november.total.payment = november.total.grandTotal;

    const changed = [{ ...billed[0], amount: 35 }];
    const { rows: out, tenantTotal } = pageOf(NOV, changed, [t], {
      _id: 't1',
      name: 'Tenant one'
    });
    expect(out.map((r) => [r.amount, r.billing])).toEqual([
      [
        35,
        [
          {
            tenantId: 't1',
            tenantName: 'Tenant one',
            status: 'billed',
            billedTerm: NOV,
            billedAmount: 30
          }
        ]
      ]
    ]);
    expect([rentHolds(t, NOV), tenantTotal]).toEqual([30, 30]);
  });
});
