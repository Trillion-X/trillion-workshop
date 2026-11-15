//! crates/composition-ast/src/kernel/types.rs
//!
//! Pure vocabulary types for the composition engine.
//! All types are immutable by default (Rust ownership).
//!
//! L088: Leaf crate — shared between composition-engine, projector,
//! and interaction-engine. Zero runtime state, zero inter-slot deps.
//!
//! # AI Directive
//!
//! The extensive documentation in this codebase is a critical design feature.
//! You are FORBIDDEN from simplifying or removing it. Your mandate is to
//! MAINTAIN and EXTEND this level of meticulous detail.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

#[cfg(feature = "wasm")]
use tsify_next::Tsify;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

// ============================================================================
// Custom Deserializers for Flexible FSM Format
// ============================================================================

/// Deserialize FSM transitions accepting both shorthand and full format:
/// - Shorthand: "toggle": "edit" (string target)
/// - Full: "toggle": [{"target": "edit", "guard": "...", "actions": [...]}]
fn deserialize_fsm_on<'de, D>(
    deserializer: D,
) -> Result<Option<HashMap<String, Vec<FSMTransition>>>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::{MapAccess, Visitor};

    struct FSMOnVisitor;

    impl<'de> Visitor<'de> for FSMOnVisitor {
        type Value = Option<HashMap<String, Vec<FSMTransition>>>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("FSM transition map with string or array values")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserializer.deserialize_map(FSMOnMapVisitor)
        }

        fn visit_map<M>(self, map: M) -> Result<Self::Value, M::Error>
        where
            M: MapAccess<'de>,
        {
            FSMOnMapVisitor.visit_map(map)
        }
    }

    struct FSMOnMapVisitor;

    impl<'de> Visitor<'de> for FSMOnMapVisitor {
        type Value = Option<HashMap<String, Vec<FSMTransition>>>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("FSM transition map")
        }

        fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
        where
            M: MapAccess<'de>,
        {
            let mut result = HashMap::new();

            while let Some(key) = map.next_key::<String>()? {
                // Try to deserialize as flexible transition value
                let value: TransitionValue = map.next_value()?;
                result.insert(key, value.into_transitions());
            }

            if result.is_empty() {
                Ok(None)
            } else {
                Ok(Some(result))
            }
        }
    }

    deserializer.deserialize_option(FSMOnVisitor)
}

/// Helper enum for flexible transition deserialization
#[derive(Deserialize)]
#[serde(untagged)]
enum TransitionValue {
    /// Shorthand: just target state name
    Shorthand(String),
    /// Full: array of transition objects
    Full(Vec<FSMTransition>),
}

impl TransitionValue {
    fn into_transitions(self) -> Vec<FSMTransition> {
        match self {
            TransitionValue::Shorthand(target) => vec![FSMTransition {
                target,
                guard: None,
                actions: None,
            }],
            TransitionValue::Full(transitions) => transitions,
        }
    }
}

// ============================================================================
// Primitive Type Aliases
// ============================================================================

/// Unique identifier for scene nodes
pub type ID = String;

/// Unsubscribe callback type (for event listeners)
pub type Unsub = Box<dyn FnOnce()>;

// ============================================================================
// Enums
// ============================================================================

/// Kernel processing phases (strictly ordered)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum Phase {
    Input,
    Fsm,
    Context,
    Layout,
    Scene,
    Semantics,
    Render,
}

/// Placement options for anchored elements (tooltips, popovers)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum Placement {
    Top,
    Bottom,
    Left,
    Right,
    #[default]
    Auto,
}

/// ARIA roles for accessibility
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum Role {
    Button,
    Checkbox,
    Radio,
    Slider,
    Menu,
    Menuitem,
    Dialog,
    Textbox,
    Link,
    Listbox,
    Option,
    Switch,
    Img,
    Heading,
    Region,
    #[default]
    None,
}

/// Node types in the scene tree
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum NodeKind {
    #[default]
    Container,
    Text,
    Image,
    Rect,
    Canvas,
    /// Composition engine registry dispatch — resolved by host component registry
    Component,
    Custom,
}

// ============================================================================
// Visibility Type (Canonical - L041/L043)
// ============================================================================

/// Visibility binding - defines how to compute visibility from context
///
/// Format matches the EEAF binding standard:
/// ```json
/// {
///   "$kind": "binding",
///   "select": { "from": "fsm", "path": "fsm:editor:mode" },
///   "transform": [{ "op": "op:core.equals", "args": { "value": "edit" } }],
///   "default": false
/// }
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct VisibilityBinding {
    /// Marker field - always "binding"
    #[serde(rename = "$kind")]
    pub kind: String,
    /// Source selection
    pub select: BindingSelect,
    /// Transform pipeline
    #[serde(default)]
    pub transform: Vec<BindingTransform>,
    /// Default value if binding fails
    #[serde(default = "default_visibility_false")]
    pub default: bool,
}

fn default_visibility_false() -> bool {
    false
}

/// Select key - either a static string or a nested binding for dynamic resolution
///
/// # 1000x Architecture
///
/// This enables the routing pattern where the key is computed at runtime:
/// - Static: `{ "key": "keyboard:0" }` → directly lookup "keyboard:0"
/// - Dynamic: `{ "key": { "$kind": "binding", "select": { "from": "ambient", "path": "session_text_origin" } } }`
///
/// Dynamic keys use the canonical binding format - ONE syntax for dynamic value resolution.
/// The nested binding is evaluated first, and its result is used as the routing key.
///
/// The `#[serde(untagged)]` attribute allows clean JSON without type discriminators.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(untagged)]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum SelectKey {
    /// A static string key (e.g., "keyboard:0")
    Static(String),
    /// A nested binding that resolves to the key value at runtime
    /// Uses serde_json::Value for WASM compatibility - the actual binding structure
    /// is validated and evaluated by the binding evaluator
    Dynamic(serde_json::Value),
}

/// Binding source selection
///
/// # 1000x Architecture - Full Binding Support
///
/// This struct must match the binding AST's BindingSelect to support:
/// - FSM bindings: `{ "from": "fsm", "path": "fsm:editor:mode" }`
/// - Routing bindings: `{ "from": "routing", "key": { "$kind": "binding", "select": { "from": "ambient", "path": "x" } } }`
/// - Data source bindings: `{ "from": "dataSource", "key": "user", "path": "name" }`
///
/// The `key` field is CRITICAL for routing - without it, dynamic routing lookups fail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct BindingSelect {
    /// Source type: "fsm", "vars", "ambient", "dataSource", "routing", "state"
    pub from: String,
    /// Path within the source (optional - not needed for routing with key)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Key for dataSource and routing lookups (static or dynamic)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<SelectKey>,
}

/// Binding transform operation
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct BindingTransform {
    /// Operator ID
    pub op: String,
    /// Operator arguments
    #[serde(default)]
    pub args: serde_json::Value,
}

/// Canonical visibility type - handles all representations
///
/// This is the ONE place where visibility is defined (L041/L043).
/// - Projector outputs Visibility (Resolved or Binding)
/// - Kernel compute phase evaluates Binding → Resolved
/// - Host receives only Resolved (booleans)
///
/// The untagged serde allows seamless deserialization from:
/// - `true` / `false` → Visibility::Resolved(bool)
/// - `{ "$kind": "binding", ... }` → Visibility::Binding(VisibilityBinding)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(untagged)]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum Visibility {
    /// Already resolved to a boolean
    Resolved(bool),
    /// Binding that needs evaluation
    Binding(VisibilityBinding),
}

impl Default for Visibility {
    fn default() -> Self {
        Visibility::Resolved(true)
    }
}

impl Visibility {
    /// Returns true if this is a resolved boolean (not a binding)
    pub fn is_resolved(&self) -> bool {
        matches!(self, Visibility::Resolved(_))
    }

    /// Returns the boolean value if resolved, or the default from binding if not
    ///
    /// IMPORTANT: This should only be called AFTER compute phase.
    /// If called on an unevaluated binding, it returns the binding's default
    /// and logs a warning (in debug builds).
    pub fn as_bool(&self) -> bool {
        match self {
            Visibility::Resolved(b) => *b,
            Visibility::Binding(binding) => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[WARN] Visibility::as_bool() called on unevaluated binding for from='{}' - using default {}",
                    binding.select.from, binding.default
                );
                binding.default
            }
        }
    }

    /// Resolve a binding to a boolean given an evaluated value
    pub fn resolve(self, evaluated_value: bool) -> Self {
        match self {
            Visibility::Binding(_) => Visibility::Resolved(evaluated_value),
            resolved => resolved,
        }
    }
}

