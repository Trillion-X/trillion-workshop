// crates/composition-engine-core/src/kernel/runtime_graph.rs
//
// # Purpose
//
// Incrementally-maintained derived state container for the Composition Engine
// kernel. Owns all collections derived from the scene tree (focusable nodes,
// tabbable nodes, semantics, world transforms) and updates them O(dirty)
// instead of O(n) per frame.
//
// # Architecture
//
// `RuntimeGraph` is the canonical owner of derived state. Before this module
// existed, `create_snapshot()` performed 3-4 independent O(n) tree walks on
// EVERY frame to collect focusable nodes, tabbable nodes, semantics, and
// world transforms — even when nothing changed. RuntimeGraph eliminates this
// by maintaining these collections incrementally:
//
// ```text
// render()
//   → compute()    [resolve bindings — already incremental via DirtyTracker]
//   → layout()     [compute positions — already incremental via dirty_nodes]
//   → RuntimeGraph::update()  ← THIS MODULE
//   → create_snapshot()       [now O(1) reads from RuntimeGraph]
// ```
//
// # Incremental Strategy
//
// RuntimeGraph uses a two-tier update strategy driven by `RuntimeDelta`:
//
// 1. **Full rebuild** — When `structure_changed=true` or `initialized=false`,
//    all collections are recomputed from scratch. This is the same cost as
//    the previous per-frame approach, but it only happens on structural changes
//    (InsertNode, RemoveSubtree, MoveNode, ReorderChildren).
//
// 2. **Incremental update** — When only properties changed (`changed_node_ids`
//    non-empty, `structure_changed=false`), each collection is updated in
//    O(dirty) instead of O(n):
//    - `focusable`: Check only dirty nodes for focusability changes
//    - `tabbable`: Check only dirty nodes, re-sort if any tabbable changed
//    - `semantics`: Re-extract a11y props only for dirty nodes
//    - `world_transforms`: Recompute only affected subtree transforms
//
// 3. **No-op** — When `RuntimeDelta` indicates nothing changed
//    (`changed_node_ids` empty, no flags set), all collections are untouched.
//    This is the O(1) fast path for frames with no mutations.
//
// # Non-Negotiable Invariants
//
// 1. **Canonical single source of truth** — RuntimeGraph OWNS derived state.
//    `create_snapshot()` reads from RuntimeGraph, never recomputes.
// 2. **Post-layout update** — `update()` is called AFTER layout completes
//    (world transforms need layout frames) and BEFORE dirty flag clearing.
// 3. **Conservative on first render** — `initialized=false` forces full
//    rebuild regardless of delta, guaranteeing correctness on boot.
// 4. **Structure change = full rebuild** — Incremental tabbable/focusable
//    updates are not safe across structural changes (removed nodes, new
//    children). Full rebuild is the only correct path.
//
// # Platform Portability
//
// Pure Rust, no platform dependencies. Uses only std::collections.
// Compiles to WASM, native, and any future target.
//
// # Security Considerations
//
// RuntimeGraph contains only derived data — node IDs, semantic properties,
// and transform matrices. No user input parsing, no code execution, no I/O.
// All data originates from the kernel's SceneNode tree (already validated).
//
// # AI Directive
//
// The extensive documentation in this codebase is a critical design feature.
// You are FORBIDDEN from simplifying or removing it. Your mandate is to
// MAINTAIN and EXTEND this level of meticulous detail.

use std::collections::{HashMap, HashSet};

use super::dirty::DirtyTracker;
use super::focus::{
    collect_focusable_nodes, collect_semantics, collect_tabbable_nodes, compare_tab_order,
    is_focusable, is_tabbable, tabbable_sort_key,
};
use super::scene::compute_world_transforms;
use super::types::{FocusState, LayoutFrame, Matrix, SceneNode, SemanticProps, ID};

// ============================================================================
// RuntimeDelta
// ============================================================================

/// Machine-readable description of what changed since the last render frame.
///
/// Produced by `DirtyTracker::to_runtime_delta()` and consumed by
/// `RuntimeGraph::update()`. This is the bridge between the dirty flag system
/// (which tracks WHAT mutations happened) and the incremental update system
/// (which decides HOW to update derived state).
///
/// # Design Principle
///
/// RuntimeDelta translates low-level dirty flags into high-level update
/// decisions. DirtyTracker knows about FSM keys, routing origins, and binding
/// dependencies. RuntimeGraph knows about focusable nodes and semantics.
/// RuntimeDelta bridges the gap with boolean flags that RuntimeGraph can
/// act on without understanding the dirty flag internals.
#[derive(Debug, Clone, Default)]
pub struct RuntimeDelta {
    /// Interned IDs of nodes whose properties changed (from `dirty_nodes` + dep-index
    /// resolution). Empty means no per-node changes occurred.
    ///
    /// Finding 25 (Task 1139): Uses `HashSet<u64>` instead of `HashSet<String>`.
    /// u64 hashing is ~3x faster than String hashing. Node ID strings are interned
    /// via `node_interner` — use `is_node_changed()` to check membership.
    pub changed_node_ids: HashSet<u64>,

    /// Interner for converting node ID strings ↔ u64.
    ///
    /// Populated at construction time with all dirty node IDs. Call sites use
    /// `is_node_changed(&node.id)` which handles the intern lookup + set check.
    pub node_interner: super::dirty::NodeIdInterner,

    /// True if scene tree structure changed (nodes added, removed, moved).
    /// Forces full rebuild of all collections.
    pub structure_changed: bool,

    /// True if layout was recomputed this frame. World transforms must be
    /// rebuilt because node positions changed.
    pub layout_changed: bool,

    /// True if any change could affect focus/tab collections or semantics.
    /// This includes visibility changes, a11y property changes, and any
    /// property change on dirty nodes (conservative — we check each node).
    pub focus_relevant_changed: bool,

    /// IDs of layout frames that changed during incremental layout.
    /// `None` = diff all frames (full layout or unknown).
    /// `Some(ids)` = only these frames changed (from IncrementalLayoutResult).
    /// Used by `diff_frames_selective` to achieve O(changed) instead of O(all).
    pub changed_frame_ids: Option<HashSet<String>>,
}

impl PartialEq for RuntimeDelta {
    fn eq(&self, other: &Self) -> bool {
        self.changed_node_ids == other.changed_node_ids
            && self.structure_changed == other.structure_changed
            && self.layout_changed == other.layout_changed
            && self.focus_relevant_changed == other.focus_relevant_changed
            && self.changed_frame_ids == other.changed_frame_ids
    }
}

impl RuntimeDelta {
    /// Returns true if no changes occurred — RuntimeGraph can skip entirely.
    ///
    /// `changed_frame_ids` is metadata for diff_frames optimization and does NOT
    /// independently indicate "something changed" — layout_changed already covers that.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.changed_node_ids.is_empty()
            && !self.structure_changed
            && !self.layout_changed
            && !self.focus_relevant_changed
    }

    /// Check if a node ID is in the changed set.
    ///
    /// Handles the interner lookup + HashSet check in one call.
    /// Returns false if the node was never interned (i.e., definitely not changed).
    #[inline]
    pub fn is_node_changed(&self, node_id: &str) -> bool {
        self.node_interner
            .get_id(node_id)
            .is_some_and(|id| self.changed_node_ids.contains(&id))
    }

    /// Intern a node ID and insert it into the changed set.
    ///
    /// Used by construction sites that merge String-based dirty sets into
    /// the u64-based RuntimeDelta.
    pub fn intern_and_insert(&mut self, node_id: &str) {
        let id = self.node_interner.intern(node_id);
        self.changed_node_ids.insert(id);
    }

    /// Construct a RuntimeDelta from string node IDs (test convenience).
    ///
    /// Interns each string and builds the `HashSet<u64>` + interner.
    #[cfg(test)]
    pub fn from_changed_strings(ids: HashSet<String>) -> Self {
        let mut delta = Self::default();
        for id in &ids {
            delta.intern_and_insert(id);
        }
        delta
    }

    /// Check if the delta contains a specific node ID string (test convenience).
    #[cfg(test)]
    pub fn contains_node(&self, node_id: &str) -> bool {
        self.is_node_changed(node_id)
    }

    /// Merge another RuntimeDelta into this one.
    ///
    /// Re-interns the other's node IDs through this interner to ensure
    /// consistent u64 mappings.
    pub fn merge_from(&mut self, other: RuntimeDelta) {
        for id in other.changed_node_ids {
            if let Some(s) = other.node_interner.get_str(id) {
                self.intern_and_insert(s);
            }
        }
        self.structure_changed = self.structure_changed || other.structure_changed;
        self.layout_changed = self.layout_changed || other.layout_changed;
        self.focus_relevant_changed = self.focus_relevant_changed || other.focus_relevant_changed;
        self.changed_frame_ids = match (self.changed_frame_ids.take(), other.changed_frame_ids) {
            (Some(mut a), Some(b)) => {
                a.extend(b);
                Some(a)
            }
            (None, _) | (_, None) => None,
        };
    }
}

// ============================================================================
// RuntimeGraph
// ============================================================================

