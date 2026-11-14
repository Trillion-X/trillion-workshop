// packages/group/do-work/board-frames.test.ts
//
// Pure proof for the Presentable Frames model (#169). Drives the REAL transforms at the
// graph level: place items, frame a selection, read the frames back in order. L062 guard —
// if any link drifts (predicate, sort, union math) this fails deterministically, no studio.

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems } from '../read-data/group-board-model';
import {
  presentationFrameOf,
  boardFrames,
  nextFrameOrder,
  appendCopiedFrameOrders,
  frameRect,
  createFrameFromSelection,
  clampFrameIndex,
  presentStep,
  itemsInsideFrame,
  withFrameContents,
  tidyFrameLayout,
  moveFrameOrder,
  frameLinkTarget,
  presentationCaptionOf,
  resizeToAspect,
  frameFitBox,
} from './board-frames';

const B = boardRootRef('bd');
const nodeRef = (id: string) => itemRef('bd', id);

function withNotes(specs: Array<{ m: string; x: number; y: number; w?: number; h?: number }>) {
  let g = emptyGraph();
  for (const s of specs) {
    g = placeItem(g, B, { memberId: s.m, nodeRef: nodeRef('n-' + s.m), kind: 'note', x: s.x, y: s.y, w: s.w ?? 100, h: s.h ?? 80, text: s.m });
  }
  return g;
}

describe('presentationFrameOf — the ONE frame predicate (shape-based, L090)', () => {
  const item = (extra?: Record<string, unknown>) =>
    ({ memberId: 'm', kind: 'frame', x: 0, y: 0, w: 1, h: 1, ...(extra ? { extra } : {}) } as unknown as Parameters<typeof presentationFrameOf>[0]);

  it('reads { order } when extra.presentationFrame has a numeric order', () => {
    expect(presentationFrameOf(item({ presentationFrame: { order: 3 } }))).toEqual({ order: 3 });
    expect(presentationFrameOf(item({ presentationFrame: { order: 0 } }))).toEqual({ order: 0 });
  });

  it('is null for non-frames and malformed facets (never a kind literal)', () => {
    expect(presentationFrameOf(item())).toBeNull(); // a note-shaped item with no facet
    expect(presentationFrameOf(item({}))).toBeNull();
    expect(presentationFrameOf(item({ presentationFrame: {} }))).toBeNull(); // no order
    expect(presentationFrameOf(item({ presentationFrame: { order: 'x' } }))).toBeNull(); // non-number
    expect(presentationFrameOf(item({ presentationFrame: null }))).toBeNull();
  });

  it('normalizes a non-finite order to a finite 0 — a NaN order must not poison the sort (cont.98 batch-9)', () => {
    // The frame IS a presentation frame (has the marker); only its order is malformed. A NaN/Infinity
    // order would make the boardFrames comparator return NaN → a non-transitive sort. Default to 0.
    expect(presentationFrameOf(item({ presentationFrame: { order: NaN } }))).toEqual({ order: 0 });
    expect(presentationFrameOf(item({ presentationFrame: { order: Infinity } }))).toEqual({ order: 0 });
    expect(presentationFrameOf(item({ presentationFrame: { order: -Infinity } }))).toEqual({ order: 0 });
  });
});

describe('boardFrames — the story path, order asc + stable', () => {
  it('returns only frames, sorted by order; notes excluded', () => {
    let g = withNotes([{ m: 'a', x: 0, y: 0 }, { m: 'b', x: 200, y: 0 }]);
    g = placeItem(g, B, { memberId: 'f2', nodeRef: nodeRef('n-f2'), kind: 'frame', x: 0, y: 0, w: 300, h: 300, text: 'Two', extra: { presentationFrame: { order: 2 } } });
    g = placeItem(g, B, { memberId: 'f1', nodeRef: nodeRef('n-f1'), kind: 'frame', x: 0, y: 0, w: 300, h: 300, text: 'One', extra: { presentationFrame: { order: 1 } } });
    const frames = boardFrames(readItems(g, B));
    expect(frames.map((f) => f.memberId)).toEqual(['f1', 'f2']); // sorted by order, notes gone
  });

  it('empty board → no frames', () => {
    expect(boardFrames(readItems(withNotes([{ m: 'a', x: 0, y: 0 }]), B))).toEqual([]);
  });
});

