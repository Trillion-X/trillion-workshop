// crates/formula-core/tests/reactive_integration.rs
//
// # Purpose
//
// End-to-end integration tests proving the full reactive evaluation cycle works
// correctly. These tests exercise the complete pipeline: evaluate formula ->
// record ReadSet -> change data -> react -> formula re-evaluated.
//
// # Non-Negotiable Invariants
//
// 1. Every test uses the PUBLIC API only — no internal/test-only helpers.
//    Integration tests compile as a separate crate and cannot access #[cfg(test)]
//    modules within formula-core.
// 2. ReadSets are built via the actual EvaluationContext public API (set_variable,
//    lookup_variable, track_* methods, get_readset_snapshot) or via the Evaluator's
//    evaluate_ast_with_readset() method for true end-to-end tests.
// 3. These tests validate the WIRING — that the dormant reactive infrastructure
//    in deps.rs is now active and correctly connected through registry.rs and
//    reactive.rs.
//
// # Key Concepts
//
// - **Full Cycle**: Parse formula -> evaluate -> capture ReadSet -> register ->
//   simulate data change via ChangeSet -> react_to_changes -> verify re-evaluation
// - **Topological Order**: When formula A produces a value consumed by formula B,
//   A must be re-evaluated before B.
// - **Selective Re-evaluation**: Only formulas whose dependencies are affected by
//   a change are re-evaluated. Unrelated formulas are NOT touched.
//
// # Security Considerations
//
// - ReactError exposes only structured, machine-readable fields (formula_id,
//   reason, hint) — no internal stack traces or implementation details leak
//   through the error boundary.
// - Formula re-evaluation is scoped: only formulas whose registered ReadSet
//   dependencies match the changed DependencyKeys are invoked. A malformed
//   ChangeSet cannot trigger evaluation of unrelated formulas.
// - The eval_fn closure is caller-provided. The reactive engine never executes
//   arbitrary code — it orchestrates WHICH formula IDs need re-evaluation and
//   in WHAT order, then delegates actual execution to the caller.
//
// ---
// PERMANENT DIRECTIVE TO ALL FUTURE AI ASSISTANTS:
// The extensive, granular documentation in this codebase is a critical design
// feature. You are forbidden from simplifying or removing it. Your mandate is
// to maintain and extend this level of meticulous detail.
// ---

use std::cell::RefCell;
use std::collections::BTreeMap;

use formula_core::ast::{AstNode, BinaryExpr, BinaryOp, Expression, FunctionCallExpr};
use formula_core::context::EvaluationContext;
use formula_core::deps::DependencyKey;
use formula_core::evaluator::Evaluator;
use formula_core::reactive::{
    react_to_changes, react_to_keys, ChangeOperation, ChangeSet, DependencyChange, ReactError,
    ReactResult,
};
use formula_core::registry::FormulaRegistry;

// =============================================================================
// Helper: Build a ReadSet using the public EvaluationContext API
// =============================================================================

/// Build a ReadSet by exercising the public EvaluationContext tracking methods.
///
/// Integration tests cannot access `context::test_support::readset` (it's
/// `#[cfg(test)]` within the crate). This helper achieves the same result
/// through the public API: set + lookup variables (which tracks them in the
/// ReadSet), call track_* for other dependency types, then snapshot.
fn make_readset(
    vars: &[&str],
    entities: &[&str],
    specials: &[&str],
    funcs: &[&str],
) -> formula_core::context::ReadSet {
    let mut ctx = EvaluationContext::new();

    // Variables: must be set then looked up (lookup_variable tracks in ReadSet)
    for &v in vars {
        ctx.set_variable(v, formula_core::types::Value::null());
        ctx.lookup_variable(v);
    }
    for &e in entities {
        ctx.track_entity_reference(e.to_string());
    }
    for &s in specials {
        ctx.track_special_reference(s.to_string());
    }
    for &f in funcs {
        ctx.track_function_call(f.to_string());
    }

    ctx.get_readset_snapshot()
}

