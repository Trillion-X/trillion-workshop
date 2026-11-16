// crates/formula-engine/src/registry.rs
//
// # Purpose
//
// FormulaRegistry — Maintains the set of all active formulas and their runtime
// ReadSets. Builds DependencyGraph on demand for reactive re-evaluation. This is
// the bridge between on-demand evaluation (which produces ReadSets) and reactive
// re-evaluation (which consumes them).
//
// # Non-Negotiable Invariants
//
// 1. The cached DependencyGraph is ALWAYS invalidated when any readset changes
//    (insert, overwrite, or remove). Stale graphs cause silent mis-evaluation.
// 2. FormulaRegistry is the CANONICAL SINGLE SOURCE of formula-to-ReadSet
//    mappings. No other component duplicates this mapping.
// 3. DependencyGraph is built lazily — only when first requested after mutation.
//    Repeated reads without mutations return the cached graph.
// 4. All public methods that mutate state invalidate the cached graph.
//
// # Key Concepts
//
// - **ReadSet**: Captured during formula evaluation, records every variable,
//   entity reference, special reference, and function call accessed.
// - **DependencyGraph**: Built from all registered ReadSets, enables computation
//   of which formulas need re-evaluation when specific keys change.
// - **Recomputation Plan**: A topologically-ordered list of formula IDs that must
//   be re-evaluated in response to changed dependency keys.
//
// # Security Considerations
//
// FormulaRegistry holds no secrets — ReadSets contain dependency metadata, not
// evaluated values. Access control is enforced at the evaluation layer, not here.
//
// ---
// The extensive, granular documentation in this codebase is a critical design
// feature. You are forbidden from simplifying or removing it. Your mandate is
// to maintain and extend this level of meticulous detail.
// ---

use std::collections::{BTreeMap, HashMap};

use crate::context::ReadSet;
use crate::deps::{DependencyGraph, DependencyKey};

/// FormulaRegistry — The canonical store of active formulas and their ReadSets.
///
/// Maintains a map of formula IDs to their most-recently-evaluated ReadSets,
/// and lazily builds/caches a `DependencyGraph` for reactive re-evaluation.
///
/// # Usage
///
/// ```rust
/// use formula_core::registry::FormulaRegistry;
/// use formula_core::context::ReadSet;
/// use formula_core::deps::DependencyKey;
///
/// let mut registry = FormulaRegistry::new();
/// let readset = ReadSet::default();
///
/// // After evaluating a formula, record its ReadSet
/// registry.record_readset("formula_1".into(), readset);
///
/// // When data changes, compute which formulas need re-evaluation
/// let changed = vec![DependencyKey::Var("user_name".into())];
/// let plan = registry.recomputation_plan(&changed);
/// // plan contains topologically-ordered formula IDs to re-evaluate
/// ```
pub struct FormulaRegistry {
    /// formula_id → ReadSet from last evaluation.
    /// HashMap for O(1) insert/lookup/remove by formula ID.
    readsets: HashMap<String, ReadSet>,

    /// Cached dependency graph, built lazily from all registered ReadSets.
    /// Invalidated (set to `None`) whenever `readsets` is mutated.
    graph_cache: Option<DependencyGraph>,
}

impl FormulaRegistry {
    /// Create an empty FormulaRegistry with no registered formulas.
    pub fn new() -> Self {
        Self {
            readsets: HashMap::new(),
            graph_cache: None,
        }
    }

    /// Record a formula's ReadSet after evaluation.
    ///
    /// If the formula was already registered, its ReadSet is overwritten.
    /// Always invalidates the cached DependencyGraph.
    pub fn record_readset(&mut self, formula_id: String, readset: ReadSet) {
        self.readsets.insert(formula_id, readset);
        self.graph_cache = None;
    }

    /// Remove a formula from the registry (e.g., when a formula is deleted).
    ///
    /// Returns `true` if the formula was present and removed.
    /// Invalidates the cached DependencyGraph if a formula was actually removed.
    pub fn remove_formula(&mut self, formula_id: &str) -> bool {
        let removed = self.readsets.remove(formula_id).is_some();
        if removed {
            self.graph_cache = None;
        }
        removed
    }

