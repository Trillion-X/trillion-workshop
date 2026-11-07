# tools/renew-a-tls-certificate/

Keeps a rented server's public address on a valid certificate. The certificate is issued and renewed by DNS-01 with the person's DNS key (Cloudflare), every DNS record is read before and after and any change fails the run, and a changed certificate restarts the receptionist and reloads the public host. The same folder sets up the server's certificate owner, writes which paths the public host keeps before everything else goes to the engine, switches on the receptionist and checks the owner on the server itself. Renewal runs on the person's own schedule: a wake they declare for `tool:renew-a-tls-certificate`.

Every row runs one process on the person's computer that reaches the server as its administrator (`admin_user` at `ssh_port`, both input) over SSH, only with its pinned key, through the engine's proxy. The server's administration key is a file the engine mounts for that run (`server-administration-ssh-key`), and the DNS key (`cloudflare-api-token`, issue and renew only) arrives on descriptor 3 and reaches the server only on the SSH process's private input. No key is in argv, the environment, a kept file or an answer. Every fact about the server is the run's input; this folder names no product.

## Files

| File | Purpose |
|------|---------|
| `do-work/renew-a-tls-certificate.mjs` | The Mac side: checks the input, pins the server's key for the run, and runs each action on the server (`hostCommand`); writes the public host's nginx configuration (`publicProxy`); installs the host owner and its layout (`installHostOwner`); keeps a download and moves its pointer (`publishDownload`). As a command: `node renew-a-tls-certificate.mjs <action> <administration key file>` with the request on standard input and the DNS key on descriptor 3. |
| `do-work/publish-download.py` | The existing download action's server-side byte check: stages stdin privately, locks publications, keeps a new name without replacing it, compares every byte on retries, and changes the pointer only after a match. A collision or incomplete transfer leaves the pointer unchanged. |
| `do-work/tls-host-owner.py` | The server side, installed at `host.owner`: certificate status, issue and renew (certbot DNS-01 with the key in an anonymous memory file), setup, the public host's configuration and services, and starting the receptionist as its own account with its certificate on descriptors 3 and 4. Reads every product fact from its layout file beside it (`host.owner` with `.json`). |
| `ports/*.json` | The port contracts: these files were moved from an older owner, byte copy first. |
| `test/renew-a-tls-certificate.test.mjs` | The Mac side's tests, on a made-up server, and the host owner's tests run here. |
| `test/tls-host-owner.test.py` | The host owner's tests; the Linux-only ones (memory file, provider failure, dry run) run on the server through `tool:check-a-servers-tls-owner-on-the-server`. |
| `tool-rows.json` | The rows below. |

## Rows

| Row | Action | Keys it is handed |
|-----|--------|-------------------|
| `tool:renew-a-tls-certificate` | `renew` (certbot renews only when due; `dryRun` asks the staging server and changes nothing) | DNS key, administration key |
| `tool:issue-a-tls-certificate` | `issue` | DNS key, administration key |
| `tool:read-a-servers-tls-certificate` | `status` | administration key |
| `tool:set-up-a-servers-tls-owner` | `setup`: owner, layout and packages | administration key |
| `tool:update-a-servers-tls-owner` | `update-owner`: owner and layout only | administration key |
| `tool:write-a-public-hosts-paths` | `configure` | administration key |
| `tool:switch-on-a-servers-receptionist` | `activate` | administration key |
| `tool:check-a-servers-tls-owner-on-the-server` | `host-test` | administration key |
| `tool:publish-a-download` | `publish`: keep the named relative file from the granted folder and move its public pointer | administration key; granted read folder and current-user lookup |

`tool:publish-a-download` is a computer row. It requires `read-a-folder` and `resolve-current-user` grants and the mounted `server-administration-ssh-key`; the computer must report both capabilities. Its `file` is relative to the granted folder. Absolute paths, traversal, folders and symlinks escaping the grant are refused before publication. Existing direct CLI callers may still supply an absolute file when no granted-folder argument is passed.