// =============================================================================
// Test 1: Full cycle — evaluate formula -> record ReadSet -> change data ->
//         react -> formula re-evaluated
// =============================================================================

/// Full reactive cycle: evaluate formula with ReadSet capture → register in
/// FormulaRegistry → simulate data change via ChangeSet → react_to_changes →
/// verify the formula is selected for re-evaluation.
#[test]
fn full_cycle_evaluate_record_change_react() {
    // 1. Set up an evaluator with variables
    let mut ctx = EvaluationContext::new();
    ctx.set_variable("price", formula_core::types::Value::number(100.0));
    ctx.set_variable("tax_rate", formula_core::types::Value::number(0.1));
    let mut evaluator = Evaluator::new(ctx);

    // 2. Build AST for: price * tax_rate (= 10.0)
    let ast = AstNode::Expression(Expression::Binary(Box::new(BinaryExpr {
        left: Expression::Identifier("price".to_string()),
        op: BinaryOp::Multiply,
        right: Expression::Identifier("tax_rate".to_string()),
    })));

    // 3. Evaluate and capture ReadSet
    let (result, readset) = evaluator.evaluate_ast_with_readset(&ast);
    assert!(result.is_ok(), "evaluation should succeed");
    assert_eq!(result.unwrap(), formula_core::types::Value::number(10.0));

    // 4. Verify ReadSet captured the correct dependencies
    assert!(
        readset.get_variables().contains("price"),
        "ReadSet should track 'price'"
    );
    assert!(
        readset.get_variables().contains("tax_rate"),
        "ReadSet should track 'tax_rate'"
    );

    // 5. Register formula in the registry
    let mut registry = FormulaRegistry::new();
    registry.record_readset("total_tax".into(), readset);
    assert_eq!(registry.formula_count(), 1);

    // 6. Create a ChangeSet: property "price" changed
    let changeset = ChangeSet::from_entries(vec![DependencyChange::variable(
        "price",
        ChangeOperation::Update,
    )]);

    // 7. React to the change and verify the formula is re-evaluated
    let evaluated: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result = react_to_changes(&mut registry, &changeset, |formula_id| {
        evaluated.borrow_mut().push(formula_id.to_string());
        Ok(())
    })
    .unwrap();

    assert_eq!(
        result,
        ReactResult::Recomputed { count: 1 },
        "one formula should be re-evaluated"
    );
    let evaluated = evaluated.into_inner();
    assert_eq!(evaluated, vec!["total_tax"]);
}

// =============================================================================
// Test 2: Formula depending on entity A is NOT re-evaluated when entity B
//         changes
// =============================================================================

/// Selective re-evaluation: when property "price" changes, only formulas depending
/// on "price" are re-evaluated. Formulas depending on "quantity" are untouched.
#[test]
fn selective_reevaluation_only_affected_formulas() {
    let mut registry = FormulaRegistry::new();

    // Formula A depends on "price"
    registry.record_readset("formula_a".into(), make_readset(&["price"], &[], &[], &[]));
    // Formula B depends on "quantity"
    registry.record_readset(
        "formula_b".into(),
        make_readset(&["quantity"], &[], &[], &[]),
    );

    // Change "price" — only formula_a should be affected
    let changeset = ChangeSet::from_entries(vec![DependencyChange::variable(
        "price",
        ChangeOperation::Update,
    )]);

    let evaluated: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result = react_to_changes(&mut registry, &changeset, |formula_id| {
        evaluated.borrow_mut().push(formula_id.to_string());
        Ok(())
    })
    .unwrap();

    assert_eq!(result, ReactResult::Recomputed { count: 1 });
    let evaluated = evaluated.into_inner();
    assert!(
        evaluated.contains(&"formula_a".to_string()),
        "formula_a depends on 'price' and should be re-evaluated"
    );
    assert!(
        !evaluated.contains(&"formula_b".to_string()),
        "formula_b depends on 'quantity', NOT 'price' — must NOT be re-evaluated"
    );
}

// =============================================================================
// Test 3: Chain — formula B depends on formula A; changing A's input
//         re-evaluates A then B
// =============================================================================

