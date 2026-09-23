#!/usr/bin/env node
'use strict';
// GitHub Action entrypoint. Runs the checker and emits ::error annotations so a
// deviation lands inline on the PR diff rather than buried in a log.
const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

const inp = (n, d) => process.env[`INPUT_${n.toUpperCase().replace(/-/g, '_')}`] || d;
const TARGET = inp('path', '.');
const PROVIDER = inp('provider', 'jev');
const FAIL = inp('fail-on-deviation', 'true') !== 'false';
const NOTARIZE = inp('notarize', 'false') === 'true';

const args = ['--json', '--quiet', '--provider', PROVIDER, TARGET];
if (NOTARIZE) args.push('--notarize');
const bin = path.join(__dirname, '..', 'bin', 'jev-verify.cjs');
const res = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (res.status === 2 || !res.stdout) {
  console.log(`::notice title=jev-verify::no ${PROVIDER} answers found in ${TARGET} -- nothing to check`);
  process.exitCode = 0;
  return;
}
let agg;
try { agg = JSON.parse(res.stdout); }
catch { console.log(`::error title=jev-verify::could not parse checker output`); process.exitCode = 1; return; }

for (const f of agg.files) {
  if (!f.deviate) continue;
  const rel = f.file.replace(/^\.\//, '');
  for (const r of f.results.filter((x) => x.verdict === 'DEVIATE').slice(0, 20)) {
    const bad = r.checks.filter((c) => c.status === 'DEVIATE');
    const why = bad.map((c) => `${c.law}: predicted ${c.predicted.toFixed(4)}, published ${c.actual} (delta ${c.delta.toFixed(4)})`).join('; ')
      || r.flags.join(', ');
    console.log(`::error file=${rel},title=jev-verify ${r.path}::${why}`);
  }
}

const pct = agg.total ? (100 * agg.conform / agg.total).toFixed(2) : '0.00';
const summary = [
  `### jev-verify (${PROVIDER})`, '',
  '| metric | value |', '|---|---|',
  `| answers checked | ${agg.total} |`,
  `| conform | ${agg.conform} (${pct}%) |`,
  `| deviate | ${agg.deviate} |`,
  `| flags | ${agg.fabrication_flags} |`, '',
  'A deviation means the output does not obey the identities the provider\'s real outputs obey.',
  'Innocent explanations exist (deliberate rounding, an older model version, a reimplementation)',
  'and this check reports arithmetic, not intent.', '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
console.log(summary);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `answers=${agg.total}\nconform=${agg.conform}\ndeviate=${agg.deviate}\n`);
}
process.exitCode = (agg.deviate && FAIL) ? 1 : 0;
