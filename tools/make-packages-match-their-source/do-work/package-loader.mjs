#!/bin/bash
set -euo pipefail

# Executable compatibility path for callers that select this loader. Resolve the loader built
# beside the caller-selected package set; do not name a user, app, provider, or fixed checkout.
package_set_folder=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "--package-set-folder" ]]; then
    package_set_folder="$argument"
    break
  fi
  previous="$argument"
done

if [[ -z "$package_set_folder" ]]; then
  echo "--package-set-folder is required" >&2
  exit 2
fi

workspace_folder="$(dirname "$package_set_folder")"
package_loader_binary="$workspace_folder/bitfield-runtime-kit/target/release/package-loader"
if [[ ! -x "$package_loader_binary" ]]; then
  echo "PACKAGE_LOADER_BINARY_MISSING:$package_loader_binary" >&2
  exit 2
fi

exec "$package_loader_binary" "$@"
