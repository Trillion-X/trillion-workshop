# Better Auth (official)

Official [Better Auth](https://www.better-auth.com/docs) (TypeScript, `better-auth` 1.7.23), set up as its docs show: the Node
integration (`toNodeHandler`), the built-in `node:sqlite` database, and the schema the Better Auth CLI generates
(`schema.sql`, from `npx auth generate --config auth.mjs`). No custom auth code.

Plugins: email and password (with `sendResetPassword`), passkey, two factor (TOTP and backup codes), email OTP, magic link,
multi session, API key, JWT (EdDSA, `/api/auth/jwks`), MCP (the OAuth 2.1 authorization server MCP clients connect through,
with Client ID Metadata Documents), device authorization, and bearer (the device docs need it so a device's
session token works as `Authorization: Bearer`). The session cookie is `__Host-trillion_session`.

## Run

    npm ci
    export BETTER_AUTH_SECRET=<random, 32+ characters>      # from the vault, never printed
    npx auth migrate --config auth.mjs -y
    node server.mjs                                          # BETTER_AUTH_SETTINGS=<file> for another settings file

## settings.json

`port`, `base_url`, `base_path`, `issuer`, `audience`, `database_path`, `session_cookie_name`, `passkey` (`rp_id`, `rp_name`),
`trusted_origins`, `attached_origins` (`ask_url`, `cache_ms`, `related_url`), `two_factor_issuer`, `mcp` (`login_page`, `consent_page`, `resource`), `disabled_paths`, `device` (`verification_uri`) and
`email` (`command`, an argv that gets each message as JSON on stdin, or `outbox`, a file each message is appended to).

`disabled_paths` is `["/token"]`: the JWT docs' OAuth Provider Mode says to turn off the session JWT route when MCP is on,
because session JWTs share the access tokens' signing key. OAuth and MCP clients get tokens from `/api/auth/oauth2/token`.
Empty `disabled_paths` and `GET /api/auth/token` hands back a session JWT (EdDSA; `kid` names the JWKS key; claims `sub`,
`iss`, `aud`, `exp`, `iat`, `email`, `name`).

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
`/sign-in/forgot-password` and `/sign-in/add-passkey`. `pages/routes.json` says which file answers each address. What the
pages' forms and buttons do is `pages/sign-in-client.mjs`: each calls Better Auth through `better-auth/client` with the
passkey, email OTP and two-factor client plugins, and its words are `pages/words.json`. `npm run build-pages` bundles it
to `pages/assets/sign-in.js`, served at `/sign-in/assets/sign-in.js`. The pages load the fonts, mark and icons at the
addresses the product already serves them from (`/workspace/fonts.css`, `/brand/current/mark.svg`, `/favicon.ico`).

## MCP access tokens

From `/api/auth/oauth2/token` with `resource` set to `mcp.resource`: EdDSA JWTs, header `typ` `at+jwt` and the JWKS `kid`,
`iss` the issuer, `aud` naming `mcp.resource` (and the userinfo URL), `sub`, `azp`, `scope`, `exp`, `iat`.

## Discovery

`/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource` (RFC 9728).
