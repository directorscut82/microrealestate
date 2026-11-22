import {
  nextWriteOff,
  recordedAfterTermination,
  terminateLease,
  unpaidAtTermination,
  unpaidByMonth,
  writeOffRequest,
  writeOffUpToTermination
} from '../utils/leaseArrears';

// The terminate window asks «how much does this tenant still owe, and on which
// months?» so it can offer to write that off. It used to ask each month's row
// on its own (own bill minus what was paid on that row beyond its carried
// balance). A row cannot answer that: arrears are normally settled on a LATER
// month's page, so the earlier row keeps saying "unpaid". Measured on the app
// with three tenants who really owed 800 / 1.300 / 400 €: the window offered
// 1.200 / 1.600 / 1.200 €, and writing that off left a phantom credit or was
// refused half way through.

const round2 = (n) => Math.round(n * 100) / 100;

// A ledger as the API returns it once carried balances add up: each month
// carries in what the month before it left unpaid.
function ledger(months, firstTerm = 2026010100) {
  const rows = [];
  let carried = 0;
  months.forEach(({ own, paid = 0 }, i) => {
    const totalToPay = round2(own + carried);
    rows.push({
      term: firstTerm + i * 10000,
      balance: carried,
      totalToPay,
      payment: paid,
      payments: paid ? [{ amount: paid }] : []
    });
    carried = round2(totalToPay - paid);
  });
  return rows;
}

const unpaid = (rows) => unpaidByMonth(rows).map((m) => m.unpaid);
const stillOwedOnLastRow = (rows) => {
  const last = rows[rows.length - 1];
  return Math.max(0, round2(last.totalToPay - last.payment));
};
const sum = (xs) => round2(xs.reduce((s, x) => s + x, 0));

describe('unpaidByMonth', () => {
  it('nothing paid: every month owes its own bill', () => {
    const rows = ledger([
      { own: 400 },
      { own: 400 },
      { own: 400 },
      { own: 400 }
    ]);
    expect(unpaid(rows)).toEqual([400, 400, 400, 400]);
    expect(sum(unpaid(rows))).toBe(1600);
  });

  it('arrears settled on a later month are not counted again on the earlier one', () => {
    // January unpaid; in February the tenant pays January and February together.
    const rows = ledger([
      { own: 400 },
      { own: 400, paid: 800 },
      { own: 400 },
      { own: 400 }
    ]);
    // The per-row reading said [400, 0, 400, 400] = 1.200.
    expect(unpaid(rows)).toEqual([0, 0, 400, 400]);
    expect(sum(unpaid(rows))).toBe(stillOwedOnLastRow(rows));
  });

  it('a part payment settles the oldest debt first', () => {
    const rows = ledger([
      { own: 400 },
      { own: 400, paid: 300 },
      { own: 400 },
      { own: 400 }
    ]);
    expect(unpaid(rows)).toEqual([100, 400, 400, 400]);
    expect(sum(unpaid(rows))).toBe(1300);
    expect(sum(unpaid(rows))).toBe(stillOwedOnLastRow(rows));
  });

  it('months paid in advance on an earlier month are settled', () => {
    const rows = ledger([
      { own: 400, paid: 1200 },
      { own: 400 },
      { own: 400 },
      { own: 400 }
    ]);
    expect(unpaid(rows)).toEqual([0, 0, 0, 400]);
    expect(sum(unpaid(rows))).toBe(stillOwedOnLastRow(rows));
  });

  it('a tenant in credit owes nothing, never a negative amount', () => {
    const rows = ledger([{ own: 400, paid: 2000 }, { own: 400 }, { own: 400 }]);
    expect(unpaid(rows)).toEqual([0, 0, 0]);
  });

  it('a payment on the latest month still settles the oldest month first', () => {
    const rows = ledger([
      { own: 400 },
      { own: 400 },
      { own: 400, paid: 500 },
      { own: 400 }
    ]);
    expect(unpaid(rows)).toEqual([0, 300, 400, 400]);
    expect(sum(unpaid(rows))).toBe(stillOwedOnLastRow(rows));
  });

  it('a month already discounted owes only what is left of its own bill', () => {
    // March's bill was written down to 150 (a 250 discount is inside its total).
    const rows = ledger([{ own: 400, paid: 400 }, { own: 400 }, { own: 150 }]);
    expect(unpaidByMonth(rows).map((m) => m.own)).toEqual([400, 400, 150]);
    expect(unpaid(rows)).toEqual([0, 400, 150]);
  });

  it('a discount larger than a month’s bill counts in the tenant’s favour', () => {
    const rows = ledger([{ own: 400 }, { own: -100 }, { own: 400 }]);
    expect(unpaid(rows)).toEqual([300, 0, 400]);
    expect(sum(unpaid(rows))).toBe(stillOwedOnLastRow(rows));
  });

  it('cents are kept exact', () => {
    const rows = ledger([
      { own: 123.45 },
      { own: 123.45, paid: 0.01 },
      { own: 99.99, paid: 100 }
    ]);
    expect(unpaid(rows)).toEqual([23.44, 123.45, 99.99]);
    expect(sum(unpaid(rows))).toBe(stillOwedOnLastRow(rows));
  });

  it('is in month order whatever order the rows arrive in, and reports each term', () => {
    const rows = ledger([{ own: 400 }, { own: 400, paid: 800 }, { own: 400 }]);
    const shuffled = [rows[2], rows[0], rows[1]].map((r) => ({
      ...r,
      term: String(r.term)
    }));
    expect(unpaidByMonth(shuffled)).toEqual([
      { term: 2026010100, own: 400, unpaid: 0 },
      { term: 2026020100, own: 400, unpaid: 0 },
      { term: 2026030100, own: 400, unpaid: 400 }
    ]);
  });

  it('copes with nothing, and with rows that carry no amounts', () => {
    expect(unpaidByMonth(undefined)).toEqual([]);
    expect(unpaidByMonth([])).toEqual([]);
    expect(
      unpaidByMonth([null, { term: 2026010100 }, { term: 'x', totalToPay: 5 }])
    ).toEqual([{ term: 2026010100, own: 0, unpaid: 0 }]);
  });

  it('a row whose total holds no figure owes nothing and credits nothing', () => {
    // A damaged row: it carried 400 in and its total is missing. Read as «total 0»
    // it would count as 400 in the tenant's favour and settle January.
    const rows = [
      { term: 2026010100, balance: 0, totalToPay: 400, payment: 0 },
      { term: 2026020100, balance: 400, payment: 0 },
      { term: 2026030100, balance: 400, totalToPay: null, payment: 0 },
      { term: 2026040100, balance: 400, totalToPay: '', payment: 0 }
    ];
    expect(unpaid(rows)).toEqual([400, 0, 0, 0]);
    // A total that arrives as text is a figure.
    expect(
      unpaid([
        { term: 2026010100, balance: 100, totalToPay: '500', payment: 0 }
      ])
    ).toEqual([400]);
  });

  it('always adds up to what the last month still owes (500 random ledgers)', () => {
    // Small deterministic generator: the test must fail the same way every run.
    let seed = 20261122;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 500; n++) {
      const months = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => ({
        own: round2(rnd() < 0.1 ? -rnd() * 80 : 50 + rnd() * 600),
        paid: rnd() < 0.45 ? 0 : round2(rnd() * 1500)
      }));
      const rows = ledger(months);
      const result = unpaidByMonth(rows);
      expect(sum(result.map((m) => m.unpaid))).toBeCloseTo(
        stillOwedOnLastRow(rows),
        2
      );
      result.forEach((m) => {
        expect(m.unpaid).toBeGreaterThanOrEqual(0);
        expect(m.unpaid).toBeLessThanOrEqual(Math.max(0, m.own) + 0.001);
      });
    }
  });
});