/// Context key enum (replaces TypeScript Symbol-based CtxKey<T>)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum ContextKey {
    Ambient,
    Vars,
    DataSources,
    Fsm,
}

// ============================================================================
// Geometry Types
// ============================================================================

/// 2D point
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const ZERO: Point = Point { x: 0.0, y: 0.0 };

    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// 2D size (width, height)
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

impl Size {
    pub const ZERO: Size = Size { w: 0.0, h: 0.0 };

    pub const fn new(w: f64, h: f64) -> Self {
        Self { w, h }
    }
}

/// 2D rectangle (position + size)
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub const ZERO: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    };

    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    pub fn from_point_size(point: Point, size: Size) -> Self {
        Self {
            x: point.x,
            y: point.y,
            w: size.w,
            h: size.h,
        }
    }

    pub fn contains(&self, point: Point) -> bool {
        point.x >= self.x
            && point.x <= self.x + self.w
            && point.y >= self.y
            && point.y <= self.y + self.h
    }

    pub fn origin(&self) -> Point {
        Point::new(self.x, self.y)
    }

    pub fn size(&self) -> Size {
        Size::new(self.w, self.h)
    }

    /// Check if two rectangles intersect (including edge touching).
    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.x + other.w
            && self.x + self.w > other.x
            && self.y < other.y + other.h
            && self.y + self.h > other.y
    }
}

/// Anchor result for positioned elements
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct AnchorResult {
    pub origin: Point,
    pub side: Placement, // Excludes 'auto' (resolved)
}

/// 2D affine transformation matrix
/// | a c e |
/// | b d f |
/// | 0 0 1 |
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct Matrix {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Default for Matrix {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Matrix {
    pub const IDENTITY: Matrix = Matrix {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    pub const fn new(a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) -> Self {
        Self { a, b, c, d, e, f }
    }

    /// Create a translation matrix
    pub const fn translate(tx: f64, ty: f64) -> Self {
        Self {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: tx,
            f: ty,
        }
    }

    /// Multiply two matrices
    pub fn multiply(&self, other: &Matrix) -> Matrix {
        Matrix {
            a: self.a * other.a + self.c * other.b,
            b: self.b * other.a + self.d * other.b,
            c: self.a * other.c + self.c * other.d,
            d: self.b * other.c + self.d * other.d,
            e: self.a * other.e + self.c * other.f + self.e,
            f: self.b * other.e + self.d * other.f + self.f,
        }
    }

    /// Transform a point by this matrix
    pub fn transform_point(&self, p: Point) -> Point {
        Point {
            x: self.a * p.x + self.c * p.y + self.e,
            y: self.b * p.x + self.d * p.y + self.f,
        }
    }
}

// ============================================================================
// Spatial Canvas Types (Camera, Edges, Layout)
// ============================================================================

/// Camera configuration limits and constants.
#[derive(Debug, Clone, Copy)]
pub struct CanvasConfig {
    /// Minimum zoom level (default: 0.1)
    pub zoom_min: f64,
    /// Maximum zoom level (default: 4.0)
    pub zoom_max: f64,
    /// Margin around viewport for culling (pixels, default: 200.0)
    pub cull_margin_px: f64,
    /// Maximum number of nodes allowed in scene (default: 10,000)
    pub max_scene_nodes: usize,
    /// Maximum number of edges allowed (default: 50,000)
    pub max_edge_count: usize,
}

impl Default for CanvasConfig {
    fn default() -> Self {
        Self {
            zoom_min: 0.1,
            zoom_max: 4.0,
            cull_margin_px: 200.0,
            max_scene_nodes: 10_000,
            max_edge_count: 50_000,
        }
    }
}

/// Canvas-related errors with structured error codes.
#[derive(Debug, Clone, PartialEq)]
pub enum CanvasError {
    /// E3022: Invalid camera parameter (pan_x, pan_y, or zoom)
    InvalidCamera(&'static str),
    /// E3050: Scene exceeds max node count
    TooManyNodes(usize),
    /// E3052: Edge set exceeds max edge count
    TooManyEdges(usize),
    /// E3053: Invalid edge (empty ID, self-loop, etc.)
    InvalidEdge(&'static str),
    /// E3055: Invalid layout JSON
    InvalidLayout(&'static str),
    /// E3056: Invalid edge JSON
    InvalidEdgeJson(&'static str),
}

impl std::fmt::Display for CanvasError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CanvasError::InvalidCamera(msg) => write!(f, "E3022 InvalidCamera: {}", msg),
            CanvasError::TooManyNodes(count) => write!(f, "E3050 TooManyNodes: {}", count),
            CanvasError::TooManyEdges(count) => write!(f, "E3052 TooManyEdges: {}", count),
            CanvasError::InvalidEdge(msg) => write!(f, "E3053 InvalidEdge: {}", msg),
            CanvasError::InvalidLayout(msg) => write!(f, "E3055 InvalidLayout: {}", msg),
            CanvasError::InvalidEdgeJson(msg) => write!(f, "E3056 InvalidEdgeJson: {}", msg),
        }
    }
}

impl std::error::Error for CanvasError {}

/// Camera with pan and zoom for viewport transformation.
///
/// Invariants (Pattern 12):
/// - pan_x, pan_y, zoom are all finite (no NaN/Infinity)
/// - zoom > 0 (division by zero structurally impossible)
/// - zoom ∈ [config.zoom_min, config.zoom_max]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct Camera {
    /// Pan offset on X axis
    pub pan_x: f64,
    /// Pan offset on Y axis
    pub pan_y: f64,
    /// Zoom level
    pub zoom: f64,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 1.0,
        }
    }
}

impl Camera {
    /// Validates and clamps camera values. Returns Err for non-finite or non-positive zoom (Pattern 12).
    pub fn validated(
        pan_x: f64,
        pan_y: f64,
        zoom: f64,
        config: &CanvasConfig,
    ) -> Result<Self, CanvasError> {
        if !pan_x.is_finite() || !pan_y.is_finite() || !zoom.is_finite() {
            return Err(CanvasError::InvalidCamera("non-finite camera value"));
        }
        if zoom <= 0.0 {
            return Err(CanvasError::InvalidCamera("zoom must be > 0"));
        }
        Ok(Self {
            pan_x,
            pan_y,
            zoom: zoom.clamp(config.zoom_min, config.zoom_max),
        })
    }

    /// Transform a point from screen coordinates to world coordinates.
    pub fn screen_to_world(&self, screen: Point) -> Point {
        Point::new(
            (screen.x - self.pan_x) / self.zoom,
            (screen.y - self.pan_y) / self.zoom,
        )
    }

    /// Transform a point from world coordinates to screen coordinates.
    pub fn world_to_screen(&self, world: Point) -> Point {
        Point::new(
            world.x * self.zoom + self.pan_x,
            world.y * self.zoom + self.pan_y,
        )
    }

    /// Compute the visible rectangle in world coordinates for a given viewport size.
    pub fn visible_rect(&self, viewport: Size) -> Rect {
        let tl = self.screen_to_world(Point::new(0.0, 0.0));
        let br = self.screen_to_world(Point::new(viewport.w, viewport.h));
        Rect {
            x: tl.x,
            y: tl.y,
            w: br.x - tl.x,
            h: br.y - tl.y,
        }
    }
}

/// Anchor point for edge connection (top, bottom, left, right, center).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
#[derive(Default)]
pub enum Anchor {
    #[serde(rename = "top")]
    Top,
    #[serde(rename = "bottom")]
    Bottom,
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(rename = "center")]
    #[default]
    Center,
}

/// Edge connection definition.
///
/// Invariants (Pattern 12):
/// - source_id and target_id must be non-empty
/// - source_id != target_id (no self-loops)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct EdgeConnection {
    /// Unique identifier for this edge
    pub edge_id: String,
    /// ID of the source node
    pub source_id: String,
    /// ID of the target node
    pub target_id: String,
    /// Anchor point on source node
    pub source_anchor: Anchor,
    /// Anchor point on target node
    pub target_anchor: Anchor,
}

