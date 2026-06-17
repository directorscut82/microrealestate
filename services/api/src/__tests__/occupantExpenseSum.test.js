/* eslint-env node, jest */
/**
 * Round-2 audit H1 + L5: toOccupantData's property expense summary.
 *  H1 — one expense with undefined amount made the reduce produce NaN, and
 *       `(length && NaN) || 0` collapsed the WHOLE property's expense sum to €0
 *       (Overview under-stated vs the ledger).
 *  L5 — a property entry lacking the `expenses` key (legacy/mongo-seed) crashed
 *       the date-format forEach → 500 + blank tenant page.
 */
import { jest } from '@jest/globals';
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

  // Round-2 audit M1: the recurring-Total figure must WINDOW each expense by
  // its [beginDate,endDate] like the engine — a past/out-of-window one-time or
  // sub-period expense must NOT inflate it every month.
  describe('M1: expense begin/end window', () => {
    const FAR_PAST = '2020-01-01';
    const FAR_FUTURE = '2099-12-31';

    it('drops an expense whose window ENDED before now (one-time, past)', () => {
      const occ = toOccupantData(
        baseOccupant([
          {
            entryDate: new Date(FAR_PAST),
            exitDate: new Date(FAR_FUTURE),
            rent: 500,
            property: { name: 'apt', type: 'apartment', surface: 50, price: 500 },
            expenses: [
              { title: 'recurring', amount: 100 }, // no window → entry/exit → active
              // a one-time charge for Jan 2021 only — long past
              { title: 'past-once', amount: 999, beginDate: new Date('2021-01-01'), endDate: new Date('2021-01-31') }
            ]
          }
        ])
      );
      // Only the recurring 100 counts; the past 999 is windowed out.
      expect(occ.expenses).toBe(100);
    });

    it('drops an expense whose window STARTS in the far future', () => {
      const occ = toOccupantData(
        baseOccupant([
          {
            entryDate: new Date(FAR_PAST),
            exitDate: new Date(FAR_FUTURE),
            rent: 500,
            property: { name: 'apt', type: 'apartment', surface: 50, price: 500 },
            expenses: [
              { title: 'recurring', amount: 100 },
              { title: 'future', amount: 50, beginDate: new Date('2099-01-01'), endDate: new Date('2099-12-31') }
            ]
          }
        ])
      );
      expect(occ.expenses).toBe(100);
    });

    it('keeps an expense whose window covers now + one with no window', () => {
      const occ = toOccupantData(
        baseOccupant([
          {
            entryDate: new Date(FAR_PAST),
            exitDate: new Date(FAR_FUTURE),
            rent: 500,
            property: { name: 'apt', type: 'apartment', surface: 50, price: 500 },
            expenses: [
              { title: 'no-window', amount: 100 },
              { title: 'covers-now', amount: 40, beginDate: new Date(FAR_PAST), endDate: new Date(FAR_FUTURE) }
            ]
          }
        ])
      );
      expect(occ.expenses).toBe(140);
    });

    // Step-7 R2-M1: the window must be MONTH-granular (matching the engine's
    // isBetween(...,'months','[]')), not day-granular — else an expense that
    // starts/ends mid-CURRENT-month is wrongly dropped though the engine bills
    // it for the whole month.
    describe('month-granularity (not day) — system time pinned to the 18th', () => {
      afterEach(() => jest.useRealTimers());

      it('KEEPS an expense that starts later this month (begin=20th, today=18th)', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-06-18T12:00:00Z'));
        const occ = toOccupantData(
          baseOccupant([
            {
              entryDate: new Date('2020-01-01'),
              exitDate: new Date('2099-12-31'),
              rent: 500,
              property: { name: 'apt', type: 'apartment', surface: 50, price: 500 },
              expenses: [
                { title: 'recurring', amount: 100 },
                // begins the 20th of THIS month — engine bills it for June.
                { title: 'mid-month-start', amount: 40, beginDate: new Date('2026-06-20'), endDate: new Date('2099-12-31') }
              ]
            }
          ])
        );
        expect(occ.expenses).toBe(140);
      });

      it('KEEPS an expense that ended earlier this month (end=10th, today=18th)', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-06-18T12:00:00Z'));
        const occ = toOccupantData(
          baseOccupant([
            {
              entryDate: new Date('2020-01-01'),
              exitDate: new Date('2099-12-31'),
              rent: 500,
              property: { name: 'apt', type: 'apartment', surface: 50, price: 500 },
              expenses: [
                { title: 'recurring', amount: 100 },
                // ended the 10th of THIS month — engine still bills June (end month, inclusive).
                { title: 'mid-month-end', amount: 25, beginDate: new Date('2026-01-01'), endDate: new Date('2026-06-10') }
              ]
            }
          ])
        );
        expect(occ.expenses).toBe(125);
      });

      it('DROPS an expense that ended LAST month (end=May, today=June 18th)', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-06-18T12:00:00Z'));
        const occ = toOccupantData(
          baseOccupant([
            {
              entryDate: new Date('2020-01-01'),
              exitDate: new Date('2099-12-31'),
              rent: 500,
              property: { name: 'apt', type: 'apartment', surface: 50, price: 500 },
              expenses: [
                { title: 'recurring', amount: 100 },
                { title: 'ended-last-month', amount: 25, beginDate: new Date('2026-01-01'), endDate: new Date('2026-05-31') }
              ]
            }
          ])
        );
        expect(occ.expenses).toBe(100);
      });
    });
  });
});
