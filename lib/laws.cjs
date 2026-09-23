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

/**
 * Walk any JSON value and yield every Jev-shaped answer: an object carrying a
 * `probabilities` map. Choice and Score both do; Noul does not (TypeSafe's own
 * docs: "Noul answers don't carry one").
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

  const sum = probSum(a.probabilities);
  const sumOk = Math.abs(sum - 1.0) <= 0.011;
  checks.push({
    law: 'L0', name: 'probabilities sum to 1',
    predicted: 1.0, actual: sum, delta: Math.abs(sum - 1.0),
    status: sumOk ? 'EXACT' : 'DEVIATE',
  });

  const flags = [];
  if (fracCoupled(a)) flags.push('FRAC_COUPLED');
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
  const total = results.length;
  const deviate = results.filter((r) => r.verdict === 'DEVIATE').length;
  return {
    total, conform: total - deviate, deviate,
    fabrication_flags: results.filter((r) => r.flags.length).length,
    results,
  };
}

module.exports = {
  EXACT, CONFORM,
  predictConfidence, predictScore, probSum,
  findAnswers, fracCoupled, checkAnswer, verifyDocument,
};