impl EdgeConnection {
    /// Validate edge connection (Pattern 12).
    pub fn validate(&self) -> Result<(), CanvasError> {
        if self.source_id.is_empty() {
            return Err(CanvasError::InvalidEdge("empty source_id"));
        }
        if self.target_id.is_empty() {
            return Err(CanvasError::InvalidEdge("empty target_id"));
        }
        if self.source_id == self.target_id {
            return Err(CanvasError::InvalidEdge("self-loop"));
        }
        Ok(())
    }
}

/// Edge route (computed path from source to target).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct EdgeRoute {
    /// Edge identifier
    pub edge_id: String,
    /// Source node ID
    pub source_id: String,
    /// Target node ID
    pub target_id: String,
    /// Route points (source → intermediate points → target)
    pub points: Vec<Point>,
}

/// Spatial layout patch (x, y coordinates from JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct LayoutPatch {
    /// X coordinate
    pub x: f64,
    /// Y coordinate
    pub y: f64,
}

impl LayoutPatch {
    /// Validate layout patch (Pattern 12).
    pub fn validate(&self) -> Result<(), CanvasError> {
        if !self.x.is_finite() || !self.y.is_finite() {
            return Err(CanvasError::InvalidLayout("non-finite coordinates"));
        }
        Ok(())
    }

    /// Convert to node props for applying via ScenePatch::UpdateProps.
    pub fn to_node_props(&self) -> HashMap<String, serde_json::Value> {
        let mut props = HashMap::new();
        props.insert("x".to_string(), serde_json::json!(self.x));
        props.insert("y".to_string(), serde_json::json!(self.y));
        props
    }
}

/// Visibility patch (Pattern 24 - viewport entry/exit transitions).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(tag = "type", content = "data")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum VisibilityPatch {
    /// Node entered viewport - host mounts DOM element with full frame data
    #[serde(rename = "entered")]
    Entered { node_id: ID, frame: LayoutFrame },
    /// Node left viewport - host unmounts DOM element
    #[serde(rename = "exited")]
    Exited { node_id: ID },
}

/// Edge mutation (add, remove, or update).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(tag = "type", rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum EdgeMutation {
    /// Add a new edge
    #[serde(rename = "add")]
    Add(EdgeConnection),
    /// Remove an edge by ID
    #[serde(rename = "remove")]
    Remove { edge_id: String },
    /// Update an existing edge
    #[serde(rename = "update")]
    Update(EdgeConnection),
}

/// Edge patch in snapshot delta.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(tag = "type", rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum EdgePatch {
    /// New edge route computed
    #[serde(rename = "added")]
    Added(EdgeRoute),
    /// Edge route updated
    #[serde(rename = "updated")]
    Updated(EdgeRoute),
    /// Edge removed
    #[serde(rename = "removed")]
    Removed { edge_id: String },
}

// ============================================================================
// Style Types
// ============================================================================

/// Padding values (top, right, bottom, left)
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
// A partial box (e.g. `{ "top": 24 }` — one side of a per-block margin) deserializes
// with the omitted sides defaulting to 0, instead of failing the whole style. This is
// what lets the spacing editor write ONE margin side without forcing all four.
#[serde(default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct Padding {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl Padding {
    pub const ZERO: Padding = Padding {
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

/// Layout mode for children arrangement
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum LayoutMode {
    #[default]
    Flex,
    Split,
    Absolute,
}

/// Layout axis direction (Physics terms)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum LayoutAxis {
    #[default]
    X,
    Y,
}

/// Split part specification
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct SplitPart {
    pub fraction: f64,
}

/// Layout configuration for a node
///
/// ## Binding Support (Late Binding Architecture)
///
/// The `x` and `y` fields use `serde_json::Value` instead of `f64` to support
/// bindings that are evaluated at runtime. This allows positions to be:
/// - Static numbers: `{"x": 100}` → `Value::Number(100)`
/// - Dynamic bindings: `{"x": {"$kind": "binding", "select": {...}}}` → binding AST
///
/// Flow:
/// 1. Projector passes through raw values (numbers or bindings)
/// 2. Kernel compute phase evaluates any bindings → resolved numbers
/// 3. Layout phase extracts f64 from the (now resolved) Value
///
/// This enables any layout property to be driven by state without polluting
/// other structs (like SceneNode) with temporary fields.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct LayoutConfig {
    pub mode: Option<LayoutMode>,
    pub axis: Option<LayoutAxis>,
    pub gap: Option<f64>,
    pub parts: Option<Vec<SplitPart>>,
    /// Absolute X position - may be a number or binding AST.
    /// After kernel compute, bindings are resolved to numbers.
    pub x: Option<serde_json::Value>,
    /// Absolute Y position - may be a number or binding AST.
    /// After kernel compute, bindings are resolved to numbers.
    pub y: Option<serde_json::Value>,
}

// ============================================================================
// Canonical Layout Transformation (L041/L043 - Single Source of Truth)
// ============================================================================
//
// This is the ONE canonical place for converting database layout format to LayoutConfig.
//
// ## Why This Exists
//
// Before this canonical function, THREE places did the same transformation:
// 1. persistence-wasm/src/lib.rs: transform_layout_recursive()
// 2. composition-engine-wasm/src/lib.rs: build_scene_from_layout()
// 3. composition-engine/src/blueprint/resolver.rs: convert_layout()
//
// Each had subtly different logic, causing bugs like x/y going to wrong locations.
// Per L043 (No Whack-a-Mole), we create ONE canonical function that all paths call.
//
// ## Database Layout Format
//
// The database stores layout as:
// ```json
// {
//   "type": "flex" | "split" | "absolute",
//   "direction": "row" | "column",
//   "default_sizes": { "x": 100, "y": 200, "width": 320, "height": 400 }
// }
// ```
//
// ## What This Function Does
//
// Extracts and converts:
// - type → LayoutMode (flex/split/absolute)
// - direction → LayoutAxis (x/y)
// - default_sizes.x/y → x/y (for absolute positioning)
// - default_sizes (array) → parts (for split layout)
//
// ## Returns
//
// Returns a tuple of (LayoutConfig, Option<width>, Option<height>) because:
// - LayoutConfig goes into style.layout
// - width/height go into style.width/height (separate from layout)

impl LayoutConfig {
    /// Extract LayoutConfig from style.layout object.
    ///
    /// This is the CANONICAL transformation for the new style blob format.
    /// All layout properties live in a nested `layout` object within style.
    ///
    /// # Expected Format
    ///
    /// ```json
    /// {
    ///     "mode": "flex",      // "flex" | "split" | "absolute"
    ///     "axis": "column",    // "row" | "column" (human-readable)
    ///     "gap": 12,           // number (pixels)
    ///     "parts": [0.3, 0.7], // array of fractions (for split)
    ///     "x": 100,            // number or binding (for absolute)
    ///     "y": 200             // number or binding (for absolute)
    /// }
    /// ```
    ///
    /// # Axis Mapping
    ///
    /// Uses human-readable "row"/"column" which maps to:
    /// - "row" → LayoutAxis::X (children flow horizontally)
    /// - "column" → LayoutAxis::Y (children flow vertically, DEFAULT)
    ///
    /// # Arguments
    ///
    /// * `layout` - The layout object extracted from style.layout
    ///
    /// # Returns
    ///
    /// LayoutConfig with all fields populated from the layout object.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let style_value = obj.get("style");
    /// if let Some(layout_obj) = style_value.and_then(|s| s.get("layout")) {
    ///     let layout_config = LayoutConfig::from_style_layout(layout_obj);
    ///     // Use layout_config...
    /// }
    /// ```
    pub fn from_style_layout(layout: &serde_json::Value) -> Self {
        // Parse layout mode from "mode" field
        let mode = match layout.get("mode").and_then(|v| v.as_str()) {
            Some("flex") => Some(LayoutMode::Flex),
            Some("split") => Some(LayoutMode::Split),
            Some("absolute") => Some(LayoutMode::Absolute),
            _ => Some(LayoutMode::Flex), // Default to Flex
        };

        // Parse axis from "axis" field (human-readable: "row"/"column")
        let axis = match layout.get("axis").and_then(|v| v.as_str()) {
            Some("row") => Some(LayoutAxis::X),
            Some("column") => Some(LayoutAxis::Y),
            Some("x") => Some(LayoutAxis::X), // Also accept direct x/y
            Some("y") => Some(LayoutAxis::Y),
            _ => Some(LayoutAxis::Y), // Default to Y (column)
        };

        // Parse gap from "gap" field
        let gap = layout.get("gap").and_then(|v| v.as_f64());

        // Parse parts from "parts" array (for split layouts)
        let parts = layout.get("parts").and_then(|p| p.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_f64())
                .map(|fraction| SplitPart { fraction })
                .collect()
        });

        // Pass through x/y as raw Value (supports bindings for absolute positioning)
        let x = layout.get("x").cloned();
        let y = layout.get("y").cloned();

        Self {
            mode,
            axis,
            gap,
            parts,
            x,
            y,
        }
    }
}

