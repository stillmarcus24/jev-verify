#!/usr/bin/env python3
"""Round 2: Noul, Score, quantisation, clamping, and cross-version law drift."""
import json, glob, os, math
from collections import defaultdict, Counter

choice, noul, score, versions = [], [], [], Counter()
verlink = []   # (version, kind, payload)

def ver_of(d):
    for k in ("model", "resolvedModel", "requestedModel"):
        v = d.get(k)
        if isinstance(v, str) and "jev" in v.lower():
            return v
    return None

def walk(node, src, ver):
    if isinstance(node, dict):
        v2 = ver_of(node) or ver
        if v2:
            versions[v2] += 1
        pr = node.get("probabilities")
        if isinstance(pr, dict) and pr and isinstance(node.get("confidence"), (int, float)):
            choice.append({"src": src, "probs": pr, "conf": node["confidence"], "ver": v2})
        # Noul: a probability with no probabilities-dict sibling
        if "probability" in node and isinstance(node["probability"], (int, float)) and not pr:
            noul.append({"src": src, "p": node["probability"],
                         "conf": node.get("confidence"), "ver": v2})
        if "score" in node and isinstance(node["score"], (int, float)) and not pr:
            score.append({"src": src, "s": node["score"],
                          "conf": node.get("confidence"), "ver": v2})
        for k, v in node.items():
            walk(v, src, v2)
    elif isinstance(node, list):
        for v in node:
            walk(v, src, ver)

srcmap = {}
for line in open("fetched.txt"):
    i, r, p = line.strip().split("|", 2)
    srcmap[i] = f"{r}:{p}"
for f in sorted(glob.glob("f_*.json")):
    i = os.path.basename(f)[2:-5]
    try:
        d = json.load(open(f))
    except Exception:
        continue
    walk(d, srcmap.get(i, f), None)

law = lambda p: (max(p.values()) - 1.0/len(p)) / (1 - 1.0/len(p)) if len(p) > 1 else None

print("=" * 66)
print("MODEL VERSIONS PRESENT IN PUBLIC ARTIFACTS")
print("=" * 66)
for v, c in versions.most_common(12):
    print(f"  {v:28s} {c:5d} mentions")

print("\n" + "=" * 66)
print("DOES THE CONFIDENCE LAW HOLD PER VERSION?  (silent-change detector)")
print("=" * 66)
byv = defaultdict(lambda: [0, 0, []])
for r in choice:
    v = r["ver"] or "UNVERSIONED"
    l = law(r["probs"])
    if l is None:
        continue
    byv[v][1] += 1
    e = abs(l - r["conf"])
    byv[v][2].append(e)
    if e <= 0.011:
        byv[v][0] += 1
for v in sorted(byv, key=lambda k: -byv[k][1]):
    ok, tot, errs = byv[v]
    errs.sort()
    print(f"  {v:28s} {ok:4d}/{tot:4d} = {100.0*ok/tot:5.1f}%   median|err|={errs[len(errs)//2]:.4f}")

print("\n" + "=" * 66)
print("NOUL  (binary probability)")
print("=" * 66)
print(f"  samples: {len(noul)}")
withc = [r for r in noul if isinstance(r["conf"], (int, float))]
print(f"  carrying a separate confidence field: {len(withc)}")
if withc:
    hits = sum(1 for r in withc if abs((2*max(r['p'], 1-r['p'])-1) - r["conf"]) <= 0.011)
    print(f"  conf == 2*max(p,1-p)-1 : {hits}/{len(withc)} = {100.0*hits/len(withc):.1f}%")
    for r in withc[:6]:
        print(f"    p={r['p']:.3f} stated_conf={r['conf']} law={2*max(r['p'],1-r['p'])-1:.4f}")

print("\n" + "=" * 66)
print("SCORE")
print("=" * 66)
print(f"  samples: {len(score)}")
if score:
    vals = [r["s"] for r in score]
    print(f"  range: {min(vals)} .. {max(vals)}")
    sc = sum(1 for r in score if isinstance(r["conf"], (int, float)))
    print(f"  carrying a confidence field: {sc}")

print("\n" + "=" * 66)
print("QUANTISATION — what grid do published probabilities live on?")
print("=" * 66)
dec = Counter()
for r in choice:
    for v in r["probs"].values():
        s = f"{v!r}"
        d = len(s.split(".")[1]) if "." in s else 0
        dec[min(d, 6)] += 1
for k in sorted(dec):
    print(f"  {k} dp: {dec[k]:5d}")

print("\n" + "=" * 66)
print("CLAMPING — what happens when p_top < 1/n (law would go negative)?")
print("=" * 66)
neg = [r for r in choice if law(r["probs"]) is not None and law(r["probs"]) < 0]
print(f"  samples where the law predicts a negative confidence: {len(neg)}")
for r in neg[:8]:
    print(f"    n={len(r['probs'])} p_top={max(r['probs'].values()):.3f} "
          f"law={law(r['probs']):.4f} stated={r['conf']}  src={r['src'].split(':')[0]}")
