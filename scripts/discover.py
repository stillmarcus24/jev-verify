#!/usr/bin/env python3
"""Recover a vendor's UNDOCUMENTED derived-field formula from published output.

compat_matrix.py tests six hand-written candidate laws. It can only ever find a
law somebody already guessed. This searches instead: it builds expressions from
primitive statistics of the probability vector and reports any that reproduce
the published field EXACTLY.

Why an exact match is the formula and not a fit: these are closed forms over a
handful of primitives with no free parameters to tune. An expression matching
across hundreds of independent samples is not a curve fitted to data -- it is
the arithmetic the vendor ran. A near-miss is worth nothing here, which is why
the bar is exactness and not R-squared.

The bar SCALES TO THE CORPUS, and that matters: Jev publishes probabilities at
2dp, so +/-0.005 on each input propagates and 1e-9 would measure the
publisher's formatting rather than the vendor's arithmetic. laya-mps publishes
full precision and does match at 1e-9. Override with --tol.

  python3 scripts/discover.py <corpus.json|dir> [--field confidence]
                              [--exclude-primitive H] [--depth 2] [--min-n 30]

--exclude-primitive is the falsification control: remove the primitive a known
law depends on and the search MUST fail to find it. A search that "discovers"
something no matter what you take away is fitting noise.

Read-only. No network, no keys.
"""
import json, math, os, sys, itertools
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

def opt(flag, dflt):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else dflt

TARGET   = next((a for a in sys.argv[1:] if not a.startswith("--")), None)
FIELD    = opt("--field", "confidence")
DEPTH    = int(opt("--depth", "2"))
MIN_N    = int(opt("--min-n", "30"))
EXACT    = float(opt("--tol", "1e-9"))
TOPK     = int(opt("--top", "8"))
EXCLUDE  = {a for i, a in enumerate(sys.argv) if i and sys.argv[i-1] == "--exclude-primitive"}

# ------------------------------------------------------------------ harvesting
def harvest(path, field):
    """Collect (probability vector, published field value) from any JSON shape."""
    rows = []
    files = []
    if os.path.isdir(path):
        for dp, _, fns in os.walk(path):
            if "node_modules" in dp or "/.git" in dp:
                continue
            files += [os.path.join(dp, f) for f in fns if f.endswith(".json")]
    else:
        files = [path]
    for f in files:
        try:
            doc = json.load(open(f, encoding="utf-8", errors="replace"))
        except Exception:
            continue
        stack = [doc]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                p, c = node.get("probabilities"), node.get(field)
                if (isinstance(p, dict) and len(p) > 1 and isinstance(c, (int, float))
                        and not isinstance(c, bool)
                        and all(isinstance(v, (int, float)) for v in p.values())):
                    rows.append((list(p.values()), float(c)))
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
    return rows

# ----------------------------------------------------------------- primitives
# Deliberately PRIMITIVE: no composite law appears here, so nothing in the
# search space is a pre-supplied answer. (p_top-1/n)/(1-1/n) and 1-H/log(n)
# must both be ASSEMBLED from these or they will not be found.
def primitives(P):
    """P: list of probability vectors -> dict name -> np.array of values."""
    out = {}
    srt = [sorted(p, reverse=True) for p in P]
    out["p1"]   = np.array([s[0] for s in srt])
    out["p2"]   = np.array([s[1] for s in srt])
    out["pmin"] = np.array([min(p) for p in P])
    n           = np.array([float(len(p)) for p in P])
    out["n"]    = n
    out["invn"] = 1.0 / n
    out["logn"] = np.log(n)
    out["H"]    = np.array([-sum(v * math.log(v) for v in p if v > 0) for p in P])
    out["sq"]   = np.array([sum(v * v for v in p) for p in P])
    out["one"]  = np.ones(len(P))
    for k in EXCLUDE:
        out.pop(k, None)
    return out

OPS = {"+": np.add, "-": np.subtract, "*": np.multiply, "/": np.divide}

def build(prims, depth, keep=None):
    """Yield (label, values) expression candidates up to `depth`.

    A GENERATOR on purpose: the final level of a depth-2 search is ~270k
    expressions, and materialising one full-length array each would cost
    gigabytes. Only the small lower levels are ever held in memory.
    `keep`, when given, restricts what is yielded (values are still computed --
    a sub-expression is needed whether or not it is itself reported).
    """
    def want(lbl):
        return keep is None or lbl in keep

    allx = [(k, v) for k, v in prims.items()]
    seen = {k for k, _ in allx}
    for k, v in allx:
        if want(k):
            yield k, v
    for lvl in range(depth):
        last = lvl == depth - 1   # nothing is built ON the last level, so do
        nxt = []                  # not retain it -- that is the 2.3GB case
        for (la, va), (lb, vb) in itertools.product(allx, repeat=2):
            for sym, fn in OPS.items():
                if sym in "+*" and la > lb:      # commutative: one ordering only
                    continue
                if sym in "-/" and la == lb:     # x-x and x/x are constants
                    continue
                lbl = f"({la}{sym}{lb})"
                if lbl in seen:
                    continue
                with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
                    vals = fn(va, vb)
                if not np.all(np.isfinite(vals)):
                    continue
                seen.add(lbl)
                if not last:
                    nxt.append((lbl, vals))
                if want(lbl):
                    yield lbl, vals
        if last or not nxt:
            break
        allx = allx + nxt

