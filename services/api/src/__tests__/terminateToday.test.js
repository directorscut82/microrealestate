import moment from 'moment';

// #5 regression guard (reported 2026-07): setting terminationDate = TODAY must
// mark the lease ENDED today (terminated=true / status='stopped'), not still
// "in force" until tomorrow. The bug was `isBefore(today)`; fix is
// `isSameOrBefore(today)` in frontdata.toOccupantData.
let FD;
beforeAll(async () => {
  FD = await import('../managers/frontdata.ts');
});

// terminationDate/endDate come from mongo as Date objects (or ISO strings) —
// toOccupantData reformats them with moment.utc(value) (no format string), so
// the test must pass Date/ISO, NOT a 'DD/MM/YYYY' string (which moment can't
// parse and would turn into "Invalid date").
const mk = (terminationDate) => ({
  name: 'T',
  terminationDate,
  endDate: new Date('2028-02-28T00:00:00Z'),
  properties: [{ propertyId: 'p1' }],
  rents: [],
  contacts: [],
  leaseId: null
});

describe('#5 terminate-today', () => {
  test('terminationDate = today → terminated=true, status=stopped', () => {
    const today = moment.utc().toDate();
    const o = FD.toOccupantData(mk(today));
    expect(o.terminated).toBe(true);
    expect(o.status).toBe('stopped');
  });

  test('terminationDate clearly in the future → still in force', () => {
    // +10 days avoids the ±1-day clock-rollover boundary that makes tight
    // relative-date assertions flaky in a long-running env.
    const future = moment.utc().add(10, 'day').toDate();
    const o = FD.toOccupantData(mk(future));
    expect(o.terminated).toBe(false);
    expect(o.status).toBe('inprogress');
  });

  test('terminationDate clearly in the past → terminated', () => {
    const past = moment.utc().subtract(10, 'day').toDate();
    const o = FD.toOccupantData(mk(past));
    expect(o.terminated).toBe(true);
  });
});
