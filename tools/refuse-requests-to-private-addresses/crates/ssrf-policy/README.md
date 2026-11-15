# ssrf-policy/

Single source of truth for Server-Side Request Forgery (SSRF) prevention — validates URLs and IP addresses to block private, loopback, and cloud-metadata ranges.

## Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | Public API — `is_private_ip()` and `is_private_or_reserved()` functions with comprehensive IPv4/IPv6 blocking rules |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `is_private_ip` | `pub fn is_private_ip(url: &Url) -> bool` | Check if a parsed URL's hostname resolves to a private, reserved, or cloud-metadata IP. Returns `true` if blocked, `false` if allowed. |
| `is_private_or_reserved` | `fn is_private_or_reserved(host: &str) -> bool` | Check if a host string (hostname or IP) is private, loopback, link-local, or cloud-metadata. Called internally by `is_private_ip()`. |

## Dependencies

**Depends on:** `url`

**Depended on by:** `crates/artifacts` (CAS download validation), `crates/transport` (outbound request validation), `crates/http-client` (HTTP client requests)

## Blocked IP Ranges

### IPv4
- `127.0.0.0/8` — Loopback
- `10.0.0.0/8` — RFC 1918 private
- `172.16.0.0/12` — RFC 1918 private
- `192.168.0.0/16` — RFC 1918 private
- `169.254.0.0/16` — Link-local (includes `169.254.169.254` AWS metadata)
- `0.0.0.0` — Unspecified

### IPv6
- `::1` — Loopback
- `fc00::/7` — Unique Local Address (ULA)
- `fe80::/10` — Link-local
- `::` — Unspecified

### Hostnames
- `localhost`
- `localhost.localdomain`
