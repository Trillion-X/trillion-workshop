// src/send-from.mjs
//
// PURPOSE
//   Where a connection's requests leave from. A service can refuse requests from servers' addresses (answering 429 or
//   403 to a hosting provider's range) while it accepts the same request from the person's own computer. The connection says, as
//   DATA, which places its requests are sent from and in what order (`sends_from` on its descriptor, carried onto its
//   connect row as invoke.connects.sends_from):
//
//     [{ "placement": "placement:this-worker", "next_when_answered": [403, 429] },
//      { "placement": "placement:your-computer-network" }]
//
//   sendFrom() turns that list into one fetch: it sends from the first place, and when that place's answer is one the
//   row says means "refused here", it sends the same request from the next place. Each place is a Workshop placement
//   row; what sends from it is the sender for that placement's executor, handed in by the host.
//
//   computerNetwork() is the sender for a placement whose executor is `computer-network`: the request is held in this
//   store's memory, the person's computers that run that placement (their helper, harness/wake-sessions.mjs, lists it in
//   its agent card's `runs`) are told `request.send.requested` with only its id, and the helper takes the request once
//   (GET /sends/<id>), sends it from that computer and answers it (POST /sends/<id>/answer).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a service, a host or a status code: the order and the refusals are the connection's DATA.
//   2. A request moves to the next place only on an ANSWER the row lists. A request that threw (it may have been sent)
//      is never sent again from somewhere else.
//   3. A request handed to a computer lives only in memory and is taken once; it is never written to the store, an
//      event or a log, because it carries the person's placed values. The event names only its id.
//   4. A request the computer took and did not answer in time is reported as possibly sent, never as not sent.
//

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const toBase64 = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000)); return btoa(text); };
const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

// The bytes of a body, so the same request can be sent from a second place.
async function bodyBytes(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

// routes:     the connection's `sends_from` list
// placements: Workshop placement rows (each { id, executor, settings })
// senders:    { [executor id]: (url, init, placement) => Response }
// → (url, init) => Response, or null when the list names no place this host can send from.
export function sendFrom({ routes, placements, senders }) {
  if (!Array.isArray(routes) || !routes.length) return null;
  const byId = new Map(placements.map(place => [place.id, place]));
  const legs = routes.map(route => {
    const place = object(route) ? byId.get(route.placement) : null;
    const send = place ? senders[place.executor] : null;
    if (!send) throw new Error(`This connection sends from ${route?.placement ?? 'a place'}, which this service cannot send from.`);
    return { place, send, next: new Set(Array.isArray(route.next_when_answered) ? route.next_when_answered : []) };
  });
  return async (url, init = {}) => {
    const body = legs.length > 1 ? await bodyBytes(init.body) : init.body;
    const { duplex: _duplex, ...rest } = init;
    const once = { ...(legs.length > 1 ? rest : init), ...(body !== undefined && body !== null ? { body } : {}) };
    for (const [at, leg] of legs.entries()) {
      const answer = await leg.send(url, once, leg.place);
      if (at === legs.length - 1 || !leg.next.has(answer.status)) return answer;
      await answer.body?.cancel();
    }
    throw new Error('A connection with places to send from sent nothing.');
  };
}

// tell(said): tells the computers that run `said.placement` (agents tellRunners) → { told }
// newId:      a fresh unguessable id
export function computerNetwork({ tell, newId = () => crypto.randomUUID() }) {
  const waiting = new Map();
  async function send(url, init = {}, place) {
    const settings = place.settings ?? {};
    const words = settings.words ?? {};
    const id = newId();
    const bytes = await bodyBytes(init.body);
    const request = {
      url: String(url), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()),
      body_b64: bytes ? toBase64(bytes) : null, redirect: init.redirect ?? 'follow',
    };
    let settle;
    const answered = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const entry = { request, placement: place.id, taken: false, taker: null, ...settle };
    waiting.set(id, entry);
    let timer;
    try {
      const { told } = tell({ placement: place.id, type: 'request.send.requested', key: id, subject_id: id, summary: `Send a request to ${new URL(request.url).hostname} from this computer.`, refs: { send_id: id } });
      if (!told) throw new Error(words.absent ?? `${place.label} is not connected to this account.`);
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(entry.taken ? (words.not_known ?? `${place.label} took the request and did not say what happened.`) : (words.late ?? `${place.label} did not answer in time.`))), (settings.wait_seconds ?? 60) * 1000); });
      const reply = await Promise.race([answered, late]);
      return new Response(reply.body_b64 ? fromBase64(reply.body_b64) : null, { status: reply.status_code, headers: reply.headers ?? {} });
    } finally {
      clearTimeout(timer);
      waiting.delete(id);
    }
  }
  // The request, once, to the computer sending it.
  function take(id, taker = null) {
    const entry = waiting.get(id);
    if (!entry || entry.taken) return null;
    entry.taken = true;
    entry.taker = taker;
    return entry.request;
  }
  function answer(id, reply, taker = null) {
    const entry = waiting.get(id);
    if (!entry || !entry.taken || entry.taker !== taker) return false;
    if (typeof reply?.error === 'string') entry.reject(new Error(reply.error));
    else if (!Number.isInteger(reply?.status_code) || reply.status_code < 200 || reply.status_code > 599) entry.reject(new Error('The computer answered without a status.'));
    else entry.resolve(reply);
    return true;
  }
  return { send, take, answer, pending: id => { const entry = waiting.get(id); return entry ? { placement: entry.placement, taken: entry.taken, taker: entry.taker } : null; } };
}

export const isSendPath = pathname => /^\/sends\/[^/]+(\/answer)?$/.test(pathname);

// GET /sends/<id>: the request (once). POST /sends/<id>/answer: { status_code, headers, body_b64 } or { error }.
export async function handleSendRequest(network, request) {
  const [, , id, verb] = new URL(request.url).pathname.split('/');
  const sendId = decodeURIComponent(id);
  if (request.method === 'GET' && !verb) {
    const taken = network.take(sendId);
    return taken ? Response.json({ send_id: sendId, request: taken }) : Response.json({ error: 'That request was already taken, or it is no longer waiting.' }, { status: 404 });
  }
  if (request.method === 'POST' && verb === 'answer') {
    const reply = await request.json().catch(() => null);
    return network.answer(sendId, reply) ? Response.json({ send_id: sendId, answered: true }) : Response.json({ error: 'No request with that id is waiting for an answer.' }, { status: 404 });
  }
  return Response.json({ error: 'Not found' }, { status: 404 });
}
