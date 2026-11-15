//! crates/composition-engine-core/src/blueprint/normalize.rs
//!
//! Normalize arbitrary author input into the canonical SceneInit form.
//!
//! # Purpose
//! Transform untrusted BlueprintNode trees into validated, kernel-ready
//! CanonicalNode/SceneInit structures. This is the only sanctioned entry
//! into the kernel pipeline.
//!
//! # Non-Negotiable Invariants
//! - Pure, deterministic, no side effects.
//! - No mutation of caller-provided objects (Rust ownership handles this).
//! - Validates structure before returning.
//!
//! # Key Concepts
//! - Accepts either a BlueprintScene or a BlueprintNode.
//! - Converts BlueprintNode → CanonicalNode (different type systems).
//! - Style resolution happens separately in resolver.rs.
//!
//! # Security Considerations
//! - Rejects non-object roots.
//! - Creates new objects, never returning references to untrusted input.
//!
//! Ported from: frontends/web/composition-engine/blueprint/normalize.ts

use super::guards::validate_scene;
use super::types::{BlueprintKind, BlueprintNode, BlueprintProps, BlueprintScene};
use crate::kernel::types::{
    A11yProps, CanonicalNode, EventHandlers, NodeKind, NodeProps, Role, SceneInit, Size,
};

/// Normalization error
#[derive(Debug, Clone)]
pub struct NormalizeError {
    pub message: String,
    pub path: String,
}

impl std::fmt::Display for NormalizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at {}", self.message, self.path)
    }
}

impl std::error::Error for NormalizeError {}

/// Result type for normalization
pub type NormalizeResult<T> = Result<T, NormalizeError>;

/// Normalize a BlueprintScene into a kernel-ready SceneInit
///
/// # Arguments
/// * `scene` - The blueprint scene to normalize
///
/// # Returns
/// A validated, kernel-ready SceneInit
pub fn normalize_scene(scene: &BlueprintScene) -> NormalizeResult<SceneInit> {
    // Validate first
    validate_scene(scene).map_err(|e| NormalizeError {
        message: e.to_string(),
        path: "root".to_string(),
    })?;

    // Convert root node
    let root = normalize_node(&scene.root, "root")?;

    // Convert viewport if present
    let viewport = scene.viewport.map(|v| Size::new(v.w, v.h));

    Ok(SceneInit { root, viewport })
}

/// Normalize a single BlueprintNode into a SceneInit
///
/// Convenience function when only a root node is provided
pub fn normalize_node_to_scene(node: &BlueprintNode) -> NormalizeResult<SceneInit> {
    let scene = BlueprintScene::new(node.clone());
    normalize_scene(&scene)
}

/// Convert a BlueprintNode tree into a CanonicalNode tree
fn normalize_node(node: &BlueprintNode, path: &str) -> NormalizeResult<CanonicalNode> {
    // Validate node ID
    if node.id.is_empty() {
        return Err(NormalizeError {
            message: "node.id must be non-empty string".to_string(),
            path: path.to_string(),
        });
    }

    // Convert kind
    let kind = convert_kind(node.kind);

    // Convert props
    let props = node.props.as_ref().map(convert_props).unwrap_or_default();

    // Recursively convert children
    let children = node
        .children
        .iter()
        .enumerate()
        .map(|(i, child)| {
            let child_path = format!("{}.children[{}]", path, i);
            normalize_node(child, &child_path)
        })
        .collect::<NormalizeResult<Vec<_>>>()?;

    Ok(CanonicalNode {
        id: node.id.clone(),
        kind,
        props,
        children: if children.is_empty() {
            None
        } else {
            Some(children)
        },
    })
}

/// Convert BlueprintKind to kernel NodeKind
fn convert_kind(kind: BlueprintKind) -> NodeKind {
    match kind {
        BlueprintKind::Container => NodeKind::Container,
        BlueprintKind::Text => NodeKind::Text,
        BlueprintKind::Image => NodeKind::Image,
        BlueprintKind::Rect => NodeKind::Rect,
        BlueprintKind::Canvas => NodeKind::Canvas,
        BlueprintKind::Component => NodeKind::Component,
        BlueprintKind::Custom => NodeKind::Custom,
    }
}

