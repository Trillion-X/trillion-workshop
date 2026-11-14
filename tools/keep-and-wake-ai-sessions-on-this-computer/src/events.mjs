import { requireCurrentConnection, selectSourceConnection } from './source-connection.mjs';
import { makeSenderPairing } from './sender-pairing.mjs';
// Events from outside: something calls in when a thing happens (a comment, a message), and a person's own rules say
// which tool runs for it. "Someone comments GUIDE, they get the guide in a private message" is one rule row.
//
//   Worker        /events/<source id>   GET: the sender confirms the address (handshake); POST: a delivery, checked
//                                       against the sender's signature over the exact bytes, split into events,
//                                       and handed to every account that listens for that route key.
//   PersonStore   /events/listen        prove which route key is this account's own (the source's proof tool, run
//                                       with this account's connection), register it, and ask the service to send
//                                       its events here (the source's listen tool)
//                 /events/receive       events the Worker verified; each rule that matches starts its tool
//
// A service that keeps no address to send to is read instead: its source row's `poll` names the tool that lists what
// is new since a cursor, how often, where the first cursor comes from and where the next one is read, and optionally a
// `detail` tool that reads each new item in full. The account's own connection does the reading on the store's alarm,
// and each new item becomes an event exactly as a delivery's would (pollDue / nextPoll).
//
// Nothing here names a platform. Sources (signature scheme, handshake, how a delivery splits into events, proof tool)
// are `tool-event-source` rows in the trillion package set, decoded by ai-tool-catalog. Rules are the account's own
// DATA: { source_id, event, match, then, once_per, skip, batch, limit, paired_senders }, where `then` is { tool_id, input } (one Workshop tool) or
// { workflow_id, input } (a workflow, run on the workflow engine through src/workflows.mjs). A rule's input fills from
// the event with { "fill": { "from": "event", "field": "<field>" } }, the same grammar tool rows use.
// A noisy source is quieted by two fields of the rule itself (rule-skip-and-batch): `skip` lists tests on the event's fields
// ({ field, matches } a pattern, or { field, equals } a value) and an event any of them holds for is left out; `batch`
// ({ every_minutes, key?, input? }) gathers matching events instead of starting a run for each, and once every_minutes
// after the first one it starts the rule's `then` once, with `event` being the gathered batch { name, count, first_at,
// last_at, events } and `input` (when given) in place of then.input. Rules sharing a batch key share one batch.
// A rule that names `paired_senders` (an event field holding the sender, like "from_id") answers only senders the person paired
// (src/sender-pairing.mjs): an unknown sender's event is held, told as skipped with their code and not replayed; once the person approves the code, the sender's later events run.
// A standing rule ("when X comes up, do Y, at most twice, not twice in an hour, until Friday") carries `limit`:
// { max_fires, cooldown_minutes, expires_at }, each optional and at least one given. It is matched structurally
// with no model call. The rule starts nothing once it has started max_fires runs, nor within cooldown_minutes of its
// last run, nor at or after expires_at, and each such event is told as skipped in words. A rule is counted when its
// run is started (a repeated delivery of the same event counts once), the count restarts when the rule is set again,
// and a limit cannot be combined with batch (a batch starts its run later, so there is no start to count).
//
// Rules are set, listed and removed through src/automations.mjs (set_rule, list_rules, remove_rule), the one family
// of rule tools for events from outside and records written in the person's own Trillion alike.
//
// A route key is registered only after the source's proof tool, run with the account's own connection, returns it,
// so nobody can listen for someone else's events. A repeated delivery (senders retry) starts no second run: the
// request key is the event's own id, for a tool run and a workflow run alike.
import { buildInvocation, WorkshopError } from './workshop.mjs';
import { selectDeclaredValue } from '../../ui/read-data/declared-selector.ts';
import { withoutSecrets } from './scheduler.mjs';
import { hasRouteCollection, makeRouteListeners } from './event-route-listeners.mjs';
import { failureOf } from './failure.mjs';
import operators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter, ruleTreeOfTests } from 'trillion-workshop/tools/formula-engine/rules/filter-rows-by-rules.mjs';

