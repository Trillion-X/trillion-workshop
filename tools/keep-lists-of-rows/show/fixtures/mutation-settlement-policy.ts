export const MUTATION_SETTLEMENT_POLICY_DATA = Object.freeze({
  kind: 'mutation-settlement.policy-set',
  schema_version: 1,
  active_revision: 'test-policy-r1',
  descriptors: [{
    revision: 'test-policy-r1',
    timeout_ms: 500,
    poll_interval_ms: 1,
  }],
});
