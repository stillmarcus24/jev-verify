#!/usr/bin/env python3
"""Wide sweep: recompute acc_norm under char vs byte for MANY models at once.

The narrow run (11 models) reported zero rank changes. That was an artifact of
the sample: those models spanned 0.197-0.327 on ARC, and nothing that far apart
can swap under a delta of one question. The real leaderboard is 99.6% tied.

This fixes both halves of that error:
  - 100+ models, sampled across the board rather than one search page
  - every model recomputed, then ranked TOGETHER, so simultaneous movements
    cancel instead of being counted as if one model moved against a frozen field

Resumable: each model appends one line to the output as it completes.
Reads only published artifacts. No model is queried.

  python3 scripts/accnorm_wide.py [--models 120] [--task arc]
"""
import io, json, os, sys, urllib.parse, urllib.request
import concurrent.futures as cf

def opt(f, d):
    return sys.argv[sys.argv.index(f) + 1] if f in sys.argv else d

N      = int(opt("--models", "120"))
TASK   = opt("--task", "arc")
OUT    = opt("--out", f"state/accnorm-wide-{TASK}.jsonl")
CONC   = int(opt("--conc", "6"))
UA     = {"user-agent": "stillos-accnorm"}

def api(path, tries=4):
    """Retry on throttling. Swallowing a 429 and returning None makes every
    model look like it simply has no data -- a silent zero that reads as a
    clean negative result. That happened: a whole HellaSwag sweep returned 0
    models with no error shown."""
    import time
    for i in range(tries):
        try:
            return json.loads(urllib.request.urlopen(
                urllib.request.Request("https://huggingface.co/api/" + path, headers=UA),
                timeout=90).read())
        except Exception as e:
            code = getattr(e, "code", None)
            if code in (429, 503) or code is None:
                time.sleep(2 ** i)
                continue
            return None
    print(f"  api gave up: {path[:60]}", file=sys.stderr, flush=True)
    return None

def blob(ds, path):
    u = f"https://huggingface.co/datasets/{ds}/resolve/main/{urllib.parse.quote(path)}"
    return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=300).read()

def argmax(v):
    return max(range(len(v)), key=lambda i: v[i])

def one(ds):
    import pyarrow.parquet as pq
    tree = api(f"datasets/{ds}/tree/main?recursive=1")
    if not isinstance(tree, list):
        return None
    f = next((t["path"] for t in sorted(tree, key=lambda x: x["path"])
              if t["type"] == "file" and t["path"].endswith(".parquet")
              and TASK in t["path"]), None)
    if not f:
        return None
    try:
        rows = pq.read_table(io.BytesIO(blob(ds, f))).to_pylist()
    except Exception:
        return None
    if not rows or "predictions" not in rows[0] or "acc_norm" not in rows[0]:
        return None
    ch = by = pub = 0
    for r in rows:
        p, c = r["predictions"], r["choices"]
        if len(p) != len(c):
            return None
        a = argmax([x / max(len(s), 1) for x, s in zip(p, c)])
        b = argmax([x / max(len(s.encode("utf-8")), 1) for x, s in zip(p, c)])
        ch += int(a == r["gold"]); by += int(b == r["gold"]); pub += r["acc_norm"]
    n = len(rows)
    return {"model": ds.split("details_")[-1], "n": n,
            "char": ch / n, "byte": by / n, "published": pub / n}

def main():
    done = set()
    if os.path.exists(OUT):
        for line in open(OUT):
            try: done.add(json.loads(line)["model"])
            except Exception: pass
    # Pull far more candidates than needed: many repos lack the task file.
    seen, cands = set(), []
    for page in range(1, 9):
        r = api(f"datasets?search=open-llm-leaderboard-old/details&limit=100&offset={(page-1)*100}") or []
        new = [d["id"] for d in r if "/details_" in d.get("id", "") and d["id"] not in seen]
        if not new:
            break
        seen.update(new); cands += new
    cands = [c for c in cands if c.split("details_")[-1] not in done]
    print(f"{len(done)} already done, {len(cands)} candidates, targeting {N}", file=sys.stderr)

    got = len(done)
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "a") as fh, cf.ThreadPoolExecutor(max_workers=CONC) as ex:
        for res in ex.map(one, cands[:N * 3]):
            if not res:
                continue
            fh.write(json.dumps(res) + "\n"); fh.flush()
            got += 1
            if got % 10 == 0:
                print(f"  {got} models", file=sys.stderr, flush=True)
            if got >= N:
                break
    print(f"done: {got} models -> {OUT}", file=sys.stderr)

if __name__ == "__main__":
    main()
