import { readTrustedRuntimePartition, sendRequestToBitfieldTarget, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { buildEngineReadCurrentRequestFromLabels, decodeEngineReadCurrentReply, makeHashCodeHexFromBytes } from '@bitfield/runtime-kit/protocol';

type Row = Record<string, any>;
const hashPattern = /^1f:[0-9a-f]{64}$/;
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a).sort(), right = Object.keys(b).sort();
  return left.length === right.length && left.every((key, i) => key === right[i]
    && same((a as Row)[key], (b as Row)[key]));
};

/** Reads execution evidence only. It never claims a destination has been saved. */
export async function inspectOwnerDelivery(input: {request_ref: string; dispatch_outcome_ref: string; expected_definition_id?: string},
  context?: BitfieldRuntimeContext, sender = sendRequestToBitfieldTarget) {
  const partition = readTrustedRuntimePartition(context);
  for (const ref of [input?.request_ref, input?.dispatch_outcome_ref]) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('The work reference is missing.');
  }
  async function read(address: string, mode: 'identity-text' | 'label-hash') {
    const reply = await sender(buildEngineReadCurrentRequestFromLabels(partition, address, {addressMode: mode}));
    const value = ArrayBuffer.isView(reply) || reply instanceof ArrayBuffer ? reply : (reply as {payload?: unknown})?.payload;
    const bytes = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
    if (!bytes) throw new Error('The work result could not be read.');
    const current = decodeEngineReadCurrentReply(bytes);
    if (!current.found) return null;
    const payload = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(current.payload));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The work result is invalid.');
    return {address, address_mode: mode, content_hash: makeHashCodeHexFromBytes(current.payload), payload};
  }
  const original = await read(input.request_ref, 'identity-text');
  if (!original || original.payload.kind !== 'content-generation.dispatch-request'
    || typeof original.payload.request_id !== 'string' || !original.payload.request_id
    || original.payload.id !== original.payload.request_id || original.payload.idempotency_key !== original.payload.request_id
    || input.request_ref !== `content-generation.dispatch-request::${original.payload.request_id}`
    || typeof original.payload.definition_id !== 'string' || !original.payload.input) {
    throw new Error('The original work request is missing or invalid.');
  }
  if (input.expected_definition_id !== undefined && original.payload.definition_id !== input.expected_definition_id) {
    throw new Error('The work was sent to a different destination.');
  }
  const dispatch = await read(input.dispatch_outcome_ref, 'label-hash');
  const open = {request_ref: input.request_ref, request_id: original.payload.request_id, outcome_complete: false};
  if (!dispatch) return {...open, status: 'pending'};
  const record = dispatch.payload;
  if (record.kind !== 'trigger-dispatch-outcome' || record.target !== 'slot::workflow'
    || record.status !== 'accepted' || record.attempt !== 1
    || record.rule_id !== 'trigger:content-generation:dispatch-durable-request'
    || record.attempt_ref !== original.content_hash
    || record.envelope?.content_hash !== original.content_hash
    || record.envelope?.address_text !== input.request_ref
    || input.dispatch_outcome_ref !== `trigger-engine.dispatch-outcome::${record.rule_id}::${record.attempt_ref}::${record.attempt}::${record.status}`
    || record.correlation !== original.payload.request_id
    || record.dispatch?.operation !== 'execute_definition'
    || record.dispatch?.definition_id !== original.payload.definition_id
    || !same(record.dispatch?.input, original.payload.input)) {
    throw new Error('The execution result belongs to different work.');
  }
  const hash = record.delivery_receipt?.request_hash;
  if (record.delivery_receipt?.kind !== 'send-later-request' || !hashPattern.test(hash ?? '')) throw new Error('The queued work has no valid execution reference.');
  const terminal = await read(`send-later::outcome::${hash}`, 'label-hash');
  if (!terminal) return {...open, status: 'pending'};
  if (terminal.payload.kind !== 'send-later-outcome' || terminal.payload.request_hash !== hash
    || terminal.payload.attempt !== 1 || !['succeeded', 'failed'].includes(terminal.payload.status)
    || (terminal.payload.error !== null && typeof terminal.payload.error !== 'string')
    || (terminal.payload.status === 'succeeded' && terminal.payload.error !== null)) {
    throw new Error('The execution result is invalid.');
  }
  const bases = [original, dispatch, terminal];
  for (const row of bases) {
    const current = await read(row.address, row.address_mode as 'identity-text' | 'label-hash');
    if (current?.content_hash !== row.content_hash) throw new Error('The work changed during the check. Try again.');
  }
  return {...open, status: terminal.payload.status === 'succeeded' ? 'executed' : 'interrupted',
    evidence_refs: bases.map(({payload: _payload, ...ref}) => ref),
    ...(terminal.payload.status === 'succeeded' ? {delivery: {definition_id: original.payload.definition_id, input: original.payload.input}} : {})};
}
