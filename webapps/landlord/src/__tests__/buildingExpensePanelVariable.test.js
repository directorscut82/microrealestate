/**
 * BuildingExpensePanel — the κυμαινόμενο decision, exhaustively.
 *
 * WHY THIS EXISTS. This panel is the ONLY surface where a monthly variable amount
 * can be typed, and it is the one rendered on the building page
 * (pages/[organization]/buildings/[id].js:249). It carried TWO hand-written copies
 * of the "is this expense variable?" rule, so the explicit `isVariable` flag added
 * 2026-08-12 had no effect here at all. The commit that shipped the flag claimed
 * "one shared rule read by every surface" and its docstring counted three
 * hand-written copies; there were five, and the two that mattered most were missed.
 *
 * Three defects were live as a result:
 *
 *  1. `{isVariable: true, amount: 120}` — flagged variable WITH an amount. The old
 *     inference said "fixed", so the panel showed a read-only «120,00 €» and added
 *     120 to the month total, while the ΧΡΕΩΣΕΙΣ breakdown underneath (computed by
 *     the server, which honours the persisted per-term charge) showed the real
 *     figure. One screen, two contradicting numbers.
 *  2. `{isVariable: false, amount: 0}` — the UNFINISHED expense the flag exists to
 *     distinguish. The old inference called it variable and gave it an input.
 *  3. `{allocationMethod: 'fixed', amount: 0, customAllocations: [40, 40]}` — the
 *     rent engine bills €80 for this (1_base.ts exempts `fixed` from its
 *     `total <= 0` skip), but the panel read `amount` alone, called it variable,
 *     showed a blank input and contributed 0 to the month total. It said "nothing
 *     entered yet" about money already on the tenants' rents.
 *
 * And fixing (1) and (3) exposed a regression in the fix itself: routing through
 * the predicate correctly stops calling (2) variable, and the `else if (fixedAmount)`
 * branch then dropped it — so the unfinished expense vanished from the panel
 * entirely. That is the `expense.isVariable === false` clause, and the test named
 * "an unfinished expense stays VISIBLE" is the one that fails without it.
 */
import {
  buildRowsForTerm,
  termsWithData
} from '../components/buildings/BuildingExpensePanel';

const TERM = '2026080100';
const START = 2026010100;

/** A building carrying exactly one expense, with no persisted charges. */
const withExpense = (expense, units = []) => ({
  _id: 'b1',
  name: 'ΟΔΟΣ ΑΛΦΑ 24',
  units,
  expenses: [{ _id: 'e1', name: 'ΔΕΗ', type: 'electricity_common', ...expense }],
  ownerMonthlyExpenses: []
});

const base = { isRecurring: true, startTerm: START };

const rowsFor = (expense, units) =>
  buildRowsForTerm(withExpense(expense, units), TERM, false);
const ownerRowsFor = (expense) =>
  buildRowsForTerm(withExpense(expense), TERM, true);

