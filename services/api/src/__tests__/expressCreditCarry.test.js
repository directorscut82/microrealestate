/* eslint-env node, jest */
/**
 * INVARIANT: a negative rent.total.grandTotal is the LEGITIMATE credit-carry
 * mechanism, NOT corruption. When a tenant OVERpays a month, the surplus must
 * carry forward and reduce the next month(s) owed. This is expressed as a
 * negative balance → negative grandTotal in the pipeline (7_total.ts adds
 * balance without a floor, ON PURPOSE).
 *
 * This test exists as a TRIPWIRE: a future "fix" that floors grandTotal (or
 * balance) at Math.max(0, ...) to make an old-arrears payment look tidy would
 * SILENTLY DELETE money the tenant is owed. That exact floor was proposed and
 * rejected in the 2026-07 express-past-month investigation. If you are here
 * because this test failed, you are about to eat a tenant credit — don't.
 */
import * as Contract from '../managers/contract.js';
import moment from 'moment';

const m0 = moment.utc().startOf('month');

function cleanCurrentMonthContract() {
  // Anchor at the current month so the paid term has NO prior arrears
  // (balance 0) — the only way to create a genuine overpayment.
  const begin = m0.clone().toDate().getTime();
  const end = m0.clone().add(24, 'months').endOf('month').toDate().getTime();
  return Contract.create({
    begin,
    end,
    frequency: 'months',
    properties: [
      { entryDate: begin, exitDate: end, property: { name: 'U', price: 200 }, rent: 200, expenses: [] }
    ]
  });
}

const term = (mo) => Number(mo.format('YYYYMMDDHH'));

describe('credit carry-forward via negative grandTotal (tripwire)', () => {
  test('overpay 500 on a 200 month → next months absorb the 300 credit', () => {
    let c = cleanCurrentMonthContract();
    const cur = term(m0);
    const next1 = term(m0.clone().add(1, 'month'));
    const next2 = term(m0.clone().add(2, 'month'));

    c = Contract.payTerm(c, String(cur), {
      payments: [{ amount: 500, date: m0.clone().format('DD/MM/YYYY'), type: 'transfer', reference: 'overpay' }]
    });

    const rc = c.rents.find((r) => r.term === cur);
    const r1 = c.rents.find((r) => r.term === next1);
    const r2 = c.rents.find((r) => r.term === next2);

    // Paid month: bill 200, paid 500, settled (balance 0 going in).
    expect(rc.total.payment).toBeCloseTo(500, 2);

    // Next month: 200 rent − 300 credit = −100. The NEGATIVE is the credit.
    expect(r1.total.balance).toBeCloseTo(-300, 2);
    expect(r1.total.grandTotal).toBeCloseTo(-100, 2);

    // Next+1 month: 200 rent − 100 remaining credit = +100 owed.
    expect(r2.total.balance).toBeCloseTo(-100, 2);
    expect(r2.total.grandTotal).toBeCloseTo(100, 2);
  });
});