// January to April 2026 are 202601…202604 as the dialog's «termination month».
const JAN = 202601;
const FEB = 202602;
const APR = 202604;

describe('unpaidAtTermination', () => {
  it('splits what is unpaid into the months that stay and the months that are deleted', () => {
    const rows = ledger([
      { own: 400 },
      { own: 400 },
      { own: 400 },
      { own: 400 }
    ]);
    expect(unpaidAtTermination(rows, FEB)).toEqual({
      kept: { months: 2, amount: 800 },
      dropped: { months: 2, amount: 800 }
    });
  });

  it('with no date picked yet, everything stays', () => {
    const rows = ledger([{ own: 400 }, { own: 400 }]);
    expect(unpaidAtTermination(rows, null)).toEqual({
      kept: { months: 2, amount: 800 },
      dropped: { months: 0, amount: 0 }
    });
  });

  it('months settled through a later payment are not unpaid on either side', () => {
    const rows = ledger([
      { own: 400 },
      { own: 400, paid: 800 },
      { own: 400 },
      { own: 400 }
    ]);
    expect(unpaidAtTermination(rows, APR)).toEqual({
      kept: { months: 2, amount: 800 },
      dropped: { months: 0, amount: 0 }
    });
  });

  it('a month after the termination that an earlier overpayment covers is not a deleted debt', () => {
    // 1.000 on January: February is covered and March owes 200. Row by row the
    // window said «2 μήνες … 800,00 €» would be deleted.
    const rows = ledger([{ own: 400, paid: 1000 }, { own: 400 }, { own: 400 }]);
    expect(unpaidAtTermination(rows, JAN)).toEqual({
      kept: { months: 0, amount: 0 },
      dropped: { months: 1, amount: 200 }
    });
  });

  it('a credit on a month the termination deletes pays for nothing that stays', () => {
    // January owes 400. February's own bill is −100 (a standing discount on a month
    // with no rent): it shows 300 in total, and it is deleted by a termination in
    // January. January still owes its 400 — read over the whole ledger the window
    // said 300, wrote 300 off, and the lease ended owing 100.
    const rows = ledger([{ own: 400 }, { own: -100 }]);
    expect(unpaidAtTermination(rows, JAN)).toEqual({
      kept: { months: 1, amount: 400 },
      dropped: { months: 0, amount: 0 }
    });
    // With February kept, its 100 does count: that is what the ledger will show.
    expect(unpaidAtTermination(rows, FEB)).toEqual({
      kept: { months: 1, amount: 300 },
      dropped: { months: 0, amount: 0 }
    });
  });

  it('a payment on a month the termination deletes settles that month, not the ones that stay', () => {
    // January and February unpaid, 800 paid on March's page, termination in February.
    // The window said nothing was unpaid up to the termination and that March, the
    // month that IS paid, was an unpaid month about to be deleted.
    const rows = ledger([{ own: 400 }, { own: 400 }, { own: 400, paid: 800 }]);
    expect(unpaidAtTermination(rows, FEB)).toEqual({
      kept: { months: 2, amount: 800 },
      dropped: { months: 0, amount: 0 }
    });
  });

  it('what stays unpaid is what the last month that stays still shows (300 random ledgers)', () => {
    let seed = 20261125;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 300; n++) {
      const rows = ledger(
        Array.from({ length: 2 + Math.floor(rnd() * 10) }, () => ({
          own: round2(rnd() < 0.15 ? -rnd() * 90 : 50 + rnd() * 600),
          paid: rnd() < 0.5 ? 0 : round2(rnd() * 1200)
        }))
      );
      const cutIndex = Math.floor(rnd() * rows.length);
      const cut = Math.floor(rows[cutIndex].term / 10000);
      const lastKept = rows[cutIndex];
      const { kept, dropped } = unpaidAtTermination(rows, cut);
      expect(kept.amount).toBeCloseTo(
        Math.max(0, round2(lastKept.totalToPay - lastKept.payment)),
        2
      );
      // …and both sides together never claim more than the bills there are.
      expect(dropped.amount).toBeGreaterThanOrEqual(0);
      expect(kept.amount + dropped.amount).toBeLessThanOrEqual(
        rows.reduce(
          (sum, r) => sum + Math.max(0, r.totalToPay - r.balance),
          0
        ) + 0.001
      );
    }
  });

  it('copes with no ledger', () => {
    expect(unpaidAtTermination(undefined, APR)).toEqual({
      kept: { months: 0, amount: 0 },
      dropped: { months: 0, amount: 0 }
    });
  });
});

describe('recordedAfterTermination', () => {
  const rows = ledger([{ own: 400 }, { own: 400 }, { own: 400, paid: 400 }]);
  const quiet = () =>
    ledger([{ own: 400, paid: 400 }, { own: 400 }, { own: 400 }]);

  it('is true when a month after the termination is paid', () => {
    expect(recordedAfterTermination(rows, FEB)).toBe(true);
    expect(recordedAfterTermination(rows, JAN)).toBe(true);
  });

  // The server refuses to delete a month that carries any of these
  // (services/api/src/managers/contract.ts `_isPayment`).
  it.each([
    ['a discount', { promo: 30 }],
    ['an extra charge', { extracharge: 30 }],
    ['a note', { description: 'agreed by phone' }],
    ['a payment', { payments: [{ amount: 0.01 }] }]
  ])('is true when a month after the termination carries %s', (_what, on) => {
    const later = quiet();
    Object.assign(later[2], on);
    expect(recordedAfterTermination(later, JAN)).toBe(true);
    expect(recordedAfterTermination(later, FEB)).toBe(true);
    expect(recordedAfterTermination(later, 202603)).toBe(false);
  });

  it('is false when the months after the termination carry nothing', () => {
    expect(recordedAfterTermination(quiet(), JAN)).toBe(false);
    // amounts of nothing are nothing
    const zeros = quiet();
    Object.assign(zeros[2], {
      promo: 0,
      extracharge: 0,
      description: '',
      payments: [{ amount: 0 }]
    });
    expect(recordedAfterTermination(zeros, JAN)).toBe(false);
  });

  it('is false when the paid month is the termination month or before it', () => {
    expect(recordedAfterTermination(rows, 202603)).toBe(false);
    expect(recordedAfterTermination(rows, APR)).toBe(false);
    expect(recordedAfterTermination(undefined, APR)).toBe(false);
  });
});

