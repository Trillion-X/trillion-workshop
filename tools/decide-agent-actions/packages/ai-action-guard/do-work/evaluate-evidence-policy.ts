export const EVIDENCE_POLICY_REQUEST_SCHEMA = 'ai-action-guard-evidence-policy-request/v1';
export const EVIDENCE_POLICY_RECEIPT_SCHEMA = 'ai-action-guard-evidence-policy-receipt/v1';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !(segment in current)) throw new TypeError(`policy source path is missing: ${path}`);
    current = current[segment];
  }
  return current;
}

/**
 * Evaluate caller evidence against a current, owner-read descriptor. The workflow
 * supplies the descriptor returned by its immediately preceding read step and
 * selects this target from descriptor.policy.evaluator_target. Denials throw so
 * the workflow cannot continue into its content effect.
 */
export function evaluateEvidencePolicy(input: unknown) {
  if (!isRecord(input)) throw new TypeError('evidence policy request must be an object');
  if (input.schema !== EVIDENCE_POLICY_REQUEST_SCHEMA) {
    throw new TypeError(`schema must equal ${EVIDENCE_POLICY_REQUEST_SCHEMA}`);
  }
  const requestRef = requiredText(input.request_ref, 'request_ref');
  const actionRef = requiredText(input.action_ref, 'action_ref');
  const subjectRef = requiredText(input.subject_ref, 'subject_ref');
  if (!isRecord(input.descriptor)) throw new TypeError('descriptor must be an owner-read object');
  if (!isRecord(input.descriptor.policy)) throw new TypeError('descriptor.policy must be an object');
  const policy = input.descriptor.policy;
  if (policy.schema !== 'ai-action-guard-evidence-policy/v1') throw new TypeError('descriptor policy schema is unsupported');
  if (requiredText(policy.action_ref, 'descriptor.policy.action_ref') !== actionRef) {
    throw new Error('descriptor policy action does not match the requested action');
  }
  if (requiredText(policy.evaluator_target, 'descriptor.policy.evaluator_target') !== 'target:ai-action-guard.evaluate-evidence-policy') {
    throw new Error('descriptor selected a different evidence policy evaluator');
  }
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) throw new TypeError('descriptor.policy.rules must be non-empty');
  if (!isRecord(input.evidence)) throw new TypeError('evidence must be an object');

  const checks = policy.rules.map((rawRule, index) => {
    if (!isRecord(rawRule)) throw new TypeError(`descriptor.policy.rules[${index}] must be an object`);
    if (rawRule.kind !== 'minimum-number') throw new TypeError(`unsupported evidence policy rule: ${String(rawRule.kind)}`);
    const evidenceKey = requiredText(rawRule.evidence_key, `rules[${index}].evidence_key`);
    const sourcePath = requiredText(rawRule.source_path, `rules[${index}].source_path`);
    const threshold = readPath(input.descriptor, sourcePath);
    const observed = input.evidence[evidenceKey];
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) throw new TypeError(`policy threshold is invalid: ${sourcePath}`);
    if (typeof observed !== 'number' || !Number.isFinite(observed)) throw new TypeError(`evidence is invalid: ${evidenceKey}`);
    const allowed = observed >= threshold;
    return { kind: rawRule.kind, evidence_key: evidenceKey, source_path: sourcePath, observed, threshold, allowed };
  });
  if (checks.some(check => !check.allowed)) throw new Error('evidence policy denied the content effect');
  return {
    schema: EVIDENCE_POLICY_RECEIPT_SCHEMA,
    kind: 'ai-action-guard-evidence-policy-receipt',
    request_ref: requestRef,
    action_ref: actionRef,
    subject_ref: subjectRef,
    allowed: true,
    checks,
  };
}
