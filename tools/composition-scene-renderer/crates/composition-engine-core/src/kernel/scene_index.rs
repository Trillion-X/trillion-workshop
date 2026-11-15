//! crates/composition-engine-core/src/kernel/scene_index.rs
//!
//! O(1) lookup index for scene tree nodes. The key to achieving O(N) diffing.
//!
//! # Purpose
//!
//! Without SceneIndex, every `find_parent_id()` or `find_node()` would be O(N),
//! making the diff algorithm O(N²). SceneIndex builds a HashMap-based index
//! enabling O(1) lookups for any node's location in the tree.
//!
//! # Invariants
//!
//! 1. All IDs in the tree MUST be unique (duplicates are errors)
//! 2. Build is O(N) and iterative (NO recursion - prevents stack overflow)
//! 3. Ordering methods are deterministic (sorted by depth, then by ID)
//! 4. IDs must be valid (non-empty, alphanumeric + `_:-.` only)
//!
//! # Security Considerations
//!
//! - ID validation prevents injection attacks
//! - Depth tracking warns on pathological trees (configurable via `SceneIndexConfig::depth_warning_threshold`, default: 1000)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::scene_diff_types::SceneDiffError;
use super::types::{SceneNode, ID};

// ============================================================================
// NodeLocation
// ============================================================================

/// Location metadata for a node - the "GPS coordinates" in the tree.
///
/// Stored for every node, enabling O(1) lookups of parent, position, and depth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeLocation {
    /// Parent node ID. None only for the root node.
    pub parent_id: Option<ID>,
    /// Position in parent's children array (0-indexed).
    pub index_in_parent: usize,
    /// Distance from root. Root = 0, root's children = 1, etc.
    pub depth: u32,
}

impl NodeLocation {
    /// Creates a new NodeLocation.
    pub fn new(parent_id: Option<ID>, index_in_parent: usize, depth: u32) -> Self {
        Self {
            parent_id,
            index_in_parent,
            depth,
        }
    }

    /// Creates a root node location (no parent, index 0, depth 0).
    pub fn root() -> Self {
        Self {
            parent_id: None,
            index_in_parent: 0,
            depth: 0,
        }
    }
}

// ============================================================================
// SceneIndex
// ============================================================================

/// O(1) lookup index for scene tree nodes.
///
/// # Example
///
/// ```
/// use composition_engine_core::kernel::scene_index::SceneIndex;
/// use composition_engine_core::kernel::types::{SceneNode, NodeKind};
///
/// let root = SceneNode::new("root", NodeKind::Container)
///     .with_children(vec![
///         SceneNode::new("child1", NodeKind::Text),
///         SceneNode::new("child2", NodeKind::Text),
///     ]);
///
/// let index = SceneIndex::build(&root).unwrap();
/// assert!(index.contains("root"));
/// assert!(index.contains("child1"));
/// assert_eq!(index.get_depth("root"), Some(0));
/// assert_eq!(index.get_depth("child1"), Some(1));
/// ```
#[derive(Debug, Clone, Default)]
pub struct SceneIndex {
    /// Map from node ID to its location metadata
    locations: HashMap<ID, NodeLocation>,
    /// The root node's ID (if tree is non-empty)
    root_id: Option<ID>,
    /// Maximum depth in the tree
    max_depth: u32,
    /// Total number of nodes indexed
    node_count: usize,
    /// Configurable thresholds (Society data, not Physics constants)
    config: SceneIndexConfig,
}

/// Configuration for scene index behavior.
///
/// All fields are Society data (configurable tunables), not Physics constants.
/// Different deployments may want different thresholds — dashboards with deep
/// nesting vs simple apps with shallow trees.
#[derive(Debug, Clone, Copy)]
pub struct SceneIndexConfig {
    /// Warning threshold for tree depth (default: 1000).
    /// Trees deeper than this are flagged as pathologically deep.
    pub depth_warning_threshold: u32,
}

impl Default for SceneIndexConfig {
    fn default() -> Self {
        Self {
            depth_warning_threshold: 1000,
        }
    }
}

impl SceneIndex {
    /// Creates an empty SceneIndex.
    pub fn new() -> Self {
        Self::default()
    }

