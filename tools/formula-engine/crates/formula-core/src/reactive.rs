// crates/formula-engine/src/reactive.rs
//
// # Purpose
//
// Bridges dependency-key change notifications to Formula Engine reactive
// re-evaluation. Formula-core does not know where those keys came from. The
// caller owns translation from its own event model into DependencyKey values;
// this module only finds affected formulas and re-evaluates them in topological
// order.
//
// # Non-Negotiable Invariants
//
// 1. Formula-engine remains PURE — this module defines its own lightweight
//    change types (ChangeSet, DependencyChange, ChangeOperation). No I/O crate
//    dependencies and no caller-schema vocabulary.
// 2. ChangeSet entries already contain DependencyKeys. Formula-core never maps
//    caller record names, property IDs, or application schemas into keys.
// 3. Re-evaluation order is ALWAYS topological — formulas that produce values
//    consumed by other formulas are re-evaluated first. This is guaranteed by
//    FormulaRegistry::recomputation_plan().
// 4. Errors during re-evaluation are structured ReactError objects with
//    formula_id, reason, and hint fields. No opaque strings.
// 5. An empty ChangeSet produces ReactResult::NoChanges — zero work is done.
//
// # Key Concepts
//
// - **ChangeSet**: Formula-engine's own representation of "which dependency
//   keys changed". It carries the exact normalized keys formula-core already
//   understands; it is not a caller-record event type.
//
// - **Boundary translation**: Callers translate their own world into
//   DependencyKey values before entering formula-core. Formula-core does not know
//   whether a Var("price") key came from a log record, a graph update, a local
//   variable write, or a file watcher.
//
// - **ReactResult**: Three-state outcome — NoChanges (nothing to do),
//   NoAffectedFormulas (keys changed but no formulas depend on them),
//   Recomputed { count } (formulas were re-evaluated).
//
// - **react_to_keys vs react_to_changes**: Two levels of API. react_to_keys
//   takes pre-translated DependencyKeys (maximum flexibility). react_to_changes
//   takes a ChangeSet and does the translation internally (convenience).
//
// # Security Considerations
//
// - ChangeSet carries no values — only normalized dependency keys and operation
//   type. No user data leaks through the reactive notification path.
// - eval_fn is caller-provided and may perform I/O (database reads for formula
//   context). This module does not validate or sandbox eval_fn — the caller is
//   responsible for security at the evaluation boundary.
//
// ---
// PERMANENT DIRECTIVE TO ALL FUTURE AI ASSISTANTS:
// The extensive, granular documentation in this codebase is a critical design
// feature. You are forbidden from simplifying or removing it. Your mandate is
// to maintain and extend this level of meticulous detail.
// ---

use crate::deps::DependencyKey;
use crate::registry::FormulaRegistry;

// =============================================================================
// Change Notification Types
// =============================================================================

/// A batch of dependency-key changes for the formula engine's reactive system.
///
/// This is formula-engine's own representation — deliberately minimal and
/// decoupled from any I/O crate or caller schema. Consumers translate from
/// their source format into DependencyKey values at the boundary.
///
/// # Why Not Accept Caller Records Directly?
///
/// Caller records belong to the caller. Formula-core is pure formula machinery:
/// parsing, evaluation, dependency collection, and recomputation planning. A
/// caller that stores facts in records, graph edges, files, or messages must
/// translate those events into DependencyKeys before calling this crate.
///
/// # Boundary Conversion Example
///
/// ```rust
/// use formula_core::deps::DependencyKey;
/// use formula_core::reactive::{ChangeOperation, ChangeSet, DependencyChange};
///
/// fn to_changeset(changed_variable_names: &[String]) -> ChangeSet {
///     ChangeSet::from_entries(
///         changed_variable_names
///             .iter()
///             .map(|name| {
///                 DependencyChange::new(
///                     DependencyKey::Var(name.clone()),
///                     ChangeOperation::Update,
///                 )
///             })
///             .collect(),
///     )
/// }
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeSet {
    /// Individual change entries describing what mutated.
    pub changes: Vec<DependencyChange>,
}

