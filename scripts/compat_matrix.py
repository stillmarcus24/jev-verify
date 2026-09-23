#!/usr/bin/env python3
"""Recover each Jev-compatible implementation's OWN confidence function, and
measure whether a threshold ported from Jev still means the same thing.

The premise of a "drop-in replacement" is that `confidence` denotes the same
quantity. That is testable: the function is deterministic, so it is recoverable
from published outputs, and two recovered functions can be compared directly.

Usage:
  python3 scripts/compat_matrix.py <repos.txt> [--out state/compat.json]

Read-only. Fetches public files only.
"""
import json, math, os, re, subprocess, sys, urllib.request, random

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

LIST = next((a for a in sys.argv[1:] if not a.startswith("--")), None)
def opt(flag, dflt):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else dflt
OUT = opt("--out", os.path.join(ROOT, "state", "compat.json"))
MAX_FILES = int(opt("--max-files", "60"))
MIN_N = int(opt("--min-n", "30"))

try:
    TOKEN = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()
except Exception:
    TOKEN = ""

def api(url):
    req = urllib.request.Request(url, headers={
        "user-agent": "jev-compat",
        **({"authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))

def raw(url):
    req = urllib.request.Request(url, headers={"user-agent": "jev-compat"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")

# ---------------------------------------------------------------- candidates
def jev(p):
    n = len(p); return (max(p.values()) - 1.0/n) / (1 - 1.0/n)
def ptop(p):
    return max(p.values())
def margin(p):
    s = sorted(p.values(), reverse=True); return s[0] - s[1]
def neg_entropy(p):
    n = len(p); vs = [v for v in p.values() if v > 0]
    if n < 2: return None
    return 1 - (-sum(v*math.log(v) for v in vs)) / math.log(n)
def gini(p):
    n = len(p); return 1 - (1 - sum(v*v for v in p.values())) / (1 - 1.0/n)
def tv_uniform(p):
    n = len(p); return 0.5 * sum(abs(v - 1.0/n) for v in p.values())

CANDIDATES = {
    "jev:(p_top-1/n)/(1-1/n)": jev,
    "1-H/log(n)  [entropy]":    neg_entropy,
    "p_top":                    ptop,
    "p1-p2  [margin]":          margin,
    "normalized Gini":          gini,
    "TV distance to uniform":   tv_uniform,
}

def harvest(repo):
    """Return [(probabilities, confidence)] published by this repo."""
    try:
        meta = api(f"https://api.github.com/repos/{repo}")
        br = meta.get("default_branch", "main")
        stars = meta.get("stargazers_count", 0)
        tree = api(f"https://api.github.com/repos/{repo}/git/trees/{br}?recursive=1")
    except Exception as e:
        return None, 0, f"meta/tree error: {type(e).__name__}"
    files = [t["path"] for t in tree.get("tree", [])
             if t.get("type") == "blob" and t["path"].endswith(".json")
             and 0 < t.get("size", 0) < 2_000_000][:MAX_FILES]
    rows = []
    for path in files:
        try:
            txt = raw(f"https://raw.githubusercontent.com/{repo}/{br}/{path}")
        except Exception:
            continue
        if not re.search(r"jev|typesafe|laya|system", txt, re.I):
            continue
        try:
            doc = json.loads(txt)
        except Exception:
            continue
        stack = [doc]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                p = node.get("probabilities")
                c = node.get("confidence")
                if isinstance(p, dict) and len(p) > 1 and isinstance(c, (int, float)) \
                   and all(isinstance(v, (int, float)) for v in p.values()):
                    rows.append((p, float(c)))
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
    return rows, stars, None

def fit(rows):
    out = {}
    for name, fn in CANDIDATES.items():
        errs = []
        for p, c in rows:
            try:
                v = fn(p)
            except Exception:
                continue
            if v is None: continue
            errs.append(abs(v - c))
        if not errs: continue
        errs.sort()
        out[name] = {
            "n": len(errs),
            "exact_1e9": sum(1 for e in errs if e <= 1e-9) / len(errs),
            "within_0.02": sum(1 for e in errs if e <= 0.02) / len(errs),
            "median_err": errs[len(errs)//2],
            "mean_err": sum(errs)/len(errs),
        }
    return out

def reversal_rate(rows, fn_a, fn_b, trials=40000, seed=11):
    """How often do two confidence functions ORDER the same pair differently?"""
    P = [p for p, _ in rows if abs(sum(p.values()) - 1) < 1e-6 and len(p) > 1]
    if len(P) < 20: return None, 0
    rnd = random.Random(seed); pairs = flips = 0
    for _ in range(trials):
        a, b = rnd.sample(range(len(P)), 2)
        try:
            xa, xb, ya, yb = fn_a(P[a]), fn_a(P[b]), fn_b(P[a]), fn_b(P[b])
        except Exception:
            continue
        if None in (xa, xb, ya, yb): continue
        if abs(xa-xb) < 1e-9 or abs(ya-yb) < 1e-9: continue
        pairs += 1
        if (xa > xb) != (ya > yb): flips += 1
    return (flips/pairs if pairs else None), pairs

def main():
    repos = [l.strip() for l in open(LIST) if l.strip()]
    results = []
    for i, repo in enumerate(repos, 1):
        rows, stars, err = harvest(repo)
        if err or not rows or len(rows) < MIN_N:
            print(f"[{i}/{len(repos)}] {repo}: {err or f'{len(rows) if rows else 0} answers (need {MIN_N})'}", file=sys.stderr)
            continue
        f = fit(rows)
        best = max(f.items(), key=lambda kv: (kv[1]["exact_1e9"], kv[1]["within_0.02"]))
        rev, pairs = reversal_rate(rows, CANDIDATES[best[0]], jev)
        rec = {"repo": repo, "stars": stars, "answers": len(rows),
               "best_law": best[0], "best": best[1],
               "jev_law_fit": f.get("jev:(p_top-1/n)/(1-1/n)"),
               "order_reversal_vs_jev": rev, "pairs": pairs, "all_fits": f}
        results.append(rec)
        print(f"[{i}/{len(repos)}] {repo}: n={len(rows)} best={best[0]} "
              f"exact={best[1]['exact_1e9']:.1%} reversal_vs_jev="
              f"{'n/a' if rev is None else f'{rev:.2%}'}", file=sys.stderr)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(results, open(OUT, "w"), indent=2)
    print(f"\nwrote {len(results)} implementations -> {OUT}", file=sys.stderr)

if __name__ == "__main__":
    if not LIST:
        print("usage: compat_matrix.py <repos.txt>", file=sys.stderr); sys.exit(2)
    main()
