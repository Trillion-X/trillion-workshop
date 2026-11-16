//! Hypergraph Foundation - Core data structures for constraint-based solving
//!
//! This module implements the hypergraph manifold system that replaces tree-walking
//! evaluation with physics-based constraint solving.

use crate::Value;
use std::collections::HashMap;

/// A unique identifier for a node in the hypergraph.
pub type NodeId = u64;

/// A unique identifier for a hyperedge in the hypergraph.
pub type HyperedgeId = u64;

/// A spec for adding edges via the public API (keeps invariants)
#[derive(Debug, Clone)]
pub struct HyperedgeSpec {
    pub constraint_type: ConstraintKind,
    pub tags: Vec<ConstraintKind>,
    pub input_nodes: Vec<NodeId>,
    pub output_node: NodeId,
}

/// A patch represents a set of changes to be applied to the manifold
#[derive(Debug, Default)]
pub struct ManifoldPatch {
    pub edges_to_add: Vec<HyperedgeSpec>,
    pub edges_to_remove: Vec<HyperedgeId>,
}

/// Strongly-typed constraint kinds for compile-time safety and exhaustiveness checking.
#[derive(Debug, Clone, PartialEq, Hash)]
pub enum ConstraintKind {
    // Core arithmetic operations
    Add,
    Subtract,
    Multiply,
    Divide,
    Modulo,
    Negate,

    // Collection operations
    Filter,
    Map,
    Sum,
    Count,
    ConstructArray,
    ConstructObject,

    // Comparison operations
    Equal,
    NotEqual,
    LessThan,
    GreaterThan,
    LessThanOrEqual,
    GreaterThanOrEqual,

    // Range constraints for widening logic (DO NOT DELETE)
    InRange { lower: NodeId, upper: NodeId },

    // Logical operations
    And,
    Or,
    Not,

    // LAZY CONSTRAINTS: These require special handling by the solver.
    If,
    Switch,
    Coalesce,
    IfError,
    Try,

    // --- Architecturally Correct Parametric Variants ---
    // The identity of the operation is correctly part of the constraint itself.
    MemberAccess(String), // CHANGED: Now parametric
    IndexAccess,          // Non-parametric because index identity comes from the edge input.
    FunctionCall { name: String, version: Option<u32> },
    Lambda,
    VariableLookup(String),       // CHANGED: Now parametric
    VersionedLookup(String, u32), // CHANGED: Now parametric

    // Constant value constraint for optimization
    Const(Value),

    // Composite constraint types for widening detection (DO NOT DELETE)
    ArithmeticOp,
    NumericComparison,
    LogicalOp,
}

/// Represents a single, addressable value in the computational space.
///
/// FIRST PRINCIPLE: A node either has a value or doesn't. Period.
/// There is no semantic difference between "compile-time" and "runtime" values
/// from the perspective of the solver - both are simply "ready for consumption."
///
/// This design guarantees that consumers cannot make mistakes:
/// - `Pending` = not ready, cannot be consumed
/// - `Ready(v)` = has value, can be consumed
/// - No third state exists
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    /// Node does not yet have a value. Edges depending on this cannot fire.
    Pending,
    /// Node has a value and is ready for consumption by downstream edges.
    Ready(Value),
}

impl Node {
    /// Extract the value if ready. The ONLY way to access node values.
    #[inline]
    pub fn value(&self) -> Option<&Value> {
        match self {
            Node::Ready(v) => Some(v),
            Node::Pending => None,
        }
    }

    /// Check if this node is ready for consumption.
    #[inline]
    pub fn is_ready(&self) -> bool {
        matches!(self, Node::Ready(_))
    }
}

/// Hyperedge connecting nodes with constraint information
#[derive(Debug, Clone, PartialEq)]
pub struct Hyperedge {
    pub id: HyperedgeId,
    pub constraint_type: ConstraintKind,
    pub tags: Vec<ConstraintKind>,
    pub input_nodes: Vec<NodeId>,
    pub output_node: NodeId,
}

/// The Manifold: The self-contained "universe" for a single formula evaluation.
#[derive(Debug, Clone)]
pub struct Manifold {
    nodes: HashMap<NodeId, Node>,
    edges: HashMap<HyperedgeId, Hyperedge>, // Use HashMap for stable IDs
    next_node_id: u64,
    next_edge_id: u64, // Counter for stable edge IDs
    // For debugging and cycle detection
    node_sources: HashMap<NodeId, String>,
    // The designated result node that will contain the final answer
    pub result_node: Option<NodeId>,
}

