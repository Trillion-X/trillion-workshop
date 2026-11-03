// src/live-protocol.mjs
//
// PURPOSE
//   The one owner of how the live socket (/work/live) behaves beyond "the revision moved": typed event handlers with
//   batching, the freshness of what a page holds, numbered requests with acknowledgements and a dead-man timer, the
//   store's first-frame hello (with a server-steered boot instruction), per-scope counters with named hole detection,
//   typed dirty notices, windowed list ops and the normalized boot bundle. The store's end (src/live-screen.mjs) and the
//   page's end (src/workspace/store-changes.ts) both import this file, so the two ends cannot drift. The numbers and
//   words are DATA (src/live-protocol.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: nothing here opens a socket, reads a clock or draws; the caller gives `now`, `random` and `send`.
//   2. One handler per event type: registering a second is refused, never a silent replacement.
//   3. A request fails with a named error when its socket closes; it is never left waiting.
//   4. A hole is named and filled by one catch-up request per scope; a number already held is never a hole.
//   5. Nothing names an app, a screen or a kind of data: types, scopes, kinds and reads are the caller's words.

import rules from './live-protocol.json' with { type: 'json' };

export const LIVE = rules;

// ---- F-0875: one typed handler registry, same-type events handed over in batches sized by measured cost ------------
export class DuplicateHandler extends Error {}

export function createEventRegistry({ now = () => Date.now(), batching = rules.batching } = {}) {
  const handlers = new Map();
  const size = new Map();
  const cost = new Map();
  let queue = [];
  const sizeOf = type => size.get(type) ?? batching.start;
  return {
    /** Registers the one handler of an event type: it is called with an array of that type's events. */
    on(type, handler) {
      if (handlers.has(type)) throw new DuplicateHandler(`There is already a handler for ${type}.`);
      handlers.set(type, handler);
      return () => { if (handlers.get(type) === handler) handlers.delete(type); };
    },
    push(event) { queue.push(event); },
    /** Hands every queued event to its handler, consecutive same-type events together up to the type's batch size. Events with no handler are returned. */
    async flush() {
      const taken = queue;
      queue = [];
      const unhandled = [];
      for (let at = 0; at < taken.length;) {
        const type = taken[at].type;
        let end = at + 1;
        while (end < taken.length && taken[end].type === type && end - at < sizeOf(type)) end += 1;
        const batch = taken.slice(at, end);
        at = end;
        const handler = handlers.get(type);
        if (!handler) { unhandled.push(...batch); continue; }
        const started = now();
        await handler(batch);
        const per = Math.max(0, now() - started) / batch.length;
        const average = cost.has(type) ? cost.get(type) * (1 - batching.smoothing) + per * batching.smoothing : per;
        cost.set(type, average);
        size.set(type, average <= 0 ? batching.max : Math.max(batching.min, Math.min(batching.max, Math.floor(batching.target_ms / average))));
      }
      return unhandled;
    },
    batchSize: sizeOf,
    pending: () => queue.length,
  };
}

// ---- F-0877: freshness is a contract --------------------------------------------------------------------------------
export function createFreshness({ now = () => Date.now(), random = Math.random, freshness = rules.freshness } = {}) {
  const acked = new Set();
  const deadline = new Map();
  const stale = new Set();
  const bursts = new Map();
  return {
    /** The ids to ask the store to subscribe to: the whole set the page shows, cut to what the store accepts. */
    wanted: ids => [...new Set(ids)].slice(0, freshness.max_subscriptions),
    /** The store acknowledged this set (replacing the last): these ids are fresh while it holds them. */
    acknowledged(ids) { acked.clear(); for (const id of ids) acked.add(id); },
    /** The page just read `id`: fresh until its time limit unless a subscription holds it. */
    read(id) {
      stale.delete(id);
      deadline.set(id, now() + freshness.ttl_ms * (1 + (random() * 2 - 1) * freshness.jitter));
    },
    isFresh(id) { return !stale.has(id) && (acked.has(id) || (deadline.get(id) ?? 0) > now()); },
    /** The store said `id` changed: it is stale until read again. False when more than `burst` came inside `burst_ms`. */
    invalidate(id) {
      const recent = (bursts.get(id) ?? []).filter(at => now() - at < freshness.burst_ms);
      if (recent.length >= freshness.burst) { bursts.set(id, recent); return false; }
      bursts.set(id, [...recent, now()]);
      deadline.delete(id);
      stale.add(id);
      return true;
    },
    subscribed: () => acked.size,
    /** The store lost its end (a different epoch answered): nothing is subscribed, everything is read again. */
    lost() { acked.clear(); deadline.clear(); },
  };
}