describe('nextWriteOff', () => {
  it('names the oldest month still unpaid, with what it owes', () => {
    const rows = ledger([
      { own: 400 },
      { own: 400, paid: 300 },
      { own: 400 },
      { own: 400 }
    ]);
    expect(nextWriteOff(rows, APR, new Set())).toEqual({
      term: 2026010100,
      amount: 100
    });
  });

  it('skips the months already written off in this run', () => {
    // January's 400 has been written off: its own bill is down to nothing.
    const rows = ledger([{ own: 0 }, { own: 400 }, { own: 400 }]);
    expect(nextWriteOff(rows, APR, new Set([2026010100]))).toEqual({
      term: 2026020100,
      amount: 400
    });
  });

  it('adds what a month written off in this run still owes to the next one', () => {
    // January was asked for and still shows 400 (a write-off that did not land):
    // February's total carries it, so February's write-off takes it along.
    const rows = ledger([{ own: 400 }, { own: 400 }, { own: 400 }]);
    expect(nextWriteOff(rows, APR, new Set([2026010100]))).toEqual({
      term: 2026020100,
      amount: 800
    });
  });

  it('stops at the termination month', () => {
    const rows = ledger([{ own: 400 }, { own: 400 }, { own: 400 }]);
    expect(nextWriteOff(rows, JAN, new Set([2026010100]))).toBeNull();
    expect(nextWriteOff(rows, 202512, new Set())).toBeNull();
  });

  it('is null when nothing is owed', () => {
    const rows = ledger([
      { own: 400, paid: 400 },
      { own: 400, paid: 900 },
      { own: 400 }
    ]);
    expect(nextWriteOff(rows, APR, new Set())).toBeNull();
  });

  it('reads only the months that stay', () => {
    // February (−100 of its own) is deleted by a termination in January: January is
    // written off in full.
    const rows = ledger([{ own: 400 }, { own: -100 }]);
    expect(nextWriteOff(rows, JAN, new Set())).toEqual({
      term: 2026010100,
      amount: 400
    });
    // A payment on a deleted month does not settle a month that stays either.
    const paidLater = ledger([{ own: 400 }, { own: 400, paid: 800 }]);
    expect(nextWriteOff(paidLater, JAN, new Set())).toEqual({
      term: 2026010100,
      amount: 400
    });
  });

  it('never asks for more than the month’s total still shows', () => {
    // March is unpaid (496), but a cent of credit reached it: its total shows 495,99.
    // Asking for 496 was refused by the server, half way through the write-offs.
    const rows = [
      { term: 2026010100, balance: 0, totalToPay: 119.99, payment: 0 },
      { term: 2026020100, balance: 119.99, totalToPay: 615.99, payment: 616 },
      { term: 2026030100, balance: -0.01, totalToPay: 495.99, payment: 0 }
    ];
    // (January's own bill is down to 119,99 after its write-off landed a cent over.)
    expect(nextWriteOff(rows, APR, new Set([2026010100, 2026020100]))).toEqual({
      term: 2026030100,
      amount: 495.99
    });
  });

  it('on a ledger whose carried balances do not add up, still never more than the month shows', () => {
    // February's row carries 100 where January left 400 (a ledger from before the
    // carried balance followed), and 200 is paid on it: its total still shows 300.
    const rows = [
      { term: 2026010100, balance: 0, totalToPay: 400, payment: 0 },
      { term: 2026020100, balance: 100, totalToPay: 500, payment: 200 }
    ];
    expect(nextWriteOff(rows, APR, new Set([2026010100]))).toEqual({
      term: 2026020100,
      amount: 300
    });
    // …and with nothing paid on it, its whole total and no more.
    rows[1].payment = 0;
    expect(nextWriteOff(rows, APR, new Set([2026010100]))).toEqual({
      term: 2026020100,
      amount: 500
    });
  });

  it('adds the cent an earlier write-off left behind to the next month', () => {
    // January was written off a cent short: 0,01 still stands on it.
    const rows = [
      { term: 2026010100, balance: 0, totalToPay: 100.01, payment: 0 },
      { term: 2026020100, balance: 100.01, totalToPay: 596.01, payment: 100 }
    ];
    expect(nextWriteOff(rows, APR, new Set([2026010100]))).toEqual({
      term: 2026020100,
      amount: 496.01
    });
  });

  it('writes a lease off to the cent even when every write-off lands a cent off (300 ledgers)', () => {
    // A model of the server on a VAT lease: a write-off of W lowers the month's bill
    // by W, W + 0,01 or W − 0,01, and a write-off above the month's total is refused.
    let seed = 20261124;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 300; n++) {
      const months = Array.from({ length: 2 + Math.floor(rnd() * 10) }, () => ({
        own: round2(50 + rnd() * 600),
        paid: rnd() < 0.5 ? 0 : round2(rnd() * 900),
        written: 0
      }));
      const rowsNow = () =>
        ledger(
          months.map((m) => ({ own: round2(m.own - m.written), paid: m.paid }))
        );
      const owedAtStart = stillOwedOnLastRow(rowsNow());
      const done = new Set();
      let writtenOff = 0;
      for (let step = 0; step < 50; step++) {
        const rows = rowsNow();
        const next = nextWriteOff(rows, 209912, done);
        if (!next) break;
        expect(done.has(next.term)).toBe(false);
        done.add(next.term);
        const row = rows.find((r) => r.term === next.term);
        // what the server checks before it accepts the discount
        expect(next.amount).toBeLessThanOrEqual(
          Math.max(0, round2(row.totalToPay - row.payment)) + 0.005
        );
        expect(next.amount).toBeGreaterThan(0);
        const landed = round2(
          next.amount + [-0.01, 0, 0.01][Math.floor(rnd() * 3)]
        );
        months[rows.indexOf(row)].written += landed;
        writtenOff = round2(writtenOff + next.amount);
      }
      const last = rowsNow().pop();
      // Nothing left but, at most, the cent the last write-off itself was off by.
      expect(
        Math.abs(round2(last.totalToPay - last.payment))
      ).toBeLessThanOrEqual(
        owedAtStart > 0
          ? 0.011
          : Math.abs(round2(last.totalToPay - last.payment))
      );
      expect(Math.abs(round2(writtenOff - owedAtStart))).toBeLessThanOrEqual(
        0.01 * months.length + 0.001
      );
    }
  });
});

