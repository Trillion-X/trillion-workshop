// crates/composition-engine-core/src/kernel/typed_index.rs
//
// Typed flat indexes for the composition engine render pipeline.
//
// # Purpose
//
// Replaces the O(n^2) `serde_json::Value`-based scene indexes with typed Rust
// structures. The old `build_scene_index()` called `serde_json::to_value(node)`
// for EACH node, serializing it WITH ALL DESCENDANTS — the root entry contained
// the entire tree as JSON, every child entry contained its full subtree. Total
// serialization cost: O(n * avg_subtree_size), effectively O(n^2) for balanced
// trees.
//
// `TypedNodeEntry` stores ONLY per-node data with `child_ids: Vec<String>`
// instead of nested children. Building the index is O(n) — one flat entry per
// node, no subtree duplication.
//
// # Non-Negotiable Invariants
//
// 1. **Flat entries only**: `TypedNodeEntry` NEVER contains nested `SceneNode`
//    or `TypedNodeEntry` children. Only `child_ids` (String references).
// 2. **O(n) build**: `build_scene_index()` and `build_previous_node_index()`
//    visit each node exactly once.
// 3. **Complete coverage**: Every node in the tree gets an entry in the index.
// 4. **Deterministic**: Same input tree → same index (insertion order may vary,
//    but key→value mapping is identical).
// 5. **JSON bridge**: `to_json_scene_index()` converts to the
//    `HashMap<String, serde_json::Value>` format required by the materialize
//    pipeline. This conversion is O(n) per flat entry — NOT O(n^2).
//
// # Key Concepts
//
// - `TypedSceneIndex`: Pre-materialization index. Built from the raw scene tree
//   (with binding ASTs). Used as a cache to avoid rebuilding on incremental
//   frames when tree structure hasn't changed.
// - `TypedPreviousIndex`: Post-materialization index. Built from the resolved
//   render tree after compute. Used by incremental skip paths to overlay
//   previously resolved values onto clean nodes.
// - Both share the same `TypedNodeEntry` representation.
//
// # Security Considerations
//
// - Input trees are treated as trusted (produced by the Projector or prior
//   compute pass). No code execution occurs during index building.
// - Gracefully handles empty trees (returns empty HashMap).
//
// # AI Assistant Directive
//
// The extensive documentation in this codebase is a critical design feature.
// You are FORBIDDEN from simplifying or removing it. Your mandate is to
// MAINTAIN and EXTEND this level of meticulous detail.

use super::types::{NodeKind, NodeProps, NodeTrigger, ResolvedStyle, SceneNode, Visibility, ID};
use std::collections::HashMap;

// ============================================================================
// Type Aliases
// ============================================================================

/// Scene index mapping node ID → flat typed entry (pre-materialization).
///
/// Built from the raw `scene_tree` before binding evaluation. Cached in
/// `KernelState::cached_scene_index` and reused when tree structure hasn't
/// changed (only node properties or context changed).
pub type TypedSceneIndex = HashMap<String, TypedNodeEntry>;

/// Previous-render index mapping node ID → flat typed entry (post-materialization).
///
/// Built from the fully-resolved `render_tree` after each compute pass. Cached
/// in `KernelState::cached_previous_index` and used by incremental skip paths
/// to overlay previously resolved binding values onto clean nodes.
pub type TypedPreviousIndex = HashMap<String, TypedNodeEntry>;

// ============================================================================
// TypedNodeEntry
// ============================================================================