// ---- F-0879: numbered requests, acknowledgements, ping and a dead-man timer ---------------------------------------
export class LiveSocketClosed extends Error { constructor(message) { super(message); this.name = rules.requests.closed_error; } }

export function createRequests({ send, now = () => Date.now(), requests = rules.requests }) {
  const waiting = new Map();
  let number = 0;
  let heard = now();
  let pinged = now();
  let epoch = null;
  return {
    /** Sends a numbered request; answers with the store's reply, or fails with LiveSocketClosed if the socket closes first. */
    request(type, body = {}) {
      const id = ++number;
      return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); send(JSON.stringify({ id, type, ...body })); });
    },
    /** A frame arrived: any frame proves the socket is alive; a reply settles its request. Answers the store's epoch when it changed. */
    heard(text) {
      heard = now();
      if (text === requests.pong_text) return { epoch_changed: false };
      let frame; try { frame = JSON.parse(text); } catch { return { epoch_changed: false }; }
      const hello = frame?.hello?.epoch ?? frame?.epoch;
      const changed = typeof hello === 'string' && epoch !== null && epoch !== hello;
      if (typeof hello === 'string') epoch = hello;
      const pending = frame && typeof frame.reply_to === 'number' ? waiting.get(frame.reply_to) : null;
      if (pending) { waiting.delete(frame.reply_to); pending.resolve(frame); }
      return { epoch_changed: changed };
    },
    /** Called on a timer: pings when it is time; 'dead' when the socket has been silent past the dead-man time. */
    tick() {
      if (now() - heard > requests.dead_ms) return 'dead';
      if (now() - pinged >= requests.ping_ms) { pinged = now(); send(requests.ping_text); return 'pinged'; }
      return 'alive';
    },
    /** The socket closed: every request still waiting fails with the named error. */
    close(why = 'The live connection closed.') { for (const [, pending] of waiting) pending.reject(new LiveSocketClosed(why)); waiting.clear(); },
    waiting: () => waiting.size,
  };
}

// Store end: answers one request frame ({ id, type, ... }) with { reply_to, ... }; null when it is not a request.
// `state` is one socket's memory ({ subscribed: [ids] }); `providers.catch_up(scope, after)` answers what a scope holds after a number.
export function answerRequest(text, state, { epoch, providers = {}, freshness = rules.freshness, requests = rules.requests } = {}) {
  if (text === requests.ping_text) return null;
  let frame; try { frame = JSON.parse(text); } catch { return null; }
  if (!frame || typeof frame.id !== 'number' || typeof frame.type !== 'string') return null;
  if (!requests.types.includes(frame.type)) return { reply_to: frame.id, epoch, error: 'unknown_request' };
  if (frame.type === 'ping') return { reply_to: frame.id, epoch, ok: true };
  if (frame.type === 'subscribe') {
    const ids = Array.isArray(frame.ids) ? [...new Set(frame.ids.filter(id => typeof id === 'string' && id))] : [];
    state.subscribed = ids.slice(0, freshness.max_subscriptions);
    return { reply_to: frame.id, epoch, acked: state.subscribed, cap: freshness.max_subscriptions, dropped: ids.length - state.subscribed.length };
  }
  if (frame.type === 'window') {
    const list = String(frame.list ?? '');
    const from = Math.max(0, Math.trunc(Number(frame.from ?? 0)) || 0);
    const to = Math.trunc(Number(frame.to ?? 0)) || 0;
    const read = providers.window?.(list, from, to);
    if (!read) return { reply_to: frame.id, epoch, error: 'unknown_list' };
    (state.windows ??= {})[list] = { from, to, rows: read.rows };
    return { reply_to: frame.id, epoch, list, from, rows: read.rows, total: read.total, ...(read.read ? { read: read.read } : {}) };
  }
  const caught = providers.catch_up?.(String(frame.scope ?? ''), typeof frame.after === 'string' ? frame.after : Number(frame.after ?? 0));
  return { reply_to: frame.id, epoch, ...(caught ? { scope: frame.scope, ...caught } : { error: 'unknown_scope' }) };
}

