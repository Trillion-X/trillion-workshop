//! crates/composition-engine-core/src/blueprint/resolver.rs
//!
//! Blueprint → Scene resolver — host-layer style resolution.
//!
//! # Purpose
//! Convert a raw blueprint node tree containing TokenPath | TokenRef | StyleLiteral
//! into a kernel-ready SceneNode tree that contains only resolved magnitudes.
//!
//! # Non-Negotiable Invariants
//! - Kernel never sees TokenPath or {$ref} or {$literal}. Magnitudes only.
//! - No side effects. No global state. Deterministic for identical inputs.
//! - Never panics for expected misuse. Returns best-effort magnitudes or drops keys.
//!
//! # Key Concepts
//! - StyleValue ∈ { number | string | TokenRef | StyleLiteral } at the blueprint boundary.
//! - ResolvedStyle ∈ { number | string } only at the kernel boundary.
//! - Resolution delegated to a TokenResolver trait that hosts implement.
//!
//! # Security Considerations
//! - Ignores unknown keys and non-scalar results.
//! - Does not execute any user code.
//!
//! Ported from: frontends/web/composition-engine/blueprint/resolver.ts

use super::types::{
    BlueprintAxis, BlueprintLayout, BlueprintNode, BlueprintProps, BlueprintStyle,
    StyleLiteralValue, StyleValue,
};
use crate::kernel::types::{
    A11yProps, EventHandlers, FontWeight, LayoutAxis, LayoutConfig, LayoutMode, NodeKind,
    NodeProps, Padding, ResolvedStyle, SceneNode, Visibility,
};
use std::collections::HashMap;
use std::sync::Arc;

// ============================================================================
// Token Resolution Trait
// ============================================================================

/// Magnitude: resolved style value (number or string)
#[derive(Debug, Clone, PartialEq)]
pub enum Magnitude {
    Number(f64),
    String(String),
}

impl Magnitude {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Magnitude::Number(n) => Some(*n),
            Magnitude::String(s) => s.parse().ok(),
        }
    }

    pub fn as_string(&self) -> String {
        match self {
            Magnitude::Number(n) => n.to_string(),
            Magnitude::String(s) => s.clone(),
        }
    }
}

/// Result of token resolution
pub type ResolveResult = Result<Magnitude, ResolveError>;

/// Token resolution error
#[derive(Debug, Clone)]
pub struct ResolveError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Failed to resolve '{}': {}", self.path, self.message)
    }
}

impl std::error::Error for ResolveError {}

/// Token set: map of token paths to values
pub type TokenSet = HashMap<String, serde_json::Value>;

/// Trait for resolving tokens to magnitudes
///
/// Hosts implement this to provide their own token resolution logic.
pub trait TokenResolver {
    /// Resolve a token path to a magnitude
    fn resolve(&self, path: &str) -> ResolveResult;
}

/// Default token resolver that looks up paths in a HashMap
pub struct HashMapResolver {
    tokens: TokenSet,
}

impl HashMapResolver {
    pub fn new(tokens: TokenSet) -> Self {
        Self { tokens }
    }

    pub fn empty() -> Self {
        Self::new(HashMap::new())
    }
}

impl TokenResolver for HashMapResolver {
    fn resolve(&self, path: &str) -> ResolveResult {
        match self.tokens.get(path) {
            Some(value) => json_to_magnitude(value).ok_or_else(|| ResolveError {
                path: path.to_string(),
                message: "value is not a scalar".to_string(),
            }),
            None => Err(ResolveError {
                path: path.to_string(),
                message: "token not found".to_string(),
            }),
        }
    }
}

/// Convert a JSON value to a magnitude
fn json_to_magnitude(value: &serde_json::Value) -> Option<Magnitude> {
    match value {
        serde_json::Value::Number(n) => n.as_f64().map(Magnitude::Number),
        serde_json::Value::String(s) => Some(Magnitude::String(s.clone())),
        _ => None,
    }
}

// ============================================================================
// Style Resolution Functions
// ============================================================================

