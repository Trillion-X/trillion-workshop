#!/bin/sh
# tools/start-a-computer/do-work/set-up-the-machine.sh
#
# Runs as root on the machine, sent over SSH on standard input (`ssh root@ADDRESS sh -s -- LAYOUT SET_UP < this file`). It
# makes the machine ready to run the layout it is given and changes nothing it already made: the packages the set-up data
# names, the node release it names for this machine kind in each unit's node_bin folder that has no node yet (checked against
# its sha256 before anything is unpacked), the account and the folders each unit names (its state folder, from its config
# when it has one, its releases folder when it has one), a key a unit's layout names when the key is not there yet, and a
# firewall that admits only the set-up data's firewall_allow ports (none is set up when it is null). Before the packages, the
# set-up data's `files` (path and text, for a file that decides how a package installs) and its `apt_sources` (a package source:
# its `list_file` holds its `line`, and the key it is signed by is kept at `key_file`, refused unless the key's sha256 is the
# pinned one) are put in place; after them its `downloads` (one program each, its archive refused unless its sha256 is the
# pinned one). The files a layout renders (the
# Caddy site file, each unit and its drop-ins) are written by apply-layout in start-a-computer.mjs, so this script names no
# path a layout does not give.
#
# LAYOUT is the computer's layout row as JSON (request.host_layout, read at run time); SET_UP is settings.json `machine` with the layout row's own `machine` fields over it.
# FRONT_DOOR_CADDY, given when the layout's caddy row has `front_door`, is "PATH URL SHA256" of this machine's architecture
# (the layout row's caddy.front_door binary_files): that Caddy is fetched and installed at PATH only when its SHA-256 is SHA256.
set -eu
LAYOUT=$1
SET_UP=$2
FRONT_DOOR_CADDY=${3:-}
command -v apt-get >/dev/null 2>&1 || { echo "This machine has no apt-get; start-a-computer sets up Debian and Ubuntu machines." >&2; exit 3; }
export DEBIAN_FRONTEND=noninteractive
command -v jq >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq jq >/dev/null; }
printf '%s' "$SET_UP" | jq -r '(.files // [])[] | .path' | while read -r path; do
  install -d -m 0755 "$(dirname "$path")"
  printf '%s' "$SET_UP" | jq -j --arg path "$path" '.files[] | select(.path == $path) | .text' | install -m 0644 /dev/stdin "$path"
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
  printf '%s\n' "$line" | install -m 0644 /dev/stdin "$list"
done
apt-get update -qq
apt-get install -y -qq -o Dpkg::Options::=--force-confold $(printf '%s' "$SET_UP" | jq -r '.packages | join(" ")') >/dev/null
# Each download is one program: its archive for this machine kind is checked against its sha256, the member the row names is
# unpacked, and the program is installed at its path only when the installed one is not the pinned bytes (binary_sha256).
printf '%s' "$SET_UP" | jq -r '(.downloads // [])[] | .path' | while read -r path; do
  kind=$(uname -m)
  row() { printf '%s' "$SET_UP" | jq -r --arg path "$path" --arg kind "$kind" ".downloads[] | select(.path == \$path) | .files[\$kind].$1 // empty"; }
  url=$(row url); want=$(row sha256); member=$(row member); binary=$(row binary_sha256)
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
printf '%s' "$LAYOUT" | jq -e '.units | type == "array"' >/dev/null || { echo "The layout row needs a units list." >&2; exit 2; }
printf '%s' "$LAYOUT" | jq -r '[.units[] | .node_bin // empty] | unique[]' | while read -r bin; do
  [ -x "$bin/node" ] && continue
  kind=$(uname -m)
  url=$(printf '%s' "$SET_UP" | jq -r --arg kind "$kind" '.node.files[$kind].url // empty')
  want=$(printf '%s' "$SET_UP" | jq -r --arg kind "$kind" '.node.files[$kind].sha256 // empty')
  [ -n "$url" ] && [ -n "$want" ] || { echo "The set-up data has no node release for $kind." >&2; exit 4; }
  download=$(mktemp)
  curl -fsSL -o "$download" "$url"
  [ "$(sha256sum "$download" | cut -d ' ' -f 1)" = "$want" ] || { rm -f "$download"; echo "The node download for $kind does not match its sha256." >&2; exit 5; }
  mkdir -p "$(dirname "$bin")"
  tar -xzf "$download" -C "$(dirname "$bin")" --strip-components=1
  rm -f "$download"
done
printf '%s' "$LAYOUT" | jq -r '.units[] | [.user, (.state // ((.config // "") | sub("/[^/]+$"; ""))), (.releases // ""), (.key_file // "")] | @tsv' | while IFS="$(printf '\t')" read -r user state releases key; do
  [ -n "$state" ] || { echo "Unit user $user needs state or config in the layout row." >&2; exit 2; }
  id -u "$user" >/dev/null 2>&1 || useradd --system --home-dir "$state" --create-home --shell /usr/sbin/nologin "$user"
  install -d -o "$user" -g "$user" -m 0700 "$state"
  [ -z "$releases" ] || install -d -o "$user" -g "$user" -m 0755 "$releases"
  if [ -n "$key" ] && [ ! -s "$key" ]; then
    head -c 32 /dev/urandom | base64 -w0 | install -o "$user" -g "$user" -m 0400 /dev/stdin "$key"
  fi
done
# The folders a unit names (`folders`) that its program needs and does not make itself, such as an engine's accounts folder.
printf '%s' "$LAYOUT" | jq -r '.units[] | .user as $user | (.folders // [])[] | [$user, .] | @tsv' | while IFS="$(printf '\t')" read -r user folder; do
  install -d -o "$user" -g "$user" -m 0700 "$folder"
done
if [ -n "$FRONT_DOOR_CADDY" ]; then
  set -- $FRONT_DOOR_CADDY
  if ! printf '%s  %s\n' "$3" "$1" | sha256sum -c --status 2>/dev/null; then
    install -d -m 0755 "$(dirname "$1")"
    curl -fsSL --max-time 300 -o "$1.new" "$2"
    printf '%s  %s\n' "$3" "$1.new" | sha256sum -c --status || { echo "The Caddy at $2 is not the pinned one." >&2; exit 4; }
    chmod 0755 "$1.new" && mv "$1.new" "$1"
  fi
fi
if printf '%s' "$SET_UP" | jq -e '.firewall_allow | type == "array"' >/dev/null; then
  printf '%s' "$SET_UP" | jq -r '.firewall_allow[]' | while read -r port; do ufw allow "$port" >/dev/null; done
  ufw --force enable >/dev/null
fi
echo "set-up $(uname -m)"