/// Text alignment options
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

// ============================================================================
// Resilient Deserialization for Numeric Style Fields (Task 146 — Agent 1)
// ============================================================================
//
// Text inputs produce JSON strings ("22.0") but ResolvedStyle expects f64.
// This deserializer accepts both forms, preventing entire-style corruption
// when a single field has a string-encoded number. Invalid strings (e.g.
// "abc") gracefully fall back to None rather than failing deserialization.
//
// This is the SAFETY NET layer. The PRIMARY defense is type coercion in
// resolve_workflow_params() (workflow-wasm), which coerces values before
// they reach the database. This deserializer handles legacy/corrupted data.

/// Deserialize an `Option<f64>` that accepts numbers, string-encoded numbers,
/// or null. This is the canonical resilient deserializer for all numeric style
/// fields in `ResolvedStyle`.
///
/// ## Accepted Inputs
/// - `null` → `None`
/// - `20.0` (JSON number) → `Some(20.0)`
/// - `"20.0"` (JSON string parseable as f64) → `Some(20.0)`
/// - `"14"` (JSON string integer) → `Some(14.0)`
/// - `"abc"` (unparseable string) → `None` (graceful fallback, not error)
///
/// ## Why Not Error on Invalid Strings?
/// Per L017 (blocked primitives return valid results, not errors/panics):
/// a single corrupted field should not prevent the entire style from loading.
/// `None` means "use default" — the correct fallback for an invalid value.
fn deserialize_lenient_f64<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    /// Visitor that accepts null, number, or string-encoded number.
    struct LenientF64Visitor;

    impl<'de> serde::de::Visitor<'de> for LenientF64Visitor {
        type Value = Option<f64>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("null, a number, or a string-encoded number")
        }

        fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(Some(v as f64))
        }

        fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(v as f64))
        }

        fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
            Ok(Some(v))
        }

        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
            match v.parse::<f64>() {
                Ok(n) => Ok(Some(n)),
                Err(_) => Ok(None), // Graceful fallback per L017
            }
        }

        fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Self::Value, E> {
            self.visit_str(&v)
        }
    }

    deserializer.deserialize_any(LenientF64Visitor)
}

/// Lenient Option<Dimension> deserializer.
/// Accepts numbers (pixels) or strings ("50%"), invalid strings → None.
/// Lenient `Option<String>` deserializer.
/// Accepts strings normally, returns `None` for objects, arrays, booleans, etc.
///
/// ## Why This Exists
/// Database style JSON may contain unresolved `$token` references like
/// `{"$token": "colors/surface/solid"}` in fields expected to be `Option<String>`.
/// Without lenient deserialization, a single unresolved token object causes the
/// ENTIRE `ResolvedStyle` to fail, losing all other valid fields (width, height,
/// flex, layout) along with it. This is catastrophic: a cosmetic token miss
/// (wrong background color) escalates to a total layout failure (0x0 node).
///
/// ## Accepted Inputs
/// - `null` → `None`
/// - `"#1a1a2e"` (string) → `Some("#1a1a2e")`
/// - `{"$token": "..."}` (object) → `None` (graceful fallback)
/// - `42` (number) → `None`
/// - `[...]` (array) → `None`
fn deserialize_lenient_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde_json::Value;

    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(Value::Null) => Ok(None),
        _ => Ok(None), // Objects, arrays, numbers, bools → graceful None
    }
}

fn deserialize_lenient_dimension<'de, D>(deserializer: D) -> Result<Option<Dimension>, D::Error>
where
    D: Deserializer<'de>,
{
    // Deserialize as Option<Value> first, then try to parse as Dimension
    use serde_json::Value;

    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None => Ok(None),
        Some(Value::Number(n)) => {
            if let Some(f) = n.as_f64() {
                Ok(Some(Dimension::Pixels(f)))
            } else {
                Ok(None)
            }
        }
        Some(Value::String(s)) => {
            // Try percentage
            if let Some(percent_str) = s.strip_suffix('%') {
                if let Ok(p) = percent_str.trim().parse::<f64>() {
                    return Ok(Some(Dimension::Percent(p / 100.0)));
                }
            }
            // Try pixels
            if let Ok(px) = s.parse::<f64>() {
                return Ok(Some(Dimension::Pixels(px)));
            }
            // Invalid string → None (graceful fallback)
            Ok(None)
        }
        _ => Ok(None),
    }
}

// ============================================================================
// Dimension — Responsive Sizing
// ============================================================================

/// Responsive dimension value: pixels or percentage of parent.
///
/// Supports responsive layouts where components size relative to their container.
///
/// ## Formats
/// - `400` or `400.0` → `Pixels(400.0)`
/// - `"50%"` → `Percent(0.5)` (stored as fraction 0.0-1.0)
/// - `"100%"` → `Percent(1.0)`
///
/// ## Resolution
/// Call `resolve(parent_size)` to get concrete pixels:
/// - `Pixels(400.0).resolve(800.0)` → `400.0`
/// - `Percent(0.5).resolve(800.0)` → `400.0`
#[derive(Debug, Clone, PartialEq)]
pub enum Dimension {
    Pixels(f64),
    Percent(f64), // 0.0 to 1.0 — fraction of parent constraint
}

impl Dimension {
    /// Resolve to concrete pixels given parent size.
    pub fn resolve(&self, parent_size: f64) -> f64 {
        match self {
            Dimension::Pixels(px) => *px,
            Dimension::Percent(fraction) => parent_size * fraction,
        }
    }
}

impl Serialize for Dimension {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Dimension::Pixels(px) => serializer.serialize_f64(*px),
            Dimension::Percent(fraction) => {
                serializer.serialize_str(&format!("{}%", fraction * 100.0))
            }
        }
    }
}

impl<'de> Deserialize<'de> for Dimension {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::de::{Error, Visitor};

        struct DimensionVisitor;

        impl<'de> Visitor<'de> for DimensionVisitor {
            type Value = Dimension;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a number (pixels) or string percentage (e.g., \"50%\")")
            }

            fn visit_i64<E: Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(Dimension::Pixels(v as f64))
            }

            fn visit_u64<E: Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(Dimension::Pixels(v as f64))
            }

            fn visit_f64<E: Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(Dimension::Pixels(v))
            }

            fn visit_str<E: Error>(self, v: &str) -> Result<Self::Value, E> {
                if let Some(percent_str) = v.strip_suffix('%') {
                    match percent_str.trim().parse::<f64>() {
                        Ok(p) => Ok(Dimension::Percent(p / 100.0)),
                        Err(_) => Err(Error::custom(format!("invalid percentage: {}", v))),
                    }
                } else {
                    // Fallback: try parsing as pixels
                    match v.parse::<f64>() {
                        Ok(px) => Ok(Dimension::Pixels(px)),
                        Err(_) => Err(Error::custom(format!("invalid dimension: {}", v))),
                    }
                }
            }

            fn visit_string<E: Error>(self, v: String) -> Result<Self::Value, E> {
                self.visit_str(&v)
            }
        }

        deserializer.deserialize_any(DimensionVisitor)
    }
}

