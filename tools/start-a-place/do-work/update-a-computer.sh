#!/bin/sh
# tools/start-a-place/do-work/update-a-computer.sh
#
# Runs as root on a running computer, sent over SSH on standard input (`ssh root@ADDRESS sh -s -- apply ... < this
# file`), by start-a-place.mjs `update`. It brings a computer that set-up-the-machine.sh made to what a new one gets
# now: the product settings file the engine reads since trillion-rust 3b2a4d10 (named by the launch setting
# SETTINGS_ENV), a place config that follows the signed release feed (its `release_feed`), the folder the feed adopts
# releases into writable for the service, and /opt/place/current at a release that knows both. Every file it replaces
# is kept first in BACKUP/old, and the change is put back from there when the service is not active SETTLE seconds
# after its restart (exit 4), or when `rollback BACKUP` is asked (the sign-up page did not answer, or a person asks).
#
# apply BACKUP RELEASE_DIR ENGINE_FILE SETTINGS_ENV SETTINGS_FILE ADOPT_DIR
#   BACKUP/new/place.json and BACKUP/new/product-settings.json are already there (start-a-place.mjs writes them first).
# rollback BACKUP
#
# ROOT (empty on a machine) is put before every path, so the tests run this on a made-up computer folder; PLACE_USER
# (place) owns what the service reads; SETTLE (5) is how long the service must stay active.
set -eu
ROOT=${ROOT:-} PLACE_USER=${PLACE_USER:-place} SETTLE=${SETTLE:-5}
MODE=${1:-} BACKUP=${2:-}
case "$BACKUP" in /*) ;; *) echo "BACKUP must be an absolute folder." >&2; exit 2 ;; esac
PLACE=$ROOT/var/lib/place UNIT=$ROOT/etc/systemd/system/place.service CURRENT=$ROOT/opt/place/current
B=$ROOT$BACKUP GROUP=$(id -gn "$PLACE_USER")

restart() {
  systemctl daemon-reload && systemctl restart place.service && sleep "$SETTLE" && systemctl is-active --quiet place.service
}

put_back() {
  [ -d "$B/old" ] || { echo "No backup at $BACKUP." >&2; exit 2; }
  install -o "$PLACE_USER" -g "$GROUP" -m 0600 "$B/old/place.json" "$PLACE/place.json"
  SETTINGS=$(cat "$B/old/settings.path")
  if [ -f "$B/old/product-settings.json" ]; then
    install -o "$PLACE_USER" -g "$GROUP" -m 0600 "$B/old/product-settings.json" "$ROOT$SETTINGS"
  else
    rm -f "$ROOT$SETTINGS"
  fi
  install -m 0644 "$B/old/place.service" "$UNIT"
  ln -sfn "$(cat "$B/old/current.link")" "$CURRENT.new" && mv -T "$CURRENT.new" "$CURRENT"
  if restart; then echo "rolled-back $BACKUP"; else echo "rolled-back $BACKUP; the service is still not active" >&2; fi
}

if [ "$MODE" = rollback ]; then
  put_back
  exit 0
fi
[ "$MODE" = apply ] || { echo "usage: update-a-computer.sh apply BACKUP RELEASE_DIR ENGINE_FILE SETTINGS_ENV SETTINGS_FILE ADOPT_DIR | rollback BACKUP" >&2; exit 2; }
RELEASE_DIR=$3 ENGINE_FILE=$4 SETTINGS_ENV=$5 SETTINGS_FILE=$6 ADOPT_DIR=$7
for path in "$RELEASE_DIR" "$SETTINGS_FILE" "$ADOPT_DIR"; do
  case "$path" in /*) ;; *) echo "Each folder and file must be an absolute path, not $path." >&2; exit 2 ;; esac
done
case "$SETTINGS_ENV" in *[!A-Z0-9_]*|'') echo "The launch setting must be capitals, digits and underscores." >&2; exit 2 ;; esac
test -x "$ROOT$RELEASE_DIR/$ENGINE_FILE" || { echo "The release $RELEASE_DIR has no $ENGINE_FILE." >&2; exit 2; }
test -f "$B/new/place.json" && test -f "$B/new/product-settings.json" || { echo "Nothing is staged in $BACKUP/new." >&2; exit 2; }
test -f "$PLACE/place.json" && test -f "$UNIT" && test -L "$CURRENT" || { echo "This machine has no place to update (place.json, place.service, /opt/place/current)." >&2; exit 3; }
test ! -e "$B/old" || { echo "$BACKUP already holds an update." >&2; exit 2; }

# The backup: every file this changes, and where /opt/place/current pointed.
install -d -m 0700 "$B/old"
cp -p "$PLACE/place.json" "$B/old/place.json"
cp -p "$UNIT" "$B/old/place.service"
readlink "$CURRENT" > "$B/old/current.link"
printf '%s\n' "$SETTINGS_FILE" > "$B/old/settings.path"
if [ -f "$ROOT$SETTINGS_FILE" ]; then cp -p "$ROOT$SETTINGS_FILE" "$B/old/product-settings.json"; fi

apply() {
  install -o "$PLACE_USER" -g "$GROUP" -m 0600 "$B/new/product-settings.json" "$ROOT$SETTINGS_FILE" &&
  install -o "$PLACE_USER" -g "$GROUP" -m 0600 "$B/new/place.json" "$PLACE/place.json" || return 1
  WRITABLE=
  case "$ADOPT_DIR" in /var/lib/place|/var/lib/place/*) ;; *)
    install -d -o "$PLACE_USER" -g "$PLACE_USER" -m 0755 "$ROOT$ADOPT_DIR" || return 1
    WRITABLE=$ADOPT_DIR ;;
  esac
  # The unit: one Environment= line naming the product settings (an older one for the same setting is dropped), right
  # after [Service], and the adopt folder added to ReadWritePaths (the service runs with ProtectSystem=strict).
  HAS_RW=$(grep -c '^ReadWritePaths=' "$UNIT" || true)
  awk -v env="Environment=$SETTINGS_ENV=$SETTINGS_FILE" -v name="Environment=$SETTINGS_ENV=" -v adopt="$WRITABLE" -v has_rw="$HAS_RW" '
    index($0, name) == 1 { next }
    /^ReadWritePaths=/ && adopt != "" {
      n = split(substr($0, 16), paths, " "); found = 0
      for (i = 1; i <= n; i++) if (paths[i] == adopt) found = 1
      if (!found) $0 = $0 " " adopt
    }
    { print }
    /^\[Service\]$/ { print env; if (adopt != "" && has_rw == 0) print "ReadWritePaths=/var/lib/place " adopt }
  ' "$B/old/place.service" > "$UNIT.new" && install -m 0644 "$UNIT.new" "$UNIT" && rm -f "$UNIT.new" || return 1
  ln -sfn "$RELEASE_DIR" "$CURRENT.new" && mv -T "$CURRENT.new" "$CURRENT" || return 1
  restart
}

if apply; then
  echo "updated $BACKUP $(readlink "$CURRENT")"
else
  echo "The service was not active after the update; putting $BACKUP back." >&2
  put_back >&2
  exit 4
fi