describe('writeOffRequest', () => {
  const about = { tenantId: 'tenant-1', note: 'Written off' };
  const savedPayment = {
    amount: 150,
    date: '05/03/2026',
    type: 'cash',
    reference: 'R-17',
    description: 'part payment',
    promo: 0,
    notepromo: '',
    extracharge: 0,
    noteextracharge: '',
    allocation: [{ category: 'rent', lineKey: 'preTax:0', amount: 150 }]
  };

  it('asks for a month-level discount on a month with no payment', () => {
    const row = { term: 2026030100, totalToPay: 400, payment: 0, payments: [] };
    expect(writeOffRequest(row, 400, about)).toEqual({
      term: '2026030100',
      payment: {
        _id: 'tenant-1',
        month: 3,
        year: 2026,
        description: '',
        extracharge: 0,
        noteextracharge: '',
        promo: 400,
        notepromo: 'Written off',
        payments: []
      }
    });
  });

  it('sends the payments already on the month back as they are', () => {
    // The request replaces the month: a payment left out is deleted.
    const row = {
      term: 2026030100,
      totalToPay: 400,
      payment: 150,
      description: 'agreed by phone',
      payments: [
        savedPayment,
        { ...savedPayment, amount: 50, reference: 'R-18' }
      ]
    };
    const { payment } = writeOffRequest(row, 200, about);
    expect(payment.payments).toEqual([
      savedPayment,
      { ...savedPayment, amount: 50, reference: 'R-18' }
    ]);
    expect(payment.promo).toBe(200);
    expect(payment.notepromo).toBe('Written off');
    expect(payment.description).toBe('agreed by phone');
  });

  it('adds the write-off to the first payment’s discount when a payment carries one', () => {
    // The server drops a month-level discount on such a month.
    const row = {
      term: 2026030100,
      totalToPay: 370,
      payment: 150,
      payments: [
        savedPayment,
        { ...savedPayment, amount: 20, promo: 30, notepromo: 'loyalty' }
      ]
    };
    const { payment } = writeOffRequest(row, 200.004, about);
    expect(payment.promo).toBe(0);
    expect(payment.notepromo).toBe('');
    expect(payment.payments[0]).toEqual({
      ...savedPayment,
      promo: 200,
      notepromo: 'Written off'
    });
    expect(payment.payments[1]).toEqual({
      ...savedPayment,
      amount: 20,
      promo: 30,
      notepromo: 'loyalty'
    });
    // …and keeps the note that payment's discount already had.
    const again = writeOffRequest(
      {
        ...row,
        payments: [{ ...savedPayment, promo: 30, notepromo: 'loyalty' }]
      },
      200,
      about
    );
    expect(again.payment.payments[0].promo).toBe(230);
    expect(again.payment.payments[0].notepromo).toBe('loyalty; Written off');
  });
});

// A stand-in for the server, as far as a write-off can tell: a request REPLACES the
// month's payments and its discount; a discount above the month's stored total is
// refused; and on a VAT lease a discount can land a cent off the amount asked for.
function fakeServer(
  months,
  { landsOff = () => 0, failOnRequest = 0, afterRequest = () => {} } = {}
) {
  const firstTerm = (i) =>
    (2000 + Math.floor(i / 12)) * 1000000 + ((i % 12) + 1) * 10000 + 100;
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const state = months.map((m, i) => ({
    term: firstTerm(i),
    bill: m.own,
    payments: copy(m.payments || (m.paid ? [{ amount: m.paid }] : [])),
    discount: m.discount || 0,
    extracharge: m.extracharge || 0,
    note: m.note || ''
  }));
  const rows = () => {
    let carried = 0;
    return state.map((s) => {
      const payment = round2(s.payments.reduce((x, p) => x + p.amount, 0));
      const totalToPay = round2(s.bill + s.extracharge - s.discount + carried);
      const row = {
        term: s.term,
        balance: carried,
        totalToPay,
        payment,
        payments: copy(s.payments),
        promo: s.discount,
        extracharge: s.extracharge,
        description: s.note
      };
      carried = round2(totalToPay - payment);
      return row;
    });
  };
  const requests = [];
  return {
    requests,
    rows,
    yearMonth: (i) => Math.floor(firstTerm(i) / 10000),
    discounts: () => state.map((s) => s.discount),
    readLedger: async () => rows(),
    record: async ({ term, payment }) => {
      requests.push({ term, payment: copy(payment) });
      if (requests.length === failOnRequest) throw new Error('network');
      const s = state.find((x) => String(x.term) === term);
      const stored = rows().find((r) => String(r.term) === term);
      const onPayments = round2(
        payment.payments.reduce((x, p) => x + (p.promo || 0), 0)
      );
      const asked = onPayments > 0 ? onPayments : payment.promo;
      if (stored.totalToPay > 0 && asked > stored.totalToPay + 0.005) {
        throw Object.assign(new Error('discount above the total'), {
          status: 422
        });
      }
      s.payments = copy(payment.payments);
      s.discount = round2(asked + (asked > 0 ? landsOff(asked) : 0));
      s.note = payment.description;
      afterRequest(requests.length, state);
    }
  };
}

