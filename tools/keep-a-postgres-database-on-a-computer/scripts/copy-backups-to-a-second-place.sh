# Copies the backup store's newest backup, and every WAL segment archived from its start until now, to a second place, with
# WAL-G's own copy: each object as it is, nothing compressed again, so the newest backup restores from either place. Each
# run copies only that one backup and its WAL, so a run stays as small as one day's backup however long the store has been
# kept. The second place is a folder reached over SSH. The sealed credential $SECRET_NAME holds NAME=value lines: the backup
# store's key (the names the server's own archive uses) and SECOND_SSH_PRIVATE_KEY_B64, the second place's SSH key file as
# one base64 line. The unit's environment names both places: the store's own variables and SECOND_WALG_SSH_PREFIX,
# SECOND_SSH_PORT and SECOND_SSH_USERNAME. The two configs and the key are written into the unit's private /tmp, which
# systemd removes when the run ends, and WAL-G runs with no other variable, so neither place's settings reach the other's
# config.
# Exit 0 only when the second place lists the backup store's newest backup.
set -eu
set -a
. "$CREDENTIALS_DIRECTORY/$SECRET_NAME"
set +a
dir=$(mktemp -d)
printf '%s' "$SECOND_SSH_PRIVATE_KEY_B64" | base64 -d > "$dir/key"
config() {
  printf '{'
  sep=
  for pair in "$@"; do printf '%s"%s": "%s"' "$sep" "${pair%%=*}" "${pair#*=}"; sep=', '; done
  printf '}\n'
}
config "WALG_S3_PREFIX=$WALG_S3_PREFIX" "AWS_ENDPOINT=$AWS_ENDPOINT" "AWS_REGION=$AWS_REGION" "AWS_S3_FORCE_PATH_STYLE=$AWS_S3_FORCE_PATH_STYLE" \
  "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY" > "$dir/from.json"
config "WALG_SSH_PREFIX=$SECOND_WALG_SSH_PREFIX" "SSH_PORT=$SECOND_SSH_PORT" "SSH_USERNAME=$SECOND_SSH_USERNAME" "SSH_PRIVATE_KEY_PATH=$dir/key" > "$dir/to.json"
walg() { env -i PATH="$PATH" HOME="$dir" wal-g "$@"; }
newest() { walg backup-list --config "$1" 2>/dev/null | awk 'NR > 1 { name = $1 } END { print name }'; }
walg copy --from "$dir/from.json" --to "$dir/to.json" --backup-name LATEST --with-history
want=$(newest "$dir/from.json")
have=$(newest "$dir/to.json")
[ -n "$want" ] && [ "$want" = "$have" ] || { echo "The second place lists ${have:-no backup}, not the store's newest backup ${want:-(none)}." >&2; exit 1; }
echo "the second place holds the newest backup $have and the WAL archived since it began"