/// Resolve a single style value to a magnitude
///
/// - number → pass-through
/// - string (token path) → resolve via TokenResolver
/// - string (concrete value) → pass-through
/// - { $ref } → resolve via TokenResolver
/// - { $literal } → unwrap
/// - { $kind: 'binding' } → None (deferred to compute-phase)
fn resolve_style_value(value: &StyleValue, resolver: &dyn TokenResolver) -> Option<Magnitude> {
    match value {
        StyleValue::Number(n) => Some(Magnitude::Number(*n)),
        StyleValue::TokenPath(path) => {
            // Check if it's a token path (contains "/" and starts with lowercase)
            if path.contains('/') && path.starts_with(|c: char| c.is_ascii_lowercase()) {
                // Try to resolve, fall back to string if resolution fails
                match resolver.resolve(path) {
                    Ok(mag) => Some(mag),
                    Err(_) => Some(Magnitude::String(path.clone())),
                }
            } else {
                // Concrete string value (e.g., "oklch(...)" or "auto")
                Some(Magnitude::String(path.clone()))
            }
        }
        StyleValue::Ref(token_ref) => resolver.resolve(&token_ref.path).ok(),
        StyleValue::Literal(lit) => match &lit.literal {
            StyleLiteralValue::Number(n) => Some(Magnitude::Number(*n)),
            StyleLiteralValue::String(s) => Some(Magnitude::String(s.clone())),
        },
        StyleValue::Binding(_) => {
            // Bindings are deferred to compute-phase evaluation
            // They will be resolved by the binding module, not here
            None
        }
    }
}

/// Resolve a BlueprintStyle into a ResolvedStyle
///
/// Binding objects ({ $kind: 'binding' }) are skipped here and deferred to
/// compute-phase evaluation. See: blueprint/resolver.ts line 107
pub fn resolve_style(style: &BlueprintStyle, resolver: &dyn TokenResolver) -> ResolvedStyle {
    let mut resolved = ResolvedStyle::default();

    for (key, value) in &style.properties {
        // Skip Binding objects - they are deferred to compute-phase evaluation
        // See: blueprint/resolver.ts line 107:
        // if (v && typeof v === 'object' && (v as any).$kind === 'binding') continue;
        if value.is_binding() {
            continue;
        }

        if let Some(mag) = resolve_style_value(value, resolver) {
            apply_style_property(&mut resolved, key, &mag);
        }
    }

    resolved
}

/// Apply a resolved magnitude to a specific style property
fn apply_style_property(style: &mut ResolvedStyle, key: &str, mag: &Magnitude) {
    match key {
        "background" | "backgroundColor" => {
            style.background = Some(mag.as_string());
        }
        "color" => {
            style.color = Some(mag.as_string());
        }
        "borderRadius" => {
            if let Some(n) = mag.as_f64() {
                style.border_radius = Some(n);
            }
        }
        "borderWidth" => {
            if let Some(n) = mag.as_f64() {
                style.border_width = Some(n);
            }
        }
        "borderColor" => {
            style.border_color = Some(mag.as_string());
        }
        "fontFamily" => {
            style.font_family = Some(mag.as_string());
        }
        "fontSize" => {
            if let Some(n) = mag.as_f64() {
                style.font_size = Some(n);
            }
        }
        "fontWeight" => {
            match mag {
                Magnitude::Number(n) => {
                    style.font_weight = Some(FontWeight::Numeric(*n));
                }
                Magnitude::String(s) => {
                    // Try to parse as number first
                    if let Ok(n) = s.parse::<f64>() {
                        style.font_weight = Some(FontWeight::Numeric(n));
                    } else {
                        style.font_weight = Some(FontWeight::Named(s.clone()));
                    }
                }
            }
        }
        "width" => {
            use crate::kernel::types::Dimension;
            match mag {
                Magnitude::Number(n) => {
                    style.width = Some(Dimension::Pixels(*n));
                }
                Magnitude::String(s) => {
                    // Try to parse as percentage (e.g., "50%")
                    if let Some(percent_str) = s.strip_suffix('%') {
                        if let Ok(p) = percent_str.trim().parse::<f64>() {
                            style.width = Some(Dimension::Percent(p / 100.0));
                        }
                    } else if let Ok(px) = s.parse::<f64>() {
                        // Fallback: parse as pixels
                        style.width = Some(Dimension::Pixels(px));
                    }
                }
            }
        }
        "height" => {
            use crate::kernel::types::Dimension;
            match mag {
                Magnitude::Number(n) => {
                    style.height = Some(Dimension::Pixels(*n));
                }
                Magnitude::String(s) => {
                    // Try to parse as percentage (e.g., "50%")
                    if let Some(percent_str) = s.strip_suffix('%') {
                        if let Ok(p) = percent_str.trim().parse::<f64>() {
                            style.height = Some(Dimension::Percent(p / 100.0));
                        }
                    } else if let Ok(px) = s.parse::<f64>() {
                        // Fallback: parse as pixels
                        style.height = Some(Dimension::Pixels(px));
                    }
                }
            }
        }
        "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "padding" => {
            apply_padding(style, key, mag);
        }
        _ => {
            // Store unknown properties in extra
            match mag {
                Magnitude::Number(n) => {
                    style.extra.insert(key.to_string(), serde_json::json!(n));
                }
                Magnitude::String(s) => {
                    style.extra.insert(key.to_string(), serde_json::json!(s));
                }
            }
        }
    }
}

