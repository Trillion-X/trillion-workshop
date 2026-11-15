//! crates/composition-engine-core/src/kernel/scene_diff_types.rs
//!
//! L088: Scene diff types re-exported from composition-ast (SSOT).
//! composition-ast owns the definitions; composition-engine re-exports them.

// Re-export ALL scene diff types from composition-ast
pub use composition_ast::kernel::scene_diff_types::*;

// ============================================================================
// Tests (exercise the re-exported types within composition-engine context)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::{NodeKind, NodeProps, SceneNode, Visibility};

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
    }

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
    fn test_diff_diagnostics_default_values() {
        let diag = DiffDiagnostics::default();
        assert_eq!(diag.patch_count, 0);
        assert_eq!(diag.nodes_removed, 0);
        assert!(!diag.root_replaced);
    }

    #[test]
    fn test_diff_diagnostics_finalize() {
        let diag = DiffDiagnostics {
            patch_count: 0,
            nodes_removed: 2,
            nodes_inserted: 3,
            nodes_updated: 1,
            nodes_moved: 1,
            reorders: 1,
            root_replaced: false,
            elapsed_micros: 0,
        }
        .finalize();
        assert_eq!(diag.patch_count, 8);
    }
}
