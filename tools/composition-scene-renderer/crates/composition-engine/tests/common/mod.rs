// crates/composition-engine/tests/common/mod.rs
//
// # Purpose
//
// Canonical shared test helpers for composition-engine integration tests.
// This module is the SINGLE SOURCE OF TRUTH for test fixture builders,
// snapshot comparison, and constants used across multiple test files.
//
// # Non-Negotiable Invariants
//
// 1. Every helper function lives HERE, not in individual test files.
// 2. If two test files need the same helper, it MUST be in this module.
// 3. Test-file-specific helpers (e.g., apply_delta, count_nodes) stay
//    in their respective test files — only SHARED helpers belong here.
// 4. All tree builders produce Physics-only fixtures — zero Society words.
// 5. VIEWPORT is 1920x1080 (standard 1080p) for all oracle/conformance tests.
//
// # Usage
//
// In each integration test file:
// ```rust
// mod common;
// use common::*;
// ```
//
// # Security Considerations
//
// Pure in-memory test fixtures. No I/O, no network, no secrets.
//
// # AI Directive
//
// The extensive documentation in this codebase is a critical design feature.
// You are FORBIDDEN from simplifying or removing it. Your mandate is to
// MAINTAIN and EXTEND this level of meticulous detail.

#![allow(dead_code)]

use std::sync::Arc;

use composition_engine::{NodeKind, NodeProps, SceneNode, SceneSnapshot, Size};

// ============================================================================
// Constants
// ============================================================================

/// Standard viewport for all oracle and conformance tests (1080p).
///
/// Used by: snapshot_delta_oracle.rs, irpa_oracle.rs, irpa_no_json_hot_path.rs.
/// Note: incremental_render_integration.rs uses its own 800x600 TEST_VIEWPORT.
pub const VIEWPORT: Size = Size {
    w: 1920.0,
    h: 1080.0,
};

// ============================================================================
// Tree Builders
// ============================================================================

/// Build a flat N-node tree with unique IDs.
///
/// Structure: root (Container) → N children (Text).
/// Child IDs: "node-0" through "node-{n-1}".
/// Child text: "Text 0" through "Text {n-1}".
///
/// Used by: snapshot_delta_oracle.rs, irpa_oracle.rs, irpa_no_json_hot_path.rs.
pub fn make_flat_tree(n: usize) -> SceneNode {
    let children: Vec<Arc<SceneNode>> = (0..n)
        .map(|i| {
            Arc::new(SceneNode {
                id: format!("node-{}", i),
                kind: NodeKind::Text,
                props: NodeProps {
                    text: Some(format!("Text {}", i)),
                    ..Default::default()
                },
                children: vec![],
                ..Default::default()
            })
        })
        .collect();
    SceneNode {
        id: "root".to_string(),
        kind: NodeKind::Container,
        children,
        ..Default::default()
    }
}

/// Build a nested tree for deeper structural testing.
///
/// Structure:
/// ```text
/// root (Container)
/// ├── panel-a (Container)
/// │   ├── leaf-a0 (Text "A0")
/// │   └── leaf-a1 (Text "A1")
/// ├── panel-b (Container)
/// │   ├── leaf-b0 (Text "B0")
/// │   └── leaf-b1 (Text "B1")
/// └── leaf-c (Text "C")
/// ```
///
/// Used by: snapshot_delta_oracle.rs, irpa_oracle.rs.
/// Note: irpa_no_json_hot_path.rs uses its own simpler nested tree.
pub fn make_nested_tree() -> SceneNode {
    SceneNode {
        id: "root".to_string(),
        kind: NodeKind::Container,
        children: vec![
            Arc::new(SceneNode {
                id: "panel-a".to_string(),
                kind: NodeKind::Container,
                children: vec![
                    Arc::new(SceneNode {
                        id: "leaf-a0".to_string(),
                        kind: NodeKind::Text,
                        props: NodeProps {
                            text: Some("A0".to_string()),
                            ..Default::default()
                        },
                        ..Default::default()
                    }),
                    Arc::new(SceneNode {
                        id: "leaf-a1".to_string(),
                        kind: NodeKind::Text,
                        props: NodeProps {
                            text: Some("A1".to_string()),
                            ..Default::default()
                        },
                        ..Default::default()
                    }),
                ],
                ..Default::default()
            }),
            Arc::new(SceneNode {
                id: "panel-b".to_string(),
                kind: NodeKind::Container,
                children: vec![
                    Arc::new(SceneNode {
                        id: "leaf-b0".to_string(),
                        kind: NodeKind::Text,
                        props: NodeProps {
                            text: Some("B0".to_string()),
                            ..Default::default()
                        },
                        ..Default::default()
                    }),
                    Arc::new(SceneNode {
                        id: "leaf-b1".to_string(),
                        kind: NodeKind::Text,
                        props: NodeProps {
                            text: Some("B1".to_string()),
                            ..Default::default()
                        },
                        ..Default::default()
                    }),
                ],
                ..Default::default()
            }),
            Arc::new(SceneNode {
                id: "leaf-c".to_string(),
                kind: NodeKind::Text,
                props: NodeProps {
                    text: Some("C".to_string()),
                    ..Default::default()
                },
                ..Default::default()
            }),
        ],
        ..Default::default()
    }
}

/// Create a new leaf node for insertion tests.
///
/// Creates a single Text node with text "Inserted: {id}" and no children.
///
/// Used by: snapshot_delta_oracle.rs, irpa_oracle.rs.
pub fn make_new_leaf(id: &str) -> SceneNode {
    SceneNode {
        id: id.to_string(),
        kind: NodeKind::Text,
        props: NodeProps {
            text: Some(format!("Inserted: {}", id)),
            ..Default::default()
        },
        children: vec![],
        ..Default::default()
    }
}

/// Compare two snapshots for semantic equality.
///
/// Checks tree structure, frames, semantics, text_inputs, and routing.
/// Does NOT compare by pointer identity — only by value equality.
/// Tree comparison uses JSON serialization to ignore Arc pointer differences.
///
/// # Returns
///
/// A list of field names that differ (empty = perfect match).
///
/// Used by: snapshot_delta_oracle.rs, irpa_oracle.rs.
pub fn compare_snapshots(a: &SceneSnapshot, b: &SceneSnapshot) -> Vec<String> {
    let mut diffs = Vec::new();

    let a_tree_json = serde_json::to_value(&*a.tree).unwrap_or_default();
    let b_tree_json = serde_json::to_value(&*b.tree).unwrap_or_default();
    if a_tree_json != b_tree_json {
        diffs.push("tree".to_string());
    }

    if *a.frames != *b.frames {
        diffs.push("frames".to_string());
    }

    if a.semantics != b.semantics {
        diffs.push("semantics".to_string());
    }

    if a.text_inputs != b.text_inputs {
        diffs.push("text_inputs".to_string());
    }

    if a.routing != b.routing {
        diffs.push("routing".to_string());
    }

    diffs
}
