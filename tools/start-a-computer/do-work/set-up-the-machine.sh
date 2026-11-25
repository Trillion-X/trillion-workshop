#!/bin/sh
# tools/start-a-computer/do-work/set-up-the-machine.sh
#
# Runs as root on the machine, sent over SSH on standard input (`ssh root@ADDRESS sh -s -- RUNS SET_UP < this file`). It
# makes the machine ready to run what it is given and changes nothing it already made: the packages the set-up data
# names, the node release it names for this machine kind in each unit's node_bin folder that has no node yet (checked against
# its sha256 before anything is unpacked), the account and the folders each unit names (its state folder, its builds folder
# when it has one), a key a unit names when the key is not there yet (32 random bytes as one base64 line), and a
# firewall that admits only the set-up data's firewall_allow ports (none is set up when it is null). Before the packages, the
# set-up data's `files` (path and text, for a file that decides how a package installs) and its `apt_sources` (a package source:
# its `list_file` holds its `line`, and the key it is signed by is kept at `key_file`, refused unless the key's sha256 is the
# pinned one) are put in place; after them its `downloads` (one program each, its archive refused unless its sha256 is the
# pinned one). The files a computer row renders (each
# unit, its drop-ins and the files it reads) are written by applyWhatItRuns in start-a-computer.mjs, so this script names no
# path the row does not give.
#
# RUNS is what the computer's row says it runs (request.computer_row `runs`, read at run time) as JSON; SET_UP is settings.json `machine` with the row's own `machine` fields over it (the node release is the row's own).
set -eu
# It runs at the lowest CPU and disk priority, and every program it starts inherits that, so the programs this computer
# serves keep answering while it works (Nov 21 2026, 3:58-4:01 PM CST: a site's npm ci on a 2-core computer slowed every site
# it served to 1.07-1.54 s).
renice -n 19 -p $$ >/dev/null 2>&1 || true
ionice -c 2 -n 7 -p $$ >/dev/null 2>&1 || true
RUNS=$1
SET_UP=$2
command -v apt-get >/dev/null 2>&1 || { echo "This machine has no apt-get; start-a-computer sets up Debian and Ubuntu machines." >&2; exit 3; }
export DEBIAN_FRONTEND=noninteractive
command -v jq >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq jq >/dev/null; }
# Writes standard input to $3 with mode $1 (and owner $2 when not empty) through a temporary file in its folder, then one
# rename: `install /dev/stdin FILE` fails on Ubuntu 26.04's coreutils (uutils 0.10.0) whenever FILE already exists.
put() {
  tmp=$(mktemp "$(dirname "$3")/.put.XXXXXX") && cat > "$tmp" && chmod "$1" "$tmp" &&
    { [ -z "$2" ] || chown "$2" "$tmp"; } && mv -f "$tmp" "$3" || { rm -f "$tmp"; return 1; }
}
printf '%s' "$SET_UP" | jq -r '(.files // [])[] | .path' | while read -r path; do
  install -d -m 0755 "$(dirname "$path")"
  printf '%s' "$SET_UP" | jq -j --arg path "$path" '.files[] | select(.path == $path) | .text' | put 0644 '' "$path"
done
printf '%s' "$SET_UP" | jq -r '(.apt_sources // [])[] | .name' | while read -r name; do
  field() { printf '%s' "$SET_UP" | jq -r --arg name "$name" ".apt_sources[] | select(.name == \$name) | .$1"; }
  url=$(field key_url); want=$(field key_sha256); line=$(field line); key=$(field key_file); list=$(field list_file)
  if ! printf '%s  %s\n' "$want" "$key" | sha256sum -c --status 2>/dev/null; then
    install -d -m 0755 "$(dirname "$key")"
    curl -fsSL -o "$key.new" "$url"
    printf '%s  %s\n' "$want" "$key.new" | sha256sum -c --status || { echo "The key at $url is not the pinned one." >&2; exit 4; }
    chmod 0644 "$key.new" && mv "$key.new" "$key"
  fi
  install -d -m 0755 "$(dirname "$list")"
  printf '%s\n' "$line" | put 0644 '' "$list"
