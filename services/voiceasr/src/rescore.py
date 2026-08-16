# -*- coding: utf-8 -*-
"""Stage 2: exact CTC forced-alignment rescoring of an explicitly widened
candidate set, then one-parameter temperature calibration.

Stage 1 (constrained beam search) is a proposal mechanism: measured, it returns
only ~1.6 distinct valid integers, so a softmax over the beam list has an almost
empty denominator and reports p~1.0 whether or not it is right. The denominator
has to be built on purpose.
"""
import math

import numpy as np

import greeknum as G


def log_softmax(x, axis=-1):
    m = x.max(axis=axis, keepdims=True)
    z = x - m
    return z - np.log(np.exp(z).sum(axis=axis, keepdims=True))


def ctc_logp(logp, target_ids, blank=0):
    """Exact log P(target | logits) by the CTC forward recursion.

    logp: [T, V] log-softmax'd. target_ids: list[int], no blanks.
    O(T * 2L) in numpy; L <= ~40 chars, T <= ~120 frames.
    """
    L = len(target_ids)
    if L == 0:
        return float(logp[:, blank].sum())
    S = 2 * L + 1
    ext = np.full(S, blank, dtype=np.int64)
    ext[1::2] = target_ids
    NEG = -1e30
    a = np.full(S, NEG)
    a[0] = logp[0, blank]
    a[1] = logp[0, ext[1]]
    # positions where a skip is allowed: label != previous label
    can_skip = np.zeros(S, dtype=bool)
    can_skip[3::2] = np.array(target_ids[1:]) != np.array(target_ids[:-1])
    for t in range(1, len(logp)):
        prev = a
        shift1 = np.concatenate(([NEG], prev[:-1]))
        shift2 = np.concatenate(([NEG, NEG], prev[:-2]))
        shift2 = np.where(can_skip, shift2, NEG)
        m = np.maximum(np.maximum(prev, shift1), shift2)
        m = np.where(m < NEG / 2, NEG, m)
        s = np.exp(prev - m) + np.exp(shift1 - m) + np.exp(shift2 - m)
        a = np.where(m <= NEG, NEG, m + np.log(s)) + logp[t, ext]
    end = np.logaddexp(a[-1], a[-2])
    return float(end)


def slot_neighbours(n):
    """Integers whose canonical spelling differs from n's in ~one slot.

    This is the denominator. It must contain the confusions the model actually
    makes -- vowel-level neighbours of the SAME slot (ΕΞΙ/ΕΦΤΑ, ΠΕΝΗΝΤΑ/ΕΝΕΝΗΝΤΑ)
    and the drop-a-slot cases (96 -> 90) that a beam search will not surface.
    """
    th, h, r = n // 1000, (n % 1000) // 100, n % 100
    out = set()
    for a in range(0, 10):
        out.add(a * 1000 + h * 100 + r)
    for b in range(0, 10):
        out.add(th * 1000 + b * 100 + r)
    for c in list(range(0, 20)) + [t * 10 for t in range(2, 10)]:
        out.add(th * 1000 + h * 100 + c)
    tens, units = (r // 10) * 10, r % 10
    for t in range(0, 10):
        out.add(th * 1000 + h * 100 + t * 10 + units)
    for u in range(0, 10):
        out.add(th * 1000 + h * 100 + tens + u)
    out.add(th * 1000 + h * 100)          # slot dropped entirely
    out.add(th * 1000 + r)
    out.add(h * 100 + r)
    return {m for m in out if 1 <= m <= 9999}


def candidate_set(beam_ints, max_extra=400):
    cands = set(beam_ints)
    for n in list(beam_ints)[:3]:
        cands |= slot_neighbours(n)
    return sorted(cands)[:max_extra] if len(cands) > max_extra else sorted(cands)


def spellings(n, ch2id, variants=2):
    """A few surface spellings per integer; take the best-scoring one."""
    base = G.int_to_words(n)
    outs = [" ".join(base)]
    if len(base) > 1:
        outs.append("".join(base))  # the lost-space variant the model produces
    seen, ids = [], []
    for s in outs[:variants]:
        try:
            ids.append([ch2id[c] for c in s])
            seen.append(s)
        except KeyError:
            pass
    return seen, ids


def ctc_logp_batch(logp, targets, blank=0):
    """Vectorised CTC forward for MANY targets at once: ONE python loop over T
    for the whole candidate set. Verified bit-identical to ctc_logp, 9.3x faster
    at T=84/C=62. This is the version to ship."""
    C = len(targets)
    Ls = [len(t) for t in targets]
    Sm = 2 * max(Ls) + 1
    ext = np.full((C, Sm), blank, dtype=np.int64)
    valid = np.zeros((C, Sm), bool)
    can_skip = np.zeros((C, Sm), bool)
    for i, t in enumerate(targets):
        S = 2 * len(t) + 1
        ext[i, 1:S:2] = t
        valid[i, :S] = True
        if len(t) > 1:
            a = np.asarray(t)
            can_skip[i, 3:S:2] = a[1:] != a[:-1]
    NEG = -1e30
    lp = logp[:, ext]                      # [T, C, Sm]
    al = np.full((C, Sm), NEG)
    al[:, 0] = lp[0, :, 0]
    al[np.arange(C), 1] = lp[0, np.arange(C), 1]
    al = np.where(valid, al, NEG)
    for t in range(1, logp.shape[0]):
        s1 = np.concatenate([np.full((C, 1), NEG), al[:, :-1]], 1)
        s2 = np.concatenate([np.full((C, 2), NEG), al[:, :-2]], 1)
        s2 = np.where(can_skip, s2, NEG)
        m = np.maximum(np.maximum(al, s1), s2)
        m = np.where(m < NEG / 2, NEG, m)
        s = np.exp(al - m) + np.exp(s1 - m) + np.exp(s2 - m)
        al = np.where(m <= NEG, NEG, m + np.log(s)) + lp[t]
        al = np.where(valid, al, NEG)
    idx = np.array(Ls) * 2
    return np.logaddexp(al[np.arange(C), idx], al[np.arange(C), idx - 1])


def rescore(logits, beam_ints, ch2id, T=1.0, prior=None):
    """Returns ranked [(n, p)], plus diagnostics."""
    logp = log_softmax(np.asarray(logits, dtype=np.float64), axis=1)
    flat, owner = [], []
    for n in candidate_set(beam_ints):
        _, idlists = spellings(n, ch2id)
        for ids in idlists:
            flat.append(ids)
            owner.append(n)
    if not flat:
        return [], {}
    vals = ctc_logp_batch(logp, flat)
    scores = {}
    for n, v in zip(owner, vals):
        scores[n] = max(scores.get(n, -math.inf), float(v))
    if not scores:
        return [], {}
    ks = list(scores)
    ls = [scores[k] / T + (math.log(prior[k]) if prior else 0.0) for k in ks]
    m = max(ls)
    Z = m + math.log(sum(math.exp(x - m) for x in ls))
    ranked = sorted(((k, math.exp(l - Z)) for k, l in zip(ks, ls)), key=lambda t: -t[1])
    return ranked, scores
