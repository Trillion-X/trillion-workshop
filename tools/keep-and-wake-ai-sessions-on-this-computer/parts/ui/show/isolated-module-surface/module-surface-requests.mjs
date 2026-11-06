// Request declarations are DATA on a saved screen. The module gets capability
// names and values; the signed-in page owns paths, methods, bindings and fetch.
// A declaration may name only what sandboxed-screen-routes.json allows: a saved screen's code is not the person's.
import shipped from './sandboxed-screen-routes.json' with { type: 'json' };
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const SAFE_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._~:%-]+$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SCHEMA_DEPTH = 12;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_PROPERTIES = 128;
const MAX_INPUT_BYTES = 32768;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const CONTENT_IDENTITY = /^(1f|12):[0-9a-f]{64}$/;
const LEASE_TOKEN = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;

const unavailable = () => new Error('This screen request is unavailable.');
/** A declaration naming a request the allowed list does not hold. The running screen is told only that the request is
 *  unavailable; `reason` is the list's own plain words for the AI that saves it (the save says it back). */
const unlisted = (allowed, name, method, path) => Object.assign(unavailable(), {
  reason: typeof allowed.unlisted_words === 'string'
    ? allowed.unlisted_words.replace('{name}', name).replace('{method}', String(method)).replace('{path}', String(path))
    : undefined,
});

/** One content-identity grammar for lesson writes and their confirming readback. */
export function lessonPracticeIdentity(value) {
  return typeof value === 'string' && CONTENT_IDENTITY.test(value);
}

/** The account comes from the session; every lesson record is also scoped to its community. */
export function lessonPracticeLabel(spaceId, courseId, lessonId) {
  const ids = [spaceId, courseId, lessonId];
  if (ids.some(value => typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f]/.test(value))) throw unavailable();
  const label = `lesson-practice:${JSON.stringify(ids)}`;
  if (label.length > 300) throw unavailable();
  return label;
}

/** Fixed, per-lesson capabilities for keeping learner work in the signed-in workspace. */
export function lessonPracticeRequests(spaceId, courseId, lessonId) {
  const label = lessonPracticeLabel(spaceId, courseId, lessonId);
  const query = encodeURIComponent(label);
  const attempt = { type: 'object', additionalProperties: false, properties: Object.fromEntries(
    ['step', 'result', 'alternative', 'prediction', 'observation', 'comparison', 'revision', 'zoom', 'transfer']
      .map(key => [key, { type: 'string', maxLength: 2000 }])) };
  return {
    read_practice: { method: 'GET', path: `/work/api/records?label=${query}` },
    keep_practice: {
      method: 'POST', path: '/work/api/records',
      input_schema: { type: 'object', additionalProperties: false, required: ['attempt', 'expected_identity', 'request_key'], properties: {
        attempt, expected_identity: { type: 'string', nullable: true, maxLength: 200 },
        request_key: { type: 'string', minLength: 1, maxLength: 200 },
      } },
      body: { writes: [{ address_label: label, payload: { from: 'attempt' }, expected_identity: { from: 'expected_identity' } }], conflict_policy: 'preserve' },
    },
  };
}

function safeKey(key) {
  return typeof key === 'string' && SAFE_KEY.test(key) && !RESERVED_KEYS.has(key);
}

