/**
 * Routes a Telegram message into the money-command dialogue when it is one,
 * and returns false when it is not (so the caller falls through to bill/text
 * handling). SHADOW MODE: the terminal state persists a validation sample via
 * the injected `saveSample`; NOTHING here imports or calls a money manager.
 *
 * The routing rule (modality-independent, owner requirement):
 *   · an ACTIVE dialogue exists for this realm → the message is its reply,
 *     whatever its modality (voice/audio → recognized; text → parsed);
 *   · else a voice/audio message → START a dialogue (its first utterance);
 *   · else a TEXT message whose intent matches → START a dialogue;
 *   · else → not a voice command; caller handles it.
 *
 * All I/O is injected (recognize, download, send, save, people) so the whole
 * router is unit-testable without network/mongo — the same discipline as the
 * scanner it plugs into.
 */
import {
  advance,
  activeSession,
  endSession,
  startSession,
  PersonEntry,
  Reply,
  Utterance,
  VoiceSession
} from '../managers/voicesession.js';
import { matchIntent } from '../utils/greekmatch.js';
import type { RecognizeMode, RecognizeResult } from '../managers/voiceasrclient.js';

export interface VoiceHandlerDeps {
  now: () => Date;
  newId: () => string;
  downloadFileById: (botToken: string, fileId: string) => Promise<Buffer | null>;
  recognize: (audio: Buffer, mode: RecognizeMode) => Promise<RecognizeResult | null>;
  peopleForRealm: (realmId: string) => Promise<PersonEntry[]>;
  sendReply: (
    botToken: string,
    chatId: string | number,
    text: string
  ) => Promise<number | null>;
  /** Persist the dialogue as a validation sample (InboxItem kind voiceCommand),
   *  keyed on the TERMINAL message id for idempotency. */
  saveSample: (session: VoiceSession, terminalMessageId: number) => Promise<void>;
  /**
   * Has a voiceCommand sample already been written for this (realm, message_id)?
   * Telegram re-delivers a whole batch when setOffset fails after handling, so
   * without this a re-delivered TERMINAL «ναι» starts a fresh dialogue, fails to
   * re-match the intent, and writes a phantom 'rejected' sample for a command the
   * landlord issued once (gate-8 finding 2). The bill lane has the same guard.
   */
  sampleExists: (realmId: string, messageId: number) => Promise<boolean>;
}

interface Msg {
  message_id: number;
  chat: { id: number };
  voice?: { file_id: string };
  audio?: { file_id: string };
  document?: { file_id: string };
  photo?: { file_id: string }[];
  text?: string;
}

/** The recognizer mode the dialogue expects for the NEXT audio reply. */
function expectedMode(session: VoiceSession | null): RecognizeMode {
  if (!session) return 'command';
  if (session.asked === 'confirm') return 'yesno';
  if (session.asked === 'amount') return 'amount';
  if (session.asked === 'month') return 'month';
  return 'command';
}

/**
 * @returns true if the message was a voice command (and fully handled here);
 *          false if the caller should handle it as a bill/other message.
 */
