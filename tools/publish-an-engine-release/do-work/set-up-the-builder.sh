#!/bin/sh
# tools/publish-an-engine-release/do-work/set-up-the-builder.sh
#
# Runs as root on the builder, sent over SSH on standard input (`ssh root@ADDRESS sh -s -- ARGS < this file`). It
# makes the machine ready to build, sign and serve engine releases and changes nothing it already made: a system user
# that builds and signs, git and a C toolchain, Node.js (from the official build, checked against its SHASUMS256.txt,
# when the machine has none new enough), rust through rustup for that user (the repository's own toolchain file picks
# the version), the feed folder, Caddy answering HOST_NAME with its own certificate (the feed folder at FEED_PATH, push
# deliveries at PUSH_PATH passed to the receiver on 127.0.0.1:PORT), and a firewall that admits SSH, HTTP and HTTPS.
# Debian and Ubuntu (apt) with systemd 250 or later (encrypted service credentials) are supported; another system
# stops here with exit 3. Names and folders are arguments; this script names no repository and no machine.
#
# usage: set-up-the-builder.sh HOST_NAME PORT FEED_PATH PUSH_PATH USER HOME FEED_FOLDER STATE_FOLDER NODE_MAJOR NODE_DIST RUSTUP_URL
set -eu
HOST_NAME=$1 PORT=$2 FEED_PATH=$3 PUSH_PATH=$4 BUILD_USER=$5 BUILD_HOME=$6 FEED_FOLDER=$7 STATE_FOLDER=$8 NODE_MAJOR=$9
shift 9
NODE_DIST=$1 RUSTUP_URL=$2
command -v apt-get >/dev/null 2>&1 || { echo "This machine has no apt-get; the builder setup supports Debian and Ubuntu." >&2; exit 3; }
SYSTEMD=$(systemctl --version | sed -n '1s/^systemd \([0-9]*\).*/\1/p')
[ "${SYSTEMD:-0}" -ge 250 ] || { echo "This machine's systemd ($SYSTEMD) is older than 250, which keeps the push secret encrypted: use Debian 12 or Ubuntu 24.04 or later." >&2; exit 3; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy git curl ca-certificates build-essential pkg-config xz-utils tar ufw >/dev/null

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) echo "No Node.js build for $(uname -m)." >&2; exit 3 ;; esac
  TMP=$(mktemp -d)
  curl -fsSL "${NODE_DIST}SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE=$(grep -o "node-v[0-9.]*-linux-$ARCH\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)
  curl -fsSL "$NODE_DIST$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c --quiet -)
  tar -C /usr/local --strip-components=1 -xJf "$TMP/$FILE"
  rm -rf "$TMP"
  hash -r
fi

id -u "$BUILD_USER" >/dev/null 2>&1 || useradd --system --home-dir "$BUILD_HOME" --create-home --shell /usr/sbin/nologin "$BUILD_USER"
install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 0700 "$BUILD_HOME" "$BUILD_HOME/work" "$STATE_FOLDER"
install -d -m 0755 "$(dirname "$FEED_FOLDER")"
install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 0755 "$FEED_FOLDER"
[ -s "$FEED_FOLDER/feed.json" ] || printf '{\n "releases": []\n}\n' | runuser -u "$BUILD_USER" -- tee "$FEED_FOLDER/feed.json" >/dev/null
if [ ! -x "$BUILD_HOME/.cargo/bin/cargo" ]; then
  curl -fsSL "$RUSTUP_URL" -o /tmp/rustup-init.sh
  runuser -u "$BUILD_USER" -- env HOME="$BUILD_HOME" sh /tmp/rustup-init.sh -y -q --profile minimal --no-modify-path >/dev/null
  rm -f /tmp/rustup-init.sh
fi

printf '%s {\n\tencode zstd gzip\n\thandle %s {\n\t\treverse_proxy 127.0.0.1:%s\n\t}\n\thandle_path %s* {\n\t\troot * %s\n\t\theader /feed.json Cache-Control "no-cache"\n\t\tfile_server\n\t}\n\trespond 404\n}\n' \
  "$HOST_NAME" "$PUSH_PATH" "$PORT" "$FEED_PATH" "$FEED_FOLDER" | install -m 0644 /dev/stdin /etc/caddy/Caddyfile
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
systemctl restart caddy
echo "set-up $HOST_NAME $(uname -m) node $(node -v)"
