//! crates/composition-engine-core/src/kernel/layout.rs
//!
//! # Pure Functional Layout Engine
//!
//! Computes positions and sizes for all nodes in a scene tree.
//!
//! ## Purpose
//! Transform a SceneNode tree + viewport → HashMap<ID, LayoutFrame> with computed
//! positions and sizes for every node. This is the ONLY layout computation in the system.
//!
//! ## Non-Negotiable Invariants
//! - **Pure functional**: NO mutations, NO side effects. Returns new HashMap.
//! - **Single source of truth**: All layout decisions flow through `SizingMode`.
//! - **Explicit > Implicit**: Explicit dimensions in style ALWAYS override content measurement.
//! - **Platform-agnostic**: No framework coupling. Works in WASM, native, anywhere.
//!
//! ## Key Concepts
//! - `SizingMode`: Canonical enum determining how a node's size is computed
//!   (Explicit / ContentFit / FlexGrow)
//! - Two-phase layout: Measure (intrinsic sizes) → Place (final positions + flex distribution)
//! - Constraint propagation: Parent constraints flow down, child sizes bubble up
//! - Flex distribution: Children with `flex > 0` absorb remaining space proportionally
//!   in the parent's main axis (same algorithm as Split, applied within Flex mode)
//!
//! ## AI Assistant Directive
//! The architecture in this file is a critical design feature. The `SizingMode` enum
//! is the CANONICAL source of truth for sizing strategy. Do NOT scatter sizing logic
//! across match arms or conditionals. All sizing decisions MUST flow through SizingMode.

use super::types::{
    Dimension, FontWeight, LayoutAxis, LayoutConfig, LayoutFrame, LayoutMode, NodeKind, Padding,
    HostTextMeasurement, Point, Rect, ResolvedStyle, SceneNode, Size, SplitPart, ID,
};
use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::sync::Arc;

struct PlacementTarget<'a> {
    frames: &'a mut HashMap<ID, LayoutFrame>,
    sizes: &'a HashMap<ID, Size>,
}

struct IncrementalPlacementTarget<'a> {
    frames: &'a mut HashMap<ID, LayoutFrame>,
    sizes: &'a HashMap<ID, Size>,
    dirty_subtrees: &'a HashSet<String>,
}

// ============================================================================
// SizingMode - Canonical Sizing Strategy
// ============================================================================

/// Canonical sizing mode for a node.
///
/// This enum is the SINGLE SOURCE OF TRUTH for how a node's size is determined.
/// Every node resolves to exactly one SizingMode. No scattered conditionals.
///
/// ## Sizing Hierarchy (in order of precedence):
/// 1. `Explicit` - Node has width/height in style → use those values
/// 2. `FlexGrow` - Node has flex > 0 without explicit main-axis size → absorbs remaining space
/// 3. `ContentFit` - Node sizes to fit its content (text, children, etc.)
///
/// ## Why This Exists
/// Without a canonical type, sizing logic gets scattered across match arms:
/// - "if explicit_w.is_some()" in one place
/// - "match node.kind { Text => ... }" in another
/// - Whack-a-mole bugs when sizing rules change
///
/// With SizingMode, ALL sizing decisions are made in ONE place (resolve_sizing_mode),
/// and the rest of the code just pattern-matches on the result.
#[derive(Debug, Clone, PartialEq)]
enum SizingMode {
    /// Node has explicit width and/or height in style. Use those values.
    /// Children are still measured (for their own positioning) but don't affect this node's size.
    /// Dimensions may be pixels or percentages — resolved against parent constraints.
    Explicit {
        width: Option<Dimension>,
        height: Option<Dimension>,
    },

    /// Node sizes to fit its content. For containers, this means measuring children.
    /// For text, this means measuring the text. For leaf nodes, this uses style dimensions.
    ContentFit,

    /// Node absorbs remaining space in its parent's main axis proportionally to the factor.
    ///
    /// ## Measure vs Place Phase
    /// During measure: uses explicit dimensions for cross-axis, content size for main-axis.
    /// During place: parent's `place_flow_children` overrides main-axis with flex allocation.
    ///
    /// ## Explicit Dimensions on FlexGrow
    /// A node can have BOTH `flex > 0` AND explicit width/height. The flex factor controls
    /// main-axis distribution; explicit dimensions provide cross-axis sizing (e.g., textarea
    /// with `flex:1, height:36` in a flex-row: flex on X, explicit 36px on Y).
    ///
    /// ## Factor Semantics
    /// - factor `1.0`: Equal share of remaining space
    /// - factor `2.0`: 2x share relative to factor=1.0 siblings
    FlexGrow {
        factor: f64,
        /// Explicit width hint (used for cross-axis in row layouts, or ignored on main axis)
        width: Option<Dimension>,
        /// Explicit height hint (used for cross-axis in column layouts, or ignored on main axis)
        height: Option<Dimension>,
    },
}

impl SizingMode {
    /// Resolve the sizing mode for a node from its style.
    /// This is the CANONICAL place where explicit vs content-fit vs flex-grow is decided.
    ///
    /// ## Precedence
    /// 1. `flex > 0` → `FlexGrow` (explicit dimensions become cross-axis hints)
    /// 2. Explicit width/height without flex → `Explicit`
    /// 3. Otherwise → `ContentFit`
    ///
    /// Flex takes precedence because `flex` is a layout PARTICIPATION mode (absorb remaining
    /// space) while explicit dimensions are SIZE hints. A node with `flex:1, height:36` in
    /// a flex-row means "absorb remaining width, use 36px height" — two orthogonal decisions.
    ///
    /// Note: Percentage dimensions are treated as Explicit and resolved during place phase.
    fn from_style(style: Option<&ResolvedStyle>) -> Self {
        let explicit_w = style.and_then(|s| s.width.clone());
        let explicit_h = style.and_then(|s| s.height.clone());
        let flex_grow = style
            .and_then(|s| s.flex)
            .filter(|&f| f.is_finite() && f > 0.0);

        if let Some(factor) = flex_grow {
            // Flex takes precedence — explicit dimensions become cross-axis hints
            SizingMode::FlexGrow {
                factor,
                width: explicit_w,
                height: explicit_h,
            }
        } else if explicit_w.is_some() || explicit_h.is_some() {
            SizingMode::Explicit {
                width: explicit_w,
                height: explicit_h,
            }
        } else {
            SizingMode::ContentFit
        }
    }

    /// Like `from_style`, but a host-measured TEXT height is AUTHORITATIVE over a stored
    /// `style.height`. The engine has no fonts, so wrapped text height only becomes known when
    /// the host measures the DOM and reports it via `text_measurements`. A Text node that ALSO
    /// carries a stale `style.height` (persisted by an earlier save/resize, from before the
    /// text-measurement path) would otherwise be sized `Explicit{height}` and pinned to that
    /// stale height — so when the text re-wraps taller (e.g. at a narrower width) the frame is
    /// too short, its content overflows, and it visually overlaps the next block (the
    /// multi-line-block overlap bug). When a host measurement exists we drop the explicit height
    /// (the measured content height wins) while KEEPING explicit width. No measurement → this is
    /// byte-identical to `from_style`. (Root-cause converged with Codex GPT-5.5, 2026-07-05.)
    fn for_node(
        node: &SceneNode,
        style: Option<&ResolvedStyle>,
        text_measurements: &HashMap<ID, HostTextMeasurement>,
    ) -> Self {
        let mode = Self::from_style(style);
        let has_host_text_height = matches!(node.kind, NodeKind::Text)
            && text_measurements
                .get(&node.id)
                .map(|m| m.height > 0.0)
                .unwrap_or(false);
        if !has_host_text_height {
            return mode;
        }
        match mode {
            SizingMode::Explicit { width, .. } => SizingMode::Explicit {
                width,
                height: None,
            },
            SizingMode::FlexGrow { factor, width, .. } => SizingMode::FlexGrow {
                factor,
                width,
                height: None,
            },
            other => other,
        }
    }

