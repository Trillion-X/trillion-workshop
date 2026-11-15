# crates/

The Cargo workspace of this tool: `ssrf-policy/`, the Rust rule that refuses requests to private and local addresses. The JavaScript form of the same rule is `../public-address.mjs`.

## Files

| Folder | Purpose |
|--------|---------|
| `ssrf-policy/` | `is_private_ip` and the URL checks, with no dependency but `url`. |

## Dependencies

**Depended on by:** `tools/http-client/crates/http-client`.