/// Flat per-node entry for typed indexes.
///
/// Contains ONLY this node's own data — never descendants. This breaks the
/// O(n^2) subtree serialization bug where the old `build_scene_index()` stored
/// each node WITH all children as JSON (root = entire tree, first child =
/// entire subtree, etc.).
///
/// # Fields
///
/// All fields mirror `SceneNode` except:
/// - `children` → `child_ids`: Only child ID strings, not nested nodes.
/// - `text_input`: Excluded — populated by snapshot creation, not index lookups.
///
/// # Non-Negotiable Invariants
///
/// 1. `child_ids` contains ONLY String IDs — never nested structures.
/// 2. Every field is cloned from the source `SceneNode` — no lossy conversion.
/// 3. `to_json_value()` produces JSON compatible with the binding evaluator's
///    `SelectSource::Scene` lookup (node properties accessible by path).
#[derive(Debug, Clone, PartialEq)]
pub struct TypedNodeEntry {
    /// Node identifier — unique within the scene tree.
    pub id: ID,
    /// Node type (Container, Text, Image, Rect, Canvas, Custom).
    pub kind: NodeKind,
    /// Node properties — layout, colors, text content, etc.
    pub props: NodeProps,
    /// Visibility state — either a resolved boolean or a binding AST.
    pub visible: Visibility,
    /// Custom node input value — may be a binding AST (pre-compute)
    /// or a resolved value (post-compute).
    pub value: Option<serde_json::Value>,
    /// Z-index override for stacking order.
    pub z_index: Option<i32>,
    /// Resolved style override (layout, colors, etc.).
    pub style: Option<ResolvedStyle>,
    /// Node-level triggers (matched during event processing with parent bubbling).
    pub triggers: Vec<NodeTrigger>,
    /// Child node IDs — references only, NOT nested nodes.
    /// This is the key structural difference from SceneNode: O(k) storage
    /// where k = direct child count, vs. O(subtree_size) for nested children.
    pub child_ids: Vec<String>,
    /// Synthetic/pass-through node flag.
    pub synthetic: bool,
    /// Portal owner reference (by ID).
    pub portal_owner: Option<ID>,
    /// Parent node ID — None for the root node.
    /// Task 202: Enables O(depth) tree navigation via parent chain,
    /// replacing O(n) find_node() DFS traversal.
    pub parent_id: Option<ID>,
}

impl TypedNodeEntry {
    /// Create a flat typed entry from a SceneNode.
    ///
    /// Clones all per-node fields. Children are captured as IDs only —
    /// the nested `SceneNode` children are NOT included. This is what
    /// makes the index O(n) instead of O(n^2).
    ///
    /// # Performance
    ///
    /// One allocation per field that requires cloning (id, props, style,
    /// triggers, child_ids). Primitive fields (kind, z_index, synthetic)
    /// are copied. Total cost: O(1) per node (fixed-size data, no subtree).
    pub fn from_node(node: &SceneNode, parent_id: Option<&str>) -> Self {
        Self {
            id: node.id.clone(),
            kind: node.kind,
            props: node.props.clone(),
            visible: node.visible.clone(),
            value: node.value.clone(),
            z_index: node.z_index,
            style: node.style.clone(),
            triggers: node.triggers.clone(),
            child_ids: node.children.iter().map(|c| c.id.clone()).collect(),
            synthetic: node.synthetic,
            portal_owner: node.portal_owner.clone(),
            parent_id: parent_id.map(|s| s.to_string()),
        }
    }

    /// Convert this typed entry to a `serde_json::Value` compatible with the
    /// binding evaluator's `SelectSource::Scene` lookup format.
    ///
    /// The binding evaluator does `scene_index.get(id).cloned()` and then
    /// applies path traversal (e.g., `.props.color`, `.visible`). This method
    /// produces a JSON object with the same top-level keys as a serialized
    /// `SceneNode`, except `children` is replaced by `child_ids`.
    ///
    /// # Performance
    ///
    /// O(1) per entry — serializes one flat struct. The old approach serialized
    /// each node WITH all descendants: O(subtree_size) per entry.
    pub fn to_json_value(&self) -> serde_json::Value {
        // Use serde to serialize the entry into a SceneNode-compatible JSON
        // structure. We build the JSON object manually for field-level control
        // and to avoid needing Serialize on TypedNodeEntry itself (which would
        // add serde overhead to the struct's derive chain).
        let mut obj = serde_json::Map::new();

        obj.insert("id".to_string(), serde_json::Value::String(self.id.clone()));

        // NodeKind serializes to its variant name
        if let Ok(kind_json) = serde_json::to_value(self.kind) {
            obj.insert("kind".to_string(), kind_json);
        }

        // Props — full object
        if let Ok(props_json) = serde_json::to_value(&self.props) {
            obj.insert("props".to_string(), props_json);
        }

        // Visibility — Resolved(bool) or Binding AST
        if let Ok(vis_json) = serde_json::to_value(&self.visible) {
            obj.insert("visible".to_string(), vis_json);
        }

        // Optional fields — only include when present (matches SceneNode's
        // skip_serializing_if behavior)
        if let Some(ref val) = self.value {
            obj.insert("value".to_string(), val.clone());
        }

        if let Some(z) = self.z_index {
            obj.insert("zIndex".to_string(), serde_json::Value::Number(z.into()));
        }

        if let Some(ref style) = self.style {
            if let Ok(style_json) = serde_json::to_value(style) {
                obj.insert("style".to_string(), style_json);
            }
        }

        if !self.triggers.is_empty() {
            if let Ok(triggers_json) = serde_json::to_value(&self.triggers) {
                obj.insert("triggers".to_string(), triggers_json);
            }
        }

        if self.synthetic {
            obj.insert("synthetic".to_string(), serde_json::Value::Bool(true));
        }

        if let Some(ref po) = self.portal_owner {
            obj.insert(
                "portalOwner".to_string(),
                serde_json::Value::String(po.clone()),
            );
        }

        // child_ids — exposed as "children" array of strings for path
        // traversal compatibility. Binding evaluators that access
        // `.children` get ID strings, not nested node objects.
        if !self.child_ids.is_empty() {
            let ids: Vec<serde_json::Value> = self
                .child_ids
                .iter()
                .map(|id| serde_json::Value::String(id.clone()))
                .collect();
            obj.insert("children".to_string(), serde_json::Value::Array(ids));
        }

        serde_json::Value::Object(obj)
    }
}

