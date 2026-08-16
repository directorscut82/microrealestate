# -*- coding: utf-8 -*-
"""The recognition pipeline: audio bytes -> {transcript, value, p, lr, reason}.

Every stage here is the one that MEASURED best in the August 2026 evaluation —
none is invented. The provenance matters because two hand-rolled predecessors
each produced a silently wrong money amount:

  proposal   flashlight-text LexiconDecoder — constrained beam GENERATION.
             pyctcdecode's hard character trie returned NO hypothesis on 7/10
             real clips (a misspelt «ΤΑΡΑΚΟΣΙΑ» falls off-trie and dies);
             flashlight proposed 9/10 correctly, because a beam explores
             off-argmax paths inside the lexicon instead of string-matching.
  lexicon    greeknum.int_to_words 1..9999 (grammar DFA from the research
             workflow, gender-corrected), spaced + fused variants — real Greek
             pronounces a compound numeral as one stress group, so the fused
             spelling is a first-class lexicon entry, not an error.
  rescore    exact CTC forced alignment, batched (rescore.ctc_logp_batch),
             over slot-neighbour-widened candidates. Widening exists because a
             shortlist that DROPS the truth can never be recovered by any
             scorer: the beam once proposed 90 for audio that said 96, and the
             posterior over that support reported p=0.9975 for the wrong
             answer. Perturbing each digit slot guarantees the truth is present
             whenever the proposal is off by one slot.
  guards     (1) temperature-softmax posterior over the widened set;
             (2) the free-decode LIKELIHOOD RATIO — keyword/filler utterance
             verification. The expert review measured it separating perfectly
             (in-set -84..0 nats vs out-of-set -187..-330) and proved that the
             posterior alone accepts a GREETING at p=0.995: the posterior is
             conditional on the answer being a number at all; only the LR can
             say it was not.
             (3) the TRUNCATION MARGIN (_truncation_margin): the best PREFIX
             alignment of an in-grammar continuation against the winner's
             COMPLETE alignment. A clipped «ενενήντα έξι» decodes to 90 with
             RISING confidence (p=0.931 at a 200 ms cut) because for the
             surviving audio the shorter numeral genuinely IS the better answer —
             so no complete-alignment score can ever see it, and two earlier
             input-side guards (VAD span geometry, then VAD ends_in_speech) both
             failed because silero pads every span to the buffer edge, making a
             tight complete recording byte-identical to a mid-word cut. Letting
             the longer word end EARLY is the question that works; it is Kaldi's
             final_relative_cost, and it is measured against a 313-decode
             truncation ladder in the method's own docstring, along with the five
             signals it beat.

Thresholds are DELIBERATELY not decided here: p, lr and the reason flags go
back to the caller raw, because 16 clips cannot calibrate a money threshold.
The api layer applies configurable gates and every human confirmation becomes
a labelled sample for real calibration.
"""
import json
import os
import subprocess
import tempfile
import time
import wave

import numpy as np
import onnxruntime as ort
from flashlight.lib.text.decoder import (
    CriterionType,
    LexiconDecoder,
    LexiconDecoderOptions,
    SmearingMode,
    Trie,
    ZeroLM,
)
from flashlight.lib.text.dictionary import Dictionary

import greeknum as G
import rescore as R
from vadseg import MAX_SPAN_S, SR, Vad

MODELS_DIR = os.environ.get("VOICEASR_MODELS_DIR", "/models")

