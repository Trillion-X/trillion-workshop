// crates/composition-engine-core/src/kernel/snapshot_delta.rs
//
// # Purpose
//
// Defines the `SnapshotDelta` type and the `compute_snapshot_delta()` function
// that computes O(dirty) deltas between consecutive scene snapshots. This is
// P5 of the IRPA (Incremental Runtime Publication Architecture): the WASM
// boundary sends only what changed, not the full tree.
//
// # Architecture
//
// The composition engine's render pipeline produces a `SceneSnapshot` each frame.
// Pre-Task 169, this full snapshot was serialized at the WASM boundary via
// `to_js_value(&snapshot)` — O(tree_size) regardless of how many nodes changed.
// With structural sharing (P1: `Arc<SceneNode>`), unchanged subtrees are
// pointer-identical across frames, but `Arc::ptr_eq` is invisible across the
// WASM membrane — serialization still walks every node.
//
// This module solves the boundary problem by computing a `SnapshotDelta` that
// contains ONLY what changed. The delta is O(dirty) to serialize, not O(n).
//
// ```text
// render()
//   → SceneSnapshot (full, Arc-shared internally)
//   → compute_snapshot_delta(prev, current, runtime_delta)
//   → SnapshotDelta (O(dirty) fields only)
//   → to_js_value(&SnapshotPublication::Delta(delta))  ← O(dirty) serialization
// ```
//
// # Dual-Mode Publication (I-Frame / P-Frame)
//
// Like video codecs, publication uses two modes:
// - **I-frame (Full):** Frame 0, resync, or structural changes — send entire snapshot.
// - **P-frame (Delta):** Steady-state frames — send only what changed.
// - **Noop:** Nothing changed — zero serialization cost.
//
// The host holds a replica of the last full snapshot and applies delta patches.
// The host remains "dumb" — it applies patches, it does NOT compute diffs.
//
// # Key Algorithm: Arc::ptr_eq Tree Diffing
//
// `compute_snapshot_delta()` walks both trees in parallel, using `Arc::ptr_eq`
// to skip unchanged subtrees in O(1). Only the "dirty spine" from root to
// changed nodes is visited. For a single property change in a balanced tree
// of 100K nodes, this visits ~17 nodes (tree depth), not 100K.
//
// # Non-Negotiable Invariants
//
// 1. **O(dirty) serialization** — Delta size is proportional to changed nodes,
//    not tree size. A 1-node change on a 100K-node tree produces a ~100B delta.
// 2. **Oracle correctness** — Applying a sequence of deltas to a base snapshot
//    MUST produce identical results to a fresh full snapshot.
// 3. **Full snapshots on structure change** — InsertNode/RemoveSubtree produce
//    StructurePatches. The host must handle inserts and removes.
// 4. **Canonical types** — All delta types have Serialize + Deserialize derives
//    for JSON wire format through the SharedBufferProtocol slot ABI.
// 5. **Physics-only** — No Society words. Content-agnostic.
//
// # Platform Portability
//
// Pure Rust, no platform dependencies. Compiles to WASM and native.
//
// # Security Considerations
//
// Delta contains the same data types as SceneSnapshot — no new attack surface.
// No user input parsing, no code execution, no I/O. All data originates from
// the kernel's validated SceneNode tree.
//
// # AI Directive
//
// The extensive documentation in this codebase is a critical design feature.
// You are FORBIDDEN from simplifying or removing it. Your mandate is to
// MAINTAIN and EXTEND this level of meticulous detail.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::routing::RoutingState;
use super::runtime_graph::RuntimeDelta;
use super::types::{
    EdgePatch, LayoutFrame, NodeKind, NodeProps, NodeTrigger, ResolvedStyle, SceneNode,
    SceneSnapshot, SemanticProps, TextInputCapability, Visibility, VisibilityPatch, ID,
};

// ============================================================================
// SnapshotPublication — Dual-Mode Publication Contract
// ============================================================================

/// Dual-mode publication result: Full snapshot (I-frame), Delta patch (P-frame),
/// or Noop (nothing changed).
///
/// # Usage
///
/// ```text
/// Frame 0:  SnapshotPublication::Full(snapshot)   — host builds initial replica
/// Frame 1+: SnapshotPublication::Delta(delta)     — host applies patch to replica
/// Clean:    SnapshotPublication::Noop              — host does nothing (0 bytes)
/// Resync:   SnapshotPublication::Full(snapshot)   — host rebuilds replica
/// ```
///
/// # Non-Negotiable Invariants
///
/// 1. First frame MUST be Full (host has no replica to patch).
/// 2. Noop means zero serialization — not even an empty delta object.
/// 3. Full is always correct — it's the fallback for complex structural changes.
/// 4. Delta is O(dirty) to serialize.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode")]
pub enum SnapshotPublication {
    /// Frame 0 or resync — full snapshot. Host builds/rebuilds its entire replica.
    #[serde(rename = "full")]
    Full(SceneSnapshot),

    /// Steady-state frame — only what changed. Host applies patches to its replica.
    #[serde(rename = "delta")]
    Delta(SnapshotDelta),

    /// Nothing changed — no serialization needed. Host does nothing.
    #[serde(rename = "noop")]
    Noop,
}

// ============================================================================
// SnapshotDelta — O(dirty) Delta Between Two Snapshots
// ============================================================================

