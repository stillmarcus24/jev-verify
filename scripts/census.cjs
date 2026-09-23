#!/usr/bin/env node
'use strict';
// census.cjs -- run the conformance check across the whole public Jev ecosystem.
//
// Input : a newline-delimited list of owner/repo (see scripts/ecosystem_repos.sh)
// Output: state/census.jsonl, one line per repo, appended incrementally so the
//         run is resumable and a crash never loses completed work.
//
//   node scripts/census.cjs repos.txt [--conc 8] [--out state/census.jsonl]
//
// Read-only. Fetches public files, opens nothing, sends nothing.

const fs = require('fs');
const path = require('path');
const https = require('https');
const L = require(path.join(__dirname, '..', 'lib', 'laws.cjs'));

const argv = process.argv.slice(2);
const LIST = argv.find((a) => !a.startsWith('--'));
const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? parseInt(argv[i + 1], 10) : dflt;
};
const str = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
};
const CONC = num('--conc', 8);
const OUT = str('--out', path.join(__dirname, '..', 'state', 'census.jsonl'));
const MAX_FILES = num('--max-files', 400);

if (!LIST) { console.error('usage: census.cjs <repos.txt> [--conc N] [--out FILE]'); process.exitCode = 2; return; }

let TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
if (!TOKEN) {
  // gh stores a token the shell never exports. Unauthenticated is 60 req/hr,
  // which silently throttles a census into uselessness -- 698 HTTP 429 and
  // 344 HTTP 403 on the first run, reported as "done".
  try { TOKEN = require('child_process').execSync('gh auth token', { encoding: 'utf8' }).trim(); }
  catch { /* leave empty; the run will warn below */ }
}
if (!TOKEN) console.error('census: WARNING -- no token, 60 req/hr, this run WILL be throttled');
const HDR = { 'user-agent': 'jev-verify-census', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };

function get(url, headers = HDR, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) {
        res.resume();
        return resolve(get(res.headers.location, headers, redirects + 1));
      }
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        if (res.statusCode === 200) return resolve(b);
        const err = Object.assign(new Error(`HTTP ${res.statusCode}`), {
          status: res.statusCode,
          retryAfter: Number(res.headers['retry-after']) || null,
          rateReset: Number(res.headers['x-ratelimit-reset']) || null,
          rateRemaining: Number(res.headers['x-ratelimit-remaining']),
        });
        reject(err);
      });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry on throttling. 429/403-with-zero-remaining are rate limits, not answers. */
