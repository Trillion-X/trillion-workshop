// tools/keep-lists-of-rows/record-at.mjs
//
// The one place the lists read a record as it was saved at an earlier moment. The engine answers it
// (trillion-rust src/storage/record_store/history.rs record_at, #149); the door will answer it as
// records:read { id, at }. Until then, a records reader that has `readAt(id, at)` (records-fake.mjs, and the door
// client once it does) is asked directly, and a local store that keeps a log (old record-log-store shape: log,
// storedRecord, logAfter, resolved) is read through record-log's readAt. Nothing else in the lists reads the past.
//
// Answer: { type, value, complete, kept_from }. value is null when the record did not exist then; complete is false
// when changes after `at` are no longer kept, and kept_from is the earliest moment the answer is good for.
import { readAt } from '../record-log/do-work/record-time.mjs';

const ownReadAt = records => typeof records?.readAt === 'function';
const keptLog = records => typeof records?.log === 'function' && typeof records?.storedRecord === 'function';

/** Whether these records can be read as they were. */
export const keepsHistory = records => ownReadAt(records) || keptLog(records);

/** One record as saved at `at` (an ISO time or a log row id). Throws when `at` is neither. */
export function recordAt(records, id, at) {
  if (ownReadAt(records)) return records.readAt(id, at);
  if (keptLog(records)) return readAt(records, id, at);
  throw new Error('These records keep no history.');
}
