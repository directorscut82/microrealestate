// Which line of a tenant's rents stands for which row of the building
// (businesslogic/carriedshares.ts). The rent engine asks it to know what a closed rent
// already holds — a share that is covered is never billed again — and the screens ask it
// to say where a share went. One answer for both: the rules are pinned here, one by one;
// what they add up to on real ledgers is in building-charge-carried.test.js (engine) and
// __tests__/chargeCarry.test.js (the answer and the building page).
import { coverRows, heldLinesOf } from '../carriedshares.js';

const OCT = 2026100100;
const NOV = 2026110100;
const DEC = 2026120100;

let made = 0;
const row = (propertyId, extra = {}) => ({
  propertyId,
  expenseId: 'power',
  month: OCT,
  marked: true,
  description: 'Common power',
  buildingName: 'Building 1',
  created: `row-${String(++made).padStart(4, '0')}`,
  ...extra
});
const line = (propertyId, extra = {}) => ({
  rentTerm: OCT,
  month: OCT,
  propertyId,
  expenseId: 'power',
  buildingName: 'Building 1',
  description: 'Common power',
  amount: 30,
  ...extra
});
const LIVE = new Set(['power', 'water']);
// which rows are covered, and by which line: [[row, line], …] in the order of `rows`
const cover = (rows, held, live = LIVE, options) => {
  const { covered } = coverRows(rows, held, live, options);
  return rows.filter((r) => covered.has(r)).map((r) => [r, covered.get(r)]);
};
// the rows an old line may be for, and that no line is known to be for
const unsure = (rows, held, live = LIVE, options) => {
  const found = coverRows(rows, held, live, options).unsure;
  return rows.filter((r) => found.has(r));
};

describe('the building lines of rents that are shares of an expense', () => {
  it('a line of the month itself is for that month; a carried line says which month it is for', () => {
    expect(
      heldLinesOf([
        {
          term: NOV,
          buildingCharges: [
            {
              description: 'Common power',
              amount: 20,
              buildingName: 'Building 1',
              propertyId: 'A',
              expenseId: 'power'
            },
            {
              description: 'Common power',
              amount: 30,
              buildingName: 'Building 1',
              propertyId: 'A',
              expenseId: 'power',
              forTerm: OCT
            }
          ]
        }
      ])
    ).toEqual([
      {
        rentTerm: NOV,
        month: NOV,
        propertyId: 'A',
        expenseId: 'power',
        buildingName: 'Building 1',
        description: 'Common power',
        amount: 20
      },
      {
        rentTerm: NOV,
        month: OCT,
        propertyId: 'A',
        expenseId: 'power',
        buildingName: 'Building 1',
        description: 'Common power',
        amount: 30
      }
    ]);
  });

  it('a line stored before lines carried ids names no unit and no expense', () => {
    expect(
      heldLinesOf([
        { term: OCT, buildingCharges: [{ description: 'Water', amount: 12 }] }
      ])
    ).toEqual([
      {
        rentTerm: OCT,
        month: OCT,
        propertyId: '',
        expenseId: '',
        buildingName: '',
        description: 'Water',
        amount: 12
      }
    ]);
  });

  it.each([
    ['a text', '2026100100'],
    ['a fraction', 2026100100.5],
    ['null', null]
  ])('a month it is for that is %s is no month: the line is its rent’s', (_w, forTerm) => {
    expect(
      heldLinesOf([
        {
          term: NOV,
          buildingCharges: [{ propertyId: 'A', expenseId: 'power', forTerm }]
        }
      ])[0].month
    ).toBe(NOV);
  });

  it('a month it is for, on a line of no expense, is not believed either', () => {
    expect(
      heldLinesOf([
        { term: NOV, buildingCharges: [{ description: 'x', forTerm: OCT }] }
      ])[0].month
    ).toBe(NOV);
  });

  it('repairs are not shares: with a repair id, or — stored before ids — by their type', () => {
    expect(
      heldLinesOf([
        {
          term: OCT,
          buildingCharges: [
            { description: 'Roof', amount: 60, repairId: 'r1', propertyId: 'A' },
            { description: 'Common power', amount: 60, type: 'repair' },
            // a line that names an expense AND a repair is a repair line
            { description: 'Both', amount: 5, repairId: 'r2', expenseId: 'power' }
          ]
        }
      ])
    ).toEqual([]);
  });

  it.each([
    ['no rents', undefined],
    ['rents that are a text', 'rents'],
    ['a rent that is null, a rent whose month is no month, a rent with no lines', [
      null,
      { term: 'October', buildingCharges: [{ description: 'x' }] },
      { term: '20261001', buildingCharges: [{ description: 'x' }] },
      { term: null, buildingCharges: [{ description: 'x' }] },
      { term: OCT },
      { term: OCT, buildingCharges: 'none' },
      { term: OCT, buildingCharges: [null, 5, 'x'] }
    ]]
  ])('%s: no lines, and nothing breaks', (_what, rents) => {
    expect(heldLinesOf(rents)).toEqual([]);
  });

  it('a month stored as its ten digits in text is that month', () => {
    // a ledger restored from a backup, or written by hand, can hold one; the line on
    // it was billed all the same, and the screens must not call it «not charged»
    expect(
      heldLinesOf([
        {
          term: '2026110100',
          buildingCharges: [
            { propertyId: 'A', expenseId: 'power', amount: 30, forTerm: OCT }
          ]
        }
      ]).map((l) => [l.rentTerm, l.month])
    ).toEqual([[NOV, OCT]]);
  });
});

