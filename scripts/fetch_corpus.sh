#!/usr/bin/env bash
# Rebuild the analysis corpus from its manifest.
#
# The corpus is NOT redistributed here: every file belongs to the repository
# that published it, under that project's own license. data/fetched.txt is the
# manifest (index|repo|path); this script re-fetches each file from its source
# so the corpus is reproducible rather than copied.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/corpus"
MAN="$DIR/data/fetched.txt"
[ -f "$MAN" ] || { echo "missing manifest: $MAN" >&2; exit 1; }
mkdir -p "$OUT"
ok=0; miss=0
while IFS='|' read -r i repo path; do
  [ -n "${i:-}" ] || continue
  dest="$OUT/f_$i.json"
  [ -s "$dest" ] && { ok=$((ok+1)); continue; }
  got=0
  for br in HEAD main master; do
    if curl -sf -m 20 "https://raw.githubusercontent.com/$repo/$br/$path" -o "$dest" 2>/dev/null && [ -s "$dest" ]; then
      got=1; break
    fi
  done
  if [ "$got" = 1 ]; then ok=$((ok+1)); else rm -f "$dest"; miss=$((miss+1)); echo "  missing: $repo/$path" >&2; fi
done < "$MAN"
echo "corpus: $ok fetched, $miss unavailable -> $OUT"
[ "$ok" -gt 0 ] || exit 1
