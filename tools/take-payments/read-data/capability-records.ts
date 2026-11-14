import packageData from '@/packages/stripe-payment-provider/things-to-store-and-run.json';

type JsonObject = Record<string, unknown>;

export type RunnerKind = 'process' | 'http' | 'workflow';
export type ReceiptState = 'succeeded' | 'failed' | 'pending';

/**
 * Process-runner mount (Option A — the descriptor owns its own mount as DATA).
 * The worker executable is shipped as a `stored_bytes` record; the generic
 * capability-run flow reads `stored_bytes_address` -> content_hash and mounts it
 * by `blob_ref` at `mount_path`. `compute.process` stays blind — it never learns
 * what a capability descriptor is; it only mounts opaque blobs by hash.
 */
export interface ProcessRunnerMount {
  /** Address of the `stored_bytes` record holding the worker bytes (read -> content_hash). */
  readonly stored_bytes_address: string;
  /** Relative path the worker is mounted at inside the process job dir (argv[1]). */
  readonly mount_path: string;
  /** Interpreter binary for argv[0]; defaults to `node`. */
  readonly interpreter?: string;
}

export interface CapabilityRunnerDescriptor {
  readonly kind: RunnerKind;
  readonly runner_id: string;
  readonly target: string;
  readonly timeout_ms?: number;
  readonly command?: readonly string[];
  readonly request?: JsonObject;
  /** Present for process-kind runners: how to mount the worker into compute.process. */
  readonly mount?: ProcessRunnerMount;
}

export interface CapabilityDescriptor {
  readonly kind: 'capability-descriptor-record';
  readonly id: string;
  readonly label: string;
  readonly operation_id: string;
  readonly provider_ref?: string;
  readonly api_version_policy?: string;
  readonly required_credential_ref?: string;
  readonly runner: CapabilityRunnerDescriptor;
  readonly input_schema: JsonObject;
  readonly idempotency_policy: JsonObject;
  readonly redaction_policy_ref: string;
  readonly evidence_projection_ref: string;
  readonly metadata: JsonObject;
}

export interface RedactionPolicy {
  readonly kind: 'redaction-policy-record';
  readonly id: string;
  readonly redacted_keys: readonly string[];
  readonly redacted_patterns: readonly string[];
  readonly public_output_keys: readonly string[];
}

export interface CapabilityInvocation {
  readonly kind: 'capability-invocation-record';
  readonly id: string;
  readonly descriptor_id: string;
  readonly operation_id: string;
  readonly runner_kind: RunnerKind;
  readonly correlation_id: string;
  readonly idempotency_key: string;
  readonly credential_handle_ref: string;
  readonly input_facts: JsonObject;
  readonly subject: JsonObject;
  readonly requested_at: string;
  readonly redaction_policy_ref: string;
  readonly evidence_projection_ref: string;
  readonly metadata: JsonObject;
}

export interface RunnerRequest {
  readonly kind: 'capability-runner-request-record';
  readonly id: string;
  readonly invocation_id: string;
  readonly descriptor_id: string;
  readonly runner_kind: RunnerKind;
  readonly runner_id: string;
  readonly target: string;
  readonly timeout_ms?: number;
  readonly correlation_id: string;
  readonly credential_handle_ref: string;
  readonly redaction_policy_ref: string;
  readonly payload: JsonObject;
  readonly command?: readonly string[];
  /** Propagated from descriptor.runner.mount for process-kind runners (Option A). */
  readonly mount?: ProcessRunnerMount;
}

export interface ProviderObjectRef {
  readonly ref: string;
  readonly object_type: string;
  readonly provenance_receipt_id: string;
}

export interface ExecutionReceipt {
  readonly kind: 'execution-receipt-record';
  readonly id: string;
  readonly invocation_id: string;
  readonly descriptor_id: string;
  readonly operation_id: string;
  readonly runner_session_ref: string;
  readonly credential_handle_ref: string;
  readonly redaction_policy_ref: string;
  readonly state: ReceiptState;
  readonly retry_class: string;
  readonly cause_category?: string;
  readonly provider_object_refs: readonly ProviderObjectRef[];
  readonly observed_at: string;
  readonly redacted_output: JsonObject;
}

