//! SSRF Policy — Canonical URL/IP validation.
//!
//! Single source of truth for all SSRF (Server-Side Request Forgery) prevention.
//! Used by: artifacts (CAS downloads), transport (outbound requests), http-client.
//!
//! ZERO external dependencies beyond url crate — safe everywhere without cycles.

use std::net::IpAddr;
use url::Url;

/// Check if a URL's hostname resolves to a private, reserved, or cloud-metadata IP.
///
/// Blocks:
/// - IPv4: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
///   `169.254.0.0/16` (includes `169.254.169.254` AWS metadata), `0.0.0.0`
/// - IPv6: `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local), `::`
/// - Hostnames: `localhost`, `localhost.localdomain`
///
/// # Examples
///
/// ```no_run
/// use url::Url;
/// use ssrf_policy::is_private_ip;
///
/// // Private IPs blocked
/// assert!(is_private_ip(&Url::parse("http://10.0.0.1/").unwrap()));
/// assert!(is_private_ip(&Url::parse("http://127.0.0.1/").unwrap()));
/// assert!(is_private_ip(&Url::parse("http://localhost/").unwrap()));
///
/// // Public IPs allowed
/// assert!(!is_private_ip(&Url::parse("http://8.8.8.8/").unwrap()));
/// assert!(!is_private_ip(&Url::parse("https://example.com/").unwrap()));
/// ```
pub fn is_private_ip(url: &Url) -> bool {
    match url.host_str() {
        Some(host) => is_private_or_reserved(host),
        None => true, // No host = fail-closed (treat as private)
    }
}

/// Check if a host string (hostname or IP) is private, reserved, loopback, or link-local.
///
/// # Blocked Ranges
///
/// | Range | Description |
/// |-------|-------------|
/// | `localhost` / `localhost.localdomain` | Loopback by name |
/// | `127.0.0.0/8` | IPv4 loopback |
/// | `10.0.0.0/8` | RFC 1918 private |
/// | `172.16.0.0/12` | RFC 1918 private |
/// | `192.168.0.0/16` | RFC 1918 private |
/// | `169.254.0.0/16` | Link-local (includes 169.254.169.254 cloud metadata) |
/// | `0.0.0.0` | IPv4 unspecified |
/// | `::1` | IPv6 loopback |
/// | `fc00::/7` | IPv6 Unique Local Address |
/// | `fe80::/10` | IPv6 link-local |
/// | `::` | IPv6 unspecified |
fn is_private_or_reserved(host: &str) -> bool {
    let lower = host.to_lowercase();

    // Check localhost by name.
    if lower == "localhost" || lower == "localhost.localdomain" {
        return true;
    }

    // Strip IPv6 brackets — url::Url::host_str() returns "[::1]" for
    // IPv6 addresses, but IpAddr::parse requires bare "::1".
    let ip_str = lower
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(&lower);

    // Try to parse as IP address.
    if let Ok(ip) = ip_str.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => {
                let o = v4.octets();
                v4.is_loopback()                              // 127.0.0.0/8
                || o[0] == 10                                  // 10.0.0.0/8
                || (o[0] == 172 && (16..=31).contains(&o[1]))  // 172.16.0.0/12
                || (o[0] == 192 && o[1] == 168)                // 192.168.0.0/16
                || (o[0] == 169 && o[1] == 254)                // 169.254.0.0/16
                || v4.is_unspecified() // 0.0.0.0
            }
            IpAddr::V6(v6) => {
                let s = v6.segments();
                v6.is_loopback()                              // ::1
                || (s[0] & 0xfe00) == 0xfc00                   // fc00::/7 (ULA)
                || (s[0] & 0xffc0) == 0xfe80                   // fe80::/10 (link-local)
                || v6.is_unspecified() // ::
            }
        };
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_localhost_blocked() {
        assert!(is_private_or_reserved("localhost"));
        assert!(is_private_or_reserved("localhost.localdomain"));
    }

    #[test]
    fn test_ipv4_private_blocked() {
        assert!(is_private_or_reserved("10.0.0.1"));
        assert!(is_private_or_reserved("172.16.0.1"));
        assert!(is_private_or_reserved("172.31.255.255"));
        assert!(is_private_or_reserved("192.168.0.1"));
        assert!(is_private_or_reserved("127.0.0.1"));
        assert!(is_private_or_reserved("127.255.255.255"));
    }

    #[test]
    fn test_aws_metadata_blocked() {
        // 169.254.169.254 is AWS metadata
        assert!(is_private_or_reserved("169.254.169.254"));
        assert!(is_private_or_reserved("169.254.0.0"));
        assert!(is_private_or_reserved("169.254.255.255"));
    }

    #[test]
    fn test_ipv4_public_allowed() {
        assert!(!is_private_or_reserved("8.8.8.8"));
        assert!(!is_private_or_reserved("1.1.1.1"));
        assert!(!is_private_or_reserved("208.67.222.222"));
    }

    #[test]
    fn test_ipv6_loopback_blocked() {
        assert!(is_private_or_reserved("::1"));
    }

    #[test]
    fn test_ipv6_ula_blocked() {
        assert!(is_private_or_reserved("fd00::1"));
        assert!(is_private_or_reserved("fc00::1"));
    }

    #[test]
    fn test_ipv6_link_local_blocked() {
        assert!(is_private_or_reserved("fe80::1"));
    }

    #[test]
    fn test_ipv6_public_allowed() {
        assert!(!is_private_or_reserved("2001:4860:4860::8888")); // Google DNS
    }

    #[test]
    fn test_url_parsing() {
        let url_private = Url::parse("http://10.0.0.1/api").unwrap();
        assert!(is_private_ip(&url_private));

        let url_public = Url::parse("http://8.8.8.8/api").unwrap();
        assert!(!is_private_ip(&url_public));
    }

    #[test]
    fn test_ipv6_brackets() {
        // URL parser puts brackets around IPv6 addresses
        let url = Url::parse("http://[::1]/").unwrap();
        assert!(is_private_ip(&url));

        let url = Url::parse("http://[2001:4860:4860::8888]/").unwrap();
        assert!(!is_private_ip(&url));
    }
}