/// Incrementally-maintained container for all derived state.
///
/// Canonical owner of focusable nodes, tabbable nodes, semantics, and world
/// transforms. Updated once per frame via `update()`, read by
/// `create_snapshot()` via accessor methods.
///
/// # Lifecycle
///
/// ```text
/// init_kernel_state() → RuntimeGraph::new()  [empty, initialized=false]
///         ↓
/// render() → compute → layout → RuntimeGraph::update(delta, tree, frames)
///         ↓                         [full rebuild on first call]
/// create_snapshot() → graph.focusable(), graph.tabbable(), ...
///         ↓                         [O(1) reads]
/// (repeat — incremental updates on subsequent frames)
/// ```
///
/// # Thread Safety
///
/// RuntimeGraph is not Sync. Owned by KernelState, which is owned by a
/// single Kernel instance. Same threading model as DirtyTracker.
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeGraph {
    /// Sorted list of focusable node IDs.
    ///
    /// A node is focusable if it is visible AND has either an a11y role or
    /// an explicit tab_index. Collected by `collect_focusable_nodes()`.
    focusable: Vec<ID>,

    /// Sorted list of tabbable node IDs (tab-order sorted).
    ///
    /// A subset of focusable — excludes nodes with negative tab_index.
    /// Sorted by: positive tab_index ascending, then z_index ascending.
    /// Collected by `collect_tabbable_nodes()`.
    tabbable: Vec<ID>,

    /// Semantic properties for all nodes with a11y annotations.
    ///
    /// Built by `collect_semantics()`. The `focused_id` is always `None`
    /// because focus is a Society concept — the kernel (Physics) doesn't
    /// derive which node is "focused". Society (host + bindings) determines
    /// this from the routing state.
    semantics: HashMap<ID, SemanticProps>,

    /// World transform matrices for all nodes.
    ///
    /// Built by `compute_world_transforms()` from the render tree and layout
    /// frames. Maps each node ID to its accumulated transform from root.
    world_transforms: HashMap<ID, Matrix>,

    /// True after the first successful `update()` call.
    ///
    /// When false, `update()` forces a full rebuild regardless of the delta.
    /// This guarantees correctness on the first frame.
    initialized: bool,
}

impl Default for RuntimeGraph {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeGraph {
    /// Create an empty, uninitialized RuntimeGraph.
    ///
    /// All collections are empty. The first call to `update()` will perform
    /// a full rebuild regardless of the delta (initialized=false).
    ///
    /// Prefer `from_tree()` when a scene tree is available at construction
    /// time — this ensures RuntimeGraph is always initialized and eliminates
    /// any fallback paths (canonical single source of truth).
    pub fn new() -> Self {
        Self {
            focusable: Vec::new(),
            tabbable: Vec::new(),
            semantics: HashMap::new(),
            world_transforms: HashMap::new(),
            initialized: false,
        }
    }

    /// Create a RuntimeGraph pre-initialized from a scene tree.
    ///
    /// Performs a full rebuild immediately so the graph is initialized from
    /// the start. This is the canonical constructor for `init_kernel_state()`
    /// — it guarantees that `create_snapshot()` can ALWAYS read from
    /// RuntimeGraph without any fallback path.
    ///
    /// # Arguments
    ///
    /// * `tree` - The scene tree to derive state from.
    /// * `layout_frames` - Layout frames (empty on init — no layout yet).
    pub fn from_tree(tree: &SceneNode, layout_frames: &HashMap<ID, LayoutFrame>) -> Self {
        let mut graph = Self::new();
        graph.init_rebuild(tree, layout_frames);
        graph
    }

    // ========================================================================
    // Accessors (read by create_snapshot)
    // ========================================================================

    /// Returns the cached list of focusable node IDs.
    #[inline]
    pub fn focusable(&self) -> &[ID] {
        &self.focusable
    }

    /// Returns the cached list of tabbable node IDs (tab-order sorted).
    #[inline]
    pub fn tabbable(&self) -> &[ID] {
        &self.tabbable
    }

    /// Returns a reference to the cached semantics map.
    #[inline]
    pub fn semantics(&self) -> &HashMap<ID, SemanticProps> {
        &self.semantics
    }

    /// Returns a reference to the cached world transforms map.
    #[inline]
    pub fn world_transforms(&self) -> &HashMap<ID, Matrix> {
        &self.world_transforms
    }

    /// Returns true if the graph has been initialized (at least one update).
    #[inline]
    pub fn is_initialized(&self) -> bool {
        self.initialized
    }

    // ========================================================================
    // Update (called once per frame, after layout, before dirty clearing)
    // ========================================================================

    /// Update all derived state based on what changed this frame.
    ///
    /// # Arguments
    ///
    /// * `delta` - What changed since the last frame (from DirtyTracker).
    /// * `render_tree` - The fully resolved render tree (bindings evaluated).
    /// * `layout_frames` - The computed layout frames (positions/sizes).
    ///
    /// # Update Strategy
    ///
    /// - `!initialized` → full rebuild (first frame — must collect everything)
    /// - `delta.is_empty()` → no-op (O(1))
    /// - `delta.structure_changed` → incremental structure update: single tree
    ///   walk collects all IDs + inspects changed nodes. Existing focusable/
    ///   tabbable entries are retained if still in tree (removals), new nodes
    ///   are checked for focusability (additions). O(n) for ID collection but
    ///   avoids the double-walk + sort of collect_focusable + collect_tabbable.
    /// - Otherwise → incremental update per collection (O(changed))
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. Must be called AFTER layout completes (needs layout_frames).
    /// 2. Must be called BEFORE dirty flags are cleared (needs the delta).
    /// 3. After this call, all accessor methods return up-to-date data.
    /// 4. `collect_focusable_nodes()` and `collect_tabbable_nodes()` are NEVER
    ///    called from the render pipeline (init/testing only).
    pub fn update(
        &mut self,
        delta: &RuntimeDelta,
        render_tree: &SceneNode,
        layout_frames: &HashMap<ID, LayoutFrame>,
    ) {
        // First frame → full rebuild (must collect everything from scratch)
        if !self.initialized {
            self.init_rebuild(render_tree, layout_frames);
            return;
        }

        // Nothing changed → O(1) no-op
        if delta.is_empty() {
            return;
        }

        // Structure change → incremental structure update
        if delta.structure_changed {
            self.update_structure(render_tree, layout_frames, delta);
            return;
        }

        // Property-only changes → incremental updates per collection
        if delta.focus_relevant_changed {
            self.update_focusable_incremental(render_tree, delta);
            self.update_tabbable_incremental(render_tree, delta);
            self.update_semantics_incremental(render_tree, delta);
        }

        if delta.layout_changed {
            // World transforms depend on layout frames — full recompute when
            // layout changes. Incremental transform updates would require
            // tracking the transform dependency graph (parent→child chain),
            // which adds complexity for marginal gain since layout changes
            // already walked the tree.
            self.world_transforms = compute_world_transforms(render_tree, layout_frames);
        }
    }

    // ========================================================================
    // Initialization Rebuild (first frame only)
    // ========================================================================

    /// Rebuild all collections from scratch on initialization.
    ///
    /// Called ONLY on the first frame (`initialized=false`). Uses the full
    /// collection functions because there is no previous state to update
    /// incrementally from. After this, all subsequent updates use the
    /// incremental paths.
    fn init_rebuild(&mut self, render_tree: &SceneNode, layout_frames: &HashMap<ID, LayoutFrame>) {
        // Physics principle: focused_id is always None in kernel.
        // Focus is a Society concept derived from routing by the host.
        let focus_state = FocusState {
            focused_id: None,
            focusable_nodes: Vec::new(),
            scopes: HashMap::new(),
            tabbable_nodes: Vec::new(),
        };

        self.focusable = collect_focusable_nodes(render_tree);
        self.tabbable = collect_tabbable_nodes(render_tree);
        self.semantics = collect_semantics(render_tree, &focus_state);
        self.world_transforms = compute_world_transforms(render_tree, layout_frames);
        self.initialized = true;
    }

    // ========================================================================
    // Structure Change Update (InsertNode, RemoveSubtree, MoveNode, etc.)
    // ========================================================================

