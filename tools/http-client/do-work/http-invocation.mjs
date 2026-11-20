// Generic invocation renderer and HTTP executor, adapted from the retained
// Workshop source. Source identities and qualified deltas live in ports/http-invocation.json.
// Hosts supply a public/DNS-checked transport and the connection owner's send/keep;
// this module never resolves a credential, retries a failed send, or logs payloads.
import { NotPublicAddress, fetchPublic, publicAddress, readResponseBytes, ResponseBytesExceeded } from '../../refuse-requests-to-private-addresses/public-address.mjs';
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const MAX_SAVED_BYTES = 20 * 1024 * 1024;
// The original imported this pure byte formatter from @noble/hashes/utils.js.
const bytesToHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export class WorkshopError extends Error {
  constructor(message, next_call = null, missing_connection = null) { super(message); this.next_call = next_call; this.missing_connection = missing_connection; }
}
// The request_key a caller sends, kept under the place it was sent from (a pursuit's grant, ...). It is checked as the
// caller sent it: a missing, empty or non-text key would otherwise become nonempty text once prefixed, and two such
// calls would share one task.
export function scopedRequestKey(scope, request_key) {
  if (!nonempty(request_key)) throw new WorkshopError('request_key is required: any unique text. Sending the same request_key again returns the same task instead of running twice.');
  return `${scope}:${request_key}`;
}
// A request that charges, calls or messages someone and was not sent (again): `effect_state` is the ledger's state for
// it (unknown, dispatching, succeeded), or 'in-flight' when this host is sending it right now.
class EffectNotSent extends Error {
  constructor(message, effect_state) { super(message); this.effect_state = effect_state; }
}
// A request refused before anything was sent, and a reply the service answered with: both say nothing happened.
const notSent = message => Object.assign(new Error(message), { not_sent: true });

