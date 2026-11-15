//! crates/composition-engine-core/src/binding/validator.rs
//!
//! Syntactic and semantic validation for Binding AST values.
//!
//! This module provides three layers of guardrails:
//!  1) Shape validation: verifies a value is a Binding and respects invariants.
//!  2) Operator validation: verifies referenced operators exist.
//!  3) Operator args validation: delegates to each operator's validator.
//!
//! Non-Negotiable Invariants:
//! - Pure and deterministic. No I/O, no global state, no time.
//! - Never panics for user errors. Returns structured diagnostics.
//! - Unknown fields are flagged to prevent silent schema drift.
//! - Path strings must be non-empty when present.
//!
//! Key Concepts:
//! - Diagnostic: machine-readable error with code, level, and optional data.
//! - Layered validation: callers choose how deep to validate.
//! - Total validation: `validate_binding_deep` composes all layers.
//!
//! Security Considerations:
//! - Prevents prototype pollution by treating inputs as plain data.
//!
//! Ported from: frontends/web/composition-engine/binding/validator.ts

use super::ast::{
    Binding, Diagnostic, DiagnosticCode, DiagnosticLevel, SelectSource, BINDING_KIND,
};
use super::operators::registry::{Operator, OperatorRegistry};
use ops_core::OpValue;
use std::collections::HashSet;
use std::sync::Arc;

// ============================================================================
// Types
// ============================================================================

/// Result of shape validation
#[derive(Debug, Clone)]
pub struct ShapeValidationResult {
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub binding: Option<Binding>,
}

/// Result of deep validation
#[derive(Debug, Clone)]
pub struct DeepValidationResult {
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub binding: Option<Binding>,
}

/// Operator resolver type - function that looks up operators by key
pub type OperatorResolver = dyn Fn(&str) -> Option<Arc<dyn Operator>>;

// ============================================================================
// Helper Functions
// ============================================================================

/// Create a diagnostic
fn diag(code: DiagnosticCode, level: DiagnosticLevel, message: impl Into<String>) -> Diagnostic {
    Diagnostic {
        code,
        level,
        message: message.into(),
        at: String::new(),
        data: None,
    }
}

/// Create an error diagnostic
fn error(code: DiagnosticCode, message: impl Into<String>) -> Diagnostic {
    diag(code, DiagnosticLevel::Error, message)
}

/// Create a warning diagnostic
fn warn(code: DiagnosticCode, message: impl Into<String>) -> Diagnostic {
    diag(code, DiagnosticLevel::Warn, message)
}

/// Check for unknown fields in a JSON object
fn find_unknown_fields(
    obj: &serde_json::Map<String, serde_json::Value>,
    allowed: &[&str],
) -> Vec<String> {
    let allowed_set: HashSet<&str> = allowed.iter().copied().collect();
    obj.keys()
        .filter(|k| !allowed_set.contains(k.as_str()))
        .cloned()
        .collect()
}

// ============================================================================
// Shape Validation
// ============================================================================

/// Type guard for Binding. Minimal, fast, and strict.
pub fn is_binding(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(obj) => obj
            .get("$kind")
            .and_then(|v| v.as_str())
            .map(|s| s == BINDING_KIND)
            .unwrap_or(false),
        _ => false,
    }
}

/// Validate Binding shape from a JSON value. No operator lookups.
pub fn validate_binding_shape(value: &serde_json::Value) -> ShapeValidationResult {
    let mut diagnostics = Vec::new();

    // Must be an object
    let obj = match value {
        serde_json::Value::Object(obj) => obj,
        _ => {
            diagnostics.push(error(
                DiagnosticCode::BindingInvalid,
                "Binding must be an object",
            ));
            return ShapeValidationResult {
                ok: false,
                diagnostics,
                binding: None,
            };
        }
    };

    // Require explicit discriminator
    match obj.get("$kind") {
        Some(serde_json::Value::String(s)) if s == BINDING_KIND => {}
        _ => {
            diagnostics.push(error(
                DiagnosticCode::BindingInvalid,
                "Binding must have `$kind: \"binding\"`",
            ));
        }
    }

    // Check for unknown top-level fields
    let allowed_top = ["$kind", "select", "transform", "default", "meta"];
    let unknown_top = find_unknown_fields(obj, &allowed_top);
    if !unknown_top.is_empty() {
        diagnostics.push(warn(
            DiagnosticCode::BindingUnknownField,
            format!("unknown fields: {}", unknown_top.join(", ")),
        ));
    }

    // Validate select
    if let Some(select_value) = obj.get("select") {
        if !select_value.is_null() {
            validate_select(select_value, &mut diagnostics);
        }
    }

    // Validate transform
    if let Some(transform_value) = obj.get("transform") {
        if !transform_value.is_null() {
            validate_transform(transform_value, &mut diagnostics);
        }
    }

    // Check if we have any errors
    let has_errors = diagnostics
        .iter()
        .any(|d| d.level == DiagnosticLevel::Error);

    // Try to parse as Binding if valid
    let binding = if !has_errors {
        serde_json::from_value::<Binding>(value.clone()).ok()
    } else {
        None
    };

    ShapeValidationResult {
        ok: !has_errors,
        diagnostics,
        binding,
    }
}

