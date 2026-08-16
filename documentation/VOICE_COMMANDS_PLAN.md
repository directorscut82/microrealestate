# Voice money-commands over Telegram — plan & state

> **Status 2026-08-16:** deployed in SHADOW MODE (revision `077d0e3b` + the decodes
> follow-up). The bot holds the dialogue and persists validation samples; **no money
> operation is ever executed from this path** — `voicesession.ts` imports no manager and
> a jest test pins that. The samples decide whether recognition is ever allowed to act.

## What is shipped

| Piece | Where | What it does |
|---|---|---|
| Recognition container | `services/voiceasr/` | Greek wav2vec2 (int8 ONNX, AVX2-free, runs on the NAS J4125 in 1.2–2.7 s/decode), Silero VAD, flashlight-text lexicon decode over a 1..9999 Greek numeral grammar, exact CTC forced-alignment rescoring, posterior + likelihood-ratio guards. Returns RAW `p`/`lr`/`nFrames` — thresholds are the api's job. |
| Dialogue state machine | `services/api/src/managers/voicesession.ts` | Modality-independent (first message and every reply may be voice OR text), noise-tolerant (phonetic-skeleton fuzzy matching with confidence floors, three-pass reply parsing), one session per realm, 10-min TTL, abandonment sweep. |
| Router | `services/api/src/jobs/voicecommandhandler.ts` | Claims dialogue messages, never claims a bill document/photo, idempotent against Telegram batch re-delivery, saves the sample BEFORE the «Καταγράφηκε» reply. |
| Sample store | `InboxItem` `kind:'voiceCommand'` | Slots, full transcript, Telegram file_ids (audio bytes stay in Telegram), corrections, outcome, and per-decode scores (`decodes[]` — see below). |

Example dialogue (synthetic names only — never real tenant data in this repo):

    Χρήστης  (φωνητικό) «καταβολή ενοικίου Δοκιμή Κάππα»
    Bot       Ποιο είναι το ποσό; Πείτε σκέτο το ποσό ή γράψτε το με ψηφία.
    Χρήστης  (γραπτό) 350
    Bot       Για ποιον μήνα;
    Χρήστης  Αύγουστος
    Bot       Επιβεβαιώστε: καταβολή ενοικίου — ΔΟΚΙΜΗ ΚΑΠΠΑ, 350 €, Αύγουστος.
              Απαντήστε «ναι» ή «όχι». Δοκιμαστική λειτουργία: δεν θα καταχωρηθεί
              τίποτα αυτόματα.
    Χρήστης  ναι
    Bot       Καταγράφηκε ως δείγμα επικύρωσης.

## The calibration dataset (`voiceCommand.decodes[]`)

Every voice turn records `{mode, value, p, lr, nFrames, accept, reason, ms}` raw.
The human ναι/όχι labels these scores; without them a sample is a label with
nothing to calibrate. Declared end-to-end (container → client → session →
schema → types) because mongoose strict silently drops undeclared sub-paths —
the `chargeableAmount` incident, documented in the schema itself.

A worked example of why labels matter more than scores: on the real eval clip
whose ground truth is 96 but whose recording is clipped mid-word, the pipeline
decodes 90 with `p=0.88, lr=-6.1/26 frames` — per-frame that is a BETTER score
than a correct «τριακόσια» clip (`lr=-45.2/41`). The error is score-invisible
by construction (the truncated audio genuinely is the best evidence for 90);
only the human labels expose it, which is what the gate below counts.

## Calibration & enable-gate procedure (researched, citations below)

# Calibrating accept thresholds for the Greek voice-command shadow stream

## 1. Which calibration methods survive n = 20–100

**Use Platt scaling (penalized logistic) as the primary tool; beta calibration as a refinement on `p`; do not use isotonic regression at this sample size.**

- **Platt scaling** fits a 2-parameter sigmoid `P(correct) = σ(A·s + B)` by maximum likelihood, and was explicitly designed with small-sample regularization built in: Platt replaces the 0/1 targets with smoothed targets `t₊ = (N₊+1)/(N₊+2)`, `t₋ = 1/(N₋+2)` precisely so the fit does not saturate on small calibration sets (Platt 1999). Two parameters means ~10–15 samples per parameter at n=30 — workable.
- **Isotonic regression** (Zadrozny & Elkan 2002) is nonparametric (PAV, piecewise-constant) and is documented to overfit below roughly 1000 calibration points; Niculescu-Mizil & Caruana (2005) show Platt dominating isotonic in the small-data regime, with isotonic only overtaking at ~1000+ samples. At n=30 an isotonic fit is essentially a lookup table of your noise. **Excluded.**
- **Beta calibration** (Kull, Silva Filho & Flach, AISTATS 2017) is a 3-parameter map for scores already in [0,1]; its family contains the identity, so it cannot make an already-calibrated posterior worse the way a sigmoid forced through logit space can. Appropriate for the forward-sum posterior `p`. For the likelihood ratio `lr` (an unbounded log-score), the natural form is affine log-LR calibration `llr' = a·llr + b` trained by logistic regression — this is the standard recipe in speaker/language recognition (Brümmer & du Preez 2006, the FoCal method behind Cllr evaluation) and is mathematically the same object as Platt scaling.
- **Small-n failure mode to plan for:** at n=30 with few or zero errors you get quasi-complete separation and vanilla logistic MLE diverges. Use **Firth's penalized likelihood** (Firth 1993), which always has a finite solution, or a weakly-informative prior (Gelman et al. 2008, Cauchy(0, 2.5) on standardized coefficients). Evaluate by **leave-one-out CV**, which is nearly free at this n.

