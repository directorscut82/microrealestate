/**
 * `isVariable` must have NO schema default.
 *
 * THE BUG THIS PINS (adversarial review, 2026-08-12): the field shipped as
 * `default: false`, which makes the "absent" state UNREACHABLE — and absent is
 * meaningful here, unlike every other boolean on this schema. Measured with this
 * repo's mongoose:
 *   · hydrating a legacy doc stamped `isVariable: false` onto every expense, so the
 *     predicate's legacy fallback could never run again;
 *   · `expenses.pull()` of a NON-LAST element emits a whole-array `$set`, which
 *     PERSISTED that false — so deleting one unrelated expense permanently
 *     reclassified every κυμαινόμενο row in the building, and the owner-expense
 *     projection then reported €0 for money the charge engine was still billing.
 *
 * This suite reads the schema source, because that is where the defect lived — a
 * behavioural test would need a live mongo, and the one-word regression (`false`)
 * is exactly what must never come back.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(
  path.resolve(HERE, '../../../common/src/collections/building.ts'),
  'utf8'
);

describe('isVariable schema default', () => {
  it('is declared, and NOT with `default: false`', () => {
    const line = SCHEMA.split('\n').find((l) => /^\s*isVariable:/.test(l));
    // NOTE: jest's expect takes ONE argument — `expect(x, 'msg')` is Playwright.
    expect({ field: 'isVariable', declared: !!line }).toEqual({
      field: 'isVariable',
      declared: true
    });
    expect(line).not.toMatch(/default:\s*false/);
  });

  it('declares `default: undefined` explicitly, so the intent is unmistakable', () => {
    const line = SCHEMA.split('\n').find((l) => /^\s*isVariable:/.test(l));
    expect(line).toMatch(/default:\s*undefined/);
  });

  it('every OTHER boolean on the expense schema may keep its default', () => {
    // Guard against over-correcting: absent === default is fine for these three,
    // which is why the same stamping is harmless for them.
    for (const field of [
      'isRecurring',
      'trackOwnerExpense',
      'chargeOwnerWhenVacant'
    ]) {
      const line = SCHEMA.split('\n').find((l) =>
        new RegExp(`^\\s*${field}:`).test(l)
      );
      expect({ field, declared: !!line }).toEqual({ field, declared: true });
    }
  });
});
