/**
 * A bill's ARREARS must never be split among the tenants.
 *
 * THE DEFECT. ΕΥΔΑΠ prints two figures: ΠΛΗΡΩΤΕΟ (what the landlord owes, any balance
 * carried from an earlier period included) and ΜΕΡΙΚΟ ΣΥΝΟΛΟ (this period's own
 * charges). The parser has separated them since Slice 3 and its docstring says why.
 * Everything downstream then read only `totalAmount`: `confirmBills` bridged ΠΛΗΡΩΤΕΟ
 * into the monthly statement, so on a bill of ΜΕΡΙΚΟ ΣΥΝΟΛΟ 89,94 / ΠΛΗΡΩΤΕΟ 289,94 a
 * 100‰ tenant was billed 28,99 instead of 8,99 — the landlord's €200 of arrears
 * distributed across the payers, every quarter.
 *
 * WHY THE EXISTING TEST DID NOT CATCH IT — the lesson worth keeping. There IS a test
 * named «flags a prior balance instead of letting it be split among tenants»
 * (eydapParser.test.js). It asserts the PARSER's output fields. The parser was never
 * wrong. A test named after a consequence must assert that consequence, or it is a
 * label on the wrong thing: it stayed green through the entire life of the defect.
 *
 * So this suite asserts the CONSUMERS. Every surface that could re-introduce the bug is
 * pinned by the thing it does with the number, not by the number existing.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

/** The exact selection `confirmBills` performs before charging tenants. */
const amountToCharge = (chargeableAmount, totalAmount) =>
  chargeableAmount === undefined || chargeableAmount === null
    ? Number(totalAmount)
    : Number(chargeableAmount);

describe('which figure reaches the tenants', () => {
  it('charges ΜΕΡΙΚΟ ΣΥΝΟΛΟ when the bill carries arrears', () => {
    // The reported shape. €200 of arrears must not reach a single tenant.
    expect(amountToCharge(89.94, 289.94)).toBe(89.94);
  });

  it('is unchanged when the two figures agree', () => {
    expect(amountToCharge(89.94, 89.94)).toBe(89.94);
  });

  it('is unchanged for a bill that states ONE figure — every ΔΕΗ bill', () => {
    // The no-regression case, and the overwhelmingly common one: absent means "use what
    // is owed", exactly as before.
    expect(amountToCharge(undefined, 120)).toBe(120);
    expect(amountToCharge(null, 57.5)).toBe(57.5);
  });

  it('does not "helpfully" cap a CREDIT balance', () => {
    // A payable BELOW the subtotal is a credit; the chargeable figure still governs, and
    // taking a min() here would quietly under-charge the tenants for this period.
    expect(amountToCharge(100, 80)).toBe(100);
  });

  it('treats 0 as a real figure, not as absent', () => {
    // `|| totalAmount` instead of a null check would turn a genuine zero-charge period
    // into a full charge — the classic falsy-zero money bug.
    expect(amountToCharge(0, 289.94)).toBe(0);
  });
});