describe('nextFrameOrder — append to the end of the path', () => {
  it('0 when no frames, else max+1', () => {
    let g = withNotes([{ m: 'a', x: 0, y: 0 }]);
    expect(nextFrameOrder(readItems(g, B))).toBe(0);
    g = placeItem(g, B, { memberId: 'f5', nodeRef: nodeRef('n-f5'), kind: 'frame', x: 0, y: 0, w: 10, h: 10, extra: { presentationFrame: { order: 5 } } });
    expect(nextFrameOrder(readItems(g, B))).toBe(6);
  });
});

it('duplicates and pasted frames keep their source sequence after existing slides', () => {
  let g = emptyGraph();
  g = placeItem(g, B, { memberId: 'existing', nodeRef: nodeRef('existing'), kind: 'frame', x: 0, y: 0, w: 10, h: 10, extra: { presentationFrame: { order: 4 } } });
  const drafts = [
    { kind: 'frame', extra: { presentationFrame: { order: 2, aspect: 'square' } } },
    { kind: 'note', extra: { color: 'red' } },
    { kind: 'frame', extra: { presentationFrame: { order: 0 } } },
  ];
  const placed = appendCopiedFrameOrders(drafts, readItems(g, B));
  expect((placed[2].extra.presentationFrame as { order: number }).order).toBe(5);
  expect((placed[0].extra.presentationFrame as { order: number; aspect: string })).toEqual({ order: 6, aspect: 'square' });
  expect(placed[1].extra).toEqual({ color: 'red' });
  expect(drafts[0].extra.presentationFrame.order).toBe(2);
});

describe('createFrameFromSelection — union + padding, connectors excluded', () => {
  it('bounds the selected notes, expanded by padding, as a kind:frame with the injected order', () => {
    const g = withNotes([
      { m: 'a', x: 100, y: 100, w: 100, h: 100 }, // rect 100..200
      { m: 'b', x: 400, y: 300, w: 100, h: 100 }, // rect 400..500 / 300..400
      { m: 'c', x: 9000, y: 9000 }, // NOT selected — must not affect bounds
    ]);
    const out = createFrameFromSelection(g, B, ['a', 'b'], { memberId: 'F', nodeRef: nodeRef('n-F'), title: 'Chapter 1', padding: 20, order: 0 });
    const frame = readItems(out, B).find((i) => i.memberId === 'F')!;
    expect(frame.kind).toBe('frame');
    expect(presentationFrameOf(frame)).toEqual({ order: 0 });
    expect(frame.text).toBe('Chapter 1');
    // union of a(100..200,100..200) + b(400..500,300..400) = {100,100,400,300}, minus/plus padding 20.
    expect(frameRect(frame)).toEqual({ x: 80, y: 80, w: 440, h: 340 });
  });

  it('excludes connectors from the bounds (a connector has no meaningful rect)', () => {
    let g = withNotes([{ m: 'a', x: 100, y: 100, w: 100, h: 100 }]);
    // a connector member (extra.from/toMemberId) placed far away — must be ignored by the union.
    g = placeItem(g, B, { memberId: 'k', nodeRef: nodeRef('n-k'), kind: 'connector', x: 5000, y: 5000, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'a' } });
    const out = createFrameFromSelection(g, B, ['a', 'k'], { memberId: 'F', nodeRef: nodeRef('n-F'), title: 'F', padding: 0, order: 0 });
    expect(frameRect(readItems(out, B).find((i) => i.memberId === 'F')!)).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });

  it('a selection with no non-connector items → graph UNCHANGED (nothing to bound)', () => {
    const g = withNotes([{ m: 'a', x: 0, y: 0 }]);
    const out = createFrameFromSelection(g, B, [], { memberId: 'F', nodeRef: nodeRef('n-F'), title: 'F', padding: 10, order: 0 });
    expect(out).toBe(g);
    expect(boardFrames(readItems(out, B))).toEqual([]);
  });
});

describe('present navigation — clamped, no wrap (a story path has a first + last)', () => {
  it('clampFrameIndex keeps the index in [0, count-1]', () => {
    expect(clampFrameIndex(3, -2)).toBe(0);
    expect(clampFrameIndex(3, 0)).toBe(0);
    expect(clampFrameIndex(3, 2)).toBe(2);
    expect(clampFrameIndex(3, 5)).toBe(2);
    expect(clampFrameIndex(0, 3)).toBe(0); // no frames → 0
  });

  it('presentStep advances/retreats and clamps at both ends (Next on last stays, Prev on first stays)', () => {
    expect(presentStep(4, 0, +1)).toBe(1);
    expect(presentStep(4, 3, +1)).toBe(3); // Next on last → stays
    expect(presentStep(4, 2, -1)).toBe(1);
    expect(presentStep(4, 0, -1)).toBe(0); // Prev on first → stays
    expect(presentStep(0, 0, +1)).toBe(0); // empty deck
  });
});