# NOTE: services/api/src/utils/greekmatch.ts carries the SAME month table for
# typed-text matching. Two runtimes, no shared source — keep them in step.
MONTHS = {
    1: ["ΙΑΝΟΥΑΡΙΟΣ", "ΙΑΝΟΥΑΡΙΟΥ", "ΓΕΝΑΡΗΣ", "ΓΕΝΑΡΗ"],
    2: ["ΦΕΒΡΟΥΑΡΙΟΣ", "ΦΕΒΡΟΥΑΡΙΟΥ", "ΦΛΕΒΑΡΗΣ", "ΦΛΕΒΑΡΗ"],
    3: ["ΜΑΡΤΙΟΣ", "ΜΑΡΤΙΟΥ", "ΜΑΡΤΗΣ", "ΜΑΡΤΗ"],
    4: ["ΑΠΡΙΛΙΟΣ", "ΑΠΡΙΛΙΟΥ", "ΑΠΡΙΛΗΣ", "ΑΠΡΙΛΗ"],
    5: ["ΜΑΙΟΣ", "ΜΑΙΟΥ", "ΜΑΗΣ", "ΜΑΗ"],
    6: ["ΙΟΥΝΙΟΣ", "ΙΟΥΝΙΟΥ"],
    7: ["ΙΟΥΛΙΟΣ", "ΙΟΥΛΙΟΥ"],
    8: ["ΑΥΓΟΥΣΤΟΣ", "ΑΥΓΟΥΣΤΟΥ"],
    9: ["ΣΕΠΤΕΜΒΡΙΟΣ", "ΣΕΠΤΕΜΒΡΙΟΥ", "ΣΕΠΤΕΜΒΡΗΣ", "ΣΕΠΤΕΜΒΡΗ"],
    10: ["ΟΚΤΩΒΡΙΟΣ", "ΟΚΤΩΒΡΙΟΥ", "ΟΚΤΩΒΡΗΣ", "ΟΚΤΩΒΡΗ"],
    11: ["ΝΟΕΜΒΡΙΟΣ", "ΝΟΕΜΒΡΙΟΥ", "ΝΟΕΜΒΡΗΣ", "ΝΟΕΜΒΡΗ"],
    12: ["ΔΕΚΕΜΒΡΙΟΣ", "ΔΕΚΕΜΒΡΙΟΥ", "ΔΕΚΕΜΒΡΗΣ", "ΔΕΚΕΜΒΡΗ"],
}
YESNO = {"yes": ["ΝΑΙ", "ΝΕ", "ΜΑΛΙΣΤΑ", "ΣΩΣΤΑ", "ΣΩΣΤΟ", "ΕΝΤΑΞΕΙ", "ΟΚ"],
         "no": ["ΟΧΙ", "ΛΑΘΟΣ", "ΟΧΙ ΛΑΘΟΣ"]}


