//! Tests for DirectedGraph CRUD operations and traversal algorithms.
//!
//! File: crates/graph/tests/directed_tests.rs
//! Purpose: Verify DirectedGraph behavior, cycle detection, edge metadata, and lazy traversal
//! Coverage: CRUD, cycle detection, metadata, zero-cost defaults, lazy BFS/DFS, topo_sort, SCCs

use graph::{algorithms, DirectedGraph};

#[test]
fn directed_crud() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    // Add nodes
    assert!(g.add_node("a"));
    assert!(g.add_node("b"));
    assert!(g.add_node("c"));

    // Duplicate add fails
    assert!(!g.add_node("a"));

    // Check counts
    assert_eq!(g.node_count(), 3);
    assert_eq!(g.edge_count(), 0);

    // Remove a node
    let removed = g.remove_node(&"b");
    assert!(removed.is_some());
    assert_eq!(g.node_count(), 2);

    // Check non-existent node
    assert!(g.remove_node(&"nonexistent").is_none());
}

#[test]
fn remove_node_returns_edges() {
    let mut g: DirectedGraph<&str, i32> = DirectedGraph::new();

    g.add_node(&"a");
    g.add_node(&"b");
    g.add_node(&"c");

    // Add edges with metadata (avoid cycles)
    g.add_edge_with(&"a", &"b", 100).unwrap();
    g.add_edge_with(&"c", &"b", 200).unwrap();
    g.add_edge_with(&"a", &"c", 300).unwrap();

    // Remove node b
    let removed = g.remove_node(&"b").unwrap();

    assert_eq!(removed.key, "b");
    assert_eq!(removed.incoming.len(), 2);
    assert_eq!(removed.outgoing.len(), 0);

    // Check incoming edges
    let incoming_keys: Vec<_> = removed.incoming.iter().map(|(k, _)| *k).collect();
    assert!(incoming_keys.contains(&"a"));
    assert!(incoming_keys.contains(&"c"));

    // Check metadata
    let metadata: Vec<_> = removed.incoming.iter().map(|(_, m)| *m).collect();
    assert!(metadata.contains(&100));
    assert!(metadata.contains(&200));
}

#[test]
fn edge_metadata() {
    let mut g: DirectedGraph<&str, String> = DirectedGraph::new();

    g.add_node("x");
    g.add_node("y");

    let meta = "important link".to_string();
    g.add_edge_with(&"x", &"y", meta.clone()).unwrap();

    assert!(g.has_edge(&"x", &"y"));

    // Remove and recover metadata
    let recovered = g.remove_edge(&"x", &"y");
    assert_eq!(recovered, Some(meta));
}

#[test]
fn zero_cost_default() {
    let mut g: DirectedGraph<String, ()> = DirectedGraph::new();

    let node1 = "node1".to_string();
    let node2 = "node2".to_string();
    g.add_node(node1.clone());
    g.add_node(node2.clone());
    g.add_edge(&node1, &node2).unwrap();

    assert_eq!(g.node_count(), 2);
    assert_eq!(g.edge_count(), 1);
}

#[test]
fn cycle_on_mutation() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"a");
    g.add_node(&"b");
    g.add_node(&"c");

    g.add_edge(&"a", &"b").unwrap();
    g.add_edge(&"b", &"c").unwrap();

    // Attempt to add c → a (would create cycle a → b → c → a)
    let result = g.add_edge(&"c", &"a");
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(!err.path.is_empty());
}

#[test]
fn self_loop_rejected() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"a");

    let result = g.add_edge(&"a", &"a");
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.path.len(), 1);
    assert_eq!(err.path[0], "a");
}

#[test]
fn directed_single_hop() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"root");
    g.add_node(&"child1");
    g.add_node(&"child2");

    g.add_edge(&"root", &"child1").unwrap();
    g.add_edge(&"root", &"child2").unwrap();
    g.add_edge(&"child1", &"child2").unwrap();

    // Check children of root
    let children: Vec<_> = g.children(&"root").cloned().collect();
    assert_eq!(children.len(), 2);
    assert!(children.contains(&"child1"));
    assert!(children.contains(&"child2"));

    // Check parents of child2
    let parents: Vec<_> = g.parents(&"child2").cloned().collect();
    assert_eq!(parents.len(), 2);
    assert!(parents.contains(&"root"));
    assert!(parents.contains(&"child1"));

    // child1 has no children (only child2, which is not a parent)
    let child1_children: Vec<_> = g.children(&"child1").cloned().collect();
    assert_eq!(child1_children.len(), 1);
    assert_eq!(child1_children[0], "child2");
}