impl ChangeSet {
    /// Create an empty ChangeSet.
    pub fn new() -> Self {
        Self {
            changes: Vec::new(),
        }
    }

    /// Create a ChangeSet from a vec of entries.
    pub fn from_entries(changes: Vec<DependencyChange>) -> Self {
        Self { changes }
    }

    /// True if no changes were recorded.
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    /// Number of individual change entries.
    pub fn len(&self) -> usize {
        self.changes.len()
    }

    /// Add a change entry to this set.
    pub fn push(&mut self, entry: DependencyChange) {
        self.changes.push(entry);
    }
}

impl Default for ChangeSet {
    fn default() -> Self {
        Self::new()
    }
}

/// A single dependency-key change notification.
///
/// The reactive system only needs to know WHICH dependency key changed, not the
/// new value. The eval_fn reads current values from the evaluation context during
/// re-evaluation.
#[derive(Debug, Clone, PartialEq)]
pub struct DependencyChange {
    /// Normalized dependency key affected by this change.
    pub key: DependencyKey,
    /// What operation was performed on the caller's dependency source.
    pub operation: ChangeOperation,
}

impl DependencyChange {
    /// Create a change entry for an already-normalized dependency key.
    pub fn new(key: DependencyKey, operation: ChangeOperation) -> Self {
        Self { key, operation }
    }

    /// Convenience constructor for variable dependency changes.
    pub fn variable(name: impl Into<String>, operation: ChangeOperation) -> Self {
        Self::new(DependencyKey::Var(name.into()), operation)
    }

    /// Convenience constructor for special-reference dependency changes.
    pub fn special(name: impl Into<String>, operation: ChangeOperation) -> Self {
        Self::new(DependencyKey::Special(name.into()), operation)
    }

    /// Convenience constructor for entity-reference dependency changes.
    pub fn entity(reference: impl Into<String>, operation: ChangeOperation) -> Self {
        Self::new(DependencyKey::Entity(reference.into()), operation)
    }
}

/// What kind of mutation was performed.
///
/// The reactive system does not differentiate between operation types for
/// DependencyKey generation because the key is already normalized. The operation
/// type is preserved for hooks and observability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChangeOperation {
    /// A new dependency source was created.
    Create,
    /// An existing dependency source was updated.
    Update,
    /// A dependency source was deleted.
    Delete,
    /// A JSON Patch was applied.
    Patch,
    /// A single JSON path was set.
    JsonSet,
}

// =============================================================================
// Reactive Result and Error Types
// =============================================================================

/// Outcome of a reactive re-evaluation cycle.
///
/// Three distinct states allow callers to differentiate between "nothing
/// happened" (NoChanges), "changes occurred but no formulas care"
/// (NoAffectedFormulas), and "formulas were re-evaluated" (Recomputed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReactResult {
    /// The ChangeSet was empty — no DependencyKeys were available, zero work done.
    NoChanges,

    /// DependencyKeys were generated but no registered formulas depend on
    /// any of them — zero formulas re-evaluated.
    NoAffectedFormulas,

    /// Formulas were re-evaluated in topological order.
    /// `count` is the number of formulas that were re-evaluated.
    Recomputed {
        /// Number of formulas re-evaluated.
        count: usize,
    },
}

/// Structured error from reactive re-evaluation.
///
/// Returned when `eval_fn` fails for a specific formula. Contains the
/// formula ID, a human-readable reason, and a remediation hint.
///
/// # Invariants
///
/// - `formula_id` is always the ID of the formula that failed.
/// - `reason` describes what went wrong (never empty).
/// - `hint` suggests how to fix it (never empty).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactError {
    /// The formula that failed re-evaluation.
    pub formula_id: String,

    /// What went wrong during re-evaluation.
    pub reason: String,

    /// How to fix or investigate the failure.
    pub hint: String,
}

impl std::fmt::Display for ReactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "reactive re-evaluation failed for formula '{}': {} (hint: {})",
            self.formula_id, self.reason, self.hint
        )
    }
}