class Pipeline:
    def __init__(self):
        so = ort.SessionOptions()
        so.intra_op_num_threads = int(os.environ.get("VOICEASR_THREADS", "3"))
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(
            os.path.join(MODELS_DIR, "model.int8.onnx"),
            providers=["CPUExecutionProvider"],
            sess_options=so,
        )
        self.inp = self.sess.get_inputs()[0].name
        self.vad = Vad(os.path.join(MODELS_DIR, "silero_vad.onnx"))
        self.vocab = json.load(
            open(os.path.join(os.path.dirname(__file__), "vocab.json"))
        )
        self.inv = {i: t for t, i in self.vocab.items()}
        self.blank = self.vocab["<pad>"]
        self.sep = self.vocab["|"]
        self._build_amount_decoder()
        self._build_extension_index()

    # -- lexicon ------------------------------------------------------------
    def _labels_for(self, s: str):
        out = []
        for ch in s.upper().replace(" ", "|"):
            if ch not in self.vocab:
                return None
            out.append(self.vocab[ch])
        return out

    def _build_amount_decoder(self):
        self.cand_ids = {}
        for n in range(1, 10000):
            words = G.int_to_words(n)
            forms = [" ".join(words)]
            if len(words) > 1:
                # the fused form: real Greek compounds are one stress group and
                # the model transcribes them without the separator
                forms.append("".join(words))
            forms += [f + " ΕΥΡΩ" for f in list(forms)]
            self.cand_ids[n] = [
                lb for f in forms if (lb := self._labels_for(f))
            ]
        tok = Dictionary()
        for i in range(len(self.vocab)):
            tok.add_entry(self.inv.get(i, f"<{i}>"))
        self.word_dict = Dictionary()
        for n in self.cand_ids:
            self.word_dict.add_entry(str(n))
        self.word_dict.add_entry("<unk>")
        trie = Trie(tok.index_size(), self.sep)
        for n, lbs in self.cand_ids.items():
            for lb in lbs:
                trie.insert(lb, self.word_dict.get_index(str(n)), 0.0)
        trie.smear(SmearingMode.MAX)
        # word_score=-8: the insertion penalty measured best in the recipe
        # sweep (raised real-clip accuracy 5/10 -> 8/10 by itself). unk=-inf:
        # the amount slot admits nothing outside the lexicon — out-of-grammar
        # audio is caught by the LR guard, not absorbed.
        opts = LexiconDecoderOptions(
            beam_size=150,
            beam_size_token=len(self.vocab),
            beam_threshold=60.0,
            lm_weight=0.0,
            word_score=-8.0,
            unk_score=-np.inf,
            sil_score=0.0,
            log_add=False,
            criterion_type=CriterionType.CTC,
        )
        self.amount_dec = LexiconDecoder(
            opts, trie, ZeroLM(), self.sep, self.blank,
            self.word_dict.get_index("<unk>"), [], False,
        )

    def _build_extension_index(self):
        """Spelling -> the values whose numeral spelling strictly EXTENDS it.

        Indexed by the numeral only: «ΕΥΡΩ» is a suffix, not part of the number,
        so ΟΓΔΟΝΤΑ's competitor is «ΟΓΔΟΝΤΑΟΧΤΩ (ΕΥΡΩ)» — indexing the
        ΕΥΡΩ-suffixed string instead finds nothing, which silently disabled the
        check on 5 of 13 measured dangerous decodes (the speaker usually DOES say
        «ευρώ», so that variant usually wins the spelling contest).

        Measured on this lexicon: 1123 of 9999 values have a value-changing
        extension. The other ~89% — every …ΕΞΙ/…ΕΝΑ/…ΤΡΙΑ compound — are exempt
        from the check for free, because no in-grammar word continues them, so a
        truncation cannot turn them into a different valid amount.
        """
        self.forms = {}
        owner = {}
        for n, lbs in self.cand_ids.items():
            fs = sorted(
                {
                    "".join(self.inv.get(i, "") for i in lb).replace("|", "")
                    for lb in lbs
                }
            )
            self.forms[n] = fs
            for f in fs:
                owner.setdefault(f, set()).add(n)
        self._allforms = sorted(owner)
        self._owner = owner

    def _extensions_of(self, spelling: str, val: int, k: int = 8):
        """[(competitor spelling, value)] — the k shortest continuations."""
        import bisect

        had_cur = spelling.endswith("ΕΥΡΩ")
        stem = spelling[: -len("ΕΥΡΩ")] if had_cur else spelling
        found = []
        i = bisect.bisect_right(self._allforms, stem)
        while i < len(self._allforms) and self._allforms[i].startswith(stem):
            f = self._allforms[i]
            i += 1
            if f == stem or f.endswith("ΕΥΡΩ"):
                continue
            for v in self._owner[f] - {val}:
                found.append((len(f), f + ("ΕΥΡΩ" if had_cur else ""), v))
        found.sort()
        seen, keep = set(), []
        for _, f, v in found:
            if v in seen:
                continue
            seen.add(v)
            keep.append((f, v))
            if len(keep) >= k:
                break
        return keep, len(stem)

    def _truncation_margin(self, lp, value):
        """Δ = best PREFIX alignment of an in-grammar continuation
             − COMPLETE alignment of the winner, in nats (max semiring both
        sides, as the LR guard requires).

        Δ near zero means a LONGER valid amount explains this audio just as well
        as the winner and merely ran out of frames — the signature of a recording
        cut mid-word. Returns (Δ, alternative value) or (None, None) when the
        winner admits no continuation.

        MEASURED (313-decode synthetic truncation ladder, 46 clips × 0-400 ms):
        this is the ONLY one of six candidate signals with a usable operating
        point. At θ=4 nats it fired on 0 of 25 scoreable correct decodes — 21 of
        them «…ΕΥΡΩ», the vowel-final class that made both previous guards
        unusable — while catching 19% of value-changing truncations, and in the
        cases it caught, the named alternative WAS the truth (88 for a decoded
        80, 255 for a decoded 250). The five signals it beat, all refuted by the
        same ladder: trailing-blank run (median 0 frames on correct AND on
        truncated), non-blank tail mass (~1.0 on both), prefix-extensibility
        alone (fires on 61% of correct decodes — round numbers ARE the extensible
        ones), frames-per-character (separates the wrong way), and the LR itself
        (INVERTED: truncated decodes score better, median −37 vs −59 nats).

        Structural blind spot, and it is not fixable acoustically: if the cut
        removed the whole continuation, no frames support it and Δ collapses. A
        cut exactly at a word boundary is undetectable. That is why the flag is
        advisory and the human confirmation stays the backstop.
        """
        forms = self.forms.get(value) or []
        targets = [self._labels_for(f) for f in forms]
        pairs = [(f, t) for f, t in zip(forms, targets) if t]
        if not pairs:
            return None, None
        sc = R.ctc_viterbi_batch(lp, [t for _, t in pairs])
        bi = int(np.argmax(sc))
        w_spell, s_complete = pairs[bi][0], float(sc[bi])

        exts, stem_len = self._extensions_of(w_spell, value)
        cand = [(f, v, lb) for f, v in exts if (lb := self._labels_for(f))]
        if not cand:
            return None, None
        # require the alignment to consume the winner PLUS one further character,
        # else the prefix score degenerates into re-scoring the winner
        s_min = [2 * stem_len + 1] * len(cand)
        sp = R.ctc_viterbi_prefix_batch(lp, [lb for _, _, lb in cand], s_min)
        j = int(np.argmax(sp))
        return float(sp[j]) - s_complete, int(cand[j][1])

    # -- audio --------------------------------------------------------------
    def decode_audio(self, data: bytes) -> np.ndarray:
        """Any container Telegram sends (OGG/Opus, m4a, wav) -> 16k mono f32.

        ffmpeg does the decode; the model card requires 16 kHz and silently
        degrades on anything else, so the rate is forced here, once, rather
        than trusted from the sender.
        """
        with tempfile.NamedTemporaryFile(suffix=".bin") as fin, tempfile.NamedTemporaryFile(
            suffix=".wav"
        ) as fout:
            fin.write(data)
            fin.flush()
            subprocess.run(
                ["ffmpeg", "-loglevel", "error", "-y", "-i", fin.name,
                 "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", fout.name],
                check=True, timeout=30,
            )
            with wave.open(fout.name) as w:
                pcm = np.frombuffer(
                    w.readframes(w.getnframes()), dtype=np.int16
                )
        return pcm.astype(np.float32) / 32768.0

    def _logits(self, wav: np.ndarray) -> np.ndarray:
        # Per-span mean/variance normalisation (wav2vec2 do_normalize=True).
        # Normalising the SPAN rather than the whole buffer bounds the
        # padding-sensitivity the review measured: the span content is
        # VAD-determined, not upload-determined.
        x = (wav - wav.mean()) / np.sqrt(wav.var() + 1e-7)
        lg = self.sess.run(None, {self.inp: x[None, :].astype(np.float32)})[0][0]
        lg = lg - lg.max(-1, keepdims=True)
        return lg - np.log(np.exp(lg).sum(-1, keepdims=True))

    def _greedy(self, lp: np.ndarray) -> str:
        ids = lp.argmax(-1)
        out, prev = [], -1
        for i in ids:
            if i != prev and i != self.blank:
                out.append(int(i))
            prev = i
        return "".join(self.inv.get(i, "") for i in out).replace("|", " ").strip()

    # -- modes ----------------------------------------------------------------
    def recognize(self, data: bytes, mode: str) -> dict:
        t0 = time.time()
        wav = self.decode_audio(data)
        spans = self.vad.spans(wav)
        if not spans:
            return _res(mode, None, None, 0.0, None, "no_speech", t0)
        too_long = [s for s in spans if (s[1] - s[0]) / SR > MAX_SPAN_S]
        if too_long:
            return _res(mode, None, None, 0.0, None, "too_long", t0)
        # TOTAL cap as well as per-span (gate-8 container finding): command mode
        # decodes every span, so a rambling many-span note could exceed the api
        # client's 45s timeout while wedging the single-flight lock for everyone.
        total_speech = sum(b - a for a, b in spans) / SR
        if total_speech > MAX_SPAN_S:
            return _res(mode, None, None, 0.0, None, "too_long", t0)

        if mode == "command":
            # transcript only; slot extraction happens API-side where the
            # realm's names live
            texts, n_frames = [], 0
            for a, b in spans:
                lp_span = self._logits(wav[a:b])
                n_frames += lp_span.shape[0]
                texts.append(self._greedy(lp_span))
            r = _res(mode, " ".join(texts).strip(), None, 0.0, None,
                     "transcript", t0, n_frames)
            r["spans"] = [[a / SR, b / SR] for a, b in spans]
            return r

        # single-utterance modes: more than one speech span answering an
        # amount question is the review's two-amounts-at-p=1.0 defect — refuse
        # and let the bot re-ask, rather than pick one and be confidently wrong
        if len(spans) > 1 and mode == "amount":
            return _res(mode, None, None, 0.0, None, "multiple_utterances", t0)
        a, b = max(spans, key=lambda s: s[1] - s[0])
        # TRUNCATION is measured in _amount() via _truncation_margin(), NOT here
        # and NOT from the audio geometry. Two input-side attempts failed at this
        # exact spot (span-vs-buffer gap + RMS; then VAD ends_in_speech) because
        # silero pads every span to the buffer edge, so a tight complete
        # recording and a mid-word cut are indistinguishable from VAD alone. The
        # signal that works is a DECODER-side one and needs the logits, so it
        # lives where the logits and the winning hypothesis both exist.
        lp = self._logits(wav[a:b]).astype(np.float64)
        transcript = self._greedy(lp)

        if mode == "amount":
            return self._amount(lp, transcript, t0)
        if mode in ("yesno", "month"):
            table = (
                {k: v for k, v in YESNO.items()}
                if mode == "yesno"
                else {m: MONTHS[m] for m in MONTHS}
            )
            return self._closed_set(lp, transcript, table, mode, t0)
        raise ValueError(f"unknown mode {mode}")

    def _amount(self, lp, transcript, t0):
        em = np.ascontiguousarray(lp.astype(np.float32))
        T, N = em.shape
        seeds = []
        for r in self.amount_dec.decode(em.ctypes.data, T, N):
            w = [x for x in r.words
                 if x >= 0 and self.word_dict.get_entry(x) != "<unk>"]
            if w:
                n = int(self.word_dict.get_entry(w[0]))
                if n not in seeds:
                    seeds.append(n)
            if len(seeds) >= 5:
                break
        if not seeds:
            return _res("amount", transcript, None, 0.0, None, "no_hypothesis",
                        t0, T)
        wide = set()
        for n in seeds[:3]:
            wide |= R.slot_neighbours(n)
        wide = sorted(w for w in wide if w in self.cand_ids)
        targets, owner = [], []
        for n in wide:
            for lb in self.cand_ids[n]:
                targets.append(lb)
                owner.append(n)
        sc = R.ctc_logp_batch(lp, targets)
        best = {}
        for s, n in zip(sc, owner):
            if n not in best or s > best[n]:
                best[n] = s
        items = sorted(best.items(), key=lambda kv: -kv[1])
        arr = np.array([v for _, v in items]) / 4.0
        arr -= arr.max()
        p = float(np.exp(arr[0]) / np.exp(arr).sum())
        n1, s1 = items[0]
        # LR in the MAX semiring on both sides (see rescore.ctc_viterbi_batch):
        # best alignment of the winning spelling vs the unconstrained argmax path.
        win_targets = [lb for lb in self.cand_ids[n1]]
        vit = float(R.ctc_viterbi_batch(lp, win_targets).max())
        lr = vit - float(lp.max(axis=1).sum())
        r = _res("amount", transcript, int(n1), p, lr, "rank", t0, lp.shape[0])
        # Truncation margin — ADVISORY, like p and lr: reported raw, never gating
        # `accept` here. The threshold belongs to the api, where confirmed samples
        # accumulate; θ=4 nats is the measured 0-false-alarm bracket (Kaldi's own
        # max_relative_cost is 2.0 confident / 8.0 permissive) but 25 clips cannot
        # fix a money threshold, which is the whole reason for shadow mode.
        delta, alt = self._truncation_margin(lp, int(n1))
        r["truncMargin"] = None if delta is None else round(delta, 2)
        r["truncAlt"] = alt
        return r

    def _closed_set(self, lp, transcript, table, mode, t0):
        """2 (yesno) or 12 (month) candidates: no beam needed — score every
        surface form by exact forced alignment directly."""
        targets, owner = [], []
        for key, forms in table.items():
            for f in forms:
                lb = self._labels_for(f)
                if lb:
                    targets.append(lb)
                    owner.append(key)
        sc = R.ctc_logp_batch(lp, targets)
        best = {}
        for s, k in zip(sc, owner):
            if k not in best or s > best[k]:
                best[k] = s
        items = sorted(best.items(), key=lambda kv: -kv[1])
        arr = np.array([v for _, v in items]) / 4.0
        arr -= arr.max()
        p = float(np.exp(arr[0]) / np.exp(arr).sum())
        k1, s1 = items[0]
        win = [lb for f in table[k1] if (lb := self._labels_for(f))]
        vit = float(R.ctc_viterbi_batch(lp, win).max())
        lr = vit - float(lp.max(axis=1).sum())
        return _res(mode, transcript, k1, p, lr, "rank", t0, lp.shape[0])


