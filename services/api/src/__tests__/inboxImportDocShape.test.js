/* eslint-env node, jest */
/**
 * The importDoc payload must actually reach the database.
 *
 * `parsed` is deliberately Mixed (see the schema comment): the parser output
 * is stored verbatim, so a declared-subdoc copy of the parser's ~60 paths
 * would silently prune whatever the parser grows next — the chargeableAmount
 * incident with a bigger surface. This proves the choice from both sides:
 *   · Mixed keeps DEEP nested fields it was never told about;
 *   · the SIBLING declared `summary` block still strict-drops an undeclared
 *     field — i.e. the schema really is strict and `parsed` survives only
 *     because it is Mixed, not because strictness is broken.
 * Plus source anchors pinning writer and schema together.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const HERE = path.dirname(fileURLToPath(import.meta.url));

it('the scanner writes importDoc and the REAL schema declares it (Mixed parsed + declared summary)', () => {
  const scanner = fs.readFileSync(
    path.join(HERE, '../jobs/telegramInboxScanner.ts'),
    'utf8'
  );
  const fnAt = scanner.indexOf('async function _parseImportDocAndFinish');
  expect(fnAt).toBeGreaterThan(-1);
  const body = scanner.slice(fnAt, scanner.indexOf('\n}', fnAt));
  expect(body).toContain('importDoc: parsed');

  const schema = fs.readFileSync(
    path.join(HERE, '../../../common/src/collections/inboxItem.ts'),
    'utf8'
  );
  const at = schema.indexOf('importDoc: {');
  expect(at).toBeGreaterThan(-1);
  const block = schema.slice(at, schema.indexOf('notice: {', at));
  expect(block).toMatch(/parsed:\s*mongoose\.Schema\.Types\.Mixed/);
  expect(block).toMatch(/docKind:\s*String/);
  expect(block).toMatch(/title:\s*String/);
  expect(block).toMatch(/classification:\s*String/);
  // and the kinds exist in the enum
  expect(schema).toContain("'leaseImport'");
  expect(schema).toContain("'e9Import'");
});

it('Mixed keeps the deep parse verbatim; the declared summary still strict-drops', () => {
  const Probe =
    mongoose.models.ImportDocProbe ||
    mongoose.model(
      'ImportDocProbe',
      new mongoose.Schema({
        realmId: String,
        importDoc: {
          type: {
            docKind: String,
            parsed: mongoose.Schema.Types.Mixed,
            summary: {
              title: String,
              subtitle: String,
              classification: String
            }
          },
          default: null
        }
      })
    );

  const doc = new Probe({
    realmId: 'r1',
    importDoc: {
      docKind: 'e9',
      parsed: {
        owner: { taxId: '999000018', lastName: 'ΔΟΚΙΜΗ' },
        buildings: [
          {
            address: { street1: 'ΟΔΟΣ ΑΛΦΑ 12' },
            units: [
              {
                atakNumber: '12345678901',
                coOwners: [{ name: 'ΛΟΙΠΟΙ', percentage: 50 }],
                // a field NO schema was ever told about — the exact shape a
                // parser upgrade produces; it must survive
                futureParserField: { nested: ['α', 'β'] }
              }
            ]
          }
        ],
        skippedLandPlots: 0
      },
      summary: {
        title: '1 κτίριο · 1 μονάδα',
        // undeclared sibling in the DECLARED block — must vanish, proving
        // strictness is live and parsed survives only through Mixed
        rogueField: 'must-not-survive'
      }
    }
  });

  const out = doc.toObject().importDoc;
  expect(out.parsed.buildings[0].units[0].coOwners[0].name).toBe('ΛΟΙΠΟΙ');
  expect(out.parsed.buildings[0].units[0].futureParserField.nested).toEqual([
    'α',
    'β'
  ]);
  expect(out.summary.title).toBe('1 κτίριο · 1 μονάδα');
  expect(out.summary.rogueField).toBeUndefined();
});
