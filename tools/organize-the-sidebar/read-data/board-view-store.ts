// packages/group/read-data/board-view-store.ts
//
// Saved VIEWPORT views — a named camera bookmark ("jump to the Q3 cluster", "the whole roadmap") kept in the
// library beside collections and saved reports. The FOURTH consumer of the generic named-record-index (b181):
// a spec + thin wrappers, proving the store generalises across yet another record type at ~30 lines, not a
// copy of the fold.
//
// A saved view stores its camera at save time AND, optionally, the card ids it framed. On apply it PREFERS to
// re-frame those cards for the current board (via `frameCamera`, b182) so the bookmark still lands on the right
// content after cards move; if the cards are gone it falls back to the stored camera. So a view survives the
// board evolving under it. Fail-closed: a stored view with a non-finite camera is rejected. No I/O, no Date/
// random — the caller supplies `savedAt`.

import { type AddressRef, type GroupGraph } from '../../ui/show/group/group-graph';
import type { BoardItem } from './group-board-model.ts';
import type { Camera, Viewport } from './viewport-visibility.ts';
import { frameSelection } from './camera-frame.ts';
import {
  recordIndexRef,
  readRecords,
  readActiveRecords,
  readArchivedRecords,
  getRecord,
  saveRecord,
  renameRecord,
  archiveRecord,
  restoreRecord,
  type RecordStoreSpec,
  type StoredRecord,
} from './named-record-index.ts';

/** A saved viewport: the camera to restore, plus (when present) the card ids it framed so it can RE-FRAME the
 *  current board instead of trusting stale coordinates. */
export interface BoardView {
  readonly camera: Camera;
  readonly frameIds?: readonly string[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Strictly validate an unknown value as a BoardView; null on any violation (never throws). The camera's three
 *  numbers must be finite; `frameIds`, when present, must be an array of strings. */
export function parseBoardView(value: unknown): BoardView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const cam = o.camera as Record<string, unknown> | undefined;
  if (!cam || typeof cam !== 'object' || !isFiniteNumber(cam.panX) || !isFiniteNumber(cam.panY) || !isFiniteNumber(cam.zoom)) return null;
  if (o.frameIds !== undefined && (!Array.isArray(o.frameIds) || o.frameIds.some((f) => typeof f !== 'string'))) return null;
  const view: { camera: Camera; frameIds?: readonly string[] } = { camera: { panX: cam.panX, panY: cam.panY, zoom: cam.zoom } };
  if (o.frameIds !== undefined) view.frameIds = o.frameIds as readonly string[];
  return view;
}

const VIEW_SPEC: RecordStoreSpec<BoardView> = {
  indexFamily: 'group.view-index',
  nodeFamily: 'group.view',
  partKey: 'view',
  kind: 'view',
  parseRecord: parseBoardView,
  idOf: () => 'view',
  nameOf: () => 'View',
};

/** One saved view decoded from an index member. */
export interface StoredBoardView {
  readonly memberId: string;
  readonly viewId: string;
  readonly name: string;
  readonly archived: boolean;
  readonly view: BoardView;
  readonly savedAt?: number;
}

function toView(r: StoredRecord<BoardView>): StoredBoardView {
  return { memberId: r.memberId, viewId: r.recordId, name: r.name, archived: r.archived, view: r.record, ...(r.savedAt !== undefined ? { savedAt: r.savedAt } : {}) };
}

/** The view-index ref for a surface (default vision-board). Distinct family from collections/reports/boards. */
export function viewIndexRef(indexId = 'vision-board'): AddressRef {
  return recordIndexRef(VIEW_SPEC, indexId);
}

/** The one member that remembers where the camera was when the board was last looked at. It lives in the view index so a
 *  board carries its own viewport (Spatial's Canvas keeps xOffset/yOffset/magnification beside its items), but it is
 *  not a bookmark the person saved, so the library listings below leave it out. */
export const LAST_VIEW_MEMBER_ID = 'last-viewport';
const isLibraryView = (view: StoredBoardView): boolean => view.memberId !== LAST_VIEW_MEMBER_ID;

export function readViews(graph: GroupGraph, indexRef: AddressRef): StoredBoardView[] {
  return readRecords(graph, indexRef, VIEW_SPEC).map(toView).filter(isLibraryView);
}
export function readActiveViews(graph: GroupGraph, indexRef: AddressRef): StoredBoardView[] {
  return readActiveRecords(graph, indexRef, VIEW_SPEC).map(toView).filter(isLibraryView);
}
export function readArchivedViews(graph: GroupGraph, indexRef: AddressRef): StoredBoardView[] {
  return readArchivedRecords(graph, indexRef, VIEW_SPEC).map(toView).filter(isLibraryView);
}

/** Remember the camera the board was last looked at through (add-or-update; one per board). Fails closed: a camera
 *  with a non-finite number changes nothing. */
export function rememberLastCamera(graph: GroupGraph, indexRef: AddressRef, camera: Camera, savedAt?: number): GroupGraph {
  const view = parseBoardView({ camera });
  if (!view) return graph;
  return saveRecord(graph, indexRef, { memberId: LAST_VIEW_MEMBER_ID, recordId: LAST_VIEW_MEMBER_ID, name: 'Last viewed', record: view, savedAt }, VIEW_SPEC);
}

/** The camera the board was last looked at through, or undefined when it has never been remembered. */
export function readLastCamera(graph: GroupGraph, indexRef: AddressRef): Camera | undefined {
  return getRecord(graph, indexRef, LAST_VIEW_MEMBER_ID, VIEW_SPEC)?.record.camera;
}
export function getView(graph: GroupGraph, indexRef: AddressRef, memberId: string): StoredBoardView | undefined {
  const r = getRecord(graph, indexRef, memberId, VIEW_SPEC);
  return r ? toView(r) : undefined;
}

/** Save a viewport view into the library (add-or-update by memberId; preserves the archived flag). */
export function saveView(
  graph: GroupGraph,
  indexRef: AddressRef,
  args: { memberId: string; viewId: string; name: string; view: BoardView; savedAt?: number },
): GroupGraph {
  return saveRecord(graph, indexRef, { memberId: args.memberId, recordId: args.viewId, name: args.name, record: args.view, savedAt: args.savedAt }, VIEW_SPEC);
}

export function renameView(graph: GroupGraph, indexRef: AddressRef, memberId: string, name: string): GroupGraph {
  return renameRecord(graph, indexRef, memberId, name);
}
export function archiveView(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  return archiveRecord(graph, indexRef, memberId);
}
export function restoreView(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  return restoreRecord(graph, indexRef, memberId);
}

/**
 * The camera to apply for a saved view against the CURRENT board. When the view names the cards it framed AND
 * at least one is still present, re-frame them for the given viewport (so the bookmark tracks the content as it
 * moves); otherwise fall back to the stored camera. Pure.
 */
export function resolveViewCamera(view: BoardView, items: readonly BoardItem[], viewport: Viewport): Camera {
  if (view.frameIds && view.frameIds.length > 0) {
    const reframed = frameSelection(items, view.frameIds, viewport);
    if (reframed) return reframed;
  }
  return view.camera;
}
