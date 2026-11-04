#!/bin/sh
# tools/start-a-place/do-work/set-up-the-machine.sh
#
# Runs as root on the machine, sent over SSH on standard input (`ssh root@ADDRESS sh -s -- ARGS < this file`). It
# makes the machine ready to keep accounts and changes nothing it already made: a system user `place` that owns
# /var/lib/place (accounts, place key, place config), Caddy answering HOST_NAME with its own certificate and passing
# to the engine on 127.0.0.1:PORT, and a firewall that admits SSH, HTTP and HTTPS only. The `place` service unit is
# written by start-a-place.mjs (`placeUnit`), the same unit its update step writes on a running computer. The engine's
# file and data folder are arguments; this script names no engine. Debian and Ubuntu (apt) are supported; another
# system stops here with exit 3.
#
# ADOPT_DIR, when given, is the folder the engine adopts releases from its signed feed into (release_feed.releases,
# engine job J1). It is made the place user's; the service runs with ProtectSystem=strict, so a folder outside
# /var/lib/place is added to the unit's ReadWritePaths (`placeUnit`).
#
# usage: set-up-the-machine.sh HOST_NAME PORT ENGINE_FILE DATA_ENV DATA_DIR [ADOPT_DIR]
set -eu
HOST_NAME=$1 PORT=$2 ENGINE_FILE=$3 DATA_ENV=$4 DATA_DIR=$5 ADOPT_DIR=${6:-}
command -v apt-get >/dev/null 2>&1 || { echo "This machine has no apt-get; start-a-place sets up Debian and Ubuntu machines." >&2; exit 3; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy jq ufw >/dev/null
id -u place >/dev/null 2>&1 || useradd --system --home-dir /var/lib/place --create-home --shell /usr/sbin/nologin place
install -d -o place -g place -m 0700 /var/lib/place /var/lib/place/accounts
test -s /var/lib/place/place.key || head -c 32 /dev/urandom | base64 -w0 | install -o place -g place -m 0400 /dev/stdin /var/lib/place/place.key
install -d -m 0755 /opt/place /opt/place/releases
if [ -n "$ADOPT_DIR" ]; then
  case "$ADOPT_DIR" in
    /*) ;;
    *) echo "The adopt folder must be an absolute path, not $ADOPT_DIR." >&2; exit 2 ;;
  esac
  install -d -o place -g place -m 0755 "$ADOPT_DIR"
fi
printf '%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$HOST_NAME" "$PORT" | install -m 0644 /dev/stdin /etc/caddy/Caddyfile
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
systemctl restart caddy
systemctl daemon-reload
echo "set-up $HOST_NAME $(uname -m)"
