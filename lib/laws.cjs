'use strict';
// laws.cjs -- the recovered Jev identities, and the detectors built on them.
//
// Both identities were recovered 2026-09-23 from 843 published Jev answers
// across 13 public repos, with ZERO API access. TypeSafe documents neither:
// their /confidence page says confidence "is a statistic computed from the
// probability distribution" and defers the definition to a cookbook that was
// never published.
//
//   L1  confidence = (p_top - 1/n) / (1 - 1/n)      [Choice and Score]
//   L2  score      = SUM(level * p(level))          [Score only]
//
// Tolerances are set by the observed publishing precision, not by taste:
// probabilities are published at 2dp, so a +/-0.005 rounding on p_top
// propagates to at most 0.005/(1-1/n) <= 0.010 on confidence for n>=2.

const EXACT = 0.011;   // within 2dp publishing rounding
const CONFORM = 0.02;  // still explainable by looser rounding
// anything above CONFORM is a real deviation

/** Recovered law L1. Returns null when inapplicable (n < 2). */
function predictConfidence(probs) {
  const n = Object.keys(probs).length;
  if (n < 2) return null;
  const pTop = Math.max(...Object.values(probs));
  return (pTop - 1 / n) / (1 - 1 / n);
}

/** Recovered law L2 -- expected value of the level index. Numeric keys only. */
function predictScore(probs) {
  const lv = [];
  for (const [k, v] of Object.entries(probs)) {
    const i = Number(k);
    if (!Number.isFinite(i)) return null;
    lv.push([i, v]);
  }
  if (!lv.length) return null;
  return lv.reduce((s, [i, p]) => s + i * p, 0);
}

function probSum(probs) {
  return Object.values(probs).reduce((a, b) => a + b, 0);
}

// Sibling field names that carry a multi-hot ground truth (one independent
// boolean per option). Their presence, with keys overlapping the probability
// keys, is definitive evidence the `probabilities` map is a MULTI-LABEL output
// (independent per-option probabilities) and NOT a categorical distribution --
// so it must NOT be held to "sums to 1". Caught 2026-09-23 on TianyuCodings/
// NanoJev, whose maze `probabilities` {north,east,south,west} legitimately sum
// to ~2.8 against a `truth` map of four independent booleans. Applying L0 to it
// manufactured a false "fabrication" accusation against a 2,100-star repo.
const TRUTH_SIBLINGS = ['truth', 'labels', 'label', 'ground_truth', 'gold', 'expected', 'targets'];

/**
 * Classify the task structure of a probabilities-bearing node from INDEPENDENT
 * structural evidence -- never from the sum, which would make fabrication
 * detection circular. Returns 'categorical' | 'multilabel' | 'batch'.
 * Only 'categorical' answers are in scope for the L0/L1/L2 identities.
 */
function classifyStructure(node, probs) {
  const pKeys = new Set(Object.keys(probs));
  // MULTI-LABEL: a sibling multi-hot boolean map keyed like the distribution.
  for (const s of TRUTH_SIBLINGS) {
    const t = node[s];
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      const tv = Object.values(t);
      const allBool = tv.length && tv.every((v) => typeof v === 'boolean');
      const overlap = Object.keys(t).filter((k) => pKeys.has(k)).length;
      if (allBool && overlap >= Math.min(2, pKeys.size)) return 'multilabel';
    }
  }
  // BATCH: an aggregate container holding many answers' worth of numbers, not
  // one distribution. `batch_size`>1, or an `answered_by` array alongside
  // per-run cost/latency aggregates. Caught on allebee/jevgrep ("batch 20",
  // probabilities summing to 63.55 across 20 flattened questions).
  if (typeof node.batch_size === 'number' && node.batch_size > 1) return 'batch';
  if (Array.isArray(node.answered_by) &&
      ('requests' in node || 'seconds' in node || 'cost_usd' in node || 'p50_latency' in node)) return 'batch';
  return 'categorical';
}

/**
 * Walk any JSON value and yield every Jev-shaped answer: an object carrying a
 * `probabilities` map. Choice and Score both do; Noul does not (TypeSafe's own
 * docs: "Noul answers don't carry one"). Each answer is tagged with its task
 * STRUCTURE so the caller can apply the identities only where they are defined.
 */
