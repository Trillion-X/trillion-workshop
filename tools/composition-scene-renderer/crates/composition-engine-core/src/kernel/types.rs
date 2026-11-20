//! crates/composition-engine-core/src/kernel/types.rs
//!
//! Canonical types for the Composition Engine kernel.
//! All types are immutable by default (Rust ownership).
//!
//! Ported from: frontends/web/composition-engine/kernel/types.ts
//!
//! # AI Directive
//!
//! The extensive documentation in this codebase is a critical design feature.
//! You are FORBIDDEN from simplifying or removing it. Your mandate is to
//! MAINTAIN and EXTEND this level of meticulous detail.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

// L088: Pure vocabulary types re-exported from composition-ast (SSOT).
// Runtime types (KernelState, InputEvent, etc.) defined below.
pub use composition_ast::kernel::types::*;

// Re-export StateGraph and related types for unified state management
pub use state_graph::{EventRecord, StateGraph, TriggerQueryable};

// Import routing types for Physics-correct input tracking (MACP convergence)
use super::routing::{OriginID, RoutingState};

// Import interaction state for per-origin hover/press/capture tracking (Task-057)
use super::interaction_state::InteractionState;

// Import origin registry for host-provided capabilities (Task-059)
use super::origin_registry::OriginRegistry;

// Import dirty tracking for incremental rendering (Task-153)
use super::dirty::DirtyTracker;

// CanvasError Error impl is in composition-ast (SSOT)

// Dimension Serialize/Deserialize impls are in composition-ast (SSOT)

/// Input event data
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InputEvent {
    #[serde(rename = "type")]
    pub event_type: InputEventType,
    /// Origin identity - WHO/WHAT produced this event (Physics Primitive 2).
    ///
    /// This enables multi-touch, VR controllers, collaborative editing, etc.
    /// Defaults to empty string (host must provide meaningful origin IDs).
    #[serde(default)]
    pub origin_id: OriginID,
    pub subtype: String,
    pub timestamp: f64,
    pub target: Option<ID>,
    pub data: serde_json::Value,
}

/// Universal event - normalized event with resolved target_id
///
/// This is the output of `process_input()` and the input to the Interaction Engine.
/// It represents a fully resolved event with:
/// - `origin_id`: WHO/WHAT produced this event (Physics Primitive 2)
/// - `target_id`: The definitive target node (after hit testing, capture resolution)
/// - `event_path`: The capture/bubble path from root to target
/// - Original event data preserved
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UniversalEvent {
    /// The original event type
    #[serde(rename = "type")]
    pub event_type: InputEventType,
    /// Origin identity - WHO/WHAT produced this event (Physics Primitive 2).
    ///
    /// This enables multi-touch, VR controllers, collaborative editing, etc.
    /// Preserved from the original InputEvent.
    #[serde(default)]
    pub origin_id: OriginID,
    /// Event subtype (e.g., "pointerdown", "keydown")
    pub subtype: String,
    /// Event timestamp
    pub timestamp: f64,
    /// The resolved target node ID (after hit testing / pointer capture)
    pub target_id: Option<ID>,
    /// The event propagation path (root → target for capture, target → root for bubble)
    pub event_path: Vec<ID>,
    /// Original event data
    pub data: serde_json::Value,
    /// Whether this event was consumed during capture/bubble
    pub consumed: bool,
    /// Synthesized events (e.g., click synthesized from pointerdown+pointerup)
    pub synthesized: Option<Vec<UniversalEvent>>,
}

// ============================================================================
// Text Input Configuration (Task 069: Text Kernel State Registry)
// ============================================================================

// ============================================================================
// Kernel State
// ============================================================================