impl Manifold {
    pub fn new() -> Self {
        Manifold {
            nodes: HashMap::new(),
            edges: HashMap::new(), // Use HashMap
            next_node_id: 0,
            next_edge_id: 0, // Initialize counter
            node_sources: HashMap::new(),
            result_node: None,
        }
    }

    /// The "CreateNode" primitive.
    pub fn create_node(&mut self, initial_state: Node, source_description: String) -> NodeId {
        let id = self.next_node_id;
        self.nodes.insert(id, initial_state);
        self.node_sources.insert(id, source_description);
        self.next_node_id += 1;
        id
    }

    /// Add a node to the manifold (compatibility method)
    pub fn add_node(&mut self, value: Value) -> NodeId {
        self.create_node(Node::Ready(value), "add_node".to_string())
    }

    /// Add a hyperedge from a spec with stable ID assignment
    pub fn add_edge(&mut self, spec: HyperedgeSpec) -> Result<HyperedgeId, String> {
        // Validate that all referenced nodes exist
        for &node_id in &spec.input_nodes {
            if !self.nodes.contains_key(&node_id) {
                return Err(format!("Input node {:?} does not exist", node_id));
            }
        }

        if !self.nodes.contains_key(&spec.output_node) {
            return Err(format!("Output node {:?} does not exist", spec.output_node));
        }

        let new_id = self.next_edge_id;
        self.next_edge_id += 1;

        let edge = Hyperedge {
            id: new_id,
            constraint_type: spec.constraint_type,
            tags: spec.tags,
            input_nodes: spec.input_nodes,
            output_node: spec.output_node,
        };

        self.edges.insert(new_id, edge);
        Ok(new_id)
    }

