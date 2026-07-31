import moment from 'moment';

// D-restore (2026-07 review): the restore-success toast names the snapshot that
// just overwrote the realm. `exportDate` is echoed straight back from the
// CLIENT-UPLOADED backup JSON — databasemanager.ts does
// `exportDate: payload.exportDate` with NO validation, and the only client-side
// gate is `data.version && data.collections`. So the toast's guard is the last
// line of defence, and "truthy && moment().isValid()" was not enough:
// moment({}) / moment([]) / moment({$date: …}) are all truthy AND report valid,
// resolving to NOW — printing TODAY as the snapshot identity on a DESTRUCTIVE
// operation, which is the precise misstatement the guard exists to prevent.
//
// This mirrors the guard from
// webapps/landlord/src/pages/[organization]/settings/database.js.
function resolveExportDate(exportDate) {
  const raw = typeof exportDate === 'string' ? exportDate.trim() : '';
  return raw && moment(raw).isValid() ? moment(raw).format('L HH:mm') : null;
}

describe('restore toast — exportDate guard', () => {
  it('formats a real ISO export date', () => {
    const out = resolveExportDate('2026-07-15T09:30:00.000Z');
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/\d{2}:\d{2}$/);
  });

  it('returns null for an ABSENT date rather than moment()=NOW', () => {
    // moment(undefined) is NOW and isValid() is TRUE, so an isValid()-only
    // guard would confidently print today's date.
    expect(resolveExportDate(undefined)).toBeNull();
    expect(resolveExportDate(null)).toBeNull();
    expect(resolveExportDate('')).toBeNull();
    expect(resolveExportDate('   ')).toBeNull();
  });

  it('returns null for truthy NON-STRING shapes that moment calls valid', () => {
    // THE MUTATION-KILLER: drop the `typeof === 'string'` narrowing and each of
    // these renders today's date instead of null.
    for (const bad of [
      {},
      [],
      { $date: '2026-01-01' },
      { y: 1 },
      12345,
      true
    ]) {
      expect(resolveExportDate(bad)).toBeNull();
    }
    // Sanity: prove the danger is real for at least one of them — moment DOES
    // consider a bare object valid, which is why narrowing is required.
    expect(moment({}).isValid()).toBe(true);
  });

  it('returns null for a garbage string moment cannot parse', () => {
    expect(resolveExportDate('not-a-date')).toBeNull();
  });
});