/// Delta between two consecutive snapshots. Contains ONLY what changed.
///
/// O(dirty) to compute from `RuntimeDelta` + Arc::ptr_eq tree comparison.
/// O(dirty) to serialize at the WASM boundary.
///
/// # Fields
///
/// Each field captures changes to one aspect of the snapshot:
/// - `node_patches`: Property/style/visibility changes on existing nodes
/// - `frame_patches`: Changed layout frames (position/size)
/// - `semantics_patches`: Changed accessibility entries
/// - `focusable_delta`: Nodes added/removed from focusable list
/// - `tabbable_delta`: Nodes added/removed from tabbable list
/// - `text_input_patches`: Text input capabilities added/removed/changed
/// - `routing`: When routing changed, the full new RoutingState (None = unchanged)
/// - `structure_patches`: Nodes added/removed from the tree
///
/// # Applying a Delta
///
/// The host applies patches in this order:
/// 1. Structure patches (add/remove nodes from tree)
/// 2. Node patches (update properties on existing nodes)
/// 3. Frame patches (update layout positions)
/// 4. Semantics patches (update a11y tree)
/// 5. Focus/tab deltas (update focus order)
/// 6. Text input patches (update native input state)
/// 7. Routing (if Some, full-replace with delta's routing state)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotDelta {
    /// Changed node data (property/style/value/visibility changes on existing nodes).
    /// Each patch contains the full current state of the node (minus children).
    pub node_patches: Vec<NodePatch>,

    /// Changed layout frames (position and size changes).
    /// Each patch contains the node ID and its new LayoutFrame.
    pub frame_patches: Vec<FramePatch>,

    /// Changed semantic entries (accessibility property changes).
    /// Includes additions, updates, and removals.
    pub semantics_patches: Vec<SemanticsPatch>,

    /// Focus list changes: nodes added to or removed from the focusable list.
    pub focusable_delta: SetDelta<ID>,

    /// Tab list changes: nodes added to or removed from the tabbable list.
    pub tabbable_delta: SetDelta<ID>,

    /// Text input capability changes: added, removed, or modified text inputs.
    pub text_input_patches: Vec<TextInputPatch>,

    /// When routing changed, contains the full new RoutingState.
    /// None means routing is unchanged — keep the replica's existing routing.
    /// Some(state) means full-replace with this routing state.
    /// Routing is small enough that full-replace is cheaper than a diff protocol.
    pub routing: Option<RoutingState>,

    /// Structural changes: nodes inserted into or removed from the tree.
    /// Applied BEFORE node patches (new nodes need to exist before patching).
    pub structure_patches: Vec<StructurePatch>,

    /// Edge route changes: edges added, updated, or removed.
    /// Engine-computed routes based on node positions and anchor points.
    pub edge_patches: Vec<super::types::EdgePatch>,

    /// Viewport scope transitions: nodes entering or exiting the visible viewport.
    /// Pattern 24: hosts use these to mount/unmount DOM elements as camera pans.
    pub visibility_patches: Vec<super::types::VisibilityPatch>,
}

impl SnapshotDelta {
    /// Returns true if no changes occurred — equivalent to Noop.
    ///
    /// When all fields are empty and routing hasn't changed, the delta carries
    /// zero information and should be published as `SnapshotPublication::Noop`
    /// to avoid serializing even the empty delta object.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.node_patches.is_empty()
            && self.frame_patches.is_empty()
            && self.semantics_patches.is_empty()
            && self.focusable_delta.is_empty()
            && self.tabbable_delta.is_empty()
            && self.text_input_patches.is_empty()
            && self.routing.is_none()
            && self.structure_patches.is_empty()
            && self.edge_patches.is_empty()
            && self.visibility_patches.is_empty()
    }
}

// ============================================================================
// Patch Types — Individual Change Descriptions
// ============================================================================

/// Property/style/visibility patch for a single node.
///
/// Contains the full current state of the node (minus children — structural
/// changes are handled by `StructurePatch`). The host replaces its replica's
/// node data with this patch.
///
/// # Design Decision: Full Node State vs Per-Field Diff
///
/// We send the full node state rather than per-field diffs because:
/// 1. No ambiguity — `Option<None>` means "field is None", not "unchanged"
/// 2. Self-contained — host applies without context
/// 3. Cost is O(1) per changed node — the overhead of extra fields is negligible
///    compared to the O(dirty) vs O(n) savings at the boundary
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodePatch {
    /// ID of the node being patched.
    pub id: ID,
    /// Node kind (Container, Text, Image, etc.)
    pub kind: NodeKind,
    /// Node properties (style, text, src, handlers, a11y, custom).
    pub props: NodeProps,
    /// Visibility state (resolved boolean after binding evaluation).
    pub visible: Visibility,
    /// Style override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<ResolvedStyle>,
    /// Z-index for render ordering.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z_index: Option<i32>,
    /// Value for Custom (input) nodes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    /// Node-level triggers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub triggers: Vec<NodeTrigger>,
    /// Synthetic/pass-through node flag.
    #[serde(default)]
    pub synthetic: bool,
    /// Portal owner reference.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portal_owner: Option<ID>,
}

impl NodePatch {
    /// Create a NodePatch from a SceneNode's current state.
    ///
    /// Captures all non-structural fields. Children are NOT included —
    /// structural changes use `StructurePatch`.
    pub fn from_node(node: &SceneNode) -> Self {
        Self {
            id: node.id.clone(),
            kind: node.kind,
            props: node.props.clone(),
            visible: node.visible.clone(),
            style: node.style.clone(),
            z_index: node.z_index,
            value: node.value.clone(),
            triggers: node.triggers.clone(),
            synthetic: node.synthetic,
            portal_owner: node.portal_owner.clone(),
        }
    }
}

/// Layout frame patch for a single node.
///
/// Contains the node ID and its new layout frame (position + size).
/// The host replaces its replica's frame entry for this node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FramePatch {
    /// ID of the node whose layout changed.
    pub id: ID,
    /// New layout frame (rect + baseline + measured_size).
    pub frame: LayoutFrame,
}

/// Semantics (accessibility) patch for a single node.
///
/// Uses an enum to distinguish additions/updates from removals:
/// - `Upsert`: Node has new or changed semantic properties.
/// - `Remove`: Node's semantic properties were removed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum SemanticsPatch {
    /// Add or update semantic properties for a node.
    #[serde(rename = "upsert")]
    Upsert {
        /// Node ID.
        id: ID,
        /// New semantic properties.
        props: SemanticProps,
    },
    /// Remove semantic properties for a node (node lost a11y annotations).
    #[serde(rename = "remove")]
    Remove {
        /// Node ID.
        id: ID,
    },
}

/// Text input capability patch for a single node.
///
/// Uses an enum to distinguish additions/updates from removals:
/// - `Upsert`: Node has new or changed text input capability.
/// - `Remove`: Node's text input capability was removed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum TextInputPatch {
    /// Add or update text input capability for a node.
    #[serde(rename = "upsert")]
    Upsert {
        /// Node ID.
        id: ID,
        /// New text input capability.
        capability: TextInputCapability,
    },
    /// Remove text input capability for a node.
    #[serde(rename = "remove")]
    Remove {
        /// Node ID.
        id: ID,
    },
}

/// Structural change to the scene tree (node insertion or removal).
///
/// Applied BEFORE node patches — new nodes must exist in the tree before
/// their properties can be patched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum StructurePatch {
    /// A new subtree was inserted into the tree.
    /// Contains the full serialized subtree (all descendants).
    #[serde(rename = "insert")]
    Insert {
        /// Parent node ID (where the subtree was inserted).
        parent_id: ID,
        /// Index in the parent's children list.
        index: usize,
        /// The full inserted subtree (including all descendants).
        subtree: Box<SceneNode>,
    },
    /// A node (and its entire subtree) was removed from the tree.
    #[serde(rename = "remove")]
    Remove {
        /// ID of the removed node.
        node_id: ID,
    },
    /// Children of a node were reordered (no adds/removes, just position change).
    #[serde(rename = "reorder")]
    Reorder {
        /// Parent node ID.
        parent_id: ID,
        /// New child ID order.
        child_ids: Vec<ID>,
    },
}

