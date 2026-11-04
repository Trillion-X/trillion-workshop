// packages/group/show/note-edit-session.ts
//
// The edit-session TRANSACTION primitive — pure, zero I/O. A live inline editor (a rich note
// today; any draft editor tomorrow) persists per-keystroke drafts WITHOUT flooding board undo
// history (`{ undoable: false }`), then records the WHOLE session as ONE undoable step when
// editing ends. Without this, a note edit was invisible to Cmd-Z the moment focus left the
// editor ("I can't get my words back"). This leaf owns only the session lifecycle + the
// change decision; the caller supplies the graph snapshot and records the returned step via
// its own `history.record`. Generic over the graph type `G` (L069) — nothing here knows what
// a "note" or a "graph" is, so any editable member can wrap its live-draft editor in it.

/** A live edit transaction: the graph snapshot taken when editing began + the member key. */
export interface EditSession<G> {
  readonly before: G;
  readonly key: string;
}

/** Open a session — capture the before-state snapshot for the member being edited. */
export function beginEditSession<G>(before: G, key: string): EditSession<G> {
  return { before, key };
}

/**
 * Close a session. Returns the ONE undoable step `{before, after}` the caller should record,
 * or `null` when there was no open session OR nothing changed — so an editor that was opened
 * but never touched (or typed-then-reverted to identical content) records no spurious undo
 * step. `changed` defaults to reference inequality; a caller with access to the graph model
 * should pass a content-aware predicate (compare the edited member's html/text) so a
 * type-then-delete-back to the same text records nothing.
 */
export function endEditSession<G>(
  session: EditSession<G> | null,
  after: G,
  changed: (before: G, after: G) => boolean = (b, a) => b !== a,
): { before: G; after: G } | null {
  if (!session) return null;
  return changed(session.before, after) ? { before: session.before, after } : null;
}
