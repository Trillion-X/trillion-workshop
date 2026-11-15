//! Serialization capability with generic parse/stringify dispatch.
//!
//! This module implements the `FormatCapability` and the generic `parse` and `stringify`
//! operators for all supported serialization formats: JSON, YAML, TOML, and CBOR.
//!
//! # Design
//!
//! The variant (format name) is a data parameter, not encoded in the function name.
//! The `FormatCapability` holds type-erased closures for each registered format:
//! - Parser: `fn(&str, &CapabilityLimits) -> Result<OpValue, OpError>`
//! - Stringifier: `fn(&OpValue, &CapabilityLimits) -> Result<String, OpError>`
//!
//! The capability is registered in EvalContext at construction time (L083 — maximally capable
//! defaults). All WASM-compatible formats (JSON, YAML, TOML, CBOR) are registered by default.
//!
//! # Resource Limits (SP9)
//!
//! `CapabilityLimits` enforces bounded resource consumption:
//! - `max_input_bytes`: Reject inputs larger than this (prevents DoS)
//! - `max_nesting_depth`: Reject deeply nested structures (prevents stack overflow)
//! - `max_path_depth`: Reject paths with too many segments (for ValuePredicate paths)

use crate::context::EvalContext;
use crate::error::OpError;
use crate::value::{
    try_from_json_with_budget, try_to_json_with_budget, JsonConversionBudget, OpValue,
};
use std::collections::HashMap;
use std::sync::Arc;

/// Resource limits for parsing and stringification operations (SP9).
///
/// These limits prevent denial-of-service attacks via oversized or deeply nested inputs.
#[derive(Debug, Clone, Copy)]
pub struct CapabilityLimits {
    /// Maximum input size in bytes (default: 128 MB)
    pub max_input_bytes: usize,

    /// Maximum nesting depth for structures like [[[[...]]]] (default: 512)
    pub max_nesting_depth: usize,

    /// Maximum path depth for ValuePredicate paths (default: 64)
    pub max_path_depth: usize,
}

impl Default for CapabilityLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: 128 * 1024 * 1024, // 128 MB
            max_nesting_depth: 512,
            max_path_depth: 64,
        }
    }
}

/// Type alias for a format parser function.
///
/// Takes a string input and capability limits, returns an OpValue or OpError.
type FormatParser = Arc<dyn Fn(&str, &CapabilityLimits) -> Result<OpValue, OpError> + Send + Sync>;

/// Type alias for a format stringifier function.
///
/// Takes an OpValue and capability limits, returns a string or OpError.
type FormatStringifier =
    Arc<dyn Fn(&OpValue, &CapabilityLimits) -> Result<String, OpError> + Send + Sync>;

/// Serialization format capability with registered parsers and stringifiers.
///
/// This struct holds type-erased closures for each supported format. Adding a new format
/// (e.g., "my-custom-format") requires registering a parser and stringifier — no new
/// function definitions or operator registrations needed.
#[derive(Clone)]
pub struct FormatCapability {
    parsers: HashMap<String, FormatParser>,
    stringifiers: HashMap<String, FormatStringifier>,
    limits: CapabilityLimits,
}

impl FormatCapability {
    fn json_budget(limits: &CapabilityLimits) -> JsonConversionBudget {
        JsonConversionBudget {
            max_depth: limits.max_nesting_depth,
            max_nodes: limits.max_input_bytes.saturating_div(16).max(1),
            max_string_bytes: limits.max_input_bytes,
            max_total_bytes: limits.max_input_bytes,
        }
    }

    /// Create a new FormatCapability with custom limits.
    pub fn with_limits(limits: CapabilityLimits) -> Self {
        let mut cap = Self {
            parsers: HashMap::new(),
            stringifiers: HashMap::new(),
            limits,
        };
        cap.register_builtin_formats();
        cap
    }

    /// Register a custom format parser.
    ///
    /// If a parser for this format already exists, it is replaced.
    pub fn register_parser(&mut self, format: String, parser: FormatParser) {
        self.parsers.insert(format, parser);
    }

    /// Register a custom format stringifier.
    ///
    /// If a stringifier for this format already exists, it is replaced.
    pub fn register_stringifier(&mut self, format: String, stringifier: FormatStringifier) {
        self.stringifiers.insert(format, stringifier);
    }

    /// Get the list of available formats.
    pub fn available_formats(&self) -> Vec<String> {
        let mut formats: Vec<_> = self.parsers.keys().cloned().collect();
        formats.sort();
        formats
    }

