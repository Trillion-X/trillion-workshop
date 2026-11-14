// packages/group/read-data/board-view-store.test.ts
//
// Proves b183's saved-viewport store (the fourth consumer of the generic named-record-index): fail-closed
// parse, save → read round-trip, resolveViewCamera (re-frames the named cards for the current board, falls
// back to the stored camera when they're gone or absent), rename/archive/restore, and isolation from the
// collection + report stores.

import { describe, it, expect } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { BoardItem } from './group-board-model';
import type { Camera, Viewport } from './viewport-visibility';
import { frameSelection } from './camera-frame';
import {
  viewIndexRef, saveView, readActiveViews, readArchivedViews, getView, renameView, archiveView, restoreView,
  parseBoardView, resolveViewCamera, type BoardView,
} from './board-view-store';
import { readActiveCollections, collectionIndexRef } from './collection-store';

const INDEX = viewIndexRef();
const cam = (panX: number, panY: number, zoom: number): Camera => ({ panX, panY, zoom });
const card = (memberId: string, x: number, y: number): BoardItem =>
  ({ memberId, kind: 'note', x, y, w: 100, h: 80, text: memberId, extra: {}, isSection: false } as unknown as BoardItem);
const viewport: Viewport = { w: 400, h: 300 };
const board = [card('a', 0, 0), card('b', 2000, 1500), card('c', 2200, 1500)];

describe('parseBoardView — fail-closed', () => {
  it('needs a finite camera; frameIds must be a string array; drops nothing valid', () => {
    expect(parseBoardView({ camera: cam(10, 20, 1.5) })).toEqual({ camera: { panX: 10, panY: 20, zoom: 1.5 } });
    expect(parseBoardView({ camera: cam(0, 0, 1), frameIds: ['b', 'c'] })).toEqual({ camera: { panX: 0, panY: 0, zoom: 1 }, frameIds: ['b', 'c'] });
    expect(parseBoardView({ camera: { panX: 0, panY: 0, zoom: Infinity } })).toBeNull();
    expect(parseBoardView({ camera: { panX: 0, panY: 0 } })).toBeNull(); // missing zoom
    expect(parseBoardView({ frameIds: ['a'] })).toBeNull(); // no camera
    expect(parseBoardView({ camera: cam(0, 0, 1), frameIds: [1, 2] })).toBeNull(); // non-string ids
    expect(parseBoardView(null)).toBeNull();
  });
});

describe('saved-view store — save → read → resolve', () => {
  it('round-trips a view and reads it back', () => {
    const view: BoardView = { camera: cam(5, 6, 0.5), frameIds: ['b', 'c'] };
    const g = saveView(emptyGraph(), INDEX, { memberId: 'm1', viewId: 'v1', name: 'BC cluster', view });
    const active = readActiveViews(g, INDEX);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ memberId: 'm1', viewId: 'v1', name: 'BC cluster', archived: false });
    expect(active[0].view).toEqual(view);
  });

  it('resolveViewCamera RE-FRAMES the named cards for the current board (tracks content as it moves)', () => {
    const view: BoardView = { camera: cam(0, 0, 1) /* stale */, frameIds: ['b', 'c'] };
    const resolved = resolveViewCamera(view, board, viewport);
    // equals freshly framing b+c — NOT the stale stored camera
    expect(resolved).toEqual(frameSelection(board, ['b', 'c'], viewport));
    expect(resolved).not.toEqual(view.camera);
  });

  it('falls back to the stored camera when frameIds are absent or none remain on the board', () => {
    expect(resolveViewCamera({ camera: cam(9, 9, 2) }, board, viewport)).toEqual(cam(9, 9, 2)); // no frameIds
    expect(resolveViewCamera({ camera: cam(9, 9, 2), frameIds: ['ghost'] }, board, viewport)).toEqual(cam(9, 9, 2)); // cards gone
  });

  it('rename / archive / restore behave like any named record', () => {
    let g = saveView(emptyGraph(), INDEX, { memberId: 'm1', viewId: 'v1', name: 'A', view: { camera: cam(0, 0, 1) } });
    g = renameView(g, INDEX, 'm1', 'Renamed');
    expect(getView(g, INDEX, 'm1')?.name).toBe('Renamed');
    g = archiveView(g, INDEX, 'm1');
    expect(readActiveViews(g, INDEX)).toHaveLength(0);
    expect(readArchivedViews(g, INDEX).map((v) => v.name)).toEqual(['Renamed']);
    g = restoreView(g, INDEX, 'm1');
    expect(readActiveViews(g, INDEX)).toHaveLength(1);
  });

  it('views are isolated from collections (different index family)', () => {
    const g = saveView(emptyGraph(), INDEX, { memberId: 'm1', viewId: 'v1', name: 'V', view: { camera: cam(0, 0, 1) } });
    expect(readActiveCollections(g, collectionIndexRef())).toHaveLength(0);
    expect(readActiveViews(g, INDEX)).toHaveLength(1);
  });
});
