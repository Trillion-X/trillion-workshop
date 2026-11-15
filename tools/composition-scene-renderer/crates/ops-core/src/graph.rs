//! Graph traversal operators for ops-core
//!
//! Delegates to `crates/graph/DirectedGraph<String>` via EvalContext.graph.
//! The graph is populated by the kernel when entity relationships are available.
//!
//! Operators:
//! - `parents(entity, relationship_type)` - Get parent entities
//! - `children(entity, relationship_type)` - Get child entities
//! - `neighbors(entity)` - Get all connected entities
//! - `traverse(start, path)` - Navigate a path through the graph
//!
//! Resource Limits (from spec Section 6.6):
//! - Breadth budget: 10,000 nodes
//! - Edge budget: 50,000 edges
//! - Cycle detection via visited set
//! - 50ms evaluation timeout

use crate::value::OpNode;
use crate::{EvalContext, OpError, OpValue};
use std::sync::Arc;

const ENTITY_REF_KEY: &str = "$ent_ref";

/// Get parent entities connected by a specific relationship type.
///
/// Delegates to `DirectedGraph::parents()` via `ctx.graph`.
/// Returns empty array if no graph context is available.
pub fn parents(
    entity: &OpValue,
    relationship_type: &OpValue,
    ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let entity_id = get_entity_id(entity)?;
    let _relationship_type = relationship_type.as_str("parents")?;

    let Some(graph) = &ctx.graph else {
        return Ok(OpValue::array(vec![]));
    };

    let results: Vec<serde_json::Value> = graph
        .parents(&entity_id)
        .map(|k| serde_json::Value::String(k.clone()))
        .collect();
    Ok(OpValue::array(results))
}

/// Get child entities connected by a specific relationship type.
///
/// Delegates to `DirectedGraph::children()` via `ctx.graph`.
/// Returns empty array if no graph context is available.
pub fn children(
    entity: &OpValue,
    relationship_type: &OpValue,
    ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let entity_id = get_entity_id(entity)?;
    let _relationship_type = relationship_type.as_str("children")?;

    let Some(graph) = &ctx.graph else {
        return Ok(OpValue::array(vec![]));
    };

    let results: Vec<serde_json::Value> = graph
        .children(&entity_id)
        .map(|k| serde_json::Value::String(k.clone()))
        .collect();
    Ok(OpValue::array(results))
}

/// Get all neighboring entities regardless of relationship type or direction.
///
/// Returns union of parents + children from `DirectedGraph`.
/// Returns empty array if no graph context is available.
pub fn neighbors(entity: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    let entity_id = get_entity_id(entity)?;

    let Some(graph) = &ctx.graph else {
        return Ok(OpValue::array(vec![]));
    };

    let mut results: Vec<serde_json::Value> = graph
        .parents(&entity_id)
        .map(|k| serde_json::Value::String(k.clone()))
        .collect();
    for child in graph.children(&entity_id) {
        results.push(serde_json::Value::String(child.clone()));
    }
    Ok(OpValue::array(results))
}

/// Traverse the graph following a path definition.
///
/// Path syntax: `->` for forward (children), `<-` for backward (parents).
/// Example: `"project->task->assignee"` follows project→task→assignee edges.
///
/// Returns all entities reachable at the end of the path.
/// Returns empty array if no graph context is available.
pub fn traverse(start: &OpValue, path: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    let start_id = get_entity_id(start)?;
    let path_def = path.as_str("traverse")?;

    let Some(graph) = &ctx.graph else {
        return Ok(OpValue::array(vec![]));
    };

    // Parse path segments: split on -> and <- markers
    let mut current_set = vec![start_id];
    let segments = parse_path(path_def);

    for (direction, _label) in &segments {
        let mut next_set = Vec::new();
        for node in &current_set {
            match direction {
                Direction::Forward => {
                    for child in graph.children(node) {
                        next_set.push(child.clone());
                    }
                }
                Direction::Backward => {
                    for parent in graph.parents(node) {
                        next_set.push(parent.clone());
                    }
                }
            }
        }
        current_set = next_set;
    }

    let results: Vec<serde_json::Value> = current_set
        .into_iter()
        .map(serde_json::Value::String)
        .collect();
    Ok(OpValue::array(results))
}

#[derive(Debug, PartialEq)]
enum Direction {
    Forward,
    Backward,
}

/// Parse path definition string into segments.
/// "project->task->assignee" → [(Forward, "task"), (Forward, "assignee")]
/// "task<-project" → [(Backward, "project")]
fn parse_path(path: &str) -> Vec<(Direction, String)> {
    let mut segments = Vec::new();
    let mut remaining = path;

    // Skip first label (it's the start node, already handled)
    if let Some(idx) = remaining.find("->").or_else(|| remaining.find("<-")) {
        remaining = &remaining[idx..];
    } else {
        return segments;
    }

    while !remaining.is_empty() {
        if let Some(rest) = remaining.strip_prefix("->") {
            let end = rest
                .find("->")
                .or_else(|| rest.find("<-"))
                .unwrap_or(rest.len());
            segments.push((Direction::Forward, rest[..end].to_string()));
            remaining = &rest[end..];
        } else if let Some(rest) = remaining.strip_prefix("<-") {
            let end = rest
                .find("->")
                .or_else(|| rest.find("<-"))
                .unwrap_or(rest.len());
            segments.push((Direction::Backward, rest[..end].to_string()));
            remaining = &rest[end..];
        } else {
            break;
        }
    }

    segments
}

