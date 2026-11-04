// Generic external database attachment through the existing Workshop owner.
// The selected provider tool performs the real create/attach/query effect; this
// module keeps only its immutable tool/connection pins and opaque remote id.
import { workshopToolVersion } from '../../shared-code/src/typed-operation-contract.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const fail = (message, status = 400, code = 'database_provider_invalid') => {
  throw Object.assign(new Error(message), { status, code });
};
const methodName = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const credentialFreeIdentity = value => {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  try { const url=new URL(value);return !url.username&&!url.password&&[...url.searchParams.keys()].every(key=>!/(?:password|token|secret|credential|authorization|api[-_]?key)/i.test(key)); }
  catch { return false; }
};
const noSecretData = value => {
  if (Array.isArray(value)) return value.every(noSecretData);
  if (!object(value)) return true;
  return Object.entries(value).every(([key, child]) => !/(?:password|token|secret|credential|authorization|api[-_]?key|private[-_]?key)/i.test(key) && noSecretData(child));
};

function selectedTool(workshop, toolId) {
  if (typeof toolId !== 'string' || !toolId.trim()) fail('Choose an installed Workshop database operation.');
  return workshop.describe({ tool_id: toolId }).then(answer => {
    const descriptor = answer?.descriptor;
    if (!object(descriptor) || descriptor.id !== toolId || !object(descriptor.invoke)
      || !object(descriptor.input_schema) || !object(descriptor.input_schema.properties)
      || !object(descriptor.output_schema)) fail(`Workshop tool ${toolId} is not an installed executable operation.`, 409);
    return { descriptor: copy(descriptor), tool_version: workshopToolVersion(descriptor) };
  });
}

/**
 * Native ABI for a standalone native Database/Resource owner.
 *
 * Required closures:
 * - workshop: current makeWorkshop facade (describe, bind, run)
 * - connection: read a fresh service connection by id
 * - readAttachment/writeAttachment: resource-local EEAF or equivalent durable owner
 * - runTool: execute Workshop's existing run with the caller's current admitted context
 * - assertCurrent: recheck the captured native command before and after external work
 *
 * Attachment DATA records names/ids only. Credential values stay in the selected
 * Workshop connection and its existing locked-box sender.
 */
