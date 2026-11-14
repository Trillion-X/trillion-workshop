#!/bin/sh
# tools/start-a-computer/do-work/set-up-the-machine.sh
#
# Runs as root on the machine, sent over SSH on standard input (`ssh root@ADDRESS sh -s -- LAYOUT SET_UP < this file`). It
# makes the machine ready to run the layout it is given and changes nothing it already made: the packages the set-up data
# names, the node release it names for this machine kind in each unit's node_bin folder that has no node yet (checked against
# its sha256 before anything is unpacked), the account and the folders each unit names (its state folder, from its config
# when it has one, its releases folder when it has one), a key a unit's layout names when the key is not there yet, and a
# firewall that admits only the set-up data's firewall_allow ports (none is set up when it is null). The files a layout renders (the
# Caddy site file, each unit and its drop-ins) are written by apply-layout in start-a-computer.mjs, so this script names no
# path a layout does not give.
#
# LAYOUT is the computer's layout row as JSON (request.host_layout, read at run time); SET_UP is settings.json `machine` with the layout row's own `machine` fields over it.
# FRONT_DOOR_CADDY, given when the layout's caddy row has `front_door`, is "PATH URL SHA256" of this machine's architecture
# (settings.json caddy_front_door): that Caddy is fetched and installed at PATH only when its SHA-256 is SHA256.
set -eu
LAYOUT=$1
SET_UP=$2
FRONT_DOOR_CADDY=${3:-}
command -v apt-get >/dev/null 2>&1 || { echo "This machine has no apt-get; start-a-computer sets up Debian and Ubuntu machines." >&2; exit 3; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
command -v jq >/dev/null 2>&1 || apt-get install -y -qq jq >/dev/null
apt-get install -y -qq $(printf '%s' "$SET_UP" | jq -r '.packages | join(" ")') >/dev/null
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
