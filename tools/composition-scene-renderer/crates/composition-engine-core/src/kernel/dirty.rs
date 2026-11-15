// crates/composition-engine-core/src/kernel/dirty.rs
//
// # Purpose
//
// Dirty flag tracking for incremental rendering in the Composition Engine kernel.
// Tracks which parts of KernelState have changed since the last render() call.
// The render() function checks these flags to skip unchanged phases — achieving
// O(change) cost instead of O(entire_dataset) cost per frame.
//
// # Non-Negotiable Invariants
//
// 1. **O(1) flag setting** — Setting a dirty flag is a single field write or
//    HashSet insert. Never walk the tree to set flags.
// 2. **O(1) flag checking** — Checking dirty flags is a single boolean read
//    or HashSet::contains lookup. Never traverse state to check dirtiness.
// 3. **Cleared after render** — After render() completes, all flags are cleared
//    via clear(). Stale flags never accumulate across frames.
// 4. **Conservative marking** — If in doubt, mark dirty. It is always safe to
//    re-evaluate; it is never safe to skip necessary work. False positives
//    cost performance. False negatives cause correctness bugs.
// 5. **First render is fully dirty** — DirtyTracker::new() starts with all flags
//    set so the first render() unconditionally runs every phase.
//
// # Key Concepts
//
// - **anything_dirty**: Master flag. If false, the entire render is a no-op.
// - **Phase flags** (fsm_dirty, routing_dirty, ambient_dirty, viewport_dirty,
//   scene_structure_changed_ids, layout_dirty): Enable per-phase skip decisions.
// - **dirty_nodes**: Per-node tracking for targeted binding re-evaluation and
//   layout recomputation. Only nodes in this set need their bindings re-evaluated.
//
// # Security Considerations
//
// - DirtyTracker contains no user data — only boolean flags and node ID strings.
// - Node IDs in dirty_nodes are opaque strings; the tracker never interprets them.
// - No code execution, no parsing, no external I/O.
//
// # Platform Portability
//
// Pure Rust, no platform dependencies. Uses only std::collections::HashSet.
// Compiles to WASM, native, and any future target.
//
// # AI Directive
//
// The extensive documentation in this codebase is a critical design feature.
// You are FORBIDDEN from simplifying or removing it. Your mandate is to
// MAINTAIN and EXTEND this level of meticulous detail.

use graph::DirectedGraph;
use std::collections::{HashMap, HashSet};

// ============================================================================
// Node ID Interner (Finding 25 — Task 1139)
// ============================================================================

/// Simple string-to-u64 interner for node IDs.
///
/// Maps string node IDs to compact u64 identifiers for O(1) hash operations.
/// Used by RuntimeDelta to enable `HashSet<u64>` instead of `HashSet<String>`.
///
/// # Performance
///
/// `intern()` is O(1) amortized (HashMap insert). `get_id()` is O(1)
/// (HashMap lookup). u64 hashing is trivially cheap (~1ns) vs String
/// hashing (~10-20ns for typical node IDs).
///
/// # Platform Portability
///
/// Pure Rust, no platform dependencies. Compiles to WASM, native, any target.
#[derive(Debug, Clone, Default)]
pub struct NodeIdInterner {
    to_id: HashMap<String, u64>,
    from_id: Vec<String>,
}

impl NodeIdInterner {
    /// Create an empty interner.
    pub fn new() -> Self {
        Self::default()
    }

    /// Intern a string, returning its stable u64 ID.
    ///
    /// First call for a given string allocates. Subsequent calls return the
    /// cached ID with zero allocation.
    pub fn intern(&mut self, s: &str) -> u64 {
        if let Some(&id) = self.to_id.get(s) {
            return id;
        }
        let id = self.from_id.len() as u64;
        self.from_id.push(s.to_string());
        self.to_id.insert(s.to_string(), id);
        id
    }

    /// Look up the u64 ID for a string without interning.
    ///
    /// Returns `None` if the string was never interned.
    pub fn get_id(&self, s: &str) -> Option<u64> {
        self.to_id.get(s).copied()
    }

    /// Reverse lookup: u64 ID → original string.
    pub fn get_str(&self, id: u64) -> Option<&str> {
        self.from_id.get(id as usize).map(|s| s.as_str())
    }
}

impl PartialEq for NodeIdInterner {
    fn eq(&self, other: &Self) -> bool {
        self.to_id == other.to_id
    }
}

// ============================================================================
// Graph Interner (Finding 24 — Task 1139)
// ============================================================================

/// What kind of graph node an interned u64 represents.
#[derive(Debug, Clone)]
enum GraphNodeKind {
    /// A dependency key (e.g., DepKey::Fsm("fsm:editor:main"))
    Dep(DepKey),
    /// A scene node ID (e.g., "layout:editor:hud")
    Node(String),
}

/// Graph-internal interner for BindingDepIndex.
///
/// Interns both DepKeys and node ID strings to unique u64 values for
/// `DirectedGraph<u64>`. A single monotonic counter ensures no collisions
/// between dep key IDs and node IDs.
///
/// # Finding 24 (PPF Plan §11 Category F)
///
/// DepKey already implements Hash + Eq. We intern DepKey DIRECTLY as a
/// structured key — zero `format!()` allocation. Before this change,
/// `to_graph_key()` called `format!("dep:fsm:{k}")` on EVERY `record()`
/// and `resolve_dirty_nodes()` call, allocating a heap String each time.
#[derive(Debug, Clone, Default)]
struct GraphInterner {
    dep_to_id: HashMap<DepKey, u64>,
    node_to_id: HashMap<String, u64>,
    from_id: Vec<GraphNodeKind>,
}

impl GraphInterner {
    fn new() -> Self {
        Self::default()
    }

    /// Intern a DepKey, returning its stable u64 ID.
    fn intern_dep(&mut self, dep: &DepKey) -> u64 {
        if let Some(&id) = self.dep_to_id.get(dep) {
            return id;
        }
        let id = self.from_id.len() as u64;
        self.from_id.push(GraphNodeKind::Dep(dep.clone()));
        self.dep_to_id.insert(dep.clone(), id);
        id
    }

    /// Intern a node ID string, returning its stable u64 ID.
    fn intern_node(&mut self, node_id: &str) -> u64 {
        if let Some(&id) = self.node_to_id.get(node_id) {
            return id;
        }
        let id = self.from_id.len() as u64;
        self.from_id.push(GraphNodeKind::Node(node_id.to_string()));
        self.node_to_id.insert(node_id.to_string(), id);
        id
    }

    /// Reverse lookup: returns the node ID string if this u64 is a node.
    fn get_node_str(&self, id: u64) -> Option<&str> {
        match self.from_id.get(id as usize)? {
            GraphNodeKind::Node(s) => Some(s.as_str()),
            GraphNodeKind::Dep(_) => None,
        }
    }

    /// Reverse lookup: returns the DepKey if this u64 is a dep key.
    #[allow(dead_code)]
    fn get_dep(&self, id: u64) -> Option<&DepKey> {
        match self.from_id.get(id as usize)? {
            GraphNodeKind::Dep(dk) => Some(dk),
            GraphNodeKind::Node(_) => None,
        }
    }
}

// ============================================================================
// Dependency Key + Binding Dependency Index (Task 167 Phase C)
// ============================================================================

/// Dependency key enum — identifies what context source a binding depends on.
///
/// Built during compute's binding dep index scan. When a binding with
/// `from: "fsm"` and `key: "fsm:editor:main"` is found for node "node-1",
/// the entry `DepKey::Fsm("fsm:editor:main") → {"node-1"}` is recorded.
///
/// # Wildcard Convention
///
/// A key of `"*"` means "depends on ALL keys of this source type". This is
/// used for:
/// - Bindings with dynamic keys (`SelectKey::Dynamic`) where the actual
///   key isn't known until runtime
/// - The `mark_fsm()` / `mark_routing()` / `mark_ambient()` backward-compat
///   methods which mark ALL keys of that type dirty
///
/// # Performance (Finding 24)
///
/// DepKey implements Hash + Eq directly. The BindingDepIndex interns DepKeys
/// to u64 via GraphInterner — zero `format!()` allocation per frame.
///
/// # Platform Portability
///
/// Pure Rust, no platform dependencies. Compiles to WASM, native, any target.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum DepKey {
    /// FSM context dependency (e.g., `DepKey::Fsm("fsm:editor:main")`)
    Fsm(String),
    /// Routing context dependency (e.g., `DepKey::Routing("pointer:0")`)
    Routing(String),
    /// Routing dependency where the key is sourced from ambient context at runtime.
    ///
    /// Example: `routing[ambient.session_text_origin]` records
    /// `DepKey::RoutingViaAmbient("session_text_origin")`. At dirty-resolution time,
    /// the ambient key is resolved to an actual routing key, and the node is only
    /// dirtied if that resolved key matches a changed routing origin.
    ///
    /// This eliminates wildcard dirtying for the dominant routing binding pattern.
    /// Without this, a single route change dirties ALL routing-dependent nodes.
    RoutingViaAmbient(String),
    /// Ambient context dependency (e.g., `DepKey::Ambient("session_text_origin")`)
    Ambient(String),
    /// Scene tree dependency (e.g., `DepKey::Scene("layout:editor:hud")`)
    Scene(String),
}

impl DepKey {
    /// Extract the inner key string for a given variant, or None if wrong type.
    fn inner_key_if_fsm(&self) -> Option<&str> {
        match self {
            DepKey::Fsm(k) => Some(k),
            _ => None,
        }
    }
    fn inner_key_if_routing(&self) -> Option<&str> {
        match self {
            DepKey::Routing(k) => Some(k),
            _ => None,
        }
    }
    fn inner_key_if_routing_via_ambient(&self) -> Option<&str> {
        match self {
            DepKey::RoutingViaAmbient(k) => Some(k),
            _ => None,
        }
    }
    fn inner_key_if_ambient(&self) -> Option<&str> {
        match self {
            DepKey::Ambient(k) => Some(k),
            _ => None,
        }
    }
    fn inner_key_if_scene(&self) -> Option<&str> {
        match self {
            DepKey::Scene(k) => Some(k),
            _ => None,
        }
    }
}

/// Bidirectional dependency index for binding evaluation.
///
/// Models the dependency relationships as a bipartite directed graph using
/// `../trillion-rust/crates/graph` `DirectedGraph<u64>` (T-GRAPH). DepKeys and node IDs are
/// interned to u64 via `GraphInterner`, then stored as graph vertices with
/// directed edges dep_key → node_id representing "node depends on this dep key."
///
/// # Architecture (Finding 24 — Task 1139)
///
/// Uses the unified `DirectedGraph` primitive with u64 keys instead of String.
/// Forward query (dep→nodes) = `graph.children()`. Reverse query (node→deps) =
/// `graph.parents()`. Bidirectional consistency is structurally guaranteed by
/// the graph primitive.
///
/// Before Task 1139, graph keys were prefixed strings like `"dep:fsm:key"` and
/// `"node:layout:editor:hud"`. Every `record()` call allocated 2 heap Strings
/// via `format!()`. Now DepKeys are interned DIRECTLY (they implement Hash+Eq),
/// and node IDs are interned once — zero per-frame String allocation.
///
/// # Wildcard Handling
///
/// `DepKey::Fsm("*")` means "depends on ANY FSM change". When resolving
/// dirty nodes, if any FSM key is dirty, all nodes with `DepKey::Fsm("*")`
/// are included. Conversely, if `fsm_dirty_keys` contains `"*"` (from
/// `mark_fsm()`), ALL FSM-dependent nodes are included.
///
/// # Non-Negotiable Invariants
///
/// 1. **Rebuilt after every compute pass** — bindings can change which keys
///    they reference (e.g., conditional bindings).
/// 2. **Bidirectional consistency** — guaranteed by DirectedGraph primitive.
/// 3. **Pure data structure** — no side effects, no I/O, no code execution.
/// 4. **Zero format!() allocation** — all keys interned to u64 (Finding 24).
#[derive(Debug, Clone)]
pub struct BindingDepIndex {
    /// Bipartite directed graph: dep_key_u64 → node_id_u64 edges.
    graph: DirectedGraph<u64>,
    /// Interner mapping DepKeys and node ID strings to unique u64 values.
    interner: GraphInterner,
}

impl Default for BindingDepIndex {
    fn default() -> Self {
        Self {
            graph: DirectedGraph::new(),
            interner: GraphInterner::new(),
        }
    }
}

impl PartialEq for BindingDepIndex {
    fn eq(&self, other: &Self) -> bool {
        // Compare by extracting all (dep_key, node_id) pairs as original types.
        // PartialEq is not a hot path — reverse-interning is acceptable here.
        let self_pairs = self.all_pairs();
        let other_pairs = other.all_pairs();
        self_pairs == other_pairs
    }
}

impl BindingDepIndex {
    /// Create an empty dependency index.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a dependency: node `node_id` depends on `dep`.
    ///
    /// Interns both the DepKey and node_id to u64, then adds vertices and
    /// a directed edge dep→node to the graph. Zero `format!()` allocation.
    ///
    /// # Arguments
    ///
    /// * `node_id` - The scene node ID with the binding.
    /// * `dep` - The context dependency key the binding references.
    pub fn record(&mut self, node_id: &str, dep: DepKey) {
        let dep_id = self.interner.intern_dep(&dep);
        let node_id_u64 = self.interner.intern_node(node_id);
        self.graph.add_node(dep_id);
        self.graph.add_node(node_id_u64);
        // Edge: dep → node (dep is parent, node is child)
        // Cycle detection is O(1) for bipartite depth-1 graphs
        let _ = self.graph.add_edge(&dep_id, &node_id_u64);
    }

