//! Merkle hash propagation through DAGs for closure hashing and compilation.
//!
//! File: crates/graph/src/merkle.rs
//! Purpose: Bottom-up Merkle hashing enabling deterministic closure verification
//! Non-Negotiable Invariants:
//! - All hashes computed deterministically via topo_sort() ordering
//! - Leaf nodes (no outgoing edges) hash as blake3(node_key)
//! - Internal nodes hash as blake3(concat(node_key, sorted_child_hashes))
//! - Child hashes sorted by hash value (lexicographic) for deterministic combination
//! - Memoization via Arc<RwLock<HashMap<K, content_crypto::advanced::blake3::Hash>>> for repeated calls
//! - Full traversal via rebuild_hashes uses dependency order for correctness
//! - Zero cycles in input graph (enforced by DirectedGraph invariant)
//!
//! Key Concepts:
//! - Merkle hash: cryptographic fingerprint of node + all descendants
//! - Topo sort: ensures children computed before parents (bottom-up)
//! - Determinism: same graph → same hashes every time, regardless of insertion order
//! - MerkleIndex: pre-computed hashes for all nodes, ready for closure queries
//!
//! Security Considerations:
//! - Blake3-256 collision resistance makes hash uniqueness trustworthy
//! - Sorted hash combination prevents hash ordering attacks
//! - No mutable state leaks after rebuild_hashes completes

#![cfg(feature = "merkle")]

use std::collections::HashMap as StdHashMap;
use std::hash::Hash;
use std::sync::{Arc, RwLock};

use crate::{algorithms, DirectedGraph};

/// Compute the Merkle hash for a single node, incorporating all descendants.
///
/// # Algorithm
/// - Leaf nodes (no outgoing edges): hash = blake3(node_key)
/// - Internal nodes: hash = blake3(concat(node_key, sorted_child_hashes))
/// - Child hashes sorted lexicographically by hash value for determinism
/// - Memoization prevents redundant computation on repeated calls
///
/// # Type Parameters
/// - `K`: Node key type (must be Clone + Ord + AsRef<[u8]>)
/// - `E`: Edge metadata (unused in hash computation)
///
/// # Arguments
/// - `graph`: The directed acyclic graph
/// - `node`: The node key to hash (must exist in graph)
/// - `memo`: Mutable memoization cache (Arc<RwLock<HashMap>>)
///
/// # Returns
/// - `content_crypto::advanced::blake3::Hash` — the 32-byte cryptographic hash
///
/// # Panics
/// - If node does not exist in graph
/// - If RwLock is poisoned (internal error, should never happen in normal operation)
fn compute_merkle_hash_memoized<K, E>(
    graph: &DirectedGraph<K, E>,
    node: &K,
    memo: &Arc<RwLock<StdHashMap<K, content_crypto::advanced::blake3::Hash>>>,
) -> content_crypto::advanced::blake3::Hash
where
    K: Clone + Eq + Ord + Hash + AsRef<[u8]>,
    E: Clone,
{
    // Check memoization cache first
    {
        let cache = memo.read().expect("memo lock poisoned");
        if let Some(&hash) = cache.get(node) {
            return hash;
        }
    }

    // Collect direct children (outgoing edges)
    let children: Vec<K> = graph.children(node).cloned().collect();

    let hash = if children.is_empty() {
        // Leaf node: hash = blake3(node_key)
        content_crypto::advanced::blake3::hash(node.as_ref())
    } else {
        // Internal node: hash = blake3(concat(node_key, sorted_child_hashes))
        // Recursively compute child hashes with memoization
        let mut child_hashes: Vec<(K, content_crypto::advanced::blake3::Hash)> = children
            .into_iter()
            .map(|child| {
                let child_hash = compute_merkle_hash_memoized(graph, &child, memo);
                (child, child_hash)
            })
            .collect();

        // Sort by hash value (lexicographic) for determinism
        child_hashes.sort_by(|a, b| a.1.as_bytes().cmp(b.1.as_bytes()));

        // Concat: node_key + all child hashes in sorted order
        let mut combined = node.as_ref().to_vec();
        for (_, child_hash) in child_hashes {
            combined.extend_from_slice(child_hash.as_bytes());
        }

        content_crypto::advanced::blake3::hash(&combined)
    };

    // Store in memo before returning
    {
        let mut cache = memo.write().expect("memo lock poisoned");
        cache.insert(node.clone(), hash);
    }

    hash
}

