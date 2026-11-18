// One account's work queue for both weigher roads. Direct arrivals retain their
// own promise; sweeps coalesce while queued. A sweep already reading may have
// missed a new event, so another request during it names one following sweep.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const STEPS_AI_MESSAGE_FIELDS = ['text', 'app', 'conversation_id', 'speaker', 'final_reply', 'recorded_at', 'authored_at', 'at', 'reworded_at'];
const messageIdentity = row => row == null ? null
  : bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(STEPS_AI_MESSAGE_FIELDS.map(field => row[field] ?? null)))));

export function stepsAisLeaveRuns(run, { readMessage } = {}) {
  if (typeof readMessage !== 'function') throw new Error('The weigher queue needs its source message owner.');
  const messages = new Map();
  let sweep = null;
  let running = false;
  let scheduled = false;
  const keyOf = (messageId, row) => JSON.stringify([messageId, messageIdentity(row)]);
  const entry = (messageId, key = null) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { messageId, key, promise, resolve, reject };
  };
  const finish = (item, result) => {
    if (item.messageId !== null && messages.get(item.key) === item) messages.delete(item.key);
    item.resolve(result);
  };
  async function drain() {
    scheduled = false;
    if (running) return;
    running = true;
    try {
      while (messages.size || sweep) {
        // Fresh replies do not wait behind a queued transcript sweep.
        const item = messages.size ? messages.values().next().value : sweep;
        if (item === sweep) sweep = null;
        const decided = new Set();
        try {
          const result = await run(item.messageId, (id, row) => decided.add(keyOf(id, row)));
          finish(item, result);
          // A run can also decide replies already in the durable waiting queue.
          // Their pending recorded events consume that same successful result,
          // including empty/context outcomes. A failed run never consumes them.
          for (const key of decided) {
            const pending = messages.get(key);
            if (pending) finish(pending, result);
          }
        } catch (error) {
          if (item.messageId !== null && messages.get(item.key) === item) messages.delete(item.key);
          item.reject(error);
        }
      }
    } finally { running = false; }
  }
  return (messageId = null) => {
    const key = messageId === null ? null : keyOf(messageId, readMessage(messageId));
    const item = messageId !== null
      ? (messages.get(key) ?? entry(messageId, key))
      : (sweep ?? entry(null));
    if (messageId !== null) messages.set(key, item);
    else sweep = item;
    if (!running && !scheduled) {
      scheduled = true;
      // Publish the entry before starting it, and coalesce arrivals in one turn.
      void Promise.resolve().then(drain);
    }
    return item.promise;
  };
}