    /// Builds index from a scene tree with default config. O(N), iterative (no recursion).
    ///
    /// Uses `SceneIndexConfig::default()` for thresholds. For custom thresholds,
    /// use `build_with_config()`.
    ///
    /// # Errors
    ///
    /// Returns `SceneDiffError::DuplicateId` if any ID appears more than once.
    /// Returns `SceneDiffError::InvalidId` if any ID is empty or contains invalid characters.
    pub fn build(root: &SceneNode) -> Result<Self, SceneDiffError> {
        Self::build_with_config(root, SceneIndexConfig::default())
    }

    /// Builds index from a scene tree with custom config. O(N), iterative (no recursion).
    ///
    /// # Errors
    ///
    /// Returns `SceneDiffError::DuplicateId` if any ID appears more than once.
    /// Returns `SceneDiffError::InvalidId` if any ID is empty or contains invalid characters.
    ///
    /// # Algorithm
    ///
    /// Uses an explicit stack for BFS/DFS traversal to avoid recursion.
    /// This prevents stack overflow on deep trees (tested with 100+ levels).
    pub fn build_with_config(
        root: &SceneNode,
        config: SceneIndexConfig,
    ) -> Result<Self, SceneDiffError> {
        let mut locations = HashMap::new();
        let mut max_depth: u32 = 0;

        // Validate root ID first
        validate_id(&root.id)?;

        // Stack entries: (node reference, parent_id, index_in_parent, depth)
        // Using Vec as explicit stack instead of recursion
        let mut stack: Vec<(&SceneNode, Option<ID>, usize, u32)> = vec![(root, None, 0, 0)];

        while let Some((node, parent_id, index_in_parent, depth)) = stack.pop() {
            // Validate this node's ID
            validate_id(&node.id)?;

            // Check for duplicate ID
            if locations.contains_key(&node.id) {
                return Err(SceneDiffError::DuplicateId {
                    id: node.id.clone(),
                    context: format!("SceneIndex::build at depth {}", depth),
                });
            }

            // Insert location for this node
            locations.insert(
                node.id.clone(),
                NodeLocation::new(parent_id, index_in_parent, depth),
            );

            // Track max depth
            if depth > max_depth {
                max_depth = depth;
            }

            // Push children onto stack (in reverse order for left-to-right processing)
            // This ensures children are processed in their natural order when popped
            for (child_index, child) in node.children.iter().enumerate().rev() {
                stack.push((child, Some(node.id.clone()), child_index, depth + 1));
            }
        }

        let node_count = locations.len();
        let root_id = Some(root.id.clone());

        Ok(Self {
            locations,
            root_id,
            max_depth,
            node_count,
            config,
        })
    }

    // ========================================================================
    // O(1) Lookups
    // ========================================================================

    /// Returns the location metadata for a node, or None if not found.
    pub fn get_location(&self, id: &str) -> Option<&NodeLocation> {
        self.locations.get(id)
    }

    /// Returns the parent ID for a node, or None if root or not found.
    pub fn get_parent_id(&self, id: &str) -> Option<&ID> {
        self.locations
            .get(id)
            .and_then(|loc| loc.parent_id.as_ref())
    }

    /// Returns the depth of a node, or None if not found.
    pub fn get_depth(&self, id: &str) -> Option<u32> {
        self.locations.get(id).map(|loc| loc.depth)
    }

    /// Returns true if the index contains a node with the given ID.
    pub fn contains(&self, id: &str) -> bool {
        self.locations.contains_key(id)
    }

    // ========================================================================
    // Iteration (Deterministic Order)
    // ========================================================================

    /// Returns an iterator over all node IDs in the index.
    ///
    /// Note: Order is NOT guaranteed to be deterministic (HashMap iteration).
    /// For deterministic order, use `ids_deepest_first()` or `ids_shallowest_first()`.
    pub fn all_ids(&self) -> impl Iterator<Item = &ID> {
        self.locations.keys()
    }

    /// Returns all IDs sorted by depth (deepest first), then by ID (ascending).
    ///
    /// This ordering is used for removals - children must be removed before parents.
    /// Deterministic: same tree always produces the same order.
    pub fn ids_deepest_first(&self) -> Vec<ID> {
        let mut entries: Vec<_> = self
            .locations
            .iter()
            .map(|(id, loc)| (id.clone(), loc.depth))
            .collect();

        // Sort by depth DESC, then ID ASC for determinism
        entries.sort_by(|(id_a, depth_a), (id_b, depth_b)| {
            depth_b.cmp(depth_a).then_with(|| id_a.cmp(id_b))
        });

        entries.into_iter().map(|(id, _)| id).collect()
    }

