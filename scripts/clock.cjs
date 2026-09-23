#!/usr/bin/env node
'use strict';
// clock.cjs -- Phase 2 + 3: the conformance clock.
//
// Re-runs the ecosystem census, appends one row to an append-only series, and
// SEALS that row into the notary receipt chain. The series is the only asset
// here that cannot be backfilled: once it starts, whoever started it owns the
// record of what the ecosystem looked like on a given date.
//
//   node scripts/clock.cjs [--repos data/ecosystem-repos.txt] [--no-seal]
//
// Each row is a full recomputation, never a delta, so a stranger can re-derive
// any historical row from the manifest rather than trusting our copy of it.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (f, d) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : d);
const REPOS = opt('--repos', path.join(ROOT, 'data', 'ecosystem-repos.txt'));
const SERIES = opt('--series', path.join(ROOT, 'state', 'conformance-series.jsonl'));
const CENSUS = opt('--census', path.join(ROOT, 'state', 'census.jsonl'));
const SEAL = !argv.includes('--no-seal');
const NOTARY = process.env.JEV_NOTARY_URL || 'http://127.0.0.1:8466/claim-verdict';
const SUMMARY = opt('--summary', path.join(ROOT, 'data', 'census-summary.json'));
// Where a stranger can fetch the published summary. This is what makes the
// sealed claim RESOLVABLE rather than merely signed -- see notarize() below.
const PUBLISHED = process.env.JEV_SUMMARY_URL ||
  'https://raw.githubusercontent.com/stillmarcus24/jev-verify/main/data/census-summary.json';

// A smoke run must be structurally incapable of entering the production chain.
// Two smoke rows (12 repos / 2,682 answers) were sealed on 2026-09-23 under the
// same agent name as a real row and are indistinguishable to an outside reader.
// Floors are deliberately absolute, not ratios of whatever happened to be
// scanned -- a ratio passes trivially when the manifest itself is the stub.
const MIN_REPOS_IN_SCOPE = Number(process.env.JEV_CLOCK_MIN_REPOS || 900);
const MIN_SCAN_RATIO = 0.95;
const AGENT = argv.includes('--dryrun') ? 'jev-verify-clock-dryrun' : 'jev-verify-clock';

function notarize(claim, resolver) {
  const body = JSON.stringify({ agent: AGENT, claim, resolver });
  const u = new URL(NOTARY);
  return new Promise((resolve) => {
    const req = (u.protocol === 'https:' ? https : http).request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ error: b.slice(0, 200) }); } });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(body); req.end();
  });
}

function summarize(censusPath) {
  const latest = new Map();
  for (const line of fs.readFileSync(censusPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); latest.set(r.repo, r); } catch { /* partial */ }
  }
  const ok = [...latest.values()].filter((r) => r.status === 'ok');
  const wa = ok.filter((r) => (r.answers || 0) > 0);
  const sum = (k) => wa.reduce((s, r) => s + (r[k] || 0), 0);
  const answers = sum('answers'), conform = sum('conform');
  return {
    repos_in_scope: latest.size,
    repos_scanned: ok.length,
    repos_with_answers: wa.length,
    answers, conform, deviate: answers - conform,
    conform_pct: answers ? +(100 * conform / answers).toFixed(4) : null,
    repos_with_deviations: wa.filter((r) => r.deviate > 0).length,
    // per-repo conformance, so a later row can be diffed against this one
    // WITHOUT re-reading the whole census
    repos: Object.fromEntries(wa.map((r) => [r.repo, [r.conform, r.answers]])),
  };
}