describe('1. a line of an expense that exists covers the row of its own unit', () => {
  it('that expense, that month, that unit', () => {
    const A = row('A');
    const held = [line('A')];
    expect(cover([A], held)).toEqual([[A, held[0]]]);
  });

  it('a row that is not marked is covered just the same', () => {
    // it is never carried — but it is what the line was billed for, and left out of
    // the question the line would be taken for a marked row's
    const A = row('A', { marked: false });
    const B = row('B');
    const held = [line('A')];
    expect(cover([A, B], held)).toEqual([[A, held[0]]]);
  });

  it('a line carried to a later rent covers the row of the month it is for', () => {
    const A = row('A');
    const held = [line('A', { rentTerm: DEC })];
    expect(cover([A], held)).toEqual([[A, held[0]]]);
  });

  it('never another expense, another month, or another unit that has its own row', () => {
    const A = row('A');
    expect(cover([A], [line('A', { expenseId: 'water' })])).toEqual([]);
    expect(cover([A], [line('A', { month: NOV, rentTerm: NOV })])).toEqual([]);
    const B = row('B');
    const held = [line('B')];
    expect(cover([A, B], held)).toEqual([[B, held[0]]]);
  });

  it('a second line for a row that is covered covers nothing more', () => {
    // a share billed twice by an older fault is one share too many for that unit, not
    // a reason to drop the other unit's
    const A = row('A');
    const B = row('B');
    const held = [line('A'), line('A', { rentTerm: NOV })];
    expect(cover([A, B], held)).toEqual([[A, held[0]]]);
  });

  it('two rows of one unit, expense and month: two lines cover both, one covers the older', () => {
    const first = row('A');
    const second = row('A');
    const held = [line('A'), line('A', { rentTerm: NOV })];
    expect(cover([second, first], held)).toEqual([
      [second, held[1]],
      [first, held[0]]
    ]);
    expect(cover([second, first], [held[0]])).toEqual([[first, held[0]]]);
  });
});

