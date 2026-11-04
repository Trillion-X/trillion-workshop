// packages/screen-arrangement/read-data/node-history-types.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Per-node navigation history. A node that exposes a navigable sequence (a pane
// and the tabs it has shown; a web frame and its URLs) records each visited ref
// with a cursor; back/forward move the cursor. Kind-blind — the record carries
// the node's AddressRef and opaque string refs; this file names no node type.
//
// Persisted on the engine log as a LayoutState side-map (`LayoutState.nodeHistory`)
// via the proven applyLayoutState path, and carried across slot ops by
// CLIENT_OWNED_LAYOUT_FIELDS. The surface decides what a `ref` means and how to
// re-project it (L098): for a pane, ref = tabId, re-project = activateTab.
// =============================================================================

import type { AddressRef } from '../../ui/show/visual-layer-stack';

export interface NodeHistoryEntry {
  /** Opaque ref the surface knows how to re-open (e.g. a tabId, a URL). */
  ref: string;
  /** Human label for the entry (e.g. the tab title). */
  label: string;
  /** Visit timestamp (ms since epoch). */
  ts: number;
}

export interface NodeHistoryRecord {
  /** The node whose history this is. Generic — any region family. */
  nodeRef: AddressRef;
  /** Ordered visited refs, oldest first. */
  entries: NodeHistoryEntry[];
  /** Index into `entries` of the currently-shown ref. -1 when empty. */
  cursor: number;
}

/** A well-formed history record: a NodeRef family, an entries array, a cursor. */
export function isNodeHistoryRecord(value: unknown): value is NodeHistoryRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const nodeRef = record.nodeRef as Record<string, unknown> | undefined;
  return (
    !!nodeRef &&
    typeof nodeRef.family === 'string' &&
    Array.isArray(record.entries) &&
    typeof record.cursor === 'number' &&
    (record.entries as unknown[]).every(
      (e) =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as Record<string, unknown>).ref === 'string' &&
        typeof (e as Record<string, unknown>).label === 'string',
    )
  );
}
