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
print("SELFTEST OK")
