//! Host selection of the public service address of the signed Mac app: the
//! product's `app_host` from the product settings the app hands its engine
//! (`product_origin`). This is a display/connection address, never account
//! authority. The private browser origin is a different source.
use super::{Error, Selection};
use std::net::Ipv6Addr;

/// Addresses derived from the current selected signed service origin. These
/// values select communication, never account/device/registration authority.
/// Construction stays inside this source owner; callers cannot override a
/// host or audience using request headers, parameters, or another setting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServiceEndpoints {
    selected_origin: String,
    origin: String,
    tls_host: String,
    tls_port: u16,
    mcp_audience: String,
    resource_connection_url: String,
    local_authority_validation_url: String,
}
impl McpServiceEndpoints {
    /// Exact source spelling, retained for source identity/custody only.
    pub fn selected_origin(&self) -> &str { &self.selected_origin }
    /// Canonical URL origin, matching the existing OAuth audience consumer.
    pub fn origin(&self) -> &str { &self.origin }
    pub fn tls_host(&self) -> &str { &self.tls_host }
    pub fn tls_port(&self) -> u16 { self.tls_port }
    pub fn mcp_audience(&self) -> &str { &self.mcp_audience }
    pub fn resource_connection_url(&self) -> &str { &self.resource_connection_url }
    pub fn local_authority_validation_url(&self) -> &str { &self.local_authority_validation_url }
}

/// The service origin's grammar: https, an ASCII host (DNS labels or a bracketed IPv6 address) and an optional
/// port, nothing else. Moved from workspace_setup/compiled.rs (OriginalSetupData::new), which left the engine.
fn validate_origin(origin: &str) -> Result<(), Error> {
    let Some(authority) = origin.strip_prefix("https://") else {
        return Err(crate::cause!(Error::Invalid));
    };
    if origin.len() > 2048
        || authority.is_empty()
        || !origin.is_ascii()
        || authority
            .bytes()
            .any(|b| b.is_ascii_whitespace() || matches!(b, b'/' | b'?' | b'#' | b'@'))
        || !valid_authority(authority)
    {
        return Err(crate::cause!(Error::Invalid));
    }
    Ok(())
}
fn valid_authority(authority: &str) -> bool {
    let (host, port, ipv6) = if let Some(rest) = authority.strip_prefix('[') {
        let Some(close) = rest.find(']') else {
            return false;
        };
        let host = &rest[..close];
        if host.parse::<Ipv6Addr>().is_err() {
            return false;
        }
        let tail = &rest[close + 1..];
        if tail.is_empty() {
            (host, None, true)
        } else if let Some(port) = tail.strip_prefix(':') {
            (host, Some(port), true)
        } else {
            return false;
        }
    } else {
        let mut split = authority.split(':');
        let host = split.next().unwrap_or_default();
        let port = split.next();
        if split.next().is_some() {
            return false;
        }
        (host, port, false)
    };
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') {
        return false;
    }
    if !ipv6 {
        if !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        {
            return false;
        }
        if host
            .split('.')
            .any(|label| label.is_empty() || label.starts_with('-') || label.ends_with('-'))
        {
            return false;
        }
    }
    match port {
        None => true,
        Some(port) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            port.parse::<u16>().is_ok_and(|n| n > 0)
        }
        Some(_) => false,
    }
}

fn mcp_service_endpoints(origin: &str) -> Result<McpServiceEndpoints, Error> {
    // Reuse the SAME source compiler grammar as the display/setup origin.
    // Parsing it here projects transport fields; it is not a host allowlist.
    validate_origin(origin)?;
    let parsed = url::Url::parse(origin).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let url::Host::Domain(host) = parsed.host().ok_or(crate::cause!(Error::Invalid))? else {
        // The current outbound WSS owner uses DNS-domain hosts. Do not make
        // an IP literal a newly supported connection merely by formatting it.
        return Err(crate::cause!(Error::Invalid));
    };
    // The source compiler already checks DNS characters, labels, and ports.
    // These are the existing native TLS transport's additional DNS bounds.
    if host.len() > 253 || host.split('.').any(|label| label.len() > 63) {
        return Err(crate::cause!(Error::Invalid));
    }
    let tls_port = parsed.port_or_known_default().ok_or(crate::cause!(Error::Invalid))?;
    let tls_host = host.to_owned();
    // Match OAuthAuthority's existing URL-origin serialization and the
    // public Worker's URL.origin. Source bytes remain independently pinned;
    // their raw spelling is not an OAuth audience equivalence rule.
    let canonical_origin = parsed.origin().ascii_serialization();
    Ok(McpServiceEndpoints {
        selected_origin: origin.to_owned(), origin: canonical_origin.clone(), tls_host, tls_port,
        mcp_audience: format!("{canonical_origin}/mcp"),
        resource_connection_url: format!("{canonical_origin}{}", crate::forwarder::websocket::RESOURCE_CONNECTION_PATH),
        local_authority_validation_url: format!("{canonical_origin}/mcp/local-authority/validate"),
    })
}

