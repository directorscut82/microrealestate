/**
 * A bill's month vs its expense's active range — ONE rule, two implementations,
 * pinned to one case table.
 *
 * WHY THIS EXISTS. When a bill's `term` falls outside its expense's
 * `startTerm`..`endTerm`, the rent engine charges that expense for no month at all,
 * so the bill's amount is recorded and lands on NO surface. It is not an error
 * anywhere: the bill saves, the expense exists, the money simply never appears.
 *
 * It happened in live data — a ΔΕΗ bill for June 2026 attached to an expense whose
 * startTerm is August 2026: €120 recorded, €0 charged, and nothing on any screen
 * said so. The upload dialog warned about it by re-deriving the comparison inline;
 * the Telegram lane hardcoded `warnings: []` and said nothing at all. Two ingest
 * doors, one rule, one of them enforcing it.
 *
 * The rule now lives in `services/common/src/utils/billterm.ts`, with a browser copy
 * at `webapps/landlord/src/utils/billTerm.js` because the frontend cannot import the
 * server lib (mongoose in the package index). This suite runs the SAME table through
 * both, so the two cannot drift — the arrangement `variableexpense` uses.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  billTermFitsExpense as serverFits,
  computeChargeTerm as serverChargeTerm
} from '@microrealestate/common/dist/utils/billterm.js';
import CASES from '@microrealestate/common/dist/utils/billterm.cases.json';

// ESM suite — `require` is not defined here (this file is loaded by
// --experimental-vm-modules). The browser copy is exercised by the landlord-side
// suite against this same table; jest cannot load an ESM module from another
// workspace in this project's config.
const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('billTermFitsExpense — server implementation', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(serverFits(c.expense, c.term)).toEqual(c.expected);
    });
  }
});

describe('both ingest doors carry the warning', () => {
  const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

  it('the Telegram lane no longer hardcodes an empty warnings array', () => {
    // This is the defect itself: `warnings: []` meant the bot lane could never warn
    // about anything, so the rule existed for one door only.
    const scanner = read('../jobs/telegramInboxScanner.ts');
    expect(scanner).toContain('warnings: termWarnings');
    expect(scanner).toContain('BillTerm.billTermFitsExpense');
  });

  it('the persistent surface uses the shared rule, not a third copy', () => {
    // The import-time warnings vanish the moment the operator moves on; the money
    // stays invisible forever after. The panel warning is the one that persists.
    const panel = read(
      '../../../../webapps/landlord/src/components/buildings/BuildingExpensePanel.js'
    );
    expect(panel).toContain("from '../../utils/billTerm'");
    expect(panel).toContain('billTermIsOutsideExpense');
    // And it must not re-derive the comparison inline.
    expect(panel).not.toMatch(/startTerm\s*\)\s*>\s*Number\(/);
  });
});

describe('computeChargeTerm — WHICH MONTH the amount is charged in', () => {
  const d = (iso) => new Date(`${iso}T00:00:00.000Z`);

  it('uses the ISSUE month, not the end of the measured period', () => {
    // THE REPORTED CASE. A real ΕΥΔΑΠ bill measures 28/04–23/07 and is issued 04/08.
    // The old rule keyed on periodEnd and charged JULY — a month whose κοινόχρηστα
    // may already be issued and whose rents may already be paid. The landlord
    // receives it in August, pays it in August, charges it in August.
    expect(
      serverChargeTerm({ periodEnd: d('2026-07-23'), issueDate: d('2026-08-04') })
    ).toBe(2026080100);
  });

  it('is unchanged for a bill issued inside its own period month', () => {
    // A ΔΕΗ monthly bill: this must not move, or the change would re-term every
    // electricity bill in the realm for no reason.
    expect(
      serverChargeTerm({ periodEnd: d('2026-07-09'), issueDate: d('2026-07-12') })
    ).toBe(2026070100);
  });

  it('removes the shape that charged nobody', () => {
    // A bill for June attached to an expense starting in August left €120 on no
    // surface. periodEnd proposed June (before startTerm); the issue date proposes
    // August, and an issue date can never precede the period it bills — so this
    // rule can only ever propose a month at or after the old one.
    expect(
      serverChargeTerm({ periodEnd: d('2026-06-28'), issueDate: d('2026-08-04') })
    ).toBe(2026080100);
  });

  it('falls back to periodEnd when no issue date was read', () => {
    // OCR does not always recover the issue date. Falling back keeps every bill
    // termable rather than refusing it — the previous behaviour, preserved.
    expect(serverChargeTerm({ periodEnd: d('2026-07-23') })).toBe(2026070100);
  });

  it('returns undefined when neither date exists, instead of a garbage term', () => {
    expect(serverChargeTerm({})).toBeUndefined();
    expect(serverChargeTerm({ issueDate: null, periodEnd: '' })).toBeUndefined();
  });

  it('accepts ISO strings, which is how the dates arrive from mongo', () => {
    expect(
      serverChargeTerm({ issueDate: '2026-08-04T00:00:00.000Z' })
    ).toBe(2026080100);
  });

  it('reads the anchor in UTC so an Athens boundary cannot slip a month', () => {
    // 01/08 00:00 UTC must be AUGUST. Built as a local Date in Athens summer
    // (UTC+3) it would be July 31 21:00Z and charge the whole bill to July.
    expect(serverChargeTerm({ issueDate: d('2026-08-01') })).toBe(2026080100);
    expect(
      serverChargeTerm({ issueDate: new Date('2026-08-01T00:30:00+03:00') })
    ).toBe(2026070100); // 31/07 21:30Z — the very slip the UTC rule exists to avoid
  });

  it('BOTH ingest lanes go through it — neither keeps a private copy', () => {
    const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');
    for (const f of [
      '../managers/billmanager.ts',
      '../jobs/telegramInboxScanner.ts'
    ]) {
      const src = read(f);
      expect({ file: f, usesShared: src.includes('computeChargeTerm') }).toEqual({
        file: f,
        usesShared: true
      });
      // The private copy each of them carried must be gone, or the two lanes can
      // decide the charge month differently again.
      expect({
        file: f,
        hasPrivateCopy: /function computeDefaultTerm\(periodEnd: Date\)/.test(src)
      }).toEqual({ file: f, hasPrivateCopy: false });
    }
  });
});