export async function handleVoiceCommand(
  realm: { realmId: string; botToken: string },
  msg: Msg,
  deps: VoiceHandlerDeps
): Promise<boolean> {
  // A message carrying a DOCUMENT or PHOTO is NEVER dialogue material — it is
  // a bill, whatever else is going on. Without this gate, a bill photo sent
  // while a dialogue happened to be open matched none of voice/text below,
  // became an EMPTY text utterance, and was claimed anyway — the bill was
  // swallowed and never ingested (gate-3 review finding, the exact
  // silent-bill-loss shape the recapture code already guards against).
  if (msg.document?.file_id || msg.photo?.length) return false;

  const now = deps.now().getTime();
  const existing = activeSession(realm.realmId, now);
  const fileId = msg.voice?.file_id || msg.audio?.file_id;
  const text = (msg.text || '').trim();

  // Decide whether this message belongs to the dialogue at all — BEFORE any DB
  // call. A non-command text (chit-chat, a bill caption) must fall through
  // without touching mongo; putting the sampleExists dedup ahead of this ran a
  // real query on every stray message and hung the poll path.
  if (!existing) {
    // A text message only STARTS a dialogue when it looks like a money command;
    // a voice/audio message always does (the landlord sent a voice note).
    if (!fileId && (!text || !matchIntent(text))) return false;
  } else if (!fileId && !text) {
    // Open session + neither audio nor text (sticker, contact, location…) is
    // not a reply we can parse — leave it to default handling rather than
    // feeding an empty utterance into the state machine.
    return false;
  }

  // IDEMPOTENCY (gate-8 findings 2 + 8): Telegram re-delivers a whole batch when
  // the offset persist fails after handling. If a sample already exists for
  // this exact message it is a replay — swallow silently (claimed, no reply, no
  // second row). Checked REGARDLESS of session liveness: a batch replay can
  // resurrect a ghost dialogue (msg1 starts a fresh session on replay), so the
  // replayed TERMINAL message then arrives with that ghost session live — the
  // earlier `!existing` guard let it through to a second «Καταγράφηκε» and an
  // E11000 the catch swallowed. Keying on the message, not the session state,
  // makes the replay a no-op at the door.
  if (await deps.sampleExists(realm.realmId, msg.message_id)) {
    return true;
  }

  const session =
    existing || startSession(realm.realmId, deps.newId(), now);

  // Build the normalized utterance. Modality is erased AFTER this point.
  let utt: Utterance;
  if (fileId) {
    const audio = await deps.downloadFileById(realm.botToken, fileId);
    if (!audio) {
      await deps.sendReply(
        realm.botToken,
        msg.chat.id,
        'Δεν μπόρεσα να κατεβάσω το ηχητικό. Δοκιμάστε ξανά ή γράψτε το.'
      );
      return true;
    }
    const mode = expectedMode(existing);
    const rec = await deps.recognize(audio, mode);
    if (!rec) {
      await deps.sendReply(
        realm.botToken,
        msg.chat.id,
        'Η φωνητική αναγνώριση δεν είναι διαθέσιμη αυτή τη στιγμή. Γράψτε την εντολή ή δοκιμάστε αργότερα.'
      );
      return true;
    }
    // Record the RAW scores beside the dialogue. The container returns p/lr/
    // nFrames precisely so the api can calibrate thresholds from confirmed
    // samples — dropping them here made every sample a label with no score to
    // calibrate, which defeats the stated purpose of the shadow phase.
    session.decodes.push({
      mode,
      value: rec.value == null ? null : String(rec.value),
      p: typeof rec.p === 'number' ? rec.p : null,
      lr: typeof rec.lr === 'number' ? rec.lr : null,
      nFrames: typeof rec.nFrames === 'number' ? rec.nFrames : null,
      accept: !!rec.accept,
      reason: rec.reason || '',
      ms: typeof rec.ms === 'number' ? rec.ms : null
    });
    utt = {
      text: rec.transcript || '',
      source: 'voice',
      ...(mode === 'amount'
        ? {
            voiceAmount: {
              value: typeof rec.value === 'number' ? rec.value : null,
              accept: rec.accept,
              reason: rec.reason
            }
          }
        : {}),
      ...(mode === 'yesno'
        ? {
            voiceYesNo: {
              value: (rec.value as 'yes' | 'no' | null) ?? null,
              accept: rec.accept
            }
          }
        : {}),
      ...(mode === 'month'
        ? {
            voiceMonth: {
              value: typeof rec.value === 'number' ? rec.value : null,
              accept: rec.accept
            }
          }
        : {})
    };
    session.fileIds.push(fileId);
  } else {
    utt = { text, source: 'text' };
  }

  const people = await deps.peopleForRealm(realm.realmId);
  const reply: Reply = advance(session, utt, people, now);

  if (reply.outcome) {
    // PERSIST BEFORE REPLYING, and let a failure THROW. The terminal message
    // says «Καταγράφηκε ως δείγμα» — sending that before the write meant a
    // mongo blip left the landlord told the sample was saved while it was
    // silently lost and unrecoverable (endSession wiped memory, the offset
    // advanced). Saving first, and rethrowing, lets the scanner's contiguous-
    // prefix retry re-deliver the batch; the sampleExists/unique-index dedup
    // makes that retry idempotent, so the only outcomes are "saved + told" or
    // "not saved + not told, will retry". The terminal message id keys the
    // dedup.
    await deps.saveSample(session, msg.message_id);
    await deps.sendReply(realm.botToken, msg.chat.id, reply.say);
    endSession(realm.realmId);
    return true;
  }
  // Non-terminal turn: the dialogue continues, so just prompt.
  await deps.sendReply(realm.botToken, msg.chat.id, reply.say);
  return true;
}