/// Compute the Merkle hash for a single node, incorporating all descendants.
///
/// See `compute_merkle_hash_memoized` for full algorithm details.
/// This is the public API that wraps memoization internally.
pub fn compute_merkle_hash<K, E>(
    graph: &DirectedGraph<K, E>,
    node: &K,
) -> content_crypto::advanced::blake3::Hash
where
    K: Clone + Eq + Ord + Hash + AsRef<[u8]>,
    E: Clone,
{
    let memo = Arc::new(RwLock::new(StdHashMap::new()));
    compute_merkle_hash_memoized(graph, node, &memo)
}

/// Pre-computed Merkle hashes for all nodes in a graph.
///
/// Stores hashes in deterministic order, computed via topological sort
/// to guarantee correctness regardless of graph construction order.
#[derive(Debug, Clone)]
pub struct MerkleIndex<K: Clone + Ord + Hash> {
    /// Immutable persistent map from node key to Merkle hash.
    /// Uses `im::HashMap` for structural sharing and immutability guarantees.
    hashes: im::HashMap<K, content_crypto::advanced::blake3::Hash>,
}

impl<K: Clone + Ord + Hash> MerkleIndex<K> {
    /// Get the Merkle hash of a node if it exists in the index.
    pub fn get(&self, node: &K) -> Option<content_crypto::advanced::blake3::Hash> {
        self.hashes.get(node).copied()
    }

    /// Return the number of nodes in the index.
    pub fn len(&self) -> usize {
        self.hashes.len()
    }

    /// Check if the index is empty.
    pub fn is_empty(&self) -> bool {
        self.hashes.is_empty()
    }

    /// Iterate over all (node, hash) pairs in the index.
    pub fn iter(&self) -> impl Iterator<Item = (&K, &content_crypto::advanced::blake3::Hash)> {
        self.hashes.iter()
    }
}

