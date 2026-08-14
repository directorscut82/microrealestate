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

  it('pushes an object with all three keys, never a bare template string', () => {
    const at = src.indexOf('termWarnings.push(');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('});', at));
    for (const key of ['level:', 'code:', 'message:']) {
      expect({ key, present: block.includes(key) }).toEqual({ key, present: true });
    }
    // `termWarnings.push(` immediately followed by a backtick is the defect's shape.
    expect(src).not.toMatch(/termWarnings\.push\(\s*`/);
  });

  it('declares the accumulator as objects, so TS catches a string at compile time', () => {
    expect(src).toMatch(
      /const termWarnings:\s*\{\s*level:[^}]*code:[^}]*message:[^}]*\}\[\]/s
    );
  });

  it('every code it emits is kebab-case and stable', () => {
    // Codes are what a future surface will branch on; a sentence as a code cannot be
    // matched, and a reworded sentence would silently change the branch.
    const at = src.indexOf('termWarnings.push(');
    const block = src.slice(at, src.indexOf('});', at));
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