/** The store's end: for each window a socket holds, reads it again and answers the ops that bring the page's copy up to date ({ list, ops, read }); lists that did not change answer nothing. */
export function windowFrames(state, window) {
  const frames = [];
  for (const [list, held] of Object.entries(state.windows ?? {})) {
    const now = window(list, held.from, held.to);
    if (!now) continue;
    if (JSON.stringify(now.rows) === JSON.stringify(held.rows)) continue;
    frames.push({ list, ops: windowOps(held.rows, now.rows, { from: held.from, total: now.total }), ...(now.read ? { read: now.read } : {}) });
    held.rows = now.rows;
  }
  return frames;
}

// ---- F-0885 and the first frame: the store's hello, with a server-steered boot instruction ------------------------
export function helloFrame({ epoch, boot = rules.boot } = {}) {
  const row = boot.rows.find(candidate => candidate.active === true);
  return { epoch, ...(row ? { instruction: { code: row.code, said: row.said } } : {}) };
}
/** What a page does for a boot instruction (DATA boot.actions); null when it has none or the code is not known. */
export function bootAction(hello, boot = rules.boot) {
  const code = hello?.instruction?.code;
  return typeof code === 'string' && Object.hasOwn(boot.actions, code) ? { action: boot.actions[code], said: hello.instruction.said ?? '' } : null;
}

// ---- F-0744: per-scope counters with named holes and one catch-up per scope ---------------------------------------
export function createCounters({ catchUp, log = () => {}, counters = rules.counters } = {}) {
  const held = new Map();
  const filling = new Set();
  return {
    /** A notice numbered `n` arrived for `scope`. Answers 'next', 'held' (already had it) or the hole it opened. A scope whose
     *  numbers are opaque, ordered cursors (strings, like the record log's) has no holes to name: a cursor past the one held
     *  is a change since it, filled by the same one catch-up with `after` that cursor; answers { scope, after, to }. */
    observe(scope, n) {
      const last = held.get(scope);
      if (typeof n === 'string') {
        if (last === undefined) { held.set(scope, n); return 'next'; }
        if (n <= last) return 'held';
        const delta = { scope, after: last, to: n };
        if (!filling.has(scope)) {
          filling.add(scope);
          Promise.resolve(catchUp(scope, last)).then(
            caught => { const through = caught?.through; held.set(scope, [n, typeof through === 'string' ? through : ''].sort().at(-1)); },
            () => {},
          ).finally(() => filling.delete(scope));
        }
        return delta;
      }
      if (last === undefined || n === last + 1) { held.set(scope, n); return 'next'; }
      if (n <= last) return 'held';
      const hole = { scope, from: last + 1, to: n - 1 };
      log(`${counters.hole_log}: ${scope} ${hole.from}..${hole.to}`);
      if (!filling.has(scope)) {
        filling.add(scope);
        Promise.resolve(catchUp(scope, last)).then(
          caught => { held.set(scope, Math.max(held.get(scope) ?? 0, n, Number(caught?.through ?? 0))); },
          () => {},
        ).finally(() => filling.delete(scope));
      }
      return hole;
    },
    last: scope => held.get(scope),
    filling: scope => filling.has(scope),
  };
}

// ---- F-0812, F-0822, F-0816: typed dirty notices, read again by id only when the version moved --------------------
export function createDirty({ read }) {
  const versions = new Map();
  return {
    /** { kind, id?, version }: reads `kind` again (with its id) when the version differs from the one held; true when it did. */
    notice({ kind, id = '', version }) {
      const key = `${kind}\u0000${id}`;
      if (version !== undefined && versions.get(key) === version) return false;
      if (version !== undefined) versions.set(key, version);
      read(kind, id);
      return true;
    },
    held: (kind, id = '') => versions.get(`${kind}\u0000${id}`),
  };
}