    /// Clear all registered formulas and invalidate the cached graph.
    pub fn clear(&mut self) {
        self.readsets.clear();
        self.graph_cache = None;
    }

    /// Get or build the DependencyGraph from all recorded ReadSets.
    ///
    /// The graph is cached and reused on subsequent calls until a mutation
    /// (record_readset, remove_formula, clear) invalidates it.
    ///
    /// The graph is built WITHOUT producer mappings (no formula-to-formula edges
    /// via key production). Producer mappings can be supplied externally via
    /// `dependency_graph_with_producers()` when formula output keys are known.
    pub fn dependency_graph(&mut self) -> &DependencyGraph {
        if self.graph_cache.is_none() {
            self.graph_cache = Some(self.build_graph(None));
        }
        // SAFETY: We just ensured `graph_cache` is Some.
        self.graph_cache
            .as_ref()
            .expect("graph_cache was just set to Some")
    }

    /// Build and cache a DependencyGraph with explicit producer mappings.
    ///
    /// Producer mappings define which formula produces (writes) which
    /// DependencyKey, enabling formula-to-formula dependency edges.
    /// Without producers, only key-to-formula relationships are tracked.
    pub fn dependency_graph_with_producers(
        &mut self,
        producers: BTreeMap<DependencyKey, String>,
    ) -> &DependencyGraph {
        self.graph_cache = Some(self.build_graph(Some(producers)));
        self.graph_cache
            .as_ref()
            .expect("graph_cache was just set to Some")
    }

    /// Given changed dependency keys, return the topologically-ordered list of
    /// formula IDs that need re-evaluation.
    ///
    /// This is a convenience method that:
    /// 1. Ensures the DependencyGraph is built (lazy cache)
    /// 2. Delegates to `DependencyGraph::recomputation_plan()`
    ///
    /// Returns an empty Vec if no registered formulas are affected.
    pub fn recomputation_plan(&mut self, changed_keys: &[DependencyKey]) -> Vec<String> {
        // Build graph if not cached
        if self.graph_cache.is_none() {
            self.graph_cache = Some(self.build_graph(None));
        }
        let graph = self
            .graph_cache
            .as_ref()
            .expect("graph_cache was just set to Some");
        graph.recomputation_plan(changed_keys.iter().cloned())
    }

    /// Return the number of registered formulas.
    pub fn formula_count(&self) -> usize {
        self.readsets.len()
    }

    /// Check if a specific formula is registered.
    pub fn contains_formula(&self, formula_id: &str) -> bool {
        self.readsets.contains_key(formula_id)
    }

    /// Check if the DependencyGraph cache is currently valid (not invalidated).
    pub fn is_graph_cached(&self) -> bool {
        self.graph_cache.is_some()
    }

    /// Get a reference to a formula's ReadSet, if registered.
    pub fn get_readset(&self, formula_id: &str) -> Option<&ReadSet> {
        self.readsets.get(formula_id)
    }

    /// Get all registered formula IDs.
    pub fn formula_ids(&self) -> Vec<String> {
        self.readsets.keys().cloned().collect()
    }

    /// Internal: build a DependencyGraph from the current readsets.
    ///
    /// Converts the internal HashMap to the slice-of-tuples format that
    /// `DependencyGraph::build()` requires.
    fn build_graph(&self, producers: Option<BTreeMap<DependencyKey, String>>) -> DependencyGraph {
        let pairs: Vec<(String, ReadSet)> = self
            .readsets
            .iter()
            .map(|(id, rs)| (id.clone(), rs.clone()))
            .collect();
        DependencyGraph::build(&pairs, producers)
    }
}

impl Default for FormulaRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod registry_tests {
    use super::*;
    use crate::context::test_support::readset;
    use crate::deps::DependencyKey;
    use std::collections::BTreeMap;

    // -------------------------------------------------------------------------
    // Test 1: FormulaRegistry::new creates empty registry
    // -------------------------------------------------------------------------
    #[test]
    fn new_creates_empty_registry() {
        let registry = FormulaRegistry::new();
        assert_eq!(registry.formula_count(), 0);
        assert!(!registry.is_graph_cached());
        assert!(registry.formula_ids().is_empty());
    }