#[test]
fn edge_removal() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"a");
    g.add_node(&"b");
    g.add_edge(&"a", &"b").unwrap();

    assert!(g.has_edge(&"a", &"b"));
    assert_eq!(g.edge_count(), 1);

    let removed = g.remove_edge(&"a", &"b");
    assert_eq!(removed, Some(()));
    assert!(!g.has_edge(&"a", &"b"));
    assert_eq!(g.edge_count(), 0);

    // Removing non-existent edge returns None
    let removed = g.remove_edge(&"a", &"b");
    assert_eq!(removed, None);
}

#[test]
fn has_node_has_edge() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"a");
    g.add_node(&"b");
    g.add_edge(&"a", &"b").unwrap();

    assert!(g.has_node(&"a"));
    assert!(g.has_node(&"b"));
    assert!(!g.has_node(&"c"));

    assert!(g.has_edge(&"a", &"b"));
    assert!(!g.has_edge(&"b", &"a"));
    assert!(!g.has_edge(&"a", &"c"));
}

#[test]
fn directed_transitive_lazy() {
    // Build a DAG: a → b → d, a → c → d
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"a");
    g.add_node(&"b");
    g.add_node(&"c");
    g.add_node(&"d");

    g.add_edge(&"a", &"b").unwrap();
    g.add_edge(&"b", &"d").unwrap();
    g.add_edge(&"a", &"c").unwrap();
    g.add_edge(&"c", &"d").unwrap();

    // Descendants of 'a' should include b, c, d
    let descendants: Vec<_> = g.descendants(&"a").collect();
    assert_eq!(descendants.len(), 3);
    assert!(descendants.contains(&"b"));
    assert!(descendants.contains(&"c"));
    assert!(descendants.contains(&"d"));

    // Ancestors of 'd' should include a, b, c
    let ancestors: Vec<_> = g.ancestors(&"d").collect();
    assert_eq!(ancestors.len(), 3);
    assert!(ancestors.contains(&"a"));
    assert!(ancestors.contains(&"b"));
    assert!(ancestors.contains(&"c"));

    // Descendants of 'b' should be just d
    let b_descendants: Vec<_> = g.descendants(&"b").collect();
    assert_eq!(b_descendants.len(), 1);
    assert_eq!(b_descendants[0], "d");
}

#[test]
fn bounded_path_summary_counts_paths_in_depth_range() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"top");
    g.add_node(&"left");
    g.add_node(&"right");
    g.add_node(&"bottom");

    g.add_edge(&"top", &"left").unwrap();
    g.add_edge(&"top", &"right").unwrap();
    g.add_edge(&"left", &"bottom").unwrap();
    g.add_edge(&"right", &"bottom").unwrap();

    let forward = g.bounded_path_summary(&"top", graph::iter::Direction::Forward, 1, 2);
    assert_eq!(forward.path_count, 4);
    assert_eq!(forward.max_depth_reached, Some(2));

    let depth_two_only = g.bounded_path_summary(&"top", graph::iter::Direction::Forward, 2, 2);
    assert_eq!(depth_two_only.path_count, 2);
    assert_eq!(depth_two_only.max_depth_reached, Some(2));

    let reverse = g.bounded_path_summary(&"bottom", graph::iter::Direction::Reverse, 1, 2);
    assert_eq!(reverse.path_count, 4);
    assert_eq!(reverse.max_depth_reached, Some(2));

    let zero_depth = g.bounded_path_summary(&"top", graph::iter::Direction::Forward, 0, 0);
    assert_eq!(zero_depth.path_count, 1);
    assert_eq!(zero_depth.max_depth_reached, Some(0));

    let missing = g.bounded_path_summary(&"missing", graph::iter::Direction::Forward, 1, 2);
    assert_eq!(missing.path_count, 0);
    assert_eq!(missing.max_depth_reached, None);

    let empty_range = g.bounded_path_summary(&"top", graph::iter::Direction::Forward, 3, 2);
    assert_eq!(empty_range.path_count, 0);
    assert_eq!(empty_range.max_depth_reached, None);
}