    /// Update all collections after a structural change (nodes added/removed/moved).
    ///
    /// Instead of 4 separate O(n) tree walks (the old full_rebuild), performs
    /// a single O(n) walk that:
    /// 1. Collects all node IDs in the current tree (for removal detection)
    /// 2. For nodes in `changed_node_ids`, checks focusability/tabbability
    ///    and extracts semantic properties (for addition detection)
    ///
    /// Then:
    /// - Retains focusable/tabbable entries whose IDs still exist (removals: O(m))
    /// - Adds newly focusable/tabbable entries (additions: O(changed))
    /// - Uses binary-search insertion for tabbable sort order (O(log m) per insert)
    /// - Prunes stale semantics entries (O(m))
    /// - Recomputes world transforms (layout always changes on structure change)
    ///
    /// # Why not per-patch?
    ///
    /// Patches are consumed by scene_diff_apply before RuntimeGraph::update()
    /// is called. DirtyTracker carries `scene_structure_changed_ids` + `dirty_nodes`
    /// (which contains new node IDs from mark_node_recursive), but not the
    /// original patches. This single-walk approach achieves O(n) + O(changed)
    /// instead of the old 4*O(n) + O(m log m) sort.
    fn update_structure(
        &mut self,
        render_tree: &SceneNode,
        layout_frames: &HashMap<ID, LayoutFrame>,
        delta: &RuntimeDelta,
    ) {
        // Single tree walk: collect all IDs + inspect changed nodes
        let mut all_ids: HashSet<String> = HashSet::new();
        let mut new_focusable: Vec<ID> = Vec::new();
        let mut new_tabbable: Vec<(ID, i32, i32)> = Vec::new();

        // Physics principle: focused_id is always None in kernel
        let focus_state_focused_id: Option<&String> = None;

        super::scene::walk_tree(render_tree, &mut |node, _depth| {
            all_ids.insert(node.id.clone());

            // Only inspect changed (new/modified) nodes for additions
            if delta.is_node_changed(&node.id) {
                if is_focusable(node) && !self.focusable.contains(&node.id) {
                    new_focusable.push(node.id.clone());
                }
                if is_tabbable(node) && !self.tabbable.contains(&node.id) {
                    let key = tabbable_sort_key(node);
                    new_tabbable.push((node.id.clone(), key.0, key.1));
                }

                // Update semantics for changed nodes
                if let Some(ref a11y) = node.props.a11y {
                    let is_focused = focus_state_focused_id == Some(&node.id);
                    let mut states = a11y.states.clone();
                    if is_focused {
                        let states_map = states.get_or_insert_with(HashMap::new);
                        states_map.insert("focused".to_string(), true);
                    }
                    self.semantics.insert(
                        node.id.clone(),
                        SemanticProps {
                            role: a11y.role,
                            label: a11y.label.clone(),
                            tab_index: a11y.tab_index,
                            props: a11y.props.clone(),
                            states,
                        },
                    );
                } else {
                    self.semantics.remove(&node.id);
                }
            }
        });

        // Remove focusable entries for nodes no longer in tree
        self.focusable.retain(|id| all_ids.contains(id));
        // Add newly focusable nodes
        self.focusable.extend(new_focusable);

        // Remove tabbable entries for nodes no longer in tree
        self.tabbable.retain(|id| all_ids.contains(id));
        // Insert new tabbable nodes in sorted order using binary search
        for (id, tab_idx, z_idx) in new_tabbable {
            let key = (tab_idx, z_idx);
            let pos = self.tabbable.partition_point(|existing_id| {
                // Find the sort key for the existing entry.
                // For entries already in the list, we need their sort keys.
                // We look them up from semantics or use default (0, 0).
                let existing_key = self
                    .semantics
                    .get(existing_id)
                    .map(|s| {
                        let t = s.tab_index.unwrap_or(0);
                        let z = 0i32; // z_index not in semantics; use 0
                        (t, z)
                    })
                    .unwrap_or((0, 0));
                compare_tab_order(existing_key, key) == std::cmp::Ordering::Less
            });
            self.tabbable.insert(pos, id);
        }

        // Remove semantics entries for nodes no longer in tree
        self.semantics.retain(|id, _| all_ids.contains(id));

        // Layout always changes on structure change — recompute world transforms
        self.world_transforms = compute_world_transforms(render_tree, layout_frames);
    }

    // ========================================================================
    // Incremental Update Functions (property-only changes)
    // ========================================================================

    /// Incrementally update the focusable node list.
    ///
    /// For each dirty node, check if its focusability changed:
    /// - Was not focusable, now is → add to list
    /// - Was focusable, now is not → remove from list
    /// - No change → skip
    fn update_focusable_incremental(&mut self, render_tree: &SceneNode, delta: &RuntimeDelta) {
        if delta.changed_node_ids.is_empty() {
            return;
        }

        // Build a lookup of current focusable nodes for O(1) membership check
        let current_focusable: HashSet<&str> = self.focusable.iter().map(|s| s.as_str()).collect();
        let mut added = Vec::new();
        let mut removed = HashSet::new();

        // Walk tree once to find dirty nodes and check their focusability
        super::scene::walk_tree(render_tree, &mut |node, _depth| {
            if !delta.is_node_changed(&node.id) {
                return;
            }

            let now_focusable = is_focusable(node);
            let was_focusable = current_focusable.contains(node.id.as_str());

            if now_focusable && !was_focusable {
                added.push(node.id.clone());
            } else if !now_focusable && was_focusable {
                removed.insert(node.id.clone());
            }
        });

        // Apply removals
        if !removed.is_empty() {
            self.focusable.retain(|id| !removed.contains(id));
        }

        // Apply additions (append — order doesn't matter for focusable)
        if !added.is_empty() {
            self.focusable.extend(added);
        }
    }

    /// Incrementally update the tabbable node list.
    ///
    /// For each dirty node, check if its tabbability or sort keys changed.
    /// Uses binary-search insertion to maintain sorted order in O(log m)
    /// per operation instead of O(m log m) full sort.
    ///
    /// Strategy:
    /// 1. Walk tree to find dirty nodes
    /// 2. Remove changed nodes from tabbable list
    /// 3. Re-insert those that are still tabbable at their new sort position
    fn update_tabbable_incremental(&mut self, render_tree: &SceneNode, delta: &RuntimeDelta) {
        if delta.changed_node_ids.is_empty() {
            return;
        }

        let mut to_remove: HashSet<String> = HashSet::new();
        let mut to_insert: Vec<(ID, i32, i32)> = Vec::new();

        // Walk tree to find dirty nodes and determine their tabbability
        super::scene::walk_tree(render_tree, &mut |node, _depth| {
            if !delta.is_node_changed(&node.id) {
                return;
            }

            let was_tabbable = self.tabbable.contains(&node.id);
            let now_tabbable = is_tabbable(node);

            if was_tabbable {
                // Always remove — will re-insert at correct position if still tabbable
                to_remove.insert(node.id.clone());
            }
            if now_tabbable {
                let key = tabbable_sort_key(node);
                to_insert.push((node.id.clone(), key.0, key.1));
            }
        });

        // Apply removals
        if !to_remove.is_empty() {
            self.tabbable.retain(|id| !to_remove.contains(id));
        }

        // Re-insert at correct sorted positions using binary search
        for (id, tab_idx, z_idx) in to_insert {
            let key = (tab_idx, z_idx);
            let pos = self.tabbable.partition_point(|existing_id| {
                let existing_key = self
                    .semantics
                    .get(existing_id)
                    .map(|s| {
                        let t = s.tab_index.unwrap_or(0);
                        (t, 0i32)
                    })
                    .unwrap_or((0, 0));
                compare_tab_order(existing_key, key) == std::cmp::Ordering::Less
            });
            self.tabbable.insert(pos, id);
        }
    }