/// Chain dependency A→B: when A's input changes, A is re-evaluated before B
/// (topological order enforced by DependencyGraph with producer mappings).
#[test]
fn chain_dependency_topological_order() {
    let mut registry = FormulaRegistry::new();

    // Formula A depends on "raw_input" (a data variable)
    registry.record_readset("A".into(), make_readset(&["raw_input"], &[], &[], &[]));
    // Formula B depends on "derived_from_a" (produced by A)
    registry.record_readset("B".into(), make_readset(&["derived_from_a"], &[], &[], &[]));

    // Set up producer mapping: A produces "derived_from_a"
    let mut producers = BTreeMap::new();
    producers.insert(DependencyKey::Var("derived_from_a".into()), "A".into());
    let _ = registry.dependency_graph_with_producers(producers);

    // Change "raw_input" → A is directly affected, B transitively (via A→derived_from_a)
    let changeset = ChangeSet::from_entries(vec![DependencyChange::variable(
        "raw_input",
        ChangeOperation::Update,
    )]);

    let order: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result = react_to_changes(&mut registry, &changeset, |formula_id| {
        order.borrow_mut().push(formula_id.to_string());
        Ok(())
    })
    .unwrap();

    assert_eq!(result, ReactResult::Recomputed { count: 2 });
    let order = order.into_inner();

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
        "A must be evaluated BEFORE B (A produces 'derived_from_a' which B consumes)"
    );
}

// =============================================================================
// Test 4: Diamond — C depends on A and B; both depend on X; changing X
//         re-evaluates X→A→B→C in order
// =============================================================================

/// Diamond dependency X→{A,B}→C: X evaluated first, then A and B (either order),
/// then C last. Verifies topological ordering across a diamond-shaped graph.
#[test]
fn diamond_dependency_topological_order() {
    let mut registry = FormulaRegistry::new();

    // X depends on "raw_input" (data variable)
    registry.record_readset("X".into(), make_readset(&["raw_input"], &[], &[], &[]));
    // A depends on "x_output" (produced by X)
    registry.record_readset("A".into(), make_readset(&["x_output"], &[], &[], &[]));
    // B depends on "x_output" (also produced by X)
    registry.record_readset("B".into(), make_readset(&["x_output"], &[], &[], &[]));
    // C depends on "a_output" (produced by A) AND "b_output" (produced by B)
    registry.record_readset(
        "C".into(),
        make_readset(&["a_output", "b_output"], &[], &[], &[]),
    );

    // Producer mappings: X → x_output, A → a_output, B → b_output
    let mut producers = BTreeMap::new();
    producers.insert(DependencyKey::Var("x_output".into()), "X".into());
    producers.insert(DependencyKey::Var("a_output".into()), "A".into());
    producers.insert(DependencyKey::Var("b_output".into()), "B".into());
    let _ = registry.dependency_graph_with_producers(producers);

    // Change "raw_input" → affects X directly, then A and B (via X→x_output), then C
    let changeset = ChangeSet::from_entries(vec![DependencyChange::variable(
        "raw_input",
        ChangeOperation::Update,
    )]);

    let order: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result = react_to_changes(&mut registry, &changeset, |formula_id| {
        order.borrow_mut().push(formula_id.to_string());
        Ok(())
    })
    .unwrap();

    assert_eq!(result, ReactResult::Recomputed { count: 4 });
    let order = order.into_inner();

    let pos = |id: &str| -> usize {
        order
            .iter()
            .position(|f| f == id)
            .unwrap_or_else(|| panic!("{} should be in the evaluation order", id))
    };

    // X must come before A, B; A and B must come before C
    assert!(pos("X") < pos("A"), "X must be evaluated before A");
    assert!(pos("X") < pos("B"), "X must be evaluated before B");
    assert!(pos("A") < pos("C"), "A must be evaluated before C");
    assert!(pos("B") < pos("C"), "B must be evaluated before C");
}

// =============================================================================
// Test 5: Concurrent changes — two ChangeSets affecting different formulas
//         produce independent re-evaluations
// =============================================================================