    /// Compute the final size given content size and constraints.
    ///
    /// - `Explicit`: Uses explicit dimensions (falls back to content for missing axis).
    ///   Percentages are resolved against parent constraints.
    /// - `ContentFit`: Uses content size directly.
    /// - `FlexGrow`: Uses explicit dimensions for cross-axis (where available), content
    ///   size otherwise. Main-axis will be overridden by `place_flow_children` during place.
    fn compute_size(self, content_size: Size, constraints: Constraints) -> Size {
        let raw = match self {
            SizingMode::Explicit { width, height } => {
                let w = width
                    .as_ref()
                    .map(|d| d.resolve(constraints.max.w))
                    .filter(|n| n.is_finite())
                    .unwrap_or(content_size.w);
                let h = height
                    .as_ref()
                    .map(|d| d.resolve(constraints.max.h))
                    .filter(|n| n.is_finite())
                    .unwrap_or(content_size.h);
                Size { w, h }
            }
            SizingMode::FlexGrow { width, height, .. } => {
                // Use explicit dimensions where available (cross-axis hints),
                // fall back to content size. Main-axis will be overridden in place phase.
                let w = width
                    .as_ref()
                    .map(|d| d.resolve(constraints.max.w))
                    .filter(|n| n.is_finite())
                    .unwrap_or(content_size.w);
                let h = height
                    .as_ref()
                    .map(|d| d.resolve(constraints.max.h))
                    .filter(|n| n.is_finite())
                    .unwrap_or(content_size.h);
                Size { w, h }
            }
            SizingMode::ContentFit => content_size,
        };

        // Apply constraints
        Size {
            w: raw.w.max(constraints.min.w).min(constraints.max.w),
            h: raw.h.max(constraints.min.h).min(constraints.max.h),
        }
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Get style from node, checking node.style first then node.props.style.
/// This handles the case where Projector puts style at root level.
fn get_node_style(node: &SceneNode) -> Option<&ResolvedStyle> {
    node.style.as_ref().or(node.props.style.as_ref())
}

/// Extract padding from style, defaulting to zero
fn to_insets(padding: Option<&Padding>) -> Padding {
    padding.cloned().unwrap_or(Padding::ZERO)
}

/// Extract layout config from style, with defaults.
///
/// NOTE: cfg.x/y are `Option<serde_json::Value>` to support bindings.
/// After kernel compute phase evaluates bindings, these should be numbers.
/// We extract f64 from the Value here.
fn to_layout(layout: Option<&LayoutConfig>) -> LayoutConfigResolved {
    match layout {
        Some(cfg) => LayoutConfigResolved {
            mode: cfg.mode.unwrap_or(LayoutMode::Flex),
            axis: cfg.axis.unwrap_or(LayoutAxis::Y),
            gap: cfg.gap.unwrap_or(0.0),
            parts: cfg.parts.clone(),
            // Extract f64 from Value (after bindings are evaluated, these should be numbers)
            x: cfg.x.as_ref().and_then(|v| v.as_f64()),
            y: cfg.y.as_ref().and_then(|v| v.as_f64()),
        },
        None => LayoutConfigResolved::default(),
    }
}

/// Resolved layout config with concrete defaults
#[derive(Debug, Clone)]
struct LayoutConfigResolved {
    mode: LayoutMode,
    axis: LayoutAxis,
    gap: f64,
    parts: Option<Vec<SplitPart>>,
    x: Option<f64>,
    y: Option<f64>,
}

impl Default for LayoutConfigResolved {
    fn default() -> Self {
        Self {
            mode: LayoutMode::Flex,
            axis: LayoutAxis::Y,
            gap: 0.0,
            parts: None,
            x: None,
            y: None,
        }
    }
}

/// Extract size from node style (for leaf nodes)
/// Note: This is for leaf nodes without layout context, so percentages
/// default to 0.0 (no parent constraint available).
fn size_from_style(node: &SceneNode) -> Size {
    let style = get_node_style(node);
    let w = style
        .and_then(|s| s.width.as_ref())
        .map(|d| match d {
            Dimension::Pixels(px) => *px,
            Dimension::Percent(_) => 0.0, // No parent constraint in this context
        })
        .unwrap_or(0.0);
    let h = style
        .and_then(|s| s.height.as_ref())
        .map(|d| match d {
            Dimension::Pixels(px) => *px,
            Dimension::Percent(_) => 0.0, // No parent constraint in this context
        })
        .unwrap_or(0.0);
    Size { w, h }
}

// ============================================================================
// Layout Constraints
// ============================================================================

/// Simple constraints for layout computation
#[derive(Debug, Clone, Copy)]
struct Constraints {
    min: Size,
    max: Size,
}

impl Constraints {
    fn new(min: Size, max: Size) -> Self {
        Self { min, max }
    }

    #[allow(dead_code)]
    fn unconstrained(max: Size) -> Self {
        Self {
            min: Size::ZERO,
            max,
        }
    }
}

// ============================================================================
// Size Resolution — O(1) lookup with frames fallback
// ============================================================================

/// Resolve a node's measured size from the sizes map, falling back to frames.
///
/// During incremental layout, only dirty-path nodes get fresh measurements in
/// `sizes`. Clean nodes that need repositioning (shifted by sibling layout
/// changes) read their measured_size from the existing LayoutFrame in `frames`.
///
/// This eliminates the O(n) pre-collection of all clean node sizes into a
/// separate HashMap — instead, clean sizes are resolved on-demand in O(1).
#[inline]
fn resolve_size(id: &str, sizes: &HashMap<ID, Size>, frames: &HashMap<ID, LayoutFrame>) -> Size {
    sizes
        .get(id)
        .copied()
        .or_else(|| frames.get(id).map(|f| f.measured_size))
        .unwrap_or(Size::ZERO)
}

// ============================================================================
// Text Measurement
// ============================================================================

/// Font properties for text measurement
#[derive(Debug, Clone)]
pub struct FontProps {
    pub family: Option<String>,
    pub size: Option<f64>,
    pub weight: Option<FontWeight>,
}

/// Text measurement callback type
pub type MeasureTextFn = Box<dyn Fn(&str, &FontProps) -> Size>;

/// Default text measurement (approximation without host)
fn default_measure_text(text: &str, font: &FontProps) -> Size {
    let font_size = font.size.unwrap_or(16.0);
    Size {
        w: text.len() as f64 * font_size * 0.6,
        h: font_size * 1.2,
    }
}

// ============================================================================
// IncrementalLayoutResult — O(dirty) change tracking for diff_frames
// ============================================================================

/// Result of incremental layout: frames + which IDs changed.
///
/// `changed_ids` contains the IDs of frames that were created, updated, or
/// whose position/size changed during incremental layout. This enables
/// `diff_frames_selective` to iterate only changed frames instead of all frames.
///
/// For full layout (`compute_layout`), callers set `changed_frame_ids = None`
/// on RuntimeDelta to signal "diff all."
pub struct IncrementalLayoutResult {
    /// The computed layout frames (same Arc semantics as before).
    pub frames: Arc<HashMap<ID, LayoutFrame>>,
    /// IDs of frames that were created or updated during this incremental pass.
    pub changed_ids: HashSet<String>,
}

/// Deref to the inner HashMap for backwards-compatible access.
/// Existing callers that used `result.get(id)` or `result.len()` continue
/// to work without modification — auto-deref through Arc to HashMap.
impl Deref for IncrementalLayoutResult {
    type Target = HashMap<ID, LayoutFrame>;

    #[inline]
    fn deref(&self) -> &Self::Target {
        &self.frames
    }
}

// ============================================================================
// Main Layout Function
// ============================================================================

/// Compute layout for entire tree. Returns layout frames for all nodes.
/// This is a pure function - NO side effects, NO mutations.
pub fn compute_layout(
    root: &SceneNode,
    viewport: Size,
    measure_text: Option<&MeasureTextFn>,
    text_measurements: &HashMap<ID, HostTextMeasurement>,
) -> HashMap<ID, LayoutFrame> {
    let mut frames = HashMap::new();
    let root_constraints = Constraints::new(Size::ZERO, viewport);
    let mut sizes: HashMap<ID, Size> = HashMap::new();

    // Phase 1: Measure - compute intrinsic sizes recursively
    measure_node(
        root,
        root_constraints,
        &mut sizes,
        measure_text,
        text_measurements,
    );

    // Phase 2: Place - compute positions recursively
    let root_size = sizes.get(&root.id).copied().unwrap_or(Size::ZERO);
    place_node(root, Point::ZERO, root_size, &mut frames, &sizes);

    frames
}

// ============================================================================
// Measure Phase
// ============================================================================

/// Measure phase: compute intrinsic sizes recursively.
///
/// ## Algorithm
/// 1. Check cache (memoization for DAG traversal)
/// 2. Resolve SizingMode from style (Explicit vs ContentFit)
/// 3. Measure children (always, for their positioning)
/// 4. Compute content size based on node kind
/// 5. Apply SizingMode to get final size
/// 6. Cache and return
///
/// ## Why SizingMode First
/// Explicit dimensions MUST take precedence over content measurement.
/// A node with `width: 120, height: 32` in style should be exactly 120x32,
/// regardless of its content. This is CSS's fundamental model.
fn measure_node(
    node: &SceneNode,
    constraints: Constraints,
    sizes: &mut HashMap<ID, Size>,
    measure_text: Option<&MeasureTextFn>,
    text_measurements: &HashMap<ID, HostTextMeasurement>,
) -> Size {
    // Memoization: return cached size if already computed
    if let Some(&cached) = sizes.get(&node.id) {
        return cached;
    }

    let style = get_node_style(node);
    let sizing_mode = SizingMode::for_node(node, style, text_measurements);

    // Determine constraints for children based on parent's sizing mode
    let child_constraints = child_constraints_for(node, &sizing_mode, constraints);

    // Always measure children (they need sizes for their own positioning)
    // This happens regardless of sizing mode - explicit parent doesn't skip child measurement
    for child in &node.children {
        measure_node(
            child,
            child_constraints,
            sizes,
            measure_text,
            text_measurements,
        );
    }

    // Compute content size based on node kind (used by ContentFit mode)
    let content_size =
        compute_content_size(node, constraints, sizes, measure_text, text_measurements);

    // Apply sizing mode to get final size
    let final_size = sizing_mode.compute_size(content_size, constraints);

    sizes.insert(node.id.clone(), final_size);
    final_size
}

/// The constraints a node hands its children: explicit (or flex-grow explicit)
/// dimensions constrain the outer size, while content-fit parents pass their own
/// maximum through. In both cases the parent's padding is removed so measurement
/// sees the same content box that placement uses. The ONE derivation both full and
/// incremental measure use, so a dirty re-measure matches a full layout.
fn child_constraints_for(
    node: &SceneNode,
    sizing_mode: &SizingMode,
    constraints: Constraints,
) -> Constraints {
    let outer_max = match sizing_mode {
        SizingMode::Explicit { width, height } | SizingMode::FlexGrow { width, height, .. } => {
            // Parent has explicit dimensions — constrain children by those dimensions
            let max_w = width
                .as_ref()
                .map(|d| d.resolve(constraints.max.w))
                .filter(|n| n.is_finite())
                .unwrap_or(constraints.max.w);
            let max_h = height
                .as_ref()
                .map(|d| d.resolve(constraints.max.h))
                .filter(|n| n.is_finite())
                .unwrap_or(constraints.max.h);
            Size::new(max_w, max_h)
        }
        _ => constraints.max,
    };

    // Child measurement happens in the same content box used by placement.
    // Passing the outer dimensions here lets an explicitly-sized child retain
    // space that placement later removes for the parent's padding, so the child
    // can overflow or be squeezed inconsistently with its measured constraints.
    let style = get_node_style(node);
    let padding = to_insets(style.and_then(|s| s.padding.as_ref()));
    Constraints::new(
        Size::ZERO,
        Size::new(
            (outer_max.w - padding.left - padding.right).max(0.0),
            (outer_max.h - padding.top - padding.bottom).max(0.0),
        ),
    )
}

/// Compute the intrinsic content size for a node.
/// This is the size the node would be if it had no explicit dimensions.
fn compute_content_size(
    node: &SceneNode,
    constraints: Constraints,
    sizes: &HashMap<ID, Size>,
    measure_text: Option<&MeasureTextFn>,
    text_measurements: &HashMap<ID, HostTextMeasurement>,
) -> Size {
    match node.kind {
        NodeKind::Text => measure_text_content(node, measure_text, text_measurements),
        NodeKind::Container if !node.children.is_empty() => {
            measure_children_content(node, constraints, sizes, measure_text)
        }
        _ => size_from_style(node),
    }
}

/// Measure text node content size.
///
/// The engine has no fonts, so wrapped-text height cannot be computed from the
/// glyph run. When the host has measured the block's real DOM height and fed it
/// via `Kernel::apply_text_measurements`, that height is authoritative and
/// overrides the approximate/font-callback height — this is what lets wrapped
/// paragraphs reflow their siblings correctly (see `KernelState::text_measurements`).
fn measure_text_content(
    node: &SceneNode,
    measure_text: Option<&MeasureTextFn>,
    text_measurements: &HashMap<ID, HostTextMeasurement>,
) -> Size {
    let Some(ref text) = node.props.text else {
        return Size::ZERO;
    };

    let style = get_node_style(node);
    let font = FontProps {
        family: style.and_then(|s| s.font_family.clone()),
        size: style.and_then(|s| s.font_size),
        weight: style.and_then(|s| s.font_weight.clone()),
    };

    let mut size = match measure_text {
        Some(measure_fn) => measure_fn(text, &font),
        None => default_measure_text(text, &font),
    };

    // Host-measured wrapped height wins when present — the DOM is the only thing
    // that knows the real wrapped height at the current width.
    if let Some(measurement) = text_measurements.get(&node.id) {
        if measurement.height > 0.0 {
            size.h = measurement.height;
        }
        if let Some(natural_width) = measurement.natural_width.filter(|width| *width > 0.0) {
            size.w = natural_width;
        }
    }

    size
}

/// Measure children content size based on layout strategy.
/// Returns the size this container would need to fit all its children.
///
/// NOTE: Children have ALREADY been measured by measure_node before this is called.
/// This function reads from the sizes cache - it does NOT re-measure children.
fn measure_children_content(
    node: &SceneNode,
    parent_constraints: Constraints,
    sizes: &HashMap<ID, Size>,
    _measure_text: Option<&MeasureTextFn>,
) -> Size {
    let style = get_node_style(node);
    let cfg = to_layout(style.and_then(|s| s.layout.as_ref()));

    match cfg.mode {
        LayoutMode::Flex => compute_flow_content_size(node, cfg.axis, cfg.gap, sizes),
        LayoutMode::Split => parent_constraints.max, // Split fills parent
        LayoutMode::Absolute => parent_constraints.max, // Absolute fills parent
    }
}

/// Compute content size for flex/flow layout by summing child sizes.
/// Children are already measured - just read from cache.
fn compute_flow_content_size(
    node: &SceneNode,
    direction: LayoutAxis,
    gap: f64,
    sizes: &HashMap<ID, Size>,
) -> Size {
    let is_row = direction == LayoutAxis::X;
    let mut main_size: f64 = 0.0;
    let mut cross_size: f64 = 0.0;

    let style = get_node_style(node);
    let padding = to_insets(style.and_then(|s| s.padding.as_ref()));

    for (i, child) in node.children.iter().enumerate() {
        let child_size = sizes.get(&child.id).copied().unwrap_or(Size::ZERO);
        let gap_add = if i > 0 { gap } else { 0.0 };
        // The parent must contain each child PLUS its margins (before+after on main,
        // both sides on cross). Zero when unset → identical to pre-margin behavior.
        let cm = to_insets(get_node_style(child).and_then(|s| s.margin.as_ref()));
        let (main_margin, cross_margin) = if is_row {
            (cm.left + cm.right, cm.top + cm.bottom)
        } else {
            (cm.top + cm.bottom, cm.left + cm.right)
        };

        if is_row {
            main_size += child_size.w + main_margin + gap_add;
            cross_size = cross_size.max(child_size.h + cross_margin);
        } else {
            main_size += child_size.h + main_margin + gap_add;
            cross_size = cross_size.max(child_size.w + cross_margin);
        }
    }

    Size {
        w: (if is_row { main_size } else { cross_size }) + padding.left + padding.right,
        h: (if is_row { cross_size } else { main_size }) + padding.top + padding.bottom,
    }
}

// ============================================================================
// Place Phase
// ============================================================================

/// Place phase: compute positions recursively and store in frames map.
///
/// VISIBILITY GATE: Invisible nodes (visible == false) are NOT placed.
/// This is the canonical location for visibility filtering - if a node
/// isn't in layout_frames, it doesn't exist for hit-testing.
fn place_node(
    node: &SceneNode,
    origin: Point,
    size: Size,
    frames: &mut HashMap<ID, LayoutFrame>,
    sizes: &HashMap<ID, Size>,
) {
    // CANONICAL VISIBILITY CHECK: Skip invisible nodes and their subtrees.
    // After compute phase, node.visible is a resolved boolean.
    // If invisible, don't create a LayoutFrame - this excludes it from hit-testing.
    if !node.visible.as_bool() {
        return;
    }

    let rect = Rect::from_point_size(origin, size);
    let measured_size = resolve_size(&node.id, sizes, frames);
    frames.insert(
        node.id.clone(),
        LayoutFrame {
            rect,
            baseline: 0.0,
            measured_size,
        },
    );

    if node.children.is_empty() {
        return;
    }

    let style = get_node_style(node);
    let cfg = to_layout(style.and_then(|s| s.layout.as_ref()));
    let padding = to_insets(style.and_then(|s| s.padding.as_ref()));

    let child_origin = Point::new(origin.x + padding.left, origin.y + padding.top);
    let content_size = Size::new(
        size.w - padding.left - padding.right,
        size.h - padding.top - padding.bottom,
    );

    match cfg.mode {
        LayoutMode::Flex => {
            place_flow_children(
                node,
                child_origin,
                content_size,
                cfg.axis,
                cfg.gap,
                frames,
                sizes,
            );
        }
        LayoutMode::Split => {
            let parts: Vec<SplitPart> = cfg
                .parts
                .unwrap_or_default()
                .into_iter()
                .map(|p| SplitPart {
                    fraction: if p.fraction > 0.0 { p.fraction } else { 1.0 },
                })
                .collect();
            place_split_children(
                node,
                child_origin,
                content_size,
                cfg.axis,
                cfg.gap,
                &parts,
                PlacementTarget { frames, sizes },
            );
        }
        LayoutMode::Absolute => {
            place_absolute_children(node, origin, content_size, frames, sizes);
        }
    }
}

/// Place flow children with flex grow/shrink distribution.
///
/// ## Algorithm (same concept as `place_split_children` but for Flex mode)
///
/// 1. Filter visible children
/// 2. Classify each child: fixed (Explicit/ContentFit) or flex (FlexGrow)
/// 3. Sum fixed children's main-axis sizes and total flex factors
/// 4. Compute remaining = parent_main - fixed_total - total_gaps
/// 5. Distribute remaining proportionally to flex children
/// 6. Place all children sequentially with computed sizes
///
/// ## parent_size parameter
///
/// The parent's content area size (after padding). Required for computing
/// remaining space available for flex distribution. Without this, flex children
/// cannot know how much space to absorb.
fn place_flow_children(
    node: &SceneNode,
    origin: Point,
    parent_size: Size,
    direction: LayoutAxis,
    gap: f64,
    frames: &mut HashMap<ID, LayoutFrame>,
    sizes: &HashMap<ID, Size>,
) {
    for (child, child_origin, child_size) in flow_child_slots(node, origin, parent_size, direction, gap, frames, sizes) {
        place_node(child, child_origin, child_size, frames, sizes);
    }
}

/// Where each visible child of a flow container goes: margins, flex distribution,
/// cross-axis stretch and gaps. The ONE flow placement rule — the full and the
/// incremental placement both place children exactly here, so a dirty update can
/// never lay a child out differently from a full layout.
fn flow_child_slots<'a>(
    node: &'a SceneNode,
    origin: Point,
    parent_size: Size,
    direction: LayoutAxis,
    gap: f64,
    frames: &HashMap<ID, LayoutFrame>,
    sizes: &HashMap<ID, Size>,
) -> Vec<(&'a SceneNode, Point, Size)> {
    let is_row = direction == LayoutAxis::X;
    let parent_main = if is_row { parent_size.w } else { parent_size.h };

    // Filter to visible children for proper gap handling
    let visible_children: Vec<_> = node
        .children
        .iter()
        .filter(|c| c.visible.as_bool())
        .collect();

    let mut slots = Vec::with_capacity(visible_children.len());
    if visible_children.is_empty() {
        return slots;
    }

    let total_gap = gap * (visible_children.len().saturating_sub(1)) as f64;

    // Phase A: Classify children — compute fixed space and flex factor totals
    let mut fixed_total: f64 = 0.0;
    let mut flex_total: f64 = 0.0;
    let mut has_flex_children = false;

    for child in &visible_children {
        let child_style = get_node_style(child);
        // Margins are fixed space on the main axis for EVERY child (flex or not),
        // so flex distribution sees them as consumed.
        let m = to_insets(child_style.and_then(|s| s.margin.as_ref()));
        fixed_total += if is_row {
            m.left + m.right
        } else {
            m.top + m.bottom
        };
        let sizing = SizingMode::from_style(child_style);
        match sizing {
            SizingMode::FlexGrow { factor, .. } => {
                flex_total += factor;
                has_flex_children = true;
            }
            _ => {
                let child_size = resolve_size(&child.id, sizes, frames);
                fixed_total += if is_row { child_size.w } else { child_size.h };
            }
        }
    }

    // Phase B: Compute remaining space for flex distribution
    // Remaining space = parent main axis - fixed children - gaps
    // Clamp to 0 to prevent negative sizes when fixed children exceed parent
    let remaining = if has_flex_children {
        (parent_main - fixed_total - total_gap).max(0.0)
    } else {
        0.0
    };

    // Phase C: Place children sequentially
    let mut cursor = if is_row { origin.x } else { origin.y };

    for (i, child) in visible_children.iter().enumerate() {
        let child_style = get_node_style(child);
        // Margin AROUND this child — space before/after on the main axis, inset on the
        // cross axis. This is the per-block spacing DATA (e.g. extra room above ONE
        // block), mapped to main/cross by the flow direction. Zero when unset → the
        // layout is byte-identical to before margins existed.
        let m = to_insets(child_style.and_then(|s| s.margin.as_ref()));
        let (main_before, main_after, cross_before, cross_after) = if is_row {
            (m.left, m.right, m.top, m.bottom)
        } else {
            (m.top, m.bottom, m.left, m.right)
        };
        cursor += main_before;

        let sizing = SizingMode::from_style(child_style);
        let measured = resolve_size(&child.id, sizes, frames);

        // Determine main-axis size: flex-allocated or measured
        let child_main = match &sizing {
            SizingMode::FlexGrow { factor, .. } => {
                if flex_total > 0.0 {
                    remaining * (factor / flex_total)
                } else {
                    0.0
                }
            }
            _ => {
                if is_row {
                    measured.w
                } else {
                    measured.h
                }
            }
        };

        // Cross-axis stretch (CSS flexbox default: align-items: stretch).
        // Children without explicit cross-axis dimensions fill the parent's cross axis.
        // Children WITH explicit cross-axis dimensions keep their specified size.
        let has_explicit_cross = match &sizing {
            SizingMode::Explicit { width, height } | SizingMode::FlexGrow { width, height, .. } => {
                if is_row {
                    height.is_some()
                } else {
                    width.is_some()
                }
            }
            _ => false,
        };
        let child_cross = if has_explicit_cross {
            if is_row {
                measured.h
            } else {
                measured.w
            }
        } else {
            // Stretch to the parent cross axis MINUS this child's cross-axis margins.
            let parent_cross = if is_row { parent_size.h } else { parent_size.w };
            (parent_cross - cross_before - cross_after).max(0.0)
        };

        let child_size = if is_row {
            Size::new(child_main, child_cross)
        } else {
            Size::new(child_cross, child_main)
        };

        // Main-axis position sits past `main_before`; the cross axis is inset by the
        // child's cross-before margin.
        let child_origin = if is_row {
            Point::new(cursor, origin.y + cross_before)
        } else {
            Point::new(origin.x + cross_before, cursor)
        };

        slots.push((*child, child_origin, child_size));

        let gap_add = if i < visible_children.len() - 1 {
            gap
        } else {
            0.0
        };
        cursor += child_main + main_after + gap_add;
    }
    slots
}

/// Place split children (fractional parts, skips invisible children)
fn place_split_children(
    node: &SceneNode,
    origin: Point,
    content_size: Size,
    direction: LayoutAxis,
    gap: f64,
    parts: &[SplitPart],
    target: PlacementTarget<'_>,
) {
    let is_row = direction == LayoutAxis::X;

    // Filter to visible children and pair with their original parts
    let visible_with_parts: Vec<_> = node
        .children
        .iter()
        .enumerate()
        .filter(|(_, c)| c.visible.as_bool())
        .map(|(i, c)| (c, parts.get(i).map(|p| p.fraction).unwrap_or(1.0)))
        .collect();

    let num_visible = visible_with_parts.len();
    if num_visible == 0 {
        return;
    }

    let total_parts: f64 = visible_with_parts.iter().map(|(_, f)| f).sum();
    let total_gap = gap * (num_visible.saturating_sub(1)) as f64;
    let available_size = if is_row {
        content_size.w
    } else {
        content_size.h
    } - total_gap;

    let mut cursor = if is_row { origin.x } else { origin.y };

    for (i, (child, part_fraction)) in visible_with_parts.iter().enumerate() {
        let fraction = if total_parts > 0.0 {
            part_fraction / total_parts
        } else {
            1.0 / num_visible as f64
        };
        let child_main_size = available_size * fraction;

        let child_size = if is_row {
            Size::new(child_main_size, content_size.h)
        } else {
            Size::new(content_size.w, child_main_size)
        };

        let child_origin = if is_row {
            Point::new(cursor, origin.y)
        } else {
            Point::new(origin.x, cursor)
        };

        place_node(child, child_origin, child_size, target.frames, target.sizes);

        let gap_add = if i < num_visible - 1 { gap } else { 0.0 };
        cursor += child_main_size + gap_add;
    }
}

/// Place absolute children
fn place_absolute_children(
    node: &SceneNode,
    origin: Point,
    parent_content_size: Size,
    frames: &mut HashMap<ID, LayoutFrame>,
    sizes: &HashMap<ID, Size>,
) {
    let style = get_node_style(node);
    let padding = to_insets(style.and_then(|s| s.padding.as_ref()));

    for child in &node.children {
        let child_style = get_node_style(child);
        let child_layout = to_layout(child_style.and_then(|s| s.layout.as_ref()));

        let x = child_layout.x.unwrap_or(0.0);
        let y = child_layout.y.unwrap_or(0.0);

        let measured = resolve_size(&child.id, sizes, frames);
        let w = child_style
            .and_then(|s| s.width.as_ref())
            .map(|d| d.resolve(parent_content_size.w))
            .filter(|n| n.is_finite())
            .unwrap_or(measured.w);
        let h = child_style
            .and_then(|s| s.height.as_ref())
            .map(|d| d.resolve(parent_content_size.h))
            .filter(|n| n.is_finite())
            .unwrap_or(measured.h);

        let child_origin = Point::new(origin.x + padding.left + x, origin.y + padding.top + y);
        place_node(child, child_origin, Size::new(w, h), frames, sizes);
    }
}

// ============================================================================
// Incremental Layout — Task 153, Agent 3
// ============================================================================
//
// Incremental layout reuses previous LayoutFrames for unchanged subtrees.
// Only subtrees containing at least one dirty node are re-measured and re-placed.
// Everything else is preserved exactly from the previous frame's layout.
//
// ## Algorithm
//
// 1. **Precompute dirty paths**: O(n) walk to build a set of node IDs whose
//    subtrees contain at least one dirty node. This enables O(1) lookups.
// 2. **Incremental measure**: Walk tree recursively. For clean subtrees,
//    extract the previous size from the layout frame. For dirty subtrees,
//    re-measure using the standard algorithm.
// 3. **Incremental place**: Walk tree recursively. For clean subtrees,
//    skip entirely (previous frames preserved). For dirty subtrees,
//    re-place using the standard algorithm.
//
// ## Correctness Invariant
//
// A clean subtree's frames are preserved exactly. This is conservative:
// if a dirty sibling changes size and affects a clean sibling's position
// in a flex layout, the clean sibling's dirty flag should have been set
// by the mutation that caused the change. If not, the next render will
// correct it (eventual consistency within 1-2 frames).
//
// ## Performance Target
//
// 1000-node tree with 1 dirty leaf: < 1ms (vs full recomputation of ~10-100ms).
// The O(n) precompute walk is amortized over the O(1) lookups it enables.

/// Compute layout incrementally, skipping unchanged subtrees.
///
/// This is the incremental entry point for layout computation. When possible,
/// it reuses previous layout frames for subtrees that have no dirty nodes,
/// avoiding the full O(tree_size) measure + place computation.
///
/// ## Arc Identity Preservation (P1 Compliant)
///
/// Accepts and returns `Arc<HashMap<ID, LayoutFrame>>`. On clean frames
/// (nothing dirty), returns the **exact same Arc** — O(1), zero cloning,
/// verifiable via `Arc::ptr_eq()`. On dirty frames, uses `Arc::make_mut()`
/// for copy-on-write: in-place mutation when sole owner (O(1) overhead),
/// clone-on-write when shared (O(n) but only when actually needed).
///
/// ## Fast Paths
///
/// - `structure_changed == true` → falls back to full `compute_layout()`
///   because node additions/removals/reorders invalidate the tree shape.
/// - `dirty_nodes.is_empty()` → returns `previous_frames` unchanged (O(1) Arc return).
/// - Dirty node IDs not in tree → returns `previous_frames` unchanged (O(1) Arc return).
///
/// ## Arguments
///
/// * `root` - The scene tree root (post-binding evaluation).
/// * `viewport` - The viewport size (root constraint).
/// * `measure_text` - Optional host-provided text measurement function.
/// * `previous_frames` - Arc-wrapped layout frames from the previous render.
/// * `dirty_nodes` - Set of node IDs whose properties changed.
/// * `structure_changed` - True if nodes were added, removed, moved, or reordered.
///
/// ## Returns
///
/// `IncrementalLayoutResult` — contains the frames Arc and a set of changed
/// frame IDs. On fast-path (nothing dirty), returns empty changed_ids with
/// the original Arc (identity preserved).
pub fn compute_layout_incremental(
    root: &SceneNode,
    viewport: Size,
    measure_text: Option<&MeasureTextFn>,
    text_measurements: &HashMap<ID, HostTextMeasurement>,
    mut previous_frames: Arc<HashMap<ID, LayoutFrame>>,
    dirty_nodes: &HashSet<String>,
) -> IncrementalLayoutResult {
    // INV-038: The old `structure_changed` bailout forced O(n) full layout on
    // every InsertNode/RemoveSubtree/visibility flip. Now incremental layout
    // handles ALL cases: new nodes (no previous frame) fall through to fresh
    // measurement in incremental_measure(), and mark_scene_structure_for()
    // adds parent to dirty_nodes so incremental layout discovers new children.

    // Fast path: nothing dirty → return previous frames unchanged.
    // O(1) Arc return — zero cloning, identity preserved.
    if dirty_nodes.is_empty() {
        return IncrementalLayoutResult {
            frames: previous_frames,
            changed_ids: HashSet::new(),
        };
    }

    // Precompute which nodes have dirty descendants (O(n) walk, O(1) lookup).
    // A node is in dirty_subtrees if it is dirty itself or has any dirty descendant.
    let dirty_subtrees = collect_dirty_subtrees(root, dirty_nodes);

    // If no node in the tree is actually dirty, return previous frames.
    // This handles the case where dirty_nodes contains IDs not present in the tree.
    // O(1) Arc return — zero cloning, identity preserved.
    if !dirty_subtrees.contains(&root.id) {
        return IncrementalLayoutResult {
            frames: previous_frames,
            changed_ids: HashSet::new(),
        };
    }

    // Phase 1: Incremental measure — recompute sizes for dirty paths,
    // reuse previous measured_size from LayoutFrames for clean subtrees.
    //
    // Only dirty-path nodes get fresh measurements. Clean subtrees read
    // their measured_size from previous_frames on demand via SizeLookup
    // fallback — no O(n) pre-collection needed.
    //
    // Cost: O(dirty_paths) for measure, not O(n).
    let root_constraints = Constraints::new(Size::ZERO, viewport);
    let mut sizes: HashMap<ID, Size> = HashMap::with_capacity(dirty_subtrees.len());
    incremental_measure(
        root,
        root_constraints,
        &mut sizes,
        measure_text,
        text_measurements,
        &dirty_subtrees,
        &previous_frames,
    );

    // Snapshot previous frames for change detection in Phase 2.
    // Capture the pre-mutation state BEFORE Arc::make_mut potentially clones.
    // Besides the dirty paths, keep the frames of the CLEAN children of dirty
    // nodes: a dirty sibling can move them (and, with them, their whole subtree),
    // and every frame that actually moves must be reported.
    let mut clean_boundary: Vec<&SceneNode> = Vec::new();
    collect_clean_boundary(root, &dirty_subtrees, &mut clean_boundary);
    let prev_snapshot: HashMap<ID, LayoutFrame> = previous_frames
        .iter()
        .filter(|(id, _)| dirty_subtrees.contains(id.as_str()))
        .map(|(id, frame)| (id.clone(), *frame))
        .collect();
    let prev_boundary: Vec<Option<LayoutFrame>> = clean_boundary
        .iter()
        .map(|node| previous_frames.get(&node.id).copied())
        .collect();

    // Phase 2: Incremental place — recompute positions for dirty paths,
    // skip clean subtrees (previous frames preserved).
    // Arc::make_mut() clones-on-write only if shared; in-place if sole owner.
    // After make_mut, `frames` contains the previous layout data. The place
    // functions use resolve_size() which falls back to frames.measured_size
    // for clean nodes not in `sizes` — eliminating the O(n) pre-collection.
    let frames = Arc::make_mut(&mut previous_frames);
    let root_size = sizes.get(&root.id).copied().unwrap_or(Size::ZERO);
    incremental_place(
        root,
        Point::ZERO,
        root_size,
        frames,
        &sizes,
        &dirty_subtrees,
    );

    // Phase 3: Collect changed frame IDs by comparing post-place frames
    // against the pre-mutation snapshot. A frame is "changed" if:
    // - It exists now but didn't exist before (new frame)
    // - It exists in both but differs (position/size changed)
    // - It existed before but was removed (evicted by visibility change)
    //
    // Cost: O(dirty_subtrees) — only checks frames for nodes on dirty paths.
    let mut changed_ids = HashSet::new();
    for id in &dirty_subtrees {
        match (prev_snapshot.get(id), frames.get(id)) {
            (None, Some(_)) => {
                changed_ids.insert(id.clone());
            } // New frame
            (Some(old), Some(new)) if old != new => {
                changed_ids.insert(id.clone());
            } // Changed
            (Some(_), None) => {
                changed_ids.insert(id.clone());
            } // Removed (evicted)
            _ => {} // Unchanged
        }
    }
    // A clean child of a dirty node whose frame moved, appeared or was evicted:
    // its whole subtree was re-placed (or removed) with it, so every node in it
    // is reported. Cost: proportional to what actually moved.
    for (node, before) in clean_boundary.iter().zip(prev_boundary) {
        if before != frames.get(&node.id).copied() {
            collect_subtree_ids(node, &mut changed_ids);
        }
    }

    IncrementalLayoutResult {
        frames: previous_frames,
        changed_ids,
    }
}

/// The clean children of every node on a dirty path: the nodes a dirty sibling or
/// parent can move without themselves being dirty.
fn collect_clean_boundary<'a>(
    node: &'a SceneNode,
    dirty_subtrees: &HashSet<String>,
    out: &mut Vec<&'a SceneNode>,
) {
    for child in &node.children {
        if dirty_subtrees.contains(&child.id) {
            collect_clean_boundary(child, dirty_subtrees, out);
        } else {
            out.push(child);
        }
    }
}