function findAnswers(root) {
  const out = [];
  (function walk(node, path) {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const probs = node.probabilities;
    if (probs && typeof probs === 'object' && !Array.isArray(probs) &&
        Object.keys(probs).length &&
        Object.values(probs).every((v) => typeof v === 'number')) {
      out.push({
        path,
        probabilities: probs,
        confidence: typeof node.confidence === 'number' ? node.confidence : null,
        score: typeof node.score === 'number' ? node.score : null,
        choice: typeof node.choice === 'string' ? node.choice : null,
        kind: 'score' in node ? 'score' : ('choice' in node ? 'choice' : 'unlabelled'),
        structure: classifyStructure(node, probs),
      });
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  })(root, '$');
  return out;
}

/**
 * The fabrication fingerprint: on generated fixtures, `confidence` equals the
 * FRACTIONAL PART of `score` exactly (2.58 -> 0.58, 2.38 -> 0.38). A
 * calibration statistic cannot legitimately track a decimal remainder. Observed
 * only in ax-llm/ax and 0xPlaygrounds/rig's rounded.json; zero occurrences in
 * cloudflare, vercel, openagents, wuyoscar or JevTape.
 */
function fracCoupled(a) {
  if (a.score === null || a.confidence === null) return false;
  const frac = a.score - Math.floor(a.score);
  // frac==0 with conf==1 is the legitimate degenerate case (a one-hot
  // distribution really does give confidence 1) -- never flag it.
  if (Math.abs(frac) < 1e-9) return false;
  return Math.abs(frac - a.confidence) <= 0.0011;
}

/** Full verdict for one answer. */
function checkAnswer(a) {
  // The L0/L1/L2 identities are DEFINED only on a categorical distribution over
  // mutually-exclusive outcomes. A multi-label or batched output is out of scope,
  // not a deviation -- reporting it as one is a false accusation, not a finding.
  if (a.structure && a.structure !== 'categorical') {
    return { path: a.path, kind: a.kind, structure: a.structure, checks: [], flags: [], verdict: 'SKIP' };
  }

  const checks = [];

  if (a.confidence !== null) {
    const pred = predictConfidence(a.probabilities);
    if (pred !== null) {
      const d = Math.abs(pred - a.confidence);
      checks.push({
        law: 'L1', name: 'confidence == (p_top-1/n)/(1-1/n)',
        predicted: pred, actual: a.confidence, delta: d,
        status: d <= EXACT ? 'EXACT' : d <= CONFORM ? 'CONFORM' : 'DEVIATE',
      });
    }
  }

  if (a.score !== null) {
    const pred = predictScore(a.probabilities);
    if (pred !== null) {
      const d = Math.abs(pred - a.score);
      checks.push({
        law: 'L2', name: 'score == SUM(level*p)',
        predicted: pred, actual: a.score, delta: d,
        status: d <= EXACT ? 'EXACT' : d <= CONFORM ? 'CONFORM' : 'DEVIATE',
      });
    }
  }

  // L0 tolerance scales with n: each probability is published at 2dp, so up to
  // n independent +/-0.005 roundings accumulate in the sum. A flat 0.011 wrongly
  // flagged honest rounding (e.g. {0.33,0.33,0.32}=0.98) as fabrication.
  const sum = probSum(a.probabilities);
  const nOpts = Object.keys(a.probabilities).length;
  const l0Tol = Math.max(0.011, nOpts * 0.005);
  const sumOk = Math.abs(sum - 1.0) <= l0Tol;
  checks.push({
    law: 'L0', name: 'probabilities sum to 1',
    predicted: 1.0, actual: sum, delta: Math.abs(sum - 1.0), tolerance: l0Tol,
    status: sumOk ? 'EXACT' : 'DEVIATE',
  });

  const flags = [];
  // FRAC_COUPLED alone is NOT evidence. score and confidence are different
  // functions of the same distribution, so at 2dp precision frac(score) equals
  // a legitimate confidence about 1 time in 100 by pure chance -- roughly 70
  // expected hits across a 7,000-answer corpus. Only flag the coupling when L1
  // is ALSO violated: a record that satisfies the confidence identity was
  // produced by something computing that identity, whatever its score does.
  const l1 = checks.find((c) => c.law === 'L1');
  const l1Violated = !!l1 && l1.status === 'DEVIATE';
  if (fracCoupled(a) && l1Violated) flags.push('FRAC_COUPLED');
  if (!sumOk) flags.push('PROBS_DONT_SUM');

  const deviations = checks.filter((c) => c.status === 'DEVIATE');
  return {
    path: a.path, kind: a.kind, checks, flags,
    verdict: flags.length || deviations.length ? 'DEVIATE' : 'CONFORM',
  };
}

function verifyDocument(root) {
  const answers = findAnswers(root);
  const results = answers.map(checkAnswer);
  // Only in-scope (categorical) answers count toward the conformance rate.
  // Out-of-scope structures are reported separately, never as deviations.
  const scored = results.filter((r) => r.verdict !== 'SKIP');
  const skipped = results.filter((r) => r.verdict === 'SKIP');
  const total = scored.length;
  const deviate = scored.filter((r) => r.verdict === 'DEVIATE').length;
  const skipped_by_structure = {};
  for (const s of skipped) skipped_by_structure[s.structure] = (skipped_by_structure[s.structure] || 0) + 1;
  return {
    total, conform: total - deviate, deviate,
    fabrication_flags: scored.filter((r) => r.flags.length).length,
    skipped: skipped.length, skipped_by_structure,
    results,
  };
}

module.exports = {
  EXACT, CONFORM,
  predictConfidence, predictScore, probSum,
  findAnswers, fracCoupled, checkAnswer, verifyDocument,
};
