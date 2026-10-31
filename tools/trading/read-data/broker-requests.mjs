// tools/trading/read-data/broker-requests.mjs
//
// How one order becomes one broker request, and one broker answer becomes the order's real state, with every broker
// difference held in the person's route (DATA), never in this file. Pure: no network, no clock, no held value is read
// here; the seam (trading.mjs) hands in the credentials and the time and sends what this file builds.
//
// A route is one broker account in one mode:
//   {
//     mode: "paper" | "live",
//     instrument_requests: { <instrument.kind> | "default": { url, method?, headers?, body_template?, body_encoding? } },
//     credential_injections: [{ field, placement: { kind: "header" | "query", name, prefix? } }],
//     signed_headers?: [{ header, scheme: "hmac-sha256", key_field, key_encoding?, output_encoding?, message, with_headers? }],
//     response_map: { broker_order_id, broker_status, filled_qty, filled_avg_price, filled_at, <any other name> },
//     status_map: { <broker status>: <order status>, "__default__"? },
//     status_request?: { url, method?, headers? },
//     open_statuses?: [<order status>, ...],
//     lookups?: { <name>: { url, method?, headers?, query?, query_names?, items_at?, one_item?, id_field?, keep_when?, numbers?,
//                           whole_numbers?, keep_fields?, sort_by?, next_at? } },
//     timeout_ms?
//   }
//
// Invariants:
// - No broker, instrument or mode is named in code: a new broker, a new kind of instrument, or paper next to live is
//   a new route.
// - A template hole that does not resolve refuses the request; nothing is sent with a hole left empty.
// - Fills are the broker's: filled_qty, filled_avg_price and filled_at come only from the answer, through the route's
//   response_map, and a queued order reads 0 filled, never an invented fill.
// - Held values go only into the request this file hands back; the copy kept on record (`shown`) has the address
//   before any credential query and the header names without their values.
import { createHmac } from 'node:crypto';
import { asciiJson, atPath, isObject, listOf, missing, numberOf, objectOf } from './values.mjs';

const OMIT = Symbol('omit');
const DEFAULT_TIMEOUT_MS = 30000;

/** Read the fact a string hole names; a string hole is always required. */
function required(facts, path, template) {
  const value = atPath(facts, path);
  if (value === null) {
    throw new Error(`template hole {${path}} in ${JSON.stringify(template)} did not resolve, and a string hole is always required. Give the fact, or write it as {"from": "${path}", "optional": true} or with an "otherwise" fallback.`);
  }
  return value;
}

// A fact placed inside a web address, escaped for an address with "/" kept.
const forAnAddress = text => encodeURIComponent(text).replace(/%2F/g, '/').replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const asText = value => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : JSON.stringify(value));

/**
 * Resolve a template against facts. Two leaf forms mean the same thing:
 *   "{qty}"                                  a string hole: alone it gives the typed value, inside text it is substituted
 *   { "const": v }                           this value
 *   { "from": "a.path" }                     this fact, required
 *   { "from": "a.path", "optional": true }   leave the field out when the fact is absent
 *   { "from": "a.path", "otherwise": leaf }  fall back to the next leaf
 * `encode` escapes substituted text (addresses use it; bodies do not).
 */
export function resolveTemplate(node, facts, encode = null) {
  if (isObject(node)) {
    const keys = Object.keys(node);
    if (keys.length === 1 && keys[0] === 'const') return node.const;
    if (keys.includes('from') && keys.every(key => ['from', 'optional', 'otherwise'].includes(key))) {
      const value = atPath(facts, node.from);
      if (value !== null) return value;
      if (Object.hasOwn(node, 'otherwise')) return resolveTemplate(node.otherwise, facts, encode);
      if (node.optional === true) return OMIT;
      throw new Error(`template field {from: ${node.from}} did not resolve, and it is neither optional nor given a fallback`);
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      const resolved = resolveTemplate(value, facts, encode);
      if (resolved !== OMIT) out[key] = resolved;
    }
    return out;
  }
  if (Array.isArray(node)) return node.map(item => resolveTemplate(item, facts, encode)).filter(item => item !== OMIT);
  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.split('{').length === 2) return required(facts, trimmed.slice(1, -1), node);
    return node.replace(/\{([^{}]+)\}/g, (_, path) => {
      const text = asText(required(facts, path, node));
      return encode ? encode(text) : text;
    });
  }
  return node;
}

