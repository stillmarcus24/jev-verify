#!/usr/bin/env python3
"""Recover Jev's undocumented Choice-confidence function from public outputs alone.

868 real (probabilities -> confidence) pairs were harvested from public repos.
The confidence function is deterministic, so it is RECOVERABLE: fit candidate
closed forms and see which one the data actually obeys. No API access needed.

This is the 'hash as oracle' method applied to a confidence function.
"""
import json, os, glob, math
from collections import defaultdict
import os as _os
_HERE = _os.path.dirname(_os.path.abspath(__file__))
_ROOT = _os.path.dirname(_HERE)
CORPUS = _os.environ.get("JEV_CORPUS", _os.path.join(_ROOT, "corpus"))
MANIFEST = _os.environ.get("JEV_MANIFEST", _os.path.join(_ROOT, "data", MANIFEST))


rows = []

def walk(node, path, src):
    if isinstance(node, dict):
        probs = node.get("probabilities")
        if isinstance(probs, dict) and probs and all(isinstance(v, (int, float)) for v in probs.values()):
            if isinstance(node.get("confidence"), (int, float)):
                rows.append({"src": src, "path": path, "probs": probs,
                             "conf": node["confidence"]})
        for k, v in node.items():
            walk(v, f"{path}.{k}", src)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{path}[{i}]", src)

srcmap = {}
for line in open(MANIFEST):
    idx, repo, p = line.strip().split("|", 2)
    srcmap[idx] = f"{repo}:{p}"

for f in sorted(glob.glob(_os.path.join(CORPUS,_os.path.join(CORPUS,"f_*.json")))):
    idx = os.path.basename(f)[2:-5]
    try:
        d = json.load(open(f))
    except Exception:
        continue
    walk(d, "$", srcmap.get(idx, f))

print(f"samples with both probabilities and confidence: {len(rows)}")

def margin(p):      # p_top - p_second
    s = sorted(p.values(), reverse=True)
    return s[0] - (s[1] if len(s) > 1 else 0.0)

def binary(p):      # 2*p_top - 1
    return 2 * max(p.values()) - 1

def norm_nopt(p):   # (p_top - 1/n) / (1 - 1/n)
    n = len(p)
    if n < 2:
        return None
    return (max(p.values()) - 1.0 / n) / (1.0 - 1.0 / n)

def ptop(p):
    return max(p.values())

def one_minus_ent(p):  # 1 - normalised Shannon entropy
    n = len(p)
    if n < 2:
        return None
    vs = [v for v in p.values() if v > 0]
    H = -sum(v * math.log(v) for v in vs)
    return 1 - H / math.log(n)

def gini(p):        # 1 - sum(p^2) complement, normalised
    n = len(p)
    if n < 2:
        return None
    g = 1 - sum(v * v for v in p.values())
    return 1 - g / (1 - 1.0 / n)

CANDS = {
    "2*p_top-1  (binary)":            binary,
    "(p_top-1/n)/(1-1/n)  (n-opt)":   norm_nopt,
    "p_top - p_second  (margin)":     margin,
    "p_top":                          ptop,
    "1 - normalised entropy":         one_minus_ent,
    "normalised Gini":                gini,
}

TOL = 0.011
print(f"\n{'candidate':34s} {'exact@0.011':>12s} {'mean|err|':>10s} {'median|err|':>12s}")
print("-" * 72)
best = None
for name, fn in CANDS.items():
    errs, hits, n = [], 0, 0
    for r in rows:
        v = fn(r["probs"])
        if v is None:
            continue
        e = abs(v - r["conf"])
        errs.append(e); n += 1
        if e <= TOL:
            hits += 1
    if not n:
        continue
    errs.sort()
    mean = sum(errs) / n
    med = errs[n // 2]
    rate = 100.0 * hits / n
    print(f"{name:34s} {rate:11.1f}% {mean:10.4f} {med:12.4f}")
    if best is None or rate > best[1]:
        best = (name, rate, fn)

print(f"\nBEST FIT: {best[0]}  ({best[1]:.1f}% exact)")

# Per-arity breakdown for the winner — does it hold across option counts?
print("\nwinner accuracy by number of options:")
by_n = defaultdict(lambda: [0, 0])
for r in rows:
    v = best[2](r["probs"])
    if v is None:
        continue
    b = by_n[len(r["probs"])]
    b[1] += 1
    if abs(v - r["conf"]) <= TOL:
        b[0] += 1
for k in sorted(by_n):
    h, t = by_n[k]
    print(f"  n={k:2d}  {h:4d}/{t:4d}  {100.0*h/t:5.1f}%")

# Residual outliers under the winner — candidates for fabricated output
print("\nsources whose outputs DISOBEY the best-fit law (>0.05 abs error):")
bad = defaultdict(lambda: [0, 0])
for r in rows:
    v = best[2](r["probs"])
    if v is None:
        continue
    src = r["src"].split(":")[0]
    bad[src][1] += 1
    if abs(v - r["conf"]) > 0.05:
        bad[src][0] += 1
for src in sorted(bad, key=lambda s: -bad[s][0] / max(bad[s][1], 1)):
    b, t = bad[src]
    if b:
        print(f"  {100.0*b/t:5.1f}%  {b:4d}/{t:4d}  {src}")
