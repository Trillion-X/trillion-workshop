# tools/receive-files-over-ftp/

A resident receiver that speaks one wire protocol (RFC 959, with the passive-mode and explicit-TLS extensions senders actually use) so a device that can only push files that way hands them to this computer with nobody present. Cameras, scanners, drones, printers, industrial controllers and older build systems all speak it, and none of them can be taught anything else. It runs on the person's own computer until it is stopped, writes each pushed file into one folder, and writes one small note next to a file when the file is whole.

```
node tools/receive-files-over-ftp/do-work/receive-pushed-files.mjs --folder <folder to keep files in> --settings <settings file>
```

The settings file is JSON the person writes. There is no sender built in: with none declared, the receiver does not start.

```json
{
  "listen_host": "127.0.0.1",
  "listen_port": 2121,
  "senders": [{ "login": "scanner", "password": "<the password the person chose>", "handed_over_by": "device:front-desk-scanner" }],
  "media_types_by_extension": { "pdf": "application/pdf" }
}
```

Optional: `advertised_host` (the address told to a sender in the passive reply; empty means the address its control connection arrived on), `passive_port_first` and `passive_port_last` (a range to open for data connections, for a firewall), `completion_note_suffix` (default `.finished.json`), `tls_certificate_file` and `tls_private_key_file` (turn on explicit TLS).

## Files

| File | Purpose |
|------|---------|
| `do-work/receive-pushed-files.mjs` | The receiver and its command. Streams each pushed file into the folder, takes the identity of the flushed bytes, writes the completion note LAST, and acknowledges the sender only after the note is on disk. |
| `tool-rows.json` | `tool:receive-files-over-ftp`: starts the receiver on the person's computer (a long-running command, so it runs there, not in a container). |
| `test/receive-pushed-files.test.mjs` | A real listener on a loopback port and a hand-rolled sender over raw sockets, so no client library's forgiveness hides a defect. |

## Key Functions (`do-work/receive-pushed-files.mjs`)

| Export | Role |
|---|---|
| `readSettings(file)` | The settings with declared fallbacks; throws, saying what to give, when no complete sender is declared. Listens on loopback unless the file says another address. |
| `resolveInsideRoot(root, currentDir, named)` | The one place that decides whether a sender-named path is inside the only folder this process may write. A parent segment anywhere is refused outright, because POSIX normalisation would otherwise clamp an escape attempt into a quiet write inside the folder. |
| `identifySender(senders, login, password)` | Constant-time compare of fixed-length seals (so length is not leaked), returning the opaque `handed_over_by` string the settings map the login to. Nothing downstream ever sees a protocol login. |
| `identityOfFile(file)` | The BLAKE3 identity (`1f:` and 64 hex digits, from `tools/content-identity`) of a flushed file, read in 1 MiB chunks. |
| `mediaTypeForName(name, table)` | Media type from the settings table, else `application/octet-stream`. |
| `completionNote({...})` | The note: `content_identity`, `byte_length`, `media_type`, `finished_at_ms`, `handed_over_by`. |
| `runReceiver({ settings, root, ... })` | The resident loop. Returns its bound address and a `close`. |

## Invariants

- **The note is written LAST**, after the last byte is flushed. A reader that keys on the note never sees a half file. There is no timer and no size comparison.
- **The sender is acknowledged only after the note is on disk.** A sender that is not acknowledged retries, which is exactly what is wanted when this computer could not take custody.
- **The identity is that of the bytes on disk.** It is taken from the flushed file just before the note is written, so a file larger than memory costs no memory, at the price of one more read of the file. A transfer that the sender cut off with a clean close looks, in this protocol, like a file that ended; the sender, not the receiver, knows its file was cut short.
- **It never originates a connection.** Active mode, where the receiver would dial an address the sender names, is refused.
- **A finished unit is no longer the sender's.** Once its note exists, delete and rename are refused over the wire; removing it is a decision made by the person.
- This process does not know what a file is or who reacts to it. It names no device, folder layout or file kind.

## Security

Passwords live only in the settings file, which is the person's, and are never printed. No command is ever passed to a shell, and the process spawns nothing. Every write is inside the one folder. The receiver listens on loopback until `listen_host` says otherwise: to take files from a device on the same network, set it to the computer's address on that network, choose a password for each sender, and do not put the port on the internet. The explicit-TLS command (`AUTH TLS`) is available only when a certificate and key are given.

## Dependencies

**Depends on:** `node:net`, `node:tls`, `node:fs`, `node:crypto`, `node:path`, and `tools/content-identity` (its public `read-data/identity.mjs`, which needs `@noble/hashes`: run `npm install` once in the repository).

**Depended on by:** nothing by name. Whatever reacts to a finished file reads its note without knowing this tool exists.
