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
import { logger } from '@microrealestate/common';
import {
  advance,
  activeSession,
  endSession,
  extractSlots,
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
  /** Persist the dialogue as a validation sample (InboxItem kind voiceCommand). */
  saveSample: (session: VoiceSession) => Promise<void>;
}

interface Msg {
  message_id: number;
  chat: { id: number };
  voice?: { file_id: string };
  audio?: { file_id: string };
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
  const now = deps.now().getTime();
  const existing = activeSession(realm.realmId, now);
  const fileId = msg.voice?.file_id || msg.audio?.file_id;
  const text = (msg.text || '').trim();

  // Decide whether this message belongs to the dialogue at all.
  if (!existing) {
    if (!fileId) {
      // A text message only STARTS a dialogue when it looks like a money
      // command; anything else is not ours (bills, chit-chat) → fall through.
      if (!text || !matchIntent(text)) return false;
    }
    // else: a voice/audio message with no active session always starts one —
    // the landlord sent a voice note, and command is the safe first mode.
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
  const reply: Reply = advance(session, utt, people);
  await deps.sendReply(realm.botToken, msg.chat.id, reply.say);

  if (reply.outcome) {
    try {
      await deps.saveSample(session);
    } catch (err: any) {
      logger.error(
        `voice-command: failed to persist sample for realm ${realm.realmId}: ${err?.message || err}`
      );
    }
    endSession(realm.realmId);
  }
  return true;
}

/** Re-export for the caller's convenience. */
export { extractSlots };