def main():
    rows = harvest(TARGET, FIELD)
    if len(rows) < MIN_N:
        print(f"discover: {len(rows)} usable samples (need {MIN_N}). "
              f"Is --field {FIELD!r} right?", file=sys.stderr)
        sys.exit(2)
    P = [r[0] for r in rows]
    y = np.array([r[1] for r in rows])

    if EXCLUDE:
        print(f"discover: primitives EXCLUDED -> {sorted(EXCLUDE)}", file=sys.stderr)

    # Two stages, for memory not for speed: a depth-2 space is ~270k
    # expressions, and holding one full-length array per expression would need
    # gigabytes. Search on a probe subsample, then RE-EVALUATE the survivors on
    # every sample -- so no reported number is ever a subsample number.
    PROBE = min(len(rows), int(opt("--probe", "48")))
    idx = np.linspace(0, len(rows) - 1, PROBE).astype(int)
    Pp = [P[i] for i in idx]
    yp = y[idx]

    prims_probe = primitives(Pp)
    print(f"discover: {len(rows)} samples ({PROBE} probed), {len(prims_probe)} primitives "
          f"({' '.join(sorted(prims_probe))}), depth {DEPTH}", file=sys.stderr)

    def probdp(p):
        out = 0
        for v in p:
            s = repr(float(v))
            out = max(out, len(s.split(".")[1]) if "." in s and "e" not in s else 17)
        return out
    pdp = int(np.median([probdp(p) for p in P]))
    tol = EXACT if "--tol" in sys.argv else max(EXACT, 10.0 ** (-pdp))

    keep, near, seen_n = set(), [], 0
    for lbl, vals in build(prims_probe, DEPTH):
        seen_n += 1
        err = np.abs(vals - yp)
        if np.mean(err <= tol) >= 0.25:
            keep.add(lbl)
        elif len(keep) == 0:
            near.append((float(np.median(err)), lbl))
    print(f"discover: {seen_n} candidate expressions", file=sys.stderr)
    if not keep:   # nothing exact -- carry the closest few so the table is informative
        near.sort()
        keep = {lbl for _, lbl in near[:200]}

    prims = primitives(P)
    cands = list(build(prims, DEPTH, keep=keep))
    print(f"discover: {len(cands)} survived the probe, re-scored on all "
          f"{len(rows)} samples", file=sys.stderr)

    # The INPUTS cap how exact any recomputation can be. When probabilities are
    # published at 2dp, a +/-0.005 rounding on each propagates into the result,
    # so demanding 1e-9 measures the publisher's formatting, not the vendor's
    # arithmetic. Scale the bar to the corpus and SAY which bar was used --
    # this tool printed the precision and then ignored it, which made a
    # correctly-recovered law read as "NOT RECOVERED".
    scored = []
    for lbl, vals in cands:
        err = np.abs(vals - y)
        scored.append((float(np.mean(err <= tol)),
                       float(np.mean(err <= 0.02)),
                       float(np.median(err)), lbl))
    scored.sort(key=lambda t: (-t[0], -t[1], t[2]))

    bar = f"exact@{tol:g}"
    print(f"\n  probabilities published at {pdp} dp -> matching bar {bar}"
          f"{' (rounding-limited, not 1e-9)' if tol > EXACT else ''}\n")
    print(f"  {bar:>13}  {'within .02':>10}  {'median err':>10}  expression")
    for ex, near, med, lbl in scored[:TOPK]:
        print(f"  {ex:>12.1%}  {near:>9.1%}  {med:>10.6f}  {lbl}")

    best = scored[0]
    print()
    if best[0] >= 0.5:
        print(f"  RECOVERED: {FIELD} == {best[3]}   ({bar} on {best[0]:.1%} of {len(rows)})")
    else:
        print(f"  NOT RECOVERED. Best rate {best[0]:.1%} at {bar} -- no closed form in "
              f"this space reproduces {FIELD!r}. Raise --depth, or the field is not "
              f"a deterministic function of the probabilities alone.")

if __name__ == "__main__":
    if not TARGET:
        print(__doc__, file=sys.stderr); sys.exit(2)
    main()