describe('the explicit isVariable flag decides, in BOTH directions', () => {
  it('isVariable:true with an amount set is VARIABLE (an editable input)', () => {
    // Defect 1. The old `isRecurring && !fixedAmount` said fixed → read-only 120
    // on screen and +120 to the month total, against a breakdown showing the real
    // charge. The flag is explicit; it wins.
    const rows = rowsFor({ ...base, isVariable: true, amount: 120 });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('variable');
    // No persisted charge for this term → the input is EMPTY, not pre-filled with
    // the 120 that is charged to nobody.
    expect(rows[0].amount).toBe('');
  });

  it('isVariable:false at €0 is NOT variable (no input)', () => {
    // Defect 2.
    const rows = rowsFor({ ...base, isVariable: false, amount: 0 });
    expect(rows[0].kind).not.toBe('variable');
  });

  it('an unfinished expense stays VISIBLE — it must not vanish', () => {
    // THE REGRESSION THE FIX ITSELF INTRODUCED. `else if (fixedAmount)` is falsy
    // at 0, so once the predicate correctly stops calling this variable the row
    // was dropped and the expense disappeared from the panel altogether — the
    // landlord could no longer see the expense they had half-created.
    const rows = rowsFor({ ...base, isVariable: false, amount: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('fixed');
    expect(rows[0].amount).toBe(0);
    expect(rows[0].name).toBe('ΔΕΗ');
  });

  it('isVariable:true at €0 is variable (the ordinary κυμαινόμενο)', () => {
    const rows = rowsFor({ ...base, isVariable: true, amount: 0 });
    expect(rows[0].kind).toBe('variable');
  });
});

describe('legacy rows (isVariable absent) behave exactly as before', () => {
  // The fallback is not optional: every expense created before the flag has
  // isVariable === undefined, including the landlord's real
  // «Πετρέλαιο (κυμαινόμενο)» rows.
  it('recurring at €0 is variable', () => {
    expect(rowsFor({ ...base, amount: 0 })[0].kind).toBe('variable');
  });

  it('recurring with an amount is fixed, at that amount', () => {
    const rows = rowsFor({ ...base, amount: 120 });
    expect(rows[0]).toMatchObject({ kind: 'fixed', amount: 120 });
  });

  it('NON-recurring at €0 still yields no row (unchanged)', () => {
    // Pre-existing behaviour, deliberately preserved: the isVariable===false
    // clause is what makes the unfinished expense visible, and a non-recurring
    // €0 expense carries no flag.
    expect(rowsFor({ isRecurring: false, startTerm: START, amount: 0 })).toEqual(
      []
    );
  });

  it('an expense outside its active term yields no row', () => {
    expect(
      rowsFor({ ...base, amount: 120, startTerm: 2026090100 })
    ).toEqual([]);
  });
});

describe("a `fixed` allocation's money lives in customAllocations, not in amount", () => {
  const fixedExpense = {
    ...base,
    amount: 0,
    allocationMethod: 'fixed',
    customAllocations: [
      { propertyId: 'p1', value: 40 },
      { propertyId: 'p2', value: 40 }
    ]
  };

  it('is NOT variable, and shows the €80 the engine actually bills', () => {
    // Defect 3. `1_base.ts` exempts `fixed` from its `total <= 0` skip, so these
    // €80 are on the tenants' rents. The panel used to call this variable, render
    // a blank input and contribute 0 — «nothing entered yet» about billed money.
    const rows = rowsFor(fixedExpense);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'fixed', amount: 80 });
  });

  it('a fixed allocation summing to 0 is still variable (nothing is billed)', () => {
    const rows = rowsFor({
      ...fixedExpense,
      customAllocations: [{ propertyId: 'p1', value: 0 }]
    });
    expect(rows[0].kind).toBe('variable');
  });

  it('tolerates a missing / malformed customAllocations without throwing', () => {
    for (const customAllocations of [undefined, null, [], [null], [{}], ['x']]) {
      const rows = rowsFor({ ...fixedExpense, customAllocations });
      expect({
        customAllocations,
        kind: rows[0]?.kind
      }).toEqual({ customAllocations, kind: 'variable' });
    }
  });
});

describe('the owner side reads ownerAmount, never the tenant amount', () => {
  it('a legacy owner-tracked row with amount 100 / ownerAmount 0 stays variable', () => {
    // If the owner side fell back to `expense.amount`, the predicate would call
    // this fixed and the owner variable input would DISAPPEAR — every legacy
    // trackOwnerExpense row.
    const rows = ownerRowsFor({
      ...base,
      trackOwnerExpense: true,
      amount: 100,
      ownerAmount: 0
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'variable', isOwner: true });
  });

  it('an owner-tracked row with an ownerAmount is fixed at THAT figure', () => {
    const rows = ownerRowsFor({
      ...base,
      trackOwnerExpense: true,
      amount: 100,
      ownerAmount: 30
    });
    expect(rows[0]).toMatchObject({ kind: 'fixed', amount: 30 });
  });

  it('the owner side ignores expenses that do not track the owner', () => {
    expect(ownerRowsFor({ ...base, amount: 100 })).toEqual([]);
  });

  it("a fixed allocation does NOT leak into the owner side's cost", () => {
    // Σ customAllocations is a TENANT-side figure. Resolving it on the owner side
    // would bill the owner the tenants' split.
    const rows = ownerRowsFor({
      ...base,
      trackOwnerExpense: true,
      amount: 0,
      ownerAmount: 0,
      allocationMethod: 'fixed',
      customAllocations: [{ propertyId: 'p1', value: 40 }]
    });
    expect(rows[0].kind).toBe('variable');
  });
});

