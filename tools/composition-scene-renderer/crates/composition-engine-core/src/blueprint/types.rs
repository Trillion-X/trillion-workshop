//! crates/composition-engine-core/src/blueprint/types.rs
//!
//! Blueprint Types — Untrusted authoring model for UI scenes.
//!
//! # Purpose
//! - Define the canonical, framework-agnostic types for author-time blueprints.
//! - Blueprints may contain token references and audited literals (StyleValue).
//! - A host-side resolver transforms BlueprintNode → SceneNode (resolved magnitudes).
//!
//! # Non-Negotiable Invariants
//! - This layer is untrusted. Never pass it into the kernel.
//! - All style values are StyleValue (TokenPath | TokenRef | StyleLiteral).
//! - IDs are stable strings. Children are ordered arrays.
//! - No framework imports. Pure Rust only.
//!
//! # Key Concepts
//! - BlueprintStyle: a string-keyed bag of StyleValue entries.
//! - Layout: authoring-time layout intent; kernel consumes the resolved result.
//! - Strict decoupling: resolution lives in host; kernel sees ResolvedStyle only.
//!
//! # Security Considerations
//! - Do not execute user code embedded in blueprints.
//! - Do not trust string contents. Validate with guards.
//!
//! Ported from: frontends/web/composition-engine/blueprint/types.ts

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// Style Value Types (untrusted, author-time)
// ============================================================================

/// Token reference: { $token: "path/to/token" }
///
/// NOTE: Uses `$token` (not `$ref`) to clearly differentiate theme token
/// references from binding dynamic keys.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenRef {
    #[serde(rename = "$token")]
    pub path: String,
}

/// Style literal escape hatch with audit trail
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StyleLiteral {
    #[serde(rename = "$literal")]
    pub literal: StyleLiteralValue,
    #[serde(rename = "$reason", skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Values allowed in a style literal
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StyleLiteralValue {
    Number(f64),
    String(String),
}

/// Binding object placeholder — deferred to compute-phase evaluation
///
/// Bindings have the shape: { $kind: 'binding', path: '...', ... }
/// They are validated by the binding module (Agent 6) and resolved at compute time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BindingRef {
    #[serde(rename = "$kind")]
    pub kind: String, // Always "binding"
    /// The binding path (e.g., "entity.name")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Additional binding configuration
    #[serde(flatten)]
    pub config: HashMap<String, serde_json::Value>,
}

impl BindingRef {
    /// Check if this is a valid binding object
    pub fn is_valid(&self) -> bool {
        self.kind == "binding"
    }
}

/// StyleValue — untrusted value in blueprint style bag
/// Can be: TokenPath (string), TokenRef ({ $ref }), StyleLiteral ({ $literal }),
/// Binding ({ $kind: 'binding' }), or raw number
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StyleValue {
    /// Raw numeric value (e.g., 16.0 for fontSize)
    Number(f64),
    /// Binding reference (deferred to compute-phase)
    Binding(BindingRef),
    /// Token reference object
    Ref(TokenRef),
    /// Literal value with audit trail
    Literal(StyleLiteral),
    /// Token path string (e.g., "colors/surface/primary")
    TokenPath(String),
}

impl StyleValue {
    /// Check if this is a token path (contains "/" and starts with lowercase)
    pub fn is_token_path(&self) -> bool {
        match self {
            StyleValue::TokenPath(s) => {
                s.contains('/') && s.starts_with(|c: char| c.is_lowercase())
            }
            _ => false,
        }
    }

    /// Check if this is a binding reference
    pub fn is_binding(&self) -> bool {
        matches!(self, StyleValue::Binding(_))
    }
}

// ============================================================================
// Geometry Types (authoring-time)
// ============================================================================

/// Authoring-time Insets (padding/margin)
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct BlueprintInsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl BlueprintInsets {
    pub const ZERO: BlueprintInsets = BlueprintInsets {
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
        left: 0.0,
    };

    pub const fn new(top: f64, right: f64, bottom: f64, left: f64) -> Self {
        Self {
            top,
            right,
            bottom,
            left,
        }
    }

    pub const fn uniform(value: f64) -> Self {
        Self {
            top: value,
            right: value,
            bottom: value,
            left: value,
        }
    }
}

/// Authoring-time Rect (geometry hint)
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct BlueprintRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BlueprintRect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

