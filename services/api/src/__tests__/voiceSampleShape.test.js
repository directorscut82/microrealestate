/* eslint-env node, jest */
/**
 * The voiceCommand sample row must carry createdDate (declared) — NOT
 * receivedDate (undeclared, silently dropped by mongoose strict, the
 * chargeableAmount incident). Verified against the REAL InboxItem schema:
 * a doc built the way _saveVoiceSample builds it must keep createdDate after
 * casting, and receivedDate must not survive.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

it('_saveVoiceSample writes createdDate, not the strict-dropped receivedDate', () => {
  // Source-level: the scanner's writer uses createdDate and no longer references
  // receivedDate for the voice sample.
  const scanner = fs.readFileSync(path.join(HERE, '../jobs/telegramInboxScanner.ts'), 'utf8');
  // Scope to the _saveVoiceSample function body — an earlier version anchored on
  // the first "kind: 'voiceCommand'", which is the sampleExists QUERY, not the
  // create().
  const fnAt = scanner.indexOf('async function _saveVoiceSample');
  expect(fnAt).toBeGreaterThan(-1);
  const body = scanner.slice(fnAt, scanner.indexOf('\n}', fnAt));
  expect(body).toContain("kind: 'voiceCommand'");
  expect(body).toContain('createdDate: new Date()');
  // The bill lane uses receivedDate; the voice sample must NOT (undeclared path).
  expect(body).not.toMatch(/receivedDate:/);
});

it('the InboxItem schema declares createdDate but NOT receivedDate', () => {
  const schema = fs.readFileSync(
    path.join(HERE, '../../../common/src/collections/inboxItem.ts'),
    'utf8'
  );
  expect(schema).toMatch(/createdDate/);
  expect(schema).not.toMatch(/receivedDate:/);
});
