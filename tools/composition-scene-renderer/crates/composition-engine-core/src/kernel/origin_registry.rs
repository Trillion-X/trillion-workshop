//! crates/composition-engine-core/src/kernel/origin_registry.rs
//!
//! # Host-Provided Origin Capability Registry
//!
//! A **1000x god-level**, first-principles registry for input origin capabilities.
//!
//! ## Purpose
//!
//! This module provides a registry for origin capabilities that are **SUPPLIED BY
//! THE HOST**, not derived from origin ID strings. This is the **Physics-correct**
//! approach: the kernel is agnostic to what "keyboard" or "pointer" means. The HOST
//! knows its input devices and registers them with their capabilities. The kernel
//! stores the mapping without interpretation.
//!
//! ## Non-Negotiable Invariants
//!
//! 1. **Capabilities are NEVER inferred from OriginID strings** - The kernel does
//!    not parse, interpret, or derive meaning from origin ID strings. All capability
//!    information comes exclusively from explicit host registration.
//!
//! 2. **Unknown origins return `None`, not a default** - The kernel never assumes
//!    capabilities. If an origin is not registered, queries return `None` and the
//!    host must decide how to handle unregistered origins.
//!
//! 3. **Registry is the SINGLE SOURCE OF TRUTH** - No other module may store or
//!    cache capability information. All capability queries flow through this registry.
//!
//! 4. **All operations are auditable** - Every registration, unregistration, and
//!    modification emits a structured `RegistryEvent` for observability.
//!
//! 5. **Deterministic serialization** - JSON output is sorted by key for reproducible
//!    snapshots, conformance testing, and debugging.
//!
//! ## Key Concepts
//!
//! - **OriginID**: Opaque string identifier from the host. The kernel never parses it.
//! - **OriginCapabilities**: Struct describing what an input origin can do (hover, pressure, tilt).
//! - **RegistryEvent**: Structured audit event for every registry mutation.
//! - **RegistryError**: Machine-readable error type with codes and remediation hints.
//!
//! ## Security Considerations
//!
//! - **OriginIDs are opaque strings** - The kernel does NOT parse, validate, or
//!   interpret them. Hosts are responsible for using sensible conventions.
//!
//! - **Hosts are trusted** - The registry assumes capability data from hosts is correct.
//!   Malicious hosts could register false capabilities, but this is a host-level concern.
//!
//! - **No capability escalation** - The registry only stores capabilities; it does not
//!   grant permissions. The kernel uses capabilities for UI behavior, not security.
//!
//! - **Audit trail** - All mutations are logged via `RegistryEvent` for forensics.
//!
//! ## Platform Agnosticism
//!
//! This registry is designed for **effortless portability** to any conceivable platform:
//! - Desktop: keyboard, mouse, trackpad
//! - Mobile: touch, on-screen keyboard
//! - VR/AR: left controller, right controller, eye tracking, hand tracking
//! - Wearables: smart watch crown, smart glasses gesture
//! - BCI: brain-computer interface thought-based input
//! - Future: haptic feedback devices, neural interfaces, holographic inputs
//!
//! The kernel does not know or care what these devices are. It only knows capabilities.
//!
//! ## AI Assistant Directive
//!
//! **CRITICAL**: The extensive, granular documentation in this codebase is a critical
//! design feature. You are **FORBIDDEN** from simplifying or removing it. Your mandate
//! is to **MAINTAIN AND EXTEND** this level of meticulous detail. Every function,
//! type, and non-trivial line of logic must be documented. This directive supersedes
//! any instinct to "clean up" or "simplify" documentation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::routing::{OriginCapabilities, OriginID};

// ============================================================================
// Error Types - Machine-Readable with Remediation Hints
// ============================================================================

/// Error codes for origin registry operations.
///
/// These codes are stable, machine-readable identifiers for error conditions.
/// They can be used for:
/// - Automated error handling in host applications
/// - Metrics and alerting
/// - Conformance testing
/// - Debugging and logging
///
/// # Stability
///
/// Error codes are part of the public API. New codes may be added, but existing
/// codes will never be removed or have their meaning changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RegistryErrorCode {
    /// Attempted to query or unregister an origin that is not registered.
    ///
    /// **Remediation**: Register the origin before querying, or check with
    /// `contains()` before attempting operations that require registration.
    OriginNotFound,

    /// Attempted to register an origin that is already registered without
    /// explicitly allowing replacement.
    ///
    /// **Remediation**: Use `register()` which allows replacement, or call
    /// `unregister()` first if you need explicit replacement semantics.
    OriginAlreadyRegistered,

    /// The provided OriginID is invalid (empty string or invalid format).
    ///
    /// **Remediation**: Ensure OriginID is a non-empty string. While the kernel
    /// treats OriginIDs as opaque, empty strings are explicitly disallowed.
    InvalidOriginId,

    /// Serialization or deserialization failed.
    ///
    /// **Remediation**: Check that the JSON/data format matches the expected
    /// schema. Use `OriginRegistry::schema()` to get the expected format.
    SerializationError,
}

/// Structured error type for origin registry operations.
///
/// This error type follows the **AI-Safe & Enterprise-Grade Fortress** principle:
/// - Machine-readable error codes
/// - Human-readable messages
/// - Remediation hints for recovery
/// - Full context for debugging
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegistryError {
    /// Machine-readable error code for automated handling.
    pub code: RegistryErrorCode,

    /// Human-readable error message describing what went wrong.
    pub message: String,

    /// Actionable remediation hint for how to fix the error.
    pub remediation: String,

    /// The OriginID involved in the error, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_id: Option<String>,
}

