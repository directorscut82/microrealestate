/**
 * The money-command dialogue: a modality-independent state machine.
 *
 * SHADOW MODE — the load-bearing property of this whole file: a completed
 * dialogue persists a VALIDATION SAMPLE and never calls a payment manager.
 * There is no import from paymentmanager/billmanager/ownermanager here and a
 * jest test asserts that stays true. The samples are the dataset that decides
 * whether the recognition is ever allowed to act.
 *
 * MODALITY-INDEPENDENT (owner requirement): the FIRST message and every reply
 * may be voice OR text. The machine consumes normalized utterances —
 * { text, source } — where text came from the voiceasr container for audio or
 * from the message body for typed input (greeklish included; greekmatch.ts
 * transliterates before matching). Nothing in the state logic knows which.
 *
 * NOISE-TOLERANT BY CONSTRUCTION (owner requirement, their words: "human
 * language when quick messaging as well as during voice dictation is a real
 * time construct and can have defects"): every slot resolver is fuzzy
 * (phonetic-skeleton matching with a confidence floor), and every reply is
 * parsed in THREE passes —
 *   1. against the slot the machine just asked for,
 *   2. against ANY slot (people answer a different question than asked),
 *   3. as a fresh command (people abandon dialogues mid-flight).
 * A reply that resolves nothing gets a re-ask, never a guess.
 *
 * The dialogue (the owner's spec, verbatim shape):
 *   1. «πληρωμή ενοικίου Βήτας 350 Αύγουστος» (voice or text)
 *   2. bot: «Επιβεβαιώστε: … — ναι ή όχι;»
 *   3. ναι → validated (sample stored). όχι → «τι να διορθώσω;» and the next
 *      message carries the correction (a name, an amount, a month — matched
 *      fuzzily against all slots), then re-confirm.
 *   Missing slot at any point → ask for exactly that slot.
 *
 * In-memory, one active dialogue per realm — the same single-consumer pattern
 * as recapturesession.ts, and for the same reason: the Telegram poller is the
 * single getUpdates consumer and adminChatId is one chat.
 *
 * PERSISTENCE, honestly: a COMPLETED dialogue (validated/rejected) writes an
 * InboxItem sample. A dialogue that TIMES OUT is swept to an 'abandoned' sample
 * by the scanner's 60s tick (sweepAbandoned below). A dialogue interrupted by
 * an api RESTART is lost with the in-memory map and leaves NO row — it never
 * wrote a mid-flight one. That last case is an accepted gap for a shadow-mode
 * dataset, documented on the schema, not papered over.
 */
import {
  MoneyIntent,
  matchIntent,
  matchMonth,
  matchYesNo,
  findBest,
  parseAmountText
} from '../utils/greekmatch.js';

export interface PersonEntry {
  id: string;
  name: string;
}

/**
 * One recognizer call, scores kept RAW. This is the calibration dataset the
 * shadow phase exists to collect: the human's ναι/όχι (the session outcome +
 * final slots) labels these scores, and the threshold work (Platt/affine
 * log-LR calibration, frame-normalized per the utterance-verification
 * literature) runs over exactly these fields. A sample persisted without them
 * is a label with nothing to calibrate.
 */
export interface VoiceDecode {
  mode: 'command' | 'amount' | 'yesno' | 'month';
  /** Recognized value, stringified ('96', 'yes', '8'); null when refused. */
  value: string | null;
  p: number | null;
  lr: number | null;
  nFrames: number | null;
  /** Truncation margin (nats) and the longer amount it names; amount mode only,
   *  null when the winner admits no in-grammar continuation. */
  truncMargin: number | null;
  truncAlt: number | null;
  accept: boolean;
  reason: string;
  ms: number | null;
}

export interface Utterance {
  text: string;
  source: 'voice' | 'text';
  /** voiceasr's verdict for a voice AMOUNT reply; unused for text. */
  voiceAmount?: { value: number | null; accept: boolean; reason: string };
  voiceYesNo?: { value: 'yes' | 'no' | null; accept: boolean };
  voiceMonth?: { value: number | null; accept: boolean };
}

export interface Slots {
  intent?: MoneyIntent;
  person?: { id: string; name: string; confidence: number };
  amount?: { value: number; source: 'voice' | 'text' };
  month?: number;
}