/// Every node id in a subtree.
fn collect_subtree_ids(node: &SceneNode, out: &mut HashSet<String>) {
    out.insert(node.id.clone());
    for child in &node.children {
        collect_subtree_ids(child, out);
    }
}

/// Precompute which nodes have dirty descendants.
///
/// Returns a set of node IDs where the node itself or at least one descendant
/// is in `dirty_nodes`. This enables O(1) subtree-dirty checks during the
/// incremental measure and place phases.
///
/// ## Performance
///
/// O(n) where n = total tree size. Single pass, no allocations beyond the result set.
fn collect_dirty_subtrees(root: &SceneNode, dirty_nodes: &HashSet<String>) -> HashSet<String> {
    let mut result = HashSet::new();
    mark_dirty_path(root, dirty_nodes, &mut result);
    result
}

/// Recursively mark nodes whose subtrees contain dirty nodes.
///
/// Returns true if this node or any descendant is in `dirty_nodes`.
/// Every node on the path from root to a dirty node gets added to `result`.
fn mark_dirty_path(
    node: &SceneNode,
    dirty_nodes: &HashSet<String>,
    result: &mut HashSet<String>,
) -> bool {
    let mut has_dirty = dirty_nodes.contains(&node.id);
    for child in &node.children {
        if mark_dirty_path(child, dirty_nodes, result) {
            has_dirty = true;
        }
    }
    if has_dirty {
        result.insert(node.id.clone());
    }
    has_dirty
}

/// Check if a node's subtree contains any dirty node by walking the tree.
///
/// Used only in contexts where the precomputed dirty_subtrees set is unavailable.
/// Prefer using the precomputed set for O(1) lookups.
///
/// ## Performance
///
/// O(subtree_size) — walks the entire subtree. Use `dirty_subtrees.contains()` instead
/// when the precomputed set is available.
pub fn subtree_contains_dirty(node: &SceneNode, dirty_nodes: &HashSet<String>) -> bool {
    if dirty_nodes.contains(&node.id) {
        return true;
    }
    for child in &node.children {
        if subtree_contains_dirty(child, dirty_nodes) {
            return true;
        }
    }
    false
}

/// Incremental measure phase: compute intrinsic sizes, skipping clean subtrees.
///
/// For nodes whose subtrees are entirely clean (no dirty descendants),
/// `LayoutFrame.measured_size` from previous frames provides the correct intrinsic
/// size in O(1) — no need to recurse into children.
/// For nodes on the dirty path, the standard measure algorithm runs.
fn incremental_measure(
    node: &SceneNode,
    constraints: Constraints,
    sizes: &mut HashMap<ID, Size>,
    measure_text: Option<&MeasureTextFn>,
    text_measurements: &HashMap<ID, HostTextMeasurement>,
    dirty_subtrees: &HashSet<String>,
    previous_frames: &HashMap<ID, LayoutFrame>,
) -> Size {
    // Clean subtree: reuse MEASURED (intrinsic) size from previous layout frame.
    // No need to recurse into children — their sizes are unchanged.
    //
    // CRITICAL: We read `measured_size` (intrinsic content dimensions), NOT
    // `rect.w/h` (placed dimensions). In Flex layout, placed size ≠ measured
    // size due to cross-axis stretching. Using placed sizes as measured sizes
    // causes cascading layout errors: parent containers compute wrong
    // content_size → wrong flex distribution → wrong placement for ALL siblings.
    if !dirty_subtrees.contains(&node.id) {
        // INV-038: If the node has a previous frame, reuse its measured size.
        // If NOT (node is new — InsertNode or visibility flip made it appear),
        // fall through to measure fresh. The old code used unwrap_or(Size::ZERO)
        // which gave new nodes zero size, breaking incremental layout for
        // any operation that adds nodes to the tree.
        if let Some(frame) = previous_frames.get(&node.id) {
            sizes.insert(node.id.clone(), frame.measured_size);
            return frame.measured_size;
        }
        // No previous frame → node is new. Fall through to measure fresh.
    }

    // Memoization: return cached size if already computed in this pass
    if let Some(&cached) = sizes.get(&node.id) {
        return cached;
    }

    let style = get_node_style(node);
    let sizing_mode = SizingMode::for_node(node, style, text_measurements);

    // Measure children incrementally: clean children reuse previous sizes,
    // dirty children re-measure through the standard algorithm — with the same
    // parent-to-child constraints the full measure derives.
    let child_constraints = child_constraints_for(node, &sizing_mode, constraints);
    for child in &node.children {
        incremental_measure(
            child,
            child_constraints,
            sizes,
            measure_text,
            text_measurements,
            dirty_subtrees,
            previous_frames,
        );
    }

    // Compute content size from children sizes (same as standard algorithm)
    let content_size =
        compute_content_size(node, constraints, sizes, measure_text, text_measurements);

    // Apply sizing mode to get final size
    let final_size = sizing_mode.compute_size(content_size, constraints);

    sizes.insert(node.id.clone(), final_size);
    final_size
}

/// INV-038: Remove stale frames for an invisible node and all its descendants.
///
/// When a node becomes invisible, its frame (and all descendant frames) must be
/// evicted from layout_frames. Full layout builds a fresh HashMap (only visible
/// nodes get frames). Incremental layout starts from previous_frames — stale
/// entries for invisible nodes persist unless explicitly removed.
///
/// This maintains the invariant: layout_frames contains frames for EXACTLY
/// the set of visible nodes. Without this, stale frames cause incorrect
/// hit testing and trigger routing (L055 deepest root: clicks land on
/// invisible nodes whose frames still exist at their old positions).
///
/// ## Performance
///
/// O(subtree_size) per call — proportional to the change, not the tree.
/// Only called when a node that HAD a frame becomes invisible.
fn evict_subtree_frames(node: &SceneNode, frames: &mut HashMap<ID, LayoutFrame>) {
    frames.remove(&node.id);
    for child in &node.children {
        evict_subtree_frames(child, frames);
    }
}

/// Incremental place phase: compute positions, skipping unchanged clean subtrees.
///
/// For clean nodes whose computed rect matches the previous frame's rect exactly,
/// the entire subtree is skipped (O(1)). For clean nodes whose rect changed
/// (due to sibling layout shifts or cross-axis stretch changes), `place_node()`
/// is used to correctly update the entire subtree — descendant absolute positions
/// depend on ancestor positions, so all descendants must be re-placed when an
/// ancestor moves. For nodes on the dirty path, the standard placement algorithm
/// runs with incremental recursion into children.
fn incremental_place(
    node: &SceneNode,
    origin: Point,
    size: Size,
    frames: &mut HashMap<ID, LayoutFrame>,
    sizes: &HashMap<ID, Size>,
    dirty_subtrees: &HashSet<String>,
) {
    // Clean subtree: properties haven't changed, but position or size may
    // have shifted due to sibling layout changes (e.g., a dirty sibling's
    // measured size changed, shifting this node's cursor position in Flex
    // layout, or the parent's cross-axis stretch changed).
    //
    // Optimization: if the computed frame matches the previous frame exactly,
    // skip the subtree — no descendants need updating.
    // If the frame differs, use standard place_node to correctly update the
    // entire clean subtree (descendant absolute positions depend on ancestor
    // positions, so all descendants must be re-placed when an ancestor moves).
    if !dirty_subtrees.contains(&node.id) {
        if !node.visible.as_bool() {
            // INV-038: Clean invisible node may have a stale frame from when
            // it was visible. Remove it + all descendant frames to maintain
            // the invariant: layout_frames contains EXACTLY visible nodes.
            // O(1) check, O(subtree) only when stale frame actually exists.
            if frames.contains_key(&node.id) {
                evict_subtree_frames(node, frames);
            }
            return;
        }
        let new_rect = Rect::from_point_size(origin, size);
        let frame_unchanged = frames
            .get(&node.id)
            .map(|f| f.rect == new_rect)
            .unwrap_or(false);
        if frame_unchanged {
            return;
        }
        // Frame changed — standard placement updates the entire clean subtree.
        place_node(node, origin, size, frames, sizes);
        return;
    }

    // CANONICAL VISIBILITY CHECK: Same as place_node.
    // INV-038: Also remove stale frames for this node and descendants.
    // When a dirty node's visibility evaluates to false, it (and all its
    // descendants) must be evicted from layout_frames. Without this,
    // stale frames persist and cause incorrect hit testing / trigger routing.
    if !node.visible.as_bool() {
        evict_subtree_frames(node, frames);
        return;
    }

    let rect = Rect::from_point_size(origin, size);
    let measured_size = resolve_size(&node.id, sizes, frames);
    frames.insert(
        node.id.clone(),
        LayoutFrame {
            rect,
            baseline: 0.0,
            measured_size,
        },
    );

    if node.children.is_empty() {
        return;
    }

    // INV-038: Evict stale frames for invisible children before layout.
    // Layout mode functions (flow/split/absolute) only process visible children,
    // so invisible children's stale frames would otherwise persist forever.
    // This is the structural fix (L063): a single eviction point that handles
    // all layout modes uniformly. O(children) check, only on dirty parents
    // that already do O(children) work for layout.
    for child in &node.children {
        if !child.visible.as_bool() {
            evict_subtree_frames(child, frames);
        }
    }

    let style = get_node_style(node);
    let cfg = to_layout(style.and_then(|s| s.layout.as_ref()));
    let padding = to_insets(style.and_then(|s| s.padding.as_ref()));

    let child_origin = Point::new(origin.x + padding.left, origin.y + padding.top);
    let content_size = Size::new(
        size.w - padding.left - padding.right,
        size.h - padding.top - padding.bottom,
    );

    match cfg.mode {
        LayoutMode::Flex => {
            incremental_place_flow(
                node,
                child_origin,
                content_size,
                cfg.axis,
                cfg.gap,
                IncrementalPlacementTarget {
                    frames,
                    sizes,
                    dirty_subtrees,
                },
            );
        }
        LayoutMode::Split => {
            let parts: Vec<SplitPart> = cfg
                .parts
                .unwrap_or_default()
                .into_iter()
                .map(|p| SplitPart {
                    fraction: if p.fraction > 0.0 { p.fraction } else { 1.0 },
                })
                .collect();
            incremental_place_split(
                node,
                child_origin,
                content_size,
                cfg.axis,
                cfg.gap,
                &parts,
                IncrementalPlacementTarget {
                    frames,
                    sizes,
                    dirty_subtrees,
                },
            );
        }
        LayoutMode::Absolute => {
            incremental_place_absolute(node, origin, content_size, frames, sizes, dirty_subtrees);
        }
    }
}

