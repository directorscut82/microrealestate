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
import { billTermFitsExpense as serverFits } from '@microrealestate/common/dist/utils/billterm.js';
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