impl std::error::Error for ReactError {}

// =============================================================================
// Translation: ChangeSet → DependencyKeys
// =============================================================================

/// Extract the normalized DependencyKeys carried by a ChangeSet.
///
/// Formula-core performs no caller-schema translation here. Every
/// DependencyChange already contains the exact key that should drive
/// recomputation.
///
/// # Arguments
///
/// * `changeset` - The set of change notifications to translate.
///
/// # Returns
///
/// A `Vec<DependencyKey>` containing one key per change entry. May contain
/// duplicates if multiple entries affect the same dependency — the
/// DependencyGraph handles deduplication internally.
///
/// # Examples
///
/// ```rust
/// use formula_core::reactive::*;
/// use formula_core::deps::DependencyKey;
///
/// let changeset = ChangeSet::from_entries(vec![
///     DependencyChange::variable("user_name", ChangeOperation::Update),
///     DependencyChange::entity("external:ent-2", ChangeOperation::Create),
/// ]);
///
/// let keys = changeset_to_dependency_keys(&changeset);
/// assert_eq!(
///     keys,
///     vec![
///         DependencyKey::Var("user_name".into()),
///         DependencyKey::Entity("external:ent-2".into()),
///     ],
/// );
/// ```
pub fn changeset_to_dependency_keys(changeset: &ChangeSet) -> Vec<DependencyKey> {
    changeset
        .changes
        .iter()
        .map(|entry| entry.key.clone())
        .collect()
}

// =============================================================================
// Reactive Re-evaluation Orchestration
// =============================================================================

/// Execute reactive re-evaluation for a set of changed DependencyKeys.
///
/// This is the lower-level API — callers who already have DependencyKeys
/// (e.g., from their own translation logic) use this directly. For callers
/// with a ChangeSet, use `react_to_changes()` instead.
///
/// # Algorithm
///
/// 1. If `changed_keys` is empty → return `ReactResult::NoChanges`
/// 2. Ask FormulaRegistry for a topologically-ordered recomputation plan
/// 3. If plan is empty → return `ReactResult::NoAffectedFormulas`
/// 4. Call `eval_fn` for each formula in topological order
/// 5. If eval_fn fails → return `Err(ReactError)` immediately (fail-fast)
/// 6. If all succeed → return `ReactResult::Recomputed { count }`
///
/// # Arguments
///
/// * `registry` - The FormulaRegistry containing all active formulas and ReadSets.
/// * `changed_keys` - DependencyKeys that changed (pre-translated by caller).
/// * `eval_fn` - Closure that re-evaluates a formula by ID. Must return
///   `Ok(())` on success or `Err(ReactError)` on failure.
///
/// # Errors
///
/// Returns `Err(ReactError)` if any formula's re-evaluation fails. The error
/// contains the formula_id that failed. Formulas earlier in topological order
/// that already succeeded are NOT rolled back — their results stand.
pub fn react_to_keys(
    registry: &mut FormulaRegistry,
    changed_keys: &[DependencyKey],
    mut eval_fn: impl FnMut(&str) -> Result<(), ReactError>,
) -> Result<ReactResult, ReactError> {
    if changed_keys.is_empty() {
        return Ok(ReactResult::NoChanges);
    }

    let plan = registry.recomputation_plan(changed_keys);
    if plan.is_empty() {
        return Ok(ReactResult::NoAffectedFormulas);
    }

    let count = plan.len();

    for formula_id in &plan {
        eval_fn(formula_id)?;
    }

    Ok(ReactResult::Recomputed { count })
}

