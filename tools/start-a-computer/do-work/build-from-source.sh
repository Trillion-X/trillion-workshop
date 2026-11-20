#!/bin/sh
# tools/start-a-computer/do-work/build-from-source.sh
#
# Runs as root on the machine, handed over SSH as the command's own text (`sh -c "<this file>" sh SOURCE`). The computer fetches
# the unit's commit itself from the row's repository address into a copy it keeps at BUILDS/repository (only what the copy
# lacks), builds the unit's program from that commit's tree as the unit's user, puts it at BUILDS/COMMIT/PROGRAM, and moves
# BUILDS/CURRENT (the link the unit runs: `current`, or a slot's `current-<slot>`) to COMMIT with one rename. A commit already
# built is not fetched or built again.
#
# SOURCE is one JSON object: user, builds, current, repository (a git address), commit, program, output (the built file, or a
# built folder that holds PROGRAM with everything it reads beside it: the whole folder is kept), build (the
# argv run in the tree), environment (NAME=value lines the build runs with, the toolchain's PATH among them), each already
# filled from the computer row, and keyed with host_keys. When keyed is true, standard input holds the SSH key the person's
# vault keeps for the repository: it goes into an ssh-agent of the unit's user for that one fetch and is never written to a
# file; the fetch's ssh reads no ssh_config, uses only that agent, and accepts only host_keys (the host's known_hosts lines). The build's own folders (its target
# and cache) are the row's to name in environment; a target kept in the builds is reused by the next commit.
set -eu
SOURCE=$1
field() { printf '%s' "$SOURCE" | jq -r ".$1"; }
user=$(field user); builds=$(field builds); commit=$(field commit); program=$(field program); output=$(field output)
repository=$(field repository); keyed=$(field keyed); current=$(field current)
at="$builds/$commit"
# One build at a time in a builds folder: a second apply waits here, then finds the commit built by the first.
exec 9>"$builds/.build.lock"
flock 9
if [ ! -x "$at/$program" ]; then
  copy="$builds/repository"
  [ -d "$copy" ] || runuser -u "$user" -- git init -q --bare "$copy"
  if [ "$keyed" = true ]; then
    printf '%s' "$SOURCE" | jq -r '.host_keys[]' | install -o "$user" -g "$user" -m 0644 /dev/stdin "$builds/known_hosts"
    runuser -u "$user" -- sh -c 'eval "$(ssh-agent -s)" >/dev/null && trap "ssh-agent -k >/dev/null" EXIT && ssh-add -q - &&
      GIT_SSH_COMMAND="ssh -F /dev/null -o IdentityAgent=$SSH_AUTH_SOCK -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$3" git -C "$0" fetch -q --depth 1 "$1" "$2"' \
      "$copy" "$repository" "$commit" "$builds/known_hosts"
  else
    cat >/dev/null
    runuser -u "$user" -- git -C "$copy" fetch -q --depth 1 "$repository" "$commit"
  fi
  tree="$builds/source-$commit"
  rm -rf "$tree"
  install -d -o "$user" -g "$user" -m 0700 "$tree"
  runuser -u "$user" -- sh -c 'git -C "$0" archive --format=tar "$1" | tar -x -C "$2"' "$copy" "$commit" "$tree"
  words=$(printf '%s' "$SOURCE" | jq -r '[.environment[], .build[]] | map(@sh) | join(" ")')
  eval "set -- $words"
  # The build's output is kept in a log beside the builds; a failed build names its first error and that log. The build is the
  # first the kernel ends when memory runs out (oom_score_adj 1000, which its compilers inherit), never a unit that serves: on a
  # 3.8 GB computer with no swap a build ended the running engine at 3:40:48 AM CST Nov 20 2026. Ended so, the build fails here
  # and the slot that serves keeps serving.
  log="$builds/build-$commit.log"
  if ! runuser -u "$user" -- sh -c 'echo 1000 > /proc/self/oom_score_adj; cd "$0" && exec env "$@"' "$tree" "$@" > "$log" 2>&1; then
    grep -m1 -A1 '^error' "$log" >&2 || true
    echo "The build of $commit failed; its whole output is $log on this computer." >&2
    rm -rf "$tree"
    exit 1
  fi
  # A folder is kept whole under a name of its own and moved to COMMIT with one rename, so a cut-off copy is never a build.
  if [ -d "$output" ]; then
    [ -f "$output/$program" ] || { echo "The built folder $output holds no $program." >&2; rm -rf "$tree"; exit 1; }
    rm -rf "$at.new" "$at"
    runuser -u "$user" -- cp -a "$output" "$at.new"
    chmod 0755 "$at.new/$program"
    mv -T "$at.new" "$at"
  else
    install -d -o "$user" -g "$user" -m 0755 "$at"
    install -o "$user" -g "$user" -m 0755 "$output" "$at/$program"
  fi
  rm -rf "$tree"
else
  # A key sent for a commit that is already built is read and dropped.
  cat >/dev/null
fi
runuser -u "$user" -- sh -c 'ln -sfn "$0" "$1/$2.new" && mv -T "$1/$2.new" "$1/$2"' "$commit" "$builds" "$current"
echo "$commit"
