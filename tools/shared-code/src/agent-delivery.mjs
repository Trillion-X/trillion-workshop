// Events an account's agents are sent, so an asleep agent wakes instead of polling: the shared delivery rail.
//
// An agent that can be reached gives a delivery address when it publishes (publish_agent delivery.url). Any owner
// sends it an event of any type (send_agent_event: a run of a tool that lives on that agent's computer, its result,
// anything later); the rail knows no type. Two types come from handoffs themselves:
//   handoff.created   goes to the agent the work is handed to (or, for work handed to nobody, to every agent that
//                     takes work and can be reached, except the one that handed it; the first to take_work wins)
//   handoff.finished  goes back to the agent that handed the work off (from_agent)
// An event carries ids (subject_id and refs) and the short summary its sender chose, never a job, an input, a result
// or any file's bytes: the woken agent reads those itself from their owner (take_work, read_handoff, or the machine
// that holds them), signed in to the account. Every event has the same shape:
//   { event_id, type, occurred_at, to_agent, from_agent, subject_id, summary, refs: { name: id }, next_call }
// Boundaries: destination is one published agent with a delivery address (none: refused, never queued); idempotency
// is the event id, made from (type, idempotency key, receiver); integrity is the signature; privacy is ids and a
// summary only; metering is at most MAX_WAITING undelivered events per agent, and a delivered count on its card.
//
// Each delivery is one POST of the event as JSON, signed with the receiving agent's own delivery secret (made at
// publish, returned to that agent only, never listed):
//   trillion-event-id:  the event's id; a receiver that has seen it already answers 2xx and does nothing
//   trillion-signature: t=<unix seconds>,v1=<hex BLAKE3 keyed hash, key = the secret, over `${t}.${body}`>
// A receiver that got an event but cannot use it (a body it cannot read, a signature it cannot check) says so with a resend
// receipt (resend_agent_event): the event goes back to waiting with a count of such requests, at most MAX_RESEND_REQUESTS.
// A 2xx answer delivers it. Anything else, or no answer within the time limit, is tried again after the next wait in
// RETRY_SECONDS; after the last it is kept as dead (a dead letter), readable with read_agent_events (and read_handoff). When the agent reports
// it is present again (agent_presence), its dead events are sent once more. Presence never returns work.
//
// The stream route. An agent whose computer cannot be reached from the internet (a laptop behind a home router)
// publishes delivery { stream: true } instead of an address: a helper on that computer (harness/wake-sessions.mjs)
// holds one outbound socket to the person's store (/mcp/api/live?agent=<id>), each event is sent down it the moment
// it is kept, and the helper says delivered or failed (ack) after its own one retry, so a failure is a dead letter
// here too. The agent is reachable only while that socket answers its pings (STREAM_FRESH_SECONDS); events kept
// while it is away wait with no send time and the helper asks for them (pull) when it connects again. An agent with
// no route at all (a chat app on the web) is sent nothing: it reads its work the next time it connects.
//
// Invariants
// - Every event is kept before any attempt, in the account's own store, so a crash between the two loses nothing.
// - One event id per (type, idempotency key, receiver): handing off, finishing or sending again never sends it twice.
// - The secret leaves this store only in the publish answer to the agent that asked for it.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { publicAddressOrNull } from '../../refuse-requests-to-private-addresses/public-address.mjs';

export const RETRY_SECONDS = [5, 30, 120, 600, 3600];
export const DELIVERY_TIMEOUT_MS = 10_000;
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const MAX_WAITING = 200;
export const PRESENT_WITHIN_MINUTES = 15;
// How many times the receiver of one event may ask for it to be sent again (a receipt of kind `resend`) before it is kept as it is.
export const MAX_RESEND_REQUESTS = 5;
// A helper pings its socket every 30 seconds; a socket silent for longer than this is not listening any more.
export const STREAM_FRESH_SECONDS = 90;

const encoder = new TextEncoder();
const mac = (secretHex, t, body) => bytesToHex(blake3(encoder.encode(`${t}.${body}`), { key: hexToBytes(secretHex) }));
const equal = (left, right) => left.length === right.length && [...left].reduce((diff, char, index) => diff | (char.charCodeAt(0) ^ right.charCodeAt(index)), 0) === 0;