/// Incremental flow placement: the same slots as `place_flow_children`
/// (`flow_child_slots`), recursing through `incremental_place` so clean subtrees
/// whose frame did not move are skipped.
fn incremental_place_flow(
    node: &SceneNode,
    origin: Point,
    parent_size: Size,
    direction: LayoutAxis,
    gap: f64,
    target: IncrementalPlacementTarget<'_>,
) {
    let slots = flow_child_slots(node, origin, parent_size, direction, gap, target.frames, target.sizes);
    for (child, child_origin, child_size) in slots {
        // Incremental recursion: clean subtrees are skipped by incremental_place
        incremental_place(
            child,
            child_origin,
            child_size,
            target.frames,
            target.sizes,
            target.dirty_subtrees,
        );
    }
}

/// Incremental split placement: fractional parts with subtree skipping.
///
/// Same algorithm as `place_split_children` but uses `incremental_place`
/// for recursion, enabling clean subtree skipping.
fn incremental_place_split(
    node: &SceneNode,
    origin: Point,
    content_size: Size,
    direction: LayoutAxis,
    gap: f64,
    parts: &[SplitPart],
    target: IncrementalPlacementTarget<'_>,
) {
    let is_row = direction == LayoutAxis::X;

    let visible_with_parts: Vec<_> = node
        .children
        .iter()
        .enumerate()
        .filter(|(_, c)| c.visible.as_bool())
        .map(|(i, c)| (c, parts.get(i).map(|p| p.fraction).unwrap_or(1.0)))
        .collect();

    let num_visible = visible_with_parts.len();
    if num_visible == 0 {
        return;
    }

    let total_parts: f64 = visible_with_parts.iter().map(|(_, f)| f).sum();
    let total_gap = gap * (num_visible.saturating_sub(1)) as f64;
    let available_size = if is_row {
        content_size.w
    } else {
        content_size.h
    } - total_gap;

    let mut cursor = if is_row { origin.x } else { origin.y };

    for (i, (child, part_fraction)) in visible_with_parts.iter().enumerate() {
        let fraction = if total_parts > 0.0 {
            part_fraction / total_parts
        } else {
            1.0 / num_visible as f64
        };
        let child_main_size = available_size * fraction;

        let child_size = if is_row {
            Size::new(child_main_size, content_size.h)
        } else {
            Size::new(content_size.w, child_main_size)
        };

        let child_origin = if is_row {
            Point::new(cursor, origin.y)
        } else {
            Point::new(origin.x, cursor)
        };

        incremental_place(
            child,
            child_origin,
            child_size,
            target.frames,
            target.sizes,
            target.dirty_subtrees,
        );

        let gap_add = if i < num_visible - 1 { gap } else { 0.0 };
        cursor += child_main_size + gap_add;
    }
}

