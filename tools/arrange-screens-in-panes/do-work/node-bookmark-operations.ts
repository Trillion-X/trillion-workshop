// packages/screen-arrangement/do-work/node-bookmark-operations.ts
//
// Pure node-bookmark mutations over LayoutState, persisted via the generic
// `applyLayoutState` commit (the normalizer preserves `nodeBookmarks`, exactly
// as it preserves `visualLayerStacks`). No new layout action type, no slot
// command, no React-only state — a bookmark is DATA on the engine log.
//
// The bookmark id is the node's canonical region key, so bookmarking the same
// node twice UPDATES the existing entry instead of duplicating it (idempotent),
// and "is this node bookmarked?" / "remove this node's bookmark" are O(1).

import type { AddressRef } from '../../ui/show/visual-layer-stack'
import type { LayoutState } from '../read-data/layout-types'
import type { NodeBookmarkRecord } from '../read-data/node-bookmark-types'
import { regionAddressKey } from '../read-data/region-address'

/** The bookmark id for a node == its canonical region key (one bookmark / node). */
export function nodeBookmarkId(nodeRef: AddressRef): string {
  return regionAddressKey(nodeRef)
}

/** All bookmarks, oldest first (stable creation order). */
export function listNodeBookmarks(state: LayoutState): NodeBookmarkRecord[] {
  return Object.values(state.nodeBookmarks ?? {}).sort((a, b) => a.createdAt - b.createdAt)
}

/** Is this node currently bookmarked? */
export function isNodeBookmarked(state: LayoutState, nodeRef: AddressRef): boolean {
  return !!state.nodeBookmarks?.[nodeBookmarkId(nodeRef)]
}

/**
 * Upsert a bookmark for a node (idempotent on the node id). Preserves the
 * original createdAt when updating so list order is stable. Persists via the
 * generic applyLayoutState commit.
 */
export function addNodeBookmark(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  nodeRef: AddressRef,
  label: string,
  createdAt: number,
  folder?: string,
): void {
  const id = nodeBookmarkId(nodeRef)
  const prior = state.nodeBookmarks?.[id]
  const record: NodeBookmarkRecord = {
    id,
    nodeRef,
    label,
    createdAt: prior?.createdAt ?? createdAt,
    ...(folder ? { folder } : {}),
  }
  applyLayoutState({
    ...state,
    nodeBookmarks: { ...(state.nodeBookmarks ?? {}), [id]: record },
  })
}

/** Remove a bookmark by its id. No-op if absent. */
export function removeNodeBookmark(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  id: string,
): void {
  if (!state.nodeBookmarks?.[id]) return
  const next = { ...state.nodeBookmarks }
  delete next[id]
  applyLayoutState({ ...state, nodeBookmarks: next })
}
