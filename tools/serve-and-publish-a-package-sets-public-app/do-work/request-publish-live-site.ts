import packageContract from '../things-to-store-and-run.json' with { type: 'json' };

type JsonRecord = Record<string, unknown>;
type ActionRequestInput = JsonRecord;
type BitfieldTransport = { invoke(target: string, payload: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> };
type BitfieldBootHooks = { connect?: () => Promise<{ transport?: BitfieldTransport }> | { transport?: BitfieldTransport } };

type MaterializedActionRequest = { target: string; payload: JsonRecord };
type SellerPublicationInput = {
  selection_materializer_descriptor_address: string;
  selection_materializer_input: JsonRecord;
  materialization_id: string;
  policy_address: string;
  publication_destination_address: string;
  offer_descriptor_address?: string;
  new_offer?: JsonRecord;
  post_purchase_destination_address?: string;
  publication_request_ref?: JsonRecord;
};

export class DescriptorActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DescriptorActionError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, code: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DescriptorActionError(code, `${label} must be a non-empty string.`);
  return value.trim();
}

function descriptor(): JsonRecord {
  const thing = (packageContract.things as unknown[]).find((candidate) => isRecord(candidate)
    && isRecord(candidate.payload)
    && candidate.payload.kind === 'operational-record.action-materializer.v1'
    && candidate.payload.export_name === 'requestPublishSelectedExperience');
  if (!isRecord(thing) || !isRecord(thing.payload)) throw new DescriptorActionError('DESCRIPTOR_ACTION_DESCRIPTOR_MISSING', 'publish-selected-experience descriptor');
  return thing.payload;
}

function workflowId(address: string): string {
  const thing = (packageContract.things as unknown[]).find((candidate) => isRecord(candidate) && candidate.address === address);
  if (!isRecord(thing) || !isRecord(thing.payload)) throw new DescriptorActionError('DESCRIPTOR_ACTION_WORKFLOW_INVALID', address);
  return requiredText(thing.payload.id, 'DESCRIPTOR_ACTION_DEFINITION_ID_MISSING', 'workflow id');
}

function receiptAddress(intentRef: JsonRecord, requestId: string): string {
  // This is a deterministic Workflow-owned receipt destination, derived only
  // from the admitted intent and request key. The exact persisted publication
  // request is carried as evidence, but cannot redirect the receipt lane.
  // arbitrary receipt/payload/address lane.
  return `workflow-receipt:publish-selected-experience:${intentRef.address}:${intentRef.revision}:${requestId}`;
}


/**
 * The browser is allowed to name a previously persisted intent and an opaque
 * request identity. Everything capable of changing authority is resolved by
 * the owner after Workflow starts; reject it at this boundary rather than
 * hoping later process descriptors ignore it.
 */
function boundedExactRef(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new DescriptorActionError('DESCRIPTOR_ACTION_EXACT_REF_REQUIRED', `${label} must be an exact identity.`);
  const allowedIntent = new Set(['address', 'revision', 'object_hash']);
  for (const key of Object.keys(value)) {
    if (!allowedIntent.has(key)) throw new DescriptorActionError('DESCRIPTOR_ACTION_EXACT_REF_UNTRUSTED_FIELD', `${label}.${key} is not identity.`);
  }
  return {
    address: requiredText(value.address, 'DESCRIPTOR_ACTION_EXACT_REF_INVALID', `${label}.address`),
    revision: requiredText(value.revision, 'DESCRIPTOR_ACTION_EXACT_REF_INVALID', `${label}.revision`),
    object_hash: requiredText(value.object_hash, 'DESCRIPTOR_ACTION_EXACT_REF_INVALID', `${label}.object_hash`),
  };
}

export function materializeActionRequest(input: ActionRequestInput = {}): MaterializedActionRequest {
  const allowed = new Set(['intent_ref', 'request_id', 'publication_request_ref']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new DescriptorActionError('DESCRIPTOR_ACTION_UNTRUSTED_FIELD', `input.${key} is owner-resolved and cannot be supplied by a caller.`);
  }
  const action = descriptor();
  const intent_ref = boundedExactRef(input.intent_ref, 'input.intent_ref');
  const publication_request_ref = boundedExactRef(input.publication_request_ref, 'input.publication_request_ref');
  const request_id = requiredText(input.request_id, 'DESCRIPTOR_ACTION_REQUEST_ID_REQUIRED', 'input.request_id');
  return {
    target: requiredText(action.owner_target, 'DESCRIPTOR_ACTION_TARGET_MISSING', 'owner_target'),
    payload: {
      operation: requiredText(action.operation, 'DESCRIPTOR_ACTION_OPERATION_MISSING', 'operation'),
      definition_id: workflowId(requiredText(action.workflow_definition_address, 'DESCRIPTOR_ACTION_WORKFLOW_ADDRESS_MISSING', 'workflow_definition_address')),
      include_output: action.include_output !== false,
      include_steps: false,
      input: { intent_ref, request_id, publication_request_ref },
      receipt: {
        address: receiptAddress(intent_ref, request_id),
        path: ['current-item', 'workflow-execution-receipt'],
        evidence: { intent_ref, request_id, publication_request_ref },
      },
    },
  };
}