describe('3. a line whose unit has no row for it stands in for one other row', () => {
  it('the share of a tenant with two units, now on the other unit', () => {
    const B = row('B');
    const held = [line('A')];
    expect(cover([B], held)).toEqual([[B, held[0]]]);
  });

  it('for ONE row', () => {
    const B = row('B');
    const C = row('C');
    const held = [line('A')];
    expect(cover([B, C], held)).toEqual([[B, held[0]]]);
  });

  it('a marked row first — that is what a share that moved looks like — whatever its age', () => {
    const before = row('B', { marked: false });
    const moved = row('C');
    const held = [line('A')];
    expect(cover([before, moved], held)).toEqual([[moved, held[0]]]);
  });

  it('not for a row its own line already covers', () => {
    const B = row('B');
    const held = [line('A'), line('B')];
    expect(cover([B], held)).toEqual([[B, held[1]]]);
  });

  it('only for that expense and that month', () => {
    expect(cover([row('B', { expenseId: 'water' })], [line('A')])).toEqual([]);
    expect(cover([row('B', { month: NOV })], [line('A')])).toEqual([]);
  });

  it('a line that names no unit at all stands in too', () => {
    const B = row('B');
    const held = [line('')];
    expect(cover([B], held)).toEqual([[B, held[0]]]);
  });

  it('only a unit of the tenant’s stands in: the line of a unit that is no longer theirs does not', () => {
    // A was taken off the tenant's lease: its rows are not in the question, so its
    // line would look like a share that moved — and swallow B's new one
    const B = row('B');
    const held = [line('A')];
    const withUnits = (tenantUnits) =>
      cover([B], held, LIVE, { tenantUnits }).map(([r]) => r);
    expect(withUnits(new Set(['B']))).toEqual([]);
    expect(withUnits(new Set(['A', 'B']))).toEqual([B]);
    // …and with no word on whose units they are, every unit may
    expect(cover([B], held)).toEqual([[B, held[0]]]);
  });

  it('between several rows: one of a month the tenant held the unit first, then a marked one, then the oldest', () => {
    // the row that is left uncovered is the one that may be billed: it must be the
    // one that is least likely to be the share that moved
    const held = [line('A')];
    const notHeld = row('B', { held: false });
    const heldRow = row('C');
    expect(cover([notHeld, heldRow], held)).toEqual([[heldRow, held[0]]]);
    const before = row('B', { marked: false });
    const moved = row('C');
    expect(cover([before, moved], held)).toEqual([[moved, held[0]]]);
    // held counts for more than marked
    const heldBefore = row('C', { marked: false });
    expect(cover([notHeld, heldBefore], held)).toEqual([[heldBefore, held[0]]]);
    const older = row('B');
    const newer = row('C');
    expect(cover([newer, older], held)).toEqual([[older, held[0]]]);
    // a stand-in is by count: it leaves nothing «unsure»
    expect(unsure([notHeld, heldRow], held)).toEqual([]);
  });

  it('…and one that no old line has put in doubt before one that is: the stand-in takes the row that would be billed', () => {
    // Unit A holds two rows of one expense for October (a known shape of old data);
    // B holds one. An old line names A and reads like them: it is shown against one
    // of A's rows and puts the other in doubt. The line of unit C — whose own row has
    // gone — stands in for one row: B's, which nothing else keeps from being billed.
    // Taking A's row in doubt (not billed anyway) left B's to be billed.
    const firstOfA = row('A');
    const secondOfA = row('A');
    const ofB = row('B');
    const held = [
      line('A', { expenseId: 'power-before' }),
      line('C', { rentTerm: NOV })
    ];
    const { covered, unsure: inDoubt } = coverRows(
      [firstOfA, secondOfA, ofB],
      held,
      LIVE
    );
    expect([
      covered.get(firstOfA),
      inDoubt.has(secondOfA),
      covered.get(ofB)
    ]).toEqual([held[0], true, held[1]]);
  });
});