const MAX_DELIVERY_BYTES = 1_000_000;
// One alarm reads at most this many due sources (each read waits on the service), and reads at most this many new
// items in full at once.
const MAX_READS_PER_WAKE = 1;
const DETAIL_READS_AT_ONCE = 4;
const MAX_RULES = 200;
const KEPT_EVENTS = 50;
// A listing of arrived events shows each without the payload a pending one keeps for its retry (up to MAX_DELIVERY_BYTES)
// and with its text cut to this many characters: the facts cut both in SQL, so neither is read.
const SEEN_TEXT_CHARS = 1000;
const SEEN_SHOWN = { drop: ['event_payload'], clip: { text: SEEN_TEXT_CHARS } };
const shownSeen = ({ event_payload, ...item }) => (typeof item.text === 'string' && item.text.length > SEEN_TEXT_CHARS ? { ...item, text: item.text.slice(0, SEEN_TEXT_CHARS) } : item);
// The newest arrivals a source's health reads (and every pending one).
const HEALTH_EVENTS = 200;
// A gathered batch keeps at most this many events in full; its count keeps counting past it.
const MAX_GATHERED = 200;
// The formula engine decides every condition here (a source's `where`, a rule's `skip`). A host that has loaded it gives
// it with setConditionEngine(holds), the shape of filter-rows-by-rules.mjs holdsNow (tree, facts) -> boolean; this Node host
// loads it from the bytes the Workshop ships, so a condition never goes undecided.
let engine = null;
export const setConditionEngine = given => { engine = given; };
const conditionEngine = () => {
  if (!engine) throw new Error('The condition engine is not loaded: call setConditionEngine first.');
  return engine;
};
try {
  const { readFileSync } = await import('node:fs');
  const filter = makeRowFilter({ operators, wasm: () => readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm'))) });
  await filter.load();
  engine ??= filter.holdsNow;
} catch { /* a host without files gives the engine with setConditionEngine */ }
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const json = (value, status = 200) => Response.json(value, { status });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// Which of two cursor values is later: as times when both read as one, else as text (ids that grow, ISO dates).
const timeOf = value => (typeof value === 'string' && /^\d{4}-\d\d-\d\d/.test(value) ? Date.parse(value) : NaN);
const laterFirst = (left, right) => { const [a, b] = [timeOf(left), timeOf(right)]; return Number.isFinite(a) && Number.isFinite(b) ? b - a : (String(right) > String(left)) - (String(right) < String(left)); };
const atOrAfter = (value, cursor) => laterFirst(value, cursor) <= 0;

// ---------------------------------------------------------------------------------------------------------------
// Words in text. Adapted from OpenReply's keyword matcher (lib/utils/keyword-matcher.ts), under its MIT licence:
//
//   MIT License. Copyright (c) 2026 Anish Raj. Copyright (c) 2026 Diwen Huang.
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
//   copyright notice and this permission notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
//   SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
//   OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
//
// Any script works (letters and numbers by Unicode property), Latin accents fold ("PREÇO" matches "preco"), Arabic
// keyboard variants fold, emoji and punctuation are ignored, and a numeric word also matches when typed with the
// letter O ("O8" for "08").
const ARABIC_SCRIPT_FOLDING = [
  [/[يىے]/gu, 'ی'], [/ك/gu, 'ک'], [/ة/gu, 'ه'], [/[آأإٱ]/gu, 'ا'],
  [/[ً-ْٰ]/gu, ''], [/ـ/gu, ''], [/[‌‎‏]/gu, ''],
];
const EASTERN_DIGITS = /[۰-۹٠-٩]/gu;
function normalizeArabicScript(text) {
  let out = text;
  for (const [pattern, replacement] of ARABIC_SCRIPT_FOLDING) out = out.replace(pattern, replacement);
  return out.replace(EASTERN_DIGITS, digit => { const code = digit.codePointAt(0); return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660)); });
}
const stripSpecialCharacters = text => text
  .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/gu, '')
  .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function foldDiacritics(text) {
  let out = '';
  let baseIsLatin = false;
  for (const char of text.normalize('NFD')) {
    if (/\p{M}/u.test(char)) { if (!baseIsLatin) out += char; continue; }
    baseIsLatin = /\p{Script=Latin}/u.test(char);
    out += char;
  }
  return out.normalize('NFC');
}
const cleaned = text => foldDiacritics(stripSpecialCharacters(normalizeArabicScript(String(text ?? '')))).toLowerCase();
export function matchWords(text, words, wholeWord = true) {
  const said = cleaned(text);
  if (!said) return null;
  for (const word of words) {
    const wanted = cleaned(word);
    if (!wanted) continue;
    const numeric = /^[0-9o]+$/.test(wanted);
    const compareText = numeric ? said.replace(/o/g, '0') : said;
    const compareWord = numeric ? wanted.replace(/o/g, '0') : wanted;
    if (wholeWord ? new RegExp(`(?<![\\p{L}\\p{N}])${compareWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(compareText) : compareText.includes(compareWord)) return word;
  }
  return null;
}

// How a rule decides an event is for it, keyed by the rule's `match.kind`. A new way to match is one more entry.
const MATCHERS = {
  words: (match, event) => matchWords(event[match.field ?? 'text'], match.words, match.whole_word !== false) !== null,
  every: () => true,
};

// A rule's skip tests and batch (rule-skip-and-batch), checked where a rule is set so a bad one is refused in words.
// Each is a comparison of rule-operators.json (matches_pattern, equals) the formula engine decides; the pattern is the
// engine's regular-expression syntax (no look-around or back-references).
const SKIP_TESTS = { matches: 'matches_pattern', equals: 'equals' };
function checkedSkip(skip, fields) {
  if (skip === undefined || skip === null) return null;
  if (!Array.isArray(skip) || !skip.length) throw new WorkshopError('skip is a list of tests, like [{ "field": "email", "matches": "@example\\.com$" }].');
  return skip.map((test, at) => {
    const kinds = object(test) ? Object.keys(SKIP_TESTS).filter(kind => Object.hasOwn(test, kind)) : [];
    if (!object(test) || !fields.includes(test.field) || kinds.length !== 1) throw new WorkshopError(`skip[${at}] needs field (one of ${fields.join(', ')}) and one of ${Object.keys(SKIP_TESTS).join(', ')}.`);
    if (kinds[0] === 'matches') { try { new RegExp(test.matches, 'u'); } catch { throw new WorkshopError(`skip[${at}].matches is not a pattern that can be read.`); } }
    return { field: test.field, [kinds[0]]: test[kinds[0]] };
  });
}
function checkedBatch(batch, source_id) {
  if (batch === undefined || batch === null) return null;
  if (!object(batch) || !(Number.isFinite(batch.every_minutes) && batch.every_minutes >= 1)) throw new WorkshopError('batch is { every_minutes }: how long to gather events before one run, like { "every_minutes": 1440 } for once a day.');
  if (batch.input !== undefined && !object(batch.input)) throw new WorkshopError('batch.input, when given, is the input of the one run, filled from the gathered batch as "event" (count, first_at, last_at, events).');
  return { every_minutes: batch.every_minutes, key: nonempty(batch.key) ? batch.key : source_id, ...(batch.input ? { input: batch.input } : {}) };
}
// A rule's limit (standing rules): at most max_fires runs, none within cooldown_minutes of the last, none from expires_at.
function checkedLimit(limit, batch) {
  if (limit === undefined || limit === null) return null;
  const given = object(limit) ? Object.keys(limit).filter(name => limit[name] !== undefined && limit[name] !== null) : [];
  if (!given.length || given.some(name => !['max_fires', 'cooldown_minutes', 'expires_at'].includes(name))) throw new WorkshopError('limit is { max_fires, cooldown_minutes, expires_at }, each optional, like { "max_fires": 2, "cooldown_minutes": 60, "expires_at": "2026-12-31T00:00:00Z" }.');
  if (limit.max_fires !== undefined && !(Number.isInteger(limit.max_fires) && limit.max_fires >= 1)) throw new WorkshopError('limit.max_fires is a whole number of runs, at least 1.');
  if (limit.cooldown_minutes !== undefined && !(Number.isFinite(limit.cooldown_minutes) && limit.cooldown_minutes > 0)) throw new WorkshopError('limit.cooldown_minutes is a number of minutes above 0.');
  if (limit.expires_at !== undefined && !(typeof limit.expires_at === 'string' && Number.isFinite(Date.parse(limit.expires_at)))) throw new WorkshopError('limit.expires_at is a date and time, like "2026-12-31T00:00:00Z".');
  if (batch) throw new WorkshopError('A rule cannot have both batch and limit: a batch starts its run later, so there is no run to count.');
  return Object.fromEntries(given.map(name => [name, name === 'expires_at' ? new Date(limit.expires_at).toISOString() : limit[name]]));
}
// Why a rule's limit holds it back for an event now, in words, or null when it may start; `fired` is { count, last_at } or null.
export function heldByLimit(limit, fired, nowMs) {
  if (!limit) return null;
  if (limit.expires_at && nowMs >= Date.parse(limit.expires_at)) return `ended at ${limit.expires_at}`;
  if (limit.max_fires && (fired?.count ?? 0) >= limit.max_fires) return `already ran ${limit.max_fires} time${limit.max_fires === 1 ? '' : 's'}`;
  const resting = limit.cooldown_minutes && fired?.last_at ? Date.parse(fired.last_at) + limit.cooldown_minutes * 60_000 : null;
  return resting && nowMs < resting ? `resting until ${new Date(resting).toISOString()}` : null;
}
// Whether an event's fields hold any of a rule's skip tests; exported so work already waiting can be put through the
// same tests (harness/quiet-open-source-work.mjs).
// A pattern is asked of each text the field holds (a field may hold a list); any rule that holds skips the event.
export function skippedBy(skip, event) {
  const facts = {};
  const rules = (skip ?? []).flatMap(test => [
    ...(Object.hasOwn(test, 'matches') ? [event[test.field]].flat().filter(each => typeof each === 'string').map((each, at) => {
      facts[`${test.field}[${at}]`] = each;
      return { kind: 'rule', field: `${test.field}[${at}]`, operator: SKIP_TESTS.matches, params: { text: test.matches } };
    }) : []),
    ...(Object.hasOwn(test, 'equals') ? (() => {
      const [rule] = ruleTreeOfTests([{ path: [test.field], equals: test.equals }]).rules;
      facts[rule.field] = event[test.field];
      return [rule];
    })() : []),
  ]);
  return rules.length > 0 && conditionEngine()({ kind: 'group', combinator: 'or', negate: false, rules }, facts);
}
const skipped = (rule, event) => skippedBy(rule.skip, event);

// ---------------------------------------------------------------------------------------------------------------
// A delivery, read through its source row.
// A path step is a field name, a list position, { find: { field: value } }: the first item of a list whose fields
// hold those values (text compared in any case), for senders that list named values (a mail's headers), or
// { decode: name }: the text read so far decoded the way the sender wrote it, by one of DECODERS.
const found = (list, wanted) => (Array.isArray(list) ? list.find(item => object(item) && Object.entries(wanted).every(([field, value]) => (typeof value === 'string' && typeof item[field] === 'string' ? item[field].toLowerCase() === value.toLowerCase() : same(item[field], value)))) : undefined);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const DECODERS = {
  // Text a service sends HTML-escaped (a mail's snippet): named and numbered character references back to characters.
  'html-entities': text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => (name[0] === '#' ? String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : ENTITIES[name.toLowerCase()] ?? whole)),
  // A mail sent as HTML only: its words, with blocks and line breaks kept as lines and every tag, style and script gone.
  'html-text': text => DECODERS['html-entities'](text
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
};
const stepAt = (at, part) => {
  if (!object(part)) return at[part];
  if (part.decode !== undefined) return typeof at === 'string' && DECODERS[part.decode] ? DECODERS[part.decode](at) : at;
  return found(at, part.find ?? {});
};
const valueAt = (scope, path) => path.reduce((at, part) => (at === undefined || at === null ? undefined : stepAt(at, part)), scope);
// A source row's tests ({ path, equals | present, not }, all must hold) as the engine's rule tree over the scope's values.
const holds = (conditions, scope) => conditionEngine()(ruleTreeOfTests(conditions, { present: 'is_not_empty' }), id => valueAt(scope, JSON.parse(id)));

// An event's own id: one field, or several joined (a thread that has news again is a new event).
const eventIdOf = (source, fields) => [source.event_id].flat().map(name => String(fields[name])).join(':');

/** Every field an event of this source carries: the ones read from the delivery and the ones its details add. */
export const eventFieldNames = (source, name) => [...Object.keys(source.events.find(item => item.name === name)?.fields ?? {}), ...Object.keys(source.poll?.detail?.fields ?? {})];

/** Every event in one delivery: `{ name, route_key, event_id, ...fields }`, as the source row says to read them. */
export function readDelivery(source, payload) {
  if (!object(payload) || !holds(source.delivery_where, payload)) return [];
  const events = [];
  for (const spec of source.events) {
    let scopes = [{}];
    spec.each.forEach(({ field, as }, index) => {
      scopes = scopes.flatMap(scope => {
        const at = index === 0 ? payload : scope[spec.each[index - 1].as];
        const list = at == null ? undefined : valueAt(at, Array.isArray(field) ? field : [field]);
        return Array.isArray(list) ? list.map(item => ({ ...scope, [as]: item })) : [];
      });
    });
    for (const scope of scopes) {
      if (!holds(spec.where, scope)) continue;
      const fields = Object.fromEntries(Object.entries(spec.fields).map(([name, path]) => [name, valueAt(scope, path)]).filter(([, value]) => value !== undefined && value !== null && value !== ''));
      if (!spec.required.every(name => fields[name] !== undefined)) continue;
      if ((spec.skip_when_same ?? []).some(([left, right]) => fields[left] !== undefined && same(fields[left], fields[right]))) continue;
      events.push({ name: spec.name, ...Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, typeof value === 'object' ? value : String(value)])), route_key: String(fields[source.route_key]), event_id: eventIdOf(source, fields) });
    }
  }
  return events;
}

// The sender's signature over the exact bytes, made with the secret the source row names, in the receiving Worker from
// the service's sealed signing secrets (src/service-signing.mjs). The HMAC and its hash are fixed by the sender's protocol; they
// are the sender's check, not an identity this service mints. Each row's hash and text form, as the box's signing
// names them; a row naming anything else is refused.
const SIGNING = { 'SHA-256': 'hmac_sha256' };
const TEXT_FORMS = { hex: 'hex', base64: 'std_b64' };
export const signingOf = source => (SIGNING[source.signature.hmac] && TEXT_FORMS[source.signature.encoding]
  ? { scheme: SIGNING[source.signature.hmac], output_encoding: TEXT_FORMS[source.signature.encoding] } : null);
export function signatureHolds(source, header, expected) {
  const { prefix = '' } = source.signature;
  if (!nonempty(header) || !nonempty(expected) || !header.startsWith(prefix)) return false;
  const given = header.slice(prefix.length).trim();
  if (given.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  return difference === 0;
}

const routeName = (sourceId, routeKey) => `event-route:${sourceId}:${routeKey}`;
const routeOwner = (namespace, sourceId, routeKey) => namespace.get(namespace.idFromName(routeName(sourceId, routeKey)));
export const eventRouteStores = async (kv, namespace, sourceId, routeKey) => namespace
  ? routeOwner(namespace, sourceId, routeKey).eventRouteStores({ source_id: sourceId, route_key: routeKey })
  : JSON.parse((await kv.get(routeName(sourceId, routeKey))) ?? '[]');

// Production membership is serialized by the existing EVENT_INBOX binding, one SQL row per account. The optional
// KV-only adapter preserves existing local callers; production supplies the binding for both writes and fan-out.
export const routeBook = (kv, storeId, namespace = null) => ({
  async add(sourceId, routeKey, { revision = 0 } = {}) {
    if (namespace) {
      const result = await routeOwner(namespace, sourceId, routeKey).changeEventRoute({ store_id: storeId, active: true, generation: revision });
      if (result?.active !== true || result.generation !== revision)
        throw Object.assign(new WorkshopError('This event listener was replaced by a newer start or stop.'), { retryable: false });
      return result;
    }
    const stores = JSON.parse((await kv.get(routeName(sourceId, routeKey))) ?? '[]');
    if (!stores.includes(storeId)) await kv.put(routeName(sourceId, routeKey), JSON.stringify([...stores, storeId]));
  },
  async remove(sourceId, routeKey, { revision = 0 } = {}) {
    if (namespace) return routeOwner(namespace, sourceId, routeKey).changeEventRoute({ store_id: storeId, active: false, generation: revision });
    const stores = JSON.parse((await kv.get(routeName(sourceId, routeKey))) ?? '[]').filter(id => id !== storeId);
    if (stores.length) await kv.put(routeName(sourceId, routeKey), JSON.stringify(stores));
    else await kv.delete(routeName(sourceId, routeKey));
  },
});

// The Worker's public address for one source. `sources()` → decoded event-source rows; `storeFor(id)` → the store
// stub for an account's store id; `sign(name, bytes, { scheme, output_encoding })` → the signature made with the held
// value of that name, or null when nothing holds it.
export async function receiveEvents(request, { sourceId, sources, kv, routeNamespace = null, storeFor, sign }) {
  // The address names a source by its id, or by its id without the "events:" every source id starts with.
  const source = (await sources()).find(item => item.id === sourceId || item.id === `events:${sourceId}`);
  if (!source) return json({ error: 'There is no event source at this address.' }, 404);
  if (!source.signature) return json({ error: 'Trillion reads this source itself; nothing is sent to this address.' }, 404);
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const shake = source.handshake;
    if (!shake?.query) return json({ error: 'This source has no address check.' }, 404);
    const confirmed = url.searchParams.get(shake.query.mode) === shake.mode && url.searchParams.get(shake.query.check) === shake.expected;
    return confirmed ? new Response(url.searchParams.get(shake.query.challenge) ?? '', { headers: { 'content-type': 'text/plain; charset=utf-8' } }) : json({ error: 'The address check did not match.' }, 403);
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  const raw = await request.text();
  if (raw.length > MAX_DELIVERY_BYTES) return json({ error: 'Delivery too large.' }, 413);
  const signing = signingOf(source);
  const expected = signing ? await sign(source.signature.secret_name, new TextEncoder().encode(raw), signing) : null;
  if (!expected) return json({ error: 'This address is not ready to receive deliveries yet.' }, 503);
  if (!signatureHolds(source, request.headers.get(source.signature.header), expected)) return json({ error: 'Signature check failed.' }, 401);
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'The delivery is not JSON.' }, 400); }
  const events = readDelivery(source, payload);
  const byRoute = new Map();
  for (const event of events) byRoute.set(event.route_key, [...(byRoute.get(event.route_key) ?? []), event]);
  let delivered = 0;
  let failed = 0;
  const unheard = [];
  // One delivery can carry many accounts' events; each account's store is reached at once, in parallel.
  await Promise.all([...byRoute].map(async ([routeKey, routed]) => {
    const stores = await eventRouteStores(kv, routeNamespace, source.id, routeKey);
    if (!stores.length) unheard.push(routeKey);
    await Promise.all(stores.map(async id => {
      const response = await storeFor(id).fetch(new Request('https://person/events/receive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_id: source.id, events: routed }) }));
      if (response.ok) delivered += 1;
      else failed += 1;
    }));
  }));
  // A rejected account delivery was not kept. Preserve the sender's retry instead of acknowledging lost work.
  return json({ received: events.length, delivered_to_accounts: delivered, ...(failed ? { failed_accounts: failed } : {}), ...(unheard.length ? { nobody_listening_for: unheard.length } : {}) }, failed ? 503 : 200);
}

// One event rule as it is kept, from a source row and the plain words it was set with: the same shape whether the
// person's AI set it (set) or it ships as one of Trillion's defaults (src/starting-rules.mjs), where `at` is null and
// the rule carries `default: true`. An edit keeps `default` and `backs` from the rule it changes (`earlier`).
export function eventRuleOf(source, { rule_id, event, match, then, once_per, skip, batch, limit, paired_senders, label, enabled, backs }, { earlier = null, at = null } = {}) {
  const names = source.events.map(item => item.name);
  if (!names.includes(event)) throw new WorkshopError(`event must be one of ${names.join(', ')} for ${source.id}.`);
  const matcher = match === undefined ? { kind: 'every' } : { kind: 'words', ...match };
  if (!MATCHERS[matcher.kind]) throw new WorkshopError(`match.kind must be one of ${Object.keys(MATCHERS).join(', ')}.`);
  if (matcher.kind === 'words' && !(Array.isArray(matcher.words) && matcher.words.length && matcher.words.every(nonempty))) throw new WorkshopError('match.words must be a list of words, for example ["guide"].');
  if (!object(then) || !(nonempty(then.tool_id) || nonempty(then.workflow_id)) || !object(then.input)) throw new WorkshopError('then must be { tool_id, input }: the tool to run and its input, or { workflow_id, input }: the workflow to start and its input. An input value { "fill": { "from": "event", "field": "comment_id" } } is taken from the event.', { tool: 'find_tool_for_job', arguments: { job: 'send a private message to someone who commented' } });
  const fields = eventFieldNames(source, event);
  if (once_per !== undefined && !fields.includes(once_per)) throw new WorkshopError(`once_per must name a field of the event: ${fields.join(', ')}.`);
  const skipTests = checkedSkip(skip, fields);
  const gathered = checkedBatch(batch, source.id);
  const limited = checkedLimit(limit, gathered);
  if (paired_senders !== undefined && !fields.includes(paired_senders)) throw new WorkshopError(`paired_senders must name a field of the event that holds the sender: ${fields.join(', ')}.`);
  return {
    rule_id, source_id: source.id, event, match: matcher, then: nonempty(then.workflow_id) ? { workflow_id: then.workflow_id, input: then.input } : { tool_id: then.tool_id, input: then.input },
    ...(once_per ? { once_per } : {}), ...(skipTests ? { skip: skipTests } : {}), ...(gathered ? { batch: gathered } : {}), ...(limited ? { limit: limited } : {}), ...(paired_senders ? { paired_senders } : {}),
    label: nonempty(label) ? label : `${event} on ${source.label}`, enabled: typeof enabled === 'boolean' ? enabled : earlier ? earlier.enabled !== false : true,
    ...((backs ?? earlier?.backs) ? { backs: backs ?? earlier.backs } : {}), ...(earlier?.default ? { default: true } : {}), ...(at ? { set_at: at } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// One account's rules.
// facts: { read(entity), list(prefix), write(entity, value) } (newest value per entity is current)
// routes: { add(sourceId, routeKey), remove(sourceId, routeKey) }
// sources: () → decoded event-source rows
// workflows: this account's workflows ({ start({ workflow_id, input, request_key }) → run }), when a rule starts one
// rearm: called when a source this account reads by itself has a new next read (the store's alarm arms for it)
// connections(vendor): → this account's connections of that vendor; connection(id): → that one connection or null, read
// without the others (an event's admission reads one connection, never the account's whole list)
// beforeRuleMutation(operation, {key,value}): fresh admission after all awaited rule/source/listener reads.
// commitRule({key,value,result,operation}): optional synchronous native owner which writes the rule and captures
// the exact formatted result in its own transaction. Async facts.write remains a separate legacy path.
export function makeEventRules({ workshop, workflows = null, facts, routes, sources, connections = null, connection = null, now = () => new Date(), keepAlive = null, settleMs = 25000, rearm = async () => {}, beforeRuleMutation = async () => {}, commitRule = null }) {
  if (commitRule !== null && (typeof commitRule !== 'function' || commitRule.constructor?.name === 'AsyncFunction'))
    throw new TypeError('The native event-rule commit supply must be synchronous.');
  const synchronousRuleResult = value => {
    if (value && typeof value.then === 'function') throw new TypeError('Native event-rule commitments and result transforms must be synchronous.');
    return value;
  };
  const connectionNamed = connection ?? (async id => ((await connections?.()) ?? []).find(item => item.connection_id === id) ?? null);
  const routeListeners = makeRouteListeners({ facts, routes, workshop, connections: connections ?? (async () => []), connection: connectionNamed, now, rearm, keepAlive });
  // The scheduler asks for the next poll on every wake, including wakes for
  // unrelated work. Only a listening or poll cursor write can change that time.
  let pollRevision = 0;
  let cachedPoll = { revision: -1, at: null, order: [] };
  const receiving = new Map();
  // Keep the control read and publication together, without holding it while a provider answers. Route changes
  // have their own ordering: a delayed stop cleanup cannot remove the route a later explicit restart just kept.
  const listenerControls = new Map(), listenerRoutes = new Map();
  const serial = (pending, key, work) => {
    const prior = pending.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    pending.set(key, next);
    const release = () => { if (pending.get(key) === next) pending.delete(key); };
    next.then(release, release);
    return next;
  };
  const control = (sourceId, work) => serial(listenerControls, sourceId, work);
  const routeChange = (sourceId, work) => serial(listenerRoutes, sourceId, work);
  const controlRevisionOf = item => item?.control_revision ?? 0;
  const checkControl = async (source, revision) => {
    const latest = await facts.read(`event-listen:${source.id}`);
    if (controlRevisionOf(latest) !== revision) {
      const error = new WorkshopError(`${source.label} was stopped or changed while its connection was being checked.`);
      error.retryable = false;
      throw error;
    }
    return latest;
  };
  async function assertConnectionBinding(binding) {
    const held = await connectionNamed(binding?.connection_id);
    requireCurrentConnection(binding, held ? [held] : []);
    const row = await facts.read(`event-listen:${binding.source_id}`);
    if (!row || row.stop_requested || controlRevisionOf(row) !== binding.control_revision
      || row.connection_binding?.connection_id !== binding.connection_id || row.connection_binding?.connected_at !== binding.connected_at
      || binding.account && row.connection_binding?.account !== binding.account)
      throw Object.assign(new WorkshopError('This source was stopped or its selected account changed.'), { retryable: false });
    return row;
  }
  async function activeListener(source, row) {
    if (!row?.connection_binding || row.stop_requested) return row;
    try { await assertConnectionBinding(row.connection_binding); return row; }
    catch (error) { return { ...row, stopped: true, binding_problem: withoutSecrets(error) }; }
  }
  const bindingAttempts = rows => rows.filter(row => row.binding_problem).map(row => ({ source_id: row.source_id,
    purpose: 'connection', state: 'failed', problem: row.binding_problem, retryable: false, task_id: null, retry_at: null,
    next_call: { tool: 'listen_for_events', arguments: { source_id: row.source_id, connection_id: row.connection_binding.connection_id } } }));
  const writePoll = (source, value) => control(source.id, async () => {
    if (value.connection_binding) await assertConnectionBinding(value.connection_binding);
    return writeFact(`event-poll:${source.id}`, value);
  });
  // The facts say which of their kind are open (still to be tried, retried or flushed) and when each is next due, so these
  // questions read only those, never the events that came and went. A store of facts that cannot say returns them all
  // and the filters here do the same.
  const pendingAdmissions = async () => (await facts.list('event-seen:', { open: {}, shown: SEEN_SHOWN })).filter(item => item.pending);
  const keepAdmission = (key, value) => facts.write(key, value);
  const writeFact = async (name, value) => {
    await facts.write(name, value);
    if (name.startsWith('event-listen:') || name.startsWith('event-poll:')) pollRevision += 1;
  };
  const sourceById = async id => {
    const found = (await sources()).find(item => item.id === id);
    if (!found) throw new WorkshopError(`There is no event source ${id}. Known: ${(await sources()).map(item => item.id).join(', ') || 'none'}.`);
    return found;
  };
  const current = async () => (await facts.list('event-rule:')).filter(rule => !rule.removed);
  // A rule is on unless it says enabled: false; an off rule starts nothing (receive and its retries pass it over).
  const on = rule => rule.enabled !== false;
  const shown = rule => ({ rule_id: rule.rule_id, source_id: rule.source_id, event: rule.event, match: rule.match, then: rule.then, ...(rule.once_per ? { once_per: rule.once_per } : {}), ...(rule.skip ? { skip: rule.skip } : {}), ...(rule.batch ? { batch: rule.batch } : {}), ...(rule.limit ? { limit: rule.limit } : {}), ...(rule.paired_senders ? { paired_senders: rule.paired_senders } : {}), label: rule.label, enabled: on(rule), ...(rule.backs ? { backs: rule.backs } : {}), ...(rule.default ? { default: true } : {}), set_at: rule.set_at });
  const finalRuleWrite = async (key, value, result, { operation, transform = result => result }) => {
    await beforeRuleMutation(operation, { key, value });
    if (commitRule) return synchronousRuleResult(commitRule({ key, value, result: synchronousRuleResult(transform(result)), operation }));
    await facts.write(key, value);
    return transform(result);
  };

  async function set({ rule_id, source_id, event, match, then, once_per, skip, batch, limit, paired_senders, label, enabled, backs }, options = {}) {
    const source = await sourceById(source_id);
    if (nonempty(then?.workflow_id)) {
      if (!workflows) throw new WorkshopError('This service runs no workflows here.');
      await workflows.recipeOf({ workflow_id: then.workflow_id });
    }
    const existing = await current();
    const id = nonempty(rule_id) ? rule_id : `rule_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    if (!existing.some(rule => rule.rule_id === id) && existing.length >= MAX_RULES) throw new WorkshopError(`An account can have at most ${MAX_RULES} rules. Remove one first.`);
    const earlier = existing.find(rule => rule.rule_id === id);
    const rule = eventRuleOf(source, { rule_id: id, event, match, then, once_per, skip, batch, limit, paired_senders, label, enabled, backs }, { earlier, at: now().toISOString() });
    const fields = eventFieldNames(source, event);
    const listening = await facts.read(`event-listen:${source_id}`);
    const result = {
      ...shown(rule), event_fields: fields,
      listening: Boolean(listening && !listening.stopped),
      next_call: listening && !listening.stopped ? { tool: 'list_rules', arguments: {} } : { tool: 'listen_for_events', arguments: { source_id } },
    };
    // A rule set again starts counting its runs afresh.
    if (rule.limit) await facts.write(`event-fires:${id}`, { rule_id: id, count: 0, last_at: null });
    return finalRuleWrite(`event-rule:${id}`, rule, result, { ...options, operation: 'rules:set' });
  }

  async function listen({ source_id, stop, automatic = false, connection_id }) {
    const source = await sourceById(source_id);
    if (hasRouteCollection(source)) {
      if (stop !== true && connection_id !== undefined && connection_id !== source.connects_with?.connection_id)
        throw new WorkshopError('This delivered source declares its own connection; choose that connection.');
      return routeListeners.listen(source, { stop, automatic });
    }
    if (stop === true) {
      const earlier = await control(source_id, async () => {
        const latest = await facts.read(`event-listen:${source_id}`);
        // Keep the person's stop before any remote cleanup. A failed cleanup cannot make the source active again.
        await writeFact(`event-listen:${source_id}`, { ...(latest ?? {}), source_id, stopped: true, stop_requested: true, control_revision: controlRevisionOf(latest) + 1, at: now().toISOString() });
        return latest;
      });
      if (earlier?.route_key) await routeChange(source_id, async () => {
        const latest = await facts.read(`event-listen:${source_id}`);
        if (!latest?.stopped && latest?.route_key === earlier.route_key) return;
        await routes.remove(source_id, earlier.route_key, { revision: controlRevisionOf(latest) });
      });
      return { source_id, listening: false };
    }
    let earlier = await facts.read(`event-listen:${source_id}`);
    if (automatic && earlier?.stopped && earlier.stop_requested !== false)
      return { source_id, listening: false, stopped: true, retryable: false, problem: `${source.label} was explicitly stopped.` };
    if (connection_id !== undefined && (!connections || !source.connects_with?.vendor))
      throw new WorkshopError('This source has no selectable connection.');
    if (automatic && connection_id !== undefined && earlier?.connection_binding && connection_id !== earlier.connection_binding.connection_id)
      throw new WorkshopError('Automatic setup cannot replace the source’s selected account.');
    const selected = connections && source.connects_with?.vendor
      ? selectSourceConnection(source, earlier, await connections(source.connects_with.vendor), connection_id) : null;
    earlier = await control(source_id, async () => {
      const latest = await checkControl(source, controlRevisionOf(earlier));
      if (automatic || !latest?.stopped || latest.stop_requested === false) return latest;
      // Keep the new explicit start before proof. It supersedes a former stop, including legacy stop rows, without
      // claiming to be listening. A later stop advances the revision again and still fences this setup's result.
      const starting = { ...latest, stop_requested: false, control_revision: controlRevisionOf(latest) + 1, at: now().toISOString() };
      await writeFact(`event-listen:${source_id}`, starting);
      return starting;
    });
    if (selected) {
      earlier = await control(source_id, async () => {
        await checkControl(source, controlRevisionOf(earlier));
        const changed = !earlier?.connection_binding || earlier.connection_binding.control_revision !== controlRevisionOf(earlier) || selected.connection_id !== earlier.connection_binding.connection_id
          || selected.connected_at !== earlier.connection_binding.connected_at;
        const control_revision = controlRevisionOf(earlier) + Number(changed);
        const sameSelection = !earlier?.connection_binding || selected.connection_id === earlier.connection_binding.connection_id;
        const binding = { ...selected, source_id, control_revision,
          ...(sameSelection && earlier?.route_key ? { account: earlier.route_key } : {}) };
        const next = { ...earlier, source_id, control_revision, connection_binding: binding,
          ...(changed ? { stopped: true, stop_requested: false } : {}) };
        if (changed) await writeFact(`event-listen:${source_id}`, next);
        return next;
      });
    }
    const controlRevision = controlRevisionOf(earlier);
    const stillWanted = () => earlier?.connection_binding ? assertConnectionBinding(earlier.connection_binding) : checkControl(source, controlRevision);
    const setup = await Promise.all(['subscribe', 'proof'].map(purpose => facts.read(`event-listen-task:${source_id}:${purpose}`)));
    const heldSetup = setup.find(item => item && controlRevisionOf(item) === controlRevision && ['working', 'scheduled'].includes(item.state));
    const at = heldSetup?.at ?? now().toISOString();
    const proof = await readTask(source, source.route_key_proof.tool_id, source.route_key_proof.input ?? {}, at, 'proof', controlRevision);
    await stillWanted();
    if (proof.state !== 'completed') {
      const error = new WorkshopError(`The connected account could not be read, so nothing is listening yet: ${proof.error ?? proof.state}.`, proof.next_call);
      error.retry_at = proof.retry_at;
      if (proof.retryable === false) error.retryable = false;
      throw error;
    }
    const routeKey = selectDeclaredValue(proof.output, source.route_key_proof.output_selector);
    if (!(typeof routeKey === 'string' || typeof routeKey === 'number') || String(routeKey) === '') throw new WorkshopError(`The connected account did not say which account it is (${source.route_key_proof.output_selector}).`);
    if (earlier?.connection_binding?.account && earlier.connection_binding.account !== String(routeKey))
      throw Object.assign(new WorkshopError('The selected connection now identifies a different provider account; no cursor or imported file was changed.'), { retryable: false });
    const connection_binding = earlier?.connection_binding ? { ...earlier.connection_binding, account: String(routeKey) } : null;
    const sameAccount = earlier?.route_key === String(routeKey);
    const alreadySubscribed = sameAccount && !earlier?.stopped && (!source.listen_tool_id || earlier.subscribed?.state === 'completed');
    let subscribed = null;
    if (source.listen_tool_id && !alreadySubscribed) {
      const asked = await readTask(source, source.listen_tool_id, {}, at, 'subscribe', controlRevision);
      await stillWanted();
      subscribed = { state: asked.state, ...(asked.error ? { error: asked.error } : {}), task_id: asked.task_id };
      if (asked.state !== 'completed') {
        await control(source_id, async () => {
          await stillWanted();
          await writeFact(`event-listen:${source_id}`, { source_id, route_key: String(routeKey), at, stopped: true, stop_requested: false, control_revision: controlRevision, ...(connection_binding ? { connection_binding } : {}), subscribed, problem: withoutSecrets(asked.error ?? asked.state) });
        });
        const error = new WorkshopError(`${source.label} has not started sending events: ${withoutSecrets(asked.error ?? asked.state)}.`, asked.next_call);
        error.retry_at = asked.retry_at;
        if (asked.retryable === false) error.retryable = false;
        throw error;
      }
    }
    subscribed ??= sameAccount ? earlier?.subscribed ?? null : null;
    await routeChange(source_id, async () => {
      await stillWanted();
      if (earlier?.route_key && !sameAccount) await routes.remove(source_id, earlier.route_key, { revision: controlRevision });
      // A source the sender delivers to is routed only after the service confirmed its subscription. Remote route
      // calls stay outside the control section, so a stop can be kept while one of those calls is still answering.
      if (source.signature) await routes.add(source_id, String(routeKey), { revision: controlRevision });
      try {
        await control(source_id, async () => {
          await stillWanted();
          await writeFact(`event-listen:${source_id}`, { source_id, route_key: String(routeKey), at, subscribed, control_revision: controlRevision, ...(connection_binding ? { connection_binding } : {}) });
        });
      } catch (error) {
        if (source.signature) await routes.remove(source_id, String(routeKey), { revision: controlRevision });
        throw error;
      }
    });
    const existing = sameAccount ? await facts.read(`event-poll:${source_id}`) : null;
    // Reconnecting the same account carries on from its kept cursor and pending page, including after a stop.
    let reading = null;
    if (source.poll) {
      if (existing) {
        await writePoll(source, { ...existing, ...(connection_binding ? { connection_binding } : {}), next_at: Number.isFinite(existing.next_at) ? Math.min(existing.next_at, now().getTime()) : now().getTime() });
        await rearm();
        reading = { cursor_set: existing.cursor !== null, every_minutes: source.poll.every_minutes };
      } else reading = await startReading(source, at);
    }
    return { source_id, account: String(routeKey), listening: true,
      ...(connection_binding ? { connection_id: connection_binding.connection_id, connected_at: connection_binding.connected_at } : {}),
      ...(subscribed ? { service_asked_to_send: subscribed } : {}), ...(reading ? { reading } : {}), next_call: { tool: 'list_rules', arguments: {} } };
  }

  // ---- Sources Trillion reads by itself (`poll`): the service keeps no address to send to, so the account's own
  // connection reads what is new since the last read, on the store's alarm, and every new item is an event exactly as
  // if it had been delivered. Nothing that happened before listening started is an event: the first cursor is where
  // the service stands at that moment (`cursor.start`: a read of its own, or the clock).
  const MINUTE = 60000;
  const MAX_EVENTS_PER_READ = 25;
  const selected = (output, selector) => { const value = selectDeclaredValue(output, selector); return (typeof value === 'string' || typeof value === 'number') && String(value) !== '' ? String(value) : null; };
  // Every read that can outlive this wake keeps the Workshop identity before starting. A timeout means resume this
  // task, not manufacture another timestamp key and abandon the answer which the provider is still working on.
  async function readTask(source, tool_id, input, at, purpose, controlRevision = null) {
    const listener = await facts.read(`event-listen:${source.id}`);
    const binding = listener?.connection_binding;
    if (binding) {
      await assertConnectionBinding(binding);
      tool_id = await workshop.bind({ tool_id, binding });
    }
    const setup = ['proof', 'subscribe'].includes(purpose);
    const key = `${setup ? 'event-listen-task' : 'event-read-task'}:${source.id}:${purpose}`;
    const controlled = work => setup ? control(source.id, work) : work();
    let held = await controlled(async () => {
      if (setup) await checkControl(source, controlRevision);
      const before = await facts.read(key);
      const sameInput = before?.tool_id === tool_id && same(before.input, input)
        && (!setup || controlRevisionOf(before) === controlRevision);
      const pending = sameInput && ['working', 'scheduled'].includes(before.state);
      if (sameInput && before.retry_at > now().getTime()) {
        const error = new WorkshopError(before.problem ?? `${source.label} is still being read.`);
        error.retry_at = before.retry_at;
        if (before.retryable === false) error.retryable = false;
        throw error;
      }
      const resume = pending || (sameInput && before.state === 'completed' && before.at === at);
      const failures = resume ? before.failures ?? 0 : sameInput ? before?.failures ?? 0 : 0;
      const next = resume ? before : { source_id: source.id, purpose, tool_id, input, at, state: 'working',
        ...(setup ? { control_revision: controlRevision } : {}), generation: (before?.generation ?? 0) + 1,
        request_key: `event-read:${source.id}:${purpose}:${at}:attempt-${(before?.generation ?? 0) + 1}`,
        failures };
      if (!resume) await facts.write(key, next);
      return next;
    });
    const failures = held.failures ?? 0;
    const keep = value => controlled(async () => {
      if (binding) await assertConnectionBinding(binding);
      if (setup) {
        await checkControl(source, controlRevision);
        // A result from before a stop cannot overwrite the replacement task's identity or completion.
        const latest = await facts.read(key);
        if (latest?.request_key !== held.request_key) throw new WorkshopError(`${source.label}'s connection check was replaced.`);
      }
      await facts.write(key, value);
    });
    let task;
    try {
      task = held.task_id ? await workshop.read({ task_id: held.task_id })
        : await workshop.run({ tool_id, input, request_key: held.request_key, wait_seconds: 30, job: `read what is new on ${source.label}` });
    } catch (error) {
      const retry_at = now().getTime() + Math.min(MINUTE * 2 ** Math.min(failures, 6), 3600000);
      await keep({ ...held, failures: failures + 1, problem: withoutSecrets(error), retry_at, ...(error?.retryable === false ? { retryable: false } : {}) });
      const reported = error instanceof Error ? error : new WorkshopError(withoutSecrets(error));
      reported.retry_at = retry_at;
      throw reported;
    }
    const unfinished = task.state !== 'completed';
    held = { ...held, task_id: task.task_id ?? held.task_id, state: task.state, checked_at: now().toISOString(),
      failures: unfinished ? failures + 1 : 0,
      ...(task.retryable === false ? { retryable: false } : {}),
      ...(unfinished ? { problem: withoutSecrets(task.error ?? task.state), retry_at: now().getTime() + Math.min(MINUTE * 2 ** Math.min(failures, 6), 3600000) } : { problem: null, retry_at: null }) };
    await keep(held);
    return { ...task, ...(held.retry_at ? { retry_at: held.retry_at } : {}) };
  }
  async function readOnce(source, tool_id, input, at, purpose) {
    const task = await readTask(source, tool_id, input, at, purpose);
    if (task.state !== 'completed') {
      const error = new WorkshopError(`${source.label} could not be read: ${task.error ?? task.state}.`);
      error.retry_at = task.retry_at;
      if (task.retryable === false) error.retryable = false;
      throw error;
    }
    return task.output;
  }
  async function startCursor(source, at) {
    const start = source.poll.cursor.start;
    if (!start?.tool_id) return now().toISOString();
    return selected(await readOnce(source, start.tool_id, start.input ?? {}, at, 'start'), start.output_selector);
  }
  async function startReading(source, at) {
    const connection_binding = (await facts.read(`event-listen:${source.id}`))?.connection_binding;
    let cursor = null;
    let problem = null;
    try { cursor = await startCursor(source, at); } catch (error) { problem = withoutSecrets(error); }
    const next_at = now().getTime() + source.poll.every_minutes * MINUTE;
    await writePoll(source, { source_id: source.id, cursor, next_at, ...(connection_binding ? { connection_binding } : {}), ...(problem ? { problem } : {}) });
    await rearm();
    return { cursor_set: cursor !== null, every_minutes: source.poll.every_minutes, ...(problem ? { problem } : {}) };
  }

  // One read of one source: new items since the cursor become events (each read in full through `detail` when the
  // list names them only), handed to receive() like a delivery, and the cursor moves to where the service now stands.
  async function readSource(source, listening, polled, stage = null) {
    if (listening.connection_binding) {
      try { await assertConnectionBinding(listening.connection_binding); }
      catch (error) {
        await control(source.id, async () => {
          const latest = await facts.read(`event-listen:${source.id}`);
          if (controlRevisionOf(latest) === controlRevisionOf(listening) && !latest?.stop_requested)
            await writeFact(`event-listen:${source.id}`, { ...latest, stopped: true, stop_requested: false, problem: withoutSecrets(error) });
        });
        throw error;
      }
      polled = { ...polled, connection_binding: listening.connection_binding };
    }
    const at = now().toISOString();
    const next_at = now().getTime() + source.poll.every_minutes * MINUTE;
    if (polled.pending) return drainRead(source, polled, stage);
    if (polled.cursor === null) {
      // A start that fails keeps its reason for the source's health; one that works clears the last one.
      let problem = null;
      const cursor = await startCursor(source, at).catch(error => { problem = withoutSecrets(error); return null; });
      await writePoll(source, { ...polled, source_id: source.id, cursor, next_at, read_at: at, ...(problem ? { problem } : { problem: null, last_success_at: at }) });
      return { source_id: source.id, started: cursor !== null };
    }
    const { input_field, next } = source.poll.cursor;
    let output;
    try {
      output = await readOnce(source, source.poll.tool_id, { ...(source.poll.input ?? {}), [input_field]: polled.cursor }, at, 'new');
    } catch (error) {
      const said = String(error.message ?? error);
      // A cursor the service no longer keeps (too old) starts again from where the service stands now.
      const restart = (source.poll.restart_when_error_contains ?? []).some(text => said.includes(text));
      const problem = withoutSecrets(said);
      await writePoll(source, { ...polled, ...(restart ? { cursor: null, gap: polled.gap ?? { from_cursor: polled.cursor, detected_at: at, problem } } : {}), next_at, read_at: at, problem });
      return { source_id: source.id, problem };
    }
    // A service that answers with a bare list is read as { items: [...] }, so a source row walks it like any field.
    const payload = Array.isArray(output) ? { items: output } : output;
    const newerThan = name => source.events.find(item => item.name === name)?.newer_than_cursor;
    const unseen = [];
    for (const event of readDelivery(source, payload)) {
      const field = newerThan(event.name);
      if (field && !atOrAfter(String(event[field] ?? ''), polled.cursor)) continue;
      const seen = await facts.read(`event-seen:${source.id}:${event.event_id}`);
      if (seen && !seen.pending) continue;
      unseen.push({ ...event, route_key: listening.route_key });
    }
    const cursor = next.output_selector
      ? selected(payload, next.output_selector) ?? polled.cursor
      : [polled.cursor, ...readDelivery(source, payload).map(event => event[next.newest_of_field]).filter(value => typeof value === 'string')].sort(laterFirst)[0];
    // Keep the complete page before dispatching any part of it. The provider's opaque cursor is only a candidate
    // until every event is admitted; a bounded wake, restart or failed rule cannot abandon the rest of this page.
    const held = { ...polled, source_id: source.id, next_at, read_at: at, last_success_at: at, problem: null, pending: { events: unseen, cursor } };
    await writePoll(source, held);
    return drainRead(source, held, stage);
  }

  async function drainRead(source, polled, stage = null) {
    if (polled.connection_binding) await assertConnectionBinding(polled.connection_binding);
    const at = now().toISOString();
    const events = polled.pending.events.slice(0, source.poll.max_events ?? MAX_EVENTS_PER_READ);
    try {
      const detail = source.poll.detail;
      const deferred = [];
      if (detail) {
        for (let first = 0; first < events.length; first += DETAIL_READS_AT_ONCE) {
          // Out of its stage budget, the read ends after this many events; the rest stay pending in the poll row (cursor
          // and all) and the next read, a second later, takes them.
          if (first > 0 && stage && stage.left() <= 0) { events.length = first; break; }
          await Promise.all(events.slice(first, first + DETAIL_READS_AT_ONCE).map(async (event, offset) => {
            try { events[first + offset] = await detailedEvent(source, event, at); }
            catch (error) {
              // This item waits with its own error and retry; the remainder of the provider page still arrives.
              await deferDetail(source, event, error);
              deferred.push({ source_id: source.id, event_id: event.event_id, pending: true });
            }
          }));
        }
      }
      const deferredIds = new Set(deferred.map(event => event.event_id));
      const ready = events.filter(event => !deferredIds.has(event.event_id));
      const received = ready.length ? await receive({ source_id: source.id, events: ready }) : { received: 0, results: [] };
      received.results.push(...deferred);
      received.received += deferred.length;
      if (deferred.length) await rearm();
      // A pending rule is still durably admitted: event-seen retains its payload and next retry. It must not hold
      // later provider pages hostage. Only an event whose durable admission threw remains on this page.
      const done = new Set((received.results ?? []).map(result => result.event_id));
      const remaining = polled.pending.events.filter(event => !done.has(event.event_id));
      const { pending, ...kept } = polled;
      await writePoll(source, { ...kept,
        cursor: remaining.length ? polled.cursor : pending.cursor,
        next_at: now().getTime() + (remaining.length ? 1000 : source.poll.every_minutes * MINUTE),
        ...(remaining.length ? { pending: { ...pending, events: remaining } } : {}),
        problem: null,
      });
      return { source_id: source.id, received: received.received };
    } catch (error) {
      const problem = withoutSecrets(error);
      await writePoll(source, { ...polled, problem, read_at: at, next_at: now().getTime() + MINUTE });
      return { source_id: source.id, problem };
    }
  }

  async function detailedEvent(source, event, at) {
    const detail = source.poll.detail;
    const input = await buildInvocation(detail.input, { input: {}, task: {}, extra: { event } });
    const read = await readOnce(source, detail.tool_id, input, at, `detail:${event.event_id}`);
    const added = Object.entries(detail.fields).map(([name, path]) => [name, valueAt(read, path)]).filter(([, value]) => value !== undefined && value !== null && value !== '');
    return { ...event, ...Object.fromEntries(added.map(([name, value]) => [name, typeof value === 'object' ? value : String(value)])) };
  }

  async function deferDetail(source, event, error) {
    const key = `event-seen:${source.id}:${event.event_id}`;
    const before = await facts.read(key);
    if (before && !before.pending) return;
    await keepAdmission(key, { ...(before ?? {}), source_id: source.id, event: event.name, event_id: event.event_id,
      from_id: event.from_id ?? null, text: event.text ?? null, at: before?.at ?? now().toISOString(), rules: before?.rules ?? [],
      pending: true, event_payload: event, needs_detail: true, read_problem: withoutSecrets(error),
      retry_at: Number.isFinite(error?.retry_at) ? error.retry_at : now().getTime() + MINUTE });
  }

  // Reads the sources that are due now, longest waiting first and at most MAX_READS_PER_WAKE of them; the rest stay
  // due, so nextPoll brings the alarm back at once. Called on the store's alarm; one source that cannot be read never
  // stops another.
  async function pollDue(stage = null) {
    const bySource = new Map((await sources()).filter(item => item.poll).map(item => [item.id, item]));
    const nowMs = now().getTime();
    const results = [];
    // Candidates come from the kept order (one listing, made again only when a listening or a poll row was written);
    // only the source about to be read has its own rows read, so a wake costs the same however many sources listen.
    for (const { source_id, next_at } of (await pollState()).order) {
      if (next_at > nowMs || results.length >= MAX_READS_PER_WAKE || (results.length && stage && stage.left() <= 0)) break;
      const source = bySource.get(source_id);
      if (!source) continue;
      const listening = await facts.read(`event-listen:${source_id}`);
      const polled = await facts.read(`event-poll:${source_id}`);
      if (!listening || listening.stopped || !polled || polled.next_at > nowMs) continue;
      results.push(await readSource(source, listening, polled, stage).catch(error => ({ source_id, problem: withoutSecrets(error) })));
    }
    return results;
  }

  // The listening sources' next read times, earliest first, kept until a listening or a poll row is written.
  async function pollState() {
    if (cachedPoll.revision === pollRevision) return cachedPoll;
    const readRevision = pollRevision;
    const reading = new Set((await facts.list('event-listen:')).filter(item => !item.stopped).map(item => item.source_id));
    const order = (await facts.list('event-poll:')).filter(item => reading.has(item.source_id)).map(item => ({ source_id: item.source_id, next_at: item.next_at }))
      .sort((left, right) => left.next_at - right.next_at);
    const state = { revision: readRevision, at: order.length ? order[0].next_at : null, order };
    if (readRevision === pollRevision) cachedPoll = state;
    return state;
  }

  // When this store next reads a source by itself.
  async function nextPoll() { return (await pollState()).at; }

  // Each event source as a source of this account's automations (src/automations.mjs readHealth): whether it is being
  // listened to, the events that arrived, the rules on it and what each rule started for each event (or its error),
  // and a read of a source Trillion reads by itself that failed. Read from the rules and facts kept here; nothing more
  // is kept for it.
  async function health() {
    const rules = await current();
    const listenerRows = await facts.list('event-listen:');
    const sourceRows = await sources();
    const activeRows = await Promise.all(listenerRows.map(async item => {
      const source = sourceRows.find(source => source.id === item.source_id);
      return hasRouteCollection(source) ? { ...item, stopped: !(await routeListeners.state(source, item)).ready } : activeListener(source, item);
    }));
    const listening = new Set(activeRows.filter(item => !item.stopped).map(item => item.source_id));
    const attempts = [...currentConnectionAttempts(listenerRows, await facts.list('event-listen-task:')), ...bindingAttempts(activeRows)];
    // The newest arrivals and every one still pending: the events of the last 30 days are not all read to show a source.
    const recent = await facts.list('event-seen:', { newest: HEALTH_EVENTS, shown: SEEN_SHOWN });
    const seen = [...new Map([...recent, ...(await pendingAdmissions())].map(item => [`${item.source_id}:${item.event_id}`, item])).values()];
    const polled = new Map((await facts.list('event-poll:')).map(item => [item.source_id, item]));
    return (await sources()).map(source => {
      const mine = seen.filter(item => item.source_id === source.id);
      const read = polled.get(source.id);
      return {
        source_id: source.id, kind: 'event-source', label: source.label, connected: listening.has(source.id),
        connection_attempts: attempts.filter(item => item.source_id === source.id),
        pending_admissions: mine.filter(item => item.pending && (item.read_problem || item.rules?.some(rule => rule.error) || now().getTime() > item.retry_at)).length,
        ...(source.poll ? { poll: { every_minutes: source.poll.every_minutes,
          last_read_at: read?.read_at ?? null, last_success_at: read?.last_success_at ?? null,
          next_at: Number.isFinite(read?.next_at) ? new Date(read.next_at).toISOString() : null,
          pending: read?.pending?.events?.length ?? 0, problem: read?.problem ?? null, gap: read?.gap ?? null } } : {}),
        arrived: mine.map(item => ({ id: item.event_id, at: item.at, ...(item.text ? { text: item.text } : {}) })),
        rules: rules.filter(rule => rule.source_id === source.id).map(rule => ({ rule_id: rule.rule_id, label: rule.label, enabled: on(rule) })),
        runs: [
          ...mine.flatMap(item => (item.rules ?? []).filter(run => run.error || run.task_id || run.run_id).map(run => ({
            at: item.at, rule_id: run.rule_id, arrival_id: item.event_id,
            ...(run.error ? { state: 'failed', error: run.error } : { started: run.task_id ? { task_id: run.task_id } : { run_id: run.run_id } }),
          }))),
          ...(listening.has(source.id) && read?.problem && read.read_at ? [{ at: read.read_at, state: 'failed', error: read.problem }] : []),
        ],
      };
    });
  }

  // Setup is distinct from a source that was never connected. Both health and the scheduler use the same current
  // attempts; an explicit stop or a replacement control revision retires an old failure without erasing its record.
  function currentConnectionAttempts(listenerRows, taskRows) {
    const listeners = new Map(listenerRows.map(item => [item.source_id, item]));
    const reported = taskRows.filter(item => {
      const listener = listeners.get(item.source_id);
      return item.state !== 'completed' && controlRevisionOf(item) === controlRevisionOf(listener)
        && !(listener?.stopped && listener.stop_requested !== false);
    }).map(item => ({ source_id: item.source_id, purpose: item.purpose, state: item.state,
      problem: ['working', 'scheduled'].includes(item.state) && item.problem === item.state ? null : item.problem ?? null,
      at: item.checked_at ?? item.at ?? null,
      retry_at: item.retry_at ?? null, task_id: item.task_id ?? null,
      ...(item.retryable === false ? { retryable: false } : {}),
      next_call: item.task_id && ['working', 'scheduled'].includes(item.state)
        ? { tool: 'read_task', arguments: { task_id: item.task_id } }
        : { tool: 'listen_for_events', arguments: { source_id: item.source_id } },
    }));
    for (const row of listenerRows) {
      if (!row.route_keys || row.ready || !row.problem || row.stop_requested || reported.some(item => item.source_id === row.source_id && item.problem)) continue;
      reported.push({ source_id: row.source_id, purpose: 'routes', state: 'failed', problem: row.problem, at: row.at,
        retry_at: row.next_check_at ?? null, task_id: null, ...(row.retryable === false ? { retryable: false } : {}),
        next_call: { tool: 'listen_for_events', arguments: { source_id: row.source_id } } });
    }
    return reported;
  }

  // Alarm setup checks need only one row per source and setup phase, never the account's event history or rules.
  async function listenerState() {
    const listenerRows = await facts.list('event-listen:');
    const sourceRows = await sources();
    const activeRows = await Promise.all(listenerRows.map(async item => {
      const source = sourceRows.find(source => source.id === item.source_id);
      return hasRouteCollection(source) ? { ...item, stopped: !(await routeListeners.state(source, item)).ready } : activeListener(source, item);
    }));
    const listening = activeRows.filter(item => !item.stopped).map(item => ({ source_id: item.source_id,
      ...(item.route_keys ? { accounts: item.route_keys } : { account: item.route_key }), since: item.at,
      ...(item.connection_binding ? { connection_id: item.connection_binding.connection_id, connected_at: item.connection_binding.connected_at } : {}) }));
    const stopped = listenerRows.filter(item => item.stopped && item.stop_requested !== false).map(item => ({ source_id: item.source_id, at: item.at,
      ...(item.connection_binding ? { connection_id: item.connection_binding.connection_id, connected_at: item.connection_binding.connected_at } : {}) }));
    const attempts = [...currentConnectionAttempts(listenerRows, await facts.list('event-listen-task:')), ...bindingAttempts(activeRows)];
    return { listening, stopped, attempts };
  }

  async function list() {
    const rules = await current();
    const seen = (await facts.list('event-seen:', { newest: KEPT_EVENTS, shown: SEEN_SHOWN })).slice(-KEPT_EVENTS).reverse().map(shownSeen);
    const state = await listenerState();
    // Which of Trillion's default rules the person changed (facts that ship defaults say, src/shipped-defaults.mjs).
    const changed = new Set(((await facts.changesFromDefaults?.()) ?? []).map(change => change.id));
    return { rules: rules.map(rule => ({ ...shown(rule), ...(changed.has(`event-rule:${rule.rule_id}`) ? { changed_from_default: true } : {}) })), ...state, recent_events: seen };
  }


  // Gathers one event into its rule's batch (rule-skip-and-batch); the batch opens with its first event.
  async function gather(rule, event) {
    const name = `event-batch:${rule.batch.key}`;
    const open = await facts.read(name);
    const at = now().toISOString();
    const kept = open?.count ? open : { key: rule.batch.key, opened_at: at, every_minutes: rule.batch.every_minutes, count: 0, events: [] };
    if (kept.events.some(item => item.event_id === event.event_id && item.route_key === event.route_key)) return kept.count;
    const next = { ...kept, count: kept.count + 1, last_at: at, events: kept.events.length < MAX_GATHERED ? [...kept.events, { ...event, at }] : kept.events };
    await facts.write(name, next);
    await rearm();
    return next.count;
  }

  // Each batch whose time has come starts its rule once with everything gathered, keyed by the batch so a repeat
  // starts nothing more; a batch whose rules are all off or removed is let go. Called on the store's alarm.
  async function flushBatches() {
    const nowMs = now().getTime();
    const rules = (await current()).filter(rule => rule.batch && on(rule)).sort((a, b) => a.rule_id.localeCompare(b.rule_id));
    const flushed = [];
    for (const batch of await facts.list('event-batch:', { open: { due_by: nowMs } })) {
      if (!batch.count || Date.parse(batch.opened_at) + batch.every_minutes * MINUTE > nowMs) continue;
      const rule = rules.find(item => item.batch.key === batch.key);
      const request_key = `batch:${batch.key}:${batch.opened_at}`;
      const cleared = { key: batch.key, count: 0, events: [], last: { opened_at: batch.opened_at, count: batch.count, at: now().toISOString() } };
      if (!rule) { await facts.write(`event-batch:${batch.key}`, { ...cleared, last: { ...cleared.last, let_go: true } }); continue; }
      const event = { name: rule.event, count: batch.count, first_at: batch.opened_at, last_at: batch.last_at, events: batch.events };
      try {
        const input = await buildInvocation(rule.batch.input ?? rule.then.input, { input: {}, task: {}, extra: { event } });
        const started = rule.then.workflow_id
          ? { run_id: (await workflows.start({ workflow_id: rule.then.workflow_id, input, request_key })).run_id }
          : { task_id: (await workshop.run({ tool_id: rule.then.tool_id, input, request_key, wait_seconds: 0, started_by: rule.rule_id, job: rule.label })).task_id };
        await facts.write(`event-batch:${batch.key}`, { ...cleared, last: { ...cleared.last, rule_id: rule.rule_id, ...started } });
        flushed.push({ key: batch.key, rule_id: rule.rule_id, count: batch.count, ...started });
      } catch (error) {
        flushed.push({ key: batch.key, rule_id: rule.rule_id, error: String(error.message ?? error).slice(0, 300) });
      }
    }
    return flushed;
  }

  // When the next gathered batch is due.
  async function nextBatchAt() {
    const times = (await facts.list('event-batch:', { open: { limit: 1 } })).filter(batch => batch.count).map(batch => Date.parse(batch.opened_at) + batch.every_minutes * MINUTE);
    return times.length ? Math.min(...times) : null;
  }

  // On or off only; the rule keeps everything else.
  async function turn({ rule_id, enabled }, options = {}) {
    const rule = (await current()).find(item => item.rule_id === rule_id);
    if (!rule) throw new WorkshopError(`There is no rule ${rule_id}. list_rules shows this account's rules.`);
    const next = { ...rule, enabled };
    return finalRuleWrite(`event-rule:${rule_id}`, next, shown(next), { ...options, operation: 'rules:set' });
  }

  // One rule as list shows it, or null: a point read of that rule, not the list with its listeners and recent events.
  async function find({ rule_id }) {
    const rule = nonempty(rule_id) ? await facts.read(`event-rule:${rule_id}`) : null;
    return rule && !rule.removed ? shown(rule) : null;
  }

  async function remove({ rule_id }, options = {}) {
    const rule = (await current()).find(item => item.rule_id === rule_id);
    if (!rule) throw new WorkshopError(`There is no rule ${rule_id}. list_rules shows this account's rules.`);
    return finalRuleWrite(`event-rule:${rule_id}`, { rule_id, removed: true, at: now().toISOString() }, { rule_id, removed: true }, { ...options, operation: 'rules:remove' });
  }

  // Events the Worker verified. Each matching rule starts its tool or workflow once per event (or once per `once_per`
  // value).
  // When the sender lets an account answer, from the source's `delivery_policy` (DATA read from the sender's published
  // limits): how long after the event an answer is still allowed, and how many answers an hour. Past its hour's room a
  // run is scheduled into the next hour that has room; past the answer window it is not run.
  const HOUR = 3600000;
  const eventMs = event => (event.at_seconds !== undefined ? Number(event.at_seconds) * 1000 : event.at_milliseconds !== undefined ? Number(event.at_milliseconds) : null);
  async function slotFor(source, event) {
    const policy = source.delivery_policy?.by_event?.[event.name] ?? {};
    const at = eventMs(event);
    const deadline = policy.answer_within_seconds && Number.isFinite(at) ? at + policy.answer_within_seconds * 1000 : null;
    const nowMs = now().getTime();
    if (deadline !== null && nowMs > deadline) return { too_late: true };
    let hour = Math.floor(nowMs / HOUR);
    if (policy.max_per_hour) {
      for (;; hour += 1) {
        const counted = (await facts.read(`event-count:${source.id}:${event.name}:${hour}`))?.count ?? 0;
        if (counted < policy.max_per_hour) { await facts.write(`event-count:${source.id}:${event.name}:${hour}`, { count: counted + 1 }); break; }
        if (deadline !== null && hour * HOUR + HOUR > deadline) return { too_late: true };
      }
    }
    const runAt = hour === Math.floor(nowMs / HOUR) ? null : new Date(hour * HOUR).toISOString();
    return { run_at: runAt, deadline };
  }

  async function start(source, rule, event, { request_key, attempt, run_at, deadline, input }) {
    const task = await workshop.run({ tool_id: rule.then.tool_id, input, request_key, wait_seconds: 0, started_by: rule.rule_id, job: rule.label, ...(run_at ? { run_at } : {}) });
    const entity = `event-attempt:${task.task_id}`;
    // A stable Workshop request key can return a successor whose lineage already advanced or completed.
    // Never reset that current state when recovering the predecessor's completion write.
    if (!(await facts.read(entity)))
      await facts.write(entity, { task_id: task.task_id, source_id: source.id, rule_id: rule.rule_id, tool_id: rule.then.tool_id, input, base_key: request_key.replace(/:attempt-\d+$/, ''), attempt, deadline, due_at: run_at ?? now().toISOString(), done: false });
    return task;
  }

  // A run that failed in a way the source says is passing (the sender's throttle codes) is tried again later, up to the
  // source's number of attempts and never past the answer window. Called after deliveries and on the store's alarm.
  let retrying = null;
  async function retryFailed() {
    if (retrying) return retrying;
    retrying = retryFailedNow();
    try { return await retrying; }
    finally { retrying = null; }
  }

  async function retryFailedNow() {
    for (const source of (await sources()).filter(hasRouteCollection)) {
      const due = await routeListeners.due(source);
      if (Number.isFinite(due) && due <= now().getTime()) await routeListeners.runDue(source);
    }
    // A rule may fail before it has a task to inspect. Its event and completed sibling rules are kept first, so
    // the same alarm also resumes those admissions after a restart, without needing another provider delivery.
    const listening = new Set((await facts.list('event-listen:')).filter(item => !item.stopped).map(item => item.source_id));
    // Only the earliest due of the sources being listened to are read; a page with fewer usable events than a read takes
    // (events kept before their payload was) is read again, larger.
    let waiting = [];
    for (let limit = MAX_EVENTS_PER_READ; listening.size; limit *= 4) {
      const rows = await facts.list('event-seen:', { open: { scopes: [...listening], due_by: now().getTime(), limit } });
      waiting = rows.filter(item => item.pending && item.event_payload && listening.has(item.source_id) && item.retry_at <= now().getTime())
        .sort((left, right) => left.retry_at - right.retry_at).slice(0, MAX_EVENTS_PER_READ);
      if (waiting.length >= MAX_EVENTS_PER_READ || rows.length < limit) break;
    }
    const blocked = new Set();
    for (let first = 0; first < waiting.length; first += DETAIL_READS_AT_ONCE) {
      await Promise.all(waiting.slice(first, first + DETAIL_READS_AT_ONCE).map(async item => {
        if (!item.needs_detail) return;
        const source = await sourceById(item.source_id);
        try {
          item.event_payload = await detailedEvent(source, item.event_payload, now().toISOString());
          item.needs_detail = false; delete item.read_problem;
          await keepAdmission(`event-seen:${item.source_id}:${item.event_id}`, item);
        } catch (error) {
          await deferDetail(source, item.event_payload, error);
          blocked.add(item);
        }
      }));
    }
    for (const item of waiting) if (!blocked.has(item)) {
      try { await receive({ source_id: item.source_id, events: [item.event_payload] }); }
      catch (error) { if (!error?.route_pending) throw error; }
    }
    const pending = (await facts.list('event-attempt:', { open: {} })).filter(item => !item.done);
    const bySource = new Map((await sources()).map(item => [item.id, item]));
    let retried = 0;
    for (const attempt of pending) {
      let task;
      // A task the Workshop says it does not hold (erased, or never kept) is never coming back, so its attempt is over;
      // left open it kept this source due, waking the store every minute for good. Any other failure is read again later.
      try { task = await workshop.read({ task_id: attempt.task_id }); }
      catch (error) {
        if (error instanceof WorkshopError) await facts.write(`event-attempt:${attempt.task_id}`, { ...attempt, done: true, state: 'missing' });
        continue;
      }
      if (task.state === 'working' || task.state === 'scheduled') continue;
      const source = bySource.get(attempt.source_id);
      const retry = source?.delivery_policy?.retry;
      const rule = retry && task.state === 'failed' ? (await current()).find(item => item.rule_id === attempt.rule_id) : null;
      const passing = task.state === 'failed' && retry && (retry.when_error_contains ?? []).some(text => String(task.error ?? '').includes(text));
      if (!passing || attempt.attempt >= (retry?.max_attempts ?? 1) || !rule || !on(rule)) {
        await facts.write(`event-attempt:${attempt.task_id}`, { ...attempt, done: true, state: task.state });
        continue;
      }

      let plan = attempt.retry_plan;
      if (!plan) {
        const nextAt = now().getTime() + (retry.after_seconds ?? 900) * 1000;
        if (attempt.deadline !== null && nextAt > attempt.deadline) {
          await facts.write(`event-attempt:${attempt.task_id}`, { ...attempt, done: true, state: task.state });
          continue;
        }
        plan = {
          request_key: `${attempt.base_key}:attempt-${attempt.attempt + 1}`,
          attempt: attempt.attempt + 1,
          run_at: new Date(nextAt).toISOString(),
        };
        try {
          await facts.write(`event-attempt:${attempt.task_id}`, { ...attempt, retry_plan: plan, due_at: plan.run_at });
        } catch { continue; }
      }
      if (typeof plan.request_key !== 'string' || !Number.isInteger(plan.attempt) || !Number.isFinite(Date.parse(plan.run_at))
        || (attempt.deadline !== null && Date.parse(plan.run_at) > attempt.deadline)) {
        await facts.write(`event-attempt:${attempt.task_id}`, { ...attempt, done: true, state: task.state });
        continue;
      }
      // Recovery can happen after the saved run time. Do not let a durable plan outlive its answer window.
      if (attempt.deadline !== null && now().getTime() > attempt.deadline) {
        await facts.write(`event-attempt:${attempt.task_id}`, { ...attempt, done: true, state: task.state });
        continue;
      }
      try {
        const successor = await start(source, rule, null, { request_key: plan.request_key, attempt: plan.attempt, run_at: plan.run_at, deadline: attempt.deadline, input: attempt.input });
        await facts.write(`event-attempt:${attempt.task_id}`, { ...attempt, retry_plan: plan, done: true, state: task.state, successor_task_id: successor.task_id });
      } catch { continue; }
      retried += 1;
    }
    return retried;
  }

  // Read scalar timing from the current-fact index, never the pending events' bodies. Subscribed routes use their
  // earliest finite retry; a registered route still being confirmed needs only an indexed existence check.
  async function routedRetries(source) {
    const state = await routeListeners.state(source);
    if (!state.current_connection || state.stop_requested) return [];
    const subscribed = state.route_keys ?? [], registered = state.registered_route_keys ?? [];
    const confirming = registered.filter(key => !subscribed.includes(key));
    const times = [];
    if (subscribed.length) {
      const [next] = await facts.list('event-seen:', { next: { scopes: [source.id], routes: subscribed } });
      if (Number.isFinite(next?.at)) times.push(next.at);
    }
    if (confirming.length) {
      const [next] = await facts.list('event-seen:', { next: { scopes: [source.id], routes: confirming, pending: true } });
      if (next?.pending) times.push(now().getTime() + 60_000);
    }
    return times;
  }

  // When this store next has an attempt to look at: a minute after the earliest pending one was due.
  async function nextCheck() {
    const [attempt] = await facts.list('event-attempt:', { next: {} });
    const times = Number.isFinite(attempt?.at) ? [attempt.at] : [];
    const sourceRows = await sources();
    // Exact declared listener reads avoid the complete-value legacy fill before the bounded summary migration.
    const listenerRows = await Promise.all(sourceRows.map(source => facts.read(`event-listen:${source.id}`)));
    const listening = new Set(sourceRows.filter((source, index) => listenerRows[index]?.source_id === source.id && !listenerRows[index].stopped).map(source => source.id));
    // The earliest retry among the events of the sources being listened to is one index read, however many are waiting.
    const routed = new Set(sourceRows.filter(source => listening.has(source.id) && hasRouteCollection(source)).map(source => source.id));
    const plain = [...listening].filter(id => !routed.has(id));
    if (plain.length) {
      const [next] = await facts.list('event-seen:', { next: { scopes: plain, from_due: 1 } });
      if (Number.isFinite(next?.at)) times.push(next.at);
    }
    for (const source of sourceRows.filter(source => routed.has(source.id))) times.push(...await routedRetries(source));
    for (const source of sourceRows.filter(hasRouteCollection)) {
      const due = await routeListeners.due(source);
      if (Number.isFinite(due)) times.push(due);
    }
    return times.length ? Math.min(...times) : null;
  }

  const pairing = makeSenderPairing({ facts, now });

  async function receive({ source_id, events }) {
    const listening = await facts.read(`event-listen:${source_id}`);
    if (listening?.connection_binding && !listening.stopped) await assertConnectionBinding(listening.connection_binding);
    const source = await sourceById(source_id);
    const rules = (await current()).filter(rule => rule.source_id === source_id && on(rule));
    const results = [];
    for (const event of Array.isArray(events) ? events : []) {
      if (!object(event) || !nonempty(event.event_id)) continue;
      if (hasRouteCollection(source)) { if (!(await routeListeners.accepts(source, event))) continue; }
      else if (!listening || listening.stopped || listening.route_key !== event.route_key) continue;
      const key = `event-seen:${source_id}:${event.event_id}`;
      // Concurrent webhook deliveries and the poll retry share one admission, as do calls after an isolate restart.
      if (receiving.has(key)) { results.push(await receiving.get(key)); continue; }
      const admit = async () => {
        if (listening?.connection_binding) await assertConnectionBinding(listening.connection_binding);
        const earlier = await facts.read(key);
        if (earlier && !earlier.pending) return { source_id, event_id: event.event_id, already_handled: true };
        if (earlier?.pending && earlier.retry_at > now().getTime()) return { ...earlier, pending: true };
        const started = (earlier?.rules ?? []).filter(rule => !rule.error);
        const record = { source_id, event: event.name, event_id: event.event_id, from_id: event.from_id ?? null, text: event.text ?? null, at: earlier?.at ?? now().toISOString(), rules: started };
        const failures = (earlier?.failures ?? 0) + 1;
        const retryAt = now().getTime() + Math.min(MINUTE * 2 ** Math.min(failures - 1, 6), HOUR);
        const keepPending = () => keepAdmission(key, { ...record, rules: [...started], pending: true, event_payload: event, failures, retry_at: retryAt });
        // This is the durable admission boundary. A deploy between a side effect and its receipt repeats that rule's
        // existing request key; a deploy between rules retains the completed siblings and resumes only the remainder.
        await keepPending();
        for (const rule of rules.filter(item => item.event === event.name && MATCHERS[item.match.kind](item.match, event))) {
          if (started.some(done => done.rule_id === rule.rule_id && !done.error)) continue;
          try {
            const onceName = rule.once_per ? `event-once:${rule.rule_id}:${event[rule.once_per]}` : null;
            if (onceName && (await facts.read(onceName))) { started.push({ rule_id: rule.rule_id, skipped: `already done for this ${rule.once_per}` }); continue; }
            if (skipped(rule, event)) { started.push({ rule_id: rule.rule_id, skipped: 'left out by the rule' }); continue; }
            if (rule.batch) { started.push({ rule_id: rule.rule_id, gathered: await gather(rule, event) }); continue; }
            if (rule.paired_senders && typeof event[rule.paired_senders] === 'string' && !(await pairing.isPaired({ source_id, sender: event[rule.paired_senders] }))) {
              const asked = await pairing.request({ source_id, sender: event[rule.paired_senders] });
              started.push({ rule_id: rule.rule_id, skipped: asked.said, ...(asked.code ? { pairing_code: asked.code, pairing_expires_at: asked.expires_at } : {}) });
              continue;
            }
            const fired = rule.limit ? await facts.read(`event-fires:${rule.rule_id}`) : null;
            const held = heldByLimit(rule.limit, fired, now().getTime());
            if (held) { started.push({ rule_id: rule.rule_id, skipped: `its limit holds it back: ${held}` }); continue; }
            const counted = () => (rule.limit ? facts.write(`event-fires:${rule.rule_id}`, { rule_id: rule.rule_id, count: (fired?.count ?? 0) + 1, last_at: now().toISOString() }) : null);
            const slot = await slotFor(source, event);
            if (slot.too_late) { started.push({ rule_id: rule.rule_id, skipped: 'too late to answer this one' }); continue; }
            const input = await buildInvocation(rule.then.input, { input: {}, task: {}, extra: { event } });
            const request_key = `event:${source_id}:${event.event_id}:${rule.rule_id}`;
            // A workflow starts now, keyed by the event like a tool run, so a repeated delivery starts one run.
            if (rule.then.workflow_id) {
              if (!workflows) throw new WorkshopError('This service runs no workflows here.');
              const run = await workflows.start({ workflow_id: rule.then.workflow_id, input, request_key });
              if (onceName) await facts.write(onceName, { run_id: run.run_id, at: now().toISOString() });
              await counted();
              started.push({ rule_id: rule.rule_id, run_id: run.run_id, state: run.state });
              continue;
            }
            const task = await start(source, rule, event, { request_key, attempt: 1, run_at: slot.run_at, deadline: slot.deadline, input });
            if (onceName) await facts.write(onceName, { task_id: task.task_id, at: now().toISOString() });
            await counted();
            started.push({ rule_id: rule.rule_id, task_id: task.task_id, state: task.state, ...(slot.run_at ? { runs_at: slot.run_at } : {}) });
          } catch (error) {
            started.push({ rule_id: rule.rule_id, error: withoutSecrets(error) });
          } finally {
            await keepPending();
          }
        }
        if (started.some(rule => rule.error)) {
          // The persisted admission already names its exact retry time. Bring the alarm forward for that time
          // rather than gathering every unrelated source again after each failed rule.
          await rearm(retryAt);
          return { ...record, rules: [...started], pending: true };
        }
        await keepAdmission(key, { ...record, rules: [...started] });
        return { ...record, rules: [...started] };
      };
      const work = admit();
      receiving.set(key, work);
      try { results.push(await work); } finally { receiving.delete(key); }
    }
    // The runs finish after this reply; a throttled one is looked at again once they have had time to answer.
    if (results.some(item => item.rules?.some(rule => rule.task_id))) (keepAlive ?? (() => {}))(new Promise(resolve => setTimeout(resolve, settleMs)).then(retryFailed).catch(() => {}));
    return { received: results.length, results };
  }

  // A lost receive read from the admissions it keeps, never by receiving again: each event the receive would take is
  // answered by its kept admission; one still pending, or one it would take with no admission while another has one,
  // cannot say how far this call got; with no admission for any of them it took nothing.
  async function receivedOutcome({ source_id, events }) {
    const listening = await facts.read(`event-listen:${source_id}`);
    const source = await sourceById(source_id);
    const results = [];
    let untaken = 0;
    for (const event of Array.isArray(events) ? events : []) {
      if (!object(event) || !nonempty(event.event_id)) continue;
      if (hasRouteCollection(source)) { if (!(await routeListeners.accepts(source, event))) continue; }
      else if (!listening || listening.stopped || listening.route_key !== event.route_key) continue;
      const kept = await facts.read(`event-seen:${source_id}:${event.event_id}`);
      if (!kept) { untaken += 1; continue; }
      if (kept.pending) return { state: 'unknown' };
      const { event_payload: _payload, failures: _failures, retry_at: _retry, ...record } = kept;
      results.push(record);
    }
    if (!results.length) return { state: 'aborted' };
    return untaken ? { state: 'unknown' } : { state: 'committed', result: { received: results.length, results } };
  }

  // Back to Trillion's shipped version of a default rule (facts that ship defaults answer resetDefault, src/shipped-defaults.mjs).
  // → the rule as it reads now, or null when this rule is not one of Trillion's defaults.
  async function resetDefault({ rule_id }) {
    if (!(await facts.resetDefault?.(`event-rule:${rule_id}`))) return null;
    const rule = await facts.read(`event-rule:${rule_id}`);
    return rule ? shown(rule) : null;
  }

  async function connectionRemoved(connection_id) {
    for (const row of await facts.list('event-listen:')) {
      if (row.connection_binding?.connection_id !== connection_id || row.stop_requested) continue;
      // A late disconnect callback cannot stop a replacement incarnation that is already connected.
      if ((await connectionNamed(connection_id))?.status === 'connected') continue;
      await control(row.source_id, async () => {
        const latest = await facts.read(`event-listen:${row.source_id}`);
        if (controlRevisionOf(latest) === controlRevisionOf(row) && !latest?.stop_requested)
          await writeFact(`event-listen:${row.source_id}`, { ...latest, stopped: true, stop_requested: false, problem: 'The selected source connection was disconnected.' });
      });
    }
    for (const source of (await sources()).filter(hasRouteCollection)) {
      if (source.connects_with.connection_id === connection_id) await routeListeners.connectionRemoved(source);
    }
  }

  return { set, turn, listen, assertConnectionBinding, connectionRemoved, list, listenerState, health, find, remove, receive, receivedOutcome, retryFailed, nextCheck, pollDue, nextPoll, flushBatches, nextBatchAt, resetDefault, pairing };
}

export const isEventsPath = pathname => pathname.startsWith('/events/');

export async function handleEventsRequest(rules, request) {
  const { pathname } = new URL(request.url);
  const body = async () => { const raw = await request.text(); if (raw.length > MAX_DELIVERY_BYTES) throw new WorkshopError('Request too large'); return JSON.parse(raw || '{}'); };
  try {
    if (request.method === 'POST' && pathname === '/events/listen') return json(await rules.listen(await body()));
    if (request.method === 'POST' && pathname === '/events/receive') return json(await rules.receive(await body()));
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (failureOf(error).tries_again_later) throw error;
    return json({ error: String(error.message ?? error), ...(error.next_call ? { next_call: error.next_call } : {}) }, 400);
  }
}
