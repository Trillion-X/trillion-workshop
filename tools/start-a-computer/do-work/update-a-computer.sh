#!/bin/sh
# tools/start-a-computer/do-work/update-a-computer.sh
#
# Runs as root on a running computer, sent over SSH on standard input (`ssh root@ADDRESS env ... sh -s -- apply ...
# < this file`), by start-a-computer.mjs `update`. It brings a running computer to what a new one gets now: the product
# settings file the engine reads since trillion-rust 3b2a4d10 (named by the launch setting SETTINGS_ENV), a computer config
# that follows the signed release feed (its `release_feed`) with a copies policy the computer can meet, the folder the
# feed adopts releases into writable for the service, and its `current` link at a release that knows both.
#
# It names no layout: every path is the computer's own, read from its service unit by start-a-computer.mjs (`readLayout`)
# or given by the request, and handed here in the environment:
#   CONFIG   the computer config the unit's `serve` names         UNIT_FILE  the unit's file      UNIT  the unit's name
#   CURRENT  the link the unit starts the engine through       STATE      the folder the service owns
#   OWNER    the user the service runs as (owns CONFIG and the product settings file)
# Every file it replaces is kept first in BACKUP/old, with these paths, and the change is put back from there when the
# service is not active SETTLE seconds after its restart (exit 4), or when `rollback BACKUP` is asked.
#
# apply BACKUP RELEASE_DIR ENGINE_FILE SETTINGS_ENV SETTINGS_FILE ADOPT_DIR
#   BACKUP/new/place.json and BACKUP/new/product-settings.json are already there (start-a-computer.mjs writes them first).
#   RELEASE_DIR is where CURRENT should point: the release just copied, or the one it already names.
# rollback BACKUP
#
# ROOT (empty on a machine) is put before every path, so the tests run this on made-up computer folders.
set -eu
ROOT=${ROOT:-} SETTLE=${SETTLE:-5}
MODE=${1:-} BACKUP=${2:-}
case "$BACKUP" in /*) ;; *) echo "BACKUP must be an absolute folder." >&2; exit 2 ;; esac
B=$ROOT$BACKUP

# The layout: from the environment for apply, from the backup for rollback.
if [ "$MODE" = rollback ]; then
  [ -f "$B/old/layout" ] || { echo "No backup at $BACKUP." >&2; exit 2; }
  layout() { sed -n "s/^$1=//p" "$B/old/layout"; }
  CONFIG=$(layout CONFIG) UNIT_FILE=$(layout UNIT_FILE) UNIT=$(layout UNIT) CURRENT=$(layout CURRENT) STATE=$(layout STATE) OWNER=$(layout OWNER) RELEASES=$(layout RELEASES)
fi
: "${CONFIG:?}" "${UNIT_FILE:?}" "${UNIT:?}" "${CURRENT:?}" "${STATE:?}" "${OWNER:?}"
for path in "$CONFIG" "$UNIT_FILE" "$CURRENT" "$STATE"; do
  case "$path" in /*) ;; *) echo "Each layout path must be absolute, not $path." >&2; exit 2 ;; esac
done
case "$UNIT" in *.service) ;; *) echo "The unit must be a .service name, not $UNIT." >&2; exit 2 ;; esac
GROUP=$(id -gn "$OWNER")

restart() {
  systemctl daemon-reload && systemctl restart "$UNIT" && sleep "$SETTLE" && systemctl is-active --quiet "$UNIT"
}

put_back() {
  install -o "$OWNER" -g "$GROUP" -m 0600 "$B/old/place.json" "$ROOT$CONFIG"
  SETTINGS=$(layout SETTINGS)
  if [ -f "$B/old/product-settings.json" ]; then
    install -o "$OWNER" -g "$GROUP" -m 0600 "$B/old/product-settings.json" "$ROOT$SETTINGS"
  else
    rm -f "$ROOT$SETTINGS"
  fi
  install -m 0644 "$B/old/unit" "$ROOT$UNIT_FILE"
  ln -sfn "$(cat "$B/old/current.link")" "$ROOT$CURRENT.new" && mv -T "$ROOT$CURRENT.new" "$ROOT$CURRENT"
  if [ -n "$RELEASES" ]; then
    if [ -f "$B/old/releases-current.link" ]; then ln -sfn "$(cat "$B/old/releases-current.link")" "$ROOT$RELEASES/current.new" && mv -T "$ROOT$RELEASES/current.new" "$ROOT$RELEASES/current"; else rm -f "$ROOT$RELEASES/current"; fi
  fi
  if restart; then echo "rolled-back $BACKUP"; else echo "rolled-back $BACKUP; $UNIT is still not active" >&2; fi
}

if [ "$MODE" = rollback ]; then
  put_back
  exit 0
fi
[ "$MODE" = apply ] || { echo "usage: update-a-computer.sh apply BACKUP RELEASE_DIR ENGINE_FILE SETTINGS_ENV SETTINGS_FILE ADOPT_DIR | rollback BACKUP" >&2; exit 2; }
RELEASE_DIR=$3 ENGINE_FILE=$4 SETTINGS_ENV=$5 SETTINGS_FILE=$6 ADOPT_DIR=$7
RELEASES=$(dirname "$RELEASE_DIR")
# The bootstrap names the feed the follower takes releases from: FEED_URL (https) and PUBLIC_KEY (64 lowercase hex), from the request.
case "$FEED_URL" in https://*) ;; *) echo "FEED_URL must be an https URL." >&2; exit 2 ;; esac
case "$PUBLIC_KEY" in *[!0-9a-f]*|"") echo "PUBLIC_KEY must be 64 lowercase hex." >&2; exit 2 ;; esac
[ "${#PUBLIC_KEY}" -eq 64 ] || { echo "PUBLIC_KEY must be 64 lowercase hex." >&2; exit 2; }
for path in "$RELEASE_DIR" "$SETTINGS_FILE" "$ADOPT_DIR"; do
  case "$path" in /*) ;; *) echo "Each folder and file must be an absolute path, not $path." >&2; exit 2 ;; esac
done
case "$SETTINGS_ENV" in *[!A-Z0-9_]*|'') echo "The launch setting must be capitals, digits and underscores." >&2; exit 2 ;; esac
test -x "$ROOT$RELEASE_DIR/$ENGINE_FILE" || { echo "The release $RELEASE_DIR has no $ENGINE_FILE." >&2; exit 2; }
test -f "$B/new/place.json" && test -f "$B/new/product-settings.json" || { echo "Nothing is staged in $BACKUP/new." >&2; exit 2; }
test -f "$ROOT$CONFIG" && test -f "$ROOT$UNIT_FILE" && test -L "$ROOT$CURRENT" || { echo "This computer has no $CONFIG, $UNIT_FILE or $CURRENT link to update." >&2; exit 3; }
test ! -e "$B/old" || { echo "$BACKUP already holds an update." >&2; exit 2; }

# The backup: every file this changes, where CURRENT pointed, and the layout it was found in.
install -d -m 0700 "$B/old"
cp -p "$ROOT$CONFIG" "$B/old/place.json"
cp -p "$ROOT$UNIT_FILE" "$B/old/unit"
readlink "$ROOT$CURRENT" > "$B/old/current.link"
if [ -L "$ROOT$RELEASES/current" ]; then readlink "$ROOT$RELEASES/current" > "$B/old/releases-current.link"; fi
printf 'CONFIG=%s\nUNIT_FILE=%s\nUNIT=%s\nCURRENT=%s\nSTATE=%s\nOWNER=%s\nSETTINGS=%s\nRELEASES=%s\n' "$CONFIG" "$UNIT_FILE" "$UNIT" "$CURRENT" "$STATE" "$OWNER" "$SETTINGS_FILE" "$RELEASES" > "$B/old/layout"
layout() { sed -n "s/^$1=//p" "$B/old/layout"; }
if [ -f "$ROOT$SETTINGS_FILE" ]; then cp -p "$ROOT$SETTINGS_FILE" "$B/old/product-settings.json"; fi

apply() {
  install -o "$OWNER" -g "$GROUP" -m 0600 "$B/new/product-settings.json" "$ROOT$SETTINGS_FILE" || return 1
  # The folder the feed adopts releases into: the service's, and writable for it (ProtectSystem=strict), unless it is
  # inside the state folder, which already is.
  WRITABLE=
  case "$ADOPT_DIR" in "$STATE"|"$STATE"/*) ;; *)
    install -d -m 0755 "$ROOT$ADOPT_DIR" && chown "$OWNER:$GROUP" "$ROOT$ADOPT_DIR" || return 1
    WRITABLE=$ADOPT_DIR ;;
  esac
  # The unit: one Environment= line naming the product settings (an older one for the same setting is dropped), right
  # after [Service], LimitNOFILE if the unit has none, and the adopt folder added to ReadWritePaths. The ExecStart that
  # runs the link CURRENT reads it through RELEASES/current, the follower's own pointer.
  HAS_RW=$(grep -c '^ReadWritePaths=' "$B/old/unit" || true)
  HAS_NOFILE=$(grep -c '^LimitNOFILE=' "$B/old/unit" || true)
  awk -v env="Environment=$SETTINGS_ENV=$SETTINGS_FILE" -v name="Environment=$SETTINGS_ENV=" -v adopt="$WRITABLE" -v state="$STATE" -v has_rw="$HAS_RW" -v has_nofile="$HAS_NOFILE" -v cur="readlink -f $CURRENT" -v rel="readlink -f $RELEASES/current" '
    index($0, name) == 1 { next }
    { gsub(cur, rel) }
    /^ReadWritePaths=/ && adopt != "" {
      n = split(substr($0, 16), paths, " "); found = 0
      for (i = 1; i <= n; i++) if (paths[i] == adopt) found = 1
      if (!found) $0 = $0 " " adopt
    }
    { print }
    /^\[Service\]$/ { print env; if (has_nofile == 0) print "LimitNOFILE=1048576"; if (adopt != "" && has_rw == 0) print "ReadWritePaths=" state " " adopt }
  ' "$B/old/unit" > "$ROOT$UNIT_FILE.new" && install -m 0644 "$ROOT$UNIT_FILE.new" "$ROOT$UNIT_FILE" && rm -f "$ROOT$UNIT_FILE.new" || return 1
  # Bootstrap: the new release's own binary adopts the newest signed release its feed serves for its target (writing the kept
  # entry) and then switches releases/current to it, the follower's own pointer. No link is written by hand.
  TARGET=$("$ROOT$RELEASE_DIR/$ENGINE_FILE" release | sed -n 's/^target //p') || return 1
  NEW=$("$ROOT$RELEASE_DIR/$ENGINE_FILE" release fetch "$FEED_URL" "$PUBLIC_KEY" "$TARGET" "$ROOT$RELEASES") || return 1
  "$ROOT$RELEASE_DIR/$ENGINE_FILE" release switch "$ROOT$RELEASES" "$(basename "$NEW")" >/dev/null || return 1
  grep -q "readlink -f $RELEASES/current)" "$ROOT$UNIT_FILE" || return 1
  # The config is written only now, after the new release is the one `current` names: the running release reads the config
  # it was started with, so a config with keys only the new release knows must never reach the old one (a restart loop).
  install -o "$OWNER" -g "$GROUP" -m 0600 "$B/new/place.json" "$ROOT$CONFIG" || return 1
  restart
}

if apply; then
  echo "updated $BACKUP $(readlink "$ROOT$CURRENT")"
else
  echo "$UNIT was not active after the update; putting $BACKUP back." >&2
  put_back >&2
  exit 4
fi