/// Resolved style properties (magnitude-only, no tokens)
/// Kernel only sees concrete values, never token references.
///
/// All `Option<f64>` fields use `deserialize_lenient_f64` to accept both
/// numeric values (20.0) and string-encoded numbers ("20.0"). This prevents
/// entire-style deserialization failure when text inputs store strings.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct ResolvedStyle {
    #[serde(deserialize_with = "deserialize_lenient_string", default)]
    pub background: Option<String>,
    #[serde(deserialize_with = "deserialize_lenient_string", default)]
    pub color: Option<String>,

    #[serde(deserialize_with = "deserialize_lenient_f64", default)]
    pub border_radius: Option<f64>,

    #[serde(deserialize_with = "deserialize_lenient_f64", default)]
    pub border_width: Option<f64>,

    #[serde(deserialize_with = "deserialize_lenient_string", default)]
    pub border_color: Option<String>,
    #[serde(deserialize_with = "deserialize_lenient_string", default)]
    pub font_family: Option<String>,

    #[serde(deserialize_with = "deserialize_lenient_f64", default)]
    pub font_size: Option<f64>,

    pub font_weight: Option<FontWeight>,
    pub text_align: Option<TextAlign>,

    /// Explicit sizing for leaf nodes
    /// Supports pixels (400.0) or percentage ("50%") of parent
    #[serde(deserialize_with = "deserialize_lenient_dimension", default)]
    pub width: Option<Dimension>,
    #[serde(deserialize_with = "deserialize_lenient_dimension", default)]
    pub height: Option<Dimension>,

    /// Flex grow factor. When > 0, this node absorbs remaining space in its
    /// parent's main axis proportionally to this value.
    ///
    /// Named `flex` to match the EEAF database format (`"flex": 1`).
    /// serde deserializes `"flex": 1` directly into this field.
    ///
    /// ## Semantics
    /// - `None` or `Some(0.0)`: Node does NOT participate in flex distribution
    /// - `Some(1.0)`: Node takes equal share of remaining space
    /// - `Some(2.0)`: Node takes 2x share relative to flex:1 siblings
    #[serde(deserialize_with = "deserialize_lenient_f64", default)]
    pub flex: Option<f64>,

    /// Flex shrink factor. Controls whether this node shrinks below its
    /// explicit/intrinsic size when siblings need more space.
    ///
    /// ## Semantics
    /// - `None`: Default behavior (shrinkable, per CSS spec default of 1)
    /// - `Some(0.0)`: Node will NOT shrink — keeps its explicit size
    /// - `Some(N)`: Shrink proportionally (higher N = shrinks more)
    #[serde(deserialize_with = "deserialize_lenient_f64", default)]
    pub flex_shrink: Option<f64>,

    /// Visual spacing INSIDE the node (insets its own content/children).
    pub padding: Option<Padding>,

    /// Visual spacing AROUND the node in its parent's flow (space before/after +
    /// cross-axis inset), distinct from `padding` (inside) and the parent's uniform
    /// `layout.gap`. This is what makes per-block spacing a real, per-node DATA
    /// property the user can set to a custom amount (e.g. more room above ONE block)
    /// — honored by the flow place phase, never a hardcoded gap.
    pub margin: Option<Padding>,

    /// Layout behavior
    pub layout: Option<LayoutConfig>,

    /// Extension properties (dynamic/custom)
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Font weight (numeric or named)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(untagged)]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum FontWeight {
    Numeric(f64),
    Named(String),
}

impl Default for FontWeight {
    fn default() -> Self {
        FontWeight::Numeric(400.0)
    }
}

// ============================================================================
// Event Handler Types
// ============================================================================

/// Dispatch FSM handler - triggers FSM event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct DispatchFsmHandler {
    pub event: FSMEvent,
}

/// Event handler types
/// Note: Only FSM dispatch is supported in composition-engine.
/// Action dispatch goes through interaction-engine's trigger system.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(tag = "kind")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum EventHandler {
    #[serde(rename = "DISPATCH_FSM")]
    DispatchFsm(DispatchFsmHandler),
}

/// Event handlers for a node
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct EventHandlers {
    pub pointerdown: Option<Vec<EventHandler>>,
    pub pointerup: Option<Vec<EventHandler>>,
    pub pointermove: Option<Vec<EventHandler>>,
    pub keydown: Option<Vec<EventHandler>>,
    pub keyup: Option<Vec<EventHandler>>,
    pub click: Option<Vec<EventHandler>>,
}

// ============================================================================
// Accessibility Types
// ============================================================================

/// Accessibility properties for a node
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct A11yProps {
    pub role: Option<Role>,
    pub label: Option<String>,
    pub tab_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub states: Option<HashMap<String, bool>>,
}

// ============================================================================
// Node Types
// ============================================================================