describe('writeOffUpToTermination', () => {
  const run = (server, cutYearMonth) =>
    writeOffUpToTermination({
      cutYearMonth,
      readLedger: server.readLedger,
      record: server.record,
      tenantId: 'tenant-1',
      note: 'Written off'
    });
  const stillOwed = (row) => round2(row.totalToPay - row.payment);
  const asked = (server) =>
    server.requests.map(({ term, payment }) => [
      Number(term),
      payment.promo ||
        round2(payment.payments.reduce((x, p) => x + (p.promo || 0), 0))
    ]);

  it('nothing paid: each month up to the termination once, oldest first, and the last one owes nothing', async () => {
    const server = fakeServer([
      { own: 400 },
      { own: 400 },
      { own: 400 },
      { own: 400 },
      { own: 400 }
    ]);
    const written = await run(server, server.yearMonth(3));
    expect(asked(server)).toEqual([
      [2000010100, 400],
      [2000020100, 400],
      [2000030100, 400],
      [2000040100, 400]
    ]);
    expect(written).toEqual([2000010100, 2000020100, 2000030100, 2000040100]);
    expect(stillOwed(server.rows()[3])).toBe(0);
    // the month after the termination is not touched
    expect(server.discounts()[4]).toBe(0);
  });

  it('arrears that were paid on a later page are not written off', async () => {
    // January unpaid; in February the tenant paid both. Only March and April are owed.
    const server = fakeServer([
      { own: 400 },
      { own: 400, paid: 800 },
      { own: 400 },
      { own: 400 }
    ]);
    await run(server, server.yearMonth(3));
    expect(asked(server)).toEqual([
      [2000030100, 400],
      [2000040100, 400]
    ]);
    expect(stillOwed(server.rows()[3])).toBe(0);
  });

  it('a part payment stays on its month, with everything it carries', async () => {
    const part = {
      amount: 150,
      date: '05/02/2000',
      type: 'cash',
      reference: 'R-17',
      description: '',
      promo: 0,
      notepromo: '',
      extracharge: 0,
      noteextracharge: '',
      allocation: [{ category: 'rent', lineKey: 'preTax:0', amount: 150 }]
    };
    const server = fakeServer([{ own: 400 }, { own: 400, payments: [part] }]);
    await run(server, server.yearMonth(1));
    expect(asked(server)).toEqual([
      [2000010100, 250],
      [2000020100, 400]
    ]);
    expect(server.requests[1].payment.payments).toEqual([part]);
    expect(server.rows()[1].payments).toEqual([part]);
    expect(stillOwed(server.rows()[1])).toBe(0);
  });

  it('a credit on a month the termination deletes is not spent on the months that stay', async () => {
    // January owes 400; February's own bill is −100 and goes with the termination.
    const server = fakeServer([{ own: 400 }, { own: -100 }]);
    await run(server, server.yearMonth(0));
    expect(asked(server)).toEqual([[2000010100, 400]]);
    expect(stillOwed(server.rows()[0])).toBe(0);
  });

  it.each([
    ['a payment', { payments: [{ amount: 400 }] }],
    ['a discount', { discount: 30 }],
    ['an extra charge', { extracharge: 30 }],
    ['a note', { note: 'agreed by phone' }]
  ])(
    'writes nothing off when a month after the termination carries %s',
    async (_what, later) => {
      // The server refuses that termination: a write-off made first would stay.
      const server = fakeServer([
        { own: 400 },
        { own: 400 },
        { own: 400, ...later }
      ]);
      const written = await run(server, server.yearMonth(1));
      expect(server.requests).toEqual([]);
      expect(written).toEqual([]);
    }
  );

  it('stops as soon as a month after the termination is paid, also half way through', async () => {
    // January to March owe 400 each, termination in February. After January's
    // write-off, 50 € is recorded on March from another window: the server will now
    // refuse the termination, so February must not be written off.
    const server = fakeServer([{ own: 400 }, { own: 400 }, { own: 400 }], {
      afterRequest: (n, state) => {
        if (n === 1) state[2].payments = [{ amount: 50 }];
      }
    });
    const written = await run(server, server.yearMonth(1));
    expect(asked(server)).toEqual([[2000010100, 400]]);
    expect(written).toEqual([2000010100]);
    expect(server.discounts()).toEqual([400, 0, 0]);
  });

  it('a ledger of 650 months is written off to its end', async () => {
    const server = fakeServer(Array.from({ length: 650 }, () => ({ own: 10 })));
    const written = await run(server, 999912);
    expect(written).toHaveLength(650);
    expect(new Set(written).size).toBe(650);
    expect(stillOwed(server.rows()[649])).toBe(0);
  });

  it('ends within a cent when every write-off lands a cent off (100 ledgers)', async () => {
    let seed = 20261126;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 100; n++) {
      const months = Array.from({ length: 2 + Math.floor(rnd() * 9) }, () => ({
        own: round2(50 + rnd() * 600),
        paid: rnd() < 0.5 ? 0 : round2(rnd() * 900)
      }));
      const server = fakeServer(months, {
        landsOff: () => [-0.01, 0, 0.01][Math.floor(rnd() * 3)]
      });
      const last = months.length - 1;
      const owedAtStart = Math.max(0, stillOwed(server.rows()[last]));
      const written = await run(server, 999912);
      // no month twice, and never a request the server refuses
      expect(new Set(written).size).toBe(written.length);
      if (owedAtStart > 0) {
        expect(Math.abs(stillOwed(server.rows()[last]))).toBeLessThanOrEqual(
          0.011
        );
      } else {
        expect(server.requests).toEqual([]);
      }
    }
  });

  it('a run that fails half way is finished by the next one, without writing a month off twice', async () => {
    const server = fakeServer(
      [{ own: 400 }, { own: 400 }, { own: 400 }, { own: 400 }],
      { failOnRequest: 3 }
    );
    await expect(run(server, 999912)).rejects.toThrow('network');
    expect(server.discounts()).toEqual([400, 400, 0, 0]);
    await run(server, 999912);
    expect(server.discounts()).toEqual([400, 400, 400, 400]);
    // the second run asked only for the two months still owed
    expect(asked(server).slice(3)).toEqual([
      [2000030100, 400],
      [2000040100, 400]
    ]);
    expect(stillOwed(server.rows()[3])).toBe(0);
  });

  it('writes nothing when nothing is owed', async () => {
    const server = fakeServer([
      { own: 400, paid: 400 },
      { own: 400, paid: 500 }
    ]);
    expect(await run(server, 999912)).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it('a month whose row shows nothing left is passed over, and the run goes on', async () => {
    // A ledger from before carried balances followed: January's row carries a credit
    // nobody paid and shows nothing left, although its bill was never settled. There
    // is nothing the server would accept there; February is still written off.
    const rows = [
      {
        term: 2026010100,
        balance: -400,
        totalToPay: 0,
        payment: 0,
        payments: []
      },
      {
        term: 2026020100,
        balance: 0,
        totalToPay: 400,
        payment: 0,
        payments: []
      }
    ];
    const sent = [];
    const written = await writeOffUpToTermination({
      cutYearMonth: 202602,
      readLedger: async () => rows,
      record: async (request) => {
        sent.push([request.term, request.payment.promo]);
        rows[1].totalToPay = 0;
      },
      tenantId: 'tenant-1',
      note: 'Written off'
    });
    expect(sent).toEqual([['2026020100', 400]]);
    expect(written).toEqual([2026020100]);
  });
});

describe('terminateLease', () => {
  // The tenant's side of the stand-in server, as far as a termination can tell:
  //   · a version that every saved request moves (a tenant stored WITHOUT one gets 1
  //     on its first save); a write-off must name the tenant it is for (422), is
  //     refused (409) when it names a version that is not the tenant's, and answers
  //     with the version it left (`_tenantVersion`) — as PATCH /rents/payment does;
  //   · a termination that is refused for a refund above the deposit (422), without a
  //     version (422), for a month after it that carries something recorded (422),
  //     and for a version that is not the tenant's (409) — and that otherwise SAVES
  //     THE WHOLE TENANT it is sent, which is how an old copy overwrites an edit made
  //     elsewhere.
  // `phone` stands for any field of the tenant another window may edit.
  function office(
    months,
    { version = 7, deposit = 800, id = 'tenant-1' } = {}
  ) {
    const server = fakeServer(months);
    // `version: null` = a tenant stored without a version
    const tenant = {
      __v: version === null ? undefined : version,
      deposit,
      phone: 'first',
      terminated: false
    };
    const sent = [];
    const refuse = (status, message) => {
      throw Object.assign(new Error(message), { response: { status } });
    };
    const saved = () => {
      tenant.__v = (tenant.__v ?? 0) + 1;
    };
    return {
      server,
      tenant,
      sent,
      // the tenant as a window is handed it NOW
      copy: () => ({
        __v: tenant.__v,
        deposit: tenant.deposit,
        phone: tenant.phone
      }),
      // what «another window» does: edit the tenant and save
      editElsewhere: (changes) => {
        Object.assign(tenant, changes);
        saved();
      },
      io: {
        readLedger: async () => ({
          rents: await server.readLedger(),
          occupant: { __v: tenant.__v }
        }),
        record: async (request) => {
          if (request.payment._id !== id) refuse(422, 'not this tenant');
          const pinned = request.payment.__v;
          if (
            pinned !== undefined &&
            pinned !== null &&
            Number(pinned) !== Number(tenant.__v)
          ) {
            refuse(409, 'modified since the page was loaded');
          }
          await server.record(request);
          saved();
          return { term: Number(request.term), _tenantVersion: tenant.__v };
        },
        terminate: async (body) => {
          sent.push({ __v: body.__v, guarantyPayback: body.guarantyPayback });
          if (body._id !== id) refuse(404, 'not this tenant');
          if (body.guarantyPayback > body.deposit) {
            refuse(422, 'refund above the deposit');
          }
          if (!Number.isFinite(Number(body.__v))) {
            refuse(422, 'the version of the tenant is required');
          }
          if (
            server
              .rows()
              .some(
                (r) =>
                  Math.floor(r.term / 10000) > body.cut &&
                  (r.payments.length > 0 ||
                    r.promo > 0 ||
                    r.extracharge > 0 ||
                    !!r.description)
              )
          ) {
            refuse(422, 'payments will be lost');
          }
          if (Number(body.__v) !== tenant.__v) {
            refuse(409, 'not the tenant’s version');
          }
          tenant.deposit = body.deposit;
          tenant.phone = body.phone;
          saved();
          tenant.terminated = true;
          return 'terminated';
        }
      }
    };
  }
  const FIRST = { __v: 7, deposit: 800, phone: 'first' };
  // One press of the button. `holds` is the tenant as the window was given it.
  const press = (
    o,
    memory,
    { writeOff, refund = 0, id = 'tenant-1', holds = FIRST, cut = 999912 }
  ) =>
    terminateLease({
      tenant: { _id: id, ...holds, guarantyPayback: refund, cut },
      writeOff,
      cutYearMonth: cut,
      note: 'Written off',
      memory,
      io: o.io
    });
  const nothing = () => ({ wroteOffFor: null, version: null });
  const pinnedAt = (o) => o.server.requests.map((r) => r.payment.__v);
  // Arms ONE failure for the next write-off: it fails before anything is saved, or it
  // is saved and its answer is lost. Arming again replaces what was armed.
  const unreliable = (o) => {
    const record = o.io.record;
    o.io.record = async (request) => {
      const failure = o.failure;
      o.failure = null;
      if (!failure) return record(request);
      if (failure.lands) await record(request);
      throw new Error('network');
    };
    return o;
  };

  it('with no write-off, sends the tenant as the window holds it and reads nothing', async () => {
    const o = office([{ own: 400 }]);
    const readLedger = jest.spyOn(o.io, 'readLedger');
    await expect(press(o, nothing(), { writeOff: false })).resolves.toBe(
      'terminated'
    );
    expect(o.sent).toEqual([{ __v: 7, guarantyPayback: 0 }]);
    expect(readLedger).not.toHaveBeenCalled();
    expect(o.server.requests).toEqual([]);
  });

  it('a tenant changed elsewhere in the meantime is refused when nothing was written off', async () => {
    const o = office([{ own: 400 }]);
    o.editElsewhere({ phone: 'elsewhere' });
    await expect(
      press(o, nothing(), { writeOff: false })
    ).rejects.toMatchObject({ response: { status: 409 } });
    expect(o.tenant).toMatchObject({ phone: 'elsewhere', terminated: false });
  });

  it('every request is sent at the version the window knows the tenant at', async () => {
    const o = office([{ own: 400 }, { own: 400 }]);
    const readLedger = jest.spyOn(o.io, 'readLedger');
    await press(o, nothing(), { writeOff: true });
    expect(o.server.discounts()).toEqual([400, 400]);
    // the first write-off at the window's version, the second at the one the first
    // left, the termination at the one the second left
    expect(pinnedAt(o)).toEqual([7, 8]);
    expect(o.server.requests.map((r) => r.payment._id)).toEqual([
      'tenant-1',
      'tenant-1'
    ]);
    expect(o.sent).toEqual([{ __v: 9, guarantyPayback: 0 }]);
    expect(o.tenant.terminated).toBe(true);
    // The ledger is read for the write-offs only (before each month, and once to find
    // nothing left): no version is ever read from it.
    expect(readLedger).toHaveBeenCalledTimes(3);
  });

  it('writes off up to the termination month it is given, and no further', async () => {
    // Three unpaid months, the lease ends in the second: the first two are written
    // off, the third goes with the termination.
    const o = office([{ own: 400 }, { own: 400 }, { own: 400 }]);
    await expect(
      press(o, nothing(), { writeOff: true, cut: o.server.yearMonth(1) })
    ).resolves.toBe('terminated');
    expect(o.server.discounts()).toEqual([400, 400, 0]);
    expect(pinnedAt(o)).toEqual([7, 8]);
    expect(o.sent).toEqual([{ __v: 9, guarantyPayback: 0 }]);
  });

  it('refused after the write-offs landed, then pressed again: the second press goes through', async () => {
    // A refund of 900 against a deposit of 800: the write-offs land (7 → 9), the
    // termination is refused. The landlord corrects the refund and presses again:
    // nothing is left to write off, and the window still holds version 7.
    const o = office([{ own: 400 }, { own: 400 }]);
    const memory = nothing();
    await expect(
      press(o, memory, { writeOff: true, refund: 900 })
    ).rejects.toMatchObject({ response: { status: 422 } });
    expect(o.server.discounts()).toEqual([400, 400]);
    expect(o.tenant.terminated).toBe(false);

    const readLedger = jest.spyOn(o.io, 'readLedger');
    await expect(
      press(o, memory, { writeOff: false, refund: 800 })
    ).resolves.toBe('terminated');
    expect(o.sent.map((x) => x.__v)).toEqual([9, 9]);
    expect(readLedger).not.toHaveBeenCalled();
    // no month was written off a second time
    expect(o.server.requests).toHaveLength(2);
  });

  it('an edit made elsewhere BEFORE the first write-off: nothing is written off, nothing is overwritten', async () => {
    const o = office([{ own: 400 }, { own: 400 }]);
    const memory = nothing();
    o.editElsewhere({ phone: 'elsewhere' });
    await expect(press(o, memory, { writeOff: true })).rejects.toMatchObject({
      response: { status: 409 }
    });
    expect(o.server.discounts()).toEqual([0, 0]);
    expect(o.sent).toEqual([]);
    expect(memory).toEqual(nothing());
    expect(o.tenant).toMatchObject({ phone: 'elsewhere', terminated: false });

    // Handed the tenant again, the window does the whole job, on the edited tenant.
    await expect(
      press(o, memory, { writeOff: true, holds: o.copy() })
    ).resolves.toBe('terminated');
    expect(o.server.discounts()).toEqual([400, 400]);
    expect(o.tenant.phone).toBe('elsewhere');
  });

  it('an edit made elsewhere BETWEEN two write-offs: the next one is refused, nothing is overwritten', async () => {
    const o = office([{ own: 400 }, { own: 400 }]);
    const memory = nothing();
    const record = o.io.record;
    o.io.record = async (request) => {
      const saved = await record(request);
      o.io.record = record;
      o.editElsewhere({ phone: 'elsewhere' });
      return saved;
    };
    await expect(press(o, memory, { writeOff: true })).rejects.toMatchObject({
      response: { status: 409 }
    });
    expect(o.server.discounts()).toEqual([400, 0]);
    expect(o.sent).toEqual([]);
    // what it remembered is no longer the tenant's version
    expect(memory).toEqual(nothing());
    expect(o.tenant).toMatchObject({ phone: 'elsewhere', terminated: false });

    await expect(
      press(o, memory, { writeOff: true, holds: o.copy() })
    ).resolves.toBe('terminated');
    expect(o.server.discounts()).toEqual([400, 400]);
    expect(o.tenant.phone).toBe('elsewhere');
  });

  it('an edit made elsewhere AFTER the last write-off: the termination is refused, nothing is overwritten', async () => {
    const o = office([{ own: 400 }, { own: 400 }]);
    const memory = nothing();
    await expect(
      press(o, memory, { writeOff: true, refund: 900 })
    ).rejects.toMatchObject({ response: { status: 422 } });
    expect(memory).toEqual({ wroteOffFor: 'tenant-1', version: 9 });

    o.editElsewhere({ phone: 'elsewhere' });
    // The window still holds the old tenant. It sends the version its own write-offs
    // left (9); the tenant is at 10: refused, and the edit stands.
    await expect(press(o, memory, { writeOff: false })).rejects.toMatchObject({
      response: { status: 409 }
    });
    expect(o.tenant).toMatchObject({
      __v: 10,
      phone: 'elsewhere',
      terminated: false
    });
    expect(memory).toEqual(nothing());
    await expect(
      press(o, memory, { writeOff: false, holds: o.copy() })
    ).resolves.toBe('terminated');
    expect(o.tenant).toMatchObject({ phone: 'elsewhere', terminated: true });
    expect(o.server.requests).toHaveLength(2);
  });

  it('an edit made elsewhere after a run that failed half way is not overwritten by the next run', async () => {
    // January is written off (7 → 8), February's request fails. Another window edits
    // the tenant (9). The box is still ticked and the landlord presses again: the
    // window knows the tenant at 8, so February is refused — it used to go through,
    // and the termination then saved the old tenant over the edit.
    const o = office([{ own: 400 }, { own: 400 }, { own: 400 }]);
    const memory = nothing();
    const record = o.io.record;
    let calls = 0;
    o.io.record = async (request) => {
      calls += 1;
      if (calls === 2) throw new Error('network');
      return record(request);
    };
    await expect(press(o, memory, { writeOff: true })).rejects.toThrow(
      'network'
    );
    expect(memory).toEqual({ wroteOffFor: 'tenant-1', version: 8 });
    o.editElsewhere({ phone: 'elsewhere' });

    await expect(press(o, memory, { writeOff: true })).rejects.toMatchObject({
      response: { status: 409 }
    });
    expect(o.server.discounts()).toEqual([400, 0, 0]);
    expect(o.sent).toEqual([]);
    expect(o.tenant).toMatchObject({ phone: 'elsewhere', terminated: false });
  });

  it('a write-off that fails stops everything; the next press picks up from the ledger as it stands', async () => {
    const o = office([{ own: 400 }, { own: 400 }, { own: 400 }]);
    const memory = nothing();
    const record = o.io.record;
    let calls = 0;
    o.io.record = async (request) => {
      calls += 1;
      if (calls === 2) throw new Error('network');
      return record(request);
    };
    await expect(press(o, memory, { writeOff: true })).rejects.toThrow(
      'network'
    );
    expect(o.sent).toEqual([]);
    expect(o.server.discounts()).toEqual([400, 0, 0]);
    expect(memory).toEqual({ wroteOffFor: 'tenant-1', version: 8 });

    await press(o, memory, { writeOff: true });
    expect(o.server.discounts()).toEqual([400, 400, 400]);
    expect(pinnedAt(o)).toEqual([7, 8, 9]);
    expect(o.sent).toEqual([{ __v: 10, guarantyPayback: 0 }]);
    expect(o.tenant.terminated).toBe(true);
  });

  it('a write-off that landed before a failure is remembered, whatever the next press does', async () => {
    // The first month lands (7 → 8), the second request fails. The landlord unticks
    // the box and terminates without writing the rest off.
    const o = office([{ own: 400 }, { own: 400 }]);
    const memory = nothing();
    const record = o.io.record;
    let calls = 0;
    o.io.record = async (request) => {
      calls += 1;
      if (calls === 2) throw new Error('network');
      return record(request);
    };
    await expect(press(o, memory, { writeOff: true })).rejects.toThrow(
      'network'
    );
    await expect(press(o, memory, { writeOff: false })).resolves.toBe(
      'terminated'
    );
    expect(o.sent).toEqual([{ __v: 8, guarantyPayback: 0 }]);
    expect(o.server.discounts()).toEqual([400, 0]);
  });

  it('a copy of the tenant newer than what is remembered is sent as it is', async () => {
    // The write-offs land (9), the termination is refused (the refund). Another
    // window raises the deposit (10) and this window is handed the tenant again. It
    // must send that copy: sending the 9 it remembered was refused for nothing.
    const o = office([{ own: 400 }, { own: 400 }]);
    const memory = nothing();
    await expect(
      press(o, memory, { writeOff: true, refund: 900 })
    ).rejects.toMatchObject({ response: { status: 422 } });
    o.editElsewhere({ deposit: 950, phone: 'elsewhere' });
    await expect(
      press(o, memory, { writeOff: false, refund: 900, holds: o.copy() })
    ).resolves.toBe('terminated');
    expect(o.sent.map((x) => x.__v)).toEqual([9, 10]);
    expect(o.tenant).toMatchObject({ deposit: 950, phone: 'elsewhere' });
  });

  it('a write-off that was saved but whose answer was lost: the window is behind, and says so', async () => {
    // January: 7 → 8, remembered. February is saved (9) but its answer never
    // arrives. The window knows 8; the tenant is at 9.
    const o = office([{ own: 400 }, { own: 400 }]);
    const memory = nothing();
    const record = o.io.record;
    let calls = 0;
    o.io.record = async (request) => {
      calls += 1;
      if (calls === 2) {
        await record(request);
        throw new Error('network');
      }
      return record(request);
    };
    await expect(press(o, memory, { writeOff: true })).rejects.toThrow(
      'network'
    );
    expect(o.server.discounts()).toEqual([400, 400]);
    expect(memory).toEqual({ wroteOffFor: 'tenant-1', version: 8 });
    // Pressed again as it is: refused, and what it remembered is dropped…
    await expect(press(o, memory, { writeOff: true })).rejects.toMatchObject({
      response: { status: 409 }
    });
    expect(memory).toEqual(nothing());
    // …and once handed the tenant again, it goes through.
    await expect(
      press(o, memory, { writeOff: true, holds: o.copy() })
    ).resolves.toBe('terminated');
    expect(o.server.requests).toHaveLength(2);
  });

  it('what it remembers is about ONE tenant', async () => {
    // The dashboard window: a write-off was sent for one tenant, then another tenant
    // is picked. That one is sent as the window holds it.
    const o = office([{ own: 400 }], { version: 3, id: 'tenant-2' });
    await press(
      o,
      { wroteOffFor: 'another-tenant', version: 41 },
      { writeOff: true, id: 'tenant-2', holds: { ...FIRST, __v: 3 } }
    );
    expect(pinnedAt(o)).toEqual([3]);
    expect(o.sent).toEqual([{ __v: 4, guarantyPayback: 0 }]);
  });

  it('what it remembers follows the tenant it last wrote off for', async () => {
    // The dashboard window again: it wrote off for one tenant earlier; now it writes
    // off for another, whose termination is refused (the refund). The second press
    // for THAT tenant must go out at the version its own write-offs left.
    const o = office([{ own: 400 }, { own: 400 }], {
      version: 3,
      id: 'tenant-2'
    });
    const memory = { wroteOffFor: 'another-tenant', version: 41 };
    const second = { id: 'tenant-2', holds: { ...FIRST, __v: 3 } };
    await expect(
      press(o, memory, { ...second, writeOff: true, refund: 900 })
    ).rejects.toMatchObject({ response: { status: 422 } });
    expect(memory).toEqual({ wroteOffFor: 'tenant-2', version: 5 });
    await expect(
      press(o, memory, { ...second, writeOff: false, refund: 800 })
    ).resolves.toBe('terminated');
    expect(o.sent.map((x) => x.__v)).toEqual([5, 5]);
  });

  it('when the server is going to refuse the termination, nothing is written off and nothing is remembered', async () => {
    const o = office([{ own: 400 }, { own: 400, paid: 400 }]);
    const memory = nothing();
    await expect(
      press(o, memory, { writeOff: true, cut: o.server.yearMonth(0) })
    ).rejects.toMatchObject({ response: { status: 422 } });
    expect(o.server.requests).toEqual([]);
    expect(memory).toEqual(nothing());
    expect(o.sent).toEqual([{ __v: 7, guarantyPayback: 0 }]);
    expect(o.tenant.terminated).toBe(false);
  });

  it.each([
    ['nothing', {}],
    ['not a number', { _tenantVersion: 'soon' }],
    ['an empty text', { _tenantVersion: '' }],
    ['true', { _tenantVersion: true }],
    ['a list holding a number', { _tenantVersion: [9] }],
    ['null', { _tenantVersion: null }],
    ['not-a-number', { _tenantVersion: NaN }],
    ['no answer at all', undefined],
    ['an answer that is null', null]
  ])(
    'a write-off whose answer names %s as the version stops the run there',
    async (_what, answer) => {
      // Without the version its write left, nothing more can be sent safely.
      const o = office([{ own: 400 }, { own: 400 }]);
      const memory = nothing();
      const record = o.io.record;
      o.io.record = async (request) => {
        await record(request);
        return answer;
      };
      await expect(press(o, memory, { writeOff: true })).rejects.toThrow(
        /version/
      );
      expect(o.server.discounts()).toEqual([400, 0]);
      expect(o.sent).toEqual([]);
      expect(memory).toEqual(nothing());
    }
  );

  it.each([
    ['no version', {}],
    ['null as its version', { __v: null }],
    ['an empty text as its version', { __v: '' }]
  ])(
    'a tenant stored without a version, held as a copy that names %s: the first write-off cannot be pinned, the rest follow the chain',
    async (_what, version) => {
      // Such a tenant (inserted straight into the database; the app creates none)
      // gets its version on its first save: 1. Reading «no version» as 0 pinned the
      // first write-off at 0 and had it refused. Known limit, as before the chain:
      // until that first answer the window cannot tell an edit made elsewhere.
      const o = office([{ own: 400 }, { own: 400 }], { version: null });
      await expect(
        press(o, nothing(), {
          writeOff: true,
          holds: { deposit: 800, phone: 'first', ...version }
        })
      ).resolves.toBe('terminated');
      expect(pinnedAt(o)).toEqual([undefined, 1]);
      expect(o.sent).toEqual([{ __v: 2, guarantyPayback: 0 }]);
      expect(o.tenant.__v).toBe(3);
    }
  );

  it('…and without a write-off such a tenant is sent as it is held (the server asks for a version)', async () => {
    const o = office([{ own: 400 }], { version: null });
    await expect(
      press(o, nothing(), {
        writeOff: false,
        holds: { deposit: 800, phone: 'first' }
      })
    ).rejects.toMatchObject({ response: { status: 422 } });
    expect(o.sent).toEqual([{ __v: undefined, guarantyPayback: 0 }]);
  });

  it('a version that arrives as text is a version', async () => {
    const o = office([{ own: 400 }, { own: 400 }]);
    const record = o.io.record;
    o.io.record = async (request) => {
      const saved = await record(request);
      return { ...saved, _tenantVersion: String(saved._tenantVersion) };
    };
    await expect(
      press(o, nothing(), { writeOff: true, holds: { ...FIRST, __v: '7' } })
    ).resolves.toBe('terminated');
    expect(pinnedAt(o)).toEqual([7, 8]);
    expect(o.sent).toEqual([{ __v: 9, guarantyPayback: 0 }]);
  });

  it('whatever happens in whatever order, an edit made elsewhere is never overwritten, no month is written off twice, and the window never gets stuck (400 sequences)', async () => {
    let seed = 20261127;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    for (let n = 0; n < 400; n++) {
      const months = Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => ({
        own: 400
      }));
      const o = unreliable(office(months));
      const memory = nothing();
      let holds = o.copy();
      let lastEdit = 'first';
      const trail = [];
      const check = () => {
        const where = `sequence ${n}: ${trail.join(' → ')}`;
        // an edit made elsewhere is never overwritten
        expect([where, o.tenant.phone]).toEqual([where, lastEdit]);
        // a month is written off in full or not at all…
        expect([
          where,
          o.server.discounts().every((d) => d === 0 || d === 400)
        ]).toEqual([where, true]);
        // …and never twice: the server accepted at most one request for it
        const accepted = {};
        o.server.requests.forEach((r) => {
          accepted[r.term] = (accepted[r.term] || 0) + 1;
        });
        expect([where, Object.values(accepted).every((c) => c === 1)]).toEqual([
          where,
          true
        ]);
        // what is remembered is never ahead of the tenant
        if (memory.version !== null) {
          expect([where, memory.version <= o.tenant.__v]).toEqual([
            where,
            true
          ]);
        }
      };
      let endedBy = null;
      const run = async (action) => {
        trail.push(action);
        await press(o, memory, {
          writeOff: action !== 'press, box unticked',
          refund: action === 'press, refund too high' ? 900 : 0,
          holds
        }).catch(() => {});
        if (o.tenant.terminated && !endedBy) endedBy = action;
      };
      for (let step = 0; step < 9 && !o.tenant.terminated; step++) {
        const action = pick([
          'press, box ticked',
          'press, box ticked',
          'press, box unticked',
          'press, refund too high',
          'edit elsewhere',
          'handed the tenant again',
          'next write-off fails',
          'next write-off is saved, answer lost'
        ]);
        if (action === 'edit elsewhere') {
          trail.push(action);
          lastEdit = `edit ${n}.${step}`;
          o.editElsewhere({ phone: lastEdit });
        } else if (action === 'handed the tenant again') {
          trail.push(action);
          holds = o.copy();
        } else if (action === 'next write-off fails') {
          trail.push(action);
          o.failure = { lands: false };
        } else if (action === 'next write-off is saved, answer lost') {
          trail.push(action);
          o.failure = { lands: true };
        } else {
          await run(action);
        }
        check();
      }
      // never stuck: handed the tenant again, a press with the box ticked ends the
      // lease (twice at most: a failure armed above may still be pending)
      for (let i = 0; i < 2 && !o.tenant.terminated; i++) {
        trail.push('handed the tenant again');
        holds = o.copy();
        await run('press, box ticked');
        check();
      }
      const where = `sequence ${n}: ${trail.join(' → ')}`;
      expect([where, o.tenant.terminated]).toEqual([where, true]);
      // ended with the box ticked: everything is written off. Unticked: only what
      // earlier runs wrote off, each month in full or not at all (checked above).
      if (endedBy !== 'press, box unticked') {
        expect([where, o.server.discounts()]).toEqual([
          where,
          months.map(() => 400)
        ]);
      }
    }
  });
});
