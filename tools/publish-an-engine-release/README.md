# tools/publish-an-engine-release/

Publish a signed engine release on every merge, so an engine fix reaches every account without an app install. A builder computer receives each push to the engine repository's branch, builds `trillion-local` at that commit for its own rust target, packs it (with the repository's `product/` folder when the commit has one), signs the entry with a key only the builder holds, and adds it to a feed served at `https://<builder name>/engine-releases/feed.json`. A release is a pointer change: each computer reads the feed, checks the signature against the public keys its config names (`release_feed` in the place config start-a-place writes) and adopts the newest release itself (engine job J1). The repository, branch and builder are input; nothing here names them.

## Files

| File | Purpose |
|------|---------|
| `do-work/release-feed.mjs` | The feed's own rules, no file or network: the signed text, Ed25519 signing and checking, a key's public half as 64 hex, an entry checked field by field, and adding an entry (newest last, at most `keep_releases`, an older sequence refused). |
| `do-work/publish-an-engine-release.mjs` | `publish REQUEST_FILE [--commit COMMIT]`, run on the builder: fetch, number, build, pack, sign, write `<feed folder>/<commit>/<target>.tar.gz` and rename feed.json into place under the feed's lock. `make-key KEY_FILE` makes the signing key once; `public-key KEY_FILE` prints its public half. |
| `do-work/contribute-an-engine-release.mjs` | `contribute REQUEST_FILE` (signing key on standard input), run by a builder for one more target (a computer of that target, or a hosted runner of it): pack the built `trillion-local` and `product/` as publish does, sign the entry with that builder's own key, and POST the tar.gz to the feed's builder at `entry_path`, the entry as base64 JSON in the `x-engine-release-entry` header. `public-key` prints the key's public half; `make-key` prints a new key once, for the vault. |
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

- `sequence`: the commit's time in seconds (`git show -s --format=%ct <commit>`), for a commit on the branch's first-parent line (anything else is refused). It is the one numbering every engine build uses: the Mac app stamps the engine it carries the same way (trillion-apps scripts/release-macos-app.sh).
- `target`: the builder's rust target triple (the host line of `rustc -vV`).
- `url`: `<base_url><commit>/<target>.tar.gz`; the tar.gz holds `trillion-local`, and `product/` when the commit has one.
- `content`: `1f:` and the BLAKE3 hex of the tar.gz (`tools/content-identity`), `bytes` its size.
- `urgent`: true when the commit message has the trailer `Release-Urgent: true`.
- `signature`: 128 hex, Ed25519 over `trillion-engine-release-v1\n<commit>\n<sequence>\n<target>\n<content>\n<bytes>\n<urgent>`.

The build gets `TRILLION_RELEASE_COMMIT` and `TRILLION_RELEASE_SEQUENCE` in its environment. A sequence older than the feed's newest for the same target is refused before the build and again under the lock, so a delivery that arrives late never replaces a newer release; the same commit again answers the entry already there.

## Every target in one feed

The feed holds one entry per commit per target; a target is the entry's data, never a named machine. The feed's builder publishes its own target (`publish`). Every other target has its own builder, which builds the same commit with the same `TRILLION_RELEASE_COMMIT` and `TRILLION_RELEASE_SEQUENCE`, and `contribute`s its signed entry. That builder can be a computer of that target or a hosted runner of it, such as the engine repository's own workflow on each push to its branch.

The feed's builder `accept`s an entry only when all of these hold, then signs it again with its own key:

- it is signed by a key in the config's `accept_entries_from` (install's request takes them);
- its commit is on the branch's first-parent line at the entry's sequence, which the builder fetches itself;
- it is newer than the feed's entry for its target;
- the body's length and BLAKE3 are the entry's.

Every follower's existing `public_keys` (start-a-place's `release_feed`, the Mac app's carried settings) take it with no config change and no app install. The feed's builder vouches for what an accepted key signed. The receiver checks the entry's signature before it reads the body, and each target has its own queue (only its newest waits). When the feed is trimmed to `keep_releases`, the oldest entries leave first, but never a target's newest, so a target whose builder is behind keeps the release its computers follow.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| publish config | `{ repository, branch, base_url, work_folder, feed_folder, key_file, state_folder, keep_releases, toolchain: { cargo, rustc }, receiver: { host, port, path, entry_path }, accept_entries_from }` | Written by install at `/etc/engine-releases/publish.json`. No credential. |
| install request | `{ builder: { address, host_name }, ssh: { known_hosts, identity_file? }, repository: { url, branch }, keep_releases?, accept_entries_from?: [64 hex] }` | Paths relative to the request file. |
| `publish` | `(config, { token, commit? }) => entry & { public_key, already_published, dropped, releases_held }` | One release. |
| `accept` | `(config, { token, entry, body }) => entry & { public_key, already_published, dropped, releases_held }` | Another builder's signed entry into this feed, signed again with this builder's key. |
| `contribute` / `packAndSign` | `(request, privatePem, { fetchImpl? }) => { commit, sequence, target, content, bytes, public_key, builder }` / `(request, privatePem) => { entry, body }` | One more target's release, packed, signed and sent. |
| `addRelease` | `(feed, entry, keep) => { feed, added, entry, dropped }` | Throws (exit 3) for an older sequence. |
| `signEntry` / `verifyEntry` | `(entry, pem) => entry` / `(entry, publicHex) => boolean` | The signature. |
| `installBuilder` / `builderStatus` | `(request, { token, secret, run? }) => { public_key, feed_url, receiver_active, feed_status, webhook }` / `(request) => { receiver_active, public_key, releases_held, newest, last_run, feed_status }` | Over SSH. |

## How credentials travel

- The signing key is made on the builder by `make-key` (mode 0400, owned by the builder user) and never leaves it; only its public half is printed.
- The repository token reaches `publish` on descriptor 3. git reads it through a credential helper that reads that descriptor on `get`; it is in no argv, file, environment, log or answer, and cargo never sees it.
- A repository named by an `ssh://` or `git@` URL needs no token: install makes a read key for the builder user on the builder (`on_builder.repository_key_file`, never leaving it), answers its public half as `deploy_key` to add to the repository as a read-only deploy key, and the receiver's git uses it through `GIT_SSH_COMMAND`.
- Another target's builder holds its own signing key: on a hosted runner, a repository secret that the workflow pipes to `contribute` on standard input. Only its public half is in the feed builder's config, and nothing a stranger sends is taken without a signature by that key.
- The push secret reaches the receiver on descriptor 4. install hands both from the person's vault (descriptors 3 and 4 on the person's computer) to `systemd-creds encrypt` on the SSH channel's standard input; on the builder they rest encrypted with its host key, and systemd opens them onto the receiver's descriptors 3 and 4 (`LoadCredentialEncrypted`).

## Dependencies

**Depends on:** `tools/content-identity` (BLAKE3, with `@noble/hashes`), Node's `crypto`, `http`, `zlib`, `child_process`; `git`, `tar`, `cargo` and `rustc` on the builder; `ssh` and `tar` on the person's computer; `apt-get`, systemd 250+, Caddy and ufw on the builder.

**Depended on by:** `tool-rows.json`; the feed is read by the engine's release-feed reader (engine job J1), configured by `tools/start-a-place`'s `release_feed`.

## Ported from

The older product's Workers Builds deploy (`scripts/deploy-worker.mjs` and `scripts/deploy-batching.json` in the older product repository, before they were removed): every push to main built that commit, uploaded an inactive version and promoted it, and an older commit never won. Here a push event builds and publishes; promotion is each computer adopting from the feed.
