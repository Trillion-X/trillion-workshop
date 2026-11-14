// packages/group/do-work/board-composition-gauntlet.test.ts
//
// #207 — L069 adversarial composition gauntlet. Individual features are each
// unit-tested; this proves they COMPOSE under a hostile multi-op sequence that
// no single test exercises: the NEWEST kind (#204 stamp) must ride the OLDER
// primitives — group-resize (scale the whole selection), connector preservation,
// frame-selection, and SVG export — for FREE, with the geometry invariants intact.
//
// The point of the gauntlet (CLAUDE.md L069): if any composition needed a
// special case, the primitives would not be truly generative. This test is the
// proof they are — a stamp is DATA the blind primitives never special-case.

import { describe, expect, it } from 'vitest';
import { boardToSvg } from './board-svg';
import {
  selectionBounds,
  anchorForHandle,
  scaleForHandleDrag,
  scaleRectsAroundAnchor,
} from './group-resize';
import { createFrameFromSelection } from './board-frames';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import {
  placeItem,
  readItems,
  boardRootRef,
  itemRef,
  itemIsConnector,
  type BoardItem,
} from '../read-data/group-board-model';

function item(partial: Partial<BoardItem> & { memberId: string }): BoardItem {
  return {
    nodeRef: { family: 'group.board-item', parts: { board: 'b', item: partial.memberId } },
    kind: 'note',
    x: 0,
    y: 0,
    w: 200,
    h: 140,
    isSection: false,
    childCount: 0,
    extra: {},
    ...partial,
  };
}

describe('#207 gauntlet — stamp (#204) × group-resize × connector × SVG export compose for free', () => {
  // A note + a stamp joined by a connector: the minimal hostile mix (new kind +
  // relationship edge + geometry transform + serializer).
  const note = item({ memberId: 'a', x: 100, y: 100, w: 200, h: 140, text: 'idea' });
  const stamp = item({ memberId: 's', x: 500, y: 100, w: 120, h: 120, kind: 'stamp', text: '🔥' });
  const connector = item({
    memberId: 'c',
    kind: 'connector',
    x: 0, y: 0, w: 0, h: 0,
    extra: { fromMemberId: 'a', toMemberId: 's' },
  });

  it('baseline export carries the stamp glyph AND the connector path', () => {
    const svg = boardToSvg([note, stamp, connector]);
    expect(svg).toContain('🔥');
    // #224: connectors export as a routed `<path fill="none" stroke=…>` (shapes use a
    // coloured fill), so `fill="none"` uniquely proves the connector edge rendered.
    expect(svg).toContain('fill="none"');
  });

  it('after a group-resize the stamp glyph + connector survive, anchor is fixed, layout stays proportional', () => {
    // Drawables only (connectors carry no rect — they follow their endpoints).
    const drawables = [note, stamp].filter((i) => !itemIsConnector(i));
    const rects = drawables.map((d) => ({ id: d.memberId, x: d.x, y: d.y, w: d.w, h: d.h }));
    const bounds = selectionBounds(rects)!;
    expect(bounds).toBeTruthy();

    // Hostile drag: grab the SE handle and pull out by a full bounds worth →
    // the whole selection roughly doubles. Anchor is the opposite (NW) corner.
    const { sx, sy } = scaleForHandleDrag(bounds, 'se', bounds.w, bounds.h);
    expect(sx).toBeGreaterThan(1);
    expect(sy).toBeGreaterThan(1);
    const anchor = anchorForHandle(bounds, 'se');
    // The NW-most item sits exactly at the anchor → it must not move.
    expect(anchor.x).toBe(bounds.x);
    expect(anchor.y).toBe(bounds.y);

    const scaled = scaleRectsAroundAnchor(rects, anchor, sx, sy, 1, 1);
    const byId = new Map(scaled.map((r) => [r.id, r]));

    // Rebuild the board with the scaled geometry; kind/text/extra untouched.
    const resized: BoardItem[] = [note, stamp].map((d) => {
      const r = byId.get(d.memberId)!;
      return { ...d, x: r.x, y: r.y, w: r.w, h: r.h };
    });
    const svg = boardToSvg([...resized, connector]);

    // 1. The new kind's glyph rode the transform for free.
    expect(svg).toContain('🔥');
    // 2. The relationship edge still renders (endpoints resolve to the moved items).
    //    #224: connector exports as a routed `<path fill="none" …>`.
    expect(svg).toContain('fill="none"');
    // 3. Anchor invariance — the NW item's top-left did not move.
    const a2 = byId.get('a')!;
    expect(a2.x).toBe(anchor.x);
    expect(a2.y).toBe(anchor.y);
    // 4. Proportional layout — the note→stamp gap scaled by sx (within rounding).
    const s2 = byId.get('s')!;
    const originalGap = stamp.x - note.x; // 400
    expect(Math.abs((s2.x - a2.x) - originalGap * sx)).toBeLessThanOrEqual(2);
    // 5. Sizes grew with the group.
    expect(a2.w).toBeGreaterThan(note.w);
    expect(s2.w).toBeGreaterThan(stamp.w);
  });
});

describe('#207 gauntlet — the newest kind composes with frame-selection', () => {
  it('a stamp can be enclosed by a frame-selection; the frame bounds it and the glyph survives', () => {
    const board = boardRootRef('board-A');
    let g = emptyGraph();
    g = placeItem(g, board, { memberId: 'n', nodeRef: itemRef('board-A', 'n'), kind: 'note', x: 0, y: 0, w: 200, h: 140, text: 'idea' });
    g = placeItem(g, board, { memberId: 'st', nodeRef: itemRef('board-A', 'st'), kind: 'stamp', x: 400, y: 300, w: 120, h: 120, text: '🔥' });

    const PAD = 48;
    g = createFrameFromSelection(g, board, ['n', 'st'], {
      memberId: 'f1', nodeRef: itemRef('board-A', 'f1'), title: 'My frame', padding: PAD, order: 0,
    });

    const items = readItems(g, board);
    const frame = items.find((i) => i.kind === 'frame');
    expect(frame).toBeDefined();
    // The frame encloses BOTH items with the padding on every side.
    expect(frame!.x).toBe(0 - PAD);
    expect(frame!.y).toBe(0 - PAD);
    expect(frame!.x + frame!.w).toBe(520 + PAD); // stamp right edge (400+120) + pad
    expect(frame!.y + frame!.h).toBe(420 + PAD); // stamp bottom edge (300+120) + pad
    // The stamp still carries its glyph after being framed (blind — frame never
    // touches item content).
    const st = items.find((i) => i.kind === 'stamp');
    expect(st!.text).toBe('🔥');
    // Export the framed board → glyph present, frame rect present.
    const svg = boardToSvg(items);
    expect(svg).toContain('🔥');
    expect(svg).toContain('<rect');
  });
});
