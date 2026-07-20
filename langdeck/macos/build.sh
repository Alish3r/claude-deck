#!/bin/bash
# Builds langtool from langtool.swift. Needs Xcode Command Line Tools (not full Xcode).
#
# If `swiftc` is missing, macOS will usually offer to install the Command Line Tools when you
# run it. Otherwise: xcode-select --install

set -u   # deliberately NOT -e: we want to report failures ourselves, with context.

cd "$(dirname "$0")" || exit 1

echo "=== environment ==="
sw_vers 2>/dev/null || echo "sw_vers unavailable"
echo "arch: $(uname -m)"
if command -v swiftc >/dev/null 2>&1; then
  echo "swiftc: $(swiftc --version 2>&1 | head -1)"
else
  echo
  echo "FAIL: swiftc not found."
  echo "Install the Xcode Command Line Tools, then re-run this script:"
  echo "    xcode-select --install"
  exit 1
fi

echo
echo "=== compiling ==="
# -O for a release build; Carbon is the framework that provides Text Input Services.
swiftc -O -framework Carbon -o langtool langtool.swift
status=$?

if [ $status -ne 0 ]; then
  echo
  echo "FAIL: compilation failed with exit $status (see errors above)."
  echo "Please paste the WHOLE output of this script back — the compiler error is the useful part."
  exit $status
fi

chmod +x langtool
echo "OK: built ./langtool ($(wc -c < langtool | tr -d ' ') bytes)"
echo
echo "Next: ./verify.sh"
