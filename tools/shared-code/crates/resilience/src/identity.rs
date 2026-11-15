// crates/resilience/src/identity.rs
//
// Purpose:
//   Trust-tiered connection identity types for BoundaryGuardEngine.
//   Trust tiers are TYPES, not enum variants — TierA has .persist(), TierC does not compile
//   with .persist(). The compiler is the enforcement mechanism (L063 structural elimination).
//
// Non-Negotiable Invariants:
//   1. Trust is structural — never a runtime string check.
//   2. SP7 binding fields on every tier — prevent bearer-token misuse.
//   3. TierA = UDS/local = highest trust (OS kernel verified peer credentials).
//   4. TierB = authenticated relay = medium trust (verified but remote).
//   5. TierC = unauthenticated/external = zero trust (unknown until proven).
//   6. .persist() exists ONLY on TierA. Period.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

use crate::types::PeerId;

/// Highest-trust connection: Unix Domain Socket, local process.
///
/// The OS kernel verified the peer's process credentials at connect time.
/// Appropriate for: Tauri host ↔ daemon, local CLI ↔ daemon.
///
/// TierA is the ONLY tier that can persist identity state across reconnects.
#[derive(Debug, Clone)]
pub struct TierA {
    pub peer_id: PeerId,
    /// Origins this identity is valid for (SP7 context binding).
    pub allowed_origins: alloc::vec::Vec<alloc::string::String>,
    /// Platform bundle ID (iOS/macOS App Store enforcement, SP7).
    pub bundle_id: Option<alloc::string::String>,
    /// Per-device hardware key binding (SP7).
    pub device_key: Option<[u8; 32]>,
    /// Opaque persistence key — used by .persist() to write identity to stable storage.
    pub persistence_key: alloc::string::String,
}

/// Medium-trust connection: authenticated relay, verified remote identity.
///
/// Identity has been cryptographically verified (Ed25519 signature check passed),
/// but the peer is remote — OS kernel cannot verify process credentials.
/// Appropriate for: SDK client with valid Ed25519 challenge response.
#[derive(Debug, Clone)]
pub struct TierB {
    pub peer_id: PeerId,
    /// Origins this identity is valid for (SP7 context binding).
    pub allowed_origins: alloc::vec::Vec<alloc::string::String>,
    /// Platform bundle ID if present (SP7).
    pub bundle_id: Option<alloc::string::String>,
    /// Per-device hardware key binding if present (SP7).
    pub device_key: Option<[u8; 32]>,
    /// Unix timestamp (seconds) when this identity expires.
    pub expires_at: u64,
}

/// Zero-trust connection: unauthenticated or externally-originated.
///
/// No cryptographic verification has succeeded yet. Treated as untrusted
/// until upgraded to TierB or rejected.
/// Appropriate for: incoming WebSocket before auth handshake completes.
#[derive(Debug, Clone)]
pub struct TierC {
    pub peer_id: PeerId,
    /// Origins this identity is valid for (SP7 context binding).
    pub allowed_origins: alloc::vec::Vec<alloc::string::String>,
    /// Platform bundle ID if present in initial headers (SP7).
    pub bundle_id: Option<alloc::string::String>,
    /// Per-device hardware key binding if present (SP7).
    pub device_key: Option<[u8; 32]>,
}

// TierA: highest-trust ONLY gets .persist()
impl TierA {
    /// Persist this identity to stable storage for reconnect continuity.
    ///
    /// Available ONLY on TierA — UDS local connections have OS-verified identity
    /// that is safe to persist. TierB/TierC persistence would create auth bypass vectors.
    ///
    /// # Storage Backend Wiring (SP3 - Latest Accepted Time Persistence)
    ///
    /// Task-0515 wires persistence to `hosts/headless/src/session.rs::SessionStore`.
    /// The SessionStore holds an append-only log of TierA identity records in SQLite:
    ///
    /// ```sql
    /// CREATE TABLE IF NOT EXISTS tier_a_identities (
    ///     peer_id TEXT PRIMARY KEY,
    ///     allowed_origins TEXT,  -- JSON array
    ///     bundle_id TEXT,
    ///     device_key BLOB,
    ///     persistence_key TEXT,
    ///     persisted_at INTEGER    -- Unix timestamp (milliseconds)
    /// );
    /// ```
    ///
    /// When wired, this function will:
    /// 1. Call `SessionStore::save_tier_a(self)` (from hosts/headless/src/session.rs)
    /// 2. Return `PersistResult::Ok(())` on success
    /// 3. Return `PersistResult::StorageError(msg)` on failure
    ///
    /// Until then, returns `StorageUnavailable`. Callers MUST check the result —
    /// a `StorageUnavailable` return is not silent success.
    pub fn persist(&self) -> PersistResult {
        // Storage hook: wire to SessionStore::save_tier_a() when available.
        // The SessionStore lives in hosts/headless/src/session.rs — it is daemon-only.
        // This crate (resilience) deliberately does NOT depend on daemon (separation of concerns).
        // Bridge wiring happens in hosts/headless/src/main.rs when constructing the daemon context.
        PersistResult::StorageUnavailable
    }

