# Reboot a computer when it asks

`tool:reboot-a-computer-when-it-asks` reads whether one of the person's computers asks for a reboot after its updates, and reboots it then: only when nothing on it is busy, and only once it is asked. Afterwards it reads the computer again to see that it came back with every container it ran.

Why: the Elestio computers rebooted themselves every Sunday after `unattended-upgrades` (their `20auto-upgrades` says `Automatic-Reboot "true"`), whoever was using them. On Nov 25 2026 team-lead switched that off in each computer's row (`/etc/apt/apt.conf.d/99-no-automatic-reboot`, `Automatic-Reboot "false"`; security updates keep applying) and made the reboot our own step, drained, announced and at a quiet hour. `workflow:reboot-a-computer-after-its-updates` is that step; this tool is the part that runs on the computer.

## What it reads and what it does

| Part | How |
|------|-----|
| Asks | `/var/run/reboot-required` is there (`asks`), and the packages `/var/run/reboot-required.pkgs` names. |
| Boot | `/proc/sys/kernel/random/boot_id`, uptime, `systemctl is-system-running` and the failed units (`systemctl list-units --failed`). |
| Containers | `docker ps` names (none on a computer without Docker). |
| Busy | Each settings.json `busy` test, a shell condition run on the computer: a package manager at work (`apt`, `apt-get`, `dpkg`, or `unattended-upgrade` itself, not its shutdown helper), or a container build or a compose run that changes containers (a pipeline deploy; a long-running `docker compose logs -f` is not one). Whether an apply holds the computer's row is the caller's to read: the row lock is in the row's own database. |
| `mode: "read"` | The default: answers `before` with the above. It changes nothing. |
| `mode: "reboot"` | Reads the same. A computer that does not ask (unless `even_if_not_asked: true`, for a proof run of this tool) or is busy is answered `rebooted: false` with why. Otherwise `systemd-run --on-active=5 /bin/systemctl reboot`: systemd reboots five seconds after the session ends, so the session returns. Every running program is stopped by the system's own shutdown (SIGTERM, then its stop timeout), as any reboot stops it; nothing is stopped by hand, so a container under `restart: unless-stopped` starts again (one stopped with `docker stop` would stay stopped). It waits 30 s, then reads every 10 s until the computer answers with a new boot id and a started system (`running` or `degraded`), for up to `wait_seconds` (600). |
| After | `after` (the same read), `back_after_seconds`, and findings: `still-asks-for-a-reboot` (warn), `degraded-after-reboot` (alert: names each failed systemd unit), `container-not-back` (alert: one that ran before does not run after), `not-back-after-reboot` (alert). |

## Keys and network

The administrator key is the held value `server-administration-ssh-key`, mounted as a 0600 file at the path the row's last argument names; it reaches only the hosts its vault entry names. The host key is pinned from the input (`host_key`), never learned on first use. SSH goes through the run's own proxy with `tools/administer-a-rented-host` (`administrationArguments`, `proxied`, `heldKeyFile`), packed beside this tool at `/opt/administer-a-rented-host`. Nothing from the input is written into a remote command.

## Source and checks

`do-work/reboot-when-asked.mjs` (Node's own `child_process` and the system `ssh`; no package). `test/reboot-when-asked.test.mjs` answers each script with a made-up computer (192.0.2.x): one that does not ask, one that asks with its packages, one that asks while busy, a proof run with `even_if_not_asked`, a reboot that comes back with every container, one that comes back without one and degraded, one that never comes back, one that does not answer at all, and refused addresses and modes. Run `node --test tools/reboot-a-computer-when-it-asks/test/reboot-when-asked.test.mjs`.
