# Check a computer from inside

`tool:check-a-computer-from-inside` reads one of the person's computers from another computer, over SSH as its administrator: how full each disk is, and whether each engine the computer's row runs holds the person it must hold. It is the inside half of `tools/check-a-computer-from-outside`, which logs in to nothing and so cannot see either.

Why: on Nov 23 2026 the always-on computer filled its disk, its engine came back holding no person, and every signed-in call to it was refused for a day. Nothing noticed, because nothing read the disk or the engine from anywhere else.

## What it reads and what it does

| Part | How |
|------|-----|
| Disks | `df -P -T -B1`; memory and image filesystems (settings.json `disk.skip_types`) are left out. A disk at or past `warn_used_pct` (85) is `disk-filling` (warn), at or past `alert_used_pct` (92) `disk-nearly-full` (alert). |
| Engines | Each unit of the row's `runs.units` that declares an engine's ready check: a loopback listen address (its slots' `health_listen`, its own `health_listen` or `settings.listen`) and a persons folder (`settings.persons`), whatever program it runs. The listen addresses are asked `/readyz`; the most persons any answering slot holds is the engine's. An engine that runs in a container names `ready_in_container` (the container's name), and is asked inside that container's network (`nsenter -t <its process> -n`, with the computer's own `curl`). No address answering is `engine-not-answering` (alert). |
| Persons owed | The persons the engine's `settings.local_agents` name. An engine that holds none of them is held again by `POST /persons/add {"person": ...}` on its `settings.agent_socket`, run as the engine's own user (`runuser`), the only road the engine adds a person on; then it is read again. `engine-held-no-person` is a warning when it holds them now, an alert when not. An engine whose row names no person (a computer that only passes requests) may hold none. |
| Person folders | Each folder in the engine's `settings.persons` folder: its size (`du -sb`) and its `persons.largest_files` (5) largest files (`find -printf`, sorted). A reading, not a finding: the caller keeps it each run to see what grows (an engine's tool-run records, its builds). Only read. |
| Units | Every other unit of the row's `runs.units` (a service, a timer, a path; a unit run in slots is read as its engine): `systemctl show -p LoadState -p ActiveState -p Result`. A unit whose last run did not end in `success` is `unit-failed` (alert): a base backup that failed (Nov 24 2026: the 6 PM CST backup failed while the database was down and nothing told anyone). A timer or path that is loaded but not active is `unit-not-running` (alert); a unit the computer does not have is `unit-missing` (warn). Only read. |
| Not answering | An SSH failure is `unreachable` (alert). An address that is not an IPv4 address or a DNS name, or a missing host key, is answered `checked: false` with why, and no finding. |
| `pretend` | `{disks: {mount: percent}, engines: {unit: persons}, units: {unit: result}, unreachable: true}` replaces what was read, so a caller sees those findings without making them. Each finding they make says `pretend: true`; a pretended engine is never asked to hold anyone. |

`hold_again: false` only tells an empty engine. Nothing else on the computer is changed.

## Keys and network

The administrator key is the held value `server-administration-ssh-key`, mounted as a 0600 file at the path the row's last argument names; it reaches only the hosts its vault entry names. The host key is pinned from the input (`host_key`), never learned on first use. SSH goes through the run's own proxy with `tools/administer-a-rented-host` (`administrationArguments`, `proxied`, `heldKeyFile`), packed beside this tool at `/opt/administer-a-rented-host`. Every value written into a remote command (listen address, unit, user, socket, person) is checked against its shape first.

## Source and checks

`do-work/check-from-inside.mjs` (Node's own `child_process` and the system `ssh`; no package). `test/check-from-inside.test.mjs` answers each script with a made-up computer (192.0.2.x): a disk under, at 86% and at 93%; an empty engine held again, one that stays empty, a pretended one, one with `hold_again: false`; an engine that owes no one; an engine that does not answer; a computer with no engine; one that does not answer; one with no usable address or host key; person folders measured with their largest files by a script that writes nothing; refused shapes; and the row's argv, key mount and packed helper. Run `node --test tools/check-a-computer-from-inside/test/check-from-inside.test.mjs`.

`workflow:check-every-computer-from-inside` (a row of the person's own `workflow_recipes`) runs it for every computer row every fifteen minutes, keeps each reading in `computer_readings` and tells each finding as a notice.