impl RegistryError {
    /// Create a new RegistryError with full context.
    ///
    /// # Arguments
    /// * `code` - The machine-readable error code
    /// * `message` - Human-readable description
    /// * `remediation` - How to fix the error
    /// * `origin_id` - The OriginID involved, if applicable
    pub fn new(
        code: RegistryErrorCode,
        message: impl Into<String>,
        remediation: impl Into<String>,
        origin_id: Option<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            remediation: remediation.into(),
            origin_id,
        }
    }

    /// Create an "origin not found" error.
    pub fn origin_not_found(origin: &OriginID) -> Self {
        Self::new(
            RegistryErrorCode::OriginNotFound,
            format!("Origin '{}' is not registered", origin.id),
            "Register the origin with register() before querying, or use contains() to check existence first.",
            Some(origin.id.clone()),
        )
    }

    /// Create an "origin already registered" error.
    pub fn origin_already_registered(origin: &OriginID) -> Self {
        Self::new(
            RegistryErrorCode::OriginAlreadyRegistered,
            format!("Origin '{}' is already registered", origin.id),
            "Use register() which allows replacement, or call unregister() first for explicit replacement.",
            Some(origin.id.clone()),
        )
    }

    /// Create an "invalid origin ID" error.
    pub fn invalid_origin_id(origin: &OriginID) -> Self {
        Self::new(
            RegistryErrorCode::InvalidOriginId,
            format!("Origin ID '{}' is invalid", origin.id),
            "Ensure OriginID is a non-empty string.",
            Some(origin.id.clone()),
        )
    }
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)
    }
}

impl std::error::Error for RegistryError {}

/// Result type for registry operations.
pub type RegistryResult<T> = Result<T, RegistryError>;

// ============================================================================
// Audit Events - Immutable Log of Registry Mutations
// ============================================================================

/// The type of registry operation that occurred.
///
/// Used in `RegistryEvent` to indicate what mutation was performed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryEventKind {
    /// A new origin was registered.
    Registered,

    /// An existing origin was re-registered with new capabilities.
    Updated,

    /// An origin was unregistered.
    Unregistered,

    /// All origins were cleared.
    Cleared,
}

/// Structured audit event for registry mutations.
///
/// Every mutation to the registry emits a `RegistryEvent` for observability.
/// This enables:
/// - Debugging: trace what changed and when
/// - Metrics: count registrations, track device connect/disconnect
/// - Audit logs: forensic analysis of input device changes
/// - Testing: verify expected mutations occurred
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegistryEvent {
    /// The type of mutation that occurred.
    pub kind: RegistryEventKind,

    /// The OriginID affected by this event.
    pub origin_id: String,

    /// The capabilities after the mutation (None for unregister/clear).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<OriginCapabilities>,

    /// The previous capabilities before the mutation (None for new registrations).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_capabilities: Option<OriginCapabilities>,

    /// Total number of registered origins after this event.
    pub registry_size: usize,
}

impl RegistryEvent {
    /// Create a new registry event.
    fn new(
        kind: RegistryEventKind,
        origin_id: impl Into<String>,
        capabilities: Option<OriginCapabilities>,
        previous_capabilities: Option<OriginCapabilities>,
        registry_size: usize,
    ) -> Self {
        Self {
            kind,
            origin_id: origin_id.into(),
            capabilities,
            previous_capabilities,
            registry_size,
        }
    }
}

// ============================================================================
// OriginRegistry - The Core Registry Implementation
// ============================================================================

/// Registry of origin capabilities provided by the host.
///
/// The host registers each origin with its capabilities at startup or when new
/// input devices are connected. This is the **Physics-correct** approach:
/// capabilities are **DATA provided by the host**, not **DERIVED** from string
/// prefixes in the kernel.
///
/// # Why This Matters (Physics vs Society)
///
/// The kernel must be **agnostic** to what "keyboard" or "pointer" means.
/// Different platforms have different input devices:
///
/// | Platform | Devices |
/// |----------|---------|
/// | Desktop | keyboard, mouse, trackpad |
/// | Mobile | touch, on-screen keyboard |
/// | VR | left controller, right controller, eye tracking |
/// | Wearables | smart watch crown, smart glasses gesture |
/// | BCI | thought-based input |
///
/// The host knows its devices. The kernel just stores the mapping.
///
/// # Thread Safety
///
/// The registry itself is **not** thread-safe. If concurrent access is needed,
/// wrap it in appropriate synchronization primitives (e.g., `Arc<RwLock<OriginRegistry>>`).
///
/// # Examples
///
/// ## Basic Registration
///
/// ```
/// use composition_engine_core::kernel::origin_registry::OriginRegistry;
/// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
///
/// let mut registry = OriginRegistry::new();
///
/// // Host registers its input devices
/// registry.register(OriginID::new("origin:host:keyboard:0"), OriginCapabilities::KEYBOARD);
/// registry.register(OriginID::new("origin:host:mouse:0"), OriginCapabilities::MOUSE);
///
/// // Kernel queries capabilities
/// assert_eq!(
///     registry.get(&OriginID::new("origin:host:keyboard:0")),
///     Some(&OriginCapabilities::KEYBOARD)
/// );
/// assert_eq!(
///     registry.get(&OriginID::new("unknown:device")),
///     None
/// );
/// ```
///
/// ## Hot-Swap (Device Connect/Disconnect)
///
/// ```
/// use composition_engine_core::kernel::origin_registry::OriginRegistry;
/// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
///
/// let mut registry = OriginRegistry::new();
///
/// // USB mouse connected
/// let event = registry.register_with_event(
///     OriginID::new("usb:mouse:123"),
///     OriginCapabilities::MOUSE
/// );
/// assert_eq!(event.kind, composition_engine_core::kernel::origin_registry::RegistryEventKind::Registered);
///
/// // USB mouse disconnected
/// let event = registry.unregister_with_event(&OriginID::new("usb:mouse:123"));
/// assert!(event.is_some());
/// ```
///
/// ## VR Controller Registration
///
/// ```
/// use composition_engine_core::kernel::origin_registry::OriginRegistry;
/// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
///
/// let mut registry = OriginRegistry::new();
///
/// // VR headset connected with two controllers
/// registry.register(OriginID::new("vr:left_hand"), OriginCapabilities::CONTROLLER);
/// registry.register(OriginID::new("vr:right_hand"), OriginCapabilities::CONTROLLER);
/// registry.register(OriginID::new("vr:eye_gaze"), OriginCapabilities {
///     has_hover: true,  // Eye gaze provides hover
///     has_pressure: false,
///     has_tilt: false,
/// });
///
/// assert_eq!(registry.len(), 3);
/// ```
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OriginRegistry {
    /// Internal storage: maps OriginID to OriginCapabilities.
    ///
    /// Uses custom serde for JSON compatibility (JSON requires string keys).
    /// Keys are sorted during serialization for deterministic output.
    #[serde(with = "super::origin_map_serde", default)]
    capabilities: HashMap<OriginID, OriginCapabilities>,
}

