import { readBoundedJson } from '../../keep-and-wake-ai-sessions-on-this-computer/src/read-bounded-json.mjs';
import { failureOf } from '../../shared-code/src/failure.mjs';

const API_PATH = '/capabilities';
const MAX_BODY_BYTES = 256_000;
const MAX_PAGE_SIZE = 200;
const fail = (message, status = 400, code = 'invalid-request') => Object.assign(new Error(message), { status, code });

const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
const id = { type: 'string', minLength: 1, description: 'An id returned by this capability owner.' };
const expectedRevision = { type: ['string', 'null'], description: 'The current revision from the most recent read, or null when creating.' };
const requirements = { type: 'object', description: 'The requirements used to resolve this capability or resource binding.', additionalProperties: true };
const inputSchema = { type: 'object', description: 'Arguments for the named operation, shaped by the operation schema returned by describe_capability.', additionalProperties: true };

const capabilityActions = new Set(['save', 'read', 'describe', 'remove', 'restore']);
const bindingActions = new Set(['bind', 'readBinding', 'updateBinding', 'removeBinding', 'restoreBinding', 'resolveBinding']);
const actions = new Set([...capabilityActions, 'resolve', ...bindingActions, 'run']);
const forbiddenOwnerFields = new Set(['owner', 'owner_id', 'physical_store', 'physical_store_id', 'connection_secret', 'connection_secrets']);

function ownMethod(owner, name) {
  if (!Object.hasOwn(owner, name) || typeof owner[name] !== 'function') throw fail('Unknown capability action.', 404, 'not-found');
  return owner[name];
}

function jsonError(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 400;
  const message = typeof error?.message === 'string' ? error.message : 'The capability request failed.';
  const code = typeof error?.code === 'string' ? error.code : 'invalid-request';
  return Response.json({ code, message }, { status });
}

/** Dispatch the HTTP endpoint through the same explicit owner-method allowlist as the MCP tools. */
export async function handleAddressedCapabilityRequest(capabilities, request) {
  const url = new URL(request.url);
  if (url.pathname !== API_PATH) return null;
  try {
    if (request.method === 'GET') {
      // reads-ok: a limit above MAX_PAGE_SIZE is refused on the next line, so a page is at most MAX_PAGE_SIZE.
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 100 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw fail(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
      const deleted = url.searchParams.get('deleted');
      if (deleted !== null && deleted !== 'true' && deleted !== 'false') throw fail('deleted must be true or false.');
      return Response.json(await ownMethod(capabilities, 'list')({
        kind: url.searchParams.get('kind') || 'capability',
        ...(url.searchParams.has('before') ? { before: url.searchParams.get('before') } : {}),
        limit,
        ...(deleted === null ? {} : { deleted: deleted === 'true' }),
      }));
    }
    if (request.method !== 'POST') throw fail('Use GET to list capabilities or POST for a capability action.', 405, 'method-not-allowed');
    const input = await readBoundedJson(request, MAX_BODY_BYTES, fail('Capability request is too large.', 413, 'request-too-large'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Capability request must be a JSON object.');
    if (Object.keys(input).some(key => forbiddenOwnerFields.has(key))) throw fail('Owner, physical store and connection secrets are controlled by the host.');
    const { action, ...args } = input;
    if (typeof action !== 'string' || !actions.has(action)) throw fail('Unknown capability action.', 404, 'not-found');
    return Response.json(await ownMethod(capabilities, action)(args));
  } catch (error) {
    // A failure that tries again later is the shared failure owner's to answer, never a refusal of this request.
    if (failureOf(error).tries_again_later) throw error;
    return jsonError(error);
  }
}

const post = (call, action, input = {}) => call(API_PATH, { ...input, action }, 'POST');
const capabilityInput = objectSchema({
  action: { type: 'string', enum: [...capabilityActions] },
  id,
  descriptor: { type: 'object', description: 'Capability descriptor, including its open method definitions.', additionalProperties: true },
  expected_revision: expectedRevision,
});
const bindingInput = objectSchema({
  action: { type: 'string', enum: [...bindingActions] },
  id,
  resource_ref: { type: 'string', minLength: 1, description: 'The opaque logical address of the resource; removing its binding never deletes that resource.' },
  requirements,
  capability_id: id,
  expected_revision: expectedRevision,
  method: { type: 'string', description: 'An open method name described by the capability.' },
});

export const addressedCapabilityTools = call => [
  {
    name: 'manage_capabilities',
    description: 'Save, read, inspect, remove or restore a capability descriptor in this account’s addressed capability catalog. Removing a catalog entry does not remove bound resources.',
    inputSchema: capabilityInput,
    run: ({ action, ...input }) => post(call, action, input),
  },
  {
    name: 'read_capabilities',
    description: 'List a bounded page of capability descriptors or resource bindings owned by this account.',
    inputSchema: objectSchema({ kind: { type: 'string', default: 'capability', description: 'The catalog kind to list, such as capability or resource-binding.' }, before: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE }, deleted: { type: 'boolean' } }),
    run: (input = {}) => call(`${API_PATH}?${new URLSearchParams(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])))}`),
  },
  {
    name: 'resolve_capability',
    description: 'Find the capability that satisfies explicit requirements in this account’s catalog.',
    inputSchema: objectSchema({ requirements }),
    run: ({ requirements: requested }) => post(call, 'resolve', { requirements: requested }),
  },
  {
    name: 'manage_resource_bindings',
    description: 'Bind, read, update, remove, restore or resolve a capability binding to a resource owned by another domain. Removing a binding removes only the binding record, never the underlying resource.',
    inputSchema: bindingInput,
    run: ({ action, ...input }) => post(call, action, input),
  },
  {
    name: 'run_resource_operation',
    description: 'Run an installed method using an opaque address or a resource binding id. Use address with resource:create to create independent project/work state, then invoke its installed methods. Keep request_key for safe retries. Binding execution and wait_seconds are optional owner controls; directly addressed operation controls belong in input.',
    inputSchema: objectSchema({
      id: { ...id, description: 'The resource binding id.' },
      address: { type: 'string', minLength: 1, description: 'An opaque resource address supplied by the host; use either address or id.' },
      method: { type: 'string', minLength: 1, description: 'Open method name from the capability introspection; no closed provider or lifecycle method list is imposed.' },
      input: inputSchema,
      request_key: { type: 'string', minLength: 1, description: 'Caller-supplied stable idempotency key. Preserve it across retries.' },
      wait_seconds: { type: 'number', minimum: 0 },
      execution: { type: 'object', additionalProperties: true },
    }),
    run: ({ id: bindingId, address, ...input }) => {
      if (address !== undefined) {
        if (bindingId !== undefined || typeof address !== 'string' || !address || address.length > 512)
          throw fail('Supply one resource address or binding id.');
        if (typeof input.method !== 'string' || !input.method || typeof input.request_key !== 'string' || !input.request_key)
          throw fail('An installed method and stable request_key are required.');
        if (input.execution !== undefined || input.wait_seconds !== undefined) throw fail('Put directly addressed operation controls in input.');
        return call(`/resources/${encodeURIComponent(address)}/command`, { operation: input.method, input: input.input ?? {}, request_key: input.request_key }, 'POST');
      }
      return post(call, 'run', { id: bindingId, ...input });
    },
  },
];

export const addressedCapabilityAnnotations = {
  manage_capabilities: { title: 'Manage capability descriptors', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  read_capabilities: { title: 'List capability descriptors', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  resolve_capability: { title: 'Resolve a capability', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  manage_resource_bindings: { title: 'Manage resource bindings', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  run_resource_operation: { title: 'Run a resource operation', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};
