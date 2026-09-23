#!/usr/bin/env python3
"""Zero-access internal-consistency audit of published Jev outputs.

Two checks, both mechanical, neither needing the Jev API:
  C1  probabilities over a Choice must sum to 1.0
  C2  Choice confidence must equal 2*p_top - 1   (the documented identity)

A failure means one of: the identity is not what the ecosystem believes,
or the published output was never produced by Jev.
"""
import json, os, glob, sys
import os as _os
_HERE = _os.path.dirname(_os.path.abspath(__file__))
_ROOT = _os.path.dirname(_HERE)
CORPUS = _os.environ.get("JEV_CORPUS", _os.path.join(_ROOT, "corpus"))
MANIFEST = _os.environ.get("JEV_MANIFEST", _os.path.join(_ROOT, "data", "fetched.txt"))


TOL_SUM  = 0.011   # allow 2-dp rounding across up to ~4 buckets
TOL_CONF = 0.011

rows = []

def walk(node, path, src):
    """Find every dict that looks like a Choice answer: has probabilities + confidence."""
    if isinstance(node, dict):
        probs = node.get("probabilities")
        if isinstance(probs, dict) and probs and all(isinstance(v, (int, float)) for v in probs.values()):
            rows.append({
                "src": src,
                "path": path,
                "probs": probs,
                "confidence": node.get("confidence"),
                "choice": node.get("choice"),
            })
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

print(f"Choice-shaped answers found: {len(rows)}\n")

c1p = c1f = c2p = c2f = c2na = 0
fails = []
for r in rows:
    s = sum(r["probs"].values())
    ok1 = abs(s - 1.0) <= TOL_SUM
    c1p, c1f = (c1p + 1, c1f) if ok1 else (c1p, c1f + 1)

    conf = r["confidence"]
    if not isinstance(conf, (int, float)):
        c2na += 1
        ok2 = None
    else:
        ptop = max(r["probs"].values())
        pred = 2 * ptop - 1
        ok2 = abs(conf - pred) <= TOL_CONF
        c2p, c2f = (c2p + 1, c2f) if ok2 else (c2p, c2f + 1)
        if not ok2:
            fails.append((r, ptop, pred, conf))
    if not ok1:
        fails.append((r, None, None, conf))

print(f"C1  probabilities sum to 1.0 : {c1p} pass / {c1f} fail")
print(f"C2  confidence == 2*p_top-1  : {c2p} pass / {c2f} fail  ({c2na} had no confidence field)")

if c2p + c2f:
    print(f"\nC2 pass rate: {100.0*c2p/(c2p+c2f):.1f}%")

print("\n--- every C2 mismatch ---")
seen = set()
for r, ptop, pred, conf in fails:
    if ptop is None:
        continue
    key = (r["src"], r["path"])
    if key in seen:
        continue
    seen.add(key)
    print(f"{r['src']}\n   at {r['path']}  p_top={ptop}  predicted_conf={pred:.4f}  stated_conf={conf}  delta={abs(conf-pred):.4f}")
