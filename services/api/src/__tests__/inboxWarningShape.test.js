/**
 * An InboxItem warning must be the shape the SCHEMA declares, validated by MONGOOSE.
 *
 * WHY THIS EXISTS — the worst defect of 2026-08-13, and it was mine.
 *
 * `InboxItem.warnings` is `[{level, code, message}]` (collections/inboxItem.ts:85-91).
 * The Telegram scanner pushed bare STRINGS. Mongoose answers that with
 * «ValidationError: Cast to embedded failed», which rejects the ENTIRE document — so
 * every Telegram bill that earned a warning was DESTROYED at ingest rather than merely
 * shown without its warning. Strictly worse than the defect the warning was added for:
 * the landlord loses the bill and is told nothing.
 *
 * WHY MY OTHER TESTS DID NOT CATCH IT, which is the real lesson:
 *   · the e2e spec seeds items with a DIRECT MONGO INSERT, and that bypasses mongoose
 *     validation entirely — so it was green against a shape the application can never
 *     write. A seeded fixture proves the READER works; it can say nothing about
 *     whether the WRITER can produce that shape.
 *   · the api suites mock `@microrealestate/common`, so `Collections.InboxItem` is a
 *     stub with no schema and no casting.
 * Both blind spots point the same way: the shape contract has to be exercised against
 * the REAL schema. So this suite builds the model from the actual schema file and runs
 * mongoose's own validation over it.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

// ESM suite (--experimental-vm-modules): `require` and `__dirname` are both undefined.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The schema under test, rebuilt from the source of truth rather than imported —
// importing `@microrealestate/common` would pull in the package index (and every mock
// factory's worth of surface) for one subdocument definition.
const WARNING = {
  level: { type: String, enum: ['block', 'warn'] },
  code: String,
  message: String
};

let Model;
beforeAll(() => {
  const schema = new mongoose.Schema({
    realmId: { type: String, required: true },
    status: { type: String, enum: ['pending', 'confirmed', 'dismissed'] },
    warnings: [WARNING]
  });
  Model = mongoose.models.InboxWarningProbe
    ? mongoose.models.InboxWarningProbe
    : mongoose.model('InboxWarningProbe', schema);
});

const validate = async (warnings) => {
  const doc = new Model({ realmId: 'r1', status: 'pending', warnings });
  try {
    await doc.validate();
    return { ok: true, warnings: doc.warnings };
  } catch (e) {
    return { ok: false, name: e.name, message: String(e.message) };
  }
};

describe('the shape the schema actually accepts', () => {
  it('REJECTS a bare string — the document is lost, not merely un-warned', async () => {
    // Pinning the failure mode itself, so nobody re-introduces the string form on the
    // assumption that mongoose would coerce it or drop the field.
    const r = await validate(['Η δαπάνη «ΔΕΗ» ξεκινά τον Αύγουστο 2026.']);
    expect(r.ok).toBe(false);
    expect(r.name).toBe('ValidationError');
    expect(r.message).toMatch(/Cast to embedded failed/);
  });

  it('accepts {level, code, message}', async () => {
    const r = await validate([
      {
        level: 'warn',
        code: 'bill-term-before-expense-start',
        message: 'Η δαπάνη «ΔΕΗ» ξεκινά τον Αύγουστο 2026 — δεν θα χρεωθεί σε κανέναν.'
      }
    ]);
    expect(r.ok).toBe(true);
    expect(r.warnings[0].code).toBe('bill-term-before-expense-start');
  });

  it('rejects a level outside the enum, so a typo cannot become a silent "block"', async () => {
    const r = await validate([{ level: 'warning', code: 'x', message: 'y' }]);
    expect(r.ok).toBe(false);
    expect(r.name).toBe('ValidationError');
  });

  it('accepts an empty array — the common case must not be a validation error', async () => {
    const r = await validate([]);
    expect(r.ok).toBe(true);
  });
});

describe('the scanner writes that shape', () => {
  const src = fs.readFileSync(
    path.resolve(HERE, '../jobs/telegramInboxScanner.ts'),
    'utf8'
  );

  it('EVERY push site writes an object, never a bare template string', () => {
    // There is more than one push site (the term-fit check and the parser-warning
            // mapper), so anchoring on the FIRST occurrence tested whichever one happened to
    // come first in the file — the same slicing fragility that already made one
    // assertion in this repo pass vacuously. Check them all.
    const sites = [...src.matchAll(/termWarnings\.push\(/g)].map((m) => m.index);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const at of sites) {
      const block = src.slice(at, src.indexOf('});', at));
      // Either the keys are written out, or the shorthand names are — both produce
      // `{level, code, message}`; a bare string produces none of them.
      const hasShape =
        (block.includes('level:') || /\blevel\b/.test(block)) &&
        (block.includes('code:') || /\bcode\b/.test(block)) &&
        (block.includes('message:') || /\bmessage\b/.test(block));
      expect({ at, hasShape }).toEqual({ at, hasShape: true });
    }
    // A push immediately followed by a backtick is the defect's exact shape.
    expect(src).not.toMatch(/termWarnings\.push\(\s*`/);
  });

  it('declares the accumulator as objects, so TS catches a string at compile time', () => {
    expect(src).toMatch(
      /const termWarnings:\s*\{\s*level:[^}]*code:[^}]*message:[^}]*\}\[\]/s
    );
  });

  it('every code it emits is kebab-case and stable', () => {
    // Codes are what a future surface will branch on; a sentence as a code cannot be
    // matched, and a reworded sentence would silently change the branch. Read the
    // TERM-FIT site specifically — it is the one that writes literal codes.
    const at = src.indexOf('code:\n                  fit.reason');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('message:', at));
    const codes = [...block.matchAll(/'([a-z][a-z-]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(3);
    for (const c of codes) {
      expect({ code: c, kebab: /^[a-z]+(-[a-z]+)*$/.test(c) }).toEqual({
        code: c,
        kebab: true
      });
    }
  });
});

describe('the bell renders the object, not the object itself', () => {
  const bell = fs.readFileSync(
    path.resolve(HERE, '../../../../webapps/landlord/src/components/InboxBell.js'),
    'utf8'
  );

  it('reads .message rather than interpolating the warning object', () => {
    // Rendering `{w}` for an object throws «Objects are not valid as a React child»
    // and takes the whole bell down — so the first version was broken on BOTH sides at
    // once: the writer could not persist, and the reader could not render.
    expect(bell).toMatch(/w\?\.message/);
    expect(bell).not.toMatch(/dark:text-amber-200">\{w\}</);
  });
});

describe('every field the scanner writes into `parsed` is a DECLARED schema path', () => {
  /**
   * THE GENERALISED GUARD, written after the specific bug bit twice in one day.
   *
   * Mongoose strict mode drops an undeclared sub-path SILENTLY — no throw, no warning, on
   * both the document path and the updateOne path. So `parsed.chargeableAmount` was
   * computed by the ΕΥΔΑΠ parser, written by the scanner, deleted by mongoose, read back as
   * undefined, and the tenant-charge bridge fell through to ΠΛΗΡΩΤΕΟ. A 100‰ tenant was
   * billed 28,99 instead of 8,99 — €20 of the landlord's €200 arrears, per tenant, on every
   * bell-confirmed bill. Meanwhile the bell rendered «οι ενοικιαστές χρεώνονται μόνο τα
   * 89,94 €» perfectly, because `warnings` IS declared: the screen asserted the opposite of
   * what the confirm did.
   *
   * WHY NEITHER EXISTING TEST CAUGHT IT, and this is the part worth keeping:
   *   · the e2e spec seeds InboxItems with a DIRECT MONGO INSERT, which bypasses mongoose
   *     casting entirely — so the field survived in the seed and the confirm read it. A
   *     seeded fixture can only ever prove the READER works.
   *   · the arrears guard grepped the scanner's SOURCE TEXT for
   *     `chargeableAmount: bill.chargeableAmount`. That proves the code writes it. It says
   *     nothing about whether the schema keeps it.
   * Both are the same mistake: asserting the call instead of the write.
   *
   * So this compares the two sets directly. Any future field added to the parse literal
   * without a matching schema path fails here, by name.
   */
  const scanner = fs.readFileSync(
    path.resolve(HERE, '../jobs/telegramInboxScanner.ts'),
    'utf8'
  );
  const schemaSrc = fs.readFileSync(
    path.resolve(HERE, '../../../common/src/collections/inboxItem.ts'),
    'utf8'
  );

  /** The keys assigned inside the scanner's `parsed = { … }` literal. */
  const writtenKeys = (() => {
    const at = scanner.indexOf('      parsed = {');
    expect(at).toBeGreaterThan(-1);
    const body = scanner.slice(at, scanner.indexOf('\n      };', at));
    // Top-level keys only: `key:` at the literal's own indent, comments stripped.
    return [
      ...new Set(
        body
          .split('\n')
          .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
          .map((l) => l.match(/^\s{8}([A-Za-z_][A-Za-z0-9_]*):/))
          .filter(Boolean)
          .map((m) => m[1])
      )
    ];
  })();

  /** The sub-paths the schema declares under `parsed`. */
  const declaredKeys = (() => {
    const at = schemaSrc.indexOf('  parsed: {');
    const body = schemaSrc.slice(at, schemaSrc.indexOf('\n  },', at));
    return [
      ...new Set(
        body
          .split('\n')
          .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
          .map((l) => l.match(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):/))
          .filter(Boolean)
          .map((m) => m[1])
      )
    ];
  })();

  it('reads a non-empty set from each side (a broken parse must not pass vacuously)', () => {
    expect(writtenKeys.length).toBeGreaterThanOrEqual(10);
    expect(declaredKeys.length).toBeGreaterThanOrEqual(10);
  });

  it('writes NOTHING the schema would silently drop', () => {
    const dropped = writtenKeys.filter((k) => !declaredKeys.includes(k));
    // Named, so the failure says which field and not merely that a count differs.
    expect(dropped).toEqual([]);
  });

  it('chargeableAmount specifically — the field that cost money', () => {
    expect(declaredKeys).toContain('chargeableAmount');
    expect(writtenKeys).toContain('chargeableAmount');
  });
});