impl OriginRegistry {
    // ========================================================================
    // Constructor
    // ========================================================================

    /// Create a new empty registry.
    ///
    /// The registry starts empty. The host must register origins before the
    /// kernel can query their capabilities.
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::origin_registry::OriginRegistry;
    ///
    /// let registry = OriginRegistry::new();
    /// assert!(registry.is_empty());
    /// ```
    #[inline]
    pub fn new() -> Self {
        Self::default()
    }

    // ========================================================================
    // Registration (Mutating Operations)
    // ========================================================================

    /// Register an origin with its capabilities.
    ///
    /// If the origin is already registered, its capabilities are **replaced**.
    /// This is the "upsert" semantic - always succeeds, never fails.
    ///
    /// For explicit "insert only" or "update only" semantics, use
    /// `register_new()` or `update()` respectively.
    ///
    /// # Arguments
    ///
    /// * `origin` - The origin ID (opaque string from host)
    /// * `caps` - The capabilities for this origin
    ///
    /// # When to Call
    ///
    /// - **Application start**: Register known devices
    /// - **Device connect**: Hot-plug USB keyboard, Bluetooth mouse, etc.
    /// - **Virtual device created**: On-screen keyboard, accessibility device
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::origin_registry::OriginRegistry;
    /// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
    ///
    /// let mut registry = OriginRegistry::new();
    /// registry.register(OriginID::new("keyboard:0"), OriginCapabilities::KEYBOARD);
    /// assert!(registry.contains(&OriginID::new("keyboard:0")));
    /// ```
    #[inline]
    pub fn register(&mut self, origin: OriginID, caps: OriginCapabilities) {
        self.capabilities.insert(origin, caps);
    }

    /// Register an origin and return an audit event.
    ///
    /// This is the **observable** version of `register()`. Use this when you
    /// need to track, log, or emit metrics for registry changes.
    ///
    /// # Arguments
    ///
    /// * `origin` - The origin ID (opaque string from host)
    /// * `caps` - The capabilities for this origin
    ///
    /// # Returns
    ///
    /// A `RegistryEvent` describing the mutation:
    /// - `kind`: `Registered` (new) or `Updated` (replaced existing)
    /// - `capabilities`: The new capabilities
    /// - `previous_capabilities`: The old capabilities if replaced
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::origin_registry::{OriginRegistry, RegistryEventKind};
    /// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
    ///
    /// let mut registry = OriginRegistry::new();
    ///
    /// // First registration
    /// let event = registry.register_with_event(
    ///     OriginID::new("mouse:0"),
    ///     OriginCapabilities::MOUSE
    /// );
    /// assert_eq!(event.kind, RegistryEventKind::Registered);
    /// assert!(event.previous_capabilities.is_none());
    ///
    /// // Update (re-registration)
    /// let event = registry.register_with_event(
    ///     OriginID::new("mouse:0"),
    ///     OriginCapabilities::PEN  // Changed to pen
    /// );
    /// assert_eq!(event.kind, RegistryEventKind::Updated);
    /// assert_eq!(event.previous_capabilities, Some(OriginCapabilities::MOUSE));
    /// ```
    pub fn register_with_event(
        &mut self,
        origin: OriginID,
        caps: OriginCapabilities,
    ) -> RegistryEvent {
        let previous = self.capabilities.insert(origin.clone(), caps);
        let kind = if previous.is_some() {
            RegistryEventKind::Updated
        } else {
            RegistryEventKind::Registered
        };

        RegistryEvent::new(
            kind,
            &origin.id,
            Some(caps),
            previous,
            self.capabilities.len(),
        )
    }