describe('2 and 4. an OLD line — of no living expense — is for a row that reads the same', () => {
  const old = (extra = {}) => line('', { expenseId: '', ...extra });

  it('stored before lines carried ids: same month, same building name, same description', () => {
    const A = row('A');
    const held = [old()];
    expect(cover([A], held)).toEqual([[A, held[0]]]);
    expect(unsure([A], held)).toEqual([]);
    expect(cover([A], [old({ description: 'Water' })])).toEqual([]);
    expect(cover([A], [old({ buildingName: 'Building 2' })])).toEqual([]);
    expect(cover([A], [old({ month: NOV, rentTerm: NOV })])).toEqual([]);
  });

  it('of an expense that was deleted: by its name, whatever id the expense has now', () => {
    const A = row('A', { expenseId: 'power-again' });
    const held = [line('A', { expenseId: 'power-before' })];
    expect(cover([A], held, new Set(['power-again']))).toEqual([[A, held[0]]]);
  });

  it('…its own unit’s row when it names a unit that has one — and no other unit’s is in doubt', () => {
    const B = row('B', { expenseId: 'power-again' });
    const A = row('A', { expenseId: 'power-again' });
    const held = [line('A', { expenseId: 'power-before' })];
    const live = new Set(['power-again']);
    expect(cover([B, A], held, live)).toEqual([[A, held[0]]]);
    expect(unsure([B, A], held, live)).toEqual([]);
  });

  it('…and when that unit’s rows are all covered, a row that reads the same on ANOTHER unit (rule 4)', () => {
    // two lines of the deleted expense name A, and A has one row: the second line is
    // not A's row's. By count it is another row's — B's is not billed again.
    const B = row('B', { expenseId: 'power-again' });
    const A = row('A', { expenseId: 'power-again' });
    const held = [
      line('A', { expenseId: 'power-before' }),
      line('A', { expenseId: 'power-before', rentTerm: NOV })
    ];
    const live = new Set(['power-again']);
    expect(cover([B, A], held, live)).toEqual([
      [B, held[1]],
      [A, held[0]]
    ]);
    expect(unsure([B, A], held, live)).toEqual([]);
  });

  it('…also when the unit’s only row that reads the same is a NAMESAKE’s, which its own line covers: a share that moved', () => {
    // Two expenses are called «Common power». October billed both for A (with ids):
    // power 30 and yard 12. The yard's expense is deleted and created again, and its
    // share is on B now. A's power row reads like the yard's old line — but it has
    // its own line: the old line is not for it, it is for the share that moved. (Left
    // where it was, the old line covered nothing and B's 12 was billed a second time:
    // found by review.)
    const powerOfA = row('A', { amount: 30 });
    const yardOnB = row('B', { expenseId: 'yard-again', amount: 12 });
    const held = [
      line('A', { amount: 30 }),
      line('A', { expenseId: 'yard-before', amount: 12 })
    ];
    const live = new Set(['power', 'yard-again']);
    expect(cover([powerOfA, yardOnB], held, live)).toEqual([
      [powerOfA, held[0]],
      [yardOnB, held[1]]
    ]);
    expect(unsure([powerOfA, yardOnB], held, live)).toEqual([]);
  });

  it('…another unit’s when its own has none that reads the same — a share that moved, whatever its amount now', () => {
    // by count, as for an expense that still exists (rule 3). An earlier version
    // wanted the exact amount here: a moved share whose figure had been corrected by
    // 1 was billed again (found by review).
    const live = new Set(['power-again']);
    const held = [line('A', { expenseId: 'power-before' })];
    const B = row('B', { expenseId: 'power-again' });
    expect(cover([B], held, live)).toEqual([[B, held[0]]]);
    const same = row('B', { expenseId: 'power-again', amount: 30 });
    expect(cover([same], held, live)).toEqual([[same, held[0]]]);
    const corrected = row('B', { expenseId: 'power-again', amount: 31 });
    expect(cover([corrected], held, live)).toEqual([[corrected, held[0]]]);
  });

  it('a line that names its unit is placed before one that names none', () => {
    // October's own line has no ids (A's, 30). B's share was carried to November,
    // which is closed now, as a line of an expense that was deleted since. The
    // expense is back under another id, B's row written first.
    const B = row('B', { expenseId: 'power-again', amount: 20 });
    const A = row('A', { expenseId: 'power-again', amount: 30 });
    const held = [
      old(),
      line('B', { expenseId: 'power-before', rentTerm: NOV, amount: 20 })
    ];
    const live = new Set(['power-again']);
    expect(cover([B, A], held, live)).toEqual([
      [B, held[1]],
      [A, held[0]]
    ]);
    expect(unsure([B, A], held, live)).toEqual([]);
  });

  it('…and before a line that stands in', () => {
    // A's dead-expense line must get A's row, not lose it to B's stand-in
    const A = row('A', { expenseId: 'water', description: 'Common power' });
    const held = [
      line('B', { expenseId: 'water' }),
      line('A', { expenseId: 'water-before' })
    ];
    expect(cover([A], held, new Set(['water']))).toEqual([[A, held[1]]]);
  });

  it('a line of a deleted expense whose unit is no longer the tenant’s covers no other unit’s row', () => {
    const B = row('B', { expenseId: 'power-again' });
    const held = [line('A', { expenseId: 'power-before' })];
    const options = { tenantUnits: new Set(['B']) };
    const live = new Set(['power-again']);
    expect(cover([B], held, live, options)).toEqual([]);
    expect(unsure([B], held, live, options)).toEqual([]);
  });

  it('a line of an expense that EXISTS is never matched by its name', () => {
    // «Common power» was billed and still exists; a second expense has the same name
    const namesake = row('A', { expenseId: 'yard' });
    const live = new Set(['power', 'yard']);
    expect(cover([namesake], [line('A')], live)).toEqual([]);
    expect(unsure([namesake], [line('A')], live)).toEqual([]);
  });

  it('an expense that is gone from the building but still has a row of that month is matched by id', () => {
    const orphan = row('A', { expenseId: 'gone' });
    const held = [line('A', { expenseId: 'gone', description: 'Renamed since' })];
    expect(cover([orphan], held, new Set())).toEqual([[orphan, held[0]]]);
  });
});