/// Apply padding values
fn apply_padding(style: &mut ResolvedStyle, key: &str, mag: &Magnitude) {
    let n = match mag.as_f64() {
        Some(n) => n,
        None => return,
    };

    let padding = style.padding.get_or_insert(Padding::ZERO);

    match key {
        "padding" => {
            *padding = Padding::uniform(n);
        }
        "paddingTop" => padding.top = n,
        "paddingRight" => padding.right = n,
        "paddingBottom" => padding.bottom = n,
        "paddingLeft" => padding.left = n,
        _ => {}
    }
}

// ============================================================================
// Tree Resolution
// ============================================================================

/// Resolve all styles in a BlueprintNode tree, producing a SceneNode tree
pub fn resolve_tree(node: &BlueprintNode, resolver: &dyn TokenResolver) -> SceneNode {
    // Convert kind
    let kind = match node.kind {
        super::types::BlueprintKind::Container => NodeKind::Container,
        super::types::BlueprintKind::Text => NodeKind::Text,
        super::types::BlueprintKind::Image => NodeKind::Image,
        super::types::BlueprintKind::Rect => NodeKind::Rect,
        super::types::BlueprintKind::Canvas => NodeKind::Canvas,
        super::types::BlueprintKind::Component => NodeKind::Component,
        super::types::BlueprintKind::Custom => NodeKind::Custom,
    };

    // Resolve props
    let props = resolve_props(node.props.as_ref(), resolver);

    // Recursively resolve children
    let children: Vec<Arc<SceneNode>> = node
        .children
        .iter()
        .map(|child| Arc::new(resolve_tree(child, resolver)))
        .collect();

    SceneNode {
        id: node.id.clone(),
        kind,
        props,
        children,
        z_index: node.z_index,
        visible: node
            .visible
            .map(Visibility::Resolved)
            .unwrap_or(Visibility::Resolved(true)),
        portal_owner: node.portal_owner.clone(),
        style: None,
        triggers: Vec::new(),
        synthetic: false,
        value: None,
        // BlueprintNode carries no inline FSM (blueprints are a distinct authoring
        // path; interactive blocks arrive via the direct SceneNode transaction).
        fsm: None,
    }
}

