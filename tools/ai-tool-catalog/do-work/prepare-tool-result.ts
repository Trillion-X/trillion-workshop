// PORTED FROM: bitfield-packages/packages/ai-tool-catalog/do-work/prepare-tool-result.ts @ e99ac5976
// packages/ai-tool-catalog/do-work/prepare-tool-result.ts
//
// The BOUNDED TOOL RESULT primitive: it turns whatever a published tool returned
// into the one bounded, policy-governed summary a caller may show a model or a
// human. Owned by the TOOL catalog because the same package that admits an
// invocation against the owner's input schema (request-tool-run.ts) is the only
// thing that can say what counts as that tool's declared OUTPUT. Split out of the
// retired ai-work-control/do-work/bind-agent-turn-ports.ts, whose remaining half
// only wires the agent-turn ports and has no consumer.
//
// Physics, not Society: the value is read through the owner's declared
// result_selector, never by scanning arbitrary fields, so a tool cannot leak a
// field it did not declare. Byte bounds and the addressed-result reference come in
// as DATA policy; an over-long output is truncated on a UTF-8-safe boundary and
// points at the addressed full result rather than being silently dropped. Every
// refusal returns structured owner-contract evidence, never an empty string.
//
// Pure leaf, zero I/O — safe for any Envelope-decoupled caller (chat's tool round,
// visual-database's owner probes, the hosted-app accessibility proof).

import { selectDeclaredValue } from '../../ui/read-data/declared-selector';

/** Shared result precedence: direct Workflow reply, addressed result, then status. */
export const selectDeclaredToolOutput = selectDeclaredValue;
export type ToolResultPolicy = { maxBytes: number; maxAddressBytes: number };
export type PreparedToolResult = { summary: string; source: 'reply' | 'address' | 'status' };
export function prepareToolResult(input: { workflowReply?: unknown | null; addressedResult?: Record<string, unknown> | null; addressedResultRef?: string | null; resultSelector?: string; policy?: ToolResultPolicy; accepted: boolean; error?: string | null }): PreparedToolResult {
  const evidence = (reason: string) => JSON.stringify({ owner_contract_error: reason });
  if (!input.policy) return { summary: JSON.stringify({ policy_contract_error: 'missing or invalid addressed result policy' }), source: 'status' };
  if (!input.resultSelector) return { summary: evidence('missing typed result_selector'), source: 'status' };
  const direct = selectDeclaredToolOutput(input.workflowReply, input.resultSelector);
  const selectorError = (value: unknown): string | null =>
    value && typeof value === 'object' && 'selector_contract_error' in value
      ? String((value as { selector_contract_error: unknown }).selector_contract_error)
      : null;
  if (selectorError(direct) === 'invalid result selector') return { summary: JSON.stringify(direct), source: 'status' };
  const render = (value: unknown): string | null =>
    typeof value === 'string' ? value.trim() : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
  const bound = (value: string): string => {
    if (new TextEncoder().encode(value).byteLength <= input.policy.maxBytes) return value;
    const addressBytes = input.addressedResultRef ? new TextEncoder().encode(input.addressedResultRef).byteLength : Infinity;
    if (!input.addressedResult || !input.addressedResultRef || addressBytes > input.policy.maxAddressBytes) {
      return JSON.stringify({ policy_contract_error: 'bounded output has no validated addressed result reference' });
    }
    // Find the largest UTF-8-safe prefix logarithmically. A one-character
    // decrement re-encodes O(n²) bytes for large addressed results, turning a
    // bounded 20 MiB continuation into a CPU denial-of-service.
    const encoder = new TextEncoder();
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encoder.encode(value.slice(0, middle)).byteLength <= input.policy.maxBytes) low = middle;
      else high = middle - 1;
    }
    return `${value.slice(0, low)}\n…[full output: ${input.addressedResultRef}]`;
  };
  const directScalar = selectorError(direct) ? null : render(direct);
  if (directScalar) return { summary: bound(directScalar), source: 'reply' };
  const addressed = selectDeclaredToolOutput(input.addressedResult, input.resultSelector);
  if (selectorError(addressed) === 'invalid result selector') return { summary: JSON.stringify(addressed), source: 'status' };
  const addressedScalar = selectorError(addressed) ? null : render(addressed);
  return addressedScalar
    ? { summary: bound(addressedScalar), source: 'address' }
    : { summary: evidence(input.error ?? (input.accepted ? 'owner result selector produced no scalar output' : 'tool was not admitted')), source: 'status' };
}
export function summarizeToolResult(input: Parameters<typeof prepareToolResult>[0]): string {
  return prepareToolResult(input).summary;
}
