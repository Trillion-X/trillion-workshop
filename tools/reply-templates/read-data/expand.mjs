// tools/reply-templates/read-data/expand.mjs
//
// Fills a reply template with what the caller gives. A template is any JSON: objects, lists and plain values are kept
// as they are, and a binding, an object { "$kind": "binding", "select": { "from": "dataSource", "key", "path" },
// "default" }, is replaced by the value it selects. Invariants:
//   - The output is whatever shape the template has. No kind of reply is known here, so a button, a line of text and a
//     clip reference expand by the same rule.
//   - The data sources are provider_record, caller_request, data, and each top-level entry of data by its own name.
//   - A binding that selects nothing gives its default, else null, whether or not select.required is set: the old
//     compiler treated a missing required value as recoverable too.
//   - An object key named itemTemplate is passed through unexpanded: its bindings belong to the item loop that fills it.
//   - A template that is present but null is a template: the reply is null.
//   - What this file does not do is refused by name (another source, a transform), never skipped.

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function parsePath(path) {
  if (Array.isArray(path)) return path;
  if (typeof path !== 'string') throw new Error('select.path must be a dotted string or a list of steps');
  return path === '' ? [] : path.split('.');
}

function step(value, key) {
  if (Array.isArray(value)) return /^\d+$/.test(String(key)) ? value[Number(key)] : undefined;
  if (isObject(value) && Object.hasOwn(value, key)) return value[key];
  return undefined;
}

function sourcesOf(request) {
  const sources = new Map([
    ['provider_record', request.provider_record ?? null],
    ['caller_request', request.caller_request ?? null],
    ['data', request.data ?? null],
  ]);
  if (isObject(request.data)) for (const [key, value] of Object.entries(request.data)) sources.set(key, value);
  return sources;
}

function select(spec, sources) {
  if (!isObject(spec)) throw new Error('a binding needs a select');
  if (spec.from !== 'dataSource') throw new Error(`select.from "${spec.from}" is not supported here: a template reads only from dataSource`);
  const key = isObject(spec.key) ? expand(spec.key, sources) : spec.key;
  if (typeof key !== 'string' || key === '') throw new Error('select.key must name a data source');
  const missing = Symbol('missing');
  let value = sources.has(key) ? sources.get(key) : missing;
  if (value !== missing) {
    for (const part of spec.path === undefined ? [] : parsePath(spec.path)) {
      value = step(value, part);
      if (value === undefined) { value = missing; break; }
    }
  }
  if (value === missing) {
    return missing;
  }
  return value;
}

function expand(node, sources) {
  if (Array.isArray(node)) return node.map((child) => expand(child, sources));
  if (!isObject(node)) return node;
  if (node.$kind === 'binding') {
    if (node.transform !== undefined) throw new Error('a binding with transform is not supported here: bind the value and change it before it is given');
    const found = node.select === undefined ? Symbol.for('missing') : select(node.select, sources);
    if (typeof found === 'symbol') return node.default === undefined ? null : node.default;
    return found;
  }
  return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, key === 'itemTemplate' ? child : expand(child, sources)]));
}

/** The reply: the request's template (else the provider record's template) with every binding filled. */
export function expandReplyTemplate(request) {
  if (!isObject(request)) throw new Error('give a request object');
  const record = request.provider_record;
  const template = request.template ?? (isObject(record) && Object.hasOwn(record, 'template') ? record.template : undefined);
  if (template === undefined) throw new Error('give a template: request.template or request.provider_record.template is required');
  return expand(template, sourcesOf(request));
}
