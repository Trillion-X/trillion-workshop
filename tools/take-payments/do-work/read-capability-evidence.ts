import {
  buildEvidenceProjection,
  buildExecutionReceipt,
  readRedactionPolicies,
  type ReceiptInput,
} from '../read-data/capability-records';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function readCapabilityEvidenceTarget(input: unknown) {
  const row = record(input) as ReceiptInput;
  const policy = readRedactionPolicies().find((entry) => entry.id === text(row.invocation?.redaction_policy_ref));
  if (!policy) return { error: 'redaction policy is required' };
  const receipt = buildExecutionReceipt(row, policy);
  return {
    receipt,
    projection: buildEvidenceProjection(receipt, policy),
  };
}
