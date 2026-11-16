# graph — DirectedGraph with Cycle Detection and Traversal

Physics-level directed acyclic graph (DAG) with O(1) node operations, cycle detection on edge insertion, and lazy traversal iterators.

## Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | DirectedGraph struct, node/edge operations (add_node, add_edge, remove_node), DFS cycle detection, BFS/DFS traversal methods (ancestors, descendants), bounded path summaries |
| `src/removed.rs` | Removed struct: change propagation result when a node is deleted (includes all severed incoming/outgoing edges) |
| `src/iter.rs` | BfsWalker and DfsWalker: lazy traversal iterators with BitVec visited tracking for O(N/8) space efficiency |
| `src/algorithms.rs` | Advanced algorithms: topological sort (Kahn's algorithm), cycle detection (Tarjan's SCC), reachability checks |
| `src/merkle.rs` | Optional feature: Merkle hashing of graph structure for content-addressable DAG fingerprinting |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `DirectedGraph<K, E>` | `struct` with nodes, edges, forward/reverse maps | Core graph: K = node key (Hash + Eq + Ord + Clone), E = edge metadata (default = ()) |
| `NodeIndex` | `struct NodeIndex(usize)` | Dense integer index for O(1) internal tracking; external API uses K only |
| `CycleError<K>` | `{ path: Vec<K> }` | Returned when add_edge would create a cycle; includes the cycle path |
| `BoundedPathSummary` | `{ path_count: usize, max_depth_reached: Option<usize> }` | Aggregate over all paths in a bounded depth range without materializing path lists |
| `Removed<K, E>` | `{ key: K, incoming: Vec<(K,E)>, outgoing: Vec<(K,E)> }` | Result of remove_node; returns all severed edges with metadata |
| `add_node(key: K) -> bool` | Adds node; returns false if already exists | O(1) insertion |
| `add_edge_with(src, dst, metadata) -> Result<(), CycleError>` | Adds edge with metadata; runs DFS cycle detection | O(V+E) DFS check per edge |
| `remove_node(key) -> Option<Removed<K,E>>` | Removes node and returns all severed edges | O(degree) |
| `children(key) -> impl Iterator<Item = &K>` | Direct successors (adjacent nodes reachable by outgoing edges) | O(degree) |
| `parents(key) -> impl Iterator<Item = &K>` | Direct predecessors (adjacent nodes reachable by incoming edges) | O(degree) |
| `ancestors(key) -> impl Iterator<Item = K>` | Transitive closure: all nodes reachable by reverse edge traversal | Uses BfsWalker, lazy |
| `descendants(key) -> impl Iterator<Item = K>` | Transitive closure: all nodes reachable by forward edge traversal | Uses BfsWalker, lazy |
| `bounded_path_summary(key, direction, min_depth, max_depth) -> BoundedPathSummary` | Counts paths inside a depth band and reports longest matching depth | Dynamic frontier aggregation; does not materialize every path |
| `BfsWalker<'g, K, E>` | Lazy breadth-first traversal iterator | Yields K values one at a time; BitVec visited tracking; Direction::Forward or Direction::Reverse |
| `topo_sort(graph) -> impl Iterator<Item = K>` | Topological order via Kahn's algorithm | Deterministic via OrdSet tie-breaking; lazy iterator |
| `detect_cycles(graph) -> Vec<Vec<K>>` | Strongly connected components (SCCs) via Tarjan's algorithm | Returns non-trivial cycles; empty Vec if acyclic |

## Dependencies

**Workspace (shared):**
- serde, serde_json

**Crate-specific:**
- `im::HashMap`, `im::OrdSet` — Persistent (immutable) maps with structural sharing
- `bitvec` — Bit-packed visited tracking for O(N/8) space vs O(N) with HashSet

**Depended on by:**
- `trigger-engine` — Builds trigger dependency graphs; uses cycle detection to validate trigger chains
- `workflow` — DAG validation for workflow action pipelines
- Any system requiring acyclic dependency analysis (migrations, schema evolution, etc.)

## Key Invariants

**L055: Cycle Detection at Edge Time** — Cycles are rejected the moment they would be created, not discovered later. DFS runs from dst → src on every add_edge; if src is reachable from dst, the edge is rejected with a CycleError containing the cycle path.

**L090: Identity Preservation via NodeIndex** — External API uses K (user-visible key); internal maps use dense NodeIndex for O(1) lookup. Bidirectional key_to_index and index_to_node maps ensure all operations are O(1) on node identity regardless of K's complexity.

**P1: Structural Sharing** — forward and reverse maps use im::OrdSet (HAMT-based), not Vec, to enable efficient sharing when graphs are cloned or partially modified.

**Memory Efficiency** — Visited tracking uses BitVec, not HashSet. A 10M-node graph uses ~1.3MB BitVec vs OOM with HashSet. Critical for trillion-scale DAG analysis.

**Deterministic Traversal Order** — All internal sets are OrdSet (ordered by Ord), so the same graph always produces the same topological order, ancestor list, and descendant list. Testability and reproducibility guaranteed.

## Tests

```bash
cargo test -p graph
cargo check -p graph --all-features
```

**Coverage:**
- Node add/remove with cycle detection
- Edge operations (add with metadata, remove with metadata extraction)
- Transitive closure: ancestors() and descendants()
- Bounded path summary: depth ranges, reverse traversal, duplicate path counting, empty ranges
- Topological sort determinism
- Cycle detection via SCC analysis
- Path reconstruction for error messages
- BitVec visited tracking efficiency

## Architecture

### Graph Representation

- **forward**: NodeIndex → OrdSet<NodeIndex> — outgoing adjacency lists
- **reverse**: NodeIndex → OrdSet<NodeIndex> — incoming adjacency lists
- **edges**: (NodeIndex, NodeIndex) → E — edge metadata storage
- **key_to_index** / **nodes**: O(1) bidirectional key ↔ index mapping

### Cycle Detection

On add_edge(src, dst):
1. Look up NodeIndex for src and dst
2. DFS from dst → can we reach src? (If yes, adding src→dst creates a cycle)
3. If reachable, reconstruct path via `dfs_path_trace()` and return CycleError
4. Otherwise, insert edge

### Traversal Strategy

- **BfsWalker**: Queue-based level-order traversal
- **DfsWalker**: Stack-based depth-first traversal (future crate expansion)
- **Both**: Use BitVec for O(N/8) space instead of HashSet/HashMap
- **Bounded path summary**: Depth-by-depth frontier aggregation. If two different paths reach the same node at the same depth, their counts are added instead of materializing two path vectors.

## Non-Negotiable Rules

- **L029:** No temporary solutions. Graph invariants are enforced from day one.
- **L030:** If removing the cycle detection feature, delete the entire feature flag, not deprecate.
- **L063:** The acyclic invariant is THE structural property that prevents entire classes of bugs (infinite loops, deadlocks from circular dependencies).
- **L069:** DirectedGraph is a generative primitive: cycle detection + lazy traversal + identity preservation = every graph algorithm can compose from these three properties without specialization.
- **L090:** K is self-describing (Ord ensures deterministic iteration); NodeIndex is the internal handler; system doesn't need variant enums per key type.

## Relation to Other Crates

- **trigger-engine** — Builds DAG of trigger → action dependencies; uses cycle detection to ensure no circular trigger chains
- **workflow** — Validates action step graph is acyclic
- **composition-engine** — Scene tree can use DAG algorithms for transitive parent/child relationships (future)
