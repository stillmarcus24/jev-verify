'use strict';
// registry.cjs -- Phase 4: the machine is not Jev-specific, the LAWS are.
//
// A provider entry declares the deterministic identities its outputs must obey
// and how to find an answer inside an arbitrary JSON document. Adding a
// provider is data, not code.
//
// An identity qualifies only if it is RECOMPUTABLE from the response itself,
// with no access to the vendor, no key, and no model. That is the whole basis
// on which a verdict here can be checked by a stranger.

const jev = require('./laws.cjs');

/** @type {Record<string, object>} */
const PROVIDERS = {
  // ---------------------------------------------------------------- jev
  jev: {
    id: 'jev',
    label: 'TypeSafe Jev (System One)',
    // Credit: the confidence identity is Yurin (bernoulli.app, 2026-09-18),
    // independently replicated by primeline.cc, xxlya/evaljev and
    // jkudish/jev-mcp#29. Not ours.
    laws: [
      { id: 'L0', name: 'probabilities sum to 1' },
      { id: 'L1', name: 'confidence == (p_top-1/n)/(1-1/n)', credit: 'Yurin 2026' },
      { id: 'L2', name: 'score == SUM(level*p)' },
    ],
    flags: ['FRAC_COUPLED', 'PROBS_DONT_SUM'],
    findAnswers: jev.findAnswers,
    checkAnswer: jev.checkAnswer,
    verifyDocument: jev.verifyDocument,
    // A file is only considered if it plausibly contains this provider's output.
    relevance: /jev|typesafe/i,
  },

  // ------------------------------------------------------------ laya-mps
  // Recovered 2026-09-23 from published artifacts: confidence is normalized
  // entropy, NOT Jev's normalized top-probability. 658/1085 exact at 1e-9,
  // median error 0.0. It disagrees with Jev's ORDERING on 9.96% of real pairs,
  // so a threshold ported between them reorders which decisions pass.
  'laya-mps': {
    id: 'laya-mps',
    label: 'Laya (afshinm/laya-mps)',
    laws: [
      { id: 'L0', name: 'probabilities sum to 1' },
      { id: 'E1', name: 'confidence == 1 - H/log(n)', credit: 'StillOS 2026-09-23' },
    ],
    flags: ['PROBS_DONT_SUM'],
    relevance: /laya|jev|system/i,
    findAnswers: jev.findAnswers,
    checkAnswer(a) {
      const checks = [];
      const p = a.probabilities;
      const n = Object.keys(p).length;
      if (a.confidence !== null && n > 1) {
        const vs = Object.values(p).filter((v) => v > 0);
        const H = -vs.reduce((s, v) => s + v * Math.log(v), 0);
        const pred = 1 - H / Math.log(n);
        const d = Math.abs(pred - a.confidence);
        checks.push({
          law: 'E1', name: 'confidence == 1 - H/log(n)',
          predicted: pred, actual: a.confidence, delta: d,
          status: d <= 1e-6 ? 'EXACT' : d <= 0.02 ? 'CONFORM' : 'DEVIATE',
        });
      }
      const sum = jev.probSum(p);
      const sumOk = Math.abs(sum - 1.0) <= 0.011;
      checks.push({
        law: 'L0', name: 'probabilities sum to 1',
        predicted: 1.0, actual: sum, delta: Math.abs(sum - 1.0),
        status: sumOk ? 'EXACT' : 'DEVIATE',
      });
      const flags = sumOk ? [] : ['PROBS_DONT_SUM'];
      const dev = checks.filter((c) => c.status === 'DEVIATE');
      return { path: a.path, kind: a.kind, checks, flags,
               verdict: flags.length || dev.length ? 'DEVIATE' : 'CONFORM' };
    },
    verifyDocument(root) {
      const answers = this.findAnswers(root);
      const results = answers.map((a) => this.checkAnswer(a));
      const deviate = results.filter((r) => r.verdict === 'DEVIATE').length;
      return { total: results.length, conform: results.length - deviate, deviate,
               fabrication_flags: results.filter((r) => r.flags.length).length, results };
    },
  },
};

function get(id) {
  const p = PROVIDERS[id];
  if (!p) {
    throw new Error(`unknown provider "${id}". known: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return p;
}

function list() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id, label: p.label, laws: p.laws.map((l) => l.id),
  }));
}

module.exports = { PROVIDERS, get, list };
