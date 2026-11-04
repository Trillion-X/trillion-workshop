# tools/start-a-place/

Make a machine into a place that keeps people's accounts: rent a server through a provider row, or take an existing Linux machine over SSH, install the engine release on it, start it serving and read back its sign-up page and monthly price. The provider is DATA: a row in `read-data/providers.json` names its API, sizes, image, price read and credential (by vault handle). A Hetzner row, a Cloudflare DNS row and an "existing Linux machine over SSH" row (a Raspberry Pi, a box at home) are here; another provider is another row.

## Files

| File | Purpose |
|------|---------|
| `read-data/providers.json` | The provider rows. `machines` rows rent and release a machine (`host`, `access_key`, `price` name which `requests` do each step); a row with `base: null` adopts a machine the person already runs. `names` rows point one DNS name at the machine (`zone`, `record`). Each row's `requests` are the only calls sent. |
| `do-work/rent-a-machine.mjs` | The lease: rent, read, price, release, point and forget a name, all through a row. Nothing is deleted without this lease's own label on it. |
| `do-work/set-up-the-machine.sh` | Runs as root on the machine over SSH: a `place` system user owning `/var/lib/place`, Caddy for the public name, a firewall (22, 80, 443), and a `place` service running the release `/opt/place/current` points at. Debian and Ubuntu. |
| `do-work/check-a-sign-up.mjs` | `tool:check-a-sign-up`: sign up a synthetic account at an origin with a software passkey made for the run, sign in with it and read a signed-in page. |
| `do-work/start-a-place.mjs` | The command every row in `tool-rows.json` runs: `price`, `start`, `status`, `install`, `remove`. |
| `tool-rows.json` | `tool:start-a-place`, `tool:read-a-place-price`, `tool:read-a-place`, `tool:check-a-sign-up`, `tool:give-a-place-a-new-release`, `tool:give-back-a-place`. |
| `part.json` | Nothing here is imported by other code. |
| `test/start-a-place.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| request file | `{ lease_file, public_origin?, machine: { provider, name, placement, lifetime, expires_at?, public_key \| public_key_file }, name: { provider?, zone?, host_name }, ssh: { known_hosts, identity_file? }, port, engine: { file, data_env, data_dir, id_argv?, release_name, release: { tarball } \| { on_machine } }, place_config, config_from_release?, release_feed?, default_places? }` | What to start. Paths are relative to the request file. `public_origin` is where people reach the machine's accounts when a forwarder stands in front of it; without it, the machine's own name. The engine's file, data folder and id command are input: this folder names no engine. |
| lease file | `{ schema: "place-lease/1", provider, name, serverType, location, image, lifetime, startedAt, expiresAt, state, serverId, sshKeyId, sharedSshKeyId?, address, adopted?, names?, zone?, zoneId?, hostName?, recordId? }` | Every identity the lease owns, never a credential. `start` resumes from it. |
| `providerClient` | `(row, token, { fetchImpl? }) => request(method, path, body)` | Sends only the calls the row's `requests` declare. |
| `rentMachine` / `releaseMachine` / `readMachine` | `({ request, file, provider, ... }) => lease` | Rent (or adopt), give back, read state. A public key the provider already holds (same fingerprint) is used as it is and never removed. |
| `readPrice` | `({ request, provider, placement }) => { cents, currency } \| null` | The size's monthly price at the location. |
| `pointName` / `forgetName` | `({ request, file, provider, zone?, hostName? }) => lease` | One A record, unproxied, marked with this lease's name. |
| `release_feed` | `{ urls: [https address of feed.json], public_keys: [64 hex Ed25519], releases }` | Written into the place config as given, checked first (before anything is rented): where the place adopts new engine releases from (engine job J1), and the keys a release must be signed by. The feed is published by `tools/publish-an-engine-release`, whose install prints the public key. |
| `default_places` | `{ holders: [place ids], answering: [place ids], voters?: [place ids] }` | Written into the place config as given: the places a new account's rows name by default. |
| `startAPlace` | `(request, { machineToken, nameToken, run?, fetchImpl? }) => { lease, host_name, arch, price, place_id, release, sign_up_status }` | The whole start, read back. |

## Dependencies

**Depends on:** Node's `fetch`, `node:fs`, `node:crypto`, `node:child_process`; `ssh` on the person's computer; `apt-get`, `systemd` and Caddy on the machine.

**Depended on by:** `tool-rows.json`, run on the person's computer.

## How credentials travel

Descriptor 3 holds the machine provider row's `vault_key` credential and descriptor 4 the names row's. They never reach argv, a file, the environment or an answer. Reaching the machine uses the person's own SSH key and a `known_hosts` file the request names; a new machine's host key is added the first time.

## What was left out

The earlier hosting rows also had a Fly.io row. It was not ported: a Fly Machine has no public IPv4 of its own and takes no root SSH key, so this setup cannot run on it.
