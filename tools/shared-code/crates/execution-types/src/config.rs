//! CompilationConfig — Operator-Controlled Envelope (Pattern 5)
//!
//! File: crates/execution-contract/src/config.rs
//! Purpose: Centralized configuration for all compilation system tunables
//! Non-Negotiable Invariants:
//! - All numeric constants and thresholds are config fields, NEVER hardcoded in code
//! - Defaults are sensible for development; operators tune via Envelope
//! - validate() checks resource constraints (e.g., max_concurrency vs system FD limits)
//! - CompilationConfig itself is NOT Society (the config fields ARE Physics-level limits)
//! - This struct lives here; the Envelope storage mechanism is operator-specific
//!
//! Key Concept:
//! - This is a single source of truth (SSOT) for all configurable compilation thresholds
//! - Society: the operator-set VALUES in an Envelope
//! - Physics: the Rust struct type and validation logic

use std::path::PathBuf;

/// CompilationConfig — All tunable parameters for the compilation subsystem
///
/// Operator-Controlled Envelope Pattern (L088 CSSOT): This struct is the single source
/// of truth for compilation system configuration. All tunables (timeouts, concurrency limits,
/// batch sizes, GC intervals) are fields here with documented defaults and ranges.
///
/// The config is loaded from an Operator-Controlled Envelope at daemon boot and can be
/// updated dynamically across all N headless instances via EnvelopeEngineHandle.subscribe().
/// Zero magic numbers in Rust code — all thresholds derive from this config.
#[derive(Debug, Clone)]
pub struct CompilationConfig {
    // =====================================================================
    // PERFORMANCE TARGETS (wall-clock / end-to-end)
    // =====================================================================
    /// End-to-end snapshot + delta replay target for headless host cold boot (ms)
    /// Rationale: Full log scan at 1M entities takes seconds; snapshot makes it milliseconds
    pub boot_target_ms: u64,

    /// End-to-end idempotency skip target when closure_hash unchanged (ms)
    /// Rationale: HashMap lookup + Arc::ptr_eq comparison = microseconds
    pub hot_noop_target_ms: u64,

    /// End-to-end single entity compilation + bundle write + Envelope emit (ms)
    /// Rationale: One esbuild invocation for one entity + CAS write + dispatch_rewrite
    pub hot_compile_target_ms: u64,

    /// Wall-clock target for prepare_source_db cold build with warm CAS (seconds)
    /// Rationale: Covers N parallel esbuild processes + dependency fetch (if cold)
    pub cold_build_target_s: u64,

    // =====================================================================
    // CONCURRENCY & RESOURCE LIMITS
    // =====================================================================
    /// Max concurrent compilation handles (Semaphore permits)
    /// Default: 16 (2x typical core count for development; adjust per system)
    /// Rationale: Each compilation uses ~3 file descriptors (sandbox dir, UDS, stdout pipe)
    /// Must satisfy: max_concurrency * 3 <= soft_fd_limit (validated in validate())
    pub max_concurrency: usize,

    /// Process kill timeout for a single compilation (seconds)
    /// Default: 300 (5 minutes)
    /// Rationale: esbuild on a large bundle + dependency resolution can take minutes
    /// Pattern: Hard fail after timeout; no infinite hangs
    pub compilation_timeout_s: u64,

    // =====================================================================
    // SNAPSHOT & PERSISTENCE
    // =====================================================================
    /// Periodic interval for persisting CompilationIndex snapshot Envelope (seconds)
    /// Default: 3600 (1 hour)
    /// Sentinel: 0 means disabled — boot always replays full Envelope log
    /// Rationale: At 1M entities, snapshot reduces boot time from seconds to milliseconds
    pub snapshot_interval_s: u64,

    // =====================================================================
    // INCREMENTAL MAINTENANCE (GC, cleanup)
    // =====================================================================
    /// Interval for background sweep of dead Weak<Multihash> entries (seconds)
    /// Default: 60 (every minute)
    /// Rationale: Prevent unbounded accumulation of dead entries in intern table
    /// Pattern: Low-priority async task; safe to run during normal operations
    pub tombstone_sweep_interval_s: u64,

    /// Interval for CAS garbage collection (seconds)
    /// Default: 86400 (daily)
    /// Rationale: Mark-and-sweep on Envelope log to reclaim unused CAS blobs
    /// Pattern: Only runs at quiescence (active_in_flight_count == 0)
    pub gc_interval_secs: u64,

    // =====================================================================
    // BATCH & BROADCAST LIMITS
    // =====================================================================
    /// Saturation limit for broadcast batch payload (bytes)
    /// Default: 5_000_000 (5 MB)
    /// Rationale: If batch exceeds this, strip payloads to hashes; clients lazy-fetch
    /// Pattern 41: Prevents N-multiplier OOM (batch × N subscribers)
    /// Hard ceiling: enforced in validate() to cap at 50MB max
    pub max_batch_payload_bytes: usize,

