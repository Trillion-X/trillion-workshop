// src/inputs.mjs
//
// Purpose: what a reading reads, from the person's own store with plain SQL, a bounded page at a time (no read holds a
// whole kind). Ported from awarenessInputs (src/awareness.mjs:537-645 of the old repository, commit b6ae0ebf8); the old
// engine calls (sql.exec, eeaf.scan, fields.after, namespace-results resultsTimeline) are the SQL below.
//
//   messages  the `messages` table: new ones by recorded_at after the cursor; history by id from the newest down, leaving
//             out what was kept after the first reading began (recorded_at after `until`)
//   results   `namespace_results` of settings.inputs.result_kinds: new by (recorded_at, identity, kind); history backwards
//             from the same place; only the first result_chars of each leave the store (SUBSTR)
//   activity  the `activity` view (tools/shared-code/src/activity.mjs): rows newer than the last reading, read only when
//             something else was read in the same reading, since an AI's own calls are not news about the person
//
// Non-Negotiable Invariants:
//   1. The cursor moves only past what was read: a read that stops at its budget leaves the cursor where it stopped.
//   2. The first reading starts both sides where the store stands then, so history is read exactly once.
//   3. Every value is a $n parameter; the kinds and limits are settings, never SQL text.
//
// Cursor: { new: { message, result, activity }, history: { message, result }, history_done }
//   new.message     recorded_at of the newest message read ('' when none)
//   new.result      [recorded_at, identity, kind] of the newest result read (null: none yet)
//   new.activity    the newest activity seq read
//   history.message null: not started (no id bound), an id: continue before it, false: done
//   history.result  null: done, or { from: [recorded_at, identity, kind], inclusive } to continue before it

import { text } from './picture.mjs';

const MESSAGE_COLUMNS = 'id, recorded_at, speaker, app, at, text';

/**
 * One namespace_results statement. `from` (a result tuple) bounds it: after it when order is ASC, before it when DESC,
 * inclusive or not. `chars`, when given, cuts each value to that many characters in SQL (SUBSTR), so no whole value
 * leaves the store.
 */
export function resultsQuery({ kinds, from = null, inclusive = false, order = 'ASC', limit, chars }) {
  const params = [];
  const at = value => { params.push(value); return `$${params.length}`; };
  const where = [`kind IN (${kinds.map(kind => at(kind)).join(', ')})`];
  if (from) {
    const op = order === 'ASC' ? (inclusive ? '>=' : '>') : (inclusive ? '<=' : '<');
    where.push(`(recorded_at, identity, kind) ${op} (${from.map(value => at(value)).join(', ')})`);
  }
  const said = chars === undefined ? '' : `, SUBSTR(value, 1, ${at(chars)}) AS said`;
  const limitAt = at(limit);
  return {
    sql: `SELECT recorded_at, identity, kind${said} FROM namespace_results WHERE ${where.join(' AND ')} ORDER BY recorded_at ${order}, identity ${order}, kind ${order} LIMIT ${limitAt}`,
    params,
  };
}

/** Messages: the page after a recorded_at, the page before an id (bounded by until), or the newest page when no id yet. */
export function messagesQuery({ after = null, before = null, until = null, limit }) {
  if (after !== null) return { sql: `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE recorded_at > $1 ORDER BY recorded_at, id LIMIT $2`, params: [after, limit] };
  if (before === null) return { sql: `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE recorded_at <= $1 ORDER BY id DESC LIMIT $2`, params: [until, limit] };
  return { sql: `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id < $1 AND recorded_at <= $2 ORDER BY id DESC LIMIT $3`, params: [before, until, limit] };
}

