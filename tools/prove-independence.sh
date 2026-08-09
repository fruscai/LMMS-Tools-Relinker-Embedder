#!/bin/bash
# prove-independence.sh — the honest test: can a bundle play with the original
# samples genuinely absent?
#
# Renames the source samples in place (never deletes), renders the bundle, then
# restores them. A trap restores on any exit path, including Ctrl-C, so the
# user's library is never left in a modified state.
#
# Usage: ./tools/prove-independence.sh <bundle.mmpz> <sampleDir> <name...>

set -uo pipefail

BUNDLE="${1:?usage: prove-independence.sh <bundle.mmpz> <sampleDir> <name...>}"
SAMPLEDIR="${2:?missing sample directory}"
shift 2
NAMES=("$@")

LMMS="/Applications/LMMS.app/Contents/MacOS/lmms"
SUFFIX=".hidden-for-test"
RENDER="/tmp/independence_render.wav"

restore() {
  echo ""
  echo "--- restoring samples ---"
  for n in "${NAMES[@]}"; do
    if [ -f "$SAMPLEDIR/$n$SUFFIX" ]; then
      mv "$SAMPLEDIR/$n$SUFFIX" "$SAMPLEDIR/$n"
      echo "  restored: $n"
    fi
  done
  for n in "${NAMES[@]}"; do
    [ -f "$SAMPLEDIR/$n" ] && echo "  verified present: $n" || echo "  *** MISSING: $n ***"
  done
}
trap restore EXIT INT TERM

echo "--- hiding samples ---"
for n in "${NAMES[@]}"; do
  if [ -f "$SAMPLEDIR/$n" ]; then
    mv "$SAMPLEDIR/$n" "$SAMPLEDIR/$n$SUFFIX"
    echo "  hidden: $n"
  else
    echo "  already absent: $n"
  fi
done

echo ""
echo "--- confirming they are gone ---"
for n in "${NAMES[@]}"; do
  [ -f "$SAMPLEDIR/$n" ] && echo "  *** STILL PRESENT: $n ***" || echo "  confirmed absent: $n"
done

echo ""
echo "--- rendering bundle with samples absent ---"
rm -f "$RENDER"
"$LMMS" -r "$BUNDLE" -o "$RENDER" -f wav -b 64 2>&1 \
  | grep -iE "sample not found|error|failed|Done|Loading" | head -20

echo ""
if [ -s "$RENDER" ]; then
  echo "RENDER PRODUCED: $(du -h "$RENDER" | cut -f1)"
else
  echo "*** NO AUDIO PRODUCED ***"
fi