/// Set delta: items added to and removed from an ordered set.
///
/// Generic over the element type (typically `ID` for focusable/tabbable lists).
///
/// # Non-Negotiable Invariants
///
/// 1. `added` and `removed` are disjoint — a node cannot be both added and removed.
/// 2. Applying `delta` to `prev_set`: `result = (prev_set - removed) + added`.
/// 3. Order of `added` is the insertion order in the current set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SetDelta<T> {
    /// Elements added to the set (not present in previous, present in current).
    pub added: Vec<T>,
    /// Elements removed from the set (present in previous, not in current).
    pub removed: Vec<T>,
}

impl<T> SetDelta<T> {
    /// Returns true if no changes occurred (both added and removed are empty).
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }
}

impl<T> Default for SetDelta<T> {
    fn default() -> Self {
        Self {
            added: Vec::new(),
            removed: Vec::new(),
        }
    }
}

// ============================================================================
// Delta Computation — Core Algorithm
// ============================================================================

/// Input context for delta computation.
///
/// Groups all inputs needed by `compute_snapshot_delta()` to avoid a long
/// parameter list. All fields are borrowed references — zero allocation.
pub struct DeltaInput<'a> {
    /// Previous frame's snapshot (the baseline for diffing).
    pub prev: &'a SceneSnapshot,
    /// Current frame's snapshot (what we're comparing against).
    pub current: &'a SceneSnapshot,
    /// RuntimeDelta from the DirtyTracker — tells us what categories changed.
    pub runtime_delta: &'a RuntimeDelta,
    /// Previous frame's focusable node list (from RuntimeGraph).
    pub prev_focusable: &'a [ID],
    /// Current frame's focusable node list (from RuntimeGraph).
    pub current_focusable: &'a [ID],
    /// Previous frame's tabbable node list (from RuntimeGraph).
    pub prev_tabbable: &'a [ID],
    /// Current frame's tabbable node list (from RuntimeGraph).
    pub current_tabbable: &'a [ID],
    /// Visibility patches computed this frame (from spatial index query diff).
    /// Empty if camera did not change and no layout change occurred.
    pub visibility_patches: Vec<VisibilityPatch>,
    /// Edge patches computed this frame (from EdgeRouter diff).
    /// Empty if edges and layout did not change.
    pub edge_patches: Vec<EdgePatch>,
}

/// Compute the delta between two consecutive snapshots.
///
/// Uses `RuntimeDelta` hints and `Arc::ptr_eq` to visit ONLY changed nodes.
/// Unchanged subtrees are skipped in O(1) via pointer comparison.
///
/// # Complexity
///
/// - Tree diff: O(dirty_path_length) — visits only the spine from root to
///   changed nodes, skipping entire unchanged subtrees via `Arc::ptr_eq`.
/// - Frame diff: O(dirty_frames) when layout unchanged (0), O(all_frames)
///   when layout changed (unavoidable — layout cascades affect many frames).
/// - Semantics diff: O(dirty_semantics) — only diffed when focus-relevant
///   changes occurred.
/// - Focus/tab: O(focusable + tabbable) — set comparison.
/// - Text inputs: O(text_inputs) — small (typically <1% of nodes).
///
/// # Arguments
///
/// * `input` - All inputs grouped in `DeltaInput` for clarity.
///
/// # Returns
///
/// A `SnapshotDelta` containing only what changed. If nothing changed,
/// returns an empty delta (`is_empty() == true`).
pub fn compute_snapshot_delta(input: &DeltaInput) -> SnapshotDelta {
    // 1. Tree diff: find node property changes and structural changes.
    //    Uses Arc::ptr_eq to skip unchanged subtrees in O(1).
    let mut node_patches = Vec::new();
    let mut structure_patches = Vec::new();

    if input.runtime_delta.structure_changed {
        // Structural change — diff children lists to find inserts/removes,
        // then recurse into matching children for property changes.
        diff_trees_structural(
            &input.prev.tree,
            &input.current.tree,
            &mut node_patches,
            &mut structure_patches,
        );
    } else if !input.runtime_delta.changed_node_ids.is_empty() {
        // Property-only change — tree shape is identical, only node data differs.
        // Walk the tree using Arc::ptr_eq to find changed nodes.
        diff_trees_property_only(&input.prev.tree, &input.current.tree, &mut node_patches);
    }
    // else: no node changes — both vecs remain empty.

    // 2. Frame diff: compare layout frames.
    // Uses changed_frame_ids from RuntimeDelta for O(changed) selective diffing
    // when available. Falls back to O(all) when changed_frame_ids is None
    // (full layout or DirtyTracker-only delta).
    let frame_patches = if input.runtime_delta.layout_changed {
        diff_frames_selective(
            &input.prev.frames,
            &input.current.frames,
            input.runtime_delta.changed_frame_ids.as_ref(),
        )
    } else if !Arc::ptr_eq(&input.prev.frames, &input.current.frames) {
        // Arc differs but layout_changed=false — shouldn't happen, but be safe.
        diff_frames_selective(&input.prev.frames, &input.current.frames, None)
    } else {
        Vec::new()
    };

    // 3. Semantics diff: compare accessibility properties.
    let semantics_patches = if input.runtime_delta.focus_relevant_changed {
        diff_semantics(&input.prev.semantics, &input.current.semantics)
    } else {
        Vec::new()
    };

    // 4. Focus/tab deltas: compare ordered lists.
    let focusable_delta = if input.runtime_delta.focus_relevant_changed {
        compute_set_delta(input.prev_focusable, input.current_focusable)
    } else {
        SetDelta::default()
    };

    let tabbable_delta = if input.runtime_delta.focus_relevant_changed {
        compute_set_delta(input.prev_tabbable, input.current_tabbable)
    } else {
        SetDelta::default()
    };

    // 5. Text input diff: compare text input side-maps.
    let text_input_patches = diff_text_inputs(&input.prev.text_inputs, &input.current.text_inputs);

    // 6. Routing: if changed, carry the full new RoutingState in the delta.
    //    The delta is self-contained — no side-channel fetch needed.
    let routing = if input.prev.routing != input.current.routing {
        Some(input.current.routing.clone())
    } else {
        None
    };

    SnapshotDelta {
        node_patches,
        frame_patches,
        semantics_patches,
        focusable_delta,
        tabbable_delta,
        text_input_patches,
        routing,
        structure_patches,
        edge_patches: input.edge_patches.clone(),
        visibility_patches: input.visibility_patches.clone(),
    }
}

// ============================================================================
// Tree Diffing — Arc::ptr_eq Parallel Walk
// ============================================================================