    /// Register all built-in serialization formats (JSON, YAML, TOML, CBOR).
    fn register_builtin_formats(&mut self) {
        self.register_json_format();
        self.register_yaml_format();
        self.register_toml_format();
        self.register_cbor_format();
    }

    /// Register JSON format.
    fn register_json_format(&mut self) {
        self.register_parser(
            "json".to_string(),
            Arc::new(|input, limits| {
                if input.len() > limits.max_input_bytes {
                    return Err(OpError::InvalidArgument {
                        operation: "parse".to_string(),
                        reason: format!(
                            "Input size {} bytes exceeds limit {}",
                            input.len(),
                            limits.max_input_bytes
                        ),
                    });
                }
                match serde_json::from_str::<serde_json::Value>(input) {
                    Ok(v) => try_from_json_with_budget(&v, &Self::json_budget(limits))
                        .map_err(OpError::from),
                    Err(e) => Err(OpError::InvalidOperation {
                        operation: "parse".to_string(),
                        reason: format!("JSON parse error: {}", e),
                    }),
                }
            }),
        );

        self.register_stringifier(
            "json".to_string(),
            Arc::new(|value, limits| {
                let json = try_to_json_with_budget(value, &Self::json_budget(limits))
                    .map_err(OpError::from)?;
                serde_json::to_string(&json).map_err(|e| OpError::InvalidOperation {
                    operation: "stringify".to_string(),
                    reason: format!("JSON stringify error: {}", e),
                })
            }),
        );
    }

    /// Register YAML format.
    fn register_yaml_format(&mut self) {
        self.register_parser(
            "yaml".to_string(),
            Arc::new(|input, limits| {
                if input.len() > limits.max_input_bytes {
                    return Err(OpError::InvalidArgument {
                        operation: "parse".to_string(),
                        reason: format!(
                            "Input size {} bytes exceeds limit {}",
                            input.len(),
                            limits.max_input_bytes
                        ),
                    });
                }
                match serde_yaml::from_str::<serde_json::Value>(input) {
                    Ok(v) => try_from_json_with_budget(&v, &Self::json_budget(limits))
                        .map_err(OpError::from),
                    Err(e) => Err(OpError::InvalidOperation {
                        operation: "parse".to_string(),
                        reason: format!("YAML parse error: {}", e),
                    }),
                }
            }),
        );

        self.register_stringifier(
            "yaml".to_string(),
            Arc::new(|value, limits| {
                let json = try_to_json_with_budget(value, &Self::json_budget(limits))
                    .map_err(OpError::from)?;
                serde_yaml::to_string(&json).map_err(|e| OpError::InvalidOperation {
                    operation: "stringify".to_string(),
                    reason: format!("YAML stringify error: {}", e),
                })
            }),
        );
    }

    /// Register TOML format.
    fn register_toml_format(&mut self) {
        self.register_parser(
            "toml".to_string(),
            Arc::new(|input, limits| {
                if input.len() > limits.max_input_bytes {
                    return Err(OpError::InvalidArgument {
                        operation: "parse".to_string(),
                        reason: format!(
                            "Input size {} bytes exceeds limit {}",
                            input.len(),
                            limits.max_input_bytes
                        ),
                    });
                }
                match toml::from_str::<toml::Value>(input) {
                    Ok(v) => {
                        // Convert toml::Value to serde_json::Value via JSON round-trip
                        match serde_json::to_value(&v) {
                            Ok(json_v) => {
                                try_from_json_with_budget(&json_v, &Self::json_budget(limits))
                                    .map_err(OpError::from)
                            }
                            Err(_e) => Err(OpError::ConversionError {
                                operation: "parse".to_string(),
                                from: "toml".to_string(),
                                to: "json".to_string(),
                            }),
                        }
                    }
                    Err(e) => Err(OpError::InvalidOperation {
                        operation: "parse".to_string(),
                        reason: format!("TOML parse error: {}", e),
                    }),
                }
            }),
        );

        self.register_stringifier(
            "toml".to_string(),
            Arc::new(|value, limits| {
                let json = try_to_json_with_budget(value, &Self::json_budget(limits))
                    .map_err(OpError::from)?;
                toml::to_string_pretty(&json).map_err(|e| OpError::InvalidOperation {
                    operation: "stringify".to_string(),
                    reason: format!("TOML stringify error: {}", e),
                })
            }),
        );
    }

