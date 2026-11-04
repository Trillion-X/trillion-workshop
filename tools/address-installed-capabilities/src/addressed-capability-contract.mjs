const DESCRIPTOR_KEYS = new Set([
  'id', 'label', 'interface', 'role', 'semantics', 'operations', 'placements',
  'needs', 'costs', 'description', 'admission_contract',
]);
const REQUIREMENT_KEYS = new Set([
  'interface', 'role', 'semantics', 'methods', 'placements',
  'max_reserved_idle_micros', 'needs', 'preferred_ids', 'admission_contracts',
]);
const OPERATION_KEYS = new Set(['tool_id', 'fixed_input', 'resource_input']);
const COST_KEYS = new Set(['reserved_idle_micros', 'per_call_micros']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SECRET_KEY = /(?:secret|token|password|passwd|authorization|api[-_]?key|private[-_]?key|credential|bearer)/i;
const SECRET_VALUE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:sk|pk|rk|gh[pousr])[-_][A-Za-z0-9_-]{16,})/;

export function capabilityError(message, status = 400, code = 'capability_invalid') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function invalid(message) {
  throw capabilityError(message);
}

function plainRecord(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${name} must be a plain object`);
  return value;
}

function safeKeys(value, allowed, name) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) invalid(`${name} contains an unsafe key`);
    if (!allowed.has(key)) invalid(`${name} contains unknown key: ${key}`);
    if (SECRET_KEY.test(key) && key !== 'secret_name') invalid(`${name} cannot contain secret-bearing keys`);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, 'value')) invalid(`${name} cannot contain accessor properties`);
  }
}

function string(value, name, { min = 1, max = 256, secretCheck = true, trim = true } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (trim && value.trim() !== value)) {
    invalid(`${name} must be a ${trim ? 'trimmed ' : ''}string of ${min}..${max} characters`);
  }
  if (secretCheck && SECRET_VALUE.test(value)) invalid(`${name} cannot contain a secret value`);
  return value;
}

function stringList(value, name, { max = 100, nonempty = false } = {}) {
  if (!Array.isArray(value) || value.length > max || (nonempty && value.length === 0)) invalid(`${name} must be an array${nonempty ? ' with at least one item' : ''}`);
  const result = value.map((item, index) => string(item, `${name}[${index}]`));
  if (new Set(result).size !== result.length) invalid(`${name} cannot contain duplicates`);
  return result;
}

function jsonValue(value, path, depth = 0) {
  if (depth > 12) invalid(`${path} is nested too deeply`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path} must contain finite numbers`);
    return value;
  }
  if (typeof value === 'string') return string(value, path, { min: 0, max: 4096, trim: false });
  if (Array.isArray(value)) {
    if (value.length > 500) invalid(`${path} has too many items`);
    return value.map((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1));
  }
  plainRecord(value, path);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || UNSAFE_KEYS.has(key) || (SECRET_KEY.test(key) && key !== 'secret_name')) invalid(`${path} contains an unsafe or secret-bearing key`);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, 'value')) invalid(`${path} cannot contain accessor properties`);
    result[key] = jsonValue(property.value, `${path}.${key}`, depth + 1);
  }
  return result;
}

function nonnegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a nonnegative safe integer`);
  return value;
}

export function checkedCapabilityDescriptor(input) {
  const descriptor = plainRecord(input, 'descriptor');
  safeKeys(descriptor, DESCRIPTOR_KEYS, 'descriptor');
  const id = string(descriptor.id, 'descriptor.id');
  const label = string(descriptor.label, 'descriptor.label', { max: 160 });
  const interfaceName = string(descriptor.interface, 'descriptor.interface');
  const role = descriptor.role === undefined ? 'external' : string(descriptor.role, 'descriptor.role');

  const semantics = stringList(descriptor.semantics, 'descriptor.semantics', { max: 100 });
  const operationsInput = plainRecord(descriptor.operations, 'descriptor.operations');
  const operationNames = Reflect.ownKeys(operationsInput);
  if (operationNames.some(key => typeof key !== 'string' || UNSAFE_KEYS.has(key))) invalid('descriptor.operations contains an unsafe key');
  if (operationNames.length < 1 || operationNames.length > 100) invalid('descriptor.operations must contain 1..100 methods');
  const operations = Object.create(null);
  for (const method of operationNames) {
    string(method, 'operation method', { secretCheck: false });
    const methodProperty = Object.getOwnPropertyDescriptor(operationsInput, method);
    if (!methodProperty || !Object.hasOwn(methodProperty, 'value')) invalid(`operation ${method} cannot be an accessor`);
    const operation = plainRecord(methodProperty.value, `operation ${method}`);
    safeKeys(operation, OPERATION_KEYS, `operation ${method}`);
    const normalized = Object.create(null);
    normalized.tool_id = string(operation.tool_id, `operation ${method}.tool_id`);
    if (operation.fixed_input !== undefined) {
      const fixedInput = plainRecord(operation.fixed_input, `operation ${method}.fixed_input`);
      normalized.fixed_input = jsonValue(fixedInput, `operation ${method}.fixed_input`);
    }
    if (operation.resource_input !== undefined) normalized.resource_input = string(operation.resource_input, `operation ${method}.resource_input`);
    operations[method] = normalized;
  }

  const result = Object.create(null);
  Object.assign(result, { id, label, interface: interfaceName, role, semantics, operations });
  if (descriptor.admission_contract !== undefined) result.admission_contract = string(descriptor.admission_contract, 'descriptor.admission_contract');
  if (descriptor.placements !== undefined) result.placements = stringList(descriptor.placements, 'descriptor.placements', { max: 100 });
  if (descriptor.needs !== undefined) result.needs = stringList(descriptor.needs, 'descriptor.needs', { max: 100 });
  if (descriptor.costs !== undefined) {
    const costs = plainRecord(descriptor.costs, 'descriptor.costs');
    safeKeys(costs, COST_KEYS, 'descriptor.costs');
    if (!Object.hasOwn(costs, 'reserved_idle_micros')) invalid('descriptor.costs.reserved_idle_micros is required when costs are declared');
    const normalizedCosts = Object.create(null);
    normalizedCosts.reserved_idle_micros = nonnegativeSafeInteger(costs.reserved_idle_micros, 'descriptor.costs.reserved_idle_micros');
    if (costs.per_call_micros !== undefined) normalizedCosts.per_call_micros = nonnegativeSafeInteger(costs.per_call_micros, 'descriptor.costs.per_call_micros');
    result.costs = normalizedCosts;
  }
  if (descriptor.description !== undefined) result.description = string(descriptor.description, 'descriptor.description', { max: 2000, secretCheck: true });
  return result;
}

export function checkedCapabilityRequirements(input = {}) {
  const requirements = plainRecord(input, 'requirements');
  safeKeys(requirements, REQUIREMENT_KEYS, 'requirements');
  const result = Object.create(null);
  for (const field of ['interface', 'role']) {
    if (requirements[field] !== undefined) result[field] = string(requirements[field], `requirements.${field}`);
  }
  for (const field of ['semantics', 'methods', 'placements', 'needs', 'preferred_ids', 'admission_contracts']) {
    if (requirements[field] !== undefined) result[field] = stringList(requirements[field], `requirements.${field}`, { max: 100 });
  }
  if (requirements.max_reserved_idle_micros !== undefined) {
    result.max_reserved_idle_micros = nonnegativeSafeInteger(requirements.max_reserved_idle_micros, 'requirements.max_reserved_idle_micros');
  }
  return result;
}

/** Select by declared compatibility and declared costs; cost values are not measured guarantees. */
export function selectCapability(candidates, requirements = {}, selectionPolicy = null) {
  const checkedRequirements = checkedCapabilityRequirements(requirements);
  if (!Array.isArray(candidates)) invalid('candidates must be an array');
  if (candidates.length > 1000) invalid('candidates has too many entries');
  const rows = candidates.map(candidate => {
    const rawId = candidate && typeof candidate === 'object' && typeof candidate.id === 'string' ? candidate.id : null;
    const reasons = [];
    let descriptor;
    try {
      plainRecord(candidate, 'candidate');
      const allowedCandidateKeys = new Set([...DESCRIPTOR_KEYS, 'revision', 'status']);
      safeKeys(candidate, allowedCandidateKeys, 'candidate');
      if (candidate.revision !== undefined) string(candidate.revision, 'candidate.revision');
      if (candidate.status !== undefined && candidate.status !== 'active') reasons.push(candidate.status === 'deleted' ? 'deleted' : 'not_active');
      const clean = Object.create(null);
      for (const key of DESCRIPTOR_KEYS) if (Object.hasOwn(candidate, key)) clean[key] = candidate[key];
      descriptor = checkedCapabilityDescriptor(clean);
    } catch (error) {
      reasons.push(error?.message || 'invalid_descriptor');
    }
    if (descriptor) {
      if (checkedRequirements.interface !== undefined && descriptor.interface !== checkedRequirements.interface) reasons.push('interface_mismatch');
      if (checkedRequirements.role !== undefined && descriptor.role !== checkedRequirements.role) reasons.push('role_mismatch');
      for (const semantic of checkedRequirements.semantics || []) if (!descriptor.semantics.includes(semantic)) reasons.push(`missing_semantic:${semantic}`);
      for (const method of checkedRequirements.methods || []) if (!Object.hasOwn(descriptor.operations, method)) reasons.push(`missing_method:${method}`);
      for (const need of checkedRequirements.needs || []) if (!(descriptor.needs || []).includes(need)) reasons.push(`missing_need:${need}`);
      if (checkedRequirements.placements?.length) {
        if (!descriptor.placements?.some(placement => checkedRequirements.placements.includes(placement))) reasons.push('placement_mismatch');
      }
      if (checkedRequirements.max_reserved_idle_micros !== undefined) {
        const idle = descriptor.costs?.reserved_idle_micros;
        if (idle === undefined) reasons.push('reserved_idle_cost_unknown');
        else if (idle > checkedRequirements.max_reserved_idle_micros) reasons.push('reserved_idle_cost_exceeds_limit');
      }
    }
    return { id: descriptor?.id ?? rawId, eligible: reasons.length === 0, reasons, descriptor };
  });
  const eligible = rows.filter(row => row.eligible);
  if (selectionPolicy !== null && (typeof selectionPolicy.id !== 'string' || typeof selectionPolicy.compare !== 'function')) invalid('An installed selection policy needs its identity and comparator');
  if (selectionPolicy) eligible.sort((a, b) => selectionPolicy.compare(a.descriptor, b.descriptor, checkedRequirements));
  const selected = eligible.length === 1 || selectionPolicy ? eligible[0]?.descriptor ?? null : null;
  return {
    selected,
    selection: selected ? { policy: selectionPolicy?.id ?? 'unique-eligible-capability', basis: selectionPolicy?.description ?? 'Exactly one admitted candidate satisfies the requirements.' } : null,
    candidates: rows.map(({ id, eligible: isEligible, reasons }) => ({ id, eligible: isEligible, reasons })),
  };
}