/// Complete kernel state
/// This is the immutable state object passed through tick()
///
/// # StateGraph Integration
/// The `state_graph` field is the **single source of truth** for:
/// - FSM state values (`state_graph.fsm`)
///
/// # Routing (Physics-correct, MACP Task 056)
/// The `routing` field maps each input origin (keyboard, pointer, touch) to its
/// target node, enabling multi-touch, VR controllers, collaborative editing,
/// and accessibility.
///
/// The `fsm_contexts` field stores FSM context data (guards, actions)
/// which is not part of the StateGraph (it only stores state values).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct KernelState {
    /// Scene tree root, Arc-wrapped for O(1) structural sharing (Task 168 P1).
    ///
    /// `render()` uses `Arc::clone()` instead of deep-cloning the entire tree.
    /// Mutations via `scene_diff_apply` use `Arc::make_mut()` for path-copying:
    /// only the spine from root to changed node is cloned, all unchanged subtrees
    /// remain pointer-identical across frames.
    pub scene_tree: Arc<SceneNode>,
    /// Layout frames, Arc-wrapped for O(1) snapshot creation (Task 168 P1).
    ///
    /// `create_snapshot()` uses `Arc::clone()` instead of cloning the entire HashMap.
    /// Layout is recomputed from scratch when `needs_layout()` is true, producing a
    /// new `Arc<HashMap>`. On clean frames, the same Arc is shared.
    pub layout_frames: Arc<HashMap<ID, LayoutFrame>>,
    /// Unified state graph - single source of truth for FSM state
    pub state_graph: StateGraph,
    /// Physics-correct routing state: Map<OriginID, TargetID> (Task 056)
    ///
    /// This replaces the Society-polluted singleton focus model.
    /// Each input origin (keyboard, pointer, touch) has its own independent route.
    #[serde(default)]
    pub routing: RoutingState,
    /// Host-provided origin capability registry (Task 059)
    ///
    /// The host registers each input origin with its capabilities.
    /// The kernel never infers capabilities from origin ID strings.
    /// This is the Physics-correct approach: capabilities are DATA, not DERIVED.
    #[serde(default)]
    pub origin_registry: OriginRegistry,
    /// FSM context data (for guards and actions) - keyed by FSM ID
    /// This is separate from StateGraph because StateGraph only stores state VALUES
    #[serde(default)]
    pub fsm_contexts: HashMap<ID, serde_json::Value>,
    /// Context cache: ContextKey → (NodeID → value)
    #[serde(skip)]
    pub context_cache: HashMap<ContextKey, HashMap<ID, serde_json::Value>>,
    /// Dirty flag tracker for incremental rendering (Task-153).
    ///
    /// Tracks which parts of KernelState changed since the last render() call.
    /// Mutations (set_fsm_state, set_route, set_ambient, update_scene) set flags.
    /// render() reads flags to skip unchanged phases, then calls clear().
    ///
    /// Runtime-only state — not serialized. Starts clean on deserialization
    /// (Default), starts fully dirty on init_kernel_state() (new()).
    #[serde(skip)]
    pub dirty: DirtyTracker,
    /// Last fully evaluated render tree (bindings resolved to concrete values).
    ///
    /// # Purpose
    ///
    /// Cached after each successful compute pass in `render()`. Used by skip paths
    /// (`is_clean()` fast path, `needs_binding_eval()=false` path) to create
    /// snapshots from resolved values instead of the raw `scene_tree` which
    /// contains unevaluated binding AST objects.
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. **None on init** — `init_kernel_state()` sets this to `None` because
    ///    the first render must run full compute to populate it.
    /// 2. **Some after compute** — After any `render()` that runs `compute()`,
    ///    this holds the fully resolved tree. All binding ASTs have been evaluated
    ///    to concrete values (strings, numbers, booleans).
    /// 3. **Reset on `set_scene()`** — When the scene tree is replaced,
    ///    `init_kernel_state()` resets this to `None` so the new tree gets
    ///    a full compute pass.
    /// 4. **Never the canonical tree** — `scene_tree` remains the canonical
    ///    source with unevaluated bindings for re-evaluation. This is a CACHE
    ///    of the last resolved output, not a replacement for `scene_tree`.
    ///
    /// # Skip Path Architecture (Task 162)
    ///
    /// ```text
    /// render() called:
    ///   is_clean() = true → use last_render_tree (or scene_tree if None)
    ///   needs_binding_eval() = false → use last_render_tree (or scene_tree if None)
    ///   needs_binding_eval() = true → run compute() → cache result here
    /// ```
    ///
    /// # Security Considerations
    ///
    /// - Contains the same data as `scene_tree` but with bindings resolved
    /// - No additional security surface — same SceneNode type, same constraints
    /// - Runtime-only state — not serialized, not persisted, not sent to host
    ///
    /// Last fully evaluated render tree, Arc-wrapped for O(1) sharing (Task 168 P1).
    ///
    /// Shared between the producing `render()` call and subsequent skip-path
    /// snapshot creation via `Arc::clone()`. No deep clone on fast/skip paths.
    #[serde(skip)]
    pub last_render_tree: Option<Arc<SceneNode>>,
    /// Cached scene index: node ID → serialized JSON representation.
    ///
    /// Built from `scene_tree` by `build_scene_index()` in `compute.rs`. Rebuilt
    /// when `scene_structure_dirty=true` (tree shape changed). Reused when only
    /// individual nodes are dirty (tree shape unchanged).
    ///
    /// # Why Cache (Task 167 Phase B)
    ///
    /// `build_scene_index()` is O(n) — serializes every node to JSON and inserts
    /// into a HashMap. On a 100-node tree, this takes ~1-2ms. Caching eliminates
    /// this cost on incremental frames where tree structure hasn't changed (most
    /// frames). Combined with `cached_previous_index`, this drops composition
    /// from ~2-5ms to <1ms for incremental updates.
    ///
    /// # Invalidation Rules
    ///
    /// - `set_scene()` → cleared (new tree via `init_kernel_state`)
    /// - `scene_structure_dirty=true` → cleared (rebuild needed, tree shape changed)
    /// - After every compute → updated from `ComputeResult::scene_index`
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. Arc-wrapped for cheap cloning across compute and binding evaluation.
    /// 2. Must be invalidated (set to None) when tree structure changes.
    /// 3. Runtime-only state — not serialized, not persisted.
    ///
    /// # Task 168 P4: Typed Index
    ///
    /// Changed from `HashMap<String, serde_json::Value>` to `TypedSceneIndex`
    /// (flat `TypedNodeEntry` per node). Building the index is now O(n) instead
    /// of O(n^2) — no subtree serialization. Converted to JSON lazily inside
    /// `compute()` when the materialize pipeline needs it.
    #[serde(skip)]
    pub cached_scene_index: Option<Arc<super::typed_index::TypedSceneIndex>>,
    /// Cached previous node index: node ID → flat typed entry from last render.
    ///
    /// Built from `last_render_tree` after each compute pass. Used by incremental
    /// skip paths to overlay resolved binding values onto clean nodes without
    /// re-serializing the previous tree.
    ///
    /// # Why Cache (Task 167 Phase B → Task 168 P4)
    ///
    /// `build_previous_node_index()` walks the previous render tree and builds a
    /// flat index. Caching eliminates this cost when the previous render tree
    /// hasn't changed (reuse across incremental frames). Now takes `&SceneNode`
    /// directly — no `serde_json::to_value()` serialization required.
    ///
    /// # Invalidation Rules
    ///
    /// - `set_scene()` → cleared (new tree via `init_kernel_state`)
    /// - After every compute → rebuilt from the just-computed render tree
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. Arc-wrapped for cheap cloning into materialize() recursive calls.
    /// 2. Updated after every successful compute pass.
    /// 3. Runtime-only state — not serialized, not persisted.
    #[serde(skip)]
    pub cached_previous_index: Option<Arc<super::typed_index::TypedPreviousIndex>>,
    /// Binding dependency index: maps context dependency keys to the set
    /// of node IDs whose bindings reference that key (Task 167 Phase C → Task 178 V4).
    ///
    /// Built from the scene tree's binding ASTs during `compute()`. Arc-wrapped
    /// for O(1) cloning between frames. Only rebuilt when `scene_structure_dirty=true`
    /// (new/removed nodes change which binding ASTs exist). On non-structural frames,
    /// the previous Arc is reused — zero cost.
    ///
    /// When a binding with `from: "fsm"` and `key: "fsm:editor:main"` is found
    /// for node "node-1", the entry `DepKey::Fsm("fsm:editor:main") → {"node-1"}`
    /// is recorded.
    ///
    /// On next frame, if `fsm_dirty_keys` contains "fsm:editor:main",
    /// `resolve_dirty_nodes()` expands the dirty set to include "node-1".
    /// This enables O(affected) binding evaluation instead of O(tree).
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. **Rebuilt when structure changes** — structural patches (InsertNode,
    ///    RemoveSubtree) may add/remove binding ASTs.
    /// 2. **Reused when structure unchanged** — property changes don't alter
    ///    which bindings exist, only their evaluated values.
    /// 3. **None on init** — first render must do full evaluation to build it.
    /// 4. **Runtime-only state** — not serialized, not persisted.
    #[serde(skip)]
    pub binding_dep_index: Option<Arc<super::dirty::BindingDepIndex>>,
    /// Incrementally-maintained derived state container (Task 168 P2).
    ///
    /// Canonical owner of focusable nodes, tabbable nodes, semantics, and
    /// world transforms. Updated once per frame via `update()` in the render
    /// pipeline (after layout, before dirty flag clearing). `create_snapshot()`
    /// reads from this instead of performing O(n) tree walks.
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. Updated AFTER layout completes (needs layout frames for transforms).
    /// 2. Updated BEFORE dirty flags are cleared (needs the delta).
    /// 3. `create_snapshot()` reads only from this — never recomputes.
    /// 4. Runtime-only state — not serialized, not persisted.
    #[serde(skip)]
    pub runtime_graph: super::runtime_graph::RuntimeGraph,
    /// Physics-correct per-origin interaction state (Task-057)
    ///
    /// This is the canonical source for hover, press, and capture state.
    /// Each input origin (finger, mouse, pen) tracks its own state independently.
    /// This enables multi-touch without one finger's release clearing another's press.
    #[serde(default)]
    pub interaction: InteractionState,
    /// Host-injected ambient values for binding evaluation (Task 060 Agent 2)
    ///
    /// # Purpose
    ///
    /// These are GLOBAL runtime values injected by the host, accessible to ALL bindings
    /// via `ambient.{key}`. This enables the 1000x Physics-correct pattern where the
    /// host injects which origin channel matters (e.g., `ambient.session_text_origin`)
    /// and bindings query `routing[ambient.session_text_origin]` dynamically.
    ///
    /// # The 1000x Pattern
    ///
    /// ```text
    /// Host startup:
    ///   kernel.set_ambient("session_text_origin", "seat1:text_edit")
    ///
    /// Binding evaluation:
    ///   { "from": "routing", "key": { "$kind": "binding", "select": { "from": "ambient", "path": "session_text_origin" } } }
    ///   → nested binding resolves to "seat1:text_edit"
    ///   → looks up routing["seat1:text_edit"]
    ///   → returns target node ID (or null if no route)
    /// ```
    ///
    /// # Key Distinction
    ///
    /// - `ambient` (this field): GLOBAL host-injected values (session_text_origin, etc.)
    /// - `context_cache[ContextKey::Ambient]`: PER-NODE ambient values from context providers
    ///
    /// Both are merged into the final `ambient` object in `EvaluationContext`.
    /// Global values take precedence over per-node values for the same key.
    ///
    /// # Invariants
    ///
    /// - Keys are arbitrary strings - kernel treats them as opaque
    /// - Values are JSON values - strings, numbers, objects, arrays, booleans, null
    /// - This field is included in EVERY `EvaluationContext` via `build_canonical_eval_context`
    /// - Empty by default - host must explicitly inject values
    ///
    /// # Platform Agnostic
    ///
    /// The kernel does not interpret ambient values. A desktop host might inject
    /// `session_text_origin: "keyboard:0"` while a Neuralink host might inject
    /// `session_text_origin: "bci:thought_stream"`. The kernel treats both identically.
    ///
    /// # Security Considerations
    ///
    /// - Keys and values are treated as opaque data - no parsing or interpretation
    /// - The "routing" key cannot be overwritten by host (kernel routing takes precedence)
    /// - No code execution - values are pure data, not evaluated as expressions
    /// - Serialization uses serde_json which handles escaping and encoding safely
    #[serde(default)]
    pub ambient: HashMap<String, serde_json::Value>,
    /// Ephemeral kernel state available during binding evaluation.
    ///
    /// This contains runtime state that bindings can query via `SelectSource::State`.
    /// Unlike ambient (which is host-injected), state is kernel-managed.
    ///
    /// # Examples
    ///
    /// - `selected_node`: The currently focused/selected node ID
    /// - `focused_element`: The element with keyboard focus
    ///
    /// # Usage in Bindings
    ///
    /// ```json
    /// { "from": "state", "path": "selected_node" }
    /// ```
    ///
    /// # Management
    ///
    /// The kernel updates state via `set_state(key, value)`.
    /// The host can trigger state changes via actions (e.g., focusNode action).
    #[serde(default)]
    pub state: HashMap<String, serde_json::Value>,
    /// Ephemeral action definitions registered at init (Task 175 Agent 3).
    ///
    /// Key = action_id (e.g., "action:focusNode"). When a trigger match
    /// produces an action_id found here, the kernel executes internally
    /// instead of emitting an Effect to the host.
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. Populated once at init via `register_ephemeral_actions()`.
    /// 2. Read during `execute_ephemeral_action()` in process_input.
    /// 3. Runtime-only — not serialized, not persisted.
    #[serde(skip)]
    pub ephemeral_actions: HashMap<String, EphemeralAction>,
    /// Passive text input capabilities harvested during compute (Task 171).
    ///
    /// Custom nodes with `props.custom.text_input` spec produce entries during
    /// the O(dirty) typed_materialize walk. Stored persistently so clean nodes'
    /// capabilities survive across frames without re-harvesting.
    ///
    /// # Two-tier architecture
    ///
    /// - **Passive (this map):** Display-only capabilities from projection metadata +
    ///   resolved binding values. Cursor is always (0,0). Created/updated by compute.
    /// - **Active (text_buffers + text_configs):** Full editing state with live cursor,
    ///   selection, and text buffer. Created by `activate_text_buffer()`.
    ///
    /// `build_text_input_side_map()` merges both tiers with active-wins precedence.
    ///
    /// # Incremental update
    ///
    /// - `structure_changed = true` → full replace from compute result (node removals)
    /// - `structure_changed = false` → upsert dirty entries into persistent map
    #[serde(skip)]
    pub passive_text_inputs: HashMap<ID, TextInputCapability>,
    /// Text buffer registry - canonical source of truth for text editing.
    ///
    /// If a node_id is in this map, that node needs native text input.
    /// Buffer existence is the signal - no componentType or editMode needed.
    #[serde(default)]
    pub text_buffers: HashMap<ID, TextBufferState>,
    /// Text input configurations paired with buffers.
    /// Used to populate TextInputCapability in snapshot.
    #[serde(default)]
    pub text_configs: HashMap<ID, TextInputConfig>,
    pub metrics: FrameMetrics,
    pub trace: FrameTrace,

    /// Camera for viewport transformation (pan and zoom).
    ///
    /// Used during render() to compute the visible rect and cull off-screen nodes.
    /// Set via `set_camera()`. Changes trigger spatial index queries.
    #[serde(skip)]
    pub camera: Camera,

    /// Spatial index for viewport culling (O(log n + visible) queries).
    ///
    /// Maintains R-tree/spatial index of node bounding boxes in world coordinates.
    /// Updated incrementally as nodes are added/removed/repositioned.
    /// Queried during render() to determine which nodes are visible.
    #[serde(skip)]
    pub spatial_index: super::spatial_index::SpatialIndex,

    /// Active edge connections (source → target with anchor points).
    ///
    /// Set via `set_edges()`, `add_edge()`, `remove_edge()`, `update_edge()`.
    /// Routes are computed by EdgeRouter and included in snapshot.
    #[serde(skip)]
    pub edges: Vec<EdgeConnection>,

    /// Ephemeral host-measured text geometry (node_id → wrapped height and optional natural width, px).
    ///
    /// The engine has no fonts and cannot measure wrapped text. The host (DOM) is the
    /// only thing that knows a text block's real wrapped height, so it measures each
    /// block and feeds the height here as a FIRST-CLASS layout INPUT — consumed by the
    /// measure phase in the SAME layout pass as the viewport width, never a persisted
    /// `style.height` prop. This is NOT authored style and is NOT serialized: it resets
    /// to empty on deserialize, and the host re-measures + re-sends after every reload
    /// or width change. It exists solely so `measure_text_content` can return the real
    /// wrapped height, eliminating the racy `UPDATE_PROPS style.height` bridge that let
    /// a stale viewport reflow discard a height reply and leave blocks overlapping.
    #[serde(skip)]
    pub text_measurements: HashMap<ID, HostTextMeasurement>,
}