/// The hosting app's public service origin: `https://` and the product's `app_host` from the product settings the app
/// hands its engine (PRODUCT_SETTINGS, src/account_files/identity.rs), the one file every product address is built from.
///
/// Ports old trillion's Mac shell road one to one in what it selects: the shell connected to `https://app.gettrillion.ai`
/// (Trillion-X/trillion macos/App/device-notices.json:2 `origin`, carried into trillion-apps 14cbe06), and this owner
/// read that same field from the signed app's `Resources/device-notices.json`. trillion-apps 2f2a2e5 dropped the field
/// (the shell reads its gateway from App/bundled-origin.json `live_origin`), so every app built after it stopped its
/// engine at `stage=selection`. Dropped: the second copy of the product's address in a shell file. The product settings
/// are the app's own sealed file (macos/computer-reader.json `product_settings`), read once per process, so no pin of
/// another file is kept here.
fn product_origin() -> Result<String, Error> {
    let identity = crate::account_files::identity::identity().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let origin = format!("https://{}", identity.app_host);
    // Reuse the source compiler's HTTPS origin grammar; do not invent a second URL parser, provider allowlist or
    // localhost fallback for remote AI setup.
    validate_origin(&origin)?;
    Ok(origin)
}

impl Selection {
    /// Called only by installed() for the current signed app. Source/dev descriptors (`from_descriptor` alone) do not
    /// gain an implicit service host.
    pub(super) fn select_installed_service_origin(&mut self) -> Result<(), Error> {
        self.service_origin = Some(product_origin()?);
        Ok(())
    }

    /// Rechecked by the native selection owner before every disclosure. The
    /// original configured address survives physical placement of the backend.
    pub fn selected_service_origin(&self) -> Result<Option<String>, Error> {
        self.assert_current()?;
        Ok(self.service_origin.clone())
    }

