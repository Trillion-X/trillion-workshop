// src/mcp-events.mjs
//
// Purpose
//   MCP Events for a chat app connected to Trillion's MCP server (OpenAI's MCP Events, protocol 2026-07-28, webhook
//   delivery only: https://developers.openai.com/plugins/build/mcp-events). A chat subscribes to an event
//   (events/subscribe) with a callback address and a signing secret; when work moves in the person's Trillion (a
//   handoff moment, src/agents.mjs tell), the matching subscriptions are sent one signed POST each, and the chat that
//   subscribed acts on it. This is how a subscribed ChatGPT chat is started on work handed to it: the callback being
//   accepted means only that the host received it, never that the chat did the work (read_handoff shows that).
//
// Non-negotiable invariants
//   1. Which events exist, what they carry and which moments make them is DATA (src/mcp-events.json); nothing here
//      names an event, a moment or a handoff field.
//   2. A subscription belongs to the account's store and to the AI that made it (its reader), and its id is made from
//      (reader, callback address, event name, arguments as canonical JSON): subscribing again is the same subscription
//      (a new secret or expiry replaces the old), and key order never makes a second one.
//   3. A callback address is accepted only after it answered a signed, single-use verification challenge, and only an
//      https address with no credentials and no local or private host; redirects are never followed.
//   4. Every event is kept before any attempt. Its eventId is stable across retries; every attempt is signed afresh
//      (Standard Webhooks: webhook-id, webhook-timestamp, webhook-signature, over the exact bytes sent). 2xx delivers
//      it; 410 ends the subscription; 413 ends the event; anything else is tried again after RETRY waits, then kept
//      as dead.
//   5. The HMAC and its SHA-256 hash are fixed by the Standard Webhooks protocol the host verifies; they are that
//      protocol's check, never an identity this service mints (identities here are BLAKE3).
//   6. A webhook the person makes on their own screen (src/webhooks-screen.mjs) is a subscription whose reader is
//      DATA `person_reader`: it gets every moment of its event (or only an agent's, when it names one) and does not
//      lapse on the 30-day refresh clock a chat's does (`person_grant_ms`); the person ends it.
//   7. A payload carries the handoff's own fields named by the event's payloadSchema, never an instruction to the model.
//
// store: { subscription(id), putSubscription(s), deleteSubscription(id), subscriptions(), deleteForGrant(grant),
//          verified(key) -> iso | null, putVerified(key, iso),
//          delivery(id), putDelivery(item), dueDeliveries(nowIso), waitingFor(subscription_id), nextDeliveryAt() }
// send(url, body, headers) -> { ok, status, text }
//
import rules from './mcp-events.json' with { type: 'json' };
import { publicAddressOrNull } from '../../../refuse-requests-to-private-addresses/public-address.mjs';
import { makeHashCodeHexFromBytes } from '../../../content-identity/read-data/identity.mjs';

export class McpEventsError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
// JSON-RPC codes the MCP Events contract names.
export const INVALID_PARAMS = -32602;
export const CALLBACK_ENDPOINT_ERROR = -32015;

const encoder = new TextEncoder();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashed = value => makeHashCodeHexFromBytes(encoder.encode(value)).slice(3, 35);
const base64 = bytes => btoa(String.fromCharCode(...bytes));

/** JSON with every object's keys sorted, so the same arguments in any key order are the same text. */
export const canonical = value => JSON.stringify(value, (_, inner) => (object(inner) ? Object.fromEntries(Object.keys(inner).sort().map(key => [key, inner[key]])) : inner));

export const subscriptionId = ({ reader, url, name, args }) => `sub_${hashed(canonical([reader ?? null, url, name, args ?? {}]))}`;

/** The secret's bytes when it is `whsec_` + base64 of 24 to 64 bytes, else null. */
export function secretBytes(secret) {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) return null;
  try {
    const bytes = Uint8Array.from(atob(secret.slice('whsec_'.length)), char => char.charCodeAt(0));
    return bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
  } catch { return null; }
}

