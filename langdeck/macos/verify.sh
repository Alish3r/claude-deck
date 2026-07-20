#!/bin/bash
# Closed-loop verification of langtool. Reads the current input source, switches to the next
# one, reads it BACK to confirm the switch really happened, then restores the original.
#
# "Read it back" is the whole point: on Windows the equivalent call can report success while
# silently doing nothing (elevated windows block it). We do not trust a return code — we trust
# a subsequent read.

set -u
cd "$(dirname "$0")" || exit 1

PASS=0
FAIL=0
note() { echo "$@"; }
ok()   { echo "  PASS: $*"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $*"; FAIL=$((FAIL+1)); }

if [ ! -x ./langtool ]; then
  echo "FAIL: ./langtool not found or not executable. Run ./build.sh first."
  exit 1
fi

echo "=== environment ==="
sw_vers 2>/dev/null
echo "arch: $(uname -m)"
echo

echo "=== 1. list input sources ==="
LIST=$(./langtool list)
echo "$LIST"
case "$LIST" in
  *'"ok":true'*) ok "list returned ok" ;;
  *) bad "list did not return ok"; echo; echo "Stopping — nothing else can work."; exit 1 ;;
esac

# Count sources without needing jq (not installed by default on macOS).
COUNT=$(printf '%s' "$LIST" | tr ',' '\n' | grep -c '"id"')
note "  detected $COUNT selectable keyboard source(s)"
if [ "$COUNT" -lt 2 ]; then
  echo
  echo "NOTE: fewer than 2 input sources are enabled, so there is nothing to cycle to."
  echo "To make this test meaningful, add a second keyboard layout:"
  echo "  System Settings > Keyboard > Text Input > Input Sources > Edit... > +"
  echo "Then re-run ./verify.sh"
  exit 0
fi
echo

echo "=== 2. read current ==="
CUR=$(./langtool current)
echo "$CUR"
ORIG_ID=$(printf '%s' "$CUR" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -n "$ORIG_ID" ]; then ok "current id = $ORIG_ID"; else bad "could not parse current id"; exit 1; fi
echo

echo "=== 3. pick a DIFFERENT source to switch to ==="
# Pull every id, drop the current one, take the first remaining.
TARGET_ID=$(printf '%s' "$LIST" | tr '{' '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | grep -v "^${ORIG_ID}$" | head -1)
if [ -n "$TARGET_ID" ]; then ok "target = $TARGET_ID"; else bad "no alternative source found"; exit 1; fi
echo

echo "=== 4. switch, then READ BACK to confirm ==="
SEL=$(./langtool select "$TARGET_ID")
echo "  select -> $SEL"
sleep 1                       # give the system a beat to apply it
AFTER=$(./langtool current)
echo "  current -> $AFTER"
AFTER_ID=$(printf '%s' "$AFTER" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ "$AFTER_ID" = "$TARGET_ID" ]; then
  ok "switch CONFIRMED by read-back ($AFTER_ID)"
else
  bad "switch NOT confirmed — asked for $TARGET_ID but read back $AFTER_ID"
fi
echo

echo "=== 5. restore the original ==="
./langtool select "$ORIG_ID" >/dev/null
sleep 1
BACK=$(./langtool current)
BACK_ID=$(printf '%s' "$BACK" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "  current -> $BACK"
if [ "$BACK_ID" = "$ORIG_ID" ]; then
  ok "original restored ($ORIG_ID)"
else
  bad "did NOT restore — you may be left on $BACK_ID instead of $ORIG_ID"
fi
echo

echo "=== 6. change notification (event-driven, no polling) ==="
echo "  Starting watch for 12 seconds."
echo "  >>> PLEASE SWITCH YOUR INPUT LANGUAGE BY HAND NOW <<<"
echo "  (menu bar input menu, or Control-Space / Globe key — whatever you normally use)"
WATCH_OUT=$(mktemp)
./langtool watch > "$WATCH_OUT" 2>&1 &
WATCH_PID=$!
sleep 12
kill "$WATCH_PID" 2>/dev/null
wait "$WATCH_PID" 2>/dev/null
echo "  --- watch output ---"
cat "$WATCH_OUT"
echo "  --------------------"
if grep -q '"event":"changed"' "$WATCH_OUT"; then
  ok "change notification fired"
else
  bad "no change notification seen (either you did not switch, or the notification does not work)"
fi
rm -f "$WATCH_OUT"
echo

echo "======================================"
echo " RESULT:  $PASS passed, $FAIL failed"
echo "======================================"
if [ "$FAIL" -eq 0 ]; then
  echo "All good. Please copy EVERYTHING above this line and send it back."
else
  echo "Some checks failed. Please copy EVERYTHING above this line and send it back —"
  echo "the failures are the useful part, not a problem on your end."
fi
