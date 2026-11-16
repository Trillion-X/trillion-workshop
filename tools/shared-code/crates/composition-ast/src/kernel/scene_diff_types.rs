//! crates/composition-engine/src/kernel/scene_diff_types.rs
//!
//! Type definitions for the Scene Diffing system.
//!
//! This module defines the atomic mutation vocabulary for scene tree transformations:
//! - `ScenePatch`: 6 atomic operations (SetRoot, InsertNode, RemoveSubtree, MoveNode, UpdateProps, ReorderChildren)
//! - `PropChanges`: Delta of node properties (visible, z_index, props - NO kind!)
//! - `SceneDiffError`: Structured errors with remediation hints
//! - `DiffDiagnostics`: Observability metrics for diff/apply operations
//!
//! # Design Principles
//!
//! 1. **Complete and Minimal**: The 6 ScenePatch operations can express any tree transformation
//! 2. **KIND STABILITY**: Same ID implies same kind - kind changes are validation errors, not patches
//! 3. **Serializable**: All types derive Serialize/Deserialize for WASM/network transport
//! 4. **Deterministic**: Patches are applied in canonical order for reproducibility
//!
//! # Related Modules
//!
//! - `scene_index.rs`: O(1) lookup primitive (SceneIndex, NodeLocation)
//! - `scene_diff.rs`: diff_scene() algorithm
//! - `scene_diff_apply.rs`: apply_patches() implementation

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[cfg(feature = "wasm")]
use tsify_next::Tsify;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

use super::types::{NodeKind, NodeProps, ResolvedStyle, SceneNode, ID};

// ============================================================================
// ScenePatch - Atomic Mutation Operations
// ============================================================================

/// Atomic mutation operations for scene tree transformations.
///
/// These 6 operations are **complete and minimal** - any tree transformation
/// can be expressed as a sequence of them.
///
/// # Canonical Ordering
///
/// When applying patches, they MUST be ordered as:
/// 1. SetRoot (if present, must be ONLY patch)
/// 2. RemoveSubtree (deepest-first)
/// 3. MoveNode (reparenting)
/// 4. ReorderChildren (sibling reordering)
/// 5. InsertNode (shallowest-first)
/// 6. UpdateProps (property changes)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[serde(tag = "type")]
pub enum ScenePatch {
    /// Set or replace the entire root node.
    ///
    /// REQUIRED for root ID changes (cannot be expressed otherwise).
    ///
    /// # Invariant
    /// If present, must be the ONLY patch in the list.
    /// Mixing SetRoot with other patches is a validation error.
    #[serde(rename = "SET_ROOT")]
    SetRoot { node: SceneNode },

    /// Insert a new node (and its subtree) as a child.
    ///
    /// The `node` includes all descendants - they are inserted atomically.
    #[serde(rename = "INSERT_NODE")]
    InsertNode {
        parent_id: ID,
        index: usize,
        node: SceneNode,
    },

    /// Remove a node AND ALL ITS DESCENDANTS.
    ///
    /// Only emitted for "removal roots" - nodes whose parent still exists.
    /// Descendants are implicitly removed (no separate patches emitted).
    #[serde(rename = "REMOVE_SUBTREE")]
    RemoveSubtree { node_id: ID },

    /// Move a node to a new parent and/or index.
    ///
    /// Ephemeral state (focus, FSM, gestures, animations) is PRESERVED
    /// because the node ID remains the same.
    #[serde(rename = "MOVE_NODE")]
    MoveNode {
        node_id: ID,
        new_parent_id: ID,
        new_index: usize,
    },

    /// Update node properties (not children, not ID).
    ///
    /// Only changed fields are set in `changes`; None means no change.
    /// Ephemeral state is PRESERVED (same ID).
    #[serde(rename = "UPDATE_PROPS")]
    UpdateProps { node_id: ID, changes: PropChanges },

    /// Reorder children within a single parent.
    ///
    /// More robust than multiple MoveNodes for sibling reordering
    /// because it avoids index shift ambiguity.
    #[serde(rename = "REORDER_CHILDREN")]
    ReorderChildren {
        parent_id: ID,
        /// Complete child ID list in new order
        new_order: Vec<ID>,
    },
}

// ============================================================================
// PropChanges - Delta of Node Properties
// ============================================================================

