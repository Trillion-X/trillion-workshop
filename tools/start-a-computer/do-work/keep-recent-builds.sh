#!/bin/sh
# tools/start-a-computer/do-work/keep-recent-builds.sh
#
# Runs as root on a computer, sent over SSH on standard input (`ssh root@ADDRESS sh -s -- BUILDS KEEP < this file`), by
# keep-recent-builds.mjs. Prints, one per line, the commits in the builds folder BUILDS that a computer no longer needs: every
# built commit (a folder named by 40 hex digits) beyond the KEEP newest, except one a `current` or `current-<slot>` link names,
# because that build is the one a unit runs. It removes nothing.
#
# A build is 15 to 210 MB and every deploy adds one; none was ever removed, so on Nov 24 2026 (5:3x PM CST) the root disk of the
# computer that serves the sites held 161 builds of one site and 28 of another (5.9 GB), 98% full, and the next deploy would
# have failed for lack of room.
set -eu
BUILDS=$1
KEEP=$2
case "$KEEP" in ''|*[!0-9]*) echo "KEEP must be a whole number." >&2; exit 2 ;; esac
[ -d "$BUILDS" ] || exit 0
cd "$BUILDS"
linked=$(for link in current current-*; do if [ -L "$link" ]; then basename "$(readlink "$link")"; fi; done)
ls -1t | grep -E '^[0-9a-f]{40}$' | while read -r commit; do
  if [ -d "$commit" ] && [ ! -L "$commit" ]; then echo "$commit"; fi
done | tail -n +"$((KEEP + 1))" | while read -r commit; do
  printf '%s\n' "$linked" | grep -qx "$commit" || echo "$commit"
done