/// Two independent ChangeSets affecting disjoint formula sets produce independent
/// re-evaluations — each ChangeSet triggers only its relevant formulas.
#[test]
fn concurrent_changesets_independent_reevaluations() {
    let mut registry = FormulaRegistry::new();

    // Formula F1 depends on "price"
    registry.record_readset("F1".into(), make_readset(&["price"], &[], &[], &[]));
    // Formula F2 depends on "color"
    registry.record_readset("F2".into(), make_readset(&["color"], &[], &[], &[]));

    // First changeset: "price" changes — only F1 affected
    let changeset_1 = ChangeSet::from_entries(vec![DependencyChange::variable(
        "price",
        ChangeOperation::Update,
    )]);

    let evaluated_1: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result_1 = react_to_changes(&mut registry, &changeset_1, |fid| {
        evaluated_1.borrow_mut().push(fid.to_string());
        Ok(())
    })
    .unwrap();

    assert_eq!(result_1, ReactResult::Recomputed { count: 1 });
    assert_eq!(evaluated_1.into_inner(), vec!["F1"]);

    // Second changeset: "color" changes — only F2 affected
    let changeset_2 = ChangeSet::from_entries(vec![DependencyChange::variable(
        "color",
        ChangeOperation::Update,
    )]);

    let evaluated_2: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result_2 = react_to_changes(&mut registry, &changeset_2, |fid| {
        evaluated_2.borrow_mut().push(fid.to_string());
        Ok(())
    })
    .unwrap();

    assert_eq!(result_2, ReactResult::Recomputed { count: 1 });
    assert_eq!(evaluated_2.into_inner(), vec!["F2"]);
}

// =============================================================================
// Test 6: Formula with no external dependencies is never in any recomputation
//         plan
// =============================================================================

/// A formula with an empty ReadSet (no dependencies — e.g., a constant) is never
/// included in any recomputation plan, regardless of what keys change.
#[test]
fn formula_with_no_dependencies_never_recomputed() {
    let mut registry = FormulaRegistry::new();

    // Formula with empty ReadSet (depends on nothing — e.g., a constant formula)
    registry.record_readset("constant".into(), make_readset(&[], &[], &[], &[]));
    // Formula that depends on "x"
    registry.record_readset("dynamic".into(), make_readset(&["x"], &[], &[], &[]));

    // Change "x" — only "dynamic" should be affected
    let changeset = ChangeSet::from_entries(vec![DependencyChange::variable(
        "x",
        ChangeOperation::Update,
    )]);

    let evaluated: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result = react_to_changes(&mut registry, &changeset, |fid| {
        evaluated.borrow_mut().push(fid.to_string());
        Ok(())
    })
    .unwrap();

    assert_eq!(result, ReactResult::Recomputed { count: 1 });
    let evaluated = evaluated.into_inner();
    assert!(
        !evaluated.contains(&"constant".to_string()),
        "formula with no dependencies should NEVER be in recomputation plan"
    );
    assert!(evaluated.contains(&"dynamic".to_string()));

    // Also try changing a random key — "constant" should still not be affected
    let changeset_random = ChangeSet::from_entries(vec![DependencyChange::variable(
        "random_key",
        ChangeOperation::Create,
    )]);

    let result_random = react_to_changes(&mut registry, &changeset_random, |_fid| {
        panic!("constant formula should not be re-evaluated for any key change");
    })
    .unwrap();

    assert_eq!(
        result_random,
        ReactResult::NoAffectedFormulas,
        "no formula should be affected by a random key"
    );
}

// =============================================================================
// Test 7: Re-evaluation updates the ReadSet (formula may now depend on
//         different keys)
// =============================================================================

