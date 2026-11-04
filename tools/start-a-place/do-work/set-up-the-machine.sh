#!/bin/sh
# tools/start-a-place/do-work/set-up-the-machine.sh
#
# Runs as root on the machine, sent over SSH on standard input (`ssh root@ADDRESS sh -s -- ARGS < this file`). It
# makes the machine ready to keep accounts and changes nothing it already made: a system user `place` that owns
# /var/lib/place (accounts, place key, place config), Caddy answering HOST_NAME with its own certificate and passing
# to the engine on 127.0.0.1:PORT, a firewall that admits SSH, HTTP and HTTPS only, and a `place` service that runs
# the release /opt/place/current points at. The engine's file and data folder are arguments; this script names no
# engine. Debian and Ubuntu (apt) are supported; another system stops here with exit 3.
#
# usage: set-up-the-machine.sh HOST_NAME PORT ENGINE_FILE DATA_ENV DATA_DIR
set -eu
HOST_NAME=$1 PORT=$2 ENGINE_FILE=$3 DATA_ENV=$4 DATA_DIR=$5
command -v apt-get >/dev/null 2>&1 || { echo "This machine has no apt-get; start-a-place sets up Debian and Ubuntu machines." >&2; exit 3; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy jq ufw >/dev/null
id -u place >/dev/null 2>&1 || useradd --system --home-dir /var/lib/place --create-home --shell /usr/sbin/nologin place
install -d -o place -g place -m 0700 /var/lib/place /var/lib/place/accounts
test -s /var/lib/place/place.key || head -c 32 /dev/urandom | base64 -w0 | install -o place -g place -m 0400 /dev/stdin /var/lib/place/place.key
install -d -m 0755 /opt/place /opt/place/releases
printf '%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$HOST_NAME" "$PORT" | install -m 0644 /dev/stdin /etc/caddy/Caddyfile
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
systemctl restart caddy
# The release folder is resolved once at start, so a release swap is one pointer move and a restart.
cat <<UNIT | install -m 0644 /dev/stdin /etc/systemd/system/place.service
[Unit]
Description=A place that keeps accounts ($HOST_NAME)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=place
Group=place
WorkingDirectory=/var/lib/place
ExecStart=/bin/sh -c 'R=\$(readlink -f /opt/place/current) && exec env $DATA_ENV="\$R/$DATA_DIR" "\$R/$ENGINE_FILE" serve /var/lib/place/place.json'
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/place
ProtectHome=true
PrivateTmp=true
LimitCORE=0

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
echo "set-up $HOST_NAME $(uname -m)"