/// Ephemeral geometry measured by the host for one rendered text node.
/// Height is the current wrapped height. Natural width is the rendered, unwrapped
/// width and is optional for compatibility with older height-only transactions.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct HostTextMeasurement {
    pub height: f64,
    pub natural_width: Option<f64>,
}

// ============================================================================
// Scene Snapshot
// ============================================================================

/// Immutable snapshot for rendering (output of tick)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneSnapshot {
    /// Render tree root, Arc-wrapped for O(1) snapshot creation (Task 168 P1).
    ///
    /// Shares the same allocation as `KernelState.last_render_tree` via `Arc::clone()`.
    /// No deep clone needed to produce a snapshot — just a ref count bump.
    /// Serde: transparent — serializes identically to a plain `SceneNode`.
    pub tree: Arc<SceneNode>,
    /// Layout frames, Arc-wrapped for O(1) snapshot creation (Task 168 P1).
    ///
    /// Shares the same allocation as `KernelState.layout_frames` via `Arc::clone()`.
    /// Serde: transparent — serializes identically to a plain `HashMap`.
    pub frames: Arc<HashMap<ID, LayoutFrame>>,
    /// Physics-correct routing state: Map<OriginID, TargetID> (Task 056)
    ///
    /// Each input origin has its own independent route to a target node.
    /// Access via: `routing.routes.get(&OriginID::new("my-origin"))` or similar.
    #[serde(default)]
    pub routing: RoutingState,
    pub semantics: HashMap<ID, SemanticProps>,
    /// Flat side-map of text input capabilities (Task 168 P3).
    ///
    /// Built O(k) from kernel's text_buffers/text_configs registries where
    /// k = number of active text inputs (typically <1% of nodes).
    /// Replaces the prior O(n) full-tree enrichment via enrich_tree_with_text_input().
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. Only nodes with active text buffers appear in this map (sparse)
    /// 2. Kernel's text_buffers + text_configs are the canonical source
    /// 3. Host reads `snapshot.text_inputs[node_id]` instead of `node.text_input`
    #[serde(default)]
    pub text_inputs: HashMap<ID, TextInputCapability>,

    /// Current camera state (pan and zoom).
    ///
    /// Published to host for viewport transformation on the client side.
    pub camera: Camera,

    /// Computed edge routes (edges with rendered paths).
    ///
    /// Pre-computed by engine from node positions and anchor points.
    /// Culled to only edges where at least one endpoint is visible.
    #[serde(default)]
    pub visible_edge_routes: Vec<EdgeRoute>,
}

// ============================================================================
// Host Trait
// ============================================================================

/// Host interface - platform adapters implement this
pub trait Host {
    /// Get current timestamp (milliseconds)
    fn now(&self) -> f64;

    /// Request animation frame
    fn raf(&self, callback: Box<dyn FnOnce(f64)>) -> Unsub;

    /// Measure text dimensions
    fn measure_text(
        &self,
        text: &str,
        font_family: Option<&str>,
        font_size: Option<f64>,
        font_weight: Option<&FontWeight>,
    ) -> Size;

    /// Execute a side effect (action dispatch)
    fn dispatch_action(&self, effect: &Effect);
}

// ============================================================================
// Result Types
// ============================================================================

/// Describes a new scene node to be inserted as a sibling after an existing node.
///
/// Used by the Enter handler (J-00c) to request tree mutations from the pure
/// process_input() function. Kept in types.rs (not scene_diff_types.rs) to avoid
/// circular imports: scene_diff_types.rs already imports from types.rs.
///
/// The Kernel::process_input() method translates each NodeInsertion into a
/// ScenePatch::InsertNode and applies it via apply_patches().
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInsertion {
    /// The new SceneNode to insert into the tree.
    pub node: SceneNode,
    /// Insert the new node immediately after this sibling in the parent's children.
    pub after_sibling_id: ID,
    /// If Some, route this origin to the newly inserted node after insertion.
    pub route_origin: Option<OriginID>,
}

