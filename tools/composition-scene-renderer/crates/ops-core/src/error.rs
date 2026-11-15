//! Error types for operator evaluation
//!
//! This module provides structured error types for operator evaluation failures.
//! Errors include machine-readable codes and detailed diagnostic information.

use thiserror::Error;

/// Errors that can occur during operator evaluation.
///
/// Each error variant includes:
/// - A machine-readable error code (via Display implementation)
/// - Detailed diagnostic information
/// - Context about what went wrong
#[derive(Error, Debug, Clone, PartialEq)]
pub enum OpError {
    #[error("FE_PAYLOAD_TOO_DEEP: JSON depth {observed} exceeds limit {limit}")]
    PayloadTooDeep { observed: usize, limit: usize },

    #[error("FE_PAYLOAD_TOO_LARGE: JSON {dimension} {observed} exceeds limit {limit}")]
    PayloadTooLarge {
        dimension: &'static str,
        observed: usize,
        limit: usize,
    },

    #[error("FE_RESOURCE_POLICY_INVALID: {field}: {reason}")]
    ResourcePolicyInvalid { field: String, reason: String },

    /// Type mismatch - operator received wrong type
    #[error("Type error: expected {expected}, got {actual} for operation '{operation}'")]
    TypeMismatch {
        operation: String,
        expected: String,
        actual: String,
    },

    /// Division by zero
    #[error("Division by zero in operation '{operation}'")]
    DivisionByZero { operation: String },

    /// Numeric overflow or underflow
    #[error("Numeric overflow in operation '{operation}': {details}")]
    NumericOverflow { operation: String, details: String },

    /// Invalid operation (e.g., sqrt of negative number)
    #[error("Invalid operation '{operation}': {reason}")]
    InvalidOperation { operation: String, reason: String },

    /// Null value where non-null was required
    #[error("Null value not allowed in operation '{operation}'")]
    NullNotAllowed { operation: String },

    /// Array/object index out of bounds
    #[error("Index {index} out of bounds in operation '{operation}' (length: {length})")]
    IndexOutOfBounds {
        operation: String,
        index: i64,
        length: usize,
    },

    /// Missing required argument
    #[error("Missing required argument '{argument}' for operation '{operation}'")]
    MissingArgument { operation: String, argument: String },

    /// Too many arguments provided
    #[error("Too many arguments for operation '{operation}': expected {expected}, got {actual}")]
    TooManyArguments {
        operation: String,
        expected: usize,
        actual: usize,
    },

    /// Invalid argument value
    #[error("Invalid argument value for operation '{operation}': {reason}")]
    InvalidArgument { operation: String, reason: String },

    /// String operation error (e.g., invalid regex)
    #[error("String operation error in '{operation}': {details}")]
    StringError { operation: String, details: String },

    /// Conversion error between types
    #[error("Conversion error in '{operation}': cannot convert {from} to {to}")]
    ConversionError {
        operation: String,
        from: String,
        to: String,
    },

    /// Generic error with custom message
    #[error("Error in operation '{operation}': {message}")]
    Generic { operation: String, message: String },
}

impl OpError {
    /// Get a machine-readable error code for this error.
    ///
    /// Error codes follow the pattern: `OP_ERROR_<VARIANT>`
    pub fn error_code(&self) -> &'static str {
        match self {
            OpError::PayloadTooDeep { .. } => "FE_PAYLOAD_TOO_DEEP",
            OpError::PayloadTooLarge { .. } => "FE_PAYLOAD_TOO_LARGE",
            OpError::ResourcePolicyInvalid { .. } => "FE_RESOURCE_POLICY_INVALID",
            OpError::TypeMismatch { .. } => "OP_ERROR_TYPE_MISMATCH",
            OpError::DivisionByZero { .. } => "OP_ERROR_DIVISION_BY_ZERO",
            OpError::NumericOverflow { .. } => "OP_ERROR_NUMERIC_OVERFLOW",
            OpError::InvalidOperation { .. } => "OP_ERROR_INVALID_OPERATION",
            OpError::NullNotAllowed { .. } => "OP_ERROR_NULL_NOT_ALLOWED",
            OpError::IndexOutOfBounds { .. } => "OP_ERROR_INDEX_OUT_OF_BOUNDS",
            OpError::MissingArgument { .. } => "OP_ERROR_MISSING_ARGUMENT",
            OpError::TooManyArguments { .. } => "OP_ERROR_TOO_MANY_ARGUMENTS",
            OpError::InvalidArgument { .. } => "OP_ERROR_INVALID_ARGUMENT",
            OpError::StringError { .. } => "OP_ERROR_STRING_ERROR",
            OpError::ConversionError { .. } => "OP_ERROR_CONVERSION_ERROR",
            OpError::Generic { .. } => "OP_ERROR_GENERIC",
        }
    }

    /// Get the operation name that caused this error.
    pub fn operation(&self) -> &str {
        match self {
            OpError::PayloadTooDeep { .. }
            | OpError::PayloadTooLarge { .. }
            | OpError::ResourcePolicyInvalid { .. } => "json_conversion",
            OpError::TypeMismatch { operation, .. }
            | OpError::DivisionByZero { operation }
            | OpError::NumericOverflow { operation, .. }
            | OpError::InvalidOperation { operation, .. }
            | OpError::NullNotAllowed { operation }
            | OpError::IndexOutOfBounds { operation, .. }
            | OpError::MissingArgument { operation, .. }
            | OpError::TooManyArguments { operation, .. }
            | OpError::InvalidArgument { operation, .. }
            | OpError::StringError { operation, .. }
            | OpError::ConversionError { operation, .. }
            | OpError::Generic { operation, .. } => operation,
        }
    }
}

