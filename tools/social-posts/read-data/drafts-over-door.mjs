// tools/social-posts/read-data/drafts-over-door.mjs
//
// The snippet and thread-summary rows over the person's own records. snippets.mjs and thread-summaries.mjs (moved
// unchanged) take `eeaf`, a record store they call without waiting: read(id), ids(type, { limit }) and
// write([{ id, type, value | null }]). The records door is reached by waiting, so each run here works in passes: a pass
// runs the moved code over the records held so far; a record it read that is not held yet (or a whole kind it listed)
// is fetched through the door and the pass runs again. Only a pass that missed nothing keeps its writes, sent as one
// door write that each record read is still as it was read (`expected`), with a key made from the writes themselves.
import { createHash, randomUUID } from 'node:crypto';
import { makeSnippets } from './snippets.mjs';
import { makeThreadSummaries } from './thread-summaries.mjs';
import snippetRows from './snippets.json' with { type: 'json' };
import summaryRows from './thread-summaries.json' with { type: 'json' };

const MOST_PASSES = 4;

/**
 * An eeaf over records held in memory (`held`: id -> { type, value | null }). `whole(id, type)` says whether a record
 * not held (or a kind's ids) is truly absent; when not, `missed({ id } | { type })` is told and the answer is empty.
 */
export function heldEeafOver({ held = new Map(), whole = () => true, missed = () => {} } = {}) {
  const changed = new Map();
  const eeaf = {
    read(id) {
      if (!held.has(id) && !whole(id)) { missed({ id }); return null; }
      return structuredClone(held.get(id)?.value ?? null);
    },
    ids(type, { limit = Infinity } = {}) {
      if (!whole(null, type)) { missed({ type }); return []; }
      return [...held].filter(([, record]) => record.type === type && record.value !== null).map(([id]) => id).sort().reverse().slice(0, limit);
    },
    write(items) {
      for (const { id, type, value } of items) {
        held.set(id, { type, value: structuredClone(value) });
        changed.set(id, { id, type, value: structuredClone(value) });
      }
    },
  };
  return { eeaf, changed };
}

/** Runs work(eeaf) over the person's records of one kind through the door; its writes are sent once it missed nothing. */
export async function passesOverDoor(door, type, work) {
  const known = new Map();
  let listed = false;
  for (let pass = 0; pass < MOST_PASSES; pass += 1) {
    const ask = { ids: new Set(), all: false };
    const { eeaf, changed } = heldEeafOver({
      held: new Map([...known].map(([id, record]) => [id, structuredClone(record)])),
      whole: (id, kind) => {
        if (kind !== undefined && kind !== null && kind !== type) throw new Error(`This run reaches only ${type} records, not ${kind}.`);
        return listed;
      },
      missed: ({ id }) => { if (id === undefined) ask.all = true; else ask.ids.add(id); },
    });
    let answer, failed;
    try { answer = work(eeaf); } catch (error) { failed = error; }
    if (ask.all || ask.ids.size) {
      if (ask.all) {
        for await (const row of door.list({ type })) known.set(row.id, { type, value: row.value ?? null });
        listed = true;
      }
      for (const id of ask.ids) if (!known.has(id) && !listed) known.set(id, { type, value: await door.read(type, id) });
      continue;
    }
    if (failed) throw failed;
    if (changed.size) {
      const writes = [...changed.values()].map(item => {
        if (item.type !== type) throw new Error(`This run writes only ${type} records, not ${item.type}.`);
        if (!known.has(item.id)) return item; // never read (keeping a summary again replaces it): written as it is
        const before = known.get(item.id).value;
        return { ...item, expected: before === null ? null : { type, value: before } };
      });
      await door.write(writes, { key: `${type}:${createHash('sha256').update(JSON.stringify(writes)).digest('hex')}` });
    }
    return answer;
  }
  throw new Error(`The ${type} records kept changing while they were read; try again.`);
}

// One clock and one new id per run, so every pass makes the same record.
const snippetsWork = (door, act) => {
  const at = new Date();
  const id = randomUUID();
  return passesOverDoor(door, snippetRows.record_type, eeaf => act(makeSnippets({ eeaf, now: () => at, newId: () => id })));
};

/** tool:save-a-snippet: a new snippet (no snippet_id) or a change to one. */
export const saveASnippet = (input, { door }) => snippetsWork(door, snippets => snippets.save(input ?? {}));
/** tool:find-snippets: the person's snippets, newest used first, narrowed by query and tag. */
export const findSnippets = (input, { door }) => snippetsWork(door, snippets => snippets.list(input ?? {}));
/** tool:use-a-snippet: its words with the blanks filled, counting the use. */
export const useASnippet = (input, { door }) => snippetsWork(door, snippets => snippets.use(input ?? {}));
/** tool:remove-a-snippet. */
export const removeASnippet = (input, { door }) => snippetsWork(door, snippets => snippets.remove(input ?? {}));

// The thread's ends come from the messages owner, handed in: `latest` { id, at } of its newest message, and
// `message_times`, the times of its newest messages (newer counts those after a time).
const latestOf = input => {
  const latest = input?.latest;
  return latest && typeof latest === 'object' && typeof latest.id === 'string' && latest.id && typeof latest.at === 'string' && Number.isFinite(Date.parse(latest.at)) ? { id: latest.id, at: latest.at } : null;
};
const newerOf = input => ({ after }) => (Array.isArray(input?.message_times) ? input.message_times : []).filter(time => Date.parse(time) > Date.parse(after)).length;
const summariesWork = (door, input, act) => {
  const at = new Date();
  return passesOverDoor(door, summaryRows.record_type, eeaf => act(makeThreadSummaries({ eeaf, now: () => at, latest: () => latestOf(input), newer: newerOf(input) })));
};

/** tool:keep-a-thread-summary: the summary, covering through the `latest` message handed in. */
export const keepAThreadSummary = (input, { door }) => summariesWork(door, input, summaries => summaries.save(input ?? {}));
/** tool:read-a-thread-summary: the summary and how many of `message_times` are newer than what it covers. */
export const readAThreadSummary = (input, { door }) => summariesWork(door, input, summaries => summaries.read(input ?? {}));
/** tool:remove-a-thread-summary. */
export const removeAThreadSummary = (input, { door }) => summariesWork(door, input, summaries => summaries.remove(input ?? {}));