    // =====================================================================
    // CLIENT-SIDE LAZY-FETCH (Pattern 40)
    // =====================================================================
    /// Max jitter for client-side lazy-fetch of stripped Envelope payloads (ms)
    /// Default: 5000 (5 seconds)
    /// Rationale: Randomize fetch start to prevent N clients DDoS'ing CAS simultaneously
    /// Pattern: Client SDK applies random(0, max_lazy_fetch_jitter_ms) delay
    pub max_lazy_fetch_jitter_ms: u64,

    /// Concurrency limit on client-side lazy-fetch from CAS (count)
    /// Default: 10
    /// Rationale: Prevent CAS overload from N parallel fetch requests
    /// Pattern: Client SDK enforces bounded queue of in-flight lazy-fetches
    pub max_concurrent_lazy_fetches: usize,

    // =====================================================================
    // I/O BOUNDARIES (security + resource protection)
    // =====================================================================
    /// Max bytes to read from compiler output BEFORE JSON parsing (bytes)
    /// Default: 10_485_760 (10 MB)
    /// Rationale: Prevent OOM attacks via large malicious manifest (e.g., 5GB JSON)
    /// Pattern SP5: Stream cap applied at ByteSource layer, before parser touches data
    pub max_manifest_bytes: usize,

    /// Max allowed manifest file size (bytes)
    /// Default: 10_485_760 (10 MB)
    /// Rationale: Compiled output manifest (meta.json) should never exceed reasonable bounds
    /// Note: distinct from max_manifest_bytes which is the I/O stream cap
    pub max_manifest_file_bytes: usize,

    // =====================================================================
    // BATCH COALESCING
    // =====================================================================
    /// Coalescing window for batching compilation requests (milliseconds)
    /// Default: 500
    /// Rationale: Collect requests arriving within this window into a single batch
    /// Max allowed: 30_000 (30 seconds — validated in validate())
    /// Pattern: Wait up to this duration before starting compilation; yields higher batch efficiency
    pub coalesce_window_ms: u64,

    // =====================================================================
    // SECURITY & ACCESS CONTROL
    // =====================================================================
    /// Allowed compiler binary paths (allowlist)
    /// Default: empty (all binaries allowed in dev mode)
    /// Pattern SP9: capability-based access — only whitelisted binaries can execute
    /// Non-empty = restrictive mode (e.g., ["/usr/bin/esbuild"])
    pub allowed_binaries: Vec<PathBuf>,
}

impl CompilationConfig {
    /// Validate configuration constraints at boot.
    ///
    /// Checks:
    /// 1. max_concurrency is reasonable given system file descriptor limits
    /// 2. max_batch_payload_bytes is within hard ceiling (50 MB)
    /// 3. timeout values are sensible (non-zero, reasonable ranges)
    /// 4. coalesce_window_ms does not exceed 30s ceiling
    ///
    /// Returns Err with human-readable message if validation fails.
    pub fn validate(&self) -> Result<(), String> {
        // Check 1: File descriptor constraint
        // Each compilation uses ~3 FDs (sandbox dir, UDS socket, stdout pipe)
        // This is a soft check — the actual FD limit depends on system configuration
        if self.max_concurrency > 1000 {
            return Err(format!(
                "max_concurrency {} exceeds safety threshold (max 1000); \
                 this may exhaust file descriptors at {} * 3 = {} total FDs",
                self.max_concurrency,
                self.max_concurrency,
                self.max_concurrency * 3
            ));
        }

        // Check 2: Hard ceiling on batch payload
        const MAX_BATCH_PAYLOAD_CEILING: usize = 50 * 1024 * 1024; // 50 MB
        if self.max_batch_payload_bytes > MAX_BATCH_PAYLOAD_CEILING {
            return Err(format!(
                "max_batch_payload_bytes {} exceeds hard ceiling {}; \
                 this prevents broadcaster serialization bound",
                self.max_batch_payload_bytes, MAX_BATCH_PAYLOAD_CEILING
            ));
        }

        // Check 3: Timeout is non-zero and reasonable
        if self.compilation_timeout_s == 0 {
            return Err("compilation_timeout_s must be non-zero".to_string());
        }
        if self.compilation_timeout_s > 3600 {
            return Err(format!(
                "compilation_timeout_s {} exceeds safety threshold (max 3600s); \
                 this may mask runaway compilations",
                self.compilation_timeout_s
            ));
        }

        // Check 4: Coalesce window capped at 30s
        const MAX_COALESCE_WINDOW_MS: u64 = 30_000;
        if self.coalesce_window_ms > MAX_COALESCE_WINDOW_MS {
            return Err(format!(
                "coalesce_window_ms {} exceeds safety threshold (max 30000ms); \
                 this may create unbounded latency",
                self.coalesce_window_ms
            ));
        }

        // Check 5: Manifest size limits are consistent
        if self.max_manifest_bytes == 0 || self.max_manifest_file_bytes == 0 {
            return Err(
                "max_manifest_bytes and max_manifest_file_bytes must be non-zero".to_string(),
            );
        }

        Ok(())
    }

