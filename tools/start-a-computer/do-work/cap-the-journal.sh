#!/bin/sh
# tools/start-a-computer/do-work/cap-the-journal.sh
#
# Runs as root on a computer, sent over SSH on standard input (`ssh root@ADDRESS env JOURNAL_MAX=... sh -s < this file`),
# by start-a-computer.mjs after the machine is set up and after an update. The system journal is the one log a computer
# keeps. A drop-in names SystemMaxUse (read-data/settings.json `journal.system_max_use`, the same number on every place)
# and ForwardToSyslog=no, so rsyslog no longer writes a second, uncapped copy of every engine line to /var/log/syslog
# (a weekly rotation let that copy fill a disk in days). The journal is restarted to read the drop-in, the journal on
# disk is trimmed to the cap now, and the numbered syslog copies already rotated away, which only repeat what the
# journal holds, are removed. ROOT (empty on a machine) is put before every folder, so the tests run this on a made-up folder.
set -eu
ROOT=${ROOT:-}
case "$JOURNAL_MAX" in [0-9]*[KMG]) ;; *) echo "JOURNAL_MAX must be a size such as 500M." >&2; exit 2 ;; esac
install -d -m 0755 "$ROOT/etc/systemd/journald.conf.d"
printf '[Journal]\nSystemMaxUse=%s\nForwardToSyslog=no\n' "$JOURNAL_MAX" > "$ROOT/etc/systemd/journald.conf.d/99-journal-cap.conf"
systemctl restart systemd-journald
journalctl --vacuum-size="$JOURNAL_MAX"
rm -f "$ROOT"/var/log/syslog.[0-9]