// ============================================================================
// Layout Types (authoring-time intent)
// ============================================================================

/// Layout axis for flow/split modes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BlueprintAxis {
    #[default]
    X,
    Y,
}

/// Split part specification
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct BlueprintSplitPart {
    /// Fixed pixel size
    #[serde(skip_serializing_if = "Option::is_none")]
    pub px: Option<f64>,
    /// Fractional size (0.0 to 1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
}

/// Authoring-time layout intent
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum BlueprintLayout {
    /// Absolute positioning
    Absolute {
        #[serde(skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        width: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        height: Option<f64>,
    },
    /// Flow layout (flex-like)
    Flow {
        axis: BlueprintAxis,
        #[serde(skip_serializing_if = "Option::is_none")]
        gap: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        padding: Option<BlueprintInsets>,
    },
    /// Split layout (fixed proportions)
    Split {
        axis: BlueprintAxis,
        #[serde(skip_serializing_if = "Option::is_none")]
        gap: Option<f64>,
        parts: Vec<BlueprintSplitPart>,
    },
}

impl Default for BlueprintLayout {
    fn default() -> Self {
        BlueprintLayout::Flow {
            axis: BlueprintAxis::Y,
            gap: None,
            padding: None,
        }
    }
}

// ============================================================================
// Node Types
// ============================================================================

/// Allowed node kinds at authoring time
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum BlueprintKind {
    #[default]
    Container,
    Text,
    Image,
    Rect,
    Canvas,
    Component,
    Custom,
}

impl BlueprintKind {
    /// Convert to kernel NodeKind
    pub fn to_node_kind(&self) -> crate::kernel::types::NodeKind {
        match self {
            BlueprintKind::Container => crate::kernel::types::NodeKind::Container,
            BlueprintKind::Text => crate::kernel::types::NodeKind::Text,
            BlueprintKind::Image => crate::kernel::types::NodeKind::Image,
            BlueprintKind::Rect => crate::kernel::types::NodeKind::Rect,
            BlueprintKind::Canvas => crate::kernel::types::NodeKind::Canvas,
            BlueprintKind::Component => crate::kernel::types::NodeKind::Component,
            BlueprintKind::Custom => crate::kernel::types::NodeKind::Custom,
        }
    }
}

/// BlueprintStyle — untrusted style bag
/// Each property value is a StyleValue
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct BlueprintStyle {
    #[serde(flatten)]
    pub properties: HashMap<String, StyleValue>,
}

impl BlueprintStyle {
    pub fn new() -> Self {
        Self {
            properties: HashMap::new(),
        }
    }

    pub fn get(&self, key: &str) -> Option<&StyleValue> {
        self.properties.get(key)
    }

    pub fn insert(&mut self, key: impl Into<String>, value: StyleValue) {
        self.properties.insert(key.into(), value);
    }
}

/// Authoring-time accessibility props
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct BlueprintA11y {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(rename = "tabIndex", skip_serializing_if = "Option::is_none")]
    pub tab_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Additional ARIA-* props
    #[serde(flatten)]
    pub aria: HashMap<String, serde_json::Value>,
}

/// Authoring-time event descriptor
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintEvent {
    pub dispatch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<HashMap<String, serde_json::Value>>,
}

/// Authoring-time handler bag
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct BlueprintHandlers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click: Option<BlueprintEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<BlueprintEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<BlueprintEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submit: Option<BlueprintEvent>,
    /// Custom handlers
    #[serde(flatten)]
    pub custom: HashMap<String, BlueprintEvent>,
}

/// Blueprint node props
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct BlueprintProps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<BlueprintStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub a11y: Option<BlueprintA11y>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handlers: Option<BlueprintHandlers>,
    /// Text content for Text nodes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Source URL for Image nodes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    /// Authoring-time geometry hints
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame: Option<BlueprintRect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inset: Option<BlueprintInsets>,
    /// Authoring-time layout intent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<BlueprintLayout>,
    /// Extra props for adapters
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Canonical authoring-time node. Never feed into the kernel directly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintNode {
    pub id: String,
    pub kind: BlueprintKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props: Option<BlueprintProps>,
    #[serde(default)]
    pub children: Vec<BlueprintNode>,
    #[serde(rename = "zIndex", skip_serializing_if = "Option::is_none")]
    pub z_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(rename = "portalOwner", skip_serializing_if = "Option::is_none")]
    pub portal_owner: Option<String>,
}

