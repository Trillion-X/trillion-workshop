// Generic live carrier for the existing board/records/changed protocol.
// It owns framing and ordering. Every authority and data operation is supplied
// by the installed native shared-content owner, which also closes quota.

const MAX_PRESENCE_MESSAGE = 4096;
const MAX_RECORDS_MESSAGE = 2 * 1024 * 1024;
const MAX_CHANGES = 200;
const MAX_ADDRESS = 400;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_SELECTION = 200;
const MAX_TARGET = 300;
const MAX_RECORDS = 5000;
const targetOf = value => {
  if (!object(value)) return null;
  const element = typeof value.element === 'string' && /^e[0-9a-z]{1,12}$/.test(value.element) ? value.element : '';
  const selector = typeof value.selector === 'string' ? value.selector.slice(0, MAX_TARGET) : '';
  const text = typeof value.text === 'string' ? value.text.slice(0, MAX_TARGET) : '';
  return element || selector || text ? { ...(element ? { element } : {}), ...(selector ? { selector } : {}), ...(text ? { text } : {}) } : null;
};
const fail = (message, status = 403) => Object.assign(new Error(message), { status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const jsonSize = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const viewName = value => {const raw=typeof value==='string'&&value.startsWith('view:')?value.slice(5):value;return typeof raw === 'string' && /^[a-z0-9-]{1,128}$/.test(raw) ? `view:${raw}` : 'view:board';};
const point = value => object(value) && Number.isFinite(value.x) && Number.isFinite(value.y);

/**
 * Create the source-side board protocol over one exact installed shared owner.
 *
 * resolve({space_id,context}) must return:
 *   {generation, authorize(context, mode), quota, read, commit, subscribe,
 *    publishRecords, publishPresence}
 *
 * authorize is a fresh current member check. quota.open/check/command/close/
 * reconcile are native admission operations, never values supplied by a
 * socket. quota.command({lease,operation,input,request_key,run}) performs the
 * actual exact participant reservation, capture, meter and original terminal
 * reconciliation. read and commit call the current admitted shared owner.
 * subscribe returns an abortable async iterator over that owner's canonical
 * record-head invalidations. The adapter retains no record authority itself.
 */
export function makeNativeBoardLive({ resolve, maxSessions = 256 } = {}) {
  if (typeof resolve !== 'function') throw new TypeError('An installed shared board resolver is required.');
  const sessions = new Map();

  async function open({ space_id, as = 'presence', view, context, socket, signal }) {
    if (typeof space_id !== 'string' || !space_id || !object(context) || !socket?.send || !socket?.close) throw fail('A native board socket binding is required.', 400);
    if (sessions.size >= maxSessions) throw fail('The native board live capacity is full.', 429);
    const mode = as === 'records' ? 'records' : 'presence';
    const owner = await resolve({ space_id, context });
    if (!owner || typeof owner.generation !== 'string' || !owner.quota || !owner.authorize || !owner.read || !owner.commit || !owner.subscribe || !owner.publishRecords || !owner.publishPresence)
      throw fail('The installed shared board live supply is incomplete.', 503);
    const token = crypto.randomUUID();
    const identity = await owner.authorize(context, mode);
    let lifetime;
    try { lifetime = await owner.quota.open({ context, resource: space_id, generation: owner.generation, token, mode }); }
    catch (error) {
      try { await owner.quota.reconcile({ context, token, resource: space_id, generation: owner.generation, reason: 'open-uncertain' }); } catch {}
      throw error;
    }
    if (!lifetime?.id || lifetime.generation !== owner.generation) {
      try { await owner.quota.reconcile({ context, token, resource: space_id, generation: owner.generation, reason: 'invalid-open-reply' }); } catch {}
      throw fail('The native live admission did not bind the current board.', 409);
    }
    const session = { token, owner, space_id, generation: owner.generation, mode, view: viewName(view), context,
      identity: { id: identity.id ?? `member-${token}`, name: String(identity.name ?? '').slice(0, 100), relay: identity.relay,
        may_change: identity.may_change === true }, lifetime, socket, closed: false, cursor: null, controller: new AbortController(), feed: null, pending: null };
    sessions.set(token, session);
    const abort = () => { void close(token, 'client-ended'); };
    signal?.addEventListener('abort', abort, { once: true });
    session.removeAbort = () => signal?.removeEventListener('abort', abort);
    try {
      await owner.quota.check({ context, lifetime, resource: space_id, generation: session.generation });
      session.feed = await owner.subscribe({ context, relay: session.identity.relay, space_id, generation: session.generation,
        ...(mode === 'records' ? {cursor:session.cursor} : {view:session.view}), signal:session.controller.signal });
      if (mode === 'records') {
        const snapshot = await measured(session, 'boardRecords', { space_id, limit: MAX_RECORDS }, () => owner.read({ context, relay: session.identity.relay, space_id, limit: MAX_RECORDS }));
        session.cursor = String(snapshot.cursor ?? '');
        persist(session);
        send(session, { type: 'board', records: validateRecords(snapshot.records) });
      }
      persist(session);
      return Object.freeze({ token, generation: session.generation, next: options => next(token, options), message: (data, current) => message(token, data, current), close: reason => close(token, reason) });
    } catch (error) {
      await close(token, 'open-failed');
      throw error;
    }
  }

  async function measured(session, operation, input, run, requestKey = `live:${session.token}:${crypto.randomUUID()}`) {
    await session.owner.quota.check({ context: session.context, lifetime: session.lifetime, resource: session.space_id, generation: session.generation });
    const current = await session.owner.authorize(session.context, session.mode);
    if (current.relay !== session.identity.relay || session.owner.generation !== session.generation) throw fail('The current board authority changed.', 409);
    const result = await session.owner.quota.command({ context: session.context, lifetime: session.lifetime, resource: session.space_id,
      generation: session.generation, operation, input, request_key: requestKey, run });
    await session.owner.quota.check({context:session.context,lifetime:session.lifetime,resource:session.space_id,generation:session.generation});
    await session.owner.authorize(session.context,session.mode);
    return result;
  }

  async function message(token, raw, currentContext) {
    const session = sessions.get(token);
    if (!session || session.closed) return;
    if (currentContext) session.context = currentContext;
    const limit = session.mode === 'records' ? MAX_RECORDS_MESSAGE : MAX_PRESENCE_MESSAGE;
    if (typeof raw !== 'string' || raw.length > limit) return;
    let sent;
    try { sent = JSON.parse(raw); } catch { return; }
    if (!object(sent)) return;
    try {
      const fresh = await session.owner.authorize(session.context, session.mode);
      if (fresh.relay !== session.identity.relay) throw fail('The current board member changed.', 403);
      session.identity = { ...session.identity, name: String(fresh.name ?? '').slice(0, 100), may_change: fresh.may_change === true };
      persist(session);
      await session.owner.quota.check({ context: session.context, lifetime: session.lifetime, resource: session.space_id, generation: session.generation });
      if (session.mode === 'records') return await change(session, sent);
      const outgoing = { id: session.identity.id, name: session.identity.name, ts: Date.now(),
        ...(point(sent.cursor) ? { cursor: { x: sent.cursor.x, y: sent.cursor.y } } : {}),
        selection: Array.isArray(sent.selection) ? sent.selection.filter(value => typeof value === 'string').slice(0, MAX_SELECTION) : [],
        ...(targetOf(sent.target) ? { target: targetOf(sent.target) } : {}),
        ...(typeof sent.doing === 'string' && sent.doing.trim() ? { doing: sent.doing.trim().slice(0, 40) } : {}) };
      await session.owner.publishPresence({ context: session.context, resource: session.space_id, view: session.view, message: outgoing, except: session.token });
    } catch (error) {
      if (error?.status === 401 || error?.status === 403 || error?.status === 404 || error?.status === 409) await close(token, 'revoked');
      else safeSend(session, { type: 'ended', error: String(error?.message ?? 'The board is unavailable.') });
    }
  }

  async function change(session, sent) {
    const request = typeof sent.request === 'string' && sent.request.length <= 100 ? sent.request : null;
    const answer = body => safeSend(session, { type: 'changed', request, ...body });
    if (!request) return answer({ error: 'This board change needs its retained request key.' });
    if (!session.identity.may_change) return answer({ error: 'This pursuit does not let you change its board.' });
    if (!Array.isArray(sent.changes) || !sent.changes.length || sent.changes.length > MAX_CHANGES) return answer({ error: `Send 1 to ${MAX_CHANGES} board changes.` });
    for (const row of sent.changes) {
      if (!object(row) || typeof row.address !== 'string' || !row.address || row.address.length > MAX_ADDRESS || row.value === undefined || jsonSize(row.value) > MAX_VALUE_BYTES)
        return answer({ error: 'A board record is invalid or too large.' });
    }
    try {
      const result = await measured(session, 'boardCommit', { space_id: session.space_id, changes: sent.changes, request_key: request, sender_id: session.identity.id },
        () => session.owner.commit({ context: session.context, relay: session.identity.relay, space_id: session.space_id,
          changes: sent.changes, request_key: request, sender_id: session.identity.id }), request);
      const records = validateRecords(result.records);
      answer({ records });
      if (!result.replayed) await session.owner.publishRecords({ context: session.context, resource: session.space_id,
        generation: session.generation, records, sender_id: session.identity.id });
    } catch (error) {
      if([401,403,404,409].includes(error?.status)){await close(session.token,'revoked');return;}
      answer({ error: String(error?.message ?? 'The board change did not complete.') });
    }
  }

  async function next(token, { wait_ms = 20_000, context: currentContext } = {}) {
    const session = sessions.get(token);
    if (!session || session.closed || session.mode !== 'records') return { done: true };
    if (currentContext) session.context = currentContext;
    let timer;
    try {
      session.pending ??= Promise.resolve(session.feed?.next?.());
      const wait = Number.isFinite(wait_ms) ? Math.max(0, Math.min(20_000, wait_ms)) : 20_000;
      const winner = await Promise.race([session.pending.then(item => ({ item })), new Promise(resolve => { timer = setTimeout(() => resolve({ idle: true }), wait); })]);
      if (winner.idle) {
        const current = await session.owner.authorize(session.context, 'records');
        if (current.relay !== session.identity.relay) throw fail('The current board member changed.', 403);
        await session.owner.quota.check({ context: session.context, lifetime: session.lifetime, resource: session.space_id, generation: session.generation });
        return { done: false, value: null, idle: true };
      }
      session.pending = null;
      const item = winner.item;
      if (!item || item.done) return { done: true };
      const fresh = await session.owner.authorize(session.context, 'records');
      if (fresh.relay !== session.identity.relay) throw fail('The current board member changed.', 403);
      const snapshot = await measured(session, 'boardRecords', { space_id: session.space_id, limit: MAX_RECORDS, after_cursor: session.cursor },
        () => session.owner.read({ context: session.context, relay: fresh.relay, space_id: session.space_id, limit: MAX_RECORDS, after_cursor: session.cursor }));
      const cursor = String(snapshot.cursor ?? '');
      if (cursor === session.cursor) return { done: false, value: null };
      session.cursor = cursor;
      persist(session);
      const records = validateRecords(snapshot.records);
      send(session, { type: 'records', records });
      return { done: false, value: { cursor, records } };
    } catch (error) {
      if ([401, 403, 404, 409].includes(error?.status)) await close(token, 'revoked');
      else await close(token, 'stream-failed');
      return { done: true, error };
    } finally { clearTimeout(timer); }
  }

  async function close(token, reason = 'closed') {
    const session = sessions.get(token);
    if (!session) return { closed: false };
    session.closed = true; session.removeAbort?.(); session.controller.abort(reason);
    if (reason === 'revoked') { try { session.socket.close(4403, 'You are no longer in this space.'); } catch {} }
    try { await session.feed?.return?.(); } catch {}
    try { await session.owner.quota.close({ context: session.context, lifetime: session.lifetime, reason }); }
    catch { await session.owner.quota.reconcile({ context: session.context, lifetime: session.lifetime, reason }); }
    sessions.delete(token);
    return { closed: true };
  }

  // Hibernating DO callbacks call this entry with the serialized attachment
  // and a freshly extracted actor/claims context. The owner reopens the same
  // lifetime admission; no caller grant or copied identity is accepted.
  async function resume({ socket, attachment = socket?.deserializeAttachment?.(), context }) {
    if (!attachment || attachment.kind !== 'native-board-live/v1' || !attachment.token || !attachment.space_id || !attachment.generation)
      throw fail('The native board socket attachment is invalid.', 403);
    if (sessions.has(attachment.token)) return sessions.get(attachment.token);
    const owner = await resolve({ space_id: attachment.space_id, context });
    if (!owner || owner.generation !== attachment.generation || typeof owner.quota?.resume !== 'function') throw fail('The board socket belongs to a retired native incarnation.', 409);
    const lifetime = await owner.quota.resume({ context, token: attachment.token, resource: attachment.space_id, generation: attachment.generation });
    await owner.quota.check({ context, lifetime, resource: attachment.space_id, generation: attachment.generation });
    const mode = attachment.mode === 'records' ? 'records' : 'presence';
    const identity = await owner.authorize(context, mode);
    const session = { token: attachment.token, owner, space_id: attachment.space_id, generation: attachment.generation,
      mode, view: viewName(attachment.view), context, identity: { id: attachment.member_id, name: String(identity.name ?? '').slice(0, 100),
        relay: identity.relay, may_change: identity.may_change === true }, lifetime, socket, closed: false,
      cursor: String(attachment.cursor ?? ''), controller: new AbortController(), feed: null, pending: null };
    if (identity.id && attachment.member_id !== identity.id) throw fail('The board socket member changed.', 403);
    sessions.set(session.token, session);
    session.feed = await owner.subscribe({ context, relay: identity.relay, space_id: session.space_id, generation: session.generation,
      ...(mode === 'records' ? { cursor: session.cursor } : { view: session.view }), signal: session.controller.signal });
    if (mode === 'records') {
      const snapshot = await measured(session, 'boardRecords', { space_id: session.space_id, limit: MAX_RECORDS },
        () => owner.read({ context, relay: identity.relay, space_id: session.space_id, limit: MAX_RECORDS }));
      if (String(snapshot.cursor ?? '') !== session.cursor) {
        session.cursor = String(snapshot.cursor ?? '');
        send(session, { type: 'board', records: validateRecords(snapshot.records) });
      }
    }
    persist(session);
    return session;
  }
  async function socketMessage({ socket, data, context }) {
    const attachment = socket?.deserializeAttachment?.();
    const session = attachment && sessions.get(attachment.token) || await resume({ socket, attachment, context });
    return message(session.token, data, context);
  }
  async function socketClose(socket, reason = 'closed') {
    const attachment = socket?.deserializeAttachment?.();
    return attachment?.token ? close(attachment.token, reason) : { closed: false };
  }

  return Object.freeze({ open, message, next, close, resume, socketMessage, socketClose, sessionCount: () => sessions.size });
}

/** Cloudflare native WebSocket realization. The Response101 is returned only
 * as transport output; it is never serialized into a command receipt. */
export async function acceptNativeBoardLiveWebSocket({ request, ctx, live, context, resolveBinding }) {
  if (request?.headers?.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Open this as a WebSocket.', { status: 426 });
  if (typeof WebSocketPair !== 'function') throw fail('The native WebSocket carrier is unavailable.', 503);
  const url = new URL(request.url), match = url.pathname.match(/^\/work\/live\/board\/([^/]+)$/);
  if (!match) return new Response('Unknown live board route.', { status: 404 });
  const space_id = decodeURIComponent(match[1]);
  const [client, server] = Object.values(new WebSocketPair());
  try {
    ctx.acceptWebSocket(server, [url.searchParams.get('as') === 'records' ? 'records' : 'presence', viewName(url.searchParams.get('view'))]);
    const binding = await resolveBinding({ space_id, request, context });
    await live.open({ space_id, as: url.searchParams.get('as'), view: url.searchParams.get('view'), context: binding.context ?? context, socket: server });
    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    try { server.close(error?.status === 403 ? 4403 : 1011, String(error?.message ?? 'Board unavailable.').slice(0, 120)); } catch {}
    return Response.json({ error: String(error?.message ?? 'Board unavailable.') }, { status: error?.status ?? 503 });
  }
}

export function validateRecords(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS || jsonSize(records) > MAX_RECORDS_MESSAGE) throw fail('The current board projection exceeds its record bound.', 413);
  return records.map(row => {
    if (!object(row) || typeof row.address !== 'string' || !row.address || row.address.length > MAX_ADDRESS || row.value === undefined || jsonSize(row.value) > MAX_VALUE_BYTES)
      throw fail('The current board projection contains an invalid record.', 409);
    return { address: row.address, value: row.value };
  });
}
function send(session, value) { safeSend(session, value); }
function safeSend(session, value) { try { session.socket.send(JSON.stringify(value)); } catch {} }
function persist(session) {
  try { session.socket.serializeAttachment?.({ kind: 'native-board-live/v1', token: session.token, space_id: session.space_id,
    generation: session.generation, mode: session.mode, view: session.view, cursor: session.cursor, member_id: session.identity.id }); } catch {}
}