    /// Register CBOR format (binary, encoded as base64 for string transport).
    fn register_cbor_format(&mut self) {
        self.register_parser(
            "cbor".to_string(),
            Arc::new(|input, limits| {
                if input.len() > limits.max_input_bytes {
                    return Err(OpError::InvalidArgument {
                        operation: "parse".to_string(),
                        reason: format!(
                            "Input size {} bytes exceeds limit {}",
                            input.len(),
                            limits.max_input_bytes
                        ),
                    });
                }
                // CBOR input is expected to be base64-encoded
                use base64::Engine;
                match base64::engine::general_purpose::STANDARD.decode(input) {
                    Ok(bytes) => {
                        match ciborium::de::from_reader::<serde_json::Value, _>(bytes.as_slice()) {
                            Ok(v) => try_from_json_with_budget(&v, &Self::json_budget(limits))
                                .map_err(OpError::from),
                            Err(e) => Err(OpError::InvalidOperation {
                                operation: "parse".to_string(),
                                reason: format!("CBOR parse error: {}", e),
                            }),
                        }
                    }
                    Err(e) => Err(OpError::InvalidArgument {
                        operation: "parse".to_string(),
                        reason: format!("Base64 decode error: {}", e),
                    }),
                }
            }),
        );

        self.register_stringifier(
            "cbor".to_string(),
            Arc::new(|value, limits| {
                let json = try_to_json_with_budget(value, &Self::json_budget(limits))
                    .map_err(OpError::from)?;
                let mut cbor_bytes = Vec::new();
                match ciborium::ser::into_writer(&json, &mut cbor_bytes) {
                    Ok(_) => {
                        // Return base64-encoded CBOR bytes
                        use base64::Engine;
                        Ok(base64::engine::general_purpose::STANDARD.encode(&cbor_bytes))
                    }
                    Err(e) => Err(OpError::InvalidOperation {
                        operation: "stringify".to_string(),
                        reason: format!("CBOR stringify error: {}", e),
                    }),
                }
            }),
        );
    }

    /// Parse an input string using the specified format.
    ///
    /// Returns an OpValue or an OpError if the format is not registered or parsing fails.
    pub fn parse(&self, input: &str, format: &str) -> Result<OpValue, OpError> {
        match self.parsers.get(format) {
            Some(parser) => parser(input, &self.limits),
            None => {
                let available = self.available_formats();
                Err(OpError::InvalidArgument {
                    operation: "parse".to_string(),
                    reason: format!(
                        "Format '{}' not registered. Available formats: {}",
                        format,
                        available.join(", ")
                    ),
                })
            }
        }
    }

    /// Stringify an OpValue using the specified format.
    ///
    /// Returns a string or an OpError if the format is not registered or stringification fails.
    pub fn stringify(&self, value: &OpValue, format: &str) -> Result<String, OpError> {
        match self.stringifiers.get(format) {
            Some(stringifier) => stringifier(value, &self.limits),
            None => {
                let available = self.available_formats();
                Err(OpError::InvalidArgument {
                    operation: "parse".to_string(),
                    reason: format!(
                        "Format '{}' not registered. Available formats: {}",
                        format,
                        available.join(", ")
                    ),
                })
            }
        }
    }
}

impl Default for FormatCapability {
    fn default() -> Self {
        Self::with_limits(CapabilityLimits::default())
    }
}

impl std::fmt::Debug for FormatCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FormatCapability")
            .field("available_formats", &self.available_formats())
            .field("limits", &self.limits)
            .finish()
    }
}

/// Generic parse operator: parse(input, format) -> OpValue
///
/// Dispatches to the registered parser for the specified format.
/// Returns null if input is null.
pub fn parse(input: &OpValue, format: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    // Null input returns null
    if input.is_null() {
        return Ok(OpValue::null());
    }

    let input_str = input.as_str("parse input")?;
    let format_str = format.as_str("format")?;

    let cap =
        ctx.capabilities
            .get::<FormatCapability>()
            .ok_or_else(|| OpError::InvalidOperation {
                operation: "parse".to_string(),
                reason: "FormatCapability not registered in context".to_string(),
            })?;

    cap.parse(input_str, format_str)
}

