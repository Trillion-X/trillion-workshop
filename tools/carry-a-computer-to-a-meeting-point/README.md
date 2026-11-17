# tools/carry-a-computer-to-a-meeting-point/

Carries a computer to a meeting point: a program the computer starts that dials out to a public host, so a computer behind a router is reached with no inbound port, and the engine on it carries no bytes between computers itself. Which program, with which files and arguments, is a **way row** (`read-data/ways.json`); one runner starts whatever a row names. It replaces `tools/keep-a-door-tunnel-open`, which could only run one SSH forward and only under launchd.

A way row is `{ id, transport_kind, relay_host_ref, client, params, order, requires_awake, install }`. `client` is the program (a pinned download with its BLAKE3, or a command already on the computer, chosen by what the computer is), the files it is given in a private folder that is removed when it ends, and its arguments. `server` is the same for the meeting point's host: ordered steps (a file, or a command) with an `each` that repeats per carried computer. Three rows ship, in order: `frp` (0.72.0 of 2026-11-04, Apache-2.0, native builds for Apple silicon, linux x64, arm64 and arm, and Windows, each pinned by BLAKE3; frps takes one token for the meeting point, and the host's `allowPorts` list holds each computer to its own port, so a token holder could ask for another listed computer's port), `rathole` (0.5.0 of 2023-10-01, the project's newest release, Apache-2.0; a token per computer; no Apple-silicon build, so such a Mac runs the x86_64 build under Rosetta) and `ssh-reverse-forward` (the host key pinned, a service user that may listen on one loopback port and do nothing else). A person's own way is a row of the same shape; no code names a program, an operating system or a host.

The port a computer listens on at the meeting point is a stable hash of its id: BLAKE3 of `salt:id`, its first four bytes, modulo the width of the range in `read-data/ports.json`. It is derived, never listed; two computers that hash to one port on a host are refused, and one is given a `salt`. A caller that needs the port (the lane that builds `remote-mcp` sources) calls `portFor(computer_id)` or reads it from the install's answer.

The program is kept running by the init row for the computer's kind (`tools/start-a-computer/read-data/init-rows.json`, installed by `tools/start-a-computer/do-work/install-init.mjs`): launchd, systemd, a Windows startup task or Quadlet. `install` copies the files the carrier needs (`read-data/carrier-files.json`) into the state folder, because the engine keeps only its current and previous Workshop copies, and the init row points at that stable copy.

## Files

| File | Purpose |
|------|---------|
| `do-work/carry-a-computer.mjs` | The runner: `portFor`, `valuesFor`, `ensureProgram` (download checked against its BLAKE3), `renderClient`, `serveCarrier` (starts the client, again two seconds after it ends), `renderMeetingPoint`, `installCarrier`, `removeCarrier`, and the command line (`serve`, `install`, `remove`, `render-meeting-point`) |
| `read-data/ways.json` | The way rows |
| `read-data/ports.json` | The meeting-point port range |
| `read-data/carrier-files.json` | What `install` copies beside the init row |
| `tool-rows.json` | `tool:carry-a-computer-to-a-meeting-point`: what a host runs for the computers carried to it (renders the way's `server` half) |
| `kits/carry-a-computer-to-a-meeting-point.json` | How to ask for it and what comes back |
| `part.json` | The public entry |
| `test/carry-a-computer.test.mjs` | Port hash, each shipped row, a synthetic way row with no code change, the BLAKE3 check of a download, the meeting point's steps and port collision, the launchd install and removal, and (on a Mac, with `CARRIER_LIVE_PROOF=<client binary>` and, for a row whose server is another program, `CARRIER_LIVE_SERVER=<server binary>` and `CARRIER_LIVE_WAY=<row id>`) the real thing: a local server, the client kept by a launchd user agent, the carried port answering, then `launchctl bootout` and the files removed |

## Running it

On the carried computer: `node do-work/carry-a-computer.mjs install CONFIG_FILE STATE_FOLDER`, with a configuration `{ label, way, relay_host, computer_id, local_port, credential_command, init_values? }`. `credential_command` is the vault command, by the held value's name, that writes the value only on its descriptor 3; it is never in an argument or a file the configuration names. `remove` undoes it. On the host, `tool:carry-a-computer-to-a-meeting-point` says what to run, and `tools/start-a-computer` renders it on a public computer.

## Dependencies

**Depends on:** `tools/start-a-computer` (`fill-fields.mjs`, `install-init.mjs`, `init-rows.json`, `unit-templates`); `@noble/hashes` (BLAKE3).

**Depended on by:** the public front door's route to a computer behind a router (`caddy.carried_computers`, `tools/start-a-computer`): the carrier's port at the meeting point is the route's port.
