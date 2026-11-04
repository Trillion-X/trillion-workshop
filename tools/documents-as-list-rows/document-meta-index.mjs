// src/document-meta-index.mjs
//
// Purpose: what the documents of a folder say about themselves (their properties, links, tags and aliases, from
// src/document-properties.mjs parseDocument) kept by the document's content identity, so a later read of the folder
// (another isolate, another day) does not read each document's bytes again from the Namespace.
//
// Non-Negotiable Invariants:
//   1. An entry is keyed by content identity and a document's bytes never change under one identity, so no entry is ever
//      stale; a changed document has a new identity and is read once, then kept.
//   2. The index is bounded by DATA (src/document-properties.json metadata_index): identities are listed in chunks in the
//      order they were first kept, and past `kept` the oldest chunk is forgotten whole. Forgetting only costs a read.
//   3. The index owns no storage: `read`, `write` and `forget` are the owner's own keyed facts (the resource's workshop
//      facts), so erasing the owner erases the index with it.
//
//   makeMetaIndex({ read, write, forget }) → { get(identity), add([[identity, parsed], ...]) }
import data from './document-properties.json' with { type: 'json' };

const { entry_prefix: ENTRY, order_prefix: ORDER, state_key: STATE, kept: KEPT, chunk: CHUNK } = data.metadata_index;
const CHUNKS = Math.max(1, Math.ceil(KEPT / CHUNK));

export function makeMetaIndex({ read, write, forget }) {
  return {
    /** The parsed document kept under an identity, or null. */
    get: async identity => (await read(`${ENTRY}${identity}`)) ?? null,
    /** Keeps parsed documents not kept yet, forgetting the oldest chunk past the bound. */
    async add(entries) {
      const state = (await read(STATE)) ?? { head: 0, tail: 0 };
      const chunks = new Map();
      const chunkOf = async at => { if (!chunks.has(at)) chunks.set(at, (await read(`${ORDER}${at}`)) ?? []); return chunks.get(at); };
      let touched = false;
      for (const [identity, parsed] of entries) {
        if ((await read(`${ENTRY}${identity}`)) != null) continue;
        await write(`${ENTRY}${identity}`, parsed);
        let list = await chunkOf(state.head);
        if (list.length >= CHUNK) { state.head += 1; list = await chunkOf(state.head); }
        list.push(identity);
        touched = true;
      }
      if (!touched) return;
      while (state.head - state.tail + 1 > CHUNKS) {
        for (const identity of await chunkOf(state.tail)) await forget(`${ENTRY}${identity}`);
        await forget(`${ORDER}${state.tail}`);
        chunks.delete(state.tail);
        state.tail += 1;
      }
      for (const [at, list] of chunks) if (at >= state.tail) await write(`${ORDER}${at}`, list);
      await write(STATE, state);
    },
  };
}
