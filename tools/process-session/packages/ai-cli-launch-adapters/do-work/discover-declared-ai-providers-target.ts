import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type Sender = (request: { target: string; payload: unknown }) => Promise<unknown>;

type DiscoveryDescriptor = {
  kind: 'ai-provider-discovery-descriptor';
  id: string;
  participant_ref: string;
  owner_target_ref: string;
  request: Record<string, unknown>;
  connection_state_ref: string;
  result_projection_ref: string;
  capability_refs: string[];
};

const decoder = new TextDecoder();
const BROKER_TARGET = 'ai-cli-launch-adapters.discover-declared-ai-providers';

function object(value: unknown): Record<string, any> {
  if (ArrayBuffer.isView(value)) {
    return object(JSON.parse(decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider discovery returned invalid data');
  const row = value as Record<string, any>;
  if (ArrayBuffer.isView(row.payload)) return object(row.payload);
  return row;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || !value) throw new Error(`${label} must be non-empty text`);
  return value;
}

function refs(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`${label} must be a list of references`);
  }
  return [...new Set(value)];
}

function descriptor(raw: unknown): DiscoveryDescriptor {
  const wrapper = object(raw);
  const value = object(wrapper.payload ?? wrapper);
  if (value.kind !== 'ai-provider-discovery-descriptor') throw new Error('Unexpected provider discovery record kind');
  const ownerTargetRef = nonempty(value.owner_target_ref, 'owner_target_ref');
  if (ownerTargetRef === BROKER_TARGET) throw new Error('Provider discovery descriptor cannot dispatch the broker to itself');
  return {
    kind: value.kind,
    id: nonempty(value.id, 'id'),
    participant_ref: nonempty(value.participant_ref, 'participant_ref'),
    owner_target_ref: ownerTargetRef,
    request: object(value.request ?? {}),
    connection_state_ref: nonempty(value.connection_state_ref, 'connection_state_ref'),
    result_projection_ref: nonempty(value.result_projection_ref, 'result_projection_ref'),
    capability_refs: refs(value.capability_refs, 'capability_refs'),
  };
}

/** Enumerates open provider DATA and dispatches each declared owner. The broker
 * does not probe, rank, write provider state, or interpret provider replies. */
export async function discoverDeclaredAiProvidersTarget(
  input: unknown,
  _context: unknown,
  sender: Sender = sendRequestToBitfieldTarget,
) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 0) {
    throw new Error('Provider discovery accepts no caller-supplied descriptors');
  }
  const found = object(await sender({
    target: 'slot::find-current-items',
    payload: {
      operation: 'find-current-items',
      in: 'published-record',
      where: { all: [{ field: 'kind', eq: 'ai-provider-discovery-descriptor' }] },
      limit: 256,
    },
  }));
  const rows = Array.isArray(found.items) ? found.items : [];
  const descriptors = rows.map(descriptor).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(descriptors.map((item) => item.id)).size !== descriptors.length) {
    throw new Error('Provider discovery descriptor ids must be unique');
  }
  const results = await Promise.all(descriptors.map(async (item) => {
    try {
      await sender({ target: item.owner_target_ref, payload: item.request });
      return { descriptor_ref: item.id, participant_ref: item.participant_ref, status: 'dispatched' as const,
        connection_state_ref: item.connection_state_ref, result_projection_ref: item.result_projection_ref };
    } catch (error) {
      return { descriptor_ref: item.id, participant_ref: item.participant_ref, status: 'failed' as const,
        connection_state_ref: item.connection_state_ref, result_projection_ref: item.result_projection_ref,
        error: error instanceof Error ? error.message : 'Provider discovery failed' };
    }
  }));
  return { kind: 'ai-provider-discovery-run', descriptor_count: descriptors.length, results };
}