export type Phase = 'collecting' | 'confirming' | 'done';

export interface VoiceSession {
  id: string;
  realmId: string;
  phase: Phase;
  slots: Slots;
  /** Which slot the last bot message asked for; replies try this first. */
  asked?: 'person' | 'amount' | 'month' | 'confirm' | 'whatToFix';
  corrections: number;
  createdAt: number;
  expiresAt: number;
  outcome?: 'validated' | 'rejected' | 'abandoned';
  /** Every raw utterance, kept for the validation sample. */
  transcript: { text: string; source: string }[];
  /** Telegram file_ids of every audio message in the dialogue (durable refs;
   *  the audio itself stays in Telegram, never in this repo's backups). */
  fileIds: string[];
  /** One entry per recognizer call, pushed by the handler beside fileIds. */
  decodes: VoiceDecode[];
}

// A dialogue is a human typing/talking — minutes, not the 2 of recapture.
const TTL_MS = 10 * 60 * 1000;

const byRealm = new Map<string, VoiceSession>();

export function activeSession(realmId: string, now: number): VoiceSession | null {
  const s = byRealm.get(realmId);
  if (!s) return null;
  if (now > s.expiresAt || s.phase === 'done') {
    byRealm.delete(realmId);
    return null;
  }
  return s;
}

export function startSession(
  realmId: string,
  id: string,
  now: number
): VoiceSession {
  const s: VoiceSession = {
    id,
    realmId,
    phase: 'collecting',
    slots: {},
    corrections: 0,
    createdAt: now,
    expiresAt: now + TTL_MS,
    transcript: [],
    fileIds: [],
    decodes: []
  };
  byRealm.set(realmId, s);
  return s;
}

export function endSession(realmId: string): void {
  byRealm.delete(realmId);
}

/**
 * Collect and REMOVE every dialogue that has passed its TTL without completing,
 * stamping each with outcome 'abandoned'. The caller (the scanner's 60s sweep)
 * persists these as samples — so a walk-away/timeout is recorded, not lost.
 *
 * This records the COMMON abandonment (the human gave up); it cannot record an
 * api restart, because the in-memory map dies with the process and these
 * dialogues never wrote a mid-flight row (a deliberate simplicity choice —
 * writing/updating a row at every turn is the alternative and is not worth it
 * for a shadow-mode dataset). That residual is documented on the schema, not
 * promised away.
 */
export function sweepAbandoned(now: number): VoiceSession[] {
  const out: VoiceSession[] = [];
  for (const [realmId, s] of byRealm) {
    if (now > s.expiresAt && s.phase !== 'done') {
      s.outcome = 'abandoned';
      out.push(s);
      byRealm.delete(realmId);
    }
  }
  return out;
}

// test-only
export function _clearAll(): void {
  byRealm.clear();
}

// ── slot extraction ──────────────────────────────────────────────────────────

/**
 * Pull every slot the utterance carries. Fuzzy everywhere; person matching is
 * against the realm's OWN tenant list (injected — this module stays pure).
 */
