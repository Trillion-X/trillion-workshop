import { readTrustedRuntimePartition, sendRequestToBitfieldTarget, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { buildEngineReadCurrentRequestFromLabels, buildEngineWriteBatchRequestFromLabels, decodeEngineReadCurrentReply, makeHashCodeHexFromBytes, makeIdentityTextAddressFromLabel } from '@bitfield/runtime-kit/protocol';
import { applySourceCorrection, validateUnderstandingGraph } from '../read-data/understanding-graph';

type Correction = Parameters<typeof applySourceCorrection>[1];
export type CorrectionInput = { graph_id: string; expected_graph_hash: string; correction: Correction };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const canonical = (value: any): string => value && typeof value === 'object'
  ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  : JSON.stringify(value);
const digest = (value: unknown) => makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(value)));

/** Same graph owner, one CAS write. A retry never applies the correction twice. */
export async function correctUnderstandingGraph(input: CorrectionInput, context?: BitfieldRuntimeContext, sender = sendRequestToBitfieldTarget) {
  const partition = readTrustedRuntimePartition(context);
  if ((context as any)?.runtime?.caller?.local_command_list_admitted !== true) throw new Error('A verified local app session is required.');
  if (!input || Object.keys(input).sort().join(',') !== 'correction,expected_graph_hash,graph_id'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(input.graph_id)
    || !/^1f:[0-9a-f]{64}$/.test(input.expected_graph_hash)
    || !input.correction || typeof input.correction !== 'object'
    || Object.keys(input.correction).some(k => !['source_ref','prior_revision','next_revision','changed_claim_refs','permission_state'].includes(k))
    || input.correction.permission_state !== undefined) throw new Error('The correction request is invalid.');
  // Corrections do not grant, revoke, or otherwise change source permissions.
  const address = `package::content-media-evidence::understanding-graph::${input.graph_id}`;
  const requestHash = digest(input);
  async function read() {
    const reply: any = await sender(buildEngineReadCurrentRequestFromLabels(partition, address, {addressMode:'identity-text'}));
    const raw = reply?.payload ?? reply;
    const bytes = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
    if (!bytes) throw new Error('The current graph could not be read.');
    const row = decodeEngineReadCurrentReply(bytes);
    if (!row.found || !row.payloadHash) throw new Error('The current graph is missing.');
    const value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(row.payload));
    if (value.kind !== 'content-media-evidence.understanding-graph/v1' || !value.graph || validateUnderstandingGraph(value.graph).length) throw new Error('The current graph is invalid.');
    return {row,value,hash:makeHashCodeHexFromBytes(row.payload)};
  }
  const result = (row: Awaited<ReturnType<typeof read>>, replay: boolean) => ({graph_ref:address, graph_content_hash:row.hash, replay,
    affected_derivatives:row.value.last_source_correction.affected_derivatives});
  const matches = (row: Awaited<ReturnType<typeof read>>) => row.value.last_source_correction?.request_hash === requestHash
    && row.value.last_source_correction?.graph_hash === digest(row.value.graph);
  const current = await read();
  if (matches(current)) return result(current,true);
  if (current.hash !== input.expected_graph_hash) throw new Error('The graph changed before this correction.');
  const graph = applySourceCorrection(current.value.graph,input.correction);
  if (validateUnderstandingGraph(graph).length) throw new Error('The corrected graph is invalid.');
  const affected = graph.derivatives.filter((d,i) => d.state !== current.value.graph.derivatives[i].state).map(d => ({ref:d.id,state:d.state}));
  const value = {...current.value,graph,last_source_correction:{request_hash:requestHash,graph_hash:digest(graph),affected_derivatives:affected}};
  try {
    await sender(buildEngineWriteBatchRequestFromLabels([{partitionLabel:partition,addressMultihashHex:makeIdentityTextAddressFromLabel(address),
      pathLabels:['current-item','published-record'],payloadBytes:encode(value),expectedCurrent:{payloadHash:current.row.payloadHash}}]));
  } catch (error) {
    const saved = await read();
    if (matches(saved)) return result(saved,true);
    throw error;
  }
  const saved = await read();
  if (!matches(saved)) throw new Error('The graph changed while the correction was saved.');
  return result(saved,false);
}
