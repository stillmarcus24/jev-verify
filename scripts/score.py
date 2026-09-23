#!/usr/bin/env python3
"""Recover the SCORE statistics: is score the expected level, and is its
confidence a dispersion measure rather than a p_top measure?"""
import json, glob, math
from collections import Counter

S = []

def walk(n):
    if isinstance(n, dict):
        pr = n.get("probabilities")
        if isinstance(pr, dict) and pr and "score" in n and isinstance(n["score"], (int, float)):
            S.append({"probs": pr, "score": n["score"],
                      "conf": n.get("confidence")})
        for v in n.values():
            walk(v)
    elif isinstance(n, list):
        for v in n:
            walk(v)

for f in sorted(glob.glob("/tmp/jevharvest/f_*.json")):
    try:
        walk(json.load(open(f)))
    except Exception:
        pass

print(f"Score answers with a probabilities distribution: {len(S)}")

def levels(p):
    """Return (index, prob) pairs with numeric level keys where possible."""
    out = []
    for k, v in p.items():
        try:
            out.append((float(k), v))
        except ValueError:
            return None
    return sorted(out)

numeric = [r for r in S if levels(r["probs"]) is not None]
print(f"  of which levels are numeric keys: {len(numeric)}")

# --- H1: score == expected value sum(i*p_i) ---
print("\n=== H1: score == Σ level·p(level)  (expected value) ===")
ok = 0
shown = 0
for r in numeric:
    lv = levels(r["probs"])
    ev = sum(i * p for i, p in lv)
    e = abs(ev - r["score"])
    if e <= 0.02:
        ok += 1
    elif shown < 6:
        print(f"   MISS score={r['score']:.3f} EV={ev:.3f} d={e:.3f} probs={r['probs']}")
        shown += 1
if numeric:
    print(f"  {ok}/{len(numeric)} = {100.0*ok/len(numeric):.1f}% within 0.02")

# --- H2: confidence over ordered levels = a dispersion statistic ---
withc = [r for r in numeric if isinstance(r["conf"], (int, float))]
print(f"\n=== H2: Score confidence — dispersion candidates (n={len(withc)}) ===")

def ptop_law(p):
    n = len(p)
    return (max(p.values()) - 1.0/n) / (1 - 1.0/n)

def std_norm(p):
    lv = levels(p)
    ev = sum(i*q for i, q in lv)
    var = sum(q*(i-ev)**2 for i, q in lv)
    sd = math.sqrt(var)
    span = lv[-1][0] - lv[0][0]
    if span <= 0:
        return None
    return 1 - 2*sd/span

def std_norm_max(p):
    """1 - sd / sd_max, where sd_max is the two-point extreme distribution."""
    lv = levels(p)
    ev = sum(i*q for i, q in lv)
    sd = math.sqrt(sum(q*(i-ev)**2 for i, q in lv))
    span = lv[-1][0] - lv[0][0]
    if span <= 0:
        return None
    return 1 - sd/(span/2.0)

def mean_abs_dev(p):
    lv = levels(p)
    ev = sum(i*q for i, q in lv)
    mad = sum(q*abs(i-ev) for i, q in lv)
    span = lv[-1][0] - lv[0][0]
    if span <= 0:
        return None
    return 1 - 2*mad/span

def ent(p):
    n = len(p)
    vs = [v for v in p.values() if v > 0]
    H = -sum(v*math.log(v) for v in vs)
    return 1 - H/math.log(n)

def adjacent_mass(p):
    """mass on the two levels bracketing the score"""
    lv = levels(p)
    ev = sum(i*q for i, q in lv)
    lo, hi = math.floor(ev), math.ceil(ev)
    d = dict(lv)
    return d.get(float(lo), 0) + (d.get(float(hi), 0) if hi != lo else 0)

CANDS = {
    "(p_top-1/n)/(1-1/n)  [Choice law]": ptop_law,
    "1 - 2*sd/span":                     std_norm,
    "1 - sd/(span/2)":                   std_norm_max,
    "1 - 2*MAD/span":                    mean_abs_dev,
    "1 - normalised entropy":            ent,
    "mass on bracketing levels":         adjacent_mass,
}
print(f"{'candidate':38s} {'@0.02':>7s} {'mean|err|':>10s}")
print("-" * 58)
for name, fn in CANDS.items():
    errs, hits = [], 0
    for r in withc:
        v = fn(r["probs"])
        if v is None:
            continue
        e = abs(v - r["conf"])
        errs.append(e)
        if e <= 0.02:
            hits += 1
    if errs:
        print(f"{name:38s} {100.0*hits/len(errs):6.1f}% {sum(errs)/len(errs):10.4f}")

print("\nraw Score samples (for eyeballing the structure):")
for r in withc[:8]:
    lv = levels(r["probs"])
    ev = sum(i*q for i, q in lv)
    print(f"  score={r['score']:.3f} EV={ev:.3f} conf={r['conf']} probs={r['probs']}")
