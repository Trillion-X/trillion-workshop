# Better Auth (official)

Official [Better Auth](https://www.better-auth.com/docs) (TypeScript, `better-auth` 1.7.25), set up as its docs show: the Node
integration (`toNodeHandler`), the shared Postgres store below through Better Auth's Kysely PostgreSQL adapter, and the schema the Better Auth
CLI generates (`schema.sql`, from `npx auth generate --config auth.mjs` on a database). No custom auth code.

Plugins: email and password (with `sendResetPassword`), passkey, two factor (TOTP and backup codes), email OTP, magic link,
multi session, API key, JWT (EdDSA, `/api/auth/jwks`), MCP (the OAuth 2.1 authorization server MCP clients connect through,
with Client ID Metadata Documents), device authorization, bearer (the device docs need it so a device's
session token works as `Authorization: Bearer`) and admin (https://www.better-auth.com/docs/plugins/admin). The session
cookie is `__Host-trillion_session`.

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

`migrate-sqlite-to-postgres.mjs <better-auth.db>` is the one-time move from the old SQLite file: every table, every id, the jwks keys
byte for byte, read back before it commits, refused when the store already holds a user (test/store-migration.test.mjs). Run it with the
tool stopped on a copy of the file made when nothing was writing. The tests run on a real Postgres (the embedded-postgres package,
test-fixtures/embedded-store.mjs), with no install and no sudo.

## settings.json

`port`, `base_url`, `base_path`, `issuer`, `audience`, `store` (`credential`, `env`, `pool_size`), `session_cookie_name`, `api_key` (`prefix`, `rate_limit` in the plugin's own `rateLimit` shape, `default_permissions`: the scope names a new key reaches, `{"trillion": [names]}`, none by default), `internal` (`host`, `port`, `verify_path`), `passkey` (`rp_id`, `rp_name`),
`trusted_origins`, `attached_origins` (`ask_url`, `cache_ms`, `related_url`), `two_factor_issuer`, `mcp` (`login_page`, `consent_page`, `resource`, `scopes`: what a client may ask for, `resource_scopes`: what the MCP resource allows), `disabled_paths`, `device` (`verification_uri`), `admin` (`user_ids`: the users the admin plugin treats as admins, its `adminUserIds`; none by default), `delete_user` (`enabled`: Better Auth's `user.deleteUser`, so a signed-in person may delete their own user; false by default) and
`email` (`command`, an argv that gets each message as JSON on stdin, or `outbox`, a file each message is appended to).

`email_code` (`digits`, `expires_in_seconds`, `attempts`, `sends_per_window`, `window_seconds`: the email code the pages tell people about), `email_password` (`require_verification`: a password signs in only after its address is proven), `add_passkey_link` (`expires_in_seconds`: the one-time link that adds a passkey on another device), `session` (`fresh_age_seconds`: how recent a sign-in adding a passkey or changing an email needs; `cookie_cache_seconds`: how long a signed session cookie answers without a store read) and `rate_limit` (`enabled`).

`cimd` (`fetch_module`: the module that fetches an AI product's client metadata document, `@better-auth/cimd/node` by default; a test names a stand-in), `mcp.always_offline_access` (an AI's authorize request gets the `offline_access` scope when it left it out, so a refresh token is always issued; the consent page then says "Stay connected until you take it away"), and

`disabled_paths` is `["/token"]`: the JWT docs' OAuth Provider Mode says to turn off the session JWT route when MCP is on,
because session JWTs share the access tokens' signing key. OAuth and MCP clients get tokens from `/api/auth/oauth2/token`.
Empty `disabled_paths` and `GET /api/auth/token` hands back a session JWT (EdDSA; `kid` names the JWKS key; claims `sub`,
`iss`, `aud`, `exp`, `iat`, `email`, `name`).

## Who a pass is

A pass names the person by its subject: the user's id. The session JWT is its default payload, and MCP access tokens (`at+jwt`,
`aud` holding `mcp.resource`) add the user's `email` and `email_verified` through the OAuth provider's `customAccessTokenClaims`
(auth.mjs), so a door can tell a proven inbox from a typed one. The access token's `scope` names the Trillion scopes (`records`,
`tools`, `account`, `vault`, `namespace-read`) the client was granted. A computer serves a person when someone at that computer
added them (trillion-rust `POST /persons/add` at its own loopback address, which `trillion login` calls); the pass carries no
computer or account address, and this tool keeps none.

## Removing a user

The admin plugin's `POST /api/auth/admin/remove-user {"userId"}` (`authClient.admin.removeUser`) deletes a user and its
sessions and accounts; the tables whose `userId` references the user with `on delete cascade` lose that user's rows too. Only a signed-in user whose id `admin.user_ids` names may call it (401 with no
session, 403 for anyone else); an admin cannot remove themself. An admin needs no device: a user made with email and
password signs in with them, and once the computer's layout row names its id under `admin.user_ids` and the computer is
started again, its session removes users. The plugin's columns (`user.role`, `banned`, `banReason`, `banExpires`,
`session.impersonatedBy`) are in `schema.sql` and are added by the migration every start runs (store.mjs).
test/admin-remove-user.test.mjs proves the refusals and one removal that leaves every other user.

