#!/bin/bash
# tools/workflows/build-wf.sh
#
# Builds wf (the workflow host: tools/workflow-host, its own package that depends on the engine crates by path) from the
# Workshop's origin/main, into WF_HOME/build. It installs nothing: the swap into the folder wf runs from is the host's installer,
# which copies the binary beside the installed one and renames it over in one step (a running wf call keeps its file).
#   WF_HOME                      the folder the build works in (WF_HOME/build)
#   WF_WORKSHOP                  the Workshop checkout whose origin/main is built
#   WF_INSTALLER                 optional: the host installer, named in the printed command (its usage: BINARY COMMIT)
#   WF_CONTENT_CRYPTO_CHECKOUT   a trillion-rust checkout (it holds crates/content-crypto; the package reads it by a relative path)
#
# Prints the Workshop commit built, and the installer command that installs it.
set -euo pipefail
: "${WF_HOME:?set WF_HOME to the folder the build works in}"
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
echo "built $TARGET/release/wf from Workshop main $TIP at $(date '+%-I:%M %p %Z')"
echo "to install: ${WF_INSTALLER:-the host installer} $TARGET/release/wf $TIP"