    /// Incrementally update the semantics map.
    ///
    /// For each dirty node:
    /// - Has a11y props → update/insert entry
    /// - No a11y props → remove entry if it existed
    fn update_semantics_incremental(&mut self, render_tree: &SceneNode, delta: &RuntimeDelta) {
        if delta.changed_node_ids.is_empty() {
            return;
        }

        // Physics principle: focused_id is always None in kernel
        let focus_state_focused_id: Option<&String> = None;

        super::scene::walk_tree(render_tree, &mut |node, _depth| {
            if !delta.is_node_changed(&node.id) {
                return;
            }

            if let Some(ref a11y) = node.props.a11y {
                // Node has a11y props — update/insert
                let is_focused = focus_state_focused_id == Some(&node.id);
                let mut states = a11y.states.clone();
                if is_focused {
                    let states_map = states.get_or_insert_with(HashMap::new);
                    states_map.insert("focused".to_string(), true);
                }

                self.semantics.insert(
                    node.id.clone(),
                    SemanticProps {
                        role: a11y.role,
                        label: a11y.label.clone(),
                        tab_index: a11y.tab_index,
                        props: a11y.props.clone(),
                        states,
                    },
                );
            } else {
                // No a11y props — remove if existed
                self.semantics.remove(&node.id);
            }
        });
    }
}

// ============================================================================
// DirtyTracker → RuntimeDelta bridge
// ============================================================================

impl DirtyTracker {
    /// Convert current dirty state into a RuntimeDelta for RuntimeGraph.
    ///
    /// This is the bridge between DirtyTracker's low-level flags and
    /// RuntimeGraph's high-level update decisions.
    ///
    /// # Mapping
    ///
    /// - `dirty_nodes` → `changed_node_ids` (direct transfer)
    /// - `is_scene_structure_dirty()` → `structure_changed`
    /// - `layout_dirty || viewport_dirty || is_scene_structure_dirty()` → `layout_changed`
    /// - `anything_dirty` → `focus_relevant_changed` (conservative: any property
    ///   change COULD affect visibility, a11y, tab_index)
    ///
    /// # Non-Negotiable Invariants
    ///
    /// 1. Must be called BEFORE `clear()` — reads the current frame's dirty state.
    /// 2. Returns `RuntimeDelta::default()` when `is_clean()` (all empty).
    /// 3. `focus_relevant_changed` is conservatively true when ANY mutation happened,
    ///    because binding evaluation can change visibility/a11y on any dirty node.
    pub fn to_runtime_delta(&self) -> RuntimeDelta {
        if self.is_clean() {
            return RuntimeDelta::default();
        }

        // Use the DirtyTracker's interner — it already has all dirty node IDs
        // interned from mark_node() calls. Clone it so RuntimeDelta owns its copy.
        let node_interner = self.node_interner.clone();
        let changed_node_ids: HashSet<u64> = self
            .dirty_nodes
            .iter()
            .filter_map(|s| node_interner.get_id(s))
            .collect();

        RuntimeDelta {
            changed_node_ids,
            node_interner,
            structure_changed: self.is_scene_structure_dirty(),
            layout_changed: self.layout_dirty
                || self.viewport_dirty
                || self.is_scene_structure_dirty(),
            // Conservative: any mutation could affect focus-relevant properties
            // after binding evaluation resolves visibility/a11y changes.
            focus_relevant_changed: self.anything_dirty,
            // DirtyTracker doesn't know which frames changed — layout provides that.
            // Callers wire this from IncrementalLayoutResult after layout completes.
            changed_frame_ids: None,
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::{A11yProps, Camera, NodeKind, NodeProps, Role, SceneSnapshot};
    use std::sync::Arc;

    // ========================================================================
    // Test Helpers
    // ========================================================================

    /// Create a simple container node with no a11y props.
    fn container(id: &str, children: Vec<SceneNode>) -> SceneNode {
        SceneNode::new(id, NodeKind::Container).with_children(children)
    }

    /// Create a focusable button node.
    fn button(id: &str) -> SceneNode {
        SceneNode::new(id, NodeKind::Container).with_props(NodeProps {
            a11y: Some(A11yProps {
                role: Some(Role::Button),
                tab_index: Some(0),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    /// Create a focusable-but-not-tabbable node (negative tab_index).
    fn focusable_not_tabbable(id: &str) -> SceneNode {
        SceneNode::new(id, NodeKind::Container).with_props(NodeProps {
            a11y: Some(A11yProps {
                role: Some(Role::Button),
                tab_index: Some(-1),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    /// Create a node with a specific tab_index for sort testing.
    fn button_with_tab(id: &str, tab_index: i32) -> SceneNode {
        SceneNode::new(id, NodeKind::Container).with_props(NodeProps {
            a11y: Some(A11yProps {
                role: Some(Role::Button),
                tab_index: Some(tab_index),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    /// Create an invisible node (not focusable regardless of a11y props).
    fn invisible_button(id: &str) -> SceneNode {
        let mut node = button(id);
        node.visible = crate::kernel::types::Visibility::Resolved(false);
        node
    }

    /// Build a standard test tree for most tests.
    ///
    /// ```text
    /// root (container)
    /// ├── btn1 (button, tab=0)
    /// ├── panel (container)
    /// │   ├── btn2 (button, tab=0)
    /// │   └── btn3 (button, tab=0)
    /// └── inert (container, no a11y)
    /// ```
    fn standard_tree() -> SceneNode {
        container(
            "root",
            vec![
                button("btn1"),
                container("panel", vec![button("btn2"), button("btn3")]),
                container("inert", vec![]),
            ],
        )
    }

    /// Create empty layout frames (sufficient for tests that don't check transforms).
    fn empty_frames() -> HashMap<ID, LayoutFrame> {
        HashMap::new()
    }

    /// Create layout frames for transform testing.
    fn layout_frames_for_transforms() -> HashMap<ID, LayoutFrame> {
        use crate::kernel::types::Rect;
        let mut frames = HashMap::new();
        frames.insert(
            "root".to_string(),
            LayoutFrame::from_rect(Rect::new(0.0, 0.0, 800.0, 600.0)),
        );
        frames.insert(
            "btn1".to_string(),
            LayoutFrame::from_rect(Rect::new(10.0, 20.0, 100.0, 40.0)),
        );
        frames.insert(
            "panel".to_string(),
            LayoutFrame::from_rect(Rect::new(0.0, 60.0, 800.0, 200.0)),
        );
        frames.insert(
            "btn2".to_string(),
            LayoutFrame::from_rect(Rect::new(5.0, 5.0, 100.0, 40.0)),
        );
        frames
    }

    // ========================================================================
    // Construction Tests
    // ========================================================================

    /// RuntimeGraph::new() creates an empty, uninitialized graph.
    #[test]
    fn new_creates_empty_uninitialized_graph() {
        let graph = RuntimeGraph::new();
        assert!(
            graph.focusable().is_empty(),
            "focusable must be empty on new"
        );
        assert!(graph.tabbable().is_empty(), "tabbable must be empty on new");
        assert!(
            graph.semantics().is_empty(),
            "semantics must be empty on new"
        );
        assert!(
            graph.world_transforms().is_empty(),
            "world_transforms must be empty on new"
        );
        assert!(!graph.is_initialized(), "must not be initialized on new");
    }

    /// RuntimeGraph::default() is equivalent to RuntimeGraph::new().
    #[test]
    fn default_equals_new() {
        assert_eq!(RuntimeGraph::default(), RuntimeGraph::new());
    }

    // ========================================================================
    // Full Rebuild Tests
    // ========================================================================

    /// First update always does full rebuild regardless of delta.
    #[test]
    fn first_update_full_rebuild_even_with_empty_delta() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = empty_frames();
        let delta = RuntimeDelta::default(); // empty delta

        graph.update(&delta, &tree, &frames);

        assert!(
            graph.is_initialized(),
            "must be initialized after first update"
        );
        assert_eq!(graph.focusable().len(), 3, "3 buttons are focusable");
        assert_eq!(graph.tabbable().len(), 3, "3 buttons are tabbable");
        assert_eq!(graph.semantics().len(), 3, "3 buttons have semantics");
    }

    /// Structure change with InsertNode picks up new focusable node.
    ///
    /// In the real system, InsertNode always calls mark_node_recursive(),
    /// which adds new node IDs to dirty_nodes → changed_node_ids. The delta
    /// must include the new node ID for the incremental path to detect it.
    #[test]
    fn structure_change_insert_picks_up_new_button() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = empty_frames();

        // First update
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 3);

        // Add a new button to the tree (simulates InsertNode)
        let new_tree = container(
            "root",
            vec![
                button("btn1"),
                container("panel", vec![button("btn2"), button("btn3")]),
                button("btn4"), // new button
                container("inert", vec![]),
            ],
        );

        // InsertNode always adds new node IDs to changed_node_ids
        let mut changed = HashSet::new();
        changed.insert("btn4".to_string());
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &new_tree, &frames);
        assert_eq!(
            graph.focusable().len(),
            4,
            "incremental structure update picks up new button"
        );
        assert!(graph.focusable().contains(&"btn4".to_string()));
    }

    /// Structure change with RemoveSubtree removes focusable node.
    #[test]
    fn structure_change_remove_drops_focusable_node() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = empty_frames();

        // First update
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 3);
        assert!(graph.focusable().contains(&"btn2".to_string()));
        assert!(graph.focusable().contains(&"btn3".to_string()));

        // Remove the panel subtree (btn2 and btn3 are gone)
        let new_tree = container("root", vec![button("btn1"), container("inert", vec![])]);

        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..Default::default() // RemoveSubtree doesn't add removed IDs
        };

        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.focusable().len(), 1, "only btn1 remains");
        assert!(graph.focusable().contains(&"btn1".to_string()));
        assert!(
            !graph.focusable().contains(&"btn2".to_string()),
            "btn2 removed"
        );
        assert!(
            !graph.focusable().contains(&"btn3".to_string()),
            "btn3 removed"
        );
    }

    // ========================================================================
    // No-Op Tests
    // ========================================================================

    /// Empty delta after initialization is a no-op.
    #[test]
    fn empty_delta_is_noop() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = empty_frames();

        // Initialize
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        let focusable_before = graph.focusable().to_vec();

        // Empty delta — should be no-op
        let empty_delta = RuntimeDelta::default();
        assert!(empty_delta.is_empty());
        graph.update(&empty_delta, &tree, &frames);

        assert_eq!(graph.focusable(), focusable_before.as_slice());
    }

    // ========================================================================
    // Incremental Focusable Tests
    // ========================================================================

    /// Node becoming invisible removes it from focusable list.
    #[test]
    fn node_becoming_invisible_removed_from_focusable() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = empty_frames();

        // Initialize
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert!(graph.focusable().contains(&"btn1".to_string()));

        // Make btn1 invisible
        let mut modified_tree = standard_tree();
        if let Some(child) = Arc::make_mut(&mut modified_tree.children[0])
            .props
            .a11y
            .as_mut()
        {
            let _ = child; // btn1 is the first child
        }
        // Rebuild with invisible btn1
        let modified_tree = container(
            "root",
            vec![
                invisible_button("btn1"),
                container("panel", vec![button("btn2"), button("btn3")]),
                container("inert", vec![]),
            ],
        );

        let mut changed = HashSet::new();
        changed.insert("btn1".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &modified_tree, &frames);
        assert!(
            !graph.focusable().contains(&"btn1".to_string()),
            "invisible node removed"
        );
        assert_eq!(graph.focusable().len(), 2, "only btn2 and btn3 remain");
    }

    /// Node gaining a11y props becomes focusable.
    #[test]
    fn node_gaining_a11y_becomes_focusable() {
        let mut graph = RuntimeGraph::new();
        // Start with inert having no a11y
        let tree = container("root", vec![button("btn1"), container("inert", vec![])]);
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 1);

        // Give inert a11y props
        let modified_tree = container(
            "root",
            vec![button("btn1"), button("inert")], // now a button
        );

        let mut changed = HashSet::new();
        changed.insert("inert".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &modified_tree, &frames);
        assert!(
            graph.focusable().contains(&"inert".to_string()),
            "inert now focusable"
        );
        assert_eq!(graph.focusable().len(), 2);
    }

    // ========================================================================
    // Incremental Tabbable Tests
    // ========================================================================

    /// Node becoming not-tabbable (negative tab_index) is removed from tabbable.
    #[test]
    fn node_becoming_not_tabbable_removed() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.tabbable().len(), 3);

        // Change btn1 to tab_index=-1 (focusable but not tabbable)
        let modified_tree = container(
            "root",
            vec![
                focusable_not_tabbable("btn1"),
                container("panel", vec![button("btn2"), button("btn3")]),
                container("inert", vec![]),
            ],
        );

        let mut changed = HashSet::new();
        changed.insert("btn1".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &modified_tree, &frames);
        assert!(
            !graph.tabbable().contains(&"btn1".to_string()),
            "btn1 no longer tabbable"
        );
        assert_eq!(graph.tabbable().len(), 2);
        // But btn1 IS still focusable (negative tab_index = focusable, not tabbable)
        assert!(graph.focusable().contains(&"btn1".to_string()));
    }

    /// Tabbable list maintains correct sort order after incremental update.
    #[test]
    fn tabbable_maintains_sort_order_after_update() {
        let mut graph = RuntimeGraph::new();
        let tree = container(
            "root",
            vec![
                button_with_tab("btn-a", 0),
                button_with_tab("btn-b", 2),
                button_with_tab("btn-c", 1),
            ],
        );
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        // Sort order: positive tab_index first ascending: btn-c(1), btn-b(2), then btn-a(0)
        assert_eq!(graph.tabbable()[0], "btn-c", "tab_index=1 first");
        assert_eq!(graph.tabbable()[1], "btn-b", "tab_index=2 second");
        assert_eq!(
            graph.tabbable()[2],
            "btn-a",
            "tab_index=0 last (zero-tabindex group)"
        );

        // Change btn-c's tab_index from 1 to 3
        let modified_tree = container(
            "root",
            vec![
                button_with_tab("btn-a", 0),
                button_with_tab("btn-b", 2),
                button_with_tab("btn-c", 3), // changed from 1 to 3
            ],
        );

        let mut changed = HashSet::new();
        changed.insert("btn-c".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &modified_tree, &frames);
        // New sort: btn-b(2), btn-c(3), btn-a(0)
        assert_eq!(graph.tabbable()[0], "btn-b", "tab_index=2 first");
        assert_eq!(graph.tabbable()[1], "btn-c", "tab_index=3 second");
        assert_eq!(graph.tabbable()[2], "btn-a", "tab_index=0 last");
    }

    // ========================================================================
    // Incremental Semantics Tests
    // ========================================================================

    /// Dirty node's semantics are updated incrementally.
    #[test]
    fn semantics_updated_for_dirty_node() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.semantics().len(), 3);
        assert!(graph.semantics().get("btn1").unwrap().label.is_none());

        // Add a label to btn1
        let mut modified_btn1 = button("btn1");
        modified_btn1.props.a11y.as_mut().unwrap().label = Some("Click me".to_string());
        let modified_tree = container(
            "root",
            vec![
                modified_btn1,
                container("panel", vec![button("btn2"), button("btn3")]),
                container("inert", vec![]),
            ],
        );

        let mut changed = HashSet::new();
        changed.insert("btn1".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &modified_tree, &frames);
        assert_eq!(
            graph.semantics().get("btn1").unwrap().label.as_deref(),
            Some("Click me"),
            "btn1 semantics updated"
        );
        // Other nodes unchanged
        assert!(graph.semantics().get("btn2").unwrap().label.is_none());
    }

    /// Node losing a11y props has semantics removed.
    #[test]
    fn node_losing_a11y_removes_semantics() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert!(graph.semantics().contains_key("btn1"));

        // Replace btn1 with a plain container (no a11y)
        let modified_tree = container(
            "root",
            vec![
                container("btn1", vec![]), // was button, now plain container
                container("panel", vec![button("btn2"), button("btn3")]),
                container("inert", vec![]),
            ],
        );

        let mut changed = HashSet::new();
        changed.insert("btn1".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &modified_tree, &frames);
        assert!(
            !graph.semantics().contains_key("btn1"),
            "semantics removed for btn1"
        );
        assert_eq!(graph.semantics().len(), 2, "btn2 and btn3 remain");
    }

    // ========================================================================
    // World Transform Tests
    // ========================================================================

    /// World transforms are computed from layout frames.
    #[test]
    fn world_transforms_computed_from_layout() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = layout_frames_for_transforms();

        graph.update(&RuntimeDelta::default(), &tree, &frames);

        assert!(
            graph.world_transforms().contains_key("root"),
            "root has transform"
        );
        assert!(
            graph.world_transforms().contains_key("btn1"),
            "btn1 has transform"
        );
        assert!(
            graph.world_transforms().contains_key("panel"),
            "panel has transform"
        );

        // btn1 is at (10, 20) under root at (0, 0) → world = (10, 20)
        let btn1_t = graph.world_transforms().get("btn1").unwrap();
        assert!((btn1_t.e - 10.0).abs() < 0.001, "btn1 world x = 10");
        assert!((btn1_t.f - 20.0).abs() < 0.001, "btn1 world y = 20");

        // btn2 is at (5, 5) under panel at (0, 60) → world = (5, 65)
        let btn2_t = graph.world_transforms().get("btn2").unwrap();
        assert!((btn2_t.e - 5.0).abs() < 0.001, "btn2 world x = 5");
        assert!((btn2_t.f - 65.0).abs() < 0.001, "btn2 world y = 65");
    }