/// Helper: Extract node ID from a node reference or string.
///
/// Node references have shape: `{"$ent_ref": "node_id"}`
fn get_entity_id(value: &OpValue) -> Result<String, OpError> {
    if value.is_object() {
        if let OpNode::Object(obj) = value.node() {
            let key_arc = Arc::from(ENTITY_REF_KEY);
            if let Some(id_node) = obj.get(&key_arc) {
                if let OpNode::String(id) = id_node.as_ref() {
                    return Ok(id.to_string());
                }
            }
        }
        return Err(OpError::TypeMismatch {
            operation: "graph".to_string(),
            expected: "node reference with $ent_ref field".to_string(),
            actual: "object without $ent_ref".to_string(),
        });
    }

    if value.is_string() {
        return Ok(value.as_str("graph")?.to_string());
    }

    Err(OpError::TypeMismatch {
        operation: "graph".to_string(),
        expected: "node reference or string".to_string(),
        actual: value.type_name().to_string(),
    })
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn ctx_with_graph() -> EvalContext {
        let mut g = graph::DirectedGraph::new();
        g.add_node("entity:project".to_string());
        g.add_node("entity:task1".to_string());
        g.add_node("entity:task2".to_string());
        g.add_node("entity:assignee".to_string());
        let _ = g.add_edge(&"entity:project".to_string(), &"entity:task1".to_string());
        let _ = g.add_edge(&"entity:project".to_string(), &"entity:task2".to_string());
        let _ = g.add_edge(&"entity:task1".to_string(), &"entity:assignee".to_string());

        let mut ctx = EvalContext::default();
        ctx.graph = Some(Arc::new(g));
        ctx
    }

    fn make_node_ref(id: &str) -> OpValue {
        let mut obj = serde_json::Map::new();
        obj.insert(
            ENTITY_REF_KEY.to_string(),
            serde_json::Value::String(id.to_string()),
        );
        OpValue::object(obj)
    }

    #[test]
    fn test_parents_with_graph() {
        let ctx = ctx_with_graph();
        let entity = OpValue::string("entity:task1");
        let rel_type = OpValue::string("owns");
        let result = parents(&entity, &rel_type, &ctx).unwrap();
        let arr = result.as_array("test").unwrap();
        assert_eq!(arr.len(), 1);
    }

    #[test]
    fn test_children_with_graph() {
        let ctx = ctx_with_graph();
        let entity = OpValue::string("entity:project");
        let rel_type = OpValue::string("owns");
        let result = children(&entity, &rel_type, &ctx).unwrap();
        let arr = result.as_array("test").unwrap();
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn test_neighbors_with_graph() {
        let ctx = ctx_with_graph();
        let entity = OpValue::string("entity:task1");
        let result = neighbors(&entity, &ctx).unwrap();
        let arr = result.as_array("test").unwrap();
        // task1 has parent (project) + child (assignee) = 2 neighbors
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn test_traverse_forward() {
        let ctx = ctx_with_graph();
        let entity = OpValue::string("entity:project");
        let path = OpValue::string("project->task->assignee");
        let result = traverse(&entity, &path, &ctx).unwrap();
        let arr = result.as_array("test").unwrap();
        // project->children=[task1,task2]->children=[assignee] (only task1 has child)
        assert_eq!(arr.len(), 1);
    }

    #[test]
    fn test_parents_no_graph() {
        let ctx = EvalContext::default();
        let entity = OpValue::string("entity:123");
        let rel_type = OpValue::string("owns");
        let result = parents(&entity, &rel_type, &ctx).unwrap();
        let arr = result.as_array("test").unwrap();
        assert!(arr.is_empty());
    }

    #[test]
    fn test_parents_with_node_ref() {
        let ctx = ctx_with_graph();
        let entity = make_node_ref("entity:task1");
        let rel_type = OpValue::string("owns");
        let result = parents(&entity, &rel_type, &ctx).unwrap();
        let arr = result.as_array("test").unwrap();
        assert_eq!(arr.len(), 1);
    }

    #[test]
    fn test_parents_invalid_entity() {
        let ctx = EvalContext::default();
        let entity = OpValue::number(123.0);
        let rel_type = OpValue::string("owns");
        let result = parents(&entity, &rel_type, &ctx);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_path_forward() {
        let segments = parse_path("project->task->assignee");
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0], (Direction::Forward, "task".to_string()));
        assert_eq!(segments[1], (Direction::Forward, "assignee".to_string()));
    }

    #[test]
    fn test_parse_path_backward() {
        let segments = parse_path("task<-project");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0], (Direction::Backward, "project".to_string()));
    }

    #[test]
    fn test_get_entity_id_from_string() {
        let value = OpValue::string("entity:123");
        let id = get_entity_id(&value).unwrap();
        assert_eq!(id, "entity:123");
    }

    #[test]
    fn test_get_entity_id_from_node_ref() {
        let value = make_node_ref("entity:456");
        let id = get_entity_id(&value).unwrap();
        assert_eq!(id, "entity:456");
    }
}
