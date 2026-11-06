#!/bin/sh
# tools/publish-an-engine-release/do-work/set-up-darwin-builds.sh
#
# Runs as root on the builder after set-up-the-builder.sh, sent over SSH on standard input, only when install's
# request names `darwin`: what the builder needs to cross-build the engine for a Mac from Linux and sign it Developer
# ID itself. zig (the C, C++ and linker for the Mac target; the ziglang wheel from PyPI, pinned by version and this
# machine's sha256, in a venv), cargo-zigbuild and rcodesign (apple-codesign) built at pinned versions for the
# builder user, and each Mac target's rust standard library. It changes nothing it already made. The macOS SDK and the
# Developer ID identity are not fetched here: install sends the SDK from the person's computer and stores the
# identity as encrypted service credentials. Versions and folders are arguments; this script names no machine.
#
# usage: set-up-darwin-builds.sh USER HOME ZIG_FOLDER ZIG_VERSION ZIG_SHA256_X86_64 ZIG_SHA256_AARCH64 CARGO_ZIGBUILD APPLE_CODESIGN TARGET...
set -eu
BUILD_USER=$1 BUILD_HOME=$2 ZIG_FOLDER=$3 ZIG_VERSION=$4 SHA_X86_64=$5 SHA_AARCH64=$6 CARGO_ZIGBUILD=$7 APPLE_CODESIGN=$8
shift 8
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq python3 python3-venv >/dev/null
case "$(uname -m)" in x86_64) SHA=$SHA_X86_64 ;; aarch64) SHA=$SHA_AARCH64 ;; *) echo "No pinned zig for $(uname -m)." >&2; exit 3 ;; esac
if [ "$("$ZIG_FOLDER/bin/python3" -m ziglang version 2>/dev/null || true)" != "$ZIG_VERSION" ]; then
  rm -rf "$ZIG_FOLDER"
  python3 -m venv "$ZIG_FOLDER"
  TMP=$(mktemp -d)
  printf 'ziglang==%s --hash=sha256:%s\n' "$ZIG_VERSION" "$SHA" > "$TMP/requirements.txt"
  "$ZIG_FOLDER/bin/pip" install -q --no-deps --only-binary :all: --require-hashes -r "$TMP/requirements.txt"
  rm -rf "$TMP"
fi
chmod -R a+rX,go-w "$ZIG_FOLDER"
as_builder() { runuser -u "$BUILD_USER" -- env HOME="$BUILD_HOME" PATH="$BUILD_HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }
installed() { as_builder cargo install --list | grep -Fqx "$1 v$2:"; }
installed cargo-zigbuild "$CARGO_ZIGBUILD" || as_builder cargo install --locked --quiet cargo-zigbuild --version "=$CARGO_ZIGBUILD"
installed apple-codesign "$APPLE_CODESIGN" || as_builder cargo install --locked --quiet apple-codesign --version "=$APPLE_CODESIGN" --bin rcodesign
for TARGET in "$@"; do as_builder rustup target add "$TARGET" >/dev/null; done
echo "darwin builds: zig $("$ZIG_FOLDER/bin/python3" -m ziglang version), $(as_builder cargo-zigbuild --version), $(as_builder rcodesign --version), $*"
