# tools/publish-an-engine-release/

Publish a signed engine release on every merge, so an engine fix reaches every account without an app install. A builder computer receives each push to the engine repository's branch, builds `trillion-local` at that commit for its own rust target, packs it (with the repository's `product/` folder when the commit has one, and the web client the commit pins laid under it), signs the entry with a key only the builder holds, and adds it to a feed served at `https://<builder name>/engine-releases/feed.json`. A release is a pointer change: each computer reads the feed, checks the signature against the public keys its config names (`release_feed` in the computer config start-a-computer writes) and adopts the newest release itself (engine job J1). The repository, branch and builder are input; nothing here names them.

## Files

| File | Purpose |
|------|---------|
| `do-work/release-feed.mjs` | The feed's own rules, no file or network: the signed text, Ed25519 signing and checking, a key's public half as 64 hex, an entry checked field by field, and adding an entry (newest last, at most `keep_releases`, an older sequence refused). |
| `do-work/git-ssh.mjs` | How the builder's git reads a repository over SSH: `overSsh` and the `GIT_SSH_COMMAND` for one repository's own read key (GitHub binds a deploy key to one repository). |
| `do-work/publish-an-engine-release.mjs` | `publish REQUEST_FILE [--commit COMMIT]`, run on the builder: fetch, number, build, pack, sign, write `<feed folder>/<commit>/<target>.tar.gz` and rename feed.json into place under the feed's lock. `make-key KEY_FILE` makes the signing key once; `public-key KEY_FILE` prints its public half. |
| `do-work/contribute-an-engine-release.mjs` | `contribute REQUEST_FILE` (signing key on standard input), run by a builder for one more target (a computer of that target, or a hosted runner of it): pack the built `trillion-local` and `product/` as publish does, sign the entry with that builder's own key, and POST the tar.gz to the feed's builder at `entry_path`, the entry as base64 JSON in the `x-engine-release-entry` header. `public-key` prints the key's public half; `make-key` prints a new key once, for the vault. |
| `do-work/receive-pushes.mjs` | `serve CONFIG_FILE`: the receiver service. A push delivery whose `X-Hub-Signature-256` holds, to the configured branch, queues its commit; runs go one at a time and only the newest waits; each run's outcome is kept in `last-run.json`. At start and every `catch_up_minutes` it compares the branch's tip with the feed and queues the tip when a target is behind (`catchUp`), so a restart never drops a release; a commit gets `attempts_at_most` runs from that check (`attempts.json`). |
| `do-work/install-a-builder.mjs` | `install REQUEST_FILE` and `status REQUEST_FILE`, run on the person's computer over SSH as root on the builder. |
| `do-work/set-up-darwin-builds.sh` | Runs as root on the builder when install's request names `darwin`: zig (the pinned ziglang wheel, by sha256, in a venv), cargo-zigbuild and rcodesign (apple-codesign) at pinned versions for the builder user, and each Mac target's rust standard library. |
| `do-work/set-up-the-builder.sh` | Runs as root on the builder: the builder user, git, a C toolchain with the OpenSSL headers, Node.js, rust through rustup, the feed folder, Caddy and the firewall. Debian 12 / Ubuntu 24.04 or later (systemd 250 for encrypted credentials). |
| `read-data/settings.json` | Every number and name: the signing domain, 32 releases kept, the folders on the builder, the paths Caddy serves, the receiver's port, bounds and timeouts. |
| `tool-rows.json` | `tool:publish-an-engine-release`, `tool:install-an-engine-builder`, `tool:read-an-engine-builder`. |
| `part.json` | `do-work/release-feed.mjs` is public: a reader of the feed may check entries with it. |
| `ports/publish-an-engine-release.json` | The port contract for the feature files here. |
| `test/darwin.test.mjs` | The Mac target, with the fake cargo's `zigbuild` and a fake rcodesign (`test/fake-rcodesign`, whose `print-signature-info` is modelled on rcodesign 0.29's): one publish adds the Linux and the darwin entry, both verifying; the darwin program is the signed one; rcodesign gets the identity and its password by path only and the build sees no credentials folder; a signature without the hardened runtime, with another team, without the Developer ID extension or not chaining to Apple is refused with the Linux entry still published; an older darwin sequence is refused alone; install sends the identity and password only on standard input and opens them in the unit. |
| `test/product-client.test.mjs` | The pinned web client: every target's release carries the client its commit pins under `product/<into>`, built once for all targets; a later release with the same pin reuses the built client and a changed pin builds the new one, each release keeping its own; a commit with no pin file is published unchanged; a failing client build, a pin for another repository and a builder with no client repository each publish nothing; a commit holding its own `product/<into>` beside a pin is refused; the pin is checked field by field; install asks for the client repository, makes its own read key for it apart from the engine repository's and writes it into the config. |
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

