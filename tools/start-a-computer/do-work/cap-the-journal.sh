#!/bin/sh
# tools/start-a-computer/do-work/cap-the-journal.sh
#
# Runs as root on a computer, sent over SSH on standard input (`ssh root@ADDRESS env JOURNAL_MAX=... sh -s < this file`),
# by start-a-computer.mjs after the machine is set up and after an update. It caps the system journal at JOURNAL_MAX
# (read-data/settings.json `journal.system_max_use`, the same number on every place): a drop-in names SystemMaxUse, the
# journal is restarted to read it, and the journal already on disk is trimmed to the cap now. ROOT (empty on a machine)
# is put before the drop-in folder, so the tests run this on a made-up folder.
set -eu
ROOT=${ROOT:-}
case "$JOURNAL_MAX" in [0-9]*[KMG]) ;; *) echo "JOURNAL_MAX must be a size such as 500M." >&2; exit 2 ;; esac
install -d -m 0755 "$ROOT/etc/systemd/journald.conf.d"
printf '[Journal]\nSystemMaxUse=%s\n' "$JOURNAL_MAX" > "$ROOT/etc/systemd/journald.conf.d/99-place.conf"
systemctl restart systemd-journald
journalctl --vacuum-size="$JOURNAL_MAX"
