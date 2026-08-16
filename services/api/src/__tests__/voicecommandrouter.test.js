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
const PEOPLE = [{ id: 't1', name: 'ΒΗΤΑΣ' }];

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
        transcript: 'ΠΛΗΡΩΜΗ ΕΝΟΙΚΙΟΥ ΒΗΤΑΣ',
        value: null,
        p: 0.9,
        lr: -20,
        accept: true,
        reason: 'rank',
        nFrames: 142,
        ms: 100
      }),
      peopleForRealm: async () => PEOPLE,
      sendReply: async (_t, _c, text) => {
        sent.push(text);
        return 1;
      },
      saveSample: async (s, terminalMessageId) => {
        saved.push({ ...s, terminalMessageId });
      },
      // In-memory stand-in for the InboxItem lookup: a sample "exists" when a
      // previous saveSample in THIS test stored that terminal message id.
      sampleExists: async (_realmId, messageId) =>
        saved.some((x) => x.terminalMessageId === messageId),
      ...overrides
    }
  };
}

describe('what the router must NOT claim', () => {
  it('a bill DOCUMENT falls through even with a dialogue open (the bill-loss fix)', async () => {
    const { deps } = makeDeps();
    // open a dialogue first
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Βήτας' }, deps);
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
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Βήτας' }, deps);
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
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Βήτας' }, deps);
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
      { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Βήτας 350' },
      deps
    );
    expect(claimed).toBe(true);
    expect(sent[0]).toMatch(/μήνα/); // month missing → asked
  });

  it('a full dialogue: command → month → ναι → sample saved, correct slots', async () => {
    const { deps, sent, saved } = makeDeps();
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Βήτας 350' }, deps);
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

  it('every VOICE turn lands its raw scores in the sample; text turns add none', async () => {
    // The saved decodes ARE the calibration dataset — a sample without them is
    // a label with no score to calibrate, which defeats the shadow phase.
    const { deps, saved } = makeDeps({
      recognize: async (_a, mode) =>
        mode === 'amount'
          ? {
              ok: true,
              mode,
              transcript: 'ΕΝΕΝΗΝΤΑ ΕΞΙ',
              value: 96,
              p: 0.8786,
              lr: -6.1,
              accept: true,
              reason: 'rank',
              nFrames: 138,
              ms: 2711
            }
          : {
              ok: true,
              mode,
              transcript: 'ΠΛΗΡΩΜΗ ΕΝΟΙΚΙΟΥ ΒΗΤΑΣ',
              value: null,
              p: 0.9,
              lr: -20,
              accept: true,
              reason: 'transcript',
              nFrames: 142,
              ms: 900
            }
    });
    // voice command (no amount) → asked amount → VOICE amount → text month → text ναι
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, voice: { file_id: 'v1' } }, deps);
    await handleVoiceCommand(REALM, { message_id: 2, chat: { id: 5 }, voice: { file_id: 'v2' } }, deps);
    await handleVoiceCommand(REALM, { message_id: 3, chat: { id: 5 }, text: 'Αύγουστος' }, deps);
    await handleVoiceCommand(REALM, { message_id: 4, chat: { id: 5 }, text: 'ναι' }, deps);
    expect(saved).toHaveLength(1);
    // Exactly the two voice turns, in order, values STRINGIFIED, scores raw.
    expect(saved[0].decodes).toEqual([
      {
        mode: 'command',
        value: null,
        p: 0.9,
        lr: -20,
        nFrames: 142,
        accept: true,
        reason: 'transcript',
        ms: 900
      },
      {
        mode: 'amount',
        value: '96',
        p: 0.8786,
        lr: -6.1,
        nFrames: 138,
        accept: true,
        reason: 'rank',
        ms: 2711
      }
    ]);
    expect(saved[0].slots.amount).toMatchObject({ value: 96, source: 'voice' });
  });

  it('an old container without nFrames yields null, never a fake zero', async () => {
    const { deps, saved } = makeDeps({
      recognize: async (_a, mode) => ({
        ok: true,
        mode,
        transcript: 'ΠΛΗΡΩΜΗ ΕΝΟΙΚΙΟΥ ΒΗΤΑΣ 350 ΑΥΓΟΥΣΤΟΣ',
        value: null,
        p: 0.9,
        lr: -20,
        accept: true,
        reason: 'transcript',
        ms: 900
        // no nFrames — a pre-2026-08-16 container build
      })
    });
    // voice command carries person+month; the amount arrives TYPED (a
    // command-mode transcript never fills the amount slot — voice amounts come
    // only through the container's amount-mode verdict).
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, voice: { file_id: 'v1' } }, deps);
    await handleVoiceCommand(REALM, { message_id: 2, chat: { id: 5 }, text: '350' }, deps);
    await handleVoiceCommand(REALM, { message_id: 3, chat: { id: 5 }, text: 'ναι' }, deps);
    expect(saved).toHaveLength(1);
    expect(saved[0].decodes).toHaveLength(1);
    expect(saved[0].decodes[0].nFrames).toBeNull();
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

  it('a saveSample failure THROWS so the scanner retries (F4: save before reply)', async () => {
    // The confirmation text says «Καταγράφηκε». Sending it before a failed
    // write left the landlord told the sample was saved when it was lost. The
    // handler now saves FIRST and lets the failure propagate, so the scanner\'s
    // contiguous-prefix retry re-delivers the batch (the sampleExists dedup
    // makes that idempotent). The bot must NOT have claimed success.
    const sent = [];
    const { deps } = makeDeps({
      sendReply: async (_t, _c, text) => { sent.push(text); return 1; },
      saveSample: async () => { throw new Error('mongo down'); }
    });
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Βήτας 350 Αύγουστος' }, deps);
    const before = sent.length;
    await expect(
      handleVoiceCommand(REALM, { message_id: 2, chat: { id: 5 }, text: 'ναι' }, deps)
    ).rejects.toThrow('mongo down');
    // and the «Καταγράφηκε» success line was NEVER sent
    expect(sent.slice(before).some((t) => /Καταγράφηκε/.test(t))).toBe(false);
  });
});

