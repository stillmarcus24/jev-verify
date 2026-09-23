#!/usr/bin/env node
'use strict';
// live_confirm.cjs -- the one thing the public artifacts cannot settle.
//
// Every real Jev output found in public repos is published at 2 decimal places,
// so L1 and L2 are confirmed only to rounding tolerance (~0.011). This makes a
// small number of live calls and tests the identities against FULL-PRECISION
// output, which either pins them to machine precision or falsifies them.
//
// Deliberately designed so p_top is NOT 1.0 -- a one-hot distribution satisfies
// almost any candidate law and proves nothing. The states below are genuinely
// ambiguous, and arity is varied (n=2,3,5 plus a Score) because the whole point
// of L1 is the 1/n term, which a single arity cannot test.
//
//   TYPESAFE_API_KEY=sk-... node scripts/live_confirm.cjs
//
// Cost: 5 requests, a few hundred input tokens each, at $0.042/M input with
// output unmetered. Well under one cent.

const https = require('https');
const path = require('path');
const fs = require('fs');
const L = require(path.join(__dirname, '..', 'lib', 'laws.cjs'));

// Load the key from env, or from secrets/typesafe.env if present.
let KEY = process.env.TYPESAFE_API_KEY;
if (!KEY || KEY === 'PASTE_KEY_HERE') {
  const p = '/home/marcus/secrets/typesafe.env';
  if (fs.existsSync(p)) {
    const m = fs.readFileSync(p, 'utf8').match(/^TYPESAFE_API_KEY=(.+)$/m);
    if (m) KEY = m[1].trim();
  }
}
if (!KEY || KEY === 'PASTE_KEY_HERE') {
  console.error('live_confirm: no API key. Put it in /home/marcus/secrets/typesafe.env');
  console.error('              (get one at https://console.typesafe.ai/keys)');
  process.exitCode = 2;
  return;
}

const AMBIGUOUS_TICKET =
  'The export runs for a while and then stops. It might be the new billing ' +
  'plan we moved to last week, or it might just be that the report is large. ' +
  'I am not sure whether this is urgent. It has happened twice.';

const CASES = [
  { label: 'choice n=2', state: AMBIGUOUS_TICKET, questions: { route: {
      type: 'choice', instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments, invoicing, plans', technical: 'Bugs, timeouts, performance' } } } },
  { label: 'choice n=3', state: AMBIGUOUS_TICKET, questions: { route: {
      type: 'choice', instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments, invoicing, plans', technical: 'Bugs, timeouts, performance',
                  success: 'Onboarding, training, account guidance' } } } },
  { label: 'choice n=5', state: AMBIGUOUS_TICKET, questions: { route: {
      type: 'choice', instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments, invoicing, plans', technical: 'Bugs, timeouts, performance',
                  success: 'Onboarding and training', security: 'Access, auth, data exposure',
                  other: 'Anything else' } } } },
  { label: 'score', state: AMBIGUOUS_TICKET, questions: { severity: {
      type: 'score', instructions: 'How severe is the issue being reported?',
      criteria: { 0: 'Cosmetic, no impact', 1: 'Degraded but has a workaround',
                  2: 'Blocking, no workaround', 3: 'Outage affecting many users' } } } },
  { label: 'noul (expect NO confidence field)', state: AMBIGUOUS_TICKET, questions: { urgent: {
      type: 'noul', instructions: 'Does this message express urgency?',
      criteria: { true: 'Explicitly time-sensitive', false: 'No urgency expressed' } } } },
];

function call(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.typesafe.ai', path: '/v1/systemone', method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json',
                 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, body: b.slice(0, 400) }); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

(async () => {
  const raw = [];
  let l1 = { n: 0, ok: 0, worst: 0 }, l2 = { n: 0, ok: 0, worst: 0 };
  let noulHadConfidence = null;

  for (const c of CASES) {
    const r = await call({ state: c.state, questions: c.questions });
    raw.push({ label: c.label, status: r.status, response: r.body });
    console.log(`\n===== ${c.label}   HTTP ${r.status}`);
    if (r.status !== 200) { console.log('   ' + JSON.stringify(r.body).slice(0, 300)); continue; }

    const answers = (r.body && r.body.answers) || {};
    for (const [name, a] of Object.entries(answers)) {
      console.log(`   ${name}: ${JSON.stringify(a)}`);

      if (c.label.startsWith('noul')) {
        noulHadConfidence = Object.prototype.hasOwnProperty.call(a, 'confidence');
        continue;
      }
      if (!a.probabilities) continue;

      if (typeof a.confidence === 'number') {
        const pred = L.predictConfidence(a.probabilities);
        const d = Math.abs(pred - a.confidence);
        l1.n++; if (d < 1e-6) l1.ok++; l1.worst = Math.max(l1.worst, d);
        console.log(`      L1 predicted ${pred.toFixed(15)}`);
        console.log(`         published ${Number(a.confidence).toFixed(15)}`);
        console.log(`         |err| ${d.toExponential(3)}  ${d < 1e-6 ? 'EXACT' : d < 0.011 ? 'within rounding' : 'DEVIATES'}`);
      }
      if (typeof a.score === 'number') {
        const pred = L.predictScore(a.probabilities);
        if (pred !== null) {
          const d = Math.abs(pred - a.score);
          l2.n++; if (d < 1e-6) l2.ok++; l2.worst = Math.max(l2.worst, d);
          console.log(`      L2 predicted ${pred.toFixed(15)}  published ${Number(a.score).toFixed(15)}  |err| ${d.toExponential(3)}`);
        }
      }
    }
  }

  const out = path.join(__dirname, '..', 'data', 'live-confirmation.json');
  fs.writeFileSync(out, JSON.stringify({ captured_utc: new Date().toISOString(), raw }, null, 2));

  console.log('\n================ VERDICT ================');
  console.log(`L1 confidence : ${l1.ok}/${l1.n} exact to 1e-6   worst |err| ${l1.worst.toExponential(3)}`);
  console.log(`L2 score      : ${l2.ok}/${l2.n} exact to 1e-6   worst |err| ${l2.worst.toExponential(3)}`);
  if (noulHadConfidence !== null) {
    console.log(`Noul confidence field present: ${noulHadConfidence}  (docs say it should be false)`);
  }
  console.log(`raw responses saved -> ${out}`);
})().catch((e) => { console.error('live_confirm: ' + e.message); process.exitCode = 2; });
