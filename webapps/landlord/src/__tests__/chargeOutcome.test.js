import {
  amountOf,
  monthClosedForAll,
  outcomeView,
  previousTerm,
  unitNameOf
} from '../utils/chargeOutcome';

// What the bill upload window and the Telegram bell say about a tenant's share of a
// saved bill. The server's answer per share (`chargeOutcome`, an entry per unit and
// tenant; services/api/src/managers/chargecarry.ts `ShareOutcome`) is turned into
// what the lists show by these helpers — the same ones for both surfaces.

const OCT = 2026100100;
const NOV = 2026110100;
const DEC = 2026120100;
const share = (extra) => ({
  propertyId: 'pA',
  tenantId: 't1',
  tenantName: 'TENANT ALFA',
  expenseId: 'e1',
  term: OCT,
  amount: 30,
  ...extra
});

describe('one share, as the lists show it', () => {
  it('on its own month’s rent: charged, on that month, nothing more to say', () => {
    expect(
      outcomeView(share({ status: 'billed', billedTerm: OCT, billedAmount: 30 }))
    ).toEqual({
      charged: true,
      term: OCT,
      otherAmount: null,
      why: null,
      paidTerm: null
    });
  });

  it('on the current month because its own is over: charged on that month, no reason under it', () => {
    expect(
      outcomeView(
        share({
          status: 'moved',
          billedTerm: NOV,
          billedAmount: 30,
          reason: 'monthClosed'
        })
      )
    ).toEqual({
      charged: true,
      term: NOV,
      otherAmount: null,
      why: null,
      paidTerm: null
    });
  });

  it('on the month AFTER the one the tenant has paid in full: the paid month is the one before it', () => {
    expect(
      outcomeView(
        share({
          status: 'moved',
          billedTerm: DEC,
          billedAmount: 30,
          reason: 'monthPaid'
        })
      )
    ).toEqual({
      charged: true,
      term: DEC,
      otherAmount: null,
      why: 'monthPaid',
      paidTerm: NOV
    });
    // …across a year's end
    expect(
      outcomeView(
        share({
          status: 'moved',
          billedTerm: 2027010100,
          billedAmount: 30,
          reason: 'monthPaid'
        })
      ).paidTerm
    ).toBe(DEC);
  });

  it('the lease has ended: not charged, and why', () => {
    expect(
      outcomeView(
        share({
          status: 'notCharged',
          billedTerm: null,
          billedAmount: null,
          reason: 'leaseEnded'
        })
      )
    ).toEqual({
      charged: false,
      term: null,
      otherAmount: null,
      why: 'leaseEnded',
      paidTerm: null
    });
  });

  it.each([
    ['a share from before the change', 'notCharged', 'notCarried'],
    ['a share an old line may be for', 'notCharged', 'unclear'],
    ['a share that should be on a rent and is not', 'missing', 'recomputeFailed'],
    ['a status this version does not know', 'somethingNew', 'whatever']
  ])('%s: not charged, and no reason is given', (_what, status, reason) => {
    expect(
      outcomeView(
        share({ status, billedTerm: null, billedAmount: null, reason })
      )
    ).toEqual({
      charged: false,
      term: null,
      otherAmount: null,
      why: null,
      paidTerm: null
    });
  });

  it('the rent holds another amount than the share: that amount is kept, to be shown in brackets', () => {
    const view = (billedAmount, amount = 30) =>
      outcomeView(
        share({ status: 'moved', billedTerm: NOV, billedAmount, amount })
      ).otherAmount;
    expect(view(25)).toBe(25);
    expect(view(30.01)).toBe(30.01);
    expect(view('25')).toBe(25);
    // the same amount, to the cent: nothing in brackets
    expect(view(30)).toBe(null);
    expect(view(30.004)).toBe(null);
    expect(view('30.00')).toBe(null);
    // nothing usable: nothing in brackets (never «NaN €», never «∞ €»)
    expect(view(null)).toBe(null);
    expect(view(undefined)).toBe(null);
    expect(view('abc')).toBe(null);
    expect(view(NaN)).toBe(null);
    expect(view(Infinity)).toBe(null);
    expect(view('1e999')).toBe(null);
    // no figure at all is not «0,00 €» (Number('') and Number(false) are 0)
    expect(view('')).toBe(null);
    expect(view('   ')).toBe(null);
    expect(view(false)).toBe(null);
    expect(view(true)).toBe(null);
    expect(view([])).toBe(null);
    expect(view({})).toBe(null);
    // the share's own amount is no figure: what the rent holds is said all the same
    expect(view(25, null)).toBe(25);
    expect(view(25, 'abc')).toBe(25);
    expect(view(25, '')).toBe(25);
  });

  it.each([
    ['«not charged»', 'notCharged'],
    ['«missing»', 'missing'],
    ['a status this version does not know', 'somethingNew'],
    ['no status', undefined]
  ])('%s that carries a month all the same: not charged — only «billed» and «moved» are on a rent', (_what, status) => {
    expect(
      outcomeView(share({ status, billedTerm: NOV, billedAmount: 30 }))
    ).toEqual({
      charged: false,
      term: null,
      otherAmount: null,
      why: null,
      paidTerm: null
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['«billed» with no month', { status: 'billed', billedTerm: null }],
    ['«moved» with a month that is no number', { status: 'moved', billedTerm: 'abc' }],
    ['a list', []],
    ['text', 'billed']
  ])('%s: reads as not charged, and nothing breaks', (_what, value) => {
    expect(outcomeView(value)).toEqual({
      charged: false,
      term: null,
      otherAmount: null,
      why: null,
      paidTerm: null
    });
  });

  it.each([
    ['a thirteenth month', 2026130100],
    ['zero', 0],
    ['a number that is no month', 5],
    ['text that is no month', '2026-10'],
    ['a list', [OCT]],
    ['true', true],
    ['an object', { term: OCT }],
    // (found by review: text that only BEGINS like a month)
    ['a month followed by letters', '202611abc'],
    ['a term followed by other text', `${NOV}${'x'.repeat(50)}`],
    ['a term followed by thirty more digits', `${NOV}${'0'.repeat(30)}`],
    ['six digits, which is no rent term', 100001]
  ])(
    '«moved» to %s: there is no month to name — not charged (never «✓» with an empty month)',
    (_what, billedTerm) => {
      expect(
        outcomeView(
          share({
            status: 'moved',
            billedTerm,
            billedAmount: 30,
            reason: 'monthPaid'
          })
        )
      ).toEqual({
        charged: false,
        term: null,
        otherAmount: null,
        why: null,
        paidTerm: null
      });
    }
  );

  it('a month given as text is a month', () => {
    expect(
      outcomeView(
        share({ status: 'billed', billedTerm: '2026100100', billedAmount: 30 })
      )
    ).toEqual({
      charged: true,
      term: OCT,
      otherAmount: null,
      why: null,
      paidTerm: null
    });
    // …with a space before it or after it, the same month either way
    [' 2026100100', '2026100100 '].forEach((billedTerm) => {
      expect(
        outcomeView(share({ status: 'billed', billedTerm, billedAmount: 30 }))
          .term
      ).toBe(OCT);
    });
  });

  it('on the month after one that no term can name: charged on that month, and nothing is said about a paid month', () => {
    // (January of the year 1000: the month before it is in the year 999)
    expect(
      outcomeView(
        share({
          status: 'moved',
          billedTerm: 1000010100,
          billedAmount: 30,
          reason: 'monthPaid'
        })
      )
    ).toEqual({
      charged: true,
      term: 1000010100,
      otherAmount: null,
      why: null,
      paidTerm: null
    });
  });
});

describe('«the month is closed for the tenants»', () => {
  const moved = { status: 'moved', billedTerm: NOV };
  const ended = { status: 'notCharged', reason: 'leaseEnded' };
  const own = { status: 'billed', billedTerm: OCT };

  it('true when every share went on a later rent, or reached none because its tenant’s lease has ended — and at least one did go on a later rent', () => {
    expect(monthClosedForAll([moved, moved, ended])).toBe(true);
    expect(monthClosedForAll([moved])).toBe(true);
  });

  it('not when one share IS on the bill’s own month: the month is not closed for that tenant', () => {
    expect(monthClosedForAll([moved, own])).toBe(false);
    expect(monthClosedForAll([own])).toBe(false);
  });

  it('not when nothing went on a later rent: «each share went on the next open rent» would not be true', () => {
    expect(monthClosedForAll([ended, ended])).toBe(false);
    expect(monthClosedForAll([{ status: 'missing' }])).toBe(false);
  });

  it.each([
    [
      'should be on a rent and is not',
      { status: 'missing', reason: 'recomputeFailed' }
    ],
    [
      'may be what an old line is for',
      { status: 'notCharged', reason: 'unclear' }
    ],
    ['is from before the change', { status: 'notCharged', reason: 'notCarried' }],
    ['is not charged, with no reason given', { status: 'notCharged' }],
    ['has a status this version does not know', { status: 'somethingNew' }],
    [
      'is «missing» and only says the lease has ended',
      { status: 'missing', reason: 'leaseEnded' }
    ]
  ])(
    'not next to a share that %s: «each share went on the next open rent» would not be true of it',
    (_what, other) => {
      expect(monthClosedForAll([moved, other])).toBe(false);
      expect(monthClosedForAll([moved, moved, other, ended])).toBe(false);
    }
  );

  it('a «moved» share that names no month is not known to have gone on a later rent', () => {
    const nowhere = { status: 'moved', billedTerm: 2026130100 };
    expect(monthClosedForAll([nowhere])).toBe(false);
    expect(monthClosedForAll([nowhere, ended])).toBe(false);
    expect(monthClosedForAll([moved, nowhere])).toBe(false);
    expect(
      monthClosedForAll([{ status: 'moved', billedTerm: '202611abc' }])
    ).toBe(false);
  });

  it('an empty entry is not listed, and does not count either way', () => {
    // (the list leaves it out: the sentence is about the shares that are listed)
    expect(monthClosedForAll([moved, null])).toBe(true);
    expect(monthClosedForAll([moved, undefined, ended])).toBe(true);
    expect(monthClosedForAll([null])).toBe(false);
    expect(monthClosedForAll([null, ended])).toBe(false);
  });

  it.each([[[]], [null], [undefined], ['moved'], [{ status: 'moved' }]])(
    'no list of shares (%p): false',
    (value) => {
      expect(monthClosedForAll(value)).toBe(false);
    }
  );
});

describe('the month before a month', () => {
  it.each([
    [DEC, NOV],
    [2027010100, DEC],
    ['2026030100', 2026020100],
    [2026031523, 2026020100]
  ])('%p → %p', (term, before) => {
    expect(previousTerm(term)).toBe(before);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['abc'],
    [0],
    [202613],
    // (the month before it is in the year 999: no term says that)
    [1000010100],
    [100001]
  ])(
    'no month to name (%p): null',
    (term) => {
      expect(previousTerm(term)).toBe(null);
    }
  );
});

describe('the name a unit goes by', () => {
  const building = {
    units: [
      { propertyId: 'pA', name: 'A1', property: { name: 'Διαμέρισμα Α' } },
      { propertyId: 'pB', name: 'B1' },
      { propertyId: 'pC' },
      null,
      { name: 'not linked to a property' }
    ]
  };

  it('the property’s name, as on the building page; else the unit’s own; else nothing', () => {
    expect(unitNameOf(building, 'pA')).toBe('Διαμέρισμα Α');
    expect(unitNameOf(building, 'pB')).toBe('B1');
    expect(unitNameOf(building, 'pC')).toBe('');
  });

  it('an id that is not text is compared as text', () => {
    expect(
      unitNameOf({ units: [{ propertyId: { toString: () => 'pA' }, name: 'A1' }] }, 'pA')
    ).toBe('A1');
  });

  it.each([
    ['a unit the building does not have', building, 'pZ'],
    ['no building', undefined, 'pA'],
    ['a building with no units', {}, 'pA'],
    ['no id', building, undefined],
    ['an empty id', building, ''],
    ['a null id', building, null]
  ])('%s: nothing, and nothing breaks', (_what, b, id) => {
    expect(unitNameOf(b, id)).toBe('');
  });
});

describe('an amount that can be shown', () => {
  it('minus zero is zero (never «-0,00 €»)', () => {
    expect(Object.is(amountOf(-0), 0)).toBe(true);
    expect(Object.is(amountOf('-0'), 0)).toBe(true);
    expect(Object.is(amountOf('-0.00'), 0)).toBe(true);
  });

  it.each([
    [30, 30],
    [0, 0],
    [-5.5, -5.5],
    ['30', 30],
    ['30.50', 30.5],
    [' 12 ', 12]
  ])('%p → %p', (value, shown) => {
    expect(amountOf(value)).toBe(shown);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['   '],
    ['abc'],
    ['12,50'],
    [NaN],
    [Infinity],
    [-Infinity],
    ['1e999'],
    // (plain decimal text only: not what `Number()` would make of these)
    ['1e3'],
    ['0x10'],
    // (digits, but too many to be a number)
    ['9'.repeat(400)],
    [true],
    [false],
    [[]],
    [[30]],
    [{}]
  ])(
    'no figure (%p): null — shown as «—», never as «0,00 €» or «NaN €»',
    (value) => {
      expect(amountOf(value)).toBe(null);
    }
  );
});