describe('the CONSUMERS, so the value cannot be computed and dropped again', () => {
  const billmanager = read('../managers/billmanager.ts');

  it('the tenant-charge bridge receives the chargeable figure, not totalAmount', () => {
    // This is the defect's exact line. `bridgeChargeToStatement(..., Number(totalAmount)`
    // is what billed the arrears.
    expect(billmanager).toContain('amountToCharge');
    const at = billmanager.indexOf('await bridgeChargeToStatement(');
    expect(at).toBeGreaterThan(-1);
    const call = billmanager.slice(at, billmanager.indexOf(');', at));
    expect(call).toContain('amountToCharge');
    expect(call).not.toContain('Number(totalAmount)');
  });

  it('confirmBills accepts and PERSISTS it', () => {
    // Persisted so a later surface can recompute the split from the same figure the
    // import used; without a column the value is discarded at confirm.
    expect(billmanager).toMatch(/^\s+chargeableAmount,$/m);
    expect(billmanager).toContain('chargeableAmount:\n            chargeableAmount');
    const schema = read('../../../common/src/collections/bill.ts');
    expect(schema).toContain('chargeableAmount: Number');
  });

  it('the parse response carries it AND the parser warnings', () => {
    // Both were computed and dropped in the results whitelist, which is why neither the
    // code nor the human had the information.
    const at = billmanager.indexOf('textSource: parseResult.textSource');
    expect(at).toBeGreaterThan(-1);
    const block = billmanager.slice(at, at + 900);
    expect(block).toContain('chargeableAmount: bill.chargeableAmount');
    expect(block).toContain('warnings: bill.warnings');
  });

  it('the Telegram lane carries it too — it is the worse door', () => {
    // The bell renders the amount READ-ONLY, so on that lane there is no manual correction.
    const scanner = read('../jobs/telegramInboxScanner.ts');
    expect(scanner).toContain('chargeableAmount: bill.chargeableAmount');
    const inbox = read('../managers/inboxmanager.ts');
    expect(inbox).toContain('chargeableAmount:');
  });

  it('and the InboxItem SCHEMA keeps it — writing it is not the same as storing it', () => {
    /**
     * THIS ASSERTION IS WHY THE BUG SURVIVED. The test above greps the scanner for the
     * write and passes — it proves the code assigns the field. It cannot see that
     * `parsed.chargeableAmount` was not a declared sub-path, so mongoose strict mode
     * deleted it on the way to disk: parser computed 89,94, scanner wrote it, mongoose
     * dropped it, inboxmanager read undefined, and the bridge charged ΠΛΗΡΩΤΕΟ. A 100‰
     * tenant was billed 28,99 instead of 8,99 while the bell displayed «οι ενοικιαστές
     * χρεώνονται μόνο τα 89,94 €», because `warnings` IS declared.
     *
     * The e2e spec could not catch it either: it seeds InboxItems with a direct mongo
     * insert, which bypasses casting, so the field survived in the seed. A seeded fixture
     * proves the reader; only the schema proves the writer.
     */
    const inboxSchema = read('../../../common/src/collections/inboxItem.ts');
    const at = inboxSchema.indexOf('  parsed: {');
    expect(at).toBeGreaterThan(-1);
    const parsedBlock = inboxSchema.slice(at, inboxSchema.indexOf('\n  },', at));
    expect(parsedBlock).toContain('chargeableAmount: Number');
    // Both schemas, named together — the previous guard checked only Bill's.
    expect(read('../../../common/src/collections/bill.ts')).toContain(
      'chargeableAmount: Number'
    );
  });

  it('an AMENDED amount drops it on both lanes', () => {
    // Once the operator types a figure it is their answer to both questions; keeping a
    // parse-derived second figure beside it would silently disagree with what they typed.
    const inbox = read('../managers/inboxmanager.ts');
    expect(inbox).toMatch(
      /chargeableAmount:\s*\n?\s*totalAmount !== undefined \? undefined : p\.chargeableAmount/
    );
    const dialog = read(
      '../../../../webapps/landlord/src/components/buildings/BillImportDialog.js'
    );
    expect(dialog).toContain('? undefined');
    expect(dialog).toContain('r.parsed.chargeableAmount');
  });

  it('the landlord is TOLD when the two figures differ', () => {
    // A silent correction is still absent representation: the card shows the payable
    // figure, so without a sentence the landlord cannot know the numbers differ.
    const dialog = read(
      '../../../../webapps/landlord/src/components/buildings/BillImportDialog.js'
    );
    expect(dialog).toContain('const hasArrears =');
    // …and it must be inside the ONE consolidated warnings block, not a new amber box.
    const at = dialog.indexOf('hasArrears ||');
    expect(at).toBeGreaterThan(-1);
    const scanner = read('../jobs/telegramInboxScanner.ts');
    expect(scanner).toContain('prior-balance-included-in-payable');
    expect(scanner).toContain('_parserWarningMessage');
  });

  it('only the direction that costs money is warned about', () => {
    // A payable BELOW the subtotal is a credit and warning about it would be noise —
    // and noise is what trains an operator to dismiss the row that matters.
    const dialog = read(
      '../../../../webapps/landlord/src/components/buildings/BillImportDialog.js'
    );
    const at = dialog.indexOf('const hasArrears =');
    const expr = dialog.slice(at, dialog.indexOf(';', at));
    expect(expr).toMatch(/chargeableAmount\).{0,40}<.{0,40}totalAmount/s);
  });
});
