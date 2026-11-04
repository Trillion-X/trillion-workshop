// PORTED FROM: bitfield-packages/packages/chat/do-work/discover-capabilities.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import { requestToolRun } from '../../ai-tool-catalog/do-work/request-tool-run';
import { readCapabilityDiscoveryBinding } from '../read-data/read-ai-tool-binding';

/** The same DATA contract that Palette consumes; Chat owns no catalog. */
export interface CapabilityDiscoveryBinding {
  target: string;
  definition_id: string;
  fixed_input: Record<string, unknown>;
  model_input_schema: Record<string, unknown>;
  query_binding: { model_field: string; action_field: string };
  authority_binding_ref: string;
}

export interface DiscoveredCapability {
  canonical_address: string;
  canonical_revision: string;
  payload_hash: string;
  owner_target: string;
  schema_ref: string;
  schema_digest: string;
  authority_provenance_ref: string;
  rank_provenance_ref: string;
  descriptor_revision: string;
  model_provenance_ref: string;
  rank_score: number;
  surface_ref?: string;
  input_schema?: unknown;
  title?: string;
  description?: string;
}

const CAPABILITY_DISCOVERY_BINDING_QUERY = {
  operation: 'find-current-items',
  in: 'published-record',
  where: { all: [{ field: 'kind', eq: 'ai-tool-binding' }, { field: 'id', eq: 'capability-discovery' }] },
  include: ['address', 'payload'],
  limit: 2,
};

const decoder = new TextDecoder();
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
function decode(reply: unknown): unknown {
  if (!isRecord(reply) || !(reply.payload instanceof Uint8Array)) return reply;
  return JSON.parse(decoder.decode(reply.payload));
}
function outputItems(reply: unknown): unknown[] {
  const decoded = decode(reply);
  if (!isRecord(decoded)) return [];
  const output = isRecord(decoded.output) ? decoded.output : decoded;
  const result = isRecord(output.result) ? output.result : output;
  return Array.isArray(result.items) ? result.items : [];
}
function canonical(item: unknown): DiscoveredCapability | null {
  if (!isRecord(item)) return null;
  const required = ['canonical_address', 'canonical_revision', 'payload_hash', 'owner_target', 'schema_ref', 'schema_digest', 'authority_provenance_ref', 'rank_provenance_ref', 'descriptor_revision', 'model_provenance_ref'];
  if (required.some((key) => !text(item[key])) || typeof item.rank_score !== 'number' || !Number.isFinite(item.rank_score)) return null;
  return item as unknown as DiscoveredCapability;
}

/** Dispatches the Meaning Search owner action and preserves its bounded rank order. */
export async function discoverCapabilities(
  binding: CapabilityDiscoveryBinding,
  query: string,
  signal?: AbortSignal,
): Promise<DiscoveredCapability[]> {
  if (binding.query_binding.model_field !== 'query') throw new Error('discovery binding must expose query');
  const ranked = await requestToolRun({ query }, { target: binding.target, toolRef: binding.definition_id, fixedInput: binding.fixed_input, modelInputSchema: binding.model_input_schema, inputFieldMap: { [binding.query_binding.model_field]: binding.query_binding.action_field } }, signal);
  const rows = outputItems(ranked);
  const items = rows.map(canonical);
  if (items.some((item) => item === null)) {
    throw new Error('Meaning Search returned an invalid capability result.');
  }
  return items as DiscoveredCapability[];
}

/** Reads the one shared owner binding immediately before executing its bounded query. */
export async function discoverCapabilitiesForChat(query: string, signal?: AbortSignal): Promise<DiscoveredCapability[]> {
  return (await discoverCapabilitiesForChatWithBinding(query, signal)).capabilities;
}
/** Keeps policy provenance separate from the authenticated caller identity. */
export async function discoverCapabilitiesForChatWithBinding(query: string, signal?: AbortSignal): Promise<{ capabilities: DiscoveredCapability[]; authorityBindingRef: string }> {
  const bindingReply = await sendRequestToBitfieldTarget({
    target: 'slot::find-current-items',
    payload: CAPABILITY_DISCOVERY_BINDING_QUERY,
  }, signal);
  const binding = readCapabilityDiscoveryBinding(bindingReply);
  if (!binding) throw new Error('Capability discovery binding is unavailable.');
  return { capabilities: await discoverCapabilities(binding, query, signal), authorityBindingRef: binding.authority_binding_ref };
}