export function awarenessInputs({ query, settings }) {
  const kinds = settings.inputs.result_kinds;
  const resultChars = settings.inputs.result_chars;
  const run = ({ sql, params }) => query(sql, params);
  const first = async q => (await run(q))[0] ?? null;
  const tupleOf = row => [row.recorded_at, row.identity, row.kind];

  // Where the store stands at the first reading: the newest message and result are already read (new starts after
  // them); history starts at them, inclusive, so each is read exactly once.
  async function start() {
    const newestMessage = await first({ sql: 'SELECT recorded_at FROM messages ORDER BY recorded_at DESC, id DESC LIMIT 1', params: [] });
    const newestResult = await first(resultsQuery({ kinds, order: 'DESC', limit: 1 }));
    const activity = await first({ sql: 'SELECT COALESCE(MAX(seq), 0) AS seq FROM activity', params: [] });
    const result = newestResult ? tupleOf(newestResult) : null;
    return {
      new: { message: newestMessage?.recorded_at ?? '', result, activity: Number(activity?.seq ?? 0) },
      history: { message: null, result: result ? { from: result, inclusive: true } : null },
      history_done: false,
    };
  }

  const messageItem = (row, limits) => ({
    kind: 'message', source_id: String(row.id), speaker: row.speaker ?? 'unknown', at: row.at ?? row.recorded_at,
    from: `${row.speaker === 'person' ? 'person' : row.speaker ?? 'ai'} in ${row.app ?? 'an AI'}`,
    text: text(row.text, limits.speaker_chars?.[row.speaker] ?? limits.message_chars),
  });
  const resultItem = row => ({ kind: row.kind, at: row.recorded_at, from: `file ${String(row.identity).slice(0, 12)}`, text: text(row.said, resultChars) });

  // Anything not read yet. A cursor that finished history reads only what is newer than it.
  async function unread(cursor) {
    if (!cursor) return (await first({ sql: 'SELECT 1 AS found FROM messages LIMIT 1', params: [] })) !== null
      || (await first(resultsQuery({ kinds, limit: 1 }))) !== null;
    if (!cursor.history_done) return true;
    if (await first({ sql: 'SELECT 1 AS found FROM messages WHERE recorded_at > $1 LIMIT 1', params: [cursor.new.message] })) return true;
    return (await first(resultsQuery({ kinds, from: cursor.new.result, order: 'ASC', limit: 1 }))) !== null;
  }

  async function read(cursor, limits = settings.inputs) {
    const place = cursor ?? await start();
    const next = { new: { ...place.new }, history: { ...place.history }, history_done: place.history_done };
    const items = [];
    let left = limits.chars;
    let messagesLeft = limits.messages;
    let resultsLeft = limits.results;
    const take = item => { if (!item.text || left <= 0) return false; items.push(item); left -= item.text.length; return true; };

    // New messages, oldest first, so the cursor stops exactly where the budget ran out.
    for (const row of await run(messagesQuery({ after: place.new.message, limit: messagesLeft }))) {
      if (left <= 0) break;
      take(messageItem(row, limits));
      messagesLeft -= 1;
      next.new.message = row.recorded_at;
    }

    // New results, oldest first.
    if (resultsLeft > 0 && left > 0) {
      for (const row of await run(resultsQuery({ kinds, from: place.new.result, order: 'ASC', limit: Math.min(resultsLeft, 200), chars: resultChars }))) {
        if (left <= 0) break;
        take(resultItem(row));
        resultsLeft -= 1;
        next.new.result = tupleOf(row);
      }
    }

    // Activity rides along with a reading that read something else.
    if (items.length) {
      for (const row of await run({ sql: 'SELECT seq, at, app, row FROM activity WHERE seq > $1 ORDER BY seq LIMIT $2', params: [place.new.activity, limits.activity] })) {
        if (left <= 0) break;
        const done = JSON.parse(row.row);
        take({ kind: 'activity', at: row.at, from: row.app ?? 'an AI', text: text([done.label, done.title ?? done.item, done.ok === false ? `(did not work${done.reason ? `: ${done.reason}` : ''})` : null].filter(Boolean).join(' '), 300) });
        next.new.activity = row.seq;
      }
    }

    const finish = () => {
      const counts = {};
      for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
      return { items, cursor: next, counts };
    };
    // Then older history, newest first, until all of it was read once.
    if (place.history_done) return finish();

    let messagesDone = place.history.message === false;
    if (!messagesDone && messagesLeft > 0 && left > 0) {
      const rows = await run(messagesQuery({ before: place.history.message, until: place.new.message, limit: messagesLeft }));
      let consumed = 0;
      for (const row of rows) {
        if (left <= 0) break;
        take(messageItem(row, limits));
        next.history.message = row.id;
        consumed += 1;
      }
      messagesDone = consumed === rows.length && rows.length < messagesLeft;
    }
    if (messagesDone) next.history.message = false;

    let resultsDone = place.history.result === null;
    if (!resultsDone && resultsLeft > 0 && left > 0) {
      const rows = await run(resultsQuery({ kinds, from: place.history.result.from, inclusive: place.history.result.inclusive, order: 'DESC', limit: resultsLeft, chars: resultChars }));
      let consumed = 0;
      for (const row of rows) {
        if (left <= 0) break;
        take(resultItem(row));
        next.history.result = { from: tupleOf(row), inclusive: false };
        consumed += 1;
      }
      resultsDone = consumed === rows.length && rows.length < resultsLeft;
    }
    if (resultsDone) next.history.result = null;
    next.history_done = messagesDone && resultsDone;
    return finish();
  }

  return { unread, read };
}