/// Validate the select field
fn validate_select(value: &serde_json::Value, diagnostics: &mut Vec<Diagnostic>) {
    let obj = match value {
        serde_json::Value::Object(obj) => obj,
        _ => {
            diagnostics.push(error(
                DiagnosticCode::BindingSelectInvalid,
                "select must be an object",
            ));
            return;
        }
    };

    // Check for unknown fields
    let allowed_sel = ["from", "path", "value", "key", "required"];
    let unknown_sel = find_unknown_fields(obj, &allowed_sel);
    if !unknown_sel.is_empty() {
        diagnostics.push(warn(
            DiagnosticCode::BindingUnknownField,
            format!("select.* unknown: {}", unknown_sel.join(", ")),
        ));
    }

    // Validate from - use SelectSource::all_names() as the canonical source of truth
    if let Some(from) = obj.get("from") {
        match from {
            serde_json::Value::String(s) => {
                // L043: Use the enum's canonical list, not a hardcoded duplicate
                let valid_sources = SelectSource::all_names();
                if !valid_sources.contains(&s.as_str()) {
                    diagnostics.push(error(
                        DiagnosticCode::BindingSelectInvalid,
                        format!("select.from must be one of: {}", valid_sources.join(", ")),
                    ));
                }
            }
            _ => {
                diagnostics.push(error(
                    DiagnosticCode::BindingSelectInvalid,
                    "select.from must be a string",
                ));
            }
        }
    }

    // Validate path
    if let Some(path) = obj.get("path") {
        match path {
            serde_json::Value::String(s) if s.is_empty() => {
                diagnostics.push(error(
                    DiagnosticCode::BindingSelectInvalid,
                    "select.path must be a non-empty string",
                ));
            }
            serde_json::Value::String(_) | serde_json::Value::Array(_) => {}
            _ => {
                diagnostics.push(error(
                    DiagnosticCode::BindingSelectInvalid,
                    "select.path must be a string or an array",
                ));
            }
        }
    }

    // Check literal requirements
    if let Some(serde_json::Value::String(from)) = obj.get("from") {
        if from == "literal" && !obj.contains_key("value") {
            diagnostics.push(error(
                DiagnosticCode::BindingSelectInvalid,
                "select.value required when from=\"literal\"",
            ));
        }

        if from == "dataSource" {
            if obj.contains_key("value") {
                diagnostics.push(error(
                    DiagnosticCode::BindingSelectInvalid,
                    "select.value is not allowed when from=\"dataSource\"",
                ));
            }
            if let Some(key) = obj.get("key") {
                if !key.is_string() {
                    diagnostics.push(error(
                        DiagnosticCode::BindingSelectInvalid,
                        "select.key must be a string when provided",
                    ));
                }
            }
        }
    }

    // Validate required
    if let Some(required) = obj.get("required") {
        if !required.is_boolean() {
            diagnostics.push(error(
                DiagnosticCode::BindingSelectInvalid,
                "select.required must be boolean",
            ));
        }
    }
}

/// Validate the transform field
fn validate_transform(value: &serde_json::Value, diagnostics: &mut Vec<Diagnostic>) {
    let arr = match value {
        serde_json::Value::Array(arr) => arr,
        _ => {
            diagnostics.push(error(
                DiagnosticCode::BindingTransformInvalid,
                "transform must be an array",
            ));
            return;
        }
    };

    for (i, step) in arr.iter().enumerate() {
        let obj = match step {
            serde_json::Value::Object(obj) => obj,
            _ => {
                diagnostics.push(error(
                    DiagnosticCode::BindingTransformInvalid,
                    format!("transform[{}] must be an object", i),
                ));
                continue;
            }
        };

        // Check for unknown fields
        let allowed_step = ["op", "args"];
        let unknown_step = find_unknown_fields(obj, &allowed_step);
        if !unknown_step.is_empty() {
            diagnostics.push(warn(
                DiagnosticCode::BindingUnknownField,
                format!("transform[{}] unknown: {}", i, unknown_step.join(", ")),
            ));
        }

        // Validate op
        match obj.get("op") {
            Some(serde_json::Value::String(s)) if !s.is_empty() => {}
            _ => {
                diagnostics.push(error(
                    DiagnosticCode::BindingTransformInvalid,
                    format!("transform[{}].op must be a non-empty string", i),
                ));
            }
        }
    }
}