describe('itemsInsideFrame — the frame\'s spatial contents (#170, FigJam section-select)', () => {
  const frame = { memberId: 'F', kind: 'frame', x: 100, y: 100, w: 400, h: 300, extra: { presentationFrame: { order: 0 } } } as unknown as Parameters<typeof itemsInsideFrame>[1];

  it('returns items whose CENTRE is inside the frame rect; excludes outside items, the frame, connectors, and other frames', () => {
    let g = withNotes([
      { m: 'in1', x: 150, y: 150, w: 100, h: 80 }, // centre 200,190 — inside
      { m: 'in2', x: 380, y: 320, w: 100, h: 60 }, // centre 430,350 — inside
      { m: 'out', x: 600, y: 150, w: 100, h: 80 }, // centre 650,190 — outside (x>500)
      { m: 'edge', x: 460, y: 150, w: 100, h: 80 }, // centre 510,190 — outside (x>500)
    ]);
    g = placeItem(g, B, { memberId: 'F', nodeRef: nodeRef('n-F'), kind: 'frame', x: 100, y: 100, w: 400, h: 300, extra: { presentationFrame: { order: 0 } } });
    g = placeItem(g, B, { memberId: 'F2', nodeRef: nodeRef('n-F2'), kind: 'frame', x: 150, y: 150, w: 50, h: 50, extra: { presentationFrame: { order: 1 } } }); // nested frame — excluded
    g = placeItem(g, B, { memberId: 'k', nodeRef: nodeRef('n-k'), kind: 'connector', x: 200, y: 200, w: 0, h: 0, extra: { fromMemberId: 'in1', toMemberId: 'in2' } }); // connector — excluded
    const all = readItems(g, B);
    const f = all.find((i) => i.memberId === 'F')!;
    expect(itemsInsideFrame(all, f).map((i) => i.memberId).sort()).toEqual(['in1', 'in2']);
  });

  it('empty when nothing is inside', () => {
    const g = withNotes([{ m: 'far', x: 9000, y: 9000 }]);
    expect(itemsInsideFrame(readItems(g, B), frame)).toEqual([]);
  });
});

describe('withFrameContents — dragging a frame carries its contents (#172, FigJam section-move)', () => {
  function scene() {
    let g = withNotes([
      { m: 'in1', x: 150, y: 150, w: 100, h: 80 }, // centre 200,190 — inside F
      { m: 'in2', x: 380, y: 320, w: 100, h: 60 }, // centre 430,350 — inside F
      { m: 'out', x: 600, y: 150, w: 100, h: 80 }, // centre 650,190 — outside F
    ]);
    g = placeItem(g, B, { memberId: 'F', nodeRef: nodeRef('n-F'), kind: 'frame', x: 100, y: 100, w: 400, h: 300, extra: { presentationFrame: { order: 0 } } });
    g = placeItem(g, B, { memberId: 'k', nodeRef: nodeRef('n-k'), kind: 'connector', x: 200, y: 200, w: 0, h: 0, extra: { fromMemberId: 'in1', toMemberId: 'in2' } });
    return readItems(g, B);
  }

  it('a base set containing a frame widens to include the frame + its inside items (connectors excluded)', () => {
    const all = scene();
    const out = [...withFrameContents(all, new Set(['F']))].sort();
    expect(out).toEqual(['F', 'in1', 'in2']); // 'out' stays put, connector 'k' auto-follows (excluded)
  });

  it('is a pass-through no-op when the base set has no frame (plain multi-drag)', () => {
    const all = scene();
    expect([...withFrameContents(all, new Set(['in1', 'out']))].sort()).toEqual(['in1', 'out']);
  });

  it('unions contents across multiple dragged frames without duplication', () => {
    let g = withNotes([
      { m: 'a', x: 150, y: 150 }, // inside F1
      { m: 'b', x: 750, y: 150 }, // inside F2
    ]);
    g = placeItem(g, B, { memberId: 'F1', nodeRef: nodeRef('n-F1'), kind: 'frame', x: 100, y: 100, w: 300, h: 300, extra: { presentationFrame: { order: 0 } } });
    g = placeItem(g, B, { memberId: 'F2', nodeRef: nodeRef('n-F2'), kind: 'frame', x: 700, y: 100, w: 300, h: 300, extra: { presentationFrame: { order: 1 } } });
    const all = readItems(g, B);
    expect([...withFrameContents(all, new Set(['F1', 'F2']))].sort()).toEqual(['F1', 'F2', 'a', 'b']);
  });
});