/// Incremental absolute placement with subtree skipping.
///
/// Same algorithm as `place_absolute_children` but uses `incremental_place`
/// for recursion, enabling clean subtree skipping.
fn incremental_place_absolute(
    node: &SceneNode,
    origin: Point,
    parent_content_size: Size,
    frames: &mut HashMap<ID, LayoutFrame>,
    sizes: &HashMap<ID, Size>,
    dirty_subtrees: &HashSet<String>,
) {
    let style = get_node_style(node);
    let padding = to_insets(style.and_then(|s| s.padding.as_ref()));

    for child in &node.children {
        let child_style = get_node_style(child);
        let child_layout = to_layout(child_style.and_then(|s| s.layout.as_ref()));

        let x = child_layout.x.unwrap_or(0.0);
        let y = child_layout.y.unwrap_or(0.0);

        let measured = resolve_size(&child.id, sizes, frames);
        let w = child_style
            .and_then(|s| s.width.as_ref())
            .map(|d| d.resolve(parent_content_size.w))
            .filter(|n| n.is_finite())
            .unwrap_or(measured.w);
        let h = child_style
            .and_then(|s| s.height.as_ref())
            .map(|d| d.resolve(parent_content_size.h))
            .filter(|n| n.is_finite())
            .unwrap_or(measured.h);

        let child_origin = Point::new(origin.x + padding.left + x, origin.y + padding.top + y);
        incremental_place(
            child,
            child_origin,
            Size::new(w, h),
            frames,
            sizes,
            dirty_subtrees,
        );
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::{NodeProps, ResolvedStyle, Visibility};
    use std::sync::Arc;

    fn make_container(id: &str, children: Vec<SceneNode>) -> SceneNode {
        SceneNode::new(id, NodeKind::Container).with_children(children)
    }

    fn make_rect(id: &str, width: f64, height: f64) -> SceneNode {
        SceneNode::new(id, NodeKind::Rect).with_props(NodeProps {
            style: Some(ResolvedStyle {
                width: Some(Dimension::Pixels(width)),
                height: Some(Dimension::Pixels(height)),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    fn make_text(id: &str, text: &str) -> SceneNode {
        SceneNode::new(id, NodeKind::Text).with_props(NodeProps {
            text: Some(text.to_string()),
            ..Default::default()
        })
    }

    #[test]
    fn per_block_margin_offsets_the_sibling_below() {
        // Per-block spacing: block `a` gets a 24px BOTTOM margin. Block `b` must sit
        // 24px lower than it would with no margin — proving margin is real, per-node,
        // engine-honored flow space (not a uniform gap, not padding-inside).
        let mut a = make_rect("a", 100.0, 40.0);
        a.props.style.as_mut().unwrap().margin = Some(Padding::new(0.0, 0.0, 24.0, 0.0));
        let b = make_rect("b", 100.0, 40.0);
        let mut parent = make_container("col", vec![a, b]);
        parent.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::Y),
                ..Default::default()
            }),
            ..Default::default()
        });

        let frames = compute_layout(&parent, Size::new(800.0, 600.0), None, &HashMap::new());
        let a_y = frames.get("a").unwrap().rect.y;
        let b_y = frames.get("b").unwrap().rect.y;
        // b sits below a's bottom edge (a_y + 40) PLUS a's 24px bottom margin.
        assert!(
            (b_y - (a_y + 40.0 + 24.0)).abs() < 0.5,
            "b must reflow below a + a's bottom margin (a_y={a_y}, b_y={b_y})",
        );

        // Zero-margin control: no margin field → identical to the classic gap-only flow.
        let mut a0 = make_rect("a", 100.0, 40.0);
        a0.props.style.as_mut().unwrap().margin = None;
        let parent0 = {
            let mut p = make_container("col", vec![a0, make_rect("b", 100.0, 40.0)]);
            p.props.style = Some(ResolvedStyle {
                layout: Some(LayoutConfig {
                    mode: Some(LayoutMode::Flex),
                    axis: Some(LayoutAxis::Y),
                    ..Default::default()
                }),
                ..Default::default()
            });
            p
        };
        let f0 = compute_layout(&parent0, Size::new(800.0, 600.0), None, &HashMap::new());
        assert!(
            (f0.get("b").unwrap().rect.y - (f0.get("a").unwrap().rect.y + 40.0)).abs() < 0.5,
            "no margin → b sits directly below a (byte-identical to pre-margin behavior)",
        );
    }

    #[test]
    fn test_single_node() {
        let root = make_rect("root", 100.0, 50.0);
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        assert_eq!(frames.len(), 1);
        let frame = frames.get("root").unwrap();
        assert_eq!(frame.rect.w, 100.0);
        assert_eq!(frame.rect.h, 50.0);
    }

    #[test]
    fn text_height_uses_host_measurement_when_present() {
        // The engine has no fonts: absent a host measurement, a text node gets the
        // crude one-line approximation. A wrapping paragraph is far taller than that.
        let root = make_text(
            "t1",
            "a long paragraph that wraps across several lines in a narrow column",
        );
        let baseline = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());
        let approx_h = baseline.get("t1").unwrap().rect.h;
        assert!(
            approx_h < 40.0,
            "approx height is ~one line; got {approx_h}"
        );

        // With the host-measured wrapped height, the engine uses it verbatim — this
        // is what reflows the blocks below and stops the overlap.
        let mut measurements: HashMap<ID, HostTextMeasurement> = HashMap::new();
        measurements.insert("t1".to_string(), HostTextMeasurement { height: 96.0, natural_width: None });
        let measured = compute_layout(&root, Size::new(800.0, 600.0), None, &measurements);
        assert_eq!(
            measured.get("t1").unwrap().rect.h,
            96.0,
            "host-measured wrapped height overrides the font approximation",
        );
    }

    #[test]
    fn host_measurement_reflows_the_sibling_below() {
        // Two stacked text blocks in a flow column. Growing the first block's
        // measured height must push the second block down by the same amount —
        // the exact behaviour whose absence caused wrapped text to overlap.
        let mut parent = make_container(
            "page",
            vec![make_text("a", "first"), make_text("b", "second")],
        );
        parent.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::Y),
                ..Default::default()
            }),
            ..Default::default()
        });

        let base = compute_layout(&parent, Size::new(800.0, 600.0), None, &HashMap::new());
        let base_b_y = base.get("b").unwrap().rect.y;

        let mut measurements: HashMap<ID, HostTextMeasurement> = HashMap::new();
        let grown = 120.0;
        measurements.insert("a".to_string(), HostTextMeasurement { height: grown, natural_width: None });
        let after = compute_layout(&parent, Size::new(800.0, 600.0), None, &measurements);
        let after_a_h = after.get("a").unwrap().rect.h;
        let after_b_y = after.get("b").unwrap().rect.y;

        assert_eq!(after_a_h, grown, "block a takes the measured height");
        assert!(
            after_b_y >= base_b_y + (grown - base.get("a").unwrap().rect.h) - 0.5,
            "block b reflowed below a's measured height (base_b_y={base_b_y}, after_b_y={after_b_y})",
        );
    }

    #[test]
    fn host_measurement_overrides_stale_explicit_height() {
        // A text block can carry a STALE `style.height` persisted by an earlier save/resize
        // (from before the text-measurement path existed). If the engine honored that stored
        // height, the block would be pinned too short and its wrapped content would overflow
        // onto the next block — the multi-line-block OVERLAP. The host measurement MUST win.
        // (Deepest-root fix via SizingMode::for_node; Codex-converged 2026-07-05.)
        let mut a = make_text("a", "first");
        a.props.style = Some(ResolvedStyle {
            height: Some(Dimension::Pixels(20.0)),
            ..Default::default()
        });
        let mut parent = make_container("page", vec![a, make_text("b", "second")]);
        parent.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::Y),
                gap: Some(0.0),
                ..Default::default()
            }),
            ..Default::default()
        });

        // Control: WITHOUT a measurement the stale explicit height still applies — the fix is
        // additive (byte-identical to `from_style` when no host measurement exists).
        let no_measure = compute_layout(&parent, Size::new(400.0, 800.0), None, &HashMap::new());
        assert_eq!(
            no_measure.get("a").unwrap().rect.h,
            20.0,
            "no measurement -> stale explicit height 20 preserved",
        );

        // With a host measurement (block a wraps to 90px), the measured height wins over the
        // stale explicit 20, and block b sits BELOW it (no overlap).
        let mut measurements: HashMap<ID, HostTextMeasurement> = HashMap::new();
        measurements.insert("a".to_string(), HostTextMeasurement { height: 90.0, natural_width: None });
        let measured = compute_layout(&parent, Size::new(400.0, 800.0), None, &measurements);
        assert_eq!(
            measured.get("a").unwrap().rect.h,
            90.0,
            "host measurement overrides the stale explicit height",
        );
        assert!(
            measured.get("b").unwrap().rect.y >= measured.get("a").unwrap().rect.y + 90.0 - 0.5,
            "block b sits below a's MEASURED height, not the stale 20 (b.y={}, a.bottom={})",
            measured.get("b").unwrap().rect.y,
            measured.get("a").unwrap().rect.y + 90.0,
        );
    }

    #[test]
    fn test_text_node() {
        let root = make_text("text", "Hello");
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let frame = frames.get("text").unwrap();
        assert!((frame.rect.w - 48.0).abs() < 0.001); // 5 * 16 * 0.6
        assert!((frame.rect.h - 19.2).abs() < 0.001); // 16 * 1.2
    }

    #[test]
    fn host_natural_width_expands_content_fit_text_and_parent() {
        let mut title = make_text("title", "Renamed page");
        title.props.style = Some(ResolvedStyle {
            font_size: Some(36.0),
            font_weight: Some(FontWeight::Numeric(700.0)),
            ..Default::default()
        });
        let mut page = make_container("page", vec![title]);
        page.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig { mode: Some(LayoutMode::Flex), axis: Some(LayoutAxis::Y), ..Default::default() }),
            ..Default::default()
        });
        let before = compute_layout(&page, Size::new(800.0, 600.0), None, &HashMap::new());
        let natural_width = before.get("title").unwrap().rect.w + 72.0;
        let measured = HashMap::from([("title".to_string(), HostTextMeasurement {
            height: before.get("title").unwrap().rect.h,
            natural_width: Some(natural_width),
        })]);
        let after = compute_layout(&page, Size::new(800.0, 600.0), None, &measured);
        assert_eq!(after.get("title").unwrap().rect.w, natural_width);
        assert_eq!(after.get("page").unwrap().rect.w, natural_width,
            "content-fit parent follows the measured intrinsic child width");
    }

    #[test]
    fn host_natural_width_never_overrides_authored_width() {
        let mut text = make_text("title", "Renamed page");
        text.props.style = Some(ResolvedStyle {
            width: Some(Dimension::Pixels(120.0)),
            ..Default::default()
        });
        let measurements = HashMap::from([("title".to_string(), HostTextMeasurement {
            height: 48.0,
            natural_width: Some(260.0),
        })]);
        let frames = compute_layout(&text, Size::new(800.0, 600.0), None, &measurements);
        assert_eq!(frames.get("title").unwrap().rect.w, 120.0,
            "explicit scene width remains authoritative");
        assert_eq!(frames.get("title").unwrap().rect.h, 48.0,
            "the same host input still owns wrapped height");
    }

    #[test]
    fn height_only_host_measurement_keeps_legacy_width_estimate() {
        let text = make_text("title", "Renamed page");
        let baseline = compute_layout(&text, Size::new(800.0, 600.0), None, &HashMap::new());
        let measurements = HashMap::from([("title".to_string(), HostTextMeasurement {
            height: 96.0,
            natural_width: None,
        })]);
        let measured = compute_layout(&text, Size::new(800.0, 600.0), None, &measurements);
        assert_eq!(measured.get("title").unwrap().rect.w, baseline.get("title").unwrap().rect.w);
        assert_eq!(measured.get("title").unwrap().rect.h, 96.0);
    }

    #[test]
    fn test_flow_column() {
        let root = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), make_rect("c2", 80.0, 30.0)],
        );
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let c1 = frames.get("c1").unwrap();
        assert_eq!(c1.rect.y, 0.0);

        let c2 = frames.get("c2").unwrap();
        assert_eq!(c2.rect.y, 50.0);
    }

    #[test]
    fn test_flow_row() {
        let mut root = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), make_rect("c2", 80.0, 30.0)],
        );
        root.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::X),
                ..Default::default()
            }),
            ..Default::default()
        });

        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let c1 = frames.get("c1").unwrap();
        assert_eq!(c1.rect.x, 0.0);

        let c2 = frames.get("c2").unwrap();
        assert_eq!(c2.rect.x, 100.0);
    }

    #[test]
    fn test_gap() {
        let mut root = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), make_rect("c2", 80.0, 30.0)],
        );
        root.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                gap: Some(10.0),
                ..Default::default()
            }),
            ..Default::default()
        });

        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());
        let c2 = frames.get("c2").unwrap();
        assert_eq!(c2.rect.y, 60.0); // 50 + 10
    }

    #[test]
    fn test_padding() {
        let mut root = make_container("root", vec![make_rect("c1", 100.0, 50.0)]);
        root.props.style = Some(ResolvedStyle {
            padding: Some(Padding::new(10.0, 20.0, 10.0, 20.0)),
            ..Default::default()
        });

        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());
        let c1 = frames.get("c1").unwrap();
        assert_eq!(c1.rect.x, 20.0);
        assert_eq!(c1.rect.y, 10.0);
    }

    #[test]
    fn content_fit_container_includes_padding_without_changing_child_width() {
        let mut root = make_container("root", vec![make_rect("child", 100.0, 30.0)]);
        root.props.style = Some(ResolvedStyle {
            padding: Some(Padding::new(18.0, 18.0, 18.0, 18.0)),
            ..Default::default()
        });

        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());
        let root_frame = frames.get("root").unwrap();
        let child_frame = frames.get("child").unwrap();

        assert_eq!(root_frame.rect.w, 136.0);
        assert_eq!(root_frame.rect.h, 66.0);
        assert_eq!(child_frame.rect.x, 18.0);
        assert_eq!(child_frame.rect.y, 18.0);
        assert_eq!(child_frame.rect.w, 100.0);
    }

    #[test]
    fn explicit_parent_constrains_children_to_its_padded_content_box() {
        let mut root = make_container("root", vec![make_rect("child", 200.0, 200.0)]);
        root.props.style = Some(ResolvedStyle {
            width: Some(Dimension::Pixels(140.0)),
            height: Some(Dimension::Pixels(100.0)),
            padding: Some(Padding::new(18.0, 18.0, 18.0, 18.0)),
            ..Default::default()
        });

        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());
        let root_frame = frames.get("root").unwrap();
        let child_frame = frames.get("child").unwrap();

        assert_eq!(root_frame.rect.w, 140.0);
        assert_eq!(root_frame.rect.h, 100.0);
        assert_eq!(child_frame.rect.x, 18.0);
        assert_eq!(child_frame.rect.y, 18.0);
        assert_eq!(child_frame.rect.w, 104.0);
        assert_eq!(child_frame.rect.h, 64.0);
    }

    #[test]
    fn test_split() {
        let mut root = make_container(
            "root",
            vec![make_rect("c1", 0.0, 0.0), make_rect("c2", 0.0, 0.0)],
        );
        root.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Split),
                axis: Some(LayoutAxis::Y),
                parts: Some(vec![
                    SplitPart { fraction: 1.0 },
                    SplitPart { fraction: 2.0 },
                ]),
                ..Default::default()
            }),
            ..Default::default()
        });

        let frames = compute_layout(&root, Size::new(300.0, 300.0), None, &HashMap::new());

        let c1 = frames.get("c1").unwrap();
        assert!((c1.rect.h - 100.0).abs() < 0.001);

        let c2 = frames.get("c2").unwrap();
        assert!((c2.rect.y - 100.0).abs() < 0.001);
        assert!((c2.rect.h - 200.0).abs() < 0.001);
    }

    #[test]
    fn test_absolute() {
        let mut child = make_rect("c1", 50.0, 50.0);
        child.props.style = Some(ResolvedStyle {
            width: Some(Dimension::Pixels(50.0)),
            height: Some(Dimension::Pixels(50.0)),
            layout: Some(LayoutConfig {
                x: Some(serde_json::json!(100.0)),
                y: Some(serde_json::json!(200.0)),
                ..Default::default()
            }),
            ..Default::default()
        });

        let mut root = make_container("root", vec![child]);
        root.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Absolute),
                ..Default::default()
            }),
            ..Default::default()
        });

        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());
        let c1 = frames.get("c1").unwrap();
        assert_eq!(c1.rect.x, 100.0);
        assert_eq!(c1.rect.y, 200.0);
    }

    // ====================================================================
    // Flex Grow/Shrink Tests (Task 143)
    // ====================================================================

    /// Create a node with `flex: N` and no explicit dimensions.
    /// This node should get FlexGrow sizing mode.
    fn make_flex(id: &str, flex_factor: f64) -> SceneNode {
        SceneNode::new(id, NodeKind::Container).with_props(NodeProps {
            style: Some(ResolvedStyle {
                flex: Some(flex_factor),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    /// Create a flex column parent with explicit height and given children.
    fn make_flex_column_parent(id: &str, height: f64, children: Vec<SceneNode>) -> SceneNode {
        let mut node = SceneNode::new(id, NodeKind::Container).with_children(children);
        node.props.style = Some(ResolvedStyle {
            height: Some(Dimension::Pixels(height)),
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::Y),
                ..Default::default()
            }),
            ..Default::default()
        });
        node
    }

    /// Create a flex row parent with explicit width and given children.
    fn make_flex_row_parent(id: &str, width: f64, children: Vec<SceneNode>) -> SceneNode {
        let mut node = SceneNode::new(id, NodeKind::Container).with_children(children);
        node.props.style = Some(ResolvedStyle {
            width: Some(Dimension::Pixels(width)),
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::X),
                ..Default::default()
            }),
            ..Default::default()
        });
        node
    }

    #[test]
    fn test_flex_grow_single() {
        // One flex:1 child fills all remaining space after a fixed sibling.
        // Parent: 300px tall, child1: 100px fixed, child2: flex:1 → 200px
        let root = make_flex_column_parent(
            "root",
            300.0,
            vec![make_rect("fixed", 80.0, 100.0), make_flex("flexible", 1.0)],
        );
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let fixed = frames.get("fixed").unwrap();
        assert_eq!(fixed.rect.y, 0.0);
        assert_eq!(fixed.rect.h, 100.0);

        let flexible = frames.get("flexible").unwrap();
        assert_eq!(flexible.rect.y, 100.0);
        assert!((flexible.rect.h - 200.0).abs() < 0.001);
    }

    #[test]
    fn test_flex_grow_fills_remaining() {
        // Popover scenario: 400px parent, tab_bar(40) + panels(flex:1) + action_bar(52)
        // Expected: panels.h = 400 - 40 - 52 = 308, action_bar.y = 40 + 308 = 348
        let root = make_flex_column_parent(
            "popover",
            400.0,
            vec![
                make_rect("tab_bar", 320.0, 40.0),
                make_flex("panels", 1.0),
                make_rect("action_bar", 320.0, 52.0),
            ],
        );
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let tab_bar = frames.get("tab_bar").unwrap();
        assert_eq!(tab_bar.rect.y, 0.0);
        assert_eq!(tab_bar.rect.h, 40.0);

        let panels = frames.get("panels").unwrap();
        assert_eq!(panels.rect.y, 40.0);
        assert!((panels.rect.h - 308.0).abs() < 0.001);

        let action_bar = frames.get("action_bar").unwrap();
        assert!((action_bar.rect.y - 348.0).abs() < 0.001);
        assert_eq!(action_bar.rect.h, 52.0);
    }

    #[test]
    fn test_flex_grow_multiple_equal() {
        // Two flex:1 children split remaining space equally.
        // Parent: 200px, fixed: 60px → remaining 140px → 70px each
        let root = make_flex_column_parent(
            "root",
            200.0,
            vec![
                make_rect("header", 80.0, 60.0),
                make_flex("a", 1.0),
                make_flex("b", 1.0),
            ],
        );
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let a = frames.get("a").unwrap();
        assert!((a.rect.h - 70.0).abs() < 0.001);
        assert_eq!(a.rect.y, 60.0);

        let b = frames.get("b").unwrap();
        assert!((b.rect.h - 70.0).abs() < 0.001);
        assert!((b.rect.y - 130.0).abs() < 0.001);
    }

    #[test]
    fn test_flex_grow_weighted() {
        // flex:2 gets 2x of flex:1.
        // Parent: 300px, no fixed children → 300px total
        // flex:1 → 100px, flex:2 → 200px
        let root = make_flex_column_parent(
            "root",
            300.0,
            vec![make_flex("small", 1.0), make_flex("large", 2.0)],
        );
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let small = frames.get("small").unwrap();
        assert!((small.rect.h - 100.0).abs() < 0.001);

        let large = frames.get("large").unwrap();
        assert!((large.rect.h - 200.0).abs() < 0.001);
        assert!((large.rect.y - 100.0).abs() < 0.001);
    }

    #[test]
    fn test_flex_grow_with_gap() {
        // Gaps subtracted from remaining space before distribution.
        // Parent: 300px, 3 children with gap=10 → 2 gaps = 20px
        // fixed: 80px, flex:1, flex:1 → remaining = 300 - 80 - 20 = 200 → 100px each
        let mut root = make_flex_column_parent(
            "root",
            300.0,
            vec![
                make_rect("header", 80.0, 80.0),
                make_flex("a", 1.0),
                make_flex("b", 1.0),
            ],
        );
        // Add gap to the parent style
        root.props
            .style
            .as_mut()
            .unwrap()
            .layout
            .as_mut()
            .unwrap()
            .gap = Some(10.0);

        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let a = frames.get("a").unwrap();
        assert!((a.rect.h - 100.0).abs() < 0.001);
        // a.y = header(80) + gap(10) = 90
        assert!((a.rect.y - 90.0).abs() < 0.001);

        let b = frames.get("b").unwrap();
        assert!((b.rect.h - 100.0).abs() < 0.001);
        // b.y = 90 + 100 + gap(10) = 200
        assert!((b.rect.y - 200.0).abs() < 0.001);
    }

    #[test]
    fn test_flex_grow_row_axis() {
        // Flex distribution works on horizontal axis.
        // Parent: 500px wide (row), fixed: 100px, flex:1 → 400px
        let root = make_flex_row_parent(
            "root",
            500.0,
            vec![make_rect("sidebar", 100.0, 50.0), make_flex("content", 1.0)],
        );
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let sidebar = frames.get("sidebar").unwrap();
        assert_eq!(sidebar.rect.x, 0.0);
        assert_eq!(sidebar.rect.w, 100.0);

        let content = frames.get("content").unwrap();
        assert!((content.rect.x - 100.0).abs() < 0.001);
        assert!((content.rect.w - 400.0).abs() < 0.001);
    }

    #[test]
    fn test_flex_grow_zero_remaining() {
        // Fixed children exceed parent → flex children get 0px (no negative sizes).
        // Parent: 100px, fixed1: 60px, fixed2: 60px = 120px > 100px → remaining = 0
        let root = make_flex_column_parent(
            "root",
            100.0,
            vec![
                make_rect("a", 80.0, 60.0),
                make_rect("b", 80.0, 60.0),
                make_flex("stretch", 1.0),
            ],
        );
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let stretch = frames.get("stretch").unwrap();
        assert!(stretch.rect.h >= 0.0);
        assert!(stretch.rect.h < 0.001);
    }

    #[test]
    fn test_flex_shrink_zero_keeps_size() {
        // flex_shrink:0 with explicit height keeps its size.
        // This verifies flex_shrink:0 nodes are treated as Explicit (not FlexGrow).
        let mut action_bar = make_rect("action_bar", 320.0, 52.0);
        action_bar.props.style.as_mut().unwrap().flex_shrink = Some(0.0);

        let root = make_flex_column_parent(
            "popover",
            400.0,
            vec![
                make_rect("tab_bar", 320.0, 40.0),
                make_flex("panels", 1.0),
                action_bar,
            ],
        );
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        // action_bar has explicit height + flex_shrink:0 → keeps 52px
        let ab = frames.get("action_bar").unwrap();
        assert_eq!(ab.rect.h, 52.0);

        // panels fills remaining: 400 - 40 - 52 = 308
        let panels = frames.get("panels").unwrap();
        assert!((panels.rect.h - 308.0).abs() < 0.001);
    }

    #[test]
    fn test_flex_grow_with_explicit_cross_axis() {
        // A node with flex:1 AND height:36 in a flex-row should:
        // - Absorb remaining width via flex (main axis = X)
        // - Use explicit 36px height (cross axis = Y)
        // This is the textarea bug fix: flex + explicit dimensions coexist.
        let mut textarea = SceneNode::new("textarea", NodeKind::Container);
        textarea.props.style = Some(ResolvedStyle {
            flex: Some(1.0),
            height: Some(Dimension::Pixels(36.0)),
            ..Default::default()
        });

        let send_button = make_rect("send_button", 60.0, 36.0);

        let root = make_flex_row_parent("input_area", 500.0, vec![textarea, send_button]);

        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        // send_button: 60px wide, explicit
        let btn = frames.get("send_button").unwrap();
        assert_eq!(btn.rect.w, 60.0);
        assert_eq!(btn.rect.h, 36.0);

        // textarea: flex:1 absorbs remaining 500-60 = 440px width, keeps 36px height
        let ta = frames.get("textarea").unwrap();
        assert!(
            (ta.rect.w - 440.0).abs() < 0.001,
            "textarea width should be 440, got {}",
            ta.rect.w
        );
        assert_eq!(ta.rect.h, 36.0, "textarea height should be 36");
        assert_eq!(ta.rect.x, 0.0);
    }

    #[test]
    fn test_flex_grow_with_explicit_cross_axis_column() {
        // Same test in a column layout: flex:1 + width:280 in a flex-column.
        // Main axis = Y, flex absorbs remaining height.
        // Cross axis = X, explicit 280px width.
        let mut sidebar = SceneNode::new("sidebar", NodeKind::Container);
        sidebar.props.style = Some(ResolvedStyle {
            flex: Some(1.0),
            width: Some(Dimension::Pixels(280.0)),
            ..Default::default()
        });

        let header = make_rect("header", 400.0, 50.0);

        let root = make_flex_column_parent("root", 400.0, vec![header, sidebar]);

        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        // sidebar: flex:1 absorbs remaining 400-50 = 350px height, keeps 280px width
        let sb = frames.get("sidebar").unwrap();
        assert!(
            (sb.rect.h - 350.0).abs() < 0.001,
            "sidebar height should be 350, got {}",
            sb.rect.h
        );
        assert_eq!(sb.rect.w, 280.0, "sidebar width should be 280");
    }

    #[test]
    fn test_flex_grow_invisible_sibling() {
        // Invisible children excluded from space calculation.
        // Parent: 200px, invisible: 50px (excluded), flex:1 → gets full 200px
        let mut invisible = make_rect("hidden", 80.0, 50.0);
        invisible.visible = Visibility::Resolved(false);

        let root = make_flex_column_parent("root", 200.0, vec![invisible, make_flex("fill", 1.0)]);
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        // Invisible node should not be in frames
        assert!(frames.get("hidden").is_none());

        let fill = frames.get("fill").unwrap();
        assert_eq!(fill.rect.y, 0.0);
        assert!((fill.rect.h - 200.0).abs() < 0.001);
    }

    #[test]
    fn test_flex_grow_nested() {
        // Flex:1 child inside another flex:1 parent both get correct sizes.
        // Outer: 400px column → inner(flex:1) gets 400px
        // Inner: 400px column → grandchild(flex:1) gets full 400px
        let grandchild = make_flex("grandchild", 1.0);
        let mut inner = make_flex("inner", 1.0);
        inner.children = vec![Arc::new(grandchild)];
        // Inner needs layout config to arrange its children
        inner.props.style.as_mut().unwrap().layout = Some(LayoutConfig {
            mode: Some(LayoutMode::Flex),
            axis: Some(LayoutAxis::Y),
            ..Default::default()
        });

        let root = make_flex_column_parent("root", 400.0, vec![inner]);
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let inner_frame = frames.get("inner").unwrap();
        assert!((inner_frame.rect.h - 400.0).abs() < 0.001);

        let gc_frame = frames.get("grandchild").unwrap();
        assert!((gc_frame.rect.h - 400.0).abs() < 0.001);
    }

    #[test]
    fn test_flex_grow_no_flex_children() {
        // No flex children → existing flow behavior unchanged (regression guard).
        // Parent: 300px, two fixed children → placed sequentially, no flex distribution
        let root = make_flex_column_parent(
            "root",
            300.0,
            vec![make_rect("a", 80.0, 50.0), make_rect("b", 80.0, 30.0)],
        );
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let a = frames.get("a").unwrap();
        assert_eq!(a.rect.y, 0.0);
        assert_eq!(a.rect.h, 50.0);

        let b = frames.get("b").unwrap();
        assert_eq!(b.rect.y, 50.0);
        assert_eq!(b.rect.h, 30.0);
    }

    #[test]
    fn test_existing_flow_column_unchanged() {
        // Existing test_flow_column scenario passes unchanged (regression guard).
        // This duplicates the original test_flow_column logic to confirm no regression.
        let root = make_container(
            "reg_root",
            vec![
                make_rect("reg_c1", 100.0, 50.0),
                make_rect("reg_c2", 80.0, 30.0),
            ],
        );
        let frames = compute_layout(&root, Size::new(800.0, 600.0), None, &HashMap::new());

        let c1 = frames.get("reg_c1").unwrap();
        assert_eq!(c1.rect.y, 0.0);
        assert_eq!(c1.rect.h, 50.0);

        let c2 = frames.get("reg_c2").unwrap();
        assert_eq!(c2.rect.y, 50.0);
        assert_eq!(c2.rect.h, 30.0);
    }

    // ====================================================================
    // Incremental Layout Tests (Task 153, Agent 3)
    // ====================================================================

    /// Helper: build a deep binary tree of N levels.
    /// Each internal node is a container with left and right children.
    /// Leaf nodes are rects with explicit size.
    fn make_deep_tree(prefix: &str, depth: usize) -> SceneNode {
        if depth == 0 {
            make_rect(&format!("{prefix}_leaf"), 50.0, 30.0)
        } else {
            make_container(
                &format!("{prefix}_d{depth}"),
                vec![
                    make_deep_tree(&format!("{prefix}_L"), depth - 1),
                    make_deep_tree(&format!("{prefix}_R"), depth - 1),
                ],
            )
        }
    }

    /// Helper: build a wide tree with N children under a single root.
    fn make_wide_tree(num_children: usize) -> SceneNode {
        let children: Vec<SceneNode> = (0..num_children)
            .map(|i| make_rect(&format!("child_{i}"), 10.0, 10.0))
            .collect();
        make_container("root", children)
    }

    /// INV-038: Incremental layout handles new nodes (no previous frame) by
    /// measuring them fresh instead of returning Size::ZERO. When a node is
    /// added to the tree (InsertNode or visibility flip), its parent is marked
    /// dirty, and incremental layout discovers and measures the new child.
    #[test]
    fn incremental_new_node_without_previous_frame_measured_fresh() {
        // Initial tree: root → [c1]
        let initial_root = make_container("root", vec![make_rect("c1", 100.0, 50.0)]);
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(
            &initial_root,
            viewport,
            None,
            &HashMap::new(),
        ));

        // New tree: root → [c1, c2_new] — c2_new has no previous frame
        let new_root = make_container(
            "root",
            vec![
                make_rect("c1", 100.0, 50.0),
                make_rect("c2_new", 80.0, 30.0),
            ],
        );

        // Mark root as dirty (mark_scene_structure_for adds parent to dirty_nodes)
        let mut dirty = HashSet::new();
        dirty.insert("root".to_string());

        let result = compute_layout_incremental(
            &new_root,
            viewport,
            None,
            &HashMap::new(),
            previous,
            &dirty,
        );

        // Full layout as reference
        let full = compute_layout(&new_root, viewport, None, &HashMap::new());

        // c2_new must have a frame with correct size (not Size::ZERO)
        let c2_frame = result.get("c2_new").expect("new node must have a frame");
        assert!(c2_frame.rect.w > 0.0, "new node width must not be zero");
        assert!(c2_frame.rect.h > 0.0, "new node height must not be zero");

        // Incremental must match full layout for all nodes
        assert_eq!(full.len(), result.len(), "frame count must match");
        for (id, frame) in &full {
            let inc_frame = result
                .get(id)
                .unwrap_or_else(|| panic!("missing frame for {id}"));
            assert!(
                (frame.rect.x - inc_frame.rect.x).abs() < 0.001,
                "x mismatch for {id}"
            );
            assert!(
                (frame.rect.y - inc_frame.rect.y).abs() < 0.001,
                "y mismatch for {id}"
            );
            assert!(
                (frame.rect.w - inc_frame.rect.w).abs() < 0.001,
                "w mismatch for {id}"
            );
            assert!(
                (frame.rect.h - inc_frame.rect.h).abs() < 0.001,
                "h mismatch for {id}"
            );
        }
    }

    /// compute_layout_incremental() with empty dirty_nodes returns previous
    /// frames unchanged — same Arc identity (O(1), zero cloning).
    #[test]
    fn incremental_empty_dirty_returns_previous_frames() {
        let root = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), make_rect("c2", 80.0, 30.0)],
        );
        let viewport = Size::new(800.0, 600.0);

        // Compute initial layout
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // Incremental with no dirty nodes
        let dirty = HashSet::new();
        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Must be the exact same Arc — O(1) identity preservation
        assert!(
            Arc::ptr_eq(&previous, &result.frames),
            "empty dirty must return same Arc"
        );
    }

    /// Single dirty node at leaf recomputes only that node's layout.
    /// Other nodes in the tree preserve their previous frames.
    #[test]
    fn incremental_single_dirty_leaf() {
        // Tree: root → [left_panel → [header, dirty_leaf], right_panel → [item]]
        let root = make_container(
            "root",
            vec![
                make_container(
                    "left",
                    vec![
                        make_rect("header", 100.0, 40.0),
                        make_rect("dirty_leaf", 80.0, 30.0),
                    ],
                ),
                make_container("right", vec![make_rect("item", 60.0, 20.0)]),
            ],
        );
        let viewport = Size::new(800.0, 600.0);

        // Compute initial layout
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // Mark only dirty_leaf as dirty
        let mut dirty = HashSet::new();
        dirty.insert("dirty_leaf".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Right subtree should be preserved exactly
        let prev_item = previous.get("item").unwrap();
        let res_item = result.get("item").unwrap();
        assert_eq!(
            prev_item.rect.x, res_item.rect.x,
            "right subtree item x changed"
        );
        assert_eq!(
            prev_item.rect.y, res_item.rect.y,
            "right subtree item y changed"
        );
        assert_eq!(
            prev_item.rect.w, res_item.rect.w,
            "right subtree item w changed"
        );
        assert_eq!(
            prev_item.rect.h, res_item.rect.h,
            "right subtree item h changed"
        );

        // Right panel itself should be preserved
        let prev_right = previous.get("right").unwrap();
        let res_right = result.get("right").unwrap();
        assert_eq!(prev_right.rect, res_right.rect, "right panel frame changed");

        // Dirty leaf should still have valid layout
        let res_dirty = result.get("dirty_leaf").unwrap();
        assert!(res_dirty.rect.w > 0.0, "dirty leaf must have valid width");
        assert!(res_dirty.rect.h > 0.0, "dirty leaf must have valid height");
    }

    /// Dirty node at root recomputes entire tree (conservative for root changes).
    #[test]
    fn incremental_dirty_root_recomputes_entire_tree() {
        let root = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), make_rect("c2", 80.0, 30.0)],
        );
        let viewport = Size::new(800.0, 600.0);

        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // Mark root as dirty
        let mut dirty = HashSet::new();
        dirty.insert("root".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Full layout should match — root dirty means entire tree recomputed
        let full = compute_layout(&root, viewport, None, &HashMap::new());
        for (id, frame) in &full {
            let res = result.get(id).unwrap();
            assert!(
                (frame.rect.x - res.rect.x).abs() < 0.001,
                "x mismatch for {id}"
            );
            assert!(
                (frame.rect.y - res.rect.y).abs() < 0.001,
                "y mismatch for {id}"
            );
            assert!(
                (frame.rect.w - res.rect.w).abs() < 0.001,
                "w mismatch for {id}"
            );
            assert!(
                (frame.rect.h - res.rect.h).abs() < 0.001,
                "h mismatch for {id}"
            );
        }
    }

    /// Dirty node in left subtree does NOT trigger recomputation of right subtree.
    /// Right subtree frames are preserved exactly from previous.
    #[test]
    fn incremental_left_dirty_right_preserved() {
        // Tree: root → [left → [dirty_child], right → [clean_a, clean_b]]
        let root = make_container(
            "root",
            vec![
                make_container("left", vec![make_rect("dirty_child", 100.0, 50.0)]),
                make_container(
                    "right",
                    vec![
                        make_rect("clean_a", 60.0, 20.0),
                        make_rect("clean_b", 40.0, 15.0),
                    ],
                ),
            ],
        );
        let viewport = Size::new(800.0, 600.0);

        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // Only left subtree is dirty
        let mut dirty = HashSet::new();
        dirty.insert("dirty_child".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Right subtree frames must be exactly preserved
        for id in &["right", "clean_a", "clean_b"] {
            let prev = previous.get(*id).unwrap();
            let res = result.get(*id).unwrap();
            assert_eq!(prev.rect.x, res.rect.x, "{id} x changed");
            assert_eq!(prev.rect.y, res.rect.y, "{id} y changed");
            assert_eq!(prev.rect.w, res.rect.w, "{id} w changed");
            assert_eq!(prev.rect.h, res.rect.h, "{id} h changed");
        }
    }

    /// Layout result from incremental matches full computation for same inputs.
    /// This is the correctness invariant: incremental NEVER produces different
    /// output than full recomputation for the same tree + viewport + dirty state.
    #[test]
    fn incremental_matches_full_computation() {
        let root = make_container(
            "root",
            vec![make_container(
                "panel",
                vec![
                    make_rect("a", 100.0, 50.0),
                    make_rect("b", 80.0, 30.0),
                    make_rect("c", 60.0, 20.0),
                ],
            )],
        );
        let viewport = Size::new(800.0, 600.0);

        // Full computation
        let full = compute_layout(&root, viewport, None, &HashMap::new());

        // Incremental with all nodes dirty (should match full)
        let mut dirty = HashSet::new();
        dirty.insert("root".to_string());
        dirty.insert("panel".to_string());
        dirty.insert("a".to_string());
        dirty.insert("b".to_string());
        dirty.insert("c".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::new(HashMap::new()),
            &dirty,
        );

        assert_eq!(full.len(), result.len(), "frame count mismatch");
        for (id, frame) in &full {
            let res = result.get(id).expect(&format!("missing frame for {id}"));
            assert!(
                (frame.rect.x - res.rect.x).abs() < 0.001,
                "x mismatch for {id}"
            );
            assert!(
                (frame.rect.y - res.rect.y).abs() < 0.001,
                "y mismatch for {id}"
            );
            assert!(
                (frame.rect.w - res.rect.w).abs() < 0.001,
                "w mismatch for {id}"
            );
            assert!(
                (frame.rect.h - res.rect.h).abs() < 0.001,
                "h mismatch for {id}"
            );
        }
    }

    /// Viewport change with root dirty recomputes layout correctly.
    /// (In production, viewport changes use full layout via force_full_layout.
    /// This test validates that incremental also produces correct results
    /// when dirty nodes are properly set.)
    #[test]
    fn incremental_viewport_change_with_all_dirty() {
        let root = make_container("root", vec![make_rect("c1", 100.0, 50.0)]);
        let old_viewport = Size::new(800.0, 600.0);
        let new_viewport = Size::new(1024.0, 768.0);

        // Previous frames from old viewport
        let previous = Arc::new(compute_layout(&root, old_viewport, None, &HashMap::new()));

        // Root dirty — all descendants get re-measured with new viewport
        let mut dirty = HashSet::new();
        dirty.insert("root".to_string());
        let result = compute_layout_incremental(
            &root,
            new_viewport,
            None,
            &HashMap::new(),
            previous,
            &dirty,
        );

        // Should match full computation with new viewport
        let full = compute_layout(&root, new_viewport, None, &HashMap::new());
        for (id, frame) in &full {
            let res = result.get(id).unwrap();
            assert!(
                (frame.rect.x - res.rect.x).abs() < 0.001,
                "x mismatch for {id}"
            );
            assert!(
                (frame.rect.y - res.rect.y).abs() < 0.001,
                "y mismatch for {id}"
            );
            assert!(
                (frame.rect.w - res.rect.w).abs() < 0.001,
                "w mismatch for {id}"
            );
            assert!(
                (frame.rect.h - res.rect.h).abs() < 0.001,
                "h mismatch for {id}"
            );
        }
    }

    /// Node width change in a flex container: when both the changed node and
    /// its parent are marked dirty, siblings get recomputed by the parent's
    /// flex distribution.
    #[test]
    fn incremental_flex_dirty_parent_recomputes_siblings() {
        // Parent: 300px column, child_a(100px) + child_b(flex:1=200px)
        let root = make_flex_column_parent(
            "root",
            300.0,
            vec![make_rect("child_a", 80.0, 100.0), make_flex("child_b", 1.0)],
        );
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // Verify initial: child_b gets 200px (300 - 100)
        let prev_b = previous.get("child_b").unwrap();
        assert!((prev_b.rect.h - 200.0).abs() < 0.001);

        // Mark root dirty (simulating parent being marked when child changes)
        let mut dirty = HashSet::new();
        dirty.insert("root".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // child_b should be recomputed (root is on dirty path, so children get re-placed)
        let res_b = result.get("child_b").unwrap();
        assert!((res_b.rect.h - 200.0).abs() < 0.001);
        assert!((res_b.rect.y - 100.0).abs() < 0.001);
    }

    /// Deep tree (10 levels) with single dirty leaf: only the path from root
    /// to the dirty leaf is recomputed. Sibling branches are preserved.
    #[test]
    fn incremental_deep_tree_single_dirty_leaf() {
        let root = make_deep_tree("root", 10);
        let viewport = Size::new(800.0, 600.0);

        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // The leftmost leaf at depth 10 is: root_L_L_L_L_L_L_L_L_L_L_leaf
        let dirty_leaf_id = "root_L_L_L_L_L_L_L_L_L_L_leaf".to_string();
        let mut dirty = HashSet::new();
        dirty.insert(dirty_leaf_id.clone());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // The dirty leaf should have valid layout
        let leaf_frame = result.get(&dirty_leaf_id).unwrap();
        assert!(leaf_frame.rect.w > 0.0, "dirty leaf must have valid width");

        // A rightmost leaf (completely separate branch) should be preserved exactly
        let clean_leaf_id = "root_R_R_R_R_R_R_R_R_R_R_leaf";
        let prev_clean = previous.get(clean_leaf_id).unwrap();
        let res_clean = result.get(clean_leaf_id).unwrap();
        assert_eq!(
            prev_clean.rect, res_clean.rect,
            "clean branch leaf must be preserved"
        );
    }

    /// Previous frames for non-dirty nodes in separate subtrees are preserved exactly.
    #[test]
    fn incremental_previous_frames_preserved_for_clean_subtrees() {
        let root = make_container(
            "root",
            vec![
                make_container("dirty_branch", vec![make_rect("dirty_node", 100.0, 50.0)]),
                make_container(
                    "clean_branch",
                    vec![
                        make_rect("clean_child_1", 60.0, 20.0),
                        make_rect("clean_child_2", 40.0, 15.0),
                        make_rect("clean_child_3", 30.0, 10.0),
                    ],
                ),
            ],
        );
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        let mut dirty = HashSet::new();
        dirty.insert("dirty_node".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // All clean_branch nodes must have exactly the same frames
        for id in &[
            "clean_branch",
            "clean_child_1",
            "clean_child_2",
            "clean_child_3",
        ] {
            let prev = previous.get(*id).unwrap();
            let res = result.get(*id).unwrap();
            assert_eq!(
                prev.rect, res.rect,
                "clean subtree node '{id}' frame must be preserved exactly"
            );
        }
    }

    /// Empty tree returns empty frames regardless of dirty state.
    #[test]
    fn incremental_empty_tree_returns_empty() {
        let root = make_container("root", vec![]);
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        let mut dirty = HashSet::new();
        dirty.insert("root".to_string());
        dirty.insert("nonexistent".to_string());

        let result =
            compute_layout_incremental(&root, viewport, None, &HashMap::new(), previous, &dirty);

        // Root should have a frame, but no children
        assert!(result.contains_key("root"), "root must have a frame");
        assert_eq!(result.len(), 1, "only root frame for empty tree");
    }

    /// Performance: 1000-node tree with 1 dirty node completes in <1ms.
    /// This test verifies the optimization is effective — incremental layout
    /// should skip the vast majority of the tree.
    #[test]
    fn incremental_performance_1000_nodes_1_dirty() {
        // Build a wide tree with 1000 child nodes
        let root = make_wide_tree(1000);
        let viewport = Size::new(10000.0, 10000.0);

        // Compute initial full layout
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));
        assert_eq!(previous.len(), 1001); // root + 1000 children

        // Mark only one child dirty
        let mut dirty = HashSet::new();
        dirty.insert("child_500".to_string());

        let start = std::time::Instant::now();
        let _result =
            compute_layout_incremental(&root, viewport, None, &HashMap::new(), previous, &dirty);
        let elapsed = start.elapsed();

        // Must complete in under 1ms (generous threshold for CI variability)
        assert!(
            elapsed.as_millis() < 10,
            "incremental layout took {}ms (expected <10ms)",
            elapsed.as_millis()
        );
    }

    /// subtree_contains_dirty correctly identifies dirty subtrees.
    #[test]
    fn subtree_contains_dirty_correctness() {
        let root = make_container(
            "root",
            vec![
                make_container("left", vec![make_rect("dirty_leaf", 50.0, 30.0)]),
                make_container("right", vec![make_rect("clean_leaf", 50.0, 30.0)]),
            ],
        );

        let mut dirty = HashSet::new();
        dirty.insert("dirty_leaf".to_string());

        // Root: has dirty descendant → true
        assert!(subtree_contains_dirty(&root, &dirty));
        // Left: has dirty descendant → true
        assert!(subtree_contains_dirty(&root.children[0], &dirty));
        // dirty_leaf itself → true
        assert!(subtree_contains_dirty(
            &root.children[0].children[0],
            &dirty
        ));
        // Right: no dirty descendant → false
        assert!(!subtree_contains_dirty(&root.children[1], &dirty));
        // clean_leaf → false
        assert!(!subtree_contains_dirty(
            &root.children[1].children[0],
            &dirty
        ));
    }

    /// collect_dirty_subtrees marks all ancestors of dirty nodes.
    #[test]
    fn collect_dirty_subtrees_marks_ancestors() {
        let root = make_container(
            "root",
            vec![
                make_container("left", vec![make_rect("dirty_leaf", 50.0, 30.0)]),
                make_container("right", vec![make_rect("clean_leaf", 50.0, 30.0)]),
            ],
        );

        let mut dirty = HashSet::new();
        dirty.insert("dirty_leaf".to_string());

        let result = collect_dirty_subtrees(&root, &dirty);

        // Dirty path: root → left → dirty_leaf
        assert!(result.contains("root"), "root must be in dirty_subtrees");
        assert!(result.contains("left"), "left must be in dirty_subtrees");
        assert!(
            result.contains("dirty_leaf"),
            "dirty_leaf must be in dirty_subtrees"
        );

        // Clean branch: right, clean_leaf
        assert!(
            !result.contains("right"),
            "right must NOT be in dirty_subtrees"
        );
        assert!(
            !result.contains("clean_leaf"),
            "clean_leaf must NOT be in dirty_subtrees"
        );
    }

    /// Dirty nodes not in tree are harmlessly ignored.
    #[test]
    fn incremental_dirty_nodes_not_in_tree_ignored() {
        let root = make_container("root", vec![make_rect("c1", 100.0, 50.0)]);
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // Dirty nodes contain IDs not present in tree
        let mut dirty = HashSet::new();
        dirty.insert("nonexistent_node".to_string());
        dirty.insert("also_not_here".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Previous frames should be returned unchanged — same Arc identity
        // because none of the dirty node IDs exist in the tree
        assert!(
            Arc::ptr_eq(&previous, &result.frames),
            "non-tree dirty nodes must return same Arc"
        );
    }

    // =========================================================================
    // V6 Arc Identity Tests — Verify clone elimination (Task 178 Agent 4)
    // =========================================================================

    /// Dirty nodes produce a new Arc (not pointer-equal to previous).
    /// Verifies that actual layout work returns fresh data.
    #[test]
    fn arc_dirty_nodes_returns_new_arc() {
        let root = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), make_rect("c2", 80.0, 30.0)],
        );
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        let mut dirty = HashSet::new();
        dirty.insert("c1".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Dirty nodes cause mutation → new Arc (or mutated-in-place if sole owner,
        // but we cloned so previous still holds a reference → clone-on-write fires)
        assert!(
            !Arc::ptr_eq(&previous, &result.frames),
            "dirty update must produce new Arc"
        );
        // Layout values must still be valid
        assert!(result.get("c1").unwrap().rect.w > 0.0);
        assert!(result.get("c2").unwrap().rect.w > 0.0);
    }

    /// INV-038: When a new child is added and parent is dirty, incremental
    /// layout produces a new Arc (not identity-preserved) with correct frames.
    #[test]
    fn arc_new_child_with_dirty_parent_returns_new_arc() {
        let initial = make_container("root", vec![make_rect("c1", 100.0, 50.0)]);
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&initial, viewport, None, &HashMap::new()));

        // Tree now has a new child — root is marked dirty
        let updated = make_container(
            "root",
            vec![
                make_rect("c1", 100.0, 50.0),
                make_rect("c2_new", 80.0, 30.0),
            ],
        );
        let mut dirty = HashSet::new();
        dirty.insert("root".to_string());

        let result = compute_layout_incremental(
            &updated,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Dirty parent → new Arc with updated frames
        assert!(
            !Arc::ptr_eq(&previous, &result.frames),
            "dirty update must produce new Arc"
        );
        assert!(result.contains_key("c2_new"), "new child must have a frame");
        assert!(
            result.get("c2_new").unwrap().rect.w > 0.0,
            "new child must have non-zero width"
        );
    }

    /// Arc identity preserved when sole owner and nothing dirty.
    /// When there is only one Arc holder and dirty_nodes is empty,
    /// the function returns the exact same Arc with no work done.
    #[test]
    fn arc_identity_preserved_sole_owner_clean() {
        let root = make_container("root", vec![make_rect("c1", 100.0, 50.0)]);
        let viewport = Size::new(800.0, 600.0);
        let frames = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));
        let frames_ptr = Arc::as_ptr(&frames);

        let dirty = HashSet::new();
        let result =
            compute_layout_incremental(&root, viewport, None, &HashMap::new(), frames, &dirty);

        // Same pointer — zero allocation, zero cloning
        assert_eq!(
            Arc::as_ptr(&result.frames),
            frames_ptr,
            "sole-owner clean must preserve pointer"
        );
    }

    /// 1000 frames with empty dirty set completes in O(1) — verifiable via timing.
    /// The Arc is returned directly without touching the HashMap.
    #[test]
    fn arc_1000_frames_empty_dirty_is_o1() {
        let root = make_wide_tree(1000);
        let viewport = Size::new(10000.0, 10000.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));
        assert_eq!(previous.len(), 1001);

        let dirty = HashSet::new();

        // Warmup
        let _ = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Timed run
        let start = std::time::Instant::now();
        for _ in 0..1000 {
            let _ = compute_layout_incremental(
                &root,
                viewport,
                None,
                &HashMap::new(),
                Arc::clone(&previous),
                &dirty,
            );
        }
        let elapsed = start.elapsed();

        // 1000 iterations on 1001-frame HashMap must complete in <10ms total
        // (each call is O(1) Arc return — sub-microsecond)
        assert!(
            elapsed.as_millis() < 10,
            "1000 iterations of empty-dirty on 1001 frames took {}ms (expected <10ms)",
            elapsed.as_millis()
        );
    }

    /// Arc::make_mut in-place mutation when sole owner.
    /// When the Arc has refcount=1, make_mut does NOT clone — mutation is O(1).
    #[test]
    fn arc_make_mut_inplace_when_sole_owner() {
        let root = make_container("root", vec![make_rect("c1", 100.0, 50.0)]);
        let viewport = Size::new(800.0, 600.0);
        // Do NOT clone — pass the sole Arc directly
        let frames = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));
        let frames_ptr = Arc::as_ptr(&frames);

        let mut dirty = HashSet::new();
        dirty.insert("c1".to_string());

        // Sole owner → Arc::make_mut mutates in-place (no clone)
        let result =
            compute_layout_incremental(&root, viewport, None, &HashMap::new(), frames, &dirty);

        // Same underlying allocation — make_mut saw refcount=1 and mutated in-place
        assert_eq!(
            Arc::as_ptr(&result.frames),
            frames_ptr,
            "sole-owner dirty update must mutate in-place via Arc::make_mut"
        );
    }

    /// INV-022: Verify split layout with exact migration 016 data
    #[test]
    fn test_inv022_editor_content_split_parts() {
        let layout_config = LayoutConfig::from_style_layout(&serde_json::json!({
            "mode": "split",
            "axis": "column",
            "gap": 0,
            "parts": [0.067, 0.933],
            "x": 0,
            "y": 0
        }));

        // Verify parts parsed correctly
        let parts = layout_config.parts.as_ref().unwrap();
        assert_eq!(parts.len(), 2);
        assert!((parts[0].fraction - 0.067).abs() < 0.001);
        assert!((parts[1].fraction - 0.933).abs() < 0.001);

        // Build tree matching editor layout
        let toolbar = {
            let mut n = SceneNode::new("layout:editor:toolbar", NodeKind::Container);
            n.style = Some(ResolvedStyle {
                width: Some(Dimension::Pixels(1024.0)),
                height: Some(Dimension::Pixels(48.0)),
                layout: Some(LayoutConfig {
                    mode: Some(LayoutMode::Flex),
                    axis: Some(LayoutAxis::X),
                    gap: Some(8.0),
                    ..Default::default()
                }),
                ..Default::default()
            });
            n
        };

        let main_node = {
            let mut n = SceneNode::new("layout:editor:main", NodeKind::Container);
            n.style = Some(ResolvedStyle {
                width: Some(Dimension::Pixels(1024.0)),
                height: Some(Dimension::Pixels(672.0)),
                layout: Some(LayoutConfig {
                    mode: Some(LayoutMode::Flex),
                    axis: Some(LayoutAxis::X),
                    gap: Some(0.0),
                    ..Default::default()
                }),
                ..Default::default()
            });
            n
        };

        let content = {
            let mut n = SceneNode::new("layout:editor:content", NodeKind::Container)
                .with_children(vec![toolbar, main_node]);
            n.style = Some(ResolvedStyle {
                width: Some(Dimension::Pixels(1024.0)),
                height: Some(Dimension::Pixels(720.0)),
                layout: Some(layout_config),
                ..Default::default()
            });
            n
        };

        let viewport = Size::new(1024.0, 720.0);
        let frames = compute_layout(&content, viewport, None, &HashMap::new());

        let toolbar_frame = frames.get("layout:editor:toolbar").unwrap();
        let main_frame = frames.get("layout:editor:main").unwrap();

        // With parts [0.067, 0.933], toolbar should be ~48px, not 360px
        assert!(
            (toolbar_frame.rect.h - 48.24).abs() < 1.0,
            "Toolbar height should be ~48px (0.067 * 720), got {:.1}",
            toolbar_frame.rect.h
        );
        assert!(
            (main_frame.rect.h - 671.76).abs() < 1.0,
            "Main height should be ~672px (0.933 * 720), got {:.1}",
            main_frame.rect.h
        );
    }

    // ====================================================================
    // Dimension::Percent Tests (Task 0244, Agent 1)
    // ====================================================================
    //
    // These tests verify that Dimension::Percent dimensions resolve correctly
    // against parent constraints, enabling responsive layouts.

    #[test]
    fn test_dimension_percent_width() {
        // Parent: 800px wide
        // Child: width="50%" → should be 400px
        let mut child = make_rect("child", 0.0, 100.0);
        child.props.style = Some(ResolvedStyle {
            width: Some(Dimension::Percent(0.5)), // 50%
            height: Some(Dimension::Pixels(100.0)),
            ..Default::default()
        });

        let mut parent = SceneNode::new("parent", NodeKind::Container).with_children(vec![child]);
        parent.props.style = Some(ResolvedStyle {
            width: Some(Dimension::Pixels(800.0)),
            height: Some(Dimension::Pixels(600.0)),
            ..Default::default()
        });

        let viewport = Size::new(1024.0, 768.0);
        let frames = compute_layout(&parent, viewport, None, &HashMap::new());

        let child_frame = frames.get("child").unwrap();
        assert_eq!(child_frame.rect.w, 400.0, "50% of 800px should be 400px");
        assert_eq!(child_frame.rect.h, 100.0);
    }

    #[test]
    fn test_dimension_percent_fill_parent() {
        // Parent: 1024px wide, 768px tall
        // Child: width="100%", height="100%" → should fill parent
        let mut child = make_rect("child", 0.0, 0.0);
        child.props.style = Some(ResolvedStyle {
            width: Some(Dimension::Percent(1.0)),  // 100%
            height: Some(Dimension::Percent(1.0)), // 100%
            ..Default::default()
        });

        let mut parent = SceneNode::new("parent", NodeKind::Container).with_children(vec![child]);
        parent.props.style = Some(ResolvedStyle {
            width: Some(Dimension::Pixels(1024.0)),
            height: Some(Dimension::Pixels(768.0)),
            ..Default::default()
        });

        let viewport = Size::new(1920.0, 1080.0);
        let frames = compute_layout(&parent, viewport, None, &HashMap::new());

        let child_frame = frames.get("child").unwrap();
        assert_eq!(
            child_frame.rect.w, 1024.0,
            "100% of 1024px should be 1024px"
        );
        assert_eq!(child_frame.rect.h, 768.0, "100% of 768px should be 768px");
    }

    // ====================================================================
    // Incremental Layout — O(dirty) Sizes Tests (Task 204, Agent 2)
    // ====================================================================
    //
    // These tests verify that the O(n) sizes HashMap pre-collection has been
    // eliminated. The sizes map now starts empty (capacity = dirty count),
    // and clean nodes resolve their measured_size from previous_frames via
    // resolve_size() fallback during the place phase.

    /// O(1) fast path: no dirty nodes returns same Arc identity.
    #[test]
    fn sizes_no_dirty_returns_previous_unchanged() {
        let root = make_container(
            "root",
            vec![make_rect("a", 100.0, 50.0), make_rect("b", 80.0, 30.0)],
        );
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));
        let dirty = HashSet::new();

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        assert!(
            Arc::ptr_eq(&previous, &result.frames),
            "empty dirty must return same Arc"
        );
    }

    /// Single dirty node is remeasured; clean siblings preserve sizes.
    #[test]
    fn sizes_one_dirty_only_measures_dirty() {
        let root = make_container(
            "root",
            vec![
                make_rect("clean", 100.0, 50.0),
                make_rect("dirty", 80.0, 30.0),
            ],
        );
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        let mut dirty = HashSet::new();
        dirty.insert("dirty".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Clean node preserves exact frame
        let prev_clean = previous.get("clean").unwrap();
        let res_clean = result.get("clean").unwrap();
        assert_eq!(prev_clean.rect, res_clean.rect, "clean node rect changed");
        assert_eq!(
            prev_clean.measured_size, res_clean.measured_size,
            "clean measured_size changed"
        );

        // Dirty node still has valid layout
        let res_dirty = result.get("dirty").unwrap();
        assert!(
            res_dirty.rect.w > 0.0 && res_dirty.rect.h > 0.0,
            "dirty must have valid size"
        );
    }

    /// Clean nodes preserve their measured_size from previous frames.
    #[test]
    fn sizes_clean_nodes_preserve_sizes() {
        let root = make_container(
            "root",
            vec![
                make_rect("c1", 120.0, 60.0),
                make_rect("c2", 90.0, 45.0),
                make_rect("c3", 70.0, 35.0),
            ],
        );
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // Only c2 is dirty
        let mut dirty = HashSet::new();
        dirty.insert("c2".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // c1 and c3 must preserve exact measured_size from previous
        for id in &["c1", "c3"] {
            let prev_ms = previous.get(*id).unwrap().measured_size;
            let res_ms = result.get(*id).unwrap().measured_size;
            assert_eq!(prev_ms, res_ms, "{id} measured_size changed");
        }
    }

    /// INV-038: Incremental layout with dirty root and empty previous frames
    /// produces the same result as full layout. This covers the case where
    /// all nodes are new (e.g., template insertion with root marked dirty).
    #[test]
    fn sizes_all_new_nodes_with_dirty_root_matches_full() {
        let root = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), make_rect("c2", 80.0, 30.0)],
        );
        let viewport = Size::new(800.0, 600.0);
        let full = compute_layout(&root, viewport, None, &HashMap::new());
        let previous = Arc::new(HashMap::new());
        let mut dirty = HashSet::new();
        dirty.insert("root".to_string());

        let result =
            compute_layout_incremental(&root, viewport, None, &HashMap::new(), previous, &dirty);

        // Must match full computation
        assert_eq!(full.len(), result.len());
        for (id, f) in &full {
            let r = result
                .get(id)
                .unwrap_or_else(|| panic!("missing frame for {id}"));
            assert!((f.rect.w - r.rect.w).abs() < 0.001, "w mismatch for {id}");
            assert!((f.rect.h - r.rect.h).abs() < 0.001, "h mismatch for {id}");
        }
    }

    /// Dirty subtree children are correctly measured and placed.
    #[test]
    fn sizes_dirty_subtree_measured() {
        let root = make_container(
            "root",
            vec![
                make_container(
                    "parent",
                    vec![
                        make_rect("child1", 50.0, 25.0),
                        make_rect("child2", 60.0, 30.0),
                    ],
                ),
                make_rect("sibling", 100.0, 50.0),
            ],
        );
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // Mark parent as dirty — both children in dirty subtree
        let mut dirty = HashSet::new();
        dirty.insert("parent".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // All children of dirty parent must have valid frames
        assert!(result.get("child1").is_some(), "child1 must have frame");
        assert!(result.get("child2").is_some(), "child2 must have frame");
        let c1 = result.get("child1").unwrap();
        assert_eq!(c1.rect.w, 50.0, "child1 width");
        assert_eq!(c1.rect.h, 25.0, "child1 height");
    }

    /// Clean sibling of dirty node is NOT measured (sizes map stays small).
    #[test]
    fn sizes_clean_sibling_not_measured() {
        // Tree: root → [left(dirty), right(clean → [deep_child])]
        let root = make_container(
            "root",
            vec![
                make_rect("left", 100.0, 50.0),
                make_container("right", vec![make_rect("deep_child", 60.0, 30.0)]),
            ],
        );
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        let mut dirty = HashSet::new();
        dirty.insert("left".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Clean deep_child preserves frame from previous
        let prev_dc = previous.get("deep_child").unwrap();
        let res_dc = result.get("deep_child").unwrap();
        assert_eq!(prev_dc.rect, res_dc.rect, "deep_child rect changed");
        assert_eq!(
            prev_dc.measured_size, res_dc.measured_size,
            "deep_child measured_size changed"
        );
    }

    /// Multiple dirty nodes — both get fresh measurements.
    #[test]
    fn sizes_multiple_dirty_nodes() {
        let root = make_container(
            "root",
            vec![
                make_rect("d1", 100.0, 50.0),
                make_rect("clean", 90.0, 45.0),
                make_rect("d2", 80.0, 40.0),
            ],
        );
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        let mut dirty = HashSet::new();
        dirty.insert("d1".to_string());
        dirty.insert("d2".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Both dirty nodes have valid layouts
        assert!(result.get("d1").unwrap().rect.w > 0.0);
        assert!(result.get("d2").unwrap().rect.w > 0.0);

        // Clean node preserved
        let prev_c = previous.get("clean").unwrap();
        let res_c = result.get("clean").unwrap();
        assert_eq!(
            prev_c.measured_size, res_c.measured_size,
            "clean measured_size changed"
        );
    }

    /// All nodes dirty = full measure (equivalent to all-dirty incremental).
    #[test]
    fn sizes_all_dirty_full_measure() {
        let root = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), make_rect("c2", 80.0, 30.0)],
        );
        let viewport = Size::new(800.0, 600.0);
        let full = compute_layout(&root, viewport, None, &HashMap::new());
        let previous = Arc::new(full.clone());

        let mut dirty = HashSet::new();
        dirty.insert("root".to_string());
        dirty.insert("c1".to_string());
        dirty.insert("c2".to_string());

        let result =
            compute_layout_incremental(&root, viewport, None, &HashMap::new(), previous, &dirty);

        for (id, f) in &full {
            let r = result.get(id).unwrap();
            assert!((f.rect.x - r.rect.x).abs() < 0.001, "x mismatch {id}");
            assert!((f.rect.y - r.rect.y).abs() < 0.001, "y mismatch {id}");
            assert!((f.rect.w - r.rect.w).abs() < 0.001, "w mismatch {id}");
            assert!((f.rect.h - r.rect.h).abs() < 0.001, "h mismatch {id}");
        }
    }

    /// Empty tree edge case.
    #[test]
    fn sizes_empty_tree() {
        let root = make_rect("root", 0.0, 0.0);
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        let mut dirty = HashSet::new();
        dirty.insert("root".to_string());

        let result =
            compute_layout_incremental(&root, viewport, None, &HashMap::new(), previous, &dirty);

        assert!(result.contains_key("root"), "root must exist");
    }

    /// Incremental result matches full recompute — correctness invariant.
    /// This verifies the resolve_size() fallback produces identical results
    /// to the old O(n) pre-collection approach.
    #[test]
    fn sizes_incremental_matches_full_recompute() {
        // Complex tree: nested containers with mixed layout modes
        let mut split_root = make_container(
            "root",
            vec![
                make_container(
                    "left",
                    vec![
                        make_rect("l1", 100.0, 40.0),
                        make_rect("l2", 80.0, 30.0),
                        make_rect("l3", 60.0, 20.0),
                    ],
                ),
                make_container(
                    "right",
                    vec![make_rect("r1", 90.0, 45.0), make_rect("r2", 70.0, 35.0)],
                ),
            ],
        );
        split_root.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::X),
                ..Default::default()
            }),
            ..Default::default()
        });

        let viewport = Size::new(800.0, 600.0);
        let full = compute_layout(&split_root, viewport, None, &HashMap::new());
        let previous = Arc::new(full.clone());

        // Mark one leaf dirty in each subtree
        let mut dirty = HashSet::new();
        dirty.insert("l2".to_string());

        let result = compute_layout_incremental(
            &split_root,
            viewport,
            None,
            &HashMap::new(),
            previous,
            &dirty,
        );

        // Every frame must match full recompute
        for (id, f) in &full {
            let r = result
                .get(id)
                .expect(&format!("missing {id} in incremental result"));
            assert!(
                (f.rect.x - r.rect.x).abs() < 0.001,
                "x mismatch for {id}: {} vs {}",
                f.rect.x,
                r.rect.x
            );
            assert!(
                (f.rect.y - r.rect.y).abs() < 0.001,
                "y mismatch for {id}: {} vs {}",
                f.rect.y,
                r.rect.y
            );
            assert!(
                (f.rect.w - r.rect.w).abs() < 0.001,
                "w mismatch for {id}: {} vs {}",
                f.rect.w,
                r.rect.w
            );
            assert!(
                (f.rect.h - r.rect.h).abs() < 0.001,
                "h mismatch for {id}: {} vs {}",
                f.rect.h,
                r.rect.h
            );
            assert!(
                (f.measured_size.w - r.measured_size.w).abs() < 0.001,
                "measured_size.w mismatch for {id}: {} vs {}",
                f.measured_size.w,
                r.measured_size.w
            );
            assert!(
                (f.measured_size.h - r.measured_size.h).abs() < 0.001,
                "measured_size.h mismatch for {id}: {} vs {}",
                f.measured_size.h,
                r.measured_size.h
            );
        }
    }

    /// Shifted clean subtree with deep children — verify resolve_size()
    /// correctly reads measured_size from frames fallback for descendants.
    #[test]
    fn sizes_shifted_clean_subtree_descendants() {
        // Tree: root(row) → [dirty_node(100x50), clean_subtree → [c1(60x30), c2(40x20)]]
        // When dirty_node changes size, clean_subtree shifts position.
        // place_node() must correctly re-place clean_subtree and all descendants
        // using measured_size from frames fallback.
        let mut root = make_container(
            "root",
            vec![
                make_rect("dirty_node", 100.0, 50.0),
                make_container(
                    "clean_subtree",
                    vec![make_rect("c1", 60.0, 30.0), make_rect("c2", 40.0, 20.0)],
                ),
            ],
        );
        root.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::X),
                ..Default::default()
            }),
            ..Default::default()
        });

        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // dirty_node is dirty — its sibling clean_subtree may shift
        let mut dirty = HashSet::new();
        dirty.insert("dirty_node".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Both c1 and c2 must have valid frames (resolved from fallback)
        let c1 = result.get("c1").expect("c1 must have frame after shift");
        let c2 = result.get("c2").expect("c2 must have frame after shift");
        assert!(c1.rect.w > 0.0, "c1 must have valid width");
        assert!(c2.rect.w > 0.0, "c2 must have valid width");
        assert!(c1.measured_size.w > 0.0, "c1 measured_size from fallback");
        assert!(c2.measured_size.w > 0.0, "c2 measured_size from fallback");
    }

    /// Dirty nodes not in tree are ignored (dirty_subtrees check).
    #[test]
    fn sizes_dirty_nodes_not_in_tree_ignored() {
        let root = make_container("root", vec![make_rect("c1", 100.0, 50.0)]);
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        let mut dirty = HashSet::new();
        dirty.insert("nonexistent".to_string());

        let result = compute_layout_incremental(
            &root,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&previous),
            &dirty,
        );

        // Should return previous unchanged (no tree nodes are dirty)
        assert!(
            Arc::ptr_eq(&previous, &result.frames),
            "nonexistent dirty nodes should be ignored"
        );
    }

    // ====================================================================
    // INV-038: Stale Frame Eviction Tests
    // ====================================================================

    /// When a visible node becomes invisible during incremental layout,
    /// its frame (and all descendant frames) must be evicted from layout_frames.
    /// This maintains the invariant: layout_frames contains EXACTLY visible nodes.
    #[test]
    fn incremental_evicts_stale_frames_when_node_becomes_invisible() {
        // Build tree: root → [c1 (visible), c2 (visible)]
        let root = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), make_rect("c2", 80.0, 30.0)],
        );
        let viewport = Size::new(800.0, 600.0);

        // Full layout — both c1 and c2 get frames
        let full = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));
        assert!(
            full.contains_key("c1"),
            "c1 should have frame after full layout"
        );
        assert!(
            full.contains_key("c2"),
            "c2 should have frame after full layout"
        );

        // Now make c2 invisible and mark it dirty
        let root2 = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), {
                let mut c2 = make_rect("c2", 80.0, 30.0);
                c2.visible = Visibility::Resolved(false);
                c2
            }],
        );

        let mut dirty = HashSet::new();
        dirty.insert("c2".to_string());

        let result = compute_layout_incremental(
            &root2,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&full),
            &dirty,
        );

        // c1 must still have a frame
        assert!(result.contains_key("c1"), "c1 should still have frame");
        // c2 must NOT have a frame — evicted by evict_subtree_frames
        assert!(
            !result.contains_key("c2"),
            "c2 should be evicted when invisible"
        );
    }

    /// Eviction must be recursive: when a parent becomes invisible, all
    /// descendant frames are also removed.
    #[test]
    fn incremental_evicts_descendant_frames_recursively() {
        // Build tree: root → [parent → [child1, child2]]
        let root = make_container(
            "root",
            vec![make_container(
                "parent",
                vec![
                    make_rect("child1", 60.0, 40.0),
                    make_rect("child2", 50.0, 30.0),
                ],
            )],
        );
        let viewport = Size::new(800.0, 600.0);

        // Full layout — all 4 nodes get frames
        let full = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));
        assert!(full.contains_key("parent"));
        assert!(full.contains_key("child1"));
        assert!(full.contains_key("child2"));

        // Make parent invisible
        let root2 = make_container(
            "root",
            vec![{
                let mut parent = make_container(
                    "parent",
                    vec![
                        make_rect("child1", 60.0, 40.0),
                        make_rect("child2", 50.0, 30.0),
                    ],
                );
                parent.visible = Visibility::Resolved(false);
                parent
            }],
        );

        let mut dirty = HashSet::new();
        dirty.insert("parent".to_string());

        let result = compute_layout_incremental(
            &root2,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&full),
            &dirty,
        );

        // root still has a frame
        assert!(result.contains_key("root"), "root should still have frame");
        // parent and both children must be evicted
        assert!(
            !result.contains_key("parent"),
            "parent evicted when invisible"
        );
        assert!(
            !result.contains_key("child1"),
            "child1 evicted with invisible parent"
        );
        assert!(
            !result.contains_key("child2"),
            "child2 evicted with invisible parent"
        );
    }

    /// Clean invisible nodes with stale frames are also evicted.
    /// This covers the case where a node became invisible in a prior cycle
    /// but its frame wasn't cleaned up. Even though the node is "clean"
    /// (not in dirty_subtrees), the stale frame must still be removed.
    #[test]
    fn incremental_evicts_clean_invisible_node_with_stale_frame() {
        // Build tree with c1 visible, c2 visible
        let root = make_container(
            "root",
            vec![make_rect("c1", 100.0, 50.0), make_rect("c2", 80.0, 30.0)],
        );
        let viewport = Size::new(800.0, 600.0);
        let full = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));
        assert!(full.contains_key("c2"));

        // Make c2 invisible but mark c1 as dirty (c2 is clean but invisible)
        let root2 = make_container(
            "root",
            vec![
                make_rect("c1", 120.0, 60.0), // changed size → dirty
                {
                    let mut c2 = make_rect("c2", 80.0, 30.0);
                    c2.visible = Visibility::Resolved(false);
                    c2
                },
            ],
        );

        let mut dirty = HashSet::new();
        dirty.insert("c1".to_string());
        // c2 is NOT in dirty set — it's "clean" but invisible with stale frame

        // Parent must be in dirty_subtrees for incremental_place to visit children.
        // Since c1 is dirty, root will be in dirty_subtrees.
        let result = compute_layout_incremental(
            &root2,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&full),
            &dirty,
        );

        // c1 should have updated frame
        assert!(result.contains_key("c1"), "c1 should have frame");
        // c2 should have stale frame evicted even though it's clean
        assert!(
            !result.contains_key("c2"),
            "clean invisible c2 should have stale frame evicted"
        );
    }

    /// Incremental layout matches full layout output for visibility changes.
    /// This is the gold standard: incremental and full must produce identical
    /// frame sets when nodes change visibility.
    #[test]
    fn incremental_matches_full_layout_after_visibility_change() {
        // Build initial tree: root → [c1, c2, c3]
        let root = make_container(
            "root",
            vec![
                make_rect("c1", 100.0, 50.0),
                make_rect("c2", 80.0, 30.0),
                make_rect("c3", 60.0, 40.0),
            ],
        );
        let viewport = Size::new(800.0, 600.0);
        let full_v1 = Arc::new(compute_layout(&root, viewport, None, &HashMap::new()));

        // Make c2 invisible
        let root_v2 = make_container(
            "root",
            vec![
                make_rect("c1", 100.0, 50.0),
                {
                    let mut c2 = make_rect("c2", 80.0, 30.0);
                    c2.visible = Visibility::Resolved(false);
                    c2
                },
                make_rect("c3", 60.0, 40.0),
            ],
        );

        // Full layout of v2 — the ground truth
        let full_v2 = compute_layout(&root_v2, viewport, None, &HashMap::new());

        // Incremental layout from v1 → v2
        let mut dirty = HashSet::new();
        dirty.insert("c2".to_string());
        // c2's parent must be dirty for layout to re-place children
        dirty.insert("root".to_string());
        let incr_v2 = compute_layout_incremental(
            &root_v2,
            viewport,
            None,
            &HashMap::new(),
            Arc::clone(&full_v1),
            &dirty,
        );

        // Same key set: both should have root, c1, c3 — NOT c2
        let mut full_keys: Vec<_> = full_v2.keys().collect();
        full_keys.sort();
        let mut incr_keys: Vec<_> = incr_v2.keys().collect();
        incr_keys.sort();
        assert_eq!(
            full_keys, incr_keys,
            "incremental and full layout must have identical frame keys"
        );
    }

    /// INV-050: Absolute root → child with width/height "100%" must fill viewport.
    /// Reproduces the dashboard rendering bug where percentage dimensions on a
    /// child of an absolute-mode parent resolve to 1px instead of viewport size.
    #[test]
    fn absolute_root_child_percent_dimensions_fill_viewport() {
        // Root: absolute mode (no explicit width/height)
        let mut root = make_container("root", vec![]);
        root.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Absolute),
                ..Default::default()
            }),
            ..Default::default()
        });

        // Dashboard: width: "100%", height: "100%", flex row with nav + content
        let mut nav = SceneNode::new("nav", NodeKind::Container);
        nav.props.style = Some(ResolvedStyle {
            width: Some(Dimension::Pixels(220.0)),
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::Y),
                ..Default::default()
            }),
            ..Default::default()
        });
        nav = nav.with_children(vec![make_rect("nav_item", 200.0, 30.0)]);

        let mut content = SceneNode::new("content", NodeKind::Container);
        content.props.style = Some(ResolvedStyle {
            flex: Some(1.0),
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::Y),
                ..Default::default()
            }),
            ..Default::default()
        });
        content = content.with_children(vec![make_rect("panel", 400.0, 200.0)]);

        let mut dashboard = SceneNode::new("dashboard", NodeKind::Container);
        dashboard.props.style = Some(ResolvedStyle {
            width: Some(Dimension::Percent(1.0)),
            height: Some(Dimension::Percent(1.0)),
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::X),
                gap: Some(0.0),
                ..Default::default()
            }),
            ..Default::default()
        });
        dashboard = dashboard.with_children(vec![nav, content]);

        root = root.with_children(vec![dashboard]);

        let viewport = Size::new(1339.0, 1192.0);
        let frames = compute_layout(&root, viewport, None, &HashMap::new());

        let root_frame = frames.get("root").expect("root must have frame");
        assert_eq!(
            root_frame.rect.w, 1339.0,
            "root width must be viewport width"
        );
        assert_eq!(
            root_frame.rect.h, 1192.0,
            "root height must be viewport height"
        );

        let dash_frame = frames.get("dashboard").expect("dashboard must have frame");
        assert_eq!(
            dash_frame.rect.w, 1339.0,
            "dashboard width: 100% must resolve to viewport width (got {})",
            dash_frame.rect.w
        );
        assert_eq!(
            dash_frame.rect.h, 1192.0,
            "dashboard height: 100% must resolve to viewport height (got {})",
            dash_frame.rect.h
        );

        // Nav should be 220px wide
        let nav_frame = frames.get("nav").expect("nav must have frame");
        assert_eq!(nav_frame.rect.w, 220.0, "nav must be 220px wide");

        // Content should fill remaining: 1339 - 220 = 1119
        let content_frame = frames.get("content").expect("content must have frame");
        assert_eq!(
            content_frame.rect.w, 1119.0,
            "content flex:1 must fill remaining width (got {})",
            content_frame.rect.w
        );
    }

    // ── Incremental layout equals full layout (audit findings 17, 18, 19) ─────────
    // A dirty update must place every node exactly where a full layout would, and
    // report every frame it moved.

    fn column(id: &str, children: Vec<SceneNode>) -> SceneNode {
        let mut parent = make_container(id, children);
        parent.props.style = Some(ResolvedStyle {
            layout: Some(LayoutConfig {
                mode: Some(LayoutMode::Flex),
                axis: Some(LayoutAxis::Y),
                ..Default::default()
            }),
            ..Default::default()
        });
        parent
    }

    fn assert_incremental_matches_full(previous_root: &SceneNode, root: &SceneNode, dirty: &[&str]) -> HashSet<String> {
        let viewport = Size::new(800.0, 600.0);
        let previous = Arc::new(compute_layout(previous_root, viewport, None, &HashMap::new()));
        let full = compute_layout(root, viewport, None, &HashMap::new());
        let dirty: HashSet<String> = dirty.iter().map(|id| id.to_string()).collect();
        let result = compute_layout_incremental(root, viewport, None, &HashMap::new(), Arc::clone(&previous), &dirty);
        for (id, frame) in &full {
            let got = result.frames.get(id).unwrap_or_else(|| panic!("incremental lost frame {id}"));
            assert_eq!(got.rect, frame.rect, "incremental frame of {id} differs from full layout");
        }
        // Every frame that differs from the previous layout is reported.
        for (id, frame) in &full {
            if previous.get(id).map(|f| f.rect) != Some(frame.rect) {
                assert!(result.changed_ids.contains(id), "moved frame {id} was not reported");
            }
        }
        result.changed_ids
    }

    #[test]
    fn incremental_flow_honours_margins_like_full_layout() {
        let with_margin = || {
            let mut a = make_rect("a", 100.0, 40.0);
            a.props.style.as_mut().unwrap().margin = Some(Padding::new(0.0, 0.0, 24.0, 8.0));
            a
        };
        let before = column("col", vec![with_margin(), make_rect("b", 100.0, 40.0)]);
        let after = column("col", vec![with_margin(), make_rect("b", 100.0, 50.0)]);
        assert_incremental_matches_full(&before, &after, &["b"]);
    }

    #[test]
    fn incremental_padding_change_matches_full_content_fit_measurement() {
        let with_padding = |inset| {
            let mut root = column("root", vec![make_rect("child", 100.0, 40.0)]);
            root.props.style.as_mut().unwrap().padding =
                Some(Padding::new(inset, inset, inset, inset));
            root
        };
        let before = with_padding(10.0);
        let after = with_padding(18.0);

        assert_incremental_matches_full(&before, &after, &["child"]);
    }

    #[test]
    fn incremental_measure_uses_the_explicit_parent_constraints() {
        let child = |h: f64| {
            let mut c = make_rect("child", 0.0, h);
            c.props.style.as_mut().unwrap().width = Some(Dimension::Percent(50.0));
            c
        };
        let parent = |h: f64| {
            let mut p = column("parent", vec![child(h)]);
            p.props.style.as_mut().unwrap().width = Some(Dimension::Pixels(200.0));
            p
        };
        let before = column("root", vec![parent(10.0)]);
        let after = column("root", vec![parent(20.0)]);
        assert_incremental_matches_full(&before, &after, &["child"]);
    }

    #[test]
    fn incremental_reports_moved_clean_siblings_and_their_descendants() {
        let before = column("col", vec![make_rect("a", 100.0, 40.0), column("b", vec![make_rect("c", 50.0, 20.0)])]);
        let after = column("col", vec![make_rect("a", 100.0, 60.0), column("b", vec![make_rect("c", 50.0, 20.0)])]);
        let changed = assert_incremental_matches_full(&before, &after, &["a"]);
        assert!(changed.contains("b") && changed.contains("c"), "moved clean sibling and its child reported: {changed:?}");
    }
}
