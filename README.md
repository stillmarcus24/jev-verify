# jev-confidence-law

**Jev returns a typed verdict with a `confidence`. That number is a closed-form rescaling of the top probability — it carries no information the probabilities don't already give you.**

Recovered from **published artifacts only**. No API key, no account, no vendor cooperation.

## The two identities

```
L1   confidence = (p_top - 1/n) / (1 - 1/n)        # Choice and Score
L2   score      = SUM(level * p(level))            # Score: the expected level
```

`n` is the number of options (Choice) or levels (Score).

Neither is documented. TypeSafe's own [`/confidence`](https://docs.typesafe.ai/confidence) page
says confidence *"is a statistic computed from the probability distribution the answer already
gives you"*, then defers the definition:

> *"you are never locked into our definition. The pros and cons of different computations is a
> specialized topic that we'll keep to a separate cookbook rather than this page, and will add
> the link here when we do!"*

That cookbook was never published. The formula was recoverable anyway, because a deterministic
function leaves its fingerprint in every output it produces.

## Verified against vendor-channel examples

| source | L1 | L2 |
|---|---|---|
| `cloudflare/cloudflare-docs` catalog | 8/8 exact | exact |
| `vercel/ai` | 2/2 exact | exact |

Cloudflare's own published example: probabilities `{0:0, 1:0.96, 2:0.04}` → L1 predicts
confidence `0.94` (published: **0.94**), L2 predicts score `1.04` (published: **1.04**).

## What this means

1. **Confidence is not a second signal.** It is `p_top` rescaled. Anyone treating it as an
   independent check on the probability is reading the same number twice.
2. **A confidence gate is a probability gate.** Confidence is monotone in `p_top` for 98.2% of
   observed samples, so `confidence > t` is `p_top > t'`. Same decision, different label.
3. **It inverts.** `n=3, confidence 0.90` → `p_top = 0.9333` exactly. The score hides nothing.
4. **The ecosystem cites the wrong formula.** `2*p_top - 1` is only the **n=2** special case;
   on n>=3 samples it is correct **26.5%** of the time (221/834).
5. **Noul carries no confidence at all** — vendor-confirmed, and 0 of 26 observed Noul answers
   have the field.

## Provenance matters — read this before quoting a number

Published "Jev outputs" are not one population. Conflating them produces a false headline.
This corpus contains at least four kinds:

| population | what it is | L1/L2 conform | fabrication flags |
|---|---|---|---|
| **vendor-channel** | Cloudflare + Vercel catalog examples | **10/10 = 100%** | 0 |
| **recorded responses** | real API calls captured to disk | **843/854 = 98.7%** | 0 |
| **reimplementations** | third-party models named after Jev (`KaLM-Jev`, `Open-Jev`) | 19/80 = 23.8% | 0 |
| **hand-authored fixtures / notes** | written by a human or a generator | 115/296 = 38.9% | **121** |

**Headline: 853/864 = 98.7%** on vendor-channel + recorded responses. The all-in number across
every file that merely mentions "jev" is 79.6%, and that number is misleading — do not quote it.

Two things fall out of this table that matter more than the headline:

- **All 121 fabrication flags land in the hand-authored stratum. Zero fire on vendor-channel or
  recorded responses.** The detector never misfires on real model output. That separation is
  what licenses trusting it.
- **Reimplementations conform at only 23.8%.** Projects named after Jev (`Open-Jev`,
  `KaLM-Jev`) do **not** reproduce its confidence function. If you swapped one in expecting
  drop-in equivalence, your confidence values are on a different scale than the ones you
  calibrated your thresholds against.

## The fabrication fingerprint

Some published fixtures set `confidence` to the **fractional part of `score`**:

```
score 2.58 -> conf 0.58      score 2.53 -> conf 0.53
score 2.38 -> conf 0.38      score 2.66 -> conf 0.66
```

A calibration statistic cannot legitimately track a decimal remainder. This is a generator
artifact. It appears in `ax-llm/ax` and `0xPlaygrounds/rig`'s `rounded.json`, and in **zero**
vendor-channel or recorded-response samples — the same sources the L1 test flags independently.
Two unrelated detectors agreeing is what makes it evidence rather than an anomaly.

**Stated fairly:** a deviation means *"this output does not obey the laws the model's real
outputs obey."* Innocent explanations exist and must be checked first — deliberate rounding
(`rounded.json` is named for it), an older model version, or a reimplementation. The tool
reports deviation; it does not assert intent.

## Install and run

Requires Node 18+. No dependencies.

```bash
git clone https://github.com/<owner>/jev-confidence-law
cd jev-confidence-law
node test/known-answer.cjs                       # 27 known-answer tests, must print "0 failed"
node bin/jev-verify.cjs corpus                   # verify the bundled corpus
node bin/jev-verify.cjs --repo owner/name        # verify any GitHub repo
node bin/jev-verify.cjs path/to/file.json --json # machine-readable
```

Exit code is `0` when every answer conforms, `1` when any deviates, `2` on error.

Optional: `--notarize` requests an Ed25519-signed, hash-chained receipt for the run, so a
verification result is itself externally checkable rather than something you take on trust.

## Reproducing the recovery from scratch

`scripts/` contains the original analysis: `recover.py` fits the candidate laws,
`deep.py` stratifies by model version and primitive, `score.py` recovers L2. `data/fetched.txt`
lists every harvested file with its source repo and path, so the corpus is re-derivable.

Candidate laws tested and rejected, with fit on the Choice corpus:

| candidate | exact @ +/-0.011 |
|---|---|
| **(p_top - 1/n)/(1 - 1/n)** | **87.5%** (98.5% on Choice at +/-0.02) |
| p_top | 35.8% |
| p_top - p_second | 31.0% |
| 2*p_top - 1 | 26.7% |
| 1 - normalised entropy | 22.3% |
| normalised Gini | 19.2% |

## Limits

- Covers `Choice` and `Score`. **`Noul` returns no confidence**, so there is nothing to check.
- Clean `Score` samples are thin (n=15 vendor-channel + recorded). L2 is exact on those, but
  treat the Score headline as a strong result on small n.
- **No live Jev API call was ever made.** Every number here comes from published artifacts.
  A single authenticated call would confirm L1 and L2 directly; it would not change them.
- Tolerances follow publishing precision: probabilities are published at 2dp, so a +/-0.005
  rounding on `p_top` propagates to <=0.010 on confidence. `EXACT` is 0.011, `CONFORM` is 0.02.

## License

MIT.
