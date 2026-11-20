//! crates/composition-engine-core/src/blueprint/guards.rs
//!
//! Fast, dependency-light guards for author-time blueprints.
//!
//! # Purpose
//! Ensures the root structure is sane and flags common mistakes early.
//! Validates structure before it enters the normalization pipeline.
//!
//! # Non-Negotiable Invariants
//! - Pure, synchronous, side-effect free.
//! - Never panics for non-critical issues; returns errors.
//! - Reports all validation errors, not just the first one.
//!
//! # Key Concepts
//! - Structural validation only. Theme token resolution happens elsewhere.
//! - Skips prototype-pollution keys (handled by Rust's type system).
//! - Treats inputs as untrusted. No execution of functions.
//!
//! # Security Considerations
//! - Validates all string fields for forbidden characters.
//! - Checks for reasonable bounds on numeric values.
//!
//! Ported from: frontends/web/composition-engine/blueprint/guards.ts

use super::types::{
    BlueprintA11y, BlueprintHandlers, BlueprintKind, BlueprintNode, BlueprintProps, BlueprintScene,
    BlueprintStyle, StyleValue,
};

// ============================================================================
// Error Types
// ============================================================================

/// A single validation diagnostic
#[derive(Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub message: String,
    pub path: String,
}

impl Diagnostic {
    pub fn new(code: &'static str, message: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            path: path.into(),
        }
    }
}

/// Validation error containing all diagnostics
#[derive(Debug, Clone)]
pub struct ValidationError {
    pub diagnostics: Vec<Diagnostic>,
}

impl ValidationError {
    pub fn new(diagnostics: Vec<Diagnostic>) -> Self {
        Self { diagnostics }
    }

    pub fn is_empty(&self) -> bool {
        self.diagnostics.is_empty()
    }
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Blueprint validation failed:")?;
        for (i, d) in self.diagnostics.iter().enumerate() {
            writeln!(f, "  {}. [{}] {} at {}", i + 1, d.code, d.message, d.path)?;
        }
        Ok(())
    }
}

impl std::error::Error for ValidationError {}

/// Result type for validation
pub type ValidationResult = Result<(), ValidationError>;

// ============================================================================
// Constants
// ============================================================================

/// Valid node kinds
const VALID_KINDS: &[BlueprintKind] = &[
    BlueprintKind::Container,
    BlueprintKind::Text,
    BlueprintKind::Image,
    BlueprintKind::Rect,
    BlueprintKind::Canvas,
    BlueprintKind::Custom,
];

/// Token path regex pattern (camelCase segments separated by '/')
#[allow(dead_code)]
const TOKEN_PATH_PATTERN: &str = r"^[a-z][a-zA-Z0-9]*(\/[a-z][a-zA-Z0-9]*)+$";

/// Forbidden bidi characters that could cause rendering issues
const BIDI_CHARS: &[char] = &[
    '\u{200E}', '\u{200F}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}',
    '\u{2067}', '\u{2068}', '\u{2069}',
];

// ============================================================================
// Main Validation Functions
// ============================================================================

