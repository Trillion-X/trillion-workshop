// parts/record-log/do-work/record-requests.mjs
//
// A WRITE A CLIENT SENDS AGAIN IS TAKEN ONCE: A REQUEST KEY SEEN WITHIN THE WINDOW ANSWERS THE FIRST WRITE, AND A
// REQUEST OLDER THAN THE WINDOW IS REFUSED RATHER THAN GUESSED AT.
//
// Purpose
//   A client (an app, a device, an AI's tool call) that lost the answer to a write sends it again. Each such write names
//   a request key; the store's write with that key is the transaction with that id (its log row carries it), so the key
//   is kept with no row beyond the write itself. requestWindow(store) remembers the keys written in the last
//   window_ms (at most most_keys of them): the same key again answers { duplicate: true } and writes nothing.
//
// Non-negotiable invariants
//   1. Exactly once inside the window, never a guess outside it: every key written since `checkedFrom` is held, and a
//      request saying it was sent before `checkedFrom` is refused (StaleRequest), so the client reads again and sends
//      a new request. checkedFrom only rises: when the window passes, when more than most_keys are held (the oldest
//      let go), and when the log no longer reaches back as far (history moved out).
//   2. The window is rebuilt from the log on first use (each kept row names its transaction), so a restarted store
//      still recognises a request it took before the restart.
//   3. Only client writes come through here. Copies settling with each other (record-sync.mjs applyChanges) never do:
//      applying the same changes twice already changes nothing, and they carry history older than any window.
//   4. Memory is bounded: most_keys keys, each with its time.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { logIdAt, logTimeOf } from './record-log-store.mjs';

export const REQUEST_WINDOW = { window_ms: 10 * 60 * 1000, most_keys: 10000 };

/** A request sent before the window the store still checks: read again, then send it as a new request. */
export class StaleRequest extends Error {
  constructor(requestKey, sentAt, checkedFrom) {
    super(`Request ${requestKey} was sent before ${new Date(checkedFrom).toISOString()}, which this store no longer checks; read again and send it as a new request.`);
    this.code = 'stale_request';
    this.request_key = requestKey;
    this.sent_at = sentAt;
    this.checked_from = new Date(checkedFrom).toISOString();
  }
}

/**
 * store: a record store (write, logAfter). Answers { write(records, { request_key, sent_at, ...context }),
 * seen(request_key), checkedFrom() }.
 */
export function requestWindow(store, { window_ms = REQUEST_WINDOW.window_ms, most_keys = REQUEST_WINDOW.most_keys, now = () => Date.now() } = {}) {
  let held = null;
  let from = 0;
  const raise = at => { if (at > from) from = at; };
  function forgetOld() {
    raise(now() - window_ms);
    for (const [key, at] of held) {
      if (at >= from && held.size <= most_keys) break;
      held.delete(key);
      raise(at + 1);
    }
  }
  function load() {
    if (held) { forgetOld(); return held; }
    held = new Map();
    const start = now() - window_ms;
    from = start;
    let position = logIdAt(start);
    for (let more = true; more;) {
      const page = store.logAfter(position, { limit: 500 });
      if (page.oldest !== null && page.oldest > logIdAt(start)) raise(logTimeOf(page.oldest));
      for (const row of page.rows) held.set(row.transaction_id, logTimeOf(row.id));
      more = page.rows.length === 500;
      position = page.last;
    }
    forgetOld();
    return held;
  }
  return {
    write(records, { request_key: requestKey, sent_at: sentAt, ...context } = {}) {
      if (requestKey === undefined) return store.write(records, context);
      if (typeof requestKey !== 'string' || !requestKey) throw new Error('A request key is non-empty text.');
      const keys = load();
      const sent = sentAt === undefined ? null : Date.parse(sentAt);
      if (sentAt !== undefined && !Number.isFinite(sent)) throw new Error(`${sentAt} is not a time.`);
      if (sent !== null && sent < from) throw new StaleRequest(requestKey, sentAt, from);
      if (keys.has(requestKey)) return { transaction_id: requestKey, duplicate: true };
      const result = store.write(records, { ...context, transaction_id: requestKey });
      keys.set(requestKey, now());
      forgetOld();
      return result;
    },
    seen: requestKey => load().has(requestKey),
    checkedFrom: () => { load(); return from; },
  };
}