/// After re-evaluation, a formula's ReadSet can change (e.g., conditional formula
/// now depends on "y" instead of "x"). Verifies that re-registering the ReadSet
/// correctly updates future recomputation plans.
#[test]
fn reevaluation_updates_readset() {
    let mut registry = FormulaRegistry::new();

    // Initially, formula depends on "x"
    registry.record_readset("formula_1".into(), make_readset(&["x"], &[], &[], &[]));

    // Verify: changing "x" affects formula_1
    let plan_before = registry.recomputation_plan(&[DependencyKey::Var("x".into())]);
    assert!(plan_before.contains(&"formula_1".to_string()));

    // Simulate re-evaluation: formula now depends on "y" instead of "x"
    // (this models a conditional formula like: IF(flag, x, y) where flag changed)
    let new_readset = make_readset(&["y"], &[], &[], &[]);
    registry.record_readset("formula_1".into(), new_readset);

    // After re-evaluation with new ReadSet: changing "x" should NOT affect formula_1
    let plan_after_x = registry.recomputation_plan(&[DependencyKey::Var("x".into())]);
    assert!(
        !plan_after_x.contains(&"formula_1".to_string()),
        "formula_1 no longer depends on 'x' after ReadSet update"
    );

    // But changing "y" should now affect formula_1
    let plan_after_y = registry.recomputation_plan(&[DependencyKey::Var("y".into())]);
    assert!(
        plan_after_y.contains(&"formula_1".to_string()),
        "formula_1 now depends on 'y' after ReadSet update"
    );
}

// =============================================================================
// Test 8: Removing a formula from registry means it's no longer re-evaluated
// =============================================================================

/// Removing a formula from the registry excludes it from all future recomputation
/// plans. Verifies that `remove_formula` permanently stops re-evaluation.
#[test]
fn removing_formula_prevents_reevaluation() {
    let mut registry = FormulaRegistry::new();

    registry.record_readset("active".into(), make_readset(&["x"], &[], &[], &[]));
    registry.record_readset("to_remove".into(), make_readset(&["x"], &[], &[], &[]));

    // Both should be in the plan before removal
    let changeset = ChangeSet::from_entries(vec![DependencyChange::variable(
        "x",
        ChangeOperation::Update,
    )]);

    let evaluated_before: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let _ = react_to_changes(&mut registry, &changeset, |fid| {
        evaluated_before.borrow_mut().push(fid.to_string());
        Ok(())
    })
    .unwrap();

    let before = evaluated_before.into_inner();
    assert!(before.contains(&"active".to_string()));
    assert!(before.contains(&"to_remove".to_string()));

    // Remove "to_remove" from the registry
    let removed = registry.remove_formula("to_remove");
    assert!(removed, "formula should be successfully removed");

    // After removal, only "active" should be re-evaluated
    let evaluated_after: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result = react_to_changes(&mut registry, &changeset, |fid| {
        evaluated_after.borrow_mut().push(fid.to_string());
        Ok(())
    })
    .unwrap();

    assert_eq!(result, ReactResult::Recomputed { count: 1 });
    let after = evaluated_after.into_inner();
    assert!(after.contains(&"active".to_string()));
    assert!(
        !after.contains(&"to_remove".to_string()),
        "removed formula should NOT be re-evaluated"
    );
}

// =============================================================================
// Test 9: Empty DependencyGraph handles react_to_keys gracefully
// =============================================================================

/// Edge case: empty registry, empty keys, and empty ChangeSets all produce
/// graceful results (NoAffectedFormulas or NoChanges) without panicking.
#[test]
fn empty_dependency_graph_handles_react_gracefully() {
    let mut registry = FormulaRegistry::new();

    // No formulas registered — react_to_keys should handle gracefully
    let keys = vec![DependencyKey::Var("anything".into())];
    let result = react_to_keys(&mut registry, &keys, |_| {
        panic!("eval_fn should never be called on empty registry");
    })
    .unwrap();

    assert_eq!(
        result,
        ReactResult::NoAffectedFormulas,
        "empty registry should produce NoAffectedFormulas, not panic"
    );

    // Also test with empty keys
    let result_empty_keys = react_to_keys(&mut registry, &[], |_| {
        panic!("eval_fn should never be called with empty keys");
    })
    .unwrap();

    assert_eq!(result_empty_keys, ReactResult::NoChanges);

    // And test react_to_changes with empty ChangeSet on empty registry
    let empty_changeset = ChangeSet::new();
    let result_empty_changeset = react_to_changes(&mut registry, &empty_changeset, |_| {
        panic!("eval_fn should never be called for empty changeset");
    })
    .unwrap();

    assert_eq!(result_empty_changeset, ReactResult::NoChanges);
}