/// Rebuild Merkle hashes for all nodes in the graph using topological order.
///
/// # Algorithm
/// 1. Compute topological sort of the graph (deterministic via Kahn's algorithm)
/// 2. Process nodes in topo order — guarantees children computed before parents
/// 3. Compute hash for each node incorporating memoized child hashes
/// 4. Return immutable `MerkleIndex` with all hashes pre-computed
///
/// # Type Parameters
/// - `K`: Node key type (must be Clone + Eq + Ord + Hash + AsRef<[u8]>)
/// - `E`: Edge metadata (unused in hash computation)
///
/// # Arguments
/// - `graph`: The directed acyclic graph
///
/// # Returns
/// - `MerkleIndex<K>` — immutable map from node key to hash
///
/// # Determinism
/// - Same graph always produces same MerkleIndex (and thus same hashes)
/// - Topo sort is deterministic via Ord tie-breaking
/// - Hash combination is deterministic via sorted child hashes
pub fn rebuild_hashes<K, E>(graph: &DirectedGraph<K, E>) -> MerkleIndex<K>
where
    K: Clone + Eq + Ord + Hash + AsRef<[u8]>,
    E: Clone,
{
    // Pre-allocate memo for all nodes
    let memo = Arc::new(RwLock::new(StdHashMap::new()));

    // Process nodes in topological order
    // This ensures children are computed before parents
    for node in algorithms::topo_sort(graph) {
        compute_merkle_hash_memoized(graph, &node, &memo);
    }

    // Extract all hashes from memo into immutable HashMap
    let mut hashes = im::HashMap::new();
    {
        let cache = memo.read().expect("memo lock poisoned");
        for (key, hash) in cache.iter() {
            hashes.insert(key.clone(), *hash);
        }
    }

    MerkleIndex { hashes }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merkle_hash_single_node() {
        let mut graph: DirectedGraph<String, ()> = DirectedGraph::new();
        graph.add_node("A".to_string());

        let hash = compute_merkle_hash(&graph, &"A".to_string());

        // Leaf node: hash should be blake3("A")
        let expected = content_crypto::advanced::blake3::hash(b"A");
        assert_eq!(hash, expected);
    }

    #[test]
    fn test_merkle_hash_determinism() {
        let mut graph: DirectedGraph<String, ()> = DirectedGraph::new();
        graph.add_node("A".to_string());
        graph.add_node("B".to_string());
        graph.add_edge(&"A".to_string(), &"B".to_string()).unwrap();

        let hash1 = compute_merkle_hash(&graph, &"A".to_string());
        let hash2 = compute_merkle_hash(&graph, &"A".to_string());

        assert_eq!(
            hash1, hash2,
            "same node should produce same hash every time"
        );
    }

    #[test]
    fn test_merkle_hash_parent_incorporates_child() {
        let mut graph: DirectedGraph<String, ()> = DirectedGraph::new();
        graph.add_node("A".to_string());
        graph.add_node("B".to_string());
        graph.add_edge(&"A".to_string(), &"B".to_string()).unwrap();

        let hash_a = compute_merkle_hash(&graph, &"A".to_string());
        let hash_b = compute_merkle_hash(&graph, &"B".to_string());

        // A's hash incorporates B's hash, so they must be different
        assert_ne!(hash_a, hash_b, "parent hash must differ from child hash");

        // Verify A's hash includes B's hash in computation
        let mut combined = b"A".to_vec();
        combined.extend_from_slice(hash_b.as_bytes());
        let expected_a = content_crypto::advanced::blake3::hash(&combined);
        assert_eq!(hash_a, expected_a);
    }

    #[test]
    fn test_merkle_hash_sorted_children() {
        // Build two graphs with children added in different orders
        let mut graph1: DirectedGraph<String, ()> = DirectedGraph::new();
        graph1.add_node("A".to_string());
        graph1.add_node("B".to_string());
        graph1.add_node("C".to_string());
        graph1.add_edge(&"A".to_string(), &"B".to_string()).unwrap();
        graph1.add_edge(&"A".to_string(), &"C".to_string()).unwrap();

        let mut graph2: DirectedGraph<String, ()> = DirectedGraph::new();
        graph2.add_node("A".to_string());
        graph2.add_node("C".to_string());
        graph2.add_node("B".to_string());
        graph2.add_edge(&"A".to_string(), &"C".to_string()).unwrap();
        graph2.add_edge(&"A".to_string(), &"B".to_string()).unwrap();

        let hash_a1 = compute_merkle_hash(&graph1, &"A".to_string());
        let hash_a2 = compute_merkle_hash(&graph2, &"A".to_string());

        assert_eq!(
            hash_a1, hash_a2,
            "child order should not affect parent hash (sorted deterministically)"
        );
    }

    #[test]
    fn test_merkle_index_rebuild_hashes() {
        let mut graph: DirectedGraph<String, ()> = DirectedGraph::new();
        graph.add_node("A".to_string());
        graph.add_node("B".to_string());
        graph.add_node("C".to_string());
        graph.add_edge(&"A".to_string(), &"B".to_string()).unwrap();
        graph.add_edge(&"B".to_string(), &"C".to_string()).unwrap();

        let index = rebuild_hashes(&graph);

        // All nodes should have hashes
        assert_eq!(index.len(), 3);
        assert!(index.get(&"A".to_string()).is_some());
        assert!(index.get(&"B".to_string()).is_some());
        assert!(index.get(&"C".to_string()).is_some());
    }

    #[test]
    fn test_merkle_index_consistency_with_compute() {
        let mut graph: DirectedGraph<String, ()> = DirectedGraph::new();
        graph.add_node("A".to_string());
        graph.add_node("B".to_string());
        graph.add_edge(&"A".to_string(), &"B".to_string()).unwrap();

        let index = rebuild_hashes(&graph);
        let hash_from_compute = compute_merkle_hash(&graph, &"A".to_string());
        let hash_from_index = index.get(&"A".to_string()).unwrap();

        assert_eq!(
            hash_from_compute, hash_from_index,
            "rebuild_hashes should produce same result as compute_merkle_hash"
        );
    }

    #[test]
    fn test_merkle_hash_linear_chain() {
        let mut graph: DirectedGraph<String, ()> = DirectedGraph::new();
        for node in &["A", "B", "C", "D"] {
            graph.add_node(node.to_string());
        }
        graph.add_edge(&"A".to_string(), &"B".to_string()).unwrap();
        graph.add_edge(&"B".to_string(), &"C".to_string()).unwrap();
        graph.add_edge(&"C".to_string(), &"D".to_string()).unwrap();

        let hash_a = compute_merkle_hash(&graph, &"A".to_string());
        let hash_b = compute_merkle_hash(&graph, &"B".to_string());
        let hash_c = compute_merkle_hash(&graph, &"C".to_string());
        let hash_d = compute_merkle_hash(&graph, &"D".to_string());

        // All hashes should be different (each node has different descendants)
        assert_ne!(hash_a, hash_b);
        assert_ne!(hash_b, hash_c);
        assert_ne!(hash_c, hash_d);

        // D is a leaf, C includes D, B includes C, A includes B
        let expected_d = content_crypto::advanced::blake3::hash(b"D");
        assert_eq!(hash_d, expected_d);
    }

    #[test]
    fn test_merkle_hash_multiple_parents() {
        let mut graph: DirectedGraph<String, ()> = DirectedGraph::new();
        graph.add_node("A".to_string());
        graph.add_node("B".to_string());
        graph.add_node("C".to_string());
        graph.add_edge(&"A".to_string(), &"C".to_string()).unwrap();
        graph.add_edge(&"B".to_string(), &"C".to_string()).unwrap();

        let hash_a = compute_merkle_hash(&graph, &"A".to_string());
        let hash_b = compute_merkle_hash(&graph, &"B".to_string());
        let hash_c = compute_merkle_hash(&graph, &"C".to_string());

        // A and B have different keys, so different hashes even with same children
        assert_ne!(
            hash_a, hash_b,
            "different parent keys produce different hashes"
        );
        // Both parents include C's hash, so both differ from C's hash
        assert_ne!(hash_a, hash_c);
        assert_ne!(hash_b, hash_c);
    }

    #[test]
    fn test_merkle_hash_modification_changes_hash() {
        let mut graph1: DirectedGraph<String, ()> = DirectedGraph::new();
        graph1.add_node("A".to_string());
        graph1.add_node("B".to_string());
        graph1.add_edge(&"A".to_string(), &"B".to_string()).unwrap();

        let hash1 = compute_merkle_hash(&graph1, &"A".to_string());

        let mut graph2: DirectedGraph<String, ()> = DirectedGraph::new();
        graph2.add_node("A".to_string());
        graph2.add_node("B".to_string());
        graph2.add_node("C".to_string());
        graph2.add_edge(&"A".to_string(), &"B".to_string()).unwrap();
        graph2.add_edge(&"A".to_string(), &"C".to_string()).unwrap();

        let hash2 = compute_merkle_hash(&graph2, &"A".to_string());

        assert_ne!(hash1, hash2, "adding a child should change parent hash");
    }

    #[test]
    fn test_merkle_index_empty_graph() {
        let graph: DirectedGraph<String, ()> = DirectedGraph::new();
        let index = rebuild_hashes(&graph);
        assert_eq!(index.len(), 0);
        assert!(index.is_empty());
    }
}
