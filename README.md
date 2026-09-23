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

## Ecosystem census (2026-09-23)

Every public repository on the four `awesome-jev` lists, scanned with this checker.

| | |
|---|---|
| repos in scope | 1,061 |
| scanned | 1,054 (99.3%) |
| containing Jev answers | 88 |
| **answers checked** | **279,842** |
| conform | 270,872 (**96.79%**) |
| deviate | 8,970 (3.21%) |

Run it yourself: `node scripts/census.cjs data/ecosystem-repos.txt`. Summary in
`data/census-summary.json`.

Two cautions this census taught, both of which nearly produced false accusations:

- `PROBS_DONT_SUM` is **not** forgery. A replica emitting independent per-option probabilities
  legitimately sums past 1. The largest hit was a 2,106-star project doing exactly that.
- `FRAC_COUPLED` alone is **not** evidence. `score` and `confidence` are different functions of
  the same distribution, so at 2dp they collide ~1 time in 100 by chance. The flag now requires
  an L1 violation as well; applying that cut took the flagged-repo count from 18 to 11, and only
  4 clear a significance bar against their own chance rate.

Separately, one implementation was found to use a different confidence function entirely:
`afshinm/laya-mps` computes `1 - H/log(n)` (normalized entropy), recovered to 1e-9 with median
error exactly 0.0 on 1,085 answers. It disagrees with Jev's ordering on 9.96% of 199,497 real
pairs, so a threshold ported between the two does not merely shift — it reorders which decisions
pass. Of 58 "Jev-compatible" projects checked, 51 publish no answers that would let anyone verify
this either way.

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
node test/known-answer.cjs                       # 27 known-answer tests, must print "0 failed"
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