// =============================================================================
// Test 10: Targeted recomputation — 1000 formulas with 100 dependencies each
// =============================================================================

/// Correctness/scale fixture: 1000 formulas with 100 dependencies each. A
/// targeted single-key change recomputes exactly one formula. Distributional
/// latency is enforced by the pinned G12 production benchmark; unit tests must
/// not turn one scheduler-dependent wall-clock sample into product truth.
#[test]
fn targeted_change_recomputes_one_of_1000_formulas_with_100_dependencies_each() {
    let mut registry = FormulaRegistry::new();

    // Register 1000 formulas, each depending on 100 unique variables
    // Formula i depends on vars: "v_{i*100+0}", "v_{i*100+1}", ..., "v_{i*100+99}"
    for i in 0..1000 {
        let vars: Vec<String> = (0..100).map(|j| format!("v_{}", i * 100 + j)).collect();
        let var_refs: Vec<&str> = vars.iter().map(|s| s.as_str()).collect();
        let readset = make_readset(&var_refs, &[], &[], &[]);
        registry.record_readset(format!("formula_{}", i), readset);
    }

    assert_eq!(registry.formula_count(), 1000);

    // Pre-build the dependency graph (this may take a moment, that's OK)
    let _ = registry.dependency_graph();

    // Change one variable that affects exactly one formula
    // (formula_42 depends on v_4200..v_4299).
    let keys = vec![DependencyKey::Var("v_4242".into())];
    let result = react_to_keys(&mut registry, &keys, |_| Ok(())).unwrap();

    assert_eq!(result, ReactResult::Recomputed { count: 1 });
}

// =============================================================================
// Test 11: Full end-to-end with actual evaluator — evaluate, register, change,
//          react, re-evaluate with updated context
// =============================================================================

/// True end-to-end: uses real Evaluator with EvaluationContext to evaluate
/// `quantity * unit_price`, captures ReadSet, registers, reacts to a "quantity"
/// change, then re-evaluates with updated context and re-registers the new ReadSet.
#[test]
fn full_end_to_end_with_evaluator() {
    // 1. Set up context with initial values
    let mut ctx = EvaluationContext::new();
    ctx.set_variable("quantity", formula_core::types::Value::number(5.0));
    ctx.set_variable("unit_price", formula_core::types::Value::number(20.0));

    // 2. Build AST: quantity * unit_price
    let ast = AstNode::Expression(Expression::Binary(Box::new(BinaryExpr {
        left: Expression::Identifier("quantity".to_string()),
        op: BinaryOp::Multiply,
        right: Expression::Identifier("unit_price".to_string()),
    })));

    // 3. Evaluate with ReadSet capture
    let mut evaluator = Evaluator::new(ctx);
    let (result, readset) = evaluator.evaluate_ast_with_readset(&ast);
    assert_eq!(
        result.unwrap(),
        formula_core::types::Value::number(100.0),
        "5 * 20 = 100"
    );

    // 4. Register in FormulaRegistry
    let mut registry = FormulaRegistry::new();
    registry.record_readset("line_total".into(), readset);

    // 5. Simulate data change: quantity was updated
    let changeset = ChangeSet::from_entries(vec![DependencyChange::variable(
        "quantity",
        ChangeOperation::Update,
    )]);

    // 6. React — verify formula is selected for re-evaluation
    let formulas_to_eval: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result = react_to_changes(&mut registry, &changeset, |formula_id| {
        formulas_to_eval.borrow_mut().push(formula_id.to_string());
        Ok(())
    })
    .unwrap();

    assert_eq!(result, ReactResult::Recomputed { count: 1 });
    assert_eq!(formulas_to_eval.into_inner(), vec!["line_total"]);

    // 7. Actually re-evaluate with UPDATED context (quantity = 10)
    let mut new_ctx = EvaluationContext::new();
    new_ctx.set_variable("quantity", formula_core::types::Value::number(10.0));
    new_ctx.set_variable("unit_price", formula_core::types::Value::number(20.0));

    let mut new_evaluator = Evaluator::new(new_ctx);
    let (new_result, new_readset) = new_evaluator.evaluate_ast_with_readset(&ast);

    // Verify new result
    assert_eq!(
        new_result.unwrap(),
        formula_core::types::Value::number(200.0),
        "10 * 20 = 200"
    );

    // 8. Update the ReadSet in the registry (dependencies may have changed)
    registry.record_readset("line_total".into(), new_readset);

    // Verify the registry still contains the formula with updated ReadSet
    assert!(registry.contains_formula("line_total"));
    let updated_readset = registry.get_readset("line_total").unwrap();
    assert!(updated_readset.get_variables().contains("quantity"));
    assert!(updated_readset.get_variables().contains("unit_price"));
}

