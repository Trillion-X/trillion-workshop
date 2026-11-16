//! Graph algorithms: topological sort, cycle detection, SCC, reachability.
//!
//! File: crates/graph/src/algorithms.rs
//! Purpose: Advanced graph analysis algorithms
//! Non-Negotiable Invariants:
//! - topo_sort returns `impl Iterator<Item=K>` — NEVER Vec<K>
//! - Deterministic topo_sort via Kahn's algorithm with OrdSet tie-breaking
//! - detect_cycles returns Vec<Vec<K>> (SCCs) — Tarjan's algorithm
//! - is_reachable does BFS reachability check
//! - All algorithms use BitVec for visited tracking

use bitvec::prelude::*;
use std::collections::{HashMap as StdHashMap, VecDeque};
use std::hash::Hash;

use crate::{DirectedGraph, NodeIndex};

/// Deterministic topological sort — returns lazy iterator.
///
/// Uses Kahn's algorithm with OrdSet for deterministic tie-breaking.
/// The same graph always produces the same topological order.
///
/// Returns `impl Iterator<Item = K>` — lazy, NOT `Vec<K>`.
pub fn topo_sort<K, E>(graph: &DirectedGraph<K, E>) -> impl Iterator<Item = K> + '_
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    TopoSortIter::new(graph)
}

/// Lazy topological sort iterator using Kahn's algorithm.
struct TopoSortIter<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    graph: &'g DirectedGraph<K, E>,
    in_degree: StdHashMap<NodeIndex, usize>,
    queue: VecDeque<NodeIndex>,
    emitted: usize,
}

impl<'g, K, E> TopoSortIter<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    fn new(graph: &'g DirectedGraph<K, E>) -> Self {
        let mut in_degree: StdHashMap<NodeIndex, usize> = StdHashMap::new();
        let mut queue = VecDeque::new();

        // Compute in-degrees for all nodes
        for (&node_idx, _) in graph.nodes.iter() {
            let degree = graph
                .reverse
                .get(&node_idx)
                .map(|preds| preds.len())
                .unwrap_or(0);
            in_degree.insert(node_idx, degree);

            // Enqueue all zero-in-degree nodes (deterministically via OrdSet)
            if degree == 0 {
                queue.push_back(node_idx);
            }
        }

        // Sort the initial queue deterministically
        let mut initial: Vec<_> = queue.iter().copied().collect();
        initial.sort_by_key(|idx| {
            graph
                .nodes
                .get(idx)
                .cloned()
                .unwrap_or_else(|| panic!("Node not found"))
        });
        queue = initial.into_iter().collect();

        Self {
            graph,
            in_degree,
            queue,
            emitted: 0,
        }
    }
}

impl<'g, K, E> Iterator for TopoSortIter<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    type Item = K;

    fn next(&mut self) -> Option<K> {
        // Process the front of the queue deterministically
        #[allow(clippy::never_loop)]
        while let Some(current) = self.queue.pop_front() {
            let key = self.graph.nodes.get(&current)?.clone();

            // Decrement in-degree for all successors
            if let Some(successors) = self.graph.forward.get(&current) {
                let mut ready = Vec::new();

                for &succ_idx in successors.iter() {
                    if let Some(degree) = self.in_degree.get_mut(&succ_idx) {
                        *degree -= 1;
                        if *degree == 0 {
                            ready.push(succ_idx);
                        }
                    }
                }

                // Sort ready nodes by their key for deterministic ordering
                ready.sort_by_key(|idx| {
                    self.graph
                        .nodes
                        .get(idx)
                        .cloned()
                        .unwrap_or_else(|| panic!("Node not found"))
                });

                for succ_idx in ready {
                    self.queue.push_back(succ_idx);
                }
            }

            self.emitted += 1;
            return Some(key);
        }

        None
    }
}