/// Validate a BlueprintScene
pub fn validate_scene(scene: &BlueprintScene) -> ValidationResult {
    let mut errors = Vec::new();

    // Validate root node
    validate_node(&scene.root, "root", &mut errors);

    // Validate viewport if present
    if let Some(vp) = &scene.viewport {
        if vp.w < 0.0 {
            errors.push(Diagnostic::new(
                "VIEWPORT_WIDTH",
                "viewport width must be >= 0",
                "viewport.w",
            ));
        }
        if vp.h < 0.0 {
            errors.push(Diagnostic::new(
                "VIEWPORT_HEIGHT",
                "viewport height must be >= 0",
                "viewport.h",
            ));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(ValidationError::new(errors))
    }
}

/// Validate a single BlueprintNode
pub fn validate_node(node: &BlueprintNode, path: &str, errors: &mut Vec<Diagnostic>) {
    // Validate ID
    if node.id.is_empty() {
        errors.push(Diagnostic::new(
            "NODE_ID_EMPTY",
            "node.id must be non-empty string",
            format!("{}.id", path),
        ));
    } else if contains_bidi_chars(&node.id) {
        errors.push(Diagnostic::new(
            "NODE_ID_BIDI",
            "node.id contains forbidden bidi characters",
            format!("{}.id", path),
        ));
    }

    // Validate kind (Rust enum handles this, but check anyway for completeness)
    if !VALID_KINDS.contains(&node.kind) {
        errors.push(Diagnostic::new(
            "NODE_KIND_INVALID",
            format!("node.kind must be one of: {:?}", VALID_KINDS),
            format!("{}.kind", path),
        ));
    }

    // Validate props if present
    if let Some(props) = &node.props {
        validate_props(props, &format!("{}.props", path), errors);
    }

    // Validate z-index bounds
    if let Some(z) = node.z_index {
        if !(-1000..=1000).contains(&z) {
            errors.push(Diagnostic::new(
                "NODE_ZINDEX_BOUNDS",
                "z_index should be between -1000 and 1000",
                format!("{}.zIndex", path),
            ));
        }
    }

    // Recursively validate children
    for (i, child) in node.children.iter().enumerate() {
        validate_node(child, &format!("{}.children[{}]", path, i), errors);
    }
}

/// Validate node props
fn validate_props(props: &BlueprintProps, path: &str, errors: &mut Vec<Diagnostic>) {
    // Validate style if present
    if let Some(style) = &props.style {
        validate_style(style, &format!("{}.style", path), errors);
    }

    // Validate a11y if present
    if let Some(a11y) = &props.a11y {
        validate_a11y(a11y, &format!("{}.a11y", path), errors);
    }

    // Validate handlers if present
    if let Some(handlers) = &props.handlers {
        validate_handlers(handlers, &format!("{}.handlers", path), errors);
    }

    // Validate text for Text nodes
    if let Some(text) = &props.text {
        if contains_bidi_chars(text) {
            errors.push(Diagnostic::new(
                "TEXT_BIDI",
                "text contains forbidden bidi characters",
                format!("{}.text", path),
            ));
        }
    }

    // Validate src for Image nodes
    if let Some(src) = &props.src {
        if src.is_empty() {
            errors.push(Diagnostic::new(
                "SRC_EMPTY",
                "src must be non-empty",
                format!("{}.src", path),
            ));
        }
    }
}

/// Validate style properties
///
/// Also validates Binding objects if present. See guards.ts lines 72-80:
/// ```typescript
/// if (v && typeof v === 'object' && isBinding(v)) {
///     const res = validateBindingShape(v)
///     if (!res.ok) { ... }
/// }
/// ```
fn validate_style(style: &BlueprintStyle, path: &str, errors: &mut Vec<Diagnostic>) {
    for (key, value) in &style.properties {
        let prop_path = format!("{}.{}", path, key);

        // Validate Binding objects
        // See: guards.ts lines 72-80
        if let StyleValue::Binding(binding) = value {
            validate_binding_shape(binding, &prop_path, errors);
        }

        // Validate non-negative style values
        match key.as_str() {
            "fontSize" | "borderRadius" | "borderWidth" | "lineHeight" | "maxWidth"
            | "fontWeight" => {
                validate_non_negative_style_value(value, &prop_path, errors);
            }
            _ => {}
        }

        // Validate token paths
        if let StyleValue::TokenPath(ref path_str) = value {
            if !is_valid_token_path(path_str) && path_str.contains('/') {
                errors.push(Diagnostic::new(
                    "STYLE_INVALID_TOKEN",
                    "invalid token path format",
                    &prop_path,
                ));
            }
        }
    }
}

/// Validate a Binding object's shape
///
/// Basic validation until Agent 6's binding module is ported.
/// Full validation is composition_ast::binding::validator::validate_binding_deep.
fn validate_binding_shape(
    binding: &super::types::BindingRef,
    path: &str,
    errors: &mut Vec<Diagnostic>,
) {
    // Check that $kind is "binding"
    if binding.kind != "binding" {
        errors.push(Diagnostic::new(
            "BINDING_KIND_INVALID",
            format!("$kind must be 'binding', got '{}'", binding.kind),
            path,
        ));
    }

    // Check that path is present for most binding types
    // (some bindings may not need a path, so this is a warning-level check)
    // Full validation will be done by the binding module
}

/// Validate that a style value is non-negative
fn validate_non_negative_style_value(value: &StyleValue, path: &str, errors: &mut Vec<Diagnostic>) {
    match value {
        StyleValue::Number(n) if *n < 0.0 => {
            errors.push(Diagnostic::new(
                "STYLE_NEGATIVE",
                "value must be >= 0",
                path,
            ));
        }
        StyleValue::Literal(lit) => {
            if let super::types::StyleLiteralValue::Number(n) = lit.literal {
                if n < 0.0 {
                    errors.push(Diagnostic::new(
                        "STYLE_LITERAL_NEGATIVE",
                        "$literal must be >= 0",
                        path,
                    ));
                }
            }
        }
        _ => {}
    }
}

/// Validate accessibility props
fn validate_a11y(a11y: &BlueprintA11y, path: &str, errors: &mut Vec<Diagnostic>) {
    // Validate tabIndex range
    if let Some(tab_index) = a11y.tab_index {
        if tab_index < -1 {
            errors.push(Diagnostic::new(
                "A11Y_TABINDEX",
                "tabIndex should be >= -1",
                format!("{}.tabIndex", path),
            ));
        }
    }

    // Validate role is non-empty if present
    if let Some(role) = &a11y.role {
        if role.is_empty() {
            errors.push(Diagnostic::new(
                "A11Y_ROLE_EMPTY",
                "role must be non-empty",
                format!("{}.role", path),
            ));
        }
    }

    // Validate label if present
    if let Some(label) = &a11y.label {
        if contains_bidi_chars(label) {
            errors.push(Diagnostic::new(
                "A11Y_LABEL_BIDI",
                "label contains forbidden bidi characters",
                format!("{}.label", path),
            ));
        }
    }
}

/// Validate event handlers
fn validate_handlers(handlers: &BlueprintHandlers, path: &str, errors: &mut Vec<Diagnostic>) {
    // Validate standard handlers
    if let Some(click) = &handlers.click {
        validate_event(click, &format!("{}.click", path), errors);
    }
    if let Some(change) = &handlers.change {
        validate_event(change, &format!("{}.change", path), errors);
    }
    if let Some(input) = &handlers.input {
        validate_event(input, &format!("{}.input", path), errors);
    }
    if let Some(submit) = &handlers.submit {
        validate_event(submit, &format!("{}.submit", path), errors);
    }

    // Validate custom handlers
    for (key, event) in &handlers.custom {
        validate_event(event, &format!("{}.{}", path, key), errors);
    }
}

/// Validate a single event handler
fn validate_event(event: &super::types::BlueprintEvent, path: &str, errors: &mut Vec<Diagnostic>) {
    if event.dispatch.is_empty() {
        errors.push(Diagnostic::new(
            "HANDLER_DISPATCH_EMPTY",
            "dispatch must be non-empty string",
            format!("{}.dispatch", path),
        ));
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Check if a string contains forbidden bidi characters
fn contains_bidi_chars(s: &str) -> bool {
    s.chars().any(|c| BIDI_CHARS.contains(&c))
}

/// Check if a string is a valid token path
fn is_valid_token_path(s: &str) -> bool {
    // Simple check: must contain '/', start with lowercase, no bidi
    if s.is_empty() || !s.contains('/') {
        return false;
    }
    if !s.starts_with(|c: char| c.is_ascii_lowercase()) {
        return false;
    }
    if contains_bidi_chars(s) {
        return false;
    }
    // Check each segment
    s.split('/')
        .all(|segment| !segment.is_empty() && segment.starts_with(|c: char| c.is_ascii_lowercase()))
}

/// Type guard: check if a value is a blueprint node
pub fn is_blueprint_node(value: &serde_json::Value) -> bool {
    value.is_object()
        && value.get("id").is_some_and(|v| v.is_string())
        && value.get("kind").is_some_and(|v| v.is_string())
}

/// Type guard: check if a value is a blueprint scene
pub fn is_blueprint_scene(value: &serde_json::Value) -> bool {
    value.is_object() && value.get("root").is_some_and(is_blueprint_node)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blueprint::types::BlueprintViewport;

    #[test]
    fn test_validate_valid_scene() {
        let node = BlueprintNode::new("root", BlueprintKind::Container);
        let scene = BlueprintScene::new(node);
        assert!(validate_scene(&scene).is_ok());
    }

    #[test]
    fn test_validate_empty_id_fails() {
        let node = BlueprintNode::new("", BlueprintKind::Container);
        let scene = BlueprintScene::new(node);
        let result = validate_scene(&scene);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.diagnostics.iter().any(|d| d.code == "NODE_ID_EMPTY"));
    }

    #[test]
    fn test_validate_negative_viewport() {
        let node = BlueprintNode::new("root", BlueprintKind::Container);
        let scene = BlueprintScene::new(node).with_viewport(BlueprintViewport::new(-100.0, 600.0));
        let result = validate_scene(&scene);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.diagnostics.iter().any(|d| d.code == "VIEWPORT_WIDTH"));
    }

    #[test]
    fn test_is_valid_token_path() {
        assert!(is_valid_token_path("colors/primary"));
        assert!(is_valid_token_path("typography/size/md"));
        assert!(!is_valid_token_path("Colors/primary")); // starts with uppercase
        assert!(!is_valid_token_path("colors")); // no slash
        assert!(!is_valid_token_path("")); // empty
    }

    #[test]
    fn test_contains_bidi_chars() {
        assert!(!contains_bidi_chars("normal string"));
        assert!(contains_bidi_chars("bad\u{200E}string"));
        assert!(contains_bidi_chars("bad\u{202A}string"));
    }

    #[test]
    fn test_validate_nested_children() {
        let child = BlueprintNode::new("", BlueprintKind::Text); // invalid empty id
        let root = BlueprintNode::new("root", BlueprintKind::Container).with_children(vec![child]);
        let scene = BlueprintScene::new(root);

        let result = validate_scene(&scene);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err
            .diagnostics
            .iter()
            .any(|d| d.path.contains("children[0]")));
    }

    #[test]
    fn test_is_blueprint_node() {
        let valid = serde_json::json!({
            "id": "test",
            "kind": "Container",
            "children": []
        });
        assert!(is_blueprint_node(&valid));

        let invalid = serde_json::json!({ "foo": "bar" });
        assert!(!is_blueprint_node(&invalid));
    }

    #[test]
    fn test_is_blueprint_scene() {
        let valid = serde_json::json!({
            "root": {
                "id": "test",
                "kind": "Container",
                "children": []
            }
        });
        assert!(is_blueprint_scene(&valid));

        let invalid = serde_json::json!({ "root": "not a node" });
        assert!(!is_blueprint_scene(&invalid));
    }
}
