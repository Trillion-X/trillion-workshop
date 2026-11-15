//! crates/composition-engine-core/src/binding/ast.rs
//!
//! Binding AST types for the Composition Engine.
//!
//! D.4.6 (L088): Pure AST types AND BindingEvaluationContext now live in
//! composition-ast (leaf crate). This module re-exports everything from there.
//!
//! The only addition: `scene_index_from_typed()` converts TypedNodeEntry
//! maps to serde_json::Value maps for the BindingEvaluationContext.
//!
//! ## Non-Negotiable Invariants
//!
//! 1. **Bindings are pure declarative data.** No functions, no closures, no host-specific constructs.
//! 2. **Keys and operator names are normalized and validated.** No dynamic evaluation or "any" escapes.
//! 3. **Diagnostics are structured, machine-readable, and stable.** No stringly-typed errors.
//! 4. **SelectSource::Routing is the ONLY way to query routing state.**
//! 5. **Nested bindings enable DRY patterns.** Resolve once in ambient, use as key via nested binding.

// Re-export ALL types from composition-ast (L088 SSOT — single definition)
pub use composition_ast::binding::ast::{
    is_binding, validate_operator_key, Binding, BindingErrorPayload, BindingEvaluationContext,
    BindingMeta, BindingResult, BindingSelect, Diagnostic, DiagnosticCode, DiagnosticLevel,
    JsonPointer, OperatorKey, Path, PathInput, PathSegment, Select, SelectKey, SelectSource,
    TransformStep, BINDING_KIND, OPERATOR_KEY_PATTERN,
};

use std::collections::HashMap;
use std::sync::Arc;

use crate::kernel::typed_index::TypedNodeEntry;

// ============================================================================
// TypedNodeEntry → Value scene index conversion
// ============================================================================

/// Convert a TypedNodeEntry scene index to a serde_json::Value scene index
/// for use with BindingEvaluationContext.
///
/// TypedNodeEntry provides O(1) typed lookups during compute(). The conversion
/// to Value happens once when building the BindingEvaluationContext, then the
/// evaluator uses O(1) HashMap lookups on the Value map.
pub fn scene_index_from_typed(
    typed_index: &HashMap<String, TypedNodeEntry>,
) -> Arc<HashMap<String, serde_json::Value>> {
    let value_map: HashMap<String, serde_json::Value> = typed_index
        .iter()
        .map(|(k, v)| (k.clone(), v.to_json_value()))
        .collect();
    Arc::new(value_map)
}

/// Extension trait for BindingEvaluationContext to accept TypedNodeEntry scene index.
pub trait BindingEvalContextExt {
    /// Set the scene index from a TypedNodeEntry map, converting to Value.
    fn with_typed_scene_index(self, index: Arc<HashMap<String, TypedNodeEntry>>) -> Self;
}

impl BindingEvalContextExt for BindingEvaluationContext {
    fn with_typed_scene_index(mut self, index: Arc<HashMap<String, TypedNodeEntry>>) -> Self {
        self.scene_index = Some(scene_index_from_typed(&index));
        self
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_binding_creation() {
        let binding = Binding::new()
            .with_select(BindingSelect {
                from: Some(SelectSource::DataSource),
                key: Some(SelectKey::static_key("user")),
                path: Some(PathInput::String("profile.name".to_string())),
                ..Default::default()
            })
            .with_transform(vec![TransformStep::new("op:text.uppercase")])
            .with_default(serde_json::json!("Unknown"));

        assert_eq!(binding.kind, "binding");
        assert!(binding.select.is_some());
        assert!(binding.transform.is_some());
        assert_eq!(binding.transform.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn test_is_binding() {
        let binding_json = serde_json::json!({
            "$kind": "binding",
            "select": { "from": "self" }
        });
        assert!(is_binding(&binding_json));

        let not_binding = serde_json::json!({
            "kind": "something_else"
        });
        assert!(!is_binding(&not_binding));

        let not_object = serde_json::json!("string");
        assert!(!is_binding(&not_object));
    }

    #[test]
    fn test_validate_operator_key() {
        assert!(validate_operator_key("op:core.math.add", "").is_none());
        assert!(validate_operator_key("op:text.format", "").is_none());
        assert!(validate_operator_key("op:a1", "").is_none());
        assert!(validate_operator_key("core.math.add", "").is_some());
        assert!(validate_operator_key("op:", "").is_some());
        assert!(validate_operator_key("op:UPPERCASE", "").is_some());
    }

    #[test]
    fn test_diagnostic_builder() {
        let diag = Diagnostic::error(
            DiagnosticCode::PathMissing,
            "Key 'name' not found",
            "/select/path",
        )
        .with_data("key", serde_json::json!("name"))
        .with_data("path", serde_json::json!(["user", "profile"]));

        assert_eq!(diag.code, DiagnosticCode::PathMissing);
        assert_eq!(diag.level, DiagnosticLevel::Error);
        assert!(diag.data.is_some());
        assert_eq!(diag.data.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn test_transform_step_builder() {
        let step = TransformStep::new("op:math.add")
            .with_arg("value", serde_json::json!(10))
            .with_arg("precision", serde_json::json!(2));

        assert_eq!(step.op, "op:math.add");
        assert!(step.args.is_some());
        assert_eq!(step.args.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn test_binding_result() {
        let result = BindingResult::ok(serde_json::json!("Hello"))
            .with_accessed_path("dataSource.user.name")
            .with_cacheable(true);

        assert_eq!(result.value, serde_json::json!("Hello"));
        assert_eq!(result.accessed_paths.len(), 1);
        assert!(result.cacheable);
    }

    #[test]
    fn test_select_source_serialization() {
        let select = BindingSelect {
            from: Some(SelectSource::DataSource),
            key: Some(SelectKey::static_key("user")),
            ..Default::default()
        };

        let json = serde_json::to_string(&select).unwrap();
        assert!(json.contains("dataSource"));
    }

    #[test]
    fn test_path_segment() {
        let key: PathSegment = "name".into();
        let index: PathSegment = 0usize.into();

        assert_eq!(key, PathSegment::Key("name".to_string()));
        assert_eq!(index, PathSegment::Index(0));
    }
}