    /// The automatic MCP communication addresses for this SAME selected app.
    /// An absent service origin stays absent. Registration, account,
    /// credentials and current route trust must still be supplied separately.
    pub fn selected_mcp_service_endpoints(&self) -> Result<Option<McpServiceEndpoints>, Error> {
        self.assert_current()?;
        self.service_origin.as_deref().map(mcp_service_endpoints).transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_hosting_apps_origin_is_the_products_app_host() {
        // PRODUCT_SETTINGS names tests/fixtures/product-settings.json (.cargo/config.toml) for this repository's runs.
        let identity = crate::account_files::identity::identity().unwrap();
        let origin = product_origin().unwrap();
        assert_eq!(origin, format!("https://{}", identity.app_host));
        let endpoints = mcp_service_endpoints(&origin).unwrap();
        assert_eq!(endpoints.tls_host(), identity.app_host);
        assert_eq!(endpoints.mcp_audience(), format!("{origin}/mcp"));
    }
    #[test]
    fn refuses_browser_origins_credentials_and_paths() {
        for value in [
            "http://127.0.0.1:28788",
            "https://user:secret@example.test",
            "https://example.test/path",
            "https://example.test?token=secret",
            "https://example.test/#hash",
            "https://",
        ] {
            let error = validate_origin(value).unwrap_err();
            assert!(!format!("{error:?} {error}").contains("secret"));
        }
    }
    #[test]
    fn an_origin_derives_the_complete_mcp_contract() {
        let endpoints = mcp_service_endpoints("https://service.example").unwrap();
        assert_eq!(endpoints.origin(), "https://service.example");
        assert_eq!(endpoints.tls_host(), "service.example");
        assert_eq!(endpoints.tls_port(), 443);
        assert_eq!(endpoints.mcp_audience(), "https://service.example/mcp");
        assert_eq!(endpoints.resource_connection_url(), "https://service.example/mcp/resource-connection");
        assert_eq!(endpoints.local_authority_validation_url(), "https://service.example/mcp/local-authority/validate");
    }

    #[test]
    fn another_supplied_provider_or_port_keeps_the_same_logical_endpoint_contract() {
        for (origin, host, port) in [
            ("https://one-provider.example", "one-provider.example", 443),
            ("https://another-provider.example:9443", "another-provider.example", 9443),
        ] {
            let endpoints = mcp_service_endpoints(origin).unwrap();
            assert_eq!(endpoints.origin(), origin);
            assert_eq!(endpoints.tls_host(), host);
            assert_eq!(endpoints.tls_port(), port);
            assert_eq!(endpoints.mcp_audience(), format!("{origin}/mcp"));
            assert_eq!(endpoints.resource_connection_url(), format!("{origin}{}", crate::forwarder::websocket::RESOURCE_CONNECTION_PATH));
            assert_eq!(endpoints.local_authority_validation_url(), format!("{origin}/mcp/local-authority/validate"));
        }
    }

    #[test]
    fn audience_matches_oauth_url_origin_serialization_without_losing_selected_source_spelling() {
        for selected_origin in ["https://MiXeD.example:443", "https://mixed.example:00443"] {
            // These spellings are accepted by the actual source compiler.
            validate_origin(selected_origin).unwrap();
            let endpoints = mcp_service_endpoints(selected_origin).unwrap();
            let expected_origin = url::Url::parse(selected_origin).unwrap().origin().ascii_serialization();
            assert_eq!(endpoints.selected_origin(), selected_origin);
            assert_eq!(endpoints.origin(), expected_origin);
            assert_eq!(endpoints.origin(), "https://mixed.example");
            assert_eq!(endpoints.tls_host(), "mixed.example");
            assert_eq!(endpoints.tls_port(), 443);
            assert_eq!(endpoints.mcp_audience(), format!("{expected_origin}/mcp"));
            assert_ne!(endpoints.mcp_audience(), format!("{selected_origin}/mcp"));
            assert_eq!(endpoints.resource_connection_url(), "https://mixed.example/mcp/resource-connection");
            assert_eq!(endpoints.local_authority_validation_url(), "https://mixed.example/mcp/local-authority/validate");
        }
        let selected_origin = "https://MiXeD.example:09443";
        validate_origin(selected_origin).unwrap();
        let endpoints = mcp_service_endpoints(selected_origin).unwrap();
        assert_eq!(endpoints.selected_origin(), selected_origin);
        assert_eq!(endpoints.origin(), "https://mixed.example:9443");
        assert_eq!(endpoints.mcp_audience(), "https://mixed.example:9443/mcp");
        assert_eq!(endpoints.tls_port(), 9443);
    }

    #[test]
    fn endpoint_projection_refuses_url_authority_injection_and_non_domain_transport_hosts() {
        for origin in [
            "http://service.example", "https://user:synthetic-secret@example.com",
            "https://service.example/", "https://service.example/path",
            "https://service.example?authorization=synthetic-secret",
            "https://service.example#synthetic-secret", "https://service.example:0",
            "https://service.example:65536", "https://service.example:443/../mcp",
            "https://127.0.0.1", "https://[::1]:9443", "https://2130706433",
            "https://0x7f000001", "https://service..example", "https://-service.example",
            "https://service.example.", "https://service.example\n",
            "https://sérvice.example", "https://service.example\\@other.example",
        ] {
            let error = mcp_service_endpoints(origin).unwrap_err();
            assert!(!format!("{error:?} {error}").contains("synthetic-secret"));
        }
    }

    #[test]
    fn endpoint_dns_limits_match_the_existing_tls_transport_bounds() {
        let host = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
        assert_eq!(host.len(), 253);
        assert_eq!(mcp_service_endpoints(&format!("https://{host}:65535")).unwrap().tls_port(), 65535);
        let too_long = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)].join(".");
        assert_eq!(too_long.len(), 254);
        assert!(mcp_service_endpoints(&format!("https://{too_long}")).is_err());
        assert!(mcp_service_endpoints(&format!("https://{}.example", "x".repeat(64))).is_err());
    }
}