export const newDeliverySecret = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
export const signDelivery = (secretHex, body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${mac(secretHex, t, body)}`;

/** True when `header` is this secret's signature over `body`, made within the tolerance of `nowSeconds`. */
export function deliveryHolds(secretHex, header, body, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map(part => part.split('=')).filter(pair => pair.length === 2));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSeconds - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  return equal(parts.v1, mac(secretHex, t, body));
}

// A delivery address is a public https address (parts/http-client/do-work/public-address.mjs): never this service's own network or a private one.
export const deliveryAddress = value => publicAddressOrNull(value);

export const eventId = (type, key, to_agent) => `ev_${bytesToHex(blake3(encoder.encode(JSON.stringify([type, key, to_agent])))).slice(0, 24)}`;

// The one event shape; `said` is { type, key, to_agent, from_agent, subject_id, summary, refs, next_call }.
export const eventFrom = (said, at) => ({
  event_id: eventId(said.type, said.key, said.to_agent), type: said.type, occurred_at: at, to_agent: said.to_agent,
  from_agent: said.from_agent ?? null, subject_id: said.subject_id, summary: said.summary ?? null, refs: said.refs ?? {}, next_call: said.next_call ?? null,
});

// The two events a handoff makes: ids an agent acts on, and a summary only when the sender wrote one.
export function handoffEvent(type, handoff, to_agent, key = handoff.handoff_id) {
  const refs = Object.fromEntries(Object.entries({ handoff_id: handoff.handoff_id, handed_to: handoff.to_agent, taken_by: handoff.taken_by, case_id: handoff.case_id, parent_handoff_id: handoff.parent_handoff_id }).filter(([, value]) => value));
  return {
    type, key, to_agent, from_agent: handoff.from_agent ?? null, subject_id: handoff.handoff_id, refs,
    summary: type === 'handoff.finished' ? handoff.summary ?? null : handoff.notice ?? null,
    next_call: type === 'handoff.finished' ? { tool: 'read_handoff', arguments: { handoff_id: handoff.handoff_id } } : { tool: 'take_work', arguments: { agent_id: to_agent, handoff_id: handoff.handoff_id } },
  };
}

// How an agent's events travel: pushed to its address, sent down the stream its computer holds, or kept for the next
// time it connects.
export const routeOf = agent => (agent?.delivery?.url ? 'push' : agent?.delivery?.stream ? 'stream' : 'next_connection');

// Whether an agent can be reached right now and what the rail last managed with it. `live` is whether its stream is
// open this moment (the store's own socket answer); an agent with an address is live when it reported itself present.
export const reachabilityOf = (agent, now, live = false) => ({
  route: routeOf(agent), live: routeOf(agent) === 'stream' ? Boolean(live) : routeOf(agent) === 'push' && Boolean(agent?.last_seen_at && now.getTime() - Date.parse(agent.last_seen_at) <= PRESENT_WITHIN_MINUTES * 60_000),
  delivery: Boolean(agent?.delivery), last_seen_at: agent?.last_seen_at ?? null,
  present: Boolean(agent?.last_seen_at && now.getTime() - Date.parse(agent.last_seen_at) <= PRESENT_WITHIN_MINUTES * 60_000),
  last_delivered_at: agent?.last_delivered_at ?? null, last_undelivered_at: agent?.last_undelivered_at ?? null, delivered: agent?.delivered ?? 0,
});

// Sends every event that is due, each once, and records what happened. `send(url, body, headers)` → { ok, status }.
export async function deliverDue({ store, send, now = () => new Date() }) {
  const results = [];
  for (const item of store.dueDeliveries(now().toISOString())) {
    // An agent that moved to the stream route is never posted to: its event waits for its helper instead.
    const card = store.card(item.agent_id);
    if (card?.delivery?.stream) { store.putDelivery({ ...item, next_at: null }); continue; }
    const secret = store.deliverySecret(item.agent_id);
    const url = card?.delivery?.url;
    const attempts = item.attempts + 1;
    let outcome;
    if (!secret || !url) outcome = { ok: false, error: 'This agent no longer has a delivery address.' };
    else {
      const body = JSON.stringify(item.event);
      try {
        const answer = await send(url, body, { 'content-type': 'application/json', 'trillion-event-id': item.event_id, 'trillion-signature': signDelivery(secret, body, Math.floor(now().getTime() / 1000)) });
        outcome = answer.ok ? { ok: true } : { ok: false, error: `The address answered ${answer.status}.` };
      } catch (error) { outcome = { ok: false, error: `No answer: ${String(error?.message ?? error).slice(0, 200)}` }; }
    }
    const at = now().toISOString();
    const wait = RETRY_SECONDS[attempts - 1];
    const next = outcome.ok ? { state: 'delivered', delivered_at: at, next_at: null }
      : wait === undefined || (!secret || !url) ? { state: 'dead', next_at: null } : { state: 'waiting', next_at: new Date(now().getTime() + wait * 1000).toISOString() };
    const updated = { ...item, ...next, attempts, last_attempt_at: at, last_error: outcome.ok ? null : outcome.error };
    store.putDelivery(updated);
    if (outcome.ok || updated.state === 'dead') {
      const latest = store.card(item.agent_id);
      if (latest) store.putCard({ ...latest, ...(outcome.ok ? { last_delivered_at: at, delivered: (latest.delivered ?? 0) + 1 } : { last_undelivered_at: at }) });
    }
    results.push(outward(updated));
  }
  return results;
}

export const outward = item => ({ event_id: item.event_id, type: item.event.type, subject_id: item.event.subject_id, agent_id: item.agent_id, state: item.state, attempts: item.attempts, next_at: item.next_at, last_error: item.last_error ?? null, delivered_at: item.delivered_at ?? null, resend_requests: item.resend_requests ?? 0 });

// The fetch every host uses: a time limit, and redirects not followed (a signed event goes to the address given).
export const sendByFetch = (fetchImpl = fetch) => async (url, body, headers) => {
  // Judged again as it is sent: an address kept before the public-address rule (or a rule row added since) is not sent to.
  if (!publicAddressOrNull(url)) return { ok: false, status: 0 };
  const answer = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
  await answer.body?.cancel();
  return { ok: answer.status >= 200 && answer.status < 300, status: answer.status };
};
