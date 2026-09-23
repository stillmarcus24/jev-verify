#!/usr/bin/env python3
"""Recompute lm-evaluation-harness `acc_norm` from published leaderboard artifacts.

EleutherAI/lm-evaluation-harness#3278 is open on exactly this: the Harness paper
says each answer's loglikelihood is divided by its length in BYTES, while
task.py computes `float(len(i))` on a `str`, which is CHARACTERS. The issue asks
which is implemented. It is answerable from the record rather than from reading
source: the Open LLM Leaderboard published per-sample `predictions` (per-choice
loglikelihoods) alongside the `acc_norm` it scored, so both candidate
normalisers can be replayed against the number that was actually published.

This does NOT query any model or API. It reads artifacts already public.

  python3 scripts/accnorm_recover.py [--models 12] [--out state/accnorm.json]
"""
import io, json, os, sys, urllib.parse, urllib.request, collections

def opt(f, d):
    return sys.argv[sys.argv.index(f) + 1] if f in sys.argv else d

N_MODELS = int(opt("--models", "12"))
OUT      = opt("--out", "state/accnorm.json")
UA       = {"user-agent": "stillos-accnorm"}

def api(path):
    try:
        return json.loads(urllib.request.urlopen(
            urllib.request.Request("https://huggingface.co/api/" + path, headers=UA),
            timeout=60).read())
    except Exception:
        return None

def blob(ds, path):
    u = f"https://huggingface.co/datasets/{ds}/resolve/main/{urllib.parse.quote(path)}"
    return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=120).read()

def argmax(v):
    return max(range(len(v)), key=lambda i: v[i])

# The two readings under test. Both are tokenizer-independent, which is the
# stated reason for normalising at all -- so "tokenizer independence" does not
# decide between them. Token normalisation is included only as a negative
# control: the harness explicitly rejects it, so it must NOT win.
NORMS = {
    "char": lambda r: [p / max(len(c), 1)
                       for p, c in zip(r["predictions"], r["choices"])],
    "byte": lambda r: [p / max(len(c.encode("utf-8")), 1)
                       for p, c in zip(r["predictions"], r["choices"])],
    "token": lambda r: [p / max(len(t), 1)
                        for p, t in zip(r["predictions"], r["cont_tokens"])],
}

def score_file(rows):
    """Return published acc_norm and the rate each normaliser reproduces it."""
    out = {"n": len(rows), "published_acc_norm": 0.0, "nonascii_rows": 0}
    # Not every published task file carries acc_norm (MMLU-style single-letter
    # continuations, and some harness versions). Skip rather than crash.
    if not rows or "acc_norm" not in rows[0] or "choices" not in rows[0]:
        return None
    out["published_acc_norm"] = sum(r["acc_norm"] for r in rows) / len(rows)
    for r in rows:
        if any(len(c) != len(c.encode("utf-8")) for c in r["choices"]):
            out["nonascii_rows"] += 1
    for name, fn in NORMS.items():
        try:
            preds = [int(argmax(fn(r)) == r["gold"]) for r in rows]
        except Exception:
            continue
        out[f"{name}_reproduces"] = sum(p == r["acc_norm"]
                                        for p, r in zip(preds, rows)) / len(rows)
        out[f"{name}_score"] = sum(preds) / len(preds)
    # Rows where the two readings disagree with EACH OTHER -- the blast radius.
    try:
        ch = [argmax(NORMS["char"](r)) for r in rows]
        by = [argmax(NORMS["byte"](r)) for r in rows]
        out["char_vs_byte_choice_flips"] = sum(a != b for a, b in zip(ch, by))
    except Exception:
        pass
    return out

def main():
    ds_list = api(f"datasets?search=open-llm-leaderboard-old/details&limit={N_MODELS * 3}") or []
    models = [d["id"] for d in ds_list if "/details_" in d.get("id", "")][:N_MODELS]
    print(f"{len(models)} model artifact sets", file=sys.stderr)

    import pyarrow.parquet as pq
    results = []
    for i, ds in enumerate(models, 1):
        tree = api(f"datasets/{ds}/tree/main?recursive=1")
        if not isinstance(tree, list):
            continue
        # arc + hellaswag: full-text continuations, so the denominator varies.
        # MMLU continuations are single letters (denominator 1), which is why
        # acc and acc_norm are identical there and it cannot show anything.
        cand = [t["path"] for t in tree if t["type"] == "file"
                and t["path"].endswith(".parquet")
                and ("arc" in t["path"] or "hellaswag" in t["path"])]
        # One file per task per model. Leaderboard repos carry several dated
        # re-runs of the same task; downloading all of them multiplies I/O
        # without adding an independent observation.
        files = []
        for key in ("arc", "hellaswag"):
            hit = next((c for c in sorted(cand) if key in c), None)
            if hit:
                files.append(hit)
        for f in files:
            try:
                rows = pq.read_table(io.BytesIO(blob(ds, f))).to_pylist()
            except Exception:
                continue
            if not rows or "predictions" not in rows[0]:
                continue
            s = score_file(rows)
            if not s:
                continue
            task = "hellaswag" if "hellaswag" in f else "arc"
            s.update(model=ds.split("details_")[-1], task=task)
            results.append(s)
            print(f"[{i}/{len(models)}] {s['model'][:38]:<38} {task:<10} "
                  f"n={s['n']:<6} char={s.get('char_reproduces',0):.4f} "
                  f"byte={s.get('byte_reproduces',0):.4f} "
                  f"flips={s.get('char_vs_byte_choice_flips','?')} "
                  f"nonascii={s['nonascii_rows']}", file=sys.stderr, flush=True)
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    json.dump(results, open(OUT, "w"), indent=1)
    print(f"\nwrote {len(results)} model-task rows -> {OUT}", file=sys.stderr)

if __name__ == "__main__":
    main()
