#!/bin/sh
# tools/start-a-computer/do-work/cap-the-journal.sh
#
# Runs as root on a computer, sent over SSH on standard input (`ssh root@ADDRESS env JOURNAL_MAX=... sh -s < this file`),
# by start-a-computer.mjs after the machine is set up and after an update. The system journal is the one log a computer
# keeps. A drop-in names SystemMaxUse (read-data/settings.json `journal.system_max_use`, the same number on every place)
# and ForwardToSyslog=no, so rsyslog no longer writes a second, uncapped copy of every engine line to /var/log/syslog
# (a weekly rotation let that copy fill a disk in days). The journal on disk is trimmed to the cap, and the numbered syslog
# copies already rotated away, which only repeat what the journal holds, are removed. ROOT (empty on a machine) is put
# before every folder, so the tests run this on a made-up folder.
#
# The drop-in is written, and the journal restarted to read it, only when its words differ from the ones there. Every apply
# used to restart the journal, and every service that logs waits while it comes back: on Nov 20 2026 at 5:42 AM CST one
# front-door sign-in page that had sent its first byte took over 5 s for the rest, in the same second as a restart that
# changed nothing.
set -eu
ROOT=${ROOT:-}
case "$JOURNAL_MAX" in [0-9]*[KMG]) ;; *) echo "JOURNAL_MAX must be a size such as 500M." >&2; exit 2 ;; esac
install -d -m 0755 "$ROOT/etc/systemd/journald.conf.d"
CAP="$ROOT/etc/systemd/journald.conf.d/99-journal-cap.conf"
WANT=$(printf '[Journal]\nSystemMaxUse=%s\nForwardToSyslog=no\n' "$JOURNAL_MAX")
if [ ! -f "$CAP" ] || [ "$(cat "$CAP")" != "$WANT" ]; then
  printf '%s\n' "$WANT" > "$CAP"
  systemctl restart systemd-journald
fi
journalctl --vacuum-size="$JOURNAL_MAX"
rm -f "$ROOT"/var/log/syslog.[0-9]