function plainObject(value) {
  if (!object(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The allowed route a declared (method, path) names, or a refusal: the path whole, its query only where the route
 *  names one. Answers whether the path is scoped to the screen's Space and the one write the route allows (none for a
 *  read). */
function validateRequestPath(path, method, allowed, name = '') {
  if (typeof path !== 'string' || !path.startsWith('/work/api/') || path.includes('#') || path.includes('\\')) throw unlisted(allowed, name, method, path);
  const queryAt = path.indexOf('?');
  const route = queryAt < 0 ? path : path.slice(0, queryAt);
  const entry = allowed.routes.find(row => row.method === method && row.path === route);
  if (!entry) throw unlisted(allowed, name, method, path);
  if (Boolean(entry.query) !== queryAt >= 0) throw unavailable();
  if (queryAt >= 0) {
    // A module may read one statically selected private practice record through
    // the signed-in workspace-record owner. Dynamic or wider queries are refused.
    const query = path.slice(queryAt + 1);
    if (method !== 'GET' || route !== '/work/api/records' || !query.startsWith('label=')) throw unavailable();
    try {
      const label = decodeURIComponent(query.slice(6));
      const ids = JSON.parse(label.slice('lesson-practice:'.length));
      if (!label.startsWith('lesson-practice:') || !Array.isArray(ids) || ids.length !== 3
        || lessonPracticeLabel(...ids) !== label || `label=${encodeURIComponent(label)}` !== query) throw unavailable();
    } catch { throw unavailable(); }
  }
  const segments = route.slice(1).split('/');
  const decodedSegments = segments.map((segment, index) => {
    if (!segment || !SAFE_SEGMENT.test(segment)) throw unavailable();
    try {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('?') || decoded.includes('#') || decoded.includes('%')) throw unavailable();
      // The only route parameter is the explicit Space context segment.
      if (decoded.startsWith(':') && !(index === 3 && segments[0] === 'work' && segments[1] === 'api' && segments[2] === 'spaces' && decoded === ':space_id')) throw unavailable();
      return decoded;
    } catch { throw unavailable(); }
  });
  const scoped = decodedSegments[0] === 'work' && decodedSegments[1] === 'api' && decodedSegments[2] === 'spaces' && decodedSegments[3] === ':space_id' && decodedSegments.length > 4;
  if (decodedSegments.includes(':space_id') && !scoped) throw unavailable();
  return { scoped, write: entry.write ?? null };
}

function validateSchema(request) {
  const schema = request.input_schema ?? { type: 'object', properties: {}, additionalProperties: false };
  if (!plainObject(schema) || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))
    || schema.type !== 'object' || schema.additionalProperties !== false || !plainObject(schema.properties ?? {})) throw unavailable();
  validateValueSchema(schema, 0);
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  return { properties, required };
}

function validateValueSchema(schema, depth) {
  if (depth > MAX_SCHEMA_DEPTH || !plainObject(schema)) throw unavailable();
  if (schema.type === 'null') {
    if (Object.keys(schema).some(key => key !== 'type')) throw unavailable();
    return;
  }
  if (['string', 'number', 'integer', 'boolean'].includes(schema.type)) {
    if (Object.keys(schema).some(key => !['type', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'nullable'].includes(key))) throw unavailable();
    if (schema.nullable !== undefined && typeof schema.nullable !== 'boolean') throw unavailable();
    if (schema.minLength !== undefined && (!Number.isSafeInteger(schema.minLength) || schema.minLength < 0)) throw unavailable();
    if (schema.maxLength !== undefined && (!Number.isSafeInteger(schema.maxLength) || schema.maxLength < 0)) throw unavailable();
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) throw unavailable();
    if (schema.minimum !== undefined && (typeof schema.minimum !== 'number' || !Number.isFinite(schema.minimum))) throw unavailable();
    if (schema.maximum !== undefined && (typeof schema.maximum !== 'number' || !Number.isFinite(schema.maximum))) throw unavailable();
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) throw unavailable();
    if ((schema.type !== 'string' && (schema.minLength !== undefined || schema.maxLength !== undefined))
      || (schema.type !== 'number' && schema.type !== 'integer' && (schema.minimum !== undefined || schema.maximum !== undefined))) throw unavailable();
    if (schema.enum !== undefined && (!Array.isArray(schema.enum)
      || schema.enum.some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item) || !checkValue(item, { ...schema, enum: undefined }))
      || new Set(schema.enum.map(item => `${typeof item}:${String(item)}`)).size !== schema.enum.length)) throw unavailable();
    return;
  }
  if (schema.type === 'array') {
    if (Object.keys(schema).some(key => !['type', 'items', 'minItems', 'maxItems'].includes(key))
      || !Number.isSafeInteger(schema.maxItems) || schema.maxItems < 0 || schema.maxItems > MAX_ARRAY_ITEMS
      || (schema.minItems !== undefined && (!Number.isSafeInteger(schema.minItems) || schema.minItems < 0 || schema.minItems > schema.maxItems))) throw unavailable();
    validateValueSchema(schema.items, depth + 1);
    return;
  }
  if (schema.type === 'object') {
    if (Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))
      || schema.additionalProperties !== false || !plainObject(schema.properties) || Object.keys(schema.properties).length > MAX_OBJECT_PROPERTIES
      || Object.keys(schema.properties).some(key => !safeKey(key))) throw unavailable();
    const required = schema.required ?? [];
    if (!Array.isArray(required) || new Set(required).size !== required.length
      || required.some(key => !safeKey(key) || !own(schema.properties, key))) throw unavailable();
    for (const value of Object.values(schema.properties)) validateValueSchema(value, depth + 1);
    return;
  }
  throw unavailable();
}