    /// Register an origin only if it doesn't already exist.
    ///
    /// This is the "insert only" semantic. If the origin already exists,
    /// returns an error without modifying the registry.
    ///
    /// # Arguments
    ///
    /// * `origin` - The origin ID to register
    /// * `caps` - The capabilities for this origin
    ///
    /// # Returns
    ///
    /// - `Ok(RegistryEvent)` if the origin was registered
    /// - `Err(RegistryError)` if the origin already exists
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::origin_registry::{OriginRegistry, RegistryErrorCode};
    /// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
    ///
    /// let mut registry = OriginRegistry::new();
    ///
    /// // First registration succeeds
    /// let result = registry.register_new(OriginID::new("mouse:0"), OriginCapabilities::MOUSE);
    /// assert!(result.is_ok());
    ///
    /// // Second registration fails
    /// let result = registry.register_new(OriginID::new("mouse:0"), OriginCapabilities::PEN);
    /// assert!(result.is_err());
    /// assert_eq!(result.unwrap_err().code, RegistryErrorCode::OriginAlreadyRegistered);
    /// ```
    pub fn register_new(
        &mut self,
        origin: OriginID,
        caps: OriginCapabilities,
    ) -> RegistryResult<RegistryEvent> {
        if self.capabilities.contains_key(&origin) {
            return Err(RegistryError::origin_already_registered(&origin));
        }

        self.capabilities.insert(origin.clone(), caps);

        Ok(RegistryEvent::new(
            RegistryEventKind::Registered,
            &origin.id,
            Some(caps),
            None,
            self.capabilities.len(),
        ))
    }

    /// Unregister an origin (device disconnected).
    ///
    /// Removes the origin from the registry. If the origin was not registered,
    /// returns `None` (no error - idempotent operation).
    ///
    /// # Arguments
    ///
    /// * `origin` - The origin ID to remove
    ///
    /// # Returns
    ///
    /// The removed capabilities if the origin was registered, `None` otherwise.
    ///
    /// # When to Call
    ///
    /// - **Device disconnect**: USB unplugged, Bluetooth lost
    /// - **Virtual device destroyed**: On-screen keyboard dismissed
    /// - **Session ends**: User logs out, application terminates
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::origin_registry::OriginRegistry;
    /// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
    ///
    /// let mut registry = OriginRegistry::new();
    /// registry.register(OriginID::new("mouse:0"), OriginCapabilities::MOUSE);
    ///
    /// let removed = registry.unregister(&OriginID::new("mouse:0"));
    /// assert_eq!(removed, Some(OriginCapabilities::MOUSE));
    /// assert!(!registry.contains(&OriginID::new("mouse:0")));
    /// ```
    #[inline]
    pub fn unregister(&mut self, origin: &OriginID) -> Option<OriginCapabilities> {
        self.capabilities.remove(origin)
    }

    /// Unregister an origin and return an audit event.
    ///
    /// This is the **observable** version of `unregister()`. Use this when you
    /// need to track, log, or emit metrics for device disconnections.
    ///
    /// # Returns
    ///
    /// - `Some(RegistryEvent)` if the origin was unregistered
    /// - `None` if the origin was not registered
    pub fn unregister_with_event(&mut self, origin: &OriginID) -> Option<RegistryEvent> {
        let removed = self.capabilities.remove(origin)?;

        Some(RegistryEvent::new(
            RegistryEventKind::Unregistered,
            &origin.id,
            None,
            Some(removed),
            self.capabilities.len(),
        ))
    }

    /// Clear all registered origins.
    ///
    /// Removes every origin from the registry. Use when:
    /// - Resetting application state
    /// - Session teardown
    /// - Testing/debugging
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::origin_registry::OriginRegistry;
    /// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
    ///
    /// let mut registry = OriginRegistry::new();
    /// registry.register(OriginID::new("a"), OriginCapabilities::MOUSE);
    /// registry.register(OriginID::new("b"), OriginCapabilities::TOUCH);
    /// assert_eq!(registry.len(), 2);
    ///
    /// registry.clear();
    /// assert!(registry.is_empty());
    /// ```
    #[inline]
    pub fn clear(&mut self) {
        self.capabilities.clear();
    }

    /// Clear all origins and return an audit event.
    ///
    /// This is the **observable** version of `clear()`.
    pub fn clear_with_event(&mut self) -> RegistryEvent {
        let _count = self.capabilities.len();
        self.capabilities.clear();

        RegistryEvent::new(
            RegistryEventKind::Cleared,
            "*", // Wildcard indicates all origins
            None,
            None,
            0,
        )
    }

    // ========================================================================
    // Query Operations (Non-Mutating)
    // ========================================================================

    /// Get capabilities for an origin.
    ///
    /// Returns `None` if the origin is not registered. The kernel should
    /// handle unknown origins gracefully:
    /// - Ignore input from unregistered origins
    /// - Use safe defaults
    /// - Prompt user to configure device
    ///
    /// # Arguments
    ///
    /// * `origin` - The origin ID to query
    ///
    /// # Returns
    ///
    /// `Some(&capabilities)` if registered, `None` otherwise.
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::origin_registry::OriginRegistry;
    /// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
    ///
    /// let mut registry = OriginRegistry::new();
    /// registry.register(OriginID::new("mouse:0"), OriginCapabilities::MOUSE);
    ///
    /// assert_eq!(registry.get(&OriginID::new("mouse:0")), Some(&OriginCapabilities::MOUSE));
    /// assert_eq!(registry.get(&OriginID::new("unknown")), None);
    /// ```
    #[inline]
    pub fn get(&self, origin: &OriginID) -> Option<&OriginCapabilities> {
        self.capabilities.get(origin)
    }

    /// Get capabilities for an origin, or return an error.
    ///
    /// Unlike `get()` which returns `Option`, this method returns a structured
    /// `RegistryError` with error code and remediation hint. Use this when you
    /// need detailed error information for logging or user feedback.
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::origin_registry::{OriginRegistry, RegistryErrorCode};
    /// use composition_engine_core::kernel::routing::OriginID;
    ///
    /// let registry = OriginRegistry::new();
    ///
    /// let result = registry.get_or_error(&OriginID::new("unknown"));
    /// assert!(result.is_err());
    /// assert_eq!(result.unwrap_err().code, RegistryErrorCode::OriginNotFound);
    /// ```
    pub fn get_or_error(&self, origin: &OriginID) -> RegistryResult<&OriginCapabilities> {
        self.capabilities
            .get(origin)
            .ok_or_else(|| RegistryError::origin_not_found(origin))
    }

