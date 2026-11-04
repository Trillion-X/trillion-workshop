// PORTED FROM: bitfield-packages/packages/chat/read-data/read-ai-tool-binding.ts @ e99ac5976
import type { CapabilityDiscoveryBinding } from '../do-work/discover-capabilities';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonEmptyText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const decoder = new TextDecoder();
const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array');

function decode(value: unknown): unknown {
  const payload = isRecord(value) && isBytes(value.payload) ? value.payload : value;
  if (!isBytes(payload)) return payload;
  try { return JSON.parse(decoder.decode(payload)); } catch { return null; }
}

function rows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (isRecord(value.output)) return rows(value.output);
  for (const key of ['items', 'results', 'result']) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

/** Decodes the owner-owned binding; malformed or ambiguous rows deny discovery. */
export function readCapabilityDiscoveryBinding(reply: unknown): CapabilityDiscoveryBinding | null {
  const matches = rows(decode(reply))
    .filter(isRecord)
    .map((row) => {
      const payload = decode(row.payload);
      return isRecord(payload) ? { ...row, ...payload } : row;
    })
    .filter((row) => row.kind === 'ai-tool-binding' && row.id === 'capability-discovery');
  if (matches.length !== 1) return null;
  const binding = matches[0];
  const fixedInput = isRecord(binding.fixed_input) ? binding.fixed_input : null;
  const queryBinding = isRecord(binding.query_binding) ? binding.query_binding : null;
  if (!nonEmptyText(binding.target) || !nonEmptyText(binding.definition_id) || !fixedInput
    || !queryBinding || !nonEmptyText(queryBinding.model_field) || !nonEmptyText(queryBinding.action_field)
    || !nonEmptyText(binding.authority_binding_ref) || !nonEmptyText(fixedInput.index_id) || !nonEmptyText(fixedInput.result_policy_ref)
    || !nonEmptyText(fixedInput.owner_query_target)) return null;
  const schema = binding.model_input_schema;
  if (!isRecord(schema) || schema.type !== 'object' || schema.additionalProperties !== false || !Array.isArray(schema.required)
    || schema.required.length !== 1 || schema.required[0] !== 'query' || !isRecord(schema.properties)
    || Object.keys(schema.properties).length !== 1 || !Object.prototype.hasOwnProperty.call(schema.properties, 'query')
    || !isRecord(schema.properties.query) || schema.properties.query.type !== 'string') return null;
  return {
    target: binding.target,
    definition_id: binding.definition_id,
    fixed_input: fixedInput,
    model_input_schema: schema,
    query_binding: { model_field: queryBinding.model_field, action_field: queryBinding.action_field },
    authority_binding_ref: binding.authority_binding_ref,
  };
}
