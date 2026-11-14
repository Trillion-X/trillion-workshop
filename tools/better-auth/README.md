# Better Auth

The documented Better Auth server for Rust ([better-auth-rs](https://github.com/better-auth-rs/better-auth-rs), pinned to
git 23c89f4e51), set up exactly as its README quick start and `examples/axum_server.rs` show: axum, its own SeaORM adapter
on a SQLite file, and the generated `src/auth_schema.rs` (`better-auth-rs generate --plugins passkey --plugins jwt`).
No custom adapter and no custom auth code.

Enabled: email and password, session management, passkey, JWT (`/api/auth/jwks`, `/api/auth/token`), and
`SessionConfig.bearer`. The session cookie is `__Host-trillion_session`.

## Run

    export BETTER_AUTH_SECRET=<random, 32+ characters>      # from the vault, never printed
    export RUST_ICU_MAJOR_VERSION_NUMBER=78 RUST_ICU_LINK_SEARCH_DIR=/opt/homebrew/opt/icu4c@78/lib
    export DYLD_FALLBACK_LIBRARY_PATH=$RUST_ICU_LINK_SEARCH_DIR   # so the binary finds ICU at run time
    cargo run --release -- [path/to/settings.json]

## settings.json

`port`, `base_url`, `base_path` (default `/api/auth`), `issuer`, `audience`, `database_path` (SQLite file, relative to
where it runs), `session_cookie_name`, `passkey` (`rp_id`, `rp_name`, `origin`) and `trusted_origins`. Change them there.

## What a verifier needs

JWKS at `{base_url}{base_path}/jwks`; tokens come from `GET {base_url}{base_path}/token` with the session (cookie or
`Authorization: Bearer`). Algorithm EdDSA (Ed25519); header `kid` names the JWKS key; claims `sub` (user id), `iss`,
`aud`, `exp` (15 minutes), `iat`, plus `id`, `email`, `name`, `emailVerified`, `image`, `createdAt`, `updatedAt`.