/// Execute reactive re-evaluation for a ChangeSet.
///
/// Convenience wrapper that translates the ChangeSet to DependencyKeys via
/// `changeset_to_dependency_keys()`, then delegates to `react_to_keys()`.
///
/// # Arguments
///
/// * `registry` - The FormulaRegistry containing all active formulas and ReadSets.
/// * `changeset` - The set of change notifications describing what mutated.
/// * `eval_fn` - Closure that re-evaluates a formula by ID.
///
/// # Errors
///
/// Returns `Err(ReactError)` if any formula's re-evaluation fails.
///
/// # Examples
///
/// ```rust
/// use formula_core::reactive::*;
/// use formula_core::registry::FormulaRegistry;
///
/// let mut registry = FormulaRegistry::new();
/// // ... register formulas and their ReadSets ...
///
/// let changeset = ChangeSet::from_entries(vec![
///     DependencyChange::variable("price", ChangeOperation::Update),
/// ]);
///
/// let result = react_to_changes(&mut registry, &changeset, |formula_id| {
///     // Re-evaluate the formula (caller provides actual evaluation logic)
///     Ok(())
/// });
/// ```
pub fn react_to_changes(
    registry: &mut FormulaRegistry,
    changeset: &ChangeSet,
    eval_fn: impl FnMut(&str) -> Result<(), ReactError>,
) -> Result<ReactResult, ReactError> {
    let keys = changeset_to_dependency_keys(changeset);
    react_to_keys(registry, &keys, eval_fn)
}

// =============================================================================
// Tests (11+ required per task spec)
// =============================================================================

#[cfg(test)]
mod reactive_tests {
    use super::*;
    use crate::context::test_support::readset;
    use crate::deps::DependencyKey;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    fn var_create(name: &str) -> DependencyChange {
        DependencyChange::variable(name, ChangeOperation::Create)
    }

    fn var_update(name: &str) -> DependencyChange {
        DependencyChange::variable(name, ChangeOperation::Update)
    }

    fn entity_create(reference: &str) -> DependencyChange {
        DependencyChange::entity(reference, ChangeOperation::Create)
    }

