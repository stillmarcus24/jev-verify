#!/usr/bin/env python3
"""Find models published under different names that are provably the same model.

Hugging Face's Open LLM Leaderboard FAQ asks users to flag "models that are
copies of other models not attributed properly." In 2023 a maintainer deleted
one such model, writing that they had "never seen results identical to so many
decimal points for two different models" and citing results identical down to
the logprobs hashes. That detection was manual, one flag at a time. The rate has
never been measured.

Two stages, cheap then conclusive:

  1. SIGNATURE. Group the 7,260 board entries by their six benchmark scores
     (ARC, HellaSwag, MMLU, TruthfulQA, Winogrande, GSM8K) to 10 decimals.
     Matching on all six across ~30k questions is not coincidence.

  2. CONFIRMATION. For each group, fetch the published per-sample ARC
     predictions and hash the full logprob vector -- 1,172 questions x 4
     choices = 4,688 floats. Bit-identical vectors are not evidence of
     similarity; they are the same model.

Stage 2 is what makes this a proof rather than a statistic. A signature match
could in principle be a coincidence; 4,688 identical floats cannot.

Reads only published artifacts. No model is run. Resumable.

  python3 scripts/leaderboard_dupes.py --rows /tmp/lb_rows.pkl
"""
import collections, hashlib, io, json, os, pickle, sys, urllib.parse, urllib.request

def opt(f, d):
    return sys.argv[sys.argv.index(f) + 1] if f in sys.argv else d

ROWS = opt("--rows", "/tmp/lb_rows.pkl")
OUT  = opt("--out", "state/leaderboard-dupes.jsonl")
UA   = {"user-agent": "stillos-dupes"}
T    = ["ARC", "HellaSwag", "MMLU", "TruthfulQA", "Winogrande", "GSM8K"]

def api(path, tries=4):
    import time
    for i in range(tries):
        try:
            return json.loads(urllib.request.urlopen(
                urllib.request.Request("https://huggingface.co/api/" + path, headers=UA),
                timeout=90).read())
        except Exception as e:
            if getattr(e, "code", None) == 404:
                return None
            time.sleep(2 ** i)
    return None

def logprob_hash(model, cache={}):
    """SHA256 of every published ARC logprob for this model, or None."""
    if model in cache:
        return cache[model]
    ds = "open-llm-leaderboard-old/details_" + model.replace("/", "__")
    t = api(f"datasets/{ds}/tree/main?recursive=1")
    h = None
    if isinstance(t, list):
        f = next((x["path"] for x in sorted(t, key=lambda y: y["path"])
                  if x["type"] == "file" and x["path"].endswith(".parquet")
                  and "arc" in x["path"]), None)
        if f:
            try:
                import pyarrow.parquet as pq
                raw = urllib.request.urlopen(urllib.request.Request(
                    f"https://huggingface.co/datasets/{ds}/resolve/main/{urllib.parse.quote(f)}",
                    headers=UA), timeout=240).read()
                rows = pq.read_table(io.BytesIO(raw)).to_pylist()
                v = [tuple(r["predictions"]) for r in rows]
                h = hashlib.sha256(repr(v).encode()).hexdigest()
            except Exception:
                h = None
    cache[model] = h
    return h

def name(r):
    return r.get("fullname") or r.get("eval_name") or ""

def main():
    rows = pickle.load(open(ROWS, "rb"))
    ok = [r for r in rows if all(isinstance(r.get(t), (int, float)) for t in T)]
    sig = collections.defaultdict(list)
    for r in ok:
        sig[tuple(round(r[t], 10) for t in T)].append(r)

    groups = []
    for k, v in sig.items():
        if len(v) < 2:
            continue
        orgs = {name(x).split("/")[0] for x in v}
        shas = {x.get("Model sha") for x in v}
        if len(orgs) > 1 and len(shas) > 1:      # the FAQ's "copy, unattributed"
            groups.append(v)
    print(f"{len(ok)} board entries | {len(groups)} cross-org groups | "
          f"{sum(len(g) for g in groups)} models", file=sys.stderr, flush=True)

    done = set()
    if os.path.exists(OUT):
        for line in open(OUT):
            try: done.add(json.loads(line)["key"])
            except Exception: pass

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    conf = unconf = nodata = 0
    with open(OUT, "a") as fh:
        for gi, g in enumerate(groups, 1):
            key = "|".join(sorted(name(x) for x in g))
            if key in done:
                continue
            hs = {name(x): logprob_hash(name(x)) for x in g}
            live = {m: h for m, h in hs.items() if h}
            verdict = ("NO_DATA" if len(live) < 2
                       else "IDENTICAL" if len(set(live.values())) == 1
                       else "DIFFERENT")
            rec = {"key": key, "models": list(hs), "verdict": verdict,
                   "hashes": {m: (h[:16] if h else None) for m, h in hs.items()},
                   "shas": {name(x): x.get("Model sha") for x in g}}
            fh.write(json.dumps(rec) + "\n"); fh.flush()
            conf += verdict == "IDENTICAL"; unconf += verdict == "DIFFERENT"
            nodata += verdict == "NO_DATA"
            print(f"  [{gi}/{len(groups)}] {verdict:<9} {key[:70]}",
                  file=sys.stderr, flush=True)
    print(f"\nIDENTICAL {conf} | DIFFERENT {unconf} | NO_DATA {nodata}",
          file=sys.stderr)

if __name__ == "__main__":
    main()