/** A Standard Webhooks signature: `v1,<base64 HMAC over "${id}.${timestamp}.${body}">`. */
export async function signWebhook(secret, id, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `v1,${base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${id}.${timestamp}.${body}`))))}`;
}

/** The callback address when it is https, carries no credentials and names a public host (parts/http-client/do-work/public-address.mjs), else null. */
export const callbackAddress = value => publicAddressOrNull(value);

// The arguments a subscription gives, checked against the event's inputSchema (objects of string and boolean fields).
function checkedArguments(schema, given, lenient = false) {
  const args = given === undefined || given === null ? {} : given;
  if (!object(args)) throw new McpEventsError(INVALID_PARAMS, 'arguments must be an object.');
  const properties = schema?.properties ?? {};
  for (const [name, value] of Object.entries(args)) {
    const expected = properties[name]?.type;
    if (!expected) {
      if (schema?.additionalProperties === false) throw new McpEventsError(INVALID_PARAMS, `Unknown argument ${name}.`);
      continue;
    }
    if (typeof value !== expected) throw new McpEventsError(INVALID_PARAMS, `${name} must be a ${expected}.`);
  }
  for (const name of lenient ? [] : schema?.required ?? []) if (!(name in args)) throw new McpEventsError(INVALID_PARAMS, `${name} is needed.`);
  return args;
}

const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length
  && [...left].reduce((diff, char, index) => diff | (char.charCodeAt(0) ^ right.charCodeAt(index)), 0) === 0;

// The event's data: the handoff fields its payloadSchema names, text cut to the DATA's length.
const payloadOf = (definition, handoff, max) => Object.fromEntries(Object.keys(definition.payloadSchema?.properties ?? {})
  .map(field => [field, typeof handoff[field] === 'string' ? (handoff[field].length > max ? `${handoff[field].slice(0, max - 1)}…` : handoff[field]) : handoff[field] ?? null]));

// Whether a handoff moment goes to one subscription: by the agent its arguments name, else by the AI that subscribed.
function matches(definition, subscription, { moment, handoff, for_reader }, settings) {
  if (!definition.moments.includes(moment)) return false;
  if (subscription.reader && subscription.reader === settings.person_reader && !subscription.arguments?.[definition.agent_argument]) return true;
  const args = subscription.arguments ?? {};
  if ((definition.anyone_moments ?? []).includes(moment)) return args[definition.anyone_argument] === true;
  const agent = definition.agent_argument ? args[definition.agent_argument] : undefined;
  if (agent) return handoff[definition.agent_field] === agent;
  return Boolean(for_reader) && for_reader === subscription.reader;
}

export const eventList = (settings = rules) => settings.events.map(({ name, description, inputSchema, payloadSchema }) => ({ name, description, delivery: ['webhook'], inputSchema, payloadSchema }));

/** The events a person may send a webhook on, with the words they read: [{ name, label }]. */
export const personEvents = (settings = rules) => settings.events.map(({ name, label }) => ({ name, label }));

// `allowed(grant)` → whether the sign-in that made a subscription still reaches the account; a subscription whose
// sign-in was turned off ends at its next delivery instead of sending anything.
export function makeMcpEvents({ store, send, now = () => new Date(), settings = rules, random = () => crypto.getRandomValues(new Uint8Array(24)), allowed = async () => true }) {
  const at = () => now().toISOString();
  const definition = name => settings.events.find(item => item.name === name);

  function deliveryOf(params) {
    const delivery = params?.delivery;
    if (!object(delivery) || delivery.mode !== 'webhook') throw new McpEventsError(INVALID_PARAMS, 'delivery.mode must be webhook.');
    const url = callbackAddress(delivery.url);
    if (!url) throw new McpEventsError(CALLBACK_ENDPOINT_ERROR, 'The callback address must be a public https address.', { reason: 'invalid_url' });
    return { url, secret: delivery.secret };
  }

  function target(params, lenient = false) {
    const found = definition(params?.name);
    if (!found) throw new McpEventsError(INVALID_PARAMS, `Unknown event ${params?.name}. events/list names the events.`);
    const args = checkedArguments(found.inputSchema, params.arguments, lenient);
    return { found, args };
  }

  // One signed POST; `body` is sent exactly as signed.
  async function post(url, secret, webhookId, subscription, body) {
    const timestamp = String(Math.floor(now().getTime() / 1000));
    return send(url, body, {
      'content-type': 'application/json', 'webhook-id': webhookId, 'webhook-timestamp': timestamp,
      'webhook-signature': await signWebhook(secret, webhookId, timestamp, body), 'x-mcp-subscription-id': subscription,
    });
  }

  // The callback proves it is the subscriber's by echoing a single-use challenge; a pass is kept for a while per
  // reader and address.
  async function verify({ url, secret, reader, id }) {
    const key = `${reader ?? ''} ${url}`;
    const passed = store.verified(key);
    if (passed && Date.parse(passed) + settings.verified_for_ms > now().getTime()) return;
    const challenge = base64(random()).replace(/[+/=]/g, '');
    let answer;
    try { answer = await post(url, secret, `ver_${hashed(`${id} ${challenge}`)}`, id, JSON.stringify({ type: 'verification', challenge })); }
    catch (error) { throw new McpEventsError(CALLBACK_ENDPOINT_ERROR, 'The callback address did not answer.', { reason: /timeout|abort/i.test(String(error?.message ?? error)) ? 'timeout' : 'unreachable' }); }
    let echoed = null;
    try { echoed = JSON.parse(answer.text ?? '')?.challenge ?? null; } catch { echoed = null; }
    if (!answer.ok || !equal(echoed, challenge)) throw new McpEventsError(CALLBACK_ENDPOINT_ERROR, 'The callback address did not return the challenge.', { reason: 'challenge_failed', status: answer.status });
    store.putVerified(key, at());
  }

  async function subscribe(params = {}, { reader = null, grant = null } = {}) {
    const { found, args } = target(params, reader === settings.person_reader);
    const { url, secret } = deliveryOf(params);
    if (!secretBytes(secret)) throw new McpEventsError(INVALID_PARAMS, 'delivery.secret must be whsec_ followed by base64 of 24 to 64 bytes.');
    const id = subscriptionId({ reader, url, name: found.name, args });
    const earlier = store.subscription(id);
    if (!earlier && store.subscriptions().length >= settings.max_subscriptions) throw new McpEventsError(INVALID_PARAMS, `At most ${settings.max_subscriptions} event subscriptions per account.`);
    await verify({ url, secret, reader, id });
    const asked = params.ttlMs;
    const { min, max } = settings.grant_ms;
    const granted = reader === settings.person_reader ? settings.person_grant_ms : asked === undefined ? settings.grant_ms.default : asked === null ? max : Math.min(max, Math.max(min, Number(asked) || min));
    const expires = now().getTime() + granted;
    const label = typeof params.label === 'string' ? params.label.replace(/\s+/g, ' ').trim().slice(0, settings.label_max) : '';
    const subscription = {
      id, name: found.name, arguments: args, url, secret, reader, grant, ...(label || earlier?.label ? { label: label || earlier.label } : {}),
      created_at: earlier?.created_at ?? at(), refreshed_at: at(), expires_at: new Date(expires).toISOString(),
      delivered: earlier?.delivered ?? 0, last_delivered_at: earlier?.last_delivered_at ?? null,
    };
    store.putSubscription(subscription);
    return { id, refreshBefore: new Date(now().getTime() + granted * settings.refresh_share).toISOString(), cursor: null, truncated: false };
  }

  // A lost subscribe read from the subscription it keeps, never by subscribing again (no challenge is sent): the
  // subscription under its id with the asked secret is that subscribe, answered as it answered; none, or one refreshed
  // with another secret, cannot say whether it was made (it may have ended since).
  function subscribedOutcome(params = {}, { reader = null } = {}) {
    let id, secret;
    try { const { found, args } = target(params); const delivery = deliveryOf(params); secret = delivery.secret; id = subscriptionId({ reader, url: delivery.url, name: found.name, args }); }
    catch (error) { if (error instanceof McpEventsError) return { state: 'aborted' }; throw error; }
    const subscription = store.subscription(id);
    if (!subscription || subscription.secret !== secret) return { state: 'unknown' };
    const refreshed = Date.parse(subscription.refreshed_at), granted = Date.parse(subscription.expires_at) - refreshed;
    return { state: 'committed', result: { id, refreshBefore: new Date(refreshed + granted * settings.refresh_share).toISOString(), cursor: null, truncated: false } };
  }

  function unsubscribe(params = {}, { reader = null } = {}) {
    const { found, args } = target(params);
    const url = callbackAddress(params?.delivery?.url);
    if (url) store.deleteSubscription(subscriptionId({ reader, url, name: found.name, args }));
    return {};
  }

  // A handoff moment: every live subscription it matches gets one kept event, sent by deliver().
  function heard(moment) {
    const nowIso = at();
    let kept = 0;
    for (const subscription of store.subscriptions()) {
      if (subscription.expires_at <= nowIso) continue;
      const found = definition(subscription.name);
      if (!found || !matches(found, subscription, moment, settings)) continue;
      const handoff = moment.handoff;
      const eventId = `evt_${hashed(canonical([subscription.id, found.name, handoff.handoff_id, handoff.finished_at ?? handoff.in_the_way_at ?? handoff.handed_at ?? null]))}`;
      if (store.delivery(eventId) || store.waitingFor(subscription.id) >= settings.max_waiting) continue;
      const body = { eventId, name: found.name, timestamp: nowIso, data: payloadOf(found, handoff, settings.text_max), cursor: null };
      store.putDelivery({ event_id: eventId, subscription_id: subscription.id, body, state: 'waiting', attempts: 0, next_at: nowIso, created_at: nowIso });
      kept += 1;
    }
    return { kept };
  }

  async function deliver() {
    const results = [];
    // A callback awaits an outside service. Its sign-in can expire or be revoked
    // during that wait, so permission must be read again before the next delivery.
    const stillAllowed = grant => grant ? allowed(grant) : true;
    for (const item of store.dueDeliveries(at())) {
      const subscription = store.subscription(item.subscription_id);
      const attempts = item.attempts + 1;
      const body = JSON.stringify(item.body);
      let outcome;
      if (!subscription || subscription.expires_at <= at()) outcome = { end: 'dead', error: 'The subscription ended.' };
      else if (!(await stillAllowed(subscription.grant))) outcome = { end: 'dead', gone: true, error: 'The sign-in that made this subscription was turned off or expired.' };
      else if (encoder.encode(body).length > settings.max_body_bytes) outcome = { end: 'dead', error: 'The event is larger than a callback takes.' };
      else {
        try {
          const answer = await post(subscription.url, subscription.secret, item.event_id, subscription.id, body);
          outcome = answer.ok ? { end: 'delivered' } : answer.status === 410 ? { end: 'dead', gone: true, error: 'The subscriber ended the subscription (410).' }
            : answer.status === 413 ? { end: 'dead', error: 'The callback refused the size (413).' } : { error: `The callback answered ${answer.status}.` };
        } catch (error) { outcome = { error: `No answer: ${String(error?.message ?? error).slice(0, 200)}` }; }
      }
      const wait = settings.retry_seconds[attempts - 1];
      const nowIso = at();
      const state = outcome.end ?? (wait === undefined ? 'dead' : 'waiting');
      const updated = { ...item, attempts, state, last_attempt_at: nowIso, last_error: outcome.error ?? null,
        next_at: state === 'waiting' ? new Date(now().getTime() + wait * 1000).toISOString() : null, ...(state === 'delivered' ? { delivered_at: nowIso } : {}) };
      store.putDelivery(updated);
      if (outcome.gone) store.deleteSubscription(subscription.id);
      else if (state === 'delivered') store.putSubscription({ ...subscription, delivered: (subscription.delivered ?? 0) + 1, last_delivered_at: nowIso });
      results.push({ event_id: item.event_id, subscription_id: item.subscription_id, name: item.body.name, state, attempts, last_error: updated.last_error });
    }
    return results;
  }

  // What the person's screens and agent cards read: each live subscription without its secret.
  const live = () => store.subscriptions().filter(item => item.expires_at > at()).map(({ secret, ...rest }) => rest);

  // The webhooks one reader (the person's own screen) made, kept to that reader: a test ping signed like an event, and ending one.
  const ownedBy = (reader, id) => { const found = store.subscription(id); return found && found.reader === reader ? found : null; };
  async function ping(id, { reader = null } = {}) {
    const found = ownedBy(reader, id);
    if (!found) throw new McpEventsError(INVALID_PARAMS, 'That webhook is not there.');
    const webhookId = `tst_${hashed(`${id} ${at()}`)}`;
    const body = JSON.stringify({ type: 'test', eventId: webhookId, name: found.name, timestamp: at(), data: {}, cursor: null });
    try { const answer = await post(found.url, found.secret, webhookId, found.id, body); return { ok: answer.ok, status: answer.status }; }
    catch { return { ok: false, status: 0 }; }
  }
  function endOwned(id, { reader = null } = {}) {
    if (!ownedBy(reader, id)) return false;
    store.deleteSubscription(id);
    return true;
  }

  return { list: () => ({ events: eventList(settings) }), ping, endOwned, liveFor: reader => live().filter(item => item.reader === reader), personReader: settings.person_reader, newSecret: () => `whsec_${base64(random())}`, subscribe, subscribedOutcome, unsubscribe, heard, deliver, live, nextDeliveryAt: () => store.nextDeliveryAt(), endGrant: grant => store.deleteForGrant(grant) };
}

// The same store over plain maps: tests, and any host with no database.
export function memoryMcpEventStore() {
  const subscriptions = new Map();
  const verified = new Map();
  const deliveries = new Map();
  const copy = value => structuredClone(value ?? null);
  return {
    subscription: id => copy(subscriptions.get(id)), putSubscription: item => { subscriptions.set(item.id, copy(item)); },
    deleteSubscription: id => { subscriptions.delete(id); }, subscriptions: () => [...subscriptions.values()].map(copy),
    deleteForGrant: grant => { for (const [id, item] of subscriptions) if (item.grant === grant) subscriptions.delete(id); },
    verified: key => verified.get(key) ?? null, putVerified: (key, iso) => { verified.set(key, iso); },
    delivery: id => copy(deliveries.get(id)), putDelivery: item => { deliveries.set(item.event_id, copy(item)); },
    dueDeliveries: nowIso => [...deliveries.values()].filter(item => item.state === 'waiting' && item.next_at <= nowIso).sort((a, b) => a.next_at.localeCompare(b.next_at)).map(copy),
    waitingFor: id => [...deliveries.values()].filter(item => item.subscription_id === id && item.state === 'waiting').length,
    nextDeliveryAt: () => [...deliveries.values()].filter(item => item.state === 'waiting').map(item => Date.parse(item.next_at)).sort((a, b) => a - b)[0] ?? null,
  };
}

// The fetch every host uses: a time limit, redirects refused, and the answer's text kept for a verification echo.
export const sendByFetch = (fetchImpl = fetch, timeoutMs = rules.timeout_ms) => async (url, body, headers) => {
  // Judged again as it is sent: an address kept before the public-address rule (or a rule row added since) is not sent to.
  if (!publicAddressOrNull(url)) return { ok: false, status: 0 };
  const answer = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const text = await answer.text().catch(() => '');
  return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: text.slice(0, 4096) };
};

// Shared SQL realization; each host invokes it at its original lazy boundary.
export function setupMcpEventTables(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS mcp_event_subscriptions (id TEXT PRIMARY KEY, grant_id TEXT, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS mcp_event_verified (key TEXT PRIMARY KEY, at TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS mcp_event_deliveries (event_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, state TEXT NOT NULL, next_at TEXT, value TEXT NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS mcp_event_deliveries_due ON mcp_event_deliveries (state, next_at)');
  sql.exec('CREATE INDEX IF NOT EXISTS mcp_event_deliveries_subscription ON mcp_event_deliveries (subscription_id, state)');
  return sql;
}
