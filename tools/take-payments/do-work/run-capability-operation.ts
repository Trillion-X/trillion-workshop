import {
  buildProcessDescriptorFromRunnerRequest,
  buildRunnerRequest,
  readCapabilityDescriptor,
  readCapabilityDescriptors,
  type CapabilityDescriptor,
  type CapabilityInvocation,
} from '@/packages/stripe-payment-provider/read-data/capability-records';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** Shared resolution: descriptor (by record or by invocation.descriptor_id) + a valid invocation. */
function resolveDescriptorAndInvocation(
  input: unknown,
): { descriptor: CapabilityDescriptor; invocation: CapabilityInvocation } | { error: string } {
  const row = record(input);
  const invocation = record(row.invocation) as CapabilityInvocation;
  const descriptor =
    readCapabilityDescriptor(row.descriptor)
    ?? readCapabilityDescriptors().find((entry) => entry.id === text(invocation.descriptor_id));
  if (!descriptor) return { error: 'capability descriptor is required' };
  if (invocation.kind !== 'capability-invocation-record') return { error: 'capability invocation is required' };
  return { descriptor, invocation };
}

export function runCapabilityOperationTarget(input: unknown) {
  const resolved = resolveDescriptorAndInvocation(input);
  if ('error' in resolved) return resolved;
  return buildRunnerRequest(resolved.descriptor, resolved.invocation);
}

/**
 * Workflow target for process-runner capabilities (Option A): given the same
 * descriptor+invocation AND the worker's content hash (read by the flow from the
 * descriptor's `runner.mount.stored_bytes_address`), return a ready
 * `compute.process` ProcessDescriptor via the generic adapter. The workflow then
 * dispatches it with a static `ask name:"compute.process"`. compute.process stays
 * blind; everything is descriptor DATA + the read hash. Fail-closed (no throw across
 * the workflow boundary — returns {error}).
 */
export function buildCapabilityProcessDescriptorTarget(input: unknown) {
  const resolved = resolveDescriptorAndInvocation(input);
  if ('error' in resolved) return resolved;
  const worker_content_hash = text(record(input).worker_content_hash ?? record(input).workerContentHash);
  if (!worker_content_hash) return { error: 'worker_content_hash is required (read it from runner.mount.stored_bytes_address)' };
  const runnerRequest = buildRunnerRequest(resolved.descriptor, resolved.invocation);
  try {
    return buildProcessDescriptorFromRunnerRequest(runnerRequest, worker_content_hash);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