/// Node properties
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct NodeProps {
    /// Kernel-facing style (magnitude-only, no tokens)
    pub style: Option<ResolvedStyle>,
    pub text: Option<String>,
    pub src: Option<String>,
    pub handlers: Option<EventHandlers>,
    pub a11y: Option<A11yProps>,
    pub custom: Option<serde_json::Value>,
    /// Opaque ID for component registry lookup (e.g. "ui_component:panel")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_id: Option<String>,
    /// Integrity hash for the compiled bundle bytes.
    ///
    /// This is verification metadata only. It is not the browser fetch key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrity_hash: Option<String>,
    /// Compiled bundle source for Component nodes.
    ///
    /// Browser renderers import this JS source directly. It is the canonical
    /// render input for browser-hosted components.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle: Option<String>,
    /// Opaque instance props passed through to the mounted component.
    ///
    /// The renderer does not inspect these. It forwards them to the
    /// component's default export as-is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_props: Option<serde_json::Value>,
    /// Dependency artifact map for Component nodes.
    ///
    /// Keys are loader-local dependency names requested by the component
    /// artifact. Values are content-addressed artifact identity strings.
    /// The AST treats both sides as opaque data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_dependencies: Option<HashMap<String, String>>,
    /// Ordered exact-byte thing-to-put-on-screen candidates for Component nodes.
    ///
    /// Each value is an opaque shell thing-to-put-on-screen record. The AST preserves the
    /// array without interpreting capability strings, platform names, or
    /// artifact meaning.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub things_to_put_on_screen: Option<Vec<serde_json::Value>>,
    /// Caller-owned authored properties that the layout kernel does not interpret.
    ///
    /// Scene transactions and snapshots must preserve these values, including
    /// explicit nulls. Dropping them at this boundary silently destroys authored
    /// semantics when a host adopts the engine's accepted scene.
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Immutable scene node
/// - No parent pointer (derive from tree position)
/// - No layout property (stored separately in KernelState.layout_frames)
/// - No transform property (computed, not stored)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
#[derive(Default)]
pub struct SceneNode {
    pub id: ID,
    pub kind: NodeKind,
    #[serde(default)]
    pub props: NodeProps,
    /// Children stored as `Arc<SceneNode>` for O(1) structural sharing (Task 168 P1).
    ///
    /// Unchanged subtrees are shared by reference across frames via `Arc::clone()`.
    /// Mutations use path-copying: only the spine from root to changed node is cloned,
    /// all sibling subtrees remain pointer-identical (`Arc::ptr_eq`).
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. `Arc::clone()` is O(1) — ref count bump, no deep copy
    /// 2. `SceneNode::clone()` is O(direct_children) — clones the Vec of Arcs (ref bumps)
    /// 3. Serde: transparent — `Arc<SceneNode>` serializes identically to `SceneNode`
    /// 4. `PartialEq`: compares inner values (deep equality), NOT pointer identity
    /// 5. For pointer identity checks, use `Arc::ptr_eq()`
    #[serde(default)]
    pub children: Vec<Arc<SceneNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z_index: Option<i32>,
    /// Visibility: either a resolved boolean or a binding that needs evaluation.
    ///
    /// Flow:
    /// 1. Projector outputs Visibility (Resolved or Binding)
    /// 2. Kernel compute phase evaluates Binding → Resolved
    /// 3. Host receives only Resolved (booleans)
    ///
    /// Using the Visibility enum provides compile-time type safety (L041/L043).
    #[serde(default)]
    pub visible: Visibility,
    /// Portal owner reference (by ID, not pointer)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portal_owner: Option<ID>,
    /// Style override
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<ResolvedStyle>,
    /// Node-level triggers (from prop:layout:triggers)
    /// These are matched during event processing with parent bubbling.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub triggers: Vec<NodeTrigger>,
    /// Synthetic/pass-through node flag.
    /// True for auto-generated nodes (e.g., text children from shorthand).
    /// Hit-test resolves through synthetic nodes to their parent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub synthetic: bool,
    /// Value for Custom (input) nodes - may be a binding that needs kernel evaluation.
    ///
    /// # Purpose
    ///
    /// Custom nodes (e.g., property inspector inputs) display bound values from the scene.
    /// The `value` field holds either:
    /// 1. A binding AST (pre-compute): `{"$kind": "binding", "select": {...}}`
    /// 2. A resolved value (post-compute): any JSON primitive/object
    ///
    /// # Flow
    ///
    /// 1. Projector creates node with `value` containing a scene/fsm binding
    /// 2. `map_to_nodes` resolves static `$item` refs, preserves runtime-only source
    /// 3. Kernel compute phase evaluates the binding against current scene state
    /// 4. Host receives resolved value (string, number, etc.) and renders it
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. Only Custom nodes should have `value` (other node kinds ignore it)
    /// 2. Bindings are evaluated by compute.rs alongside `visible`, `style`
    /// 3. Post-compute, `value` is always a resolved JSON value, never binding AST
    ///
    /// # AI Assistant Directive
    ///
    /// This field follows the same pattern as `visible`: it can be a binding AST
    /// that gets evaluated during the compute phase. Do not move this to NodeProps
    /// without updating compute.rs which explicitly processes top-level value bindings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    /// Inline FSM configuration owned by THIS node (authored block DATA).
    ///
    /// The generative primitive behind ALL interactive authored blocks (to-do,
    /// toggle list, toggle heading, accordion, tabs, stepper): a node carries its
    /// own finite-state machine, a click handler dispatches a transition to the
    /// node's OWN id (`props.handlers.click = [DispatchFsm{event}]` →
    /// `Effect::DispatchFsmEvent{ target_id: <this node id> }`), and descendant
    /// `visible` bindings read `{from:"fsm", path:<this node id>}` to show/hide
    /// reactively — ZERO per-block engine code.
    ///
    /// # Flow (auto-registration — the primitive that makes this work)
    ///
    /// 1. Authored block DATA carries `fsm` on the owner node.
    /// 2. On scene decode / `InsertNode` / `SetRoot`, the kernel auto-registers
    ///    this config under the node's id (`register_fsm(node.id, node.fsm)`),
    ///    BEFORE the same-frame compute, so first-frame visibility bindings
    ///    resolve. On `RemoveSubtree`, the config is unregistered.
    /// 3. The runtime FSM lookup is UNCHANGED — an absolute-key lookup in
    ///    `ctx.fsm` by node id (the fastest path; resolve-at-insert /
    ///    direct-lookup-at-runtime).
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. The config is keyed by the OWNER node's id — the same id the click
    ///    handler dispatches to and the same id descendant bindings name.
    /// 2. Insert-time self-reference resolution (a `$selfFsm` token in a child
    ///    binding path → the minted owner id) happens in the authoring layer
    ///    (documents `freshIds`), NOT here — the kernel only ever
    ///    sees concrete ids.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fsm: Option<FSMConfig>,
}

impl SceneNode {
    pub fn new(id: impl Into<String>, kind: NodeKind) -> Self {
        Self {
            id: id.into(),
            kind,
            ..Default::default()
        }
    }

    /// Set children, wrapping each in `Arc` for structural sharing (Task 168 P1).
    ///
    /// Convenience method: accepts owned `SceneNode` values and wraps each in
    /// `Arc::new()`. Callers constructing trees in tests or projectors don't need
    /// to manually wrap children — this method handles it.
    ///
    /// For internal use where children are already Arc-wrapped (e.g., path-copying),
    /// set the `children` field directly.
    pub fn with_children(mut self, children: Vec<SceneNode>) -> Self {
        self.children = children.into_iter().map(Arc::new).collect();
        self
    }

    pub fn with_props(mut self, props: NodeProps) -> Self {
        self.props = props;
        self
    }
}

// ============================================================================
// Layout Types
// ============================================================================

/// Layout frame — computed position, placed size, and measured (intrinsic) size for a node.
///
/// # Two Sizes: Measured vs Placed
///
/// `rect` contains the PLACED dimensions — the final position and size after flex
/// stretching, cross-axis expansion, and positioning by the parent layout algorithm.
///
/// `measured_size` contains the MEASURED (intrinsic content) dimensions — what the
/// node's content naturally measures to before the parent applies layout transforms.
///
/// These differ in Flex layout: a Text node measuring 19.2×19.2 may be placed at
/// 96.0×19.2 after cross-axis stretch. Incremental layout relies on `measured_size`
/// to correctly recompute parent content_size when only some siblings are dirty.
/// Using `rect` dimensions as measured sizes causes cascading layout errors.
///
/// # Invariant
///
/// `measured_size` MUST be populated by the layout engine's measure phase.
/// `rect` MUST be populated by the layout engine's place phase.
/// Both represent the SAME node but capture different stages of the layout pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct LayoutFrame {
    pub rect: Rect,
    pub baseline: f64,
    /// Intrinsic content size from the measure phase — BEFORE flex stretching,
    /// cross-axis expansion, or parent-imposed sizing. Used by incremental layout
    /// to correctly recompute content_size for dirty-path containers without
    /// re-walking clean subtrees.
    pub measured_size: Size,
}

impl LayoutFrame {
    /// Create a layout frame where placed size equals measured size.
    ///
    /// Use this for test fixtures and non-flex contexts where the node's
    /// placed dimensions match its intrinsic content measurement.
    pub fn from_rect(rect: Rect) -> Self {
        Self {
            rect,
            baseline: 0.0,
            measured_size: Size::new(rect.w, rect.h),
        }
    }
}

/// Layout constraints for computing child sizes
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct Constraints {
    pub min: Size,
    pub max: Size,
    pub display: Option<DisplayMode>,
    pub direction: Option<FlexDirection>,
    pub align: Option<Alignment>,
    pub justify: Option<Justification>,
    pub gap: Option<f64>,
    pub wrap: Option<bool>,
}

/// Display mode for layout
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum DisplayMode {
    #[default]
    Flex,
    Grid,
    Flow,
    Stack,
}

/// Flex direction
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum FlexDirection {
    #[default]
    Row,
    Column,
}

/// Alignment (cross-axis)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum Alignment {
    #[default]
    Start,
    Center,
    End,
    Stretch,
}

/// Justification (main-axis)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum Justification {
    #[default]
    Start,
    Center,
    End,
    SpaceBetween,
}

// ============================================================================
// Semantic Types
// ============================================================================

/// Semantic properties for accessibility tree
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct SemanticProps {
    pub role: Option<Role>,
    pub label: Option<String>,
    pub tab_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub states: Option<HashMap<String, bool>>,
}

// ============================================================================
// Focus State (Derived, NOT Stored)
// ============================================================================
//
// CRITICAL INVARIANT: FocusState is a DERIVED value computed by helper functions
// (collect_focusable_nodes, collect_tabbable_nodes, etc.) - it is NOT stored state.
//
// The source of truth for "which node is focused" is routing.routes in the kernel.
// This FocusState type is used as a return type for pure helper functions that
// collect focusable/tabbable nodes from the scene tree.
//
// See Task 059: Routing as Focus Source of Truth.

/// Focus scope configuration for trap behavior (modals, dialogs)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct FocusScope {
    pub id: ID,
    pub trap_focus: bool,
    pub roving_tabindex: bool,
}

/// Focus state - a DERIVED value computed by helper functions.
///
/// # CRITICAL INVARIANT
///
/// This is NOT stored state. The source of truth for "which node is focused"
/// is `routing.routes` in the kernel. This type is used as a return type
/// for pure helper functions that collect focusable/tabbable nodes.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct FocusState {
    pub focused_id: Option<ID>,
    pub focusable_nodes: Vec<ID>,
    pub scopes: HashMap<ID, FocusScope>,
    pub tabbable_nodes: Vec<ID>,
}

/// Input event type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum InputEventType {
    Pointer,
    Key,
    Wheel,
    Focus,
    Blur,
    Composition,
}

// ============================================================================
// FSM (Finite State Machine) Types
// ============================================================================

/// FSM event (triggers transitions)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct FSMEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(flatten)]
    pub payload: HashMap<String, serde_json::Value>,
}

impl FSMEvent {
    pub fn new(event_type: impl Into<String>) -> Self {
        Self {
            event_type: event_type.into(),
            payload: HashMap::new(),
        }
    }

    pub fn with_payload(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.payload.insert(key.into(), value);
        self
    }
}

/// FSM state (current state + context)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct FSMState {
    pub value: String,
    pub context: serde_json::Value,
}

impl Default for FSMState {
    fn default() -> Self {
        Self {
            value: String::new(),
            context: serde_json::Value::Object(serde_json::Map::new()),
        }
    }
}

