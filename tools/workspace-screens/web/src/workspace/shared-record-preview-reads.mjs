// Visible shared cards coalesce their saved-preview reads. One bounded batch runs at a time;
// keys include the audience, and neither success nor refusal is kept across a later grant check.
import { SHARED_PREVIEW_BATCH_SIZE } from '../shared-record-preview.mjs';

export function sharedRecordPreviewReads(send) {
  const pending = new Map();
  let queued = false;
  let running = false;
  const flush = async () => {
    if (running) return;
    queued = false;
    running = true;
    try {
      while (pending.size) {
        for (const [key, value] of pending) {
          value.waiters = value.waiters.filter(waiter => {
            if (waiter.current()) return true;
            waiter.resolve(null);
            return false;
          });
          if (!value.waiters.length) pending.delete(key);
        }
        if (!pending.size) break;
        const first = pending.values().next().value;
        const batch = [...pending.entries()].filter(([, value]) => value.spacePath === first.spacePath).slice(0, SHARED_PREVIEW_BATCH_SIZE);
        for (const [key] of batch) pending.delete(key);
        try {
          const answer = await send(first.spacePath, batch.map(([, value]) => value.itemId));
          for (const [, value] of batch) for (const waiter of value.waiters) waiter.resolve(waiter.current() ? answer.previews?.[value.itemId] ?? null : null);
        } catch (error) {
          for (const [, value] of batch) for (const waiter of value.waiters) waiter.reject(error);
        }
      }
    } finally { running = false; }
  };
  return (spacePath, itemId, current = () => true) => new Promise((resolve, reject) => {
    const key = JSON.stringify([spacePath, itemId]);
    const value = pending.get(key) ?? { spacePath, itemId, waiters: [] };
    value.waiters.push({ resolve, reject, current });
    pending.set(key, value);
    if (!queued && !running) { queued = true; queueMicrotask(flush); }
  });
}
