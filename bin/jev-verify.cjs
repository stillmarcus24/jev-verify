#!/usr/bin/env node
'use strict';
// jev-verify -- check any published Jev output against the recovered identities.
//
//   jev-verify <file.json|dir> [...]     verify local JSON
//   jev-verify --repo owner/name         verify every JSON in a GitHub repo
//   jev-verify --json                    machine-readable output
//   jev-verify --notarize                request a signed receipt per run
//
// Exit 0 = every answer conforms. Exit 1 = at least one deviation.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const L = require(path.join(__dirname, '..', 'lib', 'laws.cjs'));

const argv = process.argv.slice(2);
const OPT = {
  json: argv.includes('--json'),
  notarize: argv.includes('--notarize'),
  quiet: argv.includes('--quiet'),
};
// Flags that consume the following argument. Their VALUES must not be mistaken
// for file targets -- that bug made `--max-files 300` try to stat a file "300".
const VALUE_FLAGS = new Set(['--repo', '--max-files']);
const valueIdx = new Set();
argv.forEach((a, i) => { if (VALUE_FLAGS.has(a)) valueIdx.add(i + 1); });

const repoIdx = argv.indexOf('--repo');
const REPO = repoIdx >= 0 ? argv[repoIdx + 1] : null;
const TARGETS = argv.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i));

const NOTARY = process.env.JEV_NOTARY_URL || 'http://127.0.0.1:8466/claim-verdict';

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'user-agent': 'jev-verify', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, headers));
      }
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve(b) : reject(new Error(`HTTP ${res.statusCode} ${url}`))));
    }).on('error', reject);
  });
}

function walkFiles(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) {
      if (e === 'node_modules' || e === '.git') continue;
      walkFiles(path.join(p, e), out);
    }
  } else if (p.endsWith('.json')) out.push(p);
  return out;
}

async function listRepoJson(repo) {
  const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const hdr = tok ? { authorization: `Bearer ${tok}` } : {};
  const meta = JSON.parse(await get(`https://api.github.com/repos/${repo}`, hdr));
  const branch = meta.default_branch || 'main';
  const tree = JSON.parse(await get(
    `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, hdr));
  return (tree.tree || [])
    .filter((t) => t.type === 'blob' && t.path.endsWith('.json') && t.size < 2_000_000)
    .map((t) => ({ path: t.path, raw: `https://raw.githubusercontent.com/${repo}/${branch}/${t.path}` }));
}

async function notarize(summary) {
  const body = JSON.stringify({
    agent: 'jev-verify',
    claim: `${summary.conform}/${summary.total} published Jev answers conform to the recovered identities L1 (confidence=(p_top-1/n)/(1-1/n)) and L2 (score=SUM(level*p)); ${summary.fabrication_flags} carry a fabrication fingerprint`,
    resolver: { type: 'deterministic_recomputation', laws: ['L1', 'L2', 'L0'], tolerance: L.CONFORM },
  });
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

(async () => {
  const docs = [];
  if (REPO) {
    let files = await listRepoJson(REPO);
    const maxIdx = argv.indexOf('--max-files');
    const MAX = maxIdx >= 0 ? parseInt(argv[maxIdx + 1], 10) : 500;
    const found = files.length;
    if (found > MAX) {
      // Never cap silently: a truncated scan reads as "covered everything".
      console.error(`jev-verify: ${REPO} has ${found} json files; scanning the first ${MAX}. ` +
                    `${found - MAX} NOT checked -- raise with --max-files N.`);
      files = files.slice(0, MAX);
    } else if (!OPT.quiet && !OPT.json) {
      console.error(`scanning ${found} json files in ${REPO} ...`);
    }
    // Serial fetch is unusably slow on large repos; bound concurrency instead.
    const CONC = 8;
    let cursor = 0, scanned = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (cursor < files.length) {
        const f = files[cursor++];
        let txt;
        try { txt = await get(f.raw); } catch { continue; }
        if (!/jev|typesafe/i.test(txt)) continue;   // only Jev-referencing files
        let d; try { d = JSON.parse(txt); } catch { continue; }
        docs.push({ name: `${REPO}:${f.path}`, data: d });
        if (++scanned % 25 === 0 && !OPT.json && !OPT.quiet) console.error(`  ...${scanned} matched`);
      }
    }));
  }
  for (const t of TARGETS) {
    for (const f of walkFiles(t)) {
      let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      docs.push({ name: f, data: d });
    }
  }

  if (!docs.length) {
    console.error('jev-verify: nothing to check. Pass a file/dir or --repo owner/name.');
    process.exit(2);
  }

  const agg = { total: 0, conform: 0, deviate: 0, fabrication_flags: 0, files: [] };
  for (const d of docs) {
    const r = L.verifyDocument(d.data);
    if (!r.total) continue;
    agg.total += r.total; agg.conform += r.conform;
    agg.deviate += r.deviate; agg.fabrication_flags += r.fabrication_flags;
    agg.files.push({ file: d.name, ...r });
  }

  if (OPT.json) {
    console.log(JSON.stringify(agg, null, 2));
  } else {
    console.log(`\njev-verify -- ${agg.total} Jev answers across ${agg.files.length} files\n`);
    for (const f of agg.files) {
      if (!f.deviate) continue;
      console.log(`DEVIATE  ${f.file}  (${f.deviate}/${f.total})`);
      for (const r of f.results.filter((x) => x.verdict === 'DEVIATE').slice(0, 6)) {
        const bad = r.checks.filter((c) => c.status === 'DEVIATE');
        for (const c of bad) {
          console.log(`   ${r.path}  ${c.law} ${c.name}`);
          console.log(`      predicted ${c.predicted.toFixed(4)}  published ${c.actual}  delta ${c.delta.toFixed(4)}`);
        }
        if (r.flags.length) console.log(`      FLAGS: ${r.flags.join(', ')}`);
      }
    }
    const pct = agg.total ? (100 * agg.conform / agg.total).toFixed(1) : '0.0';
    console.log(`\n  conform             ${agg.conform}/${agg.total}  (${pct}%)`);
    console.log(`  deviate             ${agg.deviate}`);
    console.log(`  fabrication flags   ${agg.fabrication_flags}`);
  }

  if (OPT.notarize) {
    const r = await notarize(agg);
    const h = r && r.claim_receipt ? r.claim_receipt : null;
    if (h) console.log(`\n  receipt  ${h.hash}\n  verify   ${h.verify}`);
    else console.log(`\n  notarize failed: ${JSON.stringify(r).slice(0, 160)}`);
  }

  // NOT process.exit(): it tears down stdout mid-write and silently truncates
  // piped output. Setting exitCode lets node drain the stream and exit cleanly.
  process.exitCode = agg.deviate ? 1 : 0;
})().catch((e) => { console.error('jev-verify: ' + e.message); process.exitCode = 2; });