#[test]
fn topo_sort_deterministic() {
    // Same graph must produce same topo sort (run 5 times)
    let orders: Vec<Vec<_>> = (0..5)
        .map(|_| {
            let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

            g.add_node(&"a");
            g.add_node(&"b");
            g.add_node(&"c");
            g.add_node(&"d");

            g.add_edge(&"a", &"b").unwrap();
            g.add_edge(&"a", &"c").unwrap();
            g.add_edge(&"b", &"d").unwrap();
            g.add_edge(&"c", &"d").unwrap();

            algorithms::topo_sort(&g).collect()
        })
        .collect();

    // All 5 runs should produce the exact same order
    for i in 1..5 {
        assert_eq!(orders[0], orders[i], "Topo sort not deterministic");
    }

    // Order should satisfy: a comes before b, c; b, c come before d
    let first_order = &orders[0];
    let a_pos = first_order.iter().position(|&x| x == "a").unwrap();
    let b_pos = first_order.iter().position(|&x| x == "b").unwrap();
    let c_pos = first_order.iter().position(|&x| x == "c").unwrap();
    let d_pos = first_order.iter().position(|&x| x == "d").unwrap();

    assert!(a_pos < b_pos);
    assert!(a_pos < c_pos);
    assert!(b_pos < d_pos);
    assert!(c_pos < d_pos);
}

#[test]
fn scc_tarjan() {
    // Since DirectedGraph doesn't allow cycles, we test on a DAG
    // and verify that detect_cycles returns no non-trivial SCCs
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"a");
    g.add_node(&"b");
    g.add_node(&"c");
    g.add_node(&"d");

    g.add_edge(&"a", &"b").unwrap();
    g.add_edge(&"b", &"c").unwrap();
    g.add_edge(&"a", &"d").unwrap();

    let sccs = algorithms::detect_cycles(&g);

    // A DAG has no non-trivial SCCs, so detect_cycles should return empty
    assert_eq!(sccs.len(), 0, "DAG should have no cycles");
}

#[test]
fn is_reachable_true() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"a");
    g.add_node(&"b");
    g.add_node(&"c");

    g.add_edge(&"a", &"b").unwrap();
    g.add_edge(&"b", &"c").unwrap();

    // c is reachable from a
    assert!(algorithms::is_reachable(&g, &"a", &"c"));
    // b is reachable from a
    assert!(algorithms::is_reachable(&g, &"a", &"b"));
    // a is reachable from itself
    assert!(algorithms::is_reachable(&g, &"a", &"a"));
}

#[test]
fn is_reachable_false() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"a");
    g.add_node(&"b");
    g.add_node(&"c");

    g.add_edge(&"a", &"b").unwrap();

    // c is not reachable from a
    assert!(!algorithms::is_reachable(&g, &"a", &"c"));
    // a is not reachable from b
    assert!(!algorithms::is_reachable(&g, &"b", &"a"));
}

#[test]
fn is_reachable_nonexistent_nodes() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"a");
    g.add_node(&"b");

    // Non-existent source
    assert!(!algorithms::is_reachable(&g, &"nonexistent", &"b"));
    // Non-existent target
    assert!(!algorithms::is_reachable(&g, &"a", &"nonexistent"));
}

#[test]
fn adversarial_edge_cases() {
    // Test diamond structure
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"top");
    g.add_node(&"left");
    g.add_node(&"right");
    g.add_node(&"bottom");

    g.add_edge(&"top", &"left").unwrap();
    g.add_edge(&"top", &"right").unwrap();
    g.add_edge(&"left", &"bottom").unwrap();
    g.add_edge(&"right", &"bottom").unwrap();

    // Descendants should be deduplicated by visited tracking
    let descendants: Vec<_> = g.descendants(&"top").collect();
    assert_eq!(descendants.len(), 3); // left, right, bottom (no duplicates)

    // Topo sort should work
    let order: Vec<_> = algorithms::topo_sort(&g).collect();
    assert_eq!(order.len(), 4);
}

#[test]
fn disconnected_graph() {
    let mut g: DirectedGraph<&str, ()> = DirectedGraph::new();

    g.add_node(&"a");
    g.add_node(&"b");
    g.add_node(&"c");
    g.add_node(&"d");

    g.add_edge(&"a", &"b").unwrap();
    g.add_edge(&"c", &"d").unwrap();
    // No edges between (a,b) and (c,d)

    // Descendants from 'a' should only include b
    let a_desc: Vec<_> = g.descendants(&"a").collect();
    assert_eq!(a_desc.len(), 1);
    assert_eq!(a_desc[0], "b");

    // Topo sort should include all 4 nodes
    let order: Vec<_> = algorithms::topo_sort(&g).collect();
    assert_eq!(order.len(), 4);
}
