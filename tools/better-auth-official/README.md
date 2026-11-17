# Better Auth (official)

Official [Better Auth](https://www.better-auth.com/docs) (TypeScript, `better-auth` 1.7.25), set up as its docs show: the Node
integration (`toNodeHandler`), the built-in `node:sqlite` database, and the schema the Better Auth CLI generates
(`schema.sql`, from `npx auth generate --config auth.mjs`). No custom auth code.

Plugins: email and password (with `sendResetPassword`), passkey, two factor (TOTP and backup codes), email OTP, magic link,
multi session, API key, JWT (EdDSA, `/api/auth/jwks`), MCP (the OAuth 2.1 authorization server MCP clients connect through,
with Client ID Metadata Documents), device authorization, bearer (the device docs need it so a device's
session token works as `Authorization: Bearer`) and admin (https://www.better-auth.com/docs/plugins/admin). The session
cookie is `__Host-trillion_session`.

## Run

    npm ci
    export BETTER_AUTH_SECRET=<random, 32+ characters>      # from the vault, never printed
    npx auth migrate --config auth.mjs -y
    node server.mjs                                          # BETTER_AUTH_SETTINGS=<file> for another settings file

## settings.json

`port`, `base_url`, `base_path`, `issuer`, `audience`, `database_path`, `session_cookie_name`, `api_key` (`prefix`, `rate_limit` in the plugin's own `rateLimit` shape, `default_permissions`: the scope names a new key reaches, `{"trillion": [names]}`, none by default), `internal` (`host`, `port`, `verify_path`), `passkey` (`rp_id`, `rp_name`),
`trusted_origins`, `attached_origins` (`ask_url`, `cache_ms`, `related_url`), `two_factor_issuer`, `mcp` (`login_page`, `consent_page`, `resource`, `scopes`: what a client may ask for, `resource_scopes`: what the MCP resource allows), `disabled_paths`, `device` (`verification_uri`), `admin` (`user_ids`: the users the admin plugin treats as admins, its `adminUserIds`; none by default), `delete_user` (`enabled`: Better Auth's `user.deleteUser`, so a signed-in person may delete their own user; false by default) and
`email` (`command`, an argv that gets each message as JSON on stdin, or `outbox`, a file each message is appended to).

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
`session.impersonatedBy`) are in `schema.sql` and are added by `npx auth migrate`, which every start runs.
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
mediation, `autocomplete="username webauthn"`), `/sign-in/other-ways` (password, authenticator app, backup code),
`/sign-up` (the same email code), `/sign-in/way?way=email-code&sent=1|password|authenticator|backup-codes`,
`/sign-in/forgot-password`, `/sign-in/add-passkey` (one tap, or Not now), `/sign-in/key` (an API key, for scripts, linked from
no page) and `/sign-out` (Better Auth's sign-out, then `/sign-in`), and the connect pages:

- `/consent` (`mcp.consent_page`): the AI that asked (its `client_name`, from its Client ID Metadata Document), the computer it
  asked for (the host of `resource`), what it may do in plain words (`words.json` `scopes`), "Only approve what you started.",
  Allow and Deny through `POST /api/auth/oauth2/consent`.
- `/device` (`device.verification_uri`): the code a device shows (RFC 8628), then its client and scopes, "Only approve a device
  you are holding.", Allow and Deny through `/api/auth/device/approve` and `/deny`. The person who opens a code claims it.
- `/approve`: see below.

When an AI's connect opens the sign-in (Better Auth's authorize step with a signed query), every page carries that query on
(`pages/oauth-query.mjs`), the sign-in page names the AI (`allowPublicClientPrelogin`), and the end of the sign-in, whether after
the email code, the passkey step, a password or an authenticator, is the same request back at authorize without its signature
parts, so authorize resumes and asks consent. What the pages' forms and buttons do is `pages/sign-in-client.mjs`: each calls
Better Auth through `better-auth/client` with the passkey, email OTP and two-factor client plugins, and its words are
`pages/words.json`. `npm run build-pages` bundles it to `pages/assets/sign-in.js`, served at `/sign-in/assets/sign-in.js`. The
pages load the fonts, mark and icons at the addresses the product already serves them from (`/workspace/fonts.css`,
`/brand/current/mark.svg`, `/favicon.ico`).

## Approving a root declaration (`/approve`, `pages/approve-client.mjs`)

A root declaration is the one JSON document that says which computers and AIs are a person's. Its fingerprint is the lowercase
hex BLAKE3-256 of its canonical bytes (keys sorted at every depth, no whitespace). `/approve?root=<fingerprint>` fetches the
proposed document from `pages/approve.json` `proposed_path`, refuses one whose fingerprint is not the one asked for, says the rows
it adds and removes against `current_path` in plain words (the kind of each row from `words.json` `kinds`, its name from the first
of `approve.json` `summary_fields` it has; no kind is named in code), and one tap of the person's passkey signs it and sends
`{signature, root}` to `signature_path`:

    {"fingerprint": "<hex>", "previous": "<hex>" | null, "signed_at": <ms>,
     "signer": {"issuer": "<origin>", "sub": "<user id>", "credential_id": "<b64url>", "public_key_cose": "<b64url>"},
     "assertion": {"authenticatorData": "<b64url>", "clientDataJSON": "<b64url>", "signature": "<b64url>"}}

The WebAuthn challenge is the 32 bytes of BLAKE3 over the canonical JSON of `{fingerprint, previous, signed_at}`, not the bare
fingerprint. WebAuthn Level 3 (https://www.w3.org/TR/webauthn-3/) section 5.5 lets the challenge be any bytes the authenticator
signs and section 7.2 verifies it, but section 13.4.3 says challenges must not be replayable; a bare fingerprint is the same for
ever, so one old signature could put an old root back. A statement carrying `previous` and `signed_at` is not good for another
position in the chain. A verifier recomputes the statement, checks it against `clientDataJSON.challenge` (base64url), the
`rpIdHash`, the user present and verified flags, the origin and the signature over `authenticatorData || SHA-256(clientDataJSON)`
with the COSE key (ES256 or EdDSA; the passkey plugin offers both, and EdDSA is the one most authenticators choose), and accepts
a root whose `previous` is the current one. `test-fixtures/root-signature-verify.mjs` is that check in JavaScript.
After the first passkey (`/sign-in/add-passkey`) the page `/approve?first=1` makes the person's first root from the place they
signed in (`approve.json` `first_root`), when `current_path` answers `404 {"error": "no_root"}`; any other answer means this place
holds no roots and the page steps aside.

## MCP access tokens

From `/api/auth/oauth2/token` with `resource` set to `mcp.resource`: EdDSA JWTs, header `typ` `at+jwt` and the JWKS `kid`,
`iss` the issuer, `aud` naming `mcp.resource` (and the userinfo URL), `sub`, `azp`, `scope`, `exp`, `iat`.

## Discovery

`/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource` (RFC 9728).