export interface EvidenceProjection {
  readonly kind: 'evidence-projection-record';
  readonly id: string;
  readonly invocation_id: string;
  readonly receipt_id: string;
  readonly descriptor_id: string;
  readonly runner_session_ref: string;
  readonly credential_handle_ref: string;
  readonly provider_object_refs: readonly ProviderObjectRef[];
  readonly redaction_policy_id: string;
  readonly observed_at: string;
  readonly rows: readonly EvidenceProjectionRow[];
}

export interface EvidenceProjectionRow {
  readonly label: string;
  readonly value: string;
  readonly public: boolean;
}

export interface BindCapabilityInvocationInput {
  readonly descriptor?: CapabilityDescriptor | JsonObject;
  readonly descriptor_id?: string;
  readonly input_facts?: JsonObject;
  readonly subject?: JsonObject;
  readonly idempotency_key?: string;
  readonly requested_at?: string;
  readonly credential_handle_ref?: string;
  readonly correlation_id?: string;
  readonly metadata?: JsonObject;
}

export interface ReceiptInput {
  readonly invocation: CapabilityInvocation;
  readonly descriptor?: CapabilityDescriptor | JsonObject;
  readonly runner_session_ref: string;
  readonly state: ReceiptState;
  readonly observed_at: string;
  readonly output?: JsonObject;
  readonly cause_category?: string;
}

export const STRIPE_DOCS_CURRENT_API_VERSION = '2026-05-27.dahlia';

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function packageThings(): readonly { payload?: unknown }[] {
  return Array.isArray(packageData.things) ? packageData.things as { payload?: unknown }[] : [];
}