    // -------------------------------------------------------------------------
    // Test 2: record_readset stores ReadSet for formula ID
    // -------------------------------------------------------------------------
    #[test]
    fn record_readset_stores_readset() {
        let mut registry = FormulaRegistry::new();
        let rs = readset(&["x", "y"], &[], &[], &[]);

        registry.record_readset("formula_1".into(), rs);

        assert_eq!(registry.formula_count(), 1);
        assert!(registry.contains_formula("formula_1"));
        let stored = registry
            .get_readset("formula_1")
            .expect("readset should be stored");
        assert!(stored.get_variables().contains("x"));
        assert!(stored.get_variables().contains("y"));
    }

    // -------------------------------------------------------------------------
    // Test 3: record_readset overwrites previous ReadSet for same formula ID
    // -------------------------------------------------------------------------
    #[test]
    fn record_readset_overwrites_previous() {
        let mut registry = FormulaRegistry::new();

        // First evaluation depends on x
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));
        assert!(registry
            .get_readset("f1")
            .unwrap()
            .get_variables()
            .contains("x"));

        // Second evaluation depends on y instead
        registry.record_readset("f1".into(), readset(&["y"], &[], &[], &[]));
        assert_eq!(registry.formula_count(), 1, "should still be one formula");
        let stored = registry.get_readset("f1").unwrap();
        assert!(
            !stored.get_variables().contains("x"),
            "old dependency should be gone"
        );
        assert!(
            stored.get_variables().contains("y"),
            "new dependency should be present"
        );
    }

    // -------------------------------------------------------------------------
    // Test 4: record_readset invalidates cached DependencyGraph
    // -------------------------------------------------------------------------
    #[test]
    fn record_readset_invalidates_cached_graph() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));

        // Build and cache the graph
        let _ = registry.dependency_graph();
        assert!(registry.is_graph_cached());

        // Recording a new readset should invalidate the cache
        registry.record_readset("f2".into(), readset(&["y"], &[], &[], &[]));
        assert!(
            !registry.is_graph_cached(),
            "cache should be invalidated after mutation"
        );
    }

    // -------------------------------------------------------------------------
    // Test 5: dependency_graph() builds graph from recorded ReadSets
    // -------------------------------------------------------------------------
    #[test]
    fn dependency_graph_builds_from_readsets() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));
        registry.record_readset("f2".into(), readset(&["y"], &[], &[], &[]));

        let graph = registry.dependency_graph();

        // Both formulas should appear in the graph's dependency map
        assert!(graph.deps_by_formula.contains_key("f1"));
        assert!(graph.deps_by_formula.contains_key("f2"));

        // f1 should depend on Var("x")
        assert!(graph.deps_by_formula["f1"].contains(&DependencyKey::Var("x".into())));

        // f2 should depend on Var("y")
        assert!(graph.deps_by_formula["f2"].contains(&DependencyKey::Var("y".into())));
    }

    // -------------------------------------------------------------------------
    // Test 6: dependency_graph() returns cached graph on second call
    // -------------------------------------------------------------------------
    #[test]
    fn dependency_graph_returns_cached() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));

        // First call builds
        assert!(!registry.is_graph_cached());
        let _ = registry.dependency_graph();
        assert!(registry.is_graph_cached());

        // Second call returns cached (verified by checking cache is still valid)
        let _ = registry.dependency_graph();
        assert!(
            registry.is_graph_cached(),
            "graph should still be cached after second read"
        );
    }

    // -------------------------------------------------------------------------
    // Test 7: recomputation_plan returns empty vec when no formulas affected
    // -------------------------------------------------------------------------
    #[test]
    fn recomputation_plan_empty_when_no_affected() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));

        // Change a key that no formula depends on
        let plan = registry.recomputation_plan(&[DependencyKey::Var("unrelated".into())]);
        assert!(
            plan.is_empty(),
            "no formulas should be affected by an unrelated key"
        );
    }

    // -------------------------------------------------------------------------
    // Test 8: recomputation_plan returns affected formula IDs in topological order
    // -------------------------------------------------------------------------
    #[test]
    fn recomputation_plan_returns_affected_in_order() {
        let mut registry = FormulaRegistry::new();

        // A depends on "input", B depends on "derived", C depends on "derived" and "other"
        registry.record_readset("A".into(), readset(&["input"], &[], &[], &[]));
        registry.record_readset("B".into(), readset(&["derived"], &[], &[], &[]));
        registry.record_readset("C".into(), readset(&["derived", "other"], &[], &[], &[]));

        // Set up producers: A produces "derived"
        let mut producers = BTreeMap::new();
        producers.insert(DependencyKey::Var("derived".into()), "A".into());
        let _ = registry.dependency_graph_with_producers(producers);

        // When "input" changes, A is directly affected, B and C transitively via A->derived
        let plan = registry.recomputation_plan(&[DependencyKey::Var("input".into())]);

        assert!(
            plan.contains(&"A".to_string()),
            "A should be in plan (directly affected)"
        );
        assert!(
            plan.contains(&"B".to_string()),
            "B should be in plan (depends on A's output)"
        );
        assert!(
            plan.contains(&"C".to_string()),
            "C should be in plan (depends on A's output)"
        );

        // A must come before B and C in topological order
        let pos_a = plan.iter().position(|f| f == "A").unwrap();
        let pos_b = plan.iter().position(|f| f == "B").unwrap();
        let pos_c = plan.iter().position(|f| f == "C").unwrap();
        assert!(pos_a < pos_b, "A must be evaluated before B");
        assert!(pos_a < pos_c, "A must be evaluated before C");
    }

    // -------------------------------------------------------------------------
    // Test 9: Two formulas with shared dependency both appear in plan
    // -------------------------------------------------------------------------
    #[test]
    fn shared_dependency_both_in_plan() {
        let mut registry = FormulaRegistry::new();

        // Both f1 and f2 depend on the same variable "shared"
        registry.record_readset("f1".into(), readset(&["shared"], &[], &[], &[]));
        registry.record_readset("f2".into(), readset(&["shared"], &[], &[], &[]));

        let plan = registry.recomputation_plan(&[DependencyKey::Var("shared".into())]);
        assert!(plan.contains(&"f1".to_string()), "f1 depends on 'shared'");
        assert!(plan.contains(&"f2".to_string()), "f2 depends on 'shared'");
        assert_eq!(plan.len(), 2);
    }

    // -------------------------------------------------------------------------
    // Test 10: Formula with no dependencies never appears in recomputation plan
    // -------------------------------------------------------------------------
    #[test]
    fn no_deps_formula_never_in_plan() {
        let mut registry = FormulaRegistry::new();

        // f_nodeps has an empty ReadSet (no dependencies)
        registry.record_readset("f_nodeps".into(), readset(&[], &[], &[], &[]));
        registry.record_readset("f_with_deps".into(), readset(&["x"], &[], &[], &[]));

        // Change any key — f_nodeps should never appear
        let plan = registry.recomputation_plan(&[DependencyKey::Var("x".into())]);
        assert!(
            !plan.contains(&"f_nodeps".to_string()),
            "formula with no deps should not appear"
        );
        assert!(
            plan.contains(&"f_with_deps".to_string()),
            "formula depending on x should appear"
        );
    }

    // -------------------------------------------------------------------------
    // Test 11: Removing a readset (formula deleted) updates graph correctly
    // -------------------------------------------------------------------------
    #[test]
    fn remove_formula_updates_graph() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));
        registry.record_readset("f2".into(), readset(&["x"], &[], &[], &[]));

        // Both should appear before removal
        let plan = registry.recomputation_plan(&[DependencyKey::Var("x".into())]);
        assert_eq!(plan.len(), 2);

        // Remove f1
        let removed = registry.remove_formula("f1");
        assert!(removed, "f1 should have been removed");
        assert!(!registry.contains_formula("f1"));
        assert_eq!(registry.formula_count(), 1);

        // Only f2 should appear now
        let plan = registry.recomputation_plan(&[DependencyKey::Var("x".into())]);
        assert_eq!(plan.len(), 1);
        assert!(plan.contains(&"f2".to_string()));
        assert!(
            !plan.contains(&"f1".to_string()),
            "removed formula should not appear"
        );
    }

    // -------------------------------------------------------------------------
    // Test 12: Large registry (100+ formulas) builds graph correctly
    // -------------------------------------------------------------------------
    #[test]
    fn large_registry_builds_correctly() {
        let mut registry = FormulaRegistry::new();

        // Register 150 formulas, each depending on a unique variable
        for i in 0..150 {
            let formula_id = format!("formula_{:04}", i);
            let var_name = format!("var_{:04}", i);
            registry.record_readset(formula_id, readset(&[var_name.as_str()], &[], &[], &[]));
        }

        assert_eq!(registry.formula_count(), 150);

        // Build the graph
        let graph = registry.dependency_graph();
        assert_eq!(graph.deps_by_formula.len(), 150);

        // Changing var_0042 should only affect formula_0042
        let plan = registry.recomputation_plan(&[DependencyKey::Var("var_0042".into())]);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0], "formula_0042");
    }

    // -------------------------------------------------------------------------
    // Test 13: remove_formula returns false for non-existent formula
    // -------------------------------------------------------------------------
    #[test]
    fn remove_nonexistent_returns_false() {
        let mut registry = FormulaRegistry::new();
        assert!(!registry.remove_formula("does_not_exist"));
        assert_eq!(registry.formula_count(), 0);
    }

    // -------------------------------------------------------------------------
    // Test 14: clear removes all formulas and invalidates cache
    // -------------------------------------------------------------------------
    #[test]
    fn clear_removes_all() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));
        registry.record_readset("f2".into(), readset(&["y"], &[], &[], &[]));
        let _ = registry.dependency_graph();
        assert!(registry.is_graph_cached());

        registry.clear();
        assert_eq!(registry.formula_count(), 0);
        assert!(!registry.is_graph_cached());
        assert!(!registry.contains_formula("f1"));
        assert!(!registry.contains_formula("f2"));
    }

    // -------------------------------------------------------------------------
    // Test 15: ReadSets with entity references and special refs work correctly
    // -------------------------------------------------------------------------
    #[test]
    fn entity_and_special_refs_in_plan() {
        let mut registry = FormulaRegistry::new();

        // f1 depends on an entity ref, f2 on a special ref
        registry.record_readset("f1".into(), readset(&[], &["user.name"], &[], &[]));
        registry.record_readset("f2".into(), readset(&[], &[], &["@.owner"], &[]));

        let plan = registry.recomputation_plan(&[DependencyKey::Entity("user.name".into())]);
        assert_eq!(plan.len(), 1);
        assert!(plan.contains(&"f1".to_string()));

        let plan = registry.recomputation_plan(&[DependencyKey::Special("@.owner".into())]);
        assert_eq!(plan.len(), 1);
        assert!(plan.contains(&"f2".to_string()));
    }

    // -------------------------------------------------------------------------
    // Test 16: Default trait implementation
    // -------------------------------------------------------------------------
    #[test]
    fn default_creates_empty_registry() {
        let registry = FormulaRegistry::default();
        assert_eq!(registry.formula_count(), 0);
        assert!(!registry.is_graph_cached());
    }

    // -------------------------------------------------------------------------
    // Test 17: recomputation_plan with empty registry returns empty
    // -------------------------------------------------------------------------
    #[test]
    fn empty_registry_empty_plan() {
        let mut registry = FormulaRegistry::new();
        let plan = registry.recomputation_plan(&[DependencyKey::Var("anything".into())]);
        assert!(plan.is_empty());
    }

    // -------------------------------------------------------------------------
    // Test 18: dependency_graph_with_producers builds formula-to-formula edges
    // -------------------------------------------------------------------------
    #[test]
    fn producers_create_formula_edges() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("producer".into(), readset(&["input"], &[], &[], &[]));
        registry.record_readset("consumer".into(), readset(&["output"], &[], &[], &[]));

        let mut producers = BTreeMap::new();
        producers.insert(DependencyKey::Var("output".into()), "producer".into());

        let graph = registry.dependency_graph_with_producers(producers);

        // producer → consumer edge should exist
        let producer_children: Vec<&String> = graph
            .formula_edges
            .children(&"producer".to_string())
            .collect();
        assert!(
            producer_children.contains(&&"consumer".to_string()),
            "producer should have edge to consumer"
        );
    }
}
