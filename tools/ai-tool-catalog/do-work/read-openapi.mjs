// parts/ai-tool-catalog/do-work/read-openapi.mjs
//
// Purpose
//   An API's own description (OpenAPI 3.x, or Swagger 2.0, as JSON) as list entries a `tool-row-source` pours into tool
//   rows: one entry per operation, carrying the request it makes in the request grammar the Workshop's http executor
//   reads (src/workshop.mjs buildInvocation): the address with its path parameters as holes, the query parameters as
//   `{ from, optional }` leaves, the JSON body as one `body` input, and an input schema built from the parameters. So an
//   API with a description is one source row, and every operation in it is a tool nobody typed.
//
// Non-negotiable invariants
//   1. Blind: nothing here names an API, a host or an operation; everything comes from the description.
//   2. Only what the description says: an operation's job is its own summary or description; a licence is the one the
//      description declares (`info.license`), else null; nothing is guessed.
//   3. A local `$ref` is followed (depth-bounded, cycles cut); a reference outside the document is left as an open
//      schema with its address as the description, never fetched.
//   4. A person's key is never in an entry: an operation that asks for an API key or a bearer token in a header gets
//      `credential_injections` naming the connection field the source row names, so the locked box places the value.
//      A scheme it cannot place (a key in the query or a cookie, OAuth flows) is named in `held_back` with why. A header
//      the source row sends on every request (`headers`, never a secret: an identifying User-Agent, an Accept) satisfies
//      a scheme that asks only for that header.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const MAX_DEPTH = 6;

/** The value a local reference (`#/a/b`) points at in the document, or null. */
function pointer(document, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((at, part) => (object(at) || Array.isArray(at) ? at[part] : undefined), document) ?? null;
}

/** A value with every local reference followed, at most MAX_DEPTH references deep; a cycle or a deeper one becomes an open schema. */
export function resolved(document, value, depth = 0, seen = new Set()) {
  if (Array.isArray(value)) return value.map(item => resolved(document, item, depth, seen));
  if (!object(value)) return value;
  if (typeof value.$ref === 'string') {
    const target = pointer(document, value.$ref);
    if (!target) return { description: `Described at ${value.$ref}` };
    if (seen.has(value.$ref) || depth >= MAX_DEPTH) return { description: `See ${value.$ref.split('/').pop()}` };
    const { $ref, ...rest } = value;
    return { ...resolved(document, target, depth + 1, new Set([...seen, $ref])), ...resolved(document, rest, depth, seen) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolved(document, item, depth, seen)]));
}

// The JSON Schema keywords an input field keeps: enough for an AI to fill it and for the Workshop to check it.
const KEPT = ['type', 'enum', 'format', 'description', 'items', 'properties', 'required', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'default', 'oneOf', 'anyOf', 'allOf', 'additionalProperties', 'examples'];
function schemaOf(value) {
  if (!object(value)) return {};
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => KEPT.includes(key)));
  // OpenAPI 3.1 writes nullable as a type list; the Workshop's checker reads one type, so a list keeps only its schema.
  if (Array.isArray(kept.type)) delete kept.type;
  for (const key of ['items', 'additionalProperties']) if (object(kept[key])) kept[key] = schemaOf(kept[key]);
  if (object(kept.properties)) kept.properties = Object.fromEntries(Object.entries(kept.properties).map(([name, item]) => [name, schemaOf(item)]));
  for (const key of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(kept[key])) kept[key] = kept[key].map(schemaOf);
  return kept;
}

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const sentence = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Where the API answers: the first server the description names (3.x), or its host and base path (2.0). */
export function serverOf(document, descriptionUrl = null) {
  const first = Array.isArray(document.servers) ? document.servers[0] : null;
  if (first?.url) {
    const url = String(first.url).replace(/\{(\w+)\}/g, (_, name) => String(first.variables?.[name]?.default ?? ''));
    return descriptionUrl ? new URL(url, descriptionUrl).href.replace(/\/$/, '') : url.replace(/\/$/, '');
  }
  if (document.host) return `${(document.schemes ?? ['https'])[0]}://${document.host}${document.basePath ?? ''}`.replace(/\/$/, '');
  return descriptionUrl ? new URL('/', descriptionUrl).href.replace(/\/$/, '') : null;
}

/**
 * Every operation in a description as a list entry, and the operations held back with why.
 * options: { url (the description's own address, to resolve a relative server), connection: { connection_id, field_id }
 * (the connection field a key or token is placed from), only: [operation ids] (when the source lists only some),
 * headers: { name: value } (sent on every request as written; a scheme asking only for one of them is satisfied) }.
 */