# Per-mode gates, from the measured separation on the eval set (real answers
# vs adversarial inputs). PROVISIONAL and deliberately conservative — shadow
# mode exists precisely to recalibrate these from confirmed samples, so they
# are returned alongside the raw p/lr rather than being the last word. The
# amount gate (LR >= -150) sits in the ~160-nat gap the review measured
# between the worst correct answer (-86) and the best dangerous input (-247).
_GATES = {
    "amount": {"p": 0.80, "lr": -150.0},
    "yesno": {"p": 0.80, "lr": -80.0},
    "month": {"p": 0.80, "lr": -120.0},
    "command": {"p": 0.0, "lr": -1e9},  # transcript only; the api decides
}


def _res(mode, transcript, value, p, lr, reason, t0, n_frames=0):
    gate = _GATES.get(mode, _GATES["command"])
    # `accept` is ADVISORY. It is true only when the value cleared both the
    # posterior and the likelihood-ratio gate; the api still shows the human a
    # confirmation and never acts on money regardless (shadow mode). A false
    # accept means "re-ask / ask the operator to type it", not "silently drop".
    accept = (
        value is not None
        and reason == "rank"
        and p >= gate["p"]
        and (lr is None or lr >= gate["lr"])
    )
    return {
        "ok": True,
        "mode": mode,
        "transcript": transcript,
        "value": value,
        "p": round(p, 4),
        "lr": None if lr is None else round(float(lr), 1),
        "accept": accept,
        "reason": reason,
        # Post-VAD logit frames actually scored (0 on refusals). The api
        # persists this beside p/lr on every sample because the calibration
        # literature normalizes the LR by length (nats/frame) — a raw-LR gate
        # is implicitly a duration gate. Kept raw here for the same reason as
        # p/lr: thresholds are the api's job, this container just measures.
        "nFrames": int(n_frames),
        # Present on every response so the shape is stable; only amount mode
        # ever computes them (see _truncation_margin).
        "truncMargin": None,
        "truncAlt": None,
        "ms": int((time.time() - t0) * 1000),
    }
