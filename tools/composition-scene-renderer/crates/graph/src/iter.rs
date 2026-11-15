//! Traversal iterators for directed graphs.
//!
//! File: crates/graph/src/iter.rs
//! Purpose: Lazy BFS/DFS traversal walkers with BitVec visited tracking
//! Non-Negotiable Invariants:
//! - ALL traversals return `impl Iterator<Item=K>` — NEVER Vec or HashSet
//! - Visited tracking uses BitVec — O(N/8) bytes for 10M nodes instead of OOM
//! - BfsWalker/DfsWalker yield K (owned values, NOT references)
//! - Direction enum selects Forward (children) or Reverse (parents)
//! - Zero-copy for small graphs (<1K nodes); BitVec is ~1.3MB for 10M nodes vs HashSet OOM

use bitvec::prelude::*;
use std::collections::VecDeque;
use std::hash::Hash;

use crate::{DirectedGraph, NodeIndex};

/// Direction for traversal: Forward (children) or Reverse (parents).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Forward edges: follow src → dst
    Forward,
    /// Reverse edges: follow dst → src (transitive parents)
    Reverse,
}

/// Lazy BFS walker with BitVec visited tracking.
///
/// Yields K values one at a time without materializing the entire traversal.
/// Visited tracking uses BitVec for O(N/8) space efficiency.
pub struct BfsWalker<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    graph: &'g DirectedGraph<K, E>,
    queue: VecDeque<NodeIndex>,
    visited: BitVec,
    direction: Direction,
    start_node: Option<NodeIndex>, // Track start to skip it from results
}

impl<'g, K, E> BfsWalker<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    /// Create a new BFS walker starting from a single node.
    /// The start node is NOT yielded; only reachable neighbors are.
    pub fn new(graph: &'g DirectedGraph<K, E>, start: NodeIndex, direction: Direction) -> Self {
        let mut queue = VecDeque::new();
        let mut visited = bitvec![0; graph.next_index];

        // Mark start as visited
        if start.0 < visited.len() {
            visited.set(start.0, true);
        }

        // Enqueue neighbors of start (skip start itself)
        let neighbors = match direction {
            Direction::Forward => graph.forward.get(&start),
            Direction::Reverse => graph.reverse.get(&start),
        };

        if let Some(neighbor_set) = neighbors {
            for &neighbor_idx in neighbor_set.iter() {
                let idx = neighbor_idx.0;
                if idx < visited.len() && !visited[idx] {
                    visited.set(idx, true);
                    queue.push_back(neighbor_idx);
                }
            }
        }

        Self {
            graph,
            queue,
            visited,
            direction,
            start_node: Some(start),
        }
    }
}

impl<'g, K, E> Iterator for BfsWalker<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    type Item = K;

    fn next(&mut self) -> Option<K> {
        #[allow(clippy::never_loop)]
        while let Some(current) = self.queue.pop_front() {
            // Get the key for this node index
            let key = self.graph.nodes.get(&current)?.clone();

            // Get neighbors based on direction
            let neighbors = match self.direction {
                Direction::Forward => self.graph.forward.get(&current),
                Direction::Reverse => self.graph.reverse.get(&current),
            };

            // Enqueue unvisited neighbors
            if let Some(neighbor_set) = neighbors {
                for &neighbor_idx in neighbor_set.iter() {
                    let idx = neighbor_idx.0;
                    if idx < self.visited.len() && !self.visited[idx] {
                        self.visited.set(idx, true);
                        self.queue.push_back(neighbor_idx);
                    }
                }
            }

            // Clear start_node after first use (to skip it from results)
            self.start_node = None;
            return Some(key);
        }

        None
    }
}

/// Lazy DFS walker with BitVec visited tracking.
///
/// Yields K values one at a time without materializing the entire traversal.
/// Visited tracking uses BitVec for O(N/8) space efficiency.
pub struct DfsWalker<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    graph: &'g DirectedGraph<K, E>,
    stack: Vec<NodeIndex>,
    visited: BitVec,
    direction: Direction,
    start_node: Option<NodeIndex>, // Track start to skip it from results
}

impl<'g, K, E> DfsWalker<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    /// Create a new DFS walker starting from a single node.
    /// The start node is NOT yielded; only reachable neighbors are.
    pub fn new(graph: &'g DirectedGraph<K, E>, start: NodeIndex, direction: Direction) -> Self {
        let mut stack = vec![];
        let mut visited = bitvec![0; graph.next_index];

        // Mark start as visited
        if start.0 < visited.len() {
            visited.set(start.0, true);
        }

        // Push neighbors of start (skip start itself)
        let neighbors = match direction {
            Direction::Forward => graph.forward.get(&start),
            Direction::Reverse => graph.reverse.get(&start),
        };

        if let Some(neighbor_set) = neighbors {
            let mut neighbors_vec: Vec<_> = neighbor_set.iter().copied().collect();
            neighbors_vec.reverse();
            for neighbor_idx in neighbors_vec {
                let idx = neighbor_idx.0;
                if idx < visited.len() && !visited[idx] {
                    visited.set(idx, true);
                    stack.push(neighbor_idx);
                }
            }
        }

        Self {
            graph,
            stack,
            visited,
            direction,
            start_node: Some(start),
        }
    }
}

impl<'g, K, E> Iterator for DfsWalker<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    type Item = K;

    fn next(&mut self) -> Option<K> {
        #[allow(clippy::never_loop)]
        while let Some(current) = self.stack.pop() {
            // Get the key for this node index
            let key = self.graph.nodes.get(&current)?.clone();

            // Get neighbors based on direction
            let neighbors = match self.direction {
                Direction::Forward => self.graph.forward.get(&current),
                Direction::Reverse => self.graph.reverse.get(&current),
            };

            // Push unvisited neighbors (in reverse order for deterministic DFS)
            if let Some(neighbor_set) = neighbors {
                let mut neighbors: Vec<_> = neighbor_set.iter().copied().collect();
                neighbors.reverse();
                for neighbor_idx in neighbors {
                    let idx = neighbor_idx.0;
                    if idx < self.visited.len() && !self.visited[idx] {
                        self.visited.set(idx, true);
                        self.stack.push(neighbor_idx);
                    }
                }
            }

            // Clear start_node after first use
            self.start_node = None;
            return Some(key);
        }

        None
    }
}
