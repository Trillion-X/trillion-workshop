# Better Auth (official)

Official [Better Auth](https://www.better-auth.com/docs) (TypeScript, `better-auth` 1.7.25), set up as its docs show: the Node
integration (`toNodeHandler`), the shared Postgres store below through Better Auth's Kysely PostgreSQL adapter, and the schema the Better Auth
CLI generates (`schema.sql`, from `npx auth generate --config auth.mjs` on a database). No custom auth code.

Plugins: email and password (with `sendResetPassword`), passkey, two factor (TOTP and backup codes), email OTP, magic link,
multi session, API key, JWT (EdDSA, `/api/auth/jwks`), MCP (the OAuth 2.1 authorization server MCP clients connect through,
with Client ID Metadata Documents), device authorization, bearer (the device docs need it so a device's
session token works as `Authorization: Bearer`) and admin (https://www.better-auth.com/docs/plugins/admin). The session
cookie is `session_cookie_name`, or `__Host-<site.storage_prefix>_session`.

## Run

    npm ci
    export BETTER_AUTH_SECRET=<random, 32+ characters>      # from the vault, never printed
    export BETTER_AUTH_STORE_CONNECTION=<postgres connection string>   # the credential settings.json store.credential names
    node server.mjs                                          # BETTER_AUTH_SETTINGS=<file> for another settings file

## The store

Every Better Auth process of a sign-in shares one Postgres database (users, passkeys, the one-time passkey challenge, email-code and
authorization-code rows, sessions, grants, and the `jwks` signing keys, whose private halves Better Auth encrypts with
`BETTER_AUTH_SECRET`), so a passkey sign-in asked on one process finishes on another, and a code, an authorization code or a refresh
token works once whichever process is asked (test/store-shared-by-processes.test.mjs runs two processes on one store and proves each).
settings.json `store` names the credential (`credential`) and the environment variable (`env`) the engine or the unit hands the process
it under, and the pool size; this tool never reads a vault. `store.mjs` makes the pool and, at every start, makes or updates Better
Auth's tables for the options that process runs, holding an advisory lock so processes starting together do it one at a time
(`schema.sql` is what `npx auth generate` writes for them). `session.cookie_cache_seconds` is how long a signed session cookie answers
without a store read; the store stays the authority for revocation.

The tests run on a real Postgres (the embedded-postgres package,
test-fixtures/embedded-store.mjs), with no install and no sudo.

## settings.json

`port`, `base_url`, `base_path`, `issuer`, `audience`, `store` (`credential`, `env`, and the driver Better Auth is handed as its database: `module`, its `export`, the constructor's `arguments` with `{connection}` for the connection string, `close`, the method that ends it, and `migration_lock`, the store's own `take` and `give` statements held around a migration, or null; another store is a settings change), `session_cookie_name`, `api_key` (`prefix`, `rate_limit` in the plugin's own `rateLimit` shape, `default_permissions`: the scope names a new key reaches, `{"<resource>": [names]}`, none by default), `internal` (`host`, `port`, `verify_path`), `passkey` (`rp_id`, `rp_name`),
`trusted_origins`, `attached_origins` (`ask_url`, `cache_ms`, `related_url`), `two_factor_issuer`, `mcp` (`login_page`, `consent_page`, `resource`, `scopes`: what a client may ask for, `resource_scopes`: what the MCP resource allows), `disabled_paths`, `device` (`verification_uri`), `admin` (`user_ids`: the users the admin plugin treats as admins, its `adminUserIds`; none by default), `delete_user` (`enabled`: Better Auth's `user.deleteUser`, so a signed-in person may delete their own user; false by default) and
`email` (`from`: the address mail comes from; `sender`: a description of an email provider's request, the published one at
email-providers/resend.json or the person's own, named in their computer's layout row: `name`, `vault_key` (the name of the credential its auth header carries, read at each
send from the unit's credentials folder, `CREDENTIALS_DIRECTORY`, never a value in settings), `request` (`url`, `method`, `headers`,
`auth` {`header`, `prefix`}, `body`: the JSON body with `{from}`, `{to}`, `{subject}` and `{text}` filled in, `timeout_ms`),
`message_id_at` (where the accepted answer holds the message's id) and `error_at` (where a refusal holds its reason)). The words of
each message are `email-words.json`, by kind. No sender, or an answer that is not accepted with an id, is an error: the page says the
code could not be sent, and no message is kept anywhere else. test-fixtures/stand-in-sender.mjs is a provider on a loopback port the
tests send to.

`email_code` (`digits`, `expires_in_seconds`, `attempts`, `sends_per_window`, `window_seconds`: the email code the pages tell people about), `email_password` (`require_verification`: a password signs in only after its address is proven), `add_passkey_link` (`expires_in_seconds`: the one-time link that adds a passkey on another device), `session` (`fresh_age_seconds`: how recent a sign-in adding a passkey or changing an email needs; `cookie_cache_seconds`: how long a signed session cookie answers without a store read) and `rate_limit` (`enabled`).

`mcp.loopback_resources` (`hosts`, `path`, `name`: a person's own engine names itself as the resource an AI asks for, its loopback address, a port and `/mcp`, one per computer, so no list of them is configured: a resource that is exactly one of these hosts over http at a port with this path is accepted, and a row for it is made on first use (`loopback-resource.mjs`); every other host is refused; the same hosts, over http at a port, are the only origins the token endpoint (POST) and the authorization server metadata (GET) name for a page's own fetch, with no cookie: `loopback-cors.mjs`), `cimd` (`fetch_module`: the module that fetches an AI product's client metadata document, `@better-auth/cimd/node` by default; a test names a stand-in), `mcp.always_offline_access` (an AI's authorize request gets the `offline_access` scope when it left it out, so a refresh token is always issued; the consent page then says "Stay connected while you keep using it"), an AI's access has no end by default (the account owner, Nov 17 2026): Better Auth's `refreshTokenExpiresIn` is `mcp.refresh_token_no_end_seconds`, and each refresh makes a new token with that window again, unless the person set a limit for that AI; that file is the one place that holds the number, and the `/connected` list's `ended_text` is drawn from its words, and

`disabled_paths` is `["/token"]`: the JWT docs' OAuth Provider Mode says to turn off the session JWT route when MCP is on,
because session JWTs share the access tokens' signing key. OAuth and MCP clients get tokens from `/api/auth/oauth2/token`.
Empty `disabled_paths` and `GET /api/auth/token` hands back a session JWT (EdDSA; `kid` names the JWKS key; claims `sub`,
`iss`, `aud`, `exp`, `iat`, `email`, `name`).

## Who a pass is

A pass names the person by its subject: the user's id. The session JWT is its default payload, and MCP access tokens (`at+jwt`,
`aud` holding `mcp.resource`) add the user's `email` and `email_verified` through the OAuth provider's `customAccessTokenClaims`
(auth.mjs), so a door can tell a proven inbox from a typed one. The access token's `scope` names the method patterns (`wake:*`,
`tools:*`, `tools:list`, `sharing.*`, `secrets:*`) the client was granted; the engine reaches a method only through a pattern that matches it. A computer serves a person when someone at that computer
added them (the engine's `POST /persons/add` at its own loopback address); the pass carries no
computer or account address, and this tool keeps none.

## Teams in every pass

Teams are Better Auth's own organization plugin with teams on (https://www.better-auth.com/docs/plugins/organization); nothing here keeps a team or
a member list, and `settings.teams` turns it on (absent: no plugin, no claim). A person makes an organization (`POST /api/auth/organization/create`)
and a team in it (`/organization/create-team`), invites a person (`/organization/invite-member`), who accepts (`/organization/accept-invitation`),
and puts them in a team (`/organization/add-team-member`) or takes them out (`/organization/remove-team-member`); making an organization puts its maker
in its default team. These are the plugin's session endpoints: a signed-in person's session (cookie or the bearer session token), not an AI's access
token, which reaches the engines and not this tool.

Every pass this tool signs carries the ids of the person's teams, newest first, as the claim `settings.teams.claim` names (`team_ids`, an array of strings,
empty for a person in no team): the session JWT through the jwt plugin's `definePayload`, and an AI's access token through the OAuth provider's
`customAccessTokenClaims`, read from the plugin's `teamMember` rows (teams-claim.mjs). `settings.teams.most` (100) is how many ids one pass carries: a computer
refuses a pass past its token size (8192 bytes), so a person in more teams carries the newest 100 and never a pass no computer takes. A computer that granted a
team admits the people whose pass holds its id (the engine's share grant); it learns a person joined at their next pass and that they left
when their last pass expires. That lag is the access token's life, `settings.mcp.access_token_seconds` (3600 today, the mcp plugin's `accessTokenExpiresIn`),
and a session JWT's own end. test/teams.test.mjs proves the claim for a member, for a member taken out, for a person in no team and for the cap.

## Removing a user

The admin plugin's `POST /api/auth/admin/remove-user {"userId"}` (`authClient.admin.removeUser`) deletes a user and its
sessions and accounts; the tables whose `userId` references the user with `on delete cascade` lose that user's rows too. Only a signed-in user whose id `admin.user_ids` names may call it (401 with no
session, 403 for anyone else); an admin cannot remove themself. An admin needs no device: a user made with email and
password signs in with them, and once the computer's row names its id under `admin.user_ids` and the computer is
started again, its session removes users. The plugin's columns (`user.role`, `banned`, `banReason`, `banExpires`,
`session.impersonatedBy`) are in `schema.sql` and are added by the migration every start runs (store.mjs).
test/admin-remove-user.test.mjs proves the refusals and one removal that leaves every other user.

A signed-in person deletes their own user with `POST /api/auth/delete-user {"password"}` (Better Auth's `user.deleteUser`,
https://www.better-auth.com/docs/concepts/users-accounts#delete-user), on by default (`delete_user.enabled`); a computer that must
not offer it sets `false`, and the address then answers 404. An account with no password deletes on a sign-in that is fresh
(`session.fresh_age_seconds`), which the page's Delete step turns into a sign-in and back. Before anything is deleted,
the business's own clean-up removes the person's rows in its own database, by one of two ways that name no code of this tool.
`delete_user.before_delete_module` (a path from this folder, exporting `beforeDelete(user, request)`) is for a business whose code sits
in this folder. `delete_user.before_delete_url` is for a unit whose copy of this tool is a pinned checkout: an http address on this
computer, `127.0.0.1` or `localhost` only (any other address stops the server at start, with the reason), that receives
`POST {user_id, email}` as JSON. The request carries `x-sign-in-timestamp` (whole seconds) and `x-sign-in-signature`, which is
`sha256=` plus the HMAC-SHA256 in lower-case hex of `<timestamp>.<raw body>` under the secret the unit holds, named by
`delete_user.before_delete_secret` (a credential in the credentials folder, `CREDENTIALS_DIRECTORY`). The business checks that
signature over the raw body and refuses a timestamp more than a few minutes old. `before_delete_timeout_ms` (default 10000) bounds
the wait. A throw from either clean-up, a refused connection, a timeout or any answer other than 2xx keeps the account, and the
person sees the deletion did not happen. A retry calls the clean-up again, so it must be safe to run twice for one person.
The person's API keys are removed once the account is gone.
An admin cannot remove themself, so the last admin of a cleanup deletes itself this way. test/delete-user.test.mjs proves the
switch, the password, the business hook and the keys; test/delete-hook-url.test.mjs proves the address: 2xx deletes, any other answer,
a timeout or a refused connection keeps, the signature checks, and a non-local address is refused at start.

## The engine's API key check

A personal API key starts with `api_key.prefix` (`tr_`): a `hooks.before` on `/api-key/create` drops any prefix the request
named. The key's user is the person it signs in. Better Auth's `verifyApiKey` is server-only, so the engine calls it on the
computer's own listener, `internal` (`127.0.0.1:8793`, which Caddy never routes to): `POST /api-key/verify {"key": "tr_..."}` answers
`{"valid": true, "key": {"id", "userId", "permissions": {"<resource>": [scope names]}}}` or `{"valid": false, "key": null}`, and 400
for a body with no key. `api_key.rate_limit` is `{"enabled": false}`: the plugin's default (10 checks a key a day) would
make a key invalid after the engine's tenth request.

## Whether a credential still stands

A wake's delegation lasts only while the switcher's credential stands. The engine asks the same `internal` listener
`POST /credential/standing {"credential": "<id>"}` (`credential_standing.path`) and reads `{"valid": true|false}`; it asks by
the credential's id (`key:<key id>`, `session:<user>`, `mcp-access:<user>:<client>`), never with the credential itself.
`credential_standing.kinds` says what each id means: `api_key` stands while Better Auth's key row exists, is enabled and has
not expired, `session` while the user holds a session that has not ended, `client_grant` while the client holds an unrevoked
refresh or access token of the user. Every kind needs the user to exist and not be banned. An unknown kind or id answers false.
No copy of a key or session is kept: the answer is read from Better Auth's own records (credential-standing.mjs).

## Attached names

Every name a live account attached signs in with no settings change. `trustedOrigins` is a function
(attached-origins.mjs): the home `trusted_origins`, and a request's own `Origin` when it is https with no port and
`attached_origins.ask_url?domain=<host>` (the front door's certificate ask) answers 200; each answer is kept `cache_ms`.
A native app may use the passkeys in its own window when the app's associated domains name the `rp_id` host and that host answers `GET /.well-known/apple-app-site-association` with the app: `settings.apps.webcredentials` lists them (`<team id>.<bundle id>` each), served by server.mjs and routed with the webauthn document (on-a-computer/caddy-route-better-auth-webauthn.caddy); an empty list serves nothing. Passkeys keep one `rp_id` (the plugin has one) and use WebAuthn Related Origin Requests: `GET /.well-known/webauthn`
answers `{origins}`, the home origins plus `related_url`'s list, and the plugin takes a reported origin that
`trustedOrigins` names because `passkey` sets no `origin`. Browsers without related origins (Firefox), and names past the fifth distinct
registrable domain in that list (the clients' limit), make passkeys only on the home name. Start-a-computer's `every_name_routes: ["better-auth"]`
sends each attached name's `/api/auth/*` here.

## Sign-in pages

`pages/shell.html` is the one head, style set and script set every page shares. `pages/routes.json` says which `pages/sections/`
files are drawn inside it for each address, with the page's own `title` and `description`; a new page is a section file and a
row. The addresses: `/sign-in` (an email code, a passkey, and passkeys listed in the email box itself by WebAuthn conditional
mediation, `autocomplete="username webauthn"`), `/sign-in/other-ways` (a password; the authenticator app and backup code are asked after it),
`/sign-in/way?way=email-code&sent=1|password|authenticator|backup-codes`,
`/sign-in/forgot-password`, `/sign-in/add-passkey` (one tap, or Not now), `/sign-in/key` (an API key, for scripts, linked from
no page) and `/sign-out` (Better Auth's sign-out, then `/sign-in`), and the connect pages:

- `/consent` (`mcp.consent_page`): the AI's name in one line ("<AI> wants to work in your {{name}}."), Allow and Deny, and under a small
  Details link what it may do in plain words (`words.json` `scopes`) and the Read only switch; "Not you? Sign out" is small at the
  bottom. The person is never shown an address, a port, a redirect or a word on `pages/plain-words.json` (test/plain-words.test.mjs
  renders every page and the words the script may show, and fails on any). An AI whose return address is not its document's own (or
  a loopback one) is called "We don't know this app." with Deny as the main button. A program named in settings `mcp.first_party_clients`
  (empty in the shared tool; the computer that runs it names its own programs' client documents; `GET /first-party?client_id=`
  says whether one is) is answered Allow at once and the person sees "You're signed in. You can close this tab.". Read only sends
  `read_only` with the answer: `pages/sign-in-rules.json` `read_only_swaps` replaces each pattern that has a reading-only one
  (`tools:*` by `tools:list`) and `read_only_drops` leaves out those with none (`wake:*`, `sharing.*`, `secrets:*`). The authorize
  hook asks the variants alongside the full scope, because Better Auth accepts only scopes the signed request named, and a full grant
  leaves the variants out. `prompt=consent` is added to an external authorize GET, so an AI that is already connected shows
  "Connecting ..." with an Undo for `remembered_seconds` and then continues; Undo revokes it and denies. The consent POST needs the
  sign-in cookie (SameSite=Lax) and a trusted Origin (`test/consent-grants.test.mjs` refuses evil, null and missing Origin).
- `/connected`: the AIs the person has connected (name, what it can do, connected since, last used: the newest refresh token's
  `createdAt`) with one-tap Disconnect, through `GET /api/auth/connected` and `POST /api/auth/connected/revoke {clientId}`, which
  deletes its refresh tokens, access tokens and consent in one transaction (a refresh token left standing could be answered again
  inside the replay window, so none is left). An AI with no refresh token standing is listed as ended: `ended_by` `unused` (its
  newest token passed its end; `ended_text` "Access ended: not used for {days} days." with `ended_at`; only when the person set a limit for that AI, since by default an AI's access has no end: `mcp.refresh_token_no_end_seconds`) or `chain_ended` (an old token was used a
  second time, which makes Better Auth delete the whole chain; "Access ended."), with `reconnect_url` (the AI's own https `uri`;
  none when it has none, and the page then says to open the AI and connect it again) as one tap Reconnect beside Disconnect.
  A grant stands (credential standing) while it holds a token that is not revoked and has not ended.
  The person's limit for one AI is `idleLimitDays` on its consent row (a plugin column), set by `POST /connected/limit {clientId, days|null}` on the Connections page and applied to that AI's tokens now and to each one made later (an after hook on `/oauth2/token`). `test/access-ends.test.mjs` runs the no-end default, a limit and its renewal, clearing it, 100 days of daily use, unused past a limit, reuse ending the chain, and revoke.
- `/device` (`device.verification_uri`): the code a device shows (RFC 8628), then its client and scopes, "Only approve a device
  you are holding.", Allow and Deny through `/api/auth/device/approve` and `/deny`. The person who opens a code claims it.

When an AI's connect opens the sign-in (Better Auth's authorize step with a signed query), every page carries that query on
(`pages/oauth-query.mjs`), the sign-in page names the AI (`allowPublicClientPrelogin`), and the end of the sign-in, whether after
the email code, the passkey step, a password or an authenticator, is the same request back at authorize without its signature
parts, so authorize resumes and asks consent. What the pages' forms and buttons do is `pages/sign-in-client.mjs`: each calls
Better Auth through `better-auth/client` with the passkey, email OTP and two-factor client plugins, and its words are
`pages/words.json`. `npm run build-pages` bundles it to `pages/assets/sign-in.js`, served at `/sign-in/assets/sign-in.js`. The
pages load the fonts, mark and icons at the addresses the product already serves them from (`/workspace/fonts.css`,
`/site/current/mark.svg`, `/favicon.ico`).

## Whose sign-in it is: `settings.site`

The tool's own files name no product, colour or logo. The computer that runs it supplies one block, `settings.site`: `name` (every `{{name}}` in
pages, routes and email words, `{name}` in email words, the passkey relying party name and the authenticator issuer), `cli` (`{{cli}}`),
`storage_prefix` (every key the pages keep in the browser, and the session cookie `__Host-<prefix>_session` unless `session_cookie_name` is
set), `theme` (`data_theme`, `scheme`, `theme_color`: the Screen Look theme the pages wear), `look_css` (that theme's resolved tokens),
`share` (link-preview title and description, or null), `links` (head links: manifest, icons, font sheets), `mark_svg` (text) and
`wordmark_png` (base64), served as `mark.svg` and `wordmark.png` under the assets path, and `email` (`palette`, `made_with_label`: the look
email-message-html.mjs draws every email in). `settings.json` ships a neutral "Example" stand-in. test/site-blind.test.mjs fails when a
source file of this tool names a product.

## Sign-in edge cases (the old product's, ported)

From r6-sign-in-edge-cases.md, each with the old commit it comes from:

- A mail that did not go is an error, not "on its way" (cf1ce01b96): every send is awaited, and an after hook turns a send Better
  Auth only logged as failed into `EMAIL_NOT_SENT`, which the page says in words (`not_sent`).
- A code's digits, life, tries and sends per window are `settings.json` `email_code` (1357b4cfe0, `sign-in-email.json`); the pages
  say the same minutes (`{{minutes}}`, drawn by pages.mjs); the expiry and the tries have their own words.
- An address nobody proved cannot be taken with a password (02a2eb83ce, 78477700c9): `email_password.require_verification`, and
  the owner's first code clears a password and sessions registered before it proved the address.
- After every sign-in (`afterSignIn`): for an AI's connect or a device code, straight
  on to it, with no passkey step between; else, once, a passkey if this device can hold one, has none here and the person did not say
  Not now (9cdfdfb875, a17026f3e5; `pages/sign-in-rules.json` `skip_days`), tried quietly first with conditional create where the browser
  has it (the page is shown when it does not fire, because a person who never sees it never gets a passkey); then where they were going.
  There is no password offer. `/sign-up` is `/sign-in` (a 301), because the email code makes the account either way.
- Passkey steps end in words by error code, and a device that already holds a passkey is done (a773be1476, e9e19cd34f,
  src/passkey-step.json; `words.json` `passkey_errors`). A failed sign-in passkey focuses "Email me a code".
- Adding a passkey needs a recent sign-in (`session.fresh_age_seconds`, 13a9416da9); a page for a signed-in person opened signed
  out goes to sign-in and comes back (`next`).
- A passkey on another device: a one-time link by email (magic link, `add_passkey_link.expires_in_seconds`, a day) that signs
  that device in and opens `/sign-in/add-passkey` (21348b98b6, 9712729c52).
- `/sign-in/change-email`: Better Auth's changeEmail, a link to the current address and one to the new (21348b98b6).
- `/account`: the person's name, email and sign-in methods (passkeys, authenticator app, password, connected accounts), each with
  the page that changes it, and Delete my account (confirm step, then delete-user). test/account-page.test.mjs proves the page.
- Authenticator app and backup codes are asked after a password, where Better Auth's second step has its pending cookie; the pages
  that cannot start them no longer link them. Not ported here: rows 14 (Signal API), 20 (app association file), 26 (mail words).

## How an AI product connects

Claude and ChatGPT use their client metadata document's https address as `client_id` (CIMD); Better Auth fetches and reads it, the person
consents, the AI trades the code for tokens. `test/cimd-connect.test.mjs` runs that against a stand-in transport
(`test-fixtures/cimd-stand-in.mjs`) and checks that a refresh token comes and refreshing works. A refresh token needs `offline_access`
in the request, and the protected-resource document leaves it out by design, so `mcp.always_offline_access` adds it.

## MCP access tokens

From `/api/auth/oauth2/token` with `resource` set to `mcp.resource`: EdDSA JWTs, header `typ` `at+jwt` and the JWKS `kid`,
`iss` the issuer, `aud` naming `mcp.resource` (and the userinfo URL), `sub`, `azp`, `scope`, `exp`, `iat`.

## Discovery

`/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource` (RFC 9728).

## On a computer

`on-a-computer/` holds what a computer row names to run this tool:
- `serve-better-auth.service`: the unit's template. start-a-computer's README says which fields it reads.
- `caddy-route-*`: the web server's routes to it. `caddy-route-better-auth-pages.mjs` builds its route from `pages/routes.json`, so a page added here is routed with no list in any row.

A row names each file by path, such as `tools/better-auth-official/on-a-computer/serve-better-auth.service`.

## Busy

A sign-in server that answers 429 or any 5xx is busy, not ended: every page's failed answer goes through one `refusal` in
`pages/sign-in-client.mjs`, which shows the terminal's busy sentence (`words.sign_in_busy` in
`tools/use-your-tools-from-a-shell/do-work/command.json`, its `{site_name}` filled with the site's name) in the shared alert with Try again.
`pages/busy.mjs` holds the test for busy and the sentence; test/busy.test.mjs answers 429, 500, 502, 503 and 504 over HTTP and checks the words.
