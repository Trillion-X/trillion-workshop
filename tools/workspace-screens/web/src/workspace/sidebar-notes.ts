// src/workspace/sidebar-notes.ts
//
// NO PRIOR: the page's end of src/sidebar.mjs `note_in_sidebar`.
//
// PURPOSE
//   Keeps the notes the person's AI left on their sidebar (the `sidebar-notes` record, one note per list or row id)
//   published to the shared note table (parts/ui/show/surface-notes), so every row and list heading draws its own
//   note: the count, the highlight, the message and the screens it offers in the hover card. A note written while the
//   page is open shows without a reload, because the page records follow the store (records.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only screens this person is offered can be opened from a note; a named screen they are not offered is left out.
//   2. Nothing here names a list, a row or a screen.

import { readInputValue, subscribe } from './records';
import { publishSurfaceNotes, type SurfaceNote } from '../../parts/ui/show/surface-notes/surface-notes';

type Row = Record<string, unknown> & { id: string };
type KeptNote = { message?: unknown; count?: unknown; highlight?: unknown; by?: unknown; opens?: unknown };

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Publish the kept notes now and whenever the records change; `open` opens one offered screen row. */
export function keepSidebarNotes(offered: readonly Row[], open: (row: Row) => void): () => void {
  const publish = () => {
    const byId = new Map(offered.map(row => [row.id, row]));
    const kept = readInputValue<Record<string, KeptNote> | null>('sidebar-notes');
    const value = kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
    const notes = new Map<string, SurfaceNote>();
    for (const [on, note] of Object.entries(value)) {
      if (!note || typeof note !== 'object') continue;
      const opens = (Array.isArray(note.opens) ? note.opens : []).flatMap(id => {
        const row = typeof id === 'string' ? byId.get(id) : undefined;
        return row ? [{ id: row.id, label: text(row.label) ?? row.id, icon: text(row.icon), open: () => open(row) }] : [];
      });
      notes.set(on, {
        message: text(note.message),
        count: typeof note.count === 'number' && note.count > 0 ? note.count : undefined,
        highlight: note.highlight === true,
        by: text(note.by),
        opens,
      });
    }
    publishSurfaceNotes(notes, JSON.stringify(value));
  };
  publish();
  return subscribe(publish);
}
