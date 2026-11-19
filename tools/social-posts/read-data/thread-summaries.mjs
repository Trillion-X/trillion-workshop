// src/thread-summaries.mjs
//
// Purpose
//   Reading one conversation's summary (tool:read-a-thread-summary): the summary the AI kept, and how many of the thread's
//   newest messages come after the message it covers, so a stale summary is never taken for the thread's present. Keeping
//   and removing a summary are the store's job (workflow:keep-conversation-summaries), so this code only reads the record
//   it is handed.
//
// Non-negotiable invariants
//   1. The record type and every word are DATA (read-data/thread-summaries.json).
//   2. Reading changes nothing.
//   3. A summary covers through the newest message the thread had when it was kept (its through_at); the newer count is
//      the messages handed in whose time comes after it.
//
import data from './thread-summaries.json' with { type: 'json' };

export class SummaryError extends Error {}

const text = value => (typeof value === 'string' ? value.trim() : '');
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/**
 * eeaf:  read(id) -> the record's value or null, over the records the caller handed in.
 * newer: ({ app, conversation_id, after }) -> how many messages come after the one at `after` (an ISO time).
 */
export function makeThreadSummaries({ eeaf, newer }) {
  const TYPE = data.record_type;
  const keyOf = (app, conversation) => `${TYPE}:${app || '-'}:${conversation}`;
  const asked = ({ app, conversation_id: conversation } = {}) => {
    if (!text(conversation)) throw new SummaryError(data.words.needs_conversation);
    return { app: text(app), conversation_id: text(conversation) };
  };

  function read(input = {}) {
    const thread = asked(input);
    const record = eeaf.read(keyOf(thread.app, thread.conversation_id));
    if (!record) return { summary: null, said: data.words.none_yet };
    const count = newer({ ...thread, after: record.through_at });
    return { summary: record, newer_messages: count, stale: count > 0, said: count > 0 ? fill(data.words.stale, { count }) : fill(data.words.fresh, { at: record.through_at }) };
  }

  return { read };
}