done
apt-get update -qq
apt-get install -y -qq -o Dpkg::Options::=--force-confold $(printf '%s' "$SET_UP" | jq -r '.packages | join(" ")') >/dev/null
# Each download is one program: its archive for this machine kind is checked against its sha256, the member the row names is
# unpacked, and the program is installed at its path only when the installed one is not the pinned bytes (binary_sha256).
# A download with `install` (a toolchain) is a whole tree instead: when its path is not there, the checked archive is
# unpacked and the row's install argv runs inside it, and its path must be there after.
printf '%s' "$SET_UP" | jq -r '(.downloads // [])[] | .path' | while read -r path; do
  kind=$(uname -m)
  row() { printf '%s' "$SET_UP" | jq -r --arg path "$path" --arg kind "$kind" ".downloads[] | select(.path == \$path) | .files[\$kind].$1 // empty"; }
  url=$(row url); want=$(row sha256); member=$(row member); binary=$(row binary_sha256)
  install=$(printf '%s' "$SET_UP" | jq -r --arg path "$path" '.downloads[] | select(.path == $path) | .install // empty | map(@sh) | join(" ")')
  if [ -n "$install" ]; then
    [ -x "$path" ] && continue
    [ -n "$url" ] && [ -n "$want" ] || { echo "The set-up data has no download of $path for $kind." >&2; exit 4; }
    download=$(mktemp)
    curl -fsSL -o "$download" "$url"
    [ "$(sha256sum "$download" | cut -d ' ' -f 1)" = "$want" ] || { rm -f "$download"; echo "The download of $path for $kind does not match its sha256." >&2; exit 5; }
    folder=$(mktemp -d)
    tar -xf "$download" -C "$folder" --strip-components=1
    rm -f "$download"
    (cd "$folder" && eval "$install" >/dev/null)
    rm -rf "$folder"
    [ -x "$path" ] || { echo "The install of the download for $path made no $path." >&2; exit 5; }
    continue
  fi
  [ -n "$url" ] && [ -n "$want" ] && [ -n "$member" ] && [ -n "$binary" ] || { echo "The set-up data has no download of $path for $kind." >&2; exit 4; }
  printf '%s  %s\n' "$binary" "$path" | sha256sum -c --status 2>/dev/null && continue
  download=$(mktemp)
  curl -fsSL -o "$download" "$url"
  [ "$(sha256sum "$download" | cut -d ' ' -f 1)" = "$want" ] || { rm -f "$download"; echo "The download of $path for $kind does not match its sha256." >&2; exit 5; }
  folder=$(mktemp -d)
  tar -xzf "$download" -C "$folder" "$member"
  rm -f "$download"
  printf '%s  %s\n' "$binary" "$folder/$member" | sha256sum -c --status || { echo "The program in the download of $path is not the pinned bytes." >&2; exit 5; }
  install -d -m 0755 "$(dirname "$path")"
  install -m 0755 "$folder/$member" "$path"
  rm -rf "$folder"
done
printf '%s' "$RUNS" | jq -e '.units | type == "array"' >/dev/null || { echo "The computer row's runs needs a units list." >&2; exit 2; }
printf '%s' "$RUNS" | jq -r '[.units[] | .node_bin // empty] | unique[]' | while read -r bin; do
  [ -x "$bin/node" ] && continue
  kind=$(uname -m)
  url=$(printf '%s' "$SET_UP" | jq -r --arg kind "$kind" '.node.files[$kind].url // empty')
  want=$(printf '%s' "$SET_UP" | jq -r --arg kind "$kind" '.node.files[$kind].sha256 // empty')
  [ -n "$url" ] && [ -n "$want" ] || { echo "The set-up data has no node release for $kind: the computer row's machine.node gives one." >&2; exit 4; }
  download=$(mktemp)
  curl -fsSL -o "$download" "$url"
  [ "$(sha256sum "$download" | cut -d ' ' -f 1)" = "$want" ] || { rm -f "$download"; echo "The node download for $kind does not match its sha256." >&2; exit 5; }
  mkdir -p "$(dirname "$bin")"
  tar -xzf "$download" -C "$(dirname "$bin")" --strip-components=1
  rm -f "$download"
done
printf '%s' "$RUNS" | jq -r '.units[] | [.user, (.state // ""), (.builds // ""), (.key_file // "")] | @tsv' | while IFS="$(printf '\t')" read -r user state builds key; do
  # A unit that runs as an account the machine already has (root, say) and names no state of its own needs nothing made here.
  if [ -z "$state" ] && id -u "$user" >/dev/null 2>&1; then continue; fi
  [ -n "$state" ] || { echo "Unit user $user needs state in the computer row." >&2; exit 2; }
  id -u "$user" >/dev/null 2>&1 || useradd --system --home-dir "$state" --create-home --shell /usr/sbin/nologin "$user"
  install -d -o "$user" -g "$user" -m 0700 "$state"
  [ -z "$builds" ] || install -d -o "$user" -g "$user" -m 0755 "$builds"
  if [ -n "$key" ] && [ ! -s "$key" ]; then
    head -c 32 /dev/urandom | base64 -w0 | put 0400 "$user:$user" "$key"
  fi
done
# The folders a unit names (`folders`) that its program needs and does not make itself, such as an engine's persons folder.
printf '%s' "$RUNS" | jq -r '.units[] | .user as $user | (.folders // [])[] | [$user, .] | @tsv' | while IFS="$(printf '\t')" read -r user folder; do
  install -d -o "$user" -g "$user" -m 0700 "$folder"
done
if printf '%s' "$SET_UP" | jq -e '.firewall_allow | type == "array"' >/dev/null; then
  printf '%s' "$SET_UP" | jq -r '.firewall_allow[]' | while read -r port; do ufw allow "$port" >/dev/null; done
  ufw --force enable >/dev/null
fi
echo "set-up $(uname -m)"
