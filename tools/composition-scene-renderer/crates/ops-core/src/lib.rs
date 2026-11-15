//! Unified Operator Semantics for the Architect Platform
//!
//! The `ops-core` crate provides the single source of truth for operator semantics
//! across all Architect engines. This eliminates duplication between `formula-engine`
//! and `composition-engine` while preserving the exact semantics of both.
//!
//! # Core Components
//!
//! - [`OpValue`] - The runtime value type for all operators (wraps `serde_json::Value`)
//! - [`EvalContext`] - Evaluation context with float mode and future configuration
//! - [`FloatMode`] - Controls float arithmetic (Strict=rust_decimal, Fast=f64)
//! - [`OpError`] - Structured error types with machine-readable codes
//!
//! # Design Philosophy
//!
//! This crate follows the "single source of truth" principle:
//! 1. Extract exact semantics from `formula-engine` (the authoritative implementation)
//! 2. Provide these semantics as reusable operator functions
//! 3. Make both engines call `ops-core` for consistent behavior
//!
//! # Float Semantics
//!
//! The crate preserves the hybrid float model from the Formula Engine Amendment:
//!
//! - **Strict Mode** (default): Uses `rust_decimal` for financial-grade precision
//!   - `0.1 + 0.2 = 0.3` (exact decimal arithmetic)
//!   - No floating-point rounding errors
//!   - Best for financial calculations, money, percentages
//!
//! - **Fast Mode**: Uses `f64` for high-performance IEEE 754 operations
//!   - `0.1 + 0.2 = 0.30000000000000004` (IEEE 754 behavior)
//!   - Subject to floating-point rounding errors
//!   - Best for graphics, animations, scientific computing
//!
//! See: `docs/platform-architecture/core-platform-architecture/the-formula-engine-amendment.md`
//! Lines 175-200 for detailed float semantics documentation.
//!
//! # Truthiness and Equality
//!
//! The crate implements the exact truthiness and equality semantics from `formula-engine`:
//!
//! **Truthiness** (following JavaScript-like conventions):
//! - `null` is falsy
//! - `false` is falsy
//! - `0` (and `0.0`) is falsy
//! - `""` (empty string) is falsy
//! - `[]` (empty array) is falsy
//! - `{}` (empty object) is falsy
//! - Everything else is truthy
//!
//! **Equality** (with special handling):
//! - Integer vs float: `0 == 0.0` returns `true`
//! - NaN handling: `NaN == NaN` returns `true` (unlike IEEE 754)
//! - Recursive comparison for arrays and objects
//!
//! # Example Usage
//!
//! ```rust
//! use ops_core::{OpValue, EvalContext, FloatMode};
//!
//! // Create values
//! let a = OpValue::number(42.0);
//! let b = OpValue::string("hello");
//!
//! // Check truthiness
//! assert!(a.is_truthy());
//! assert!(b.is_truthy());
//! assert!(!OpValue::null().is_truthy());
//!
//! // Test equality
//! let int_zero = OpValue::from(serde_json::json!(0));
//! let float_zero = OpValue::number(0.0);
//! assert!(OpValue::are_equal(&int_zero, &float_zero));
//!
//! // Create evaluation context
//! let ctx_strict = EvalContext::strict();
//! let ctx_fast = EvalContext::fast();
//! ```
//!
//! # Future Operators
//!
//! Future agents will add operator modules:
//! - `math` - Arithmetic and mathematical functions (Agent 2)
//! - `logical` - Boolean logic and conditionals (Agent 3)
//! - `text` - String manipulation (Agent 3)
//! - `array` - Array operations (Agent 3)

pub mod constants;
pub mod context;
pub mod error;
pub mod registry;
pub mod serialization;
pub mod value;

// Operator modules (Agent 2):
pub mod conversion;
pub mod crypto;
pub mod crypto_provider;
pub mod datetime;
pub mod math;

// Operator modules (Agent 3):
pub mod array;
pub mod graph;
pub mod logical;
pub mod series;
pub mod security;
pub mod text;

// Structural operations (Task T1):
pub mod structure;

// Re-export the main types for convenience
pub use context::{EvalContext, FloatMode};
pub use error::OpError;
pub use value::{
    try_from_json_with_budget, try_to_json_with_budget, JsonConversionBudget, JsonConversionError,
    OpValue,
};

// Re-export serde_json::Value for interop
pub use serde_json::Value as JsonValue;
