//! DirectedGraph: A Physics-level directed graph with CRUD operations.
//!
//! File: crates/graph/src/lib.rs
//! Purpose: Core directed graph data structure with cycle detection and change propagation
//! Non-Negotiable Invariants:
//! - All keys must be unique and tracked bidirectionally
//! - Cycle detection is mandatory on add_edge — no cycles allowed
//! - remove_node returns ALL severed edges via Removed<K, E>
//! - Internal NodeIndex is O(1) lookup; external API uses K
//! - Bitset visited tracking for O(N/8) space efficiency in traversals
//! - Edge metadata E is zero-cost when E = ()
//!
//! Key Concepts:
//! - NodeIndex: Dense integer indices for internal tracking
//! - K: User-visible key (Hash + Eq + Ord + Clone)
//! - E: Edge metadata (Clone, default is ())
//! - forward/reverse maps: bidirectional adjacency via im::OrdSet (deterministic)
//! - DFS cycle detection: O(V + E) on add_edge
//!
//! Security Considerations:
//! - No cycles allowed — architecture enforces acyclic invariant
//! - Deterministic ordering via Ord ensures reproducible traversals
//! - No interior mutability — all mutations require &mut self

use bitvec::prelude::*;
use im::{HashMap, OrdSet};
use serde::{Deserialize, Serialize};
use std::collections::HashMap as StdHashMap;
use std::hash::Hash;

pub mod algorithms;
pub mod iter;
#[cfg(feature = "merkle")]
pub mod merkle;
pub mod removed;

pub use removed::Removed;

/// Dense integer index for internal node tracking.
/// External API uses K; internal maps K ↔ NodeIndex.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct NodeIndex(usize);

// =============================================================================
// Serde helpers for non-string HashMap keys (NodeIndex, tuple keys)
// =============================================================================
// JSON requires string object keys. These helpers serialize NodeIndex-keyed
// and tuple-keyed maps as Vec<(key, value)> for round-trip fidelity.

fn ser_ni_map<V: Serialize, S: serde::Serializer>(
    map: &HashMap<NodeIndex, V>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let pairs: Vec<(&NodeIndex, &V)> = map.iter().collect();
    pairs.serialize(serializer)
}

fn de_ni_map<'de, V: serde::de::DeserializeOwned + Clone, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<NodeIndex, V>, D::Error> {
    let pairs: Vec<(NodeIndex, V)> = Vec::deserialize(deserializer)?;
    Ok(pairs.into_iter().collect())
}

fn ser_tuple_map<V: Serialize, S: serde::Serializer>(
    map: &HashMap<(NodeIndex, NodeIndex), V>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let pairs: Vec<(&(NodeIndex, NodeIndex), &V)> = map.iter().collect();
    pairs.serialize(serializer)
}

fn de_tuple_map<'de, V: serde::de::DeserializeOwned + Clone, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<(NodeIndex, NodeIndex), V>, D::Error> {
    let pairs: Vec<((NodeIndex, NodeIndex), V)> = Vec::deserialize(deserializer)?;
    Ok(pairs.into_iter().collect())
}

/// Cycle error returned when adding an edge would create a cycle.
#[derive(Debug, Clone)]
pub struct CycleError<K> {
    /// The cycle path detected (first key to last key that would close the cycle)
    pub path: Vec<K>,
}

/// Aggregate over all bounded paths from a start node.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedPathSummary {
    /// Number of paths whose length is inside the requested depth range.
    pub path_count: usize,
    /// Longest path length observed inside the requested depth range.
    pub max_depth_reached: Option<usize>,
}

/// Directed acyclic graph with node and edge metadata.
///
/// # Type Parameters
/// - `K`: Node key type (must be Hash + Eq + Ord + Clone)
/// - `E`: Edge metadata type (default is empty tuple for zero-cost)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(bound(
    serialize = "K: Serialize + Hash + Eq + Ord + Clone, E: Serialize + Clone",
    deserialize = "K: serde::de::DeserializeOwned + Hash + Eq + Ord + Clone, E: serde::de::DeserializeOwned + Clone"
))]
pub struct DirectedGraph<K, E = ()>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    // O(1) lookup from node index to user key
    #[serde(serialize_with = "ser_ni_map", deserialize_with = "de_ni_map")]
    nodes: HashMap<NodeIndex, K>,
    // O(1) lookup from user key to node index
    key_to_index: HashMap<K, NodeIndex>,
    // Forward edges: src → {dst}
    #[serde(serialize_with = "ser_ni_map", deserialize_with = "de_ni_map")]
    forward: HashMap<NodeIndex, OrdSet<NodeIndex>>,
    // Reverse edges: dst → {src}
    #[serde(serialize_with = "ser_ni_map", deserialize_with = "de_ni_map")]
    reverse: HashMap<NodeIndex, OrdSet<NodeIndex>>,
    // Edge metadata stored separately
    #[serde(serialize_with = "ser_tuple_map", deserialize_with = "de_tuple_map")]
    edges: HashMap<(NodeIndex, NodeIndex), E>,
    // Counter for next node index
    next_index: usize,
}