    /// Returns all IDs sorted by depth (shallowest first), then by ID (ascending).
    ///
    /// This ordering is used for insertions - parents must exist before children.
    /// Deterministic: same tree always produces the same order.
    pub fn ids_shallowest_first(&self) -> Vec<ID> {
        let mut entries: Vec<_> = self
            .locations
            .iter()
            .map(|(id, loc)| (id.clone(), loc.depth))
            .collect();

        // Sort by depth ASC, then ID ASC for determinism
        entries.sort_by(|(id_a, depth_a), (id_b, depth_b)| {
            depth_a.cmp(depth_b).then_with(|| id_a.cmp(id_b))
        });

        entries.into_iter().map(|(id, _)| id).collect()
    }

    // ========================================================================
    // Metadata Accessors
    // ========================================================================

    /// Returns the root node's ID, or None if the index is empty.
    pub fn root_id(&self) -> Option<&ID> {
        self.root_id.as_ref()
    }

    /// Returns the maximum depth in the tree.
    pub fn max_depth(&self) -> u32 {
        self.max_depth
    }

    /// Returns the total number of nodes in the index.
    pub fn node_count(&self) -> usize {
        self.node_count
    }

    /// Returns true if the index is empty.
    pub fn is_empty(&self) -> bool {
        self.node_count == 0
    }

    /// Returns true if the tree exceeds the configurable depth warning threshold.
    pub fn is_pathologically_deep(&self) -> bool {
        self.max_depth > self.config.depth_warning_threshold
    }

    /// Returns the config used by this index.
    pub fn config(&self) -> &SceneIndexConfig {
        &self.config
    }
}

// ============================================================================
// ID Validation
// ============================================================================

/// Valid characters for node IDs: alphanumeric plus underscore, colon, hyphen, period.
fn is_valid_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == ':' || c == '-' || c == '.'
}