// A nested object as bracket form pairs: { a: { b: 1 } } -> [["a[b]", "1"]]; lists by index; null left out.
function formPairs(node, prefix = '') {
  if (isObject(node)) return Object.entries(node).flatMap(([key, value]) => formPairs(value, prefix ? `${prefix}[${key}]` : key));
  if (Array.isArray(node)) return node.flatMap((value, index) => formPairs(value, prefix ? `${prefix}[${index}]` : String(index)));
  if (node === null || node === undefined) return [];
  return [[prefix, typeof node === 'boolean' ? String(node) : asText(node)]];
}

const formWord = text => encodeURIComponent(text).replace(/%20/g, '+').replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** The body as the text sent and its content type, in the encoding the route names ("json" or "form"). */
export function encodeBody(body, encoding = 'json') {
  if (body === null || body === undefined) return { text: null, contentType: null };
  if (encoding === 'form') {
    return { text: formPairs(body).map(([key, value]) => `${formWord(key)}=${formWord(value)}`).join('&'), contentType: 'application/x-www-form-urlencoded' };
  }
  if (encoding !== 'json') throw new Error(`body_encoding ${encoding} is not one this tool writes; use "json" or "form"`);
  return { text: asciiJson(body), contentType: 'application/json' };
}

const hasHeader = (headers, name) => Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase());

/** Fold computed headers into base headers: each entry's with_headers, then its signature; last wins; empty values never. */
export function mergeHeaders(base, computed) {
  const merged = { ...objectOf(base) };
  const put = (name, value) => {
    if (typeof name !== 'string' || name === '' || value === undefined || value === null || value === '') return;
    merged[name] = value;
  };
  for (const entry of listOf(computed)) {
    if (!isObject(entry)) continue;
    for (const [name, value] of Object.entries(objectOf(entry.with_headers))) put(name, value);
    put(entry.header_name, entry.signature);
  }
  return merged;
}

/** The value of one held field; a route that names a field the held credentials lack is refused by name only. */
function heldField(held, field, heldName) {
  if (typeof field !== 'string' || !Object.hasOwn(objectOf(held), field) || typeof held[field] !== 'string' || held[field] === '') {
    throw new Error(`the route needs the field "${field}" of the held value ${heldName}, and it has no such field`);
  }
  return held[field];
}

const KEY_ENCODINGS = { utf8: 'utf8', base64: 'base64', hex: 'hex' };
const OUTPUT_ENCODINGS = { hex: 'hex', base64: 'base64', base64url: 'base64url' };

/** One signed header per route signed_headers entry, signed with a held field over the route's message template. */
function signHeaders(route, facts, held, heldName) {
  return listOf(route.signed_headers).map(entry => {
    if (entry.scheme !== 'hmac-sha256') throw new Error(`signed header ${entry.header} uses scheme ${entry.scheme}; this tool signs hmac-sha256 only`);
    const keyEncoding = KEY_ENCODINGS[entry.key_encoding ?? 'utf8'];
    const outputEncoding = OUTPUT_ENCODINGS[entry.output_encoding ?? 'hex'];
    if (!keyEncoding || !outputEncoding) throw new Error(`signed header ${entry.header}: key_encoding is utf8, base64 or hex and output_encoding is hex, base64 or base64url`);
    const key = Buffer.from(heldField(held, entry.key_field, heldName), keyEncoding);
    const message = resolveTemplate(entry.message, facts);
    if (typeof message !== 'string') throw new Error(`signed header ${entry.header}: message must resolve to text`);
    return {
      header_name: entry.header,
      signature: createHmac('sha256', key).update(message, 'utf8').digest(outputEncoding),
      with_headers: resolveTemplate(objectOf(entry.with_headers), facts),
    };
  });
}