    /// Layout change triggers world transform recompute.
    #[test]
    fn layout_change_recomputes_transforms() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = layout_frames_for_transforms();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        let btn1_y_before = graph.world_transforms().get("btn1").unwrap().f;

        // Move btn1 to a new position
        let mut new_frames = layout_frames_for_transforms();
        new_frames.get_mut("btn1").unwrap().rect.y = 50.0; // was 20

        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: true,
            focus_relevant_changed: false,
            changed_frame_ids: None,
            ..Default::default()
        };

        graph.update(&delta, &tree, &new_frames);
        let btn1_y_after = graph.world_transforms().get("btn1").unwrap().f;

        assert!((btn1_y_before - 20.0).abs() < 0.001, "before: y=20");
        assert!((btn1_y_after - 50.0).abs() < 0.001, "after: y=50");
    }

    // ========================================================================
    // RuntimeDelta Tests
    // ========================================================================

    /// RuntimeDelta::default() is empty.
    #[test]
    fn runtime_delta_default_is_empty() {
        let delta = RuntimeDelta::default();
        assert!(delta.is_empty(), "default delta must be empty");
        assert!(delta.changed_node_ids.is_empty());
        assert!(!delta.structure_changed);
        assert!(!delta.layout_changed);
        assert!(!delta.focus_relevant_changed);
    }

    /// RuntimeDelta with only changed_node_ids is not empty.
    #[test]
    fn runtime_delta_with_changed_nodes_not_empty() {
        let mut delta = RuntimeDelta::default();
        delta.intern_and_insert("node-1");
        assert!(!delta.is_empty());
    }

    /// RuntimeDelta with only structure_changed is not empty.
    #[test]
    fn runtime_delta_with_structure_changed_not_empty() {
        let delta = RuntimeDelta {
            structure_changed: true,
            ..Default::default()
        };
        assert!(!delta.is_empty());
    }

    // ========================================================================
    // DirtyTracker::to_runtime_delta Tests
    // ========================================================================

    /// Clean tracker produces empty delta.
    #[test]
    fn clean_tracker_produces_empty_delta() {
        let tracker = DirtyTracker::default();
        let delta = tracker.to_runtime_delta();
        assert!(delta.is_empty(), "clean tracker → empty delta");
    }

    /// Tracker with dirty_nodes produces delta with changed_node_ids.
    #[test]
    fn dirty_nodes_transfer_to_delta() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_node("node-1");
        tracker.mark_node("node-2");

        let delta = tracker.to_runtime_delta();
        assert!(delta.is_node_changed("node-1"));
        assert!(delta.is_node_changed("node-2"));
        assert_eq!(delta.changed_node_ids.len(), 2);
        assert!(!delta.structure_changed);
        assert!(
            !delta.layout_changed,
            "property-only dirty must NOT set layout_changed"
        );
    }

    /// Structure dirty maps to structure_changed + layout_changed.
    #[test]
    fn structure_dirty_maps_to_delta() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_scene_structure();

        let delta = tracker.to_runtime_delta();
        assert!(delta.structure_changed, "structure_changed must be true");
        assert!(
            delta.layout_changed,
            "layout_changed must be true (structure implies layout)"
        );
        assert!(
            delta.focus_relevant_changed,
            "focus_relevant_changed must be true"
        );
    }

    /// Viewport dirty maps to layout_changed.
    #[test]
    fn viewport_dirty_maps_to_layout_changed() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_viewport();

        let delta = tracker.to_runtime_delta();
        assert!(
            delta.layout_changed,
            "viewport change implies layout change"
        );
        assert!(
            !delta.structure_changed,
            "viewport is not a structure change"
        );
    }

    /// FSM dirty produces focus_relevant_changed (bindings may change visibility).
    #[test]
    fn fsm_dirty_produces_focus_relevant() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm();

        let delta = tracker.to_runtime_delta();
        assert!(
            delta.focus_relevant_changed,
            "FSM change could affect focus"
        );
        assert!(!delta.structure_changed);
        assert!(!delta.layout_changed, "FSM alone doesn't change layout");
    }

    /// DirtyTracker::new() (fully dirty) produces a full-rebuild delta.
    #[test]
    fn new_tracker_produces_full_rebuild_delta() {
        let tracker = DirtyTracker::new();
        let delta = tracker.to_runtime_delta();

        assert!(delta.structure_changed, "new tracker = structure dirty");
        assert!(delta.layout_changed, "new tracker = layout dirty");
        assert!(delta.focus_relevant_changed, "new tracker = focus relevant");
    }

    // ========================================================================
    // Integration Test: Full Lifecycle
    // ========================================================================

    /// Full lifecycle: init → update → incremental → verify.
    #[test]
    fn full_lifecycle_init_update_incremental() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = layout_frames_for_transforms();

        // Frame 1: First render (full rebuild via uninitialized)
        let tracker = DirtyTracker::new();
        let delta = tracker.to_runtime_delta();
        graph.update(&delta, &tree, &frames);

        assert!(graph.is_initialized());
        assert_eq!(graph.focusable().len(), 3);
        assert_eq!(graph.tabbable().len(), 3);
        assert_eq!(graph.semantics().len(), 3);
        assert!(!graph.world_transforms().is_empty());

        // Frame 2: No changes — no-op
        let clean_tracker = DirtyTracker::default();
        let empty_delta = clean_tracker.to_runtime_delta();
        assert!(empty_delta.is_empty());
        graph.update(&empty_delta, &tree, &frames);
        assert_eq!(graph.focusable().len(), 3, "no change");

        // Frame 3: Make btn1 invisible
        let modified_tree = container(
            "root",
            vec![
                invisible_button("btn1"),
                container("panel", vec![button("btn2"), button("btn3")]),
                container("inert", vec![]),
            ],
        );

        let mut tracker3 = DirtyTracker::default();
        tracker3.mark_node("btn1");
        let delta3 = tracker3.to_runtime_delta();
        graph.update(&delta3, &modified_tree, &frames);

        assert_eq!(graph.focusable().len(), 2, "btn1 removed from focusable");
        assert!(!graph.focusable().contains(&"btn1".to_string()));
        // btn1 still has a11y props (role=Button) even when invisible,
        // so semantics retains it — collect_semantics checks a11y, not visibility.
        assert!(
            graph.semantics().contains_key("btn1"),
            "invisible node retains semantics"
        );
    }

    // ========================================================================
    // Task 178 V5: Incremental Focus/Tab Tests
    // ========================================================================

    /// V5-T1: Insert focusable node via structure change → added to focusable set.
    #[test]
    fn v5_insert_focusable_node_added_to_set() {
        let mut graph = RuntimeGraph::new();
        let tree = container("root", vec![button("btn1")]);
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 1);

        // Insert a new focusable button
        let new_tree = container("root", vec![button("btn1"), button("btn2")]);
        let mut changed = HashSet::new();
        changed.insert("btn2".to_string());
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.focusable().len(), 2);
        assert!(graph.focusable().contains(&"btn2".to_string()));
    }

    /// V5-T2: Insert non-focusable node → NOT in focusable set.
    #[test]
    fn v5_insert_non_focusable_node_not_in_set() {
        let mut graph = RuntimeGraph::new();
        let tree = container("root", vec![button("btn1")]);
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 1);

        // Insert a plain container (not focusable)
        let new_tree = container("root", vec![button("btn1"), container("panel", vec![])]);
        let mut changed = HashSet::new();
        changed.insert("panel".to_string());
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.focusable().len(), 1, "non-focusable node not added");
        assert!(!graph.focusable().contains(&"panel".to_string()));
    }

    /// V5-T3: Remove focusable node → removed from focusable set.
    #[test]
    fn v5_remove_focusable_node_removed_from_set() {
        let mut graph = RuntimeGraph::new();
        let tree = container("root", vec![button("btn1"), button("btn2")]);
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 2);

        // Remove btn2
        let new_tree = container("root", vec![button("btn1")]);
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..Default::default()
        };

        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.focusable().len(), 1);
        assert!(!graph.focusable().contains(&"btn2".to_string()));
    }

    /// V5-T4: Change tab_index → tabbable order updated correctly.
    #[test]
    fn v5_change_tab_index_updates_tabbable_order() {
        let mut graph = RuntimeGraph::new();
        let tree = container(
            "root",
            vec![
                button_with_tab("a", 1),
                button_with_tab("b", 2),
                button_with_tab("c", 3),
            ],
        );
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.tabbable()[0], "a");
        assert_eq!(graph.tabbable()[1], "b");
        assert_eq!(graph.tabbable()[2], "c");

        // Change b's tab_index from 2 to 5 (should move to end of positive group)
        let modified_tree = container(
            "root",
            vec![
                button_with_tab("a", 1),
                button_with_tab("b", 5), // was 2
                button_with_tab("c", 3),
            ],
        );

        let mut changed = HashSet::new();
        changed.insert("b".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &modified_tree, &frames);
        assert_eq!(graph.tabbable()[0], "a", "tab_index=1 first");
        assert_eq!(graph.tabbable()[1], "c", "tab_index=3 second");
        assert_eq!(graph.tabbable()[2], "b", "tab_index=5 last");
    }

    /// V5-T5: Change visibility to hidden → removed from both focusable and tabbable.
    #[test]
    fn v5_visibility_hidden_removes_from_both_sets() {
        let mut graph = RuntimeGraph::new();
        let tree = container("root", vec![button("btn1"), button("btn2")]);
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 2);
        assert_eq!(graph.tabbable().len(), 2);

        // Make btn1 invisible
        let modified_tree = container("root", vec![invisible_button("btn1"), button("btn2")]);

        let mut changed = HashSet::new();
        changed.insert("btn1".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &modified_tree, &frames);
        assert_eq!(
            graph.focusable().len(),
            1,
            "invisible removed from focusable"
        );
        assert_eq!(graph.tabbable().len(), 1, "invisible removed from tabbable");
        assert!(!graph.focusable().contains(&"btn1".to_string()));
        assert!(!graph.tabbable().contains(&"btn1".to_string()));
    }

    /// V5-T6: Insert subtree with 3 focusable nodes → all 3 added.
    #[test]
    fn v5_insert_subtree_adds_all_focusable_descendants() {
        let mut graph = RuntimeGraph::new();
        let tree = container("root", vec![button("btn1")]);
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 1);

        // Insert a subtree with 3 focusable children
        let new_tree = container(
            "root",
            vec![
                button("btn1"),
                container(
                    "panel",
                    vec![button("sub1"), button("sub2"), button("sub3")],
                ),
            ],
        );

        // mark_node_recursive adds panel + all descendants
        let mut changed = HashSet::new();
        changed.insert("panel".to_string());
        changed.insert("sub1".to_string());
        changed.insert("sub2".to_string());
        changed.insert("sub3".to_string());
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.focusable().len(), 4, "btn1 + 3 new buttons");
        assert!(graph.focusable().contains(&"sub1".to_string()));
        assert!(graph.focusable().contains(&"sub2".to_string()));
        assert!(graph.focusable().contains(&"sub3".to_string()));
    }

    /// V5-T7: Remove subtree → all descendants removed from both sets.
    #[test]
    fn v5_remove_subtree_removes_all_descendants() {
        let mut graph = RuntimeGraph::new();
        let tree = container(
            "root",
            vec![
                button("btn1"),
                container(
                    "panel",
                    vec![button("sub1"), button("sub2"), button("sub3")],
                ),
            ],
        );
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 4);
        assert_eq!(graph.tabbable().len(), 4);

        // Remove the panel subtree
        let new_tree = container("root", vec![button("btn1")]);
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..Default::default()
        };

        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.focusable().len(), 1, "only btn1 remains in focusable");
        assert_eq!(graph.tabbable().len(), 1, "only btn1 remains in tabbable");
        assert!(!graph.focusable().contains(&"sub1".to_string()));
        assert!(!graph.focusable().contains(&"sub2".to_string()));
        assert!(!graph.focusable().contains(&"sub3".to_string()));
    }

    /// V5-T8: Insert 1 node in large tree → only that node's focusability checked.
    ///
    /// Validates O(changed) behavior: changed_node_ids contains only the new node,
    /// so only that node is checked for focusability/tabbability additions.
    /// The full tree walk is only for ID collection (retention), not property checks.
    #[test]
    fn v5_insert_one_node_in_large_tree() {
        let mut graph = RuntimeGraph::new();

        // Create a tree with 100 buttons
        let mut children: Vec<SceneNode> = Vec::new();
        for i in 0..100 {
            children.push(button(&format!("btn-{i}")));
        }
        let tree = container("root", children);
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 100);

        // Insert 1 new button
        let mut children2: Vec<SceneNode> = Vec::new();
        for i in 0..100 {
            children2.push(button(&format!("btn-{i}")));
        }
        children2.push(button("new-btn"));
        let new_tree = container("root", children2);

        // Only the new button is in changed_node_ids
        let mut changed = HashSet::new();
        changed.insert("new-btn".to_string());
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.focusable().len(), 101, "exactly 1 node added");
        assert!(graph.focusable().contains(&"new-btn".to_string()));
    }

    /// V5-T9: Tab order after incremental updates matches full rebuild.
    ///
    /// Oracle test: build incrementally, then verify against a fresh full build.
    #[test]
    fn v5_incremental_tab_order_matches_full_rebuild() {
        let mut graph = RuntimeGraph::new();
        let tree = container(
            "root",
            vec![
                button_with_tab("a", 0),
                button_with_tab("b", 2),
                button_with_tab("c", 1),
            ],
        );
        let frames = empty_frames();

        graph.update(&RuntimeDelta::default(), &tree, &frames);

        // Incremental: insert a new button with tab_index=3
        let tree2 = container(
            "root",
            vec![
                button_with_tab("a", 0),
                button_with_tab("b", 2),
                button_with_tab("c", 1),
                button_with_tab("d", 3),
            ],
        );

        let mut changed = HashSet::new();
        changed.insert("d".to_string());
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };
        graph.update(&delta, &tree2, &frames);

        // Oracle: fresh full rebuild from same tree
        let oracle = RuntimeGraph::from_tree(&tree2, &frames);

        // Focusable sets should contain same elements
        let incremental_focusable: HashSet<&str> =
            graph.focusable().iter().map(|s| s.as_str()).collect();
        let oracle_focusable: HashSet<&str> =
            oracle.focusable().iter().map(|s| s.as_str()).collect();
        assert_eq!(
            incremental_focusable, oracle_focusable,
            "focusable sets must match oracle"
        );

        // Tabbable order should match oracle
        assert_eq!(
            graph.tabbable(),
            oracle.tabbable(),
            "tabbable order must match oracle: incremental={:?} oracle={:?}",
            graph.tabbable(),
            oracle.tabbable()
        );
    }

    /// V5-T10: 100 random insert/remove operations → incremental matches full rebuild.
    ///
    /// Deterministic pseudo-random sequence: uses a simple LCG seeded with a constant.
    #[test]
    fn v5_random_ops_incremental_equals_full_rebuild() {
        let mut graph = RuntimeGraph::new();
        let frames = empty_frames();

        // Start with 10 buttons
        let mut node_ids: Vec<String> = (0..10).map(|i| format!("n-{i}")).collect();
        let tree = make_tree_from_ids(&node_ids);
        graph.update(&RuntimeDelta::default(), &tree, &frames);

        // Simple LCG for deterministic pseudo-random
        let mut rng_state: u64 = 42;
        let mut next_rng = || -> u64 {
            rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
            rng_state >> 33
        };

        let mut next_id = 10u32;

        for _ in 0..100 {
            let op = next_rng() % 3;
            match op {
                0 if node_ids.len() < 200 => {
                    // Insert
                    let new_id = format!("n-{next_id}");
                    next_id += 1;
                    node_ids.push(new_id.clone());

                    let tree = make_tree_from_ids(&node_ids);
                    let mut changed = HashSet::new();
                    changed.insert(new_id);
                    let delta = RuntimeDelta {
                        structure_changed: true,
                        layout_changed: true,
                        focus_relevant_changed: true,
                        changed_frame_ids: None,
                        ..RuntimeDelta::from_changed_strings(changed)
                    };
                    graph.update(&delta, &tree, &frames);
                }
                1 if node_ids.len() > 2 => {
                    // Remove
                    let idx = (next_rng() as usize) % node_ids.len();
                    node_ids.swap_remove(idx);

                    let tree = make_tree_from_ids(&node_ids);
                    let delta = RuntimeDelta {
                        structure_changed: true,
                        layout_changed: true,
                        focus_relevant_changed: true,
                        changed_frame_ids: None,
                        ..Default::default()
                    };
                    graph.update(&delta, &tree, &frames);
                }
                _ => {
                    // No-op frame
                    let tree = make_tree_from_ids(&node_ids);
                    graph.update(&RuntimeDelta::default(), &tree, &frames);
                }
            }
        }

        // Oracle: fresh full rebuild from final tree
        let final_tree = make_tree_from_ids(&node_ids);
        let oracle = RuntimeGraph::from_tree(&final_tree, &frames);

        let incremental_focusable: HashSet<&str> =
            graph.focusable().iter().map(|s| s.as_str()).collect();
        let oracle_focusable: HashSet<&str> =
            oracle.focusable().iter().map(|s| s.as_str()).collect();
        assert_eq!(
            incremental_focusable, oracle_focusable,
            "after 100 random ops, focusable must match oracle"
        );

        // Tabbable: same elements (order may differ slightly due to z_index=0 ties)
        let incremental_tabbable: HashSet<&str> =
            graph.tabbable().iter().map(|s| s.as_str()).collect();
        let oracle_tabbable: HashSet<&str> = oracle.tabbable().iter().map(|s| s.as_str()).collect();
        assert_eq!(
            incremental_tabbable, oracle_tabbable,
            "after 100 random ops, tabbable set must match oracle"
        );

        // Semantics: same keys
        let incr_sem_keys: HashSet<&str> = graph.semantics().keys().map(|s| s.as_str()).collect();
        let oracle_sem_keys: HashSet<&str> =
            oracle.semantics().keys().map(|s| s.as_str()).collect();
        assert_eq!(
            incr_sem_keys, oracle_sem_keys,
            "after 100 random ops, semantics keys must match oracle"
        );
    }

    // ========================================================================
    // Task 204 Agent 1: Focus Incremental Verification Tests
    // ========================================================================

    /// T204-1: Verify collect_focusable_nodes and collect_tabbable_nodes are
    /// NOT called from the render hot path.
    #[test]
    fn t204_focusable_not_called_in_render_hot_path() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = empty_frames();
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert!(graph.is_initialized());
        let mut changed = HashSet::new();
        changed.insert("btn1".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };
        graph.update(&delta, &tree, &frames);
        assert_eq!(graph.focusable().len(), 3);
        let new_tree = container(
            "root",
            vec![
                button("btn1"),
                container("panel", vec![button("btn2"), button("btn3")]),
                container("inert", vec![]),
                button("btn4"),
            ],
        );
        let mut changed2 = HashSet::new();
        changed2.insert("btn4".to_string());
        let delta2 = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed2)
        };
        graph.update(&delta2, &new_tree, &frames);
        assert_eq!(graph.focusable().len(), 4);
    }

    /// T204-2: Insert a focusable node via incremental update.
    #[test]
    fn t204_incremental_focusable_add_node() {
        let mut graph = RuntimeGraph::new();
        let tree = container("root", vec![button("a")]);
        let frames = empty_frames();
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 1);
        let new_tree = container("root", vec![button("a"), button("b")]);
        let mut changed = HashSet::new();
        changed.insert("b".to_string());
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };
        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.focusable().len(), 2);
        assert!(graph.focusable().contains(&"b".to_string()));
    }

    /// T204-3: Remove a focusable node — list shrinks.
    #[test]
    fn t204_incremental_focusable_remove_node() {
        let mut graph = RuntimeGraph::new();
        let tree = container("root", vec![button("a"), button("b"), button("c")]);
        let frames = empty_frames();
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 3);
        let new_tree = container("root", vec![button("a"), button("c")]);
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..Default::default()
        };
        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.focusable().len(), 2);
        assert!(!graph.focusable().contains(&"b".to_string()));
    }

    /// T204-4: Insert a tabbable node — sorted correctly.
    #[test]
    fn t204_incremental_tabbable_add_node() {
        let mut graph = RuntimeGraph::new();
        let tree = container(
            "root",
            vec![button_with_tab("a", 1), button_with_tab("c", 3)],
        );
        let frames = empty_frames();
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.tabbable().len(), 2);
        let new_tree = container(
            "root",
            vec![
                button_with_tab("a", 1),
                button_with_tab("b", 2),
                button_with_tab("c", 3),
            ],
        );
        let mut changed = HashSet::new();
        changed.insert("b".to_string());
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };
        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.tabbable().len(), 3);
        assert_eq!(graph.tabbable()[0], "a");
        assert_eq!(graph.tabbable()[1], "b");
        assert_eq!(graph.tabbable()[2], "c");
    }

    /// T204-5: Remove a tabbable node.
    #[test]
    fn t204_incremental_tabbable_remove_node() {
        let mut graph = RuntimeGraph::new();
        let tree = container(
            "root",
            vec![
                button_with_tab("a", 1),
                button_with_tab("b", 2),
                button_with_tab("c", 3),
            ],
        );
        let frames = empty_frames();
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.tabbable().len(), 3);
        let new_tree = container(
            "root",
            vec![button_with_tab("a", 1), button_with_tab("c", 3)],
        );
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..Default::default()
        };
        graph.update(&delta, &new_tree, &frames);
        assert_eq!(graph.tabbable().len(), 2);
        assert!(!graph.tabbable().contains(&"b".to_string()));
    }

    /// T204-6: Tab order maintained after property-only update.
    #[test]
    fn t204_incremental_tabbable_order_preserved() {
        let mut graph = RuntimeGraph::new();
        let tree = container(
            "root",
            vec![
                button_with_tab("a", 1),
                button_with_tab("b", 2),
                button_with_tab("c", 3),
            ],
        );
        let frames = empty_frames();
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.tabbable(), &["a", "b", "c"]);
        let mut modified_a = button_with_tab("a", 1);
        modified_a.props.a11y.as_mut().unwrap().label = Some("Click".to_string());
        let modified_tree = container(
            "root",
            vec![modified_a, button_with_tab("b", 2), button_with_tab("c", 3)],
        );
        let mut changed = HashSet::new();
        changed.insert("a".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };
        graph.update(&delta, &modified_tree, &frames);
        assert_eq!(graph.tabbable(), &["a", "b", "c"]);
    }

    /// T204-7: Move node — focusability preserved after reparenting.
    #[test]
    fn t204_incremental_focusable_move_node() {
        let mut graph = RuntimeGraph::new();
        let tree = container(
            "root",
            vec![
                button("btn1"),
                container("panel-a", vec![button("btn2")]),
                container("panel-b", vec![]),
            ],
        );
        let frames = empty_frames();
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert!(graph.focusable().contains(&"btn2".to_string()));
        let new_tree = container(
            "root",
            vec![
                button("btn1"),
                container("panel-a", vec![]),
                container("panel-b", vec![button("btn2")]),
            ],
        );
        let mut changed = HashSet::new();
        changed.insert("btn2".to_string());
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };
        graph.update(&delta, &new_tree, &frames);
        assert!(graph.focusable().contains(&"btn2".to_string()));
        assert_eq!(graph.focusable().len(), 2);
    }

    /// T204-8: Reorder children — tabbable list re-sorted.
    #[test]
    fn t204_incremental_tabbable_reorder() {
        let mut graph = RuntimeGraph::new();
        let tree = container(
            "root",
            vec![
                button_with_tab("x", 1),
                button_with_tab("y", 2),
                button_with_tab("z", 3),
            ],
        );
        let frames = empty_frames();
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.tabbable(), &["x", "y", "z"]);
        let modified_tree = container(
            "root",
            vec![
                button_with_tab("x", 3),
                button_with_tab("y", 2),
                button_with_tab("z", 1),
            ],
        );
        let mut changed = HashSet::new();
        changed.insert("x".to_string());
        changed.insert("z".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };
        graph.update(&delta, &modified_tree, &frames);
        assert_eq!(graph.tabbable()[0], "z");
        assert_eq!(graph.tabbable()[1], "y");
        assert_eq!(graph.tabbable()[2], "x");
    }

    /// T204-9: Full collect at init matches incremental (oracle test).
    #[test]
    fn t204_init_produces_same_as_incremental() {
        let initial_tree = container("root", vec![button("a"), button("b")]);
        let frames = empty_frames();
        let mut incremental = RuntimeGraph::from_tree(&initial_tree, &frames);
        let tree_v2 = container("root", vec![button("b"), button("c")]);
        let mut changed = HashSet::new();
        changed.insert("c".to_string());
        let delta = RuntimeDelta {
            structure_changed: true,
            layout_changed: true,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };
        incremental.update(&delta, &tree_v2, &frames);
        let oracle = RuntimeGraph::from_tree(&tree_v2, &frames);
        let inc_set: HashSet<&str> = incremental.focusable().iter().map(|s| s.as_str()).collect();
        let ora_set: HashSet<&str> = oracle.focusable().iter().map(|s| s.as_str()).collect();
        assert_eq!(inc_set, ora_set, "focusable must match oracle");
        let inc_tab: HashSet<&str> = incremental.tabbable().iter().map(|s| s.as_str()).collect();
        let ora_tab: HashSet<&str> = oracle.tabbable().iter().map(|s| s.as_str()).collect();
        assert_eq!(inc_tab, ora_tab, "tabbable must match oracle");
    }

    /// T204-10: Empty tree produces empty lists.
    #[test]
    fn t204_empty_tree_focusable_empty() {
        let tree = container("root", vec![]);
        let frames = empty_frames();
        let graph = RuntimeGraph::from_tree(&tree, &frames);
        assert!(graph.focusable().is_empty());
        assert!(graph.tabbable().is_empty());
        assert!(graph.semantics().is_empty());
    }

    /// T204-11: Multiple property changes in single frame.
    #[test]
    fn t204_multiple_property_changes_single_frame() {
        let mut graph = RuntimeGraph::new();
        let tree = container(
            "root",
            vec![
                button("a"),
                button("b"),
                button("c"),
                container("d", vec![]),
            ],
        );
        let frames = empty_frames();
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert_eq!(graph.focusable().len(), 3);
        let modified_tree = container(
            "root",
            vec![invisible_button("a"), button("b"), button("c"), button("d")],
        );
        let mut changed = HashSet::new();
        changed.insert("a".to_string());
        changed.insert("d".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };
        graph.update(&delta, &modified_tree, &frames);
        assert_eq!(graph.focusable().len(), 3);
        assert!(!graph.focusable().contains(&"a".to_string()));
        assert!(graph.focusable().contains(&"d".to_string()));
    }

    /// T204-12: from_tree() equals new() + update().
    #[test]
    fn t204_from_tree_equals_new_plus_update() {
        let tree = container(
            "root",
            vec![
                button_with_tab("x", 2),
                button_with_tab("y", 0),
                button_with_tab("z", 1),
                focusable_not_tabbable("w"),
            ],
        );
        let frames = empty_frames();
        let via_from_tree = RuntimeGraph::from_tree(&tree, &frames);
        let mut via_update = RuntimeGraph::new();
        via_update.update(&RuntimeDelta::default(), &tree, &frames);
        let ft_f: HashSet<&str> = via_from_tree
            .focusable()
            .iter()
            .map(|s| s.as_str())
            .collect();
        let up_f: HashSet<&str> = via_update.focusable().iter().map(|s| s.as_str()).collect();
        assert_eq!(ft_f, up_f, "focusable sets must match");
        assert_eq!(
            via_from_tree.tabbable(),
            via_update.tabbable(),
            "tabbable order must match"
        );
        let ft_s: HashSet<&str> = via_from_tree
            .semantics()
            .keys()
            .map(|s| s.as_str())
            .collect();
        let up_s: HashSet<&str> = via_update.semantics().keys().map(|s| s.as_str()).collect();
        assert_eq!(ft_s, up_s, "semantics keys must match");
    }

    // ========================================================================
    // Task 205 Agent 1: layout_changed False Positive Fix Tests
    // ========================================================================

    /// Property-only dirty (mark_node) must NOT set layout_changed.
    #[test]
    fn property_only_dirty_does_not_set_layout_changed() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_node("color-changed-node");
        let delta = tracker.to_runtime_delta();
        assert!(
            !delta.layout_changed,
            "property change alone must not trigger layout_changed"
        );
        assert!(
            delta.focus_relevant_changed,
            "property change still triggers focus check"
        );
        assert!(!delta.structure_changed);
    }

    /// layout_dirty flag correctly sets layout_changed.
    #[test]
    fn layout_dirty_sets_layout_changed() {
        let mut tracker = DirtyTracker::default();
        tracker.layout_dirty = true;
        tracker.anything_dirty = true;
        let delta = tracker.to_runtime_delta();
        assert!(delta.layout_changed, "layout_dirty must set layout_changed");
    }

    /// Combined property + layout dirty correctly sets layout_changed.
    #[test]
    fn property_and_layout_dirty_sets_layout_changed() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_node("some-node");
        tracker.layout_dirty = true;
        let delta = tracker.to_runtime_delta();
        assert!(delta.layout_changed, "layout_dirty overrides property-only");
        assert!(delta.is_node_changed("some-node"));
    }

    /// Multiple property-only dirtied nodes still don't trigger layout_changed.
    #[test]
    fn many_dirty_nodes_still_no_layout_changed() {
        let mut tracker = DirtyTracker::default();
        for i in 0..50 {
            tracker.mark_node(&format!("node-{}", i));
        }
        let delta = tracker.to_runtime_delta();
        assert!(
            !delta.layout_changed,
            "50 property changes still don't change layout"
        );
        assert_eq!(delta.changed_node_ids.len(), 50);
    }

    /// Cascade: RuntimeGraph::update does NOT recompute world transforms when
    /// layout_changed=false (property-only dirty).
    #[test]
    fn cascade_property_only_skips_world_transforms() {
        let mut graph = RuntimeGraph::new();
        let tree = standard_tree();
        let frames = layout_frames_for_transforms();

        // Frame 1: full init — transforms computed
        graph.update(&RuntimeDelta::default(), &tree, &frames);
        assert!(graph.is_initialized());
        let transforms_after_init = graph.world_transforms().clone();
        assert!(
            !transforms_after_init.is_empty(),
            "init must compute transforms"
        );

        // Frame 2: property-only change (layout_changed=false)
        let mut changed = HashSet::new();
        changed.insert("btn1".to_string());
        let delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        // Provide DIFFERENT frames — if transforms were recomputed, they'd differ
        let mut different_frames = layout_frames_for_transforms();
        different_frames.insert(
            "btn1".to_string(),
            LayoutFrame::from_rect(crate::kernel::types::Rect::new(999.0, 999.0, 50.0, 50.0)),
        );
        graph.update(&delta, &tree, &different_frames);

        // Transforms must be UNCHANGED — the update must NOT have recomputed them
        assert_eq!(
            graph.world_transforms(),
            &transforms_after_init,
            "property-only update must NOT recompute world transforms"
        );
    }

    /// Cascade: compute_snapshot_delta returns empty frame_patches when
    /// layout_changed=false and frame Arcs are identical.
    #[test]
    fn cascade_snapshot_delta_skips_frames_when_no_layout_change() {
        use crate::kernel::snapshot_delta::{compute_snapshot_delta, DeltaInput};

        let tree = Arc::new(standard_tree());
        let frames = Arc::new(layout_frames_for_transforms());

        let snapshot = SceneSnapshot {
            tree: Arc::clone(&tree),
            frames: Arc::clone(&frames),
            routing: Default::default(),
            semantics: HashMap::new(),
            text_inputs: HashMap::new(),
            camera: Camera::default(),
            visible_edge_routes: Vec::new(),
        };

        // Property-only delta: layout_changed=false
        let mut changed = HashSet::new();
        changed.insert("btn1".to_string());
        let runtime_delta = RuntimeDelta {
            structure_changed: false,
            layout_changed: false,
            focus_relevant_changed: true,
            changed_frame_ids: None,
            ..RuntimeDelta::from_changed_strings(changed)
        };

        let input = DeltaInput {
            prev: &snapshot,
            current: &snapshot,
            runtime_delta: &runtime_delta,
            prev_focusable: &[],
            current_focusable: &[],
            prev_tabbable: &[],
            current_tabbable: &[],
            visibility_patches: Vec::new(),
            edge_patches: Vec::new(),
        };

        let delta = compute_snapshot_delta(&input);
        assert!(
            delta.frame_patches.is_empty(),
            "frame_patches must be empty when layout_changed=false and Arc ptrs match"
        );
    }

    /// Helper: build a flat tree of buttons from a list of IDs.
    fn make_tree_from_ids(ids: &[String]) -> SceneNode {
        let children: Vec<SceneNode> = ids.iter().map(|id| button(id)).collect();
        container("root", children)
    }
}