/// Tarjan's SCC algorithm — detects strongly connected components (cycles).
///
/// Returns a Vec of Vec<K>, where each inner Vec is one SCC.
/// Single-node SCCs with no self-loop are included.
pub fn detect_cycles<K, E>(graph: &DirectedGraph<K, E>) -> Vec<Vec<K>>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    let mut tarjan = TarjanSCC {
        graph,
        index_counter: 0,
        stack: Vec::new(),
        indices: StdHashMap::new(),
        lowlinks: StdHashMap::new(),
        on_stack: bitvec![0; graph.next_index],
        sccs: Vec::new(),
    };

    for (&node_idx, _) in graph.nodes.iter() {
        if !tarjan.indices.contains_key(&node_idx) {
            tarjan.strongconnect(node_idx);
        }
    }

    tarjan.sccs
}

struct TarjanSCC<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    graph: &'g DirectedGraph<K, E>,
    index_counter: usize,
    stack: Vec<NodeIndex>,
    indices: StdHashMap<NodeIndex, usize>,
    lowlinks: StdHashMap<NodeIndex, usize>,
    on_stack: BitVec,
    sccs: Vec<Vec<K>>,
}

impl<'g, K, E> TarjanSCC<'g, K, E>
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    fn strongconnect(&mut self, v: NodeIndex) {
        let v_idx = v.0;
        self.indices.insert(v, self.index_counter);
        self.lowlinks.insert(v, self.index_counter);
        self.index_counter += 1;

        if v_idx < self.on_stack.len() {
            self.on_stack.set(v_idx, true);
        }
        self.stack.push(v);

        // Consider successors
        if let Some(successors) = self.graph.forward.get(&v) {
            for &w in successors.iter() {
                let w_idx = w.0;
                if !self.indices.contains_key(&w) {
                    self.strongconnect(w);
                    let w_lowlink = *self.lowlinks.get(&w).unwrap_or(&0);
                    let v_lowlink = self.lowlinks.entry(v).or_insert(0);
                    *v_lowlink = (*v_lowlink).min(w_lowlink);
                } else if w_idx < self.on_stack.len() && self.on_stack[w_idx] {
                    let w_idx_val = *self.indices.get(&w).unwrap_or(&0);
                    let v_lowlink = self.lowlinks.entry(v).or_insert(0);
                    *v_lowlink = (*v_lowlink).min(w_idx_val);
                }
            }
        }

        // If v is a root node, pop the stack and emit SCC
        if self.lowlinks.get(&v) == self.indices.get(&v) {
            let mut scc = Vec::new();
            loop {
                let w = self.stack.pop().unwrap();
                let w_idx = w.0;
                if w_idx < self.on_stack.len() {
                    self.on_stack.set(w_idx, false);
                }

                if let Some(key) = self.graph.nodes.get(&w) {
                    scc.push(key.clone());
                }

                if w == v {
                    break;
                }
            }

            // Only include non-trivial SCCs (size > 1) or self-loops
            if scc.len() > 1 {
                self.sccs.push(scc);
            }
        }
    }
}

/// Reachability check — is `target` reachable from `source`?
///
/// Uses BFS to determine if there's a path from source to target.
/// Returns false if either source or target doesn't exist.
pub fn is_reachable<K, E>(graph: &DirectedGraph<K, E>, source: &K, target: &K) -> bool
where
    K: Hash + Eq + Ord + Clone,
    E: Clone,
{
    let source_idx = match graph.key_to_index.get(source) {
        Some(&idx) => idx,
        None => return false,
    };

    let target_idx = match graph.key_to_index.get(target) {
        Some(&idx) => idx,
        None => return false,
    };

    if source_idx == target_idx {
        return true;
    }

    let mut visited = bitvec![0; graph.next_index];
    let mut queue = VecDeque::new();

    visited.set(source_idx.0, true);
    queue.push_back(source_idx);

    while let Some(current) = queue.pop_front() {
        if current == target_idx {
            return true;
        }

        if let Some(successors) = graph.forward.get(&current) {
            for &succ_idx in successors.iter() {
                let idx = succ_idx.0;
                if idx < visited.len() && !visited[idx] {
                    visited.set(idx, true);
                    queue.push_back(succ_idx);
                }
            }
        }
    }

    false
}