/// Resolve BlueprintProps into NodeProps
fn resolve_props(props: Option<&BlueprintProps>, resolver: &dyn TokenResolver) -> NodeProps {
    let props = match props {
        Some(p) => p,
        None => return NodeProps::default(),
    };

    // Resolve style
    let style = props.style.as_ref().map(|s| resolve_style(s, resolver));

    // Convert layout
    let layout_config = props.layout.as_ref().map(convert_layout);

    // Merge layout into style
    let final_style = match (style, layout_config) {
        (Some(mut s), Some(layout)) => {
            s.layout = Some(layout);
            Some(s)
        }
        (Some(s), None) => Some(s),
        (None, Some(layout)) => Some(ResolvedStyle {
            layout: Some(layout),
            ..Default::default()
        }),
        (None, None) => None,
    };

    // Convert a11y
    let a11y = props.a11y.as_ref().map(|a| A11yProps {
        role: a.role.as_ref().and_then(|r| parse_role(r)),
        label: a.label.clone(),
        tab_index: a.tab_index,
        props: if a.aria.is_empty() {
            None
        } else {
            Some(a.aria.clone())
        },
        states: None,
    });

    // Convert handlers
    let handlers = props.handlers.as_ref().map(convert_handlers);

    let mut extra = props.extra.clone();
    NodeProps {
        style: final_style,
        text: props.text.clone(),
        src: props.src.clone(),
        handlers,
        a11y,
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

/// Convert BlueprintLayout to LayoutConfig
fn convert_layout(layout: &BlueprintLayout) -> LayoutConfig {
    match layout {
        BlueprintLayout::Absolute {
            x,
            y,
            width: _,
            height: _,
        } => LayoutConfig {
            mode: Some(LayoutMode::Absolute),
            // Convert f64 to Value for the new binding-supporting LayoutConfig
            x: x.map(serde_json::Value::from),
            y: y.map(serde_json::Value::from),
            axis: None,
            gap: None,
            parts: None,
        },
        BlueprintLayout::Flow {
            axis,
            gap,
            padding: _,
        } => LayoutConfig {
            mode: Some(LayoutMode::Flex),
            axis: Some(convert_axis(axis)),
            gap: *gap,
            x: None,
            y: None,
            parts: None,
        },
        BlueprintLayout::Split { axis, gap, parts } => LayoutConfig {
            mode: Some(LayoutMode::Split),
            axis: Some(convert_axis(axis)),
            gap: *gap,
            parts: Some(
                parts
                    .iter()
                    .map(|p| crate::kernel::types::SplitPart {
                        fraction: p.fraction.unwrap_or(1.0 / parts.len() as f64),
                    })
                    .collect(),
            ),
            x: None,
            y: None,
        },
    }
}

/// Convert BlueprintAxis to LayoutAxis
fn convert_axis(axis: &BlueprintAxis) -> LayoutAxis {
    match axis {
        BlueprintAxis::X => LayoutAxis::X,
        BlueprintAxis::Y => LayoutAxis::Y,
    }
}

/// Parse role string
fn parse_role(role: &str) -> Option<crate::kernel::types::Role> {
    use crate::kernel::types::Role;
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

/// Convert blueprint handlers
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

// ============================================================================
// Convenience Functions
// ============================================================================

/// Resolve a tree with an empty token set (no token resolution)
pub fn resolve_tree_no_tokens(node: &BlueprintNode) -> SceneNode {
    let resolver = HashMapResolver::empty();
    resolve_tree(node, &resolver)
}

/// Resolve a tree with a provided token map
pub fn resolve_tree_with_tokens(node: &BlueprintNode, tokens: TokenSet) -> SceneNode {
    let resolver = HashMapResolver::new(tokens);
    resolve_tree(node, &resolver)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blueprint::types::{BlueprintKind, TokenRef};

    #[test]
    fn authored_properties_survive_blueprint_resolution() {
        let props: BlueprintProps = serde_json::from_value(serde_json::json!({
            "text": "Child", "indent_level": 2, "caller_metadata": {"nested": [true, null]},
            "component_id": "caller-component", "instance_props": {"colour": "blue"}
        })).unwrap();
        let converted = resolve_props(Some(&props), &HashMapResolver::empty());
        let encoded = serde_json::to_value(&converted).unwrap();
        assert_eq!(encoded["indent_level"], serde_json::json!(2));
        assert_eq!(encoded["caller_metadata"], serde_json::json!({"nested": [true, null]}));
        assert_eq!(encoded["component_id"], serde_json::json!("caller-component"));
        assert!(!converted.extra.contains_key("component_id"));
        assert!(!converted.extra.contains_key("instance_props"));
    }

    #[test]
    fn test_resolve_number_value() {
        let resolver = HashMapResolver::empty();
        let value = StyleValue::Number(16.0);
        let result = resolve_style_value(&value, &resolver);
        assert_eq!(result, Some(Magnitude::Number(16.0)));
    }

    #[test]
    fn test_resolve_string_value() {
        let resolver = HashMapResolver::empty();
        let value = StyleValue::TokenPath("auto".to_string());
        let result = resolve_style_value(&value, &resolver);
        assert_eq!(result, Some(Magnitude::String("auto".to_string())));
    }

    #[test]
    fn test_resolve_token_path() {
        let mut tokens = HashMap::new();
        tokens.insert("colors/primary".to_string(), serde_json::json!("#ff0000"));

        let resolver = HashMapResolver::new(tokens);
        let value = StyleValue::TokenPath("colors/primary".to_string());
        let result = resolve_style_value(&value, &resolver);
        assert_eq!(result, Some(Magnitude::String("#ff0000".to_string())));
    }

    #[test]
    fn test_resolve_token_ref() {
        let mut tokens = HashMap::new();
        tokens.insert("spacing/md".to_string(), serde_json::json!(16));

        let resolver = HashMapResolver::new(tokens);
        let value = StyleValue::Ref(TokenRef {
            path: "spacing/md".to_string(),
        });
        let result = resolve_style_value(&value, &resolver);
        assert_eq!(result, Some(Magnitude::Number(16.0)));
    }

    #[test]
    fn test_resolve_literal() {
        let resolver = HashMapResolver::empty();
        let value = StyleValue::Literal(super::super::types::StyleLiteral {
            literal: StyleLiteralValue::Number(42.0),
            reason: Some("special case".to_string()),
        });
        let result = resolve_style_value(&value, &resolver);
        assert_eq!(result, Some(Magnitude::Number(42.0)));
    }

    #[test]
    fn test_resolve_tree() {
        let mut tokens = HashMap::new();
        tokens.insert(
            "colors/background".to_string(),
            serde_json::json!("#ffffff"),
        );

        let mut style = BlueprintStyle::new();
        style.insert(
            "background",
            StyleValue::TokenPath("colors/background".to_string()),
        );

        let props = BlueprintProps {
            style: Some(style),
            ..Default::default()
        };

        let node = BlueprintNode::new("root", BlueprintKind::Container).with_props(props);

        let resolved = resolve_tree_with_tokens(&node, tokens);
        assert_eq!(resolved.id, "root");
        assert!(resolved.props.style.is_some());
        assert_eq!(
            resolved.props.style.as_ref().unwrap().background,
            Some("#ffffff".to_string())
        );
    }

    #[test]
    fn test_convert_layout_flow() {
        let layout = BlueprintLayout::Flow {
            axis: BlueprintAxis::Y,
            gap: Some(8.0),
            padding: None,
        };

        let config = convert_layout(&layout);
        assert_eq!(config.mode, Some(LayoutMode::Flex));
        assert_eq!(config.axis, Some(LayoutAxis::Y));
        assert_eq!(config.gap, Some(8.0));
    }

    #[test]
    fn test_convert_layout_absolute() {
        let layout = BlueprintLayout::Absolute {
            x: Some(10.0),
            y: Some(20.0),
            width: Some(100.0),
            height: Some(50.0),
        };

        let config = convert_layout(&layout);
        assert_eq!(config.mode, Some(LayoutMode::Absolute));
        assert_eq!(config.x, Some(serde_json::json!(10.0)));
        assert_eq!(config.y, Some(serde_json::json!(20.0)));
    }
}