/// Validates a node ID.
///
/// # Rules
/// - Must be non-empty
/// - Must contain only alphanumeric characters plus `_`, `:`, `-`, `.`
pub fn validate_id(id: &str) -> Result<(), SceneDiffError> {
    if id.is_empty() {
        return Err(SceneDiffError::InvalidId {
            id: id.to_string(),
            reason: "ID cannot be empty".to_string(),
        });
    }

    if let Some(invalid_char) = id.chars().find(|c| !is_valid_id_char(*c)) {
        return Err(SceneDiffError::InvalidId {
            id: id.to_string(),
            reason: format!(
                "ID contains invalid character '{}'. Allowed: alphanumeric, _, :, -, .",
                invalid_char
            ),
        });
    }

    Ok(())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::NodeKind;

    /// Helper to create a simple node with given ID and children
    fn make_node(id: &str, children: Vec<SceneNode>) -> SceneNode {
        SceneNode::new(id, NodeKind::Container).with_children(children)
    }

    // ------------------------------------------------------------------------
    // Test 1: Build from empty tree (single root node)
    // ------------------------------------------------------------------------
    #[test]
    fn test_build_single_root() {
        let root = make_node("root", vec![]);
        let index = SceneIndex::build(&root).unwrap();

        assert_eq!(index.node_count(), 1);
        assert_eq!(index.max_depth(), 0);
        assert_eq!(index.root_id(), Some(&"root".to_string()));
        assert!(index.contains("root"));

        let loc = index.get_location("root").unwrap();
        assert_eq!(loc.parent_id, None);
        assert_eq!(loc.index_in_parent, 0);
        assert_eq!(loc.depth, 0);
    }

    // ------------------------------------------------------------------------
    // Test 2: Build from tree with children
    // ------------------------------------------------------------------------
    #[test]
    fn test_build_with_children() {
        let root = make_node(
            "root",
            vec![
                make_node("child1", vec![]),
                make_node("child2", vec![]),
                make_node("child3", vec![]),
            ],
        );
        let index = SceneIndex::build(&root).unwrap();

        assert_eq!(index.node_count(), 4);
        assert_eq!(index.max_depth(), 1);

        // Check root
        let root_loc = index.get_location("root").unwrap();
        assert_eq!(root_loc.parent_id, None);
        assert_eq!(root_loc.depth, 0);

        // Check children
        let child1_loc = index.get_location("child1").unwrap();
        assert_eq!(child1_loc.parent_id, Some("root".to_string()));
        assert_eq!(child1_loc.index_in_parent, 0);
        assert_eq!(child1_loc.depth, 1);

        let child2_loc = index.get_location("child2").unwrap();
        assert_eq!(child2_loc.parent_id, Some("root".to_string()));
        assert_eq!(child2_loc.index_in_parent, 1);
        assert_eq!(child2_loc.depth, 1);

        let child3_loc = index.get_location("child3").unwrap();
        assert_eq!(child3_loc.parent_id, Some("root".to_string()));
        assert_eq!(child3_loc.index_in_parent, 2);
        assert_eq!(child3_loc.depth, 1);
    }

    // ------------------------------------------------------------------------
    // Test 3: Build from deep tree (100+ levels) - verify no stack overflow
    // ------------------------------------------------------------------------
    #[test]
    fn test_build_deep_tree_no_stack_overflow() {
        // Build a tree with 150 levels (deeper than default stack limit)
        let depth = 150;
        let mut node = make_node(&format!("level_{}", depth), vec![]);

        for i in (0..depth).rev() {
            node = make_node(&format!("level_{}", i), vec![node]);
        }

        let index = SceneIndex::build(&node).unwrap();

        assert_eq!(index.node_count(), depth + 1);
        assert_eq!(index.max_depth(), depth as u32);

        // Verify deepest node
        let deepest_loc = index.get_location(&format!("level_{}", depth)).unwrap();
        assert_eq!(deepest_loc.depth, depth as u32);
    }

    // ------------------------------------------------------------------------
    // Test 4: get_location() returns correct parent/index/depth
    // ------------------------------------------------------------------------
    #[test]
    fn test_get_location_correctness() {
        let root = make_node(
            "root",
            vec![make_node(
                "parent",
                vec![
                    make_node("child_a", vec![]),
                    make_node("child_b", vec![make_node("grandchild", vec![])]),
                ],
            )],
        );
        let index = SceneIndex::build(&root).unwrap();

        // Root
        let root_loc = index.get_location("root").unwrap();
        assert_eq!(root_loc.parent_id, None);
        assert_eq!(root_loc.index_in_parent, 0);
        assert_eq!(root_loc.depth, 0);

        // Parent (first child of root)
        let parent_loc = index.get_location("parent").unwrap();
        assert_eq!(parent_loc.parent_id, Some("root".to_string()));
        assert_eq!(parent_loc.index_in_parent, 0);
        assert_eq!(parent_loc.depth, 1);

        // child_a (first child of parent)
        let child_a_loc = index.get_location("child_a").unwrap();
        assert_eq!(child_a_loc.parent_id, Some("parent".to_string()));
        assert_eq!(child_a_loc.index_in_parent, 0);
        assert_eq!(child_a_loc.depth, 2);

        // child_b (second child of parent)
        let child_b_loc = index.get_location("child_b").unwrap();
        assert_eq!(child_b_loc.parent_id, Some("parent".to_string()));
        assert_eq!(child_b_loc.index_in_parent, 1);
        assert_eq!(child_b_loc.depth, 2);

        // grandchild (first child of child_b)
        let grandchild_loc = index.get_location("grandchild").unwrap();
        assert_eq!(grandchild_loc.parent_id, Some("child_b".to_string()));
        assert_eq!(grandchild_loc.index_in_parent, 0);
        assert_eq!(grandchild_loc.depth, 3);
    }

    // ------------------------------------------------------------------------
    // Test 5: contains() returns true for existing, false for missing
    // ------------------------------------------------------------------------
    #[test]
    fn test_contains() {
        let root = make_node(
            "root",
            vec![make_node("child1", vec![]), make_node("child2", vec![])],
        );
        let index = SceneIndex::build(&root).unwrap();

        assert!(index.contains("root"));
        assert!(index.contains("child1"));
        assert!(index.contains("child2"));
        assert!(!index.contains("nonexistent"));
        assert!(!index.contains(""));
        assert!(!index.contains("child3"));
    }

    // ------------------------------------------------------------------------
    // Test 6: ids_deepest_first() ordering is correct
    // ------------------------------------------------------------------------
    #[test]
    fn test_ids_deepest_first_ordering() {
        let root = make_node(
            "root",
            vec![
                make_node("a", vec![make_node("a_child", vec![])]),
                make_node("b", vec![make_node("b_child", vec![])]),
            ],
        );
        let index = SceneIndex::build(&root).unwrap();

        let ids = index.ids_deepest_first();

        // Depth 2 nodes first (sorted alphabetically): a_child, b_child
        // Depth 1 nodes next (sorted alphabetically): a, b
        // Depth 0 node last: root
        assert_eq!(
            ids,
            vec!["a_child", "b_child", "a", "b", "root"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }

    // ------------------------------------------------------------------------
    // Test 7: ids_shallowest_first() ordering is correct
    // ------------------------------------------------------------------------
    #[test]
    fn test_ids_shallowest_first_ordering() {
        let root = make_node(
            "root",
            vec![
                make_node("a", vec![make_node("a_child", vec![])]),
                make_node("b", vec![make_node("b_child", vec![])]),
            ],
        );
        let index = SceneIndex::build(&root).unwrap();

        let ids = index.ids_shallowest_first();

        // Depth 0 node first: root
        // Depth 1 nodes next (sorted alphabetically): a, b
        // Depth 2 nodes last (sorted alphabetically): a_child, b_child
        assert_eq!(
            ids,
            vec!["root", "a", "b", "a_child", "b_child"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }

    // ------------------------------------------------------------------------
    // Test 8: Determinism - same tree produces same index
    // ------------------------------------------------------------------------
    #[test]
    fn test_determinism() {
        let tree1 = make_node(
            "root",
            vec![
                make_node("z", vec![make_node("z_child", vec![])]),
                make_node("a", vec![make_node("a_child", vec![])]),
                make_node("m", vec![]),
            ],
        );

        let tree2 = make_node(
            "root",
            vec![
                make_node("z", vec![make_node("z_child", vec![])]),
                make_node("a", vec![make_node("a_child", vec![])]),
                make_node("m", vec![]),
            ],
        );

        let index1 = SceneIndex::build(&tree1).unwrap();
        let index2 = SceneIndex::build(&tree2).unwrap();

        // Same metadata
        assert_eq!(index1.node_count(), index2.node_count());
        assert_eq!(index1.max_depth(), index2.max_depth());
        assert_eq!(index1.root_id(), index2.root_id());

        // Same ordering (deterministic)
        assert_eq!(index1.ids_deepest_first(), index2.ids_deepest_first());
        assert_eq!(index1.ids_shallowest_first(), index2.ids_shallowest_first());

        // Same locations for all nodes
        for id in index1.all_ids() {
            assert_eq!(index1.get_location(id), index2.get_location(id));
        }
    }

    // ------------------------------------------------------------------------
    // Test 9: Duplicate ID detection during build → error
    // ------------------------------------------------------------------------
    #[test]
    fn test_duplicate_id_detection() {
        let root = make_node(
            "root",
            vec![
                make_node("duplicate", vec![]),
                make_node("duplicate", vec![]), // Duplicate!
            ],
        );

        let result = SceneIndex::build(&root);
        assert!(result.is_err());

        match result.unwrap_err() {
            SceneDiffError::DuplicateId { id, .. } => {
                assert_eq!(id, "duplicate");
            }
            other => panic!("Expected DuplicateId error, got: {:?}", other),
        }
    }

    // ------------------------------------------------------------------------
    // Test 10: all_ids() iteration
    // ------------------------------------------------------------------------
    #[test]
    fn test_all_ids_iteration() {
        let root = make_node(
            "root",
            vec![
                make_node("child1", vec![]),
                make_node("child2", vec![make_node("grandchild", vec![])]),
            ],
        );
        let index = SceneIndex::build(&root).unwrap();

        let mut ids: Vec<_> = index.all_ids().cloned().collect();
        ids.sort(); // Sort for deterministic comparison

        assert_eq!(ids, vec!["child1", "child2", "grandchild", "root"]);
    }

    // ------------------------------------------------------------------------
    // Test 11: Invalid ID detection - empty string
    // ------------------------------------------------------------------------
    #[test]
    fn test_invalid_id_empty() {
        let root = make_node("", vec![]); // Empty ID!

        let result = SceneIndex::build(&root);
        assert!(result.is_err());

        match result.unwrap_err() {
            SceneDiffError::InvalidId { id, reason } => {
                assert_eq!(id, "");
                assert!(reason.contains("empty"));
            }
            other => panic!("Expected InvalidId error, got: {:?}", other),
        }
    }

    // ------------------------------------------------------------------------
    // Test 12: Invalid ID detection - forbidden characters
    // ------------------------------------------------------------------------
    #[test]
    fn test_invalid_id_forbidden_chars() {
        let root = make_node("root<script>", vec![]); // Contains < and >

        let result = SceneIndex::build(&root);
        assert!(result.is_err());

        match result.unwrap_err() {
            SceneDiffError::InvalidId { id, reason } => {
                assert_eq!(id, "root<script>");
                assert!(reason.contains("invalid character"));
            }
            other => panic!("Expected InvalidId error, got: {:?}", other),
        }
    }

    // ------------------------------------------------------------------------
    // Test 13: Valid ID with allowed special characters
    // ------------------------------------------------------------------------
    #[test]
    fn test_valid_id_special_chars() {
        let root = make_node(
            "my-component_v1.2:section",
            vec![make_node("child_node-123.test:item", vec![])],
        );

        let index = SceneIndex::build(&root).unwrap();
        assert!(index.contains("my-component_v1.2:section"));
        assert!(index.contains("child_node-123.test:item"));
    }

    // ------------------------------------------------------------------------
    // Test 14: get_parent_id() and get_depth() helpers
    // ------------------------------------------------------------------------
    #[test]
    fn test_helper_methods() {
        let root = make_node(
            "root",
            vec![make_node("child", vec![make_node("grandchild", vec![])])],
        );
        let index = SceneIndex::build(&root).unwrap();

        // get_parent_id
        assert_eq!(index.get_parent_id("root"), None);
        assert_eq!(index.get_parent_id("child"), Some(&"root".to_string()));
        assert_eq!(
            index.get_parent_id("grandchild"),
            Some(&"child".to_string())
        );
        assert_eq!(index.get_parent_id("nonexistent"), None);

        // get_depth
        assert_eq!(index.get_depth("root"), Some(0));
        assert_eq!(index.get_depth("child"), Some(1));
        assert_eq!(index.get_depth("grandchild"), Some(2));
        assert_eq!(index.get_depth("nonexistent"), None);
    }

    // ------------------------------------------------------------------------
    // Test 15: Wide tree (many siblings)
    // ------------------------------------------------------------------------
    #[test]
    fn test_wide_tree() {
        let children: Vec<_> = (0..100)
            .map(|i| make_node(&format!("child_{:03}", i), vec![]))
            .collect();
        let root = make_node("root", children);

        let index = SceneIndex::build(&root).unwrap();

        assert_eq!(index.node_count(), 101);
        assert_eq!(index.max_depth(), 1);

        // Check ordering is correct (alphabetical for same depth)
        let shallow_ids = index.ids_shallowest_first();
        assert_eq!(shallow_ids[0], "root");
        assert_eq!(shallow_ids[1], "child_000");
        assert_eq!(shallow_ids[100], "child_099");
    }

    // ------------------------------------------------------------------------
    // Test 16: Duplicate ID deep in tree (duplicates ancestor)
    // ------------------------------------------------------------------------
    #[test]
    fn test_duplicate_id_deep() {
        let root = make_node(
            "root",
            vec![make_node(
                "level1",
                vec![make_node(
                    "level2",
                    vec![
                        make_node("unique1", vec![]),
                        make_node("level1", vec![]), // Duplicates ancestor!
                    ],
                )],
            )],
        );

        let result = SceneIndex::build(&root);
        assert!(result.is_err());

        match result.unwrap_err() {
            SceneDiffError::DuplicateId { id, .. } => {
                assert_eq!(id, "level1");
            }
            other => panic!("Expected DuplicateId error, got: {:?}", other),
        }
    }
}