impl<K, E> Default for DirectedGraph<K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    fn default() -> Self {
        Self::new()
    }
}

impl<K, E> DirectedGraph<K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    /// Create a new empty directed graph.
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            key_to_index: HashMap::new(),
            forward: HashMap::new(),
            reverse: HashMap::new(),
            edges: HashMap::new(),
            next_index: 0,
        }
    }

    /// Add a node to the graph.
    /// Returns true if the node was added, false if it already exists.
    pub fn add_node(&mut self, key: K) -> bool {
        if self.key_to_index.contains_key(&key) {
            return false;
        }
        let idx = NodeIndex(self.next_index);
        self.next_index += 1;
        self.nodes.insert(idx, key.clone());
        self.key_to_index.insert(key, idx);
        true
    }

    /// Remove a node and all its incident edges.
    /// Returns Removed with all severed edges (incoming + outgoing).
    pub fn remove_node(&mut self, key: &K) -> Option<Removed<K, E>> {
        let idx = self.key_to_index.remove(key)?;
        let key = self.nodes.remove(&idx)?;

        let mut removed = Removed {
            key: key.clone(),
            incoming: Vec::new(),
            outgoing: Vec::new(),
        };

        // Collect incoming edges
        if let Some(predecessors) = self.reverse.remove(&idx) {
            for pred_idx in predecessors {
                // Remove the forward edge from predecessor
                if let Some(succs) = self.forward.get_mut(&pred_idx) {
                    succs.remove(&idx);
                }
                // Extract metadata and record
                if let Some(metadata) = self.edges.remove(&(pred_idx, idx)) {
                    let pred_key = self.nodes.get(&pred_idx).cloned().unwrap();
                    removed.incoming.push((pred_key, metadata));
                }
            }
        }

        // Collect outgoing edges
        if let Some(successors) = self.forward.remove(&idx) {
            for succ_idx in successors {
                // Remove the reverse edge from successor
                if let Some(preds) = self.reverse.get_mut(&succ_idx) {
                    preds.remove(&idx);
                }
                // Extract metadata and record
                if let Some(metadata) = self.edges.remove(&(idx, succ_idx)) {
                    let succ_key = self.nodes.get(&succ_idx).cloned().unwrap();
                    removed.outgoing.push((succ_key, metadata));
                }
            }
        }

        Some(removed)
    }

    /// Add an edge with default metadata (E = ()).
    pub fn add_edge(&mut self, src: &K, dst: &K) -> Result<(), CycleError<K>>
    where
        E: Default,
    {
        self.add_edge_with(src, dst, E::default())
    }

    /// Add an edge with metadata.
    /// Detects cycles via DFS from dst; if src is reachable from dst, reject with CycleError.
    pub fn add_edge_with(&mut self, src: &K, dst: &K, metadata: E) -> Result<(), CycleError<K>> {
        // Self-loops are rejected
        if src == dst {
            return Err(CycleError {
                path: vec![src.clone()],
            });
        }

        let src_idx = match self.key_to_index.get(src) {
            Some(idx) => *idx,
            None => {
                return Err(CycleError {
                    path: vec![src.clone()],
                })
            }
        };

        let dst_idx = match self.key_to_index.get(dst) {
            Some(idx) => *idx,
            None => {
                return Err(CycleError {
                    path: vec![dst.clone()],
                })
            }
        };

        // DFS from dst to check if src is reachable
        // If src is reachable from dst, adding src→dst creates a cycle
        if self.dfs_path_exists(dst_idx, src_idx) {
            // Reconstruct the cycle path
            let path = self.dfs_path_trace(dst_idx, src_idx);
            return Err(CycleError { path });
        }

        // Add the edge
        self.forward.entry(src_idx).or_default().insert(dst_idx);

        self.reverse.entry(dst_idx).or_default().insert(src_idx);

        self.edges.insert((src_idx, dst_idx), metadata);

        Ok(())
    }

    /// Remove an edge and return its metadata if it existed.
    pub fn remove_edge(&mut self, src: &K, dst: &K) -> Option<E> {
        let src_idx = *self.key_to_index.get(src)?;
        let dst_idx = *self.key_to_index.get(dst)?;

        // Remove from forward/reverse
        if let Some(succs) = self.forward.get_mut(&src_idx) {
            succs.remove(&dst_idx);
        }
        if let Some(preds) = self.reverse.get_mut(&dst_idx) {
            preds.remove(&src_idx);
        }

        // Remove and return metadata
        self.edges.remove(&(src_idx, dst_idx))
    }

    /// Check if a node exists.
    pub fn has_node(&self, key: &K) -> bool {
        self.key_to_index.contains_key(key)
    }

    /// Check if an edge exists.
    pub fn has_edge(&self, src: &K, dst: &K) -> bool {
        if let (Some(&src_idx), Some(&dst_idx)) =
            (self.key_to_index.get(src), self.key_to_index.get(dst))
        {
            self.edges.contains_key(&(src_idx, dst_idx))
        } else {
            false
        }
    }

    /// Return the number of nodes.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Return the number of edges.
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Return all nodes in the graph as a Vec.
    pub fn all_nodes(&self) -> Vec<K> {
        self.nodes.values().cloned().collect()
    }

    /// Count nodes that have outgoing edges (source nodes).
    pub fn sources_count(&self) -> usize {
        self.forward
            .iter()
            .filter(|(_, succs)| !succs.is_empty())
            .count()
    }

    /// Count nodes that have incoming edges (sink nodes).
    pub fn sinks_count(&self) -> usize {
        self.reverse
            .iter()
            .filter(|(_, preds)| !preds.is_empty())
            .count()
    }

    /// Return an iterator over direct successors of a node.
    pub fn children(&self, key: &K) -> impl Iterator<Item = &K> {
        let idx = self.key_to_index.get(key).copied();
        let node_ref = &self.nodes;
        idx.into_iter()
            .flat_map(move |idx| {
                self.forward.get(&idx).into_iter().flat_map(move |succs| {
                    succs
                        .iter()
                        .filter_map(move |succ_idx| node_ref.get(succ_idx))
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
    }

    /// Return an iterator over direct predecessors of a node.
    pub fn parents(&self, key: &K) -> impl Iterator<Item = &K> {
        let idx = self.key_to_index.get(key).copied();
        let node_ref = &self.nodes;
        idx.into_iter()
            .flat_map(move |idx| {
                self.reverse.get(&idx).into_iter().flat_map(move |preds| {
                    preds
                        .iter()
                        .filter_map(move |pred_idx| node_ref.get(pred_idx))
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
    }

    // Internal helper: DFS to check if `dst` is reachable from `src`
    // Uses bitset visited tracking for O(N/8) space efficiency
    fn dfs_path_exists(&self, from: NodeIndex, target: NodeIndex) -> bool {
        if from == target {
            return true;
        }

        let max_index = self.next_index;
        let mut visited = bitvec![0; max_index];

        let mut stack = vec![from];

        while let Some(current) = stack.pop() {
            let idx = current.0;
            if idx < visited.len() && visited[idx] {
                continue;
            }
            if idx < visited.len() {
                visited.set(idx, true);
            }

            if current == target {
                return true;
            }

            if let Some(succs) = self.forward.get(&current) {
                for &succ in succs.iter() {
                    let succ_idx = succ.0;
                    if succ_idx >= visited.len() || !visited[succ_idx] {
                        stack.push(succ);
                    }
                }
            }
        }

        false
    }

    // Internal helper: Reconstruct path for cycle error
    // Uses bitset visited tracking for O(N/8) space efficiency
    fn dfs_path_trace(&self, from: NodeIndex, target: NodeIndex) -> Vec<K> {
        let mut result = vec![];
        let mut stack = vec![(from, vec![from])];
        let max_index = self.next_index;
        let mut visited = bitvec![0; max_index];

        while let Some((current, path)) = stack.pop() {
            let idx = current.0;
            if idx < visited.len() && visited[idx] {
                continue;
            }
            if idx < visited.len() {
                visited.set(idx, true);
            }

            if current == target {
                // Convert path to keys
                for node_idx in path {
                    if let Some(k) = self.nodes.get(&node_idx) {
                        result.push(k.clone());
                    }
                }
                return result;
            }

            if let Some(succs) = self.forward.get(&current) {
                for &succ in succs.iter() {
                    let succ_idx = succ.0;
                    if succ_idx >= visited.len() || !visited[succ_idx] {
                        let mut new_path = path.clone();
                        new_path.push(succ);
                        stack.push((succ, new_path));
                    }
                }
            }
        }

        result
    }

    /// Transitive ancestors (reverse BFS) — lazy iterator of all keys reachable by following reverse edges.
    ///
    /// This is a public method that returns `impl Iterator<Item = K>`.
    /// It calls `BfsWalker` internally and yields K values (not references).
    pub fn ancestors(&self, key: &K) -> impl Iterator<Item = K> + '_ {
        let start_idx = self.key_to_index.get(key).copied();

        start_idx
            .into_iter()
            .flat_map(move |idx| iter::BfsWalker::new(self, idx, iter::Direction::Reverse))
    }

    /// Transitive descendants (forward BFS) — lazy iterator of all keys reachable by following forward edges.
    ///
    /// This is a public method that returns `impl Iterator<Item = K>`.
    /// It calls `BfsWalker` internally and yields K values (not references).
    pub fn descendants(&self, key: &K) -> impl Iterator<Item = K> + '_ {
        let start_idx = self.key_to_index.get(key).copied();

        start_idx
            .into_iter()
            .flat_map(move |idx| iter::BfsWalker::new(self, idx, iter::Direction::Forward))
    }

    /// Count bounded paths without materializing every path.
    ///
    /// The summary counts path endpoints per path, not unique nodes. In a
    /// diamond graph `a -> b -> d` and `a -> c -> d`, node `d` contributes two
    /// paths at depth 2. This matches graph-query path aggregate semantics.
    pub fn bounded_path_summary(
        &self,
        key: &K,
        direction: iter::Direction,
        min_depth: usize,
        max_depth: usize,
    ) -> BoundedPathSummary {
        let Some(start) = self.key_to_index.get(key).copied() else {
            return BoundedPathSummary::default();
        };
        if max_depth < min_depth {
            return BoundedPathSummary::default();
        }

        let mut summary = BoundedPathSummary::default();
        if min_depth == 0 {
            summary.path_count = 1;
            summary.max_depth_reached = Some(0);
        }

        let max_possible_depth = self.nodes.len().saturating_sub(1);
        let effective_max_depth = max_depth.min(max_possible_depth);
        if effective_max_depth == 0 {
            return summary;
        }

        let mut frontier = StdHashMap::new();
        frontier.insert(start, 1usize);

        for depth in 1..=effective_max_depth {
            let mut next = StdHashMap::new();
            for (node, path_count) in frontier {
                let neighbors = match direction {
                    iter::Direction::Forward => self.forward.get(&node),
                    iter::Direction::Reverse => self.reverse.get(&node),
                };
                if let Some(neighbors) = neighbors {
                    for &neighbor in neighbors.iter() {
                        let count = next.entry(neighbor).or_insert(0usize);
                        *count = count.saturating_add(path_count);
                    }
                }
            }

            if next.is_empty() {
                break;
            }
            if depth >= min_depth {
                let paths_at_depth = next
                    .values()
                    .fold(0usize, |total, count| total.saturating_add(*count));
                summary.path_count = summary.path_count.saturating_add(paths_at_depth);
                summary.max_depth_reached = Some(depth);
            }
            frontier = next;
        }

        summary
    }

    /// Return the in-degree of a node (number of incoming edges).
    /// Returns 0 if the node doesn't exist or has no predecessors.
    pub fn in_degree(&self, key: &K) -> usize {
        self.key_to_index
            .get(key)
            .and_then(|&idx| self.reverse.get(&idx))
            .map(|preds| preds.len())
            .unwrap_or(0)
    }

    /// Return outgoing edges from a node as (target_key, &edge_metadata) pairs.
    pub fn outgoing_edges(&self, key: &K) -> Vec<(K, &E)> {
        let Some(&src_idx) = self.key_to_index.get(key) else {
            return Vec::new();
        };
        let Some(succs) = self.forward.get(&src_idx) else {
            return Vec::new();
        };

        succs
            .iter()
            .filter_map(|&dst_idx| {
                let dst_key = self.nodes.get(&dst_idx)?;
                let meta = self.edges.get(&(src_idx, dst_idx))?;
                Some((dst_key.clone(), meta))
            })
            .collect()
    }

    /// Return inbound edges to a node as (source_key, &edge_metadata) pairs.
    pub fn inbound_edges(&self, key: &K) -> Vec<(K, &E)> {
        let Some(&dst_idx) = self.key_to_index.get(key) else {
            return Vec::new();
        };
        let Some(preds) = self.reverse.get(&dst_idx) else {
            return Vec::new();
        };

        preds
            .iter()
            .filter_map(|&src_idx| {
                let src_key = self.nodes.get(&src_idx)?;
                let meta = self.edges.get(&(src_idx, dst_idx))?;
                Some((src_key.clone(), meta))
            })
            .collect()
    }

    /// Return all node keys in the graph (alias for all_nodes for API clarity).
    pub fn nodes(&self) -> Vec<K> {
        self.all_nodes()
    }

    // =========================================================================
    // NodeIndex-based API — O(1) hot-loop operations for concurrent walkers
    //
    // The key-based API above resolves K→NodeIndex on every call (HashMap lookup).
    // For hot loops that iterate thousands of times (workflow DAG walkers, layout
    // traversals), this adds unnecessary hashing overhead. These methods let the
    // caller hold NodeIndex directly and avoid string operations entirely.
    //
    // Pattern: get_index() once at setup, use index-based methods in the loop,
    // resolve back to K via get_key() only when producing output.
    // =========================================================================

    /// Resolve a key to its internal NodeIndex. O(1) via HashMap lookup.
    /// Returns None if the key doesn't exist in the graph.
    pub fn get_index(&self, key: &K) -> Option<NodeIndex> {
        self.key_to_index.get(key).copied()
    }

    /// Resolve a NodeIndex back to its key. O(1) via HashMap lookup.
    /// Returns None if the index is stale (node was removed).
    pub fn get_key(&self, idx: NodeIndex) -> Option<&K> {
        self.nodes.get(&idx)
    }

    /// Return all NodeIndex values in the graph.
    pub fn all_node_indices(&self) -> Vec<NodeIndex> {
        self.nodes.keys().copied().collect()
    }

    /// In-degree by NodeIndex. O(1) — no key hashing.
    pub fn in_degree_by_index(&self, idx: NodeIndex) -> usize {
        self.reverse.get(&idx).map(|preds| preds.len()).unwrap_or(0)
    }

    /// Outgoing edges by NodeIndex. Returns (target_NodeIndex, &edge_metadata).
    /// O(out-degree) — no key hashing in the hot loop.
    pub fn outgoing_edges_by_index(&self, idx: NodeIndex) -> Vec<(NodeIndex, &E)> {
        let Some(succs) = self.forward.get(&idx) else {
            return Vec::new();
        };
        succs
            .iter()
            .filter_map(|&dst_idx| {
                let meta = self.edges.get(&(idx, dst_idx))?;
                Some((dst_idx, meta))
            })
            .collect()
    }

    /// Forward BFS descendants by NodeIndex — yields NodeIndex values.
    /// Used for subgraph skipping: mark an entire downstream subgraph without
    /// resolving keys until recording output.
    pub fn descendants_by_index(&self, start: NodeIndex) -> Vec<NodeIndex> {
        use std::collections::VecDeque;
        let mut result = Vec::new();
        let mut queue = VecDeque::new();
        let mut visited = bitvec![0; self.next_index];

        if start.0 < visited.len() {
            visited.set(start.0, true);
        }

        // Seed with direct successors
        if let Some(succs) = self.forward.get(&start) {
            for &s in succs.iter() {
                if s.0 < visited.len() && !visited[s.0] {
                    visited.set(s.0, true);
                    queue.push_back(s);
                }
            }
        }

        while let Some(current) = queue.pop_front() {
            result.push(current);
            if let Some(succs) = self.forward.get(&current) {
                for &s in succs.iter() {
                    if s.0 < visited.len() && !visited[s.0] {
                        visited.set(s.0, true);
                        queue.push_back(s);
                    }
                }
            }
        }

        result
    }
}