describe('re-delivery idempotency (gate-8 finding 2)', () => {
  it('a re-delivered TERMINAL VOICE «ναι» writes no phantom sample', async () => {
    // The refuter's exact path: the confirmation is a VOICE note. A voice
    // message ALWAYS passes routing (unlike a text «ναι», which is not a
    // command and falls through), so a re-delivery reaches the dedup. Without
    // it, tick 2 starts a fresh dialogue, recognizes «ΝΑΙ» in command mode,
    // fails to match it as an intent, and writes a phantom REJECTED sample.
    const yesVoice = (id) => ({
      message_id: id, chat: { id: 5 }, voice: { file_id: `nai-${id}` }
    });
    const { deps, saved } = makeDeps({
      recognize: async (_a, mode) =>
        mode === 'yesno'
          ? { ok: true, mode, transcript: 'ΝΑΙ', value: 'yes', p: 0.99, lr: 0, accept: true, reason: 'rank', ms: 50 }
          : { ok: true, mode, transcript: 'ΝΑΙ', value: null, p: 0.9, lr: -20, accept: true, reason: 'rank', ms: 50 }
    });
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Βήτας 350 Αύγουστος' }, deps);
    // terminal confirmation as a voice note → validated sample keyed on msg 2
    await handleVoiceCommand(REALM, yesVoice(2), deps);
    expect(saved).toHaveLength(1);
    expect(saved[0].outcome).toBe('validated');
    // Telegram re-delivers the same voice note (offset persist failed):
    const claimed = await handleVoiceCommand(REALM, yesVoice(2), deps);
    expect(claimed).toBe(true); // swallowed as a replay
    expect(saved).toHaveLength(1); // NO phantom second row
  });

  it('F9: dedup fires REGARDLESS of session liveness (ghost-dialogue replay)', async () => {
    // Batch replay: msg1 re-runs and starts a ghost dialogue, so the replayed
    // terminal msg2 arrives with a session LIVE. The dedup must still swallow
    // it (keyed on the message, not on !existing), or it double-validates and
    // hits E11000. Simulate by leaving a session open AND a prior sample present.
    const { deps, saved } = makeDeps({
      recognize: async (_a, mode) =>
        mode === 'yesno'
          ? { ok: true, mode, transcript: 'ΝΑΙ', value: 'yes', p: 0.99, lr: 0, accept: true, reason: 'rank', ms: 50 }
          : { ok: true, mode, transcript: 'ΝΑΙ', value: null, p: 0.9, lr: -20, accept: true, reason: 'rank', ms: 50 }
    });
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Βήτας 350 Αύγουστος' }, deps);
    await handleVoiceCommand(REALM, { message_id: 2, chat: { id: 5 }, voice: { file_id: 'v2' } }, deps);
    expect(saved).toHaveLength(1);
    // A ghost dialogue is now open (msg1 replayed); the replayed terminal msg2
    // must be swallowed even though a session is live.
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Βήτας 350 Αύγουστος' }, deps);
    const claimed = await handleVoiceCommand(REALM, { message_id: 2, chat: { id: 5 }, voice: { file_id: 'v2' } }, deps);
    expect(claimed).toBe(true);
    expect(saved).toHaveLength(1); // no phantom second validated sample
  });

  it('a re-delivered terminal TEXT «ναι» falls through (not a command, no phantom)', async () => {
    // The text path is safe for a different reason: «ναι» alone is not a money
    // intent, so with no session it returns false at routing — no fresh
    // dialogue, no phantom sample — before the dedup is even needed.
    const { deps, saved } = makeDeps();
    await handleVoiceCommand(REALM, { message_id: 1, chat: { id: 5 }, text: 'πληρωμή ενοικίου Βήτας 350 Αύγουστος' }, deps);
    await handleVoiceCommand(REALM, { message_id: 2, chat: { id: 5 }, text: 'ναι' }, deps);
    expect(saved).toHaveLength(1);
    const claimed = await handleVoiceCommand(REALM, { message_id: 2, chat: { id: 5 }, text: 'ναι' }, deps);
    expect(claimed).toBe(false);
    expect(saved).toHaveLength(1);
  });
});
