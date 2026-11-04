// PORTED FROM: bitfield-packages/packages/chat/do-work/submit-connect-action.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import type {
  AddressedRouteDescriptor,
  AddressedSetupDescriptor,
  AddressedSetupFieldDescriptor,
} from '../read-data/read-addressed-exchange-participants';

const DEFAULT_CREDENTIAL_STORE_TARGET = 'slot::credentials-vault';
const DEFAULT_HANDLE_TTL_SECONDS = 900;

interface TargetReplyEnvelope {
  payload?: unknown;
}

interface CredentialVaultResponse {
  success?: unknown;
  handle?: unknown;
  error?: unknown;
}

type ConnectActionPayload = {
  operation_ref: string;
  definition_id: string | null;
  participant_ref: string;
  way_ref: string | null;
  service_connection_ref: string;
  setup_route_ref: string;
  public_input: Record<string, string>;
  credential_handle_refs: string[];
  verify_request: VerifyRequestPayload | null;
  correlation_refs: string[];
};

type VerifyRequestPayload = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credential_injections: {
    handle: string;
    placement: Record<string, unknown>;
  }[];
  timeout_ms: number;
  expected_status: { min: number; max: number } | Record<string, unknown> | null;
  route_ref: string | null;
};

export interface SubmitConnectActionInput {
  participantRef: string;
  wayRef: string | null;
  serviceConnectionRef: string;
  setupRoute: AddressedRouteDescriptor;
  setupDescriptor: AddressedSetupDescriptor;
  fieldValues: Record<string, string>;
  correlationRefs?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeJsonPayload(reply: unknown): Record<string, unknown> {
  if (!isRecord(reply)) return {};
  const payload = (reply as TargetReplyEnvelope).payload;
  if (payload instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
  }
  return isRecord(payload) ? payload : reply;
}

function workflowOutputFromReply(reply: Record<string, unknown>): Record<string, unknown> {
  return isRecord(reply.output) ? reply.output : reply;
}

function parseVaultError(response: CredentialVaultResponse, fallback: string): string {
  return typeof response.error === 'string' && response.error.length > 0
    ? response.error
    : fallback;
}

function secretName(input: SubmitConnectActionInput, field: AddressedSetupFieldDescriptor): string {
  // credentials-vault keys allow ONLY [a-zA-Z0-9_-] (E5004). The refs contain
  // colons (e.g. service-connection:openai), so join then sanitize every invalid
  // char to '_'. The key is store-only; downstream uses the opaque handle, so the
  // sanitized form just needs to be deterministic + unique per field.
  return [
    'chat',
    input.participantRef,
    input.wayRef ?? 'way',
    input.serviceConnectionRef,
    field.id,
  ].join(':').replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function mintCredentialHandle(input: SubmitConnectActionInput, field: AddressedSetupFieldDescriptor): Promise<{ fieldId: string; handle: string } | null> {
  const secretValue = input.fieldValues[field.id] ?? '';
  if (!secretValue && !field.required) return null;
  const target = DEFAULT_CREDENTIAL_STORE_TARGET;
  const key = secretName(input, field);

  const writeResponse = decodeJsonPayload(await sendRequestToBitfieldTarget({
    target,
    payload: {
      operation: 'write',
      key,
      value: secretValue,
    },
  })) as CredentialVaultResponse;
  if (writeResponse.success !== true) {
    throw new Error(parseVaultError(writeResponse, 'Failed to store credential'));
  }

  const readResponse = decodeJsonPayload(await sendRequestToBitfieldTarget({
    target,
    payload: {
      operation: 'read',
      key,
      handle_ttl_seconds: DEFAULT_HANDLE_TTL_SECONDS,
      // one_time:true fails resolution ([E3002] "not active in this vault
      // instance") even on a clean single-instance engine: the handle is minted
      // through the shell HTTP vault route while http-client resolves it inside
      // the runner's vault instance, and one-time activation state is not shared
      // across those instances. TTL (900s) still bounds the handle's lifetime.
      one_time: false,
    },
  })) as CredentialVaultResponse;
  if (readResponse.success !== true) {
    throw new Error(parseVaultError(readResponse, 'Failed to mint credential handle'));
  }
  if (typeof readResponse.handle !== 'string' || readResponse.handle.length === 0) {
    throw new Error(`${target} returned no opaque handle`);
  }
  return { fieldId: field.id, handle: readResponse.handle };
}

function credentialHandleId(handle: string): string {
  try {
    const parsed = JSON.parse(handle) as { handle_id?: unknown };
    if (typeof parsed.handle_id === 'string' && parsed.handle_id.length > 0) {
      return `credential-handle:${parsed.handle_id}`;
    }
  } catch {
    // Opaque non-JSON handle formats fall through to the hash-free marker below.
  }
  return 'credential-handle:opaque';
}

function buildVerifyRequest(input: SubmitConnectActionInput, credentialHandleByFieldId: Map<string, string>): VerifyRequestPayload | null {
  const resolvedVerifyRequest = input.setupDescriptor.resolvedVerifyRequest;
  if (!resolvedVerifyRequest) return null;

  return {
    url: resolvedVerifyRequest.url,
    method: resolvedVerifyRequest.method,
    headers: resolvedVerifyRequest.headers,
    body: resolvedVerifyRequest.body,
    credential_injections: resolvedVerifyRequest.credentialInjections.map((injection) => {
      const handle = credentialHandleByFieldId.get(injection.fieldId);
      if (!handle) {
        throw new Error(`No credential handle minted for verify request field ${injection.fieldId}`);
      }
      return {
        handle,
        placement: injection.placement,
      };
    }),
    timeout_ms: 30000,
    expected_status: resolvedVerifyRequest.expectedStatus,
    route_ref: resolvedVerifyRequest.routeRef,
  };
}

export async function submitConnectAction(input: SubmitConnectActionInput): Promise<Record<string, unknown>> {
  if (!input.setupRoute.targetRef) {
    throw new Error(`Setup route ${input.setupRoute.routeRef} has no target`);
  }
  const fields = input.setupDescriptor.fields;
  const credentialHandlesByField = (
    await Promise.all(fields.filter((field) => field.secret).map((field) => mintCredentialHandle(input, field)))
  ).filter((entry): entry is { fieldId: string; handle: string } => !!entry);
  const credentialHandleByFieldId = new Map(
    credentialHandlesByField.map((entry) => [entry.fieldId, entry.handle]),
  );
  // Live connection-state persists credential_handle_refs. Full handles are a
  // reusable secret-resolution capability (bearer token) — only the opaque
  // handle_id goes into state. The full handles travel solely inside
  // verify_request.credential_injections, which the action hands to
  // http-client and never writes.
  const credentialHandleRefs = credentialHandlesByField.map((entry) => credentialHandleId(entry.handle));
  // verifyRequest is null for services whose descriptor has no verify route
  // (local/no-credential services). Their setup route points at the direct
  // connect definition, which requires no verify_request — one-click connect.
  const verifyRequest = buildVerifyRequest(input, credentialHandleByFieldId);
  const publicInput = Object.fromEntries(
    fields
      .filter((field) => !field.secret)
      .map((field) => [field.id, input.fieldValues[field.id] ?? '']),
  );
  const connectPayload: ConnectActionPayload = {
    operation_ref: input.setupRoute.operationRef ?? 'operation:connection.submit',
    definition_id: input.setupRoute.definitionId,
    participant_ref: input.participantRef,
    way_ref: input.wayRef,
    service_connection_ref: input.serviceConnectionRef,
    setup_route_ref: input.setupRoute.routeRef,
    public_input: publicInput,
    credential_handle_refs: credentialHandleRefs,
    verify_request: verifyRequest,
    correlation_refs: input.correlationRefs ?? [],
  };
  if (input.setupRoute.targetRef === 'slot::workflow' && !input.setupRoute.definitionId) {
    throw new Error(`Setup route ${input.setupRoute.routeRef} has no workflow definition`);
  }
  const payload = input.setupRoute.targetRef === 'slot::workflow'
    ? {
        operation: 'execute_definition',
        definition_id: input.setupRoute.definitionId,
        include_steps: false,
        include_output: true,
        input: connectPayload,
      }
    : connectPayload;

  const reply = decodeJsonPayload(await sendRequestToBitfieldTarget({
    target: input.setupRoute.targetRef,
    payload,
  }));
  // DO NOT invoke action:publish-addressed-exchange-participants here. That
  // action projects ONLY from live attribute_facts, but participant/route/
  // descriptor facts live in package records (not live state) — running it
  // overwrites the full feed with a connection-state-only table and the
  // participant picker goes empty (2026-06-11 incident). Connection status in
  // the feed refreshes on the next full projection; the dialog's own success
  // state is driven by this reply.
  return input.setupRoute.targetRef === 'slot::workflow' ? workflowOutputFromReply(reply) : reply;
}