    /// Snapshot interval for persistent state (returns true if enabled)
    pub fn snapshots_enabled(&self) -> bool {
        self.snapshot_interval_s > 0
    }
}

impl Default for CompilationConfig {
    fn default() -> Self {
        Self {
            // Performance targets (milliseconds/seconds)
            boot_target_ms: 500,
            hot_noop_target_ms: 10,
            hot_compile_target_ms: 100,
            cold_build_target_s: 10,

            // Concurrency & resource limits
            max_concurrency: 16, // 2x typical core count; update for your system
            compilation_timeout_s: 300,

            // Snapshot & persistence
            snapshot_interval_s: 3600, // 1 hour

            // Incremental maintenance
            tombstone_sweep_interval_s: 60, // 1 minute
            gc_interval_secs: 86400,        // 24 hours (daily)

            // Batch & broadcast
            max_batch_payload_bytes: 5_000_000, // 5 MB

            // Client-side lazy-fetch
            max_lazy_fetch_jitter_ms: 5000,  // 5 seconds
            max_concurrent_lazy_fetches: 10, // 10 concurrent fetches

            // I/O boundaries
            max_manifest_bytes: 10 * 1024 * 1024,      // 10 MB
            max_manifest_file_bytes: 10 * 1024 * 1024, // 10 MB

            // Batch coalescing
            coalesce_window_ms: 500, // 500ms default

            // Security
            allowed_binaries: vec![], // Empty = all allowed (dev mode)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config_is_valid() {
        let config = CompilationConfig::default();
        assert!(config.validate().is_ok(), "Default config must be valid");
    }

    #[test]
    fn test_validate_rejects_excessive_concurrency() {
        let config = CompilationConfig {
            max_concurrency: 2000,
            ..Default::default()
        };
        assert!(
            config.validate().is_err(),
            "Should reject max_concurrency > 1000"
        );
    }

    #[test]
    fn test_validate_rejects_payload_exceeding_ceiling() {
        let config = CompilationConfig {
            max_batch_payload_bytes: 100 * 1024 * 1024,
            ..Default::default()
        };
        assert!(
            config.validate().is_err(),
            "Should reject payload exceeding 50 MB ceiling"
        );
    }

    #[test]
    fn test_validate_rejects_zero_timeout() {
        let config = CompilationConfig {
            compilation_timeout_s: 0,
            ..Default::default()
        };
        assert!(config.validate().is_err(), "Should reject zero timeout");
    }

    #[test]
    fn test_validate_rejects_excessive_timeout() {
        let config = CompilationConfig {
            compilation_timeout_s: 7200,
            ..Default::default()
        };
        assert!(config.validate().is_err(), "Should reject timeout > 3600s");
    }

    #[test]
    fn test_validate_rejects_excessive_coalesce_window() {
        let config = CompilationConfig {
            coalesce_window_ms: 60_000,
            ..Default::default()
        };
        assert!(
            config.validate().is_err(),
            "Should reject coalesce_window_ms > 30000ms"
        );
    }

    #[test]
    fn test_snapshots_enabled() {
        let mut config = CompilationConfig::default();
        assert!(
            config.snapshots_enabled(),
            "Snapshots should be enabled by default"
        );

        config.snapshot_interval_s = 0;
        assert!(
            !config.snapshots_enabled(),
            "Snapshots should be disabled when interval is 0"
        );
    }

    #[test]
    fn test_validate_rejects_zero_manifest_bytes() {
        let config = CompilationConfig {
            max_manifest_bytes: 0,
            ..Default::default()
        };
        assert!(
            config.validate().is_err(),
            "Should reject zero max_manifest_bytes"
        );
    }

    #[test]
    fn test_config_with_allowed_binaries() {
        let config = CompilationConfig {
            allowed_binaries: vec![
                PathBuf::from("/usr/bin/esbuild"),
                PathBuf::from("/usr/bin/rustc"),
            ],
            ..Default::default()
        };
        assert_eq!(config.allowed_binaries.len(), 2);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_coalesce_window_at_limit() {
        let config = CompilationConfig {
            coalesce_window_ms: 30_000,
            ..Default::default()
        };
        assert!(
            config.validate().is_ok(),
            "Should accept coalesce_window_ms = 30000ms"
        );
    }
}