/// FSM transition definition
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct FSMTransition {
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guard: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
}

/// FSM state node definition
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct FSMStateNode {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<Vec<String>>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "deserialize_fsm_on"
    )]
    pub on: Option<HashMap<String, Vec<FSMTransition>>>,
}

/// FSM configuration
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct FSMConfig {
    pub initial: String,
    pub states: HashMap<String, FSMStateNode>,
}

// ============================================================================
// Timeline & Metrics Types
// ============================================================================

/// Frame trace event types
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(tag = "t")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum FrameTraceEvent {
    #[serde(rename = "input")]
    Input { ev: String },
    #[serde(rename = "fsm")]
    Fsm { ev: String },
    #[serde(rename = "context")]
    Context { ev: String },
    #[serde(rename = "layout")]
    Layout,
    #[serde(rename = "scene")]
    Scene,
    #[serde(rename = "semantics")]
    Semantics,
    #[serde(rename = "render")]
    Render,
    #[serde(rename = "undo_begin")]
    UndoBegin { label: Option<String> },
    #[serde(rename = "undo_end")]
    UndoEnd,
}

/// Frame trace (sequence of events in a frame)
pub type FrameTrace = Vec<FrameTraceEvent>;

/// Frame metrics for performance monitoring
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct FrameMetrics {
    pub frame_count: u64,
    pub total_time: f64,
    pub phase_timings: HashMap<Phase, Vec<f64>>,
    pub dropped_frames: u64,
}

// ============================================================================
// Text Types
// ============================================================================

/// Text selection range with BYTE indices.
///
/// # Critical: Index Semantics
///
/// **All indices are BYTE offsets into UTF-8 strings, NOT character indices.**
///
/// This matches Rust's native `str` indexing semantics. Indices MUST be on
/// valid UTF-8 character boundaries or string slicing will panic.
///
/// # Converting from Character Indices
///
/// Use `text.char_indices()` to convert character positions to byte indices:
/// ```ignore
/// let byte_idx = text.char_indices().nth(char_idx).map(|(i, _)| i).unwrap_or(text.len());
/// ```
///
/// # Non-Negotiable Invariants
///
/// 1. `start` and `end` MUST be valid byte indices into the target string
/// 2. `start` and `end` MUST be on UTF-8 character boundaries
/// 3. `start <= end` for a valid forward selection
/// 4. Indices beyond string length are clamped, not panicked
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct TextRange {
    /// Byte offset of selection start (inclusive)
    pub start: usize,
    /// Byte offset of selection end (exclusive)
    pub end: usize,
}

impl TextRange {
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    pub fn is_collapsed(&self) -> bool {
        self.start == self.end
    }

    pub fn length(&self) -> usize {
        self.end.saturating_sub(self.start)
    }
}

/// Composition state (for IME input)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct ComposingState {
    pub range: TextRange,
    pub text: String,
}

/// Opaque text mark identifier — the kernel has ZERO knowledge of what mark names mean.
/// "bold", "italic", "custom-highlight" are Society data from EEAF.
/// The kernel stores, propagates, and emits mark names generically.
///
/// # Invariants
///
/// 1. Mark names are opaque strings — kernel never interprets them
/// 2. Mark names come from EEAF configuration, not hardcoded in code
/// 3. The kernel treats all mark names identically regardless of content
/// 4. Society-level semantics (CSS classes, visual styling) are defined in EEAF data
///
/// # Examples
///
/// Valid mark names: "bold", "italic", "code", "custom-highlight", "red-bg"
/// The kernel does not validate or constrain mark names.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct TextMark(pub String);

/// A mark applied to a byte range within a text buffer.
/// Start and end are byte offsets (same as TextRange).
///
/// # Invariants
///
/// 1. Both start and end are byte offsets into UTF-8 strings
/// 2. start <= end (marks can be zero-width at positions)
/// 3. Both offsets must be on valid UTF-8 character boundaries
/// 4. Multiple marks can overlap on the same text (e.g., "bold" AND "italic")
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct MarkRange {
    pub mark: TextMark,
    pub start: usize, // byte offset
    pub end: usize,   // byte offset
}

/// Text buffer state
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct TextBufferState {
    pub text: String,
    pub selection: TextRange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composing: Option<ComposingState>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub marks: Vec<MarkRange>,
}

// ============================================================================
// Text Input Configuration (Task 069: Text Kernel State Registry)
// ============================================================================

/// Default keyboard type for text input
fn default_keyboard_type() -> String {
    "text".to_string()
}

/// Configuration for text input from database (prop:kernel:text).
///
/// # Invariants
///
/// 1. `editable: true` required to create a text buffer
/// 2. `editable: false` means display-only (no buffer)
/// 3. Kernel passes through keyboard_type without interpretation
///
/// # Database Format
///
/// ```json
/// {
///   "editable": true,
///   "multiline": false,
///   "secure": false,
///   "keyboard_type": "email",
///   "placeholder": "Enter email..."
/// }
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct TextInputConfig {
    /// Whether the text is editable (required for buffer creation)
    pub editable: bool,
    /// Whether to allow multiple lines (textarea vs input)
    #[serde(default)]
    pub multiline: bool,
    /// Whether to mask the text (password mode)
    #[serde(default)]
    pub secure: bool,
    /// Keyboard type hint for mobile platforms
    #[serde(default = "default_keyboard_type")]
    pub keyboard_type: String,
    /// Placeholder text when buffer is empty
    #[serde(default)]
    pub placeholder: Option<String>,
}

impl Default for TextInputConfig {
    fn default() -> Self {
        Self {
            editable: false,
            multiline: false,
            secure: false,
            keyboard_type: default_keyboard_type(),
            placeholder: None,
        }
    }
}

/// Capability exposed in snapshot for host rendering.
///
/// If a node has this capability, the host renders a native text input.
///
/// # Flow (Task 168 P3: Flat Side-Map)
///
/// ```text
/// Database: prop:kernel:text = { "editable": true, ... }
///     ↓
/// Kernel: text_buffers[node_id] = TextBufferState  (canonical truth)
///     ↓
/// Snapshot: text_inputs[node_id] = TextInputCapability  (flat side-map)
///     ↓
/// Host: if (snapshot.text_inputs[node_id]) → render native input
/// ```
///
/// # Invariants
///
/// 1. Capability existence signals native input requirement
/// 2. `value` is the current buffer text (source of truth)
/// 3. `selection` is the cursor/selection state
/// 4. Platform mapping (keyboard_type → inputMode) happens in host
/// 5. Lives in SceneSnapshot.text_inputs (flat HashMap), NOT on SceneNode
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct TextInputCapability {
    /// Current text value from the buffer
    pub value: String,
    /// Current selection/cursor position
    pub selection: TextRange,
    /// Whether to mask text (password mode)
    pub secure: bool,
    /// Whether multiline is allowed (textarea vs input)
    pub multiline: bool,
    /// Keyboard type hint (passed through to host)
    pub keyboard_type: String,
    /// Placeholder text (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// Original field input type from projector (e.g., "spacing", "color", "select",
    /// "trigger", "action_list", "border", "dimension", "text", "number").
    /// Host uses this to route to specialized field renderers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_type: Option<String>,
}

// ============================================================================
// Effect Types (Side-Effect Contract)
// ============================================================================

/// Effects returned by tick() for the host to execute
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(tag = "type")]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum Effect {
    #[serde(rename = "DISPATCH_ACTION")]
    DispatchAction {
        target_id: ID,
        dispatch: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        params: Option<HashMap<String, serde_json::Value>>,
    },
    #[serde(rename = "DISPATCH_FSM_EVENT")]
    DispatchFsmEvent { target_id: ID, event: FSMEvent },
    /// Execute an action from a recipe trigger
    /// Unlike DispatchAction (which comes from node handlers),
    /// ExecuteAction comes from recipe-driven trigger matching.
    #[serde(rename = "EXECUTE_ACTION")]
    ExecuteAction {
        /// ID of the trigger that matched
        trigger_id: ID,
        /// Target node that received the input
        target_id: Option<ID>,
        /// Action type from recipe
        action: String,
        /// Action parameters
        #[serde(skip_serializing_if = "Option::is_none")]
        params: Option<HashMap<String, serde_json::Value>>,
        /// Context from the matched input event
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<TriggerContext>,
    },
}

// ============================================================================
// Node-Level Triggers (from prop:layout:triggers)
// ============================================================================