function validateTemplate(value, properties, depth = 0) {
  if (depth > 12) throw unavailable();
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw unavailable();
    for (const item of value) validateTemplate(item, properties, depth + 1);
    return;
  }
  if (!object(value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw unavailable();
    return;
  }
  if (own(value, 'from')) {
    if (Object.keys(value).length !== 1 || typeof value.from !== 'string' || !own(properties, value.from)) throw unavailable();
    return;
  }
  if (!plainObject(value) || Object.keys(value).length > MAX_OBJECT_PROPERTIES || Object.keys(value).some(key => !safeKey(key))) throw unavailable();
  for (const item of Object.values(value)) validateTemplate(item, properties, depth + 1);
}

/** Validate saved-screen request capability declarations before they are admitted. */
/** `allowed` is the list of requests a declaration may name: sandboxed-screen-routes.json, unless the caller names one. */
export function validateModuleSurfaceRequests(requests, allowed = shipped) {
  if (!object(requests) || Object.keys(requests).some(name => !safeKey(name))) throw unavailable();
  for (const [name, request] of Object.entries(requests)) {
    if (!object(request) || Object.keys(request).some(key => !['method', 'path', 'resource_operation', 'input_schema', 'body', 'bind'].includes(key))) throw unavailable();
    const addressed = typeof request.resource_operation === 'string' && request.resource_operation.trim().length > 0
      && request.resource_operation.length <= 200 && request.resource_operation === request.resource_operation.trim();
    if (own(request, 'resource_operation') && !addressed) throw unavailable();
    if (addressed && !allowed.resource_operations.includes(request.resource_operation)) throw unavailable();
    if (addressed ? request.method !== undefined || request.path !== undefined
      : !METHODS.has(request.method) || typeof request.path !== 'string') throw unavailable();
    const scoped = addressed ? false : validateRequestPath(request.path, request.method, allowed, name).scoped;
    const { properties, required } = validateSchema(request);
    if (addressed) {
      const key = properties.request_key;
      if (!key || key.type !== 'string' || key.minLength === undefined || key.minLength < 1
        || key.maxLength === undefined || key.maxLength > 200 || !required.includes('request_key')) throw unavailable();
    }
    if (request.method === 'GET' && (Object.keys(properties).length || request.body !== undefined || request.bind !== undefined)) throw unavailable();
    const body = request.body === undefined ? {} : request.body;
    if (!object(body)) throw unavailable();
    validateTemplate(body, properties);
    const bind = request.bind ?? {};
    if (!object(bind) || Object.keys(bind).some(key => !safeKey(key) || (typeof bind[key] !== 'string' && typeof bind[key] !== 'boolean' && (typeof bind[key] !== 'number' || !Number.isFinite(bind[key]))))) throw unavailable();
    if (JSON.stringify({ ...body, ...bind }).length > 32768) throw unavailable();
    // The path itself must declare its Space scope; dynamic route placeholders are not accepted.
    if (!addressed && scoped !== request.path.includes('/:space_id/')) throw unavailable();
    void name; void required;
  }
  return true;
}

function schemaOf(request) {
  return validateSchema(request);
}

function checkedPath(path, surfaceInput, method, allowed) {
  const { scoped } = validateRequestPath(path, method, allowed);
  const hasSpace = surfaceInput && own(surfaceInput, 'space_id') && surfaceInput.space_id !== undefined && surfaceInput.space_id !== null;
  if (hasSpace && (typeof surfaceInput.space_id !== 'string' || !surfaceInput.space_id.trim() || surfaceInput.space_id.includes('/'))) throw new Error('This screen cannot make that request in this computer.');
  if (path.startsWith('/work/api/records?label=')) {
    const label = lessonPracticeLabel(surfaceInput?.space_id, surfaceInput?.course_id, surfaceInput?.lesson_id);
    if (path !== `/work/api/records?label=${encodeURIComponent(label)}`) throw unavailable();
    return path;
  }
  if (hasSpace && method === 'POST' && path === '/work/api/records') {
    lessonPracticeLabel(surfaceInput.space_id, surfaceInput.course_id, surfaceInput.lesson_id);
    return path;
  }
  if (hasSpace !== scoped) throw new Error('This screen cannot make that request in this computer.');
  return scoped ? path.replace(':space_id', encodeURIComponent(surfaceInput.space_id.trim())) : path;
}

