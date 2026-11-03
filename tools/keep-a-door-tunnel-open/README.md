# tools/keep-a-door-tunnel-open/

Keeps one door on this computer reachable from a server: one SSH reverse forward from the server's `127.0.0.1:<remotePort>` to this computer's `127.0.0.1:<localPort>`, with the server's host key pinned on first contact and never silently replaced, the held connection key only inside a private `ssh-agent`, and a new connection two seconds after one ends. It also sets up the server side (a user that may only listen on that one loopback port) and gives the SSH arguments other door tools reach the same host with. A library: it offers no tool of its own yet, because the engine has no kept run that reaches an SSH host (see Running it). Moved from the older owner's `scripts/portable-service-connection.mjs` (contract `ports/keep-a-door-tunnel-open.json`).

## Files

| File | Purpose |
|------|---------|
| `do-work/keep-a-door-tunnel-open.mjs` | The tunnel, the host pin, the host setup, the administration arguments and the launch agent, and the same as a command (`serve`, `install CONFIG_FILE LABEL CREDENTIAL_COMMAND...`). |
| `do-work/prepare-a-tunnel-host.sh` | Run as root on the server by `prepareConnectionHost`: the service user, its one `permitlisten` key and an sshd `Match User` block that allows a remote forward to that port only (no shell, no session, no other forwarding). |
| `part.json` | Both files are public, so another door tool (`tools/renew-a-tls-certificate`) imports `administrationArguments`. |
| `ports/keep-a-door-tunnel-open.json` | The port contract from the older owner. |
| `test/keep-a-door-tunnel-open.test.mjs` | Loopback-only arguments, the administration identity, the pinned host key, the host setup's restrictions, reconnect and abort, a refused credential, the launch agent, the launch command's descriptors, and install. All data is made up. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| Configuration | `{ address, user, remotePort, localPort, knownHostsFile, publicKeyFile?, adminKeyFile? }` | The server's IPv4 address, the service user, both ports and the pinned-host file. `adminKeyFile` is the root identity for setup. All of it is the person's DATA; nothing here names a host. |
| `connectionArguments` | `(c, { identityFile?, agentSocket? }) -> argv` | `ssh -N -T -R 127.0.0.1:<remote>:127.0.0.1:<local>` with the host key checked, batch mode and keep-alives. |
| `administrationArguments` | `(c) -> argv` | `ssh -T` as root on the pinned host at `c.address` with `adminKeyFile`, through the run's proxy when `HTTPS_PROXY` names one; needs only the address, the pinned-host file and the identity, and refuses without them. |
| `proxied` | `(proxy?) -> argv` | The ssh options for a run's loopback proxy (`ProxyCommand` through its CONNECT tunnel with the system `nc`) and a 30 second keepalive; a proxy that is not `http://127.0.0.1:<port>` or `localhost` is refused. |
| `pinHost` | `(c, { run? }) -> knownHostsFile` | Keeps the server's one ed25519 key the first time; an existing file is never rescanned. |
| `makeConnectionKey` | `(comment) -> { privateKey, publicKey }` | A new RSA 3072 key, the public half in OpenSSH form with the comment given. |
| `prepareConnectionHost` | `(c, publicKey, { run? }) -> output` | Sends `prepare-a-tunnel-host.sh` with the user, port and public key to the server over SSH stdin. |
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

**Depends on:** Node's standard library; `/usr/bin/ssh`, `ssh-agent`, `ssh-add` and `ssh-keyscan` on this computer; on the server, OpenSSH with `sshd_config.d` and systemd.

**Depended on by:** `tools/renew-a-tls-certificate` (`administrationArguments` and `proxied`, packed in each of its rows); the launch agent that keeps the public door's tunnel open.