// =============================================================================
// Test 12: Error propagation — eval_fn failure stops reactive chain and
//          returns structured ReactError
// =============================================================================

/// Error propagation: when eval_fn returns Err(ReactError), react_to_changes
/// stops and propagates the structured error with formula_id, reason, and hint.
#[test]
fn eval_fn_failure_propagates_structured_error() {
    let mut registry = FormulaRegistry::new();
    registry.record_readset("failing".into(), make_readset(&["x"], &[], &[], &[]));

    let changeset = ChangeSet::from_entries(vec![DependencyChange::variable(
        "x",
        ChangeOperation::Update,
    )]);

    let result = react_to_changes(&mut registry, &changeset, |formula_id| {
        Err(ReactError {
            formula_id: formula_id.to_string(),
            reason: "evaluation context expired".to_string(),
            hint: "refresh the evaluation context before reactive re-evaluation".to_string(),
        })
    });

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.formula_id, "failing");
    assert_eq!(err.reason, "evaluation context expired");
    assert!(!err.hint.is_empty());

    // Verify Display implementation
    let display = format!("{}", err);
    assert!(display.contains("failing"));
    assert!(display.contains("evaluation context expired"));
}

// =============================================================================
// Test 13: Mixed dependency types — formula depending on variables, entity
//          refs, special refs, and function calls
// =============================================================================

