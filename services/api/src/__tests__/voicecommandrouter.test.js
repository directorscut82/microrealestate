/* eslint-env node, jest */
/**
 * The voice-command ROUTER: which Telegram messages it claims, which it must
 * let fall through to bill handling.
 *
 * THE FINDING THAT CREATED THIS FILE (gate-3 of the full review): with a
 * dialogue open, a bill PHOTO carried neither voice nor text, so the router
 * built an EMPTY text utterance, fed it to the state machine, and returned
 * "claimed" — the bill was swallowed and never ingested. Silent bill loss,
 * the exact shape recapturesession.ts already documents guarding against
 * (isRecaptureCandidate's parsedAsFullBill gate). The first test pins the fix:
 * a document/photo is NEVER dialogue material.
 */
let handleVoiceCommand;
let VS;

beforeAll(async () => {
  ({ handleVoiceCommand } = await import('../jobs/voicecommandhandler.js'));
  VS = await import('../managers/voicesession.js');
});

beforeEach(() => VS._clearAll());

const REALM = { realmId: 'r1', botToken: 'tok' };
const PEOPLE = [{ id: 't1', name: 'ΜΑΝΤΑΣ' }];

function makeDeps(overrides = {}) {
  const sent = [];
  const saved = [];
  return {
    sent,
    saved,
    deps: {
      now: () => new Date(1_000_000),
      newId: () => 'sess-1',
      downloadFileById: async () => Buffer.from('audio'),
      recognize: async (_a, mode) => ({
        ok: true,
        mode,
        transcript: 'ΠΛΗΡΩΜΗ ΕΝΟΙΚΙΟΥ ΜΑΝΤΑΣ',
        value: null,
        p: 0.9,
        lr: -20,
        accept: true,
        reason: 'rank',
        ms: 100
      }),
      peopleForRealm: async () => PEOPLE,
      sendReply: async (_t, _c, text) => {
        sent.push(text);
        return 1;
      },
      saveSample: async (s) => {
        saved.push(s);
      },
      ...overrides
    }
  };
}

describe('what the router must NOT claim', () => {
  it('a bill DOCUMENT falls through even with a dialogue open (the bill-loss fix)', async () => {
    const { deps } = makeDeps();
    // open a dialogue first
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Μάντας' }, deps);
    // now a bill arrives as a document — this is a BILL, not a dialogue reply
    const claimed = await handleVoiceCommand(
      REALM,
      { message_id: 2, chat: { id: 5 }, document: { file_id: 'bill-1' } },
      deps
    );
    expect(claimed).toBe(false); // falls through → the scanner ingests it
  });

  it('a bill PHOTO falls through too', async () => {
    const { deps } = makeDeps();
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Μάντας' }, deps);
    const claimed = await handleVoiceCommand(
      REALM,
      { message_id: 2, chat: { id: 5 }, photo: [{ file_id: 'p1' }] },
      deps
    );
    expect(claimed).toBe(false);
  });

  it('a non-command text with NO open dialogue falls through', async () => {
    const { deps } = makeDeps();
    const claimed = await handleVoiceCommand(
      REALM,
      { message_id: 1, chat: { id: 5 }, text: 'καλημέρα' },
      deps
    );
    expect(claimed).toBe(false);
  });

  it('a sticker-like message (no audio, no text) with a dialogue open falls through', async () => {
    const { deps } = makeDeps();
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Μάντας' }, deps);
    const claimed = await handleVoiceCommand(REALM, { message_id: 2, chat: { id: 5 } }, deps);
    expect(claimed).toBe(false);
  });
});

describe('what the router claims', () => {
  it('a voice note with no session starts a dialogue', async () => {
    const { deps, sent } = makeDeps();
    const claimed = await handleVoiceCommand(
      REALM,
      { message_id: 1, chat: { id: 5 }, voice: { file_id: 'v1' } },
      deps
    );
    expect(claimed).toBe(true);
    expect(sent.length).toBe(1); // the bot replied something
  });

  it('a money-intent TEXT starts a dialogue and asks for the missing slot', async () => {
    const { deps, sent } = makeDeps();
    const claimed = await handleVoiceCommand(
      REALM,
      { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Μάντας 350' },
      deps
    );
    expect(claimed).toBe(true);
    expect(sent[0]).toMatch(/μήνα/); // month missing → asked
  });

  it('a full dialogue: command → month → ναι → sample saved, correct slots', async () => {
    const { deps, sent, saved } = makeDeps();
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Μάντας 350' }, deps);
    await handleVoiceCommand(REALM, { message_id: 2, chat: { id: 5 }, text: 'Αύγουστος' }, deps);
    expect(sent[1]).toMatch(/Επιβεβαιώστε/);
    await handleVoiceCommand(REALM, { message_id: 3, chat: { id: 5 }, text: 'ναι' }, deps);
    expect(saved).toHaveLength(1);
    expect(saved[0].slots).toMatchObject({
      intent: 'rentPayment',
      person: { id: 't1' },
      amount: { value: 350 },
      month: 8
    });
    expect(saved[0].outcome).toBe('validated');
    // and the session is closed — the next text is a fresh routing decision
    const claimed = await handleVoiceCommand(REALM, { message_id: 4, chat: { id: 5 }, text: 'καλημέρα' }, deps);
    expect(claimed).toBe(false);
  });

  it('voiceasr unreachable → honest reply, still claimed, no crash', async () => {
    const { deps, sent } = makeDeps({ recognize: async () => null });
    const claimed = await handleVoiceCommand(
      REALM,
      { message_id: 1, chat: { id: 5 }, voice: { file_id: 'v1' } },
      deps
    );
    expect(claimed).toBe(true);
    expect(sent[0]).toMatch(/δεν είναι διαθέσιμη|Γράψτε/);
  });

  it('saveSample failure does not crash the poll path', async () => {
    const { deps } = makeDeps({
      saveSample: async () => {
        throw new Error('mongo down');
      }
    });
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Μάντας 350' }, deps);
    await handleVoiceCommand(REALM, { message_id: 2, chat: { id: 5 }, text: 'Αύγουστος' }, deps);
    await expect(
      handleVoiceCommand(REALM, { message_id: 3, chat: { id: 5 }, text: 'ναι' }, deps)
    ).resolves.toBe(true);
  });
});