// ============================================================================
// Operator Validation
// ============================================================================

/// Validate that all referenced operators exist.
pub fn validate_binding_operators(
    binding: &Binding,
    registry: &OperatorRegistry,
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    if let Some(ref steps) = binding.transform {
        for (i, step) in steps.iter().enumerate() {
            if registry.get(&step.op).is_none() {
                diagnostics.push(Diagnostic {
                    code: DiagnosticCode::BindingOperatorNotFound,
                    level: DiagnosticLevel::Error,
                    message: format!("operator not registered: {}", step.op),
                    at: String::new(),
                    data: Some({
                        let mut map = std::collections::HashMap::new();
                        map.insert("index".to_string(), serde_json::json!(i));
                        map.insert("op".to_string(), serde_json::json!(&step.op));
                        map
                    }),
                });
            }
        }
    }

    diagnostics
}

/// Validate that all referenced operators exist using a resolver function.
pub fn validate_binding_operators_with_resolver<F>(binding: &Binding, resolve: F) -> Vec<Diagnostic>
where
    F: Fn(&str) -> Option<Arc<dyn Operator>>,
{
    let mut diagnostics = Vec::new();

    if let Some(ref steps) = binding.transform {
        for (i, step) in steps.iter().enumerate() {
            if resolve(&step.op).is_none() {
                diagnostics.push(Diagnostic {
                    code: DiagnosticCode::BindingOperatorNotFound,
                    level: DiagnosticLevel::Error,
                    message: format!("operator not registered: {}", step.op),
                    at: String::new(),
                    data: Some({
                        let mut map = std::collections::HashMap::new();
                        map.insert("index".to_string(), serde_json::json!(i));
                        map.insert("op".to_string(), serde_json::json!(&step.op));
                        map
                    }),
                });
            }
        }
    }

    diagnostics
}

/// Run each operator's argument validator when available.
pub fn validate_binding_operator_args(
    binding: &Binding,
    registry: &OperatorRegistry,
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    if let Some(ref steps) = binding.transform {
        for (i, step) in steps.iter().enumerate() {
            if let Some(op) = registry.get(&step.op) {
                let args_value = step.args.as_ref().map(|a| {
                    OpValue::from(serde_json::to_value(a).unwrap_or(serde_json::Value::Null))
                });
                let diags = op.validate(args_value.as_ref());

                for mut d in diags {
                    // Add index and op to data
                    let data = d.data.get_or_insert_with(std::collections::HashMap::new);
                    data.insert("index".to_string(), serde_json::json!(i));
                    data.insert("op".to_string(), serde_json::json!(&step.op));
                    diagnostics.push(d);
                }
            }
        }
    }

    diagnostics
}

// ============================================================================
// Deep Validation
// ============================================================================

/// Full validation: shape -> operators -> operator args.
pub fn validate_binding_deep(
    value: &serde_json::Value,
    registry: &OperatorRegistry,
) -> DeepValidationResult {
    // Shape validation first
    let shape_result = validate_binding_shape(value);
    if !shape_result.ok || shape_result.binding.is_none() {
        return DeepValidationResult {
            ok: shape_result.ok,
            diagnostics: shape_result.diagnostics,
            binding: None,
        };
    }

    let binding = shape_result.binding.unwrap();

    // Operator existence validation
    let op_missing = validate_binding_operators(&binding, registry);

    // Operator args validation
    let op_args = validate_binding_operator_args(&binding, registry);

    // Combine all diagnostics
    let mut all_diagnostics = shape_result.diagnostics;
    all_diagnostics.extend(op_missing);
    all_diagnostics.extend(op_args);

    let has_errors = all_diagnostics
        .iter()
        .any(|d| d.level == DiagnosticLevel::Error);

    DeepValidationResult {
        ok: !has_errors,
        diagnostics: all_diagnostics,
        binding: if has_errors { None } else { Some(binding) },
    }
}

