// packages/group/read-data/arrangement-library-actions.ts
//
// The store-side controller for the Saved Arrangement Library manage actions. The
// SavedArrangementGallery emits opaque action keys (rename/archive/restore/duplicate);
// this maps each to the collection-store mutation, via a DATA capability map keyed by
// the action string (L090 — no switch in the caller, a new action is one map entry).
// `apply` is NOT here: placing onto a live board needs the panel's graph/commit, so it
// is dispatched separately (Codex: apply belongs in GroupBoardPanel).

import type { AddressRef, GroupGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { SavedArrangement } from './saved-arrangement';
import { duplicateSavedArrangement } from './saved-arrangement';
import { renameCollection, archiveCollection, restoreCollection } from 'trillion-workshop/tools/organize-the-sidebar/read-data/collection-store.ts';

/** The inputs a manage action may need beyond the row (a new name, minted ids for a
 *  duplicate). Opaque bag — each handler reads only what it needs. */
export interface ArrangementActionInput {
  readonly name?: string;
  readonly newMemberId?: string;
  readonly newCollectionId?: string;
}

/** One manage handler: pure (graph, index, row, input) -> graph. */
export type ArrangementActionHandler = (
  graph: GroupGraph,
  indexRef: AddressRef,
  row: SavedArrangement,
  input: ArrangementActionInput,
) => GroupGraph;

/**
 * The manage-action capability map (DATA-keyed dispatch, L090). Store-backed rows
 * carry a `memberId`; a handler that needs one no-ops when it is absent (e.g. a static
 * template can be duplicated but not renamed/archived — its capabilities already gate
 * the UI, and this is the belt-and-braces guard). Adding a new manage action = one entry.
 */
export const ARRANGEMENT_LIBRARY_ACTIONS: Readonly<Record<string, ArrangementActionHandler>> = {
  rename: (graph, indexRef, row, input) =>
    row.memberId && input.name ? renameCollection(graph, indexRef, row.memberId, input.name) : graph,
  archive: (graph, indexRef, row) => (row.memberId ? archiveCollection(graph, indexRef, row.memberId) : graph),
  restore: (graph, indexRef, row) => (row.memberId ? restoreCollection(graph, indexRef, row.memberId) : graph),
  duplicate: (graph, indexRef, row, input) =>
    input.newMemberId && input.newCollectionId
      ? duplicateSavedArrangement(graph, indexRef, row, {
          memberId: input.newMemberId,
          collectionId: input.newCollectionId,
          name: input.name && input.name.trim() ? input.name : `Copy of ${row.label}`,
        })
      : graph,
};

/** True iff `action` is a store-manage action this controller handles (vs `apply`,
 *  which the board panel owns). Lets a caller route by data, not a hardcoded list. */
export function isLibraryManageAction(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(ARRANGEMENT_LIBRARY_ACTIONS, action);
}

/**
 * Dispatch a manage action through the capability map. Unknown / `apply` actions
 * return the graph unchanged (the caller handles `apply` against the live board). Pure.
 */
export function runArrangementLibraryAction(
  graph: GroupGraph,
  indexRef: AddressRef,
  action: string,
  row: SavedArrangement,
  input: ArrangementActionInput = {},
): GroupGraph {
  const handler = ARRANGEMENT_LIBRARY_ACTIONS[action];
  return handler ? handler(graph, indexRef, row, input) : graph;
}