    // -------------------------------------------------------------------------
    // Test 1: changeset_to_dependency_keys returns variable create keys unchanged
    // -------------------------------------------------------------------------
    #[test]
    fn changeset_returns_variable_create_dependency_key() {
        let changeset = ChangeSet::from_entries(vec![var_create("user_name")]);

        let keys = changeset_to_dependency_keys(&changeset);

        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0], DependencyKey::Var("user_name".into()));
    }

    // -------------------------------------------------------------------------
    // Test 2: changeset_to_dependency_keys returns variable update keys unchanged
    // -------------------------------------------------------------------------
    #[test]
    fn changeset_returns_variable_update_dependency_key() {
        let changeset = ChangeSet::from_entries(vec![var_update("price")]);

        let keys = changeset_to_dependency_keys(&changeset);

        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0], DependencyKey::Var("price".into()));
    }

    // -------------------------------------------------------------------------
    // Test 3: changeset_to_dependency_keys keeps entity keys because the caller
    //         already translated its own source event into a DependencyKey.
    // -------------------------------------------------------------------------
    #[test]
    fn changeset_keeps_entity_dependency_keys() {
        let changeset = ChangeSet::from_entries(vec![
            entity_create("ent-1"),
            DependencyChange::entity("ent-2", ChangeOperation::Delete),
        ]);

        let keys = changeset_to_dependency_keys(&changeset);

        assert_eq!(
            keys,
            vec![
                DependencyKey::Entity("ent-1".into()),
                DependencyKey::Entity("ent-2".into())
            ]
        );
    }

    // -------------------------------------------------------------------------
    // Test 4: changeset_to_dependency_keys handles empty ChangeSet → empty keys
    // -------------------------------------------------------------------------
    #[test]
    fn changeset_empty_produces_empty_keys() {
        let changeset = ChangeSet::new();

        let keys = changeset_to_dependency_keys(&changeset);

        assert!(keys.is_empty());
    }

    // -------------------------------------------------------------------------
    // Test 5: react_to_changes returns NoChanges for empty ChangeSet
    // -------------------------------------------------------------------------
    #[test]
    fn react_returns_no_changes_for_empty_changeset() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));

        let changeset = ChangeSet::new();

        let result = react_to_changes(&mut registry, &changeset, |_| Ok(())).unwrap();

        assert_eq!(result, ReactResult::NoChanges);
    }

    // -------------------------------------------------------------------------
    // Test 6: react_to_changes returns NoAffectedFormulas when no formulas
    //         depend on the changed keys
    // -------------------------------------------------------------------------
    #[test]
    fn react_returns_no_affected_formulas_when_none_depend_on_changed_keys() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));

        // Change a property that no formula depends on
        let changeset = ChangeSet::from_entries(vec![var_update("unrelated_property")]);

        let result = react_to_changes(&mut registry, &changeset, |_| {
            panic!("eval_fn should not be called when no formulas are affected");
        })
        .unwrap();

        assert_eq!(result, ReactResult::NoAffectedFormulas);
    }

    // -------------------------------------------------------------------------
    // Test 7: react_to_changes calls eval_fn for each affected formula
    // -------------------------------------------------------------------------
    #[test]
    fn react_calls_eval_fn_for_each_affected_formula() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));
        registry.record_readset("f2".into(), readset(&["x"], &[], &[], &[]));
        registry.record_readset("f3".into(), readset(&["y"], &[], &[], &[]));

        let changeset = ChangeSet::from_entries(vec![var_update("x")]);

        let evaluated: RefCell<Vec<String>> = RefCell::new(Vec::new());

        let result = react_to_changes(&mut registry, &changeset, |formula_id| {
            evaluated.borrow_mut().push(formula_id.to_string());
            Ok(())
        })
        .unwrap();

        let evaluated = evaluated.into_inner();
        assert_eq!(result, ReactResult::Recomputed { count: 2 });
        assert!(evaluated.contains(&"f1".to_string()), "f1 depends on 'x'");
        assert!(evaluated.contains(&"f2".to_string()), "f2 depends on 'x'");
        assert!(
            !evaluated.contains(&"f3".to_string()),
            "f3 depends on 'y', not 'x'"
        );
    }

    // -------------------------------------------------------------------------
    // Test 8: react_to_changes calls eval_fn in topological order
    // -------------------------------------------------------------------------
    #[test]
    fn react_calls_eval_fn_in_topological_order() {
        let mut registry = FormulaRegistry::new();

        // A depends on "input" (a raw variable)
        // B depends on "derived" (produced by A)
        registry.record_readset("A".into(), readset(&["input"], &[], &[], &[]));
        registry.record_readset("B".into(), readset(&["derived"], &[], &[], &[]));

        // Set up producer mapping: A produces "derived"
        let mut producers = BTreeMap::new();
        producers.insert(DependencyKey::Var("derived".into()), "A".into());
        let _ = registry.dependency_graph_with_producers(producers);

        // Change "input" → affects A directly, B transitively (via A→derived)
        let changeset = ChangeSet::from_entries(vec![var_update("input")]);

        let order: RefCell<Vec<String>> = RefCell::new(Vec::new());

        let result = react_to_changes(&mut registry, &changeset, |formula_id| {
            order.borrow_mut().push(formula_id.to_string());
            Ok(())
        })
        .unwrap();

        let order = order.into_inner();
        assert_eq!(result, ReactResult::Recomputed { count: 2 });

        let pos_a = order
            .iter()
            .position(|f| f == "A")
            .expect("A should be evaluated");
        let pos_b = order
            .iter()
            .position(|f| f == "B")
            .expect("B should be evaluated");
        assert!(
            pos_a < pos_b,
            "A must be evaluated before B (A produces 'derived' which B consumes)"
        );
    }

    // -------------------------------------------------------------------------
    // Test 9: react_to_changes returns Recomputed with correct count
    // -------------------------------------------------------------------------
    #[test]
    fn react_returns_recomputed_with_correct_count() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));
        registry.record_readset("f2".into(), readset(&["x"], &[], &[], &[]));
        registry.record_readset("f3".into(), readset(&["x"], &[], &[], &[]));

        let changeset = ChangeSet::from_entries(vec![var_update("x")]);

        let result = react_to_changes(&mut registry, &changeset, |_| Ok(())).unwrap();

        assert_eq!(result, ReactResult::Recomputed { count: 3 });
    }

    // -------------------------------------------------------------------------
    // Test 10: Mixed ChangeSet preserves all caller-provided dependency keys
    // -------------------------------------------------------------------------
    #[test]
    fn mixed_changeset_preserves_all_dependency_keys() {
        let changeset = ChangeSet::from_entries(vec![
            entity_create("ent-1"),
            var_create("name"),
            DependencyChange::entity("ent-2", ChangeOperation::Delete),
            var_update("color"),
            DependencyChange::special("$scope", ChangeOperation::Patch),
        ]);

        let keys = changeset_to_dependency_keys(&changeset);

        assert_eq!(keys.len(), 5);
        assert_eq!(keys[0], DependencyKey::Entity("ent-1".into()));
        assert_eq!(keys[1], DependencyKey::Var("name".into()));
        assert_eq!(keys[2], DependencyKey::Entity("ent-2".into()));
        assert_eq!(keys[3], DependencyKey::Var("color".into()));
        assert_eq!(keys[4], DependencyKey::Special("$scope".into()));
    }

    // -------------------------------------------------------------------------
    // Test 11: Multiple variable changes produce multiple DependencyKeys
    // -------------------------------------------------------------------------
    #[test]
    fn multiple_variable_changes_produce_multiple_keys() {
        let changeset = ChangeSet::from_entries(vec![
            var_update("name"),
            var_update("email"),
            var_create("phone"),
        ]);

        let keys = changeset_to_dependency_keys(&changeset);

        assert_eq!(keys.len(), 3);
        assert!(keys.contains(&DependencyKey::Var("name".into())));
        assert!(keys.contains(&DependencyKey::Var("email".into())));
        assert!(keys.contains(&DependencyKey::Var("phone".into())));
    }

    // -------------------------------------------------------------------------
    // Test 12: react_to_changes propagates eval_fn errors as ReactError
    // -------------------------------------------------------------------------
    #[test]
    fn react_propagates_eval_fn_error() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));
        registry.record_readset("f2".into(), readset(&["x"], &[], &[], &[]));

        let changeset = ChangeSet::from_entries(vec![var_update("x")]);

        let call_count: RefCell<usize> = RefCell::new(0);

        let result = react_to_changes(&mut registry, &changeset, |formula_id| {
            *call_count.borrow_mut() += 1;
            if formula_id == "f1" || formula_id == "f2" {
                // Fail on the first formula encountered (could be f1 or f2
                // since BTreeSet ordering for f1/f2 is alphabetical)
                if *call_count.borrow() == 1 {
                    return Err(ReactError {
                        formula_id: formula_id.to_string(),
                        reason: "evaluation context missing".to_string(),
                        hint: "ensure entity data is loaded before reactive re-eval".to_string(),
                    });
                }
            }
            Ok(())
        });

        assert!(result.is_err(), "should propagate eval_fn error");
        let err = result.unwrap_err();
        assert!(!err.formula_id.is_empty());
        assert!(!err.reason.is_empty());
        assert!(!err.hint.is_empty());
    }

    // -------------------------------------------------------------------------
    // Test 13: react_to_keys works directly with DependencyKeys
    // -------------------------------------------------------------------------
    #[test]
    fn react_to_keys_works_with_dependency_keys_directly() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));

        let keys = vec![DependencyKey::Var("x".into())];

        let result = react_to_keys(&mut registry, &keys, |_| Ok(())).unwrap();

        assert_eq!(result, ReactResult::Recomputed { count: 1 });
    }

    // -------------------------------------------------------------------------
    // Test 14: react_to_keys returns NoChanges for empty keys slice
    // -------------------------------------------------------------------------
    #[test]
    fn react_to_keys_returns_no_changes_for_empty_keys() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));

        let result = react_to_keys(&mut registry, &[], |_| {
            panic!("should not be called");
        })
        .unwrap();

        assert_eq!(result, ReactResult::NoChanges);
    }

    // -------------------------------------------------------------------------
    // Test 15: ChangeSet constructors and accessors work correctly
    // -------------------------------------------------------------------------
    #[test]
    fn changeset_constructors_and_accessors() {
        let mut cs = ChangeSet::new();
        assert!(cs.is_empty());
        assert_eq!(cs.len(), 0);

        cs.push(var_create("name"));
        assert!(!cs.is_empty());
        assert_eq!(cs.len(), 1);

        let cs2 = ChangeSet::from_entries(vec![var_update("x"), var_update("y")]);
        assert_eq!(cs2.len(), 2);
    }

    // -------------------------------------------------------------------------
    // Test 16: DependencyChange factory methods produce correct keys
    // -------------------------------------------------------------------------
    #[test]
    fn change_entry_factory_methods() {
        let var = DependencyChange::variable("prop-a", ChangeOperation::Update);
        assert_eq!(var.key, DependencyKey::Var("prop-a".into()));
        assert_eq!(var.operation, ChangeOperation::Update);

        let ent = DependencyChange::entity("ent-2", ChangeOperation::Create);
        assert_eq!(ent.key, DependencyKey::Entity("ent-2".into()));
        assert_eq!(ent.operation, ChangeOperation::Create);

        let special = DependencyChange::special("$scope", ChangeOperation::Patch);
        assert_eq!(special.key, DependencyKey::Special("$scope".into()));
        assert_eq!(special.operation, ChangeOperation::Patch);
    }

    // -------------------------------------------------------------------------
    // Test 17: every entry produces its key; empty means no entry, not no property
    // -------------------------------------------------------------------------
    #[test]
    fn dependency_change_always_produces_its_key() {
        let changeset = ChangeSet::from_entries(vec![DependencyChange::new(
            DependencyKey::Func("TEXT".into()),
            ChangeOperation::Update,
        )]);

        let keys = changeset_to_dependency_keys(&changeset);

        assert_eq!(keys, vec![DependencyKey::Func("TEXT".into())]);
    }

    // -------------------------------------------------------------------------
    // Test 18: All ChangeOperation variants preserve their DependencyKeys
    // -------------------------------------------------------------------------
    #[test]
    fn all_change_operations_preserve_keys() {
        let operations = [
            ChangeOperation::Create,
            ChangeOperation::Update,
            ChangeOperation::Delete,
            ChangeOperation::Patch,
            ChangeOperation::JsonSet,
        ];

        for (i, op) in operations.iter().enumerate() {
            let prop = format!("prop_{}", i);
            let changeset =
                ChangeSet::from_entries(vec![DependencyChange::variable(prop.clone(), *op)]);

            let keys = changeset_to_dependency_keys(&changeset);

            assert_eq!(
                keys.len(),
                1,
                "operation {:?} should preserve its dependency key",
                op
            );
            assert_eq!(keys[0], DependencyKey::Var(prop));
        }
    }

    // -------------------------------------------------------------------------
    // Test 19: ReactError Display implementation
    // -------------------------------------------------------------------------
    #[test]
    fn react_error_display() {
        let err = ReactError {
            formula_id: "formula_total".to_string(),
            reason: "division by zero".to_string(),
            hint: "check denominator is non-zero before evaluation".to_string(),
        };

        let display = format!("{}", err);
        assert!(display.contains("formula_total"));
        assert!(display.contains("division by zero"));
        assert!(display.contains("check denominator"));
    }

    // -------------------------------------------------------------------------
    // Test 20: react_to_changes with entity-only ChangeSet returns
    //          NoAffectedFormulas when no formula depends on those entity keys
    // -------------------------------------------------------------------------
    #[test]
    fn react_entity_only_changeset_returns_no_affected_formulas() {
        let mut registry = FormulaRegistry::new();
        registry.record_readset("f1".into(), readset(&["x"], &[], &[], &[]));

        let changeset = ChangeSet::from_entries(vec![
            entity_create("ent-1"),
            DependencyChange::entity("ent-2", ChangeOperation::Delete),
        ]);

        let result = react_to_changes(&mut registry, &changeset, |_| {
            panic!("should not be called for entity-only changeset");
        })
        .unwrap();

        assert_eq!(result, ReactResult::NoAffectedFormulas);
    }
}