The retained file is immutable by name. A retry must match its actual bytes, including when the lengths match; a different file with the same retained name fails without changing either public pointer. A staged incomplete transfer fails in the same way. A failed redirect update restores the prior named pointer; if that recovery also fails, the helper reports an unknown outcome. A pointer name cannot overwrite a retained regular file. The existing synchronous caller still buffers the local artifact in memory. The shared `content-identity` module hashes the exact outgoing bytes; no local or remote `b3sum` program is required. These source checks do not establish that the new row, capability or administration credential is installed or available live.

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| Request | `{ hostname, address, ssh_port, admin_user, knownHost, host, remotePort?, receptionistBinary?, connectionDiagnostics?, tokenField?, dryRun? }` | One server. `knownHost` is its pinned key, `"<address> ssh-ed25519 <key>"`. |
| `host` | `{ owner, state, downloads, ingress: { service, pid_file, error_log, diagnostics_log?, diagnostics_paths? }, receptionist: { service, account, binary_pattern, listen, paths, environment }, site?: { hostname, paths } }` | The server's layout. `owner` is where the host owner lives (a `.py` path); `binary_pattern` is the whole-path pattern a receptionist build must match; `environment` maps each variable the receptionist reads to a value where `{hostname}` and `{listen}` are filled in. |
| Layout file | `{ state, ingress: { service }, receptionist: { service, account, binary_pattern, listen, environment } }` | What `installHostOwner` writes beside the host owner, and all it reads. |

A made-up request:

```json
{
  "hostname": "app.example.com",
  "address": "192.0.2.34",
  "ssh_port": 22,
  "admin_user": "admin",
  "knownHost": "192.0.2.34 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample",
  "remotePort": 18789,
  "host": {
    "owner": "/usr/local/lib/example/tls-host-owner.py",
    "state": "/etc/example-public-tls",
    "downloads": "/var/lib/public-downloads",
    "ingress": { "service": "example-public-tls", "pid_file": "/run/example-public-tls.pid", "error_log": "/var/log/nginx/example-error.log" },
    "receptionist": {
      "service": "example-receptionist", "account": "example-mcp",
      "binary_pattern": "/opt/example/source/[a-f0-9]{40}/target/release/example-receptionist",
      "listen": "127.0.0.1:9443",
      "paths": ["/mcp", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"],
      "environment": { "EXAMPLE_LISTEN": "{listen}", "EXAMPLE_ORIGIN": "https://{hostname}" }
    },
    "site": { "hostname": "example.org", "paths": ["/privacy", "/terms"] }
  }
}
```

## Public export folders

`host.static_files` optionally mounts dedicated public export trees. A row is `{ "path": "/share/", "folder": "/srv/public-exports", "index": "index.html", "exclude": ["manifest.json"], "media_types": { "files/1f:example": "image/png" } }`. All names and paths are the run's DATA. Omit the field to retain the existing ingress unchanged.

The host serves GET/HEAD, resolves extensionless pages to their declared index, retains JSON/XML/HTML types, and uses `media_types` for files without extensions. It sends no-store, nosniff and open anonymous CORS headers. It refuses hidden and temporary files, excluded files and their index aliases, symlinks, folder listings, overlapping mounts and attempts to take the host's existing ingress paths. A mapping's folder must be proved to be the host's dedicated public export directory; path validation cannot prove publication rights.

`tool:write-public-share-files` returns `host_files`, the desired row from its actual current export manifest. A composing workflow may place that row in `host.static_files` only when the host reads that same public folder. Files on a different computer need an established publication handoff first. A new extensionless-media manifest requires the host DATA regenerated and applied again. The host cannot check revocation or expiry: the export writer's existing change/expiry wakes and successful refresh remain necessary. No fixture, generated config or unavailable administrator credential proves a live publication.

## Renewing on a schedule

The person declares a wake (a `wake-declaration` record in their own records, then `wake:switch`) for `tool:renew-a-tls-certificate` with `{ "time": { "every_ms": 21600000 } }`, a budget of at least the row's `max_run_ms`, and their server's request as its `input`. Each firing renews when the certificate is due and is a no-op otherwise; a missed firing (the computer slept) runs once when it wakes.

## Dependencies

**Depends on:** `tools/administer-a-rented-host` (`administrationArguments`, `knownHostsLine` and `heldKeyFile`, packed in every row at `/opt/administer-a-rented-host`), `tools/content-identity` (the shared BLAKE3 code and its declared `@noble/hashes` files), Node's standard library, `/usr/bin/ssh` and `/usr/bin/nc` on the person's computer; on the server, Python 3 (also used for download staging and comparison), certbot with `python3-certbot-dns-cloudflare`, nginx, openssl, curl and systemd.

**Depended on by:** `tool-rows.json`, run by Trillion's local engine (a `container` row with `internet: true`, `credential_mounts` and `max_run_ms`).
