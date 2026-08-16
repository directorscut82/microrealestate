/* eslint-env node, jest */
/**
 * The money-command dialogue state machine and its fuzzy matchers.
 *
 * SCOPE: this is the noise-tolerance the owner demanded verbatim — "human
 * language when quick messaging as well as during voice dictation is a real
 * time construct and can have defects" — proven, not asserted. Every case here
 * feeds DEFECTIVE input (misspelt names, greeklish, month typos, ASR
 * homophones, out-of-order slots, mid-message self-correction) and checks the
 * machine either resolves it or asks again, never guesses.
 *
 * And the load-bearing safety test: the dialogue module must not import or call
 * any money manager (shadow mode). That is checked structurally at the bottom —
 * a green functional suite that silently gained a paymentmanager import would
 * be worse than useless.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let VS; // voicesession
let GM; // greekmatch

beforeAll(async () => {
  VS = await import('../managers/voicesession.js');
  GM = await import('../utils/greekmatch.js');
});

beforeEach(() => VS._clearAll());

const PEOPLE = [
  { id: 't1', name: 'ΜΑΝΤΑΣ' },
  { id: 't2', name: 'ΜΑΡΙΑ ΜΑΓΔΑΛΗΝΗ' },
  { id: 't3', name: 'ΠΑΠΑΔΟΠΟΥΛΟΣ' },
  { id: 't4', name: 'ΜΑΡΓΑΡΙΤΑ' }
];

const NOW = 1_000_000;
function fresh() {
  return VS.startSession('r1', 'id1', NOW);
}
const text = (t) => ({ text: t, source: 'text' });
const voice = (t, extra = {}) => ({ text: t, source: 'voice', ...extra });

describe('greekmatch — the noise tolerance itself', () => {
  it('greeklish transliterates to Greek before matching', () => {
    // The owner types «plhrwmh enoikiou Mantas» — pure greeklish.
    expect(GM.matchIntent('plhrwmh enoikiou Mantas')?.value).toBe('rentPayment');
  });

  it('a misspelt tenant name still matches (ASR / typo tolerance)', () => {
    // «ΜΑΝΤΑΣ» heard/typed as «ΜΑΔΑΣ», «Μαντα», «μανδας»
    for (const spelling of ['ΜΑΔΑΣ', 'Μαντα', 'μανδας', 'mantas']) {
      const m = GM.findBest(spelling, [{ value: 't1', labels: ['ΜΑΝΤΑΣ'] }], 0.6);
      expect({ spelling, id: m?.value }).toEqual({ spelling, id: 't1' });
    }
  });

  it('a month TYPO resolves, and June/July stay DISTINCT', () => {
    // typo tolerance…
    expect(GM.matchMonth('Αυγουστος')?.value).toBe(8);
    expect(GM.matchMonth('avgoustos')?.value).toBe(8); // greeklish
    expect(GM.matchMonth('Αύγουστο')?.value).toBe(8); // wrong case ending
    // …but the two confusable ones must never cross: iounios vs ioulios differ
    // by exactly one skeleton char, so the true month always wins outright.
    expect(GM.matchMonth('Ιούνιος')?.value).toBe(6);
    expect(GM.matchMonth('Ιούλιος')?.value).toBe(7);
    expect(GM.matchMonth('Ιουνιο')?.value).toBe(6);
    expect(GM.matchMonth('Ιουλιο')?.value).toBe(7);
  });

  it('a completely unrelated word matches NOTHING, not the nearest month', () => {
    // The floor is the safety: gibberish must return null so the bot re-asks.
    expect(GM.matchMonth('σπίτι')).toBeNull();
    expect(GM.findBest('τζζζ', [{ value: 't1', labels: ['ΜΑΝΤΑΣ'] }], 0.66)).toBeNull();
  });

  it('typed amounts: digits, cents, euro word, greeklish euro', () => {
    expect(GM.parseAmountText('350')).toEqual({ value: 350, cents: false });
    expect(GM.parseAmountText('80,50')).toEqual({ value: 80.5, cents: true });
    expect(GM.parseAmountText('350 ευρώ')).toEqual({ value: 350, cents: false });
    expect(GM.parseAmountText('350€')).toEqual({ value: 350, cents: false });
    expect(GM.parseAmountText('1.550')).toEqual({ value: 1550, cents: false });
  });

  it('a message with TWO numbers is a self-correction — ask, do not guess', () => {
    // «300 όχι 400» typed in one breath: ambiguous, must return null.
    expect(GM.parseAmountText('300 όχι 400')).toBeNull();
  });

  it('yes/no tolerates greeklish and rejects the both-present case', () => {
    expect(GM.matchYesNo('ναι')).toBe('yes');
    expect(GM.matchYesNo('nai')).toBe('yes');
    expect(GM.matchYesNo('όχι')).toBe('no');
    expect(GM.matchYesNo('oxi')).toBe('no');
    // «όχι, ναι σωστά» — the human corrected themselves; ambiguous → null.
    expect(GM.matchYesNo('όχι ναι σωστά')).toBeNull();
  });
});

describe('the dialogue — the owner’s exact flow', () => {
  it('one complete text command → straight to confirm', () => {
    const s = fresh();
    const r = VS.advance(s, text('πληρωμή ενοικίου Μάντας 350 Αύγουστος'), PEOPLE);
    expect(s.slots).toMatchObject({
      intent: 'rentPayment',
      person: { id: 't1' },
      amount: { value: 350 },
      month: 8
    });
    expect(r.asked).toBe('confirm');
    expect(r.say).toMatch(/Επιβεβαιώστε/);
    expect(r.say).toMatch(/Μάντας|ΜΑΝΤΑΣ/);
  });

  it('«ναι» validates and stores a sample; no money executed', () => {
    const s = fresh();
    VS.advance(s, text('πληρωμή ενοικίου Μάντας 350 Αύγουστος'), PEOPLE);
    const r = VS.advance(s, text('ναι'), PEOPLE);
    expect(r.outcome).toBe('validated');
    expect(s.phase).toBe('done');
    expect(s.outcome).toBe('validated');
  });

  it('a MISSING slot is asked for, one at a time', () => {
    const s = fresh();
    // no month
    let r = VS.advance(s, text('πληρωμή ενοικίου Μάντας 350'), PEOPLE);
    expect(r.asked).toBe('month');
    expect(r.say).toMatch(/μήνα/);
    r = VS.advance(s, text('Αύγουστος'), PEOPLE);
    expect(r.asked).toBe('confirm');
  });

  it('the owner’s second example: κοινόχρηστα 30 Αύγουστος για Μαρία Μαγδαληνή', () => {
    const s = fresh();
    const r = VS.advance(
      s,
      text('πληρωμή κοινοχρήστων 30 Αύγουστος για Μαρία Μαγδαληνή'),
      PEOPLE
    );
    expect(s.slots).toMatchObject({
      intent: 'commonChargesPayment',
      person: { id: 't2' },
      amount: { value: 30 },
      month: 8
    });
    expect(r.asked).toBe('confirm');
  });

  it('«όχι» → asks what to fix → a bare corrected name is absorbed → re-confirm', () => {
    const s = fresh();
    VS.advance(s, text('πληρωμή ενοικίου Μάντας 350 Αύγουστος'), PEOPLE);
    VS.advance(s, text('ναι σωστά; όχι'), PEOPLE); // ambiguous ναι/όχι → not yes
    // force the clean no:
    VS._clearAll();
    const s2 = fresh();
    VS.advance(s2, text('πληρωμή ενοικίου Μάντας 350 Αύγουστος'), PEOPLE);
    let r = VS.advance(s2, text('όχι'), PEOPLE);
    expect(r.asked).toBe('whatToFix');
    // correction: it was Μαργαρίτα, not Μάντας — a bare name
    r = VS.advance(s2, text('Μαργαρίτα'), PEOPLE);
    expect(s2.slots.person.id).toBe('t4');
    expect(r.asked).toBe('confirm');
    // the other slots survived the correction
    expect(s2.slots.amount.value).toBe(350);
    expect(s2.slots.month).toBe(8);
  });
});

describe('modality independence and mixed defects', () => {
  it('a VOICE first message with an accepted amount fills the slot', () => {
    const s = fresh();
    // voiceasr already recognised the amount and accepted it
    const r = VS.advance(
      s,
      voice('ΠΛΗΡΩΜΗ ΕΝΟΙΚΙΟΥ ΜΑΝΤΑΣ ΑΥΓΟΥΣΤΟΣ', {
        voiceAmount: { value: 350, accept: true, reason: 'rank' }
      }),
      PEOPLE
    );
    // amount comes from the voice verdict, not from parsing digits in text
    expect(s.slots.amount).toEqual({ value: 350, source: 'voice' });
    expect(r.asked).toBe('confirm');
  });

  it('a REJECTED voice amount is NOT filled — the bot re-asks', () => {
    const s = fresh();
    VS.advance(s, text('πληρωμή ενοικίου Μάντας Αύγουστος'), PEOPLE); // asks amount
    const r = VS.advance(
      s,
      voice('ΕΝΕΝΗΝΤΑ', {
        voiceAmount: { value: 90, accept: false, reason: 'possibly_truncated' }
      }),
      PEOPLE
    );
    expect(s.slots.amount).toBeUndefined();
    expect(r.asked).toBe('amount');
    expect(r.say).toMatch(/κόπηκε|ξανά/); // surfaces the truncation reason
  });

  it('slots given OUT OF ORDER across turns still assemble', () => {
    const s = fresh();
    VS.advance(s, text('καταβολή ενοικίου'), PEOPLE); // intent only → asks person
    VS.advance(s, text('300'), PEOPLE); // answered amount instead of person
    VS.advance(s, text('Παπαδόπουλος'), PEOPLE); // the person
    const r = VS.advance(s, text('Μάρτιος'), PEOPLE); // the month
    expect(s.slots).toMatchObject({
      intent: 'rentPayment',
      person: { id: 't3' },
      amount: { value: 300 },
      month: 3
    });
    expect(r.asked).toBe('confirm');
  });

  it('a non-command text is declined, not turned into a bogus payment', () => {
    const s = fresh();
    const r = VS.advance(s, text('καλημέρα τι κάνεις'), PEOPLE);
    expect(r.outcome).toBe('rejected');
    expect(s.slots.intent).toBeUndefined();
  });
});

describe('gate-8 money-safety fixes', () => {
  const FULL = [
    { id: 'f1', name: 'ΜΑΝΤΑΣ ΚΩΝΣΤΑΝΤΙΝΟΣ' },
    { id: 'f2', name: 'ΠΑΠΑΔΟΠΟΥΛΟΥ ΕΛΕΝΗ' }
  ];

  it('F1: a SURNAME resolves against a stored FULL legal name', () => {
    // Occupant.name holds the full name; people say the surname. The refuter
    // showed the owner\'s own «Μάντας» looping «Ποιον αφορά;» forever.
    const s = VS.startSession('r1', 'id1', NOW);
    const r = VS.advance(s, text('πληρωμή ενοικίου Μάντας 350 Αύγουστος'), FULL, NOW);
    expect(s.slots.person?.id).toBe('f1');
    expect(r.asked).toBe('confirm');
  });

  it('F1: greeklish surname too', () => {
    const s = VS.startSession('r1', 'id1', NOW);
    VS.advance(s, text('plhrwmh enoikiou Papadopoulou 300 Aygoustos'), FULL, NOW);
    expect(s.slots.person?.id).toBe('f2');
  });

  it('F2: a month-question answer does NOT clobber the already-set amount', () => {
    // «15 Αυγούστου» answering the month question must set month, not overwrite 350.
    const s = VS.startSession('r1', 'id1', NOW);
    VS.advance(s, text('πληρωμή ενοικίου Μάντας 350'), PEOPLE, NOW); // asks month
    VS.advance(s, text('15 Αυγούστου'), PEOPLE, NOW);
    expect(s.slots.amount?.value).toBe(350); // NOT 15
    expect(s.slots.month).toBe(8);
  });

  it('F3: a REFUSED voice month is not filled from the transcript', () => {
    const s = VS.startSession('r1', 'id1', NOW);
    VS.advance(s, text('πληρωμή ενοικίου Μάντας 350'), PEOPLE, NOW); // asks month
    const r = VS.advance(
      s,
      { text: 'ΙΟΥΛΙΟΣ', source: 'voice', voiceMonth: { value: null, accept: false } },
      PEOPLE,
      NOW
    );
    expect(s.slots.month).toBeUndefined(); // the refused transcript is NOT trusted
    expect(r.asked).toBe('month'); // re-asked
  });

  it('F3: a REFUSED voice ναι does not validate', () => {
    const s = VS.startSession('r1', 'id1', NOW);
    VS.advance(s, text('πληρωμή ενοικίου Μάντας 350 Αύγουστος'), PEOPLE, NOW); // confirm
    const r = VS.advance(
      s,
      { text: 'ΝΑΙ', source: 'voice', voiceYesNo: { value: null, accept: false } },
      PEOPLE,
      NOW
    );
    expect(r.outcome).toBeUndefined(); // NOT validated from refused audio
  });

  it('F3: an ACCEPTED voice month IS used', () => {
    const s = VS.startSession('r1', 'id1', NOW);
    VS.advance(s, text('πληρωμή ενοικίου Μάντας 350'), PEOPLE, NOW);
    VS.advance(
      s,
      { text: 'ΑΥΓΟΥΣΤΟΣ', source: 'voice', voiceMonth: { value: 8, accept: true } },
      PEOPLE,
      NOW
    );
    expect(s.slots.month).toBe(8);
  });

  it('F5: a bare-noun intent in chit-chat does NOT start a dialogue', () => {
    const s = VS.startSession('r1', 'id1', NOW);
    const r = VS.advance(s, text('το ενοίκιο του μαγαζιού είναι ακριβό φέτος'), PEOPLE, NOW);
    expect(r.outcome).toBe('rejected'); // not treated as a command
    expect(s.slots.intent).toBeUndefined();
  });

  it('F5: a bare noun WITH another slot IS a command', () => {
    const s = VS.startSession('r1', 'id1', NOW);
    const r = VS.advance(s, text('κοινόχρηστα 30 Αύγουστος Μάντας'), PEOPLE, NOW);
    expect(s.slots.intent).toBe('commonChargesPayment');
    expect(s.slots.amount?.value).toBe(30); // and 30 is the amount, not vetoed
    expect(r.asked).toBe('confirm');
  });

  it('F6: an equidistant month typo is a TIE → null, not a wrong guess', () => {
    // «Ιούνλιος» is one edit from both Ιούνιος and Ιούλιος.
    expect(GM.matchMonth('Ιούνλιος')).toBeNull();
  });
});

describe('abandonment sweep (gate-8 finding 1)', () => {
  it('a timed-out dialogue is returned as an abandoned sample and dropped', () => {
    const s = VS.startSession('r1', 'id1', NOW);
    VS.advance(s, text('πληρωμή ενοικίου Μάντας'), PEOPLE, NOW); // incomplete → still open
    // before TTL: nothing swept, session still active
    expect(VS.sweepAbandoned(NOW + 60_000)).toEqual([]);
    expect(VS.activeSession('r1', NOW + 60_000)).not.toBeNull();
    // after TTL (10min): swept, stamped abandoned, and removed from memory
    const swept = VS.sweepAbandoned(NOW + 11 * 60_000);
    expect(swept).toHaveLength(1);
    expect(swept[0].outcome).toBe('abandoned');
    expect(swept[0].realmId).toBe('r1');
    expect(VS.activeSession('r1', NOW + 11 * 60_000)).toBeNull();
    // idempotent: a second sweep finds nothing (already removed)
    expect(VS.sweepAbandoned(NOW + 12 * 60_000)).toEqual([]);
  });

  it('a COMPLETED dialogue is never swept as abandoned', () => {
    const s = VS.startSession('r1', 'id1', NOW);
    VS.advance(s, text('πληρωμή ενοικίου Μάντας 350 Αύγουστος'), PEOPLE);
    VS.advance(s, text('ναι'), PEOPLE); // validated → phase done, removed
    // even well past TTL, there is nothing to abandon
    expect(VS.sweepAbandoned(NOW + 20 * 60_000)).toEqual([]);
  });
});

describe('SHADOW MODE — no money path exists', () => {
  it('voicesession.ts imports no money manager', () => {
    const src = fs.readFileSync(path.join(HERE, '../managers/voicesession.ts'), 'utf8');
    // Check IMPORT lines, not raw substrings — the file's own docstring names
    // the managers to explain WHY it must not touch them, and a substring
    // scan would trip on that sentence.
    const imports = src
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l))
      .join('\n')
      .toLowerCase();
    for (const forbidden of [
      'paymentmanager',
      'billmanager',
      'ownermanager',
      'rentmanager'
    ]) {
      expect({ forbidden, imported: imports.includes(forbidden) }).toEqual({
        forbidden,
        imported: false
      });
    }
  });

  it('the handler imports no money manager either', () => {
    const src = fs.readFileSync(
      path.join(HERE, '../jobs/voicecommandhandler.ts'),
      'utf8'
    );
    const imports = src
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l))
      .join('\n');
    expect(/paymentmanager|billmanager|ownermanager|rentmanager/i.test(imports)).toBe(
      false
    );
  });

  it('a validated dialogue produces a SAMPLE object, never a payment call', () => {
    // The state machine has no side effect beyond mutating its own session:
    // advance() returns a Reply, and persistence is the caller's injected
    // saveSample. There is no code path from advance() to a manager.
    const s = fresh();
    VS.advance(s, text('πληρωμή ενοικίου Μάντας 350 Αύγουστος'), PEOPLE);
    const r = VS.advance(s, text('ναι'), PEOPLE);
    expect(r).not.toHaveProperty('execute');
    expect(r).not.toHaveProperty('payment');
    expect(r.outcome).toBe('validated');
  });
});
