# jev-verify

**Check whether a published Jev output was actually produced by Jev.**

Jev's `confidence` is a deterministic function of the probabilities it already returned. That
means any published Jev answer can be recomputed and checked. Point this at a repository and it
tells you which answers obey the identities and which do not.

## Credit where it belongs

The confidence identity is **not our discovery**. It was established by
**[Stanislav Yurin, "Is Jev confident?" (bernoulli.app, 18 September 2026)](https://bernoulli.app/confidence.html)**,
from over a million live tests:

```
C = (N * p_max - 1) / (N - 1)   ==   (p_max - 1/N) / (1 - 1/N)
```

Over 738,164 live Choice answers he measured a mean absolute residual of 0.005 and a maximum
miss of 0.023. He also treats Score as a modal-concentration measure, shows why entropy
normalization does not rescue it, and notes that Jev returns an expected score. TypeSafe's CTO
responded to that work on 20 September 2026.

**[primeline.cc](https://primeline.cc/blog/typesafe-jev-pre-registered-test)** independently
replicated it on two jobs of 1,203 and 801 answers and added the monotonicity result: strict confidence versus
top-probability reversals occur in 0.076% and 0.030% of pairs, none above a 0.02 gap.

We derived the same identity independently, from 843 published artifacts with no API access,
before finding their work. That is replication by a different method, not a discovery, and the
agreement is the useful part: our residuals (mean 0.005, max 0.0158) sit inside his bounds,
measured on a corpus three orders of magnitude larger than ours.

## What this repository adds

Yurin and primeline tested the **live API**. Neither looked at what the ecosystem **publishes**.
That is a different surface, and it has problems the API cannot show you.

**1. Some published "Jev outputs" were never produced by Jev.** In several fixtures the
`confidence` equals the fractional part of `score`:

```
score 2.58 -> conf 0.58      score 2.53 -> conf 0.53
score 2.38 -> conf 0.38      score 2.66 -> conf 0.66
```

A calibration statistic cannot track a decimal remainder. This is a generator artifact. It
appears in `ax-llm/ax` and in `0xPlaygrounds/rig`'s `rounded.json`, and in **zero** vendor-channel
or recorded-response samples — the same sources the identity test flags independently. Two
unrelated detectors agreeing is what makes it evidence rather than an anomaly.

**Stated fairly:** a deviation means *"this output does not obey the identities real outputs
obey."* Innocent explanations exist and should be checked first — deliberate rounding
(`rounded.json` is named for it), an older model version, or a reimplementation. This tool
reports deviation, not intent.

**2. At least one "Jev-compatible" implementation uses a different confidence function.**
See the census section below for the measured result and its limits.

**3. Published Jev artifacts are not one population.** Conflating them produces a false number:

| population | what it is | conform | fabrication flags |
|---|---|---|---|
| vendor-channel | Cloudflare + Vercel catalog examples | 10/10 = 100% | 0 |
| recorded responses | real API calls captured to disk | 843/854 = 98.7% | 0 |
| reimplementations | third-party models named after Jev | 19/80 = 23.8% | 0 |
| hand-authored fixtures / notes | written by a human or a generator | 115/296 = 38.9% | **121** |

Flags land in the hand-authored stratum and none fire on vendor-channel or recorded responses.
⚠️ The flag counts in this table predate a correction to the detector (see the census section):
`FRAC_COUPLED` now additionally requires an L1 violation, which removed a large share of them as
chance coincidences. Treat the census numbers as current and these as historical.

## Ecosystem census (2026-09-23, structure-aware)

Every public repository on the four `awesome-jev` lists, scanned with this checker. The L0/L1/L2
identities are defined only on a **single categorical distribution** over mutually-exclusive
outcomes, so the checker first classifies each answer's task structure and scores **only
categorical answers**. Multi-label outputs (independent per-option probabilities — detected by a
multi-hot `truth` sibling, or by the mathematical fact that a real distribution cannot carry two
probabilities each > 0.5) and batched containers (`batch_size` > 1) are **skipped, never scored**.

| | |
|---|---|
| repos in scope | 1,061 |
| scanned | 1,054 (99.3%) |
| containing Jev answers | 88 |
| **categorical answers checked** | **275,852** |
| conform | 270,955 (**98.22%**) |
| deviate | 4,897 (1.78%) |

Run it yourself: `node scripts/census.cjs data/ecosystem-repos.txt`. Full per-repo taxonomy in
[`data/conformance-map.json`](data/conformance-map.json).

**Correction (2026-09-23):** an earlier version of this census reported 279,842 answers at 96.79%
and flagged a "fabrication" class including a 2,100-star repo. That was wrong. The detector applied
`probabilities sum to 1` to **every** probabilities map, with no notion of task structure — so it
misread multi-label game/RL outputs (e.g. `TianyuCodings/NanoJev`, whose maze/arcade probabilities
are independent per-direction values that legitimately sum past 1) as fabrication. The checker is
now structure-aware (42 known-answer tests, incl. the exact shapes that caused the false flag), and
detection of genuine categorical fabrication is **not** weakened — the gate is structural, not
sum-based, so a real distribution that fails to sum to 1 (with a `choice` and no multi-hot sibling)
still deviates.

**What the deviations actually are.** Of the 46 repos with any deviation:

- **20 use a different confidence law**, not broken output. The clearest, independently re-verified
  on the live repo: `afshinm/laya-mps` computes `1 - H/log(n)` (normalized entropy) — its
  probabilities sum to **1.000** and its stated confidence deviates from Jev's L1 by a systematic
  mean of 0.155, always lower, the normalized-entropy signature. `deepanwadhwa/OpenDecision` (95.9%)
  and 18 others show the same kind of systematic L1 gap.
- **24 are rounding-level** (small L1/L2 deltas at 2dp publishing precision).
- **2 are unresolved** (`PROBS_DONT_SUM` survivors that concentrate in game/RL repos where outputs
  are plausibly multi-label). These are **not** characterized as fabrication without per-repo review.

## The identities being checked

```
L0   probabilities sum to 1
L1   confidence = (p_top - 1/n) / (1 - 1/n)     # Yurin (2026); Choice and Score
L2   score      = SUM(level * p(level))         # the expected level
```

Noul answers carry no confidence — TypeSafe states this directly on their
[confidence page](https://docs.typesafe.ai/confidence), and 0 of 26 observed Noul answers have
the field. There is nothing to check.

## Install and run

Requires Node 18+. No dependencies.

```bash
git clone https://github.com/stillmarcus24/jev-verify
cd jev-verify
node test/known-answer.cjs                       # 30 known-answer tests, must print "0 failed"
bash test/discover-kat.sh                        # 3 law-discovery tests incl. the exclusion control
bash scripts/fetch_corpus.sh                     # rebuild the corpus from data/fetched.txt
node bin/jev-verify.cjs corpus                   # verify it
node bin/jev-verify.cjs --repo owner/name        # verify any GitHub repo
node bin/jev-verify.cjs path/to/file.json --json # machine-readable
```

Exit code is `0` when every answer conforms, `1` when any deviates, `2` on error.

The corpus is not redistributed here. Every harvested file belongs to the repository that
published it, under that project's license. `data/fetched.txt` is the manifest and
`scripts/fetch_corpus.sh` re-fetches each file from its source, so the corpus is reproducible
rather than copied.

Optional: `--notarize` requests an Ed25519-signed, hash-chained receipt for the run, so a
verification result is itself externally checkable rather than something you take on trust.

## Reproducing the independent derivation

`scripts/recover.py` fits candidate laws against the corpus and prints this table, which is how
the identity was recovered here without API access:

| candidate | exact @ +/-0.011 | median err |
|---|---|---|
| **(p_top - 1/n)/(1 - 1/n)** | **75.4%** | **0.0050** |
| p_top | 35.6% | 0.0300 |
| p_top - p_second | 33.4% | 0.0500 |
| 2*p_top - 1 | 28.4% | 0.0849 |
| 1 - normalized entropy | 28.2% | 0.0466 |
| normalized Gini | 22.3% | 0.0733 |

These are all-in, unstratified numbers against the full 199-file corpus, so they reproduce
exactly. They are lower than the stratified figures because the full corpus mixes
reimplementations and hand-authored fixtures in with real output. `scripts/deep.py` stratifies by
model version and primitive; `scripts/score.py` examines L2; `scripts/live_confirm.cjs` confirms
both identities against the live API if you have a key.

Note that `2*p_top - 1` — the form most often quoted in the ecosystem — is only the n=2 special
case, and is correct on 26.5% of n>=3 samples.

## Recovering a law nobody wrote down

`scripts/recover.py` and `scripts/compat_matrix.py` both test a fixed list of six hand-written
candidate formulas. They can only ever find a law somebody already guessed.

`scripts/discover.py` searches instead. It builds primitive statistics of the input vector —
`v1 v2 vmin n logn sum sq one`, plus `invn`/`H` on a simplex or `expsum`/`expmean`/`mean` in log
space — and enumerates expressions over `+ - * /`, reporting any that reproduce the published
field. **No composite law is in the search space**, so both known laws have to be assembled from
primitives or they will not be found.

**This is brute-force symbolic regression, and symbolic regression is not ours.** It is a mature
field with far better tools — [PySR](https://github.com/MilesCranmer/PySR), gplearn, and learned-prior
methods like [deep symbolic regression](https://arxiv.org/abs/1912.04871) and
[NeSymReS](https://arxiv.org/abs/2106.06427), which beat genetic programming at *exact* expression
recovery. Anyone doing this seriously should reach for those first.

What is different here is narrow and worth stating plainly: the search runs over **artifacts the
ecosystem already published**, with no API access, no key, and no ability to query the vendor — so
the operator set stays tiny and dependency-free rather than general. The usual SR caveat that a
structurally wrong expression can hide inside a good numerical fit is handled by the exclusion
control below, not by fit quality.

```bash
python3 scripts/discover.py corpus --depth 2                          # Jev
python3 scripts/discover.py corpus-laya --depth 2                     # laya-mps
python3 scripts/discover.py corpus-laya --depth 2 --exclude-primitive H   # the control
bash test/discover-kat.sh                                             # all three, asserted
```

Both laws recover blind, neither supplied as a candidate:

| corpus | searched | recovered | rate | n |
|---|---|---|---|---|
| Jev | 129,503 expressions | `(v1-invn)/(sum-invn)` | 67.3% | 1,213 |
| laya-mps | 174,977 expressions | `one-(H/logn)` | 60.6% @1e-9 | 1,085 |

On a simplex `sum` is 1, so the Jev row is Yurin's law; on 2dp-rounded data the published sum is
marginally the better normaliser than assuming exactly 1.0.

The Jev result is a **rediscovery, not a discovery** — that law is Yurin's, established on the live
API and credited at the top of this file. It is here because recovering a known answer blind is how
you find out whether the search works at all.

**The control is the load-bearing test.** Remove the `H` primitive and laya's entropy law must
become unfindable: 2.5%, `NOT RECOVERED`. A search that reports a law no matter what you take away
from it is fitting noise, and would be worse than useless pointed at a vendor whose formula nobody
already knows.

Why an exact match is the formula rather than a fit: these are closed forms with **no free
parameters to tune**. An expression reproducing hundreds of independent samples is not a curve
fitted to data — it is the arithmetic that was run.

**The bar scales to the corpus, and it has to.** Jev publishes probabilities at 2dp, so a ±0.005
rounding on each input propagates; demanding 1e-9 there measures the publisher's formatting, not
the vendor's arithmetic, and made the *correct* law read as `NOT RECOVERED` until this was fixed.
laya-mps publishes full precision and does match at 1e-9. Override with `--tol`.

One hypothesis this refuted, recorded because it was wrong and is worth not repeating: *"rounding
is what blocks exact recovery on the Jev corpus."* It isn't — the 97 full-precision Jev rows
recover **worse** (4.1%) than the rounded ones (22.8%), because that subset is the reimplementation
stratum rather than cleaner data.

Neither corpus is redistributed. `test/discover-kat.sh` rebuilds both from `data/fetched.txt` and
`data/laya-fetched.txt` on first run.

## Limits

- Covers `Choice` and `Score`. `Noul` returns no confidence, so there is nothing to check.
- Clean `Score` samples are thin (n=15 vendor-channel + recorded).
- **No live Jev API call was made here.** Every number in this repository comes from published
  artifacts. Yurin's live-API measurement is the authority on the identity itself; this work is
  about the published corpus. Since 21 September, `console.typesafe.ai` has returned HTTP 500 on
  every auth path ([typesafe-ai/skills#10](https://github.com/typesafe-ai/skills/issues/10)), so
  obtaining a key to confirm independently is currently not possible.
- Tolerances follow publishing precision: probabilities are published at 2dp, so a +/-0.005
  rounding on `p_top` propagates to <=0.010 on confidence. `EXACT` is 0.011, `CONFORM` is 0.02.

## License

MIT.
