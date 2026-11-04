// parts/delight-moments/read-data/choose-moment.mjs
//
// Purpose
//   Picks the moment to play for one thing that happened, from moment rows a caller hands in, and says what to
//   remember so the next pick is right (how many times each kind happened, which once-only moments have played).
//   Pure: no DOM, no storage, no clock; the player (show/DelightMoments.tsx) and the tests call it the same way.
//
// Non-negotiable invariants
//   1. A row answers an event when its `on.event_kind` equals the event's kind, every `on.match` field equals the
//      event's field, and every `on.starts_with` field starts the event's field. A row with `on.typed` answers only
//      typed phrases (`typedMoment`). No event kind or field name is written in this file.
//   2. Rows are tried in their order; the first row that answers and is due wins. A `once` row is due only if it has
//      never played; a `count_at` row only when the event's running count is one of those numbers.
//   3. A row's words are a list; the pick rotates through it by how many times that row has played, so the same
//      moment says something different the next time. `{count}` in words is the event's running count.
//   4. `memory` is never changed here; the returned `remember` is the whole next memory.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const emptyMemory = () => ({ counts: {}, played: {} });

const fieldsMatch = (wanted, event, test) => Object.entries(wanted ?? {}).every(([key, value]) => typeof event[key] === 'string' && test(event[key], String(value)));

/** Whether one row answers one event (invariant 1); parts/feel answers events with its own rows the same way. */
export function rowAnswers(row, event) {
  const on = row.on ?? {};
  if (typeof on.typed === 'string' || on.event_kind !== event.event_kind) return false;
  return fieldsMatch(on.match, event, (have, want) => have === want) && fieldsMatch(on.starts_with, event, (have, want) => have.startsWith(want));
}

function wordsOf(row, played, count) {
  const list = Array.isArray(row.words) ? row.words : [row.words];
  const words = String(list[played % list.length] ?? '');
  return words.replaceAll('{count}', count.toLocaleString('en-US'));
}

function pick(rows, isAnswer, countKey, memory) {
  const counts = { ...memory.counts, [countKey]: (memory.counts?.[countKey] ?? 0) + 1 };
  const count = counts[countKey];
  for (const row of rows) {
    if (!isAnswer(row)) continue;
    const played = memory.played?.[row.id] ?? 0;
    if (row.once && played > 0) continue;
    if (Array.isArray(row.count_at) && !row.count_at.includes(count)) continue;
    return {
      moment: { id: row.id, motion: row.motion, mark: row.mark ?? '', words: wordsOf(row, played, count) },
      remember: { counts, played: { ...memory.played, [row.id]: played + 1 } },
    };
  }
  return { moment: null, remember: { counts, played: { ...memory.played } } };
}

/** The moment for one happened event, or null, and the memory to keep. */
export function chooseMoment(rows, event, memory = emptyMemory()) {
  return pick(rows, row => rowAnswers(row, event), `event:${event.event_kind}`, { ...emptyMemory(), ...memory });
}

/** The moment for the text typed so far, or null: a row whose `on.typed` phrase the text ends with. */
export function typedMoment(rows, typedText, memory = emptyMemory()) {
  const text = String(typedText ?? '').toLowerCase();
  const row = rows.find(candidate => typeof candidate.on?.typed === 'string' && text.endsWith(candidate.on.typed.toLowerCase()));
  if (!row) return { moment: null, remember: { ...emptyMemory(), ...memory } };
  return pick([row], () => true, `typed:${row.on.typed.toLowerCase()}`, { ...emptyMemory(), ...memory });
}

/** The longest typed phrase any row waits for, so a player keeps only that many typed characters. */
export const longestTypedPhrase = rows => rows.reduce((longest, row) => Math.max(longest, typeof row.on?.typed === 'string' ? row.on.typed.length : 0), 0);

/** Every event kind some row answers, for the coverage judge (scripts/check-delight.mjs). */
export const answeredKinds = rows => new Set(rows.map(row => row.on?.event_kind).filter(kind => typeof kind === 'string'));