/// Diff two trees when only property changes occurred (no structural changes).
///
/// Walks both trees in parallel. When `Arc::ptr_eq` returns true, the entire
/// subtree is skipped in O(1). When Arcs differ, checks if the node's
/// non-children fields changed and emits a `NodePatch` if so.
///
/// # Precondition
///
/// `structure_changed == false` — the two trees have identical shape (same
/// node IDs in the same positions). Only node properties may differ.
fn diff_trees_property_only(
    prev: &Arc<SceneNode>,
    current: &Arc<SceneNode>,
    node_patches: &mut Vec<NodePatch>,
) {
    // O(1) fast path: same Arc = identical data, skip entire subtree.
    if Arc::ptr_eq(prev, current) {
        return;
    }

    // Different Arcs — check this node's non-structural fields.
    if node_data_differs(prev, current) {
        node_patches.push(NodePatch::from_node(current));
    }

    // Recurse into children (same count guaranteed by precondition).
    // Each child comparison starts with Arc::ptr_eq — siblings of the
    // changed node are skipped in O(1).
    for (prev_child, curr_child) in prev.children.iter().zip(current.children.iter()) {
        diff_trees_property_only(prev_child, curr_child, node_patches);
    }
}

/// Diff two trees when structural changes occurred (inserts/removes/reorders).
///
/// More expensive than `diff_trees_property_only` because it must handle
/// mismatched children lists. Uses ID-based matching to find:
/// - Removed nodes: in prev but not in current
/// - Inserted nodes: in current but not in prev
/// - Reordered nodes: same IDs but different positions
/// - Changed nodes: same ID, different properties
fn diff_trees_structural(
    prev: &Arc<SceneNode>,
    current: &Arc<SceneNode>,
    node_patches: &mut Vec<NodePatch>,
    structure_patches: &mut Vec<StructurePatch>,
) {
    // O(1) fast path: same Arc = identical subtree.
    if Arc::ptr_eq(prev, current) {
        return;
    }

    // Different IDs at same position — entire subtree replaced.
    // This is a remove + insert at the structural level.
    if prev.id != current.id {
        // The caller handles this via parent's child list diff.
        return;
    }

    // Same ID, different Arc — check node data.
    if node_data_differs(prev, current) {
        node_patches.push(NodePatch::from_node(current));
    }

    // Diff children lists for structural changes.
    diff_children(prev, current, node_patches, structure_patches);
}

/// Diff children lists between two versions of the same node.
///
/// Uses ID-based matching to identify inserts, removes, reorders, and
/// property changes within matching children.
fn diff_children(
    prev_parent: &SceneNode,
    curr_parent: &SceneNode,
    node_patches: &mut Vec<NodePatch>,
    structure_patches: &mut Vec<StructurePatch>,
) {
    let prev_children = &prev_parent.children;
    let curr_children = &curr_parent.children;

    // Build ID sets for O(1) membership checks.
    let prev_ids: HashSet<&str> = prev_children.iter().map(|c| c.id.as_str()).collect();
    let curr_ids: HashSet<&str> = curr_children.iter().map(|c| c.id.as_str()).collect();

    // Removed nodes: in prev but not in current.
    for child in prev_children {
        if !curr_ids.contains(child.id.as_str()) {
            structure_patches.push(StructurePatch::Remove {
                node_id: child.id.clone(),
            });
        }
    }

    // Inserted nodes: in current but not in prev.
    for (index, child) in curr_children.iter().enumerate() {
        if !prev_ids.contains(child.id.as_str()) {
            // Clone the SceneNode from the Arc for serialization.
            // This is O(subtree_size) but only for genuinely new nodes.
            structure_patches.push(StructurePatch::Insert {
                parent_id: curr_parent.id.clone(),
                index,
                subtree: Box::new((**child).clone()),
            });
        }
    }

    // Reorder detection: same IDs, different order.
    let prev_id_order: Vec<&str> = prev_children.iter().map(|c| c.id.as_str()).collect();
    let curr_id_order: Vec<&str> = curr_children.iter().map(|c| c.id.as_str()).collect();
    // Only emit reorder if no inserts/removes (pure reorder).
    if prev_ids == curr_ids && prev_id_order != curr_id_order {
        structure_patches.push(StructurePatch::Reorder {
            parent_id: curr_parent.id.clone(),
            child_ids: curr_id_order.iter().map(|s| s.to_string()).collect(),
        });
    }

    // Recurse into matching children for property + deeper structural changes.
    let prev_by_id: HashMap<&str, &Arc<SceneNode>> =
        prev_children.iter().map(|c| (c.id.as_str(), c)).collect();

    for child in curr_children {
        if let Some(prev_child) = prev_by_id.get(child.id.as_str()) {
            diff_trees_structural(prev_child, child, node_patches, structure_patches);
        }
        // New children are handled by StructurePatch::Insert above.
    }
}

/// Check if non-structural fields of two nodes differ.
///
/// Compares all fields EXCEPT `children` (structural changes are handled
/// separately). This is O(node_fields) — constant time per node.
#[inline]
fn node_data_differs(prev: &SceneNode, current: &SceneNode) -> bool {
    prev.kind != current.kind
        || prev.props != current.props
        || prev.visible != current.visible
        || prev.style != current.style
        || prev.z_index != current.z_index
        || prev.value != current.value
        || prev.triggers != current.triggers
        || prev.synthetic != current.synthetic
        || prev.portal_owner != current.portal_owner
}

// ============================================================================
// Frame Diffing
// ============================================================================

/// Diff layout frame maps with optional selective filtering.
///
/// When `changed_ids` is `Some(ids)`, only iterates those IDs — O(changed)
/// instead of O(all). When `None`, falls back to iterating all current frames
/// — O(max(prev, current)) — same as the original `diff_frames`.
///
/// This is the key optimization: `compute_layout_incremental` knows which
/// frames it touched, so `diff_frames_selective` can skip the 99% of frames
/// that didn't change. For 85 frames with 3 dirty, this is 35x fewer
/// comparisons.
fn diff_frames_selective(
    prev: &HashMap<ID, LayoutFrame>,
    current: &HashMap<ID, LayoutFrame>,
    changed_ids: Option<&HashSet<String>>,
) -> Vec<FramePatch> {
    let mut patches = Vec::new();

    match changed_ids {
        Some(ids) => {
            // O(changed): only check frames that layout reported as changed.
            for id in ids {
                match current.get(id) {
                    Some(current_frame) => {
                        match prev.get(id) {
                            Some(prev_frame) if prev_frame == current_frame => {
                                // Unchanged — skip.
                            }
                            _ => {
                                // Changed or new frame.
                                patches.push(FramePatch {
                                    id: id.clone(),
                                    frame: *current_frame,
                                });
                            }
                        }
                    }
                    None => {
                        // Frame was removed (evicted by visibility change).
                        // Handled by StructurePatch::Remove — host removes frames
                        // when it removes nodes from its replica.
                    }
                }
            }
        }
        None => {
            // O(all): no change tracking available — compare all frames.
            for (id, current_frame) in current {
                match prev.get(id) {
                    Some(prev_frame) if prev_frame == current_frame => {
                        // Unchanged — skip.
                    }
                    _ => {
                        // Changed or new frame.
                        patches.push(FramePatch {
                            id: id.clone(),
                            frame: *current_frame,
                        });
                    }
                }
            }
        }
    }

    // Note: removed frames (in prev but not current) correspond to removed nodes,
    // which are handled by StructurePatch::Remove. The host removes frames when
    // it removes nodes from its replica.

    patches
}

