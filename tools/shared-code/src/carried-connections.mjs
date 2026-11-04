// src/carried-connections.mjs
//
// Purpose
//   Connections a person's own computer carries: an account that exists only on a device (iMessage in Messages on a
//   Mac, a WhatsApp linked device), reached by a program on that device and never by Trillion's servers. The program
//   (computer/carry-connections.mjs) is an agent on the person's account like any AI: its card's skills name each
//   connection it carries (`connection:<vendor>`) or can start (`connectable:<vendor>`), and its capacity claim says
//   it is present. This owner hands declared connection and local-copy lifecycle requests to a present computer as a handoff, then
//   waits a few seconds for its finished result. A queued request is never proof that its operation happened.
//
// Non-negotiable invariants
//   1. Nothing here names a service, a vendor, an app or a verb: services are the service-connections descriptors that
//      say `carried_by`, verbs and words are DATA (src/carried-connections.json), and the computer says what it carries.
//   2. Connected is read from presence on every call, never stored: a computer whose capacity claim expired is Away,
//      and a request to it is refused in words, never queued to be sent hours later.
//   3. The same request_key never sends twice: it names the handoff, and the agents road returns the earlier one.
//   4. Only the computer the request is addressed to can take it (it takes only its own work), and only its own fixed
//      verbs run there; no tool of any kind is placed on a person's computer through this road.
//
// Key concepts
//   service   { vendor, name }                     from the Workshop's connect rows whose invoke.connects.carried_by is set
//   carrier   an agent card with a `connection:<vendor>` skill, found through agents.find (with its capacity)
//   row       { connection_id, service, vendor, status: 'connected' | 'away', account_label, connected_at, last_seen_at,
//               carried_by }                        the connection row shape src/account-screens.mjs already draws
//   request   handoff input { connection: vendor, verb, ...fields }
//
// Security
//   Credentials and message stores never leave the computer; the store keeps only the handoff with the result the AI
//   asked for, in the person's own store.
//
import settings from './carried-connections.json' with { type: 'json' };
import { failureOf } from './failure.mjs';
import { handoffIdFor } from './agents.mjs';
import { quoteFieldsIn } from './quoted-words.mjs';

export class CarriedError extends Error {}

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const said = (key, values = {}) => fill(settings.words[key], values);

/** The vendors one agent card carries, read from its skills. */
export const carriedVendorsOf = card => (card?.skills ?? [])
  .map(skill => skill?.id)
  .filter(id => typeof id === 'string' && id.startsWith(settings.skill_prefix))
  .map(id => id.slice(settings.skill_prefix.length));

/** The vendors an agent card can start connecting on its computer, read from its skills. */
export const connectableVendorsOf = card => (card?.skills ?? [])
  .map(skill => skill?.id)
  .filter(id => typeof id === 'string' && id.startsWith(settings.connect_skill_prefix))
  .map(id => id.slice(settings.connect_skill_prefix.length));

/** The services a computer can carry: the Workshop's connect rows whose service-connections descriptor says so. */
export const carriedServicesFrom = rows => (rows?.tools ?? [])
  .filter(tool => typeof tool.invoke?.provider === 'string' && object(tool.invoke?.connects?.carried_by))
  .map(tool => ({ vendor: tool.invoke.provider, name: tool.label ?? tool.invoke.provider }));

// When a computer was last heard from: its presence, its capacity report or its card, whichever is latest. The one
// reading of "last seen"; src/agents.mjs uses it to open work named to an AI that has gone.
export const seenAt =agent => [agent.last_seen_at, agent.capacity?.reported_at, agent.published_at].filter(Boolean).sort().at(-1) ?? null;

// One field of a verb's input, checked against its DATA row.
function field(name, rule, value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    if (rule.required) throw new CarriedError(said('missing', { field: name }));
    return undefined;
  }
  if (rule.boolean) {
    if (typeof value !== 'boolean') throw new CarriedError(`${name} must be true or false.`);
    return value;
  }
  if (rule.strings) {
    if (!Array.isArray(value) || value.length < rule.min || value.length > rule.max || value.some(item => typeof item !== 'string' || !item.trim() || item.length > rule.item_max)) throw new CarriedError(`${name} must name between ${rule.min} and ${rule.max} exact source IDs.`);
    return [...new Set(value)];
  }
  if (rule.integer) {
    if (!Number.isInteger(value) || value < rule.min || value > rule.max) throw new CarriedError(said('not_whole', { field: name, min: rule.min, max: rule.max }));
    return value;
  }
  if (typeof value !== 'string') throw new CarriedError(said('not_text', { field: name }));
  if (rule.max && value.length > rule.max) throw new CarriedError(said('too_long', { field: name, max: rule.max }));
  return value.trim();
}