describe('calendar dots — termsWithData', () => {
  it('a variable expense does NOT dot every active month', () => {
    // The deliberate behaviour this panel documents: a dot means "something was
    // actually charged". Projecting variable expenses would dot every active month
    // unconditionally and destroy the filled-vs-blank signal.
    const terms = termsWithData(withExpense({ ...base, isVariable: true, amount: 0 }));
    expect(terms.size).toBe(0);
  });

  it('...not even when it carries an amount (the flag is explicit)', () => {
    // Before the fix, this copy's own inference (`!amount && !ownerAmount`) called
    // an isVariable:true row with an amount NON-variable and dotted every month.
    const terms = termsWithData(
      withExpense({ ...base, isVariable: true, amount: 120 })
    );
    expect(terms.size).toBe(0);
  });

  it('a fixed expense dots its active months', () => {
    const terms = termsWithData(withExpense({ ...base, amount: 120 }));
    expect(terms.has(TERM)).toBe(true);
  });

  it('a `fixed` allocation at amount 0 keeps its dots', () => {
    // It bills real money, so its months are not blank.
    const terms = termsWithData(
      withExpense({
        ...base,
        amount: 0,
        allocationMethod: 'fixed',
        customAllocations: [{ propertyId: 'p1', value: 40 }]
      })
    );
    expect(terms.has(TERM)).toBe(true);
  });

  it('a persisted monthlyCharge dots its month regardless of expense shape', () => {
    const terms = termsWithData(
      withExpense({ ...base, isVariable: true, amount: 0 }, [
        { _id: 'u1', monthlyCharges: [{ term: Number(TERM), amount: 62.4 }] }
      ])
    );
    expect(terms.has(TERM)).toBe(true);
  });

  it('survives a null / non-object expense without throwing', () => {
    const building = withExpense({ ...base, amount: 120 });
    building.expenses.push(null, 42, 'x');
    expect(() => termsWithData(building)).not.toThrow();
    expect(() => buildRowsForTerm(building, TERM, false)).not.toThrow();
  });
});

/**
 * THE OWNER AMOUNT OF A MONTH IS WHAT WAS ENTERED FOR IT — AND NOTHING ELSE.
 *
 * Found on 24/11/2026 while rehearsing a correction on a copy of the real data. An
 * owner-tracked expense with no fixed owner amount (the heating of two buildings) gets
 * an input under «Ιδιοκτήτες». The panel pre-filled it with `ownerEntries.find(term,
 * expenseId).amount` — the FIRST owner entry of the month that names the expense, of
 * ANY kind. In a month with an empty apartment that entry is the apartment's own share
 * (`source: 'vacant'`), so the input read «100», the «Ιδιοκτήτες» total was 100 too
 * high, and the next «Αποθήκευση» sent it as the building's owner amount: the server
 * split it over the five apartments as new owner charges (20 € each). The next save
 * then read ONE of those rows back (20) and split that (4 € each) — and so on.
 *
 * What the statement save writes for an entered owner amount is `source: 'expense'`
 * rows (one per apartment; one building-wide row before the per-apartment split;
 * rows from before `source` existed carry none). Their sum is the amount entered
 * whenever the split hands out the whole amount — every allocation but custom shares
 * that cover less than 100% (MONEY_SURFACE_MATRIX: the typed owner amount is not
 * stored yet; that case still reads back less than was typed).
 */
