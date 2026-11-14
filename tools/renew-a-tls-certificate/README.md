# tools/renew-a-tls-certificate/

Keeps a rented server's public address on a valid certificate. The certificate is issued and renewed by DNS-01 with the person's DNS key (Cloudflare), every DNS record is read before and after and any change fails the run, and a changed certificate restarts the receptionist and reloads the public host. The same folder sets up the server's certificate owner, writes which paths the public host keeps before everything else goes to the engine, switches on the receptionist and checks the owner on the server itself. Renewal runs on the person's own schedule: a wake they declare for `tool:renew-a-tls-certificate`.

Every row runs one process on the person's computer that reaches the server as its administrator (`admin_user` at `ssh_port`, both input) over SSH, only with its pinned key, through the engine's proxy. The server's administration key is a file the engine mounts for that run (`server-administration-ssh-key`), and the DNS key (`cloudflare-api-token`, issue and renew only) arrives on descriptor 3 and reaches the server only on the SSH process's private input. No key is in argv, the environment, a kept file or an answer. Every fact about the server is the run's input; this folder names no product.

## Files

| File | Purpose |
|------|---------|
| `do-work/renew-a-tls-certificate.mjs` | The Mac side: checks the input, pins the server's key for the run, and runs each action on the server (`hostCommand`); writes the public host's nginx configuration (`publicProxy`); installs the host owner and its layout (`installHostOwner`); keeps a download and moves its pointer (`publishDownload`). As a command: `node renew-a-tls-certificate.mjs <action> <administration key file>` with the request on standard input and the DNS key on descriptor 3. |
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
| `tool:seed-a-servers-receptionist` | `seed`: the newest release the receptionist's feed names for the server's target, placed as the program a host with no `current` starts | administration key |
| `tool:roll-back-a-servers-receptionist` | `roll-back`: refuse one release and go back to the one that was ready | administration key |
| `tool:retire-a-servers-old-builds` | `retire`: remove the build folders the hand road left, but the one the seed runs from | administration key |
| `tool:check-a-servers-tls-owner-on-the-server` | `host-test` | administration key |

`publishDownload` has no row yet: it reads a file the person names, which is a `computer` row's job (a granted folder), and a computer run's sandbox does not let ssh look up its own user (`No user exists for uid`), so the server cannot be reached from one. It runs once the engine has a computer capability that reaches a server over SSH.

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

## Renewing on a schedule

The person declares a wake (a `wake-declaration` record in their own records, then `wake:switch`) for `tool:renew-a-tls-certificate` with `{ "time": { "every_ms": 21600000 } }`, a budget of at least the row's `max_run_ms`, and their server's request as its `input`. Each firing renews when the certificate is due and is a no-op otherwise; a missed firing (the computer slept) runs once when it wakes.

## Dependencies

**Depends on:** `tools/administer-a-rented-host` (`administrationArguments`, `knownHostsLine` and `heldKeyFile`, packed in every row at `/opt/administer-a-rented-host`), Node's standard library, `/usr/bin/ssh` and `/usr/bin/nc` on the person's computer; on the server, Python 3, certbot with `python3-certbot-dns-cloudflare`, nginx, openssl, curl and systemd.

**Depended on by:** `tool-rows.json`, run by Trillion's local engine (a `container` row with `internet: true`, `credential_mounts` and `max_run_ms`).

## A receptionist that follows a signed release feed

`host.receptionist.releases` (optional) is `{ folder, program, feed: { urls, public_keys }, target, body_max_bytes, retire? }`. With it the server never gets a program by hand:

- The program (the forwarder, `trillion-mcp-forwarder`) reads `<folder>/release-feed.json` (this owner writes it: the feed's https addresses, its public keys and `folder`, public data) and follows the feed itself. It takes a release only when the signature is by a listed key, the target is its own, the sequence is above its own, and the length and BLAKE3 are the entry's; an older commit never wins; a release marked refused is never taken again. It keeps its releases in `<folder>/<program>/`, switches `current` atomically, then ends so the service restarts it on `current`, and prunes: `current`, the ready one, the running one and the newest three stay (trillion-rust src/native_entry/computer/releases.rs).
- This owner only starts the program: `launch` runs `<folder>/<program>/current/<program>` when that is a file the service account owns and may run, and otherwise the seed (`receptionistBinary`, which `binary_pattern` must allow, for a host with no release yet or one whose `current` was rolled back). The unit makes the system read-only but for `<folder>/<program>`, which `configure` creates and gives to the service account.
- A release that is not marked ready (it served for `release_ready_after_ms`) within `release_boot_attempts` starts is marked refused by the program, and `current` goes back to the ready release: a release that cannot start never keeps the server down. `roll-back` is the lever for one that starts and is wrong.
- `seed` fetches the newest release the feed names for `target` over https, bounded by the entry's own length, and checks that the archive holds the program alone at its root. It does not check the signature (that is the program's job on every release it takes), so the seed is trusted only for the seconds before the program replaces itself by a release it verified. A host that has any program already needs no seed.
- `retire` removes the build folders of the retired hand road (`retire: { folder, name }`) but the one the seed runs from. Releases the program followed are pruned by the program, never by this owner.

The releases themselves come from the builder: every engine publish also signs the forwarder it built into `forwarder-feed.json` (tools/publish-an-engine-release, kind row `also_publishes`), so a fix that lands reaches the server on the next poll.
