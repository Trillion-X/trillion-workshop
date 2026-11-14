#!/bin/sh
# tools/start-a-computer/do-work/set-up-the-machine.sh
#
# Runs as root on the machine, sent over SSH on standard input (`ssh root@ADDRESS sh -s -- LAYOUT < this file`). It makes
# the machine ready to run the layout it is given and changes nothing it already made: the packages Caddy, jq and ufw, the
# account and the folders each unit names (its state folder from its config, its releases folder), a key a unit's layout
# names when the key is not there yet, and a firewall that admits SSH, HTTP and HTTPS only. The files a layout renders (the
# Caddy site file, each unit and its drop-ins) are written by apply-layout in start-a-computer.mjs, so this script names no
# path a layout does not give.
#
# LAYOUT is the computer's layout row as JSON (request.host_layout, read at run time). FRONT_DOOR_CADDY, given when the
# layout's caddy row has `front_door`, is "PATH URL SHA256" of this machine's architecture (settings.json caddy_front_door):
# that Caddy is fetched and installed at PATH only when its SHA-256 is SHA256.
set -eu
LAYOUT=$1
FRONT_DOOR_CADDY=${2:-}
command -v apt-get >/dev/null 2>&1 || { echo "This machine has no apt-get; start-a-computer sets up Debian and Ubuntu machines." >&2; exit 3; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy jq ufw >/dev/null
printf '%s' "$LAYOUT" | jq -e '.units | type == "array"' >/dev/null || { echo "The layout row needs a units list." >&2; exit 2; }
printf '%s' "$LAYOUT" | jq -r '.units[] | [.user, (.config | sub("/[^/]+$"; "")), .releases, (.key_file // "")] | @tsv' | while IFS="$(printf '\t')" read -r user state releases key; do
  id -u "$user" >/dev/null 2>&1 || useradd --system --home-dir "$state" --create-home --shell /usr/sbin/nologin "$user"
  install -d -o "$user" -g "$user" -m 0700 "$state"
  install -d -o "$user" -g "$user" -m 0755 "$releases"
  if [ -n "$key" ] && [ ! -s "$key" ]; then
    head -c 32 /dev/urandom | base64 -w0 | install -o "$user" -g "$user" -m 0400 /dev/stdin "$key"
  fi
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
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
echo "set-up $(uname -m)"