export function nativeWorkshopDatabaseProvider({ workshop, connection, readAttachment, writeAttachment,
  runTool, assertCurrent, now = () => new Date().toISOString() } = {}) {
  if (!workshop || !['describe', 'bind'].every(name => typeof workshop[name] === 'function'))
    throw new TypeError('The current Workshop describe and bind owners are required.');
  if (![connection, readAttachment, writeAttachment, runTool, assertCurrent].every(value => typeof value === 'function'))
    throw new TypeError('Current connection, resource attachment, Workshop run and native authority owners are required.');

  const checkedConnection = async pin => {
    const current = await connection(pin.connection_id);
    if (!current || current.status !== 'connected' || current.connection_id !== pin.connection_id
      || current.connected_at !== pin.connected_at || current.vendor !== pin.vendor)
      fail('The selected database connection changed. Reattach it using its current connection.', 409, 'database_provider_connection_changed');
    return current;
  };
  const bindTool = async (toolId, pin) => {
    const { descriptor } = await selectedTool(workshop, toolId);
    if (descriptor.invoke.connection_id && descriptor.invoke.connection_id !== pin.connection_id)
      fail('This provider tool is already bound to another service connection.', 409);
    if (!descriptor.invoke.connection_id && !descriptor.invoke.connection)
      fail(`Workshop tool ${toolId} does not declare a service connection.`, 409);
    await checkedConnection(pin);
    const bound = await workshop.bind({ tool_id: toolId, binding: { connection_id: pin.connection_id, connected_at: pin.connected_at } });
    if (typeof bound !== 'string' || !bound) fail(`Workshop could not bind ${toolId} to the selected connection.`, 409);
    const selected=await selectedTool(workshop,bound);return { tool_id: bound, descriptor:selected.descriptor };
  };
  const run = async (attachment, method, input, context) => {
    const pin = attachment.connection;
    await checkedConnection(pin);
    await assertCurrent(context, { attachment: copy(attachment), method });
    const operation = attachment.operations[method];
    if (!operation) fail(`The attached database provider does not supply ${method}.`, 404, 'database_provider_method_missing');
    const currentTool = await selectedTool(workshop, operation.tool_id);
    if (currentTool.tool_version !== operation.tool_version)
      fail(`Workshop tool ${operation.tool_id} changed after it was attached. Reattach the provider before new work.`, 409, 'database_provider_tool_changed');
    if (!Object.hasOwn(currentTool.descriptor.input_schema.properties, attachment.resource_field))
      fail(`Workshop tool ${operation.tool_id} no longer accepts the pinned external database identity field.`, 409, 'database_provider_tool_changed');
    const values = { ...copy(input), [attachment.resource_field]: attachment.external_resource };
    const result = await runTool({ tool_id: operation.tool_id, input: values, request_key: context.request_key,
      wait_seconds: 30, resource_authorization: context.resource_authorization, command_context: context });
    if (!object(result) || result.state !== 'completed' || !Object.hasOwn(result, 'output'))
      return { state: result?.state ?? 'unknown', ...(result?.task_id ? { task_id: result.task_id } : {}) };
    await assertCurrent(context, { attachment: copy(attachment), method, after_effect: true });
    await checkedConnection(pin);
    return copy(result.output);
  };

  return Object.freeze({
    async attach(input, context) {
      if (!object(input) || !object(context) || typeof input.resource !== 'string' || !input.resource.trim()
        || typeof input.connection_id !== 'string' || typeof input.connected_at !== 'string' || typeof input.vendor !== 'string'
        || !object(input.operations) || typeof input.resource_field !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(input.resource_field)
        || !object(input.provision_input ?? {}) || !noSecretData(input.provision_input))
        fail('Attach needs a resource, current connection incarnation, provider operations and non-secret provision input.');
      await assertCurrent(context, { resource: input.resource, operation: 'database:attach' });
      const connectionPin = { connection_id: input.connection_id, connected_at: input.connected_at, vendor: input.vendor };
      await checkedConnection(connectionPin);
      const names = Object.keys(input.operations);
      if (!names.includes('provision') && !names.includes('attach')) fail('Supply a real provider provision or attach tool.');
      if (names.length > 16 || names.some(name => !methodName(name))) fail('Provider operation names are invalid.');
      const pinned = {};
      for (const name of names) {
        const supplied = input.operations[name];
        const toolId = typeof supplied === 'string' ? supplied : supplied?.tool_id;
        const bound = await bindTool(toolId, connectionPin);
        if (!['provision', 'attach'].includes(name) && !Object.hasOwn(bound.descriptor.input_schema.properties, input.resource_field))
          fail(`Workshop tool ${toolId} must accept the declared external database identity field ${input.resource_field}.`, 409);
        pinned[name] = { tool_id: bound.tool_id, tool_version: workshopToolVersion(bound.descriptor) };
      }
      const provisioningMethod = names.includes('provision') ? 'provision' : 'attach';
      const provisioning = pinned[provisioningMethod];
      const provisionDescriptor = await selectedTool(workshop, provisioning.tool_id);
      const outputField = input.output_resource_field ?? input.resource_field;
      if (!Object.hasOwn(provisionDescriptor.descriptor.output_schema.properties ?? {}, outputField))
        fail(`The selected provider must declare ${outputField} in its result schema.`, 409);
      const called = await runTool({ tool_id: provisioning.tool_id, input: copy(input.provision_input ?? {}),
        request_key: context.request_key, wait_seconds: 30, resource_authorization: context.resource_authorization,
        command_context: context });
      if (!object(called) || called.state !== 'completed' || !object(called.output))
        return { state: called?.state ?? 'unknown', ...(called?.task_id ? { task_id: called.task_id } : {}) };
      await assertCurrent(context, { resource: input.resource, operation: 'database:attach', after_effect: true });
      await checkedConnection(connectionPin);
      const externalResource = called.output[outputField];
      if (typeof externalResource !== 'string' || !externalResource.trim() || externalResource.length > 512)
        fail('The provider operation completed without returning the declared external database identity.', 502, 'database_provider_identity_missing');
      if (!credentialFreeIdentity(externalResource)) fail('Return a database identity with credentials held by its connected service.', 502, 'database_provider_identity_credential');
      if (!noSecretData(called.output)) fail('The provider result contains secret-shaped fields and cannot be retained.', 502);
      const attachment = { resource: input.resource, engine: 'external-database-provider',
        connection: connectionPin, resource_field: input.resource_field, external_resource: externalResource,
        operations: pinned, attached_at: now(), source_request_key: context.request_key };
      await writeAttachment(input.resource, attachment, context);
      return attachedReply(attachment);
    },
    async invoke(input, context) {
      if (!object(input) || typeof input.resource !== 'string' || !methodName(input.operation) || !object(input.input ?? {}))
        fail('An addressed database resource, operation and object input are required.');
      const attachment = await readAttachment(input.resource, context);
      if (!object(attachment) || attachment.resource !== input.resource || attachment.engine !== 'external-database-provider')
        fail('No external database provider is attached at this resource.', 404, 'database_provider_not_found');
      if (!noSecretData(input.input)) fail('Send credentials through the connected Workshop service, never as query input.');
      return run(attachment, input.operation, input.input ?? {}, context);
    },
    async current(resource, context) {
      await assertCurrent(context, { resource, operation: 'database:attachment-read' });
      const attachment = await readAttachment(resource, context);
      if (!attachment) return { attached: false };
      await checkedConnection(attachment.connection);
      return { attached: true, resource, external_resource: attachment.external_resource,
        connection_id: attachment.connection.connection_id, methods: Object.keys(attachment.operations), attached_at: attachment.attached_at };
    },
  });
}

