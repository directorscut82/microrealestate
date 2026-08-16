# -*- coding: utf-8 -*-
"""Silero VAD segmentation, driven from onnxruntime.

THE TWO TRAPS THIS FILE ENCODES (both cost a day each to find):

1. The v5/v6 graph takes 576 samples per step — 64 samples of PRECEDING CONTEXT
   concatenated with the 512-sample window — not a bare 512 window. Feeding
   context-free frames does not error; it silently returns ~0 probability for
   ALL speech, which is how real Greek audio scored p=0.002 and the model was
   nearly written off as broken. It was the caller.

2. A span MUST be capped. Transformer attention is O(T^2): the expert review
   measured 86 s of continuous speech in one span costing 6.2 GB peak RSS,
   which OOMs this container (1.5 GiB limit) and pressures the whole NAS. A
   span longer than MAX_SPAN_S is refused upstream — the caller tells the
   landlord to send a shorter message rather than this process dying mid-OOM.
"""
import numpy as np
import onnxruntime as ort

SR = 16000
WIN = 512
CTX = 64

# ~15 s of speech ≈ 1.0-1.2 GB peak on the measured RSS curve — comfortably
# inside the 1.5 GiB container limit, and far longer than any money command.
MAX_SPAN_S = 15.0


class Vad:
    def __init__(self, model_path: str):
        self.sess = ort.InferenceSession(
            model_path,
            providers=["CPUExecutionProvider"],
            sess_options=_one_thread(),
        )

    def speech_probs(self, wav: np.ndarray) -> np.ndarray:
        state = np.zeros((2, 1, 128), dtype=np.float32)
        sr = np.array([SR], dtype=np.int64)
        probs = []
        for start in range(0, len(wav) - WIN + 1, WIN):
            buf = np.zeros(CTX + WIN, dtype=np.float32)
            # The context is the CTX samples preceding this window. When fewer
            # than CTX exist (the first window), take what there is and LEFT-pad
            # with the leading zeros already in buf — so a `ctx` of length k
            # occupies buf[CTX-k:CTX], never buf[0:CTX] against a shorter slice
            # (which raised "shape (0,) into (64,)" on every first frame).
            ctx = wav[max(0, start - CTX) : start]
            buf[CTX - len(ctx) : CTX] = ctx
            buf[CTX:] = wav[start : start + WIN]
            out = self.sess.run(
                None, {"input": buf[None, :], "state": state, "sr": sr}
            )
            probs.append(float(out[0][0, 0]))
            state = out[1]
        return np.asarray(probs, dtype=np.float32)

    def spans(
        self,
        wav: np.ndarray,
        threshold: float = 0.5,
        min_speech_ms: int = 120,
        min_silence_ms: int = 180,
        pad_ms: int = 100,
    ):
        """Speech spans as (start_sample, end_sample). Thin wrapper over analyze()."""
        return self.analyze(wav, threshold, min_speech_ms, min_silence_ms, pad_ms)[
            "spans"
        ]

    def analyze(
        self,
        wav: np.ndarray,
        threshold: float = 0.5,
        min_speech_ms: int = 120,
        min_silence_ms: int = 180,
        pad_ms: int = 100,
    ):
        """One VAD pass → {spans, ends_in_speech}.

        Hysteresis (leave only after min_silence_ms below threshold) is what
        stops a stop-consonant closure mid-word from splitting a number in
        half — the split that once made «πενήντα έξι» arrive as two fragments.

        `ends_in_speech`: was the LAST frame of the recording still speech, with
        no closing silence after it? That — NOT the span-vs-buffer-end gap — is
        the truncation signal. VAD pads every span to nearly the buffer end when
        speech reaches it, so a gap test fires on any word spoken to the edge
        (the guard's original, broken form: it refused «πεντακόσια» spoken
        normally). What actually distinguishes a mid-word CUT from a complete
        utterance is whether the recorder stopped while speech was ongoing (no
        trailing silence → ends_in_speech True) versus after the speaker
        finished (VAD saw the closing silence → False).
        """
        probs = self.speech_probs(wav)
        ms = WIN / SR * 1000.0
        min_sil = round(min_silence_ms / ms)
        min_sp = round(min_speech_ms / ms)
        pad = round(pad_ms / ms)
        raw = []
        start, sil = None, 0
        for i, p in enumerate(probs):
            if p >= threshold:
                if start is None:
                    start = i
                sil = 0
            elif start is not None:
                sil += 1
                if sil >= min_sil:
                    end = i - sil + 1
                    if end - start >= min_sp:
                        raw.append((start, end))
                    start, sil = None, 0
        # A span still open at the last frame = the recording ended DURING speech.
        ends_in_speech = start is not None
        if start is not None and len(probs) - start >= min_sp:
            raw.append((start, len(probs)))
        spans = [
            (max(0, (a - pad)) * WIN, min(len(probs), (b + pad)) * WIN)
            for a, b in raw
        ]
        return {"spans": spans, "ends_in_speech": ends_in_speech}


def _one_thread():
    # The VAD is 2.3 MB; thread fan-out costs more than it saves, and this
    # container shares 4 weak cores with the ASR forward pass.
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    return so
