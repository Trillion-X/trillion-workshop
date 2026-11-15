# crates/

The Cargo workspace of this tool: `http-client/`, the request sender that places a held value only at send time. Built with `--no-default-features` for the Worker by `tools/build-engine-modules-for-web-hosts` into `built-stored-bytes/held-values/`.

It reaches the engine's `content-crypto`, `execution-types` and `slot-protocol` by path in the engine checkout beside this one (`../trillion-rust/crates`), and `ssrf-policy` in `tools/refuse-requests-to-private-addresses/crates`.

## Files

| Folder | Purpose |
|--------|---------|
| `http-client/` | Sends a request with a sealed value placed only at send time. Its runtime config (`HttpClientRuntimeConfig`) carries the host's `execution_namespace` word. |

## Dependencies

**Depends on:** cargo, `../trillion-rust/crates`, `tools/refuse-requests-to-private-addresses/crates/ssrf-policy`.

**Depended on by:** `tools/build-engine-modules-for-web-hosts` (`COMPILED_MODULES`).