/** What an attach answers, made from the attachment it keeps (also how a lost attach is answered from that record). */
export const attachedReply = attachment => ({ state: 'attached', resource: attachment.resource, external_resource: attachment.external_resource,
  connection_id: attachment.connection.connection_id, methods: Object.keys(attachment.operations), attached_at: attachment.attached_at });

/** Reusable MCP/CLI tool definitions; callers route the action through the native resource owner. */
export function databaseProviderTools(call) {
  if (typeof call !== 'function') throw new TypeError('An admitted database provider command is required.');
  return [
    { name: 'attach_database_provider', description: 'Provision or attach an external database using an installed Workshop tool and one of your current service connections. The provider tool must return the external database identity. Credentials stay in the connected service.', inputSchema: { type: 'object', required: ['resource','connection_id','connected_at','vendor','operations','resource_field','provision_input'], additionalProperties: false, properties: {
      resource: { type: 'string', minLength: 1 }, target_resource:{type:'string',description:'The native work resource containing the selected service connection; defaults to your account records.'}, connection_id: { type: 'string', minLength: 1 }, connected_at: { type: 'string', minLength: 1 }, vendor: { type: 'string', minLength: 1 },
      operations: { type: 'object', minProperties: 1, maxProperties: 16, additionalProperties: { oneOf: [{ type: 'string' }, { type: 'object', required: ['tool_id'], properties: { tool_id: { type: 'string' } }, additionalProperties: false }] } },
      resource_field: { type: 'string', minLength: 1 }, output_resource_field: { type: 'string' }, provision_input: { type: 'object' },
    } }, run: input => call('attach', input) },
    { name: 'run_external_database_operation', description: 'Run an operation on the attached external database through its pinned Workshop provider tool and current connection.', inputSchema: { type: 'object', required: ['resource','operation','input'], additionalProperties: false, properties: {
      resource: { type: 'string', minLength: 1 }, target_resource:{type:'string'}, operation: { type: 'string', minLength: 1 }, input: { type: 'object' },
    } }, run: input => call('invoke', input) },
    { name: 'read_external_database_attachment', description: 'Read the current attached provider, connection incarnation and supported operations.', inputSchema: { type: 'object', required: ['resource'], additionalProperties: false, properties: { resource: { type: 'string', minLength: 1 },target_resource:{type:'string'} } }, run: input => call('current', input) },
  ];
}

export const databaseProviderAnnotations = {
  attach_database_provider: { title: 'Attach a database provider', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run_external_database_operation: { title: 'Run an external database operation', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  read_external_database_attachment: { title: 'Read an attached database provider', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