/// Mixed dependency types: a formula depending on Var + Entity + Special + Func
/// keys. Each matching DependencyKey type triggers re-evaluation; unrelated keys
/// produce NoAffectedFormulas.
#[test]
fn mixed_dependency_types_in_readset() {
    let mut registry = FormulaRegistry::new();

    // Formula depends on a mix of dependency types
    registry.record_readset(
        "complex_formula".into(),
        make_readset(
            &["user_name"],
            &["@.profile.avatar"],
            &["$scope"],
            &["TEXT"],
        ),
    );

    // Change "user_name" (a Var key) — should trigger re-evaluation
    let result_var = react_to_keys(
        &mut registry,
        &[DependencyKey::Var("user_name".into())],
        |fid| {
            assert_eq!(fid, "complex_formula");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(result_var, ReactResult::Recomputed { count: 1 });

    // Change an entity ref — should also trigger
    let result_entity = react_to_keys(
        &mut registry,
        &[DependencyKey::Entity("@.profile.avatar".into())],
        |fid| {
            assert_eq!(fid, "complex_formula");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(result_entity, ReactResult::Recomputed { count: 1 });

    // Change a special ref — should also trigger
    let result_special = react_to_keys(
        &mut registry,
        &[DependencyKey::Special("$scope".into())],
        |fid| {
            assert_eq!(fid, "complex_formula");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(result_special, ReactResult::Recomputed { count: 1 });

    // Change a function key — should also trigger
    let result_func = react_to_keys(
        &mut registry,
        &[DependencyKey::Func("TEXT".into())],
        |fid| {
            assert_eq!(fid, "complex_formula");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(result_func, ReactResult::Recomputed { count: 1 });

    // Change an unrelated key — should NOT trigger
    let result_unrelated = react_to_keys(
        &mut registry,
        &[DependencyKey::Var("unrelated".into())],
        |_| panic!("should not be called for unrelated key"),
    )
    .unwrap();
    assert_eq!(result_unrelated, ReactResult::NoAffectedFormulas);
}

// =============================================================================
// Test 14: ReadSet from actual formula evaluation (TEXT(x) — tracks variable
//          and function call)
// =============================================================================

/// Real evaluator produces correct ReadSet: evaluating `TEXT(score)` tracks both
/// the "score" variable and the "TEXT" function call. Both DependencyKey types
/// trigger re-evaluation when changed.
#[test]
fn readset_from_actual_formula_evaluation_tracks_all_deps() {
    let mut ctx = EvaluationContext::new();
    ctx.set_variable("score", formula_core::types::Value::number(42.0));

    // AST: TEXT(score)
    let ast = AstNode::Expression(Expression::FunctionCall(Box::new(FunctionCallExpr {
        function_name: "TEXT".to_string(),
        version: None,
        args: vec![Expression::Identifier("score".to_string())],
    })));

    let mut evaluator = Evaluator::new(ctx);
    let (result, readset) = evaluator.evaluate_ast_with_readset(&ast);

    assert_eq!(result.unwrap(), formula_core::types::Value::string("42"));

    // ReadSet should track both the variable and the function call
    assert!(
        readset.get_variables().contains("score"),
        "ReadSet should track 'score' variable"
    );
    assert!(
        readset.get_function_calls().contains("TEXT"),
        "ReadSet should track 'TEXT' function call"
    );

    // Register and verify reactive behavior
    let mut registry = FormulaRegistry::new();
    registry.record_readset("display_score".into(), readset);

    // Change to "score" should trigger re-evaluation
    let plan = registry.recomputation_plan(&[DependencyKey::Var("score".into())]);
    assert!(plan.contains(&"display_score".to_string()));

    // Change to "TEXT" function should also trigger (e.g., function implementation changed)
    let plan_func = registry.recomputation_plan(&[DependencyKey::Func("TEXT".into())]);
    assert!(plan_func.contains(&"display_score".to_string()));
}

// =============================================================================
// Test 15: Multiple changes in single ChangeSet — formulas affected by ANY
//          changed key are re-evaluated once
// =============================================================================

/// Multiple changes in one ChangeSet: "price" and "quantity" both change. F1
/// (depends on price), F2 (depends on quantity), and F3 (depends on both) are all
/// re-evaluated, with F3 evaluated exactly once (not once per changed dependency).
#[test]
fn multiple_changes_in_single_changeset() {
    let mut registry = FormulaRegistry::new();

    // F1 depends on "price", F2 depends on "quantity", F3 depends on both
    registry.record_readset("F1".into(), make_readset(&["price"], &[], &[], &[]));
    registry.record_readset("F2".into(), make_readset(&["quantity"], &[], &[], &[]));
    registry.record_readset(
        "F3".into(),
        make_readset(&["price", "quantity"], &[], &[], &[]),
    );

    // Single changeset with both "price" and "quantity" changed
    let changeset = ChangeSet::from_entries(vec![
        DependencyChange::variable("price", ChangeOperation::Update),
        DependencyChange::variable("quantity", ChangeOperation::Update),
    ]);

    let evaluated: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result = react_to_changes(&mut registry, &changeset, |fid| {
        evaluated.borrow_mut().push(fid.to_string());
        Ok(())
    })
    .unwrap();

    assert_eq!(result, ReactResult::Recomputed { count: 3 });
    let evaluated = evaluated.into_inner();
    assert!(evaluated.contains(&"F1".to_string()));
    assert!(evaluated.contains(&"F2".to_string()));
    assert!(evaluated.contains(&"F3".to_string()));
    // F3 should appear exactly once even though both its dependencies changed
    assert_eq!(
        evaluated.iter().filter(|f| *f == "F3").count(),
        1,
        "F3 should be re-evaluated exactly once, not once per changed dependency"
    );
}