/**
 * Put the credentials and signatures on a request. `request` is { url, method, headers, body }; the answer is
 * { send: the request with held values, shown: the request as it may be kept }.
 */
export function withCredentials(request, route, held, { heldName, now }) {
  const headers = { ...request.headers };
  const address = new URL(request.url);
  for (const { field, placement } of listOf(route.credential_injections)) {
    const value = `${placement?.prefix ?? ''}${heldField(held, field, heldName)}`;
    if (placement?.kind === 'header' && !missing(placement.name)) headers[placement.name] = value;
    else if (placement?.kind === 'query' && !missing(placement.name)) address.searchParams.set(placement.name, value);
    else throw new Error(`credential placement for field "${field}" must be { kind: "header" | "query", name }`);
  }
  const facts = {
    ...request.facts,
    request: { method: request.method, path: address.pathname, path_and_query: `${address.pathname}${address.search}`, body: request.body ?? '' },
    now: { seconds: String(Math.floor(now / 1000)), milliseconds: String(now) },
  };
  const send = { url: address.href, method: request.method, headers: mergeHeaders(headers, signHeaders(route, facts, held, heldName)), body: request.body, timeout_ms: request.timeout_ms };
  const shown = { url: request.url, method: request.method, header_names: Object.keys(send.headers).sort(), body: request.body };
  return { send, shown };
}

/** The route's request for one order: { url, method, headers, body (text or null), facts, timeout_ms }. */
export function orderRequest(order, route) {
  const mappings = objectOf(route.instrument_requests);
  const kind = order.instrument?.kind;
  const mapping = objectOf(Object.hasOwn(mappings, kind ?? '') ? mappings[kind] : mappings.default);
  if (missing(mapping.url)) throw new Error(`the route has no instrument_requests entry for kind ${kind ?? '(none)'} and no default`);
  const url = resolveTemplate(mapping.url, order, forAnAddress);
  const headers = Object.fromEntries(Object.entries(mapping.headers ?? { accept: 'application/json' })
    .map(([name, value]) => [name, typeof value === 'string' ? resolveTemplate(value, order) : value]));
  const body = mapping.body_template === undefined ? null : resolveTemplate(mapping.body_template, order);
  const { text, contentType } = encodeBody(body, mapping.body_encoding ?? route.body_encoding ?? 'json');
  if (contentType && !hasHeader(headers, 'content-type')) headers['content-type'] = contentType;
  return { url, method: (mapping.method ?? 'POST').toUpperCase(), headers, body: text, facts: { order }, timeout_ms: route.timeout_ms ?? DEFAULT_TIMEOUT_MS };
}

/** The route's request for one order's current state at the broker (status_request.url holes read the order record). */
export function statusRequest(order, route) {
  const status = objectOf(route.status_request);
  if (missing(status.url)) throw new Error('the route has no status_request.url, so placed orders cannot be checked');
  return {
    url: resolveTemplate(status.url, order, forAnAddress),
    method: (status.method ?? 'GET').toUpperCase(),
    headers: { ...(status.headers ?? { accept: 'application/json' }) },
    body: null,
    facts: { order },
    timeout_ms: route.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  };
}

/** The route's request for one named lookup, with the caller's query on the lookup's defaults. */
export function lookupRequest(route, name, query) {
  const lookup = objectOf(objectOf(route.lookups)[name]);
  if (missing(lookup.url)) throw new Error(`the route has no lookup named ${name}; its lookups are ${Object.keys(objectOf(route.lookups)).join(', ') || '(none)'}`);
  const allowed = Array.isArray(lookup.query_names) ? new Set(lookup.query_names) : null;
  const refused = Object.keys(objectOf(query)).filter(key => allowed && !allowed.has(key));
  if (refused.length) throw new Error(`lookup ${name} takes the query names ${[...allowed].join(', ')}, not ${refused.join(', ')}`);
  const address = new URL(lookup.url);
  for (const [key, value] of Object.entries({ ...objectOf(lookup.query), ...objectOf(query) })) {
    if (!missing(value)) address.searchParams.set(key, asText(value));
  }
  return { url: address.href, method: (lookup.method ?? 'GET').toUpperCase(), headers: { ...(lookup.headers ?? { accept: 'application/json' }) }, body: null, facts: {}, timeout_ms: route.timeout_ms ?? DEFAULT_TIMEOUT_MS };
}