## The web client

A release can carry the engine's web client, so a change to it reaches every computer through the signed feed like an engine change, with no Mac app release. The engine repository holds `product-client.json` (the name is `settings.product_client.pin_file`) at the commit: `{ repository, commit, into, checkout_folder, engine_folder, build }`. `commit` is a commit of the client repository, so the engine commit and the client it serves are one signed unit; a client change is a commit that moves the pin.

Before it packs any target, `publish` reads the pin, checks it field by field (`checkProductPin`: `repository` must be the one the install request's `product_client.repository` named, `build` starts with one of `settings.product_client.programs`, only the placeholders `{checkout}`, `{commit}` and `{out}`, and `{out}` named), fetches the pinned commit with that repository's own read key into `<work>/client/<checkout_folder>`, puts the engine checkout at `<work>/client/<engine_folder>` (the client repository's own layout expects it beside its own), and runs `build` in the checkout: it must write the client into `{out}`, a folder that did not exist. The result is kept under `<work>/client/built/<identity of the pin>` and its files are packed under `product/<into>` of every target's tar.gz (never written into the engine checkout, whose own build refuses a file it does not list under `product/`) (the host, the cross-built Linux and the Mac one): one build serves them all, a later release with the same pin builds nothing, and the newest `keep_built` are kept. A commit with no pin file is published as before. A build that fails, a pin for another repository, a builder with no client repository and a commit that holds its own `product/<into>` beside a pin each refuse the publish (exit 5): no release is signed without the client its commit pins.

install takes `product_client: { repository }` and, for a repository over SSH, makes the builder a second read key (`on_builder.product_key_file`) and answers its public half as `product_deploy_key`, to add to the client repository as a read-only deploy key.

## The Mac target, built here

A builder whose config names `darwin` also publishes each Mac target in it (`aarch64-apple-darwin`) itself, from the same checkout of the same commit, into the same feed: no Mac builds anything and no second feed exists. After the builder's own target, `publish` runs, per Mac target:

1. `cargo zigbuild --release --bin trillion-local --target aarch64-apple-darwin` with `SDKROOT` at the macOS SDK install sent (`settings.darwin.sdk_folder`), `MACOSX_DEPLOYMENT_TARGET` the Mac app's own (13.0) and zig from the venv set-up-darwin-builds.sh made (`CARGO_ZIGBUILD_PYTHON_PATH`). zig is the C, C++ and linker for the target (the engine's bundled SQLite and its ICU build, crates/icu-collation, compile with it); the SDK gives the frameworks zig does not ship (Security and CoreFoundation, which native-tls links).
2. `rcodesign sign` with the Developer ID Application identity and its password, read by path from the receiver's `$CREDENTIALS_DIRECTORY`, `--code-signature-flags runtime`, a timestamp from Apple's server, the identifier `trillion-local` and no entitlements: how trillion-apps scripts/release-macos-app.sh signs the engine the app carries. rcodesign includes Apple's CA chain in the signature when the certificate is Apple-issued, as codesign does.
3. `rcodesign print-signature-info`, held to the requirement trillion-apps CarriedCode.checkRelease admits a release by (`anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "<the app's team>"`), clause by clause, plus the hardened runtime on every code directory (`checkDeveloperId`). A signature that does not meet it is refused before its entry is signed.
4. Packed with `product/`, signed with the builder's key and added like the builder's own target.

Each Mac target is its own entry with its own sequence check: one that fails leaves the Linux entry published, is listed in the answer's `also` with its error, and makes the run exit 4 (`last-run.json` keeps both the release and the error). The app then runs it when all four of its checks hold: the feed key signed it, its target is the Mac's, its sequence is above the bundled engine's, and its program meets the Developer ID requirement. The engine's follower (trillion-rust releases.rs) writes the program itself, so it carries no quarantine attribute and Gatekeeper does not assess it; it is not notarized.

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
| publish config | `{ repository, branch, base_url, work_folder, feed_folder, key_file, state_folder, keep_releases, toolchain: { cargo, rustc, rcodesign?, zig_python? }, receiver: { host, port, path, entry_path }, accept_entries_from, product_client?: { repository }, darwin?: { targets, team_id, sdk_root } }` | Written by install at `/etc/engine-releases/publish.json`. No credential. |
| install request | `{ builder: { address, host_name }, ssh: { known_hosts, identity_file? }, repository: { url, branch }, product_client?: { repository }, keep_releases?, accept_entries_from?: [64 hex], darwin?: { targets?, team_id, sdk } }` | Paths relative to the request file. `darwin.sdk` is a macOS SDK as .tar.xz on the person's computer (`tar -C "$(xcrun --show-sdk-path)/.." -chJf MacOSX.sdk.tar.xz "$(basename "$(xcrun --show-sdk-path)")"`); `team_id` is the Mac app's Developer ID team. |
| `publish` | `(config, { token, commit? }) => entry & { public_key, already_published, dropped, releases_held }` | One release. |
| `accept` | `(config, { token, entry, body }) => entry & { public_key, already_published, dropped, releases_held }` | Another builder's signed entry into this feed, signed again with this builder's key. |
| `contribute` / `packAndSign` | `(request, privatePem, { fetchImpl? }) => { commit, sequence, target, content, bytes, public_key, builder }` / `(request, privatePem) => { entry, body }` | One more target's release, packed, signed and sent. |
| `publishDarwin` / `checkDeveloperId` | `(…) => entry & { public_key, already_published, … }` / `(signatureInfo, team) => void` | One Mac target's cross-build, Developer ID signature and entry / the signature read back, held to the app's requirement. |
| `addRelease` | `(feed, entry, keep) => { feed, added, entry, dropped }` | Throws (exit 3) for an older sequence. |
| `signEntry` / `verifyEntry` | `(entry, pem) => entry` / `(entry, publicHex) => boolean` | The signature. |
| `installBuilder` / `builderStatus` | `(request, { token, secret, run? }) => { public_key, feed_url, receiver_active, feed_status, webhook }` / `(request) => { receiver_active, public_key, releases_held, newest, last_run, feed_status }` | Over SSH. |

## How credentials travel

- The signing key is made on the builder by `make-key` (mode 0400, owned by the builder user) and never leaves it; only its public half is printed.
- The repository token reaches `publish` on descriptor 3. git reads it through a credential helper that reads that descriptor on `get`; it is in no argv, file, environment, log or answer, and cargo never sees it.
- A repository named by an `ssh://` or `git@` URL needs no token: install makes a read key for the builder user on the builder (`on_builder.repository_key_file`, never leaving it), answers its public half as `deploy_key` to add to the repository as a read-only deploy key, and the receiver's git uses it through `GIT_SSH_COMMAND`.
- Another target's builder holds its own signing key: on a hosted runner, a repository secret that the workflow pipes to `contribute` on standard input. Only its public half is in the feed builder's config, and nothing a stranger sends is taken without a signature by that key.
- The Developer ID Application identity (its .p12, as base64) reaches install on descriptor 5 and its password on descriptor 6, from the person's vault. install sends each on the SSH channel's standard input to `systemd-creds encrypt` (`developer-id-p12`, `developer-id-p12-password`), so they rest encrypted with the builder's host key like the other two; the unit opens them into the receiver's `$CREDENTIALS_DIRECTORY`, and `publish` hands rcodesign their paths (`--p12-file`, `--p12-password-file`). No value is in source, argv, the config, a log or the answer. cargo is run without `CREDENTIALS_DIRECTORY` in its environment. The build runs as the same builder user, though, so the repository's own build scripts could still read that folder, as they could read the Ed25519 key: the builder trusts the branch it builds.
- The push secret reaches the receiver on descriptor 4. install hands both from the person's vault (descriptors 3 and 4 on the person's computer) to `systemd-creds encrypt` on the SSH channel's standard input; on the builder they rest encrypted with its host key, and systemd opens them onto the receiver's descriptors 3 and 4 (`LoadCredentialEncrypted`).

## Dependencies

**Depends on:** `tools/content-identity` (BLAKE3, with `@noble/hashes`), Node's `crypto`, `http`, `zlib`, `child_process`; `git`, `tar`, `cargo` and `rustc` on the builder; for `darwin`, zig (the ziglang wheel), cargo-zigbuild, rcodesign (apple-codesign) and a macOS SDK there; `ssh` and `tar` on the person's computer; `apt-get`, systemd 250+, Caddy and ufw on the builder.

**Depended on by:** `tool-rows.json`; the feed is read by the engine's release-feed reader (engine job J1), configured by `tools/start-a-computer`'s `release_feed`.

## Ported from

The older product's Workers Builds deploy (`scripts/deploy-worker.mjs` and `scripts/deploy-batching.json` in the older product repository, before they were removed): every push to main built that commit, uploaded an inactive version and promoted it, and an older commit never won. Here a push event builds and publishes; promotion is each computer adopting from the feed.