/// Delta of node properties. None = no change.
///
/// # KIND STABILITY Invariant
///
/// **IMPORTANT**: `kind` is NOT included in PropChanges.
///
/// The KIND STABILITY invariant states: Same ID implies same kind.
/// If a node's kind needs to change, its ID MUST change (or use SetRoot).
///
/// Kind changes are detected during diff validation and return
/// `SceneDiffError::KindChangedForId`, not a patch.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct PropChanges {
    /// Changed visibility state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,

    /// Changed z-index (outer Option = no change, inner Option = the actual z_index value)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z_index: Option<Option<i32>>,

    /// Changed node properties
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props: Option<NodeProps>,

    /// Changed style override (outer Option = no change, inner Option = the actual style value)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<Option<ResolvedStyle>>,
    // NOTE: NO `kind` field - this is intentional (KIND STABILITY invariant)
    // Kind changes are validation errors, not patches.
}

impl PropChanges {
    /// Returns true if no properties changed.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let empty = PropChanges::default();
    /// assert!(empty.is_empty());
    ///
    /// let with_visible = PropChanges {
    ///     visible: Some(false),
    ///     ..Default::default()
    /// };
    /// assert!(!with_visible.is_empty());
    /// ```
    pub fn is_empty(&self) -> bool {
        self.visible.is_none()
            && self.z_index.is_none()
            && self.props.is_none()
            && self.style.is_none()
    }
}

// ============================================================================
// SceneDiffError - Structured Errors
// ============================================================================

/// Machine-readable errors with remediation hints.
///
/// All errors include enough context to diagnose and fix the issue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Error)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub enum SceneDiffError {
    /// Duplicate node ID found in tree.
    ///
    /// Every node ID in a tree MUST be unique.
    #[error("Duplicate node ID '{id}' in {context}")]
    DuplicateId { id: ID, context: String },

    /// Invalid node ID format.
    ///
    /// IDs must be non-empty and contain only: alphanumeric, `_`, `:`, `-`, `.`
    #[error("Invalid node ID '{id}': {reason}")]
    InvalidId { id: ID, reason: String },

    /// Referenced node not found in tree.
    #[error("Node not found: '{id}'")]
    NodeNotFound { id: ID },

    /// Index out of bounds for child insertion/access.
    #[error("Index {index} out of bounds for parent '{parent_id}' with {len} children")]
    IndexOutOfBounds {
        parent_id: ID,
        index: usize,
        len: usize,
    },

    /// Patch application failed for a specific reason.
    #[error("Cannot apply patch: {reason}")]
    PatchApplicationFailed { reason: String },

    /// Tree validation failed.
    #[error("Tree validation failed: {reason}")]
    ValidationFailed { reason: String },

    /// KIND STABILITY VIOLATION: Same ID cannot change kind.
    ///
    /// # Remediation
    ///
    /// When you need to change a node's kind:
    /// 1. Change the node's ID (new ID = new node), OR
    /// 2. Use SetRoot if it's the root node
    ///
    /// Same ID implies same kind - this is a fundamental invariant
    /// that enables ephemeral state preservation.
    #[error(
        "Kind changed for node '{id}': {old_kind:?} -> {new_kind:?}. Same ID implies same kind."
    )]
    KindChangedForId {
        id: ID,
        old_kind: NodeKind,
        new_kind: NodeKind,
    },
}

// ============================================================================
// DiffDiagnostics - Observability Metrics
// ============================================================================

/// Diagnostics returned after diff/apply for observability.
///
/// These metrics help monitor performance and debug issues:
/// - `patch_count`: Total patches generated/applied
/// - `nodes_*`: Breakdown by operation type
/// - `elapsed_micros`: Time spent in diff/apply
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
pub struct DiffDiagnostics {
    /// Total number of patches generated or applied
    pub patch_count: usize,

    /// Number of RemoveSubtree patches (nodes removed)
    pub nodes_removed: usize,

    /// Number of InsertNode patches (nodes inserted)
    pub nodes_inserted: usize,

    /// Number of UpdateProps patches (nodes updated)
    pub nodes_updated: usize,

    /// Number of MoveNode patches (nodes moved)
    pub nodes_moved: usize,

    /// Number of ReorderChildren patches
    pub reorders: usize,