    /// Resolve dirty keys → affected node IDs.
    ///
    /// Given the sets of dirty context keys, returns the union of all node IDs
    /// whose bindings reference any of those keys. Handles wildcards in both
    /// the dirty keys and the dependency index.
    ///
    /// Returns `HashSet<String>` at the boundary (L098 — translation at boundary).
    /// All internal operations use u64 graph lookups with zero String allocation.
    pub fn resolve_dirty_nodes(
        &self,
        fsm_keys: &HashSet<String>,
        routing_origins: &HashSet<String>,
        ambient_keys: &HashSet<String>,
        scene_structure_changed_ids: &HashSet<String>,
        ambient_state: &HashMap<String, serde_json::Value>,
    ) -> HashSet<String> {
        let mut affected = HashSet::new();

        // FSM resolution
        self.resolve_source_deps(
            fsm_keys,
            |dk| dk.inner_key_if_fsm(),
            |key| DepKey::Fsm(key.to_string()),
            &mut affected,
        );

        // Routing resolution (concrete keys)
        self.resolve_source_deps(
            routing_origins,
            |dk| dk.inner_key_if_routing(),
            |key| DepKey::Routing(key.to_string()),
            &mut affected,
        );

        // RoutingViaAmbient resolution: resolve ambient key → actual routing key
        if !routing_origins.is_empty() {
            for (dep, &dep_id) in &self.interner.dep_to_id {
                if let Some(ambient_key) = dep.inner_key_if_routing_via_ambient() {
                    let children: Vec<String> = self
                        .graph
                        .children(&dep_id)
                        .filter_map(|&cid| self.interner.get_node_str(cid).map(|s| s.to_string()))
                        .collect();
                    if routing_origins.contains("*") {
                        affected.extend(children);
                    } else if let Some(resolved_value) = ambient_state.get(ambient_key) {
                        let resolved_key = match resolved_value {
                            serde_json::Value::String(s) => s.as_str(),
                            _ => continue,
                        };
                        if routing_origins.contains(resolved_key) {
                            affected.extend(children);
                        }
                    }
                }
            }
        }

        // Ambient resolution
        self.resolve_source_deps(
            ambient_keys,
            |dk| dk.inner_key_if_ambient(),
            |key| DepKey::Ambient(key.to_string()),
            &mut affected,
        );

        // Scene resolution
        if !scene_structure_changed_ids.is_empty() {
            if scene_structure_changed_ids.contains("*") {
                // Wildcard: ALL from:scene dependents
                for (dep, &dep_id) in &self.interner.dep_to_id {
                    if dep.inner_key_if_scene().is_some() {
                        for &child_id in self.graph.children(&dep_id) {
                            if let Some(nid) = self.interner.get_node_str(child_id) {
                                affected.insert(nid.to_string());
                            }
                        }
                    }
                }
            } else {
                for (dep, &dep_id) in &self.interner.dep_to_id {
                    if let Some(scene_id) = dep.inner_key_if_scene() {
                        if scene_structure_changed_ids.contains(scene_id) {
                            for &child_id in self.graph.children(&dep_id) {
                                if let Some(nid) = self.interner.get_node_str(child_id) {
                                    affected.insert(nid.to_string());
                                }
                            }
                        }
                    }
                }
                affected.extend(scene_structure_changed_ids.iter().cloned());
            }
        }

        affected
    }

    /// Internal helper: resolve deps for a single source type via interner lookup.
    ///
    /// Uses `type_filter` to identify dep keys of the target type (e.g., FSM),
    /// and `make_key` to construct DepKeys for specific dirty keys.
    /// Zero string prefix matching — all dispatch via typed DepKey variants.
    fn resolve_source_deps(
        &self,
        dirty_keys: &HashSet<String>,
        type_filter: impl Fn(&DepKey) -> Option<&str>,
        make_key: impl Fn(&str) -> DepKey,
        affected: &mut HashSet<String>,
    ) {
        if dirty_keys.is_empty() {
            return;
        }

        if dirty_keys.contains("*") {
            // Wildcard: ALL nodes depending on ANY key of this source type
            for (dep, &dep_id) in &self.interner.dep_to_id {
                if type_filter(dep).is_some() {
                    for &child_id in self.graph.children(&dep_id) {
                        if let Some(nid) = self.interner.get_node_str(child_id) {
                            affected.insert(nid.to_string());
                        }
                    }
                }
            }
        } else {
            // Specific keys: only matching deps
            for key in dirty_keys {
                let dep = make_key(key);
                if let Some(&dep_id) = self.interner.dep_to_id.get(&dep) {
                    for &child_id in self.graph.children(&dep_id) {
                        if let Some(nid) = self.interner.get_node_str(child_id) {
                            affected.insert(nid.to_string());
                        }
                    }
                }
            }
            // Also include wildcard-dep nodes
            let wildcard = make_key("*");
            if let Some(&wc_id) = self.interner.dep_to_id.get(&wildcard) {
                for &child_id in self.graph.children(&wc_id) {
                    if let Some(nid) = self.interner.get_node_str(child_id) {
                        affected.insert(nid.to_string());
                    }
                }
            }
        }
    }

    /// Returns the number of unique dependency entries.
    pub fn dep_count(&self) -> usize {
        self.interner.dep_to_id.len()
    }

    /// Returns the number of unique nodes tracked.
    pub fn node_count(&self) -> usize {
        self.interner.node_to_id.len()
    }

    /// Extract all (DepKey, node_id) pairs for equality comparison.
    ///
    /// Reverse-interns u64 IDs back to original types. Not a hot path —
    /// used only by PartialEq.
    fn all_pairs(&self) -> HashSet<(DepKey, String)> {
        let mut pairs = HashSet::new();
        for (dep, &dep_id) in &self.interner.dep_to_id {
            for &child_id in self.graph.children(&dep_id) {
                if let Some(nid) = self.interner.get_node_str(child_id) {
                    pairs.insert((dep.clone(), nid.to_string()));
                }
            }
        }
        pairs
    }

    /// Query nodes that depend on a specific dep key. Used by tests.
    #[cfg(test)]
    pub fn nodes_for_dep(&self, dep: &DepKey) -> HashSet<String> {
        if let Some(&dep_id) = self.interner.dep_to_id.get(dep) {
            self.graph
                .children(&dep_id)
                .filter_map(|&cid| self.interner.get_node_str(cid).map(|s| s.to_string()))
                .collect()
        } else {
            HashSet::new()
        }
    }

    /// Query deps for a specific node. Used by tests.
    #[cfg(test)]
    pub fn deps_for_node(&self, node_id: &str) -> HashSet<DepKey> {
        if let Some(&nid) = self.interner.node_to_id.get(node_id) {
            self.graph
                .parents(&nid)
                .filter_map(|&pid| self.interner.get_dep(pid).cloned())
                .collect()
        } else {
            HashSet::new()
        }
    }
}

// ============================================================================
// DirtyTracker
// ============================================================================

/// Tracks what changed since the last render() call.
///
/// Cleared by render() after each frame. Mutations to KernelState
/// (scene tree, FSM, routing, ambient, viewport) set flags here.
///
/// # Lifecycle
///
/// ```text
/// DirtyTracker::new()   → all flags set (first render runs everything)
///        ↓
/// Mutations set flags   → mark_node(), mark_fsm(), mark_routing(), etc.
///        ↓
/// render() reads flags  → needs_binding_eval(), needs_layout(), is_clean()
///        ↓
/// render() calls clear()→ all flags reset, ready for next frame
///        ↓
/// (repeat)
/// ```
///
/// # Thread Safety
///
/// DirtyTracker is not Sync. It is owned by KernelState which is owned
/// by a single Kernel instance. Concurrent access is handled by the host
/// via message-passing (WASM) or external synchronization (native).
#[derive(Debug, Clone, Default)]
pub struct DirtyTracker {
    /// Node ID string→u64 interner (Finding 25 — Task 1139).
    ///
    /// Excluded from PartialEq — it's a performance cache, not semantic state.
    /// Grows monotonically across frames; `clear()` does NOT reset it.
    ///
    /// Maps string node IDs to compact u64 identifiers. Populated by mark_*()
    /// methods. Used by `to_runtime_delta()` to produce `HashSet<u64>` for
    /// `RuntimeDelta.changed_node_ids`. Grows monotonically — `clear()` does
    /// NOT reset the interner (IDs are stable across frames).
    pub node_interner: NodeIdInterner,

    /// Master flag: true if ANY change occurred since last render.
    ///
    /// This enables the fastest possible no-op check: a single boolean read.
    /// Every mark_*() method sets this to true. clear() sets it to false.
    /// If this is false, render() can return the previous snapshot immediately.
    pub anything_dirty: bool,

    /// Set of node IDs where scene tree structure changed (nodes added, removed,
    /// moved, reordered). Replaces the old boolean `scene_structure_dirty` with
    /// a set that carries WHERE the change occurred, enabling scoped binding
    /// evaluation instead of global re-evaluation. (Task 203)
    ///
    /// Structural changes always imply layout_dirty because adding/removing/moving
    /// nodes changes the flex layout tree. mark_scene_structure_for() sets both flags.
    pub scene_structure_changed_ids: HashSet<String>,

    /// Node IDs whose properties changed (binding inputs, style, layout props).
    ///
    /// Used for targeted re-evaluation: only nodes in this set have their
    /// bindings re-evaluated and layout recomputed. Nodes NOT in this set
    /// can reuse their previous computed values.
    pub dirty_nodes: HashSet<String>,

    /// True if any FSM state transition occurred (set_fsm_state called).
    ///
    /// FSM transitions can change binding context (bindings may reference
    /// `fsm.{id}` values), so this triggers binding re-evaluation for nodes
    /// that depend on FSM state.
    ///
    /// Kept alongside `fsm_dirty_keys` for backward compatibility with code
    /// that checks the boolean flag directly. Both are always kept in sync
    /// by the mark methods.
    pub fsm_dirty: bool,

    /// FSM keys that changed since last render (Task 167 Phase C).
    ///
    /// When non-empty, only bindings referencing these specific FSM keys
    /// need re-evaluation — not ALL bindings. A `"*"` entry means ALL FSM
    /// keys changed (set by `mark_fsm()` for backward compat).
    ///
    /// Used by `BindingDepIndex::resolve_dirty_nodes()` for scoped resolution.
    pub fsm_dirty_keys: HashSet<String>,

    /// True if any routing change occurred (set_route called).
    ///
    /// Routing changes affect bindings that reference `routing[origin_id]`,
    /// so this triggers binding re-evaluation for routing-dependent nodes.
    ///
    /// Kept alongside `routing_dirty_origins` for backward compatibility.
    pub routing_dirty: bool,

    /// Routing origins that changed since last render (Task 167 Phase C).
    ///
    /// When non-empty, only bindings referencing these specific origins
    /// need re-evaluation. A `"*"` entry means ALL origins changed.
    pub routing_dirty_origins: HashSet<String>,

    /// True if any ambient value changed (set_ambient called).
    ///
    /// Ambient changes affect bindings that reference `ambient.{key}`,
    /// so this triggers binding re-evaluation for ambient-dependent nodes.
    ///
    /// Kept alongside `ambient_dirty_keys` for backward compatibility.
    pub ambient_dirty: bool,

    /// Ambient keys that changed since last render (Task 167 Phase C).
    ///
    /// When non-empty, only bindings referencing these specific ambient keys
    /// need re-evaluation. A `"*"` entry means ALL keys changed.
    pub ambient_dirty_keys: HashSet<String>,

    /// True if viewport size changed (set_viewport called).
    ///
    /// Viewport changes always imply layout_dirty because the root constraints
    /// change. mark_viewport() sets both flags.
    pub viewport_dirty: bool,

    /// True if the entire tree needs re-layout.
    ///
    /// Set automatically by mark_scene_structure_for() and mark_viewport().
    /// Also true when dirty_nodes is non-empty (node property changes may
    /// affect layout). Checked by needs_layout().
    pub layout_dirty: bool,

    /// True if camera changed (pan, zoom).
    ///
    /// Used during render() to determine if viewport culling needs to recompute
    /// the visible set via spatial index query. Set by mark_camera().
    pub camera_dirty: bool,

    /// True if edge set changed (added, removed, or updated).
    ///
    /// Used during render() to determine if edge routes need recomputation.
    /// Set by mark_edges().
    pub edges_dirty: bool,
}

impl PartialEq for DirtyTracker {
    fn eq(&self, other: &Self) -> bool {
        // node_interner excluded — it's a performance cache, not semantic state.
        self.anything_dirty == other.anything_dirty
            && self.scene_structure_changed_ids == other.scene_structure_changed_ids
            && self.dirty_nodes == other.dirty_nodes
            && self.fsm_dirty == other.fsm_dirty
            && self.fsm_dirty_keys == other.fsm_dirty_keys
            && self.routing_dirty == other.routing_dirty
            && self.routing_dirty_origins == other.routing_dirty_origins
            && self.ambient_dirty == other.ambient_dirty
            && self.ambient_dirty_keys == other.ambient_dirty_keys
            && self.viewport_dirty == other.viewport_dirty
            && self.layout_dirty == other.layout_dirty
            && self.camera_dirty == other.camera_dirty
            && self.edges_dirty == other.edges_dirty
    }
}

impl DirtyTracker {
    /// Create a new DirtyTracker with ALL flags set (fully dirty).
    ///
    /// The first render after kernel initialization MUST run all phases
    /// unconditionally. Starting fully dirty guarantees this.
    ///
    /// # Returns
    ///
    /// A DirtyTracker where every flag is true. dirty_nodes is empty
    /// because no specific nodes are targeted — the global flags ensure
    /// all phases run regardless.
    pub fn new() -> Self {
        let mut fsm_dirty_keys = HashSet::new();
        fsm_dirty_keys.insert("*".to_string());
        let mut routing_dirty_origins = HashSet::new();
        routing_dirty_origins.insert("*".to_string());
        let mut ambient_dirty_keys = HashSet::new();
        ambient_dirty_keys.insert("*".to_string());

        // First render treats ALL scene nodes as structurally changed.
        // The wildcard "*" entry means "everything" — resolve_dirty_nodes
        // will match it against any DepKey::Scene key, ensuring all scene-dependent
        // bindings are evaluated on the first pass.
        let mut scene_structure_changed_ids = HashSet::new();
        scene_structure_changed_ids.insert("*".to_string());

        Self {
            node_interner: NodeIdInterner::new(),
            anything_dirty: true,
            scene_structure_changed_ids,
            dirty_nodes: HashSet::new(),
            fsm_dirty: true,
            fsm_dirty_keys,
            routing_dirty: true,
            routing_dirty_origins,
            ambient_dirty: true,
            ambient_dirty_keys,
            viewport_dirty: true,
            layout_dirty: true,
            camera_dirty: true,
            edges_dirty: true,
        }
    }

    // ========================================================================
    // Mutation Methods (called by KernelState mutation operations)
    // ========================================================================

    /// Mark a specific node as dirty (property change, binding input change).
    ///
    /// Called when update_scene() applies an UpdateProps patch. The node's
    /// bindings will be re-evaluated and its layout recomputed on next render.
    ///
    /// # Arguments
    ///
    /// * `node_id` - The ID of the node whose properties changed.
    ///
    /// # Performance
    ///
    /// O(1) amortized (HashSet insert).
    #[inline]
    pub fn mark_node(&mut self, node_id: &str) {
        self.anything_dirty = true;
        self.node_interner.intern(node_id);
        self.dirty_nodes.insert(node_id.to_string());
    }

