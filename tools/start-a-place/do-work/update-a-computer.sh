#!/bin/sh
# tools/start-a-place/do-work/update-a-computer.sh
#
# Runs as root on a computer that already serves (`ssh root@ADDRESS sh -s -- ARGS < this file`), after start-a-place.mjs
# staged the new place config, service unit and product settings file in BACKUPS/STAMP/new/ (`updateAComputer`).
#
#   apply     keeps each of the three files as it is now in BACKUPS/STAMP/old/ (a file that is not there is kept as
#             NAME.absent), makes the releases folder the place user's, installs the staged files, reloads systemd,
#             restarts place.service, waits SETTLE seconds and reads whether it is active. If it is not, or any step
#             fails, it puts the old files back, restarts, and exits 4: the computer runs as it did before.
#   rollback  puts BACKUPS/STAMP/old/ back the same way and restarts (used when the check from outside fails, or by hand).
#
# The paths are arguments (start-a-place's read-data/settings.json `computer`); PLACE_ROOT, empty on a computer, is put
# in front of each so the tests run this on a made-up computer folder. This script names no engine and no product.
#
# usage: update-a-computer.sh apply|rollback STAMP CONFIG UNIT PRODUCT_SETTINGS BACKUPS RELEASES SETTLE_SECONDS
set -eu
OP=$1 STAMP=$2 CONFIG=$3 UNIT=$4 PRODUCT=$5 BACKUPS=$6 RELEASES=$7 SETTLE=$8
ROOT=${PLACE_ROOT:-}
case "$STAMP" in *[!A-Za-z0-9._-]*|'') echo "The stamp must be letters, digits, dot, dash or underscore." >&2; exit 2 ;; esac
B="$ROOT$BACKUPS/$STAMP"

restore() {
  for f in "$CONFIG" "$UNIT" "$PRODUCT"; do
    name=$(basename "$f")
    if [ -e "$B/old/$name.absent" ]; then rm -f "$ROOT$f"
    elif [ -e "$B/old/$name" ]; then cp -p "$B/old/$name" "$ROOT$f"
    fi
  done
  systemctl daemon-reload
  systemctl restart place.service || true
}

active() {
  sleep "$SETTLE"
  systemctl is-active --quiet place.service
}

case "$OP" in
  apply)
    [ -d "$B/new" ] || { echo "Nothing is staged in $B/new." >&2; exit 2; }
    [ ! -e "$B/old" ] || { echo "$B/old is already there: this stamp was applied once." >&2; exit 2; }
    install -d -m 0700 "$B/old"
    for f in "$CONFIG" "$UNIT" "$PRODUCT"; do
      name=$(basename "$f")
      if [ -e "$ROOT$f" ]; then cp -p "$ROOT$f" "$B/old/$name"; else : > "$B/old/$name.absent"; fi
    done
    # One && chain: `set -e` does not hold inside an `if` condition.
    if install -d -m 0700 "$ROOT$RELEASES" && chown place:place "$ROOT$RELEASES" \
      && install -d -m 0755 "$(dirname "$ROOT$PRODUCT")" \
      && install -m 0644 "$B/new/$(basename "$PRODUCT")" "$ROOT$PRODUCT" \
      && install -m 0600 "$B/new/$(basename "$CONFIG")" "$ROOT$CONFIG" && chown place:place "$ROOT$CONFIG" \
      && install -m 0644 "$B/new/$(basename "$UNIT")" "$ROOT$UNIT" \
      && systemctl daemon-reload \
      && systemctl restart place.service \
      && active; then
      echo "applied $STAMP"
    else
      restore
      if active; then echo "The update did not start; the old files are back and place.service is active again ($B/old)." >&2
      else echo "The update did not start; the old files are back but place.service is not active ($B/old)." >&2; fi
      exit 4
    fi
    ;;
  rollback)
    [ -d "$B/old" ] || { echo "No backup in $B/old." >&2; exit 2; }
    restore
    active || { echo "The old files are back but place.service is not active ($B/old)." >&2; exit 4; }
    echo "rolled-back $STAMP"
    ;;
  *) echo "usage: update-a-computer.sh apply|rollback STAMP CONFIG UNIT PRODUCT_SETTINGS BACKUPS RELEASES SETTLE_SECONDS" >&2; exit 2 ;;
esac