    /// Whether SetRoot was used (entire tree replaced)
    pub root_replaced: bool,

    /// Time elapsed in microseconds
    pub elapsed_micros: u64,
}

impl DiffDiagnostics {
    /// Create diagnostics from elapsed duration
    pub fn with_elapsed(mut self, elapsed: std::time::Duration) -> Self {
        self.elapsed_micros = elapsed.as_micros() as u64;
        self
    }

    /// Update patch_count from the breakdown
    pub fn finalize(mut self) -> Self {
        self.patch_count = self.nodes_removed
            + self.nodes_inserted
            + self.nodes_updated
            + self.nodes_moved
            + self.reorders
            + if self.root_replaced { 1 } else { 0 };
        self
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::{NodeKind, Visibility};

    // Helper to create a minimal SceneNode for testing
    fn make_node(id: &str, kind: NodeKind) -> SceneNode {
        SceneNode {
            id: id.to_string(),
            kind,
            props: NodeProps::default(),
            children: vec![],
            z_index: None,
            visible: Visibility::Resolved(true),
            portal_owner: None,
            style: None,
            triggers: vec![],
            synthetic: false,
            value: None,
            fsm: None,
        }
    }

    // =========================================================================
    // ScenePatch Serialization Round-Trip Tests
    // =========================================================================

    #[test]
    fn test_scene_patch_set_root_serialization() {
        let patch = ScenePatch::SetRoot {
            node: make_node("root", NodeKind::Container),
        };

        let json = serde_json::to_string(&patch).unwrap();
        let deserialized: ScenePatch = serde_json::from_str(&json).unwrap();

        assert_eq!(patch, deserialized);
        assert!(json.contains("SET_ROOT"));
    }

    #[test]
    fn test_scene_patch_insert_node_serialization() {
        let patch = ScenePatch::InsertNode {
            parent_id: "parent".to_string(),
            index: 2,
            node: make_node("child", NodeKind::Text),
        };

        let json = serde_json::to_string(&patch).unwrap();
        let deserialized: ScenePatch = serde_json::from_str(&json).unwrap();

        assert_eq!(patch, deserialized);
        assert!(json.contains("INSERT_NODE"));
        assert!(json.contains("\"parent_id\":\"parent\""));
        assert!(json.contains("\"index\":2"));
    }

    #[test]
    fn test_scene_patch_remove_subtree_serialization() {
        let patch = ScenePatch::RemoveSubtree {
            node_id: "node-to-remove".to_string(),
        };

        let json = serde_json::to_string(&patch).unwrap();
        let deserialized: ScenePatch = serde_json::from_str(&json).unwrap();

        assert_eq!(patch, deserialized);
        assert!(json.contains("REMOVE_SUBTREE"));
        assert!(json.contains("\"node_id\":\"node-to-remove\""));
    }

    #[test]
    fn test_scene_patch_move_node_serialization() {
        let patch = ScenePatch::MoveNode {
            node_id: "moving-node".to_string(),
            new_parent_id: "new-parent".to_string(),
            new_index: 0,
        };

        let json = serde_json::to_string(&patch).unwrap();
        let deserialized: ScenePatch = serde_json::from_str(&json).unwrap();

        assert_eq!(patch, deserialized);
        assert!(json.contains("MOVE_NODE"));
        assert!(json.contains("\"node_id\":\"moving-node\""));
        assert!(json.contains("\"new_parent_id\":\"new-parent\""));
    }

    #[test]
    fn test_scene_patch_update_props_serialization() {
        let patch = ScenePatch::UpdateProps {
            node_id: "target-node".to_string(),
            changes: PropChanges {
                visible: Some(false),
                z_index: Some(Some(10)),
                ..Default::default()
            },
        };

        let json = serde_json::to_string(&patch).unwrap();
        let deserialized: ScenePatch = serde_json::from_str(&json).unwrap();

        assert_eq!(patch, deserialized);
        assert!(json.contains("UPDATE_PROPS"));
        assert!(json.contains("\"visible\":false"));
    }

    #[test]
    fn test_scene_patch_reorder_children_serialization() {
        let patch = ScenePatch::ReorderChildren {
            parent_id: "parent".to_string(),
            new_order: vec!["c".to_string(), "a".to_string(), "b".to_string()],
        };

        let json = serde_json::to_string(&patch).unwrap();
        let deserialized: ScenePatch = serde_json::from_str(&json).unwrap();

        assert_eq!(patch, deserialized);
        assert!(json.contains("REORDER_CHILDREN"));
        assert!(json.contains("\"new_order\":[\"c\",\"a\",\"b\"]"));
    }

    // =========================================================================
    // PropChanges::is_empty() Tests
    // =========================================================================

    #[test]
    fn test_prop_changes_is_empty_when_all_none() {
        let changes = PropChanges::default();
        assert!(changes.is_empty());
    }

    #[test]
    fn test_prop_changes_is_empty_when_visible_some() {
        let changes = PropChanges {
            visible: Some(true),
            ..Default::default()
        };
        assert!(!changes.is_empty());
    }

    #[test]
    fn test_prop_changes_is_empty_when_z_index_some() {
        let changes = PropChanges {
            z_index: Some(Some(5)),
            ..Default::default()
        };
        assert!(!changes.is_empty());
    }

    #[test]
    fn test_prop_changes_is_empty_when_z_index_some_none() {
        // z_index = Some(None) means "set z_index to None" (a change!)
        let changes = PropChanges {
            z_index: Some(None),
            ..Default::default()
        };
        assert!(!changes.is_empty());
    }

    #[test]
    fn test_prop_changes_is_empty_when_props_some() {
        let changes = PropChanges {
            props: Some(NodeProps::default()),
            ..Default::default()
        };
        assert!(!changes.is_empty());
    }

    // =========================================================================
    // SceneDiffError Display Tests
    // =========================================================================

    #[test]
    fn test_scene_diff_error_duplicate_id_display() {
        let error = SceneDiffError::DuplicateId {
            id: "dupe-id".to_string(),
            context: "tree validation".to_string(),
        };

        let msg = format!("{}", error);
        assert_eq!(msg, "Duplicate node ID 'dupe-id' in tree validation");
    }

    #[test]
    fn test_scene_diff_error_invalid_id_display() {
        let error = SceneDiffError::InvalidId {
            id: "bad@id".to_string(),
            reason: "contains invalid character '@'".to_string(),
        };

        let msg = format!("{}", error);
        assert_eq!(
            msg,
            "Invalid node ID 'bad@id': contains invalid character '@'"
        );
    }

    #[test]
    fn test_scene_diff_error_node_not_found_display() {
        let error = SceneDiffError::NodeNotFound {
            id: "missing-node".to_string(),
        };

        let msg = format!("{}", error);
        assert_eq!(msg, "Node not found: 'missing-node'");
    }

    #[test]
    fn test_scene_diff_error_index_out_of_bounds_display() {
        let error = SceneDiffError::IndexOutOfBounds {
            parent_id: "parent".to_string(),
            index: 5,
            len: 3,
        };

        let msg = format!("{}", error);
        assert_eq!(
            msg,
            "Index 5 out of bounds for parent 'parent' with 3 children"
        );
    }

    #[test]
    fn test_scene_diff_error_patch_application_failed_display() {
        let error = SceneDiffError::PatchApplicationFailed {
            reason: "SetRoot must be the only patch".to_string(),
        };

        let msg = format!("{}", error);
        assert_eq!(msg, "Cannot apply patch: SetRoot must be the only patch");
    }

    #[test]
    fn test_scene_diff_error_validation_failed_display() {
        let error = SceneDiffError::ValidationFailed {
            reason: "tree contains cycles".to_string(),
        };

        let msg = format!("{}", error);
        assert_eq!(msg, "Tree validation failed: tree contains cycles");
    }

    #[test]
    fn test_scene_diff_error_kind_changed_display() {
        let error = SceneDiffError::KindChangedForId {
            id: "node-1".to_string(),
            old_kind: NodeKind::Container,
            new_kind: NodeKind::Text,
        };

        let msg = format!("{}", error);
        assert_eq!(
            msg,
            "Kind changed for node 'node-1': Container -> Text. Same ID implies same kind."
        );
    }

    // =========================================================================
    // DiffDiagnostics Tests
    // =========================================================================

    #[test]
    fn test_diff_diagnostics_default_values() {
        let diag = DiffDiagnostics::default();

        assert_eq!(diag.patch_count, 0);
        assert_eq!(diag.nodes_removed, 0);
        assert_eq!(diag.nodes_inserted, 0);
        assert_eq!(diag.nodes_updated, 0);
        assert_eq!(diag.nodes_moved, 0);
        assert_eq!(diag.reorders, 0);
        assert!(!diag.root_replaced);
        assert_eq!(diag.elapsed_micros, 0);
    }

    #[test]
    fn test_diff_diagnostics_serialization() {
        let diag = DiffDiagnostics {
            patch_count: 10,
            nodes_removed: 2,
            nodes_inserted: 5,
            nodes_updated: 3,
            nodes_moved: 0,
            reorders: 0,
            root_replaced: false,
            elapsed_micros: 1234,
        };

        let json = serde_json::to_string(&diag).unwrap();
        let deserialized: DiffDiagnostics = serde_json::from_str(&json).unwrap();

        assert_eq!(diag.patch_count, deserialized.patch_count);
        assert_eq!(diag.nodes_removed, deserialized.nodes_removed);
        assert_eq!(diag.nodes_inserted, deserialized.nodes_inserted);
        assert_eq!(diag.elapsed_micros, deserialized.elapsed_micros);
    }

    #[test]
    fn test_diff_diagnostics_with_elapsed() {
        let diag = DiffDiagnostics::default().with_elapsed(std::time::Duration::from_micros(5000));

        assert_eq!(diag.elapsed_micros, 5000);
    }

    #[test]
    fn test_diff_diagnostics_finalize() {
        let diag = DiffDiagnostics {
            patch_count: 0, // Will be computed
            nodes_removed: 2,
            nodes_inserted: 3,
            nodes_updated: 1,
            nodes_moved: 1,
            reorders: 1,
            root_replaced: false,
            elapsed_micros: 0,
        }
        .finalize();

        assert_eq!(diag.patch_count, 8); // 2 + 3 + 1 + 1 + 1 = 8
    }

    #[test]
    fn test_diff_diagnostics_finalize_with_root_replaced() {
        let diag = DiffDiagnostics {
            patch_count: 0,
            nodes_removed: 0,
            nodes_inserted: 0,
            nodes_updated: 0,
            nodes_moved: 0,
            reorders: 0,
            root_replaced: true,
            elapsed_micros: 0,
        }
        .finalize();

        assert_eq!(diag.patch_count, 1); // Only SetRoot
    }

    // =========================================================================
    // SceneDiffError Serialization Tests
    // =========================================================================

    #[test]
    fn test_scene_diff_error_serialization_duplicate_id() {
        let error = SceneDiffError::DuplicateId {
            id: "test-id".to_string(),
            context: "validation".to_string(),
        };

        let json = serde_json::to_string(&error).unwrap();
        let deserialized: SceneDiffError = serde_json::from_str(&json).unwrap();

        assert_eq!(error, deserialized);
    }

    #[test]
    fn test_scene_diff_error_serialization_kind_changed() {
        let error = SceneDiffError::KindChangedForId {
            id: "node-x".to_string(),
            old_kind: NodeKind::Image,
            new_kind: NodeKind::Canvas,
        };

        let json = serde_json::to_string(&error).unwrap();
        let deserialized: SceneDiffError = serde_json::from_str(&json).unwrap();

        assert_eq!(error, deserialized);
    }

    // =========================================================================
    // PropChanges Serialization Tests
    // =========================================================================

    #[test]
    fn test_prop_changes_serialization_empty() {
        let changes = PropChanges::default();

        let json = serde_json::to_string(&changes).unwrap();
        // Empty PropChanges should serialize to "{}" due to skip_serializing_if
        assert_eq!(json, "{}");

        let deserialized: PropChanges = serde_json::from_str(&json).unwrap();
        assert_eq!(changes, deserialized);
    }

    #[test]
    fn test_prop_changes_serialization_with_values() {
        let changes = PropChanges {
            visible: Some(false),
            z_index: Some(Some(100)),
            ..Default::default()
        };

        let json = serde_json::to_string(&changes).unwrap();
        let deserialized: PropChanges = serde_json::from_str(&json).unwrap();

        assert_eq!(changes, deserialized);
        assert!(json.contains("\"visible\":false"));
        assert!(json.contains("\"z_index\":100"));
    }
}