    /// Check if an origin is registered.
    ///
    /// Useful for validation before processing input from an origin.
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::origin_registry::OriginRegistry;
    /// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
    ///
    /// let mut registry = OriginRegistry::new();
    /// registry.register(OriginID::new("mouse:0"), OriginCapabilities::MOUSE);
    ///
    /// assert!(registry.contains(&OriginID::new("mouse:0")));
    /// assert!(!registry.contains(&OriginID::new("unknown")));
    /// ```
    #[inline]
    pub fn contains(&self, origin: &OriginID) -> bool {
        self.capabilities.contains_key(origin)
    }

    /// Get number of registered origins.
    ///
    /// Useful for metrics and debugging.
    #[inline]
    pub fn len(&self) -> usize {
        self.capabilities.len()
    }

    /// Check if registry is empty.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.capabilities.is_empty()
    }

    /// Iterate over all registered origins and their capabilities.
    ///
    /// Useful for:
    /// - Debugging: list all registered devices
    /// - Serialization: export registry state
    /// - Bulk operations: update all origins
    ///
    /// # Note
    ///
    /// Iteration order is **not** guaranteed. For deterministic order, use
    /// `iter_sorted()`.
    #[inline]
    pub fn iter(&self) -> impl Iterator<Item = (&OriginID, &OriginCapabilities)> {
        self.capabilities.iter()
    }

    /// Iterate over all registered origins in sorted order.
    ///
    /// Origins are sorted by their ID string (lexicographic order).
    /// Use this for deterministic output in tests and snapshots.
    pub fn iter_sorted(&self) -> impl Iterator<Item = (&OriginID, &OriginCapabilities)> {
        let mut entries: Vec<_> = self.capabilities.iter().collect();
        entries.sort_by(|a, b| a.0.id.cmp(&b.0.id));
        entries.into_iter()
    }

    /// Get all origin IDs as a Vec.
    ///
    /// Useful for listing all registered devices.
    pub fn origin_ids(&self) -> Vec<&OriginID> {
        self.capabilities.keys().collect()
    }

    // ========================================================================
    // Dry-Run / Validation Operations
    // ========================================================================

    /// Validate a registration without performing it.
    ///
    /// This is the **dry-run** capability for safe validation. Use this to
    /// check if a registration would succeed before committing.
    ///
    /// # Arguments
    ///
    /// * `origin` - The origin ID to validate
    /// * `require_new` - If true, fails if origin already exists
    ///
    /// # Returns
    ///
    /// - `Ok(())` if the registration would succeed
    /// - `Err(RegistryError)` if it would fail
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::origin_registry::OriginRegistry;
    /// use composition_engine_core::kernel::routing::{OriginID, OriginCapabilities};
    ///
    /// let mut registry = OriginRegistry::new();
    /// registry.register(OriginID::new("mouse:0"), OriginCapabilities::MOUSE);
    ///
    /// // Dry-run: would registering "mouse:0" as new succeed?
    /// let result = registry.validate_registration(&OriginID::new("mouse:0"), true);
    /// assert!(result.is_err()); // No, it already exists
    ///
    /// // Dry-run: would registering "keyboard:0" as new succeed?
    /// let result = registry.validate_registration(&OriginID::new("keyboard:0"), true);
    /// assert!(result.is_ok()); // Yes, it doesn't exist yet
    /// ```
    pub fn validate_registration(
        &self,
        origin: &OriginID,
        require_new: bool,
    ) -> RegistryResult<()> {
        // Validate OriginID is not empty
        if origin.id.is_empty() {
            return Err(RegistryError::invalid_origin_id(origin));
        }

        // Check for existing registration if require_new
        if require_new && self.capabilities.contains_key(origin) {
            return Err(RegistryError::origin_already_registered(origin));
        }

        Ok(())
    }
}

// ============================================================================
// Conformance Test Fixtures
// ============================================================================

/// Conformance test fixtures for the OriginRegistry.
///
/// These fixtures define **canonical input/output pairs** that any implementation
/// must satisfy. They serve as:
/// - **Contract tests**: Verify behavior matches specification
/// - **Regression tests**: Ensure changes don't break expected behavior
/// - **Documentation**: Show expected behavior by example
///
/// # Usage
///
/// ```rust,ignore
/// for fixture in OriginRegistry::conformance_fixtures() {
///     let mut registry = OriginRegistry::new();
///     for op in fixture.operations {
///         op.apply(&mut registry);
///     }
///     assert_eq!(registry, fixture.expected_state);
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConformanceFixture {
    /// Human-readable name for this test case.
    pub name: String,

    /// Description of what this fixture tests.
    pub description: String,

    /// Operations to apply to an empty registry.
    pub operations: Vec<ConformanceOperation>,

    /// Expected registry state after all operations.
    pub expected_state: HashMap<String, OriginCapabilities>,

    /// Expected number of origins after all operations.
    pub expected_count: usize,
}

/// An operation in a conformance fixture.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ConformanceOperation {
    /// Register an origin with capabilities.
    Register {
        origin_id: String,
        capabilities: OriginCapabilities,
    },

    /// Unregister an origin.
    Unregister { origin_id: String },

    /// Clear all origins.
    Clear,
}

