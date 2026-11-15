// This integration test was removed during E.24/E.28 (GPH plan).
// It tested the old governance system (PermissionProvider, ConstraintProvider,
// AuditSink, GuardsFactory) which was purged from the workflow engine.
// Security enforcement is now a slot-side responsibility — the workflow engine
// is a blind DAG runner that sends Envelopes. The RECEIVING slot enforces
// permissions, constraints, and audit.
//
// When slot-side governance tests are needed, they belong in the governance
// slot's own test suite, not in the workflow engine.
