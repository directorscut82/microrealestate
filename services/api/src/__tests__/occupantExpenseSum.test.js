/* eslint-env node, jest */
/**
 * Round-2 audit H1 + L5: toOccupantData's property expense summary.
 *  H1 — one expense with undefined amount made the reduce produce NaN, and
 *       `(length && NaN) || 0` collapsed the WHOLE property's expense sum to €0
 *       (Overview under-stated vs the ledger).
 *  L5 — a property entry lacking the `expenses` key (legacy/mongo-seed) crashed
 *       the date-format forEach → 500 + blank tenant page.
 */
import { toOccupantData } from '../managers/frontdata.js';

const baseOccupant = (properties) => ({
  _id: 't1',
  name: 'T',
  isCompany: false,
  contacts: [],
  rents: [],
  discount: 0,
  vatRatio: 0,
  properties
});

describe('toOccupantData property expense sum (H1 / L5)', () => {
  it('H1: a property with one undefined-amount expense still sums the rest (not €0)', () => {
    const occ = toOccupantData(
      baseOccupant([
        {
          entryDate: new Date('2026-01-01'),
          exitDate: new Date('2026-12-31'),
          rent: 500,
          property: { name: 'apt', type: 'apartment', surface: 50, price: 500 },
          expenses: [
            { title: 'fee-a', amount: 100 },
            { title: 'legacy' /* no amount */ },
            { title: 'fee-b', amount: 30 }
          ]
        }
      ])
    );
    // 100 + 0 + 30 = 130 — NOT 0 (the NaN-collapse bug).
    expect(occ.expenses).toBe(130);
  });

  it('L5: a property with NO expenses key does not crash (renders, expenses 0)', () => {
    expect(() =>
      toOccupantData(
        baseOccupant([
          {
            entryDate: new Date('2026-01-01'),
            exitDate: new Date('2026-12-31'),
            rent: 500,
            property: { name: 'apt', type: 'apartment', surface: 50, price: 500 }
            // no expenses key
          }
        ])
      )
    ).not.toThrow();
  });

  it('clean case: all amounts present → exact sum (regression guard)', () => {
    const occ = toOccupantData(
      baseOccupant([
        {
          entryDate: new Date('2026-01-01'),
          exitDate: new Date('2026-12-31'),
          rent: 500,
          property: { name: 'apt', type: 'apartment', surface: 50, price: 500 },
          expenses: [
            { title: 'a', amount: 80 },
            { title: 'b', amount: 20 }
          ]
        }
      ])
    );
    expect(occ.expenses).toBe(100);
  });
});