/// Convert BlueprintProps to kernel NodeProps
///
/// Note: Style resolution happens in resolver.rs, not here.
/// This function only copies non-style props.
fn convert_props(props: &BlueprintProps) -> NodeProps {
    let mut extra = props.extra.clone();
    NodeProps {
        // Style will be resolved separately by resolver.rs
        // For now, just pass None (unresolved)
        style: None,
        text: props.text.clone(),
        src: props.src.clone(),
        handlers: props.handlers.as_ref().map(convert_handlers),
        a11y: props.a11y.as_ref().map(convert_a11y),
        custom: extra.remove("custom"),
        component_id: extra.remove("component_id")
            .and_then(|v| v.as_str().map(String::from)),
        bundle: extra.remove("bundle")
            .and_then(|v| v.as_str().map(String::from)),
        integrity_hash: extra.remove("integrity_hash")
            .and_then(|v| v.as_str().map(String::from)),
        instance_props: extra.remove("instance_props"),
        artifact_dependencies: extra.remove("artifact_dependencies").and_then(
            |value| serde_json::from_value::<std::collections::HashMap<String, String>>(value).ok(),
        ),
        things_to_put_on_screen: extra.remove("things_to_put_on_screen")
            .and_then(|value| {
                value
                    .as_array()
                    .map(|values| values.iter().cloned().collect())
            }),
        extra: extra.into_iter().collect(),
    }
}

/// Convert blueprint handlers to kernel handlers
///
/// Note: Action dispatch is no longer supported in composition-engine.
/// Action dispatch should go through the interaction-engine's trigger system.
/// Only FSM dispatch handlers are supported.
fn convert_handlers(_handlers: &super::types::BlueprintHandlers) -> EventHandlers {
    // Action dispatch handlers are no longer supported in composition-engine.
    // The trigger system in interaction-engine should be used instead.
    // Return empty handlers for now.
    EventHandlers {
        click: None,
        pointerdown: None,
        pointerup: None,
        pointermove: None,
        keydown: None,
        keyup: None,
    }
}

/// Convert blueprint a11y to kernel a11y
fn convert_a11y(a11y: &super::types::BlueprintA11y) -> A11yProps {
    A11yProps {
        role: a11y.role.as_ref().and_then(|r| parse_role(r)),
        label: a11y.label.clone(),
        tab_index: a11y.tab_index,
        props: if a11y.aria.is_empty() {
            None
        } else {
            Some(a11y.aria.clone())
        },
        states: None,
    }
}