// ============================================================================
// Semantics Diffing
// ============================================================================

/// Diff two semantics maps, emitting Upsert patches for changed/added entries
/// and Remove patches for deleted entries.
fn diff_semantics(
    prev: &HashMap<ID, SemanticProps>,
    current: &HashMap<ID, SemanticProps>,
) -> Vec<SemanticsPatch> {
    let mut patches = Vec::new();

    // Changed or added entries.
    for (id, current_props) in current {
        match prev.get(id) {
            Some(prev_props) if prev_props == current_props => {
                // Unchanged — skip.
            }
            _ => {
                patches.push(SemanticsPatch::Upsert {
                    id: id.clone(),
                    props: current_props.clone(),
                });
            }
        }
    }

    // Removed entries: in prev but not in current.
    for id in prev.keys() {
        if !current.contains_key(id) {
            patches.push(SemanticsPatch::Remove { id: id.clone() });
        }
    }

    patches
}

// ============================================================================
// Text Input Diffing
// ============================================================================

/// Diff two text input capability maps.
fn diff_text_inputs(
    prev: &HashMap<ID, TextInputCapability>,
    current: &HashMap<ID, TextInputCapability>,
) -> Vec<TextInputPatch> {
    let mut patches = Vec::new();

    // Changed or added entries.
    for (id, current_cap) in current {
        match prev.get(id) {
            Some(prev_cap) if prev_cap == current_cap => {
                // Unchanged — skip.
            }
            _ => {
                patches.push(TextInputPatch::Upsert {
                    id: id.clone(),
                    capability: current_cap.clone(),
                });
            }
        }
    }

    // Removed entries.
    for id in prev.keys() {
        if !current.contains_key(id) {
            patches.push(TextInputPatch::Remove { id: id.clone() });
        }
    }

    patches
}

// ============================================================================
// Set Delta Computation
// ============================================================================

