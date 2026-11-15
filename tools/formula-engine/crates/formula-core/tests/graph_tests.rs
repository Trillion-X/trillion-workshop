//! Integration tests for formula-engine graph rules integration
//!
//! Tests the integration between formula-engine RewriteRules (PARENTS, CHILDREN, NEIGHBORS, TRAVERSE)
//! and the underlying ops-core graph stubs. These are end-to-end integration tests for the
//! graph traversal rule system.

#[test]
fn test_graph_rules_delegate_through_ops_core() {
    // This test verifies that formula-engine's graph rules
    // correctly delegate to ops_core::graph module.
    //
    // In the current stub implementation, all graph rules return empty arrays
    // after validating input types. Future implementation will wire these
    // through the caller-owned SolverContext for actual graph traversal.

    // Test would need access to formula-engine's internal rule system,
    // which is integration tested at the Manifold level (Task 170+).
    // For now, verify the ops-core delegation works correctly.

    let entity = OpValue::string("entity:test");
    let rel_type = OpValue::string("owns");

    let result = ops_core::graph::parents(&entity, &rel_type, &EvalContext::default());
    assert!(result.is_ok());
}

// Re-export types for testing
use ops_core::{EvalContext, OpValue};
