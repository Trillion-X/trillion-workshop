# Removes named objects from the backup store, such as a database dump put there for one move (copy-a-database.sh TO_STORE),
# once the copy it carried compares equal. It reads the store's settings and a key that may delete (NAME=value lines, WAL-G's
# own) from the sealed credential $SECRET_NAME, removes each object of STORE_OBJECTS (names, spaces between), and refuses
# unless each is then gone from the listing of its folder. It removes nothing else: no backup, no WAL, no other name.
set -eu
set -a; . "$CREDENTIALS_DIRECTORY/$SECRET_NAME"; set +a
[ -n "${STORE_OBJECTS:-}" ] || { echo "Needs STORE_OBJECTS." >&2; exit 2; }
for object in $STORE_OBJECTS; do
  case "$object" in basebackups_*|wal_*|*..*|/*) echo "$object is not a name this removes." >&2; exit 2;; esac
  wal-g st rm "$object" >/dev/null
  folder=$(dirname "$object")
  if wal-g st ls "$folder/" 2>/dev/null | awk '{print $NF}' | grep -qx "$(basename "$object")"; then echo "$object is still in the store." >&2; exit 1; fi
  echo "removed $object at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
done