/// Compute the delta between two ordered sets (e.g., focusable/tabbable lists).
///
/// Returns the items added (in current but not prev) and removed (in prev
/// but not current). Order of `added` matches their order in `current`.
fn compute_set_delta(prev: &[ID], current: &[ID]) -> SetDelta<ID> {
    let prev_set: HashSet<&str> = prev.iter().map(|s| s.as_str()).collect();
    let curr_set: HashSet<&str> = current.iter().map(|s| s.as_str()).collect();

    let added: Vec<ID> = current
        .iter()
        .filter(|id| !prev_set.contains(id.as_str()))
        .cloned()
        .collect();

    let removed: Vec<ID> = prev
        .iter()
        .filter(|id| !curr_set.contains(id.as_str()))
        .cloned()
        .collect();

    SetDelta { added, removed }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::{Camera, NodeKind, Rect};

    // ========================================================================
    // Test Helpers
    // ========================================================================

    /// Create a minimal SceneNode with the given ID and kind.
    fn make_node(id: &str, kind: NodeKind) -> SceneNode {
        SceneNode {
            id: id.to_string(),
            kind,
            ..Default::default()
        }
    }

    /// Create a SceneNode with children (wraps each child in Arc).
    fn make_node_with_children(id: &str, children: Vec<SceneNode>) -> SceneNode {
        SceneNode {
            id: id.to_string(),
            kind: NodeKind::Container,
            children: children.into_iter().map(Arc::new).collect(),
            ..Default::default()
        }
    }

    /// Create a minimal SceneSnapshot from a tree.
    fn make_snapshot(tree: SceneNode) -> SceneSnapshot {
        SceneSnapshot {
            tree: Arc::new(tree),
            frames: Arc::new(HashMap::new()),
            routing: Default::default(),
            semantics: HashMap::new(),
            text_inputs: HashMap::new(),
            camera: Camera::default(),
            visible_edge_routes: Vec::new(),
        }
    }

    /// Create a DeltaInput with minimal defaults.
    fn make_delta_input<'a>(
        prev: &'a SceneSnapshot,
        current: &'a SceneSnapshot,
        runtime_delta: &'a RuntimeDelta,
        prev_focusable: &'a [ID],
        current_focusable: &'a [ID],
        prev_tabbable: &'a [ID],
        current_tabbable: &'a [ID],
    ) -> DeltaInput<'a> {
        DeltaInput {
            prev,
            current,
            runtime_delta,
            prev_focusable,
            current_focusable,
            prev_tabbable,
            current_tabbable,
            visibility_patches: Vec::new(),
            edge_patches: Vec::new(),
        }
    }

    /// Create a RuntimeDelta indicating specific nodes changed.
    fn delta_with_changed_nodes(ids: &[&str]) -> RuntimeDelta {
        RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: false,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(ids.iter().map(|s| s.to_string()).collect())
        }
    }

    /// Create a RuntimeDelta indicating structure changed.
    fn delta_structure_changed(ids: &[&str]) -> RuntimeDelta {
        RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(ids.iter().map(|s| s.to_string()).collect())
        }
    }

    // ========================================================================
    // Test: Property change produces NodePatch
    // ========================================================================

    #[test]
    fn property_change_produces_node_patch() {
        let child = make_node("child-1", NodeKind::Text);
        let root = make_node_with_children("root", vec![child]);
        let prev = make_snapshot(root);

        // Modify child's text property.
        let mut child_modified = make_node("child-1", NodeKind::Text);
        child_modified.props.text = Some("updated text".to_string());
        let root_modified = make_node_with_children("root", vec![child_modified]);
        let current = make_snapshot(root_modified);

        let runtime_delta = delta_with_changed_nodes(&["child-1"]);
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        assert_eq!(delta.node_patches.len(), 1, "expected 1 node patch");
        assert_eq!(delta.node_patches[0].id, "child-1");
        assert_eq!(
            delta.node_patches[0].props.text,
            Some("updated text".to_string())
        );
        assert!(delta.structure_patches.is_empty(), "no structural changes");
    }

    // ========================================================================
    // Test: Structure change produces StructurePatch (insert)
    // ========================================================================

    #[test]
    fn structure_change_insert_produces_structure_patch() {
        let root = make_node_with_children("root", vec![make_node("child-1", NodeKind::Text)]);
        let prev = make_snapshot(root);

        let root_with_new = make_node_with_children(
            "root",
            vec![
                make_node("child-1", NodeKind::Text),
                make_node("child-2", NodeKind::Rect),
            ],
        );
        let current = make_snapshot(root_with_new);

        let runtime_delta = delta_structure_changed(&["child-2"]);
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        let inserts: Vec<_> = delta
            .structure_patches
            .iter()
            .filter(|p| matches!(p, StructurePatch::Insert { .. }))
            .collect();
        assert_eq!(inserts.len(), 1, "expected 1 insert patch");
        if let StructurePatch::Insert {
            parent_id,
            index,
            subtree,
        } = &inserts[0]
        {
            assert_eq!(parent_id, "root");
            assert_eq!(*index, 1);
            assert_eq!(subtree.id, "child-2");
        }
    }

    // ========================================================================
    // Test: Structure change produces StructurePatch (remove)
    // ========================================================================

    #[test]
    fn structure_change_remove_produces_structure_patch() {
        let root = make_node_with_children(
            "root",
            vec![
                make_node("child-1", NodeKind::Text),
                make_node("child-2", NodeKind::Rect),
            ],
        );
        let prev = make_snapshot(root);

        let root_after_remove =
            make_node_with_children("root", vec![make_node("child-1", NodeKind::Text)]);
        let current = make_snapshot(root_after_remove);

        let runtime_delta = delta_structure_changed(&[]);
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        let removes: Vec<_> = delta
            .structure_patches
            .iter()
            .filter(|p| matches!(p, StructurePatch::Remove { .. }))
            .collect();
        assert_eq!(removes.len(), 1, "expected 1 remove patch");
        if let StructurePatch::Remove { node_id } = &removes[0] {
            assert_eq!(node_id, "child-2");
        }
    }

    // ========================================================================
    // Test: Layout change produces FramePatch entries
    // ========================================================================

    #[test]
    fn layout_change_produces_frame_patches() {
        let root = make_node("root", NodeKind::Container);
        let mut prev = make_snapshot(root.clone());

        let mut prev_frames = HashMap::new();
        prev_frames.insert(
            "root".to_string(),
            LayoutFrame::from_rect(Rect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            }),
        );
        prev.frames = Arc::new(prev_frames);

        let mut current = make_snapshot(root);
        let mut curr_frames = HashMap::new();
        curr_frames.insert(
            "root".to_string(),
            LayoutFrame::from_rect(Rect {
                x: 0.0,
                y: 0.0,
                w: 200.0,
                h: 100.0,
            }),
        );
        current.frames = Arc::new(curr_frames);

        let runtime_delta = RuntimeDelta {
            layout_changed: true,
            ..Default::default()
        };
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        assert_eq!(delta.frame_patches.len(), 1);
        assert_eq!(delta.frame_patches[0].id, "root");
        assert_eq!(delta.frame_patches[0].frame.rect.w, 200.0);
    }

    // ========================================================================
    // Test: Semantics change produces SemanticsPatch
    // ========================================================================

    #[test]
    fn semantics_change_produces_semantics_patches() {
        let root = make_node("root", NodeKind::Container);
        let mut prev = make_snapshot(root.clone());
        prev.semantics.insert(
            "node-a".to_string(),
            SemanticProps {
                role: Some(crate::kernel::types::Role::Button),
                label: Some("Click me".to_string()),
                ..Default::default()
            },
        );

        let mut current = make_snapshot(root);
        current.semantics.insert(
            "node-a".to_string(),
            SemanticProps {
                role: Some(crate::kernel::types::Role::Button),
                label: Some("Updated label".to_string()),
                ..Default::default()
            },
        );

        let runtime_delta = RuntimeDelta {
            focus_relevant_changed: true,
            ..Default::default()
        };
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        assert_eq!(delta.semantics_patches.len(), 1);
        match &delta.semantics_patches[0] {
            SemanticsPatch::Upsert { id, props } => {
                assert_eq!(id, "node-a");
                assert_eq!(props.label, Some("Updated label".to_string()));
            }
            other => panic!("expected Upsert, got {:?}", other),
        }
    }

    // ========================================================================
    // Test: Focus change produces focusable_delta
    // ========================================================================

    #[test]
    fn focus_change_produces_focusable_delta() {
        let root = make_node("root", NodeKind::Container);
        let prev = make_snapshot(root.clone());
        let current = make_snapshot(root);

        let prev_focusable: Vec<ID> = vec!["btn-1".to_string(), "btn-2".to_string()];
        let curr_focusable: Vec<ID> = vec!["btn-1".to_string(), "btn-3".to_string()];

        let runtime_delta = RuntimeDelta {
            focus_relevant_changed: true,
            ..Default::default()
        };
        let input = make_delta_input(
            &prev,
            &current,
            &runtime_delta,
            &prev_focusable,
            &curr_focusable,
            &[],
            &[],
        );

        let delta = compute_snapshot_delta(&input);

        assert_eq!(delta.focusable_delta.added, vec!["btn-3".to_string()]);
        assert_eq!(delta.focusable_delta.removed, vec!["btn-2".to_string()]);
    }

    // ========================================================================
    // Test: Text input change produces TextInputPatch
    // ========================================================================

    #[test]
    fn text_input_change_produces_patch() {
        let root = make_node("root", NodeKind::Container);
        let mut prev = make_snapshot(root.clone());
        prev.text_inputs.insert(
            "input-1".to_string(),
            TextInputCapability {
                value: "hello".to_string(),
                selection: crate::kernel::types::TextRange { start: 0, end: 0 },
                secure: false,
                multiline: false,
                keyboard_type: "text".to_string(),
                placeholder: None,
                input_type: None,
            },
        );

        let mut current = make_snapshot(root);
        current.text_inputs.insert(
            "input-1".to_string(),
            TextInputCapability {
                value: "hello world".to_string(),
                selection: crate::kernel::types::TextRange { start: 11, end: 11 },
                secure: false,
                multiline: false,
                keyboard_type: "text".to_string(),
                placeholder: None,
                input_type: None,
            },
        );

        let runtime_delta = RuntimeDelta::default();
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        assert_eq!(delta.text_input_patches.len(), 1);
        match &delta.text_input_patches[0] {
            TextInputPatch::Upsert { id, capability } => {
                assert_eq!(id, "input-1");
                assert_eq!(capability.value, "hello world");
            }
            other => panic!("expected Upsert, got {:?}", other),
        }
    }

    // ========================================================================
    // Test: Routing change produces routing: Some(new_state)
    // ========================================================================

    #[test]
    fn routing_change_produces_some() {
        let root = make_node("root", NodeKind::Container);
        let prev = make_snapshot(root.clone());

        let mut current = make_snapshot(root);
        // Modify routing by inserting a route.
        current.routing.routes.insert(
            crate::kernel::routing::OriginID {
                id: "keyboard:0".to_string(),
            },
            "btn-1".to_string(),
        );

        let runtime_delta = RuntimeDelta::default();
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        assert!(
            delta.routing.is_some(),
            "routing should carry the new RoutingState"
        );
        assert_eq!(
            delta.routing.as_ref().unwrap().routes.len(),
            1,
            "routing should carry the new route"
        );
    }

    // ========================================================================
    // Test: Clean frame produces empty delta
    // ========================================================================

    #[test]
    fn clean_frame_produces_empty_delta() {
        let root = make_node_with_children("root", vec![make_node("child-1", NodeKind::Text)]);
        let snapshot = make_snapshot(root);

        // Same snapshot for both prev and current.
        let runtime_delta = RuntimeDelta::default();
        let input = make_delta_input(&snapshot, &snapshot, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        assert!(delta.is_empty(), "clean frame should produce empty delta");
        assert!(delta.node_patches.is_empty());
        assert!(delta.frame_patches.is_empty());
        assert!(delta.semantics_patches.is_empty());
        assert!(delta.focusable_delta.is_empty());
        assert!(delta.tabbable_delta.is_empty());
        assert!(delta.text_input_patches.is_empty());
        assert!(delta.routing.is_none());
        assert!(delta.structure_patches.is_empty());
    }

    // ========================================================================
    // Test: SnapshotPublication — first render returns Full
    // ========================================================================

    #[test]
    fn publication_full_contains_snapshot() {
        let root = make_node("root", NodeKind::Container);
        let snapshot = make_snapshot(root);
        let publication = SnapshotPublication::Full(snapshot.clone());

        match publication {
            SnapshotPublication::Full(s) => {
                assert_eq!(s.tree.id, "root");
            }
            _ => panic!("expected Full"),
        }
    }

    // ========================================================================
    // Test: SnapshotPublication — Delta with changes
    // ========================================================================

    #[test]
    fn publication_delta_contains_patches() {
        let delta = SnapshotDelta {
            node_patches: vec![NodePatch {
                id: "node-1".to_string(),
                kind: NodeKind::Text,
                props: NodeProps::default(),
                visible: Visibility::Resolved(true),
                style: None,
                z_index: None,
                value: None,
                triggers: Vec::new(),
                synthetic: false,
                portal_owner: None,
            }],
            frame_patches: Vec::new(),
            semantics_patches: Vec::new(),
            focusable_delta: SetDelta::default(),
            tabbable_delta: SetDelta::default(),
            text_input_patches: Vec::new(),
            routing: None,
            structure_patches: Vec::new(),
            edge_patches: Vec::new(),
            visibility_patches: Vec::new(),
        };

        let publication = SnapshotPublication::Delta(delta);
        match publication {
            SnapshotPublication::Delta(d) => {
                assert_eq!(d.node_patches.len(), 1);
                assert_eq!(d.node_patches[0].id, "node-1");
            }
            _ => panic!("expected Delta"),
        }
    }

    // ========================================================================
    // Test: SnapshotPublication — Noop on no changes
    // ========================================================================

    #[test]
    fn publication_noop_on_no_changes() {
        let publication = SnapshotPublication::Noop;
        assert!(matches!(publication, SnapshotPublication::Noop));
    }

    // ========================================================================
    // Test: Arc::ptr_eq skips unchanged subtrees (only visits dirty path)
    // ========================================================================

    #[test]
    fn arc_ptr_eq_skips_unchanged_subtrees() {
        // Build a tree where only one leaf changes.
        let unchanged_child = Arc::new(make_node("unchanged", NodeKind::Rect));
        let changing_child = make_node("changing", NodeKind::Text);

        let prev_root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::clone(&unchanged_child), Arc::new(changing_child)],
            ..Default::default()
        };
        let prev = make_snapshot(prev_root);

        // Create current tree: unchanged child shares Arc, changing child differs.
        let mut modified_child = make_node("changing", NodeKind::Text);
        modified_child.props.text = Some("new text".to_string());

        let curr_root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::clone(&unchanged_child), // SAME Arc — ptr_eq = true
                Arc::new(modified_child),     // DIFFERENT Arc
            ],
            ..Default::default()
        };
        let current = make_snapshot(curr_root);

        // Verify Arc::ptr_eq behavior.
        assert!(
            Arc::ptr_eq(&prev.tree.children[0], &current.tree.children[0]),
            "unchanged child should share Arc"
        );
        assert!(
            !Arc::ptr_eq(&prev.tree.children[1], &current.tree.children[1]),
            "changed child should have different Arc"
        );

        let runtime_delta = delta_with_changed_nodes(&["changing"]);
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        // Only the "changing" node should appear in patches.
        assert_eq!(delta.node_patches.len(), 1);
        assert_eq!(delta.node_patches[0].id, "changing");
        assert_eq!(
            delta.node_patches[0].props.text,
            Some("new text".to_string())
        );

        // No structural changes.
        assert!(delta.structure_patches.is_empty());
    }

    // ========================================================================
    // Test: Semantics removal produces Remove patch
    // ========================================================================

    #[test]
    fn semantics_removal_produces_remove_patch() {
        let root = make_node("root", NodeKind::Container);
        let mut prev = make_snapshot(root.clone());
        prev.semantics.insert(
            "old-node".to_string(),
            SemanticProps {
                role: Some(crate::kernel::types::Role::Button),
                ..Default::default()
            },
        );

        let current = make_snapshot(root);
        // current has no semantics entries.

        let runtime_delta = RuntimeDelta {
            focus_relevant_changed: true,
            ..Default::default()
        };
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        assert_eq!(delta.semantics_patches.len(), 1);
        match &delta.semantics_patches[0] {
            SemanticsPatch::Remove { id } => assert_eq!(id, "old-node"),
            other => panic!("expected Remove, got {:?}", other),
        }
    }

    // ========================================================================
    // Test: Text input removal produces Remove patch
    // ========================================================================

    #[test]
    fn text_input_removal_produces_remove_patch() {
        let root = make_node("root", NodeKind::Container);
        let mut prev = make_snapshot(root.clone());
        prev.text_inputs.insert(
            "old-input".to_string(),
            TextInputCapability {
                value: "".to_string(),
                selection: crate::kernel::types::TextRange { start: 0, end: 0 },
                secure: false,
                multiline: false,
                keyboard_type: "text".to_string(),
                placeholder: None,
                input_type: None,
            },
        );

        let current = make_snapshot(root);

        let runtime_delta = RuntimeDelta::default();
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        assert_eq!(delta.text_input_patches.len(), 1);
        match &delta.text_input_patches[0] {
            TextInputPatch::Remove { id } => assert_eq!(id, "old-input"),
            other => panic!("expected Remove, got {:?}", other),
        }
    }

    // ========================================================================
    // Test: Empty delta is_empty() returns true
    // ========================================================================

    #[test]
    fn empty_delta_is_empty() {
        let delta = SnapshotDelta {
            node_patches: Vec::new(),
            frame_patches: Vec::new(),
            semantics_patches: Vec::new(),
            focusable_delta: SetDelta::default(),
            tabbable_delta: SetDelta::default(),
            text_input_patches: Vec::new(),
            routing: None,
            structure_patches: Vec::new(),
            edge_patches: Vec::new(),
            visibility_patches: Vec::new(),
        };
        assert!(delta.is_empty());
    }

    // ========================================================================
    // Test: Non-empty delta is_empty() returns false
    // ========================================================================

    #[test]
    fn non_empty_delta_is_not_empty() {
        let delta = SnapshotDelta {
            node_patches: Vec::new(),
            frame_patches: Vec::new(),
            semantics_patches: Vec::new(),
            focusable_delta: SetDelta::default(),
            tabbable_delta: SetDelta::default(),
            text_input_patches: Vec::new(),
            routing: Some(Default::default()), // This alone makes it non-empty.
            structure_patches: Vec::new(),
            edge_patches: Vec::new(),
            visibility_patches: Vec::new(),
        };
        assert!(!delta.is_empty());
    }

    // ========================================================================
    // Test: Tabbable delta computed correctly
    // ========================================================================

    #[test]
    fn tabbable_delta_computed_correctly() {
        let root = make_node("root", NodeKind::Container);
        let prev = make_snapshot(root.clone());
        let current = make_snapshot(root);

        let prev_tabbable: Vec<ID> = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let curr_tabbable: Vec<ID> = vec!["b".to_string(), "c".to_string(), "d".to_string()];

        let runtime_delta = RuntimeDelta {
            focus_relevant_changed: true,
            ..Default::default()
        };
        let input = make_delta_input(
            &prev,
            &current,
            &runtime_delta,
            &[],
            &[],
            &prev_tabbable,
            &curr_tabbable,
        );

        let delta = compute_snapshot_delta(&input);

        assert_eq!(delta.tabbable_delta.added, vec!["d".to_string()]);
        assert_eq!(delta.tabbable_delta.removed, vec!["a".to_string()]);
    }

    // ========================================================================
    // Test: Multiple property changes on different nodes
    // ========================================================================

    #[test]
    fn multiple_property_changes_produce_multiple_patches() {
        let prev_root = make_node_with_children(
            "root",
            vec![
                make_node("a", NodeKind::Text),
                make_node("b", NodeKind::Rect),
                make_node("c", NodeKind::Image),
            ],
        );
        let prev = make_snapshot(prev_root);

        let mut modified_a = make_node("a", NodeKind::Text);
        modified_a.props.text = Some("new a".to_string());
        let mut modified_c = make_node("c", NodeKind::Image);
        modified_c.props.src = Some("new-src.png".to_string());
        let curr_root = make_node_with_children(
            "root",
            vec![
                modified_a,
                make_node("b", NodeKind::Rect), // unchanged in data
                modified_c,
            ],
        );
        let current = make_snapshot(curr_root);

        let runtime_delta = delta_with_changed_nodes(&["a", "c"]);
        let input = make_delta_input(&prev, &current, &runtime_delta, &[], &[], &[], &[]);

        let delta = compute_snapshot_delta(&input);

        // Should have patches for a and c, but not b.
        // Note: since we rebuild all nodes (no Arc sharing in this test),
        // diff_trees_property_only will detect all changed nodes.
        assert!(
            delta.node_patches.iter().any(|p| p.id == "a"),
            "node 'a' should have a patch"
        );
        assert!(
            delta.node_patches.iter().any(|p| p.id == "c"),
            "node 'c' should have a patch"
        );
    }

    // ========================================================================
    // Test: SetDelta is_empty when no changes
    // ========================================================================

    #[test]
    fn set_delta_empty_when_no_changes() {
        let prev: Vec<ID> = vec!["a".to_string(), "b".to_string()];
        let current: Vec<ID> = vec!["a".to_string(), "b".to_string()];
        let delta = compute_set_delta(&prev, &current);
        assert!(delta.is_empty());
    }

    // ========================================================================
    // Test: SnapshotDelta serializes correctly (Serde roundtrip)
    // ========================================================================

    #[test]
    fn snapshot_delta_serializes_to_json() {
        let delta = SnapshotDelta {
            node_patches: vec![NodePatch {
                id: "node-1".to_string(),
                kind: NodeKind::Text,
                props: NodeProps::default(),
                visible: Visibility::Resolved(true),
                style: None,
                z_index: None,
                value: None,
                triggers: Vec::new(),
                synthetic: false,
                portal_owner: None,
            }],
            frame_patches: Vec::new(),
            semantics_patches: Vec::new(),
            focusable_delta: SetDelta::default(),
            tabbable_delta: SetDelta::default(),
            text_input_patches: Vec::new(),
            routing: None,
            structure_patches: Vec::new(),
            edge_patches: Vec::new(),
            visibility_patches: Vec::new(),
        };

        let json = serde_json::to_value(&delta).expect("serialization should succeed");
        assert!(json["node_patches"].is_array());
        assert_eq!(json["node_patches"].as_array().unwrap().len(), 1);
        assert_eq!(json["node_patches"][0]["id"], "node-1");
        assert!(
            json["routing"].is_null(),
            "routing should serialize as null when None"
        );
    }

    // ========================================================================
    // Test: SnapshotPublication serializes with mode tag
    // ========================================================================

    #[test]
    fn snapshot_publication_serializes_with_mode_tag() {
        let noop = SnapshotPublication::Noop;
        let json = serde_json::to_value(&noop).expect("serialization should succeed");
        assert_eq!(json["mode"], "noop");

        let delta = SnapshotPublication::Delta(SnapshotDelta {
            node_patches: Vec::new(),
            frame_patches: Vec::new(),
            semantics_patches: Vec::new(),
            focusable_delta: SetDelta::default(),
            tabbable_delta: SetDelta::default(),
            text_input_patches: Vec::new(),
            routing: None,
            structure_patches: Vec::new(),
            edge_patches: Vec::new(),
            visibility_patches: Vec::new(),
        });
        let json = serde_json::to_value(&delta).expect("serialization should succeed");
        assert_eq!(json["mode"], "delta");
    }
}