impl From<crate::value::JsonConversionError> for OpError {
    fn from(error: crate::value::JsonConversionError) -> Self {
        match error {
            crate::value::JsonConversionError::TooDeep { observed, limit } => {
                Self::PayloadTooDeep { observed, limit }
            }
            crate::value::JsonConversionError::TooManyNodes { observed, limit } => {
                Self::PayloadTooLarge {
                    dimension: "nodes",
                    observed,
                    limit,
                }
            }
            crate::value::JsonConversionError::TooLarge {
                observed_bytes,
                limit_bytes,
            } => Self::PayloadTooLarge {
                dimension: "bytes",
                observed: observed_bytes,
                limit: limit_bytes,
            },
            crate::value::JsonConversionError::InvalidPolicy { field, reason } => {
                Self::ResourcePolicyInvalid { field, reason }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_type_mismatch_error() {
        let err = OpError::TypeMismatch {
            operation: "add".to_string(),
            expected: "number".to_string(),
            actual: "string".to_string(),
        };
        assert_eq!(err.error_code(), "OP_ERROR_TYPE_MISMATCH");
        assert_eq!(err.operation(), "add");
        assert!(err.to_string().contains("expected number"));
    }

    #[test]
    fn test_division_by_zero_error() {
        let err = OpError::DivisionByZero {
            operation: "div".to_string(),
        };
        assert_eq!(err.error_code(), "OP_ERROR_DIVISION_BY_ZERO");
        assert_eq!(err.operation(), "div");
        assert!(err.to_string().contains("Division by zero"));
    }

    #[test]
    fn test_numeric_overflow_error() {
        let err = OpError::NumericOverflow {
            operation: "mul".to_string(),
            details: "result too large".to_string(),
        };
        assert_eq!(err.error_code(), "OP_ERROR_NUMERIC_OVERFLOW");
        assert_eq!(err.operation(), "mul");
    }

    #[test]
    fn test_invalid_operation_error() {
        let err = OpError::InvalidOperation {
            operation: "sqrt".to_string(),
            reason: "negative number".to_string(),
        };
        assert_eq!(err.error_code(), "OP_ERROR_INVALID_OPERATION");
        assert_eq!(err.operation(), "sqrt");
    }

    #[test]
    fn test_null_not_allowed_error() {
        let err = OpError::NullNotAllowed {
            operation: "concat".to_string(),
        };
        assert_eq!(err.error_code(), "OP_ERROR_NULL_NOT_ALLOWED");
        assert_eq!(err.operation(), "concat");
    }

    #[test]
    fn test_index_out_of_bounds_error() {
        let err = OpError::IndexOutOfBounds {
            operation: "get".to_string(),
            index: 5,
            length: 3,
        };
        assert_eq!(err.error_code(), "OP_ERROR_INDEX_OUT_OF_BOUNDS");
        assert_eq!(err.operation(), "get");
        assert!(err.to_string().contains("Index 5"));
    }

    #[test]
    fn test_missing_argument_error() {
        let err = OpError::MissingArgument {
            operation: "if".to_string(),
            argument: "condition".to_string(),
        };
        assert_eq!(err.error_code(), "OP_ERROR_MISSING_ARGUMENT");
        assert_eq!(err.operation(), "if");
    }

    #[test]
    fn test_error_implements_std_error() {
        let err = OpError::Generic {
            operation: "test".to_string(),
            message: "test error".to_string(),
        };
        // This compiles if OpError implements std::error::Error
        let _: &dyn std::error::Error = &err;
    }

    #[test]
    fn test_error_clone() {
        let err1 = OpError::DivisionByZero {
            operation: "div".to_string(),
        };
        let err2 = err1.clone();
        assert_eq!(err1, err2);
    }

    #[test]
    fn test_error_debug() {
        let err = OpError::TypeMismatch {
            operation: "add".to_string(),
            expected: "number".to_string(),
            actual: "string".to_string(),
        };
        let debug_str = format!("{:?}", err);
        assert!(debug_str.contains("TypeMismatch"));
    }
}
