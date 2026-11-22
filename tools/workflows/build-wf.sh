#!/bin/bash
# tools/workflows/build-wf.sh
#
# Builds wf (the workflow host: tools/workflow-host, its own package that depends on the engine crates by path) from the
# Workshop's origin/main and installs it as $WF_HOME/bin/wf. The source comes from origin/main, never from a working copy, so a
# build is the landed code. The build folder is overwritten in place, never deleted; the binary it replaces is kept as
# bin/wf.before-<time>.
#   WF_HOME                      the folder wf runs from: its bin folder receives the binary, and wf.json and runs live beside it
#   WF_WORKSHOP                  the Workshop checkout whose origin/main is built
#   WF_CONTENT_CRYPTO_CHECKOUT   a trillion-rust checkout (it holds crates/content-crypto; the package reads it by a relative path)
#   WF_NO_INSTALL                set to build only: the binary stays in the build folder and bin/ is not touched
#
# Prints the Workshop commit built; wf.built-from in bin/ keeps it beside the binary.
set -euo pipefail
: "${WF_HOME:?set WF_HOME to the folder wf runs from}"
: "${WF_WORKSHOP:?set WF_WORKSHOP to the Workshop checkout}"
: "${WF_CONTENT_CRYPTO_CHECKOUT:?set WF_CONTENT_CRYPTO_CHECKOUT to a trillion-rust checkout}"
R="$WF_HOME/build"
mkdir -p "$R/ws"
git -C "$WF_WORKSHOP" fetch -q origin
TIP=$(git -C "$WF_WORKSHOP" rev-parse --short=9 origin/main)
git -C "$WF_WORKSHOP" archive "$TIP" tools/workflow-host tools/workflows/crates tools/shared-code | tar -x -C "$R/ws"
# The package reads content-crypto from the trillion-rust checkout beside its tree (../../../trillion-rust): that checkout is linked there.
ln -sfn "$WF_CONTENT_CRYPTO_CHECKOUT" "$R/trillion-rust"
PKG="$R/ws/tools/workflow-host"
TARGET="${CARGO_TARGET_DIR:-$R/target}"
cd "$PKG"
CARGO_TARGET_DIR="$TARGET" cargo build -q --release
if [ -n "${WF_NO_INSTALL:-}" ]; then
  echo "built $TARGET/release/wf from Workshop main $TIP, not installed"
  exit 0
fi
mkdir -p "$WF_HOME/bin"
[ -x "$WF_HOME/bin/wf" ] && cp -p "$WF_HOME/bin/wf" "$WF_HOME/bin/wf.before-$(date +%Y%m%d-%H%M%S)"
cp "$TARGET/release/wf" "$WF_HOME/bin/wf"
echo "$TIP" > "$WF_HOME/bin/wf.built-from"
echo "built wf from Workshop main $TIP at $(date '+%-I:%M %p %Z')"