/// Result of the process_input() function (Phase 1 only)
///
/// Contains the normalized universal event with resolved target,
/// updated input state, and any effects generated during input processing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputResult {
    /// The normalized universal event with resolved target_id
    pub universal_event: UniversalEvent,
    /// Physics-correct per-origin interaction state (Task-057)
    ///
    /// This is the canonical source for hover, press, and capture state.
    /// Each input origin (finger, mouse, pen) tracks its own state independently.
    #[serde(default)]
    pub next_interaction: InteractionState,
    /// Updated focus state (if focus changed during input)
    pub next_focus_state: FocusState,
    /// Text buffer updates from text input handling (Task 0556: J-00a)
    ///
    /// Maps node_id → updated TextBufferState for any nodes that received text input.
    /// The caller (host/render) applies these updates to KernelState.text_buffers.
    #[serde(default)]
    pub text_buffer_updates: HashMap<ID, TextBufferState>,
    /// Scene node insertions requested by Enter handler (Task 0558: J-00c)
    ///
    /// Each entry describes a new node to insert after a sibling. Applied by
    /// Kernel::process_input() after the pure function returns, via apply_patches().
    #[serde(default)]
    pub node_insertions: Vec<NodeInsertion>,
    /// Effects generated during input processing (click handlers, etc.)
    pub effects: Vec<Effect>,
}

