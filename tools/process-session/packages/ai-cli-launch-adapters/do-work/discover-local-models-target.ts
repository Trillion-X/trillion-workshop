import { readTrustedRuntimeClockMs, readTrustedRuntimePartition, sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';
import { deriveLocalModelInventory, installedModelCandidates } from './local-model-inventory';

type Sender = (request: { target: string; payload: unknown }) => Promise<unknown>;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const inventoryAddress = 'package::ai-cli-launch-adapters::local-model-inventory::ollama';
function row(value: unknown): Record<string, any> {
  if (ArrayBuffer.isView(value)) return row(JSON.parse(decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid metadata response');
  return value as Record<string, any>;
}

async function metadata(sender: Sender, definitionId: string, input = {}) {
  const reply = row(await sender({ target: 'slot::workflow', payload: {
    operation: 'execute_definition', definition_id: definitionId,
    input, include_output: true, include_steps: false,
  } }));
  const execution = row(reply.payload ?? reply);
  if (execution.status !== 'completed') throw new Error('Local metadata request did not complete');
  const http = row(execution.output);
  if (http.status_code !== 200 || !Array.isArray(http.body) || http.body.length > 2_097_152
    || http.body.some((v: unknown) => !Number.isInteger(v) || Number(v) < 0 || Number(v) > 255)) {
    throw new Error('Local metadata response unavailable');
  }
  return JSON.parse(decoder.decode(Uint8Array.from(http.body)));
}

/** Refreshes installation/capability facts only. Never sends a model prompt. */
export async function discoverLocalModelsTarget(
  input: unknown, context: unknown, sender: Sender = sendRequestToBitfieldTarget,
) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
    throw new Error('Discovery accepts no caller-supplied metadata or phases');
  }
  const now = readTrustedRuntimeClockMs(context);
  const partition = readTrustedRuntimePartition(context);
  const readReply = row(await sender({ target: 'engine.operation.label-addressed', payload: {
    operation_label: 'engine.operation.read-current', partition_label: partition,
    address_label: inventoryAddress, address_mode: 'label_hash',
  } }));
  const basis = 'found' in readReply ? readReply : row(readReply.payload);
  let expectedHash: string | null = null;
  let previousModels: { id: string; descriptor_ref?: string }[] = [];
  if (basis.found !== false) {
    if (basis.found !== true || typeof basis.content_hash !== 'string'
      || !/^1f:[a-f0-9]{64}$/.test(basis.content_hash)
      || basis.payload?.kind !== 'local-model-inventory'
      || !Number.isSafeInteger(basis.payload.observed_at_ms)
      || basis.payload.observed_at_ms > now) throw new Error('Local inventory basis is invalid or newer');
    previousModels = Array.isArray(basis.payload.models)
      ? basis.payload.models.filter((model: unknown): model is { id: string; descriptor_ref?: string } => (
        !!model && typeof model === 'object' && typeof (model as any).id === 'string'
      ))
      : [];
    expectedHash = btoa(Array.from(makeMultihashEncodedBytesFromCodeHex(basis.content_hash),
      byte => String.fromCharCode(byte)).join(''));
  }
  let inventory = deriveLocalModelInventory({ tags: null, details: [], observedAtMs: now });
  try {
    const tags = await metadata(sender, 'action:read-local-ollama-tags');
    const candidates = installedModelCandidates(tags);
    const details: { id: string; body: unknown }[] = [];
    for (let offset = 0; offset < candidates.length; offset += 4) {
      details.push(...await Promise.all(candidates.slice(offset, offset + 4).map(async ({ id }) => ({
        id, body: await metadata(sender, 'action:read-local-ollama-model-details', {
          body: Array.from(encoder.encode(JSON.stringify({ model: id }))),
        }),
      }))));
    }
    const current = installedModelCandidates(await metadata(sender, 'action:read-local-ollama-tags'));
    const identity = (items: typeof candidates) => JSON.stringify([...items].sort((a, b) => a.id.localeCompare(b.id)));
    if (identity(current) !== identity(candidates)) throw new Error('Local inventory changed during discovery');
    inventory = deriveLocalModelInventory({ tags, details, observedAtMs: now });
  } catch {
    // Publish unavailability, never preserve a previously usable seed on failure.
  }
  const fact = (property: string, value: unknown) => ({
    address_label: `attribute_fact|cli:ollama|prop:cli_registry:${property}|type:json`,
    address_mode: 'identity_text', path_labels: [`prop:cli_registry:${property}`],
    payload: { table: 'attribute_fact', subject_id: 'cli:ollama',
      property_id: `prop:cli_registry:${property}`, type_id: 'type:json', value_json: JSON.stringify(value) },
  });
  const providerFact = (property: string, value: unknown) => ({
    address_label: `attribute_fact|ai_provider:ollama|prop:provider:${property}|type:json`,
    address_mode: 'identity_text', path_labels: ['current-item', 'published-record'],
    payload: { table: 'attribute_fact', subject_id: 'ai_provider:ollama',
      property_id: `prop:provider:${property}`, type_id: 'type:json', value_json: JSON.stringify(value) },
  });
  const writes = [
    { address_label: inventoryAddress, address_mode: 'label_hash',
      expected_current: { payload_hash_base64: expectedHash },
      path_labels: ['current-item', 'published-record'], payload: inventory },
    fact('models', inventory.models.map(model => ({ id: model.id, label: model.id }))),
    providerFact('vendor', 'ollama'),
    providerFact('availability', inventory.status === 'current' && inventory.models.length > 0 ? 'available' : 'unavailable'),
    providerFact('authority', 'not-required'),
    providerFact('capability_refs', inventory.models.length > 0 ? ['capability:text-generation'] : []),
    providerFact('marginal_cost', 0),
    ...inventory.models.map(model => ({
      address_label: `package::ai-cli-launch-adapters::model::ollama::${encodeURIComponent(model.id)}`,
      address_mode: 'identity_text', path_labels: ['current-item', 'published-record'],
      payload: { kind: 'ai-model-descriptor', id: `ai-model-descriptor:ollama:${model.id}`,
        model_id: model.id, provider_ref: 'ai_provider:ollama', status: 'available',
        display_name: model.id, capabilities: ['text'], local_digest: model.digest },
    })),
    ...previousModels.filter(model => !inventory.models.some(current => current.id === model.id)).map(model => ({
      address_label: `package::ai-cli-launch-adapters::model::ollama::${encodeURIComponent(model.id)}`,
      address_mode: 'identity_text', path_labels: ['current-item', 'published-record'],
      payload: { kind: 'ai-model-descriptor', id: model.descriptor_ref ?? `ai-model-descriptor:ollama:${model.id}`,
        model_id: model.id, provider_ref: 'ai_provider:ollama', status: 'unavailable',
        display_name: model.id, capabilities: [] },
    })),
  ];
  const reply = row(await sender({ target: 'engine.operation.label-addressed', payload: {
    operation_label: 'engine.operation.write-batch', partition_label: partition, writes,
  } }));
  const written = row(reply.payload ?? reply);
  if (written.write_count !== writes.length) throw new Error('Local inventory could not be saved');
  return inventory;
}
