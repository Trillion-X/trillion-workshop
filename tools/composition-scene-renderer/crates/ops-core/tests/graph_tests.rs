//! Integration tests for ops-core graph module stubs
//!
//! Tests that graph operations validate inputs correctly and return expected
//! stub results. These tests verify the integration between ops-core and the
//! underlying DirectedGraph implementations.

use ops_core::{EvalContext, OpValue};

fn ctx() -> EvalContext {
    EvalContext::default()
}

fn make_entity_ref(id: &str) -> OpValue {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "$ent_ref".to_string(),
        serde_json::Value::String(id.to_string()),
    );
    OpValue::object(obj)
}

#[test]
fn test_parents_accepts_entity_ref() {
    let entity = make_entity_ref("entity:parent:1");
    let rel_type = OpValue::string("contains");
    let result = ops_core::graph::parents(&entity, &rel_type, &ctx()).unwrap();
    assert!(result.is_array());
    let arr = result.as_array("test").unwrap();
    // Stub returns empty array
    assert!(arr.is_empty());
}

#[test]
fn test_parents_accepts_string_id() {
    let entity = OpValue::string("entity:123");
    let rel_type = OpValue::string("child_of");
    let result = ops_core::graph::parents(&entity, &rel_type, &ctx()).unwrap();
    assert!(result.is_array());
}

#[test]
fn test_parents_rejects_invalid_entity() {
    let entity = OpValue::number(42.0);
    let rel_type = OpValue::string("owns");
    let result = ops_core::graph::parents(&entity, &rel_type, &ctx());
    assert!(result.is_err());
}

#[test]
fn test_parents_rejects_non_string_relationship() {
    let entity = OpValue::string("entity:1");
    let rel_type = OpValue::array(vec![]);
    let result = ops_core::graph::parents(&entity, &rel_type, &ctx());
    assert!(result.is_err());
}

#[test]
fn test_children_returns_array() {
    let entity = OpValue::string("entity:parent");
    let rel_type = OpValue::string("owns");
    let result = ops_core::graph::children(&entity, &rel_type, &ctx()).unwrap();
    assert!(result.is_array());
    let arr = result.as_array("test").unwrap();
    assert!(arr.is_empty());
}

#[test]
fn test_children_validates_inputs() {
    let entity = OpValue::number(123.0);
    let rel_type = OpValue::string("owns");
    let result = ops_core::graph::children(&entity, &rel_type, &ctx());
    assert!(result.is_err());
}

#[test]
fn test_neighbors_returns_array() {
    let entity = OpValue::string("entity:node");
    let result = ops_core::graph::neighbors(&entity, &ctx()).unwrap();
    assert!(result.is_array());
    let arr = result.as_array("test").unwrap();
    assert!(arr.is_empty());
}

#[test]
fn test_neighbors_validates_entity() {
    let entity = OpValue::bool(true);
    let result = ops_core::graph::neighbors(&entity, &ctx());
    assert!(result.is_err());
}

#[test]
fn test_traverse_returns_array() {
    let start = OpValue::string("entity:root");
    let path = OpValue::string("owns->item->category");
    let result = ops_core::graph::traverse(&start, &path, &ctx()).unwrap();
    assert!(result.is_array());
    let arr = result.as_array("test").unwrap();
    assert!(arr.is_empty());
}

#[test]
fn test_traverse_validates_path_type() {
    let start = OpValue::string("entity:root");
    let path = OpValue::number(123.0);
    let result = ops_core::graph::traverse(&start, &path, &ctx());
    assert!(result.is_err());
}

#[test]
fn test_traverse_with_entity_ref() {
    let start = make_entity_ref("entity:start");
    let path = OpValue::string("parent<-child");
    let result = ops_core::graph::traverse(&start, &path, &ctx()).unwrap();
    assert!(result.is_array());
}