// ============================================================================
// Index Conversion (Typed → JSON Bridge)
// ============================================================================

/// Convert a `TypedSceneIndex` to the `HashMap<String, serde_json::Value>`
/// format required by the `materialize()` pipeline.
///
/// The materialize pipeline and binding evaluator operate on JSON internally.
/// This bridge converts each flat `TypedNodeEntry` to JSON — O(n) total
/// where n = number of entries. Each entry conversion is O(1) (flat struct,
/// no subtree serialization).
///
/// # Why This Bridge Exists
///
/// The compute/materialize core operates on `serde_json::Value` (hundreds of
/// lines of binding evaluation code). Refactoring it to use typed access is
/// beyond P4 scope. P4 eliminates the INDEX-building O(n^2) overhead; the
/// compute core's JSON usage is a separate concern for a future task.
///
/// # Performance
///
/// O(n) total — one `to_json_value()` call per entry. The old approach was
/// O(n^2) because `build_scene_index()` called `serde_json::to_value(node)`
/// which serialized each node WITH all descendants.
///
/// Task 202: No longer used in production — `BindingEvaluationContext` now
/// accepts `TypedNodeEntry` directly and converts on-demand per lookup.
#[cfg(test)]
pub fn typed_to_json_scene_index(typed: &TypedSceneIndex) -> HashMap<String, serde_json::Value> {
    typed
        .iter()
        .map(|(id, entry)| (id.clone(), entry.to_json_value()))
        .collect()
}

