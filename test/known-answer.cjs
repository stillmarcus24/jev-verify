'use strict';
// known-answer.cjs -- an untested detector is a silent no-op. This box has
// shipped that bug before (the fast-crypto stop-loss monitor ran at
// MODULE_NOT_FOUND for a week). Every record below is a VERBATIM published
// artifact, not an invented example.
//
// Run: node test/known-answer.cjs   (exit 0 = all pass)

const path = require('path');
const L = require(path.join(__dirname, '..', 'lib', 'laws.cjs'));

let pass = 0, fail = 0;
const fails = [];

function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL ${name}${detail ? '  -- ' + detail : ''}`); }
}

// ---------------------------------------------------------------- MUST PASS
// Authoritative: cloudflare/cloudflare-docs catalog-models/typesafe-jev.json
// and vercel/ai. These are the vendor-channel examples; the laws must hold.
const AUTHORITATIVE = [
  { src: 'cloudflare', probabilities: { billing: 0.87, sales: 0, technical: 0.13 }, confidence: 0.8, choice: 'billing' },
  { src: 'cloudflare', probabilities: { '0': 0, '1': 0.96, '2': 0.04 }, confidence: 0.94, score: 1.04 },
  { src: 'cloudflare', probabilities: { technical: 0, billing: 0, account: 1, other: 0 }, confidence: 1, choice: 'account' },
  { src: 'cloudflare', probabilities: { '0': 0, '1': 0.16, '2': 0.84 }, confidence: 0.77, score: 1.84 },
  { src: 'vercel/ai', probabilities: { technical: 0, other: 0, billing: 1 }, confidence: 1, choice: 'billing' },
  { src: 'vercel/ai', probabilities: { '0': 0.13, '1': 0.76, '2': 0.11 }, confidence: 0.64, score: 0.97 },
];

console.log('KAT 1 -- authoritative vendor-channel outputs must CONFORM');
for (const rec of AUTHORITATIVE) {
  const r = L.checkAnswer(L.findAnswers(rec)[0]);
  t(`${rec.src} ${rec.score !== undefined ? 'score ' + rec.score : 'choice ' + rec.choice} conforms`,
    r.verdict === 'CONFORM',
    JSON.stringify(r.checks.map((c) => `${c.law}:${c.status}:${c.delta.toFixed(4)}`)));
}

// ------------------------------------------------------------- MUST DEVIATE
// Verbatim records from ax-llm/ax and 0xPlaygrounds/rig's rounded.json.
// A detector that does not fire on these is useless.
console.log('\nKAT 2 -- published outputs that violate the laws must DEVIATE');
const VIOLATORS = [
  { src: 'ax-llm/ax', why: 'probabilities sum to 0.30',
    rec: { probabilities: { billing: 0.2, support: 0.1 }, confidence: 0.7, choice: 'support' },
    expectFlag: 'PROBS_DONT_SUM' },
  { src: 'ax-llm/ax', why: 'n=2 p_top=0.8 -> law 0.60, stated 0.70',
    rec: { probabilities: { billing: 0.2, support: 0.8 }, confidence: 0.7, choice: 'support' } },
  { src: 'ax-llm/ax', why: 'uniform 0.33 -> score claims 1.5, EV is 0.99',
    rec: { probabilities: { '0': 0.33, '1': 0.33, '2': 0.33 }, confidence: 0.5, score: 1.5 } },
  { src: 'rig rounded.json', why: 'conf == frac(score): 2.58 -> 0.58',
    rec: { probabilities: { '0': 0.01, '1': 0.01, '2': 0.37, '3': 0.61 }, confidence: 0.58, score: 2.58 },
    expectFlag: 'FRAC_COUPLED' },
  { src: 'rig rounded.json', why: 'conf == frac(score): 2.38 -> 0.38',
    rec: { probabilities: { '0': 0.02, '1': 0.19, '2': 0.18, '3': 0.61 }, confidence: 0.38, score: 2.38 },
    expectFlag: 'FRAC_COUPLED' },
];
for (const v of VIOLATORS) {
  const r = L.checkAnswer(L.findAnswers(v.rec)[0]);
  t(`${v.src} deviates (${v.why})`, r.verdict === 'DEVIATE',
    JSON.stringify(r.checks.map((c) => `${c.law}:${c.status}`)));
  if (v.expectFlag) {
    t(`  ${v.src} raises ${v.expectFlag}`, r.flags.includes(v.expectFlag), `flags=${r.flags}`);
  }
}

// ------------------------------------------------- the degenerate-case trap
// A one-hot distribution legitimately gives score 0.0 and confidence 1.0.
// frac(0.0)==0 and conf==1, so a naive frac test does NOT fire -- but a
// sloppier one comparing frac to (1-conf) would. Guard against a false accusation.
console.log('\nKAT 3 -- legitimate degenerate cases must NOT be flagged as fabricated');
const DEGENERATE = [
  { why: 'one-hot, score 0.0 conf 1.0', rec: { probabilities: { '0': 1, '1': 0, '2': 0, '3': 0 }, confidence: 1, score: 0 } },
  { why: 'one-hot, score 2.0 conf 1.0', rec: { probabilities: { '0': 0, '1': 0, '2': 1, '3': 0 }, confidence: 1, score: 2 } },
];
for (const d of DEGENERATE) {
  const a = L.findAnswers(d.rec)[0];
  t(`not frac-coupled (${d.why})`, L.fracCoupled(a) === false);
  t(`conforms (${d.why})`, L.checkAnswer(a).verdict === 'CONFORM');
}

// ------------------------------------------- the coincidence false positive
// score and confidence are different functions of the same distribution, so at
// 2dp frac(score) matches a legitimate confidence ~1 time in 100 by chance.
// Found live in kavehmz/typesafe-playground: L1 predicted 0.7600 and the
// published confidence WAS 0.76 -- a perfect identity match that the naive
// frac test flagged as forgery. 18 repos were about to be accused on this.
console.log('\nKAT 3b -- frac coincidence with a VALID confidence must NOT be flagged');
{
  // n=5, p_top=0.808 -> L1 = (0.808-0.2)/0.8 = 0.76 exactly; score frac is also .76
  const rec = { probabilities: { '0': 0.048, '1': 0.048, '2': 0.048, '3': 0.048, '4': 0.808 },
                confidence: 0.76, score: 3.76 };
  const a = L.findAnswers(rec)[0];
  const r = L.checkAnswer(a);
  const l1 = r.checks.find((c) => c.law === 'L1');
  t('L1 is satisfied on the coincidence record', l1.status !== 'DEVIATE', `delta=${l1.delta.toFixed(4)}`);
  t('raw fracCoupled() still sees the coupling', L.fracCoupled(a) === true);
  t('but FRAC_COUPLED is NOT raised (L1 holds)', !r.flags.includes('FRAC_COUPLED'), `flags=${r.flags}`);
}

// --------------------------------------------------------- law unit checks
console.log('\nKAT 4 -- the laws themselves');
t('L1 n=2 reduces to 2*p_top-1',
  Math.abs(L.predictConfidence({ a: 0.8, b: 0.2 }) - 0.6) < 1e-9);
t('L1 n=3 p_top=0.96 -> 0.94',
  Math.abs(L.predictConfidence({ a: 0.96, b: 0.02, c: 0.02 }) - 0.94) < 1e-9);
t('L1 uniform -> 0 confidence',
  Math.abs(L.predictConfidence({ a: 0.25, b: 0.25, c: 0.25, d: 0.25 }) - 0) < 1e-9);
t('L1 inapplicable when n<2', L.predictConfidence({ a: 1 }) === null);
t('L2 expected value 1*0.96+2*0.04 = 1.04',
  Math.abs(L.predictScore({ '0': 0, '1': 0.96, '2': 0.04 }) - 1.04) < 1e-9);
t('L2 null on non-numeric level keys', L.predictScore({ billing: 0.9, other: 0.1 }) === null);

// ------------------------------------------------------------ walker check
console.log('\nKAT 5 -- the walker finds answers at depth, and ignores Noul');
const nested = { response: { answers: {
  route: { choice: 'billing', probabilities: { billing: 0.87, sales: 0, technical: 0.13 }, confidence: 0.8 },
  urgent: { probability: 0.91 },                       // Noul: no probabilities map
  severity: { score: 1.04, probabilities: { '0': 0, '1': 0.96, '2': 0.04 }, confidence: 0.94 },
} } };
const found = L.findAnswers(nested);
t('finds exactly 2 answers (Noul excluded)', found.length === 2, `found ${found.length}`);
t('classifies choice and score', found.map((f) => f.kind).sort().join(',') === 'choice,score');
t('document verdict is CONFORM', L.verifyDocument(nested).deviate === 0);

// ------------------------------------------------- task-structure gating
// Verbatim shapes that the flat "probabilities sum to 1" law misread as
// fabrication on 2026-09-23, each nearly a public false accusation.
console.log('\nKAT 6 -- non-categorical structures must be SKIPPED, not accused');
{
  // NanoJev: multi-label maze. `probabilities` are independent per-direction
  // safety probs, keyed like a multi-hot `truth`. They legitimately sum to ~2.8.
  const nanojev = { id: 'maze:test:0', planner_action: 'west',
    truth: { north: false, east: false, south: false, west: true },
    probabilities: { north: 0.712, east: 0.697, south: 0.667, west: 0.695 } };
  const a = L.findAnswers(nanojev)[0];
  t('NanoJev multi-label is classified multilabel', a.structure === 'multilabel', `structure=${a.structure}`);
  t('NanoJev multi-label is SKIPPED (not DEVIATE)', L.checkAnswer(a).verdict === 'SKIP');
  t('NanoJev not counted in conformance denominator', L.verifyDocument(nanojev).total === 0);

  // allebee/jevgrep: a batch of 20 questions flattened; container carries
  // batch_size + aggregate cost/latency. `probabilities` here is not one dist.
  const batch = { system: 'Jev (batch 20)', batch_size: 20, answered_by: ['typesafe/jev-1.13-20260917'],
    requests: 10, seconds: 4.43, cost_usd: 0.0008,
    probabilities: { '1': 0.01, '2': 0.02, '3': 0.9, '4': 0.9, '5': 0.9 } };
  const b = L.findAnswers(batch)[0];
  t('batch container is classified batch', b.structure === 'batch', `structure=${b.structure}`);
  t('batch container is SKIPPED (not DEVIATE)', L.checkAnswer(b).verdict === 'SKIP');

  // A genuine categorical distribution that fails to sum to 1 MUST still be
  // caught -- the gate is structural, not the sum, so fabrication detection is
  // NOT weakened. (ax-llm/ax: {billing:0.2,support:0.1} with a choice, no truth.)
  const realFab = { choice: 'support', confidence: 0.7, probabilities: { billing: 0.2, support: 0.1 } };
  const c = L.findAnswers(realFab)[0];
  t('real categorical fabrication still classified categorical', c.structure === 'categorical');
  t('real categorical fabrication still DEVIATES', L.checkAnswer(c).verdict === 'DEVIATE');
  t('real categorical fabrication still raises PROBS_DONT_SUM', L.checkAnswer(c).flags.includes('PROBS_DONT_SUM'));

  // Honest 2dp rounding of a near-uniform 3-way dist sums to 0.98 -- must CONFORM
  // now that L0 tolerance scales with n (3*0.005=0.015 >= 0.02? no -> still, test the
  // clearly-legitimate {0.34,0.33,0.33}=1.00 and a 4-way {0.25,0.25,0.25,0.24}=0.99).
  const round4 = { choice: 'a', confidence: 0, probabilities: { a: 0.25, b: 0.25, c: 0.25, d: 0.24 } };
  const d = L.checkAnswer(L.findAnswers(round4)[0]);
  const l0 = d.checks.find((x) => x.law === 'L0');
  t('4-way 2dp rounding (sum 0.99) is within scaled L0 tolerance', l0.status === 'EXACT', `delta=${l0.delta.toFixed(3)} tol=${l0.tolerance}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
process.exit(0);
