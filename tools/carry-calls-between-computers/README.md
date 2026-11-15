# tools/carry-calls-between-computers/

Carries a call between computers: the public door's route table, the confidential session a Mac opens to it, the connected computers it routes to, and the one HTTPS client the engine's outbound calls use. The engine keeps launch and listen; carrying a call from one computer to another is this tool.

Every file here is the engine repository's file at commit `5fbc2ff4b1bf16622e2472f0638db9f79da980e9`, at the same path under `src/`, so each file's `include_bytes!`, `include_str!` and `#[path]` reads still reach their neighbours. Byte for byte, but for three swaps this public tree needs (`calls` in `moved-from.json`): a first name in one `forwarder/README.md` sentence, the user information of two example URLs in `https/tests.rs` (on an example.com host), and the first dash of one certificate-header test string, written as the escape `\x2d` (the same bytes at run time). `moved-from.json` names each file's source path and commit, the BLAKE3 identity of its source bytes and of its bytes here, and the calls applied to it. The move was made by `tools/move-code-between-trees` (`move-rows/trillion-rust-carry-calls-to-workshop.json`). Nothing here is built by the Workshop: the files name the engine's crate (`crate::...`), so they compile only beside the engine's `Cargo.toml`, which no longer lists them.

## What the files do

| Path under `src/` | Job |
|-------------------|-----|
| `forwarder.rs`, `forwarder/README.md` | The module root and the forwarder's own description of its parts. |
| `forwarder/ingress.rs` | The public door's plain HTTP listener (axum on hyper, behind the front door that holds TLS): the route table, the Host gate (421), the connection bound (64, then 503), the per-request limit. |
| `forwarder/gateway.rs`, `forwarder/gateway/body_custody.rs` | The route table composed with the authenticated MCP adapter and the connected computers; a request that names an account goes whole to a live computer of the account. |
| `forwarder/session.rs`, `forwarder/session_tests.rs`, `forwarder/websocket.rs` | The Mac-initiated session: bounded request/reply framing over a confidential stream, its admission, expiry and retirement; the WebSocket upgrade rules. |
| `forwarder/connected_computers.rs`, `forwarder/connected_computers/` | The per-process list of connected computers: slots, installation before acknowledgement, replacement, revocation. |
| `forwarder/origins.rs`, `forwarder/origin_dns.rs`, `forwarder/remote_connection_check.rs`, `forwarder/tls.rs`, `forwarder/answers.rs`, `forwarder/lease_time.rs` | Which origins an account answers at, the DNS proof of an origin, the check of a remote connection, the Mac's WSS connect, and the shared answer helpers. |
| `forwarder/*.json` | The forwarder's DATA: connected-computer limits, keep-alive, origin rules, words. |
| `https.rs`, `https/settings.json`, `https/tests.rs` | The engine's one outbound HTTPS client: reqwest over hyper on rustls, one TLS setup per root-certificate file, bounded uploads and answers. |
| `signed_authority.rs` | Verifies scoped remote-client grants with configured public keys and fresh-rights checks, at admission and at commitment. |
| `native_boot/forwarder_connection.rs` | The Mac side of the session: the public account routes' operations arrive over the computer's own outbound connection and reach the same selected-account dispatch as the local routes. |
| `native_boot/mcp_outbound.rs` | The optional outbound composition on the native host's lifetime: the existing credential and retry DATA open the connection to the public service origin. |
| `bin/trillion-mcp-forwarder.rs` | The forwarder program the public door runs. |

## How it is used

The public door runs as a service started by `tools/start-a-computer` from the door's host-layout row, with its own signed program feed; moving these files changes no running program. The files are the source of what that feed builds.

## Files

| File | Purpose |
|------|---------|
| `moved-from.json` | The receipt: every file's source path, source commit and identities. |
| `part.json` | Which repositories import this folder. |
| `src/` | The moved files, at their source paths. |

## Dependencies

**Depends on:** the engine's crate (`crate::account::signed_in::verify`, `crate::mcp::http`, `crate::account::computers::verify_use` and the engine's storage and record modules) when built; `tools/move-code-between-trees` for the receipt's proof.

**Depended on by:** nothing at run time; the engine's own door reads the program this source builds only through the signed feed.