/// A trigger attached to a scene node.
/// Format from database: {"query": {"event": "click"}, "action_ref": "action:...", "payload": {...}}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct NodeTrigger {
    /// Query to match (simplified format: {"event": "click"} or {"event": "pointerdown"})
    pub query: NodeTriggerQuery,
    /// Action to execute when trigger matches
    pub action_ref: String,
    /// Payload to pass to the action
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

/// Simple query format for node-level triggers
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct NodeTriggerQuery {
    /// Event type to match (e.g., "click", "pointerdown", "pointerup")
    pub event: String,
}

impl NodeTrigger {
    /// Check if this trigger matches the given event subtype
    pub fn matches(&self, event_subtype: &str) -> bool {
        self.query.event == event_subtype
    }
}

// ============================================================================
// Trigger Context (for Effect::ExecuteAction)
// ============================================================================

/// Context from the matched input event, passed with ExecuteAction effects
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct TriggerContext {
    /// Event type that triggered
    pub event_type: InputEventType,
    /// Event subtype (e.g., "pointerdown", "keydown")
    pub event_subtype: String,
    /// Target node ID
    pub target_id: Option<ID>,
    /// Timestamp of the event
    pub timestamp: f64,
    /// Position for pointer events
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Point>,
    /// Key for keyboard events
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Original event data (for advanced use)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

// ============================================================================
// Ephemeral Action Types (Task 175 Agent 3)
// ============================================================================

/// Ephemeral action definition stored in the kernel.
///
/// Contains only the workflow steps needed for direct execution inside the
/// kernel — no `_transact` steps (no database writes). When a trigger matches
/// an action registered here, the kernel executes it directly instead of
/// emitting an Effect for the host, eliminating four WASM boundary crossings
/// (Host → workflow-wasm → JS extern → Host → composition-engine-wasm → kernel).
///
/// # Non-Negotiable Invariants
///
/// 1. **Only ephemeral steps** — SetRoute, ClearRoute, DispatchFsm, SetState.
///    Persistent actions (with `_transact`) are NOT registered here.
/// 2. **Registered at init** — populated from workflow-wasm's action cache
///    after all action definitions are loaded.
/// 3. **Immutable after registration** — actions don't change during a session.
///
/// # Performance
///
/// Before: trigger match → Effect → host → workflow-wasm → JS extern → host → kernel
/// After: trigger match → direct kernel function call. O(steps) with zero boundary crossings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct EphemeralAction {
    /// Action identifier (e.g., "action:focusNode", "action:toggle_edit_mode")
    pub id: String,
    /// Ordered steps to execute inside the kernel
    pub steps: Vec<EphemeralStep>,
}

/// A single step in an ephemeral action.
///
/// Each variant maps to an existing kernel method:
/// - `SetRoute` → `kernel.set_route()`
/// - `ClearRoute` → `kernel.set_route(origin, None)`
/// - `DispatchFsm` → `kernel.dispatch_fsm_event_str()`
/// - `SetState` → `kernel.set_state()`
///
/// Templates use `{{input.field}}` syntax for dynamic value resolution
/// from the trigger's input context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum EphemeralStep {
    /// Set routing target: maps an origin to a target node.
    /// `target_template` supports `{{input.target_id}}` resolution.
    SetRoute {
        origin: String,
        target_template: String,
    },
    /// Clear routing for an origin (deselect/unfocus).
    ClearRoute { origin: String },
    /// Dispatch an FSM event to trigger a state transition.
    DispatchFsm { fsm_id: String, event: String },
    /// Set transient kernel state.
    /// `value_template` supports `{{input.field}}` resolution within JSON values.
    SetState {
        key: String,
        value_template: serde_json::Value,
    },
    /// Adjust the canvas camera position and zoom.
    /// Template strings support `{{input.field}}` resolution for dynamic deltas.
    /// Deltas are added to current camera values (pan_x, pan_y) or multiplied (zoom).
    SetCamera {
        pan_x_delta_template: String,
        pan_y_delta_template: String,
        zoom_delta_template: String,
    },
    /// Center the camera on a target node (navigate / "Go to a page" / link-to-page).
    ///
    /// Resolves the target node's computed layout frame (world space) and sets the
    /// camera so that frame's center lands at the viewport center, keeping the
    /// current zoom. Unlike `SetCamera` (relative deltas), this is ABSOLUTE-to-node
    /// — the generative primitive behind `action:navigate`: a click trigger carries
    /// `payload.target` (a node id resolved at author-time), which flows into
    /// `{{input.target}}` here. In-kernel, zero round-trips (the kernel already owns
    /// camera + layout_frames + viewport). A missing/unlaid target is a safe no-op.
    CenterOnNode { node_id_template: String },
}

// ============================================================================
// Authoring/Blueprint Types
// ============================================================================

/// Canonical node (authoring format, before normalization)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct CanonicalNode {
    pub id: ID,
    pub kind: NodeKind,
    pub props: NodeProps,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<CanonicalNode>>,
}

/// Scene initialization data
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct SceneInit {
    pub root: CanonicalNode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewport: Option<Size>,
}

// ============================================================================
// Evaluation Context (for Binding Resolution)
// ============================================================================

/// Context for binding evaluation - the canonical input to all binding resolution.
///
/// # Purpose
///
/// Provides all data sources needed for binding evaluation. This is the single
/// source of truth for all context data during the compute phase.
///
/// # Non-Negotiable Invariants
///
/// 1. **Routing is first-class**: `routing` is a SEPARATE field, NOT nested in ambient.
///    This enables type-safe routing queries via `SelectSource::Routing`.
/// 2. **Ambient is host-injected only**: The `ambient` field contains values injected
///    by the host (e.g., `session_text_origin`), NOT kernel-derived data.
/// 3. **No duplication**: Each data source has ONE representation. No DRY violations.
/// 4. **Deterministic**: Same inputs produce identical context every time.
///
/// # Key Concepts
///
/// | Field | Source | Example |
/// |-------|--------|---------|
/// | `ambient` | Host-injected values | `{ "session_text_origin": "seat1:text_edit" }` |
/// | `routing` | Kernel routing state | `{ "seat1:text_edit": "node123" }` |
/// | `fsm` | FSM current states | `{ "fsm:editor:mode": "edit" }` |
/// | `vars` | Per-node variables | Node-specific data |
/// | `data_sources` | External data | Query results, etc. |
///
/// # Security Considerations
///
/// - All fields are read-only snapshots of kernel state
/// - No mutation of kernel state through context
/// - Bindings cannot modify routing or FSM state
///
/// # AI Assistant Directive
///
/// The separation of `routing` from `ambient` is a critical 1000x architecture decision.
/// You are FORBIDDEN from nesting routing inside ambient. Maintain this separation.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct EvaluationContext {
    /// Host-injected ambient values (e.g., session_text_origin).
    /// Does NOT contain routing - routing is a separate first-class field.
    pub ambient: serde_json::Value,
    /// Per-node variables bag.
    pub vars: serde_json::Value,
    /// External data sources (query results, etc.).
    pub data_sources: serde_json::Value,
    /// FSM current states (e.g., { "fsm:editor:mode": "edit" }).
    pub fsm: serde_json::Value,
    /// Routing state - maps origin IDs to target node IDs.
    ///
    /// # 1000x Architecture
    ///
    /// This is a FIRST-CLASS field, not nested inside ambient.
    /// - Key: Origin ID (e.g., "seat1:text_edit", "pointer:0", "neuralink:bci")
    /// - Value: Target node ID (e.g., "node:text-input-1")
    ///
    /// Bindings query via `SelectSource::Routing` with static or dynamic keys:
    /// ```json
    /// { "from": "routing", "key": { "$kind": "binding", "select": { "from": "ambient", "path": "session_text_origin" } } }
    /// ```
    #[serde(default)]
    pub routing: std::collections::HashMap<String, String>,
    /// Kernel state - ephemeral state available during binding evaluation.
    ///
    /// # Examples
    ///
    /// - `selected_node`: The currently focused/selected node ID
    /// - `focused_element`: The element with keyboard focus
    ///
    /// Bindings query via `SelectSource::State` with path:
    /// ```json
    /// { "from": "state", "path": "selected_node" }
    /// ```
    #[serde(default)]
    pub state: std::collections::HashMap<String, serde_json::Value>,
}
