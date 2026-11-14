#!/bin/sh
# tools/start-a-computer/do-work/keep-the-layout.sh
#
# Runs as root on a computer, from keep-the-layout.timer (the layout row's `keep_layout.every`). A computer changes only from
# its layout row: start-a-computer renders the row and writes every file it declares, together with the list of those files
# (MANIFEST, settings.json keep_layout.manifest: each file's path, sha256, bytes, mode, owner, the unit it belongs to and how
# the Caddy file is validated). This script compares each listed file with the computer and, for each one that differs, is
# missing, or is a drop-in the row does not declare, first appends a difference row to ROWS (settings.json
# keep_layout.rows: one JSON object per line naming the file, why it differs and what changed), then puts the row's bytes
# back, keeping the computer's bytes beside it as NAME.differed-STAMP (an undeclared drop-in is moved out of the unit's
# folder into the HELD folder). Only what changed is reloaded: systemd reloads its units once, each unit whose file changed
# restarts, and Caddy reloads when only its site file changed.
#
# KEEP_ROOT prefixes every path (empty on a computer); the tests run the script on a folder.
set -eu
ROOT=${KEEP_ROOT:-}
MANIFEST=$ROOT${KEEP_MANIFEST:-/etc/start-a-computer/layout-files.json}
[ -s "$MANIFEST" ] || { echo "keep-the-layout: no layout files list at $MANIFEST" >&2; exit 2; }
ROWS=$ROOT$(jq -r '.rows' "$MANIFEST")
HELD=$ROOT$(jq -r '.held' "$MANIFEST")
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
: > "$work/restart"
: > "$work/reload"
install -d -m 0700 "$(dirname "$ROWS")" "$HELD"

# One difference row, written before anything is put back. $3 is the file holding the computer's bytes (or empty when
# absent), $4 the file holding the row's bytes (or empty when the row declares none).
row() {
  path=$1 reason=$2 live=$3 want=$4
  changed=$(diff -u --label "computer $path" --label "layout row $path" "${live:-/dev/null}" "${want:-/dev/null}" | head -n 200 || true)
  live_sha=$([ -n "$live" ] && sha256sum "$live" | cut -d ' ' -f 1 || echo "")
  jq -cn --arg at "$STAMP" --arg path "$path" --arg reason "$reason" --arg changed "$changed" --arg live "$live_sha" \
    --arg want "$([ -n "$want" ] && sha256sum "$want" | cut -d ' ' -f 1 || echo "")" \
    '{at: $at, path: $path, reason: $reason, changed: $changed, computer_sha256: (if $live == "" then null else $live end), layout_sha256: (if $want == "" then null else $want end), put_back: true}' >> "$ROWS"
  chmod 0600 "$ROWS"
  echo "keep-the-layout: $path $reason; put back"
}

jq -c '.files[]' "$MANIFEST" | while read -r entry; do
  path=$(printf '%s' "$entry" | jq -r '.path')
  at=$ROOT$path
  printf '%s' "$entry" | jq -r '.text_base64' | base64 -d > "$work/want"
  want_sha=$(printf '%s' "$entry" | jq -r '.sha256')
  [ "$(sha256sum "$work/want" | cut -d ' ' -f 1)" = "$want_sha" ] || { echo "keep-the-layout: the list's bytes for $path are not its sha256" >&2; exit 4; }
  if [ -f "$at" ]; then
    [ "$(sha256sum "$at" | cut -d ' ' -f 1)" = "$want_sha" ] && continue
    row "$path" 'differs from the layout' "$at" "$work/want"
    cp -p "$at" "$at.differed-$STAMP"
  else
    row "$path" 'missing on the computer' '' "$work/want"
  fi
  mode=$(printf '%s' "$entry" | jq -r '.mode')
  owner=$(printf '%s' "$entry" | jq -r '.owner')
  validate=$(printf '%s' "$entry" | jq -r '.validate // empty')
  install -d -m 0755 "$(dirname "$at")"
  install -m "$mode" "$work/want" "$at.new"
  chown "$owner:$owner" "$at.new"
  if [ -n "$validate" ]; then
    sh -c "$validate validate --config \"\$1\" --adapter caddyfile >/dev/null" keep "$at.new" || { rm -f "$at.new"; echo "keep-the-layout: the row's $path does not validate; left as it is" >&2; exit 5; }
    echo caddy >> "$work/reload"
  fi
  mv "$at.new" "$at"
  unit=$(printf '%s' "$entry" | jq -r '.unit // empty')
  [ -z "$unit" ] || echo "$unit" >> "$work/restart"
  case "$path" in /etc/systemd/system/*) echo daemon >> "$work/reload" ;; esac
done

# A drop-in the row does not declare changes a unit the row does; it is moved out, so the unit runs as its row says.
jq -r '.units[] | [.unit, (.drop_ins | join(" "))] | @tsv' "$MANIFEST" | while IFS="$(printf '\t')" read -r unit drop_ins; do
  dir=$ROOT/etc/systemd/system/$unit.d
  [ -d "$dir" ] || continue
  for file in "$dir"/*; do
    [ -e "$file" ] || continue
    name=$(basename "$file")
    case " $drop_ins " in *" ${name%.conf} "*) [ "${name%.conf}.conf" = "$name" ] && continue ;; esac
    row "/etc/systemd/system/$unit.d/$name" 'not in the layout' "$file" ''
    mv "$file" "$HELD/$STAMP-$unit.d-$name"
    echo "$unit" >> "$work/restart"
    echo daemon >> "$work/reload"
  done
done

if grep -qx daemon "$work/reload"; then systemctl daemon-reload; fi
for unit in $(sort -u "$work/restart"); do
  case "$unit" in
    keep-the-layout.service) ;;
    keep-the-layout.timer) systemctl restart keep-the-layout.timer ;;
    *) systemctl restart "$unit" ;;
  esac
done
if grep -qx caddy "$work/reload" && ! grep -qx caddy.service "$work/restart"; then systemctl reload caddy; fi