describe('the owner amount of a month is what was entered for it, and nothing else', () => {
  const tracked = {
    ...base,
    amount: 0,
    trackOwnerExpense: true,
    ownerAmount: 0
  };
  const ownerRow = (ownerMonthlyExpenses) =>
    buildRowsForTerm(
      { ...withExpense(tracked), ownerMonthlyExpenses },
      TERM,
      true
    )[0];
  const entry = (extra) => ({
    expenseId: 'e1',
    term: Number(TERM),
    amount: 100,
    propertyId: 'p1',
    ...extra
  });
  const perApartment = (amount, n = 5) =>
    Array.from({ length: n }, (_, i) =>
      entry({ source: 'expense', amount, propertyId: `p${i + 1}` })
    );

  it('nothing entered: the input is blank', () => {
    expect(ownerRow([])).toMatchObject({
      kind: 'variable',
      amount: '',
      isOwner: true
    });
  });

  it.each([
    ['the share of an empty apartment', 'vacant'],
    ['a fixed owner amount', 'owner-fixed'],
    ['the share of an apartment its owner lives in', 'owner-resident'],
    ['a credit that keeps a payment', 'credit'],
    ['a repair', 'repair'],
    ['the share of a repair on an empty apartment', 'repair-vacant'],
    ['an entry of a kind this version does not know', 'somethingNew']
  ])(
    '%s names the expense too, and is NOT an entered amount: the input stays blank',
    (_what, source) => {
      expect(ownerRow([entry({ source })]).amount).toBe('');
      expect(
        ownerRow([
          entry({ source }),
          entry({ source, propertyId: 'p2' }),
          entry({ source, propertyId: 'p3' })
        ]).amount
      ).toBe('');
    }
  );

  it('entered, and split over five apartments: the amount that was entered — not one apartment’s share', () => {
    expect(ownerRow(perApartment(20)).amount).toBe(100);
  });

  it('…whatever else of the month names the expense: empty apartments’ shares and a credit are not added', () => {
    expect(
      ownerRow([
        entry({ source: 'vacant', amount: 77, propertyId: 'p3' }),
        ...perApartment(20),
        entry({ source: 'credit', amount: 0, propertyId: null }),
        entry({ source: 'vacant', amount: 77, propertyId: 'p4' })
      ]).amount
    ).toBe(100);
  });

  it.each([
    ['with its kind written', { source: 'expense' }],
    ['from before entries said their kind', {}]
  ])(
    'an amount saved as one building-wide entry, %s: that amount',
    (_what, extra) => {
      expect(
        ownerRow([entry({ ...extra, amount: 60, propertyId: null })]).amount
      ).toBe(60);
    }
  );

  it('shares that do not divide evenly add back to the cent', () => {
    expect(
      ownerRow([
        entry({ source: 'expense', amount: 33.33, propertyId: 'p1' }),
        entry({ source: 'expense', amount: 33.33, propertyId: 'p2' }),
        entry({ source: 'expense', amount: 33.34, propertyId: 'p3' })
      ]).amount
    ).toBe(100);
    expect(ownerRow(perApartment(0.1, 3)).amount).toBe(0.3);
  });

  it('entries of another month, or of another expense, are not this month’s amount', () => {
    expect(
      ownerRow([
        entry({ source: 'expense', term: 2026070100 }),
        entry({ source: 'expense', expenseId: 'e2' })
      ]).amount
    ).toBe('');
    expect(
      ownerRow([
        entry({ source: 'expense', term: 2026070100 }),
        ...perApartment(20),
        entry({ source: 'expense', expenseId: 'e2' })
      ]).amount
    ).toBe(100);
  });

  it('a month stored as text is the same month', () => {
    expect(
      ownerRow(perApartment(20).map((e) => ({ ...e, term: TERM }))).amount
    ).toBe(100);
  });

  it.each([[null], [undefined], ['abc'], [NaN], [{}]])(
    'an entry whose amount is %p adds nothing (and breaks nothing)',
    (amount) => {
      expect(
        ownerRow([
          ...perApartment(20, 2),
          entry({ source: 'expense', amount, propertyId: 'p9' })
        ]).amount
      ).toBe(40);
    }
  );

  it('an empty slot among the entries breaks nothing', () => {
    expect(ownerRow([null, ...perApartment(20), undefined]).amount).toBe(100);
    expect(ownerRow([null]).amount).toBe('');
  });

  it('the fixed owner amount of an expense is still that expense’s own figure, whatever the month holds', () => {
    const rows = buildRowsForTerm(
      {
        ...withExpense({ ...tracked, ownerAmount: 30 }),
        ownerMonthlyExpenses: perApartment(20)
      },
      TERM,
      true
    );
    expect(rows[0]).toMatchObject({ kind: 'fixed', amount: 30 });
  });
});