export function extractSlots(
  utt: Utterance,
  people: PersonEntry[]
): Partial<Slots> {
  const out: Partial<Slots> = {};
  const intent = matchIntent(utt.text);
  if (intent) out.intent = intent.value;

  // EVERY NAME TOKEN is a label, not just the full name. Occupant.name holds
  // the lease's full legal name («ΒΗΤΑΣ ΚΩΝΣΤΑΝΤΙΝΟΣ»), while people say the
  // surname — and findBest windows are sized to the NEEDLE, so a full-name
  // needle could never score against a surname-only utterance: the refuter
  // demonstrated the owner's own example «Βήτας» looping «Ποιον αφορά;» until
  // TTL. Tokens under 4 chars are excluded (particles, initials — too
  // matchable). Floor 0.75: at 0.7, answering «Αύγουστος» to the month question
  // matched a hypothetical tenant «ΑΥΓΟΥΣΤΙΔΗΣ» at exactly the floor.
  const person = findBest(
    utt.text,
    people.map((p) => ({
      value: p,
      labels: [
        p.name,
        ...p.name.split(/\s+/).filter((t) => t.length >= 4)
      ]
    })),
    0.75
  );
  if (person) {
    out.person = {
      id: person.value.id,
      name: person.value.name,
      confidence: person.confidence
    };
  }

  // MONTH by modality, same rule as the amount: when the container was asked
  // for a month (utt.voiceMonth present), ITS verdict is the only source — the
  // refuter demonstrated a refused verdict (accept=false on Ιούνιος/Ιούλιος-
  // ambiguous audio) being bypassed by fuzzy-matching the very transcript the
  // LR guard had refused. Transcript matching remains correct for text and for
  // command-mode voice (no voiceMonth), where no verdict exists.
  let month: ReturnType<typeof matchMonth> = null;
  if (utt.voiceMonth !== undefined) {
    if (utt.voiceMonth.accept && utt.voiceMonth.value != null) {
      out.month = utt.voiceMonth.value;
    }
  } else {
    month = matchMonth(utt.text);
    if (month) out.month = month.value;
  }

  // Amount: the modality decides the parser. Voice amounts are only trusted
  // through the container's grammar+LR verdict; typed digits are unambiguous.
  if (utt.source === 'voice') {
    if (utt.voiceAmount?.accept && utt.voiceAmount.value != null) {
      out.amount = { value: utt.voiceAmount.value, source: 'voice' };
    }
  } else {
    const a = parseAmountText(utt.text);
    // A date number CAN be misread as the amount («για τον Αύγουστο 2026» →
    // €2026), but the two guards that tried to veto it (plausible-year, or a
    // number adjacent to the month word) each dropped LEGITIMATE amounts:
    // «30 Αύγουστος» is €30 in August, and a €2000 rent is a real Athens figure.
    // The demonstrated HARM was a date number OVERWRITING an already-correct
    // amount — and that is handled where it belongs, by the fill-if-empty rule
    // in advance() (a filled amount is never clobbered by pass-2 absorption).
    // A stray date-as-amount on an OTHERWISE-empty slot surfaces in the confirm
    // text, which the human rejects; in shadow mode that is the backstop, and
    // vetoing real amounts to pre-empt it is the worse trade.
    if (a) out.amount = { value: a.value, source: 'text' };
  }
  return out;
}

export function missingSlot(s: Slots): 'person' | 'amount' | 'month' | null {
  // All three money intents need the same trio. Order = what a human asks first.
  if (!s.person) return 'person';
  if (!s.amount) return 'amount';
  if (!s.month) return 'month';
  return null;
}

// ── the transition function — pure, fully unit-testable ─────────────────────

export interface Reply {
  /** What the bot should say. */
  say: string;
  /** What the bot expects next (stored on the session). */
  asked?: VoiceSession['asked'];
  /** Terminal outcome, when the dialogue just ended. */
  outcome?: 'validated' | 'rejected';
  /** For voice replies: which recognizer mode the NEXT audio should use. */
  expectMode?: 'amount' | 'yesno' | 'month' | 'command';
}

const INTENT_LABEL: Record<MoneyIntent, string> = {
  rentPayment: 'καταβολή ενοικίου',
  commonChargesPayment: 'πληρωμή κοινοχρήστων',
  ownerPayment: 'καταβολή ιδιοκτήτη'
};

const MONTH_LABEL = [
  '',
  'Ιανουάριος',
  'Φεβρουάριος',
  'Μάρτιος',
  'Απρίλιος',
  'Μάιος',
  'Ιούνιος',
  'Ιούλιος',
  'Αύγουστος',
  'Σεπτέμβριος',
  'Οκτώβριος',
  'Νοέμβριος',
  'Δεκέμβριος'
];

function confirmText(s: Slots): string {
  const euros =
    s.amount!.value % 1 === 0
      ? `${s.amount!.value} €`
      : `${s.amount!.value.toFixed(2).replace('.', ',')} €`;
  return (
    `Επιβεβαιώστε: ${INTENT_LABEL[s.intent!]} — ${s.person!.name}, ${euros}, ` +
    `${MONTH_LABEL[s.month!]}. Απαντήστε «ναι» ή «όχι» (γραπτά ή φωνητικά). ` +
    'Δοκιμαστική λειτουργία: δεν θα καταχωρηθεί τίποτα αυτόματα.'
  );
}

