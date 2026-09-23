#!/usr/bin/env bash
# Known-answer tests for the law-discovery search.
#
# Two held-out answers and one control. The control is the load-bearing test:
# a search that reports a law no matter what you remove from its inputs is
# fitting noise, and would be worse than useless pointed at a vendor whose
# formula nobody already knows.
set -uo pipefail
cd "$(dirname "$0")/.."

# Neither corpus is redistributed -- each file belongs to the repo that
# published it. Both are rebuilt from their manifests. Without this, a cold
# clone runs this script and gets 0/3 with empty output, which reads like the
# discovery engine is broken rather than like the corpus is simply absent.
for c in "data/fetched.txt corpus" "data/laya-fetched.txt corpus-laya"; do
  set -- $c
  if [ ! -d "$2" ] || [ -z "$(ls -A "$2" 2>/dev/null)" ]; then
    echo "fetching $2 from $1 ..."
    bash scripts/fetch_corpus.sh "$1" "$2" >/dev/null 2>&1 || {
      echo "  CANNOT FETCH $2 -- network required. Run: bash scripts/fetch_corpus.sh $1 $2" >&2
      exit 2; }
  fi
done

pass=0; fail=0
check() { # name expected_regex command...
  local name="$1" want="$2"; shift 2
  local out; out="$("$@" 2>/dev/null | tail -3)"
  if grep -qE "$want" <<<"$out"; then echo "  ok    $name"; pass=$((pass+1))
  else echo "  FAIL  $name"; echo "        want /$want/"; echo "        got: $out"; fail=$((fail+1)); fi
}

echo "discover known-answer tests"

# 1. Jev's law, recovered blind. Probabilities are published at 2dp, so the bar
#    scales to the inputs -- demanding 1e-9 here would measure formatting.
check "recovers Jev (p_top-1/n)/(1-1/n)" \
  'RECOVERED.*\(p1-invn\)/\(one-invn\)' \
  python3 scripts/discover.py corpus --depth 2

# 2. laya-mps publishes full precision, so its law recovers at 1e-9.
check "recovers laya-mps 1-H/log(n)" \
  'RECOVERED.*one-\(H/logn\)' \
  python3 scripts/discover.py corpus-laya --depth 2

# 3. CONTROL. Remove entropy and the entropy law must become unfindable.
check "control: no H -> NOT RECOVERED" \
  'NOT RECOVERED' \
  python3 scripts/discover.py corpus-laya --depth 2 --exclude-primitive H

echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