async function getRetry(url, headers, tries = 5) {
  for (let a = 0; a < tries; a++) {
    try { return await get(url, headers); }
    catch (e) {
      const throttled = e.status === 429 || (e.status === 403 && e.rateRemaining === 0);
      if (!throttled || a === tries - 1) throw e;
      let waitMs = (e.retryAfter ? e.retryAfter * 1000 : 0);
      if (!waitMs && e.rateReset) waitMs = Math.max(0, e.rateReset * 1000 - Date.now()) + 1000;
      if (!waitMs) waitMs = Math.min(60000, 2000 * Math.pow(2, a));
      console.error(`  throttled (${e.status}), waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(Math.min(waitMs, 120000));
    }
  }
  throw new Error('unreachable');
}

async function scanRepo(repo) {
  const rec = { repo, scanned_at: new Date().toISOString(), status: 'ok',
                files_checked: 0, answers: 0, conform: 0, deviate: 0,
                fabrication_flags: 0,
                // EXACT per-flag totals, counted over every result -- not derived
                // from the capped `sample` array, which is a display convenience.
                // Conflating FRAC_COUPLED with PROBS_DONT_SUM under one
                // "fabrication" label nearly produced a false public accusation
                // against a 2,103-star replica whose probabilities legitimately
                // do not sum to 1.
                flag_counts: { FRAC_COUPLED: 0, PROBS_DONT_SUM: 0 },
                frac_examples: [], findings: [] };
  let meta;
  try {
    meta = JSON.parse(await getRetry(`https://api.github.com/repos/${repo}`, HDR));
  } catch (e) {
    rec.status = e.status === 404 ? 'not_found' : `meta_error_${e.status || 'net'}`;
    return rec;
  }
  if (meta.private) { rec.status = 'private'; return rec; }
  rec.stars = meta.stargazers_count;
  rec.default_branch = meta.default_branch;

  let tree;
  try {
    tree = JSON.parse(await getRetry(
      `https://api.github.com/repos/${repo}/git/trees/${meta.default_branch}?recursive=1`, HDR));
  } catch (e) {
    rec.status = `tree_error_${e.status || 'net'}`;
    return rec;
  }
  let files = (tree.tree || []).filter(
    (t) => t.type === 'blob' && t.path.endsWith('.json') && t.size > 0 && t.size < 2_000_000);
  if (files.length > MAX_FILES) { rec.truncated_files = files.length - MAX_FILES; files = files.slice(0, MAX_FILES); }

  for (const f of files) {
    let txt;
    try {
      txt = await get(`https://raw.githubusercontent.com/${repo}/${meta.default_branch}/${f.path}`, { 'user-agent': 'jev-verify-census' });
    } catch { continue; }
    if (!/jev|typesafe/i.test(txt)) continue;
    let doc;
    try { doc = JSON.parse(txt); } catch { continue; }
    const r = L.verifyDocument(doc);
    if (!r.total) continue;
    rec.files_checked++;
    rec.answers += r.total; rec.conform += r.conform;
    rec.deviate += r.deviate; rec.fabrication_flags += r.fabrication_flags;
    for (const res of r.results) {
      for (const fl of res.flags) {
        rec.flag_counts[fl] = (rec.flag_counts[fl] || 0) + 1;
        if (fl === 'FRAC_COUPLED' && rec.frac_examples.length < 25) {
          const l1 = res.checks.find((c) => c.law === 'L1');
          rec.frac_examples.push({ file: f.path, path: res.path,
            predicted: l1 ? l1.predicted : null, actual: l1 ? l1.actual : null });
        }
      }
    }
    if (r.deviate) {
      rec.findings.push({
        file: f.path, answers: r.total, deviate: r.deviate,
        fabrication_flags: r.fabrication_flags,
        sample: r.results.filter((x) => x.verdict === 'DEVIATE').slice(0, 3).map((x) => ({
          path: x.path, flags: x.flags,
          checks: x.checks.filter((c) => c.status === 'DEVIATE')
            .map((c) => ({ law: c.law, predicted: c.predicted, actual: c.actual, delta: c.delta })),
        })),
      });
    }
  }
  return rec;
}

(async () => {
  const repos = fs.readFileSync(LIST, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // Resume: skip repos already recorded.
  const done = new Set();
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        // Only terminal outcomes count as done. A throttled or networking
        // failure MUST be retried, or a bad run poisons every later one.
        if (['ok', 'not_found', 'private'].includes(r.status)) done.add(r.repo);
      } catch { /* partial line */ }
    }
  }
  const todo = repos.filter((r) => !done.has(r));
  console.error(`census: ${repos.length} repos, ${done.size} already done, ${todo.length} to scan, conc=${CONC}`);

  const fd = fs.openSync(OUT, 'a');
  let i = 0, completed = 0, withAnswers = 0, withDeviations = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < todo.length) {
      const repo = todo[i++];
      let rec;
      try { rec = await scanRepo(repo); }
      catch (e) { rec = { repo, scanned_at: new Date().toISOString(), status: 'error', error: String(e.message).slice(0, 120) }; }
      fs.writeSync(fd, JSON.stringify(rec) + '\n');
      completed++;
      if (rec.answers) withAnswers++;
      if (rec.deviate) withDeviations++;
      if (completed % 25 === 0) {
        console.error(`  ${completed}/${todo.length}  with-answers=${withAnswers}  with-deviations=${withDeviations}`);
      }
    }
  }));
  fs.closeSync(fd);
  console.error(`census done: ${completed} scanned, ${withAnswers} contained Jev answers, ${withDeviations} had deviations`);
})().catch((e) => { console.error('census: ' + e.message); process.exitCode = 2; });
