// packages/screen-arrangement/read-data/node-bookmark-types.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A node bookmark is a saved pointer to ANY addressed node — a tab, a container,
// the canvas, a layout — keyed by its NodeRef (== region AddressRef). The shape
// is kind-blind: it never names a node type. Bookmarks persist on the engine log
// as a LayoutState side-map (`LayoutState.nodeBookmarks`), written through the
// same `applyLayoutState` path proven durable for decoration + tab order. The
// generic `ui/BookmarksPanel` renders these; the surface owns NodeRef -> open.
//
// This is the user's EEAF/workflow-slot persistence mandate made structural:
// the bookmark is DATA on the log, not React component state.
// =============================================================================

import type { AddressRef } from '../../ui/show/visual-layer-stack';

export interface NodeBookmarkRecord {
  /** Stable bookmark id. Derived from the node address so bookmarking the same
   *  node twice updates the existing entry instead of duplicating it. */
  id: string;
  /** The addressed node this bookmark points to. Generic — any region family. */
  nodeRef: AddressRef;
  /** Human label shown in the list; defaults to the node's name at save time. */
  label: string;
  /** Folder grouping when present; absent = ungrouped. */
  folder?: string;
  /** Creation timestamp (ms since epoch) for stable ordering. */
  createdAt: number;
}

/** A well-formed bookmark record has an id, a NodeRef with a family, a label. */
export function isNodeBookmarkRecord(value: unknown): value is NodeBookmarkRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const nodeRef = record.nodeRef as Record<string, unknown> | undefined;
  return (
    typeof record.id === 'string' &&
    typeof record.label === 'string' &&
    !!nodeRef &&
    typeof nodeRef.family === 'string' &&
    typeof record.createdAt === 'number'
  );
}