// The part of JSON Schema a tool contract uses. Written without code generation, because the hosted runtime
// forbids it. Keywords it does not know are ignored rather than guessed at.
// Only a missing top-level declared field can be collected through the durable Workshop seam. Nested requirements
// are grouped under their declared top-level object, while invalid values and undeclared fields remain refusals.
function pendingInputFields(problems, schema) {
  if (!problems.length || !object(schema?.properties)) return null;
  const missing = [];
  for (const problem of problems) {
    const match = /^input\.([^.\[ ]+)(?:\..*)? is required$/.exec(problem);
    if (!match || !Object.hasOwn(schema.properties, match[1])) return null;
    const field = schema.properties[match[1]];
    if (!object(field) || field.writeOnly === true) return null;
    if (!missing.includes(match[1])) missing.push(match[1]);
  }
  return missing.length ? missing : null;
}

// Turn a tool's `invoke` DATA into the concrete call. An object whose only key is `fill` is replaced by a value:
//   { "fill": { "from": "input" } }                                   the whole call input
//   { "fill": { "from": "input", "field": "audio_url" } }             one input field
//   { "fill": { "from": "input", "field": "audio_url", "fetch": "base64" } }   the bytes at that address, base64
//   { "fill": { "from": "task", "field": "request_key" } }            a field of the task
// Callers may name more sources (`extra`), for example the tool row and the last input for an outcome notice.
// Everything else is copied as written.
//
// A tool's request (`request: true`) also reads the grammar other packages' notes are written in, the one
// trade-order's assemble-order-request.py owns (its tests are this port's conformance list). It applies only to
// the request's url, headers and body, and reads facts from the call input:
//   "{a.b}"                                    the whole value: that input fact, keeping its type; required
//   "https://x/{a}/y"                          a hole inside text: substituted (escaped when in the url); required
//   { "const": value }                         this value
//   { "from": "a.b" }                          that input fact; required (a list is walked by position: "things.0.label")
//   { "from": "a.b", "optional": true }        the field is left out when the fact is absent
//   { "from": "a.b", "otherwise": <leaf> }     the next leaf when the fact is absent
//   { "$when": "a.b", "value": <leaf> }         the leaf is left out when the fact is absent
//   { "$time": { "hours": -24 } }              when the run started, moved by days, hours and minutes, as an ISO time
//                                              ("as": "date" gives YYYY-MM-DD), so a scheduled read names its own window
// `query` ({ name: leaf }) is read the same way and added to the address as its query string, a list as repeated
// names; a name whose leaf is left out is not sent.
// (`body_template` is the notes' own name for the body and is read the same way.)
// and `credential_injections` and `credential_mounts` become the names the locked box holds: `secret_name` (or
// `vault_key`) as written, else the service-connections name for `connection_id` + `field_id`.
// `connection: { vendor, from_input }` (the form the container rows use) takes the connection the caller names in input
// (`connection_id`: service_connection:<vendor> or service_connection:<vendor>:<account>) in place of a fixed `connection_id`.
// `argv` (a container tool's command) reads the same `{ from }` leaves, but its text is passed as written: a braced
// word in a command is the command's, never a hole.
const REQUEST_FIELDS = { url: 'address', headers: 'text', body: 'text', body_template: 'text', query: 'text', argv: 'as-written' };
const OMIT = Symbol('left out');
const TIME_STEPS = { days: 86_400_000, hours: 3_600_000, minutes: 60_000 };
function timeFrom(started, { as, ...moves }) {
  const unknown = Object.keys(moves).filter(name => !TIME_STEPS[name] || !Number.isFinite(moves[name]));
  if (unknown.length) throw new WorkshopError(`$time moves by days, hours and minutes (numbers); ${unknown.join(', ')} is not one of them.`);
  const at = new Date(started + Object.entries(moves).reduce((sum, [name, count]) => sum + count * TIME_STEPS[name], 0)).toISOString();
  return as === 'date' ? at.slice(0, 10) : at;
}
// A path walks objects by key and lists by position ("things.0.address": the first thing's address).
const factAt = (facts, path) => String(path).split('.').reduce((at, part) => (object(at) && Object.hasOwn(at, part) ? at[part] : Array.isArray(at) && /^\d+$/.test(part) ? at[Number(part)] : undefined), facts);
function requiredFact(facts, path) {
  const value = factAt(facts, path);
  if (value === undefined || value === null) throw new WorkshopError(`The request needs input.${path}, and it was not given.`);
  return value;
}
const percent = char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
const forAnAddress = (text, inPath) => {
  if (inPath && (text.startsWith('/') || text.split('/').some(part => part === '.' || part === '..'))) {
    throw new WorkshopError('An address path must stay inside the named resource.');
  }
  const encoded = encodeURIComponent(text).replace(/[!'()*]/g, percent);
  return inPath ? encoded.replace(/%2F/g, '/') : encoded;
};
function fillHoles(text, facts, zone) {
  const whole = text.trim();
  if (whole.startsWith('{') && whole.endsWith('}') && whole.split('{').length === 2) return requiredFact(facts, whole.slice(1, -1));
  const pathEnd = Math.min(...[text.indexOf('?'), text.indexOf('#')].filter(at => at >= 0), text.length);
  return text.replace(/\{([^{}]+)\}/g, (_, path, at) => {
    const value = String(requiredFact(facts, path));
    return zone === 'address' ? forAnAddress(value, at < pathEnd) : value;
  });
}
const hexOf = text => bytesToHex(new TextEncoder().encode(String(text ?? '')));
// The name the locked box keeps one field of one connection under (service-connections' naming rule).
export const connectionFieldName = (connectionId, fieldId) => `service-connection-${hexOf(connectionId)}-field-${hexOf(fieldId)}`;
// A request that says `before_you_have_a_secret` (opening an account, handing back a code) places none, exactly as
// service-connections' own performer (follow-one-written-note-now.py) does.
const heldName = (invoke, item) => (nonempty(item.secret_name) ? item.secret_name : nonempty(item.vault_key) ? item.vault_key : connectionFieldName(invoke.connection_id, item.field_id));
const heldItems = (invoke, field) => (invoke?.before_you_have_a_secret === true || !Array.isArray(invoke?.[field]) ? [] : invoke[field]);
export function credentialInjections(invoke) {
  return heldItems(invoke, 'credential_injections').map(item => ({ secret_name: heldName(invoke, item), placement: item.placement }));
}
// Values a container tool reads as files (`invoke.credential_mounts: [{ field_id | secret_name, mount_path }]`, the
// credentials vault's `resolve-one-credential-mount` input shape), named the same way.
export function credentialMounts(invoke) {
  return heldItems(invoke, 'credential_mounts').map(item => ({ secret_name: heldName(invoke, item), mount_path: item.mount_path }));
}
const FETCHES = {
  base64: bytes => {
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(binary);
  },
};
// The connection a caller names through input, for an invoke with `connection: { vendor, from_input }`: its handle must be
// this vendor's (service_connection:<vendor> or service_connection:<vendor>:<account>). Anything else is refused before a key is named.
function connectionFromInput({ vendor, from_input }, input) {
  const handed = factAt(input, `${from_input}.connection_id`);
  const bare = `service_connection:${vendor}`;
  if (!nonempty(handed) || !(handed === bare || handed.startsWith(`${bare}:`))) throw new WorkshopError(`This tool needs a ${vendor} connection: input.${from_input}.connection_id as ${bare} or ${bare}:<account>.`);
  return handed;
}
export async function buildInvocation(template, { input, task, extra = {}, needs = {}, fetchBytes = fetch, request = false }) {
  const sources = { input, task, ...extra };
  const fill = async (value, zone = null) => {
    if (Array.isArray(value)) return (await Promise.all(value.map(item => fill(item, zone)))).filter(item => item !== OMIT);
    if (typeof value === 'string') return zone && zone !== 'as-written' ? fillHoles(value, input, zone) : value;
    if (!object(value)) return value;
    const keys = Object.keys(value);
    if (zone && keys.length === 1 && keys[0] === 'const') return value.const;
    if (zone && keys.length === 2 && typeof value.$when === 'string' && keys.includes('value')) {
      const fact = factAt(input, value.$when);
      return fact === undefined || fact === null || fact === '' ? OMIT : fill(value.value, zone);
    }
    if (zone && keys.length === 1 && object(value.$time)) return timeFrom(Date.parse(task?.started_at ?? '') || Date.now(), value.$time);
    if (zone && typeof value.from === 'string' && keys.every(key => key === 'from' || key === 'optional' || key === 'otherwise' || key === 'allow_null')) {
      const found = factAt(input, value.from);
      if (found !== undefined && (found !== null || value.allow_null === true)) return found;
      if ('otherwise' in value) return fill(value.otherwise, zone);
      if (value.optional === true) return OMIT;
      throw new WorkshopError(`The request needs input.${value.from}, and it was not given.`);
    }
    if (keys.length === 1 && object(value.fill)) {
      const { from, field, fetch: as } = value.fill;
      const source = Object.hasOwn(sources, from) ? sources[from] : undefined;
      if (source === undefined) throw new WorkshopError(`The tool's invoke names an unknown source "${from}".`);
      const picked = field === undefined ? source : source?.[field];
      if (!as) return picked;
      if (!FETCHES[as]) throw new WorkshopError(`The tool's invoke asks for an unknown fetch "${as}".`);
      // A file to fetch is on a public site (tools/refuse-requests-to-private-addresses/public-address.mjs), judged again at every redirect.
      let response;
      try { response = await fetchPublic(String(picked), { signal: AbortSignal.timeout(30000) }, { fetchImpl: fetchBytes, schemes: ['https:', 'http:'] }); }
      catch (error) { if (error instanceof NotPublicAddress) throw new WorkshopError(`input.${field}: ${error.message}`); throw new WorkshopError(`input.${field} could not be fetched.`); }
      if (!response.ok) throw new WorkshopError(`input.${field} could not be fetched: the address answered ${response.status}. Give an address that serves the file directly.`);
      const limit = Number(needs.max_input_bytes) || MAX_SAVED_BYTES;
      let bytes;
      try { bytes = await readResponseBytes(response, { maxBytes: limit }); }
      catch (error) {
        if (error instanceof ResponseBytesExceeded) throw new WorkshopError(`input.${field} exceeds ${limit} bytes; this tool takes at most ${limit}.`);
        throw new WorkshopError(`input.${field} could not be read.`);
      }
      return FETCHES[as](bytes);
    }
    return Object.fromEntries((await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await fill(item, zone)]))).filter(([, item]) => item !== OMIT));
  };
  if (!request || !object(template)) return fill(template);
  const named = object(template.connection) ? connectionFromInput(template.connection, input) : undefined;
  const connected = named === undefined ? template : { ...template, connection_id: named };
  const built = Object.fromEntries(await Promise.all(Object.entries(template).filter(([key]) => key !== 'connection').map(async ([key, item]) => [key, await fill(item, REQUEST_FIELDS[key] ?? null)])));
  return {
    ...built,
    ...(named === undefined ? {} : { connection_id: named }),
    ...(connected.credential_injections === undefined ? {} : { credential_injections: credentialInjections(connected) }),
    ...(connected.credential_mounts === undefined ? {} : { credential_mounts: credentialMounts(connected) }),
  };
}
const formPairs = (node, prefix = '') => {
  if (Array.isArray(node)) return node.flatMap((item, index) => formPairs(item, prefix ? `${prefix}[${index}]` : String(index)));
  if (object(node)) return Object.entries(node).flatMap(([key, item]) => formPairs(item, prefix ? `${prefix}[${key}]` : key));
  return node === null || node === undefined ? [] : [[prefix, String(node)]];
};
const forAForm = text => encodeURIComponent(text).replace(/[!'()*]/g, percent).replace(/%20/g, '+');
const BODY_ENCODINGS = {
  json: body => ({ text: JSON.stringify(body), content_type: 'application/json' }),
  form: body => ({ text: formPairs(body).map(([key, value]) => `${forAForm(key)}=${forAForm(value)}`).join('&'), content_type: 'application/x-www-form-urlencoded' }),
  // A file sent as the request's whole body (a package uploaded to a store): the body is the file's bytes as base64,
  // filled by the row's invoke (`{ fill: { from: "input", field, fetch: "base64" } }` over a file the input names).
  bytes: body => {
    if (typeof body !== 'string') throw notSent('A body sent as bytes must be the file\'s bytes as base64.');
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return { bytes, content_type: 'application/octet-stream' };
  },
};
// What an encoded body sends: its bytes, or its words as UTF-8.
const bodyBytes = encoded => encoded.bytes ?? new TextEncoder().encode(encoded.text);
export function encodeBody(body, encoding = 'json') {
  if (body === undefined || body === null) return null;
  if (!Object.hasOwn(BODY_ENCODINGS, encoding)) throw notSent(`This tool asks for a body encoding "${encoding}" this service does not have.`);
  return BODY_ENCODINGS[encoding](body);
}

const HELD = '[held value]';
const scrubText = (text, texts) => texts.reduce((kept, value) => kept.split(value).join(HELD), String(text));
const replyText = body => (body === undefined || body === null ? '' : typeof body === 'string' ? body : new TextDecoder().decode(body instanceof Uint8Array ? body : Uint8Array.from(body)));
async function keepHeldReplyValues(value, invocation, keep, store = true) {
  const held = [];
  for (const { from, keep_as_field: field } of invocation.reply_holds_values) {
    const parts = String(from).split('.');
    const parent = parts.slice(0, -1).reduce((at, part) => (object(at) ? at[part] : undefined), value);
    const last = parts.at(-1);
    if (!object(parent) || parent[last] === undefined || parent[last] === null || parent[last] === '') continue;
    held.push({ field, value: String(parent[last]) });
    parent[last] = HELD;
  }
  // A returned credential can also occur in an error, a report or another field.
  // Mask every occurrence before any branch can disclose the reply. Storage
  // failures are intentionally opaque, and do not authorize another send.
  const clean = item => typeof item === 'string' ? scrubText(item, held.map(one => one.value))
    : Array.isArray(item) ? item.map(clean)
      : object(item) ? Object.fromEntries(Object.entries(item).map(([key, inner]) => [scrubText(key, held.map(one => one.value)), clean(inner)])) : item;
  const safe = clean(value);
  if (store) for (const one of held) await keep(connectionFieldName(invocation.connection_id, one.field), one.value);
  return safe;
}
/** A request's address with its `query` leaves (already filled) added as its query string. */
export function addressWithQuery(url, query) {
  if (!object(query) || !Object.keys(query).length) return url;
  const address = new URL(url);
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) address.searchParams.append(name, object(item) ? JSON.stringify(item) : String(item));
  }
  return address.href;
}
// Cursor APIs sometimes put an access token in paging URLs. Tools declaring reply_cursor_paging keep opaque
// cursors and continuation flags instead. No returned paging URL can be persisted, disclosed or followed later.
export function cursorPagingReply(value) {
  if (Array.isArray(value)) return value.map(cursorPagingReply);
  if (!object(value)) return value;
  const safe = Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key !== 'paging' || !object(item)) return [key, cursorPagingReply(item)];
    const { next, previous, ...rest } = item;
    return [key, { ...cursorPagingReply(rest), has_next: typeof next === 'string' && next.length > 0,
      has_previous: typeof previous === 'string' && previous.length > 0 }];
  }));
  if (Array.isArray(safe.data) && !object(safe.paging)) safe.paging = { has_next: false, has_previous: false };
  return safe;
}
export async function httpJson({ invocation: given, send, keep }, request = fetch) {
  const invocation = given.query === undefined ? given : { ...given, url: addressWithQuery(given.url, given.query) };
  const keepsReplyValues = Array.isArray(invocation.reply_holds_values) && invocation.reply_holds_values.length > 0;
  if (keepsReplyValues && !(keep && nonempty(invocation.connection_id))) throw notSent('This tool\'s reply carries a key, and there is no connection here to keep it in, so it was not sent.');
  const encoded = encodeBody(invocation.body !== undefined ? invocation.body : invocation.body_template, invocation.body_encoding ?? 'json');
  const named = Object.keys(invocation.headers ?? {}).some(name => name.toLowerCase() === 'content-type');
  const headers = { ...(encoded && !named ? { 'content-type': encoded.content_type } : {}), ...(invocation.headers ?? {}) };
  const method = invocation.method ?? 'POST';
  const timeout_ms = Number(invocation.timeout_ms) || (Number(invocation.timeout_seconds) || 300) * 1000;
  const injections = invocation.credential_injections ?? [];
  let status;
  let text;
  // A tool reaches only public sites (tools/refuse-requests-to-private-addresses/public-address.mjs), and every redirect it is sent is
  // judged again. A send with a connection also goes only to that connection's own hosts over https, which the box checks.
  try { publicAddress(invocation.url, { schemes: ['https:', 'http:'] }); } catch (error) { if (error instanceof NotPublicAddress) throw notSent(`This tool's address cannot be used: ${error.message}`); throw error; }
  if (injections.length) {
    if (!send) throw notSent('This service holds no connections, so a tool that uses one cannot run here.');
    try {
      const reply = await send({ url: invocation.url, method, headers, ...(encoded ? { body: bodyBytes(encoded) } : {}), credential_injections: injections, timeout_ms });
      status = reply.status_code;
      text = replyText(reply.body);
    } catch { throw new Error('The tool request could not be completed; its outcome is unknown.'); }
  } else {
    let response;
    const sent = { method, headers, ...(encoded ? { body: bodyBytes(encoded) } : {}), signal: AbortSignal.timeout(timeout_ms) };
    try { response = invocation.follow_redirects === false ? await request(publicAddress(invocation.url, { schemes: ['https:', 'http:'] }), { ...sent, redirect: 'manual' }) : await fetchPublic(invocation.url, sent, { fetchImpl: request, schemes: ['https:', 'http:'] }); }
    catch (error) {
      // A redirect refusal may follow an already completed first request. Only
      // initial validation above can truthfully establish that nothing was sent.
      if (error instanceof NotPublicAddress) throw new Error(`This tool's redirected address cannot be used: ${error.message}`);
      throw new Error('The tool request could not be completed; its outcome is unknown.');
    }
    status = response.status;
    try { text = await response.text(); }
    catch { throw Object.assign(new Error('The tool replied, but its reply could not be read.'), { service_answered: status }); }
  }
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  if (keepsReplyValues) {
    // An unstructured reply cannot satisfy declared held-field paths safely.
    if (!object(value) && !Array.isArray(value)) throw Object.assign(new Error('The tool replied, but its held values could not be read.'), { service_answered: status });
    const accepted = status >= 200 && status < 300 && !(typeof invocation.answer_ok_field === 'string' && value[invocation.answer_ok_field] === false);
    try { value = await keepHeldReplyValues(value, invocation, keep, accepted); }
    catch { throw Object.assign(new Error('The tool replied, but its held values could not be kept.'), { service_answered: status }); }
    text = JSON.stringify(value);
  }
  if (!(status >= 200 && status < 300)) throw Object.assign(new Error(`The tool answered ${status}: ${(typeof value?.error === 'string' ? value.error : text).slice(0, 300)}`), { service_answered: status });
  if (typeof invocation.answer_ok_field === 'string' && object(value) && value[invocation.answer_ok_field] === false) {
    throw Object.assign(new Error(`${new URL(invocation.url).host} did not take it: ${String(value.error ?? 'no reason given').slice(0, 300)}`), { service_answered: status });
  }
  if (invocation.report_answer === true) {
    const answer = typeof value === 'string' ? value : JSON.stringify(value);
    return { status, said: `${new URL(invocation.url).host} answered ${status}.`, ...(answer ? { answer: answer.slice(0, 500) } : {}) };
  }
  const safe = invocation.reply_cursor_paging === true ? cursorPagingReply(value) : value;
  return safe;
}