function checkValue(value, schema) {
  const type = schema.type;
  if (type === 'null') return value === null;
  if (value === null) return schema.nullable === true;
  if (type === 'array') return Array.isArray(value) && value.length <= schema.maxItems && value.length >= (schema.minItems ?? 0)
    && Array.from({ length: value.length }, (_, index) => own(value, index) && checkValue(value[index], schema.items)).every(Boolean);
  if (type === 'object') {
    if (!plainObject(value)) return false;
    const properties = schema.properties;
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_PROPERTIES || keys.some(key => !safeKey(key) || !own(properties, key))) return false;
    if ((schema.required ?? []).some(key => !own(value, key))) return false;
    return keys.every(key => checkValue(value[key], properties[key]));
  }
  if (type === 'string' && typeof value !== 'string') return false;
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (type === 'integer' && !Number.isSafeInteger(value)) return false;
  if (type === 'boolean' && typeof value !== 'boolean') return false;
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) return false;
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) return false;
  if ((typeof value === 'number') && schema.minimum !== undefined && value < schema.minimum) return false;
  if ((typeof value === 'number') && schema.maximum !== undefined && value > schema.maximum) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  return true;
}

/** Build one fixed same-origin request from the module's named capability call. */
export function moduleSurfaceRequest(requests, name, input, surfaceInput = {}, allowed = shipped) {
  if (!object(requests) || typeof name !== 'string' || !SAFE_KEY.test(name) || !own(requests, name)) throw new Error('This screen request is unavailable.');
  const request = requests[name];
  if (!object(request)) throw new Error('This screen request is unavailable.');
  const addressed = typeof request.resource_operation === 'string' && request.resource_operation.trim().length > 0
    && request.resource_operation.length <= 200 && request.resource_operation === request.resource_operation.trim();
  if (own(request, 'resource_operation') && !addressed) throw new Error('This screen request is unavailable.');
  if (addressed) validateModuleSurfaceRequests({ [name]: request }, allowed);
  else if (!METHODS.has(request.method)) throw new Error('This screen request is unavailable.');
  const path = addressed ? '/work/api/resources/invoke' : checkedPath(request.path, surfaceInput, request.method, allowed);
  const { properties, required } = schemaOf(request);
  if (!plainObject(input ?? {})) throw new Error('This screen request is unavailable.');
  const values = input ?? {};
  let inputJson;
  try { inputJson = JSON.stringify(values); } catch { throw new Error('This screen request is unavailable.'); }
  if (typeof inputJson !== 'string' || new TextEncoder().encode(inputJson).byteLength > MAX_INPUT_BYTES) throw new Error('This screen request is unavailable.');
  if (Object.keys(values).some(key => !own(properties, key))) throw new Error('This screen request is unavailable.');
  for (const key of required) if (!own(values, key)) throw new Error('This screen request is unavailable.');
  for (const [key, value] of Object.entries(values)) if (!checkValue(value, properties[key])) throw new Error('This screen request is unavailable.');

  const fill = (value, depth = 0) => {
    if (depth > 12) throw new Error('This screen request is unavailable.');
    if (Array.isArray(value)) return value.map(one => fill(one, depth + 1));
    if (!object(value)) return value;
    if (own(value, 'from')) {
      if (Object.keys(value).length !== 1 || typeof value.from !== 'string' || !own(properties, value.from) || !own(values, value.from)) throw new Error('This screen request is unavailable.');
      return structuredClone(values[value.from]);
    }
    if (Object.keys(value).some(key => !safeKey(key))) throw new Error('This screen request is unavailable.');
    return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fill(one, depth + 1)]));
  };
  const defaultOperationInput = addressed
    ? Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'request_key')) : {};
  // Validated call values are data, never descriptor templates. A customer's
  // nested `from` property must retain its literal meaning.
  const body = request.body === undefined ? structuredClone(defaultOperationInput) : fill(request.body);
  if (!object(body)) throw new Error('This screen request is unavailable.');
  const bind = request.bind ?? {};
  if (!object(bind) || Object.keys(bind).some(key => !safeKey(key) || !['string', 'number', 'boolean'].includes(typeof bind[key]) || (typeof bind[key] === 'number' && !Number.isFinite(bind[key])))) {
    throw new Error('This screen request is unavailable.');
  }
  // Fixed descriptor bindings always win over values supplied by the module.
  Object.assign(body, bind);
  if (request.method === 'GET' && Object.keys(body).length) throw new Error('This screen request is unavailable.');
  // A route's one allowed write (sandboxed-screen-routes.json `write`) is checked whole before anything is sent.
  const write = addressed ? null : validateRequestPath(request.path, request.method, allowed).write;
  if (write !== null && write !== 'lesson-practice') throw unavailable();
  if (write === 'lesson-practice') {
    const label = lessonPracticeLabel(surfaceInput?.space_id, surfaceInput?.course_id, surfaceInput?.lesson_id);
    const write = body.writes?.[0];
    if (Object.keys(body).some(key => !['writes', 'conflict_policy'].includes(key)) || body.conflict_policy !== 'preserve'
      || !Array.isArray(body.writes) || body.writes.length !== 1 || !plainObject(write)
      || Object.keys(write).some(key => !['address_label', 'payload', 'expected_identity'].includes(key))
      || write.address_label !== label || !own(write, 'payload') || !own(write, 'expected_identity')
      || (write.expected_identity !== null && !lessonPracticeIdentity(write.expected_identity))) throw unavailable();
  }
  const envelope = addressed ? (() => {
    const address = surfaceInput?.address;
    const generation = surfaceInput?.generation;
    const requestKey = values.request_key;
    if (typeof address !== 'string' || !address.trim() || address.length > 8192
      || !(typeof generation === 'string' && generation.trim() && generation.length <= 200 || Number.isSafeInteger(generation) && generation >= 1)
      || typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 200) throw new Error('This screen request is unavailable.');
    return { address, generation, operation: request.resource_operation, request_key: requestKey, input: body };
  })() : body;
  const bodyJson = JSON.stringify(envelope);
  if (typeof bodyJson !== 'string' || new TextEncoder().encode(bodyJson).byteLength > MAX_INPUT_BYTES) throw new Error('This screen request is unavailable.');
  return {
    path,
    init: !addressed && request.method === 'GET' ? { method: 'GET' } : {
      method: addressed ? 'POST' : request.method,
      headers: { 'content-type': 'application/json',
        ...(!addressed && request.method === 'POST' && required.includes('request_key')
          ? { 'idempotency-key': values.request_key } : {}) },
      body: bodyJson,
    },
  };
}