/// Result of the render() function (Phases 2-7)
///
/// Contains the rendered snapshot and any effects generated during rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderResult {
    /// The rendered scene snapshot
    pub snapshot: SceneSnapshot,
    /// Updated kernel state after rendering
    #[serde(skip)]
    pub next_state: KernelState,
    /// Effects generated during rendering (FSM effects, etc.)
    pub effects: Vec<Effect>,
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_point_creation() {
        let p = Point::new(10.0, 20.0);
        assert_eq!(p.x, 10.0);
        assert_eq!(p.y, 20.0);
    }

    #[test]
    fn test_rect_contains() {
        let r = Rect::new(0.0, 0.0, 100.0, 100.0);
        assert!(r.contains(Point::new(50.0, 50.0)));
        assert!(r.contains(Point::new(0.0, 0.0)));
        assert!(r.contains(Point::new(100.0, 100.0)));
        assert!(!r.contains(Point::new(101.0, 50.0)));
        assert!(!r.contains(Point::new(-1.0, 50.0)));
    }

    #[test]
    fn test_matrix_identity() {
        let m = Matrix::IDENTITY;
        let p = Point::new(5.0, 10.0);
        let transformed = m.transform_point(p);
        assert_eq!(transformed.x, 5.0);
        assert_eq!(transformed.y, 10.0);
    }

    #[test]
    fn test_matrix_translate() {
        let m = Matrix::translate(10.0, 20.0);
        let p = Point::new(5.0, 5.0);
        let transformed = m.transform_point(p);
        assert_eq!(transformed.x, 15.0);
        assert_eq!(transformed.y, 25.0);
    }

    #[test]
    fn test_scene_node_builder() {
        let node = SceneNode::new("root", NodeKind::Container)
            .with_children(vec![SceneNode::new("child", NodeKind::Text)]);

        assert_eq!(node.id, "root");
        assert_eq!(node.kind, NodeKind::Container);
        assert_eq!(node.children.len(), 1);
        assert_eq!(node.children[0].id, "child");
    }

    #[test]
    fn test_fsm_event_builder() {
        let event = FSMEvent::new("CLICK")
            .with_payload("x", serde_json::json!(100))
            .with_payload("y", serde_json::json!(200));

        assert_eq!(event.event_type, "CLICK");
        assert_eq!(event.payload.get("x"), Some(&serde_json::json!(100)));
        assert_eq!(event.payload.get("y"), Some(&serde_json::json!(200)));
    }

    #[test]
    fn test_text_range() {
        let range = TextRange::new(5, 10);
        assert_eq!(range.length(), 5);
        assert!(!range.is_collapsed());

        let collapsed = TextRange::new(5, 5);
        assert!(collapsed.is_collapsed());
        assert_eq!(collapsed.length(), 0);
    }

    // ========================================================================
    // LayoutConfig::from_style_layout Tests (Task 064)
    // ========================================================================

    #[test]
    fn test_from_style_layout_flex_mode() {
        let layout = serde_json::json!({ "mode": "flex" });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.mode, Some(LayoutMode::Flex));
    }

    #[test]
    fn test_from_style_layout_split_mode() {
        let layout = serde_json::json!({ "mode": "split" });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.mode, Some(LayoutMode::Split));
    }

    #[test]
    fn test_from_style_layout_absolute_mode() {
        let layout = serde_json::json!({ "mode": "absolute" });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.mode, Some(LayoutMode::Absolute));
    }

    #[test]
    fn test_from_style_layout_axis_row_maps_to_x() {
        let layout = serde_json::json!({ "axis": "row" });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.axis, Some(LayoutAxis::X));
    }

    #[test]
    fn test_from_style_layout_axis_column_maps_to_y() {
        let layout = serde_json::json!({ "axis": "column" });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.axis, Some(LayoutAxis::Y));
    }

    #[test]
    fn test_from_style_layout_axis_x_direct() {
        let layout = serde_json::json!({ "axis": "x" });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.axis, Some(LayoutAxis::X));
    }

    #[test]
    fn test_from_style_layout_axis_y_direct() {
        let layout = serde_json::json!({ "axis": "y" });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.axis, Some(LayoutAxis::Y));
    }

    #[test]
    fn test_from_style_layout_gap_extraction() {
        let layout = serde_json::json!({ "gap": 12 });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.gap, Some(12.0));
    }

    #[test]
    fn test_from_style_layout_parts_extraction() {
        let layout = serde_json::json!({ "parts": [0.3, 0.7] });
        let config = LayoutConfig::from_style_layout(&layout);
        let parts = config.parts.unwrap();
        assert_eq!(parts.len(), 2);
        assert!((parts[0].fraction - 0.3).abs() < 0.001);
        assert!((parts[1].fraction - 0.7).abs() < 0.001);
    }

    #[test]
    fn test_from_style_layout_xy_extraction() {
        let layout = serde_json::json!({ "x": 100, "y": 200 });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.x, Some(serde_json::json!(100)));
        assert_eq!(config.y, Some(serde_json::json!(200)));
    }

    #[test]
    fn test_from_style_layout_missing_fields_defaults() {
        let layout = serde_json::json!({});
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.mode, Some(LayoutMode::Flex)); // Default
        assert_eq!(config.axis, Some(LayoutAxis::Y)); // Default
        assert_eq!(config.gap, None);
        assert_eq!(config.parts, None);
        assert_eq!(config.x, None);
        assert_eq!(config.y, None);
    }

    #[test]
    fn test_from_style_layout_full_config() {
        let layout = serde_json::json!({
            "mode": "split",
            "axis": "row",
            "gap": 8,
            "parts": [0.2, 0.8]
        });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.mode, Some(LayoutMode::Split));
        assert_eq!(config.axis, Some(LayoutAxis::X));
        assert_eq!(config.gap, Some(8.0));
        let parts = config.parts.unwrap();
        assert_eq!(parts.len(), 2);
    }

    #[test]
    fn test_from_style_layout_xy_with_binding() {
        // Test that binding objects are passed through unchanged
        let binding = serde_json::json!({
            "$kind": "binding",
            "select": { "from": "ambient", "path": "popover_x" }
        });
        let layout = serde_json::json!({ "x": binding.clone() });
        let config = LayoutConfig::from_style_layout(&layout);
        assert_eq!(config.x, Some(binding));
    }

    // ========================================================================
    // TextInputConfig Tests (Task 069)
    // ========================================================================

    #[test]
    fn test_text_input_config_deserialize_minimal() {
        let json = r#"{"editable": true}"#;
        let config: TextInputConfig = serde_json::from_str(json).unwrap();
        assert!(config.editable);
        assert!(!config.multiline);
        assert!(!config.secure);
        assert_eq!(config.keyboard_type, "text");
        assert!(config.placeholder.is_none());
    }

    #[test]
    fn test_text_input_config_deserialize_full() {
        let json = r#"{
            "editable": true,
            "multiline": true,
            "secure": false,
            "keyboard_type": "email",
            "placeholder": "Enter email"
        }"#;
        let config: TextInputConfig = serde_json::from_str(json).unwrap();
        assert!(config.editable);
        assert!(config.multiline);
        assert!(!config.secure);
        assert_eq!(config.keyboard_type, "email");
        assert_eq!(config.placeholder, Some("Enter email".to_string()));
    }

    #[test]
    fn test_text_input_config_secure_mode() {
        let json = r#"{"editable": true, "secure": true}"#;
        let config: TextInputConfig = serde_json::from_str(json).unwrap();
        assert!(config.secure);
    }

    #[test]
    fn test_text_input_config_multiline() {
        let json = r#"{"editable": true, "multiline": true}"#;
        let config: TextInputConfig = serde_json::from_str(json).unwrap();
        assert!(config.multiline);
    }

    #[test]
    fn test_text_input_config_keyboard_types() {
        for kb_type in ["text", "email", "number", "tel", "url", "search"] {
            let json = format!(r#"{{"editable": true, "keyboard_type": "{}"}}"#, kb_type);
            let config: TextInputConfig = serde_json::from_str(&json).unwrap();
            assert_eq!(config.keyboard_type, kb_type);
        }
    }

    #[test]
    fn test_text_input_config_default() {
        let config = TextInputConfig::default();
        assert!(!config.editable);
        assert!(!config.multiline);
        assert!(!config.secure);
        assert_eq!(config.keyboard_type, "text");
        assert!(config.placeholder.is_none());
    }

    #[test]
    fn test_text_input_capability_serialization() {
        let cap = TextInputCapability {
            value: "hello".to_string(),
            selection: TextRange::new(5, 5),
            secure: false,
            multiline: false,
            keyboard_type: "text".to_string(),
            placeholder: Some("Type here".to_string()),
            input_type: Some("text".to_string()),
        };
        let json = serde_json::to_string(&cap).unwrap();
        assert!(json.contains("\"value\":\"hello\""));
        assert!(json.contains("\"selection\""));
        assert!(json.contains("\"placeholder\":\"Type here\""));
    }

    #[test]
    fn test_text_input_capability_no_placeholder() {
        let cap = TextInputCapability {
            value: "".to_string(),
            selection: TextRange::new(0, 0),
            secure: true,
            multiline: false,
            keyboard_type: "text".to_string(),
            placeholder: None,
            input_type: None,
        };
        let json = serde_json::to_string(&cap).unwrap();
        // placeholder and input_type should be omitted when None
        assert!(!json.contains("placeholder"));
        assert!(!json.contains("input_type"));
    }

    #[test]
    fn test_kernel_state_has_text_fields() {
        let state = KernelState::default();
        assert!(state.text_buffers.is_empty());
        assert!(state.text_configs.is_empty());
    }

    #[test]
    fn test_text_buffer_state_default() {
        let buffer = TextBufferState::default();
        assert!(buffer.text.is_empty());
        assert_eq!(buffer.selection, TextRange::new(0, 0));
        assert!(buffer.composing.is_none());
    }

    // ====================================================================
    // Resilient f64 Deserialization Tests (Task 146 — Agent 1)
    // ====================================================================
    //
    // These tests verify that ResolvedStyle's Option<f64> fields accept
    // both numeric values and string-encoded numbers, preventing entire-
    // style deserialization failure from a single corrupted field.

    // ── Test: border_radius deserializes from number correctly ──────────

    #[test]
    fn test_resolved_style_border_radius_number() {
        let json = r#"{"border_radius": 20.0}"#;
        let style: ResolvedStyle =
            serde_json::from_str(json).expect("number 20.0 must deserialize");
        assert_eq!(
            style.border_radius,
            Some(20.0),
            "border_radius: 20.0 (number) must deserialize to Some(20.0)"
        );
    }

    // ── Test: border_radius deserializes from string "20.0" ────────────

    #[test]
    fn test_resolved_style_border_radius_string() {
        let json = r#"{"border_radius": "20.0"}"#;
        let style: ResolvedStyle =
            serde_json::from_str(json).expect("string '20.0' must deserialize");
        assert_eq!(
            style.border_radius,
            Some(20.0),
            "border_radius: '20.0' (string) must parse to Some(20.0)"
        );
    }

    // ── Test: border_radius deserializes null as None ───────────────────

    #[test]
    fn test_resolved_style_border_radius_null() {
        let json = r#"{"border_radius": null}"#;
        let style: ResolvedStyle = serde_json::from_str(json).expect("null must deserialize");
        assert_eq!(
            style.border_radius, None,
            "border_radius: null must deserialize to None"
        );
    }

    // ── Test: font_size deserializes from string "14" ──────────────────

    #[test]
    fn test_resolved_style_font_size_string_integer() {
        let json = r#"{"font_size": "14"}"#;
        let style: ResolvedStyle =
            serde_json::from_str(json).expect("string '14' must deserialize");
        assert_eq!(
            style.font_size,
            Some(14.0),
            "font_size: '14' (string integer) must parse to Some(14.0)"
        );
    }

    // ── Test: width deserializes from string "100.5" ───────────────────

    #[test]
    fn test_resolved_style_width_string_decimal() {
        let json = r#"{"width": "100.5"}"#;
        let style: ResolvedStyle =
            serde_json::from_str(json).expect("string '100.5' must deserialize");
        assert_eq!(
            style.width,
            Some(Dimension::Pixels(100.5)),
            "width: '100.5' (string) must parse to Dimension::Pixels(100.5)"
        );
    }

    // ── Test: all f64 fields as strings deserialize fully ──────────────

    #[test]
    fn test_resolved_style_all_f64_fields_as_strings() {
        let json = r#"{
            "border_radius": "4",
            "border_width": "2",
            "font_size": "16",
            "width": "200",
            "height": "100",
            "flex": "1",
            "flex_shrink": "0"
        }"#;
        let style: ResolvedStyle = serde_json::from_str(json)
            .expect("all f64 fields as strings must deserialize — no partial failure");
        assert_eq!(style.border_radius, Some(4.0));
        assert_eq!(style.border_width, Some(2.0));
        assert_eq!(style.font_size, Some(16.0));
        assert_eq!(style.width, Some(Dimension::Pixels(200.0)));
        assert_eq!(style.height, Some(Dimension::Pixels(100.0)));
        assert_eq!(style.flex, Some(1.0));
        assert_eq!(style.flex_shrink, Some(0.0));
    }

    // ── Test: invalid string falls back to None ────────────────────────

    #[test]
    fn test_resolved_style_invalid_string_falls_back_to_none() {
        let json = r#"{"border_radius": "abc", "font_size": "not-a-number"}"#;
        let style: ResolvedStyle =
            serde_json::from_str(json).expect("invalid strings must not crash deserialization");
        assert_eq!(
            style.border_radius, None,
            "'abc' is not a number — must fall back to None per L017"
        );
        assert_eq!(
            style.font_size, None,
            "'not-a-number' must fall back to None per L017"
        );
    }

    // ── Test: missing f64 field defaults to None ───────────────────────

    #[test]
    fn test_resolved_style_missing_f64_defaults_to_none() {
        let json = r#"{}"#;
        let style: ResolvedStyle =
            serde_json::from_str(json).expect("empty object must deserialize with all defaults");
        assert_eq!(style.border_radius, None);
        assert_eq!(style.border_width, None);
        assert_eq!(style.font_size, None);
        assert_eq!(style.width, None);
        assert_eq!(style.height, None);
        assert_eq!(style.flex, None);
        assert_eq!(style.flex_shrink, None);
    }

    // ── Test: mixed number and string f64 fields coexist ───────────────

    #[test]
    fn test_resolved_style_mixed_number_and_string_fields() {
        let json = r#"{
            "border_radius": 8,
            "font_size": "16.5",
            "width": 300,
            "height": "auto_is_invalid_falls_to_none",
            "flex": "1"
        }"#;
        let style: ResolvedStyle =
            serde_json::from_str(json).expect("mixed numbers and strings must deserialize");
        assert_eq!(style.border_radius, Some(8.0), "integer number → f64");
        assert_eq!(style.font_size, Some(16.5), "string decimal → f64");
        assert_eq!(
            style.width,
            Some(Dimension::Pixels(300.0)),
            "integer number → Dimension::Pixels"
        );
        assert_eq!(style.height, None, "non-numeric string → None");
        assert_eq!(style.flex, Some(1.0), "string integer → f64");
    }

    // ── Test: string fields remain unaffected by f64 deserializer ──────

    #[test]
    fn test_resolved_style_string_fields_unaffected() {
        let json = r##"{
            "background": "#ff0000",
            "color": "rgba(0,0,0,0.5)",
            "border_color": "#333",
            "font_family": "Inter"
        }"##;
        let style: ResolvedStyle =
            serde_json::from_str(json).expect("string fields must deserialize normally");
        assert_eq!(style.background, Some("#ff0000".to_string()));
        assert_eq!(style.color, Some("rgba(0,0,0,0.5)".to_string()));
        assert_eq!(style.border_color, Some("#333".to_string()));
        assert_eq!(style.font_family, Some("Inter".to_string()));
    }

    // ========================================================================
    // Field Name Alignment Tests (Task 146 — Agent 2)
    // ========================================================================
    //
    // Purpose:
    //   Verify that ResolvedStyle field names EXACTLY match the canonical DB
    //   key names. Any mismatch causes values to silently fall into the
    //   `extra: HashMap<String, Value>` catch-all instead of typed fields,
    //   making them invisible to typed accessors (e.g., `style.background`).
    //
    // Non-Negotiable Invariants:
    //   1. ONE canonical name per style property — zero aliases, zero
    //      backwards-compat hacks (per Canonical Single Source of Truth)
    //   2. DB key MUST exactly match Rust struct field name (serde
    //      deserializes by key name match)
    //   3. No `#[serde(alias)]` annotations — duplicates die
    //   4. Misnamed keys ALWAYS fall to `extra` — never silently mapped
    //   5. Migration 042 renames all `background_color` → `background`
    //      in DB seed data to match the Rust field
    //
    // Key Concepts:
    //   - `#[serde(flatten)] pub extra: HashMap<String, Value>` catches
    //     any JSON key that doesn't match a typed field
    //   - If a key like `background_color` has no matching struct field,
    //     serde puts it in `extra` — the value is lost to typed access
    //   - `background` is the canonical name (not `background_color`)
    //     because it's more generic (covers color, gradient, image),
    //     already used in 11 migration files, and matches CSS semantics
    //
    // Security Considerations:
    //   - Pure deserialization tests — no I/O, no DB access, no side effects
    //   - All test JSON is hardcoded — no external input parsing
    //
    // AI Directive:
    //   The extensive documentation in this test suite is a critical design
    //   feature. You are FORBIDDEN from simplifying or removing it. Your
    //   mandate is to MAINTAIN and EXTEND this level of meticulous detail.
    //
    // Canonical Field Name Table:
    // | Rust Field    | DB Key (canonical) | Type          |
    // |---------------|--------------------| --------------|
    // | background    | background         | Option<String>|
    // | color         | color              | Option<String>|
    // | border_radius | border_radius      | Option<f64>   |
    // | border_width  | border_width       | Option<f64>   |
    // | border_color  | border_color       | Option<String>|
    // | font_family   | font_family        | Option<String>|
    // | font_size     | font_size          | Option<f64>   |
    // | font_weight   | font_weight        | Option<FW>    |
    // | text_align    | text_align         | Option<TA>    |
    // | width         | width              | Option<f64>   |
    // | height        | height             | Option<f64>   |
    // | flex          | flex               | Option<f64>   |
    // | flex_shrink   | flex_shrink        | Option<f64>   |
    // | padding       | padding            | Option<Pad>   |
    // | layout        | layout             | Option<LC>    |

    // ── Test: "background" key maps to typed field, not extra ───────────
    // Verifies the fundamental serde contract: when JSON key exactly matches
    // the Rust field name, the value populates the typed field. If this fails,
    // the background value would be invisible to `style.background` access.

    #[test]
    fn test_background_field_exact_name_match() {
        // Canonical key "background" → typed field ResolvedStyle.background
        let json = r##"{"background": "#3b82f6"}"##;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert_eq!(style.background, Some("#3b82f6".to_string()));
        assert!(
            style.extra.is_empty(),
            "background must map to typed field, not extra"
        );
    }

    // ── Test: "background_color" has NO alias — goes to extra ──────────
    // This is the CRITICAL test for the Canonical Single Source of Truth
    // principle. After migration 042, DB no longer uses "background_color".
    // If any legacy data still has that key, it MUST fall to the `extra`
    // HashMap — NOT silently map to `background` via a serde alias.
    // This proves: zero `#[serde(alias)]` annotations exist on background.

    #[test]
    fn test_background_color_key_falls_to_extra() {
        // Non-canonical key "background_color" → extra HashMap (no alias)
        let json = r##"{"background_color": "#3b82f6"}"##;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert_eq!(
            style.background, None,
            "background_color must NOT map to background field (no alias)"
        );
        assert!(
            style.extra.contains_key("background_color"),
            "background_color must fall through to extra HashMap"
        );
    }

    // ── Test: border_color maps to typed field by exact name ────────────
    // Ensures another Option<String> field with an underscore name (which
    // could be confused with `background_color`) correctly maps by exact
    // name match. `border_color` IS a canonical field name.

    #[test]
    fn test_border_color_field_exact_name_match() {
        // Canonical key "border_color" → typed field ResolvedStyle.border_color
        let json = r##"{"border_color": "#000000"}"##;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert_eq!(style.border_color, Some("#000000".to_string()));
        assert!(style.extra.is_empty());
    }

    // ── Test: all Option<String> fields map by exact name ──────────────
    // Bulk verification that ALL four string-typed style fields deserialize
    // from their canonical DB key names. None should leak to extra.

    #[test]
    fn test_all_string_fields_exact_name_match() {
        // All 4 Option<String> fields: background, color, border_color, font_family
        let json = r##"{
            "background": "#ff0000",
            "color": "#1a1a1a",
            "border_color": "#e5e7eb",
            "font_family": "Inter"
        }"##;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert_eq!(style.background, Some("#ff0000".to_string()));
        assert_eq!(style.color, Some("#1a1a1a".to_string()));
        assert_eq!(style.border_color, Some("#e5e7eb".to_string()));
        assert_eq!(style.font_family, Some("Inter".to_string()));
        assert!(
            style.extra.is_empty(),
            "All string fields must map to typed fields, not extra"
        );
    }

    // ── Test: all Option<f64> fields map by exact name ─────────────────
    // Bulk verification that ALL seven f64-typed style fields deserialize
    // from their canonical DB key names. Integer JSON values coerce to f64
    // (serde's standard number→f64 path). None should leak to extra.

    #[test]
    fn test_all_f64_fields_exact_name_match_agent2() {
        // All 7 Option<f64> fields: border_radius, border_width, font_size,
        // width, height, flex, flex_shrink
        let json = r#"{
            "border_radius": 8,
            "border_width": 1,
            "font_size": 16,
            "width": 320,
            "height": 400,
            "flex": 1,
            "flex_shrink": 0
        }"#;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert_eq!(style.border_radius, Some(8.0));
        assert_eq!(style.border_width, Some(1.0));
        assert_eq!(style.font_size, Some(16.0));
        assert_eq!(style.width, Some(Dimension::Pixels(320.0)));
        assert_eq!(style.height, Some(Dimension::Pixels(400.0)));
        assert_eq!(style.flex, Some(1.0));
        assert_eq!(style.flex_shrink, Some(0.0));
        assert!(
            style.extra.is_empty(),
            "All f64 fields must map to typed fields, not extra"
        );
    }

    // ── Test: button blueprint style (post-042 canonical names) ────────
    // End-to-end test: deserializes the button blueprint style JSON as it
    // would appear in the DB AFTER migration 042. Verifies that background
    // (renamed from background_color) and padding both reach typed fields.
    // This is the integration proof that migration 042 + ResolvedStyle
    // work together correctly for the button block.

    #[test]
    fn test_migration_seed_button_style_canonical() {
        // Simulates the button blueprint style from migration 019
        // AFTER migration 042 renames background_color → background.
        // Migration 019 stores padding as a bare integer (12), but ResolvedStyle
        // expects Padding struct — we use the struct form here to test the full
        // typed deserialization path. The bare-integer padding issue is a separate
        // concern (Padding type coercion, not field name alignment).
        let json = r##"{
            "padding": {"top": 12, "right": 12, "bottom": 12, "left": 12},
            "background": "#3b82f6",
            "border_radius": 8
        }"##;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert_eq!(style.background, Some("#3b82f6".to_string()));
        assert_eq!(style.border_radius, Some(8.0));
        assert_eq!(style.padding, Some(Padding::new(12.0, 12.0, 12.0, 12.0)));
        assert!(
            !style.extra.contains_key("background"),
            "background must be in typed field, not extra"
        );
        assert!(
            !style.extra.contains_key("padding"),
            "padding must be in typed field, not extra"
        );
    }

    // ── Test: HUD style (post-042 canonical names) ─────────────────────
    // End-to-end test: deserializes the HUD style JSON from migration 019
    // AFTER migration 042 renames background_color → background. The HUD
    // uses a mix of string and numeric fields — verifies all reach typed
    // fields, including font_weight as a string "600" (FontWeight enum).

    #[test]
    fn test_hud_style_uses_canonical_background() {
        // Simulates layout:editor:hud / prop:layout:style (post-042 fix)
        let json = r##"{
            "background": "#3b82f6",
            "color": "#ffffff",
            "font_size": 12,
            "font_weight": "600",
            "border_radius": 4
        }"##;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert_eq!(style.background, Some("#3b82f6".to_string()));
        assert_eq!(style.color, Some("#ffffff".to_string()));
        assert_eq!(style.font_size, Some(12.0));
        assert_eq!(style.border_radius, Some(4.0));
        assert!(style.font_weight.is_some());
    }

    // ── Test: extension properties go to extra, canonical do not ────────
    // Comprehensive test with ALL 13 canonical fields populated plus 2
    // extension properties (cursor, z_index). Verifies the complete
    // separation: typed fields capture canonical names, extra captures
    // everything else. Iterates extra.keys() to prove no canonical field
    // name leaked into the catch-all HashMap.

    #[test]
    fn test_no_canonical_fields_leak_to_extra() {
        // All 13 scalar canonical fields + 2 extension properties
        let json = r##"{
            "background": "#ff0000",
            "color": "#000",
            "border_radius": 4,
            "border_width": 1,
            "border_color": "#ccc",
            "font_family": "monospace",
            "font_size": 14,
            "font_weight": 400,
            "text_align": "center",
            "width": 200,
            "height": 100,
            "flex": 1,
            "flex_shrink": 0,
            "cursor": "pointer",
            "z_index": 10
        }"##;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();

        // Typed fields must be populated — each canonical key reached its field
        assert!(style.background.is_some());
        assert!(style.color.is_some());
        assert!(style.border_radius.is_some());
        assert!(style.border_width.is_some());
        assert!(style.border_color.is_some());
        assert!(style.font_family.is_some());
        assert!(style.font_size.is_some());
        assert!(style.font_weight.is_some());
        assert!(style.text_align.is_some());
        assert!(style.width.is_some());
        assert!(style.height.is_some());
        assert!(style.flex.is_some());
        assert!(style.flex_shrink.is_some());

        // Extension properties (no typed field) SHOULD be in extra
        assert!(style.extra.contains_key("cursor"));
        assert!(style.extra.contains_key("z_index"));

        // Exhaustive check: no canonical field name appears in extra
        for key in style.extra.keys() {
            assert!(
                !matches!(
                    key.as_str(),
                    "background"
                        | "color"
                        | "border_radius"
                        | "border_width"
                        | "border_color"
                        | "font_family"
                        | "font_size"
                        | "font_weight"
                        | "text_align"
                        | "width"
                        | "height"
                        | "flex"
                        | "flex_shrink"
                        | "padding"
                        | "layout"
                ),
                "Canonical field '{}' must NOT appear in extra",
                key
            );
        }
    }

    // ── Test: SceneNode.style.background accessible after deser ─────────
    // Verifies the full pipeline: JSON SceneNode → deserialization →
    // node.style.background accessible as Option<String>. This mirrors
    // the actual data flow: Projector produces SceneNode JSON, kernel
    // deserializes it, and code accesses style.background on the result.

    #[test]
    fn test_scene_node_style_contains_background() {
        // SceneNode with nested ResolvedStyle containing canonical "background"
        let node_json = r##"{
            "id": "layout:editor:hud",
            "kind": "Container",
            "style": {
                "background": "#3b82f6",
                "border_radius": 4
            }
        }"##;
        let node: SceneNode = serde_json::from_str(node_json).unwrap();
        let style = node.style.expect("style must be present");
        assert_eq!(
            style.background,
            Some("#3b82f6".to_string()),
            "background must be accessible on SceneNode.style"
        );
        assert_eq!(style.border_radius, Some(4.0));
    }

    // ── Test: background survives serialize → deserialize round-trip ────
    // Round-trip proof: construct a ResolvedStyle in Rust → serialize to
    // JSON → deserialize back → values match. This matters because
    // update_scene() serializes/deserializes styles for diffing. If the
    // round-trip changes field values, patches would be incorrect.

    #[test]
    fn test_background_round_trip_serialization() {
        // Construct → serialize → deserialize → compare
        let original = ResolvedStyle {
            background: Some("#ff0000".to_string()),
            color: Some("#000".to_string()),
            border_radius: Some(8.0),
            ..Default::default()
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: ResolvedStyle = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.background, original.background);
        assert_eq!(deserialized.color, original.color);
        assert_eq!(deserialized.border_radius, original.border_radius);
    }

    // ── Test: background change detectable via PartialEq ────────────────
    // update_scene() compares old vs new SceneNode trees to produce
    // ScenePatch diffs. It relies on PartialEq to detect changes.
    // If background changes are invisible to PartialEq (e.g., both
    // values land in `extra` with different serialization), patches
    // would be missed and visual updates would not reach the host.

    #[test]
    fn test_background_change_detected_in_style_diff() {
        // Two styles differing only in background value
        let before = ResolvedStyle {
            background: Some("#ff0000".to_string()),
            ..Default::default()
        };
        let after = ResolvedStyle {
            background: Some("#00ff00".to_string()),
            ..Default::default()
        };
        assert_ne!(before, after, "Background change must be detectable");
    }

    // ── Test: empty JSON → default ResolvedStyle, empty extra ───────────
    // Baseline test: an empty JSON object `{}` produces a fully-default
    // ResolvedStyle with all fields None and extra empty. This proves
    // serde's `#[serde(default)]` annotations work correctly and no
    // phantom values appear from the deserialization machinery.

    #[test]
    fn test_empty_style_deserializes_with_no_extra() {
        // Empty JSON → all None, empty extra
        let json = r#"{}"#;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert!(style.background.is_none());
        assert!(style.color.is_none());
        assert!(style.extra.is_empty());
    }

    // ── Test: misnamed keys always go to extra (zero aliases proof) ─────
    // Structural proof that NO serde alias annotations exist on any
    // ResolvedStyle field. Tests 10 plausible alias names (background_color,
    // bg, bg_color, colour, radius, size, weight, align, w, h). Each MUST
    // land in extra — if any reaches a typed field, an alias exists.
    // This is the exhaustive grep-equivalent test from the task checklist.

    #[test]
    fn test_zero_serde_alias_on_resolved_style() {
        // 10 plausible aliases — every one MUST go to extra
        let misnamed_keys = vec![
            ("background_color", "background"),
            ("bg", "background"),
            ("bg_color", "background"),
            ("colour", "color"),
            ("radius", "border_radius"),
            ("size", "font_size"),
            ("weight", "font_weight"),
            ("align", "text_align"),
            ("w", "width"),
            ("h", "height"),
        ];
        for (wrong_key, canonical_field) in misnamed_keys {
            let json = format!(r#"{{"{wrong_key}": "test_value"}}"#);
            let style: ResolvedStyle = serde_json::from_str(&json).unwrap();
            assert!(
                style.extra.contains_key(wrong_key),
                "Misnamed key '{}' must go to extra (no alias to '{}')",
                wrong_key,
                canonical_field
            );
        }
    }

    // ── Test: Dimension deserialization ─────────────────────────────────
    // Dimension::Pixels from numbers, Dimension::Percent from strings like "50%"

    #[test]
    fn test_dimension_deserialize_pixels() {
        // Integer
        let json = "400";
        let dim: Dimension = serde_json::from_str(json).unwrap();
        assert_eq!(dim, Dimension::Pixels(400.0));

        // Float
        let json = "400.5";
        let dim: Dimension = serde_json::from_str(json).unwrap();
        assert_eq!(dim, Dimension::Pixels(400.5));
    }

    #[test]
    fn test_dimension_deserialize_percent() {
        // "50%"
        let json = r#""50%""#;
        let dim: Dimension = serde_json::from_str(json).unwrap();
        assert_eq!(dim, Dimension::Percent(0.5));

        // "100%"
        let json = r#""100%""#;
        let dim: Dimension = serde_json::from_str(json).unwrap();
        assert_eq!(dim, Dimension::Percent(1.0));

        // "25%"
        let json = r#""25%""#;
        let dim: Dimension = serde_json::from_str(json).unwrap();
        assert_eq!(dim, Dimension::Percent(0.25));
    }

    #[test]
    fn test_dimension_resolve() {
        // Pixels resolve to self
        let dim = Dimension::Pixels(400.0);
        assert_eq!(dim.resolve(800.0), 400.0);

        // Percent resolves to parent_size * fraction
        let dim = Dimension::Percent(0.5);
        assert_eq!(dim.resolve(800.0), 400.0);

        let dim = Dimension::Percent(1.0);
        assert_eq!(dim.resolve(1024.0), 1024.0);

        let dim = Dimension::Percent(0.25);
        assert_eq!(dim.resolve(1000.0), 250.0);
    }

    #[test]
    fn test_resolved_style_with_dimension() {
        // Test width/height as Option<Dimension>
        let json = r#"{"width": 400, "height": "50%"}"#;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();

        assert_eq!(style.width, Some(Dimension::Pixels(400.0)));
        assert_eq!(style.height, Some(Dimension::Percent(0.5)));
    }

    #[test]
    fn test_resolved_style_with_percentage_dimensions_resolved_tokens() {
        // Migration 135 scenario WITH resolved tokens (theme available)
        let json =
            r##"{"background": "#1a1a2e", "color": "#e0e0e0", "width": "100%", "height": "100%"}"##;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert_eq!(style.width, Some(Dimension::Percent(1.0)));
        assert_eq!(style.height, Some(Dimension::Percent(1.0)));
        assert_eq!(style.background, Some("#1a1a2e".to_string()));
    }

    #[test]
    fn test_resolved_style_with_unresolved_token_objects_now_resilient() {
        // Migration 135 scenario WITHOUT resolved tokens (no theme)
        // background: {"$token": "..."} is a JSON object, not a string.
        // With deserialize_lenient_string, the object gracefully becomes None
        // and width/height are PRESERVED.
        let json = r#"{
            "background": {"$token": "colors/surface/solid"},
            "color": {"$token": "colors/text/primary"},
            "width": "100%",
            "height": "100%"
        }"#;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        // background/color gracefully fall to None (unresolved tokens)
        assert_eq!(style.background, None);
        assert_eq!(style.color, None);
        // width/height are PRESERVED — not lost due to token issues
        assert_eq!(style.width, Some(Dimension::Percent(1.0)));
        assert_eq!(style.height, Some(Dimension::Percent(1.0)));
    }

    #[test]
    fn test_resolved_style_unresolved_tokens_graceful_fallback() {
        // With deserialize_lenient_string, an object-typed background gracefully
        // becomes None while width is preserved.
        let json = r#"{
            "background": {"$token": "colors/surface/solid"},
            "width": "100%"
        }"#;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert_eq!(style.background, None);
        assert_eq!(style.width, Some(Dimension::Percent(1.0)));
    }

    #[test]
    fn test_resolved_style_migration_122_unresolved_tokens_now_resilient() {
        // Migration 122 scenario: flex:1 with unresolved $token.
        // With deserialize_lenient_string, tokens gracefully become None
        // while flex is preserved.
        let json = r#"{
            "background": {"$token": "colors/surface/solid"},
            "color": {"$token": "colors/text/primary"},
            "flex": 1
        }"#;
        let style: ResolvedStyle = serde_json::from_str(json).unwrap();
        assert_eq!(style.background, None);
        assert_eq!(style.color, None);
        assert_eq!(style.flex, Some(1.0));
    }

    #[test]
    fn test_dimension_percent_roundtrip() {
        // Percent roundtrips correctly through serialize → deserialize
        let original = Dimension::Percent(1.0);
        let json = serde_json::to_value(&original).unwrap();
        assert_eq!(
            json,
            serde_json::json!("100%"),
            "Percent(1.0) serializes as '100%'"
        );
        let roundtripped: Dimension = serde_json::from_value(json).unwrap();
        assert_eq!(roundtripped, original, "Percent roundtrip is identity");
    }

    #[test]
    fn test_dimension_pixels_roundtrip() {
        let original = Dimension::Pixels(400.0);
        let json = serde_json::to_value(&original).unwrap();
        assert_eq!(
            json,
            serde_json::json!(400.0),
            "Pixels(400.0) serializes as 400.0"
        );
        let roundtripped: Dimension = serde_json::from_value(json).unwrap();
        assert_eq!(roundtripped, original, "Pixels roundtrip is identity");
    }

    #[test]
    fn test_dimension_edge_cases() {
        // Percent(0.0) = "0%"
        let d = Dimension::Percent(0.0);
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json, serde_json::json!("0%"));
        assert_eq!(serde_json::from_value::<Dimension>(json).unwrap(), d);

        // Percent(0.5) = "50%"
        let d = Dimension::Percent(0.5);
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json, serde_json::json!("50%"));
        assert_eq!(serde_json::from_value::<Dimension>(json).unwrap(), d);

        // Pixels(0.0) roundtrips
        let d = Dimension::Pixels(0.0);
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json, serde_json::json!(0.0));
        assert_eq!(serde_json::from_value::<Dimension>(json).unwrap(), d);

        // Integer pixels via visit_i64
        let json = serde_json::json!(200);
        let d: Dimension = serde_json::from_value(json).unwrap();
        assert_eq!(d, Dimension::Pixels(200.0));
    }

    // ============================================================================
    // Tests for NodeKind::Component and NodeProps::component_id (Task 0430)
    // ============================================================================

    #[test]
    fn test_nodekind_component_variant_exists() {
        // Verify NodeKind::Component can be constructed and matched
        let kind = NodeKind::Component;
        match kind {
            NodeKind::Component => {
                // Expected case
            }
            _ => {
                panic!("NodeKind::Component variant should match");
            }
        }
    }

    #[test]
    fn test_nodekind_component_serializes_correctly() {
        // Verify NodeKind::Component serializes to "Component" string
        let kind = NodeKind::Component;
        let json = serde_json::to_value(&kind).unwrap();
        assert_eq!(json, serde_json::json!("Component"));

        // Verify roundtrip
        let roundtripped: NodeKind = serde_json::from_value(json).unwrap();
        assert_eq!(roundtripped, NodeKind::Component);
    }

    #[test]
    fn test_nodeprops_component_id_none_by_default() {
        // Verify that default NodeProps has component_id: None
        let props = NodeProps::default();
        assert_eq!(props.component_id, None);
    }

    #[test]
    fn test_nodeprops_component_id_some() {
        // Verify that NodeProps can be constructed with component_id: Some(...)
        let props = NodeProps {
            style: None,
            text: None,
            src: None,
            handlers: None,
            a11y: None,
            custom: None,
            component_id: Some("ui_component:panel".to_string()),
            bundle: None,
            integrity_hash: None,
            instance_props: None,
            artifact_dependencies: None,
            things_to_put_on_screen: None,
            ..Default::default()
        };
        assert_eq!(props.component_id, Some("ui_component:panel".to_string()));
    }

    #[test]
    fn test_nodeprops_component_id_serialization() {
        // Verify that NodeProps with component_id serializes correctly
        let props = NodeProps {
            style: None,
            text: None,
            src: None,
            handlers: None,
            a11y: None,
            custom: None,
            component_id: Some("ui_component:panel".to_string()),
            bundle: None,
            integrity_hash: None,
            instance_props: None,
            artifact_dependencies: None,
            things_to_put_on_screen: None,
            ..Default::default()
        };
        let json = serde_json::to_value(&props).unwrap();
        assert_eq!(
            json.get("component_id"),
            Some(&serde_json::json!("ui_component:panel"))
        );

        // Verify roundtrip
        let roundtripped: NodeProps = serde_json::from_value(json).unwrap();
        assert_eq!(
            roundtripped.component_id,
            Some("ui_component:panel".to_string())
        );
    }

    #[test]
    fn test_nodeprops_component_id_none_not_serialized() {
        // Verify that NodeProps with component_id: None skips serialization (due to skip_serializing_if)
        let props = NodeProps {
            style: None,
            text: None,
            src: None,
            handlers: None,
            a11y: None,
            custom: None,
            component_id: None,
            bundle: None,
            integrity_hash: None,
            artifact_dependencies: None,
            instance_props: None,
            things_to_put_on_screen: None,
            ..Default::default()
        };
        let json = serde_json::to_value(&props).unwrap();
        // The component_id field should not be present in the JSON
        // because it's Option<T> and should be skipped when None
        assert!(
            json.get("component_id").is_none(),
            "component_id should be absent from serialized JSON when None"
        );
    }

    #[test]
    fn test_scenenode_with_component_kind() {
        // Verify that SceneNode can be created with NodeKind::Component
        let mut node = SceneNode::default();
        node.id = "test-node".to_string();
        node.kind = NodeKind::Component;
        node.props.component_id = Some("ui_component:panel".to_string());

        assert_eq!(node.kind, NodeKind::Component);
        assert_eq!(
            node.props.component_id,
            Some("ui_component:panel".to_string())
        );
    }
}