Concrete model per mode:

```
P(correct) = σ( w0 + w1 · (lr / nFrames) + w2 · logit(p) )   # Firth-penalized fit, LOOCV
```

## 2. How the KWS / utterance-verification literature sets LR thresholds

**Duration normalization is standard.** The LR test in utterance verification descends from Rose & Paul (1990) (keyword vs. filler/background likelihood ratio). The follow-on UV literature normalizes the log-LR by the number of frames in the tested segment so that a single threshold is comparable across utterance lengths: Sukkar & Lee (1996) and Lleida & Rose (2000) both define frame-normalized (time-normalized) LR scores as the test statistic; Rahim, Lee & Juang (1997) pass the segment LR through a sigmoid — i.e. calibrate it — before thresholding. In speaker verification the same problem is handled by score normalization (Z-norm/T-norm; Auckenthaler et al. 2000) and, directly on point for you, by **using duration as a calibration covariate** (Mandasari et al. 2013, "quality measure functions" for duration-varying trials).

**Implication for the current gate:** the advisory `amount lr >= -150` is an *un-normalized* total, so it is implicitly length-dependent — a 3 s «τρεις χιλιάδες εξακόσια εβδομήντα δύο» accumulates far more nats than a 0.5 s «δέκα». Convert the gate to **nats/frame** (or nats/second): `lr / nFrames`. This is the single highest-value change and is exactly what the UV literature does.

**Per-keyword thresholds are also standard.** NIST Spoken Term Detection scoring (ATWV; Fiscus et al. 2007) drove per-term operating points: the ATWV-optimal threshold depends on the term's occurrence statistics (Miller et al. 2007 derive the per-term threshold analytically), and later systems fold this into **keyword-specific score normalization** so a single global threshold works after normalization (Karakos et al. 2013). Translation for you: per-*mode* thresholds (or a mode covariate in the calibration model) are the norm, not an exotic choice.

## 3. Sequential rule: when is there enough evidence to enable auto-accept?

Target: 95% confident that FA rate < 5%, where FA = "gate accepts AND human verdict was όχι/wrong", counted **only over samples the frozen gate would have accepted** (the bound is on the conditional error of the accept region, so the denominator is accepted samples, not all samples).

**Fixed-n answer (exact, verified numerically):**

| Observed FAs | Accepted samples needed (Clopper–Pearson, one-sided 95%, FA < 5%) |
|---|---|
| 0 | **59** (rule of three ≈ 3/0.05 = 60; Hanley & Lippman-Hand 1983) |
| 1 | 93 |
| 2 | 124 |

Wilson gives 52 at k=0 but is anticonservative exactly at the zero-numerator boundary (Brown, Cai & DasGupta 2001 recommend Wilson/Jeffreys generally but note the boundary behavior); Clopper–Pearson (1934) is the conservative, defensible choice for a go/no-go gate. The Bayesian versions bracket it: uniform prior → 58, Jeffreys prior → 38 (aggressive; use only if you accept the prior argument).

**Sequential answer (samples trickle in over weeks, you peek constantly):** repeatedly applying the fixed-n test inflates the error. Two clean options:

1. **Wald SPRT** (Wald 1945) — optional stopping is built in. Test H₀: FA = 5% (unacceptable) vs H₁: FA = 1% (acceptable), α = β = 0.05. Boundaries ±ln 19 = ±2.944; each clean accepted sample adds ln(0.99/0.95) = 0.0412, each FA subtracts ln 5 = 1.609. So: **enable after 72 consecutive clean accepted samples; each FA costs 40 additional clean samples; two FAs inside the first ~7 samples crosses the reject boundary** (stay advisory, raise the threshold).
2. **Anytime-valid confidence sequences** (Howard et al. 2021; Waudby-Smith & Ramdas 2023) if you want a running upper bound on FA that is valid at every peek. Overkill here; the milestone table above used as *pre-registered checkpoints* is the pragmatic middle ground.

