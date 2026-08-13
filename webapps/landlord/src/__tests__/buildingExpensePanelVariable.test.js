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
