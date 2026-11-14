# Start a computer

Rent a Linux machine through a provider row or adopt an existing machine over SSH, install a caller-supplied engine release, write its config, start it and read back its sign-up page and monthly price. Provider credentials arrive on private pipes, never in argv, a lease or an answer.

The request must provide `product_settings`: a JSON object or an absolute JSON file path. `readRequest(file)` resolves a relative settings path against the request file. The settings must include `new_accounts.sign_in`, `sign_in_ways`, `sign_in_words`, `copies` and `copies_rules`. The tool supplies no product identity, engine program name, starting account fixture or release-feed default.

A start or update reads one settings snapshot before it contacts the machine. Those exact bytes are written as the remote settings file, and that snapshot's `new_accounts` fills missing config rows. Existing config rows remain intact; copies are the request's explicit policy or the supplied product policy bounded by the number of default holders. Copy counts follow the engine's admission bound and ordering rules. The engine remains responsible for validating each row's full schema.

A request's `release_feed` selects its signed feed. An omitted or null feed selects none for a start. An update requires an explicit feed; when its `releases` is an object rather than an absolute folder, the computer's existing releases folder is used.

## Requests and commands

Run `node tools/start-a-computer/do-work/start-a-computer.mjs OPERATION ...`. Operations are `price REQUEST`, `rent REQUEST`, `start REQUEST`, `status LEASE`, `install LEASE REQUEST`, `update LEASE REQUEST`, `rollback LEASE REQUEST BACKUP` and `remove LEASE`.

A start request names `lease_file`, `machine`, `name`, `ssh`, `port`, `engine` and `product_settings`. Engine inputs include its file, data environment name, data folder and release. Optional inputs include `place_config`, `config_from_release`, `default_places`, `copies`, `public_origin` and `release_feed`. Local file paths are relative to the request file. An update also accepts `layout` overrides; otherwise the running service's own config, current link, state folder, owner and release folder are discovered.

A computer's layout row (`request.host_layout`) may also name the sign-in unit: a unit with `template: serve-better-auth` runs official Better Auth from the Workshop's `tools/better-auth-official` folder (clone, `npm ci`, migrate, `node server.mjs`), with `workshop`, `repository`, `tool_folder`, `node_bin`, `user` and `writable`; its `settings` object is written as JSON to `settings_file`; its secret is named by `secret_vault_key` and read by systemd from `secret_file` (`LoadCredential`), never held in the row. `caddy.routes: ["better-auth"]` with `caddy.auth_port` sends `/api/auth/*` and `/.well-known/oauth-authorization-server*` to it.

Updates back up replaced config, service unit, settings and release pointer. A failed service health check or sign-up response restores them. Explicit rollback uses the same backup and layout. Removal deletes only resources the saved lease owns; adopted machines are forgotten without deleting them.

## Source and checks

This is the existing canonical `start-a-computer` owner, recovered from its committed public origin implementation. Earlier product-filled DATA remains in that Git history; it is not a production default here. Recovery does not assert a new historical byte-copy baseline. The old `start-a-place` working files are outside this recovery's custody.

`test/start-a-computer.test.mjs` covers provider ownership, pricing, lease lifecycle, complete starts and updates, discovered layouts, failed-health rollback, exact settings snapshots and starting-row merges, using synthetic caller settings.

The shell commands target GNU/Linux. Tests discover a genuine GNU coreutils `mv` or `gmv` by its version, searching PATH and standard package bin folders. Each fixture links that executable as `mv` in its own PATH folder. Install coreutils when the discovery error names it; BSD `mv` is refused. Run plain `node --test tools/start-a-computer/test/start-a-computer.test.mjs`; an external PATH override is unnecessary. The shared test selector lives in `tools/process-session/test/target-tools.mjs`. Production SSH commands remain unchanged.