/** Only reads are safe for automatic retry; this descriptor currently declares no write idempotency contract. */
export function moduleSurfaceRequestCanRetry(request) {
  return object(request) && request.method === 'GET';
}

/** The route identity which requires a fresh isolated module instance. */
export function moduleSurfaceScopeKey(surfaceInput = {}) {
  const keys = ['account_id', 'person_id', 'user_id', 'space_id', 'course_id', 'lesson_id', 'address', 'generation'];
  return JSON.stringify(keys.map(key => {
    const value = surfaceInput?.[key];
    return [key, value === undefined || value === null ? null
      : ['string', 'number', 'boolean'].includes(typeof value) ? value : '[invalid]'];
  }));
}

/** File bytes are exposed only for identities already present in this screen's input. */
export function moduleSurfaceMediaIdentities(surfaceInput = {}) {
  const found = new Set();
  const seen = new WeakSet();
  const pending = [{ value: surfaceInput, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 4096 && found.size < 256) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (typeof value === 'string') {
      if (CONTENT_IDENTITY.test(value)) found.add(value);
      continue;
    }
    if ((!Array.isArray(value) && !object(value)) || depth >= 12 || seen.has(value)) continue;
    seen.add(value);
    const items = Array.isArray(value) ? value.slice(0, MAX_ARRAY_ITEMS) : Object.values(value).slice(0, MAX_OBJECT_PROPERTIES);
    for (const item of items) pending.push({ value: item, depth: depth + 1 });
  }
  return found;
}

/** Construct the one-file read URL returned by the Namespace lease owner. */
export function moduleSurfaceMediaAddress(identity, lease, serviceOrigin) {
  if (typeof identity !== 'string' || !CONTENT_IDENTITY.test(identity) || typeof lease !== 'string' || !LEASE_TOKEN.test(lease)) {
    throw new Error('This screen media is unavailable.');
  }
  const origin = new URL(serviceOrigin).origin;
  return `${origin}/namespace/bytes/${encodeURIComponent(identity)}?lease=${lease}`;
}

/** Keep only import-map entries whose targets are public Trillion module files. */
export function moduleSurfaceImportMap(files, origin) {
  const imports = files?.import_map?.imports;
  if (!object(imports)) throw new Error('This screen could not open.');
  const kept = {};
  for (const [name, address] of Object.entries(imports)) {
    if (typeof name !== 'string' || typeof address !== 'string') continue;
    let url;
    try { url = new URL(address, origin); } catch { continue; }
    if (url.origin !== origin || !(url.pathname.startsWith('/workspace/') || url.pathname.startsWith('/workshop/modules/'))) continue;
    kept[name] = url.href;
  }
  return { imports: kept };
}

export function savedScreenModuleAddress(bundle, file, origin) {
  if (typeof bundle !== 'string' || !/^1f:[0-9a-f]{64}$/.test(bundle) || typeof file !== 'string' || !file || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._~-]+$/.test(part))) {
    throw new Error('This screen could not open.');
  }
  return new URL(`/workshop/modules/${encodeURIComponent(bundle)}/${file.split('/').map(encodeURIComponent).join('/')}`, origin).href;
}