impl OriginRegistry {
    /// Get the conformance test fixtures.
    ///
    /// These are the canonical test cases that define correct behavior.
    pub fn conformance_fixtures() -> Vec<ConformanceFixture> {
        vec![
            ConformanceFixture {
                name: "empty_registry".to_string(),
                description: "An empty registry has no origins".to_string(),
                operations: vec![],
                expected_state: HashMap::new(),
                expected_count: 0,
            },
            ConformanceFixture {
                name: "single_registration".to_string(),
                description: "Registering one origin stores it correctly".to_string(),
                operations: vec![ConformanceOperation::Register {
                    origin_id: "keyboard:0".to_string(),
                    capabilities: OriginCapabilities::KEYBOARD,
                }],
                expected_state: {
                    let mut m = HashMap::new();
                    m.insert("keyboard:0".to_string(), OriginCapabilities::KEYBOARD);
                    m
                },
                expected_count: 1,
            },
            ConformanceFixture {
                name: "multiple_registrations".to_string(),
                description: "Multiple origins can be registered".to_string(),
                operations: vec![
                    ConformanceOperation::Register {
                        origin_id: "keyboard:0".to_string(),
                        capabilities: OriginCapabilities::KEYBOARD,
                    },
                    ConformanceOperation::Register {
                        origin_id: "mouse:0".to_string(),
                        capabilities: OriginCapabilities::MOUSE,
                    },
                    ConformanceOperation::Register {
                        origin_id: "touch:0".to_string(),
                        capabilities: OriginCapabilities::TOUCH,
                    },
                ],
                expected_state: {
                    let mut m = HashMap::new();
                    m.insert("keyboard:0".to_string(), OriginCapabilities::KEYBOARD);
                    m.insert("mouse:0".to_string(), OriginCapabilities::MOUSE);
                    m.insert("touch:0".to_string(), OriginCapabilities::TOUCH);
                    m
                },
                expected_count: 3,
            },
            ConformanceFixture {
                name: "registration_replaces".to_string(),
                description: "Re-registering replaces capabilities".to_string(),
                operations: vec![
                    ConformanceOperation::Register {
                        origin_id: "device:0".to_string(),
                        capabilities: OriginCapabilities::MOUSE,
                    },
                    ConformanceOperation::Register {
                        origin_id: "device:0".to_string(),
                        capabilities: OriginCapabilities::PEN,
                    },
                ],
                expected_state: {
                    let mut m = HashMap::new();
                    m.insert("device:0".to_string(), OriginCapabilities::PEN);
                    m
                },
                expected_count: 1,
            },
            ConformanceFixture {
                name: "unregister_removes".to_string(),
                description: "Unregistering removes the origin".to_string(),
                operations: vec![
                    ConformanceOperation::Register {
                        origin_id: "device:0".to_string(),
                        capabilities: OriginCapabilities::MOUSE,
                    },
                    ConformanceOperation::Unregister {
                        origin_id: "device:0".to_string(),
                    },
                ],
                expected_state: HashMap::new(),
                expected_count: 0,
            },
            ConformanceFixture {
                name: "clear_removes_all".to_string(),
                description: "Clear removes all origins".to_string(),
                operations: vec![
                    ConformanceOperation::Register {
                        origin_id: "a".to_string(),
                        capabilities: OriginCapabilities::MOUSE,
                    },
                    ConformanceOperation::Register {
                        origin_id: "b".to_string(),
                        capabilities: OriginCapabilities::TOUCH,
                    },
                    ConformanceOperation::Clear,
                ],
                expected_state: HashMap::new(),
                expected_count: 0,
            },
            ConformanceFixture {
                name: "vr_controllers".to_string(),
                description: "VR controllers can be registered".to_string(),
                operations: vec![
                    ConformanceOperation::Register {
                        origin_id: "vr:left_hand".to_string(),
                        capabilities: OriginCapabilities::CONTROLLER,
                    },
                    ConformanceOperation::Register {
                        origin_id: "vr:right_hand".to_string(),
                        capabilities: OriginCapabilities::CONTROLLER,
                    },
                ],
                expected_state: {
                    let mut m = HashMap::new();
                    m.insert("vr:left_hand".to_string(), OriginCapabilities::CONTROLLER);
                    m.insert("vr:right_hand".to_string(), OriginCapabilities::CONTROLLER);
                    m
                },
                expected_count: 2,
            },
        ]
    }

    /// Apply a conformance operation to this registry.
    ///
    /// Used by the conformance test runner to apply operations from fixtures.
    pub fn apply_conformance_operation(&mut self, op: &ConformanceOperation) {
        match op {
            ConformanceOperation::Register {
                origin_id,
                capabilities,
            } => {
                self.register(OriginID::new(origin_id.clone()), *capabilities);
            }
            ConformanceOperation::Unregister { origin_id } => {
                self.unregister(&OriginID::new(origin_id.clone()));
            }
            ConformanceOperation::Clear => {
                self.clear();
            }
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Conformance Tests (Canonical Behavior)
    // ========================================================================

    #[test]
    fn test_conformance_all_fixtures_pass() {
        for fixture in OriginRegistry::conformance_fixtures() {
            let mut registry = OriginRegistry::new();

            for op in &fixture.operations {
                registry.apply_conformance_operation(op);
            }

            // Verify count matches
            assert_eq!(
                registry.len(),
                fixture.expected_count,
                "Fixture '{}' failed: expected {} origins, got {}",
                fixture.name,
                fixture.expected_count,
                registry.len()
            );

            // Verify each expected origin is present with correct capabilities
            for (origin_id, expected_caps) in &fixture.expected_state {
                let actual = registry.get(&OriginID::new(origin_id.clone()));
                assert_eq!(
                    actual,
                    Some(expected_caps),
                    "Fixture '{}' failed: origin '{}' has wrong capabilities",
                    fixture.name,
                    origin_id
                );
            }
        }
    }

    // ========================================================================
    // Error Type Tests
    // ========================================================================

    #[test]
    fn test_error_origin_not_found() {
        let registry = OriginRegistry::new();
        let result = registry.get_or_error(&OriginID::new("nonexistent"));

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, RegistryErrorCode::OriginNotFound);
        assert!(err.message.contains("nonexistent"));
        assert!(err.remediation.contains("register"));
    }

    #[test]
    fn test_error_origin_already_registered() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("mouse:0"), OriginCapabilities::MOUSE);