// An old line says a name and an amount. When several rows read like it, nothing in
// the ledger says which one it was billed for. Two earlier versions of this code
// GUESSED (first «the one that was there before», then «the nearest amount») and let
// the engine bill the others; each was broken by review with a history in which the
// guess was wrong and a tenant was billed twice. Now the engine is told which rows are
// in doubt, and bills none of them again.
describe('an old line that could be for several rows: shown against one, the others are «unsure»', () => {
  const old = (extra = {}) => line('', { expenseId: '', ...extra });
  const split = (rows, held, live, options) => [
    cover(rows, held, live, options).map(([r]) => r),
    unsure(rows, held, live, options)
  ];

  it('two units, one old line: one row is shown as billed, the other is in doubt — whichever is which', () => {
    const A = row('A', { marked: false, amount: 30 });
    const B = row('B', { amount: 20 });
    expect(split([A, B], [old()])).toEqual([[A], [B]]);
  });

  it('…as many rows are shown as there are lines; with a line for each, none is in doubt', () => {
    const A = row('A');
    const B = row('B');
    const C = row('C');
    expect(split([A, B, C], [old()])).toEqual([[A], [B, C]]);
    expect(split([A, B, C], [old(), old({ rentTerm: NOV })])).toEqual([
      [A, B],
      [C]
    ]);
    expect(
      split([A, B, C], [old(), old({ rentTerm: NOV }), old({ rentTerm: DEC })])
    ).toEqual([[A, B, C], []]);
  });

  it('two expenses of one name on one unit', () => {
    const first = row('A');
    const second = row('A', { expenseId: 'yard' });
    expect(split([first, second], [old()])).toEqual([[first], [second]]);
    expect(split([first, second], [old(), old({ rentTerm: NOV })])).toEqual([
      [first, second],
      []
    ]);
  });

  it('a line of a deleted expense that names its unit: only the rows of THAT unit can be its own', () => {
    // one expense of that name: the line is its unit's row's, and the other unit's row
    // is not in doubt
    const recreated = row('A', { expenseId: 'power-again' });
    const others = row('B', { expenseId: 'power-again' });
    const held = [line('A', { expenseId: 'power-before' })];
    expect(split([recreated, others], held, new Set(['power-again']))).toEqual([
      [recreated],
      []
    ]);
    // two rows of that expense on the unit (old data): one shown, the other in doubt,
    // the other unit's still out of it
    const twin = row('A', { expenseId: 'power-again' });
    expect(
      split([recreated, twin, others], held, new Set(['power-again']))
    ).toEqual([[recreated], [twin]]);
  });

  it('…unless the rows that read like it are of TWO expenses: then the unit says too little, and every such row is in doubt', () => {
    // «Common power» is two expenses. The line of the deleted one names A — but its
    // share may sit on B now (it moved), while the row on A that reads like the line
    // is the OTHER expense's. Kept to A's rows, the line took the namesake's row and
    // left the moved share to be billed a second time (found by review).
    const namesakeOnA = row('A', { amount: 30 });
    const movedToB = row('B', { expenseId: 'yard-again', amount: 12 });
    const held = [line('A', { expenseId: 'yard-before', amount: 12 })];
    const live = new Set(['power', 'yard-again']);
    expect(split([namesakeOnA, movedToB], held, live)).toEqual([
      [movedToB],
      [namesakeOnA]
    ]);
    // with a row of the expense on A as well: one line, three rows it could be for —
    // one is shown (the older of the two at the line's amount), none is billed
    const recreated = row('A', { expenseId: 'yard-again', amount: 12 });
    expect(split([namesakeOnA, recreated, movedToB], held, live)).toEqual([
      [movedToB],
      [namesakeOnA, recreated]
    ]);
  });

  it('a row that is in doubt for one line and covered by another is covered', () => {
    // B's own line (ids, a living expense) comes after the old one in the ledger
    const A = row('A');
    const B = row('B');
    const held = [old({ rentTerm: NOV }), line('B')];
    expect(split([A, B], held)).toEqual([[A, B], []]);
  });

  it('rows of another month, another name or another building are not in doubt', () => {
    const A = row('A');
    expect(
      split(
        [
          A,
          row('B', { month: NOV }),
          row('B', { description: 'Water', expenseId: 'water' }),
          row('B', { buildingName: 'Building 2' })
        ],
        [old()]
      )
    ).toEqual([[A], []]);
  });

  // WHICH row is shown as the billed one changes nothing the tenant pays — the others
  // are not billed either way. It is what the building page says, so it is the
  // likeliest: the exact amount, then a month the tenant held the unit, then a row
  // from before the mark, then the nearest amount, then the oldest.
  describe('which one is shown', () => {
    const shown = (rows, held) => cover(rows, held).map(([r]) => r);

    it('the row with exactly the line’s amount', () => {
      const B = row('B', { amount: 20 });
      const A = row('A', { amount: 30 });
      expect(shown([B, A], [old()])).toEqual([A]);
      // …before «it was there before»: an old row that never reached a rent, next to
      // the row that was billed and has been typed again since
      const lost = row('A', { marked: false, amount: 33 });
      const typedAgain = row('B', { amount: 30 });
      expect(shown([lost, typedAgain], [old()])).toEqual([typedAgain]);
      // …and before «the tenant held the unit»: an exit date recorded after the month
      // was billed
      const left = row('A', { marked: false, amount: 30, held: false });
      const stayed = row('B', { amount: 20 });
      expect(shown([left, stayed], [old()])).toEqual([left]);
    });

    it('then a row of a month the tenant held the unit', () => {
      // the tenant moved from A to B; October was billed for B; both typed again
      const A = row('A', { amount: 50, held: false });
      const B = row('B', { amount: 75 });
      expect(shown([A, B], [old({ amount: 60 })])).toEqual([B]);
      const equalA = row('A', { amount: 30, held: false });
      const equalB = row('B', { amount: 30 });
      expect(shown([equalA, equalB], [old()])).toEqual([equalB]);
      // …before «it was there before»: A's row is from before the mark, but the
      // tenant did not hold A that month
      const before = row('A', { amount: 50, held: false, marked: false });
      expect(shown([before, B], [old({ amount: 60 })])).toEqual([B]);
    });

    it('then a row that was there before the mark existed', () => {
      // A's billed figure was corrected from 30 to 20 (the row keeps its id); B's new
      // share of 28 is nearer the line
      const A = row('A', { marked: false, amount: 20 });
      const B = row('B', { amount: 28 });
      expect(shown([B, A], [old()])).toEqual([A]);
    });

    it('then the nearest amount, then the oldest', () => {
      const B = row('B', { amount: 20 });
      const dearer = row('A', { amount: 36 });
      expect(shown([B, dearer], [old()])).toEqual([dearer]);
      const later = row('A', { expenseId: 'yard' });
      const earlier = row('A', { expenseId: 'yard', created: 'row-0000' });
      expect(shown([later, earlier], [old()])).toEqual([earlier]);
      const one = row('A', { expenseId: 'yard', created: '' });
      const other = row('A', { expenseId: 'yard', created: '' });
      expect(shown([one, other], [old()])).toEqual([one]);
    });
  });
});

