// do-work/read-awareness.mjs
//
// Purpose: the tool's answer for the reading's pure reads, run in a small container (tool:keep-a-continuous-awareness-reading,
// tool-rows.json). The caller hands in the state the reading keeps (its picture, cursor, pending request, the pursuits the
// person recorded, the map's rows and whether the plan keeps records) and gets back what Progress and read_awareness show,
// or when the next reading is due. Nothing here reads a store or asks a model: those reads are the engine's SQL and the
// routing owner's road, which the reader calls with the store's own adapters.
//
// Input (JSON):
//   action        'read' (the picture, the reading state, the map) | 'next_due' (when the next reading is due, ms or null)
//   settings      the awareness rows (content the caller hands in)
//   mapSettings   the map's reading words ({ reading: { ask, look } }), required with map_rows
//   map_list_id   the id of the person's map list, required with map_rows
//   state         { allowed, picture, reading, pending, stated, unread, map_rows }
//   now           milliseconds since the epoch (the clock; a run without it reads the container's clock)
// Result: the reader's view (read) or { next_due } (next_due).

import { awarenessReader } from '../src/reader.mjs';
import { mapAreas } from '../../place-pursuits-on-a-life-map/src/life-map.mjs';

// An in-memory store with the reader's read/write seam. A read action never writes, so the value is kept as given.
const store = value => {
  let current = value ?? null;
  return { read: () => current, write: next => { current = next; } };
};

export async function readAwareness(input) {
  const { settings, mapSettings = null, state = {} } = input ?? {};
  if (!settings) throw new TypeError('readAwareness needs the awareness settings (input.settings).');
  if (state.map_rows && (!mapSettings || !input.map_list_id)) throw new TypeError('A map needs input.mapSettings and input.map_list_id with it.');
  const clock = input.now === undefined ? () => new Date() : () => new Date(input.now);
  const map = state.map_rows ? { list_id: input.map_list_id, areas: () => mapAreas(state.map_rows) } : null;
  const reader = awarenessReader({
    settings,
    allowed: () => state.allowed === true,
    reading: store(state.reading),
    pending: store(state.pending),
    picture: store(state.picture),
    inputs: { unread: async () => state.unread === true },
    ask: null,
    stated: async () => state.stated ?? [],
    map,
    mapSettings,
    now: clock,
  });
  if (input.action === 'read') return reader.read();
  if (input.action === 'next_due') {
    const due = await reader.nextDue();
    return { next_due: due === null ? null : new Date(due).toISOString() };
  }
  throw new TypeError(`Unknown action ${JSON.stringify(input.action)}: use read or next_due.`);
}