**Selection-bias rule:** the threshold must be **frozen before the counter starts**. Samples used to pick τ (Phase 1 below) cannot count toward the 59/72. If τ is later changed, the counter resets.

## 4. Separate thresholds per mode — yes

- **Vocabulary size shapes the score distribution under both hypotheses.** Posterior-type confidences depend directly on the competing-hypothesis space (Wessel et al. 2001): a yes/no decode competes against 1 alternative, an amount decode against up to 9998 partially-confusable numeral strings (and the clipping-truncation confusions live almost entirely in amount mode). The KWS literature's per-term thresholds / per-term normalization (Miller et al. 2007; Karakos et al. 2013) is the same phenomenon at word granularity.
- **Utterance length differs systematically by mode** (yes/no ≈ 0.3–0.6 s; amounts 1–3 s). Even after per-frame normalization, the *variance* of the normalized LR scales like 1/duration, so short-mode and long-mode distributions differ; duration-aware calibration is established practice (Mandasari et al. 2013).
- With tiny per-mode n, don't fit three fully independent models: **pool the slope, free the intercept** (fit `w1` on all modes jointly, per-mode `w0`) — a standard partial-pooling compromise.
- **Amount mode deserves a stricter target** because the clipped-«ενενήντα έξι»→90 failure is an in-grammar substitution: the truncated audio genuinely is the best evidence for "90", the free decode sees the same truncated audio, so **neither `p` nor `lr` can flag it — it is score-invisible by construction**. It will, however, surface as an FA in the human-labelled stream, which is exactly what the sequential gate is for. If you want 95%-confident FA < 2% for amounts: **149 clean accepted samples** (0.98ⁿ ≤ 0.05).

## 5. Concrete procedure over InboxItem

Rows: `kind:'voiceCommand'`, `voiceCommand.outcome ∈ {validated, rejected}` (`services/common/src/collections/inboxItem.ts`).

**Step 0 — schema (blocking prerequisite).** The current `voiceCommand` payload stores `transcript: [{text, source}]` but **no per-decode telemetry**. Mongoose strict mode silently deletes undeclared sub-paths on write — documented in this exact schema (`inboxItem.ts:53-57`, the `chargeableAmount` incident) — so the fields must be declared before the container's output is persisted. Add a declared array:

```js
decodes: [{
  mode: String,        // 'amount' | 'yesno' | 'month' | 'command'
  decoded: String,     // canonical decoded value
  p: Number,           // forward-sum forced-alignment posterior
  lr: Number,          // total log-LR (nats), Viterbi both sides
  nFrames: Number,     // post-VAD speech frames in the decoded span
  durationSec: Number,
  verdict: Boolean     // human-confirmed correct (from the dialogue turn)
}]
```

**Step 1 — normalize.** `lrNorm = lr / nFrames` (nats/frame). Retire the raw `lr >= -150` gate; keep it only as a floor if you must.

**Step 2 — calibrate (per mode, once n ≥ ~30 with ≥ 3 errors).** Fit Firth-penalized logistic `P(correct) = σ(w0_mode + w1·lrNorm + w2·logit(p))`, slope pooled across modes, intercept per mode. Validate with LOOCV. While errors < 3 (separation), skip fitting: set τ conservatively at, e.g., the 90th percentile of *rejected*-sample scores or just above the worst observed correct-sample score, and let Step 3 carry the guarantee — the FA bound comes from the counter, not from the calibration.

**Step 3 — freeze τ, count prequentially (per mode).** A nightly job (or on-write hook) scans decodes newer than the freeze date: `accepted = calibratedScore ≥ τ`; `FA = accepted && !verdict`. Maintain `{mode, tau, nAccepted, nFA, frozenAt}`.

**Step 4 — enable gate.** Auto-accept for a mode turns on when the counter reaches a pre-registered milestone: **59 accepted / 0 FA** (or 93/1, 124/2) — or the SPRT crossing (72 consecutive clean, +40 per FA) if you prefer the fully sequential rule. Expect `yesno` to qualify first (high volume, 2-word vocab), `month` next, `amount` last — with the 149/0 milestone if you adopt FA < 2% there.

