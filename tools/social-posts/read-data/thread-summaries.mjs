// src/thread-summaries.mjs
//
// Purpose
//   A short summary of one conversation, kept by the AI that read it and read by the next, with the message it covers
//   through, so anyone can tell at once whether the thread has moved on since. The summary is the AI's reading; the
//   messages themselves stay word for word where they are kept.
//
// Non-negotiable invariants
//   1. The record type, the size and every word are DATA (src/thread-summaries.json).
//   2. A summary covers through the newest message the thread had when it was kept (`latest`, from the messages owner);
//      reading says how many messages are newer, so a stale summary is never taken for the thread's present.
//   3. One summary per conversation; keeping again replaces it. Removing it removes only the summary.
//
import data from './thread-summaries.json' with { type: 'json' };

export class SummaryError extends Error {}

const text = value => (typeof value === 'string' ? value.trim() : '');
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/**
 * eeaf:   the person's record store.
 * latest: ({ app, conversation_id }) → { id, at } of the thread's newest message, or null when it has none.
 * newer:  ({ app, conversation_id, after }) → how many messages come after the one at `after` (an ISO time).
 */
export function makeThreadSummaries({ eeaf, now = () => new Date(), latest, newer }) {
  const TYPE = data.record_type;
  const keyOf = (app, conversation) => `${TYPE}:${app || '-'}:${conversation}`;
  const asked = ({ app, conversation_id: conversation } = {}) => {
    if (!text(conversation)) throw new SummaryError(data.words.needs_conversation);
    return { app: text(app), conversation_id: text(conversation) };
  };

  function save(input = {}) {
    const thread = asked(input);
    const summary = text(input.summary).slice(0, data.max_summary);
    if (!summary) throw new SummaryError(data.words.needs_summary);
    const newest = latest(thread);
    if (!newest) throw new SummaryError(data.words.nothing_there);
    const record = { summary_id: keyOf(thread.app, thread.conversation_id), ...thread, summary, through_message_id: newest.id, through_at: newest.at, set_at: now().toISOString() };
    eeaf.write([{ id: record.summary_id, type: TYPE, value: record }], { actor: { by: 'ai' } });
    return { summary: record, said: fill(data.words.fresh, { at: newest.at }) };
  }

  function read(input = {}) {
    const thread = asked(input);
    const record = eeaf.read(keyOf(thread.app, thread.conversation_id));
    if (!record) return { summary: null, said: data.words.none_yet };
    const count = newer({ ...thread, after: record.through_at });
    return { summary: record, newer_messages: count, stale: count > 0, said: count > 0 ? fill(data.words.stale, { count }) : fill(data.words.fresh, { at: record.through_at }) };
  }

  function remove(input = {}) {
    const thread = asked(input);
    const id = keyOf(thread.app, thread.conversation_id);
    if (!eeaf.read(id)) throw new SummaryError(data.words.none_yet);
    eeaf.write([{ id, type: TYPE, value: null }], { actor: { by: 'ai' } });
    return { removed: true, said: data.words.removed };
  }

  return { save, read, remove };
}