    pub fn trust_level(&self) -> u8 {
        0
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }
}

impl TierB {
    pub fn trust_level(&self) -> u8 {
        1
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }

    /// Returns true if this identity is expired relative to the given wall clock time.
    pub fn is_expired(&self, wall_clock_ms: u64) -> bool {
        wall_clock_ms / 1000 >= self.expires_at
    }
}

impl TierC {
    pub fn trust_level(&self) -> u8 {
        2
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }
}

/// Result of a TierA persist operation.
#[derive(Debug, PartialEq, Eq)]
pub enum PersistResult {
    /// Identity persisted successfully.
    Ok(()),
    /// Storage backend is not yet connected — task-0515 wires this. Callers must handle.
    StorageUnavailable,
    /// Storage backend returned an error. Callers must handle.
    StorageError(alloc::string::String),
}

/// Unified connection identity — wraps one of the three trust tier structs.
#[derive(Debug, Clone)]
pub enum ConnectionIdentity {
    /// Local, OS-verified identity.
    TierA(TierA),
    /// Authenticated remote identity.
    TierB(TierB),
    /// Unauthenticated/zero-trust identity.
    TierC(TierC),
}

impl ConnectionIdentity {
    /// Trust level: 0 = highest (TierA), 2 = lowest (TierC).
    pub fn trust_level(&self) -> u8 {
        match self {
            ConnectionIdentity::TierA(a) => a.trust_level(),
            ConnectionIdentity::TierB(b) => b.trust_level(),
            ConnectionIdentity::TierC(c) => c.trust_level(),
        }
    }

    /// Convenience accessor for the embedded PeerId.
    pub fn peer_id(&self) -> &PeerId {
        match self {
            ConnectionIdentity::TierA(a) => a.peer_id(),
            ConnectionIdentity::TierB(b) => b.peer_id(),
            ConnectionIdentity::TierC(c) => c.peer_id(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_peer() -> PeerId {
        PeerId("test-peer".to_string())
    }

    #[test]
    fn tier_a_trust_level_is_zero() {
        let a = TierA {
            peer_id: make_peer(),
            allowed_origins: alloc::vec![],
            bundle_id: None,
            device_key: None,
            persistence_key: "key".to_string(),
        };
        assert_eq!(a.trust_level(), 0);
    }

    #[test]
    fn tier_b_trust_level_is_one() {
        let b = TierB {
            peer_id: make_peer(),
            allowed_origins: alloc::vec![],
            bundle_id: None,
            device_key: None,
            expires_at: u64::MAX,
        };
        assert_eq!(b.trust_level(), 1);
    }

    #[test]
    fn tier_c_trust_level_is_two() {
        let c = TierC {
            peer_id: make_peer(),
            allowed_origins: alloc::vec![],
            bundle_id: None,
            device_key: None,
        };
        assert_eq!(c.trust_level(), 2);
    }

    #[test]
    fn tier_a_persist_returns_storage_unavailable_until_task_0515() {
        // Honest: storage wiring is task-0515's responsibility.
        // persist() must NOT silently return Ok when no backend is connected.
        let a = TierA {
            peer_id: make_peer(),
            allowed_origins: alloc::vec!["https://localhost".to_string()],
            bundle_id: None,
            device_key: None,
            persistence_key: "k1".to_string(),
        };
        assert_eq!(a.persist(), PersistResult::StorageUnavailable);
    }

    #[test]
    fn connection_identity_tier_a_trust_level() {
        let a = TierA {
            peer_id: make_peer(),
            allowed_origins: alloc::vec![],
            bundle_id: None,
            device_key: None,
            persistence_key: "k".to_string(),
        };
        let id = ConnectionIdentity::TierA(a);
        assert_eq!(id.trust_level(), 0);
    }

    #[test]
    fn tier_b_is_expired() {
        let b = TierB {
            peer_id: make_peer(),
            allowed_origins: alloc::vec![],
            bundle_id: None,
            device_key: None,
            expires_at: 1000, // 1000 seconds since epoch
        };
        // wall_clock_ms = 2_000_000 ms = 2000 seconds > 1000 → expired
        assert!(b.is_expired(2_000_000));
        // wall_clock_ms = 500_000 ms = 500 seconds < 1000 → not expired
        assert!(!b.is_expired(500_000));
    }

    #[test]
    fn tier_c_peer_id_accessor() {
        let peer = make_peer();
        let c = TierC {
            peer_id: peer.clone(),
            allowed_origins: alloc::vec![],
            bundle_id: None,
            device_key: None,
        };
        assert_eq!(c.peer_id(), &peer);
    }
}