**Step 5 — post-enable monitoring.** Keep labeling a sampled fraction (the dialogue's ναι/όχι confirm is already the label source). Disable the gate the moment the running count violates the next milestone (e.g., 2nd FA before 124 accepted), and return to advisory + Step 2 refit.

## References

- Platt, J. (1999). Probabilistic outputs for support vector machines and comparisons to regularized likelihood methods. *Advances in Large Margin Classifiers*.
- Zadrozny, B., Elkan, C. (2002). Transforming classifier scores into accurate multiclass probability estimates. *KDD*.
- Niculescu-Mizil, A., Caruana, R. (2005). Predicting good probabilities with supervised learning. *ICML*.
- Kull, M., Silva Filho, T., Flach, P. (2017). Beta calibration: a well-founded and easily implemented improvement on logistic calibration for binary classifiers. *AISTATS*.
- Firth, D. (1993). Bias reduction of maximum likelihood estimates. *Biometrika* 80(1).
- Gelman, A., Jakulin, A., Pittau, M., Su, Y.-S. (2008). A weakly informative default prior distribution for logistic and other regression models. *Ann. Appl. Stat.* 2(4).
- Rose, R. C., Paul, D. B. (1990). A hidden Markov model based keyword recognition system. *ICASSP*.
- Rahim, M., Lee, C.-H., Juang, B.-H. (1997). Discriminative utterance verification for connected digits recognition. *IEEE Trans. Speech Audio Process.* 5(3).
- Sukkar, R., Lee, C.-H. (1996). Vocabulary independent discriminative utterance verification for nonkeyword rejection in subword based speech recognition. *IEEE Trans. Speech Audio Process.* 4(6).
- Lleida, E., Rose, R. C. (2000). Utterance verification in continuous speech recognition: decoding and training procedures. *IEEE Trans. Speech Audio Process.* 8(2).
- Wessel, F., Schlüter, R., Macherey, K., Ney, H. (2001). Confidence measures for large vocabulary continuous speech recognition. *IEEE Trans. Speech Audio Process.* 9(3).
- Fiscus, J., Ajot, J., Garofolo, J., Doddington, G. (2007). Results of the 2006 spoken term detection evaluation. *SSCS/SIGIR Workshop*.
- Miller, D. R. H., et al. (2007). Rapid and accurate spoken term detection. *Interspeech*.
- Karakos, D., et al. (2013). Score normalization and system combination for improved keyword spotting. *ASRU*.
- Auckenthaler, R., Carey, M., Lloyd-Thomas, H. (2000). Score normalization for text-independent speaker verification systems. *Digital Signal Processing* 10.
- Brümmer, N., du Preez, J. (2006). Application-independent evaluation of speaker detection. *Computer Speech & Language* 20.
- Mandasari, M. I., Saeidi, R., McLaren, M., van Leeuwen, D. (2013). Quality measure functions for calibration of speaker recognition systems in various duration conditions. *IEEE Trans. Audio Speech Lang. Process.* 21(11).
- Hanley, J. A., Lippman-Hand, A. (1983). If nothing goes wrong, is everything all right? Interpreting zero numerators. *JAMA* 249(13).
- Clopper, C. J., Pearson, E. S. (1934). The use of confidence or fiducial limits illustrated in the case of the binomial. *Biometrika* 26.
- Brown, L. D., Cai, T., DasGupta, A. (2001). Interval estimation for a binomial proportion. *Statistical Science* 16(2).
- Wald, A. (1945). Sequential tests of statistical hypotheses. *Ann. Math. Statist.* 16(2).
- Howard, S. R., Ramdas, A., McAuliffe, J., Sekhon, J. (2021). Time-uniform, nonparametric, nonasymptotic confidence sequences. *Ann. Statist.* 49(2).
- Waudby-Smith, I., Ramdas, A. (2023). Estimating means of bounded random variables by betting. *JRSS-B* 86(1).

(All sample-size figures — 59/93/124, 149, SPRT 72/+40, uniform 58, Jeffreys 38, Wilson 52 — verified by direct binomial computation, not quoted from approximation.)


## Owed work (honest ledger)

- **Endpointing / truncation detection** — the guard was removed (both attempted
  forms were wrong in one direction or the other; see the long comment in
  `services/voiceasr/src/pipeline.py`). The literature review for the real fix
  has NOT landed (research agents rate-limited twice, 2026-08-16). Unverified
  hypotheses on file: conjunction of VAD ends-in-speech + grammar-prefix
  extensibility (90→96 is a prefix flip) + CTC tail-blank margin; and prompting
  «…ευρώ» so an early cut clips the filler word, not the numeral. Treat both as
  hypotheses to measure, not findings.
- **Currency/cents grammar** («ογδόντα ευρώ και πενήντα λεπτά») — same rate-limited
  review. Do not expand the lexicon before measuring demand in real shadow
  transcripts: any grammar change shifts the p/lr null distributions and resets
  every threshold and counter above.
- **Review surface in the app** — a read-only «Φωνητικές εντολές (δοκιμαστική
  λειτουργία)» card so the landlord can see accumulated samples. The bell is the
  wrong home (it is action-oriented and its list query filters
  status∈{processing,pending}); the third-parties settings page (where Telegram
  is configured) is the proposed home. Mock pending approval.
- **Backup gap**: per-realm backups intentionally exclude nothing new here
  (inboxitems is in `COLLECTIONS_TO_BACKUP`), but remember `TelegramOffset` is
  not backed up — a restore replays recent messages; the router's dedup makes
  that a no-op for samples.