impl BlueprintNode {
    /// Create a new blueprint node with minimal fields
    pub fn new(id: impl Into<String>, kind: BlueprintKind) -> Self {
        Self {
            id: id.into(),
            kind,
            props: None,
            children: Vec::new(),
            z_index: None,
            visible: None,
            portal_owner: None,
        }
    }

    /// Builder: add children
    pub fn with_children(mut self, children: Vec<BlueprintNode>) -> Self {
        self.children = children;
        self
    }

    /// Builder: add props
    pub fn with_props(mut self, props: BlueprintProps) -> Self {
        self.props = Some(props);
        self
    }

    /// Builder: set visibility
    pub fn with_visible(mut self, visible: bool) -> Self {
        self.visible = Some(visible);
        self
    }

    /// Builder: set z-index
    pub fn with_z_index(mut self, z_index: i32) -> Self {
        self.z_index = Some(z_index);
        self
    }
}

impl Default for BlueprintNode {
    fn default() -> Self {
        Self::new("", BlueprintKind::Container)
    }
}

// ============================================================================
// Scene Types
// ============================================================================

/// Blueprint viewport size
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct BlueprintViewport {
    pub w: f64,
    pub h: f64,
}

impl BlueprintViewport {
    pub const fn new(w: f64, h: f64) -> Self {
        Self { w, h }
    }
}

/// Top-level scene init payload (blueprint format)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintScene {
    pub root: BlueprintNode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewport: Option<BlueprintViewport>,
}

impl BlueprintScene {
    pub fn new(root: BlueprintNode) -> Self {
        Self {
            root,
            viewport: None,
        }
    }

    pub fn with_viewport(mut self, viewport: BlueprintViewport) -> Self {
        self.viewport = Some(viewport);
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
    fn test_blueprint_node_creation() {
        let node = BlueprintNode::new("test-node", BlueprintKind::Container);
        assert_eq!(node.id, "test-node");
        assert_eq!(node.kind, BlueprintKind::Container);
        assert!(node.children.is_empty());
    }

    #[test]
    fn test_blueprint_node_with_children() {
        let child1 = BlueprintNode::new("child1", BlueprintKind::Text);
        let child2 = BlueprintNode::new("child2", BlueprintKind::Image);
        let parent = BlueprintNode::new("parent", BlueprintKind::Container)
            .with_children(vec![child1, child2]);

        assert_eq!(parent.children.len(), 2);
        assert_eq!(parent.children[0].id, "child1");
        assert_eq!(parent.children[1].id, "child2");
    }

    #[test]
    fn test_style_value_is_token_path() {
        let path = StyleValue::TokenPath("colors/primary".to_string());
        assert!(path.is_token_path());

        let number = StyleValue::Number(16.0);
        assert!(!number.is_token_path());

        let ref_val = StyleValue::Ref(TokenRef {
            path: "colors/primary".to_string(),
        });
        assert!(!ref_val.is_token_path());
    }

    #[test]
    fn test_blueprint_layout_serialization() {
        let layout = BlueprintLayout::Flow {
            axis: BlueprintAxis::Y,
            gap: Some(8.0),
            padding: Some(BlueprintInsets::uniform(16.0)),
        };

        let json = serde_json::to_string(&layout).unwrap();
        assert!(json.contains("\"mode\":\"flow\""));

        let parsed: BlueprintLayout = serde_json::from_str(&json).unwrap();
        assert_eq!(layout, parsed);
    }

    #[test]
    fn test_blueprint_scene_serialization() {
        let scene = BlueprintScene::new(BlueprintNode::new("root", BlueprintKind::Container))
            .with_viewport(BlueprintViewport::new(800.0, 600.0));

        let json = serde_json::to_string(&scene).unwrap();
        let parsed: BlueprintScene = serde_json::from_str(&json).unwrap();

        assert_eq!(scene.root.id, parsed.root.id);
        assert_eq!(scene.viewport, parsed.viewport);
    }

    #[test]
    fn test_blueprint_kind_conversion() {
        assert_eq!(
            BlueprintKind::Container.to_node_kind(),
            crate::kernel::types::NodeKind::Container
        );
        assert_eq!(
            BlueprintKind::Text.to_node_kind(),
            crate::kernel::types::NodeKind::Text
        );
    }
}