    /// Get a node by its ID
    pub fn get_node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }

    /// Get a mutable reference to a node by its ID
    pub fn get_node_mut(&mut self, id: NodeId) -> Option<&mut Node> {
        self.nodes.get_mut(&id)
    }

    /// Get the value from a node if it's ready.
    /// This is the primary way rules should access input values.
    pub fn get_node_value(&self, id: NodeId) -> Option<&Value> {
        self.get_node(id).and_then(|node| node.value())
    }

    /// Set the result node for the manifold
    pub fn set_result_node(&mut self, id: NodeId) -> Result<(), String> {
        if !self.nodes.contains_key(&id) {
            return Err(format!("Result node {:?} does not exist", id));
        }
        self.result_node = Some(id);
        Ok(())
    }

    /// Get the final result value from the result node
    pub fn get_result(&self) -> Option<&Value> {
        self.result_node
            .and_then(|id| self.get_node(id))
            .and_then(|node| node.value())
    }

    /// Get the number of edges in the manifold.
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Get the number of nodes in the manifold.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Apply widening to a node for convergence guarantee.
    /// Uses the specified float mode for type coherence.
    pub fn apply_widening_to_node(&mut self, node_id: NodeId, float_mode: &str) {
        if let Some(Node::Pending) = self.nodes.get(&node_id) {
            // Apply widening by setting a safe default value based on float mode
            let widened_value = match float_mode {
                "strict" => Value(serde_json::json!(0)),
                "fast" => Value(serde_json::json!(0.0)),
                _ => Value(serde_json::json!(0)),
            };
            self.nodes.insert(node_id, Node::Ready(widened_value));
        }
    }

    /// Find a ready edge for execution.
    /// An edge is ready when all inputs are Ready and output is Pending.
    pub fn find_ready_edge(&self) -> Option<&Hyperedge> {
        self.edges.values().find(|edge| {
            let inputs_ready = edge
                .input_nodes
                .iter()
                .all(|&id| self.get_node(id).is_some_and(|n| n.is_ready()));
            let output_pending = self
                .get_node(edge.output_node)
                .is_some_and(|n| matches!(n, Node::Pending));
            inputs_ready && output_pending
        })
    }

    /// Add a hyperedge with explicit tags (compiler dual-tagging mandate)
    pub fn add_edge_with_tags(
        &mut self,
        constraint_type: ConstraintKind,
        mut tags: Vec<ConstraintKind>,
        input_nodes: Vec<NodeId>,
        output_node: NodeId,
    ) -> Result<HyperedgeId, String> {
        // Ensure the concrete kind is always present in the tags
        if !tags.contains(&constraint_type) {
            tags.insert(0, constraint_type.clone());
        }

        let spec = HyperedgeSpec {
            constraint_type,
            tags,
            input_nodes,
            output_node,
        };

        self.add_edge(spec)
    }

    /// Remove an edge from the manifold
    pub fn remove_edge(&mut self, edge_to_remove: &Hyperedge) {
        self.remove_edge_by_id(edge_to_remove.id);
    }

    /// Remove an edge by its stable ID
    pub fn remove_edge_by_id(&mut self, edge_id: HyperedgeId) {
        self.edges.remove(&edge_id);
    }

    /// Get a snapshot of all edges for optimizer iteration
    pub fn edges_snapshot(&self) -> Vec<Hyperedge> {
        self.edges.values().cloned().collect()
    }

    /// Get edge IDs for optimization
    pub fn edge_ids(&self) -> Vec<HyperedgeId> {
        self.edges.keys().cloned().collect()
    }

    /// Get edge by ID
    pub fn edge(&self, id: HyperedgeId) -> Option<&Hyperedge> {
        self.edges.get(&id)
    }

    /// Get all node IDs in the manifold
    pub fn node_ids(&self) -> Vec<NodeId> {
        self.nodes.keys().cloned().collect()
    }

    /// Apply a patch to the manifold
    pub fn apply_patch(&mut self, patch: ManifoldPatch) -> Result<(), String> {
        // Remove edges by stable ID
        for id in patch.edges_to_remove {
            self.edges.remove(&id);
        }

        // Add new edges from specs (assign stable IDs during insertion)
        for spec in patch.edges_to_add {
            self.add_edge_with_tags(
                spec.constraint_type,
                spec.tags,
                spec.input_nodes,
                spec.output_node,
            )?;
        }

        Ok(())
    }

    /// Add edge from a spec (compatibility method)
    pub fn add_edge_spec(&mut self, spec: HyperedgeSpec) -> Result<HyperedgeId, String> {
        self.add_edge(spec)
    }

    /// Find the first edge that has this node as output
    pub fn edge_from_output(&self, output_node: NodeId) -> Option<&Hyperedge> {
        self.edges
            .values()
            .find(|edge| edge.output_node == output_node)
    }

    /// Get mutable reference to edge by ID
    pub fn edge_mut(&mut self, id: HyperedgeId) -> Option<&mut Hyperedge> {
        self.edges.get_mut(&id)
    }

    /// Computes state hash for visited-state tracking during solving.
    /// Used for loop detection to guarantee solver termination.
    pub fn compute_state_hash(&self) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();

        // Hash the current state of all nodes in sorted order for deterministic results
        let mut sorted_nodes: Vec<_> = self.nodes.iter().collect();
        sorted_nodes.sort_by_key(|(id, _)| *id);

        for (id, node) in sorted_nodes {
            id.hash(&mut hasher);
            match node {
                Node::Ready(value) => {
                    "ready".hash(&mut hasher);
                    // Hash value using stable serialization
                    if let Ok(json) = serde_json::to_string(&value.0) {
                        json.hash(&mut hasher);
                    }
                }
                Node::Pending => {
                    "pending".hash(&mut hasher);
                }
            }
        }

        // Hash remaining edges (represents computation progress)
        self.edges.len().hash(&mut hasher);
        for (edge_id, edge) in &self.edges {
            edge_id.hash(&mut hasher);
            format!("{:?}", edge.constraint_type).hash(&mut hasher);
            edge.input_nodes.hash(&mut hasher);
            edge.output_node.hash(&mut hasher);
        }

        hasher.finish()
    }

    /// Extracts dependency keys from manifold for cache invalidation.
    /// Used during UNSTABLE exits to identify related cache entries.
    pub fn extract_dependency_keys(&self) -> Vec<String> {
        let mut dependency_keys = Vec::new();

        // Extract keys from all nodes based on their source descriptions
        for node_id in self.nodes.keys() {
            if let Some(source) = self.node_sources.get(node_id) {
                // Generate dependency key based on node source (e.g., "entity.user.name")
                if source.contains('.') || source.contains(':') {
                    dependency_keys.push(source.clone());
                }
            }
        }

        // Extract constraint types as dependency keys
        for edge in self.edges.values() {
            let constraint_key = format!("constraint.{:?}", edge.constraint_type);
            dependency_keys.push(constraint_key);
        }

        // Deduplicate and sort for consistent key generation
        dependency_keys.sort();
        dependency_keys.dedup();

        dependency_keys
    }

    /// Returns node IDs that are involved in numeric constraints.
    /// Used for widening logic to force convergence.
    pub fn get_numeric_constraint_nodes(&self) -> Vec<NodeId> {
        let mut numeric_nodes = Vec::new();

        for node_id in self.nodes.keys() {
            // Check if this node is involved in numeric constraints using composite tags
            if self.edges.values().any(|edge| {
                edge.input_nodes.contains(node_id)
                    && (edge.tags.contains(&ConstraintKind::NumericComparison)
                        || edge.tags.contains(&ConstraintKind::ArithmeticOp)
                        || matches!(
                            edge.constraint_type,
                            ConstraintKind::Add
                                | ConstraintKind::Subtract
                                | ConstraintKind::Multiply
                                | ConstraintKind::Divide
                                | ConstraintKind::Modulo
                                | ConstraintKind::LessThan
                                | ConstraintKind::GreaterThan
                                | ConstraintKind::LessThanOrEqual
                                | ConstraintKind::GreaterThanOrEqual
                        ))
            }) {
                numeric_nodes.push(*node_id);
            }
        }

        numeric_nodes
    }

    /// Deep-copies a subgraph rooted at a node, returning a new manifold with mapped IDs.
    pub fn deep_copy_subgraph(&self, root_node: NodeId) -> Result<Manifold, String> {
        use std::collections::{HashMap, HashSet, VecDeque};

        let mut new_manifold = Manifold::new();
        let mut node_map: HashMap<NodeId, NodeId> = HashMap::new();
        let mut edge_map: HashMap<HyperedgeId, HyperedgeId> = HashMap::new();

        // BFS to find all reachable nodes/edges from root
        let mut queue = VecDeque::new();
        queue.push_back(root_node);
        let mut visited_nodes = HashSet::new();
        visited_nodes.insert(root_node);

        while let Some(node_id) = queue.pop_front() {
            let node = self.get_node(node_id).ok_or("Missing node")?.clone();
            let new_node_id = new_manifold.create_node(node, format!("copied_{}", node_id));
            node_map.insert(node_id, new_node_id);

            // Find edges where this node is input or output
            for (edge_id, edge) in &self.edges {
                if (edge.output_node == node_id || edge.input_nodes.contains(&node_id))
                    && !edge_map.contains_key(edge_id)
                {
                    // Add input nodes to visit queue
                    for &input_node in &edge.input_nodes {
                        if visited_nodes.insert(input_node) {
                            queue.push_back(input_node);
                        }
                    }

                    // Add output node to visit queue
                    if visited_nodes.insert(edge.output_node) {
                        queue.push_back(edge.output_node);
                    }
                }
            }
        }

        // Now copy all edges that connect visited nodes
        for (edge_id, edge) in &self.edges {
            let all_nodes_copied = edge.input_nodes.iter().all(|&n| node_map.contains_key(&n))
                && node_map.contains_key(&edge.output_node);

            if all_nodes_copied {
                let new_input_nodes = edge
                    .input_nodes
                    .iter()
                    .map(|&old| *node_map.get(&old).unwrap())
                    .collect();
                let new_output_node = *node_map.get(&edge.output_node).unwrap();

                let new_edge_id = new_manifold.add_edge_with_tags(
                    edge.constraint_type.clone(),
                    edge.tags.clone(),
                    new_input_nodes,
                    new_output_node,
                )?;
                edge_map.insert(*edge_id, new_edge_id);
            }
        }

        new_manifold.result_node = node_map.get(&root_node).copied();
        Ok(new_manifold)
    }
}