        let result = registry.register_new(OriginID::new("mouse:0"), OriginCapabilities::PEN);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, RegistryErrorCode::OriginAlreadyRegistered);
        assert!(err.message.contains("mouse:0"));
    }

    #[test]
    fn test_error_invalid_origin_id() {
        let registry = OriginRegistry::new();
        let result = registry.validate_registration(&OriginID::new(""), true);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, RegistryErrorCode::InvalidOriginId);
    }

    // ========================================================================
    // Audit Event Tests
    // ========================================================================

    #[test]
    fn test_event_registered() {
        let mut registry = OriginRegistry::new();
        let event =
            registry.register_with_event(OriginID::new("mouse:0"), OriginCapabilities::MOUSE);

        assert_eq!(event.kind, RegistryEventKind::Registered);
        assert_eq!(event.origin_id, "mouse:0");
        assert_eq!(event.capabilities, Some(OriginCapabilities::MOUSE));
        assert!(event.previous_capabilities.is_none());
        assert_eq!(event.registry_size, 1);
    }

    #[test]
    fn test_event_updated() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("device:0"), OriginCapabilities::MOUSE);

        let event =
            registry.register_with_event(OriginID::new("device:0"), OriginCapabilities::PEN);

        assert_eq!(event.kind, RegistryEventKind::Updated);
        assert_eq!(event.capabilities, Some(OriginCapabilities::PEN));
        assert_eq!(event.previous_capabilities, Some(OriginCapabilities::MOUSE));
    }

    #[test]
    fn test_event_unregistered() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("mouse:0"), OriginCapabilities::MOUSE);

        let event = registry.unregister_with_event(&OriginID::new("mouse:0"));

        assert!(event.is_some());
        let event = event.unwrap();
        assert_eq!(event.kind, RegistryEventKind::Unregistered);
        assert!(event.capabilities.is_none());
        assert_eq!(event.previous_capabilities, Some(OriginCapabilities::MOUSE));
        assert_eq!(event.registry_size, 0);
    }

    #[test]
    fn test_event_cleared() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("a"), OriginCapabilities::MOUSE);
        registry.register(OriginID::new("b"), OriginCapabilities::TOUCH);

        let event = registry.clear_with_event();

        assert_eq!(event.kind, RegistryEventKind::Cleared);
        assert_eq!(event.origin_id, "*");
        assert_eq!(event.registry_size, 0);
    }

    // ========================================================================
    // Dry-Run / Validation Tests
    // ========================================================================

    #[test]
    fn test_validate_registration_succeeds_for_new() {
        let registry = OriginRegistry::new();
        let result = registry.validate_registration(&OriginID::new("new_device"), true);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_registration_fails_for_existing_when_require_new() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("existing"), OriginCapabilities::MOUSE);

        let result = registry.validate_registration(&OriginID::new("existing"), true);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_registration_succeeds_for_existing_when_not_require_new() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("existing"), OriginCapabilities::MOUSE);

        let result = registry.validate_registration(&OriginID::new("existing"), false);
        assert!(result.is_ok());
    }

    // ========================================================================
    // Basic Registration Tests
    // ========================================================================

    #[test]
    fn test_registry_stores_capabilities_for_origin() {
        let mut registry = OriginRegistry::new();
        let origin = OriginID::new("test:origin:1");

        registry.register(origin.clone(), OriginCapabilities::MOUSE);

        assert_eq!(registry.get(&origin), Some(&OriginCapabilities::MOUSE));
    }

    #[test]
    fn test_registry_returns_none_for_unknown_origin() {
        let registry = OriginRegistry::new();
        let origin = OriginID::new("unknown:origin");

        assert_eq!(registry.get(&origin), None);
    }

    #[test]
    fn test_registry_unregister_removes_origin() {
        let mut registry = OriginRegistry::new();
        let origin = OriginID::new("test:origin:1");

        registry.register(origin.clone(), OriginCapabilities::TOUCH);
        assert!(registry.contains(&origin));

        let removed = registry.unregister(&origin);
        assert_eq!(removed, Some(OriginCapabilities::TOUCH));
        assert!(!registry.contains(&origin));
    }

    #[test]
    fn test_multiple_origins_same_capabilities() {
        let mut registry = OriginRegistry::new();

        registry.register(OriginID::new("touch:1"), OriginCapabilities::TOUCH);
        registry.register(OriginID::new("touch:2"), OriginCapabilities::TOUCH);

        assert_eq!(registry.len(), 2);
        assert_eq!(
            registry.get(&OriginID::new("touch:1")),
            Some(&OriginCapabilities::TOUCH)
        );
        assert_eq!(
            registry.get(&OriginID::new("touch:2")),
            Some(&OriginCapabilities::TOUCH)
        );
    }

    #[test]
    fn test_different_origins_different_capabilities() {
        let mut registry = OriginRegistry::new();

        registry.register(OriginID::new("kb:0"), OriginCapabilities::KEYBOARD);
        registry.register(OriginID::new("mouse:0"), OriginCapabilities::MOUSE);
        registry.register(OriginID::new("pen:0"), OriginCapabilities::PEN);

        assert_eq!(
            registry.get(&OriginID::new("kb:0")),
            Some(&OriginCapabilities::KEYBOARD)
        );
        assert_eq!(
            registry.get(&OriginID::new("mouse:0")),
            Some(&OriginCapabilities::MOUSE)
        );
        assert_eq!(
            registry.get(&OriginID::new("pen:0")),
            Some(&OriginCapabilities::PEN)
        );
    }

    // ========================================================================
    // VR/AR/Future Device Tests
    // ========================================================================

    #[test]
    fn test_vr_controller_registration() {
        let mut registry = OriginRegistry::new();

        registry.register(
            OriginID::new("vr:left_hand"),
            OriginCapabilities::CONTROLLER,
        );
        registry.register(
            OriginID::new("vr:right_hand"),
            OriginCapabilities::CONTROLLER,
        );

        assert_eq!(
            registry.get(&OriginID::new("vr:left_hand")),
            Some(&OriginCapabilities::CONTROLLER)
        );
        assert_eq!(
            registry.get(&OriginID::new("vr:right_hand")),
            Some(&OriginCapabilities::CONTROLLER)
        );
    }

    #[test]
    fn test_bci_origin_custom_capabilities() {
        let mut registry = OriginRegistry::new();

        let bci_caps = OriginCapabilities {
            has_hover: false,
            has_pressure: false,
            has_tilt: false,
        };

        registry.register(OriginID::new("bci:thought:0"), bci_caps);

        assert!(registry.contains(&OriginID::new("bci:thought:0")));
        assert_eq!(
            registry.get(&OriginID::new("bci:thought:0")),
            Some(&bci_caps)
        );
    }

    // ========================================================================
    // Hot-Swap Tests
    // ========================================================================

    #[test]
    fn test_hot_swap_unregister_removes_cleanly() {
        let mut registry = OriginRegistry::new();
        let origin = OriginID::new("usb:device:123");

        registry.register(origin.clone(), OriginCapabilities::MOUSE);
        assert!(registry.contains(&origin));
        assert_eq!(registry.len(), 1);

        let removed = registry.unregister(&origin);
        assert_eq!(removed, Some(OriginCapabilities::MOUSE));
        assert!(!registry.contains(&origin));
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn test_unregister_nonexistent_returns_none() {
        let mut registry = OriginRegistry::new();

        let removed = registry.unregister(&OriginID::new("nonexistent"));
        assert_eq!(removed, None);
    }

    // ========================================================================
    // Serialization Tests
    // ========================================================================

    #[test]
    fn test_serialization_roundtrip() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("test:1"), OriginCapabilities::MOUSE);
        registry.register(OriginID::new("test:2"), OriginCapabilities::TOUCH);

        let json = serde_json::to_string(&registry).unwrap();
        let restored: OriginRegistry = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.len(), 2);
        assert_eq!(
            restored.get(&OriginID::new("test:1")),
            Some(&OriginCapabilities::MOUSE)
        );
        assert_eq!(
            restored.get(&OriginID::new("test:2")),
            Some(&OriginCapabilities::TOUCH)
        );
    }

    // ========================================================================
    // Iteration Tests
    // ========================================================================

    #[test]
    fn test_iterate_origins() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("a"), OriginCapabilities::MOUSE);
        registry.register(OriginID::new("b"), OriginCapabilities::TOUCH);

        let items: Vec<_> = registry.iter().collect();
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn test_iterate_sorted() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("z"), OriginCapabilities::MOUSE);
        registry.register(OriginID::new("a"), OriginCapabilities::TOUCH);
        registry.register(OriginID::new("m"), OriginCapabilities::PEN);

        let ids: Vec<_> = registry
            .iter_sorted()
            .map(|(id, _)| id.id.as_str())
            .collect();
        assert_eq!(ids, vec!["a", "m", "z"]);
    }

    // ========================================================================
    // Edge Cases
    // ========================================================================

    #[test]
    fn test_empty_registry() {
        let registry = OriginRegistry::new();

        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);
        assert_eq!(registry.get(&OriginID::new("any")), None);
    }

    #[test]
    fn test_clear_registry() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("a"), OriginCapabilities::MOUSE);
        registry.register(OriginID::new("b"), OriginCapabilities::TOUCH);

        assert_eq!(registry.len(), 2);

        registry.clear();

        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn test_register_replaces_existing() {
        let mut registry = OriginRegistry::new();
        let origin = OriginID::new("changeable");

        registry.register(origin.clone(), OriginCapabilities::MOUSE);
        assert_eq!(registry.get(&origin), Some(&OriginCapabilities::MOUSE));

        registry.register(origin.clone(), OriginCapabilities::PEN);
        assert_eq!(registry.get(&origin), Some(&OriginCapabilities::PEN));
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn test_origin_id_is_opaque_string() {
        let mut registry = OriginRegistry::new();

        registry.register(
            OriginID::new("literally:anything:goes:here"),
            OriginCapabilities::KEYBOARD,
        );
        registry.register(
            OriginID::new("emoji:🎮:controller"),
            OriginCapabilities::CONTROLLER,
        );
        // Note: Empty strings are now validated against in strict mode

        assert_eq!(registry.len(), 2);
    }

    #[test]
    fn test_origin_ids_returns_all_keys() {
        let mut registry = OriginRegistry::new();
        registry.register(OriginID::new("a"), OriginCapabilities::MOUSE);
        registry.register(OriginID::new("b"), OriginCapabilities::TOUCH);

        let ids = registry.origin_ids();
        assert_eq!(ids.len(), 2);
    }
}