With `delete_user.enabled` true, a signed-in person deletes their own user with `POST /api/auth/delete-user {"password"}`
(Better Auth's `user.deleteUser`, https://www.better-auth.com/docs/concepts/users-accounts#delete-user); off, the address
answers 404. An admin cannot remove themself, so the last admin of a cleanup deletes itself this way, and the layout row
then turns it off again. test/delete-user.test.mjs proves both.

## The engine's API key check

A personal API key starts with `api_key.prefix` (`tr_`): a `hooks.before` on `/api-key/create` drops any prefix the request
named. The key's user is the person it signs in. Better Auth's `verifyApiKey` is server-only, so the engine calls it on the
computer's own listener, `internal` (`127.0.0.1:8793`, which Caddy never routes to): `POST /api-key/verify {"key": "tr_..."}` answers
`{"valid": true, "key": {"id", "userId", "permissions": {"trillion": [scope names]}}}` or `{"valid": false, "key": null}`, and 400
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
Passkeys keep one `rp_id` (the plugin has one) and use WebAuthn Related Origin Requests: `GET /.well-known/webauthn`
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

- `/consent` (`mcp.consent_page`): the AI that asked (its `client_name`, from its Client ID Metadata Document), the computer it
  asked for (the host of `resource`), what it may do in plain words (`words.json` `scopes`), "Only approve what you started.",
  Allow and Deny through `POST /api/auth/oauth2/consent`. The owner's AI is given everything by default; "Read only" is a switch
  that sends `read_only` with the answer, and the `narrowConsent` hook then drops the scopes named in `pages/sign-in-rules.json`
  `read_only_drops` (the engine's scopes have no read variants yet, so a read variant is added there, not in code). A client
  known by its own https document, returning to a host that belongs to that document's domain (or to loopback), gets Allow as the
  primary button; any other host gets Deny as primary and Allow stays disabled until the person types the host. No code is
  matched and no end date is asked. `prompt=consent` is added to an external authorize GET, so an AI that is already connected
  shows "Connecting ..." with an Undo for `remembered_seconds` and then continues; Undo revokes it and denies. The consent POST
  needs the sign-in cookie (SameSite=Lax) and a trusted Origin (`test/consent-grants.test.mjs` refuses evil, null and missing
  Origin).
- `/connected`: the AIs the person has connected (name, what it can do, connected since, last token issued) with one-tap
  Disconnect, through `GET /api/auth/connected` and `POST /api/auth/connected/revoke {clientId}`, which ends its refresh tokens,
  access tokens and consent in one transaction.
- `/device` (`device.verification_uri`): the code a device shows (RFC 8628), then its client and scopes, "Only approve a device
  you are holding.", Allow and Deny through `/api/auth/device/approve` and `/deny`. The person who opens a code claims it.

When an AI's connect opens the sign-in (Better Auth's authorize step with a signed query), every page carries that query on
(`pages/oauth-query.mjs`), the sign-in page names the AI (`allowPublicClientPrelogin`), and the end of the sign-in, whether after
the email code, the passkey step, a password or an authenticator, is the same request back at authorize without its signature
parts, so authorize resumes and asks consent. What the pages' forms and buttons do is `pages/sign-in-client.mjs`: each calls
Better Auth through `better-auth/client` with the passkey, email OTP and two-factor client plugins, and its words are
`pages/words.json`. `npm run build-pages` bundles it to `pages/assets/sign-in.js`, served at `/sign-in/assets/sign-in.js`. The
pages load the fonts, mark and icons at the addresses the product already serves them from (`/workspace/fonts.css`,
`/brand/current/mark.svg`, `/favicon.ico`).

## Sign-in edge cases (old Trillion's, ported)

From r6-sign-in-edge-cases.md, each with the old Trillion commit it comes from:

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
