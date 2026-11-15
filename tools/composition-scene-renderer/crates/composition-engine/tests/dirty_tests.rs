//! Integration tests for composition-engine BindingDepIndex dirty tracking
//!
//! Tests the BindingDepIndex's bidirectional dependency tracking between
//! context keys and scene nodes.

use composition_engine::kernel::dirty::{BindingDepIndex, DepKey};
use std::collections::HashSet;

#[test]
fn test_binding_dep_index_new() {
    let index = BindingDepIndex::new();
    assert_eq!(index.dep_count(), 0);
    assert_eq!(index.node_count(), 0);
}

#[test]
fn test_binding_dep_index_record() {
    let mut index = BindingDepIndex::new();
    index.record("node:1", DepKey::Fsm("fsm:editor:main".to_string()));

    assert_eq!(index.dep_count(), 1);
    assert_eq!(index.node_count(), 1);
}

#[test]
fn test_binding_dep_index_record_multiple() {
    let mut index = BindingDepIndex::new();
    index.record("node:1", DepKey::Fsm("fsm:editor:main".to_string()));
    index.record("node:2", DepKey::Fsm("fsm:editor:main".to_string()));
    index.record("node:1", DepKey::Ambient("theme".to_string()));

    assert!(index.dep_count() > 0);
    assert_eq!(index.node_count(), 2);
}

#[test]
fn test_binding_dep_index_resolve_fsm() {
    let mut index = BindingDepIndex::new();
    index.record("node:a", DepKey::Fsm("fsm:modal:main".to_string()));
    index.record("node:b", DepKey::Fsm("fsm:modal:main".to_string()));
    index.record("node:c", DepKey::Ambient("color".to_string()));

    let mut fsm_keys = HashSet::new();
    fsm_keys.insert("fsm:modal:main".to_string());

    let affected = index.resolve_dirty_nodes(
        &fsm_keys,
        &HashSet::new(),
        &HashSet::new(),
        &HashSet::new(),
        &Default::default(),
    );

    assert_eq!(affected.len(), 2);
    assert!(affected.contains("node:a"));
    assert!(affected.contains("node:b"));
    assert!(!affected.contains("node:c"));
}

#[test]
fn test_binding_dep_index_resolve_ambient() {
    let mut index = BindingDepIndex::new();
    index.record("node:1", DepKey::Ambient("theme".to_string()));
    index.record("node:2", DepKey::Ambient("locale".to_string()));

    let mut ambient_keys = HashSet::new();
    ambient_keys.insert("theme".to_string());

    let affected = index.resolve_dirty_nodes(
        &HashSet::new(),
        &HashSet::new(),
        &ambient_keys,
        &HashSet::new(),
        &Default::default(),
    );

    assert_eq!(affected.len(), 1);
    assert!(affected.contains("node:1"));
    assert!(!affected.contains("node:2"));
}

#[test]
fn test_binding_dep_index_wildcard_fsm() {
    let mut index = BindingDepIndex::new();
    index.record("node:1", DepKey::Fsm("*".to_string()));
    index.record("node:2", DepKey::Fsm("fsm:specific".to_string()));

    let mut fsm_keys = HashSet::new();
    fsm_keys.insert("*".to_string());

    let affected = index.resolve_dirty_nodes(
        &fsm_keys,
        &HashSet::new(),
        &HashSet::new(),
        &HashSet::new(),
        &Default::default(),
    );

    assert!(affected.contains("node:1"));
}

#[test]
fn test_binding_dep_index_scene_structure_change() {
    let mut index = BindingDepIndex::new();
    index.record("node:1", DepKey::Scene("layout:header".to_string()));
    index.record("node:2", DepKey::Scene("layout:body".to_string()));

    let mut changed_ids = HashSet::new();
    changed_ids.insert("layout:header".to_string());

    let affected = index.resolve_dirty_nodes(
        &HashSet::new(),
        &HashSet::new(),
        &HashSet::new(),
        &changed_ids,
        &Default::default(),
    );

    assert!(affected.contains("node:1"));
    assert!(!affected.contains("node:2"));
}

#[test]
fn test_binding_dep_index_empty_resolve() {
    let index = BindingDepIndex::new();
    let affected = index.resolve_dirty_nodes(
        &HashSet::new(),
        &HashSet::new(),
        &HashSet::new(),
        &HashSet::new(),
        &Default::default(),
    );

    assert!(affected.is_empty());
}
