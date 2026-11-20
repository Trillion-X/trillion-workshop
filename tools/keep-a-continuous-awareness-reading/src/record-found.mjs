// src/record-found.mjs
//
// Purpose: records what foundPursuits returned (src/found-pursuits.mjs), one pursuit at a time, so one the store refuses
// (a title written about someone instead of to the person) never stops the others. Ported from keepFound
// (src/awareness.mjs:326-334 of the old repository, commit b6ae0ebf8).

/**
 * record:  async ([pursuit]) => records it; a throw is a refusal of that one pursuit.
 * Returns how many of each were kept: { added, updated, ended, refused }.
 */
export async function keepFound(record, { add, update, end }) {
  const kept = { added: 0, updated: 0, ended: 0, refused: 0 };
  for (const [key, items] of [['added', add], ['updated', update], ['ended', end]]) {
    for (const item of items) {
      try { await record([item]); kept[key] += 1; } catch { kept.refused += 1; }
    }
  }
  return kept;
}
