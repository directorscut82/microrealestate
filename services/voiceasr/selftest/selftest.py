# -*- coding: utf-8 -*-
"""Container self-test: proves the pipeline loads and recognizes on a known clip
WITHOUT any network. Run in CI and as a smoke test. Exit non-zero on failure."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from pipeline import Pipeline

p = Pipeline()
data = open(os.path.join(os.path.dirname(__file__), "t_255.wav"), "rb").read()
# t_255 is synthetic «διακόσια πενήντα πέντε ευρώ»
r = p.recognize(data, "amount")
print(r)
assert r["value"] == 255, f"expected 255, got {r['value']}"
assert r["p"] > 0.5, f"low posterior {r['p']}"

# --- the prefix-terminating Viterbi, on synthetic logits ---------------------
# Guards the one primitive that has no equivalent elsewhere in the file. The
# invariants are exact, not statistical, so this cannot become a flaky assert:
#   · terminating anywhere (s_min=0) can never score BELOW terminating at the
#     end, because the final states are inside the allowed set;
#   · a target twice as long as the audio can support scores far worse COMPLETE
#     than as a PREFIX — that gap IS the truncation margin;
#   · requiring one character beyond the winner must not silently re-score the
#     winner (s_min clamped, never negative).
import numpy as np
import rescore as R

V, T = 5, 12
lg = np.full((T, V), -8.0)
lg[:, 0] = -0.2                      # blank dominates, as CTC does
for t, ch in enumerate([1, 1, 2, 2]):  # audio supports "AB" then goes quiet
    lg[t, ch] = -0.05
lp = lg - np.log(np.exp(lg).sum(axis=1, keepdims=True))

short, long_ = [1, 2], [1, 2, 3, 4]   # "AB" and "ABCD"
c_short = float(R.ctc_viterbi_batch(lp, [short])[0])
c_long = float(R.ctc_viterbi_batch(lp, [long_])[0])
p_long = float(R.ctc_viterbi_prefix_batch(lp, [long_], [2 * len(short) + 1])[0])
p_any = float(R.ctc_viterbi_prefix_batch(lp, [long_], [0])[0])

assert p_any >= c_long - 1e-9, f"prefix-anywhere {p_any} < complete {c_long}"
assert p_long > c_long, f"prefix {p_long} should beat complete {c_long}"
assert c_short > c_long, "audio supports the short target better"
# and the margin has the sign the pipeline reads: a longer word that ran out of
# frames is CLOSE to the winner, while forcing all of it is far away.
assert (p_long - c_short) > (c_long - c_short), "margin must favour the prefix"
print(f"prefix-viterbi OK  complete_long={c_long:.2f} prefix_long={p_long:.2f} "
      f"complete_short={c_short:.2f}")

print("SELFTEST OK")
