// harness/wake-handlers/send-requests-here.mjs
//
// Purpose
//   A handler for harness/wake-sessions.mjs: sends, from this computer's own internet connection, a request one of the
//   person's connections could not send from Trillion's servers (src/send-from.mjs: the connection's `sends_from` names
//   a placement whose executor is computer-network, and this computer's agent lists that placement in `runs`).
//
// How
//   1. The event (request.send.requested) names only the request's id (refs.send_id).
//   2. Takes the request once (GET /sends/<id>): its address, method, headers and body, with the person's values
//      already placed by their locked box.
//   3. Sends it from here, answering redirects as they come (Trillion decides whether to follow one), and hands the
//      answer back (POST /sends/<id>/answer) as { status_code, headers, body_b64 }, or { error } when it could not be
//      sent.
//
// Non-negotiable invariants
//   1. It names no service: which requests it sends is the placement the computer's agent says it runs.
//   2. The request is never written anywhere on this computer and never logged: it carries the person's values.
//   3. A request already taken (by this computer or another) is left alone.
//

// Headers the sending library sets itself from the request it actually sends.
const SET_BY_THE_SENDER = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
// Headers that describe bytes this computer already decoded, so they would misdescribe the body handed back.
const DESCRIBES_ENCODED_BYTES = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

export const wants = ({ event, helper }) => Boolean(helper) && event.type === 'request.send.requested' && Boolean(event.refs?.send_id);

export async function handle({ event, call, read, fetchImpl = fetch }) {
  const id = encodeURIComponent(event.refs.send_id);
  let taken;
  try { taken = await read(`/sends/${id}`); } catch (error) { return { skipped: String(error?.message ?? error) }; }
  const { request } = taken;
  let reply;
  try {
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([name]) => !SET_BY_THE_SENDER.has(name.toLowerCase())));
    const answer = await fetchImpl(request.url, {
      method: request.method, headers, redirect: 'manual',
      ...(request.body_b64 ? { body: Buffer.from(request.body_b64, 'base64') } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const body = Buffer.from(await answer.arrayBuffer());
    reply = {
      status_code: answer.status,
      headers: Object.fromEntries([...answer.headers.entries()].filter(([name]) => !DESCRIBES_ENCODED_BYTES.has(name.toLowerCase()))),
      body_b64: body.length ? body.toString('base64') : null,
    };
  } catch (error) {
    reply = { error: `This computer could not send the request: ${String(error?.message ?? error).slice(0, 300)}` };
  }
  const answered = await call(`/sends/${id}/answer`, reply);
  return { send_id: event.refs.send_id, answered: answered.answered === true, status_code: reply.status_code ?? null };
}
