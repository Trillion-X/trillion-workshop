//! Evaluation context for operator execution
//!
//! The EvalContext provides configuration for how operators should execute,
//! including float precision mode and future extensibility for recursion limits,
//! determinism levels, etc.

use crate::crypto::{EncodingCapability, HashCapability};
use crate::datetime::DateTimeExtractCapability;
use crate::registry::CapabilityRegistry;
use crate::serialization::FormatCapability;
use serde::{Deserialize, Serialize};

/// Float computation mode for numeric operators.
///
/// This enum controls how floating-point arithmetic is performed, allowing
/// operators to choose between strict decimal precision (financial grade) and
/// fast IEEE 754 f64 operations (performance).
///
/// See: docs/platform-architecture/core-platform-architecture/the-formula-engine-amendment.md
/// Lines 175-200 for detailed semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FloatMode {
    /// Strict mode - uses rust_decimal for financial-grade precision.
    ///
    /// In this mode:
    /// - 0.1 + 0.2 = 0.3 (exact decimal arithmetic)
    /// - No floating-point rounding errors
    /// - Slower performance
    /// - Best for financial calculations, money, percentages
    ///
    /// This is the **default** mode for operator evaluation.
    Strict,

    /// Fast mode - uses f64 for high-performance IEEE 754 operations.
    ///
    /// In this mode:
    /// - 0.1 + 0.2 = 0.30000000000000004 (IEEE 754 behavior)
    /// - Subject to floating-point rounding errors
    /// - Faster performance
    /// - Best for graphics, animations, scientific computing
    Fast,
}

impl Default for FloatMode {
    /// The default float mode is Strict (rust_decimal) for financial-grade precision.
    fn default() -> Self {
        FloatMode::Strict
    }
}

/// Evaluation context for operator execution.
///
/// This struct provides configuration and state for operator evaluation.
/// It contains float_mode and a capability registry for extensible operator dispatch.
///
/// The context is designed to be extended with additional state in the future:
/// - Recursion limits (prevent stack overflow in nested operations)
/// - Determinism level (control randomness, timestamps, etc.)
/// - Locale settings (for text operations)
/// - Timezone settings (for date operations)
#[derive(Debug, Clone)]
pub struct EvalContext {
    /// The float computation mode to use for numeric operators.
    pub float_mode: FloatMode,

    /// Capability registry for extensible operator dispatch (FormatCapability, HashCapability, etc.)
    pub capabilities: CapabilityRegistry,

    /// Optional entity relationship graph for graph traversal operators (parents, children, neighbors, traverse).
    /// Populated by the kernel when graph context is available.
    pub graph: Option<std::sync::Arc<graph::DirectedGraph<String>>>,
}

impl EvalContext {
    /// Create a new evaluation context with the specified float mode.
    pub fn new(float_mode: FloatMode) -> Self {
        let mut capabilities = CapabilityRegistry::new();
        capabilities.register(FormatCapability::default());
        capabilities.register(DateTimeExtractCapability::default());
        capabilities.register(HashCapability::new());
        capabilities.register(EncodingCapability::new());
        EvalContext {
            float_mode,
            capabilities,
            graph: None,
        }
    }

    /// Create a new evaluation context with strict float mode (rust_decimal).
    pub fn strict() -> Self {
        let mut capabilities = CapabilityRegistry::new();
        capabilities.register(FormatCapability::default());
        capabilities.register(DateTimeExtractCapability::default());
        capabilities.register(HashCapability::new());
        capabilities.register(EncodingCapability::new());
        EvalContext {
            float_mode: FloatMode::Strict,
            capabilities,
            graph: None,
        }
    }

    /// Create a new evaluation context with fast float mode (f64).
    pub fn fast() -> Self {
        let mut capabilities = CapabilityRegistry::new();
        capabilities.register(FormatCapability::default());
        capabilities.register(DateTimeExtractCapability::default());
        capabilities.register(HashCapability::new());
        capabilities.register(EncodingCapability::new());
        EvalContext {
            float_mode: FloatMode::Fast,
            capabilities,
            graph: None,
        }
    }
}

impl Default for EvalContext {
    /// The default evaluation context uses Strict float mode with all default capabilities.
    fn default() -> Self {
        EvalContext::strict()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_float_mode_default() {
        assert_eq!(FloatMode::default(), FloatMode::Strict);
    }

    #[test]
    fn test_float_mode_variants() {
        let strict = FloatMode::Strict;
        let fast = FloatMode::Fast;
        assert_ne!(strict, fast);
    }

    #[test]
    fn test_eval_context_new() {
        let ctx_strict = EvalContext::new(FloatMode::Strict);
        assert_eq!(ctx_strict.float_mode, FloatMode::Strict);

        let ctx_fast = EvalContext::new(FloatMode::Fast);
        assert_eq!(ctx_fast.float_mode, FloatMode::Fast);
    }

    #[test]
    fn test_eval_context_strict() {
        let ctx = EvalContext::strict();
        assert_eq!(ctx.float_mode, FloatMode::Strict);
    }

    #[test]
    fn test_eval_context_fast() {
        let ctx = EvalContext::fast();
        assert_eq!(ctx.float_mode, FloatMode::Fast);
    }

    #[test]
    fn test_eval_context_default() {
        let ctx = EvalContext::default();
        assert_eq!(ctx.float_mode, FloatMode::Strict);
    }

    #[test]
    fn test_eval_context_clone() {
        let ctx1 = EvalContext::strict();
        let ctx2 = ctx1.clone();
        assert_eq!(ctx1.float_mode, ctx2.float_mode);
    }

    #[test]
    fn test_eval_context_debug() {
        let ctx = EvalContext::strict();
        let debug_str = format!("{:?}", ctx);
        assert!(debug_str.contains("EvalContext"));
        assert!(debug_str.contains("Strict"));
    }

    #[test]
    fn test_eval_context_has_capabilities() {
        let ctx = EvalContext::strict();
        // Verify that FormatCapability is registered
        assert!(ctx.capabilities.get::<FormatCapability>().is_some());
    }
}