function askFor(slot: 'person' | 'amount' | 'month'): Reply {
  switch (slot) {
    case 'person':
      return {
        say: 'Ποιον αφορά; Πείτε ή γράψτε το όνομα.',
        asked: 'person',
        expectMode: 'command'
      };
    case 'amount':
      // «σκέτο το ποσό»: isolated numbers decode reliably; numbers buried in a
      // sentence measurably do not — this instruction IS the accuracy fix.
      return {
        say: 'Ποιο είναι το ποσό; Πείτε σκέτο το ποσό (π.χ. «τριακόσια πενήντα») ή γράψτε το με ψηφία (π.χ. 350 ή 80,50).',
        asked: 'amount',
        expectMode: 'amount'
      };
    case 'month':
      return {
        say: 'Για ποιον μήνα;',
        asked: 'month',
        expectMode: 'month'
      };
  }
}

/**
 * One inbound utterance → the bot's reply + mutated session. The three-pass
 * parse lives here.
 */
export function advance(
  session: VoiceSession,
  utt: Utterance,
  people: PersonEntry[],
  // The clock, injected — startSession and sweepAbandoned already take one, and
  // reading Date.now() here instead mixed wall-clock into a session whose TTL is
  // set from the injected clock, so the sweep (also injected-clock) could never
  // see the row as expired. Defaults to real time for production callers.
  now: number = Date.now()
): Reply {
  session.transcript.push({ text: utt.text, source: utt.source });
  session.expiresAt = now + TTL_MS;

  // ── pass 1: the slot we explicitly asked for ──────────────────────────────
  if (session.asked === 'confirm') {
    // When the container was asked yes/no (voiceYesNo present), its verdict is
    // FINAL: accept → use the value; refused → unresolved, fall through to the
    // correction pass and ultimately a re-ask. The earlier shape fell back to
    // matchYesNo on the very transcript the LR guard had just refused — a
    // dialogue could VALIDATE from audio the recognizer would not trust
    // (refuter, demonstrated). Text replies still match the transcript.
    const yn =
      utt.voiceYesNo !== undefined
        ? utt.voiceYesNo.accept
          ? utt.voiceYesNo.value
          : null
        : matchYesNo(utt.text);
    if (yn === 'yes') {
      session.phase = 'done';
      session.outcome = 'validated';
      return {
        say: 'Καταγράφηκε ως δείγμα επικύρωσης. (Δοκιμαστική λειτουργία — καμία καταβολή δεν καταχωρήθηκε στην εφαρμογή.)',
        outcome: 'validated'
      };
    }
    if (yn === 'no') {
      session.corrections++;
      session.asked = 'whatToFix';
      return {
        say: 'Τι να διορθώσω; Στείλτε το σωστό στοιχείο — όνομα, ποσό ή μήνα (γραπτά ή φωνητικά).',
        asked: 'whatToFix',
        expectMode: 'command'
      };
    }
    // Not a clean ναι/όχι: maybe they sent a correction directly. Fall through
    // to the any-slot pass rather than punishing the shortcut.
  }

  if (session.asked === 'whatToFix' || session.asked === 'confirm') {
    const found = extractSlots(utt, people);
    // A direct correction replaces exactly the slots the message carries.
    let changed = false;
    if (found.person) {
      session.slots.person = found.person;
      changed = true;
    }
    if (found.amount) {
      session.slots.amount = found.amount;
      changed = true;
    }
    if (found.month) {
      session.slots.month = found.month;
      changed = true;
    }
    if (found.intent && found.intent !== session.slots.intent) {
      session.slots.intent = found.intent;
      changed = true;
    }
    if (changed) {
      const miss = missingSlot(session.slots);
      if (miss) {
        session.asked = miss;
        return askFor(miss);
      }
      session.asked = 'confirm';
      session.phase = 'confirming';
      return { say: confirmText(session.slots), asked: 'confirm', expectMode: 'yesno' };
    }
    session.asked = session.asked === 'confirm' ? 'confirm' : 'whatToFix';
    return {
      say: 'Δεν το κατάλαβα. Γράψτε ή πείτε το σωστό όνομα, ποσό ή μήνα.',
      asked: session.asked,
      expectMode: 'command'
    };
  }

  if (session.asked === 'person' || session.asked === 'amount' || session.asked === 'month') {
    const found = extractSlots(utt, people);
    const wanted = session.asked;
    const got =
      wanted === 'person' ? found.person : wanted === 'amount' ? found.amount : found.month;
    if (got !== undefined) {
      if (wanted === 'person') session.slots.person = found.person;
      if (wanted === 'amount') session.slots.amount = found.amount;
      if (wanted === 'month') session.slots.month = found.month;
      // ── pass 2 bonus: absorb OTHER slots the message carried — but only
      // into EMPTY slots. Overwriting a filled one turned «15 Αυγούστου»
      // (answering the month question) into amount=15, clobbering the correct
      // 350 already collected (refuter, demonstrated). Replacing a filled slot
      // is what the όχι→correction pass is for, where replacement is the
      // user's stated intent.
      if (wanted !== 'person' && found.person && !session.slots.person)
        session.slots.person = found.person;
      if (wanted !== 'amount' && found.amount && !session.slots.amount)
        session.slots.amount = found.amount;
      if (wanted !== 'month' && found.month && !session.slots.month)
        session.slots.month = found.month;
      const miss = missingSlot(session.slots);
      if (miss) {
        session.asked = miss;
        return askFor(miss);
      }
      session.asked = 'confirm';
      session.phase = 'confirming';
      return { say: confirmText(session.slots), asked: 'confirm', expectMode: 'yesno' };
    }
    // The asked slot did not resolve — maybe they answered something else.
    // Same fill-if-empty rule as the pass-2 bonus, same demonstrated hazard.
    let absorbed = false;
    if (found.person && !session.slots.person) {
      session.slots.person = found.person;
      absorbed = true;
    }
    if (found.amount && !session.slots.amount) {
      session.slots.amount = found.amount;
      absorbed = true;
    }
    if (found.month && !session.slots.month) {
      session.slots.month = found.month;
      absorbed = true;
    }
    if (absorbed) {
      const miss = missingSlot(session.slots);
      if (miss) {
        session.asked = miss;
        return askFor(miss);
      }
      session.asked = 'confirm';
      session.phase = 'confirming';
      return { say: confirmText(session.slots), asked: 'confirm', expectMode: 'yesno' };
    }
    // Nothing resolved: honest re-ask of the same slot, with the voice-refusal
    // reason surfaced when there is one (e.g. possibly_truncated → "again").
    const why =
      utt.source === 'voice' && utt.voiceAmount && !utt.voiceAmount.accept
        ? utt.voiceAmount.reason === 'possibly_truncated'
          ? ' Η ηχογράφηση κόπηκε — πείτε το ξανά.'
          : ' Δεν ακούστηκε καθαρά.'
        : '';
    return { ...askFor(wanted), say: askFor(wanted).say + why };
  }

  // ── first message of the dialogue (or a fresh command mid-flight) ─────────
  const found = extractSlots(utt, people);
  // A BARE-NOUN intent («ενοίκιο», «κοινόχρηστα» as single words) needs a
  // second signal. The single-word labels exist so the owner's real phrasing
  // matches, but alone they also match chit-chat — «το ενοίκιο του μαγαζιού
  // είναι ακριβό φέτος» opened a dialogue that then swallowed every text for
  // ten minutes (refuter, demonstrated). A multi-word command phrase, or a
  // bare noun accompanied by any other slot, is a command; a lone noun in a
  // sentence is conversation.
  const intentHit = matchIntent(utt.text);
  const bareNounOnly =
    intentHit !== null &&
    !intentHit.matched.includes(' ') &&
    !found.person &&
    !found.amount &&
    !found.month;
  if (found.intent && !bareNounOnly) session.slots.intent = found.intent;
  if (found.person) session.slots.person = found.person;
  if (found.amount) session.slots.amount = found.amount;
  if (found.month) session.slots.month = found.month;
  if (!session.slots.intent) {
    // No money intent anywhere: this machine should not have been started —
    // the caller routes such messages to the existing bill/text handling.
    session.phase = 'done';
    session.outcome = 'rejected';
    return {
      say: 'Δεν αναγνώρισα εντολή καταβολής. Υποστηρίζω: καταβολή ενοικίου, πληρωμή κοινοχρήστων, καταβολή ιδιοκτήτη.',
      outcome: 'rejected'
    };
  }
  const miss = missingSlot(session.slots);
  if (miss) {
    session.asked = miss;
    return askFor(miss);
  }
  session.asked = 'confirm';
  session.phase = 'confirming';
  return { say: confirmText(session.slots), asked: 'confirm', expectMode: 'yesno' };
}