impl Default for Manifold {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_manifold_creation() {
        let mut manifold = Manifold::new();

        // Add some nodes
        let node1 = manifold.add_node(Value(json!(42)));
        let node2 = manifold.add_node(Value(json!(10)));
        let result_node = manifold.add_node(Value(json!(null)));

        // Add an edge representing addition using HyperedgeSpec
        manifold
            .add_edge(HyperedgeSpec {
                constraint_type: ConstraintKind::Add,
                input_nodes: vec![node1, node2],
                output_node: result_node,
                tags: vec![],
            })
            .unwrap();

        // Set result node
        manifold.set_result_node(result_node).unwrap();

        assert_eq!(manifold.nodes.len(), 3);
        assert_eq!(manifold.edge_count(), 1);
        assert_eq!(manifold.result_node, Some(result_node));
    }

    #[test]
    fn test_node_retrieval() {
        let mut manifold = Manifold::new();
        let node_id = manifold.add_node(Value(json!("test")));

        let node = manifold.get_node(node_id).unwrap();
        assert!(matches!(node, Node::Ready(_)));
    }

    #[test]
    fn test_invalid_edge() {
        let mut manifold = Manifold::new();
        let valid_node = manifold.add_node(Value(json!(1)));
        let invalid_node = 999;

        let result = manifold.add_edge(HyperedgeSpec {
            constraint_type: ConstraintKind::Add,
            input_nodes: vec![valid_node],
            output_node: invalid_node,
            tags: vec![],
        });

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }
}
