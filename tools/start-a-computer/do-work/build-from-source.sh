#!/bin/sh
# tools/start-a-computer/do-work/build-from-source.sh
#
# Runs as root on the machine, handed over SSH as the command's own text (`sh -c "<this file>" sh SOURCE`), so standard input
# is free for the source: a tar stream of the tree at the unit's commit (`git archive COMMIT` from the caller's checkout).
# It builds the unit's program from that tree as the unit's user, puts it at BUILDS/COMMIT/PROGRAM, and moves
# BUILDS/current to COMMIT with one rename. A commit already built is not built again and reads no standard input.
#
# SOURCE is one JSON object: user, builds, commit, program, output (the built file), build (the argv run in the tree) and
# environment (NAME=value lines the build runs with, the toolchain's PATH among them), each already filled from the computer
# row. The build's own folders (its target and cache) are the row's to name in environment; a target kept in the
# builds is reused by the next commit.
set -eu
SOURCE=$1
field() { printf '%s' "$SOURCE" | jq -r ".$1"; }
user=$(field user); builds=$(field builds); commit=$(field commit); program=$(field program); output=$(field output)
at="$builds/$commit"
if [ ! -x "$at/$program" ]; then
  tree="$builds/source-$commit"
  rm -rf "$tree"
  install -d -o "$user" -g "$user" -m 0700 "$tree"
  runuser -u "$user" -- tar -x -C "$tree"
  words=$(printf '%s' "$SOURCE" | jq -r '[.environment[], .build[]] | map(@sh) | join(" ")')
  eval "set -- $words"
  runuser -u "$user" -- sh -c 'cd "$0" && exec env "$@"' "$tree" "$@" >&2
  install -d -o "$user" -g "$user" -m 0755 "$at"
  install -o "$user" -g "$user" -m 0755 "$output" "$at/$program"
  rm -rf "$tree"
fi
runuser -u "$user" -- sh -c 'ln -sfn "$0" "$1/current.new" && mv -T "$1/current.new" "$1/current"' "$commit" "$builds"
echo "$commit"