describe('tidyFrameLayout — arrange a frame\'s contents into an even grid (#173)', () => {
  const bi = (o: Record<string, unknown>) => o as unknown as Parameters<typeof tidyFrameLayout>[0][number];
  const frame = { memberId: 'F', kind: 'frame', x: 100, y: 100, w: 400, h: 400, extra: { presentationFrame: { order: 0 } } } as unknown as Parameters<typeof tidyFrameLayout>[1];

  it('lays scattered items into a padded grid in reading order, centred in cells', () => {
    // Given three same-size items scattered → sorted by (y,x): a(110,110), b(260,110), c(300,300).
    const contents = [
      bi({ memberId: 'c', x: 300, y: 300, w: 80, h: 60 }),
      bi({ memberId: 'a', x: 110, y: 110, w: 80, h: 60 }),
      bi({ memberId: 'b', x: 260, y: 110, w: 80, h: 60 }),
    ];
    const pos = tidyFrameLayout(contents, frame, { pad: 20, gap: 10, titleInset: 40 });
    // cellW=80,cellH=60; usableW=400-40=360; cols=min(3, floor(370/90)=4)=3; origin (120,140).
    expect(pos.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(pos[0]).toEqual({ id: 'a', x: 120, y: 140 });
    expect(pos[1]).toEqual({ id: 'b', x: 210, y: 140 });
    expect(pos[2]).toEqual({ id: 'c', x: 300, y: 140 });
  });

  it('wraps to a new row when the frame is too narrow (cols clamps to 1)', () => {
    const narrow = { ...(frame as object), w: 140 } as unknown as Parameters<typeof tidyFrameLayout>[1];
    const contents = [bi({ memberId: 'a', x: 0, y: 0, w: 80, h: 60 }), bi({ memberId: 'b', x: 0, y: 10, w: 80, h: 60 })];
    const pos = tidyFrameLayout(contents, narrow, { pad: 20, gap: 10, titleInset: 40 });
    expect(pos[0].x).toBe(pos[1].x); // one column
    expect(pos[1].y).toBe(pos[0].y + 60 + 10); // next row = cellH + gap below
  });

  it('centres a smaller item within a uniform cell sized to the largest', () => {
    const contents = [bi({ memberId: 'big', x: 0, y: 0, w: 100, h: 40 }), bi({ memberId: 'sm', x: 0, y: 100, w: 40, h: 40 })];
    // narrow frame → 1 col; cellW=100. 'sm' (w40) centred: offset (100-40)/2 = 30.
    const narrow = { ...(frame as object), w: 150 } as unknown as Parameters<typeof tidyFrameLayout>[1];
    const pos = tidyFrameLayout(contents, narrow, { pad: 20, gap: 10, titleInset: 40 });
    expect(pos[0].x).toBe(120); // big fills its cell
    expect(pos[1].x).toBe(120 + 30); // small centred
  });

  it('empty contents → empty', () => {
    expect(tidyFrameLayout([], frame)).toEqual([]);
  });

  // cont.98 batch-27 red-team: cell sizing uses reduce (maxOf) + finiteCoord, never Math.max(...spread).
  it('does not RangeError on a very large content set (reduce, not Math.max spread)', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => bi({ memberId: 'c' + i, x: i, y: 0, w: 10, h: 10 }));
    expect(() => tidyFrameLayout(many, frame)).not.toThrow();
  });

  it('clamps a Number.MAX_VALUE content dimension to finite grid positions (no Infinity/NaN)', () => {
    const contents = [bi({ memberId: 'a', x: 0, y: 0, w: Number.MAX_VALUE, h: 50 }), bi({ memberId: 'b', x: 0, y: 100, w: 40, h: 40 })];
    const pos = tidyFrameLayout(contents, frame, { pad: 20, gap: 10, titleInset: 40 });
    for (const p of pos) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('moveFrameOrder — reorder the present path (#174)', () => {
  // Three frames placed OUT of order-index sequence, with SPARSE orders.
  function frames() {
    let g = emptyGraph();
    g = placeItem(g, B, { memberId: 'a', nodeRef: nodeRef('n-a'), kind: 'frame', x: 0, y: 0, w: 10, h: 10, extra: { presentationFrame: { order: 0 } } });
    g = placeItem(g, B, { memberId: 'b', nodeRef: nodeRef('n-b'), kind: 'frame', x: 0, y: 0, w: 10, h: 10, extra: { presentationFrame: { order: 5 } } });
    g = placeItem(g, B, { memberId: 'c', nodeRef: nodeRef('n-c'), kind: 'frame', x: 0, y: 0, w: 10, h: 10, extra: { presentationFrame: { order: 9 } } });
    return readItems(g, B);
  }

  it('moving the middle frame earlier swaps it with its predecessor and renumbers 0..n-1', () => {
    // order a,b,c → move b earlier → b,a,c contiguously renumbered.
    expect(moveFrameOrder(frames(), 'b', -1)).toEqual([
      { id: 'b', order: 0 },
      { id: 'a', order: 1 },
      { id: 'c', order: 2 },
    ]);
  });

  it('moving a frame later swaps it with its successor', () => {
    expect(moveFrameOrder(frames(), 'a', 1)).toEqual([
      { id: 'b', order: 0 },
      { id: 'a', order: 1 },
      { id: 'c', order: 2 },
    ]);
  });

  it('is a no-op at the boundary (first cannot move earlier, last cannot move later)', () => {
    expect(moveFrameOrder(frames(), 'a', -1)).toEqual([]);
    expect(moveFrameOrder(frames(), 'c', 1)).toEqual([]);
  });

  it('unknown frame id → no-op', () => {
    expect(moveFrameOrder(frames(), 'zzz', 1)).toEqual([]);
  });
});

describe('frameLinkTarget — present-mode follows a frame→frame connector (#175)', () => {
  function scene(link?: { from: string; to: string }) {
    let g = emptyGraph();
    g = placeItem(g, B, { memberId: 'a', nodeRef: nodeRef('n-a'), kind: 'frame', x: 0, y: 0, w: 10, h: 10, extra: { presentationFrame: { order: 0 } } });
    g = placeItem(g, B, { memberId: 'b', nodeRef: nodeRef('n-b'), kind: 'frame', x: 0, y: 0, w: 10, h: 10, extra: { presentationFrame: { order: 1 } } });
    g = placeItem(g, B, { memberId: 'c', nodeRef: nodeRef('n-c'), kind: 'frame', x: 0, y: 0, w: 10, h: 10, extra: { presentationFrame: { order: 2 } } });
    g = placeItem(g, B, { memberId: 'note', nodeRef: nodeRef('n-note'), kind: 'note', x: 0, y: 0, w: 10, h: 10, text: 'n' });
    if (link) g = placeItem(g, B, { memberId: 'k', nodeRef: nodeRef('n-k'), kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: link.from, toMemberId: link.to } });
    return readItems(g, B);
  }

  it('returns the linked frame index when the current frame links forward to another frame', () => {
    const all = scene({ from: 'a', to: 'c' });
    const frames = boardFrames(all); // order-sorted a,b,c
    expect(frameLinkTarget(frames, all, 0)).toBe(2); // a → c (index 2), skipping b
  });

  it('a link can jump BACKWARD too (prototype loops are the user\'s design)', () => {
    const all = scene({ from: 'c', to: 'a' });
    const frames = boardFrames(all);
    expect(frameLinkTarget(frames, all, 2)).toBe(0); // c → a
  });

  it('null when the current frame has no outgoing frame link (advance stays sequential)', () => {
    const all = scene({ from: 'a', to: 'c' });
    const frames = boardFrames(all);
    expect(frameLinkTarget(frames, all, 1)).toBeNull(); // b has no link
  });

  it('ignores a connector whose target is NOT a frame', () => {
    const all = scene({ from: 'a', to: 'note' });
    const frames = boardFrames(all);
    expect(frameLinkTarget(frames, all, 0)).toBeNull();
  });
});

describe('presentationCaptionOf — a frame\'s speaker-note (#176)', () => {
  const item = (extra?: Record<string, unknown>) =>
    ({ memberId: 'm', kind: 'frame', x: 0, y: 0, w: 1, h: 1, ...(extra ? { extra } : {}) } as unknown as Parameters<typeof presentationCaptionOf>[0]);

  it('returns the trimmed caption string when extra.frameCaption is non-blank', () => {
    expect(presentationCaptionOf(item({ frameCaption: 'Open with the vision' }))).toBe('Open with the vision');
    expect(presentationCaptionOf(item({ frameCaption: '  padded  ' }))).toBe('padded');
  });

  it('is null when absent, blank, or non-string', () => {
    expect(presentationCaptionOf(item())).toBeNull();
    expect(presentationCaptionOf(item({ frameCaption: '   ' }))).toBeNull();
    expect(presentationCaptionOf(item({ frameCaption: 42 }))).toBeNull();
  });
});

describe('resizeToAspect — reshape a frame into a slide/print canvas (#177)', () => {
  it('keeps the width and conforms the height to the ratio (16:9)', () => {
    expect(resizeToAspect({ w: 1600, h: 500 }, 16, 9)).toEqual({ w: 1600, h: 900 });
  });

  it('makes a perfect square for 1:1 (height = width)', () => {
    expect(resizeToAspect({ w: 720, h: 1234 }, 1, 1)).toEqual({ w: 720, h: 720 });
  });

  it('supports a portrait ratio taller than wide (9:16 story)', () => {
    expect(resizeToAspect({ w: 900, h: 100 }, 9, 16)).toEqual({ w: 900, h: 1600 });
  });

  it('rounds the height for a non-integer result (4:3)', () => {
    // 1000 * 3 / 4 = 750 exactly; 1001 * 3 / 4 = 750.75 → 751
    expect(resizeToAspect({ w: 1000, h: 10 }, 4, 3)).toEqual({ w: 1000, h: 750 });
    expect(resizeToAspect({ w: 1001, h: 10 }, 4, 3)).toEqual({ w: 1001, h: 751 });
  });

  it('handles an A4 print ratio (210:297 portrait)', () => {
    // 420 * 297 / 210 = 594
    expect(resizeToAspect({ w: 420, h: 10 }, 210, 297)).toEqual({ w: 420, h: 594 });
  });

  it('fail-closes to the original box on a non-positive ratio or width (never NaN/0)', () => {
    expect(resizeToAspect({ w: 800, h: 450 }, 0, 9)).toEqual({ w: 800, h: 450 });
    expect(resizeToAspect({ w: 800, h: 450 }, 16, -1)).toEqual({ w: 800, h: 450 });
    expect(resizeToAspect({ w: 0, h: 450 }, 16, 9)).toEqual({ w: 0, h: 450 });
  });

  it('floors the height at 1px so a frame is never a zero-height region', () => {
    // width 1, ratio 1:1000 → 0.001 rounds to 0 → clamped to 1
    expect(resizeToAspect({ w: 1, h: 5 }, 1000, 1)).toEqual({ w: 1, h: 1 });
  });
});

describe('frameFitBox — resize a frame to snugly bound its contents (#178)', () => {
  type Item = Parameters<typeof frameFitBox>[0][number];
  const mk = (m: string, x: number, y: number, w: number, h: number, extra?: Record<string, unknown>) =>
    ({ memberId: m, kind: 'note', x, y, w, h, ...(extra ? { extra } : {}) } as unknown as Item);
  const frame = mk('F', 0, 0, 1000, 1000, { presentationFrame: { order: 0 } });

  it('returns the union of the contents expanded by padding (top-left hugs inward)', () => {
    const items = [frame, mk('a', 100, 100, 50, 50), mk('b', 800, 800, 40, 40)];
    // union: x 100..840, y 100..840 → w/h 740; padding 24 → x/y 76, w/h 788
    expect(frameFitBox(items, frame, 24)).toEqual({ x: 76, y: 76, w: 788, h: 788 });
  });

  it('ignores connectors and nested frames, counting only spatial note/media contents', () => {
    const items = [
      frame,
      mk('a', 100, 100, 50, 50),
      mk('conn', 0, 0, 10, 10, { fromMemberId: 'a', toMemberId: 'F' }), // connector → excluded
      mk('inner', 200, 200, 30, 30, { presentationFrame: { order: 1 } }), // nested frame → excluded
    ];
    // only 'a' counts → union {100,100,50,50}; padding 10 → {90,90,70,70}
    expect(frameFitBox(items, frame, 10)).toEqual({ x: 90, y: 90, w: 70, h: 70 });
  });

  it('is null for an empty frame (nothing to bound → caller no-ops)', () => {
    expect(frameFitBox([frame], frame, 24)).toBeNull();
  });
});