/// Convert a `TypedPreviousIndex` to the `HashMap<String, serde_json::Value>`
/// format required by the `materialize()` overlay path.
///
/// The incremental skip path in `materialize()` overlays previously resolved
/// binding values (props, visible, style, value, zIndex, portalOwner, triggers)
/// from this index onto clean nodes. The overlay expects JSON objects.
///
/// # Performance
///
/// Same as `typed_to_json_scene_index()`: O(n) total, O(1) per entry.
#[cfg(test)]
pub fn typed_to_json_previous_index(
    typed: &TypedPreviousIndex,
) -> HashMap<String, serde_json::Value> {
    typed
        .iter()
        .map(|(id, entry)| (id.clone(), entry.to_json_value()))
        .collect()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::super::types::{NodeKind, Visibility};
    use super::*;
    use std::sync::Arc;

    /// Helper: create a simple SceneNode for testing.
    fn make_node(id: &str, kind: NodeKind) -> SceneNode {
        SceneNode {
            id: id.to_string(),
            kind,
            ..Default::default()
        }
    }

    /// Helper: create a tree with the given number of children under root.
    fn make_flat_tree(child_count: usize) -> SceneNode {
        let mut root = make_node("root", NodeKind::Container);
        for i in 0..child_count {
            root.children.push(Arc::new(make_node(
                &format!("child-{}", i),
                NodeKind::Container,
            )));
        }
        root
    }

    /// Helper: create a deep chain of nodes (root → child-0 → child-1 → ...).
    fn make_deep_tree(depth: usize) -> SceneNode {
        let mut current = make_node(&format!("node-{}", depth - 1), NodeKind::Text);
        for i in (0..depth - 1).rev() {
            let mut parent = make_node(&format!("node-{}", i), NodeKind::Container);
            parent.children.push(Arc::new(current));
            current = parent;
        }
        current
    }

    // ========================================================================
    // TypedNodeEntry::from_node
    // ========================================================================

    #[test]
    fn typed_entry_from_node_captures_all_fields() {
        let mut node = make_node("test-1", NodeKind::Custom);
        node.visible = Visibility::Resolved(false);
        node.z_index = Some(42);
        node.synthetic = true;
        node.portal_owner = Some("portal-owner-1".to_string());
        node.value = Some(serde_json::json!("hello"));

        let entry = TypedNodeEntry::from_node(&node, None);

        assert_eq!(entry.id, "test-1");
        assert_eq!(entry.kind, NodeKind::Custom);
        assert_eq!(entry.visible, Visibility::Resolved(false));
        assert_eq!(entry.z_index, Some(42));
        assert!(entry.synthetic);
        assert_eq!(entry.portal_owner, Some("portal-owner-1".to_string()));
        assert_eq!(entry.value, Some(serde_json::json!("hello")));
        assert!(entry.child_ids.is_empty());
    }

    #[test]
    fn typed_entry_child_ids_captures_direct_children_only() {
        let mut root = make_node("root", NodeKind::Container);
        let mut child_a = make_node("child-a", NodeKind::Container);
        child_a
            .children
            .push(Arc::new(make_node("grandchild-a1", NodeKind::Text)));
        root.children.push(Arc::new(child_a));
        root.children
            .push(Arc::new(make_node("child-b", NodeKind::Text)));

        let entry = TypedNodeEntry::from_node(&root, None);

        // child_ids should have ONLY direct children, NOT grandchildren
        assert_eq!(entry.child_ids, vec!["child-a", "child-b"]);
    }

    #[test]
    fn typed_entry_does_not_contain_nested_children() {
        let mut root = make_node("root", NodeKind::Container);
        root.children
            .push(Arc::new(make_node("child-1", NodeKind::Text)));
        root.children
            .push(Arc::new(make_node("child-2", NodeKind::Text)));

        let entry = TypedNodeEntry::from_node(&root, None);

        // Verify: entry has child_ids (strings), NOT nested SceneNode structures
        assert_eq!(entry.child_ids.len(), 2);
        assert_eq!(entry.child_ids[0], "child-1");
        assert_eq!(entry.child_ids[1], "child-2");
    }

    // ========================================================================
    // to_json_value
    // ========================================================================

    #[test]
    fn to_json_value_produces_binding_evaluator_compatible_json() {
        let mut node = make_node("node-1", NodeKind::Text);
        node.visible = Visibility::Resolved(true);
        node.value = Some(serde_json::json!(42));

        let entry = TypedNodeEntry::from_node(&node, None);
        let json = entry.to_json_value();

        // Must be an object with expected keys
        let obj = json.as_object().expect("must be JSON object");
        assert_eq!(obj.get("id").and_then(|v| v.as_str()), Some("node-1"));
        assert!(obj.contains_key("kind"));
        assert!(obj.contains_key("props"));
        assert!(obj.contains_key("visible"));
        assert_eq!(obj.get("value"), Some(&serde_json::json!(42)));
    }

    #[test]
    fn to_json_value_omits_none_fields() {
        let node = make_node("node-1", NodeKind::Container);
        let entry = TypedNodeEntry::from_node(&node, None);
        let json = entry.to_json_value();
        let obj = json.as_object().expect("must be JSON object");

        // Optional fields with None/empty should not be present
        assert!(!obj.contains_key("value"), "value=None should be omitted");
        assert!(
            !obj.contains_key("zIndex"),
            "z_index=None should be omitted"
        );
        assert!(!obj.contains_key("style"), "style=None should be omitted");
        assert!(
            !obj.contains_key("triggers"),
            "empty triggers should be omitted"
        );
        assert!(
            !obj.contains_key("synthetic"),
            "synthetic=false should be omitted"
        );
        assert!(
            !obj.contains_key("portalOwner"),
            "portal_owner=None should be omitted"
        );
    }

    #[test]
    fn to_json_value_z_index_uses_camel_case() {
        let mut node = make_node("n", NodeKind::Container);
        node.z_index = Some(10);
        let entry = TypedNodeEntry::from_node(&node, None);
        let json = entry.to_json_value();
        let obj = json.as_object().unwrap();

        // Must use "zIndex" (camelCase) to match SceneNode's serde rename
        assert_eq!(obj.get("zIndex"), Some(&serde_json::json!(10)));
        assert!(!obj.contains_key("z_index"), "must use camelCase zIndex");
    }

    // ========================================================================
    // Index Conversion (typed → JSON bridge)
    // ========================================================================

    #[test]
    fn typed_to_json_scene_index_converts_all_entries() {
        let tree = make_flat_tree(3);
        let mut typed_index = TypedSceneIndex::new();
        fn visit(node: &SceneNode, index: &mut TypedSceneIndex) {
            index.insert(node.id.clone(), TypedNodeEntry::from_node(node, None));
            for child in &node.children {
                visit(child, index);
            }
        }
        visit(&tree, &mut typed_index);

        let json_index = typed_to_json_scene_index(&typed_index);

        assert_eq!(json_index.len(), typed_index.len());
        assert_eq!(json_index.len(), 4); // root + 3 children
        for (id, json_val) in &json_index {
            let obj = json_val.as_object().expect("entry must be JSON object");
            assert_eq!(obj.get("id").and_then(|v| v.as_str()), Some(id.as_str()));
        }
    }

    #[test]
    fn typed_to_json_previous_index_converts_all_entries() {
        let tree = make_flat_tree(2);
        let mut typed_index = TypedPreviousIndex::new();
        fn visit(node: &SceneNode, index: &mut TypedPreviousIndex) {
            index.insert(node.id.clone(), TypedNodeEntry::from_node(node, None));
            for child in &node.children {
                visit(child, index);
            }
        }
        visit(&tree, &mut typed_index);

        let json_index = typed_to_json_previous_index(&typed_index);

        assert_eq!(json_index.len(), 3); // root + 2 children
    }

    // ========================================================================
    // 100-node tree has exactly 100 entries
    // ========================================================================

    #[test]
    fn scene_index_100_node_tree_has_100_entries() {
        let tree = make_flat_tree(99); // root + 99 children = 100 nodes
        let mut index = TypedSceneIndex::new();
        fn visit(node: &SceneNode, index: &mut TypedSceneIndex) {
            index.insert(node.id.clone(), TypedNodeEntry::from_node(node, None));
            for child in &node.children {
                visit(child, index);
            }
        }
        visit(&tree, &mut index);

        assert_eq!(
            index.len(),
            100,
            "100-node tree must have exactly 100 entries"
        );
    }

    // ========================================================================
    // Deep tree doesn't stack-overflow
    // ========================================================================

    #[test]
    fn typed_index_deep_tree_no_stack_overflow() {
        // 200-deep chain should not stack overflow
        let tree = make_deep_tree(200);
        let mut index = TypedSceneIndex::new();
        fn visit(node: &SceneNode, index: &mut TypedSceneIndex) {
            index.insert(node.id.clone(), TypedNodeEntry::from_node(node, None));
            for child in &node.children {
                visit(child, index);
            }
        }
        visit(&tree, &mut index);

        assert_eq!(index.len(), 200);
    }

    // ========================================================================
    // Entry preserves resolved values (post-compute)
    // ========================================================================

    #[test]
    fn build_scene_index_returns_typed_scene_index_with_flat_entries() {
        use super::super::compute::build_scene_index;

        let mut root = make_node("root", NodeKind::Container);
        let mut child = make_node("child-a", NodeKind::Container);
        child
            .children
            .push(Arc::new(make_node("grandchild-a1", NodeKind::Text)));
        root.children.push(Arc::new(child));
        root.children
            .push(Arc::new(make_node("child-b", NodeKind::Text)));

        let index: TypedSceneIndex = build_scene_index(&root);

        // 4 nodes total: root, child-a, grandchild-a1, child-b
        assert_eq!(index.len(), 4);

        // Root entry has child_ids pointing to direct children only
        let root_entry = index.get("root").expect("root must exist");
        assert_eq!(root_entry.child_ids, vec!["child-a", "child-b"]);

        // child-a entry has grandchild in child_ids
        let child_a_entry = index.get("child-a").expect("child-a must exist");
        assert_eq!(child_a_entry.child_ids, vec!["grandchild-a1"]);

        // grandchild is a leaf — no child_ids
        let gc_entry = index
            .get("grandchild-a1")
            .expect("grandchild-a1 must exist");
        assert!(gc_entry.child_ids.is_empty());
    }

    #[test]
    fn typed_entry_preserves_resolved_values() {
        let mut node = make_node("resolved-1", NodeKind::Custom);
        node.visible = Visibility::Resolved(true);
        node.value = Some(serde_json::json!({"color": "#ff0000"}));
        node.z_index = Some(5);

        let entry = TypedNodeEntry::from_node(&node, None);

        assert_eq!(entry.visible, Visibility::Resolved(true));
        assert_eq!(entry.value, Some(serde_json::json!({"color": "#ff0000"})));
        assert_eq!(entry.z_index, Some(5));
    }
}
