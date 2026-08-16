/* eslint-env node, jest */
/**
 * The voiceCommand sample row must carry createdDate (declared) — NOT
 * receivedDate (undeclared, silently dropped by mongoose strict, the
 * chargeableAmount incident). Verified against the REAL InboxItem schema:
 * a doc built the way _saveVoiceSample builds it must keep createdDate after
 * casting, and receivedDate must not survive.
 *
 * Same stakes for `decodes`: the per-call recognizer scores (p/lr/nFrames) ARE
 * the calibration dataset the shadow phase exists to collect. An undeclared
 * sub-path would be silently dropped at write — every sample a label with no
 * score — so the declaration is proven live from both sides: the writer sends
 * it (source anchor) and a schema shaped like the real one both keeps it and
 * demonstrably drops an undeclared sibling.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

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

describe('decodes — the calibration scores must actually reach the database', () => {
  it('the writer persists session.decodes and the REAL schema declares every field', () => {
    const scanner = fs.readFileSync(
      path.join(HERE, '../jobs/telegramInboxScanner.ts'),
      'utf8'
    );
    const fnAt = scanner.indexOf('async function _saveVoiceSample');
    const body = scanner.slice(fnAt, scanner.indexOf('\n}', fnAt));
    expect(body).toContain('decodes: session.decodes');

    const schema = fs.readFileSync(
      path.join(HERE, '../../../common/src/collections/inboxItem.ts'),
      'utf8'
    );
    // Scope to the voiceCommand block so a `decodes` elsewhere can't satisfy this.
    const vcAt = schema.indexOf('voiceCommand: {');
    const vcBlock = schema.slice(vcAt, schema.indexOf('notice: {', vcAt));
    expect(vcBlock).toMatch(/decodes:\s*\[/);
    for (const field of [
      'mode', 'value', 'p', 'lr', 'nFrames', 'truncMargin', 'truncAlt',
      'accept', 'reason', 'ms'
    ]) {
      expect(vcBlock).toMatch(new RegExp(`${field}:\\s*(String|Number|Boolean)`));
    }
  });

  it('a schema shaped like the declaration KEEPS the scores — and drops an undeclared sibling', () => {
    // Probe pattern (inboxWarningShape.test.js): the real collection file pulls the
    // whole common package in through its Realm import, so the sub-schema is rebuilt
    // exactly as declared; the source anchor above pins the two together.
    const Probe =
      mongoose.models.VoiceDecodesProbe ||
      mongoose.model(
        'VoiceDecodesProbe',
        new mongoose.Schema({
          realmId: String,
          voiceCommand: {
            type: {
              intent: String,
              decodes: [
                {
                  mode: String,
                  value: String,
                  p: Number,
                  lr: Number,
                  nFrames: Number,
                  truncMargin: Number,
                  truncAlt: Number,
                  accept: Boolean,
                  reason: String,
                  ms: Number
                }
              ],
              outcome: String
            },
            default: null
          }
        })
      );
    const doc = new Probe({
      realmId: 'r1',
      voiceCommand: {
        intent: 'rentPayment',
        decodes: [
          {
            mode: 'amount',
            value: '96',
            p: 0.8786,
            lr: -6.1,
            nFrames: 142,
            truncMargin: -0.44,
            truncAlt: 88,
            accept: true,
            reason: 'rank',
            ms: 2711,
            // UNDECLARED — must vanish silently, proving strict-drop is live
            // and therefore that every kept field above is kept only because
            // it is declared.
            spanSec: 1.9
          }
        ],
        outcome: 'validated'
      }
    });
    const out = doc.toObject().voiceCommand.decodes[0];
    expect(out.mode).toBe('amount');
    expect(out.value).toBe('96');
    expect(out.p).toBe(0.8786);
    expect(out.lr).toBe(-6.1);
    expect(out.nFrames).toBe(142);
    expect(out.truncMargin).toBe(-0.44);
    expect(out.truncAlt).toBe(88);
    expect(out.accept).toBe(true);
    expect(out.reason).toBe('rank');
    expect(out.ms).toBe(2711);
    expect(out.spanSec).toBeUndefined();
  });
});