export function openapiEntries(document, { url = null, connection = null, only = null, headers: fixed = {} } = {}) {
  const sent = new Set(Object.keys(fixed).map(name => name.toLowerCase()));
  if (!object(document) || !object(document.paths) || !(document.openapi || document.swagger)) throw new Error('This is not an OpenAPI or Swagger description: it has no openapi or swagger version and no paths.');
  const server = serverOf(document, url);
  if (!server) throw new Error('The description names no server to send requests to.');
  const schemes = object(document.components?.securitySchemes) ? document.components.securitySchemes : object(document.securityDefinitions) ? document.securityDefinitions : {};
  const licence = sentence(document.info?.license?.identifier || document.info?.license?.name) || null;
  const entries = [];
  const held_back = [];
  const ids = new Set();
  for (const [path, item] of Object.entries(document.paths)) {
    if (!object(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS.filter(name => object(item[name]))) {
      const operation = item[method];
      const id = slug(operation.operationId || `${method} ${path}`);
      if (only && !only.includes(operation.operationId) && !only.includes(id)) continue;
      if (operation.deprecated === true) { held_back.push({ operation: id, reasons: ['the description marks it deprecated'] }); continue; }
      if (ids.has(id)) { held_back.push({ operation: id, reasons: ['another operation already has this id'] }); continue; }
      const reasons = [];
      // Operation parameters override path-level ones of the same name and place.
      const byKey = new Map();
      for (const raw of [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
        const parameter = resolved(document, raw);
        if (object(parameter) && parameter.name && parameter.in) byKey.set(`${parameter.in}:${parameter.name}`, parameter);
      }
      const properties = {};
      const required = [];
      const query = {};
      const headers = {};
      for (const parameter of byKey.values()) {
        if (parameter.in === 'body') continue;
        if (parameter.in === 'cookie') { if (parameter.required) reasons.push(`it needs the cookie ${parameter.name}`); continue; }
        const name = parameter.name;
        const schema = schemaOf(object(parameter.schema) ? resolved(document, parameter.schema) : parameter);
        properties[name] = { ...schema, ...(parameter.description ? { description: sentence(parameter.description) } : {}) };
        const needed = parameter.in === 'path' || parameter.required === true;
        if (needed) required.push(name);
        if (parameter.in === 'query') query[name] = { from: name, ...(needed ? {} : { optional: true }) };
        if (parameter.in === 'header') headers[name] = { from: name, ...(needed ? {} : { optional: true }) };
      }
      let body;
      const content = object(operation.requestBody) ? resolved(document, operation.requestBody) : null;
      const bodyParameter = [...byKey.values()].find(parameter => parameter.in === 'body');
      const json = content ? Object.entries(content.content ?? {}).find(([type]) => /json/i.test(type))?.[1] : null;
      if (content && !json) reasons.push(`its body is ${Object.keys(content.content ?? {}).join(', ') || 'not described'}, not JSON`);
      if (json || bodyParameter) {
        const bodySchema = schemaOf(resolved(document, (json ?? bodyParameter).schema ?? {}));
        properties.body = { ...bodySchema, description: sentence(content?.description || bodyParameter?.description || 'The request body') };
        const bodyNeeded = Boolean(content?.required || bodyParameter?.required);
        if (bodyNeeded) required.push('body');
        body = { from: 'body', ...(bodyNeeded ? {} : { optional: true }) };
      }
      // A key or token the operation (or the whole API) asks for, placed from the person's connection by the locked box.
      const security = Array.isArray(operation.security) ? operation.security : Array.isArray(document.security) ? document.security : [];
      const injections = [];
      const options = security.filter(object);
      const satisfied = option => Object.keys(option).every(name => schemes[name]?.in === 'header' && sent.has(String(schemes[name].name).toLowerCase()));
      const usable = options.find(option => Object.keys(option).length === 0 || satisfied(option))
        ?? options.find(option => Object.keys(option).every(name => placementOf(schemes[name])));
      if (options.length && !usable) reasons.push(`it signs in with ${options.map(option => Object.keys(option).join(' and ')).join(' or ')}, which is not a key or token in a header`);
      else if (usable && Object.keys(usable).length && !satisfied(usable)) {
        if (!connection?.connection_id || !connection?.field_id) reasons.push('it needs a key, and the source row names no connection to take it from');
        else for (const name of Object.keys(usable)) injections.push({ field_id: connection.field_id, placement: placementOf(schemes[name]) });
      }
      if (reasons.length) { held_back.push({ operation: id, reasons }); continue; }
      ids.add(id);
      const named = sentence(String(operation.operationId ?? '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
      const label = sentence(operation.summary) || (named ? named[0].toUpperCase() + named.slice(1) : `${method.toUpperCase()} ${path}`);
      entries.push({
        operation: id,
        label,
        job: sentence(operation.description || operation.summary) || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        url: `${server}${path}`,
        input_schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        query: Object.keys(query).length ? query : undefined,
        headers: Object.keys(headers).length || sent.size ? { ...Object.fromEntries(Object.entries(fixed).map(([name, value]) => [name, { const: String(value) }])), ...headers } : undefined,
        body,
        changes_something: !['get', 'head', 'options'].includes(method),
        ...(injections.length ? { connection_id: connection.connection_id, credential_injections: injections } : {}),
        licence,
        api: sentence(document.info?.title) || new URL(server).host,
        page: operation.externalDocs?.url ?? document.externalDocs?.url ?? null,
      });
    }
  }
  return { entries, held_back, licence, api: sentence(document.info?.title) || null };
}

/** Where a security scheme's value goes in a request, when it is a header the box can place; null otherwise. */
export function placementOf(scheme) {
  if (!object(scheme)) return null;
  if (scheme.type === 'apiKey' && scheme.in === 'header' && scheme.name) return { kind: 'header', name: scheme.name, prefix: '' };
  if (scheme.type === 'http' && String(scheme.scheme).toLowerCase() === 'bearer') return { kind: 'header', name: 'Authorization', prefix: 'Bearer ' };
  return null;
}