(async () => {
  const startedAt = new Date().toISOString();

  // 1. Refuse to seal on a detector we have not just proven works. An untested
  //    detector sealed into an append-only chain is a permanent false record.
  const kat = spawnSync(process.execPath, [path.join(ROOT, 'test', 'known-answer.cjs')],
    { encoding: 'utf8' });
  if (kat.status !== 0) {
    console.error('clock: known-answer tests FAILED -- refusing to run or seal');
    console.error(kat.stdout.split('\n').slice(-6).join('\n'));
    process.exitCode = 2; return;
  }
  const katLine = (kat.stdout.match(/(\d+) passed, (\d+) failed/) || [])[0] || 'unknown';

  // 2. Recompute the census in full. --reuse-census seals an ALREADY-computed
  //    census rather than recomputing (the scope gate below still applies, so
  //    this cannot be used to sneak a stub into the chain).
  const cen = argv.includes('--reuse-census')
    ? { status: 0 }
    : spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'census.cjs'),
    REPOS, '--conc', '4', '--out', CENSUS], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  if (cen.status === 2) { console.error('clock: census failed'); process.exitCode = 2; return; }

  const s = summarize(CENSUS);
  const prev = fs.existsSync(SERIES)
    ? fs.readFileSync(SERIES, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).pop()
    : null;

  // 3. Diff against the previous row -- this is what the clock exists for.
  let moved = [];
  if (prev && prev.repos) {
    for (const [repo, [c, a]] of Object.entries(s.repos)) {
      const p = prev.repos[repo];
      if (!p) { moved.push({ repo, change: 'new', now: [c, a] }); continue; }
      if (p[0] !== c || p[1] !== a) moved.push({ repo, change: 'changed', was: p, now: [c, a] });
    }
    for (const repo of Object.keys(prev.repos)) {
      if (!s.repos[repo]) moved.push({ repo, change: 'gone', was: prev.repos[repo] });
    }
  }

  const row = {
    started_at: startedAt, completed_at: new Date().toISOString(),
    known_answer_tests: katLine,
    ...s,
    changed_since_previous: prev ? moved.length : null,
    changes: prev ? moved.slice(0, 200) : null,
    previous_receipt: prev ? prev.receipt || null : null,
  };

  // 3b. SCOPE GATE. A sealed row is permanent and carries no indication of how
  //     much of the ecosystem it actually covered. Refuse to seal a census that
  //     is too small to be the real one -- a partial scan sealed under the
  //     production agent name is a false historical record, not a partial one.
  const ratio = row.repos_in_scope ? row.repos_scanned / row.repos_in_scope : 0;
  const tooSmall = row.repos_in_scope < MIN_REPOS_IN_SCOPE || ratio < MIN_SCAN_RATIO;
  if (SEAL && tooSmall && AGENT === 'jev-verify-clock') {
    console.error(`clock: REFUSING TO SEAL -- scope gate failed. ` +
      `${row.repos_in_scope} repos in scope (floor ${MIN_REPOS_IN_SCOPE}), ` +
      `${row.repos_scanned} scanned (${(100 * ratio).toFixed(1)}%, floor ${100 * MIN_SCAN_RATIO}%). ` +
      `Re-run with --dryrun to seal this under the non-production agent name.`);
    row.seal_error = 'scope_gate_failed';
  }

  if (SEAL && !row.seal_error) {
    // Refresh the publishable summary so the resolver below has a real target.
    // NOT pushed from here: publication is an externally visible action and
    // stays a deliberate, approved step.
    fs.writeFileSync(SUMMARY, JSON.stringify({
      generated_utc: row.completed_at.slice(0, 10),
      repos_in_scope: row.repos_in_scope, repos_scanned: row.repos_scanned,
      repos_with_jev_answers: row.repos_with_answers,
      answers_checked: row.answers, conform: row.conform, deviate: row.deviate,
      conform_pct: row.conform_pct,
      method: 'L1 confidence=(p_top-1/n)/(1-1/n) [Yurin 2026], L2 score=SUM(level*p), L0 probabilities sum to 1',
      note: 'repo list built from the four public awesome-jev lists; see data/ecosystem-repos.txt',
    }, null, 1) + '\n');

    const claim = `Jev ecosystem conformance at ${row.completed_at}: ` +
      `${row.conform}/${row.answers} answers across ${row.repos_with_answers} repositories ` +
      `(${row.conform_pct}%), ${row.repos_scanned}/${row.repos_in_scope} repos scanned` +
      (prev ? `; ${moved.length} repositories changed since the previous sealed row` : '');
    // url_json is one of the notary's five BONDED resolvers. The previous
    // resolver type, "deterministic_recomputation", is not one of them, so
    // every seal came back verdict=ERROR -- signed and timestamped, but never
    // actually adjudicated. This settles against the published artifact.
    // Honest scope: it proves the sealed row matches what we published, not
    // that the ecosystem number is true. The manifest is what makes the
    // number independently re-derivable.
    const r = await notarize(claim, {
      type: 'url_json',
      url: PUBLISHED,
      path: 'answers_checked',
      expect: row.answers,
      recomputation: {
        manifest: path.relative(ROOT, REPOS),
        laws: ['L0', 'L1', 'L2'],
        known_answer_tests: katLine,
        previous_receipt: row.previous_receipt,
      },
    });
    if (r && r.claim_receipt) {
      row.receipt = r.claim_receipt.hash;
      row.verify = r.claim_receipt.verify;
    } else {
      row.seal_error = (r && (r.error || JSON.stringify(r).slice(0, 160))) || 'unknown';
    }
  }

  fs.mkdirSync(path.dirname(SERIES), { recursive: true });
  fs.appendFileSync(SERIES, JSON.stringify(row) + '\n');

  console.log(`\nclock: ${row.conform}/${row.answers} (${row.conform_pct}%) across ` +
    `${row.repos_with_answers} repos; KAT ${katLine}`);
  if (prev) console.log(`       ${moved.length} repositories changed since ${prev.completed_at}`);
  console.log(row.receipt ? `       sealed ${row.receipt}` : `       NOT sealed: ${row.seal_error || 'disabled'}`);
})().catch((e) => { console.error('clock: ' + e.message); process.exitCode = 2; });