function stringList(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function readRunner(value: unknown): CapabilityRunnerDescriptor | null {
  const row = record(value);
  const kind = text(row.kind) as RunnerKind;
  const runner_id = text(row.runner_id ?? row.runnerId);
  const target = text(row.target);
  if (!['process', 'http', 'workflow'].includes(kind) || !runner_id || !target) return null;
  return {
    kind,
    runner_id,
    target,
    timeout_ms: numberValue(row.timeout_ms ?? row.timeoutMs),
    command: stringList(row.command),
    request: record(row.request),
    mount: readProcessRunnerMount(row.mount),
  };
}

/** Parse a process-runner mount from DATA; null unless both required fields are present. */
function readProcessRunnerMount(value: unknown): ProcessRunnerMount | undefined {
  const row = record(value);
  const stored_bytes_address = text(row.stored_bytes_address ?? row.storedBytesAddress);
  const mount_path = text(row.mount_path ?? row.mountPath);
  if (!stored_bytes_address || !mount_path) return undefined;
  const interpreter = text(row.interpreter);
  return { stored_bytes_address, mount_path, ...(interpreter ? { interpreter } : {}) };
}

export function readCapabilityDescriptor(value: unknown): CapabilityDescriptor | null {
  const row = record(value);
  if (text(row.kind) !== 'capability-descriptor-record') return null;
  const id = text(row.id);
  const label = text(row.label);
  const operation_id = text(row.operation_id ?? row.operationId);
  const runner = readRunner(row.runner);
  const redaction_policy_ref = text(row.redaction_policy_ref ?? row.redactionPolicyRef);
  const evidence_projection_ref = text(row.evidence_projection_ref ?? row.evidenceProjectionRef);
  if (!id || !label || !operation_id || !runner || !redaction_policy_ref || !evidence_projection_ref) return null;
  return {
    kind: 'capability-descriptor-record',
    id,
    label,
    operation_id,
    provider_ref: text(row.provider_ref ?? row.providerRef) || undefined,
    api_version_policy: text(row.api_version_policy ?? row.apiVersionPolicy) || undefined,
    required_credential_ref: text(row.required_credential_ref ?? row.requiredCredentialRef) || undefined,
    runner,
    input_schema: record(row.input_schema ?? row.inputSchema),
    idempotency_policy: record(row.idempotency_policy ?? row.idempotencyPolicy),
    redaction_policy_ref,
    evidence_projection_ref,
    metadata: record(row.metadata),
  };
}

export function readCapabilityDescriptors(rawThings: readonly { payload?: unknown }[] = packageThings()): CapabilityDescriptor[] {
  return rawThings
    .map((thing) => readCapabilityDescriptor(thing.payload))
    .filter((descriptor): descriptor is CapabilityDescriptor => descriptor !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function readRedactionPolicy(value: unknown): RedactionPolicy | null {
  const row = record(value);
  if (text(row.kind) !== 'redaction-policy-record') return null;
  const id = text(row.id);
  if (!id) return null;
  return {
    kind: 'redaction-policy-record',
    id,
    redacted_keys: stringList(row.redacted_keys ?? row.redactedKeys),
    redacted_patterns: stringList(row.redacted_patterns ?? row.redactedPatterns),
    public_output_keys: stringList(row.public_output_keys ?? row.publicOutputKeys),
  };
}

export function readRedactionPolicies(rawThings: readonly { payload?: unknown }[] = packageThings()): RedactionPolicy[] {
  return rawThings
    .map((thing) => readRedactionPolicy(thing.payload))
    .filter((policy): policy is RedactionPolicy => policy !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function descriptorFromInput(input: BindCapabilityInvocationInput): CapabilityDescriptor | null {
  const direct = readCapabilityDescriptor(input.descriptor);
  if (direct) return direct;
  const descriptorId = text(input.descriptor_id);
  return readCapabilityDescriptors().find((descriptor) => descriptor.id === descriptorId) ?? null;
}

function missingInputKeys(descriptor: CapabilityDescriptor, facts: JsonObject): string[] {
  const required = stringList(record(descriptor.input_schema).required);
  return required.filter((key) => facts[key] === undefined);
}

export function bindCapabilityInvocation(input: BindCapabilityInvocationInput): CapabilityInvocation | { error: string; details: string[] } {
  const descriptor = descriptorFromInput(input);
  if (!descriptor) return { error: 'capability descriptor is required', details: ['descriptor_id did not resolve'] };
  const input_facts = record(input.input_facts);
  const idempotency_key = text(input.idempotency_key);
  const requested_at = text(input.requested_at);
  const credential_handle_ref = text(input.credential_handle_ref);
  const details = [
    ...missingInputKeys(descriptor, input_facts).map((key) => `Missing required input fact: ${key}`),
    ...(!idempotency_key ? ['idempotency_key is required'] : []),
    ...(!requested_at ? ['requested_at is required'] : []),
    ...(!credential_handle_ref ? ['credential_handle_ref is required'] : []),
  ];
  if (details.length > 0) return { error: 'capability invocation input is incomplete', details };
  return {
    kind: 'capability-invocation-record',
    id: `capability-invocation:${idempotency_key}`,
    descriptor_id: descriptor.id,
    operation_id: descriptor.operation_id,
    runner_kind: descriptor.runner.kind,
    correlation_id: text(input.correlation_id) || `correlation:${idempotency_key}`,
    idempotency_key,
    credential_handle_ref,
    input_facts,
    subject: record(input.subject),
    requested_at,
    redaction_policy_ref: descriptor.redaction_policy_ref,
    evidence_projection_ref: descriptor.evidence_projection_ref,
    metadata: { ...descriptor.metadata, ...record(input.metadata) },
  };
}

export function buildRunnerRequest(descriptor: CapabilityDescriptor, invocation: CapabilityInvocation): RunnerRequest {
  return {
    kind: 'capability-runner-request-record',
    id: `capability-runner-request:${invocation.idempotency_key}`,
    invocation_id: invocation.id,
    descriptor_id: descriptor.id,
    runner_kind: descriptor.runner.kind,
    runner_id: descriptor.runner.runner_id,
    target: descriptor.runner.target,
    timeout_ms: descriptor.runner.timeout_ms,
    correlation_id: invocation.correlation_id,
    credential_handle_ref: invocation.credential_handle_ref,
    redaction_policy_ref: invocation.redaction_policy_ref,
    payload: {
      descriptor_id: descriptor.id,
      operation_id: descriptor.operation_id,
      input_facts: invocation.input_facts,
      subject: invocation.subject,
      idempotency_key: invocation.idempotency_key,
      api_version_policy: descriptor.api_version_policy,
      request: descriptor.runner.request ?? {},
    },
    command: descriptor.runner.command,
    ...(descriptor.runner.mount ? { mount: descriptor.runner.mount } : {}),
  };
}

/**
 * ProcessDescriptor shape consumed by `compute.process` (architect
 * execution-types `ProcessDescriptor`). Built ENTIRELY from DATA + the read
 * worker content hash — `compute.process` stays blind to capabilities.
 */
export interface ProcessDescriptorRecord {
  readonly argv: readonly string[];
  readonly cwd: string | null;
  readonly timeout_ms: number;
  readonly termination_grace_ms: number;
  readonly expected_termination: null;
  readonly env: Readonly<Record<string, string>>;
  readonly inputs: ReadonlyArray<{
    readonly mount_path: string;
    readonly source: { readonly kind: 'blob_ref'; readonly hash: string };
    readonly executable?: boolean;
  }>;
  readonly input_trees: readonly [];
  readonly outputs: readonly [];
  readonly containment: {
    readonly kind: 'descendant_effect_contained';
    readonly pipe_eof_timeout_ms: number;
    readonly publications: readonly [];
  };
  readonly capture_fds: readonly [1, 2];
  readonly collected_files: readonly [];
}

/**
 * Generic adapter (the converged Option-A keystone, Claude+Codex 2026-06-28):
 * RunnerRequest + the worker's content hash -> a `compute.process` ProcessDescriptor.
 *
 * - argv = [interpreter, mount_path, "--input-json", <payload>] (worker reads --input-json, proven).
 * - inputs mounts the worker bytes by `blob_ref` (content hash from the flow's read step).
 * - Pulls interpreter/mount_path from descriptor DATA (via RunnerRequest.mount); no worker
 *   command or credential is hardcoded here. Process-kind runners only.
 *
 * Throws on a non-process runner, a missing mount, or an empty content hash — fail closed,
 * never silently produce a descriptor that can't run.
 */
export function buildProcessDescriptorFromRunnerRequest(
  runnerRequest: RunnerRequest,
  workerContentHash: string,
  defaultTimeoutMs = 30_000,
): ProcessDescriptorRecord {
  if (runnerRequest.runner_kind !== 'process') {
    throw new Error(`buildProcessDescriptorFromRunnerRequest: runner_kind must be "process", got "${runnerRequest.runner_kind}"`);
  }
  const mount = runnerRequest.mount;
  if (!mount || !mount.mount_path) {
    throw new Error('buildProcessDescriptorFromRunnerRequest: descriptor.runner.mount{mount_path} is required for process runners');
  }
  if (!workerContentHash) {
    throw new Error('buildProcessDescriptorFromRunnerRequest: workerContentHash (from the read step) is required');
  }
  const interpreter = mount.interpreter ?? 'node';
  return {
    argv: [interpreter, mount.mount_path, '--input-json', JSON.stringify(runnerRequest.payload)],
    cwd: null,
    timeout_ms: runnerRequest.timeout_ms ?? defaultTimeoutMs,
    termination_grace_ms: 1_000,
    expected_termination: null,
    env: {},
    inputs: [{ mount_path: mount.mount_path, source: { kind: 'blob_ref', hash: workerContentHash }, executable: false }],
    input_trees: [],
    outputs: [],
    containment: {
      kind: 'descendant_effect_contained',
      pipe_eof_timeout_ms: 1_000,
      publications: [],
    },
    capture_fds: [1, 2],
    collected_files: [],
  };
}

export function containsForbiddenGenericTerm(value: unknown, forbiddenTerms: readonly string[] = []): boolean {
  const haystack = JSON.stringify(value);
  return forbiddenTerms.some((term) => haystack.includes(term));
}

export function validateGenericDescriptorShape(descriptor: CapabilityDescriptor, forbiddenTerms: readonly string[] = []): string[] {
  const errors: string[] = [];
  if (containsForbiddenGenericTerm(descriptor.input_schema, forbiddenTerms)) errors.push(`${descriptor.id} generic input_schema contains package/domain vocabulary`);
  if (containsForbiddenGenericTerm(descriptor.idempotency_policy, forbiddenTerms)) errors.push(`${descriptor.id} idempotency_policy contains package/domain vocabulary`);
  if (descriptor.runner.kind !== 'process' && descriptor.runner.kind !== 'http' && descriptor.runner.kind !== 'workflow') errors.push(`${descriptor.id} runner kind is invalid`);
  return errors;
}

function shouldRedactKey(key: string, policy: RedactionPolicy): boolean {
  const lowered = key.toLowerCase();
  return policy.redacted_keys.some((redacted) => lowered.includes(redacted.toLowerCase()));
}

function redactString(value: string, policy: RedactionPolicy): string {
  const policyPatterns = policy.redacted_patterns.map((pattern) => new RegExp(pattern, 'g'));
  return policyPatterns.reduce(
    (current, pattern) => current.replace(pattern, '[redacted]'),
    value,
  );
}

export function redactProviderOutput(value: unknown, policy: RedactionPolicy): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactProviderOutput(entry, policy));
  if (value && typeof value === 'object') {
    const next: JsonObject = {};
    for (const [key, entry] of Object.entries(value as JsonObject)) {
      next[key] = shouldRedactKey(key, policy) ? '[redacted]' : redactProviderOutput(entry, policy);
    }
    return next;
  }
  return typeof value === 'string' ? redactString(value, policy) : value;
}

function readProviderRefs(output: JsonObject, receiptId: string): ProviderObjectRef[] {
  const rawRefs = list(output.provider_object_refs ?? output.providerObjectRefs);
  return rawRefs
    .map((entry) => {
      const row = record(entry);
      const ref = text(row.ref ?? row.id);
      const object_type = text(row.object_type ?? row.objectType ?? row.type);
      return ref && object_type ? { ref, object_type, provenance_receipt_id: receiptId } : null;
    })
    .filter((entry): entry is ProviderObjectRef => entry !== null);
}

export function buildExecutionReceipt(input: ReceiptInput, policy: RedactionPolicy): ExecutionReceipt {
  const descriptor = readCapabilityDescriptor(input.descriptor) ?? readCapabilityDescriptors().find((item) => item.id === input.invocation.descriptor_id);
  const receiptId = `execution-receipt:${input.invocation.idempotency_key}`;
  const redacted = record(redactProviderOutput(record(input.output), policy));
  return {
    kind: 'execution-receipt-record',
    id: receiptId,
    invocation_id: input.invocation.id,
    descriptor_id: input.invocation.descriptor_id,
    operation_id: descriptor?.operation_id ?? input.invocation.operation_id,
    runner_session_ref: input.runner_session_ref,
    credential_handle_ref: input.invocation.credential_handle_ref,
    redaction_policy_ref: input.invocation.redaction_policy_ref,
    state: input.state,
    retry_class: input.state === 'failed' ? 'retryable-after-review' : 'not-needed',
    cause_category: input.cause_category,
    provider_object_refs: readProviderRefs(redacted, receiptId),
    observed_at: input.observed_at,
    redacted_output: redacted,
  };
}

export function buildEvidenceProjection(receipt: ExecutionReceipt, policy: RedactionPolicy): EvidenceProjection {
  const rows = policy.public_output_keys
    .map((key) => {
      const value = receipt.redacted_output[key];
      return value === undefined ? null : { label: key.replaceAll('_', ' '), value: String(value), public: true };
    })
    .filter((row): row is EvidenceProjectionRow => row !== null);
  return {
    kind: 'evidence-projection-record',
    id: `evidence-projection:${receipt.invocation_id}`,
    invocation_id: receipt.invocation_id,
    receipt_id: receipt.id,
    descriptor_id: receipt.descriptor_id,
    runner_session_ref: receipt.runner_session_ref,
    credential_handle_ref: receipt.credential_handle_ref,
    provider_object_refs: receipt.provider_object_refs,
    redaction_policy_id: policy.id,
    observed_at: receipt.observed_at,
    rows,
  };
}
