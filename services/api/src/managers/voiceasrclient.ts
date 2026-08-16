/**
 * Thin client for the voiceasr container.
 *
 * The container serializes decodes internally, so this client's timeout is the
 * only back-pressure needed: a 15 s span decodes in ~5 s idle / ~14 s under
 * OCR contention on the J4125, so 45 s covers the worst measured case plus a
 * queued request ahead. A failure or timeout degrades to «try again» — the
 * scanner must NEVER hang its poll tick on this call (it runs on the parse
 * queue, off the tick, same as OCR).
 */
import axios from 'axios';
import { Service } from '@microrealestate/common';

export type RecognizeMode = 'command' | 'amount' | 'yesno' | 'month';

export interface RecognizeResult {
  ok: boolean;
  mode: RecognizeMode;
  transcript: string | null;
  value: number | string | null;
  p: number;
  lr: number | null;
  accept: boolean;
  reason: string;
  /** Post-VAD logit frames scored (0 on refusals). Absent from container
   *  builds before 2026-08-16 — treat undefined as unknown, not zero. */
  nFrames?: number;
  /** Truncation margin in nats (amount mode): how well a LONGER in-grammar
   *  amount explains the same audio. Near zero => the recording was probably cut
   *  mid-word. null when the winner admits no continuation. */
  truncMargin?: number | null;
  /** The longer amount that margin refers to — the value to offer if we ever
   *  ask «88 ή 80;». */
  truncAlt?: number | null;
  ms: number;
}

export async function recognize(
  audio: Buffer,
  mode: RecognizeMode
): Promise<RecognizeResult | null> {
  const base =
    (Service.getInstance()?.envConfig?.getValues() as any)?.VOICEASR_URL ||
    process.env.VOICEASR_URL;
  if (!base) return null;
  try {
    const res = await axios.post(`${base}/recognize?mode=${mode}`, audio, {
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 45_000,
      maxBodyLength: 8 * 1024 * 1024,
      responseType: 'json'
    });
    return res.data as RecognizeResult;
  } catch {
    // Unreachable/slow container is an operational state, not an exception the
    // dialogue can act on: the caller replies «try again later» and the sample
    // records the failure.
    return null;
  }
}