/// Generic stringify operator: stringify(value, format) -> string
///
/// Dispatches to the registered stringifier for the specified format.
/// Returns null if value is null.
pub fn stringify(value: &OpValue, format: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    // Null value returns null
    if value.is_null() {
        return Ok(OpValue::null());
    }

    let format_str = format.as_str("format")?;

    let cap =
        ctx.capabilities
            .get::<FormatCapability>()
            .ok_or_else(|| OpError::InvalidOperation {
                operation: "stringify".to_string(),
                reason: "FormatCapability not registered in context".to_string(),
            })?;

    match cap.stringify(value, format_str) {
        Ok(s) => Ok(OpValue::string(s)),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_with_capabilities() -> EvalContext {
        EvalContext::default()
    }

    #[test]
    fn test_json_round_trip() {
        let cap = FormatCapability::default();
        let input = r#"{"a": 1, "b": "hello"}"#;
        let parsed = cap.parse(input, "json").unwrap();
        let stringified = cap.stringify(&parsed, "json").unwrap();
        let reparsed = cap.parse(&stringified, "json").unwrap();
        assert_eq!(parsed, reparsed);
    }

    #[test]
    fn test_yaml_round_trip() {
        let cap = FormatCapability::default();
        let input = "a: 1\nb: hello";
        let parsed = cap.parse(input, "yaml").unwrap();
        let stringified = cap.stringify(&parsed, "yaml").unwrap();
        let reparsed = cap.parse(&stringified, "yaml").unwrap();
        assert_eq!(parsed, reparsed);
    }

    #[test]
    fn test_toml_round_trip() {
        let cap = FormatCapability::default();
        let input = "a = 1\nb = \"hello\"";
        let parsed = cap.parse(input, "toml").unwrap();
        let stringified = cap.stringify(&parsed, "toml").unwrap();
        // TOML stringify adds formatting, so reparsed should equal original parsed
        let reparsed = cap.parse(&stringified, "toml").unwrap();
        assert_eq!(parsed, reparsed);
    }

    #[test]
    fn test_cross_format_transcode() {
        let cap = FormatCapability::default();
        let json_input = r#"{"key": "value"}"#;
        let parsed = cap.parse(json_input, "json").unwrap();
        let yaml_str = cap.stringify(&parsed, "yaml").unwrap();
        let reparsed = cap.parse(&yaml_str, "yaml").unwrap();
        assert_eq!(parsed, reparsed);
    }

    #[test]
    fn test_unknown_format() {
        let cap = FormatCapability::default();
        let result = cap.parse("test", "unknown-format");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.error_code(), "OP_ERROR_INVALID_ARGUMENT");
    }

    #[test]
    fn test_available_formats() {
        let cap = FormatCapability::default();
        let formats = cap.available_formats();
        assert!(formats.contains(&"json".to_string()));
        assert!(formats.contains(&"yaml".to_string()));
        assert!(formats.contains(&"toml".to_string()));
        assert!(formats.contains(&"cbor".to_string()));
    }

    #[test]
    fn test_input_size_limit() {
        let limits = CapabilityLimits {
            max_input_bytes: 10,
            ..Default::default()
        };
        let cap = FormatCapability::with_limits(limits);
        let oversized = "a".repeat(100);
        let result = cap.parse(&oversized, "json");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.error_code(), "OP_ERROR_INVALID_ARGUMENT");
    }

    #[test]
    fn test_parse_operator() {
        let ctx = ctx_with_capabilities();
        let input = OpValue::string(r#"{"a": 1}"#);
        let format = OpValue::string("json");
        let result = parse(&input, &format, &ctx);
        assert!(result.is_ok());
        let parsed = result.unwrap();
        assert!(!parsed.is_null());
    }

    #[test]
    fn test_parse_null_input() {
        let ctx = ctx_with_capabilities();
        let input = OpValue::null();
        let format = OpValue::string("json");
        let result = parse(&input, &format, &ctx);
        assert!(result.is_ok());
        assert!(result.unwrap().is_null());
    }

    #[test]
    fn test_stringify_operator() {
        let ctx = ctx_with_capabilities();
        let value = OpValue::from(serde_json::json!({"a": 1}));
        let format = OpValue::string("json");
        let result = stringify(&value, &format, &ctx);
        assert!(result.is_ok());
        let stringified = result.unwrap();
        assert!(!stringified.is_null());
    }

    #[test]
    fn test_stringify_null_value() {
        let ctx = ctx_with_capabilities();
        let value = OpValue::null();
        let format = OpValue::string("json");
        let result = stringify(&value, &format, &ctx);
        assert!(result.is_ok());
        assert!(result.unwrap().is_null());
    }

    #[test]
    fn test_cbor_round_trip() {
        let cap = FormatCapability::default();
        let original = OpValue::from(serde_json::json!({
            "a": 42,
            "b": "test"
        }));

        let stringified = cap.stringify(&original, "cbor").unwrap();
        let parsed = cap.parse(&stringified, "cbor").unwrap();
        assert_eq!(original, parsed);
    }

    #[test]
    fn test_json_parse_invalid() {
        let cap = FormatCapability::default();
        let result = cap.parse("not valid json", "json");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.error_code(), "OP_ERROR_INVALID_OPERATION");
    }
}
