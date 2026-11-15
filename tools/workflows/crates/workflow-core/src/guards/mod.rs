// crates/workflow-core/src/guards/mod.rs
//
// Purpose:
//   This module is intentionally empty.
//
//   Governance enforcement (permission checks, constraint validation,
//   audit logging) is the RECEIVING SLOT's responsibility — not the
//   workflow engine's. The engine evaluates DAG nodes and fires Envelopes.
//   The slot that receives each Envelope enforces its own security.
//
//   Previously held GuardsFactory/DataGuards that were carried by the engine
//   but NEVER actually invoked (dead code). Purged in E.28 — a generic DAG
//   evaluator has no business knowing about permissions, constraints, or audit.