/**
 * agents:   makeAgents instance (find, handOff, read)
 * services: () → [{ vendor, name }] (carriedServicesFrom over the Workshop rows)
 * sleep:    ms → Promise (the host's timer)
 */
export function makeCarriedConnections({ agents, services, ownerIdentity = async () => null, checkRecipient = () => {}, beforeHandoff = async () => {}, readHandoff = null, commitHandoff = create => create(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  // Handoffs an AI is waiting on, woken the moment the agents road says they finished.
  const waiters = new Map();

  function carriers() {
    const carries = agent => carriedVendorsOf(agent).length > 0 || connectableVendorsOf(agent).length > 0;
    // Filter cards before find computes capacity, and omit the waiting-work
    // count: a connection row only needs this computer's current presence.
    return agents.find({ all: true }, { keepCard: carries, includeWaiting: false }).agents;
  }

  // The connection rows: one per computer and service it carries, for services a descriptor declares.
  async function rows() {
    const known = new Map((await services()).map(service => [service.vendor, service]));
    return carriers().flatMap(agent => carriedVendorsOf(agent).filter(vendor => known.has(vendor)).map(vendor => ({
      connection_id: `carried:${agent.agent_id}:${vendor}`,
      service: known.get(vendor).name,
      vendor,
      status: agent.ready_now ? 'connected' : 'away',
      account_label: agent.where && agent.where !== 'unknown' ? agent.where : agent.name,
      connected_at: agent.first_published_at ?? null,
      last_seen_at: seenAt(agent),
      carried_by: agent.agent_id,
    })));
  }

  // Wait until the handoff is finished or the time is up; the finished hook wakes it at once.
  async function finishedWithin(handoff_id, seconds) {
    const current = agents.read({ handoff_id }).handoff;
    if (current.state === 'finished') return current;
    let wake;
    const woken = new Promise(resolve => { wake = resolve; });
    waiters.set(handoff_id, [...(waiters.get(handoff_id) ?? []), wake]);
    await Promise.race([woken, sleep(seconds * 1000)]);
    waiters.set(handoff_id, (waiters.get(handoff_id) ?? []).filter(item => item !== wake));
    if (!waiters.get(handoff_id)?.length) waiters.delete(handoff_id);
    const after = agents.read({ handoff_id }).handoff;
    return after.state === 'finished' ? after : null;
  }

  /** The agents road's finished hook: wakes whoever waits on this handoff. */
  function finished(handoff) {
    for (const wake of waiters.get(handoff?.handoff_id) ?? []) wake();
  }

  /**
   * Ask the computer that carries `service` to do `verb` with the fields in `input`.
   * input: { service, request_key?, wait_seconds?, ...the verb's fields }
   */
  async function ask(verbName, input = {}) {
    const verb = settings.verbs[verbName];
    if (!verb) throw new CarriedError(said('unknown_verb', { verb: verbName, verbs: Object.keys(settings.verbs).join(', ') }));
    const known = await services();
    const present = carriers();
    const vendor = typeof input.service === 'string' ? input.service.trim().toLowerCase() : '';
    const service = known.find(item => item.vendor === vendor || item.name.toLowerCase() === vendor);
    if (!service) {
      const carried = [...new Set(present.flatMap(carriedVendorsOf))].filter(item => known.some(known => known.vendor === item));
      throw new CarriedError(said('unknown_service', { service: input.service ?? '', carried: carried.join(', ') || said('none') }));
    }
    const fields = {};
    for (const [name, rule] of Object.entries(verb.fields)) {
      const value = field(name, rule, input[name]);
      if (value !== undefined) fields[name] = value;
    }
    if (verbName === 'send' && service.vendor === 'imessage' && fields.to === 'me') {
      const verified = await ownerIdentity();
      if (typeof verified !== 'string' || !verified.trim()) throw new CarriedError('Your Trillion sign-in has no verified address for iMessage to check. Nothing was sent.');
      fields.owner_identity = verified.trim();
    }
    let recipient_resolution = null;
    if (verbName === 'send') {
      try { recipient_resolution = checkRecipient({ to: fields.to, recipient: input.recipient }); }
      catch (error) { throw new CarriedError(error.message); }
    }
    if (verb.needs_one_of && !verb.needs_one_of.some(name => fields[name] !== undefined)) throw new CarriedError(said('one_of', { fields: verb.needs_one_of.join(' or ') }));
    const key = typeof input.request_key === 'string' && input.request_key.trim() ? input.request_key.trim() : null;
    if (verb.needs_request_key && !key) throw new CarriedError(said('request_key'));
    const holding = present.filter(agent => (verb.availability === 'connectable' ? connectableVendorsOf(agent) : carriedVendorsOf(agent)).includes(service.vendor));
    if (!holding.length) throw new CarriedError(said(verb.availability === 'connectable' ? 'not_connectable' : 'not_carried', { name: service.name }));
    const carrier = holding.find(agent => agent.ready_now);
    if (!carrier) {
      const latest = [...holding].sort((left, right) => String(seenAt(right)).localeCompare(String(seenAt(left))))[0];
      throw new CarriedError(said('away', { name: service.name, computer: latest.where && latest.where !== 'unknown' ? latest.where : latest.name, seen: seenAt(latest) ?? said('never') }));
    }
    // The service/verified identity reads above may await. The supplied current
    // resource gate checks again immediately before creating durable work.
    await beforeHandoff(verbName, input);
    const { handoff } = commitHandoff(() => agents.handOff({
      job: fill(verb.job, { service: service.name, ...fields }),
      to_agent: carrier.agent_id,
      input: { connection: service.vendor, verb: verbName, ...fields },
      request_key: `carried:${verbName}:${key ?? crypto.randomUUID()}`,
      hold_minutes: settings.hold_minutes,
    }));
    const wanted = Number(input.wait_seconds);
    const seconds = Number.isFinite(wanted) && wanted >= 0 ? Math.min(wanted, settings.wait_seconds.max) : settings.wait_seconds.default;
    const done = await finishedWithin(handoff.handoff_id, seconds);
    const computer = carrier.where && carrier.where !== 'unknown' ? carrier.where : carrier.name;
    return done
      ? { state: 'finished', service: service.name, computer, handoff_id: done.handoff_id, result: done.result, ...(recipient_resolution ? { recipient_resolution } : {}) }
      : { state: 'waiting', service: service.name, computer, handoff_id: handoff.handoff_id, said: said('waiting', { computer, handoff_id: handoff.handoff_id }), ...(recipient_resolution ? { recipient_resolution } : {}), next_call: { tool: 'read_handoff', arguments: { handoff_id: handoff.handoff_id } } };
  }

  // Outcome lookup never creates work. The exact original handoff carries the
  // effects/results and survives a reply loss or native owner reconstruction.
  // Absence, a changed input or an erased original remains unknown.
  async function readOriginal(verbName, input = {}, bound = null) {
    if (typeof readHandoff !== 'function') return null;
    const verb = settings.verbs[verbName], key = typeof input.request_key === 'string' ? input.request_key.trim() : '';
    if (!verb || !bound && !key) return null;
    const original = readHandoff(bound?.handoff_id ?? handoffIdFor(`carried:${verbName}:${key}`));
    if (!original || original.withdrawal || !original.asked || original.asked.input?.verb !== verbName) return null;
    const known = await services(), vendor = bound ? original.asked.input.connection : typeof input.service === 'string' ? input.service.trim().toLowerCase() : '';
    const service = known.find(item => item.vendor === vendor || item.name.toLowerCase() === vendor);
    if (!service || original.asked.input.connection !== service.vendor) return null;
    const expected = {};
    for (const [name, rule] of Object.entries(verb.fields)) {
      const value = field(name, rule, bound ? original.asked.input[name] : input[name]);
      if (value !== undefined) expected[name] = value;
    }
    const actual = original.asked.input;
    for (const name of Object.keys(verb.fields)) if (JSON.stringify(actual[name]) !== JSON.stringify(expected[name])) return null;
    // Only the canonical iMessage self-recipient resolution may add a field.
    const allowed = new Set(['connection', 'verb', ...Object.keys(verb.fields), ...(verbName === 'send' && service.vendor === 'imessage' && expected.to === 'me' ? ['owner_identity'] : [])]);
    if (Object.keys(actual).some(name => !allowed.has(name)) || original.job !== fill(verb.job, { service: service.name, ...actual })) return null;
    // The retained target is the computer actually asked, even if it is now
    // asleep. Recovery does not select another carrier or repeat the request.
    const card = agents.cardOf?.(original.asked.to_agent), computer = card?.where && card.where !== 'unknown' ? card.where : card?.name ?? original.asked.to_agent;
    return original.state === 'finished'
      ? { state: 'finished', service: service.name, computer, handoff_id: original.handoff_id, result: original.result }
      : { state: 'waiting', service: service.name, computer, handoff_id: original.handoff_id,
        said: said('waiting', { computer, handoff_id: original.handoff_id }), next_call: { tool: 'read_handoff', arguments: { handoff_id: original.handoff_id } } };
  }

  return { rows, ask, finished, readOriginal };
}

// ---- the person store's routes ---------------------------------------------------------------------------------

const ROUTES = { '/carried/read-incoming': 'read_incoming', '/carried/status': 'status', '/carried/disconnect': 'disconnect', '/carried/revoke': 'revoke', '/carried/erase-incoming': 'erase_incoming', '/carried/connect': 'connect', '/carried/pause': 'pause', '/carried/resume': 'resume', '/carried/send': 'send', '/carried/read': 'read' };
export const isCarriedPath = path => Object.hasOwn(ROUTES, path);
export const carriedVerbForPath = path => ROUTES[path] ?? null;

/** POST to a declared /carried route: the verb is the route's; the body is the caller's input. */
export async function handleCarriedRequest(owner, request) {
  const verb = ROUTES[new URL(request.url).pathname];
  if (request.method !== 'POST' || !verb) return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    return Response.json(await owner.ask(verb, JSON.parse((await request.text()) || '{}')));
  } catch (error) {
    if (failureOf(error).tries_again_later) throw error;
    return Response.json({ error: String(error.message ?? error) }, { status: error instanceof CarriedError || error instanceof SyntaxError ? 400 : error.status ?? 500 });
  }
}

// ---- the MCP tools -----------------------------------------------------------------------------------------------

const serviceField = { type: 'string', description: 'The service, as list_connections names it (its vendor), such as imessage or whatsapp.' };
const waitField = { type: 'number', minimum: 0, maximum: settings.wait_seconds.max, description: `How long to wait for the computer's answer (default ${settings.wait_seconds.default} seconds); after that the answer is read with read_handoff.` };

export const carriedTools = call => [
  {
    name: 'connect_carried_service',
    description: 'Starts connecting a service on one of the person\'s awake computers. The computer opens the native sign-in or pairing step and returns what the person must finish, such as entering a one-time code on their phone. It does not read or send messages until the service reports connected. To bind a different account, first disconnect_carried_service with the current exact account, then call this tool for the replacement; pending items remain with their original account. For a provider that signs in on its own page, use connect_service instead.',
    inputSchema: { type: 'object', required: ['service', 'request_key'], properties: { service: serviceField, phone: { type: 'string', description: 'The account phone number in international format when the service requires it to make a pairing code.' }, request_key: { type: 'string' }, wait_seconds: waitField } },
    run: input => call('/carried/connect', input),
  },
  ...[
    { verb: 'pause', name: 'pause_carried_service', description: "Pauses a service on the person's awake computer. Stops its connection and incoming delivery until explicitly resumed, preserving its linked session and pending items. This is a durable user pause, not ordinary app shutdown." },
    { verb: 'resume', name: 'resume_carried_service', description: "Resumes an already linked service on the person's awake computer after a pause. Reopens the existing connection and retries pending incoming items. It does not start new pairing; use connect_carried_service if the session is no longer linked." },
  ].map(({ verb, name, description }) => ({
    name, description,
    inputSchema: { type: 'object', required: ['service', 'request_key'], properties: { service: serviceField, request_key: { type: 'string' }, wait_seconds: waitField } },
    run: input => call(`/carried/${verb}`, input),
  })),
  {
    name: 'read_carried_service_state',
    description: "Reads the current bound account, connection state and local incoming journal counts from the person's awake computer. Use its exact account value when disconnecting, revoking or erasing selected journal copies. It exposes no session keys.",
    inputSchema: { type: 'object', additionalProperties: false, required: ['service'], properties: { service: serviceField, wait_seconds: waitField } },
    run: input => call('/carried/status', input),
  },
  ...[
    { verb: 'disconnect', name: 'disconnect_carried_service', description: "Disconnects the exact bound account locally, keeping its session archived on this computer and preserving pending incoming items. It does not claim remote revocation. To bind a replacement account, disconnect first, then use connect_carried_service and finish any required pairing." },
    { verb: 'revoke', name: 'revoke_carried_service', description: "Requests removal of this computer's linked session from the exact account. Reports remote_revoked only after a matching successful provider acknowledgement; a timeout, refusal or unavailable connection remains unconfirmed. The connection must be open; resume it first if paused. Pending items remain scoped to their original account." },
  ].map(({ verb, name, description }) => ({
    name, description,
    inputSchema: { type: 'object', additionalProperties: false, required: ['service', 'account', 'request_key'], properties: { service: serviceField, account: { type: 'string', description: 'The exact bound account returned by read_carried_service_state.' }, request_key: { type: 'string' }, wait_seconds: waitField } },
    run: input => call(`/carried/${verb}`, input),
  })),
  {
    name: 'read_carried_incoming_copies',
    description: "Lists metadata and exact source IDs of this computer's incoming journal copies for one account, including pending copies from an earlier disconnected account. Use incoming_accounts from read_carried_service_state. Returns no message text or session keys. Follow next_after as after to read the next page; erased copies are excluded.",
    inputSchema: { type: 'object', additionalProperties: false, required: ['service', 'account'], properties: { service: serviceField, account: { type: 'string' }, after: { type: 'string', maxLength: 4000 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, wait_seconds: waitField } },
    run: input => call('/carried/read-incoming', input),
  },
  {
    name: 'erase_carried_incoming_copy',
    description: "Erases only the exact selected copies in this computer's incoming journal. Name their account and source IDs. Pending items are refused unless include_pending:true explicitly includes those undelivered copies. Hashed tombstones prevent replay from reimporting erased items. This does not erase provider messages, the separate recent-message cache, or shared Trillion receipts/history; an already in-flight delivery may still finish.",
    inputSchema: { type: 'object', additionalProperties: false, required: ['service', 'account', 'source_ids', 'request_key'], properties: { service: serviceField, account: { type: 'string' }, source_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4000 } }, include_pending: { type: 'boolean', default: false }, request_key: { type: 'string' }, wait_seconds: waitField } },
    run: input => call('/carried/erase-incoming', input),
  },
  {
    name: 'send_message',
    description: 'Sends a message from the person\'s own account on a service their computer carries (for example iMessage from their Mac, or their WhatsApp). To name a person, first read their current contact row, then pass recipient as that row\'s name and to as its phone or email; the server refuses a mismatch or ambiguous address. Never reuse a number from past sends as proof of who owns it. For yourself use to: "me". The computer sends it and answers with what happened; only an awake computer can send, and nothing is queued for later. request_key is any unique text: the same key never sends twice.',
    inputSchema: { type: 'object', required: ['service', 'to', 'request_key'], properties: { service: serviceField, to: { type: 'string' }, recipient: { type: 'string', description: 'The intended person\'s name from their current contact row; required when to belongs to a saved contact. For yourself use to: "me".' }, text: { type: 'string' }, link: { type: 'string', format: 'uri' }, request_key: { type: 'string' }, wait_seconds: waitField } },
    run: input => call('/carried/send', input),
  },
  {
    name: 'read_recent_messages',
    description: 'Reads the person\'s recent messages on a service their computer carries (for example iMessage on their Mac, or their WhatsApp), newest first: each with who sent it, when, and its words. WhatsApp returns only the currently verified linked account\'s recent cache, identifies that account, and reports history_complete:false plus cache_status and omitted_legacy_count; older unassigned cache entries stay preserved but are not returned as this account\'s messages. WhatsApp voice notes are kept with their original audio in the person\'s Files and include file_identity and file_name; use read_file or show_file to open that sound. with (optional) keeps only one conversation, by phone number, email handle or name; limit is how many (default the computer\'s own, at most 50). Only a computer that is awake can answer.',
    inputSchema: { type: 'object', required: ['service'], properties: { service: serviceField, with: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, wait_seconds: waitField } },
    // Other people's words reach the AI quoted: control and bidi characters gone, markup neutralised, the block closed (src/quoted-words.json).
    run: async input => quoteFieldsIn(await call('/carried/read', input), { source: input?.service }),
  },
];

export const carriedAnnotations = {
  read_carried_incoming_copies: { title: 'Read local incoming copy metadata', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_carried_service_state: { title: 'Read a connection on my computer', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  disconnect_carried_service: { title: 'Disconnect a local account', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  revoke_carried_service: { title: 'Revoke a linked device session', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  erase_carried_incoming_copy: { title: 'Erase selected local incoming copies', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  pause_carried_service: { title: 'Pause a service on my computer', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  resume_carried_service: { title: 'Resume a linked service on my computer', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  connect_carried_service: { title: 'Connect a service on my computer', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  send_message: { title: 'Send a message from my own account', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  read_recent_messages: { title: 'Read my recent messages', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

// Required native-owner API, retained from verified main.
