/* eslint-env node, jest */
/**
 * #2 — tenant import "mark all past months paid" fix (Contract.create
 * autoPayThroughTerm), against the REAL engine.
 *
 * THE BUG (proven live + by probe): the old client PATCH loop paid each past
 * month its CUMULATIVE grandTotal (200, 400, 600 … for a 200/mo tenant, because
 * 5_balance carries prev.grandTotal forward), recording Σ 15.600 collected for a
 * tenant that should total 2.400 — the ΟΔΟΣ ΗΤΑ 24 garbage numbers.
 *
 * THE FIX: seed the past ledger already-settled AT GENERATION. Contract.create
 * gains an optional autoPayThroughTerm directive: every term strictly before it
 * with grandTotal>0 is generated with a settlement of its OWN single-month bill,
 * so 5_balance for the next term computes prev.grandTotal − prev.payment = 0 —
 * no cumulative carry-in ever forms. The freeze (payTerm/update) is untouched.
 *
 * These assertions run the actual businesslogic pipeline (no mocks needed —
 * same plain-import pattern as contract.test.js / contract-freeze-past-unpaid).
 */
import * as Contract from '../managers/contract.js';
import moment from 'moment';

const RENT = 200;
// 12-month lease ending last month → all 12 terms are PAST.
const nowM = moment.utc().startOf('month');
const beginM = nowM.clone().subtract(12, 'months');
const endM = nowM.clone().subtract(1, 'months');
const currentTerm = Number(nowM.format('YYYYMMDDHH'));

function baseInput(extra = {}) {
  return {
    begin: beginM.toDate().getTime(),
    end: endM.clone().endOf('month').toDate().getTime(),
    frequency: 'months',
    properties: [
      {
        entryDate: beginM.toDate().getTime(),
        exitDate: endM.clone().endOf('month').toDate().getTime(),
        property: { name: 'unit', price: RENT },
        rent: RENT,
        expenses: []
      }
    ],
    rents: [],
    ...extra
  };
}

describe('Contract.create autoPayThroughTerm (import mark-past-paid)', () => {
  it('seeds every past month PAID with its own single-month bill — no cumulative snowball', () => {
    const c = Contract.create(baseInput({ autoPayThroughTerm: currentTerm }));
    expect(c.rents.length).toBe(12);

    let totalPaid = 0;
    for (const r of c.rents) {
      // every past month: paid its own bill, balance 0, grandTotal collapsed
      expect(r.total.balance).toBeCloseTo(0, 2);
      expect(r.total.grandTotal).toBeCloseTo(RENT, 2);
      expect(r.total.payment).toBeCloseTo(RENT, 2);
      totalPaid += r.total.payment;
    }
    // Σ collected == 12 months of rent (2.400), NOT the cumulative 15.600.
    expect(totalPaid).toBeCloseTo(RENT * 12, 2);
  });

  it('WITHOUT the directive, produces the (cumulative) baseline ledger — proves zero change for every other caller', () => {
    const c = Contract.create(baseInput()); // no autoPayThroughTerm
    // Baseline: unpaid, so balance snowballs (grandTotal = k×rent) and payment 0.
    expect(c.rents[0].total.grandTotal).toBeCloseTo(RENT, 2);
    expect(c.rents[0].total.balance).toBeCloseTo(0, 2);
    expect(c.rents[11].total.grandTotal).toBeCloseTo(RENT * 12, 2);
    expect(c.rents[11].total.balance).toBeCloseTo(RENT * 11, 2);
    c.rents.forEach((r) => expect(r.total.payment).toBeCloseTo(0, 2));
  });

  it('leaves the CURRENT and FUTURE terms unpaid (only strictly-past terms are seeded)', () => {
    // Lease spanning 3 past + current + 2 future months.
    const b = nowM.clone().subtract(3, 'months');
    const e = nowM.clone().add(2, 'months');
    const c = Contract.create({
      begin: b.toDate().getTime(),
      end: e.clone().endOf('month').toDate().getTime(),
      frequency: 'months',
      properties: [
        {
          entryDate: b.toDate().getTime(),
          exitDate: e.clone().endOf('month').toDate().getTime(),
          property: { name: 'unit', price: RENT },
          rent: RENT,
          expenses: []
        }
      ],
      rents: [],
      autoPayThroughTerm: currentTerm
    });
    for (const r of c.rents) {
      if (r.term < currentTerm) {
        expect(r.total.payment).toBeCloseTo(RENT, 2); // past → paid
        expect(r.total.balance).toBeCloseTo(0, 2);
      } else {
        expect(r.total.payment).toBeCloseTo(0, 2); // current+future → unpaid
      }
    }
  });

  it('does not double-pay: each past month payment == its own bill, never the carried grandTotal', () => {
    const c = Contract.create(baseInput({ autoPayThroughTerm: currentTerm }));
    // The 12th month, had it been paid cumulatively, would show payment 2400.
    // With the fix it must be exactly one month's rent.
    expect(c.rents[11].total.payment).toBeCloseTo(RENT, 2);
    expect(c.rents[11].total.payment).not.toBeCloseTo(RENT * 12, 0);
  });

  // Step-7 coverage note: 'weeks'/'years' terms are NOT startOf-normalized in
  // taskBase, but the paid-gate compares rent.term < autoPayThroughTerm where
  // autoPayThroughTerm == startOf(freq) of NOW, so the partition (past vs
  // current/future) is exact regardless of normalization, and snowball
  // prevention is positional (via previousRent), not term-based. This weekly
  // case pins that: a WEEKLY lease with past weeks seeded paid, current week
  // left open, no cumulative carry.
  it('weekly frequency: past weeks seeded paid (balance 0), current week left unpaid', () => {
    const wNow = moment.utc().startOf('weeks');
    const wBegin = wNow.clone().subtract(6, 'weeks'); // 6 past weeks + current
    const wEnd = wNow.clone(); // through the current week
    const WRENT = 70;
    const autoPayThroughWeek = Number(wNow.format('YYYYMMDDHH'));
    const c = Contract.create({
      begin: wBegin.toDate().getTime(),
      end: wEnd.clone().endOf('week').toDate().getTime(),
      frequency: 'weeks',
      properties: [
        {
          entryDate: wBegin.toDate().getTime(),
          exitDate: wEnd.clone().endOf('week').toDate().getTime(),
          property: { name: 'unit', price: WRENT },
          rent: WRENT,
          expenses: []
        }
      ],
      rents: [],
      autoPayThroughTerm: autoPayThroughWeek
    });
    let pastCount = 0;
    for (const r of c.rents) {
      if (r.term < autoPayThroughWeek) {
        // past week → seeded fully paid, no carried balance/snowball
        expect(r.total.payment).toBeCloseTo(WRENT, 2);
        expect(r.total.balance).toBeCloseTo(0, 2);
        expect(r.total.grandTotal).toBeCloseTo(WRENT, 2);
        pastCount++;
      } else {
        // current/future week → left unpaid
        expect(r.total.payment).toBeCloseTo(0, 2);
      }
    }
    expect(pastCount).toBeGreaterThan(0); // proves past weeks WERE seeded
  });
});