    /// Mark a node AND all its descendants as dirty.
    ///
    /// Called when InsertNode adds a new subtree. Every node in the subtree
    /// needs binding evaluation because none have cached resolved values
    /// in `previous_index`.
    ///
    /// # Arguments
    ///
    /// * `node` - The root of the subtree to mark dirty.
    ///
    /// # Performance
    ///
    /// O(subtree_size). For typical inserts (1-5 nodes), this is negligible.
    pub fn mark_node_recursive(&mut self, node: &super::types::SceneNode) {
        self.anything_dirty = true;
        self.node_interner.intern(&node.id);
        self.dirty_nodes.insert(node.id.clone());
        for child in &node.children {
            self.mark_node_recursive(child);
        }
    }

    /// Mark a specific node as the site of a structural change.
    ///
    /// Called when update_scene() applies SetRoot, InsertNode, RemoveSubtree,
    /// MoveNode, or ReorderChildren patches. The `node_id` identifies WHERE
    /// the structural change occurred (typically the parent of the
    /// inserted/removed/moved node, or the root for SetRoot).
    ///
    /// This replaces the old `mark_scene_structure()` boolean with a per-node
    /// set, enabling `resolve_dirty_nodes()` to scope `from:scene` binding
    /// evaluation to ONLY nodes whose bindings depend on the changed subtree.
    /// (Task 203: Structure-Scoped Binding Evaluation)
    ///
    /// # Side Effects
    ///
    /// Also sets layout_dirty = true (structural change implies layout change).
    ///
    /// # Arguments
    ///
    /// * `node_id` - The ID of the node at which the structural change occurred.
    #[inline]
    pub fn mark_scene_structure_for(&mut self, node_id: &str) {
        self.anything_dirty = true;
        self.node_interner.intern(node_id);
        self.scene_structure_changed_ids.insert(node_id.to_string());
        // INV-038: Also add to dirty_nodes so incremental layout visits this
        // parent, discovers newly inserted/removed children, and measures them.
        // Without this, incremental layout skips the parent (not in dirty set)
        // and never discovers new children — forcing full O(n) layout.
        self.dirty_nodes.insert(node_id.to_string());
        self.layout_dirty = true;
    }

    /// Check if any structural change occurred since last render.
    ///
    /// Returns true when one or more node IDs have been recorded via
    /// `mark_scene_structure_for()`. Replaces direct reads of the old
    /// `scene_structure_dirty` boolean field.
    #[inline]
    pub fn is_scene_structure_dirty(&self) -> bool {
        !self.scene_structure_changed_ids.is_empty()
    }

    /// INV-038: Check if a wildcard `"*"` structural change is recorded.
    ///
    /// Wildcard means the ENTIRE tree structure is new (first render or SetRoot) —
    /// previous layout frames are meaningless and full layout is required.
    /// Per-node structure changes (InsertNode/RemoveSubtree/MoveNode) are
    /// handled incrementally and do NOT trigger this.
    #[inline]
    pub fn has_wildcard_structure_dirty(&self) -> bool {
        self.scene_structure_changed_ids.contains("*")
    }

    /// Backward-compatible bulk mark: marks ALL structure as dirty (wildcard).
    ///
    /// Used by `DirtyTracker::new()` for first-render initialization and by
    /// callers that don't have a specific node ID (e.g., SetRoot when the
    /// entire tree is replaced). Internally inserts `"*"` which causes
    /// `resolve_dirty_nodes()` to include ALL `from:scene` dependents.
    #[inline]
    pub fn mark_scene_structure(&mut self) {
        self.anything_dirty = true;
        self.scene_structure_changed_ids.insert("*".to_string());
        self.layout_dirty = true;
    }

    /// Mark FSM state as dirty (state transition occurred).
    ///
    /// Marks ALL FSM keys as dirty (wildcard `"*"`). For key-scoped marking,
    /// use `mark_fsm_key()` instead. Kept for backward compatibility with
    /// code that doesn't know which specific key changed.
    #[inline]
    pub fn mark_fsm(&mut self) {
        self.anything_dirty = true;
        self.fsm_dirty = true;
        self.fsm_dirty_keys.insert("*".to_string());
    }

    /// Mark a specific FSM key as dirty (Task 167 Phase C).
    ///
    /// Only bindings referencing this specific FSM key need re-evaluation.
    /// Combined with `BindingDepIndex`, this enables O(affected) instead
    /// of O(tree) binding evaluation on FSM changes.
    ///
    /// # Arguments
    ///
    /// * `key` - The FSM key that changed (e.g., "fsm:editor:main").
    #[inline]
    pub fn mark_fsm_key(&mut self, key: &str) {
        self.anything_dirty = true;
        self.fsm_dirty = true;
        self.fsm_dirty_keys.insert(key.to_string());
    }

    /// Mark routing as dirty (route set or cleared).
    ///
    /// Marks ALL routing origins as dirty (wildcard `"*"`). For key-scoped
    /// marking, use `mark_routing_origin()` instead.
    #[inline]
    pub fn mark_routing(&mut self) {
        self.anything_dirty = true;
        self.routing_dirty = true;
        self.routing_dirty_origins.insert("*".to_string());
    }

    /// Mark a specific routing origin as dirty (Task 167 Phase C).
    ///
    /// Only bindings referencing this specific routing origin need re-evaluation.
    ///
    /// # Arguments
    ///
    /// * `origin` - The routing origin that changed (e.g., "pointer:0").
    #[inline]
    pub fn mark_routing_origin(&mut self, origin: &str) {
        self.anything_dirty = true;
        self.routing_dirty = true;
        self.routing_dirty_origins.insert(origin.to_string());
    }

    /// Mark ambient as dirty (host-injected value changed).
    ///
    /// Marks ALL ambient keys as dirty (wildcard `"*"`). For key-scoped
    /// marking, use `mark_ambient_key()` instead.
    #[inline]
    pub fn mark_ambient(&mut self) {
        self.anything_dirty = true;
        self.ambient_dirty = true;
        self.ambient_dirty_keys.insert("*".to_string());
    }

    /// Mark a specific ambient key as dirty (Task 167 Phase C).
    ///
    /// Only bindings referencing this specific ambient key need re-evaluation.
    ///
    /// # Arguments
    ///
    /// * `key` - The ambient key that changed (e.g., "session_text_origin").
    #[inline]
    pub fn mark_ambient_key(&mut self, key: &str) {
        self.anything_dirty = true;
        self.ambient_dirty = true;
        self.ambient_dirty_keys.insert(key.to_string());
    }

    /// Mark viewport as dirty (resize occurred).
    ///
    /// Called when set_viewport() is invoked. Viewport changes always
    /// require full layout recomputation because root constraints change.
    ///
    /// # Side Effects
    ///
    /// Also sets layout_dirty = true (viewport resize implies layout change).
    #[inline]
    pub fn mark_viewport(&mut self) {
        self.anything_dirty = true;
        self.viewport_dirty = true;
        self.layout_dirty = true;
    }

    /// Mark camera as dirty (pan or zoom changed).
    ///
    /// Called when set_camera() is invoked. Camera changes affect viewport
    /// culling but NOT layout. The spatial index query needs to recompute
    /// the visible set.
    #[inline]
    pub fn mark_camera(&mut self) {
        self.anything_dirty = true;
        self.camera_dirty = true;
    }

    /// Mark edges as dirty (edge set changed).
    ///
    /// Called when set_edges(), add_edge(), remove_edge(), or update_edge()
    /// is invoked. Edge changes require route recomputation.
    #[inline]
    pub fn mark_edges(&mut self) {
        self.anything_dirty = true;
        self.edges_dirty = true;
    }

    // ========================================================================
    // Query Methods (called by render() to decide phase skipping)
    // ========================================================================

    /// Check if nothing changed since last render (full no-op possible).
    ///
    /// If this returns true, render() can return the previous SceneSnapshot
    /// without running any computation phases. This is the fastest possible
    /// path: a single boolean check.
    ///
    /// # Returns
    ///
    /// true if no mutations have occurred since the last clear().
    #[inline]
    pub fn is_clean(&self) -> bool {
        !self.anything_dirty
    }

    /// Check if a specific node is dirty.
    ///
    /// Used by incremental binding evaluation to decide whether to
    /// re-evaluate a node's bindings or reuse the previous result.
    ///
    /// # Arguments
    ///
    /// * `node_id` - The node ID to check.
    ///
    /// # Returns
    ///
    /// true if mark_node() was called with this node_id since last clear().
    #[inline]
    pub fn is_node_dirty(&self, node_id: &str) -> bool {
        self.dirty_nodes.contains(node_id)
    }

    /// Check if binding evaluation is needed.
    ///
    /// Binding evaluation must run if any binding context changed:
    /// - FSM state transition (bindings may reference `fsm.{id}`)
    /// - Routing change (bindings may reference `routing[origin]`)
    /// - Ambient change (bindings may reference `ambient.{key}`)
    /// - Scene structure change (new nodes need initial evaluation)
    /// - Individual node property changes (binding inputs changed)
    ///
    /// # Returns
    ///
    /// true if any condition requires binding re-evaluation.
    #[inline]
    pub fn needs_binding_eval(&self) -> bool {
        self.fsm_dirty
            || self.routing_dirty
            || self.ambient_dirty
            || self.is_scene_structure_dirty()
            || !self.dirty_nodes.is_empty()
    }

    /// Check if a global binding CONTEXT changed and full evaluation is needed.
    ///
    /// # Task 167 Phase C: Key-Scoped Dirty + Dependency Index
    ///
    /// This method now accepts `has_dep_index` to support scoped resolution:
    ///
    /// - When `has_dep_index=false` (no dep index yet — first render or before
    ///   first compute): returns true if ANY context flag is set. This forces
    ///   full evaluation as a safe fallback.
    /// - When `has_dep_index=true` (dep index exists from a previous compute):
    ///   returns false even if context flags are set. The caller should use
    ///   `BindingDepIndex::resolve_dirty_nodes()` with the key-scoped dirty
    ///   sets to determine exactly which nodes need re-evaluation.
    ///
    /// Scene structure changes (InsertNode, RemoveSubtree) do NOT belong here
    /// because they don't invalidate EXISTING nodes' binding evaluations:
    /// - Existing nodes' bindings reference the same FSM keys, routes, and
    ///   ambient values as before the insert.
    /// - NEW nodes are handled by adding them to `dirty_nodes` (see
    ///   `mark_node_recursive()`).
    /// - Nodes with `from:scene` bindings are handled by the dep index:
    ///   `resolve_dirty_nodes()` includes `DepKey::Scene` dependents for the
    ///   specific changed node IDs in `scene_structure_changed_ids`.
    ///
    /// Structure changes still force full LAYOUT (via `needs_layout()` which
    /// checks `is_scene_structure_dirty()`). Only BINDING EVALUATION becomes
    /// incremental for structure changes.
    ///
    /// This differs from `needs_binding_eval()` which also returns true
    /// when `dirty_nodes` is non-empty or `is_scene_structure_dirty()` is true.
    /// `context_globally_dirty()` only checks context-level flags — it
    /// answers "does the evaluation CONTEXT require FULL re-evaluation?"
    ///
    /// # Arguments
    ///
    /// * `has_dep_index` - Whether a `BindingDepIndex` exists for scoped
    ///   resolution. Pass `false` on first render or when no dep index is
    ///   available. Pass `true` when `KernelState::binding_dep_index.is_some()`.
    ///
    /// # Returns
    ///
    /// true if context changed AND no dep index is available for scoped resolution.
    #[inline]
    pub fn context_globally_dirty(&self, has_dep_index: bool) -> bool {
        let any_context_dirty = self.fsm_dirty || self.routing_dirty || self.ambient_dirty;

        // If we have a dep index, scoped resolution handles it.
        // If not, fall back to global dirty for safety.
        any_context_dirty && !has_dep_index
    }

    /// Check if layout recomputation is needed.
    ///
    /// Layout must be recomputed if:
    /// - layout_dirty is set (structure change or viewport resize)
    /// - viewport_dirty is set (root constraints changed)
    /// - scene_structure_changed_ids is non-empty (flex tree shape changed)
    /// - Individual nodes changed (property changes may affect layout)
    ///
    /// # Returns
    ///
    /// true if any condition requires layout recomputation.
    #[inline]
    pub fn needs_layout(&self) -> bool {
        self.layout_dirty
            || self.viewport_dirty
            || self.is_scene_structure_dirty()
            || !self.dirty_nodes.is_empty()
    }

    // ========================================================================
    // Lifecycle Methods
    // ========================================================================

    /// Clear all flags after render completes.
    ///
    /// Called by render() at the end of each frame. After clearing,
    /// is_clean() returns true and all phase-skip queries return false.
    /// The tracker is ready to accumulate dirty flags for the next frame.
    ///
    /// # Invariant
    ///
    /// After clear(), the tracker is in the same state as Default::default().
    pub fn clear(&mut self) {
        self.anything_dirty = false;
        self.scene_structure_changed_ids.clear();
        self.dirty_nodes.clear();
        self.fsm_dirty = false;
        self.fsm_dirty_keys.clear();
        self.routing_dirty = false;
        self.routing_dirty_origins.clear();
        self.ambient_dirty = false;
        self.ambient_dirty_keys.clear();
        self.viewport_dirty = false;
        self.layout_dirty = false;
        self.camera_dirty = false;
        self.edges_dirty = false;
    }
}

// ============================================================================
// Ancestor Dirty Set (Task 198)
// ============================================================================

/// Compute the set of all node IDs that are ancestors of at least one dirty node.
///
/// Used by `typed_materialize()` and `rebuild_children()` to skip entire clean
/// subtrees without entering them. A node is in the ancestor set if it IS dirty
/// or if ANY of its descendants are dirty.
///
/// # Architecture
///
/// This converts the flat `dirty_nodes` set into a tree-aware structure. Without
/// this, `rebuild_children()` must enter every child subtree because a dirty
/// descendant could be arbitrarily deep. With the ancestor set, children not in
/// the set are guaranteed to have zero dirty descendants — the entire subtree
/// can be reused via `Arc::clone()` at O(1).
///
/// # Performance
///
/// O(n) worst case (walks entire tree), but the result converts every subsequent
/// `rebuild_children()` call from O(children) to O(dirty-path-children). For a
/// tree of 10^6 nodes with 10 dirty, the traversal saves ~999,990 node visits.
///
/// # Arguments
///
/// * `root` - The root of the scene tree to analyze.
/// * `dirty_set` - The set of node IDs that are dirty (need binding re-evaluation).
///
/// # Returns
///
/// A `HashSet<String>` containing every node ID on the path from root to any
/// dirty node (inclusive of both the dirty node and the root).
pub fn compute_ancestor_set(
    root: &std::sync::Arc<super::types::SceneNode>,
    dirty_set: &HashSet<String>,
) -> HashSet<String> {
    let mut ancestors = HashSet::new();
    walk_ancestor(root, dirty_set, &mut ancestors);
    ancestors
}

