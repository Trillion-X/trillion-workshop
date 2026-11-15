// crates/resilience/src/config.rs
//
// Purpose:
//   Canonical daemon server configuration — SSOT for all numeric thresholds.
//   Replaces both `ServerConfig` (hosts/headless/src/server_config.rs) and
//   `DaemonWsConfig` (hosts/headless/src/main.rs) which duplicated identical fields.
//
// Non-Negotiable Invariants:
//   1. ALL defaults are safe for production — no override required for basic operation.
//   2. This struct is the SSOT for all numeric thresholds — no magic numbers elsewhere.
//   3. TCP_NODELAY is NOT a field here — it is Physics (always true for WebSocket).
//      Only keepalive POLICY values (Society data) live here.
//   4. validate() MUST be called at daemon boot — reject at boundary, not at use site.
//
// Physics vs Society:
//   TCP_NODELAY=true is Physics (universally correct for WebSocket — disables Nagle).
//   Keepalive intervals are Society (operator deployment policy — NOT hardcoded).

/// Canonical server configuration — replaces ServerConfig + DaemonWsConfig.
///
/// Create once at daemon startup; share via `Arc<ServerConfig>` to all subsystems.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    // ── Auth ─────────────────────────────────────────────────────────────────
    /// Seconds before auth handshake must complete. (GAP R3-12)
    pub auth_timeout_secs: u64,

    // ── Rate + Connections ────────────────────────────────────────────────────
    /// Max WebSocket connections per IP per second. (GAP R3-12 rate limiting)
    pub rate_limit_connections_per_sec: u32,

    /// Global concurrent WebSocket connection ceiling. (GAP R8-6)
    pub max_connections: usize,

    // ── Payload + Queue ──────────────────────────────────────────────────────
    /// Maximum WebSocket frame payload size in bytes. Default: 16MB. (GAP R5-2)
    pub max_payload_bytes: usize,

    /// Bounded MPSC write-queue depth. (GAP R7-2)
    pub write_queue_capacity: usize,

    // ── Timeouts ─────────────────────────────────────────────────────────────
    /// Seconds of server-side idle before a connection is force-closed. (GAP R12-4)
    pub server_idle_timeout_secs: u64,

    // ── Idempotency Cache ─────────────────────────────────────────────────────
    /// In-memory LRU idempotency cache capacity (entries). (GAP R6-3)
    pub idempotency_cache_capacity: u64,

    /// In-memory LRU idempotency cache TTL in seconds. (GAP R6-3)
    pub idempotency_cache_ttl_secs: u64,

    /// Cancel-tombstone LRU cache capacity (entries). (GAP R10-1)
    pub cancel_tombstone_capacity: u64,

    // ── Storage ──────────────────────────────────────────────────────────────
    /// Minimum free disk bytes before storage recovery kicks in. Default: 100MB. (GAP R27-3)
    pub storage_recovery_min_bytes: u64,

    /// Bounded bus subscriber channel depth per subscriber. (GAP R12-2)
    pub effective_bus_capacity: usize,

    // ── TCP Keepalive (Society — operator deployment policy, NOT hardcoded) ──
    /// Seconds of idle before first keepalive probe. (Society: operator policy)
    pub tcp_keepalive_idle_secs: u64,

    /// Seconds between keepalive probes. (Society: operator policy)
    pub tcp_keepalive_interval_secs: u64,

    /// Number of probes before reporting dead. (Society: operator policy, linux only)
    pub tcp_keepalive_probes: u32,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            auth_timeout_secs: 5,
            rate_limit_connections_per_sec: 10,
            max_connections: 100,
            max_payload_bytes: 16 * 1024 * 1024, // 16MB
            write_queue_capacity: 1024,
            server_idle_timeout_secs: 60,
            idempotency_cache_capacity: 10_000,
            idempotency_cache_ttl_secs: 300,
            cancel_tombstone_capacity: 10_000,
            storage_recovery_min_bytes: 100 * 1024 * 1024, // 100MB
            effective_bus_capacity: 1_000,
            // TCP keepalive: match existing hardcoded values in websocket.rs:214-221
            tcp_keepalive_idle_secs: 15,
            tcp_keepalive_interval_secs: 5,
            tcp_keepalive_probes: 3,
        }
    }
}

/// Validation errors returned by `ServerConfig::validate()`.
#[derive(Debug)]
pub enum ConfigError {
    ZeroValue(&'static str),
    BelowMinimum {
        field: &'static str,
        min: u64,
        got: u64,
    },
}

impl core::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ConfigError::ZeroValue(field) => write!(f, "config field '{}' must be > 0", field),
            ConfigError::BelowMinimum { field, min, got } => write!(
                f,
                "config field '{}' must be >= {}, got {}",
                field, min, got
            ),
        }
    }
}

impl ServerConfig {
    /// Validate all configuration fields. Call at daemon boot — fail fast at the boundary.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.auth_timeout_secs == 0 {
            return Err(ConfigError::ZeroValue("auth_timeout_secs"));
        }
        if self.max_connections == 0 {
            return Err(ConfigError::ZeroValue("max_connections"));
        }
        if self.max_payload_bytes == 0 {
            return Err(ConfigError::ZeroValue("max_payload_bytes"));
        }
        if self.write_queue_capacity == 0 {
            return Err(ConfigError::ZeroValue("write_queue_capacity"));
        }
        if self.server_idle_timeout_secs == 0 {
            return Err(ConfigError::ZeroValue("server_idle_timeout_secs"));
        }
        if self.tcp_keepalive_idle_secs == 0 {
            return Err(ConfigError::ZeroValue("tcp_keepalive_idle_secs"));
        }
        if self.tcp_keepalive_interval_secs == 0 {
            return Err(ConfigError::ZeroValue("tcp_keepalive_interval_secs"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_validates() {
        assert!(ServerConfig::default().validate().is_ok());
    }

    #[test]
    fn zero_max_connections_rejected() {
        let mut cfg = ServerConfig::default();
        cfg.max_connections = 0;
        assert!(matches!(
            cfg.validate(),
            Err(ConfigError::ZeroValue("max_connections"))
        ));
    }

    #[test]
    fn zero_auth_timeout_rejected() {
        let mut cfg = ServerConfig::default();
        cfg.auth_timeout_secs = 0;
        assert!(matches!(
            cfg.validate(),
            Err(ConfigError::ZeroValue("auth_timeout_secs"))
        ));
    }

    #[test]
    fn zero_tcp_keepalive_idle_rejected() {
        let mut cfg = ServerConfig::default();
        cfg.tcp_keepalive_idle_secs = 0;
        assert!(matches!(
            cfg.validate(),
            Err(ConfigError::ZeroValue("tcp_keepalive_idle_secs"))
        ));
    }
}