/// Full validation using a resolver function instead of registry.
pub fn validate_binding_deep_with_resolver<F>(
    value: &serde_json::Value,
    resolve: F,
) -> DeepValidationResult
where
    F: Fn(&str) -> Option<Arc<dyn Operator>>,
{
    // Shape validation first
    let shape_result = validate_binding_shape(value);
    if !shape_result.ok || shape_result.binding.is_none() {
        return DeepValidationResult {
            ok: shape_result.ok,
            diagnostics: shape_result.diagnostics,
            binding: None,
        };
    }

    let binding = shape_result.binding.unwrap();

    // Operator existence validation
    let op_missing = validate_binding_operators_with_resolver(&binding, &resolve);

    // Combine all diagnostics
    let mut all_diagnostics = shape_result.diagnostics;
    all_diagnostics.extend(op_missing);

    let has_errors = all_diagnostics
        .iter()
        .any(|d| d.level == DiagnosticLevel::Error);

    DeepValidationResult {
        ok: !has_errors,
        diagnostics: all_diagnostics,
        binding: if has_errors { None } else { Some(binding) },
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_binding() {
        let valid = serde_json::json!({
            "$kind": "binding",
            "select": { "from": "self" }
        });
        assert!(is_binding(&valid));

        let invalid = serde_json::json!({
            "kind": "other"
        });
        assert!(!is_binding(&invalid));

        let not_object = serde_json::json!("string");
        assert!(!is_binding(&not_object));
    }

    #[test]
    fn test_validate_shape_valid() {
        let binding = serde_json::json!({
            "$kind": "binding",
            "select": {
                "from": "dataSource",
                "key": "user",
                "path": "profile.name"
            },
            "transform": [
                { "op": "op:text.uppercase" }
            ],
            "default": "Unknown"
        });

        let result = validate_binding_shape(&binding);
        assert!(result.ok);
        assert!(result.binding.is_some());
    }

    #[test]
    fn test_validate_shape_missing_kind() {
        let binding = serde_json::json!({
            "select": { "from": "self" }
        });

        let result = validate_binding_shape(&binding);
        assert!(!result.ok);
        assert!(result
            .diagnostics
            .iter()
            .any(|d| d.code == DiagnosticCode::BindingInvalid));
    }

    #[test]
    fn test_validate_shape_invalid_select_from() {
        let binding = serde_json::json!({
            "$kind": "binding",
            "select": { "from": "invalid_source" }
        });

        let result = validate_binding_shape(&binding);
        assert!(!result.ok);
        assert!(result
            .diagnostics
            .iter()
            .any(|d| d.code == DiagnosticCode::BindingSelectInvalid));
    }

    #[test]
    fn test_validate_shape_unknown_fields() {
        let binding = serde_json::json!({
            "$kind": "binding",
            "select": { "from": "self" },
            "unknownField": true
        });

        let result = validate_binding_shape(&binding);
        // Should have a warning but still be valid
        assert!(result.ok);
        assert!(result.diagnostics.iter().any(|d| {
            d.code == DiagnosticCode::BindingUnknownField && d.level == DiagnosticLevel::Warn
        }));
    }

    #[test]
    fn test_validate_shape_literal_requires_value() {
        let binding = serde_json::json!({
            "$kind": "binding",
            "select": { "from": "literal" }
        });

        let result = validate_binding_shape(&binding);
        assert!(!result.ok);
        assert!(result.diagnostics.iter().any(|d| {
            d.code == DiagnosticCode::BindingSelectInvalid
                && d.message.contains("select.value required")
        }));
    }

    #[test]
    fn test_validate_shape_transform_invalid_op() {
        let binding = serde_json::json!({
            "$kind": "binding",
            "transform": [
                { "op": "" }
            ]
        });

        let result = validate_binding_shape(&binding);
        assert!(!result.ok);
        assert!(result
            .diagnostics
            .iter()
            .any(|d| d.code == DiagnosticCode::BindingTransformInvalid));
    }

    #[test]
    fn test_validate_operators_missing() {
        use super::super::operators::registry::OperatorRegistry;

        let binding = Binding::new()
            .add_transform(super::super::ast::TransformStep::new("op:unknown.operator"));

        let registry = OperatorRegistry::new();
        let diagnostics = validate_binding_operators(&binding, &registry);

        assert!(!diagnostics.is_empty());
        assert!(diagnostics
            .iter()
            .any(|d| d.code == DiagnosticCode::BindingOperatorNotFound));
    }

    #[test]
    fn test_validate_operators_found() {
        use super::super::operators::registry::{FnOperator, OperatorRegistry};

        let binding =
            Binding::new().add_transform(super::super::ast::TransformStep::new("op:core.identity"));

        let mut registry = OperatorRegistry::new();
        registry
            .register(FnOperator::new("op:core.identity", |input, _, _| {
                Ok(input.clone())
            }))
            .unwrap();

        let diagnostics = validate_binding_operators(&binding, &registry);
        assert!(diagnostics.is_empty());
    }
}