// ---- F-0896: windowed list ops --------------------------------------------------------------------------------------
/** Applies ordered ops to a window ({ from, rows, total }) and answers the next window; `invalidate` answers `stale: true`. */
export function applyWindowOps(window, ops) {
  let { from, rows, total, online } = window;
  let stale = false;
  rows = [...rows];
  for (const op of ops) {
    if (op.total !== undefined) total = op.total;
    if (op.online !== undefined) online = op.online;
    if (op.op === 'sync') { from = op.from ?? from; rows = [...op.rows]; stale = false; }
    else if (op.op === 'insert') rows.splice(op.index - from, 0, op.row);
    else if (op.op === 'update') rows[op.index - from] = op.row;
    else if (op.op === 'delete') rows.splice(op.index - from, 1);
    else if (op.op === 'invalidate') stale = true;
  }
  return { from, rows, total, ...(online === undefined ? {} : { online }), stale };
}
/** The store's end: the ops that turn `before` (a window's rows) into `after`, by row id. A reorder is a delete and an insert. */
export function windowOps(before, after, { from = 0, idOf = row => row.id, total = from + after.length } = {}) {
  const ops = [];
  const working = [...before];
  const afterIds = new Set(after.map(idOf));
  for (let i = working.length - 1; i >= 0; i -= 1) if (!afterIds.has(idOf(working[i]))) { ops.push({ op: 'delete', index: from + i }); working.splice(i, 1); }
  after.forEach((row, i) => {
    const at = working.findIndex(candidate => idOf(candidate) === idOf(row));
    if (at === i) { if (JSON.stringify(working[i]) !== JSON.stringify(row)) { ops.push({ op: 'update', index: from + i, row }); working[i] = row; } return; }
    if (at !== -1) { ops.push({ op: 'delete', index: from + at }); working.splice(at, 1); }
    ops.push({ op: 'insert', index: from + i, row });
    working.splice(i, 0, row);
  });
  if (ops.length) ops[ops.length - 1] = { ...ops[ops.length - 1], total };
  else ops.push({ op: 'sync', from, rows: [...after], total });
  return ops;
}

// ---- F-0891: the normalized boot bundle ---------------------------------------------------------------------------
/** Lists of entities in, each entity once: { entities: { id: entity }, lists: { name: [ids] } }. */
export function normalizeBundle(lists, idOf = entity => entity.id) {
  const entities = {};
  const named = {};
  for (const [name, members] of Object.entries(lists)) {
    named[name] = members.map(member => { const id = idOf(member); entities[id] ??= member; return id; });
  }
  return { entities, lists: named };
}
/** The bundle read back as lists of entities; an id the bundle does not carry is left out and named in `missing`. */
export function resolveBundle(bundle) {
  const missing = [];
  const lists = {};
  for (const [name, ids] of Object.entries(bundle.lists)) lists[name] = ids.flatMap(id => (Object.hasOwn(bundle.entities, id) ? [bundle.entities[id]] : (missing.push(id), [])));
  return { lists, missing };
}

// ---- F-0890: a socket opened before the app loads keeps what it hears until the app takes it ---------------------
export function createEarlyBuffer() {
  const heard = [];
  let consumer = null;
  return {
    /** Called for every frame as it arrives, before or after the app took the socket. */
    frame(text) { if (consumer) consumer(text); else heard.push(text); },
    /** The app mounted: it gets everything heard so far, in order, then every later frame. */
    take(next) { consumer = next; for (const text of heard.splice(0)) next(text); },
    buffered: () => heard.length,
  };
}

/** The inline script that opens the socket before the app loads and keeps what it hears (F-0890); its page end is store-changes.ts. */
export const earlySocketScript = () => `(function(){try{var w=window,t=false,h=[];var open=function(){var s=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+${JSON.stringify(rules.early.path)});`
  + `w.trillionEarlySocket={socket:s,take:function(f){t=true;var q=h;h=null;q.forEach(f);s.addEventListener('message',function(e){f(e.data)})}};`
  + `s.addEventListener('message',function(e){if(h)h.push(e.data)});setTimeout(function(){if(!t){s.close(1000);var c=w.trillionCounting;if(c&&c.liveClosed)c.liveClosed('early',${Number(rules.early.give_up_ms)})}},${Number(rules.early.give_up_ms)})};`
  // Another tab holding the stream lock owns the browser's socket: this one opens none (rules.early.stream_lock). Without
  // Web Locks, or when asking them fails, it opens one as before.
  + `var n=typeof navigator!=='undefined'?navigator:null,a=null;try{a=n&&n.locks&&n.locks.query?n.locks.query():null}catch(e){a=null}`
  + `if(a&&a.then)a.then(function(q){if(!((q&&q.held)||[]).some(function(l){return l.name===${JSON.stringify(rules.early.stream_lock)}}))open()},open);else open()}catch(e){}})();`;
