# tools/publish-an-engine-release/

Publish a signed engine release on every merge, so an engine fix reaches every account without an app install. A builder computer receives each push to the engine repository's branch, builds `trillion-local` at that commit for its own rust target, packs it (with the repository's `product/` folder when the commit has one), signs the entry with a key only the builder holds, and adds it to a feed served at `https://<builder name>/engine-releases/feed.json`. A release is a pointer change: each computer reads the feed, checks the signature against the public keys its config names (`release_feed` in the place config start-a-place writes) and adopts the newest release itself (engine job J1). The repository, branch and builder are input; nothing here names them.

## Files

| File | Purpose |
|------|---------|
| `do-work/release-feed.mjs` | The feed's own rules, no file or network: the signed text, Ed25519 signing and checking, a key's public half as 64 hex, an entry checked field by field, and adding an entry (newest last, at most `keep_releases`, an older sequence refused). |
| `do-work/publish-an-engine-release.mjs` | `publish REQUEST_FILE [--commit COMMIT]`, run on the builder: fetch, number, build, pack, sign, write `<feed folder>/<commit>/<target>.tar.gz` and rename feed.json into place under the feed's lock. `make-key KEY_FILE` makes the signing key once; `public-key KEY_FILE` prints its public half. |
| `do-work/receive-pushes.mjs` | `serve CONFIG_FILE`: the receiver service. A push delivery whose `X-Hub-Signature-256` holds, to the configured branch, queues its commit; runs go one at a time and only the newest waits; each run's outcome is kept in `last-run.json`. |
| `do-work/install-a-builder.mjs` | `install REQUEST_FILE` and `status REQUEST_FILE`, run on the person's computer over SSH as root on the builder. |
| `do-work/set-up-the-builder.sh` | Runs as root on the builder: the builder user, git, a C toolchain with the OpenSSL headers, Node.js, rust through rustup, the feed folder, Caddy and the firewall. Debian 12 / Ubuntu 24.04 or later (systemd 250 for encrypted credentials). |
| `read-data/settings.json` | Every number and name: the signing domain, 32 releases kept, the folders on the builder, the paths Caddy serves, the receiver's port, bounds and timeouts. |
| `tool-rows.json` | `tool:publish-an-engine-release`, `tool:install-an-engine-builder`, `tool:read-an-engine-builder`. |
| `part.json` | `do-work/release-feed.mjs` is public: a reader of the feed may check entries with it. |
| `ports/publish-an-engine-release.json` | The port contract for the feature files here. |
| `test/publish-an-engine-release.test.mjs` | A made-up repository, a fake cargo and rustc (`test/fake-cargo`, `test/fake-rustc`) and the fake engine the fake cargo writes: a publish's entry verifies with the printed key, an older sequence is refused before anything is built, 32 entries are kept and a dropped one's tar.gz leaves, the token reaches git only through descriptor 3, the receiver checks the HMAC and the branch, and install sends the token and secret only on standard input. |

## The feed

`feed.json` is `{ "releases": [entry, ...] }`, newest last, at most 32. An entry is

```
{ commit, sequence, target, url, content, bytes, urgent, signature }
```

- `sequence`: `git rev-list --count --first-parent <commit>`, for a commit on the branch's first-parent line (anything else is refused).
- `target`: the builder's rust target triple (the host line of `rustc -vV`).
- `url`: `<base_url><commit>/<target>.tar.gz`; the tar.gz holds `trillion-local`, and `product/` when the commit has one.
- `content`: `1f:` and the BLAKE3 hex of the tar.gz (`tools/content-identity`), `bytes` its size.
- `urgent`: true when the commit message has the trailer `Release-Urgent: true`.
- `signature`: 128 hex, Ed25519 over `trillion-engine-release-v1\n<commit>\n<sequence>\n<target>\n<content>\n<bytes>\n<urgent>`.

The build gets `TRILLION_RELEASE_COMMIT` and `TRILLION_RELEASE_SEQUENCE` in its environment. A sequence older than the feed's newest for the same target is refused before the build and again under the lock, so a delivery that arrives late never replaces a newer release; the same commit again answers the entry already there.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| publish config | `{ repository, branch, base_url, work_folder, feed_folder, key_file, state_folder, keep_releases, toolchain: { cargo, rustc }, receiver: { host, port, path } }` | Written by install at `/etc/engine-releases/publish.json`. No credential. |
| install request | `{ builder: { address, host_name }, ssh: { known_hosts, identity_file? }, repository: { url, branch }, keep_releases? }` | Paths relative to the request file. |
| `publish` | `(config, { token, commit? }) => entry & { public_key, already_published, dropped, releases_held }` | One release. |
| `addRelease` | `(feed, entry, keep) => { feed, added, entry, dropped }` | Throws (exit 3) for an older sequence. |
| `signEntry` / `verifyEntry` | `(entry, pem) => entry` / `(entry, publicHex) => boolean` | The signature. |
| `installBuilder` / `builderStatus` | `(request, { token, secret, run? }) => { public_key, feed_url, receiver_active, feed_status, webhook }` / `(request) => { receiver_active, public_key, releases_held, newest, last_run, feed_status }` | Over SSH. |

## How credentials travel

- The signing key is made on the builder by `make-key` (mode 0400, owned by the builder user) and never leaves it; only its public half is printed.
- The repository token reaches `publish` on descriptor 3. git reads it through a credential helper that reads that descriptor on `get`; it is in no argv, file, environment, log or answer, and cargo never sees it.
- A repository named by an `ssh://` or `git@` URL needs no token: install makes a read key for the builder user on the builder (`on_builder.repository_key_file`, never leaving it), answers its public half as `deploy_key` to add to the repository as a read-only deploy key, and the receiver's git uses it through `GIT_SSH_COMMAND`.
- The push secret reaches the receiver on descriptor 4. install hands both from the person's vault (descriptors 3 and 4 on the person's computer) to `systemd-creds encrypt` on the SSH channel's standard input; on the builder they rest encrypted with its host key, and systemd opens them onto the receiver's descriptors 3 and 4 (`LoadCredentialEncrypted`).

## Dependencies

**Depends on:** `tools/content-identity` (BLAKE3, with `@noble/hashes`), Node's `crypto`, `http`, `zlib`, `child_process`; `git`, `tar`, `cargo` and `rustc` on the builder; `ssh` and `tar` on the person's computer; `apt-get`, systemd 250+, Caddy and ufw on the builder.

**Depended on by:** `tool-rows.json`; the feed is read by the engine's release-feed reader (engine job J1), configured by `tools/start-a-place`'s `release_feed`.

## Ported from

The older product's Workers Builds deploy (`scripts/deploy-worker.mjs` and `scripts/deploy-batching.json` in the older product repository, before they were removed): every push to main built that commit, uploaded an inactive version and promoted it, and an older commit never won. Here a push event builds and publishes; promotion is each computer adopting from the feed.