/// Recursive helper: returns true if this node or any descendant is dirty.
///
/// When a dirty descendant is found, the current node is added to the ancestor
/// set. This builds the complete spine from root to every dirty leaf.
fn walk_ancestor(
    node: &std::sync::Arc<super::types::SceneNode>,
    dirty_set: &HashSet<String>,
    ancestors: &mut HashSet<String>,
) -> bool {
    let mut has_dirty_descendant = dirty_set.contains(&node.id);
    for child in &node.children {
        if walk_ancestor(child, dirty_set, ancestors) {
            has_dirty_descendant = true;
        }
    }
    if has_dirty_descendant {
        ancestors.insert(node.id.clone());
    }
    has_dirty_descendant
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Construction Tests
    // ========================================================================

    /// DirtyTracker::new() starts fully dirty so the first render runs all phases.
    #[test]
    fn new_starts_fully_dirty() {
        let tracker = DirtyTracker::new();
        assert!(
            tracker.anything_dirty,
            "anything_dirty must be true on new()"
        );
        assert!(
            tracker.is_scene_structure_dirty(),
            "scene_structure_dirty must be true on new()"
        );
        assert!(tracker.fsm_dirty, "fsm_dirty must be true on new()");
        assert!(tracker.routing_dirty, "routing_dirty must be true on new()");
        assert!(tracker.ambient_dirty, "ambient_dirty must be true on new()");
        assert!(
            tracker.viewport_dirty,
            "viewport_dirty must be true on new()"
        );
        assert!(tracker.layout_dirty, "layout_dirty must be true on new()");
        assert!(
            tracker.dirty_nodes.is_empty(),
            "dirty_nodes must be empty on new()"
        );
        // All phase queries must return true
        assert!(!tracker.is_clean(), "is_clean() must be false on new()");
        assert!(
            tracker.needs_binding_eval(),
            "needs_binding_eval() must be true on new()"
        );
        assert!(
            tracker.needs_layout(),
            "needs_layout() must be true on new()"
        );
    }

    /// DirtyTracker::default() starts clean (all flags false, empty dirty_nodes).
    /// This is used in testing and when serde skips the field on deserialization.
    #[test]
    fn default_starts_clean() {
        let tracker = DirtyTracker::default();
        assert!(
            !tracker.anything_dirty,
            "anything_dirty must be false on default()"
        );
        assert!(!tracker.is_scene_structure_dirty());
        assert!(!tracker.fsm_dirty);
        assert!(!tracker.routing_dirty);
        assert!(!tracker.ambient_dirty);
        assert!(!tracker.viewport_dirty);
        assert!(!tracker.layout_dirty);
        assert!(tracker.dirty_nodes.is_empty());
        assert!(tracker.is_clean(), "is_clean() must be true on default()");
        assert!(
            !tracker.needs_binding_eval(),
            "needs_binding_eval() must be false on default()"
        );
        assert!(
            !tracker.needs_layout(),
            "needs_layout() must be false on default()"
        );
    }

    // ========================================================================
    // mark_node Tests
    // ========================================================================

    /// mark_node() sets anything_dirty and adds the node to dirty_nodes.
    #[test]
    fn mark_node_sets_anything_dirty_and_adds_to_dirty_nodes() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_node("node-1");

        assert!(
            tracker.anything_dirty,
            "anything_dirty must be true after mark_node"
        );
        assert!(
            tracker.dirty_nodes.contains("node-1"),
            "dirty_nodes must contain 'node-1'"
        );
        assert!(
            !tracker.is_clean(),
            "is_clean() must be false after mark_node"
        );
    }

    /// Multiple mark_node() calls accumulate in the dirty_nodes set.
    #[test]
    fn mark_node_accumulates_in_dirty_nodes_set() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_node("node-1");
        tracker.mark_node("node-2");
        tracker.mark_node("node-3");

        assert_eq!(tracker.dirty_nodes.len(), 3);
        assert!(tracker.dirty_nodes.contains("node-1"));
        assert!(tracker.dirty_nodes.contains("node-2"));
        assert!(tracker.dirty_nodes.contains("node-3"));
    }

    /// Duplicate mark_node() calls are idempotent (HashSet deduplication).
    #[test]
    fn mark_node_is_idempotent() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_node("node-1");
        tracker.mark_node("node-1");
        tracker.mark_node("node-1");

        assert_eq!(
            tracker.dirty_nodes.len(),
            1,
            "duplicate inserts must not increase set size"
        );
    }

    /// mark_node() after clear() sets dirty again.
    #[test]
    fn mark_node_after_clear_sets_dirty_again() {
        let mut tracker = DirtyTracker::new();
        tracker.clear();
        assert!(tracker.is_clean(), "must be clean after clear()");

        tracker.mark_node("node-1");
        assert!(
            !tracker.is_clean(),
            "must be dirty after mark_node following clear()"
        );
        assert!(tracker.dirty_nodes.contains("node-1"));
    }

    // ========================================================================
    // mark_scene_structure Tests
    // ========================================================================

    /// mark_scene_structure() sets scene_structure_dirty, layout_dirty, and anything_dirty.
    #[test]
    fn mark_scene_structure_sets_structure_and_layout_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_scene_structure();

        assert!(tracker.anything_dirty, "anything_dirty must be true");
        assert!(
            tracker.is_scene_structure_dirty(),
            "scene_structure_dirty must be true"
        );
        assert!(
            tracker.layout_dirty,
            "layout_dirty must be true (structure implies layout)"
        );
        // Other flags should NOT be set
        assert!(!tracker.fsm_dirty, "fsm_dirty must remain false");
        assert!(!tracker.routing_dirty, "routing_dirty must remain false");
        assert!(!tracker.ambient_dirty, "ambient_dirty must remain false");
        assert!(!tracker.viewport_dirty, "viewport_dirty must remain false");
    }

    // ========================================================================
    // mark_fsm Tests
    // ========================================================================

    /// mark_fsm() sets fsm_dirty and anything_dirty.
    #[test]
    fn mark_fsm_sets_fsm_dirty_and_anything_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm();

        assert!(tracker.anything_dirty, "anything_dirty must be true");
        assert!(tracker.fsm_dirty, "fsm_dirty must be true");
        // Other flags should NOT be set
        assert!(!tracker.is_scene_structure_dirty());
        assert!(!tracker.routing_dirty);
        assert!(!tracker.ambient_dirty);
        assert!(!tracker.viewport_dirty);
        assert!(!tracker.layout_dirty);
    }

    // ========================================================================
    // mark_routing Tests
    // ========================================================================

    /// mark_routing() sets routing_dirty and anything_dirty.
    #[test]
    fn mark_routing_sets_routing_dirty_and_anything_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_routing();

        assert!(tracker.anything_dirty, "anything_dirty must be true");
        assert!(tracker.routing_dirty, "routing_dirty must be true");
        assert!(!tracker.is_scene_structure_dirty());
        assert!(!tracker.fsm_dirty);
        assert!(!tracker.ambient_dirty);
        assert!(!tracker.viewport_dirty);
        assert!(!tracker.layout_dirty);
    }

    // ========================================================================
    // mark_ambient Tests
    // ========================================================================

    /// mark_ambient() sets ambient_dirty and anything_dirty.
    #[test]
    fn mark_ambient_sets_ambient_dirty_and_anything_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_ambient();

        assert!(tracker.anything_dirty, "anything_dirty must be true");
        assert!(tracker.ambient_dirty, "ambient_dirty must be true");
        assert!(!tracker.is_scene_structure_dirty());
        assert!(!tracker.fsm_dirty);
        assert!(!tracker.routing_dirty);
        assert!(!tracker.viewport_dirty);
        assert!(!tracker.layout_dirty);
    }

    // ========================================================================
    // mark_viewport Tests
    // ========================================================================

    /// mark_viewport() sets viewport_dirty, layout_dirty, and anything_dirty.
    #[test]
    fn mark_viewport_sets_viewport_and_layout_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_viewport();

        assert!(tracker.anything_dirty, "anything_dirty must be true");
        assert!(tracker.viewport_dirty, "viewport_dirty must be true");
        assert!(
            tracker.layout_dirty,
            "layout_dirty must be true (viewport implies layout)"
        );
        // Other flags should NOT be set
        assert!(!tracker.is_scene_structure_dirty());
        assert!(!tracker.fsm_dirty);
        assert!(!tracker.routing_dirty);
        assert!(!tracker.ambient_dirty);
    }

    // ========================================================================
    // is_clean / is_node_dirty Tests
    // ========================================================================

    /// is_clean() returns true after clear(), false after any mark_* operation.
    #[test]
    fn is_clean_reflects_dirty_state() {
        let mut tracker = DirtyTracker::default();
        assert!(tracker.is_clean(), "default tracker must be clean");

        tracker.mark_fsm();
        assert!(!tracker.is_clean(), "must not be clean after mark_fsm");

        tracker.clear();
        assert!(tracker.is_clean(), "must be clean after clear()");

        tracker.mark_node("x");
        assert!(!tracker.is_clean(), "must not be clean after mark_node");

        tracker.clear();
        tracker.mark_ambient();
        assert!(!tracker.is_clean(), "must not be clean after mark_ambient");
    }

    /// is_node_dirty() returns true only for marked nodes.
    #[test]
    fn is_node_dirty_returns_true_only_for_marked_nodes() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_node("node-1");

        assert!(tracker.is_node_dirty("node-1"), "marked node must be dirty");
        assert!(
            !tracker.is_node_dirty("node-2"),
            "unmarked node must not be dirty"
        );
        assert!(
            !tracker.is_node_dirty("node-999"),
            "unknown node must not be dirty"
        );
    }

    // ========================================================================
    // needs_binding_eval Tests
    // ========================================================================

    /// needs_binding_eval() returns true when fsm_dirty is set.
    #[test]
    fn needs_binding_eval_true_when_fsm_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm();
        assert!(tracker.needs_binding_eval());
    }

    /// needs_binding_eval() returns true when routing_dirty is set.
    #[test]
    fn needs_binding_eval_true_when_routing_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_routing();
        assert!(tracker.needs_binding_eval());
    }

    /// needs_binding_eval() returns true when ambient_dirty is set.
    #[test]
    fn needs_binding_eval_true_when_ambient_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_ambient();
        assert!(tracker.needs_binding_eval());
    }

    /// needs_binding_eval() returns true when dirty_nodes is non-empty.
    #[test]
    fn needs_binding_eval_true_when_dirty_nodes_nonempty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_node("node-1");
        assert!(tracker.needs_binding_eval());
    }

    /// needs_binding_eval() returns true when scene_structure_dirty is set.
    #[test]
    fn needs_binding_eval_true_when_scene_structure_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_scene_structure();
        assert!(tracker.needs_binding_eval());
    }

    /// needs_binding_eval() returns false when only viewport or layout is dirty.
    #[test]
    fn needs_binding_eval_false_when_only_viewport_dirty() {
        let mut tracker = DirtyTracker::default();
        // Manually set only viewport_dirty and layout_dirty (without scene_structure)
        tracker.anything_dirty = true;
        tracker.viewport_dirty = true;
        tracker.layout_dirty = true;
        assert!(
            !tracker.needs_binding_eval(),
            "viewport-only change should not trigger binding eval"
        );
    }

    // ========================================================================
    // context_globally_dirty Tests (Task 164)
    // ========================================================================

    /// context_globally_dirty() returns true when fsm_dirty is set.
    #[test]
    fn context_globally_dirty_true_when_fsm_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm();
        assert!(tracker.context_globally_dirty(false));
    }

    /// context_globally_dirty() returns true when routing_dirty is set.
    #[test]
    fn context_globally_dirty_true_when_routing_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_routing();
        assert!(tracker.context_globally_dirty(false));
    }

    /// context_globally_dirty() returns true when ambient_dirty is set.
    #[test]
    fn context_globally_dirty_true_when_ambient_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_ambient();
        assert!(tracker.context_globally_dirty(false));
    }

    /// context_globally_dirty() returns FALSE when only scene_structure_dirty is set.
    ///
    /// Task 167 Phase A: Scene structure changes (InsertNode, RemoveSubtree) do NOT
    /// invalidate existing nodes' binding context. New nodes are tracked via
    /// dirty_nodes (mark_node_recursive). Structure changes still force full LAYOUT
    /// via needs_layout() and the explicit scene_structure_dirty check in
    /// force_full_layout, but binding evaluation is now incremental.
    #[test]
    fn context_globally_dirty_false_when_only_scene_structure_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_scene_structure();
        assert!(
            !tracker.context_globally_dirty(false),
            "scene_structure_dirty alone must NOT trigger context_globally_dirty — \
             structure changes don't invalidate existing nodes' binding context. \
             New nodes are tracked via dirty_nodes (mark_node_recursive)."
        );
    }

    /// context_globally_dirty() returns false when only dirty_nodes is non-empty.
    /// This is the key distinction from needs_binding_eval(): dirty_nodes alone
    /// means only specific nodes need re-evaluation, not a full context change.
    #[test]
    fn context_globally_dirty_false_when_only_dirty_nodes() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_node("node-1");
        assert!(
            !tracker.context_globally_dirty(false),
            "dirty_nodes alone must NOT trigger context_globally_dirty — \
             only node-level re-evaluation is needed"
        );
    }

    /// context_globally_dirty() returns false when only viewport or layout is dirty.
    #[test]
    fn context_globally_dirty_false_when_only_viewport_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.anything_dirty = true;
        tracker.viewport_dirty = true;
        tracker.layout_dirty = true;
        assert!(
            !tracker.context_globally_dirty(false),
            "viewport-only change must NOT trigger context_globally_dirty"
        );
    }

    /// context_globally_dirty() returns false on clean tracker.
    #[test]
    fn context_globally_dirty_false_when_clean() {
        let tracker = DirtyTracker::default();
        assert!(!tracker.context_globally_dirty(false));
    }

    // ========================================================================
    // needs_layout Tests
    // ========================================================================

    /// needs_layout() returns true when layout_dirty is set.
    #[test]
    fn needs_layout_true_when_layout_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.anything_dirty = true;
        tracker.layout_dirty = true;
        assert!(tracker.needs_layout());
    }

    /// needs_layout() returns true when viewport_dirty is set.
    #[test]
    fn needs_layout_true_when_viewport_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_viewport();
        assert!(tracker.needs_layout());
    }

    /// needs_layout() returns true when scene_structure_dirty is set.
    #[test]
    fn needs_layout_true_when_scene_structure_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_scene_structure();
        assert!(tracker.needs_layout());
    }

    /// needs_layout() returns true when dirty_nodes is non-empty.
    #[test]
    fn needs_layout_true_when_dirty_nodes_nonempty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_node("node-1");
        assert!(tracker.needs_layout());
    }

    /// needs_layout() returns false when only fsm, routing, or ambient is dirty.
    #[test]
    fn needs_layout_false_when_only_context_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm();
        // fsm_dirty alone does not imply layout change
        assert!(
            !tracker.needs_layout(),
            "fsm-only change should not trigger layout"
        );

        let mut tracker2 = DirtyTracker::default();
        tracker2.mark_routing();
        assert!(
            !tracker2.needs_layout(),
            "routing-only change should not trigger layout"
        );

        let mut tracker3 = DirtyTracker::default();
        tracker3.mark_ambient();
        assert!(
            !tracker3.needs_layout(),
            "ambient-only change should not trigger layout"
        );
    }

    // ========================================================================
    // clear Tests
    // ========================================================================

    /// clear() resets ALL flags and empties dirty_nodes.
    #[test]
    fn clear_resets_all_flags_and_empties_dirty_nodes() {
        let mut tracker = DirtyTracker::new();
        tracker.mark_node("node-1");
        tracker.mark_node("node-2");

        // Verify everything is dirty before clear
        assert!(tracker.anything_dirty);
        assert!(tracker.is_scene_structure_dirty());
        assert!(tracker.fsm_dirty);
        assert!(tracker.routing_dirty);
        assert!(tracker.ambient_dirty);
        assert!(tracker.viewport_dirty);
        assert!(tracker.layout_dirty);
        assert!(!tracker.dirty_nodes.is_empty());

        tracker.clear();

        // Verify everything is clean after clear
        assert!(
            !tracker.anything_dirty,
            "anything_dirty must be false after clear"
        );
        assert!(
            !tracker.is_scene_structure_dirty(),
            "scene_structure_dirty must be false after clear"
        );
        assert!(!tracker.fsm_dirty, "fsm_dirty must be false after clear");
        assert!(
            !tracker.routing_dirty,
            "routing_dirty must be false after clear"
        );
        assert!(
            !tracker.ambient_dirty,
            "ambient_dirty must be false after clear"
        );
        assert!(
            !tracker.viewport_dirty,
            "viewport_dirty must be false after clear"
        );
        assert!(
            !tracker.layout_dirty,
            "layout_dirty must be false after clear"
        );
        assert!(
            tracker.dirty_nodes.is_empty(),
            "dirty_nodes must be empty after clear"
        );

        // Verify all queries return clean state
        assert!(tracker.is_clean());
        assert!(!tracker.needs_binding_eval());
        assert!(!tracker.needs_layout());
    }

    /// After clear(), the tracker equals DirtyTracker::default().
    #[test]
    fn clear_produces_default_equivalent() {
        let mut tracker = DirtyTracker::new();
        tracker.mark_node("a");
        tracker.mark_node("b");
        tracker.clear();

        assert_eq!(
            tracker,
            DirtyTracker::default(),
            "cleared tracker must equal default()"
        );
    }

    // ========================================================================
    // Combined / Cross-Cutting Tests
    // ========================================================================

    /// Multiple different mark_* calls accumulate correctly.
    #[test]
    fn multiple_mark_calls_accumulate() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm();
        tracker.mark_routing();
        tracker.mark_node("node-1");

        assert!(tracker.fsm_dirty);
        assert!(tracker.routing_dirty);
        assert!(tracker.dirty_nodes.contains("node-1"));
        assert!(!tracker.ambient_dirty, "ambient was not marked");
        assert!(!tracker.viewport_dirty, "viewport was not marked");
        assert!(
            !tracker.is_scene_structure_dirty(),
            "structure was not marked"
        );
    }

    /// mark_scene_structure does NOT set context flags (fsm, routing, ambient).
    #[test]
    fn mark_scene_structure_does_not_set_context_flags() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_scene_structure();

        assert!(tracker.is_scene_structure_dirty());
        assert!(tracker.layout_dirty);
        assert!(
            !tracker.fsm_dirty,
            "structure change should not imply fsm change"
        );
        assert!(
            !tracker.routing_dirty,
            "structure change should not imply routing change"
        );
        assert!(
            !tracker.ambient_dirty,
            "structure change should not imply ambient change"
        );
    }

    /// Full lifecycle: new → mark → clear → mark → verify.
    #[test]
    fn full_lifecycle_new_mark_clear_mark() {
        // Start fully dirty
        let mut tracker = DirtyTracker::new();
        assert!(!tracker.is_clean());

        // Simulate render complete
        tracker.clear();
        assert!(tracker.is_clean());
        assert!(!tracker.needs_binding_eval());
        assert!(!tracker.needs_layout());

        // Simulate FSM transition between frames
        tracker.mark_fsm();
        assert!(!tracker.is_clean());
        assert!(tracker.needs_binding_eval());
        assert!(
            !tracker.needs_layout(),
            "FSM change alone does not need layout"
        );

        // Simulate render complete again
        tracker.clear();
        assert!(tracker.is_clean());

        // Simulate viewport resize
        tracker.mark_viewport();
        assert!(!tracker.is_clean());
        assert!(
            !tracker.needs_binding_eval(),
            "viewport change alone does not need binding eval"
        );
        assert!(tracker.needs_layout());
    }

    // ========================================================================
    // Task 167 Phase A: Structure-Dirty Decoupling Tests
    //
    // These tests verify that scene structure changes (InsertNode) no longer
    // trigger full binding re-evaluation via context_globally_dirty(). Instead,
    // new nodes are tracked via dirty_nodes (mark_node_recursive) and only
    // THOSE nodes get binding evaluation. Layout still forces full recompute
    // for structure changes.
    // ========================================================================

    use crate::kernel::types::SceneNode;
    use std::sync::Arc;

    /// Helper: Build a SceneNode tree for mark_node_recursive tests.
    ///
    /// Creates a tree with the given root ID and child IDs (single level).
    fn make_scene_node(id: &str, child_ids: &[&str]) -> SceneNode {
        SceneNode {
            id: id.to_string(),
            children: child_ids
                .iter()
                .map(|cid| Arc::new(make_scene_node(cid, &[])))
                .collect(),
            ..Default::default()
        }
    }

    /// context_globally_dirty() returns false when only scene_structure_dirty
    /// is set — the CORE decoupling that enables incremental binding evaluation
    /// for structure changes. (Task 167 Phase A)
    #[test]
    fn t167_context_globally_dirty_false_when_only_structure_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_scene_structure();
        assert!(
            !tracker.context_globally_dirty(false),
            "scene_structure_dirty alone must NOT trigger context_globally_dirty"
        );
    }

    /// context_globally_dirty() returns true when fsm_dirty is set
    /// (unchanged behavior — regression guard). (Task 167 Phase A)
    #[test]
    fn t167_context_globally_dirty_true_when_fsm_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm();
        assert!(
            tracker.context_globally_dirty(false),
            "fsm_dirty must still trigger context_globally_dirty"
        );
    }

    /// context_globally_dirty() returns true when routing_dirty is set
    /// (unchanged behavior — regression guard). (Task 167 Phase A)
    #[test]
    fn t167_context_globally_dirty_true_when_routing_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_routing();
        assert!(
            tracker.context_globally_dirty(false),
            "routing_dirty must still trigger context_globally_dirty"
        );
    }

    /// context_globally_dirty() returns true when ambient_dirty is set
    /// (unchanged behavior — regression guard). (Task 167 Phase A)
    #[test]
    fn t167_context_globally_dirty_true_when_ambient_dirty() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_ambient();
        assert!(
            tracker.context_globally_dirty(false),
            "ambient_dirty must still trigger context_globally_dirty"
        );
    }

    /// mark_node_recursive() on a leaf node adds only that node's ID
    /// to dirty_nodes. (Task 167 Phase A)
    #[test]
    fn t167_mark_node_recursive_leaf_adds_only_self() {
        let mut tracker = DirtyTracker::default();
        let leaf = make_scene_node("leaf-1", &[]);
        tracker.mark_node_recursive(&leaf);

        assert!(tracker.anything_dirty, "anything_dirty must be true");
        assert_eq!(
            tracker.dirty_nodes.len(),
            1,
            "only one node should be dirty"
        );
        assert!(
            tracker.dirty_nodes.contains("leaf-1"),
            "leaf ID must be in dirty_nodes"
        );
    }

    /// mark_node_recursive() on a root adds the root AND all descendants
    /// to dirty_nodes. (Task 167 Phase A)
    #[test]
    fn t167_mark_node_recursive_adds_all_descendants() {
        let mut tracker = DirtyTracker::default();
        // Build: root -> [child-a, child-b -> [grandchild-b1]]
        let grandchild = make_scene_node("grandchild-b1", &[]);
        let child_a = make_scene_node("child-a", &[]);
        let child_b = SceneNode {
            id: "child-b".to_string(),
            children: vec![Arc::new(grandchild)],
            ..Default::default()
        };
        let root = SceneNode {
            id: "root".to_string(),
            children: vec![Arc::new(child_a), Arc::new(child_b)],
            ..Default::default()
        };

        tracker.mark_node_recursive(&root);

        assert!(tracker.anything_dirty, "anything_dirty must be true");
        assert_eq!(
            tracker.dirty_nodes.len(),
            4,
            "root + 2 children + 1 grandchild = 4"
        );
        assert!(tracker.dirty_nodes.contains("root"), "root must be dirty");
        assert!(
            tracker.dirty_nodes.contains("child-a"),
            "child-a must be dirty"
        );
        assert!(
            tracker.dirty_nodes.contains("child-b"),
            "child-b must be dirty"
        );
        assert!(
            tracker.dirty_nodes.contains("grandchild-b1"),
            "grandchild-b1 must be dirty"
        );
    }

    /// mark_node_recursive() on root adds root ID to dirty_nodes.
    /// (Explicit root-level check.) (Task 167 Phase A)
    #[test]
    fn t167_mark_node_recursive_adds_root_id() {
        let mut tracker = DirtyTracker::default();
        let node = make_scene_node("inserted-root", &["child-1", "child-2"]);
        tracker.mark_node_recursive(&node);

        assert!(
            tracker.dirty_nodes.contains("inserted-root"),
            "root node ID must be in dirty_nodes"
        );
    }

    /// After mark_scene_structure() + mark_node_recursive(), the system
    /// enters incremental compute path (context_globally_dirty=false,
    /// dirty_nodes non-empty). This simulates the InsertNode flow. (Task 167 Phase A)
    #[test]
    fn t167_insert_node_flow_uses_incremental_compute() {
        let mut tracker = DirtyTracker::default();

        // Simulate InsertNode: mark structure + mark new subtree
        tracker.mark_scene_structure();
        let new_node = make_scene_node("new-node", &["new-child"]);
        tracker.mark_node_recursive(&new_node);

        // Binding evaluation IS needed (new nodes need eval)
        assert!(
            tracker.needs_binding_eval(),
            "needs_binding_eval must be true"
        );
        // But context is NOT globally dirty (no FSM/routing/ambient change)
        assert!(
            !tracker.context_globally_dirty(false),
            "context_globally_dirty must be false — structure change with no context change"
        );
        // Layout IS needed (structure changed)
        assert!(
            tracker.needs_layout(),
            "needs_layout must be true — structure changed"
        );
        // scene_structure_dirty IS set (used by force_full_layout)
        assert!(
            tracker.is_scene_structure_dirty(),
            "scene_structure_dirty must be true — InsertNode sets it"
        );
        // dirty_nodes contains the new subtree
        assert!(
            tracker.dirty_nodes.contains("new-node"),
            "new node must be in dirty_nodes"
        );
        assert!(
            tracker.dirty_nodes.contains("new-child"),
            "new child must be in dirty_nodes"
        );
    }

    /// scene_structure_dirty forces full layout even when context_globally_dirty
    /// is false. This verifies the flag is available for force_full_layout checks
    /// in mod.rs. (Task 167 Phase A)
    #[test]
    fn t167_scene_structure_dirty_forces_layout_not_binding_eval() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_scene_structure();

        // Layout: YES (structure changed)
        assert!(tracker.needs_layout(), "structure change must need layout");
        assert!(
            tracker.is_scene_structure_dirty(),
            "scene_structure_dirty must be set"
        );
        // Full binding eval: NO (context hasn't changed)
        assert!(
            !tracker.context_globally_dirty(false),
            "structure-only change must not trigger global binding eval"
        );
    }

    /// Full lifecycle simulating InsertNode: insert → render → only new nodes
    /// evaluated, existing nodes skip. Verified via dirty_nodes set state
    /// at each phase. (Task 167 Phase A)
    #[test]
    fn t167_full_lifecycle_insert_render_incremental() {
        let mut tracker = DirtyTracker::new();

        // Phase 1: First render (fully dirty)
        assert!(!tracker.is_clean(), "new tracker must be dirty");
        assert!(
            tracker.context_globally_dirty(false),
            "first render: all context flags set → globally dirty"
        );
        tracker.clear(); // Simulate render() clearing flags

        // Phase 2: Between frames — InsertNode arrives
        assert!(tracker.is_clean(), "must be clean after clear");
        tracker.mark_scene_structure();
        let new_subtree = make_scene_node("inserted", &["inserted-child-1", "inserted-child-2"]);
        tracker.mark_node_recursive(&new_subtree);

        // Phase 3: render() checks
        // Binding eval needed (dirty_nodes non-empty) but NOT globally dirty
        assert!(
            !tracker.context_globally_dirty(false),
            "only structure changed — incremental binding eval"
        );
        assert!(
            tracker.needs_binding_eval(),
            "dirty_nodes non-empty → eval needed"
        );
        assert_eq!(
            tracker.dirty_nodes.len(),
            3,
            "exactly 3 nodes dirty: inserted + 2 children"
        );
        assert!(tracker.dirty_nodes.contains("inserted"));
        assert!(tracker.dirty_nodes.contains("inserted-child-1"));
        assert!(tracker.dirty_nodes.contains("inserted-child-2"));

        // Layout: full (scene_structure_dirty)
        assert!(tracker.needs_layout(), "structure change needs layout");
        assert!(
            tracker.is_scene_structure_dirty(),
            "scene_structure_dirty available for force_full_layout"
        );

        // Phase 4: render() completes
        tracker.clear();
        assert!(tracker.is_clean(), "clean after render");
        assert!(
            tracker.dirty_nodes.is_empty(),
            "dirty_nodes empty after clear"
        );
        assert!(
            !tracker.is_scene_structure_dirty(),
            "flags cleared after render"
        );
    }

    /// mark_node_recursive() combined with existing mark_node() — both types
    /// of dirty marking coexist in the dirty_nodes set. (Task 167 Phase A)
    #[test]
    fn t167_mark_node_recursive_coexists_with_mark_node() {
        let mut tracker = DirtyTracker::default();

        // Pre-existing dirty node (e.g., from UpdateProps)
        tracker.mark_node("existing-node-1");

        // New subtree inserted
        let new_node = make_scene_node("new-node", &["new-child"]);
        tracker.mark_node_recursive(&new_node);

        assert_eq!(
            tracker.dirty_nodes.len(),
            3,
            "1 existing + 1 new root + 1 new child = 3"
        );
        assert!(tracker.dirty_nodes.contains("existing-node-1"));
        assert!(tracker.dirty_nodes.contains("new-node"));
        assert!(tracker.dirty_nodes.contains("new-child"));
    }

    // ========================================================================
    // Task 167 Phase C: Key-Scoped Dirty + Binding Dependency Index Tests
    //
    // These tests verify:
    // 1. Key-scoped dirty sets track WHICH specific keys changed
    // 2. BindingDepIndex records and resolves dependencies correctly
    // 3. context_globally_dirty() respects has_dep_index parameter
    // 4. Wildcard handling works for both dirty keys and dep entries
    // ========================================================================

    /// mark_fsm_key() adds a specific key to fsm_dirty_keys.
    #[test]
    fn t167c_mark_fsm_key_adds_specific_key() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm_key("fsm:editor:main");

        assert!(tracker.anything_dirty, "anything_dirty must be true");
        assert!(tracker.fsm_dirty, "fsm_dirty bool must be true");
        assert!(tracker.fsm_dirty_keys.contains("fsm:editor:main"));
        assert_eq!(
            tracker.fsm_dirty_keys.len(),
            1,
            "only one key should be tracked"
        );
        // No wildcard
        assert!(
            !tracker.fsm_dirty_keys.contains("*"),
            "mark_fsm_key must not insert wildcard"
        );
    }

    /// fsm_dirty_keys tracks which FSM keys changed across multiple calls.
    #[test]
    fn t167c_fsm_dirty_keys_tracks_multiple() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm_key("fsm:editor:main");
        tracker.mark_fsm_key("fsm:toolbar:mode");

        assert_eq!(tracker.fsm_dirty_keys.len(), 2);
        assert!(tracker.fsm_dirty_keys.contains("fsm:editor:main"));
        assert!(tracker.fsm_dirty_keys.contains("fsm:toolbar:mode"));
    }

    /// mark_routing_origin() tracks which routing origins changed.
    #[test]
    fn t167c_routing_dirty_origins_tracks_specific() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_routing_origin("pointer:0");

        assert!(tracker.routing_dirty, "routing_dirty bool must be true");
        assert!(tracker.routing_dirty_origins.contains("pointer:0"));
        assert_eq!(tracker.routing_dirty_origins.len(), 1);
        assert!(!tracker.routing_dirty_origins.contains("*"));
    }

    /// mark_ambient_key() tracks which ambient keys changed.
    #[test]
    fn t167c_ambient_dirty_keys_tracks_specific() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_ambient_key("session_text_origin");

        assert!(tracker.ambient_dirty, "ambient_dirty bool must be true");
        assert!(tracker.ambient_dirty_keys.contains("session_text_origin"));
        assert_eq!(tracker.ambient_dirty_keys.len(), 1);
        assert!(!tracker.ambient_dirty_keys.contains("*"));
    }

    /// context_globally_dirty(has_dep_index=true) returns false even when
    /// context flags are set — scoped resolution handles it.
    #[test]
    fn t167c_context_globally_dirty_false_with_dep_index() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm_key("fsm:editor:main");
        tracker.mark_routing_origin("pointer:0");

        assert!(tracker.fsm_dirty, "fsm_dirty must be set");
        assert!(
            !tracker.context_globally_dirty(true),
            "with dep index, context_globally_dirty must return false \
             even when context flags are set — scoped resolution handles it"
        );
    }

    /// context_globally_dirty(has_dep_index=false) returns true when keys dirty —
    /// full evaluation needed without dep index.
    #[test]
    fn t167c_context_globally_dirty_true_without_dep_index() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm_key("fsm:editor:main");

        assert!(
            tracker.context_globally_dirty(false),
            "without dep index, context_globally_dirty must return true \
             when any context flag is set — safe fallback to full eval"
        );
    }

    /// context_globally_dirty returns false when no keys dirty regardless
    /// of has_dep_index — nothing changed, nothing to evaluate.
    #[test]
    fn t167c_context_globally_dirty_false_when_clean() {
        let tracker = DirtyTracker::default();
        assert!(
            !tracker.context_globally_dirty(false),
            "clean + no dep index = false"
        );
        assert!(
            !tracker.context_globally_dirty(true),
            "clean + dep index = false"
        );
    }

    /// clear() empties all key-scoped dirty sets.
    #[test]
    fn t167c_clear_empties_key_sets() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_fsm_key("fsm:editor:main");
        tracker.mark_routing_origin("pointer:0");
        tracker.mark_ambient_key("session_text_origin");

        assert!(!tracker.fsm_dirty_keys.is_empty());
        assert!(!tracker.routing_dirty_origins.is_empty());
        assert!(!tracker.ambient_dirty_keys.is_empty());

        tracker.clear();

        assert!(
            tracker.fsm_dirty_keys.is_empty(),
            "fsm_dirty_keys must be empty after clear"
        );
        assert!(
            tracker.routing_dirty_origins.is_empty(),
            "routing_dirty_origins must be empty after clear"
        );
        assert!(
            tracker.ambient_dirty_keys.is_empty(),
            "ambient_dirty_keys must be empty after clear"
        );
    }

    /// BindingDepIndex records node → dep key mappings bidirectionally.
    #[test]
    fn t167c_dep_index_records_bidirectional() {
        let mut index = BindingDepIndex::new();
        index.record("node-1", DepKey::Fsm("fsm:editor:main".to_string()));
        index.record("node-1", DepKey::Routing("pointer:0".to_string()));
        index.record("node-2", DepKey::Fsm("fsm:editor:main".to_string()));

        // Forward: dep → nodes (via test helper, replaces deleted dep_to_nodes shim)
        let fsm_nodes = index.nodes_for_dep(&DepKey::Fsm("fsm:editor:main".to_string()));
        assert!(fsm_nodes.contains("node-1"));
        assert!(fsm_nodes.contains("node-2"));
        assert_eq!(fsm_nodes.len(), 2);

        let routing_nodes = index.nodes_for_dep(&DepKey::Routing("pointer:0".to_string()));
        assert!(routing_nodes.contains("node-1"));

        // Reverse: node → deps (via test helper, replaces deleted node_to_deps shim)
        let node1_deps = index.deps_for_node("node-1");
        assert!(node1_deps.contains(&DepKey::Fsm("fsm:editor:main".to_string())));
        assert!(node1_deps.contains(&DepKey::Routing("pointer:0".to_string())));
        assert_eq!(node1_deps.len(), 2);

        let node2_deps = index.deps_for_node("node-2");
        assert!(node2_deps.contains(&DepKey::Fsm("fsm:editor:main".to_string())));
        assert_eq!(node2_deps.len(), 1);
    }

    /// BindingDepIndex resolves specific dep key to affected node IDs.
    #[test]
    fn t167c_dep_index_resolves_specific_keys() {
        let mut index = BindingDepIndex::new();
        index.record("node-1", DepKey::Fsm("fsm:editor:main".to_string()));
        index.record("node-2", DepKey::Fsm("fsm:toolbar:mode".to_string()));
        index.record("node-3", DepKey::Routing("pointer:0".to_string()));

        let mut fsm_keys = HashSet::new();
        fsm_keys.insert("fsm:editor:main".to_string());
        let empty = HashSet::new();

        let no_ambient = HashMap::new();
        let affected = index.resolve_dirty_nodes(&fsm_keys, &empty, &empty, &empty, &no_ambient);
        assert!(
            affected.contains("node-1"),
            "node-1 depends on fsm:editor:main"
        );
        assert!(
            !affected.contains("node-2"),
            "node-2 depends on DIFFERENT fsm key"
        );
        assert!(
            !affected.contains("node-3"),
            "node-3 depends on routing, not fsm"
        );
    }

    /// resolve_dirty_nodes includes from:scene dependents when scene_structure_dirty.
    #[test]
    fn t167c_resolve_includes_scene_deps_when_structure_dirty() {
        let mut index = BindingDepIndex::new();
        index.record("node-1", DepKey::Scene("layout:editor:hud".to_string()));
        index.record("node-2", DepKey::Fsm("fsm:editor:main".to_string()));

        let empty = HashSet::new();
        let no_ambient = HashMap::new();
        let mut structure_all = HashSet::new();
        structure_all.insert("*".to_string());
        let affected =
            index.resolve_dirty_nodes(&empty, &empty, &empty, &structure_all, &no_ambient);

        assert!(
            affected.contains("node-1"),
            "scene-dependent node must be included when structure dirty"
        );
        assert!(
            !affected.contains("node-2"),
            "FSM-dependent node must NOT be included by structure dirty alone"
        );
    }

    /// resolve_dirty_nodes with wildcard fsm key includes ALL FSM-dependent nodes.
    #[test]
    fn t167c_resolve_wildcard_fsm_includes_all() {
        let mut index = BindingDepIndex::new();
        index.record("node-1", DepKey::Fsm("fsm:editor:main".to_string()));
        index.record("node-2", DepKey::Fsm("fsm:toolbar:mode".to_string()));
        index.record("node-3", DepKey::Routing("pointer:0".to_string()));

        let mut fsm_keys = HashSet::new();
        fsm_keys.insert("*".to_string()); // Wildcard — ALL FSM keys
        let empty = HashSet::new();

        let no_ambient = HashMap::new();
        let affected = index.resolve_dirty_nodes(&fsm_keys, &empty, &empty, &empty, &no_ambient);
        assert!(
            affected.contains("node-1"),
            "all FSM nodes must be included with wildcard"
        );
        assert!(
            affected.contains("node-2"),
            "all FSM nodes must be included with wildcard"
        );
        assert!(
            !affected.contains("node-3"),
            "routing node must NOT be included by FSM wildcard"
        );
    }

    /// Multi-key dirty: FSM key + routing origin → union of affected nodes.
    #[test]
    fn t167c_multi_key_dirty_produces_union() {
        let mut index = BindingDepIndex::new();
        index.record("node-1", DepKey::Fsm("fsm:editor:main".to_string()));
        index.record("node-2", DepKey::Routing("pointer:0".to_string()));
        index.record("node-3", DepKey::Ambient("session_text_origin".to_string()));

        let mut fsm_keys = HashSet::new();
        fsm_keys.insert("fsm:editor:main".to_string());
        let mut routing = HashSet::new();
        routing.insert("pointer:0".to_string());
        let empty = HashSet::new();

        let no_ambient = HashMap::new();
        let affected = index.resolve_dirty_nodes(&fsm_keys, &routing, &empty, &empty, &no_ambient);
        assert!(affected.contains("node-1"), "FSM-dependent node in union");
        assert!(
            affected.contains("node-2"),
            "routing-dependent node in union"
        );
        assert!(
            !affected.contains("node-3"),
            "ambient node not in dirty set"
        );
        assert_eq!(affected.len(), 2);
    }

    /// Nodes with wildcard deps (dynamic key bindings) are included
    /// when any key of that source type is dirty.
    #[test]
    fn t167c_wildcard_dep_nodes_included_on_any_dirty() {
        let mut index = BindingDepIndex::new();
        // node-1 has a dynamic key binding (wildcard dep)
        index.record("node-1", DepKey::Fsm("*".to_string()));
        // node-2 has a specific key binding
        index.record("node-2", DepKey::Fsm("fsm:editor:main".to_string()));

        let mut fsm_keys = HashSet::new();
        fsm_keys.insert("fsm:toolbar:mode".to_string()); // Different specific key
        let empty = HashSet::new();

        let no_ambient = HashMap::new();
        let affected = index.resolve_dirty_nodes(&fsm_keys, &empty, &empty, &empty, &no_ambient);
        assert!(
            affected.contains("node-1"),
            "wildcard-dep node must be included when ANY FSM key is dirty"
        );
        assert!(
            !affected.contains("node-2"),
            "specific-dep node must NOT be included for non-matching key"
        );
    }

    /// mark_fsm() (old API) inserts wildcard, mark_fsm_key() inserts specific key.
    /// Both set fsm_dirty=true and populate fsm_dirty_keys.
    #[test]
    fn t167c_mark_fsm_vs_mark_fsm_key() {
        let mut tracker1 = DirtyTracker::default();
        tracker1.mark_fsm();
        assert!(tracker1.fsm_dirty);
        assert!(
            tracker1.fsm_dirty_keys.contains("*"),
            "mark_fsm inserts wildcard"
        );

        let mut tracker2 = DirtyTracker::default();
        tracker2.mark_fsm_key("fsm:editor:main");
        assert!(tracker2.fsm_dirty);
        assert!(tracker2.fsm_dirty_keys.contains("fsm:editor:main"));
        assert!(
            !tracker2.fsm_dirty_keys.contains("*"),
            "mark_fsm_key does not insert wildcard"
        );
    }

    /// new() populates key-scoped sets with wildcards (first render = fully dirty).
    #[test]
    fn t167c_new_populates_key_sets_with_wildcards() {
        let tracker = DirtyTracker::new();
        assert!(
            tracker.fsm_dirty_keys.contains("*"),
            "new() must have wildcard in fsm_dirty_keys"
        );
        assert!(
            tracker.routing_dirty_origins.contains("*"),
            "new() must have wildcard in routing_dirty_origins"
        );
        assert!(
            tracker.ambient_dirty_keys.contains("*"),
            "new() must have wildcard in ambient_dirty_keys"
        );
    }

    /// dep_count() and node_count() report correct sizes.
    #[test]
    fn t167c_dep_index_counts() {
        let mut index = BindingDepIndex::new();
        assert_eq!(index.dep_count(), 0);
        assert_eq!(index.node_count(), 0);

        index.record("node-1", DepKey::Fsm("key-a".to_string()));
        index.record("node-1", DepKey::Routing("origin-b".to_string()));
        index.record("node-2", DepKey::Fsm("key-a".to_string()));

        assert_eq!(index.dep_count(), 2, "2 unique dep keys");
        assert_eq!(index.node_count(), 2, "2 unique nodes");
    }

    // ========================================================================
    // Task 199: Routing Dependency Precision Tests
    //
    // These tests verify that DepKey::RoutingViaAmbient produces precise
    // dirtying via ambient-key resolution at dirty-resolution time, instead
    // of wildcard dirtying all routing-dependent nodes.
    // ========================================================================

    /// RoutingViaAmbient resolves ambient key to actual routing key and
    /// dirties the node when the resolved key matches a dirty routing origin.
    #[test]
    fn t199_resolve_routing_via_ambient_match() {
        let mut index = BindingDepIndex::new();
        index.record(
            "node-1",
            DepKey::RoutingViaAmbient("session_text_origin".to_string()),
        );

        let mut routing = HashSet::new();
        routing.insert("origin:host:text:0".to_string());
        let empty = HashSet::new();

        // Ambient state: session_text_origin = "origin:host:text:0"
        let mut ambient = HashMap::new();
        ambient.insert(
            "session_text_origin".to_string(),
            serde_json::Value::String("origin:host:text:0".to_string()),
        );

        let affected = index.resolve_dirty_nodes(&empty, &routing, &empty, &empty, &ambient);
        assert!(
            affected.contains("node-1"),
            "node-1's ambient resolves to matching routing origin — must be dirtied"
        );
    }

    /// RoutingViaAmbient does NOT dirty node when resolved key differs from
    /// the dirty routing origin.
    #[test]
    fn t199_resolve_routing_via_ambient_no_match() {
        let mut index = BindingDepIndex::new();
        index.record(
            "node-1",
            DepKey::RoutingViaAmbient("session_text_origin".to_string()),
        );

        let mut routing = HashSet::new();
        routing.insert("origin:host:keyboard:0".to_string()); // Different origin
        let empty = HashSet::new();

        // Ambient resolves to a DIFFERENT origin than what changed
        let mut ambient = HashMap::new();
        ambient.insert(
            "session_text_origin".to_string(),
            serde_json::Value::String("origin:host:text:0".to_string()),
        );

        let affected = index.resolve_dirty_nodes(&empty, &routing, &empty, &empty, &ambient);
        assert!(
            !affected.contains("node-1"),
            "resolved key does not match dirty origin — node must NOT be dirtied"
        );
    }

    /// RoutingViaAmbient does NOT dirty node when ambient key is missing from state.
    #[test]
    fn t199_resolve_routing_via_ambient_missing_ambient() {
        let mut index = BindingDepIndex::new();
        index.record(
            "node-1",
            DepKey::RoutingViaAmbient("nonexistent_key".to_string()),
        );

        let mut routing = HashSet::new();
        routing.insert("origin:host:text:0".to_string());
        let empty = HashSet::new();

        // Empty ambient state — key cannot be resolved
        let ambient = HashMap::new();

        let affected = index.resolve_dirty_nodes(&empty, &routing, &empty, &empty, &ambient);
        assert!(
            !affected.contains("node-1"),
            "ambient key missing from state — node must NOT be dirtied"
        );
    }

    /// Routing wildcard ("*") still dirties ALL routing-dependent nodes
    /// including RoutingViaAmbient nodes (no regression).
    #[test]
    fn t199_routing_wildcard_still_dirties_all() {
        let mut index = BindingDepIndex::new();
        index.record("node-concrete", DepKey::Routing("origin:a".to_string()));
        index.record("node-wildcard", DepKey::Routing("*".to_string()));
        index.record(
            "node-via-ambient",
            DepKey::RoutingViaAmbient("session_text_origin".to_string()),
        );

        let mut routing = HashSet::new();
        routing.insert("*".to_string()); // Wildcard — ALL routing
        let empty = HashSet::new();
        let ambient = HashMap::new(); // No ambient needed for wildcard

        let affected = index.resolve_dirty_nodes(&empty, &routing, &empty, &empty, &ambient);
        assert!(
            affected.contains("node-concrete"),
            "concrete routing node must be dirtied by wildcard"
        );
        assert!(
            affected.contains("node-wildcard"),
            "wildcard-dep routing node must be dirtied"
        );
        assert!(
            affected.contains("node-via-ambient"),
            "via-ambient routing node must be dirtied by wildcard"
        );
    }

    /// Mixed routing deps: some via-ambient, some direct → correct dirtying for each.
    #[test]
    fn t199_mixed_routing_deps() {
        let mut index = BindingDepIndex::new();
        // Node with concrete routing key
        index.record(
            "node-direct",
            DepKey::Routing("origin:host:text:0".to_string()),
        );
        // Node with ambient-sourced routing key resolving to same origin
        index.record(
            "node-ambient",
            DepKey::RoutingViaAmbient("session_text_origin".to_string()),
        );
        // Node with ambient-sourced routing key resolving to DIFFERENT origin
        index.record(
            "node-other",
            DepKey::RoutingViaAmbient("session_keyboard_origin".to_string()),
        );

        let mut routing = HashSet::new();
        routing.insert("origin:host:text:0".to_string());
        let empty = HashSet::new();

        let mut ambient = HashMap::new();
        ambient.insert(
            "session_text_origin".to_string(),
            serde_json::Value::String("origin:host:text:0".to_string()),
        );
        ambient.insert(
            "session_keyboard_origin".to_string(),
            serde_json::Value::String("origin:host:keyboard:0".to_string()),
        );

        let affected = index.resolve_dirty_nodes(&empty, &routing, &empty, &empty, &ambient);
        assert!(
            affected.contains("node-direct"),
            "direct routing match — dirtied"
        );
        assert!(
            affected.contains("node-ambient"),
            "ambient resolves to matching origin — dirtied"
        );
        assert!(
            !affected.contains("node-other"),
            "ambient resolves to different origin — NOT dirtied"
        );
    }

    /// Multiple ambient routing nodes with different ambient keys —
    /// only the node whose ambient key resolves to the dirty origin is dirtied.
    #[test]
    fn t199_multiple_ambient_routing_nodes() {
        let mut index = BindingDepIndex::new();
        index.record(
            "text-node",
            DepKey::RoutingViaAmbient("session_text_origin".to_string()),
        );
        index.record(
            "keyboard-node",
            DepKey::RoutingViaAmbient("session_keyboard_origin".to_string()),
        );
        index.record(
            "pointer-node",
            DepKey::RoutingViaAmbient("session_pointer_origin".to_string()),
        );
        index.record(
            "gamepad-node",
            DepKey::RoutingViaAmbient("session_gamepad_origin".to_string()),
        );
        index.record(
            "pen-node",
            DepKey::RoutingViaAmbient("session_pen_origin".to_string()),
        );

        let mut routing = HashSet::new();
        routing.insert("origin:host:text:0".to_string());
        let empty = HashSet::new();

        let mut ambient = HashMap::new();
        ambient.insert(
            "session_text_origin".to_string(),
            serde_json::json!("origin:host:text:0"),
        );
        ambient.insert(
            "session_keyboard_origin".to_string(),
            serde_json::json!("origin:host:keyboard:0"),
        );
        ambient.insert(
            "session_pointer_origin".to_string(),
            serde_json::json!("origin:host:pointer:0"),
        );
        ambient.insert(
            "session_gamepad_origin".to_string(),
            serde_json::json!("origin:host:gamepad:0"),
        );
        ambient.insert(
            "session_pen_origin".to_string(),
            serde_json::json!("origin:host:pen:0"),
        );

        let affected = index.resolve_dirty_nodes(&empty, &routing, &empty, &empty, &ambient);
        assert_eq!(
            affected.len(),
            1,
            "only 1 of 5 ambient routing nodes should match"
        );
        assert!(
            affected.contains("text-node"),
            "text-node resolves to matching origin"
        );
    }

    /// Direct routing key still works unchanged (no regression).
    #[test]
    fn t199_routing_direct_key_still_works() {
        let mut index = BindingDepIndex::new();
        index.record("node-1", DepKey::Routing("origin:host:text:0".to_string()));

        let mut routing = HashSet::new();
        routing.insert("origin:host:text:0".to_string());
        let empty = HashSet::new();
        let ambient = HashMap::new();

        let affected = index.resolve_dirty_nodes(&empty, &routing, &empty, &empty, &ambient);
        assert!(
            affected.contains("node-1"),
            "direct routing key must still resolve correctly"
        );
    }

    /// Non-string ambient value cannot match — node is not dirtied.
    #[test]
    fn t199_non_string_ambient_value_not_matched() {
        let mut index = BindingDepIndex::new();
        index.record(
            "node-1",
            DepKey::RoutingViaAmbient("numeric_key".to_string()),
        );

        let mut routing = HashSet::new();
        routing.insert("42".to_string());
        let empty = HashSet::new();

        let mut ambient = HashMap::new();
        ambient.insert("numeric_key".to_string(), serde_json::json!(42)); // Number, not string

        let affected = index.resolve_dirty_nodes(&empty, &routing, &empty, &empty, &ambient);
        assert!(
            !affected.contains("node-1"),
            "non-string ambient value cannot match routing origin — node NOT dirtied"
        );
    }

    /// Adversarial scale: 1000 routing-via-ambient nodes, 1 route change →
    /// only matching nodes dirtied, NOT all 1000. (L064)
    #[test]
    fn t199_adversarial_1000_routing_nodes() {
        let mut index = BindingDepIndex::new();
        let mut ambient = HashMap::new();

        // Create 1000 nodes, each with a different ambient key resolving to a different origin
        for i in 0..1000 {
            let node_id = format!("node-{}", i);
            let ambient_key = format!("session_origin_{}", i);
            let origin = format!("origin:host:input:{}", i);
            index.record(&node_id, DepKey::RoutingViaAmbient(ambient_key.clone()));
            ambient.insert(ambient_key, serde_json::Value::String(origin));
        }

        // Only origin 42 changed
        let mut routing = HashSet::new();
        routing.insert("origin:host:input:42".to_string());
        let empty = HashSet::new();

        let affected = index.resolve_dirty_nodes(&empty, &routing, &empty, &empty, &ambient);
        assert_eq!(affected.len(), 1, "only 1 of 1000 nodes should be dirtied");
        assert!(
            affected.contains("node-42"),
            "only node-42 resolves to the dirty origin"
        );
    }

    /// Empty routing origins → no RoutingViaAmbient nodes dirtied
    /// (guard clause prevents unnecessary iteration).
    #[test]
    fn t199_empty_routing_origins_skips_via_ambient() {
        let mut index = BindingDepIndex::new();
        index.record(
            "node-1",
            DepKey::RoutingViaAmbient("session_text_origin".to_string()),
        );

        let empty = HashSet::new();
        let mut ambient = HashMap::new();
        ambient.insert(
            "session_text_origin".to_string(),
            serde_json::Value::String("origin:host:text:0".to_string()),
        );

        let affected = index.resolve_dirty_nodes(&empty, &empty, &empty, &empty, &ambient);
        assert!(
            !affected.contains("node-1"),
            "no routing origins dirty → via-ambient node must NOT be dirtied"
        );
    }

    // ========================================================================
    // Task 198: Ancestor Dirty Set Tests
    //
    // These tests verify compute_ancestor_set() correctness and the O(dirty-path)
    // traversal optimization it enables.
    // ========================================================================

    use super::compute_ancestor_set;

    /// Helper: Build a multi-level SceneNode tree using Arc children.
    ///
    /// Tree structure:
    /// ```text
    ///         root
    ///        /    \
    ///     left    right
    ///    /   \       \
    ///  ll    lr      rr
    /// ```
    fn make_ancestor_tree() -> Arc<SceneNode> {
        let ll = Arc::new(SceneNode {
            id: "ll".into(),
            ..Default::default()
        });
        let lr = Arc::new(SceneNode {
            id: "lr".into(),
            ..Default::default()
        });
        let rr = Arc::new(SceneNode {
            id: "rr".into(),
            ..Default::default()
        });
        let left = Arc::new(SceneNode {
            id: "left".into(),
            children: vec![ll, lr],
            ..Default::default()
        });
        let right = Arc::new(SceneNode {
            id: "right".into(),
            children: vec![rr],
            ..Default::default()
        });
        Arc::new(SceneNode {
            id: "root".into(),
            children: vec![left, right],
            ..Default::default()
        })
    }

    /// Single dirty leaf: ancestor set contains the spine from root to that leaf.
    #[test]
    fn t198_ancestor_set_single_dirty_leaf() {
        let root = make_ancestor_tree();
        let dirty = HashSet::from(["ll".to_string()]);
        let ancestors = compute_ancestor_set(&root, &dirty);

        // Spine: root -> left -> ll
        assert!(
            ancestors.contains("root"),
            "root must be ancestor of dirty leaf"
        );
        assert!(
            ancestors.contains("left"),
            "left must be ancestor of dirty leaf ll"
        );
        assert!(
            ancestors.contains("ll"),
            "dirty node itself must be in ancestor set"
        );
        // Not on the spine:
        assert!(
            !ancestors.contains("lr"),
            "sibling lr must NOT be in ancestor set"
        );
        assert!(
            !ancestors.contains("right"),
            "right subtree must NOT be in ancestor set"
        );
        assert!(!ancestors.contains("rr"), "rr must NOT be in ancestor set");
        assert_eq!(ancestors.len(), 3);
    }

    /// Two dirty leaves in different subtrees: union of both spines.
    #[test]
    fn t198_ancestor_set_multiple_dirty_leaves() {
        let root = make_ancestor_tree();
        let dirty = HashSet::from(["ll".to_string(), "rr".to_string()]);
        let ancestors = compute_ancestor_set(&root, &dirty);

        // Spine to ll: root -> left -> ll
        // Spine to rr: root -> right -> rr
        assert!(ancestors.contains("root"), "root on both spines");
        assert!(ancestors.contains("left"), "left on ll's spine");
        assert!(ancestors.contains("ll"), "ll is dirty");
        assert!(ancestors.contains("right"), "right on rr's spine");
        assert!(ancestors.contains("rr"), "rr is dirty");
        // lr is not on either spine
        assert!(!ancestors.contains("lr"), "lr not on any dirty spine");
        assert_eq!(ancestors.len(), 5);
    }

    /// Empty dirty set: ancestor set is empty.
    #[test]
    fn t198_ancestor_set_empty_dirty() {
        let root = make_ancestor_tree();
        let dirty = HashSet::new();
        let ancestors = compute_ancestor_set(&root, &dirty);
        assert!(ancestors.is_empty(), "no dirty nodes -> no ancestors");
    }

    /// Root is dirty: ancestor set contains only root (no descendants dirty).
    #[test]
    fn t198_ancestor_set_root_dirty() {
        let root = make_ancestor_tree();
        let dirty = HashSet::from(["root".to_string()]);
        let ancestors = compute_ancestor_set(&root, &dirty);

        assert!(
            ancestors.contains("root"),
            "dirty root must be in ancestor set"
        );
        assert_eq!(
            ancestors.len(),
            1,
            "only root is dirty -- no descendant spines"
        );
    }

    /// Dirty sibling: only the dirty sibling's spine is in ancestor set.
    #[test]
    fn t198_ancestor_set_sibling_dirty() {
        let root = make_ancestor_tree();
        let dirty = HashSet::from(["lr".to_string()]);
        let ancestors = compute_ancestor_set(&root, &dirty);

        // Spine: root -> left -> lr
        assert!(ancestors.contains("root"));
        assert!(ancestors.contains("left"));
        assert!(ancestors.contains("lr"));
        // Clean siblings/subtrees:
        assert!(
            !ancestors.contains("ll"),
            "clean sibling ll must NOT be in set"
        );
        assert!(
            !ancestors.contains("right"),
            "clean subtree right must NOT be in set"
        );
        assert!(
            !ancestors.contains("rr"),
            "clean subtree rr must NOT be in set"
        );
        assert_eq!(ancestors.len(), 3);
    }

    /// Dirty node not in tree: ancestor set is empty (no node matches).
    #[test]
    fn t198_ancestor_set_nonexistent_dirty_node() {
        let root = make_ancestor_tree();
        let dirty = HashSet::from(["nonexistent".to_string()]);
        let ancestors = compute_ancestor_set(&root, &dirty);
        assert!(
            ancestors.is_empty(),
            "dirty node not in tree -> empty ancestor set"
        );
    }

    /// All leaves dirty: entire tree is in ancestor set.
    #[test]
    fn t198_ancestor_set_all_leaves_dirty() {
        let root = make_ancestor_tree();
        let dirty = HashSet::from(["ll".to_string(), "lr".to_string(), "rr".to_string()]);
        let ancestors = compute_ancestor_set(&root, &dirty);

        assert!(ancestors.contains("root"));
        assert!(ancestors.contains("left"));
        assert!(ancestors.contains("right"));
        assert!(ancestors.contains("ll"));
        assert!(ancestors.contains("lr"));
        assert!(ancestors.contains("rr"));
        assert_eq!(ancestors.len(), 6);
    }

    /// Adversarial deep tree with single dirty leaf: ancestor set size equals depth.
    #[test]
    fn t198_adversarial_deep_tree_single_leaf() {
        let depth = 1000;
        let mut current = Arc::new(SceneNode {
            id: format!("node-{}", depth - 1),
            ..Default::default()
        });
        for i in (0..depth - 1).rev() {
            current = Arc::new(SceneNode {
                id: format!("node-{}", i),
                children: vec![current],
                ..Default::default()
            });
        }

        let dirty = HashSet::from([format!("node-{}", depth - 1)]);
        let ancestors = compute_ancestor_set(&current, &dirty);

        assert_eq!(
            ancestors.len(),
            depth,
            "ancestor set must contain exactly {depth} nodes (full spine)"
        );
        for i in 0..depth {
            assert!(
                ancestors.contains(&format!("node-{}", i)),
                "node-{i} must be in ancestor set"
            );
        }
    }

    /// Ancestor set size is bounded by dirty_count * avg_depth for balanced trees.
    #[test]
    fn t198_ancestor_set_scales_correctly() {
        fn build_balanced(prefix: &str, depth: usize) -> Arc<SceneNode> {
            if depth == 0 {
                return Arc::new(SceneNode {
                    id: format!("{prefix}"),
                    ..Default::default()
                });
            }
            let left = build_balanced(&format!("{prefix}-L"), depth - 1);
            let right = build_balanced(&format!("{prefix}-R"), depth - 1);
            Arc::new(SceneNode {
                id: format!("{prefix}"),
                children: vec![left, right],
                ..Default::default()
            })
        }

        let root = build_balanced("r", 4);

        // Two dirty leaves on opposite sides
        let dirty = HashSet::from(["r-L-L-L-L".to_string(), "r-R-R-R-R".to_string()]);
        let ancestors = compute_ancestor_set(&root, &dirty);

        // Spine to left leaf: r -> r-L -> r-L-L -> r-L-L-L -> r-L-L-L-L (5 nodes)
        // Spine to right leaf: r -> r-R -> r-R-R -> r-R-R-R -> r-R-R-R-R (5 nodes)
        // Root is shared, so total = 5 + 4 = 9
        assert_eq!(
            ancestors.len(),
            9,
            "two disjoint spines sharing root = 9 ancestor nodes"
        );
        assert!(
            !ancestors.contains("r-L-R"),
            "clean sibling subtree must NOT be in set"
        );
        assert!(
            !ancestors.contains("r-R-L"),
            "clean sibling subtree must NOT be in set"
        );
    }

    /// Arc identity preserved for clean subtrees via ancestor set in compute pipeline.
    #[test]
    fn t198_arc_identity_preserved_for_clean() {
        use crate::kernel::compute::compute;
        use crate::kernel::types::NodeKind;

        let dirty_child = Arc::new(SceneNode {
            id: "dirty-child".into(),
            kind: NodeKind::Container,
            ..Default::default()
        });
        let clean_child = Arc::new(SceneNode {
            id: "clean-child".into(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "grandchild".into(),
                ..Default::default()
            })],
            ..Default::default()
        });
        let root = SceneNode {
            id: "root".into(),
            kind: NodeKind::Container,
            children: vec![dirty_child, clean_child],
            ..Default::default()
        };

        let ctx = crate::kernel::types::EvaluationContext {
            ambient: serde_json::json!({}),
            vars: serde_json::json!({}),
            data_sources: serde_json::json!({}),
            fsm: serde_json::json!({}),
            routing: std::collections::HashMap::new(),
            state: std::collections::HashMap::new(),
        };

        // First compute (full eval)
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev_tree = Arc::new(result1.snapshot);

        // Second compute with only dirty-child dirty
        let dirty_set = HashSet::from(["dirty-child".to_string()]);
        let result2 = compute(
            &root,
            &ctx,
            None,
            Some(&dirty_set),
            Some(&prev_tree),
            None,
            None,
            None,
            false,
        )
        .unwrap();
        let new_tree = Arc::new(result2.snapshot);

        // Clean-child subtree should be pointer-identical to previous
        let prev_clean = &prev_tree.children[1];
        let new_clean = &new_tree.children[1];
        assert_eq!(prev_clean.id, "clean-child");
        assert_eq!(new_clean.id, "clean-child");
        assert!(
            Arc::ptr_eq(prev_clean, new_clean),
            "clean subtree must be pointer-identical (Arc::ptr_eq) after incremental compute"
        );
    }

    /// Full eval (dirty_nodes=None) visits all nodes -- no regression from ancestor set.
    #[test]
    fn t198_globally_dirty_visits_all() {
        use crate::kernel::compute::compute;
        use crate::kernel::types::NodeKind;

        let root = SceneNode {
            id: "root".into(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "a".into(),
                    kind: NodeKind::Container,
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "b".into(),
                    kind: NodeKind::Container,
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };

        let ctx = crate::kernel::types::EvaluationContext {
            ambient: serde_json::json!({}),
            vars: serde_json::json!({}),
            data_sources: serde_json::json!({}),
            fsm: serde_json::json!({}),
            routing: std::collections::HashMap::new(),
            state: std::collections::HashMap::new(),
        };

        // Full eval (None dirty_nodes) -- all nodes visited
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        assert_eq!(result.snapshot.id, "root");
        assert_eq!(result.snapshot.children.len(), 2);
        assert_eq!(result.snapshot.children[0].id, "a");
        assert_eq!(result.snapshot.children[1].id, "b");
    }

    // ========================================================================
    // Task 203: Structure-Scoped Binding Evaluation Tests
    // ========================================================================

    /// Scoped structure change only dirties dependents of the specific node.
    #[test]
    fn t203_structure_change_scopes_to_affected_node() {
        let mut index = BindingDepIndex::new();
        index.record("widget-a", DepKey::Scene("parent-a".to_string()));
        index.record("widget-b", DepKey::Scene("parent-b".to_string()));

        let empty = HashSet::new();
        let no_ambient = HashMap::new();
        let mut changed = HashSet::new();
        changed.insert("parent-a".to_string());

        let affected = index.resolve_dirty_nodes(&empty, &empty, &empty, &changed, &no_ambient);
        assert!(
            affected.contains("widget-a"),
            "widget-a depends on parent-a"
        );
        assert!(
            affected.contains("parent-a"),
            "parent-a itself included as changed node"
        );
        assert!(
            !affected.contains("widget-b"),
            "widget-b depends on parent-b, not parent-a"
        );
    }

    /// Bindings on unrelated nodes remain clean when a specific subtree changes.
    #[test]
    fn t203_structure_change_does_not_dirty_unrelated_bindings() {
        let mut index = BindingDepIndex::new();
        index.record("header", DepKey::Scene("toolbar".to_string()));
        index.record("footer", DepKey::Scene("statusbar".to_string()));
        index.record("sidebar", DepKey::Fsm("fsm:nav".to_string()));

        let empty = HashSet::new();
        let no_ambient = HashMap::new();
        let mut changed = HashSet::new();
        changed.insert("toolbar".to_string());

        let affected = index.resolve_dirty_nodes(&empty, &empty, &empty, &changed, &no_ambient);
        assert!(affected.contains("header"), "header depends on toolbar");
        assert!(
            !affected.contains("footer"),
            "footer depends on statusbar, unaffected"
        );
        assert!(
            !affected.contains("sidebar"),
            "sidebar depends on FSM, unaffected"
        );
    }

    /// Multiple structure changes union their dirty sets.
    #[test]
    fn t203_multiple_structure_changes_union_dirty_set() {
        let mut index = BindingDepIndex::new();
        index.record("node-a", DepKey::Scene("parent-a".to_string()));
        index.record("node-b", DepKey::Scene("parent-b".to_string()));
        index.record("node-c", DepKey::Scene("parent-c".to_string()));

        let empty = HashSet::new();
        let no_ambient = HashMap::new();
        let mut changed = HashSet::new();
        changed.insert("parent-a".to_string());
        changed.insert("parent-b".to_string());

        let affected = index.resolve_dirty_nodes(&empty, &empty, &empty, &changed, &no_ambient);
        assert!(affected.contains("node-a"), "node-a depends on parent-a");
        assert!(affected.contains("node-b"), "node-b depends on parent-b");
        assert!(
            !affected.contains("node-c"),
            "node-c depends on parent-c, unaffected"
        );
    }

    /// Wildcard "*" in structure changes includes ALL scene-dependent nodes
    /// (backward compat with first render / SetRoot).
    #[test]
    fn t203_wildcard_includes_all_scene_deps() {
        let mut index = BindingDepIndex::new();
        index.record("node-1", DepKey::Scene("parent-a".to_string()));
        index.record("node-2", DepKey::Scene("parent-b".to_string()));
        index.record("node-3", DepKey::Fsm("fsm:x".to_string()));

        let empty = HashSet::new();
        let no_ambient = HashMap::new();
        let mut wildcard = HashSet::new();
        wildcard.insert("*".to_string());

        let affected = index.resolve_dirty_nodes(&empty, &empty, &empty, &wildcard, &no_ambient);
        assert!(
            affected.contains("node-1"),
            "wildcard includes all scene deps"
        );
        assert!(
            affected.contains("node-2"),
            "wildcard includes all scene deps"
        );
        assert!(
            !affected.contains("node-3"),
            "FSM dep not included by scene wildcard"
        );
    }

    /// mark_scene_structure() inserts wildcard "*".
    #[test]
    fn t203_mark_scene_structure_inserts_wildcard() {
        let mut tracker = DirtyTracker::default();
        assert!(!tracker.is_scene_structure_dirty());
        tracker.mark_scene_structure();
        assert!(tracker.is_scene_structure_dirty());
        assert!(tracker.scene_structure_changed_ids.contains("*"));
    }

    /// mark_scene_structure_for() inserts specific node ID.
    #[test]
    fn t203_mark_scene_structure_for_inserts_specific_id() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_scene_structure_for("parent-42");
        assert!(tracker.is_scene_structure_dirty());
        assert!(tracker.scene_structure_changed_ids.contains("parent-42"));
        assert!(
            !tracker.scene_structure_changed_ids.contains("*"),
            "no wildcard"
        );
    }

    /// is_scene_structure_dirty() is false when no IDs present.
    #[test]
    fn t203_is_scene_structure_dirty_false_when_empty() {
        let tracker = DirtyTracker::default();
        assert!(!tracker.is_scene_structure_dirty());
        assert!(tracker.scene_structure_changed_ids.is_empty());
    }

    /// is_scene_structure_dirty() is true when IDs present.
    #[test]
    fn t203_is_scene_structure_dirty_true_when_populated() {
        let mut tracker = DirtyTracker::default();
        tracker.mark_scene_structure_for("node-1");
        assert!(tracker.is_scene_structure_dirty());
    }

    /// clear() empties the scene_structure_changed_ids set.
    #[test]
    fn t203_clear_empties_structure_changed_ids() {
        let mut tracker = DirtyTracker::new(); // starts with wildcard
        assert!(tracker.is_scene_structure_dirty());
        tracker.clear();
        assert!(!tracker.is_scene_structure_dirty());
        assert!(tracker.scene_structure_changed_ids.is_empty());
    }

    /// Scoped resolution also includes the changed node IDs themselves,
    /// since newly-inserted nodes need initial binding evaluation.
    #[test]
    fn t203_scoped_resolution_includes_changed_nodes_themselves() {
        let index = BindingDepIndex::new(); // no recorded deps

        let empty = HashSet::new();
        let no_ambient = HashMap::new();
        let mut changed = HashSet::new();
        changed.insert("new-child".to_string());

        let affected = index.resolve_dirty_nodes(&empty, &empty, &empty, &changed, &no_ambient);
        assert!(
            affected.contains("new-child"),
            "changed node itself must be in affected set for initial eval"
        );
    }

    /// Heading template regression: inserting a node under a specific parent
    /// does NOT dirty bindings that depend on a completely different subtree.
    /// This is the core improvement of Task 203 — the heading outlier
    /// (5.74ms compute) was caused by boolean structure dirty triggering
    /// ALL from:scene bindings globally.
    #[test]
    fn t203_heading_template_does_not_dirty_all_nodes() {
        let mut index = BindingDepIndex::new();
        // Simulate many bindings across different scene subtrees
        for i in 0..100 {
            index.record(
                &format!("widget-{i}"),
                DepKey::Scene(format!("subtree-{i}")),
            );
        }

        let empty = HashSet::new();
        let no_ambient = HashMap::new();
        // Only subtree-7 changed (e.g., heading template inserted there)
        let mut changed = HashSet::new();
        changed.insert("subtree-7".to_string());

        let affected = index.resolve_dirty_nodes(&empty, &empty, &empty, &changed, &no_ambient);

        // Only widget-7 + subtree-7 should be dirty, not the other 99
        assert!(
            affected.contains("widget-7"),
            "widget-7 depends on subtree-7"
        );
        assert!(
            affected.contains("subtree-7"),
            "subtree-7 is the changed node"
        );
        assert_eq!(
            affected.len(),
            2,
            "Only 2 nodes dirty (widget-7 + subtree-7), not all 100. \
             Got {} nodes: {:?}",
            affected.len(),
            affected
        );
    }
}
