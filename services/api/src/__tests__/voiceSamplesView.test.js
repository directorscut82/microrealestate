/* eslint-env node, jest */
/**
 * The settings-card view of voiceCommand samples (_voiceSampleView) — the pure
 * mapper behind GET /inbox/voicesamples. What matters:
 *   · transcript BODIES and decodes never reach the browser payload (whatever
 *     the landlord said to the bot is not UI data), only the first message's
 *     modality for the 🎤/⌨️ icon;
 *   · a rejected row with no slots still renders (nulls, not crashes);
 *   · corrections defaults to 0 for rows written before the field existed.
 * The mongo query + stats counting are exercised end-to-end by the Playwright
 * spec against the live NAS (seeded via direct insert).
 */
let view;

beforeAll(async () => {
  ({ _voiceSampleView: view } = await import('../managers/inboxmanager.js'));
});

const FULL_ROW = {
  _id: 'i1',
  createdDate: new Date('2026-08-16T14:32:00Z'),
  voiceCommand: {
    intent: 'rentPayment',
    personId: 't1',
    personName: 'ΒΗΤΑΣ ΚΩΝΣΤΑΝΤΙΝΟΣ',
    personConfidence: 0.98,
    amount: 350,
    amountSource: 'text',
    month: 8,
    transcript: [
      { text: 'ΠΛΗΡΩΜΗ ΕΝΟΙΚΙΟΥ ΒΗΤΑΣ', source: 'voice' },
      { text: '350', source: 'text' },
      { text: 'ναι', source: 'text' }
    ],
    telegramFileIds: ['f1'],
    decodes: [
      { mode: 'command', p: 0.9, lr: -20, nFrames: 142, accept: true }
    ],
    corrections: 0,
    outcome: 'validated'
  }
};

it('maps the full row: slots + outcome + FIRST-message modality, nothing more', () => {
  const [v] = view([FULL_ROW]);
  expect(v).toEqual({
    _id: 'i1',
    createdDate: FULL_ROW.createdDate,
    intent: 'rentPayment',
    personName: 'ΒΗΤΑΣ ΚΩΝΣΤΑΝΤΙΝΟΣ',
    amount: 350,
    month: 8,
    corrections: 0,
    outcome: 'validated',
    firstSource: 'voice'
  });
  // The privacy property, stated as an assertion: no transcript text, no
  // decodes, no confidence/ids leak through whatever the row grows next.
  expect(JSON.stringify(v)).not.toContain('ΠΛΗΡΩΜΗ');
  expect(v.transcript).toBeUndefined();
  expect(v.decodes).toBeUndefined();
  expect(v.personId).toBeUndefined();
});

it('a rejected row with NO slots maps to nulls, not a crash', () => {
  const [v] = view([
    {
      _id: 'i2',
      createdDate: new Date(),
      voiceCommand: {
        transcript: [{ text: 'καλημέρα τι κάνεις', source: 'text' }],
        corrections: 0,
        outcome: 'rejected'
      }
    }
  ]);
  expect(v.intent).toBeNull();
  expect(v.personName).toBeNull();
  expect(v.amount).toBeNull();
  expect(v.month).toBeNull();
  expect(v.outcome).toBe('rejected');
  expect(v.firstSource).toBe('text');
});

it('tolerates a degenerate row: missing voiceCommand, missing corrections, empty transcript', () => {
  const [a, b] = view([
    { _id: 'i3', createdDate: new Date() },
    {
      _id: 'i4',
      createdDate: new Date(),
      voiceCommand: { intent: 'ownerPayment', transcript: [], outcome: 'abandoned' }
    }
  ]);
  expect(a.outcome).toBeNull();
  expect(a.corrections).toBe(0);
  expect(b.firstSource).toBeNull();
  expect(b.corrections).toBe(0);
});
