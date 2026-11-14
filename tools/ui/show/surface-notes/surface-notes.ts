// parts/ui/show/surface-notes/surface-notes.ts
//
// PURPOSE
// Notes on places: a short message, a count, a highlight and screens to open,
// left on a navigation row or a list by its id (the person's AI leaves them
// through src/sidebar.mjs note_in_sidebar). An owner publishes the whole set;
// any row or list heading reads the note for its own id and draws it (its count
// as a badge, the highlight as a mark, the message and screens in its hover
// card). Nothing here knows who wrote a note or what a row is.
//
// NON-NEGOTIABLE INVARIANTS
// 1. One table per document (globalThis), so separately bundled scripts on one
//    page read and write the same notes (as surface-badges does).
// 2. Publishing the set replaces it whole; a note absent from it is gone.
// 3. Publishing an unchanged set notifies nobody.

import React from 'react';

/** A screen a note offers to open: its name and icon, and the call that opens it. */
export interface SurfaceNoteOpen {readonly id: string; readonly label: string; readonly icon?: string; readonly open: () => void}
/** A note on one row or list. */
export interface SurfaceNote {
  readonly message?: string;
  readonly count?: number;
  readonly highlight?: boolean;
  readonly by?: string;
  readonly opens?: readonly SurfaceNoteOpen[];
}

type Listener = () => void;
interface NoteTable {notes: ReadonlyMap<string, SurfaceNote>; key: string; listeners: Set<Listener>}

const KEY = '__trillionSurfaceNotes';

function table(): NoteTable {
  const scope = globalThis as unknown as Record<string, NoteTable | undefined>;
  return scope[KEY] ??= {notes: new Map(), key: '', listeners: new Set()};
}

/** Replace every note (invariant 2); `key` says what the set is, so the same set again notifies nobody (invariant 3). */
export function publishSurfaceNotes(notes: ReadonlyMap<string, SurfaceNote>, key: string): void {
  const current = table();
  if (current.key === key) return;
  current.notes = notes;
  current.key = key;
  for (const listener of [...current.listeners]) listener();
}

export function readSurfaceNote(id: string): SurfaceNote | undefined {
  return table().notes.get(id);
}

export function subscribeSurfaceNotes(listener: Listener): () => void {
  const current = table();
  current.listeners.add(listener);
  return () => { current.listeners.delete(listener); };
}

/** The note on `id`, or undefined when there is none. */
export function useSurfaceNote(id: string | undefined): SurfaceNote | undefined {
  return React.useSyncExternalStore(
    subscribeSurfaceNotes,
    () => (id ? readSurfaceNote(id) : undefined),
    () => undefined,
  );
}