/// Parse a role string into a Role enum
fn parse_role(role: &str) -> Option<Role> {
    match role.to_lowercase().as_str() {
        "button" => Some(Role::Button),
        "checkbox" => Some(Role::Checkbox),
        "radio" => Some(Role::Radio),
        "slider" => Some(Role::Slider),
        "menu" => Some(Role::Menu),
        "menuitem" => Some(Role::Menuitem),
        "dialog" => Some(Role::Dialog),
        "textbox" => Some(Role::Textbox),
        "link" => Some(Role::Link),
        "listbox" => Some(Role::Listbox),
        "option" => Some(Role::Option),
        "switch" => Some(Role::Switch),
        "img" => Some(Role::Img),
        "heading" => Some(Role::Heading),
        "region" => Some(Role::Region),
        _ => None,
    }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/// Quick normalization from JSON string
pub fn normalize_from_json(json: &str) -> NormalizeResult<SceneInit> {
    let scene: BlueprintScene = serde_json::from_str(json).map_err(|e| NormalizeError {
        message: format!("JSON parse error: {}", e),
        path: "".to_string(),
    })?;
    normalize_scene(&scene)
}

/// Quick normalization from JSON Value
pub fn normalize_from_value(value: &serde_json::Value) -> NormalizeResult<SceneInit> {
    let scene: BlueprintScene =
        serde_json::from_value(value.clone()).map_err(|e| NormalizeError {
            message: format!("JSON conversion error: {}", e),
            path: "".to_string(),
        })?;
    normalize_scene(&scene)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authored_properties_survive_blueprint_normalization() {
        let props: BlueprintProps = serde_json::from_value(serde_json::json!({
            "text": "Child", "indent_level": 2, "caller_metadata": {"nested": [true, null]},
            "component_id": "caller-component", "instance_props": {"colour": "blue"}
        })).unwrap();
        let encoded = serde_json::to_value(convert_props(&props)).unwrap();
        assert_eq!(encoded["indent_level"], serde_json::json!(2));
        assert_eq!(encoded["caller_metadata"], serde_json::json!({"nested": [true, null]}));
        assert_eq!(encoded["component_id"], serde_json::json!("caller-component"));
        assert_eq!(encoded["instance_props"], serde_json::json!({"colour": "blue"}));
        let converted = convert_props(&props);
        assert!(!converted.extra.contains_key("component_id"));
        assert!(!converted.extra.contains_key("instance_props"));
    }

    #[test]
    fn test_normalize_simple_scene() {
        let node = BlueprintNode::new("root", BlueprintKind::Container);
        let scene = BlueprintScene::new(node);

        let result = normalize_scene(&scene).unwrap();
        assert_eq!(result.root.id, "root");
        assert_eq!(result.root.kind, NodeKind::Container);
    }

    #[test]
    fn test_normalize_with_children() {
        let child = BlueprintNode::new("child", BlueprintKind::Text);
        let root = BlueprintNode::new("root", BlueprintKind::Container).with_children(vec![child]);
        let scene = BlueprintScene::new(root);

        let result = normalize_scene(&scene).unwrap();
        assert!(result.root.children.is_some());
        let children = result.root.children.as_ref().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].id, "child");
    }

    #[test]
    fn test_normalize_with_viewport() {
        let node = BlueprintNode::new("root", BlueprintKind::Container);
        let scene = BlueprintScene::new(node)
            .with_viewport(super::super::types::BlueprintViewport::new(800.0, 600.0));

        let result = normalize_scene(&scene).unwrap();
        assert!(result.viewport.is_some());
        let viewport = result.viewport.unwrap();
        assert_eq!(viewport.w, 800.0);
        assert_eq!(viewport.h, 600.0);
    }

    #[test]
    fn test_normalize_empty_id_fails() {
        let node = BlueprintNode::new("", BlueprintKind::Container);
        let scene = BlueprintScene::new(node);

        let result = normalize_scene(&scene);
        assert!(result.is_err());
    }

    #[test]
    fn test_normalize_kind_conversion() {
        assert_eq!(convert_kind(BlueprintKind::Container), NodeKind::Container);
        assert_eq!(convert_kind(BlueprintKind::Text), NodeKind::Text);
        assert_eq!(convert_kind(BlueprintKind::Image), NodeKind::Image);
        assert_eq!(convert_kind(BlueprintKind::Rect), NodeKind::Rect);
        assert_eq!(convert_kind(BlueprintKind::Canvas), NodeKind::Canvas);
        assert_eq!(convert_kind(BlueprintKind::Component), NodeKind::Component);
        assert_eq!(convert_kind(BlueprintKind::Custom), NodeKind::Custom);
    }

    #[test]
    fn test_parse_role() {
        assert_eq!(parse_role("button"), Some(Role::Button));
        assert_eq!(parse_role("BUTTON"), Some(Role::Button)); // case insensitive
        assert_eq!(parse_role("textbox"), Some(Role::Textbox));
        assert_eq!(parse_role("unknown"), None);
    }

    #[test]
    fn test_normalize_from_json() {
        let json = r#"{"root":{"id":"test","kind":"Container","children":[]}}"#;
        let result = normalize_from_json(json).unwrap();
        assert_eq!(result.root.id, "test");
    }
}