describe('in which order', () => {
  it('lines that name their row come first: a name can only take what is left', () => {
    const A = row('A');
    const held = [
      line('', { expenseId: '' }),
      line('A', { rentTerm: NOV })
    ];
    expect(cover([A], held)).toEqual([[A, held[1]]]);
  });

  it('own rows before stand-ins: a line that lost its row cannot take a row that has its own line', () => {
    const B = row('B');
    const C = row('C');
    const held = [line('A'), line('B')];
    expect(cover([B, C], held)).toEqual([
      [B, held[1]],
      [C, held[0]]
    ]);
  });

});

describe('whatever it is given', () => {
  it.each([
    ['no rows', [undefined, [line('A')]]],
    ['no lines', [[row('A')], undefined]],
    ['neither', [[], []]]
  ])('%s: nothing is covered, nothing is in doubt', (_what, [rows, held]) => {
    const { covered, unsure: inDoubt } = coverRows(rows, held, LIVE);
    expect([covered.size, inDoubt.size]).toEqual([0, 0]);
  });

  it('nothing it is given is changed', () => {
    const rows = [row('B'), row('A', { marked: false })];
    const held = [line('A'), line('', { expenseId: '' })];
    const before = JSON.stringify([rows, held]);
    coverRows(rows, held, LIVE);
    expect(JSON.stringify([rows, held])).toBe(before);
  });

  it('never more rows covered than lines, never a line or a row used twice — and no row that an old line could be for is left to be billed (2,000 random cases)', () => {
    let seed = 20261123;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    let inDoubtSeen = 0;
    let freeSeen = 0;
    for (let n = 0; n < 2000; n++) {
      const rows = Array.from({ length: Math.floor(rnd() * 6) }, () =>
        row(pick(['A', 'B', 'C']), {
          expenseId: pick(['power', 'water', 'yard']),
          month: pick([OCT, NOV]),
          marked: rnd() < 0.6,
          held: rnd() < 0.8,
          amount: pick([20, 30, 30, 45]),
          description: pick(['Common power', 'Water'])
        })
      );
      const held = Array.from({ length: Math.floor(rnd() * 6) }, () =>
        line(pick(['A', 'B', 'C', '']), {
          expenseId: pick(['power', 'water', 'gone', '']),
          month: pick([OCT, NOV]),
          description: pick(['Common power', 'Water'])
        })
      );
      const { covered, unsure: inDoubt } = coverRows(rows, held, LIVE);
      const lines = [...covered.values()];
      expect(covered.size).toBeLessThanOrEqual(held.length);
      expect(new Set(lines).size).toBe(lines.length);
      covered.forEach((l, r) => {
        expect(rows).toContain(r);
        expect(held).toContain(l);
        // a line only ever covers a row of its own month
        expect(r.month).toBe(l.month);
        // …of its own expense, or — a line of no living expense — one that reads the same
        if (LIVE.has(l.expenseId)) {
          expect(r.expenseId).toBe(l.expenseId);
        } else if (r.expenseId !== l.expenseId) {
          expect([r.description, r.buildingName]).toEqual([
            l.description,
            l.buildingName
          ]);
        }
        // a row is covered or in doubt, not both
        expect(inDoubt.has(r)).toBe(false);
      });
      inDoubtSeen += inDoubt.size;
      // …and the other way round: a row is covered, or in doubt, only when some line
      // of its month has its expense or reads like it. (A version that withheld every
      // share would pass everything else here.)
      rows.forEach((r) => {
        if (!covered.has(r) && !inDoubt.has(r)) return;
        expect([
          n,
          held.some(
            (l) =>
              l.month === r.month &&
              (l.expenseId === r.expenseId ||
                (l.description === r.description &&
                  l.buildingName === r.buildingName))
          )
        ]).toEqual([n, true]);
      });
      // a row that NO line of its month names by its expense or reads like is free
      rows.forEach((r) => {
        const anyLine = held.some(
          (l) =>
            l.month === r.month &&
            (l.expenseId === r.expenseId ||
              (!LIVE.has(l.expenseId) &&
                l.description === r.description &&
                l.buildingName === r.buildingName))
        );
        if (!anyLine) {
          expect([n, covered.has(r) || inDoubt.has(r)]).toEqual([n, false]);
          freeSeen += 1;
        }
      });
      // THE RULE THE ENGINE RESTS ON, said without the code's own words: take an old
      // line (no living expense, and no row of its month has its expense id) and the
      // rows it could be for (same month, name and building — of its own unit when it
      // names one that has such a row). None of them is left free to be billed.
      held
        .filter(
          (l) =>
            !LIVE.has(l.expenseId) &&
            !(
              l.expenseId &&
              rows.some(
                (r) => r.month === l.month && r.expenseId === l.expenseId
              )
            )
        )
        .forEach((l) => {
          const alike = rows.filter(
            (r) =>
              r.month === l.month &&
              r.description === l.description &&
              r.buildingName === l.buildingName
          );
          const ofUnit = alike.filter((r) => r.propertyId === l.propertyId);
          (l.propertyId && ofUnit.length ? ofUnit : alike).forEach((r) => {
            expect([n, covered.has(r) || inDoubt.has(r)]).toEqual([n, true]);
          });
        });
    }
    // the generator really makes lines that could be for several rows
    expect(inDoubtSeen).toBeGreaterThan(100);
    expect(freeSeen).toBeGreaterThan(1000);
  });
});
