// parts/record-log/do-work/record-intents.mjs
//
// A CHANGE ONE STORE ASKS OF ANOTHER IS KEPT WITH ITS OWN CHANGE, DELIVERED UNTIL A RECEIPT COMES BACK, AND APPLIED
// THERE EXACTLY ONCE, IN THE ORDER IT WAS ASKED.
//
// Purpose
//   Two stores never lock each other (a person's records and a space's are separate stores, each its own Durable
//   Object). When a change in one must make a change in the other, the first store writes an INTENT in the same write
//   as its own change (one log row: both happen or neither does), then delivers it until the other store answers with a
//   RECEIPT: applied, refused (the other store does not let this source change those records) or failed (it could not
//   take them). The receiving store keeps the receipt, so an intent delivered twice is answered from it, never applied
//   twice; and it takes each source's intents in the order they were asked (a numbered channel), so delivery that
//   reorders them never changes the outcome.
//
// Non-negotiable invariants
//   1. Atomic with the change that asks: intentRecords() answers records the caller writes in its own write.
//   2. Exactly once: receiving keeps `receipt:<source>:<request>` in the same write as the records it applies; the same
//      intent again answers that receipt and writes nothing.
//   3. In order per source: intent n from a source is taken only after n - 1 (the store keeps the next number it
//      expects in `channel-in:<source>`); an intent that arrives early answers { result: 'later' } and is delivered again.
//   4. Delivered until answered: an intent stays (`intent:<request>`) until a receipt comes back; then it is replaced by
//      its result (`intent-result:<request>`) in one write. A delivery that fails in transport leaves it waiting.
//   5. Nothing here names a store, a route or a transport: `send(target, intent)` is the caller's, and `allows(records,
//      source)` is the receiving store's own rule for what a source may change.
//
// Key concepts
//   intent    { request_id, source, target, number, records: [{ id, type, value }], asked_at }
//   receipt   { request_id, source, target, number, result: 'applied' | 'refused' | 'failed' | 'later', reason?, at }
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const ID_PART = /^[^/\u0000:]+$/;
const named = (what, text) => { if (typeof text !== 'string' || !ID_PART.test(text)) throw new Error(`${what} must be text without "/" or ":": ${text}`); return text; };

/**
 * The records that ask `target` for `records`, to write in the same write as the asking store's own change:
 * the intent and the next number of this store's channel to that target.
 */
export function intentRecords(store, { source, target, records, request_id: requestId, asked_at: askedAt = new Date().toISOString() }) {
  named('A source', source);
  named('A target', target);
  named('A request id', requestId);
  if (!Array.isArray(records) || !records.length) throw new Error('An intent carries at least one record.');
  const channel = `channel-out:${target}`;
  const number = store.read(channel)?.next ?? 1;
  return [
    { id: channel, type: 'channel-out', value: { target, next: number + 1 } },
    { id: `intent:${requestId}`, type: 'intent', value: { request_id: requestId, source, target, number, records, asked_at: askedAt } },
  ];
}

/** The intents still waiting for a receipt, oldest number first per target. */
export function waitingIntents(store) {
  return store.ids('intent').map(id => store.read(id)).filter(Boolean)
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : a.number - b.number));
}

/**
 * Takes one intent into `store` (the target): applies its records with the receipt in one write, or answers the
 * receipt kept from before, or 'later' when an earlier intent from the same source has not arrived yet.
 * allows(records, source) → true, or text saying why not.
 */
export function receiveIntent(store, intent, { allows = () => true, actor = {} } = {}) {
  const { request_id: requestId, source, target, number, records } = intent;
  named('A source', source);
  named('A request id', requestId);
  const receiptId = `receipt:${source}:${requestId}`;
  const kept = store.read(receiptId);
  if (kept) return kept;
  const channelId = `channel-in:${source}`;
  const expected = store.read(channelId)?.next ?? 1;
  const at = new Date().toISOString();
  if (number !== expected) return { request_id: requestId, source, target, number, result: 'later', expected, at };
  const answer = (result, reason) => ({ request_id: requestId, source, target, number, result, ...(reason ? { reason } : {}), at });
  const bookkeeping = receipt => [
    { id: channelId, type: 'channel-in', value: { source, next: number + 1 } },
    { id: receiptId, type: 'receipt', value: receipt },
  ];
  const allowed = allows(records, source);
  if (allowed !== true) {
    const receipt = answer('refused', typeof allowed === 'string' ? allowed : 'This store does not take these records from this source.');
    store.write(bookkeeping(receipt), { actor, transaction_id: requestId });
    return receipt;
  }
  const receipt = answer('applied');
  try {
    store.write([...records, ...bookkeeping(receipt)], { actor: { ...actor, from: source }, transaction_id: requestId });
    return receipt;
  } catch (error) {
    // The records themselves could not be taken (too large, malformed): that answer is final, so it is kept too and
    // the channel moves on; a fault of the store itself (a reset) never reaches here as an answer.
    if (error?.injected) throw error;
    const failed = answer('failed', String(error?.message ?? error));
    store.write(bookkeeping(failed), { actor, transaction_id: requestId });
    return failed;
  }
}

/**
 * Delivers every waiting intent through send(target, intent) (async, any transport), each target's in number order,
 * and keeps what comes back: a receipt replaces its intent with the result. A target answering 'later', or a
 * delivery that throws, stops that target for this round (its later intents would only be answered 'later' too).
 * Answers { delivered, results: [receipt], waiting, failed_deliveries }.
 */
export async function deliverIntents(store, send, { actor = {} } = {}) {
  const report = { delivered: 0, results: [], waiting: 0, failed_deliveries: 0 };
  const stopped = new Set();
  for (const intent of waitingIntents(store)) {
    if (stopped.has(intent.target)) { report.waiting += 1; continue; }
    let receipt;
    try { receipt = await send(intent.target, intent); } catch {
      report.failed_deliveries += 1;
      report.waiting += 1;
      stopped.add(intent.target);
      continue;
    }
    if (!receipt || receipt.request_id !== intent.request_id || receipt.result === 'later') {
      report.waiting += 1;
      stopped.add(intent.target);
      continue;
    }
    store.write([
      { id: `intent:${intent.request_id}`, type: 'intent', value: null },
      { id: `intent-result:${intent.request_id}`, type: 'intent-result', value: { request_id: intent.request_id, target: intent.target, number: intent.number, result: receipt.result, ...(receipt.reason ? { reason: receipt.reason } : {}), at: receipt.at } },
    ], { actor });
    report.delivered += 1;
    report.results.push(receipt);
  }
  return report;
}
