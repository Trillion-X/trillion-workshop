# Better Auth (official)

Official [Better Auth](https://www.better-auth.com/docs) (TypeScript, `better-auth` 1.7.23), set up as its docs show: the Node
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

`port`, `base_url`, `base_path`, `issuer`, `audience`, `database_path`, `session_cookie_name`, `account_claim` (`field`, `claim`, `create`), `api_key` (`prefix`, `rate_limit` in the plugin's own `rateLimit` shape, `default_permissions`: the scope names a new key reaches, `{"trillion": [names]}`, none by default), `internal` (`host`, `port`, `verify_path`), `key_check` (`path`, `use`), `computer_proof` (the proof domains, window, row domain and address context, the same values as trillion-rust computers/settings.json), `passkey` (`rp_id`, `rp_name`),
`trusted_origins`, `attached_origins` (`ask_url`, `cache_ms`, `related_url`), `two_factor_issuer`, `mcp` (`login_page`, `consent_page`, `resource`, `scopes`: what a client may ask for, `resource_scopes`: what the MCP resource allows), `disabled_paths`, `device` (`verification_uri`), `admin` (`user_ids`: the users the admin plugin treats as admins, its `adminUserIds`; none by default), `delete_user` (`enabled`: Better Auth's `user.deleteUser`, so a signed-in person may delete their own user; false by default) and
`email` (`command`, an argv that gets each message as JSON on stdin, or `outbox`, a file each message is appended to).

`disabled_paths` is `["/token"]`: the JWT docs' OAuth Provider Mode says to turn off the session JWT route when MCP is on,
because session JWTs share the access tokens' signing key. OAuth and MCP clients get tokens from `/api/auth/oauth2/token`.
Empty `disabled_paths` and `GET /api/auth/token` hands back a session JWT (EdDSA; `kid` names the JWKS key; claims `sub`,
`iss`, `aud`, `exp`, `iat`, `email`, `name`).

## The account in every pass

`account_claim` names the user field that holds the account a person signed in to (`trillionAccount`, a user additional
field with `input: false`, so no sign-up or update sets it) and the claim it goes out as (`trillion_account`, a 64-hex
account address). The session JWT is its default payload plus that claim (the jwt plugin's `definePayload`), and MCP
access tokens (`at+jwt`, `aud` holding `mcp.resource`) carry it through the OAuth provider's `customAccessTokenClaims`
(account-claim.mjs), with the user's `email` and `email_verified`, so a door can tell a proven inbox from a typed one. The access token's `scope` names the Trillion scopes (`records`, `tools`, `account`, `vault`, `namespace-read`) the client was granted. A user with no account gets no claim. With `account_claim.create` (`url`, the engine's loopback `POST /accounts/create` on the same computer, such as `http://127.0.0.1:7199/accounts/create`, and `timeout_ms`) a new person's account is made there by the `databaseHooks.user.create.before` hook (`accountCreate`): the engine answers `{"address"}` and the user row is written with it, so the first pass carries the account; a computer that refuses or does not answer refuses the sign-up and no user row is written (trillion-rust src/native_entry/computer/account_create.rs, c0539be7e). No `create`: no account is made here. test/account-create.test.mjs runs against a stand-in computer, or against a scratch engine when `ACCOUNT_CREATE_URL` names its operation.

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

A personal API key starts with `api_key.prefix` (`tr_`) and its metadata carries `trillion_account`, the account of the
party that created it: a `hooks.before` on `/api-key/create` sets it from the creator's own user row and drops any the
request named. Better Auth's `verifyApiKey` is server-only, so the engine calls it on the computer's own listener,
`internal` (`127.0.0.1:8793`, which Caddy never routes to): `POST /api-key/verify {"key": "tr_..."}` answers
`{"valid": true, "key": {"id", "userId", "metadata": {"trillion_account"}, "permissions": {"trillion": [scope names]}}}` or `{"valid": false, "key": null}`, and 400
for a body with no key. `api_key.rate_limit` is `{"enabled": false}`: the plugin's default (10 checks a key a day) would
make a key invalid after the engine's tenth request.

## Pointing a person at the account their computer holds

`internal.account_path` (`/account/claim`) answers on the same loopback listener: `POST {email, account}` sets the user's
`account_claim.field` to `account` (64 hex) and answers `{email, account}`; 400 for a body that is not both, 404 for an
email no user has. It is the one way to move a user that is already linked (a sign-up links once, and a key check never
moves a linked user). Caddy never routes to it, so only the computer itself calls it. test/internal-verify.test.mjs proves it.

## Whether a credential still stands

A wake's delegation lasts only while the switcher's credential stands. The engine asks the same `internal` listener
`POST /credential/standing {"credential": "<id>"}` (`credential_standing.path`) and reads `{"valid": true|false}`; it asks by
the credential's id (`key:<key id>`, `session:<user>`, `mcp-access:<user>:<client>`), never with the credential itself.
`credential_standing.kinds` says what each id means: `api_key` stands while Better Auth's key row exists, is enabled and has
not expired, `session` while the user holds a session that has not ended, `client_grant` while the client holds an unrevoked
refresh or access token of the user. Every kind needs the user to exist and not be banned. An unknown kind or id answers false.
No copy of a key or session is kept: the answer is read from Better Auth's own records (credential-standing.mjs).

A computer elsewhere asks over the public origin, `POST /api/auth/computer/key-check {"key", "kept"}` with
`authorization: Bearer trp_<computer id>_<blake3 of the key>_<at ms>_<signature>`: its own Ed25519 proof for the
`key-check` use (trillion-rust `ComputerSigner::sign_use("key-check", [blake3(key)], at)`, so one proof is good for one key
and `computer_proof.window_ms`), and `kept`, its account's own computers row with the account's public key (`KeptAccount`,
what it tells a forwarder). It is admitted when the proof checks, the key is the one it binds, the address is the one the
public key names and that key signed the row, and the row lists the computer among the computers that keep a copy
(computer-proof.mjs, byte for byte as computers.rs). It gets the same answer as `internal`, and `{"valid": false}` for a
key of another account. No shared credential is involved; a 401 says the computer was not admitted.

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

`pages/` holds the sign-in pages as this tool's own files, in Trillion's sign-in design: `/sign-in` (email, then the
account's ways), `/sign-up`, `/sign-in/way?way=password|email-code|text-code|authenticator|backup-codes`, `/sign-in/email`,
`/sign-in/forgot-password`, `/sign-in/add-passkey` and `/sign-out` (one button: Better Auth's sign-out, then `/sign-in`). `pages/routes.json` says which file answers each address. What the
pages' forms and buttons do is `pages/sign-in-client.mjs`: each calls Better Auth through `better-auth/client` with the
passkey, email OTP and two-factor client plugins, and its words are `pages/words.json`. `npm run build-pages` bundles it
to `pages/assets/sign-in.js`, served at `/sign-in/assets/sign-in.js`. The pages load the fonts, mark and icons at the
addresses the product already serves them from (`/workspace/fonts.css`, `/brand/current/mark.svg`, `/favicon.ico`).

## MCP access tokens

From `/api/auth/oauth2/token` with `resource` set to `mcp.resource`: EdDSA JWTs, header `typ` `at+jwt` and the JWKS `kid`,
`iss` the issuer, `aud` naming `mcp.resource` (and the userinfo URL), `sub`, `azp`, `scope`, `exp`, `iat`.

## Discovery

`/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource` (RFC 9728).