/** The answer's body: its JSON when it is JSON, else its text. */
export function bodyOf(text) {
  if (typeof text !== 'string') return text ?? null;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * The order's real state from a broker answer the broker accepted (HTTP 2xx), read through the route's response_map
 * and status_map. Every response_map name is an answer field; the order status is status_map[broker_status], else
 * "filled" when the answer shows a fill with a price, else status_map.__default__, else "submitted".
 */
export function readOrderAnswer(answer, route) {
  const body = bodyOf(answer.body);
  const fields = isObject(body) ? body : {};
  const responseMap = objectOf(route.response_map);
  const statusMap = objectOf(route.status_map);
  const out = Object.fromEntries(Object.entries(responseMap).map(([name, where]) => [name, atPath(fields, where)]));
  const brokerStatus = atPath(fields, responseMap.broker_status);
  const filledQty = numberOf(atPath(fields, responseMap.filled_qty)) ?? 0;
  const filledAvgPrice = numberOf(atPath(fields, responseMap.filled_avg_price));
  const mapped = typeof brokerStatus === 'string' && Object.hasOwn(statusMap, brokerStatus) ? statusMap[brokerStatus] : null;
  const status = mapped ?? (filledQty && filledAvgPrice !== null ? 'filled' : statusMap.__default__ ?? 'submitted');
  return {
    ...out,
    broker_order_id: atPath(fields, responseMap.broker_order_id),
    broker_status: brokerStatus,
    filled_qty: filledQty,
    filled_avg_price: filledAvgPrice,
    filled_at: atPath(fields, responseMap.filled_at),
    status,
    http_status: answer.status_code,
  };
}

/**
 * The items of a lookup answer: the list at items_at (or the answer itself when it is a list, or when one_item says it is one object), only objects that
 * carry id_field and match every keep_when field, numbers and whole_numbers read as numbers, only keep_fields kept,
 * sorted by sort_by.field (missing values last), and the next page token at next_at.
 */
export function readLookupAnswer(answer, lookup) {
  const body = bodyOf(answer.body);
  // one_item: the answer is one object (an account) and is read as a list of one.
  const list = Array.isArray(body) ? body : lookup.one_item === true ? [isObject(body) ? body : null] : atPath(body, lookup.items_at);
  const keepWhen = objectOf(lookup.keep_when);
  const items = listOf(list).filter(item => isObject(item)
    && (missing(lookup.id_field) || !missing(item[lookup.id_field]))
    && Object.entries(keepWhen).every(([field, value]) => item[field] === value))
    .map(item => {
      const kept = Array.isArray(lookup.keep_fields) ? Object.fromEntries(lookup.keep_fields.map(field => [field, item[field] ?? null])) : { ...item };
      for (const field of listOf(lookup.numbers)) if (Object.hasOwn(kept, field)) kept[field] = numberOf(kept[field]);
      for (const field of listOf(lookup.whole_numbers)) if (Object.hasOwn(kept, field)) { const read = numberOf(kept[field]); kept[field] = read === null ? null : Math.trunc(read); }
      return kept;
    });
  const sortBy = objectOf(lookup.sort_by);
  if (!missing(sortBy.field)) {
    const sign = sortBy.order === 'ascending' ? 1 : -1;
    items.sort((a, b) => {
      const [x, y] = [numberOf(a[sortBy.field]), numberOf(b[sortBy.field])];
      if (x === null || y === null) return (x === null) - (y === null);
      return sign * (x - y);
    });
  }
  return { items, count: items.length, next: isObject(body) ? atPath(body, lookup.next_at) : null };
}
