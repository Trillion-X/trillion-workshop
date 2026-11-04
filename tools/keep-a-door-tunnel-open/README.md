# tools/keep-a-door-tunnel-open/

Keeps one door on this computer reachable from a server: one SSH reverse forward from the server's `127.0.0.1:<remotePort>` to this computer's `127.0.0.1:<localPort>`, with the server's host key pinned on first contact and never silently replaced, the held connection key only inside a private `ssh-agent`, and a new connection two seconds after one ends. It also sets up the server side (a user that may only listen on that one loopback port), offered as `tool:prepare-a-server-for-a-door-tunnel`; it reaches the server as its administrator through `tools/administer-a-rented-host`, the one owner of those SSH arguments. Keeping the tunnel open is not a row yet, because the engine has no kept run that reaches this computer's door (see Running it). Moved from the older owner's `scripts/portable-service-connection.mjs` (contract `ports/keep-a-door-tunnel-open.json`).

## Files

| File | Purpose |
|------|---------|
| `do-work/keep-a-door-tunnel-open.mjs` | The tunnel, the host pin, the host setup and the launch agent, and the same as a command (`serve`, `prepare ADMIN_KEY_FILE`, `install CONFIG_FILE LABEL CREDENTIAL_COMMAND...`). |
| `do-work/prepare-a-tunnel-host.sh` | Run as root on the server by `prepareConnectionHost`: the service user, its one `permitlisten` key and an sshd `Match User` block that allows a remote forward to that port only (no shell, no session, no other forwarding). |
| `part.json` | Both files are public. |
| `tool-rows.json` | `tool:prepare-a-server-for-a-door-tunnel`: a container row with `internet: true` that runs `prepare` with the request on standard input and the administration key the engine mounts (`server-administration-ssh-key`), and packs `tools/administer-a-rented-host`. |
| `ports/keep-a-door-tunnel-open.json` | The port contract from the older owner. |
| `test/keep-a-door-tunnel-open.test.mjs` | Loopback-only arguments, the pinned host key, the host setup's restrictions, reconnect and abort, a refused credential, preparing a server through the run's proxy with the request's host key, the launch agent, the launch command's descriptors, and install. All data is made up. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| Configuration | `{ address, user, remotePort, localPort, knownHostsFile, publicKeyFile?, adminKeyFile?, ssh_port?, admin_user?, host_key? }` | The server's IPv4 address, the service user, both ports and the pinned-host file. Setting up the server also needs `adminKeyFile`, `ssh_port` and `admin_user` (the administrator it signs in as), and the row takes `host_key` to pin. All of it is the person's DATA; nothing here names a host. |
| `connectionArguments` | `(c, { identityFile?, agentSocket? }) -> argv` | `ssh -N -T -R 127.0.0.1:<remote>:127.0.0.1:<local>` with the host key checked, batch mode and keep-alives. |
| `pinHost` | `(c, { run? }) -> knownHostsFile` | Keeps the server's one ed25519 key the first time; an existing file is never rescanned. |
| `makeConnectionKey` | `(comment) -> { privateKey, publicKey }` | A new RSA 3072 key, the public half in OpenSSH form with the comment given. |
| `prepareConnectionHost` | `(c, publicKey, { run? }) -> output` | Sends `prepare-a-tunnel-host.sh` with the user, port and public key to the server over SSH stdin, as `c.admin_user` at `c.ssh_port` (`administrationArguments`). |
| `prepareFromRequest` | `(request, adminKeyFile, { run?, proxy? }) -> { prepared, said }` | The row's work: pins `request.host_key` in a private folder of the run (`knownHostsLine`), gives the mounted key its last newline (`heldKeyFile`), and prepares the server through the run's proxy. |
| `serveConnection` | `(c, credential, { spawnImpl?, agentOwner?, wait?, stopped?, signal?, report? })` | The loop: asks `credential()` for the key, checks it is RSA, puts it in the private agent, runs SSH, reports why it ended, waits two seconds, again; abort ends the child and the agent. |
| `keyDescriptor` | `4` | The descriptor `serve` reads the held key on: a row's `credential_mounts` fd, or the launch agent's pipe. |
| `connectionLaunchArguments` | `({ nodeExecutable, script, configFile, credentialCommand }) -> argv` | `bash -c` that runs `serve` with the configuration on standard input and the vault command's descriptor 3 on `keyDescriptor`, so the key is never in argv, a file or the log. |
| `connectionLaunchAgent` / `installConnection` | `({ label, programArguments, environment?, logFile }) -> plist` / `(configFile, { label, credentialCommand, environment?, nodeExecutable, uid, home?, run? })` | A launchd agent that keeps the command running (`KeepAlive`, `ThrottleInterval` 10), and installing it: written to `~/Library/LaunchAgents/<label>.plist`, the old one booted out, the new one bootstrapped, the log beside the configuration. `credentialCommand` is the vault command, by the held value's name, that writes the value only on its descriptor 3; the label and that command are the installer's input, never a file in a repository. |

## Running it

The engine runs a Workshop row only inside its sandbox, where a run ends at its ceiling, reaches a server only through the engine's proxy and cannot reach the door it would forward to. Until it can (the waiting AI job `ai-job:engine-kept-run-for-door-tunnel-2026-11-03` names the three gaps), a launch agent runs this file from the engine's installed Workshop copy, never from a working checkout:

```
node <installed workshop>/tools/keep-a-door-tunnel-open/do-work/keep-a-door-tunnel-open.mjs install <configuration file> <label> <vault command> <its arguments...>
```

## Dependencies

**Depends on:** `tools/administer-a-rented-host` (`administrationArguments`, `knownHostsLine`, `heldKeyFile`); Node's standard library; `/usr/bin/ssh`, `ssh-agent`, `ssh-add` and `ssh-keyscan` on this computer; on the server, OpenSSH with `sshd_config.d` and systemd.

**Depended on by:** `tool-rows.json` (`tool:prepare-a-server-for-a-door-tunnel`); the launch agent that keeps the public door's tunnel open.
