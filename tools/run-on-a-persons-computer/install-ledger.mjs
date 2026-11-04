// computer/install-ledger.mjs
//
// Purpose: one record of everything this Mac's reader writes into another application's folder (a browser's offer file,
// an AI tool's settings), so removal and repair touch exactly what was written and nothing else.
//
// Non-negotiable invariants
//   1. Every such write is a ledger row { path, owner, reason, content (BLAKE3 of the bytes written), written_at },
//      recorded in the same step as the write; a file written without a row is a defect.
//   2. Removal deletes a file only while its bytes are still the ones recorded. A file the person or the other app
//      changed is left alone and reported as changed; one already gone is dropped from the ledger.
//   3. The ledger lives inside the caller's own state object (`state.ledger`); this file reads and writes no file of
//      its own and names no application.
import { makeHashCodeHexFromBytes } from '../content-identity/read-data/identity.mjs';
import { readFileSync, rmSync } from 'node:fs';

export const contentOf = bytes => makeHashCodeHexFromBytes(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).slice(3);

/** Records one write into the state; a second row for the same path replaces the first. */
export function recordWrite(state, { path, owner, reason, bytes, at = new Date().toISOString() }) {
  state.ledger = [...(state.ledger ?? []).filter(row => row.path !== path), { path, owner, reason, content: contentOf(bytes), written_at: at }];
  return state.ledger.at(-1);
}

export const writesOf = (state, { owner } = {}) => (state.ledger ?? []).filter(row => owner === undefined || row.owner === owner);

/**
 * Removes what the ledger says was written (all of it, or one owner's): { removed, gone, changed } path lists. Rows for
 * removed and already-gone files leave the ledger; a changed file stays on it so it is reported again.
 */
export function removeWrites(state, { owner, read = readFileSync, remove = rmSync } = {}) {
  const outcome = { removed: [], gone: [], changed: [] };
  const rows = writesOf(state, { owner });
  for (const row of rows) {
    let bytes;
    try { bytes = read(row.path); } catch (error) { if (error?.code === 'ENOENT') { outcome.gone.push(row.path); continue; } throw error; }
    if (contentOf(bytes) !== row.content) { outcome.changed.push(row.path); continue; }
    remove(row.path);
    outcome.removed.push(row.path);
  }
  const done = new Set([...outcome.removed, ...outcome.gone]);
  state.ledger = (state.ledger ?? []).filter(row => !(rows.includes(row) && done.has(row.path)));
  return outcome;
}
