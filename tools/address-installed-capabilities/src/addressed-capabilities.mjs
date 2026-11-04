// This synchronous metadata realization binds capabilities to an independently supplied execution owner.
// This registry does not open a database, select a vendor, implement a transport or run a queue.
// Physical transports and ABIs are executable host supplies; definitions alone never implement them.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { operationVersion, assertReplayableInput } from '../../shared-code/src/typed-operation-contract.mjs';
import { capabilityError, checkedCapabilityDescriptor, checkedCapabilityRequirements, selectCapability } from './addressed-capability-contract.mjs';

const CAPABILITY = 'addressed-capability';
const BINDING = 'resource-binding';
const INVOCATION = 'resource-operation-binding';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const identity = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(stable(value)))))}`;
const text = (value, name, most = 1000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > most) throw capabilityError(`${name} needs nonempty text of at most ${most} characters.`);
  return value;
};
const copy = value => structuredClone(value);
const same = (a, b) => identity(a) === identity(b);
const fail = (message, code = 'capability_conflict') => { throw capabilityError(message, 409, code); };
const DESCRIPTOR_FIELDS = ['id', 'label', 'description', 'interface', 'role', 'semantics', 'operations', 'placements', 'needs', 'costs', 'admission_contract'];
const descriptorOf = row => Object.fromEntries(DESCRIPTOR_FIELDS.filter(field => row[field] !== undefined).map(field => [field, row[field]]));
const selectRows = (rows, requirements, selectionPolicy = null) => {
  const descriptors = rows.map(row => ({ ...descriptorOf(row),
    ...(row.admitted_operations ? { placements: [...new Set(Object.values(row.admitted_operations).flatMap(operation => operation.placements))] } : {}),
    ...(row.deleted_at ? { status: 'deleted' } : {}) }));
  const result = selectCapability(descriptors, requirements, selectionPolicy);
  // Every requested method must have an allowed real placement; a union alone could hide an unusable method.
  const candidates = result.candidates.map(candidate => {
    const row = rows.find(item => item.id === candidate.id);
    const methods = requirements.methods?.length ? requirements.methods : Object.keys(row?.operations ?? {});
    const incompatible = requirements.placements?.length && methods.some(method => row?.admitted_operations?.[method]
      && !row.admitted_operations[method].placements.some(place => requirements.placements.includes(place)));
    return incompatible ? { ...candidate, eligible: false, reasons: [...candidate.reasons, 'method_placement_mismatch'] } : candidate;
  });
  const eligible = new Set(candidates.filter(candidate => candidate.eligible).map(candidate => candidate.id));
  const chosen = selectCapability(descriptors.filter(row => eligible.has(row.id)), requirements, selectionPolicy);
  const winner = chosen.selected;
  return { candidates, selection: chosen.selection, selected: winner ? copy(rows.find(row => row.id === winner.id)) : null };
};

/** records is the authenticated scope's current synchronous EEAF record owner.
 *  admissionContracts and operationOwner are actual host supplies.
 *  An asynchronous metadata backend implements its own atomic/CAS owner behind addressed-operation. */
export function makeAddressedCapabilities(records, { owner, operationOwner, admissionContracts = {}, admissionPolicy, resourceRequirements = () => ({}), selectionPolicy = null, commandAuthority = null,
  writeAuthority = null, transaction = fn => fn(), now = () => new Date().toISOString(), keep = null } = {}) {
  text(owner, 'Authenticated resource owner');
  if (typeof admissionPolicy !== 'function' || typeof resourceRequirements !== 'function') throw new TypeError('An authoritative admission policy and resource requirements owner are required.');
  const prefix = type => `${type}:${encodeURIComponent(owner)}:`;
  const key = (type, id) => `${prefix(type)}${encodeURIComponent(text(id, 'id'))}`;
  const commit = fn => {
    const result = transaction(() => {
      const value = fn();
      if (value && typeof value.then === 'function') throw new TypeError('Resource metadata commitments must be synchronous.');
      return value;
    });
    if (result && typeof result.then === 'function') throw new TypeError('Use an asynchronous commitment owner for a remote metadata backend.');
    return result;
  };
  // A registry or binding change is kept with its answer under the command's receipt when the host supplies `keep`
  // (src/standalone-resource-behavior.mjs routeReceipts); a run's request binding is its task's, never a receipt.
  const kept = fn => (keep ? keep(() => commit(fn), { operation: 'capabilities:write' }) : commit(fn));
  const execution = () => {
    const supplied = operationOwner;
    return typeof supplied === 'function' ? supplied() : supplied;
  };
  const contractsFor = (descriptor, requirements = {}, resource_ref) => {
    const names = admissionPolicy({ descriptor: copy(descriptor), requirements: copy(requirements), resource_ref });
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name)) throw new TypeError('The installed policy must synchronously declare required contracts.');
    return [...new Set([...names, ...(requirements.admission_contracts ?? []), ...(descriptor.admission_contract ? [descriptor.admission_contract] : [])])];
  };
  const requirementsFor = (resource_ref, requested) => {
    const trusted = checkedCapabilityRequirements(resourceRequirements(resource_ref));
    const required = checkedCapabilityRequirements(requested);
    for (const field of ['interface', 'role']) if (trusted[field] !== undefined && required[field] !== undefined && trusted[field] !== required[field]) fail('Requested requirements contradict the resource contract.', 'capability_requirements_unmet');
    const result = { ...required, ...trusted };
    for (const field of ['semantics', 'methods', 'needs', 'admission_contracts']) result[field] = [...new Set([...(trusted[field] ?? []), ...(required[field] ?? [])])];
    if (trusted.placements?.length && required.placements?.length) {
      result.placements = trusted.placements.filter(value => required.placements.includes(value));
      if (!result.placements.length) fail('No placement satisfies the resource contract.', 'capability_requirements_unmet');
    }
    if (trusted.max_reserved_idle_micros !== undefined && required.max_reserved_idle_micros !== undefined) result.max_reserved_idle_micros = Math.min(trusted.max_reserved_idle_micros, required.max_reserved_idle_micros);
    return checkedCapabilityRequirements(result);
  };
  const select = (rows, requirements, resource_ref) => {
    const result = selectRows(rows, requirements, selectionPolicy);
    const candidates = result.candidates.map(candidate => {
      const row = rows.find(item => item.id === candidate.id);
      const missing = row && contractsFor(row, requirements, resource_ref).filter(name => row.contract_admissions?.[name]?.admitted !== true);
      return missing?.length ? { ...candidate, eligible: false, reasons: [...candidate.reasons, ...missing.map(name => `unverified_contract:${name}`)] } : candidate;
    });
    const eligible = new Set(candidates.filter(row => row.eligible).map(row => row.id));
    const picked = selectRows(rows.filter(row => eligible.has(row.id)), requirements, selectionPolicy);
    return { ...picked, candidates };
  };
  const at = () => { const value = now(); return value instanceof Date ? value.toISOString() : value; };
  const contract = name => admissionContracts instanceof Map ? admissionContracts.get(name) : Object.hasOwn(admissionContracts, name) ? admissionContracts[name] : null;
  const readRow = (type, id, deleted = false) => {
    const address = key(type, id);
    const row = records.typeOf(address) === type ? records.read(address) : null;
    if (!row || row.owner !== owner || (!deleted && row.deleted_at)) throw capabilityError('This resource was not found in this owner.', 404, 'capability_not_found');
    return copy(row);
  };
  const optionalRow = (type, id) => { try { return readRow(type, id, true); } catch (error) { if (error.status === 404) return null; throw error; } };
  const fence = (type, id, expected) => {
    const current = optionalRow(type, id);
    if (expected === undefined || (current?.revision ?? null) !== expected) fail('The current revision is required. Read this resource and retry the intended change.');
    return current;
  };
  const write = (type, id, value) => {
    const { revision: ignored, ...content } = value;
    const row = { ...content, id, owner, revision: identity({ ...content, id, owner }) };
    // Callers hold the transaction that also checked revisions and dependencies.
    const checked = writeAuthority?.({ type, id, value: row });
    if (checked && typeof checked.then === 'function') throw new TypeError('The current write authority must be checked synchronously in the resource transaction.');
    const written = records.write([{ id: key(type, id), type, value: row }]);
    if (written && typeof written.then === 'function') throw new TypeError('This metadata realization requires synchronous resource writes. Use an asynchronous commit owner for a remote backend.');
    return copy(row);
  };
  const page = (type, { before, limit = 100, deleted = false } = {}) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw capabilityError('Read between 1 and 200 resources at once.');
    const ids = records.ids(type, { ...(before ? { before: key(type, before) } : {}), limit: limit + 1 });
    if (ids.some(id => !id.startsWith(prefix(type)))) throw capabilityError('Capability records require an isolated authenticated scope.', 403, 'capability_owner_mismatch');
    const rows = ids.slice(0, limit).map(id => records.read(id)).filter(row => row?.owner === owner && (deleted || !row.deleted_at));
    return { rows: copy(rows), before: ids.length > limit && ids[limit - 1] ? decodeURIComponent(ids[limit - 1].slice(prefix(type).length)) : null };
  };
  const currentTool = async operation => {
    const tools = execution();
    if (!tools?.describe || !tools?.admitOperation || !tools?.run) throw capabilityError('The executable operation owner is unavailable.', 503, 'capability_executor_unavailable');
    const answer = await tools.describe({ tool_id: operation.tool_id });
    const descriptor = answer?.descriptor;
    if (!object(descriptor) || !descriptor.invoke || descriptor.status === 'deleted' || descriptor.status === 'disabled') {
      throw capabilityError('The operation has no current executable implementation.', 409, 'capability_executor_unavailable');
    }
    if (!object(descriptor.input_schema) || !object(descriptor.output_schema)) {
      throw capabilityError('An admitted operation needs real input and output type descriptions.', 409, 'capability_types_missing');
    }
    if (!Array.isArray(descriptor.placements) || !descriptor.placements.length) throw capabilityError('The operation declares no execution placements.', 409, 'capability_placement_missing');
    if (operation.resource_input && !Object.hasOwn(descriptor.input_schema.properties ?? {}, operation.resource_input)) {
      throw capabilityError('The operation resource input must name one of its declared input fields.');
    }
    if (operation.resource_input && descriptor.input_schema.properties[operation.resource_input]?.writeOnly === true) throw capabilityError('The bound resource address must remain verifiable in durable task state.');
    assertReplayableInput(operation.fixed_input ?? {}, descriptor.input_schema);
    if (operation.resource_input) assertReplayableInput({ [operation.resource_input]: 'bound-resource' }, descriptor.input_schema);
    for (const name of Object.keys(operation.fixed_input ?? {})) {
      if (descriptor.input_schema.additionalProperties === false && !Object.hasOwn(descriptor.input_schema.properties ?? {}, name)) throw capabilityError('A fixed operation input is not in its declared schema.');
      if (descriptor.input_schema.properties?.[name]?.writeOnly === true) throw capabilityError('An operation must refer to a held connection, not persist a write-only input in its definition.');
    }
    const tool_version = operationVersion(descriptor);
    const supply = await tools.admitOperation({ tool_id: operation.tool_id, tool_version, placements: descriptor.placements });
    const placements = supply?.placements?.filter(id => descriptor.placements.includes(id));
    if (!placements?.length) throw capabilityError('No executable host supply can run this operation.', 409, 'capability_executor_unavailable');
    return { descriptor, tool_version, placements };
  };
  const admission = async descriptor => {
    const admitted = {};
    for (const [method, operation] of Object.entries(descriptor.operations)) {
      const { descriptor: tool, tool_version, placements } = await currentTool(operation);
      const places = descriptor.placements?.length ? placements.filter(id => descriptor.placements.includes(id)) : placements;
      if (!places.length) throw capabilityError(`Operation ${method} has no declared compatible placement.`, 409, 'capability_placement_missing');
      admitted[method] = { ...operation, tool_version, input_schema: copy(tool.input_schema), output_schema: copy(tool.output_schema), placements: places };
    }
    const contract_admissions = {};
    for (const name of contractsFor(descriptor)) {
      const verifier = contract(name);
      const answer = typeof verifier === 'function' ? await verifier(copy(descriptor), copy(admitted)) : null;
      if (answer?.admitted !== true || typeof answer.contract_ref !== 'string' || !answer.contract_ref) throw capabilityError('This host has not verified the required admission contract.', 409, 'capability_contract_unverified');
      contract_admissions[name] = answer;
    }
    return { admitted, contract_admissions };
  };
  const read = input => readRow(CAPABILITY, typeof input === 'string' ? input : input.id, input?.deleted === true);
  const binding = input => readRow(BINDING, typeof input === 'string' ? input : input.id, input?.deleted === true);
  const allCandidates = (requirements, resource_ref) => {
    let before = null, selected = null, scanned = 0, eligibleCount = 0;
    const candidates = [];
    do {
      const found = page(CAPABILITY, { limit: 200, ...(before ? { before } : {}) });
      const result = select(found.rows, requirements, resource_ref);
      scanned += found.rows.length;
      eligibleCount += result.candidates.filter(candidate => candidate.eligible).length;
      candidates.push(...result.candidates.slice(0, 200 - candidates.length));
      if (result.selected) selected = select([...(selected ? [selected] : []), result.selected], requirements, resource_ref).selected;
      before = found.before;
    } while (before);
    return { selected: selectionPolicy || eligibleCount === 1 ? selected : null, selection: selectionPolicy ? { policy: selectionPolicy.id, basis: selectionPolicy.description } : eligibleCount === 1 ? { policy: 'unique-eligible-capability' } : null, candidates, scanned, candidates_truncated: scanned > candidates.length, complete: true };
  };
  const choose = (requirements, capability_id, resource_ref) => {
    const result = capability_id ? select([read({ id: capability_id })], requirements, resource_ref) : allCandidates(requirements, resource_ref);
    if (!result.selected) throw capabilityError('No admitted capability satisfies these semantics, cost and placement requirements.', 409, 'capability_requirements_unmet');
    return typeof result.selected === 'string' ? read({ id: result.selected }) : result.selected;
  };
  const resolvedBinding = (row, method) => {
    const capability = read({ id: row.capability_id });
    if (capability.revision !== row.capability_revision) fail('This binding pins a different capability definition. Rebind explicitly before new work.', 'capability_definition_changed');
    const requirements = requirementsFor(row.resource_ref, row.requirements);
    const eligible = select([capability], requirements, row.resource_ref);
    if (!eligible.selected) fail('The bound capability no longer satisfies this resource.', 'capability_requirements_unmet');
    if (method !== undefined && !Object.hasOwn(capability.admitted_operations, text(method, 'method', 200))) {
      throw capabilityError('This resource does not implement that operation.', 400, 'capability_method_unsupported');
    }
    return { binding: row, capability, requirements, ...(method === undefined ? {} : { operation: capability.admitted_operations[method] }) };
  };
  const api = {
    list({ kind = 'capability', ...input } = {}) {
      if (!['capability', 'binding'].includes(kind)) throw capabilityError('Read capabilities or bindings.');
      const result = page(kind === 'capability' ? CAPABILITY : BINDING, input);
      return { [kind === 'capability' ? 'capabilities' : 'bindings']: result.rows, before: result.before };
    },
    read,
    readBinding: binding,
    async save({ descriptor: input, expected_revision }) {
      const descriptor = checkedCapabilityDescriptor(input);
      fence(CAPABILITY, descriptor.id, expected_revision);
      const { admitted, contract_admissions } = await admission(descriptor);
      return kept(() => {
        const previous = fence(CAPABILITY, descriptor.id, expected_revision);
        if (previous?.deleted_at) fail('Restore the capability before replacing its definition.');
        return write(CAPABILITY, descriptor.id, { ...descriptor, admitted_operations: admitted, contract_admissions, created_at: previous?.created_at ?? at(), changed_at: at() });
      });
    },
    remove({ id, expected_revision }) {
      return kept(() => {
        const current = fence(CAPABILITY, id, expected_revision);
        if (!current) throw capabilityError('Capability not found.', 404);
        let before = null;
        do {
          const dependents = page(BINDING, { limit: 200, ...(before ? { before } : {}) });
          if (dependents.rows.some(row => row.capability_id === id)) fail('Remove or rebind dependent resources before removing this capability.', 'capability_in_use');
          before = dependents.before;
        } while (before);
        return write(CAPABILITY, id, { ...current, deleted_at: current.deleted_at ?? at(), changed_at: at() });
      });
    },
    async restore({ id, expected_revision }) {
      const current = fence(CAPABILITY, id, expected_revision);
      if (!current) throw capabilityError('Capability not found.', 404);
      const descriptor = checkedCapabilityDescriptor(descriptorOf(current));
      const { admitted, contract_admissions } = await admission(descriptor);
      return kept(() => {
        const { deleted_at, ...kept } = fence(CAPABILITY, id, expected_revision);
        return write(CAPABILITY, id, { ...kept, admitted_operations: admitted, contract_admissions, changed_at: at() });
      });
    },
    async describe({ id }) {
      const capability = read({ id });
      const operations = {};
      for (const [method, operation] of Object.entries(capability.admitted_operations)) {
        const current = await currentTool(operation);
        operations[method] = { ...operation, current: current.tool_version === operation.tool_version };
      }
      // A changed registry while its implementations were being inspected is not a current introspection result.
      if (read({ id }).revision !== capability.revision) fail('The capability changed while it was being described.');
      return { ...capability, admitted_operations: operations, verification: Object.keys(capability.contract_admissions ?? {}).length ? 'host-admitted-contract' : 'declared-semantics-with-pinned-executable-tools' };
    },
    resolve({ requirements = {} } = {}) { return allCandidates(checkedCapabilityRequirements(requirements)); },
    bind({ id, resource_ref, requirements = {}, capability_id, expected_revision }) {
      text(resource_ref, 'resource_ref');
      return kept(() => {
        const required = requirementsFor(resource_ref, requirements);
        const selected = choose(required, capability_id, resource_ref);
        const previous = fence(BINDING, id, expected_revision);
        if (previous) fail('This binding already exists. Update or restore its existing identity.');
        return write(BINDING, id, { resource_ref, capability_id: selected.id, capability_revision: selected.revision, requirements: required, created_at: at(), changed_at: at() });
      });
    },
    updateBinding({ id, requirements, capability_id, expected_revision }) {
      return kept(() => {
        const current = fence(BINDING, id, expected_revision);
        if (!current || current.deleted_at) throw capabilityError('Binding not found.', 404);
        const required = requirementsFor(current.resource_ref, requirements ?? current.requirements);
        const selected = choose(required, capability_id ?? current.capability_id, current.resource_ref);
        return write(BINDING, id, { ...current, requirements: required, capability_id: selected.id, capability_revision: selected.revision, changed_at: at() });
      });
    },
    removeBinding({ id, expected_revision }) {
      return kept(() => {
        const current = fence(BINDING, id, expected_revision);
        if (!current) throw capabilityError('Binding not found.', 404);
        return write(BINDING, id, { ...current, deleted_at: current.deleted_at ?? at(), changed_at: at() });
      });
    },
    restoreBinding({ id, expected_revision }) {
      return kept(() => {
        const current = fence(BINDING, id, expected_revision);
        if (!current) throw capabilityError('Binding not found.', 404);
        const { deleted_at, ...kept } = current;
        resolvedBinding(kept);
        return write(BINDING, id, { ...kept, changed_at: at() });
      });
    },
    resolveBinding({ id, method }) { return resolvedBinding(binding({ id }), method); },
    assertCurrent(authorization, tool, input) {
      if (!object(authorization) || authorization.owner !== owner) throw capabilityError('This operation belongs to another resource owner.', 403, 'capability_owner_mismatch');
      const resolved = resolvedBinding(binding({ id: authorization.binding_id }), authorization.method);
      if (resolved.binding.revision !== authorization.binding_revision || resolved.capability.id !== authorization.capability_id || resolved.capability.revision !== authorization.capability_revision) {
        fail('The resource or admitted capability changed before this effect.', 'capability_binding_changed');
      }
      if (resolved.operation.tool_id !== tool?.id || resolved.operation.tool_version !== authorization.tool_version || resolved.operation.tool_version !== operationVersion(tool)) fail('The bound executable operation changed.', 'capability_definition_changed');
      const placements = resolved.requirements.placements?.length ? resolved.operation.placements.filter(id => resolved.requirements.placements.includes(id)) : resolved.operation.placements;
      if (!placements.length || !same(placements, authorization.placements)) fail('The admitted placement contract changed.');
      const needs = [...new Set([...(resolved.capability.needs ?? []), ...(resolved.requirements.needs ?? [])])];
      if (!same(needs, authorization.needs)) fail('The chosen execution requirements changed.');
      if (input !== undefined) {
        if (!object(input)) fail('The bound operation input must remain an object.');
        if (resolved.operation.resource_input && input[resolved.operation.resource_input] !== resolved.binding.resource_ref) fail('Input cannot replace the bound resource.', 'capability_resource_mismatch');
        for (const [name, value] of Object.entries(resolved.operation.fixed_input ?? {})) if (!same(input[name], value)) fail('The bound fixed operation input changed.', 'capability_resource_mismatch');
        if (needs.some(need => !Array.isArray(input.needs) || !input.needs.includes(need))) fail('The chosen execution requirements were removed.');
      }
      if (commandAuthority?.assertCurrent) {
        const checked = commandAuthority.assertCurrent(authorization.command_claim, { authorization, tool, input, resource_ref: resolved.binding.resource_ref });
        if (checked && typeof checked.then === 'function') throw new TypeError('Current resource authority must be synchronous in its commitment transaction.');
      }
      return resolved;
    },
    async assertTask(authorization, tool, input) {
      const resolved = api.assertCurrent(authorization, tool, input);
      const current = await currentTool(resolved.operation);
      if (current.tool_version !== authorization.tool_version || !authorization.placements.some(place => current.placements.includes(place))) fail('The admitted executable supply changed.', 'capability_definition_changed');
      for (const name of contractsFor(resolved.capability, requirementsFor(resolved.binding.resource_ref, resolved.binding.requirements), resolved.binding.resource_ref)) {
        const verifier = contract(name);
        const fresh = typeof verifier === 'function' ? await verifier(resolved.capability, resolved.capability.admitted_operations) : null;
        if (fresh?.admitted !== true || fresh.contract_ref !== resolved.capability.contract_admissions?.[name]?.contract_ref) fail('The required admission contract is no longer verified.', 'capability_contract_unverified');
      }
      if (commandAuthority) await commandAuthority.assert(authorization.command_claim, { authorization, tool, input, resource_ref: resolved.binding.resource_ref });
      else if (authorization.command_claim !== undefined) fail('The command authority owner is unavailable.', 'capability_authority_unavailable');
      // Every asynchronous host/tool read must finish before the final synchronous revision fence.
      return api.assertCurrent(authorization, tool, input);
    },
    // The task a run's request key names (its request binding kept before dispatch), or null when it never got one.
    invocation({ id, request_key }) {
      if (typeof id !== 'string' || !id || typeof request_key !== 'string' || !request_key) return null;
      const invocationId = identity({ owner, id, request_key });
      const row = optionalRow(INVOCATION, invocationId);
      return row ? { tool_id: row.request.tool_id, request_key: `resource:${invocationId}` } : null;
    },
    async run({ id, method, input = {}, request_key, wait_seconds, execution: source, command_context }) {
      text(request_key, 'request_key');
      if (!object(input)) throw capabilityError('Operation input must be an object.');
      const resolved = api.resolveBinding({ id, method });
      const { binding: row, capability, operation, requirements } = resolved;
      const { descriptor: tool, tool_version } = await currentTool(operation);
      if (tool_version !== operation.tool_version) fail('The executable operation changed. Read and admit its current definition.', 'capability_definition_changed');
      const needs = [...new Set([...(capability.needs ?? []), ...(requirements.needs ?? [])])];
      const values = { ...copy(input), ...copy(operation.fixed_input ?? {}) };
      if (operation.resource_input) {
        if (Object.hasOwn(input, operation.resource_input) && input[operation.resource_input] !== row.resource_ref) fail('Input cannot replace the bound resource.', 'capability_resource_mismatch');
        values[operation.resource_input] = row.resource_ref;
      }
      if (needs.length) {
        if (!Object.hasOwn(tool.input_schema.properties ?? {}, 'needs')) throw capabilityError('This operation cannot preserve the selected execution requirements.', 409, 'capability_execution_unavailable');
        const requested = Array.isArray(input.needs) ? input.needs : [];
        values.needs = [...new Set([...requested, ...needs])];
      }
      const placements = requirements.placements?.length ? operation.placements.filter(id => requirements.placements.includes(id)) : operation.placements;
      if (!placements.length) throw capabilityError('This operation cannot execute in the resource’s required placement.', 409, 'capability_placement_missing');
      const authorization = { owner, binding_id: id, binding_revision: row.revision, capability_id: capability.id, capability_revision: capability.revision, method, tool_version, placements, needs };
      if (commandAuthority) authorization.command_claim = await commandAuthority.capture({ authorization: copy(authorization), resource_ref: row.resource_ref, input: values, request_key, context: command_context });
      await api.assertTask(authorization, tool, values);
      assertReplayableInput(values, tool.input_schema);
      const invocationId = identity({ owner, id, request_key });
      // An immutable request-to-task binding is not a queue. The admitted execution owner dispatches and recovers work.
      // It prevents reusing one request key against a new physical target after a rebind or tool change.
      const request = { binding_id: id, method, tool_id: operation.tool_id, authorization, input_identity: identity(values) };
      commit(() => {
        api.assertCurrent(authorization, tool, values);
        const prior = optionalRow(INVOCATION, invocationId);
        if (prior && !same(prior.request, request)) fail('This request key already names another resource operation. Inspect its original task; use a new key only for genuinely new work.', 'capability_request_conflict');
        if (!prior) write(INVOCATION, invocationId, { request, created_at: at() });
      });
      return execution().run({ tool_id: operation.tool_id, input: values, request_key: `resource:${invocationId}`, wait_seconds, ...(source ? { execution: source } : {}), resource_authorization: authorization });
    },
  };
  return api;
}