function payloadToBytes(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
function hooks(): BitfieldBootHooks {
  const value = (globalThis as { __BITFIELD_BOOT_HOOKS__?: BitfieldBootHooks }).__BITFIELD_BOOT_HOOKS__;
  if (!value?.connect) throw new DescriptorActionError('DESCRIPTOR_ACTION_BOOT_HOOKS_MISSING', '__BITFIELD_BOOT_HOOKS__.connect');
  return value;
}

export async function requestPublishSelectedExperience(input: ActionRequestInput = {}): Promise<unknown> {
  const request = materializeActionRequest(input);
  const connection = await hooks().connect?.();
  if (!connection?.transport) throw new DescriptorActionError('DESCRIPTOR_ACTION_TRANSPORT_MISSING', 'transport.invoke');
  const response = JSON.parse(new TextDecoder().decode(await connection.transport.invoke(request.target, payloadToBytes(request.payload))));
  if (response.status !== 'completed') throw new DescriptorActionError('DESCRIPTOR_ACTION_WORKFLOW_NOT_COMPLETED', 'workflow request did not complete');
  return response.output ?? response;
}

function sellerPublicationInput(input: ActionRequestInput): SellerPublicationInput {
  const allowed = new Set([
    'selection_materializer_descriptor_address', 'selection_materializer_input', 'materialization_id', 'policy_address', 'publication_destination_address', 'offer_descriptor_address', 'new_offer', 'post_purchase_destination_address', 'publication_request_ref',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new DescriptorActionError('SELLER_PUBLICATION_UNTRUSTED_FIELD', `input.${key} is owner-resolved and cannot be supplied by a seller.`);
  }
  const address = (value: unknown, label: string) => requiredText(value, 'SELLER_PUBLICATION_ADDRESS_INVALID', `input.${label}`);
  const ref = (value: unknown, label: string): JsonRecord => boundedExactRef(value, `input.${label}`);
  if (!isRecord(input.selection_materializer_input)
    || new TextEncoder().encode(JSON.stringify(input.selection_materializer_input)).byteLength > 256 * 1024) {
    throw new DescriptorActionError('SELLER_PUBLICATION_SELECTION_INVALID', 'input.selection_materializer_input must be a bounded owner-local object.');
  }
  if (input.offer_descriptor_address !== undefined && input.new_offer !== undefined) throw new DescriptorActionError('SELLER_PUBLICATION_OFFER_CONFLICT', 'choose an exact offer or a new offer, never both.');
  return {
    selection_materializer_descriptor_address: address(input.selection_materializer_descriptor_address, 'selection_materializer_descriptor_address'),
    selection_materializer_input: input.selection_materializer_input,
    materialization_id: address(input.materialization_id, 'materialization_id'),
    policy_address: address(input.policy_address, 'policy_address'),
    publication_destination_address: address(input.publication_destination_address, 'publication_destination_address'),
    ...(input.offer_descriptor_address === undefined ? {} : { offer_descriptor_address: address(input.offer_descriptor_address, 'offer_descriptor_address') }),
    ...(input.new_offer === undefined ? {} : { new_offer: input.new_offer as JsonRecord }),
    ...(input.post_purchase_destination_address === undefined ? {} : { post_purchase_destination_address: address(input.post_purchase_destination_address, 'post_purchase_destination_address') }),
    ...(input.publication_request_ref === undefined ? {} : { publication_request_ref: ref(input.publication_request_ref, 'publication_request_ref') }),
  };
}

/** Seller ingress dispatches one owner Workflow action.  Normalization,
 * definition admission, publication, compensation, and receipts are Workflow
 * state — never a browser-side orchestration shadow. */
export async function requestSellerPublication(input: ActionRequestInput = {}): Promise<unknown> {
  const connection = await hooks().connect?.();
  if (!connection?.transport) throw new DescriptorActionError('DESCRIPTOR_ACTION_TRANSPORT_MISSING', 'transport.invoke');
  const response = JSON.parse(new TextDecoder().decode(await connection.transport.invoke('slot::workflow', payloadToBytes({
    operation: 'execute_definition',
    definition_id: 'action:request-seller-publication',
    include_output: true,
    include_steps: false,
    input: sellerPublicationInput(input),
  }))));
  if (response.status !== 'completed') throw new DescriptorActionError('SELLER_PUBLICATION_WORKFLOW_NOT_COMPLETED', 'seller publication did not complete');
  return response.output ?? response;
}
