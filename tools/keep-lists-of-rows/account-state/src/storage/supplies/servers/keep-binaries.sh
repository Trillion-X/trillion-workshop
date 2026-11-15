#!/bin/bash
# Copy the compiled suite executables out of a contained cargo target folder before it is removed, so the suites can be
# run again against each server without a rebuild.
#   keep-binaries.sh <cargo target dir> <destination folder>
set -eu
target="$1"; destination="$2"
mkdir -p "$destination/debug/deps"
for suite in conformance differential roundtrips; do
  binary="$(ls -t "$target"/debug/deps/"$suite"-* | grep -v '\.[a-z]*$' | head -1)"
  cp "$binary" "$destination/debug/deps/"
done
ls -la "$destination/debug/deps"
