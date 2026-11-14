import { describe, expect, it } from 'vitest';
import { emptyGraph, groupKey } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems, patchItem, patchItems } from '../read-data/group-board-model';
import {
  membersOfRefs,
  unlockedOf,
  alignBoxes,
  distributeBoxes,
  distributeSpacing,
  distributeByGap,
  equalSize,
  reshapeFramesToAspect,
  reverseConnectors,
  newChainConnectors,
  newStarConnectors,
  newCycleConnectors,
  newMeshConnectors,
  invertedNodeIds,
  mindMapOutline,
  outlineToMarkdown,
  parseOutline,
  outlineParents,
  planOutlineMindMap,
  branchMemberIds,
  upstreamMemberIds,
  mindMapNonRootIds,
  parentViaConnectors,
  descendantsViaConnectors,
  setBranchHidden,
  connectorPairKey,
  applyBundleToAll,
  reorderZ,
  reorderZStep,
  flipItems,
  rotateItems,
  setLocked,
  setHidden,
  reorderZToOrder,
  snapToGrid,
  tidyGrid,
  arrangeUniform,
  arrangeBy,
  arrangeByFacet,
  arrangeByFacetLabeled,
  arrangeSelectionOnAxis,
  arrangeSelectionAsTimeline,
  itemIsAxisTick,
  itemIsBoardFurniture,
  AXIS_TICK_PREFIX,
  itemIsRegionHeading,
  REGION_HEADING_PREFIX,
  radialPlacement,
  flowPlacement,
  masonryPlacement,
  byTextAsc,
  byAreaDesc,
  byHue,
  byProgressDesc,
  byDueAsc,
  cardCompletion,
  arrangeByMatrixLabeled,
  spreadOutOverlaps,
  recolorSelectionToPalette,
  harmonizeSelectionFromAnchor,
  recolorSelectionByFacet,
  batchActionsAsNodeActions,
  buildBoardBatchPack,
  BOARD_GRID,
  BOARD_ITEM_FAMILY,
  minOf,
  maxOf,
} from './batch-actions';
import type { BoardBatchContext } from './batch-actions';
import { itemTags } from '../show/item-tags';
import { seededFillStack, itemFillColor } from '../show/item-fill';
import { arrangeColumns } from '../show/arrange-by-field';
import { importanceRanks, importanceValue } from '../read-data/board-importance';
import { BOARD_PALETTES, cycleAssign, nearestHueAssign } from '../show/board-palettes';
import { BOARD_HARMONY_SCHEMES, harmonize } from '../show/color-harmony';
import { MARKER_FACET_LABELS } from '../show/board-marker-catalog';
import { SHAPE_FACET_LABELS } from '../show/board-shapes';
import type { BatchActionCapability, NodeRef } from '../../ui/show/node-actions';
import type { VisualLayerStackRecord } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

/** A graph with the given boxes placed under PARENT. */
function graphWith(boxes: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>) {
  let g = emptyGraph();
  for (const b of boxes) {
    g = placeItem(g, PARENT, {
      memberId: b.id,
      nodeRef: { family: 'test.item', parts: { id: b.id } },
      kind: 'note',
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
    });
  }
  return g;
}

function boxesOf(g: ReturnType<typeof emptyGraph>) {
  return Object.fromEntries(readItems(g, PARENT).map((i) => [i.memberId, { x: i.x, y: i.y, w: i.w, h: i.h }]));
}

describe('reshapeFramesToAspect (#177) — only frames become slides', () => {
  function frameAndNote() {
    let g = emptyGraph();
    // A presentation frame (order 0) + a plain note both in the selection.
    g = placeItem(g, PARENT, {
      memberId: 'F',
      nodeRef: { family: 'test.item', parts: { id: 'F' } },
      kind: 'frame',
      x: 100,
      y: 50,
      w: 1600,
      h: 400,
      extra: { presentationFrame: { order: 0 } },
    });
    g = placeItem(g, PARENT, {
      memberId: 'N',
      nodeRef: { family: 'test.item', parts: { id: 'N' } },
      kind: 'note',
      x: 10,
      y: 10,
      w: 300,
      h: 999,
    });
    return g;
  }

  it('reshapes the frame to 16:9 keeping its top-left + width, and leaves the note untouched', () => {
    const out = reshapeFramesToAspect(frameAndNote(), PARENT, ['F', 'N'], 16, 9);
    const boxes = boxesOf(out);
    expect(boxes.F).toEqual({ x: 100, y: 50, w: 1600, h: 900 }); // width kept, height → ratio
    expect(boxes.N).toEqual({ x: 10, y: 10, w: 300, h: 999 }); // non-frame unchanged
  });

  it('is a no-op when no selected member is a frame', () => {
    const out = reshapeFramesToAspect(frameAndNote(), PARENT, ['N'], 1, 1);
    expect(boxesOf(out).N).toEqual({ x: 10, y: 10, w: 300, h: 999 });
  });
});

describe('unlockedOf (the lock chokepoint for batch ops)', () => {
  it('drops locked items, keeps unlocked ones (mixed selection)', () => {
    let g = graphWith([
      { id: 'a', x: 0, y: 0, w: 100, h: 60 },
      { id: 'b', x: 200, y: 0, w: 100, h: 60 },
      { id: 'c', x: 400, y: 0, w: 100, h: 60 },
    ]);
    g = setLocked(g, PARENT, ['b'], true); // lock b
    expect(unlockedOf(g, ['a', 'b', 'c'], PARENT).sort()).toEqual(['a', 'c']);
  });

  it('returns [] when every selected id is locked (batch op becomes a no-op)', () => {
    let g = graphWith([{ id: 'a', x: 0, y: 0, w: 100, h: 60 }]);
    g = setLocked(g, PARENT, ['a'], true);
    expect(unlockedOf(g, ['a'], PARENT)).toEqual([]);
  });

  it('is identity when nothing is locked (zero regression for the common case)', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 100, h: 60 },
      { id: 'b', x: 200, y: 0, w: 100, h: 60 },
    ]);
    expect(unlockedOf(g, ['a', 'b'], PARENT)).toEqual(['a', 'b']);
  });
});

describe('membersOfRefs', () => {
  it('extracts member ids, ignoring foreign families/missing parts', () => {
    expect(
      membersOfRefs([
        { family: BOARD_ITEM_FAMILY, parts: { member: 'a' } },
        { family: 'other', parts: {} },
        { family: BOARD_ITEM_FAMILY, parts: { member: 'b' } },
      ]),
    ).toEqual(['a', 'b']);
  });
});

describe('alignBoxes', () => {
  const g = graphWith([
    { id: 'a', x: 10, y: 0, w: 100, h: 50 },
    { id: 'b', x: 40, y: 100, w: 60, h: 50 },
    { id: 'c', x: 90, y: 200, w: 80, h: 50 },
  ]);

  it('align left snaps every x to the min', () => {
    const out = boxesOf(alignBoxes(g, PARENT, ['a', 'b', 'c'], 'left'));
    expect([out.a.x, out.b.x, out.c.x]).toEqual([10, 10, 10]);
  });

  it('align right snaps every right edge to the max right (x = right - w)', () => {
    const out = boxesOf(alignBoxes(g, PARENT, ['a', 'b', 'c'], 'right'));
    const maxRight = 170; // c: 90 + 80
    expect([out.a.x, out.b.x, out.c.x]).toEqual([maxRight - 100, maxRight - 60, maxRight - 80]);
  });

  it('is a no-op for a single box', () => {
    expect(alignBoxes(g, PARENT, ['a'], 'left')).toBe(g);
  });
});

describe('distributeBoxes', () => {
  it('evens the centers between the two outermost (≥3)', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 20, h: 20 }, // center 10
      { id: 'b', x: 30, y: 0, w: 20, h: 20 }, // center 40 (will move)
      { id: 'd', x: 190, y: 0, w: 20, h: 20 }, // center 200
    ]);
    const out = boxesOf(distributeBoxes(g, PARENT, ['a', 'b', 'd'], 'h'));
    // outermost centers 10 and 200 → middle center should be 105 → x = 105 - 10 = 95
    expect(out.b.x).toBe(95);
    expect(out.a.x).toBe(0); // endpoints unchanged
    expect(out.d.x).toBe(190);
  });

  it('needs at least 3 boxes', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 20, h: 20 },
      { id: 'b', x: 50, y: 0, w: 20, h: 20 },
    ]);
    expect(distributeBoxes(g, PARENT, ['a', 'b'], 'h')).toBe(g);
  });
});

describe('distributeSpacing', () => {
  it('evens the EDGE-TO-EDGE GAPS with mixed sizes (what distributeBoxes gets wrong)', () => {
    // a: x0 w20 (right edge 20); c: x180 w60 (left edge 180, right 240); b: w40 inner.
    // span = 240 - 0 = 240; ΣW = 20+40+60 = 120; gap = (240-120)/2 = 60.
    // b.x = a.right(20) + gap(60) = 80; gap b→c = 180 - (80+40) = 60. Equal gaps ✓.
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 20, h: 20 },
      { id: 'b', x: 70, y: 0, w: 40, h: 20 }, // starts misplaced → should move to 80
      { id: 'c', x: 180, y: 0, w: 60, h: 20 },
    ]);
    const out = boxesOf(distributeSpacing(g, PARENT, ['a', 'b', 'c'], 'h'));
    expect(out.b.x).toBe(80);
    const gapAB = out.b.x - (out.a.x + out.a.w); // 80 - 20 = 60
    const gapBC = out.c.x - (out.b.x + out.b.w); // 180 - 120 = 60
    expect(gapAB).toBe(gapBC);
    expect(gapAB).toBe(60);
  });

  it('leaves the two extreme items anchored', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 20, h: 20 },
      { id: 'b', x: 70, y: 0, w: 40, h: 20 },
      { id: 'c', x: 180, y: 0, w: 60, h: 20 },
    ]);
    const out = boxesOf(distributeSpacing(g, PARENT, ['a', 'b', 'c'], 'h'));
    expect(out.a.x).toBe(0);
    expect(out.c.x).toBe(180);
  });

  it('mirrors on the vertical axis (y/height)', () => {
    // span = 240; ΣH = 120; gap 60; b.y = 20 + 60 = 80.
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 20, h: 20 },
      { id: 'b', x: 0, y: 70, w: 20, h: 40 },
      { id: 'c', x: 0, y: 180, w: 20, h: 60 },
    ]);
    const out = boxesOf(distributeSpacing(g, PARENT, ['a', 'b', 'c'], 'v'));
    expect(out.b.y).toBe(80);
    expect(out.a.y).toBe(0);
    expect(out.c.y).toBe(180);
  });

  it('needs at least 3 boxes', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 20, h: 20 },
      { id: 'b', x: 50, y: 0, w: 20, h: 20 },
    ]);
    expect(distributeSpacing(g, PARENT, ['a', 'b'], 'h')).toBe(g);
  });
});

describe('distributeByGap', () => {
  it('lays items at a FIXED pitch, first anchored, mixed sizes (h)', () => {
    // a x0 w20 (right 20); b w40; c w60. gap 10 → b.x = 20+10 = 30; c.x = 30+40+10 = 80.
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 20, h: 20 },
      { id: 'b', x: 100, y: 0, w: 40, h: 20 }, // wrong gaps (sorted x), re-laid at fixed pitch
      { id: 'c', x: 200, y: 0, w: 60, h: 20 },
    ]);
    const out = boxesOf(distributeByGap(g, PARENT, ['a', 'b', 'c'], 'h', 10));
    expect(out.a.x).toBe(0); // first anchored
    expect(out.b.x).toBe(30);
    expect(out.c.x).toBe(80);
  });

  it('gap 0 packs flush edge-to-edge', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 20, h: 20 },
      { id: 'b', x: 500, y: 0, w: 40, h: 20 },
    ]);
    const out = boxesOf(distributeByGap(g, PARENT, ['a', 'b'], 'h', 0));
    expect(out.b.x).toBe(20); // a.right
  });

  it('mirrors on the vertical axis (y/height)', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 20, h: 20 },
      { id: 'b', x: 0, y: 500, w: 20, h: 40 },
    ]);
    const out = boxesOf(distributeByGap(g, PARENT, ['a', 'b'], 'v', 10));
    expect(out.b.y).toBe(30); // 20 + 10
  });

  it('needs at least 2 boxes', () => {
    const g = graphWith([{ id: 'a', x: 0, y: 0, w: 20, h: 20 }]);
    expect(distributeByGap(g, PARENT, ['a'], 'h', 10)).toBe(g);
  });
});

describe('equalSize', () => {
  const g = graphWith([
    { id: 'a', x: 0, y: 0, w: 100, h: 40 },
    { id: 'b', x: 0, y: 0, w: 60, h: 80 },
  ]);

  it('matches width to the reference (first) member', () => {
    const out = boxesOf(equalSize(g, PARENT, ['a', 'b'], 'w', 'a'));
    expect([out.a.w, out.b.w]).toEqual([100, 100]);
    expect([out.a.h, out.b.h]).toEqual([40, 80]); // heights untouched
  });

  it('both dims uses the reference w and h', () => {
    const out = boxesOf(equalSize(g, PARENT, ['a', 'b'], 'both', 'b'));
    expect([out.a.w, out.a.h]).toEqual([60, 80]);
  });
});

describe('reorderZ', () => {
  // readItems returns members in memberOrder; last = painted on top (front).
  const g = graphWith([
    { id: 'a', x: 0, y: 0, w: 10, h: 10 },
    { id: 'b', x: 0, y: 0, w: 10, h: 10 },
    { id: 'c', x: 0, y: 0, w: 10, h: 10 },
  ]);
  const order = (gr: ReturnType<typeof emptyGraph>) => readItems(gr, PARENT).map((i) => i.memberId);

  it('bring-to-front moves selection to the end, preserving relative order', () => {
    expect(order(reorderZ(g, PARENT, ['a'], 'front'))).toEqual(['b', 'c', 'a']);
    expect(order(reorderZ(g, PARENT, ['a', 'b'], 'front'))).toEqual(['c', 'a', 'b']);
  });

  it('send-to-back moves selection to the start, preserving relative order', () => {
    expect(order(reorderZ(g, PARENT, ['c'], 'back'))).toEqual(['c', 'a', 'b']);
    expect(order(reorderZ(g, PARENT, ['b', 'c'], 'back'))).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op for an empty selection', () => {
    expect(reorderZ(g, PARENT, [], 'front')).toBe(g);
  });
});

describe('reorderZStep (one-step forward/backward)', () => {
  const order = (gr: ReturnType<typeof emptyGraph>) => readItems(gr, PARENT).map((i) => i.memberId);
  const g3 = graphWith([
    { id: 'a', x: 0, y: 0, w: 10, h: 10 },
    { id: 'b', x: 0, y: 0, w: 10, h: 10 },
    { id: 'c', x: 0, y: 0, w: 10, h: 10 },
  ]);
  const g4 = graphWith([
    { id: 'a', x: 0, y: 0, w: 10, h: 10 },
    { id: 'b', x: 0, y: 0, w: 10, h: 10 },
    { id: 'c', x: 0, y: 0, w: 10, h: 10 },
    { id: 'd', x: 0, y: 0, w: 10, h: 10 },
  ]);

  it('forward swaps a single item up past the neighbour above', () => {
    expect(order(reorderZStep(g3, PARENT, ['a'], 'forward'))).toEqual(['b', 'a', 'c']);
  });
  it('forward is a no-op when the item is already at the front (top)', () => {
    expect(order(reorderZStep(g3, PARENT, ['c'], 'forward'))).toEqual(['a', 'b', 'c']);
  });
  it('backward swaps a single item down past the neighbour below', () => {
    expect(order(reorderZStep(g3, PARENT, ['c'], 'backward'))).toEqual(['a', 'c', 'b']);
  });
  it('backward is a no-op when the item is already at the back (bottom)', () => {
    expect(order(reorderZStep(g3, PARENT, ['a'], 'backward'))).toEqual(['a', 'b', 'c']);
  });
  it('a contiguous multi-selection moves together past one non-selected neighbour (forward)', () => {
    expect(order(reorderZStep(g4, PARENT, ['a', 'b'], 'forward'))).toEqual(['c', 'a', 'b', 'd']);
  });
  it('a contiguous multi-selection moves together past one non-selected neighbour (backward)', () => {
    expect(order(reorderZStep(g4, PARENT, ['b', 'c'], 'backward'))).toEqual(['b', 'c', 'a', 'd']);
  });
  it('selected items do not jump past each other (block blocked at the edge)', () => {
    expect(order(reorderZStep(g3, PARENT, ['b', 'c'], 'forward'))).toEqual(['a', 'b', 'c']);
  });
  it('is a no-op for an empty selection', () => {
    expect(reorderZStep(g3, PARENT, [], 'forward')).toBe(g3);
  });
});

describe('setLocked', () => {
  it('writes the locked flag onto every selected member', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', x: 0, y: 0, w: 10, h: 10 },
    ]);
    const locked = readItems(setLocked(g, PARENT, ['a', 'b'], true), PARENT);
    expect(locked.map((i) => i.extra?.locked)).toEqual([true, true]);
    const unlocked = readItems(setLocked(setLocked(g, PARENT, ['a'], true), PARENT, ['a'], false), PARENT);
    expect(unlocked.find((i) => i.memberId === 'a')?.extra?.locked).toBe(false);
  });
});

describe('snapToGrid', () => {
  it('rounds each box top-left to the nearest grid multiple', () => {
    const g = graphWith([
      { id: 'a', x: 10, y: 10, w: 100, h: 50 }, // → 0 ,0   (10/24→0 at grid 24)
      { id: 'b', x: 40, y: 50, w: 60, h: 50 }, //  → 48,48  (40/24→2, 50/24→2)
    ]);
    const out = boxesOf(snapToGrid(g, PARENT, ['a', 'b'], BOARD_GRID));
    expect([out.a.x, out.a.y]).toEqual([0, 0]);
    expect([out.b.x, out.b.y]).toEqual([48, 48]);
  });
  it('is a no-op for a zero/negative grid', () => {
    const g = graphWith([{ id: 'a', x: 13, y: 13, w: 10, h: 10 }]);
    expect(snapToGrid(g, PARENT, ['a'], 0)).toBe(g);
  });
});

describe('tidyGrid', () => {
  it('reflows into a compact ≈square grid anchored at the top-left', () => {
    // 4 boxes → 2 cols; max w=50,h=50; pitch = 50+gap.
    const g = graphWith([
      { id: 'a', x: 200, y: 100, w: 50, h: 50 },
      { id: 'b', x: 0, y: 0, w: 50, h: 50 },
      { id: 'c', x: 90, y: 0, w: 50, h: 50 },
      { id: 'd', x: 300, y: 300, w: 50, h: 50 },
    ]);
    const gap = 10;
    const pitch = 60; // 50 + 10
    const out = boxesOf(tidyGrid(g, PARENT, ['a', 'b', 'c', 'd'], gap));
    // reading order by (y,x): b(0,0), c(0,90), a(100,200), d(300,300)
    // anchor = min x/y = (0,0); 2 cols → b=(0,0) c=(pitch,0) a=(0,pitch) d=(pitch,pitch)
    expect([out.b.x, out.b.y]).toEqual([0, 0]);
    expect([out.c.x, out.c.y]).toEqual([pitch, 0]);
    expect([out.a.x, out.a.y]).toEqual([0, pitch]);
    expect([out.d.x, out.d.y]).toEqual([pitch, pitch]);
  });
  it('needs at least 2 boxes', () => {
    const g = graphWith([{ id: 'a', x: 5, y: 5, w: 10, h: 10 }]);
    expect(tidyGrid(g, PARENT, ['a'], 10)).toBe(g);
  });
});

describe('arrangeUniform (#202 — the generative grid/column/row primitive)', () => {
  // Mixed widths/heights → uniform pitch = max dim + gap (nothing overlaps).
  const boxes = () => graphWith([
    { id: 'a', x: 300, y: 300, w: 40, h: 30 },
    { id: 'b', x: 0, y: 0, w: 50, h: 60 }, // widest + tallest → drives pitch
    { id: 'c', x: 200, y: 100, w: 20, h: 20 },
  ]);
  const gap = 10;
  const colPitch = 60; // maxW 50 + 10
  const rowPitch = 70; // maxH 60 + 10
  // reading order by (y,x): b(0,0) → c(100,200) → a(300,300); anchor = (0,0).

  it('COLUMN (colsFor=1): stacks every box in one vertical line (same x, y by rowPitch)', () => {
    const out = boxesOf(arrangeUniform(boxes(), PARENT, ['a', 'b', 'c'], gap, () => 1));
    expect([out.b.x, out.b.y]).toEqual([0, 0]);
    expect([out.c.x, out.c.y]).toEqual([0, rowPitch]);
    expect([out.a.x, out.a.y]).toEqual([0, rowPitch * 2]);
    // Every box shares the anchor x → a single column.
    expect(new Set([out.a.x, out.b.x, out.c.x]).size).toBe(1);
  });

  it('ROW (colsFor=n): lays every box in one horizontal line (same y, x by colPitch)', () => {
    const out = boxesOf(arrangeUniform(boxes(), PARENT, ['a', 'b', 'c'], gap, (n) => n));
    expect([out.b.x, out.b.y]).toEqual([0, 0]);
    expect([out.c.x, out.c.y]).toEqual([colPitch, 0]);
    expect([out.a.x, out.a.y]).toEqual([colPitch * 2, 0]);
    // Every box shares the anchor y → a single row.
    expect(new Set([out.a.y, out.b.y, out.c.y]).size).toBe(1);
  });

  it('is a pure config of ONE body — tidyGrid IS arrangeUniform(ceil√n)', () => {
    const ids = ['a', 'b', 'c'];
    const viaTidy = boxesOf(tidyGrid(boxes(), PARENT, ids, gap));
    const viaArrange = boxesOf(arrangeUniform(boxes(), PARENT, ids, gap, (n) => Math.ceil(Math.sqrt(n))));
    expect(viaArrange).toEqual(viaTidy); // grid is not a special case — it's the same function
  });

  it('needs at least 2 boxes (no-op otherwise)', () => {
    const g = graphWith([{ id: 'a', x: 5, y: 5, w: 10, h: 10 }]);
    expect(arrangeUniform(g, PARENT, ['a'], 10, () => 1)).toBe(g);
  });
});

describe('arrangeBy (#203 — the deeper placement-injection primitive)', () => {
  const boxes = () => graphWith([
    { id: 'a', x: 300, y: 300, w: 40, h: 30 },
    { id: 'b', x: 0, y: 0, w: 50, h: 60 }, // widest + tallest → drives pitch
    { id: 'c', x: 200, y: 100, w: 20, h: 20 },
  ]);
  const gap = 10;
  const colPitch = 60; // maxW 50 + 10
  const rowPitch = 70; // maxH 60 + 10

  it('arrangeUniform IS arrangeBy(flowPlacement(colsFor)) — flow is one placement', () => {
    const ids = ['a', 'b', 'c'];
    for (const colsFor of [() => 1, (n: number) => n, (n: number) => Math.ceil(Math.sqrt(n))]) {
      const viaUniform = boxesOf(arrangeUniform(boxes(), PARENT, ids, gap, colsFor));
      const viaBy = boxesOf(arrangeBy(boxes(), PARENT, ids, gap, flowPlacement(colsFor)));
      expect(viaBy).toEqual(viaUniform); // grid/column/row are NOT special-cased — same body
    }
  });

  it('CIRCLE (radialPlacement): every box centre is equidistant from the ring centre', () => {
    const ids = ['a', 'b', 'c'];
    const out = boxesOf(arrangeBy(boxes(), PARENT, ids, gap, radialPlacement()));
    // Reconstruct the ring geometry the same way the placement does.
    const pitch = Math.max(colPitch, rowPitch); // 70
    const radius = Math.max(pitch, (3 * pitch) / (2 * Math.PI)); // 70 (floored to one pitch)
    const cx = 0 + radius; // anchor minX=0 + radius
    const cy = 0 + radius; // anchor minY=0 + radius
    const dims: Record<string, { w: number; h: number }> = {
      a: { w: 40, h: 30 }, b: { w: 50, h: 60 }, c: { w: 20, h: 20 },
    };
    const radii = ids.map((id) => {
      const cxi = out[id].x + dims[id].w / 2; // box centre
      const cyi = out[id].y + dims[id].h / 2;
      return Math.hypot(cxi - cx, cyi - cy);
    });
    // All three centres sit on ONE circle → equal radius (within rounding).
    for (const r of radii) expect(Math.abs(r - radius)).toBeLessThanOrEqual(1.5);
    // A circle is NOT a grid: the three boxes do NOT share a single x (column) or y (row).
    expect(new Set(ids.map((id) => out[id].x)).size).toBeGreaterThan(1);
    expect(new Set(ids.map((id) => out[id].y)).size).toBeGreaterThan(1);
  });

  it('circle starts at 12 o\'clock (first reading-order box centred above the ring centre)', () => {
    const out = boxesOf(arrangeBy(boxes(), PARENT, ['a', 'b', 'c'], gap, radialPlacement()));
    // reading order by (y,x): b is first → placed at angle -π/2 → directly above centre.
    const radius = 70;
    const cx = radius; // 70
    const bCentreX = out.b.x + 50 / 2;
    const bCentreY = out.b.y + 60 / 2;
    expect(Math.abs(bCentreX - cx)).toBeLessThanOrEqual(1); // same x as centre
    expect(bCentreY).toBeLessThan(radius); // above the centre (y < cy)
  });

  it('needs at least 2 boxes (no-op otherwise)', () => {
    const g = graphWith([{ id: 'a', x: 5, y: 5, w: 10, h: 10 }]);
    expect(arrangeBy(g, PARENT, ['a'], 10, radialPlacement())).toBe(g);
  });

  describe('MASONRY (masonryPlacement) — variable-height column packing grid can never produce', () => {
    // 4 boxes, reading order a,b,c,d (ascending y). maxW 30 → colPitch 40 (gap 10). cols = ceil√4 = 2.
    // a is TALL (fills column 0); b,c,d then all fall into the shorter column 1 and stack by ACTUAL
    // height (20 each), NOT a uniform rowPitch — the whole point of masonry.
    const masonryBoxes = () => graphWith([
      { id: 'a', x: 0, y: 0, w: 30, h: 100 },
      { id: 'b', x: 0, y: 10, w: 30, h: 20 },
      { id: 'c', x: 0, y: 20, w: 30, h: 20 },
      { id: 'd', x: 0, y: 30, w: 30, h: 20 },
    ]);
    const gap = 10;
    const out = () => boxesOf(arrangeBy(masonryBoxes(), PARENT, ['a', 'b', 'c', 'd'], gap, masonryPlacement((n) => Math.ceil(Math.sqrt(n)))));

    it('packs into exactly N fixed-width columns (2 distinct x at minX / minX+colPitch)', () => {
      const o = out();
      const xs = new Set(['a', 'b', 'c', 'd'].map((id) => o[id].x));
      expect(xs).toEqual(new Set([0, 40])); // colPitch = 30 + 10
    });

    it('each box drops into the SHORTEST column: the tall box owns col 0, the rest stack in col 1', () => {
      const o = out();
      expect(o.a.x).toBe(0);            // a (tall) → column 0, fills it to y=110
      expect(o.b.x).toBe(40);           // col 0 now taller → b/c/d go to column 1
      expect(o.c.x).toBe(40);
      expect(o.d.x).toBe(40);
    });

    it('column 1 packs by ACTUAL height (dense), NOT a uniform rowPitch — the grid-impossible result', () => {
      const o = out();
      // b at top of col 1, then c and d each one real height + gap below the previous.
      expect(o.b.y).toBe(0);
      expect(o.c.y).toBe(o.b.y + 20 + gap); // 30 — uses b's real 20px height, not the 100px tall box
      expect(o.d.y).toBe(o.c.y + 20 + gap); // 60
      // A grid (uniform rowPitch = maxH 100 + gap = 110) would put c at y≈110 — masonry is far denser.
      expect(o.d.y).toBeLessThan(110);
    });

    it('is registered in the board batch pack (auto-surfaced in bulk bar / ⌘K / right-click)', () => {
      const stub = { anyUnlockedSelected: true } as unknown as BoardBatchContext;
      expect(buildBoardBatchPack(stub).map((r) => r.id)).toContain('arrange-masonry');
    });
  });

  describe('SORT arrangements (injectable arrangeBy ORDER) — order by meaning, not position', () => {
    // A graph whose items carry TEXT + varied areas, placed OUT of both alpha and size order.
    const textGraph = () => {
      let g = emptyGraph();
      const rows = [
        { id: 'banana', x: 0, y: 0, w: 100, h: 100, text: 'Banana' },   // area 10000
        { id: 'apple', x: 0, y: 200, w: 60, h: 40, text: 'apple' },      // area 2400 (lowercase → ci sort)
        { id: 'cherry', x: 0, y: 400, w: 80, h: 80, text: 'Cherry' },    // area 6400
      ];
      for (const r of rows) g = placeItem(g, PARENT, { memberId: r.id, nodeRef: { family: 'test.item', parts: { id: r.id } }, kind: 'note', x: r.x, y: r.y, w: r.w, h: r.h, text: r.text });
      return g;
    };
    const ids = ['banana', 'apple', 'cherry'];

    it('byTextAsc comparator sorts case-insensitively + numerically ("item 2" < "item 10")', () => {
      const bx = (text: string) => ({ memberId: text, x: 0, y: 0, w: 1, h: 1, text });
      expect(['Banana', 'apple', 'Cherry'].map(bx).sort(byTextAsc).map((b) => b.text)).toEqual(['apple', 'Banana', 'Cherry']);
      expect(['item 10', 'item 2'].map(bx).sort(byTextAsc).map((b) => b.text)).toEqual(['item 2', 'item 10']);
    });

    it('byAreaDesc comparator orders biggest-first', () => {
      const bx = (id: string, w: number, h: number) => ({ memberId: id, x: 0, y: 0, w, h });
      expect([bx('s', 10, 10), bx('l', 50, 50), bx('m', 30, 30)].sort(byAreaDesc).map((b) => b.memberId)).toEqual(['l', 'm', 's']);
    });

    it('Sort A→Z lays the items into a COLUMN in alphabetical order (top→bottom = apple, Banana, Cherry)', () => {
      const out = boxesOf(arrangeBy(textGraph(), PARENT, ids, 10, flowPlacement(() => 1), byTextAsc));
      // single column → all same x
      expect(new Set(ids.map((id) => out[id].x)).size).toBe(1);
      // y ascending follows alpha order: apple < banana < cherry
      expect(out.apple.y).toBeLessThan(out.banana.y);
      expect(out.banana.y).toBeLessThan(out.cherry.y);
    });

    it('Sort by size orders biggest-first in reading order (Banana → Cherry → apple by area)', () => {
      const out = boxesOf(arrangeBy(textGraph(), PARENT, ids, 10, flowPlacement(() => 1), byAreaDesc));
      // biggest (banana) at top, smallest (apple) at bottom
      expect(out.banana.y).toBeLessThan(out.cherry.y);
      expect(out.cherry.y).toBeLessThan(out.apple.y);
    });

    it('DEFAULT order is unchanged (reading order) — every existing caller is byte-safe (regression guard)', () => {
      const g = graphWith([
        { id: 'a', x: 300, y: 300, w: 40, h: 30 },
        { id: 'b', x: 0, y: 0, w: 50, h: 60 },
        { id: 'c', x: 200, y: 100, w: 20, h: 20 },
      ]);
      const withDefault = boxesOf(arrangeBy(g, PARENT, ['a', 'b', 'c'], 10, flowPlacement(() => 1)));
      const withExplicit = boxesOf(arrangeBy(g, PARENT, ['a', 'b', 'c'], 10, flowPlacement(() => 1), (x, y) => x.y - y.y || x.x - y.x));
      expect(withDefault).toEqual(withExplicit);
    });

    it('byHue comparator orders boxes into a rainbow by fill (red→green→blue), achromatic/absent last', () => {
      const bx = (id: string, fill?: string) => ({ memberId: id, x: 0, y: 0, w: 1, h: 1, fill });
      const order = [bx('blue', '#0000ff'), bx('gray', '#e5e7eb'), bx('red', '#ff0000'), bx('none'), bx('green', '#00ff00')]
        .sort(byHue)
        .map((b) => b.memberId);
      // chromatic sorted by hue; both hueless boxes (gray, none) sink to the end via the Infinity guard.
      expect(order.slice(0, 3)).toEqual(['red', 'green', 'blue']);
      expect(order.slice(3).sort()).toEqual(['gray', 'none']);
    });

    it('cardCompletion reads metric-first, else checklist, else undefined (cont.98 batch-61)', () => {
      const item = (extra: Record<string, unknown>) => ({ memberId: 'm', kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, extra } as never);
      const chk = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ id: `c${i}`, text: `t${i}`, done: i < done }));
      expect(cardCompletion(item({ metric: { current: 5, target: 10 } }))).toBeCloseTo(0.5); // metric progress
      expect(cardCompletion(item({ checklist: chk(3, 4) }))).toBeCloseTo(0.75); // falls back to checklist
      expect(cardCompletion(item({ metric: { current: 8, target: 10 }, checklist: chk(0, 4) }))).toBeCloseTo(0.8); // metric WINS when both exist
      expect(cardCompletion(item({}))).toBeUndefined(); // neither → no progress
    });

    it('byProgressDesc orders most-done first; no-progress cards rank LAST', () => {
      const bx = (id: string, progress?: number) => ({ memberId: id, x: 0, y: 0, w: 1, h: 1, progress });
      const order = [bx('half', 0.5), bx('none'), bx('done', 1), bx('start', 0)].sort(byProgressDesc).map((b) => b.memberId);
      expect(order.slice(0, 3)).toEqual(['done', 'half', 'start']); // 1 > 0.5 > 0
      expect(order[3]).toBe('none'); // no progress → -1 → last
    });

    it('byDueAsc orders soonest-due first; undated cards rank LAST', () => {
      const bx = (id: string, due?: number) => ({ memberId: id, x: 0, y: 0, w: 1, h: 1, due });
      const order = [bx('later', 3000), bx('undated'), bx('soon', 1000), bx('mid', 2000)].sort(byDueAsc).map((b) => b.memberId);
      expect(order.slice(0, 3)).toEqual(['soon', 'mid', 'later']);
      expect(order[3]).toBe('undated'); // no due → +Infinity → last
    });

    it('Sort by color lays fill-carrying items into a COLUMN in rainbow order (red→blue top→bottom)', () => {
      // A graph placed OUT of hue order; each item seeds a real fill stack (read back via itemFillColor).
      let g = emptyGraph();
      const rows = [
        { id: 'blue', color: '#0000ff' },
        { id: 'red', color: '#ff0000' },
        { id: 'green', color: '#00ff00' },
      ];
      rows.forEach((r, idx) =>
        (g = placeItem(g, PARENT, {
          memberId: r.id,
          nodeRef: { family: 'test.item', parts: { id: r.id } },
          kind: 'note',
          x: 0,
          y: idx * 200,
          w: 40,
          h: 40,
          extra: { visualLayerStack: seededFillStack(r.color) },
        })));
      const out = boxesOf(arrangeBy(g, PARENT, ['blue', 'red', 'green'], 10, flowPlacement(() => 1), byHue));
      expect(new Set(['blue', 'red', 'green'].map((id) => out[id].x)).size).toBe(1); // single column
      expect(out.red.y).toBeLessThan(out.green.y);
      expect(out.green.y).toBeLessThan(out.blue.y);
    });

    it('all three sort rows are registered in the board batch pack', () => {
      const stub = { anyUnlockedSelected: true } as unknown as BoardBatchContext;
      const rowIds = buildBoardBatchPack(stub).map((r) => r.id);
      expect(rowIds).toContain('arrange-sort-az');
      expect(rowIds).toContain('arrange-sort-size');
      expect(rowIds).toContain('arrange-sort-color');
    });
  });
});

describe('arrangeByFacet (§9.1 — cluster the selection by an injected facet)', () => {
  /** Items with facet-bearing extras: two tagged "work", one "life", one untagged. */
  function facetGraph() {
    let g = emptyGraph();
    const place = (id: string, x: number, y: number, kind: string, extra?: Record<string, unknown>) => {
      g = placeItem(g, PARENT, {
        memberId: id,
        nodeRef: { family: 'test.item', parts: { id } },
        kind,
        x,
        y,
        w: 40,
        h: 30,
        extra,
      });
    };
    place('w1', 500, 500, 'note', { tags: ['work'] });
    place('w2', 0, 0, 'note', { tags: ['work'] });
    place('l1', 200, 100, 'image', { tags: ['life'] });
    place('u1', 300, 300, 'note');
    return g;
  }
  const yOf = (g: ReturnType<typeof emptyGraph>) =>
    Object.fromEntries(readItems(g, PARENT).map((i) => [i.memberId, i.y]));

  it('same-key items share a cluster band; different keys land in different bands', () => {
    const out = arrangeByFacet(facetGraph(), PARENT, ['w1', 'w2', 'l1', 'u1'], 10, (i) => itemTags(i));
    const y = yOf(out);
    // Equal heights + one row per cluster → same y = same cluster band.
    expect(y.w1).toBe(y.w2); // both "work"
    expect(y.l1).not.toBe(y.w1); // "life" is its own band
    expect(y.u1).not.toBe(y.w1); // untagged ('' key) is its own band
    expect(y.u1).not.toBe(y.l1);
    // Cluster order is groupKeys sorted ascending → '' (untagged) < life < work.
    expect(y.u1).toBeLessThan(y.l1);
    expect(y.l1).toBeLessThan(y.w1);
  });

  it('anchors at the selection top-left (no jump to the origin) and only moves the selection', () => {
    const out = arrangeByFacet(facetGraph(), PARENT, ['w1', 'w2', 'l1'], 10, (i) => itemTags(i));
    const items = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, i]));
    // Selection min was (0,0) (w2) → the first cluster starts exactly there.
    expect(Math.min(items.w1.x, items.w2.x, items.l1.x)).toBe(0);
    expect(Math.min(items.w1.y, items.w2.y, items.l1.y)).toBe(0);
    // u1 was OUTSIDE the selection → untouched.
    expect(items.u1.x).toBe(300);
    expect(items.u1.y).toBe(300);
  });

  it('the facet is INJECTED — kind-clustering is the same engine with a different lambda (L090)', () => {
    const out = arrangeByFacet(facetGraph(), PARENT, ['w1', 'w2', 'l1', 'u1'], 10, (i) => i.kind);
    const y = yOf(out);
    // By KIND: the three notes share a band; the image is its own band.
    expect(y.w1).toBe(y.w2);
    expect(y.w1).toBe(y.u1);
    expect(y.l1).not.toBe(y.w1);
  });

  it('multi-key items cluster under their FIRST key (deterministic primary)', () => {
    let g = facetGraph();
    g = placeItem(g, PARENT, {
      memberId: 'm1',
      nodeRef: { family: 'test.item', parts: { id: 'm1' } },
      kind: 'note',
      x: 400,
      y: 400,
      w: 40,
      h: 30,
      extra: { tags: ['life', 'work'] },
    });
    const y = yOf(arrangeByFacet(g, PARENT, ['w1', 'l1', 'm1'], 10, (i) => itemTags(i)));
    expect(y.m1).toBe(y.l1); // first tag "life" wins
    expect(y.m1).not.toBe(y.w1);
  });

  it('needs at least 2 non-connector items (no-op otherwise)', () => {
    const g = facetGraph();
    expect(arrangeByFacet(g, PARENT, ['w1'], 10, (i) => itemTags(i))).toBe(g);
  });
});

describe('applyBundleToAll', () => {
  it('stamps the opaque stack onto every member, re-homing region to the parent', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', x: 0, y: 0, w: 10, h: 10 },
    ]);
    const bundle: VisualLayerStackRecord = {
      kind: 'visual-layer-stack',
      version: 1,
      region: { family: 'somewhere.else', parts: {} },
      layers: [],
    };
    const out = applyBundleToAll(g, PARENT, ['a', 'b'], bundle);
    for (const item of readItems(out, PARENT)) {
      const stack = item.extra?.visualLayerStack as VisualLayerStackRecord;
      expect(stack.kind).toBe('visual-layer-stack');
      expect(stack.region).toEqual(PARENT); // re-homed to where it lands
    }
  });
});

// Place boxes that also carry `extra` (rotation / flip flags) for the flip tests.
function graphWithExtra(
  boxes: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number; extra?: Record<string, unknown> }>,
) {
  let g = emptyGraph();
  for (const b of boxes) {
    g = placeItem(g, PARENT, {
      memberId: b.id,
      nodeRef: { family: 'test.item', parts: { id: b.id } },
      kind: 'note',
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      extra: b.extra,
    });
  }
  return g;
}

/** Read each item's centre + rotation + flip flags. */
function statesOf(g: ReturnType<typeof emptyGraph>) {
  return Object.fromEntries(
    readItems(g, PARENT).map((i) => [
      i.memberId,
      { cx: i.x + i.w / 2, cy: i.y + i.h / 2, x: i.x, y: i.y, rotation: Number(i.extra?.rotation) || 0, flipX: i.extra?.flipX === true, flipY: i.extra?.flipY === true },
    ]),
  );
}

describe('flipItems', () => {
  it('single horizontal flip: toggles flipX, negates rotation, leaves the centre in place', () => {
    const g = graphWithExtra([{ id: 'a', x: 100, y: 100, w: 80, h: 40, extra: { rotation: 30 } }]);
    const out = statesOf(flipItems(g, PARENT, ['a'], 'x'));
    expect(out.a.flipX).toBe(true);
    expect(out.a.rotation).toBe(330); // -30 normalized to [0,360)
    expect(out.a.cx).toBe(140); // pivot = own centre → unchanged
    expect(out.a.cy).toBe(120);
  });

  it('single vertical flip: toggles flipY, negates rotation, leaves the centre in place', () => {
    const g = graphWithExtra([{ id: 'a', x: 100, y: 100, w: 80, h: 40, extra: { rotation: 30 } }]);
    const out = statesOf(flipItems(g, PARENT, ['a'], 'y'));
    expect(out.a.flipY).toBe(true);
    expect(out.a.rotation).toBe(330);
    expect(out.a.cx).toBe(140);
    expect(out.a.cy).toBe(120);
  });

  it('group horizontal flip: mirrors the two centres about the selection pivot (left↔right)', () => {
    // a centre x=50, b centre x=350 → pivotX = 200; mirror → a→350, b→50.
    const g = graphWithExtra([
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 300, y: 0, w: 100, h: 100 },
    ]);
    const out = statesOf(flipItems(g, PARENT, ['a', 'b'], 'x'));
    expect(out.a.cx).toBe(350);
    expect(out.b.cx).toBe(50);
    expect(out.a.cy).toBe(50); // y untouched by an x-flip
    expect(out.b.cy).toBe(50);
    expect(out.a.flipX).toBe(true);
    expect(out.b.flipX).toBe(true);
  });

  it('group vertical flip: mirrors the two centres about the selection pivot (top↔bottom)', () => {
    // a centre y=50, b centre y=350 → pivotY = 200; mirror → a→350, b→50.
    const g = graphWithExtra([
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 0, y: 300, w: 100, h: 100 },
    ]);
    const out = statesOf(flipItems(g, PARENT, ['a', 'b'], 'y'));
    expect(out.a.cy).toBe(350);
    expect(out.b.cy).toBe(50);
    expect(out.a.cx).toBe(50); // x untouched by a y-flip
    expect(out.b.cx).toBe(50);
    expect(out.a.flipY).toBe(true);
    expect(out.b.flipY).toBe(true);
  });

  it('is an involution: flipping twice restores x, rotation, and the flip flag', () => {
    const g = graphWithExtra([
      { id: 'a', x: 0, y: 0, w: 100, h: 100, extra: { rotation: 30 } },
      { id: 'b', x: 300, y: 0, w: 100, h: 100, extra: { rotation: 200 } },
    ]);
    const once = flipItems(g, PARENT, ['a', 'b'], 'x');
    const twice = statesOf(flipItems(once, PARENT, ['a', 'b'], 'x'));
    const before = statesOf(g);
    expect(twice.a.x).toBe(before.a.x);
    expect(twice.b.x).toBe(before.b.x);
    expect(twice.a.rotation).toBe(before.a.rotation); // -(-30)=30
    expect(twice.b.rotation).toBe(before.b.rotation); // -(-200)=200 normalized
    expect(twice.a.flipX).toBe(false);
    expect(twice.b.flipX).toBe(false);
  });

  it('is a no-op for an empty selection', () => {
    const g = graphWithExtra([{ id: 'a', x: 0, y: 0, w: 100, h: 100 }]);
    expect(flipItems(g, PARENT, [], 'x')).toBe(g);
  });
});

describe('rotateItems', () => {
  it('rotates a single item in place: centre unchanged, rotation set', () => {
    const g = graphWithExtra([{ id: 'a', x: 100, y: 200, w: 80, h: 40 }]);
    const out = statesOf(rotateItems(g, PARENT, ['a'], 90));
    // Single item → bbox pivot IS its own centre → orbit dx=dy=0 → centre fixed.
    expect(out.a.cx).toBe(140);
    expect(out.a.cy).toBe(220);
    expect(out.a.rotation).toBe(90);
  });

  it('orbits a group about the selection bbox centre (+90° CW)', () => {
    // a centre (50,50), b centre (350,50); bbox pivot (200,50).
    const g = graphWithExtra([
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 300, y: 0, w: 100, h: 100 },
    ]);
    const out = statesOf(rotateItems(g, PARENT, ['a', 'b'], 90));
    // +90: (dx,dy)->(-dy,dx). a dx=-150,dy=0 -> (0,-150) -> centre (200,-100).
    expect(out.a.cx).toBe(200);
    expect(out.a.cy).toBe(-100);
    // b dx=150,dy=0 -> (0,150) -> centre (200,200).
    expect(out.b.cx).toBe(200);
    expect(out.b.cy).toBe(200);
    expect(out.a.rotation).toBe(90);
    expect(out.b.rotation).toBe(90);
  });

  it('+90 then -90 returns to the original arrangement (involution)', () => {
    const g = graphWithExtra([
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 300, y: 0, w: 100, h: 100 },
    ]);
    const before = statesOf(g);
    const round = statesOf(rotateItems(rotateItems(g, PARENT, ['a', 'b'], 90), PARENT, ['a', 'b'], -90));
    expect(round.a.cx).toBe(before.a.cx);
    expect(round.a.cy).toBe(before.a.cy);
    expect(round.b.cx).toBe(before.b.cx);
    expect(round.b.cy).toBe(before.b.cy);
    expect(round.a.rotation).toBe(before.a.rotation);
    expect(round.b.rotation).toBe(before.b.rotation);
  });

  it('accumulates rotation modulo 360', () => {
    const g = graphWithExtra([{ id: 'a', x: 0, y: 0, w: 100, h: 100, extra: { rotation: 300 } }]);
    const out = statesOf(rotateItems(g, PARENT, ['a'], 90));
    expect(out.a.rotation).toBe(30); // (300+90)%360
  });

  it('CCW (-90) from 0 normalizes to 270', () => {
    const g = graphWithExtra([{ id: 'a', x: 0, y: 0, w: 100, h: 100 }]);
    const out = statesOf(rotateItems(g, PARENT, ['a'], -90));
    expect(out.a.rotation).toBe(270);
  });

  it('is a no-op for an empty selection', () => {
    const g = graphWithExtra([{ id: 'a', x: 0, y: 0, w: 100, h: 100 }]);
    expect(rotateItems(g, PARENT, [], 90)).toBe(g);
  });
});

describe('Select same marker / shape rows (select-similar by the first-class marker/shape)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: Record<string, string[][]> } {
    const calls: Record<string, string[][]> = { marker: [], shape: [] };
    const ctx = {
      anyUnlockedSelected: true, anchorHasMarker: false, anchorHasShape: false,
      selectSameMarker: (ids: string[]) => calls.marker.push([...ids]),
      selectSameShape: (ids: string[]) => calls.shape.push([...ids]),
      ...over,
    } as unknown as BoardBatchContext;
    return { ctx, calls };
  }

  it('both rows are HIDDEN (accepts=false) when the anchor has no per-item marker/shape (L118)', () => {
    const { ctx } = ctxWith({});
    const pack = buildBoardBatchPack(ctx);
    const marker = pack.find((r) => r.id === 'select-same-marker')!;
    const shape = pack.find((r) => r.id === 'select-same-shape')!;
    expect(marker.accepts([ref('a')])).toBe(false);
    expect(shape.accepts([ref('a')])).toBe(false);
  });

  it('the marker row enables when anchorHasMarker and delegates the member ids to selectSameMarker', () => {
    const { ctx, calls } = ctxWith({ anchorHasMarker: true });
    const row = buildBoardBatchPack(ctx).find((r) => r.id === 'select-same-marker')!;
    expect(row.accepts([ref('a'), ref('b')])).toBe(true);
    row.run([ref('a'), ref('b')]);
    expect(calls.marker).toEqual([['a', 'b']]);
  });

  it('the shape row enables when anchorHasShape and delegates to selectSameShape', () => {
    const { ctx, calls } = ctxWith({ anchorHasShape: true });
    const row = buildBoardBatchPack(ctx).find((r) => r.id === 'select-same-shape')!;
    expect(row.accepts([ref('a')])).toBe(true);
    row.run([ref('a')]);
    expect(calls.shape).toEqual([['a']]);
  });
});

describe('Select upstream row (#186 twin — the all-connector ancestor lineage)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: string[][] } {
    const calls: string[][] = [];
    const ctx = {
      anchorHasAncestors: false,
      selectUpstream: (ids: string[]) => calls.push([...ids]),
      ...over,
    } as unknown as BoardBatchContext;
    return { ctx, calls };
  }

  it('is HIDDEN (accepts=false) when the anchor has no ancestors (L118 — no dead no-op)', () => {
    const row = buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-upstream')!;
    expect(row.accepts([ref('a')])).toBe(false);
  });

  it('enables when anchorHasAncestors and delegates the member ids to selectUpstream', () => {
    const { ctx, calls } = ctxWith({ anchorHasAncestors: true });
    const row = buildBoardBatchPack(ctx).find((r) => r.id === 'select-upstream')!;
    expect(row.accepts([ref('a')])).toBe(true);
    row.run([ref('a')]);
    expect(calls).toEqual([['a']]);
  });
});

describe('trace-path row (b138 — select the chain between two connected cards)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: string[][] } {
    const calls: string[][] = [];
    const ctx = {
      exactlyTwoNodesSelected: false,
      selectionHasConnectors: false,
      tracePath: (ids: string[]) => calls.push([...ids]),
      ...over,
    } as unknown as BoardBatchContext;
    return { ctx, calls };
  }

  it('is HIDDEN unless EXACTLY two nodes are selected AND they carry a connector (L118)', () => {
    const row = (o: Partial<Record<string, unknown>>) => buildBoardBatchPack(ctxWith(o).ctx).find((r) => r.id === 'trace-path')!;
    expect(row({}).accepts([ref('a'), ref('b')])).toBe(false); // neither gate
    expect(row({ exactlyTwoNodesSelected: true }).accepts([ref('a'), ref('b')])).toBe(false); // no connectors
    expect(row({ selectionHasConnectors: true }).accepts([ref('a'), ref('b')])).toBe(false); // not exactly two
    expect(row({ exactlyTwoNodesSelected: true, selectionHasConnectors: true }).accepts([ref('a'), ref('b')])).toBe(true);
  });

  it('delegates the two member ids to tracePath', () => {
    const { ctx, calls } = ctxWith({ exactlyTwoNodesSelected: true, selectionHasConnectors: true });
    const row = buildBoardBatchPack(ctx).find((r) => r.id === 'trace-path')!;
    row.run([ref('a'), ref('b')]);
    expect(calls).toEqual([['a', 'b']]);
  });
});

describe('select-backlinks row (b139 — wikilink "linked mentions")', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: string[][] } {
    const calls: string[][] = [];
    const ctx = { anchorHasBacklinks: false, selectBacklinks: (ids: string[]) => calls.push([...ids]), ...over } as unknown as BoardBatchContext;
    return { ctx, calls };
  }

  it('is HIDDEN unless the anchor actually has backlinks (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-backlinks')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ anchorHasBacklinks: true }).ctx).find((r) => r.id === 'select-backlinks')!.accepts([ref('a')])).toBe(true);
  });

  it('delegates the anchor member ids to selectBacklinks', () => {
    const { ctx, calls } = ctxWith({ anchorHasBacklinks: true });
    buildBoardBatchPack(ctx).find((r) => r.id === 'select-backlinks')!.run([ref('a')]);
    expect(calls).toEqual([['a']]);
  });
});

describe('create-linked-cards row (b140 — create cards from broken wikilinks)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: string[][] } {
    const calls: string[][] = [];
    const ctx = { anchorHasBrokenRefs: false, createMissingCards: (ids: string[]) => calls.push([...ids]), ...over } as unknown as BoardBatchContext;
    return { ctx, calls };
  }

  it('is HIDDEN unless the anchor types a broken reference (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'create-linked-cards')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ anchorHasBrokenRefs: true }).ctx).find((r) => r.id === 'create-linked-cards')!.accepts([ref('a')])).toBe(true);
  });

  it('delegates the anchor member ids to createMissingCards', () => {
    const { ctx, calls } = ctxWith({ anchorHasBrokenRefs: true });
    buildBoardBatchPack(ctx).find((r) => r.id === 'create-linked-cards')!.run([ref('a')]);
    expect(calls).toEqual([['a']]);
  });
});

describe('select-orphans row (b141 — select floating cards)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasOrphans: false, selectOrphans: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has an orphan (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-orphans')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasOrphans: true }).ctx).find((r) => r.id === 'select-orphans')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectOrphans (board-global — ignores the selection)', () => {
    const h = ctxWith({ boardHasOrphans: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-orphans')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-ready row (b144 — select the actionable frontier)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasReadyCards: false, selectReady: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a ready card (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-ready')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasReadyCards: true }).ctx).find((r) => r.id === 'select-ready')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectReady (board-global — ignores the selection)', () => {
    const h = ctxWith({ boardHasReadyCards: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-ready')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-unlinked-mentions row (b146 — select cards to link up)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasUnlinkedMentions: false, selectUnlinkedMentions: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has an unlinked mention (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-unlinked-mentions')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasUnlinkedMentions: true }).ctx).find((r) => r.id === 'select-unlinked-mentions')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectUnlinkedMentions (board-global — ignores the selection)', () => {
    const h = ctxWith({ boardHasUnlinkedMentions: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-unlinked-mentions')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-questions row (b150 — select the open threads)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasQuestions: false, selectQuestions: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has an open question (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-questions')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasQuestions: true }).ctx).find((r) => r.id === 'select-questions')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectQuestions (board-global — ignores the selection)', () => {
    const h = ctxWith({ boardHasQuestions: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-questions')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-duplicate-titles row (b151 — the ambiguous [[link]] targets)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasDuplicateTitles: false, selectDuplicateTitles: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a title collision (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-duplicate-titles')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasDuplicateTitles: true }).ctx).find((r) => r.id === 'select-duplicate-titles')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectDuplicateTitles (board-global — ignores the selection)', () => {
    const h = ctxWith({ boardHasDuplicateTitles: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-duplicate-titles')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-fragmented-tags row (b152 — unify a fragmented tag taxonomy)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasFragmentedTags: false, selectFragmentedTags: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a near-duplicate tag group (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-fragmented-tags')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasFragmentedTags: true }).ctx).find((r) => r.id === 'select-fragmented-tags')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectFragmentedTags (board-global — ignores the selection)', () => {
    const h = ctxWith({ boardHasFragmentedTags: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-fragmented-tags')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('unify-fragmented-tags row (b156 — one-click canonicalize)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasFragmentedTags: false, unifyFragmentedTags: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a near-duplicate tag group (L118 — same gate as select)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'unify-fragmented-tags')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasFragmentedTags: true }).ctx).find((r) => r.id === 'unify-fragmented-tags')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes unifyFragmentedTags (board-global mutation)', () => {
    const h = ctxWith({ boardHasFragmentedTags: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'unify-fragmented-tags')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-largest-cluster row (b153 — isolate the main structure of a fragmented board)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasMultipleClusters: false, selectLargestCluster: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has ≥2 separate clusters (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-largest-cluster')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasMultipleClusters: true }).ctx).find((r) => r.id === 'select-largest-cluster')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectLargestCluster (board-global — ignores the selection)', () => {
    const h = ctxWith({ boardHasMultipleClusters: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-largest-cluster')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-redundant-connectors row (b154 — de-dup accidental double-draws)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasDuplicateConnectors: false, selectRedundantConnectors: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a duplicate connector (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-redundant-connectors')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasDuplicateConnectors: true }).ctx).find((r) => r.id === 'select-redundant-connectors')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectRedundantConnectors (board-global — ignores the selection)', () => {
    const h = ctxWith({ boardHasDuplicateConnectors: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-redundant-connectors')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-sources / select-sinks rows (b157 — dependency-flow endpoints)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; sources: number; sinks: number } {
    const box = { s: 0, k: 0 };
    const ctx = {
      boardHasSources: false, boardHasSinks: false,
      selectSources: () => { box.s += 1; }, selectSinks: () => { box.k += 1; }, ...over,
    } as unknown as BoardBatchContext;
    return { ctx, get sources() { return box.s; }, get sinks() { return box.k; } };
  }

  it('each row is HIDDEN unless the board has that endpoint (L118)', () => {
    const pack = (over: Partial<Record<string, unknown>>) => buildBoardBatchPack(ctxWith(over).ctx);
    expect(pack({}).find((r) => r.id === 'select-sources')!.accepts([ref('a')])).toBe(false);
    expect(pack({ boardHasSources: true }).find((r) => r.id === 'select-sources')!.accepts([ref('a')])).toBe(true);
    expect(pack({}).find((r) => r.id === 'select-sinks')!.accepts([ref('a')])).toBe(false);
    expect(pack({ boardHasSinks: true }).find((r) => r.id === 'select-sinks')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes the right board-global selector', () => {
    const h = ctxWith({ boardHasSources: true, boardHasSinks: true });
    const pack = buildBoardBatchPack(h.ctx);
    pack.find((r) => r.id === 'select-sources')!.run([ref('a')]);
    pack.find((r) => r.id === 'select-sinks')!.run([ref('a')]);
    expect(h.sources).toBe(1);
    expect(h.sinks).toBe(1);
  });
});

describe('select-undated row (b158 — cards missing a deadline)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasDateGaps: false, selectUndatedCards: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board is partly scheduled (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-undated')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasDateGaps: true }).ctx).find((r) => r.id === 'select-undated')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectUndatedCards (board-global)', () => {
    const h = ctxWith({ boardHasDateGaps: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-undated')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-top-theme row (b159 — cards sharing the top recurring theme)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasThemes: false, selectTopThemeCards: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a recurring theme (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-top-theme')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasThemes: true }).ctx).find((r) => r.id === 'select-top-theme')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectTopThemeCards (board-global)', () => {
    const h = ctxWith({ boardHasThemes: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-top-theme')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-linked-cards row (b160 — cards carrying an external link)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasLinks: false, selectLinkedCards: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a link (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-linked-cards')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasLinks: true }).ctx).find((r) => r.id === 'select-linked-cards')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectLinkedCards (board-global)', () => {
    const h = ctxWith({ boardHasLinks: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-linked-cards')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-split-candidates row (b161 — cards worth splitting)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasSplitCandidates: false, selectSplitCandidates: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a split candidate (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-split-candidates')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasSplitCandidates: true }).ctx).find((r) => r.id === 'select-split-candidates')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectSplitCandidates (board-global)', () => {
    const h = ctxWith({ boardHasSplitCandidates: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-split-candidates')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-untagged row (b162 — cards missing a tag)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasTagGaps: false, selectUntaggedCards: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board is partly tagged (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-untagged')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasTagGaps: true }).ctx).find((r) => r.id === 'select-untagged')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectUntaggedCards (board-global)', () => {
    const h = ctxWith({ boardHasTagGaps: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-untagged')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-main-relationship row (b163 — cards in the dominant relationship)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasRelationships: false, selectMainRelationshipCards: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a connector (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-main-relationship')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasRelationships: true }).ctx).find((r) => r.id === 'select-main-relationship')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectMainRelationshipCards (board-global)', () => {
    const h = ctxWith({ boardHasRelationships: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-main-relationship')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-health-issues row (b164 — every card a health signal flagged)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasHealthIssues: false, selectHealthIssueCards: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a health issue (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-health-issues')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasHealthIssues: true }).ctx).find((r) => r.id === 'select-health-issues')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectHealthIssueCards (board-global)', () => {
    const h = ctxWith({ boardHasHealthIssues: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-health-issues')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-largest-color-group row (b166 — the board\'s dominant colour family)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasColorGroups: false, selectLargestColorGroup: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless the board has a colour (L118 — no dead no-op on a colourless board)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-largest-color-group')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasColorGroups: true }).ctx).find((r) => r.id === 'select-largest-color-group')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectLargestColorGroup (board-global)', () => {
    const h = ctxWith({ boardHasColorGroups: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-largest-color-group')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('select-strongest-tag-pair row (b168 — the board\'s most co-occurring tag pair)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxWith(over: Partial<Record<string, unknown>>): { ctx: BoardBatchContext; calls: number } {
    const box = { n: 0 };
    const ctx = { boardHasTagPairs: false, selectStrongestTagPair: () => { box.n += 1; }, ...over } as unknown as BoardBatchContext;
    return { ctx, get calls() { return box.n; } };
  }

  it('is HIDDEN unless two tags co-occur (L118 — no dead no-op)', () => {
    expect(buildBoardBatchPack(ctxWith({}).ctx).find((r) => r.id === 'select-strongest-tag-pair')!.accepts([ref('a')])).toBe(false);
    expect(buildBoardBatchPack(ctxWith({ boardHasTagPairs: true }).ctx).find((r) => r.id === 'select-strongest-tag-pair')!.accepts([ref('a')])).toBe(true);
  });

  it('run invokes selectStrongestTagPair (board-global)', () => {
    const h = ctxWith({ boardHasTagPairs: true });
    buildBoardBatchPack(h.ctx).find((r) => r.id === 'select-strongest-tag-pair')!.run([ref('a')]);
    expect(h.calls).toBe(1);
  });
});

describe('batchActionsAsNodeActions (right-click context-menu adapter)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  // A minimal fake pack: one minCount-1 row + one minCount-2 row. Each records the
  // refs its run received so we can assert the adapter forwards refsForMenu().
  function fakePack(): { pack: BatchActionCapability[]; runs: Record<string, NodeRef[][]> } {
    const runs: Record<string, NodeRef[][]> = { rot: [], align: [] };
    const pack: BatchActionCapability[] = [
      { id: 'rot', label: 'Rotate', icon: 'RotateCw', priority: 1, minCount: 1, accepts: () => true, run: (refs) => { runs.rot.push([...refs]); } },
      { id: 'align', label: 'Align', icon: 'AlignLeft', priority: 2, minCount: 2, accepts: () => true, run: (refs) => { runs.align.push([...refs]); } },
    ];
    return { pack, runs };
  }

  it('namespaces ids with `menu-` so they never collide with the bulk-bar ids', () => {
    const { pack } = fakePack();
    const out = batchActionsAsNodeActions(pack, () => [ref('a')]);
    expect(out.map((a) => a.id)).toEqual(['menu-rot', 'menu-align']);
    expect(out.map((a) => a.label)).toEqual(['Rotate', 'Align']);
  });

  it('gates on minCount: a minCount-2 action is hidden for a 1-ref menu, shown for 2', () => {
    const { pack } = fakePack();
    const one = batchActionsAsNodeActions(pack, () => [ref('a')]);
    const two = batchActionsAsNodeActions(pack, () => [ref('a'), ref('b')]);
    const accepts = (acts: ReturnType<typeof batchActionsAsNodeActions>, id: string) =>
      acts.find((a) => a.id === id)!.accepts(ref('a'));
    expect(accepts(one, 'menu-rot')).toBe(true); // minCount 1 → ok with 1
    expect(accepts(one, 'menu-align')).toBe(false); // minCount 2 → hidden with 1
    expect(accepts(two, 'menu-align')).toBe(true); // minCount 2 → shown with 2
  });

  it('run forwards the CURRENT refsForMenu() to the underlying batch action', () => {
    const { pack, runs } = fakePack();
    let refs = [ref('a')];
    const acts = batchActionsAsNodeActions(pack, () => refs);
    acts.find((a) => a.id === 'menu-rot')!.run!(ref('a'));
    expect(membersOfRefs(runs.rot[0])).toEqual(['a']);
    // refsForMenu is read at RUN time, not adapt time — a later selection flows through.
    refs = [ref('a'), ref('b')];
    acts.find((a) => a.id === 'menu-rot')!.run!(ref('a'));
    expect(membersOfRefs(runs.rot[1])).toEqual(['a', 'b']);
  });
});

describe('export-selection rows (#148 — 4th caller of boardToSvg)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });

  /** A ctx that records which export side-effect fired with which memberIds; every
   *  other method is a no-op so the pack builds. */
  function recordingCtx(): { ctx: BoardBatchContext; calls: Record<string, string[][]> } {
    const calls: Record<string, string[][]> = { svg: [], png: [], copy: [], isolate: [] };
    const noop = () => {};
    // Partial stub — this suite only exercises the export/isolate/frame rows, so it stubs
    // those fields and honestly casts the rest (matches every newer row-test stub). A strict
    // `: BoardBatchContext` annotation here would be a FALSE guarantee: vitest strips types
    // via esbuild, so a future missing field is silently accepted, not caught (audit P2).
    const ctx = {
      applyBatch: noop,
      primaryBundle: () => null,
      duplicateSelected: noop,
      deleteSelected: noop,
      groupSelected: noop,
      tagSelected: noop,
      spaceByGap: noop,
      selectSameKind: noop,
      selectSameTag: noop,
      selectSameFill: noop,
      selectFrameContents: noop,
      tidyFrameContents: noop,
      reorderFrame: noop,
      setFrameCaption: noop,
      pickFrameAspect: noop,
      fitFrameToContents: noop,
      anchorFrameCanMoveEarlier: false,
      anchorFrameCanMoveLater: false,
      anchorIsFrame: false,
      anchorHasTags: false,
      anchorHasFill: false,
      copyStyle: noop,
      pasteStyle: noop,
      hasStyleClipboard: false,
      savePreset: noop,
      openPresetPicker: noop,
      hasPresets: false,
      anyUnlockedSelected: true,
      anyLockedSelected: false,
      anyVisibleSelected: true,
      anyHiddenSelected: false,
      canIsolate: true,
      isolateSelection: (ids) => { calls.isolate.push([...ids]); },
      exportSelectionSvg: (ids) => { calls.svg.push([...ids]); },
      exportSelectionPng: (ids) => { calls.png.push([...ids]); },
      copySelectionPng: (ids) => { calls.copy.push([...ids]); },
    } as unknown as BoardBatchContext;
    return { ctx, calls };
  }

  it('the select-frame-contents row (#170) is gated on anchorIsFrame and delegates to ctx', () => {
    const calls: string[][] = [];
    const { ctx } = recordingCtx();
    const withFrame = { ...ctx, anchorIsFrame: true, selectFrameContents: (ids: string[]) => calls.push(ids) };
    const off = buildBoardBatchPack(ctx).find((r) => r.id === 'select-frame-contents');
    const on = buildBoardBatchPack(withFrame).find((r) => r.id === 'select-frame-contents');
    const refs = [{ family: 'group.board-item', parts: { member: 'F' } }] as unknown as Parameters<NonNullable<typeof off>['accepts']>[0];
    expect(off?.accepts(refs)).toBe(false); // anchor not a frame → hidden
    expect(on?.accepts(refs)).toBe(true); // anchor is a frame → shown
    on?.run(refs);
    expect(calls).toEqual([['F']]);
  });

  it('the tidy-frame-contents row (#173) is gated on anchorIsFrame and delegates to ctx', () => {
    const calls: string[][] = [];
    const { ctx } = recordingCtx();
    const withFrame = { ...ctx, anchorIsFrame: true, tidyFrameContents: (ids: string[]) => calls.push(ids) };
    const off = buildBoardBatchPack(ctx).find((r) => r.id === 'tidy-frame-contents');
    const on = buildBoardBatchPack(withFrame).find((r) => r.id === 'tidy-frame-contents');
    const refs = [{ family: 'group.board-item', parts: { member: 'F' } }] as unknown as Parameters<NonNullable<typeof off>['accepts']>[0];
    expect(off?.accepts(refs)).toBe(false); // anchor not a frame → hidden
    expect(on?.accepts(refs)).toBe(true); // anchor is a frame → shown
    on?.run(refs);
    expect(calls).toEqual([['F']]);
  });

  it('the set-frame-caption row (#176) is gated on anchorIsFrame and delegates to ctx', () => {
    const calls: string[][] = [];
    const { ctx } = recordingCtx();
    const withFrame = { ...ctx, anchorIsFrame: true, setFrameCaption: (ids: string[]) => calls.push(ids) };
    const off = buildBoardBatchPack(ctx).find((r) => r.id === 'set-frame-caption');
    const on = buildBoardBatchPack(withFrame).find((r) => r.id === 'set-frame-caption');
    const refs = [{ family: 'group.board-item', parts: { member: 'F' } }] as unknown as Parameters<NonNullable<typeof off>['accepts']>[0];
    expect(off?.accepts(refs)).toBe(false);
    expect(on?.accepts(refs)).toBe(true);
    on?.run(refs);
    expect(calls).toEqual([['F']]);
  });

  it('the set-frame-aspect row (#177) is gated on anchorIsFrame and delegates to ctx', () => {
    const calls: string[][] = [];
    const { ctx } = recordingCtx();
    const withFrame = { ...ctx, anchorIsFrame: true, pickFrameAspect: (ids: string[]) => calls.push(ids) };
    const off = buildBoardBatchPack(ctx).find((r) => r.id === 'set-frame-aspect');
    const on = buildBoardBatchPack(withFrame).find((r) => r.id === 'set-frame-aspect');
    const refs = [{ family: 'group.board-item', parts: { member: 'F' } }] as unknown as Parameters<NonNullable<typeof off>['accepts']>[0];
    expect(off?.accepts(refs)).toBe(false); // anchor not a frame → hidden
    expect(on?.accepts(refs)).toBe(true); // anchor is a frame → shown
    on?.run(refs);
    expect(calls).toEqual([['F']]);
  });

  it('the fit-frame-to-contents row (#178) is gated on anchorIsFrame and delegates to ctx', () => {
    const calls: string[][] = [];
    const { ctx } = recordingCtx();
    const withFrame = { ...ctx, anchorIsFrame: true, fitFrameToContents: (ids: string[]) => calls.push(ids) };
    const off = buildBoardBatchPack(ctx).find((r) => r.id === 'fit-frame-to-contents');
    const on = buildBoardBatchPack(withFrame).find((r) => r.id === 'fit-frame-to-contents');
    const refs = [{ family: 'group.board-item', parts: { member: 'F' } }] as unknown as Parameters<NonNullable<typeof off>['accepts']>[0];
    expect(off?.accepts(refs)).toBe(false); // anchor not a frame → hidden
    expect(on?.accepts(refs)).toBe(true); // anchor is a frame → shown
    on?.run(refs);
    expect(calls).toEqual([['F']]);
  });

  it('the reorder rows (#174) are gated on can-move flags and pass the direction', () => {
    const moves: Array<[string[], number]> = [];
    const { ctx } = recordingCtx();
    const withFrame = { ...ctx, anchorFrameCanMoveEarlier: true, anchorFrameCanMoveLater: true, reorderFrame: (ids: string[], dir: -1 | 1) => moves.push([ids, dir]) };
    const refs = [{ family: 'group.board-item', parts: { member: 'F' } }] as unknown as Parameters<NonNullable<ReturnType<typeof buildBoardBatchPack>[number]['accepts']>>[0];
    // Off by default (not a movable frame), on when the flags allow.
    expect(buildBoardBatchPack(ctx).find((r) => r.id === 'frame-move-earlier')?.accepts(refs)).toBe(false);
    expect(buildBoardBatchPack(ctx).find((r) => r.id === 'frame-move-later')?.accepts(refs)).toBe(false);
    const earlier = buildBoardBatchPack(withFrame).find((r) => r.id === 'frame-move-earlier');
    const later = buildBoardBatchPack(withFrame).find((r) => r.id === 'frame-move-later');
    expect(earlier?.accepts(refs)).toBe(true);
    expect(later?.accepts(refs)).toBe(true);
    earlier?.run(refs);
    later?.run(refs);
    expect(moves).toEqual([[['F'], -1], [['F'], 1]]);
  });

  it('exposes the three export rows, gated at minCount 1, accepting board items only', () => {
    const { ctx } = recordingCtx();
    const pack = buildBoardBatchPack(ctx);
    for (const id of ['export-selection-svg', 'export-selection-png', 'copy-selection-png']) {
      const row = pack.find((r) => r.id === id);
      expect(row, id).toBeTruthy();
      expect(row!.minCount).toBe(1);
      expect(row!.accepts([ref('a')])).toBe(true);
      expect(row!.accepts([{ family: 'other', parts: {} }])).toBe(false);
    }
  });

  it('each row delegates the RESOLVED member ids to its ctx side-effect', () => {
    const { ctx, calls } = recordingCtx();
    const pack = buildBoardBatchPack(ctx);
    const refs = [ref('a'), ref('b'), { family: 'other', parts: {} } as NodeRef];
    pack.find((r) => r.id === 'export-selection-svg')!.run!(refs);
    pack.find((r) => r.id === 'export-selection-png')!.run!(refs);
    pack.find((r) => r.id === 'copy-selection-png')!.run!(refs);
    expect(calls.svg[0]).toEqual(['a', 'b']); // foreign family stripped by membersOfRefs
    expect(calls.png[0]).toEqual(['a', 'b']);
    expect(calls.copy[0]).toEqual(['a', 'b']);
  });

  it('Isolate (#150) is gated by canIsolate and delegates the keep set', () => {
    const { ctx, calls } = recordingCtx();
    const gated = buildBoardBatchPack({ ...ctx, canIsolate: false });
    expect(gated.find((r) => r.id === 'isolate')!.accepts([ref('a')])).toBe(false);
    const on = buildBoardBatchPack({ ...ctx, canIsolate: true });
    const isolate = on.find((r) => r.id === 'isolate')!;
    expect(isolate.accepts([ref('a')])).toBe(true);
    isolate.run!([ref('a'), ref('b')]);
    expect(calls.isolate[0]).toEqual(['a', 'b']);
  });
});

describe('reorderZToOrder (#152 — Objects-panel drag-reorder)', () => {
  const orderOf = (g: ReturnType<typeof emptyGraph>) => readItems(g, PARENT).map((i) => i.memberId);

  it('restacks the board to an exact member order', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', x: 0, y: 0, w: 10, h: 10 },
      { id: 'c', x: 0, y: 0, w: 10, h: 10 },
    ]);
    expect(orderOf(g)).toEqual(['a', 'b', 'c']);
    const out = reorderZToOrder(g, PARENT, ['c', 'a', 'b']);
    expect(orderOf(out)).toEqual(['c', 'a', 'b']);
  });

  it('moves a single item to the top (its memberOrder becomes last)', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', x: 0, y: 0, w: 10, h: 10 },
      { id: 'c', x: 0, y: 0, w: 10, h: 10 },
    ]);
    // panel shows top-first [c,b,a]; drag a to the top → new top-first [a,c,b]
    // → bottom-first memberOrder = reverse = [b,c,a].
    const out = reorderZToOrder(g, PARENT, ['b', 'c', 'a']);
    expect(orderOf(out)).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op for the identity order and for a single item', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', x: 0, y: 0, w: 10, h: 10 },
    ]);
    expect(orderOf(reorderZToOrder(g, PARENT, ['a', 'b']))).toEqual(['a', 'b']);
    const one = graphWith([{ id: 'a', x: 0, y: 0, w: 10, h: 10 }]);
    expect(orderOf(reorderZToOrder(one, PARENT, ['a']))).toEqual(['a']);
  });
});

describe('setHidden (#149 — the visibility flag)', () => {
  it('sets and clears extra.hidden on the targeted members only', () => {
    let g = graphWith([
      { id: 'a', x: 0, y: 0, w: 100, h: 60 },
      { id: 'b', x: 200, y: 0, w: 100, h: 60 },
    ]);
    g = setHidden(g, PARENT, ['a'], true);
    const after = Object.fromEntries(readItems(g, PARENT).map((i) => [i.memberId, i.extra?.hidden]));
    expect(after.a).toBe(true);
    expect(after.b).toBeUndefined(); // untouched
    g = setHidden(g, PARENT, ['a'], false);
    expect(readItems(g, PARENT).find((i) => i.memberId === 'a')?.extra?.hidden).toBe(false);
  });

  it('is independent of lock — a locked item can still be hidden (orthogonal flags)', () => {
    let g = graphWith([{ id: 'a', x: 0, y: 0, w: 100, h: 60 }]);
    g = setLocked(g, PARENT, ['a'], true);
    g = setHidden(g, PARENT, ['a'], true);
    const a = readItems(g, PARENT).find((i) => i.memberId === 'a');
    expect(a?.extra?.locked).toBe(true);
    expect(a?.extra?.hidden).toBe(true);
  });
});

describe('Hide/Show rows (#149 — gated by visible/hidden selection)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  function ctxStub(): BoardBatchContext {
    const noop = () => {};
    return {
      applyBatch: noop, primaryBundle: () => null, duplicateSelected: noop, deleteSelected: noop,
      groupSelected: noop, tagSelected: noop, spaceByGap: noop, selectSameKind: noop, selectSameTag: noop,
      selectSameFill: noop, anchorHasTags: false, anchorHasFill: false, copyStyle: noop, pasteStyle: noop,
      hasStyleClipboard: false, savePreset: noop, openPresetPicker: noop, hasPresets: false,
      anyUnlockedSelected: true, anyLockedSelected: false, anyVisibleSelected: true, anyHiddenSelected: false,
      canIsolate: true, isolateSelection: noop,
      exportSelectionSvg: noop, exportSelectionPng: noop, copySelectionPng: noop,
    };
  }

  it('Hide shows only when something visible is selected; Show only when something hidden is', () => {
    const visiblePack = buildBoardBatchPack({ ...ctxStub(), anyVisibleSelected: true, anyHiddenSelected: false });
    const hide = visiblePack.find((r) => r.id === 'hide')!;
    const show = visiblePack.find((r) => r.id === 'show')!;
    expect(hide.accepts([ref('a')])).toBe(true);
    expect(show.accepts([ref('a')])).toBe(false);

    const hiddenPack = buildBoardBatchPack({ ...ctxStub(), anyVisibleSelected: false, anyHiddenSelected: true });
    expect(hiddenPack.find((r) => r.id === 'hide')!.accepts([ref('a')])).toBe(false);
    expect(hiddenPack.find((r) => r.id === 'show')!.accepts([ref('a')])).toBe(true);
  });

  it('Hide routes its mutation through applyBatch (one undoable batch)', () => {
    let batched = 0;
    const pack = buildBoardBatchPack({ ...ctxStub(), applyBatch: () => { batched++; } });
    pack.find((r) => r.id === 'hide')!.run!([ref('a')]);
    pack.find((r) => r.id === 'show')!.run!([ref('a')]);
    expect(batched).toBe(2);
  });
});

describe('reverseConnectors (#180) — swap a connector\'s endpoints, notes untouched', () => {
  const PARENT2: AddressRef = { family: 'test.board', parts: { board: 'b2' } };
  function scene() {
    let g = emptyGraph();
    // Two notes + a connector a→b + a plain note that must stay put.
    g = placeItem(g, PARENT2, { memberId: 'a', nodeRef: { family: 'test.item', parts: { id: 'a' } }, kind: 'note', x: 0, y: 0, w: 10, h: 10 });
    g = placeItem(g, PARENT2, { memberId: 'b', nodeRef: { family: 'test.item', parts: { id: 'b' } }, kind: 'note', x: 100, y: 0, w: 10, h: 10 });
    g = placeItem(g, PARENT2, { memberId: 'c', nodeRef: { family: 'test.item', parts: { id: 'c' } }, kind: 'connector', x: 0, y: 0, w: 1, h: 1, extra: { fromMemberId: 'a', toMemberId: 'b' } });
    return g;
  }
  const endpointsOf = (g: ReturnType<typeof emptyGraph>, id: string) => {
    const it = readItems(g, PARENT2).find((i) => i.memberId === id);
    return { from: it?.extra?.fromMemberId, to: it?.extra?.toMemberId };
  };

  it('swaps from/to on the selected connector', () => {
    const out = reverseConnectors(scene(), PARENT2, ['c']);
    expect(endpointsOf(out, 'c')).toEqual({ from: 'b', to: 'a' });
  });

  it('leaves non-connector members in the set untouched', () => {
    const out = reverseConnectors(scene(), PARENT2, ['a', 'c']);
    const a = readItems(out, PARENT2).find((i) => i.memberId === 'a')!;
    expect({ x: a.x, y: a.y }).toEqual({ x: 0, y: 0 }); // note a not reversed / moved
    expect(endpointsOf(out, 'c')).toEqual({ from: 'b', to: 'a' });
  });

  it('is a no-op when no selected member is a connector', () => {
    const out = reverseConnectors(scene(), PARENT2, ['a', 'b']);
    expect(endpointsOf(out, 'c')).toEqual({ from: 'a', to: 'b' }); // untouched
  });
});

describe('reverse-connector row (#180 — gated on anyConnectorSelected, routes via applyBatch)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  const stub = (over: Partial<BoardBatchContext>): BoardBatchContext =>
    ({ applyBatch: () => {}, anyConnectorSelected: false, ...over } as unknown as BoardBatchContext);
  it('shows only when a connector is selected and routes its mutation through applyBatch', () => {
    const off = buildBoardBatchPack(stub({ anyConnectorSelected: false })).find((r) => r.id === 'reverse-connector');
    expect(off?.accepts([ref('a')])).toBe(false);
    let batched = 0;
    const on = buildBoardBatchPack(stub({ anyConnectorSelected: true, applyBatch: () => { batched++; } })).find((r) => r.id === 'reverse-connector');
    expect(on?.accepts([ref('c')])).toBe(true);
    on?.run?.([ref('c')]);
    expect(batched).toBe(1);
  });
});

describe('newChainConnectors (#181) — chain a node selection, dedup existing links', () => {
  it('chains ordered ids into consecutive from→to pairs', () => {
    expect(newChainConnectors(['a', 'b', 'c'], new Set())).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);
  });

  it('skips a pair already linked in EITHER direction (no duplicate arrows)', () => {
    const existing = new Set([connectorPairKey('b', 'a')]); // b↔a already connected
    expect(newChainConnectors(['a', 'b', 'c'], existing)).toEqual([{ from: 'b', to: 'c' }]);
  });

  it('returns no pairs for fewer than two ids', () => {
    expect(newChainConnectors(['a'], new Set())).toEqual([]);
    expect(newChainConnectors([], new Set())).toEqual([]);
  });

  it('connectorPairKey is order-independent', () => {
    expect(connectorPairKey('x', 'y')).toBe(connectorPairKey('y', 'x'));
  });
});

describe('connect-selected row (#181 — gated on multipleNodesSelected, delegates to ctx)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  const stub = (over: Partial<BoardBatchContext>): BoardBatchContext =>
    ({ connectSelected: () => {}, multipleNodesSelected: false, ...over } as unknown as BoardBatchContext);
  it('shows only when ≥2 nodes are selected and delegates to ctx.connectSelected', () => {
    const off = buildBoardBatchPack(stub({ multipleNodesSelected: false })).find((r) => r.id === 'connect-selected');
    expect(off?.accepts([ref('a'), ref('b')])).toBe(false);
    let got: string[] | null = null;
    let gotTopology: unknown = null;
    const on = buildBoardBatchPack(stub({ multipleNodesSelected: true, connectSelected: (ids, topo) => { got = ids; gotTopology = topo; } })).find((r) => r.id === 'connect-selected');
    expect(on?.accepts([ref('a'), ref('b')])).toBe(true);
    expect(on?.minCount).toBe(2); // the bar needs ≥2 members for a chain (minCount, not accepts)
    on?.run?.([ref('a'), ref('b')]);
    expect(got).toEqual(['a', 'b']);
    expect(gotTopology).toBe(newChainConnectors); // the row carries the chain generator (L069)
  });
});

describe('newStarConnectors (#182) — hub→each other node, dedup existing links', () => {
  it('links the FIRST (hub) node to every other node', () => {
    expect(newStarConnectors(['h', 'a', 'b'], new Set())).toEqual([
      { from: 'h', to: 'a' },
      { from: 'h', to: 'b' },
    ]);
  });

  it('skips a spoke already linked in either direction', () => {
    const existing = new Set([connectorPairKey('a', 'h')]); // a↔h already linked
    expect(newStarConnectors(['h', 'a', 'b'], existing)).toEqual([{ from: 'h', to: 'b' }]);
  });

  it('returns no pairs for fewer than two ids', () => {
    expect(newStarConnectors(['h'], new Set())).toEqual([]);
    expect(newStarConnectors([], new Set())).toEqual([]);
  });
});

describe('connect-hub row (#182 — star topology, same gate + board method as chain)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  const stub = (over: Partial<BoardBatchContext>): BoardBatchContext =>
    ({ connectSelected: () => {}, multipleNodesSelected: false, ...over } as unknown as BoardBatchContext);
  it('shows only with ≥2 nodes and passes the STAR topology to ctx.connectSelected', () => {
    const off = buildBoardBatchPack(stub({ multipleNodesSelected: false })).find((r) => r.id === 'connect-hub');
    expect(off?.accepts([ref('a'), ref('b')])).toBe(false);
    let gotTopology: unknown = null;
    const on = buildBoardBatchPack(stub({ multipleNodesSelected: true, connectSelected: (_ids, topo) => { gotTopology = topo; } })).find((r) => r.id === 'connect-hub');
    expect(on?.accepts([ref('a'), ref('b')])).toBe(true);
    expect(on?.minCount).toBe(2);
    on?.run?.([ref('a'), ref('b')]);
    expect(gotTopology).toBe(newStarConnectors); // the row carries the star generator (L069)
  });
});

describe('newCycleConnectors (cont.20) — close the selection into a loop', () => {
  it('chains ordered ids AND closes last→first', () => {
    expect(newCycleConnectors(['a', 'b', 'c'], new Set())).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' }, // the closing edge — this is what distinguishes it from a chain
    ]);
  });

  it('an n=2 loop collapses to ONE undirected edge (b→a is the same pair as a→b)', () => {
    expect(newCycleConnectors(['a', 'b'], new Set())).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('skips edges already linked in either direction, including the closing edge', () => {
    const existing = new Set([connectorPairKey('c', 'a')]); // the loop-closing pair pre-exists
    expect(newCycleConnectors(['a', 'b', 'c'], existing)).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]); // no closing edge minted
  });

  it('returns no pairs for fewer than two ids', () => {
    expect(newCycleConnectors(['a'], new Set())).toEqual([]);
    expect(newCycleConnectors([], new Set())).toEqual([]);
  });
});

describe('newMeshConnectors (cont.20) — fully connect the selection (complete graph)', () => {
  it('links EVERY unordered pair exactly once', () => {
    expect(newMeshConnectors(['a', 'b', 'c'], new Set())).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ]); // 3 nodes → C(3,2)=3 edges
  });

  it('mints n·(n−1)/2 edges for n nodes (4 → 6)', () => {
    expect(newMeshConnectors(['a', 'b', 'c', 'd'], new Set())).toHaveLength(6);
  });

  it('skips pairs already linked (idempotent re-run adds nothing when complete)', () => {
    const all = new Set([connectorPairKey('a', 'b'), connectorPairKey('a', 'c'), connectorPairKey('b', 'c')]);
    expect(newMeshConnectors(['a', 'b', 'c'], all)).toEqual([]);
  });

  it('n=2 mesh is one edge (same as chain/star at that size); <2 → none', () => {
    expect(newMeshConnectors(['a', 'b'], new Set())).toEqual([{ from: 'a', to: 'b' }]);
    expect(newMeshConnectors(['a'], new Set())).toEqual([]);
  });
});

describe('connect-cycle / connect-mesh rows (cont.20 — 3rd + 4th topology over the ONE seam)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  const stub = (over: Partial<BoardBatchContext>): BoardBatchContext =>
    ({ connectSelected: () => {}, multipleNodesSelected: false, ...over } as unknown as BoardBatchContext);
  it('connect-cycle carries the cycle generator, gated on ≥2 nodes', () => {
    const off = buildBoardBatchPack(stub({ multipleNodesSelected: false })).find((r) => r.id === 'connect-cycle');
    expect(off?.accepts([ref('a'), ref('b')])).toBe(false);
    let topo: unknown = null;
    const on = buildBoardBatchPack(stub({ multipleNodesSelected: true, connectSelected: (_i, t) => { topo = t; } })).find((r) => r.id === 'connect-cycle');
    expect(on?.accepts([ref('a'), ref('b')])).toBe(true);
    on?.run?.([ref('a'), ref('b')]);
    expect(topo).toBe(newCycleConnectors);
  });
  it('connect-mesh carries the mesh generator, gated on ≥2 nodes', () => {
    let topo: unknown = null;
    const on = buildBoardBatchPack(stub({ multipleNodesSelected: true, connectSelected: (_i, t) => { topo = t; } })).find((r) => r.id === 'connect-mesh');
    expect(on?.accepts([ref('a'), ref('b')])).toBe(true);
    on?.run?.([ref('a'), ref('b')]);
    expect(topo).toBe(newMeshConnectors);
  });
});

describe('invertedNodeIds (#183) — the pure Select-Inverse primitive', () => {
  it('returns every node NOT in the selection, preserving order', () => {
    expect(invertedNodeIds(['a', 'b', 'c', 'd'], new Set(['b', 'd']))).toEqual(['a', 'c']);
  });

  it('returns all nodes when the selection is empty', () => {
    expect(invertedNodeIds(['a', 'b'], new Set())).toEqual(['a', 'b']);
  });

  it('returns none when every node is selected', () => {
    expect(invertedNodeIds(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
  });

  it('ignores selected ids that are not board nodes', () => {
    expect(invertedNodeIds(['a', 'b'], new Set(['z']))).toEqual(['a', 'b']);
  });
});

describe('invert-selection row (#183 — gated on hasUnselectedNodes, delegates to ctx)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  const stub = (over: Partial<BoardBatchContext>): BoardBatchContext =>
    ({ invertSelection: () => {}, hasUnselectedNodes: false, ...over } as unknown as BoardBatchContext);
  it('hides when nothing is left to invert to and delegates the members otherwise', () => {
    const off = buildBoardBatchPack(stub({ hasUnselectedNodes: false })).find((r) => r.id === 'invert-selection');
    expect(off?.accepts([ref('a')])).toBe(false);
    let got: string[] | null = null;
    const on = buildBoardBatchPack(stub({ hasUnselectedNodes: true, invertSelection: (ids) => { got = ids; } })).find((r) => r.id === 'invert-selection');
    expect(on?.accepts([ref('a')])).toBe(true);
    expect(on?.minCount).toBe(1);
    on?.run?.([ref('a'), ref('b')]);
    expect(got).toEqual(['a', 'b']);
  });
});

describe('branchMemberIds (#186) — the root plus its whole connector-subtree', () => {
  const node = (memberId: string): BoardItem =>
    ({ memberId, kind: 'note', text: memberId, x: 0, y: 0, w: 10, h: 10, extra: {} } as unknown as BoardItem);
  const edge = (from: string, to: string): BoardItem =>
    ({ memberId: `c-${from}-${to}`, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

  it('leads with the root, then every descendant', () => {
    const items = [node('r'), node('a'), node('b'), node('g'), edge('r', 'a'), edge('r', 'b'), edge('a', 'g')];
    const branch = branchMemberIds(items, 'r');
    expect(branch[0]).toBe('r');
    expect([...branch].sort()).toEqual(['a', 'b', 'g', 'r']);
  });

  it('returns just the root for a leaf', () => {
    expect(branchMemberIds([node('r'), node('x')], 'r')).toEqual(['r']);
  });

  it('scopes the traversal to a subset of edges (kind-scoped downstream)', () => {
    // r --depends-on--> a --depends-on--> g ; r --blocks--> b. Following ONLY depends-on edges
    // from r reaches a + g (the dependency chain), NEVER b (a blocks edge). No filter = all edges.
    const dep = (from: string, to: string): BoardItem =>
      ({ memberId: `c-${from}-${to}`, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to, relationKind: 'depends-on' } } as unknown as BoardItem);
    const blk = (from: string, to: string): BoardItem =>
      ({ memberId: `c-${from}-${to}`, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to, relationKind: 'blocks' } } as unknown as BoardItem);
    const items = [node('r'), node('a'), node('b'), node('g'), dep('r', 'a'), dep('a', 'g'), blk('r', 'b')];
    const onlyDepends = (c: BoardItem) => c.extra?.relationKind === 'depends-on';
    expect([...branchMemberIds(items, 'r', onlyDepends)].sort()).toEqual(['a', 'g', 'r']); // b excluded
    expect([...branchMemberIds(items, 'r')].sort()).toEqual(['a', 'b', 'g', 'r']); // no filter → all
  });

  it('upstreamMemberIds walks edges BACKWARD (the transitive ancestors), also kind-scopable', () => {
    // r --> a --> g (depends-on), x --> g (blocks). Upstream of g = everything that leads INTO g.
    const dep = (from: string, to: string): BoardItem =>
      ({ memberId: `c-${from}-${to}`, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to, relationKind: 'depends-on' } } as unknown as BoardItem);
    const blk = (from: string, to: string): BoardItem =>
      ({ memberId: `c-${from}-${to}`, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to, relationKind: 'blocks' } } as unknown as BoardItem);
    const items = [node('r'), node('a'), node('g'), node('x'), dep('r', 'a'), dep('a', 'g'), blk('x', 'g')];
    // Upstream of g, all edges: g's ancestors are a, r (via depends-on) and x (via blocks).
    expect([...upstreamMemberIds(items, 'g')].sort()).toEqual(['a', 'g', 'r', 'x']);
    // Kind-scoped to depends-on: only a, r (x's blocks edge is skipped).
    const onlyDepends = (c: BoardItem) => c.extra?.relationKind === 'depends-on';
    expect([...upstreamMemberIds(items, 'g', onlyDepends)].sort()).toEqual(['a', 'g', 'r']);
    // Downstream of g is empty (g is a sink) — proves direction is genuinely reversed.
    expect(branchMemberIds(items, 'g')).toEqual(['g']);
  });
});

describe('mindMapNonRootIds (#191) — every non-root node (indegree ≥ 1) to fold', () => {
  const node = (memberId: string): BoardItem =>
    ({ memberId, kind: 'note', text: memberId, x: 0, y: 0, w: 10, h: 10, extra: {} } as unknown as BoardItem);
  const edge = (from: string, to: string): BoardItem =>
    ({ memberId: `c-${from}-${to}`, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

  it('returns every node with an incoming connector, excluding the roots', () => {
    // r → a → g, r → b : roots {r}; non-roots {a, b, g}
    const items = [node('r'), node('a'), node('b'), node('g'), edge('r', 'a'), edge('r', 'b'), edge('a', 'g')];
    expect(mindMapNonRootIds(items).sort()).toEqual(['a', 'b', 'g']);
  });

  it('returns [] for a board with no connectors (nothing to fold)', () => {
    expect(mindMapNonRootIds([node('x'), node('y')])).toEqual([]);
  });

  it('ignores a connector endpoint that is not a real node', () => {
    expect(mindMapNonRootIds([node('r'), edge('r', 'ghost')])).toEqual([]);
  });
});

describe('select-branch row (#186 — gated on the anchor having a subtree)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  const stub = (over: Partial<BoardBatchContext>): BoardBatchContext =>
    ({ selectBranch: () => {}, anchorHasVisibleDescendants: false, anchorHasHiddenDescendants: false, ...over } as unknown as BoardBatchContext);
  it('hides when the anchor has no descendants at all', () => {
    const off = buildBoardBatchPack(stub({})).find((r) => r.id === 'select-branch');
    expect(off?.accepts([ref('a')])).toBe(false);
  });
  it('shows for a HIDDEN subtree too and delegates the members to ctx.selectBranch', () => {
    let got: string[] | null = null;
    const on = buildBoardBatchPack(stub({ anchorHasHiddenDescendants: true, selectBranch: (ids) => { got = ids; } })).find((r) => r.id === 'select-branch');
    expect(on?.accepts([ref('a')])).toBe(true);
    expect(on?.minCount).toBe(1);
    on?.run?.([ref('a'), ref('b')]);
    expect(got).toEqual(['a', 'b']);
  });
});

describe('mindMapOutline (#184) — serialize the connector tree to indented lines', () => {
  // A tiny board factory: node at (x,y) with text; connector from→to.
  const node = (memberId: string, text: string, x: number, y: number): BoardItem =>
    ({ memberId, kind: 'note', text, x, y, w: 100, h: 40, extra: {} } as unknown as BoardItem);
  const edge = (from: string, to: string): BoardItem =>
    ({ memberId: `c-${from}-${to}`, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

  it('walks root→children depth-first, ordered top-to-bottom by y', () => {
    const items = [
      node('root', 'Root', 0, 0),
      node('b', 'Beta', 0, 200), // lower on the board → second sibling
      node('a', 'Alpha', 0, 100), // higher → first sibling
      edge('root', 'a'),
      edge('root', 'b'),
    ];
    expect(mindMapOutline(items, ['root', 'a', 'b'])).toEqual([
      { depth: 0, text: 'Root', memberId: 'root' },
      { depth: 1, text: 'Alpha', memberId: 'a' },
      { depth: 1, text: 'Beta', memberId: 'b' },
    ]);
  });

  it('nests grandchildren one level deeper', () => {
    const items = [
      node('r', 'R', 0, 0),
      node('c', 'C', 0, 100),
      node('g', 'G', 0, 200),
      edge('r', 'c'),
      edge('c', 'g'),
    ];
    expect(mindMapOutline(items, ['r', 'c', 'g'])).toEqual([
      { depth: 0, text: 'R', memberId: 'r' },
      { depth: 1, text: 'C', memberId: 'c' },
      { depth: 2, text: 'G', memberId: 'g' },
    ]);
  });

  it('collapses whitespace and falls back to (untitled) for blank text', () => {
    const items = [
      node('r', '  Multi\n line ', 0, 0),
      node('c', '   ', 0, 100),
      edge('r', 'c'),
    ];
    expect(mindMapOutline(items, ['r', 'c'])).toEqual([
      { depth: 0, text: 'Multi line', memberId: 'r' },
      { depth: 1, text: '(untitled)', memberId: 'c' },
    ]);
  });

  it('emits a shared (DAG) node once and is cycle-safe', () => {
    const items = [
      node('r', 'R', 0, 0),
      node('a', 'A', 0, 100),
      node('b', 'B', 0, 200),
      edge('r', 'a'),
      edge('r', 'b'),
      edge('a', 'b'), // b reachable via two parents → still emitted once
      edge('b', 'a'), // back-edge → no infinite loop
    ];
    const lines = mindMapOutline(items, ['r', 'a', 'b']);
    const texts = lines.map((l) => l.text).sort();
    expect(texts).toEqual(['A', 'B', 'R']);
  });

  it('returns [] when no selected nodes exist', () => {
    expect(mindMapOutline([], [])).toEqual([]);
  });
});

describe('graph outline round-trip (#193) — mindMapOutline ∘ planOutlineMindMap are inverses', () => {
  const node = (memberId: string, text: string, x: number, y: number): BoardItem =>
    ({ memberId, kind: 'note', text, x, y, w: 100, h: 40, extra: {} } as unknown as BoardItem);
  const edge = (from: string, to: string): BoardItem =>
    ({ memberId: `c-${from}-${to}`, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

  it('a mind-map exported to an outline re-imports to the SAME depth/text tree', () => {
    // Root → {Health → Run, Work}: the whole graph → outline → planned graph must preserve
    // the tree exactly (the #184 export and #185 import are true inverses at the graph level).
    const items = [
      node('root', 'Goals', 0, 0),
      node('h', 'Health', 0, 100),
      node('run', 'Run', 0, 150),
      node('w', 'Work', 0, 300),
      edge('root', 'h'),
      edge('h', 'run'),
      edge('root', 'w'),
    ];
    const memberIds = ['root', 'h', 'run', 'w'];

    // #184: graph → outline lines.
    const lines = mindMapOutline(items, memberIds);
    expect(lines.map((l) => `${l.depth}:${l.text}`)).toEqual(['0:Goals', '1:Health', '2:Run', '1:Work']);

    // #184 render → #185 plan: outline text → a fresh tree.
    const plan = planOutlineMindMap(outlineToMarkdown(lines));

    // The regenerated tree has the SAME depth/text sequence — round-trip lossless.
    expect(plan.nodes.map((n) => `${n.depth}:${n.text}`)).toEqual(['0:Goals', '1:Health', '2:Run', '1:Work']);
    // …and the same edge topology (parent→child), by index: Goals→Health, Health→Run, Goals→Work.
    const label = (i: number) => plan.nodes[i].text;
    expect(plan.edges.map((e) => `${label(e.from)}→${label(e.to)}`)).toEqual([
      'Goals→Health',
      'Health→Run',
      'Goals→Work',
    ]);
  });
});

describe('outlineToMarkdown (#184) — render lines as a bullet list', () => {
  it('indents two spaces per depth', () => {
    expect(
      outlineToMarkdown([
        { depth: 0, text: 'Root' },
        { depth: 1, text: 'Child' },
        { depth: 2, text: 'Leaf' },
      ]),
    ).toBe('- Root\n  - Child\n    - Leaf');
  });
});

describe('parseOutline (#185) — recover depth from indentation', () => {
  it('parses two-space-per-depth Markdown bullets (round-trips outlineToMarkdown)', () => {
    expect(parseOutline('- Root\n  - Child\n    - Leaf')).toEqual([
      { depth: 0, text: 'Root' },
      { depth: 1, text: 'Child' },
      { depth: 2, text: 'Leaf' },
    ]);
  });

  it('treats siblings at the same indent as the same depth and dedents correctly', () => {
    expect(parseOutline('- A\n  - B\n  - C\n- D')).toEqual([
      { depth: 0, text: 'A' },
      { depth: 1, text: 'B' },
      { depth: 1, text: 'C' },
      { depth: 0, text: 'D' },
    ]);
  });

  it('skips blank lines and strips assorted bullet markers', () => {
    expect(parseOutline('* One\n\n\t+ Two\n\t• Three')).toEqual([
      { depth: 0, text: 'One' },
      { depth: 1, text: 'Two' },
      { depth: 1, text: 'Three' },
    ]);
  });

  it('returns [] for empty or whitespace-only text', () => {
    expect(parseOutline('')).toEqual([]);
    expect(parseOutline('   \n\n  ')).toEqual([]);
  });
});

describe('outlineParents (#185) — link each line to its nearest shallower ancestor', () => {
  it('points children at their parent index and roots at -1', () => {
    const lines = parseOutline('- A\n  - B\n    - C\n  - D\n- E');
    // A(0) root, B(1)->A, C(2)->B, D(3)->A (ascended past C), E(4) root
    expect(outlineParents(lines)).toEqual([-1, 0, 1, 0, -1]);
  });
});

describe('planOutlineMindMap (#185) — parse + link + tidy layout into mint-ready data', () => {
  it('emits a node per line and a parent→child edge per non-root', () => {
    const plan = planOutlineMindMap('- Root\n  - A\n  - B');
    expect(plan.nodes.map((n) => n.text)).toEqual(['Root', 'A', 'B']);
    expect(plan.edges).toEqual([
      { from: 0, to: 1 },
      { from: 0, to: 2 },
    ]);
    // Root sits left of its children (tidy tree lays depth along x).
    expect(plan.nodes[0].x).toBeLessThan(plan.nodes[1].x);
    expect(plan.nodes[0].x).toBeLessThan(plan.nodes[2].x);
  });

  it('round-trips a mind-map through outlineToMarkdown → parseOutline', () => {
    const md = outlineToMarkdown([
      { depth: 0, text: 'Goals' },
      { depth: 1, text: 'Health' },
      { depth: 2, text: 'Run' },
      { depth: 1, text: 'Work' },
    ]);
    expect(planOutlineMindMap(md).nodes.map((n) => `${n.depth}:${n.text}`)).toEqual([
      '0:Goals',
      '1:Health',
      '2:Run',
      '1:Work',
    ]);
  });

  it('stacks a flat list vertically (no tree → no overlap) and has no edges', () => {
    const plan = planOutlineMindMap('- One\n- Two\n- Three');
    expect(plan.edges).toEqual([]);
    expect(plan.nodes[0].y).toBeLessThan(plan.nodes[1].y);
    expect(plan.nodes[1].y).toBeLessThan(plan.nodes[2].y);
  });

  it('returns empty plan for empty text', () => {
    expect(planOutlineMindMap('')).toEqual({ nodes: [], edges: [] });
  });
});

describe('copy-outline row (#184 — gated on selectionHasConnectors, delegates to ctx)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  const stub = (over: Partial<BoardBatchContext>): BoardBatchContext =>
    ({ copyOutline: () => {}, selectionHasConnectors: false, ...over } as unknown as BoardBatchContext);
  it('appears only with a real tree and delegates the members to ctx.copyOutline', () => {
    const off = buildBoardBatchPack(stub({ selectionHasConnectors: false })).find((r) => r.id === 'copy-outline');
    expect(off?.accepts([ref('a'), ref('b')])).toBe(false);
    let got: string[] | null = null;
    const on = buildBoardBatchPack(stub({ selectionHasConnectors: true, copyOutline: (ids) => { got = ids; } })).find((r) => r.id === 'copy-outline');
    expect(on?.accepts([ref('a'), ref('b')])).toBe(true);
    expect(on?.minCount).toBe(2);
    on?.run?.([ref('a'), ref('b')]);
    expect(got).toEqual(['a', 'b']);
  });
});

describe('arrangeByFacetLabeled — Group-by-field materialises labelled group areas (§9.1)', () => {
  // Place notes carrying an `extra.tag` (and optionally extra.stage) so a simple keyOf can cluster.
  function tagged(boxes: ReadonlyArray<{ id: string; tag: string; stage?: string }>) {
    let g = emptyGraph();
    let i = 0;
    for (const b of boxes) {
      g = placeItem(g, PARENT, {
        memberId: b.id,
        nodeRef: { family: 'test.item', parts: { id: b.id } },
        kind: 'note',
        x: i * 10,
        y: i * 10,
        w: 120,
        h: 60,
        extra: { tag: b.tag, ...(b.stage ? { stage: b.stage } : {}) },
      });
      i += 1;
    }
    return g;
  }
  const tagOf = (it: { extra?: Record<string, unknown> }) => String(it.extra?.tag ?? '');
  const stageOf = (it: { extra?: Record<string, unknown> }) => String(it.extra?.stage ?? '');
  const headings = (g: ReturnType<typeof emptyGraph>) =>
    readItems(g, PARENT).filter(itemIsRegionHeading);
  const realItems = (g: ReturnType<typeof emptyGraph>) =>
    readItems(g, PARENT).filter((it) => !itemIsRegionHeading(it));

  it('drops one labelled heading per cluster, with the "label · N" text, above the items', () => {
    const g = tagged([
      { id: 'a1', tag: 'ideas' },
      { id: 'a2', tag: 'ideas' },
      { id: 'b1', tag: 'done' },
    ]);
    const out = arrangeByFacetLabeled(g, PARENT, ['a1', 'a2', 'b1'], BOARD_GRID, tagOf, { facetId: 'tag' });
    const hs = headings(out);
    // One heading per distinct tag, sorted ascending: 'done' then 'ideas'.
    expect(hs.map((h) => h.text)).toEqual(['done · 1', 'ideas · 2']);
    // Every heading carries the self-describing DATA + a deterministic id.
    expect(hs.every((h) => h.memberId.startsWith(REGION_HEADING_PREFIX) && h.extra?.regionHeading === true)).toBe(true);
    // Each cluster's items sit BELOW their heading (the reserved band).
    for (const h of hs) {
      const key = String(h.extra?.groupKey);
      const members = realItems(out).filter((it) => tagOf(it) === key);
      expect(members.every((m) => m.y >= h.y + h.h)).toBe(true);
    }
  });

  it('re-arranging by a DIFFERENT facet REPLACES the headings (no accumulation, no stale labels)', () => {
    const g = tagged([
      { id: 'a1', tag: 'ideas', stage: 'todo' },
      { id: 'a2', tag: 'done', stage: 'todo' },
      { id: 'a3', tag: 'done', stage: 'doing' },
    ]);
    const byTag = arrangeByFacetLabeled(g, PARENT, ['a1', 'a2', 'a3'], BOARD_GRID, tagOf, { facetId: 'tag' });
    expect(headings(byTag).map((h) => h.extra?.regionFacet)).toEqual(['tag', 'tag']); // done, ideas

    // Now group the SAME board by a different facet — the old tag headings must be gone.
    const byStage = arrangeByFacetLabeled(byTag, PARENT, ['a1', 'a2', 'a3'], BOARD_GRID, stageOf, { facetId: 'stage' });
    const hs = headings(byStage);
    expect(hs.every((h) => h.extra?.regionFacet === 'stage')).toBe(true); // ONLY stage headings survive
    expect(hs.map((h) => h.text).sort()).toEqual(['doing · 1', 'todo · 2']);
    // Real items are unchanged in count (headings never get re-clustered as items).
    expect(realItems(byStage).map((i) => i.memberId).sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('is idempotent: grouping by the same facet twice yields the same headings (no growth)', () => {
    const g = tagged([
      { id: 'a1', tag: 'x' },
      { id: 'a2', tag: 'y' },
    ]);
    const once = arrangeByFacetLabeled(g, PARENT, ['a1', 'a2'], BOARD_GRID, tagOf, { facetId: 'tag' });
    const twice = arrangeByFacetLabeled(once, PARENT, readItems(once, PARENT).map((i) => i.memberId), BOARD_GRID, tagOf, { facetId: 'tag' });
    expect(headings(twice).map((h) => h.text)).toEqual(['x · 1', 'y · 1']); // exactly 2, not 4
    expect(realItems(twice).map((i) => i.memberId).sort()).toEqual(['a1', 'a2']);
  });

  it('uses the emptyLabel for the no-facet pile', () => {
    const g = tagged([
      { id: 'a1', tag: 'keep' },
      { id: 'a2', tag: '' },
      { id: 'a3', tag: '' },
    ]);
    const out = arrangeByFacetLabeled(g, PARENT, ['a1', 'a2', 'a3'], BOARD_GRID, tagOf, { facetId: 'tag', emptyLabel: 'Untagged' });
    expect(headings(out).map((h) => h.text)).toContain('Untagged · 2');
  });

  it('a labelMap renames the headings (used by Group-by-marker/shape → glyph/name labels, not raw ids)', () => {
    const g = tagged([
      { id: 'a1', tag: 'check' },
      { id: 'a2', tag: 'check' },
      { id: 'a3', tag: 'star' },
    ]);
    // Reuse the SAME MARKER_FACET_LABELS the 'Group by marker' facet row injects.
    const out = arrangeByFacetLabeled(g, PARENT, ['a1', 'a2', 'a3'], BOARD_GRID, tagOf, { facetId: 'marker', labelMap: MARKER_FACET_LABELS });
    // keys sort ascending ('check' < 'star'); each heading shows the readable glyph+name, not the id.
    expect(headings(out).map((h) => h.text)).toEqual(['✓ Check · 2', '★ Star · 1']);
  });
});

describe('arrangeByMatrixLabeled — the 2-facet MATRIX/cross-tab (§9.3, cont.19)', () => {
  // Notes carrying two facet extras: keyX = extra.ax, keyY = extra.ay.
  function celled(rows: ReadonlyArray<{ id: string; ax: string; ay: string }>) {
    let g = emptyGraph();
    let i = 0;
    for (const b of rows) {
      g = placeItem(g, PARENT, { memberId: b.id, nodeRef: { family: 'test.item', parts: { id: b.id } }, kind: 'note', x: i * 10, y: i * 10, w: 100, h: 60, extra: { ax: b.ax, ay: b.ay } });
      i += 1;
    }
    return g;
  }
  const axOf = (it: { extra?: Record<string, unknown> }) => String(it.extra?.ax ?? '');
  const ayOf = (it: { extra?: Record<string, unknown> }) => String(it.extra?.ay ?? '');
  const headings = (g: ReturnType<typeof emptyGraph>) => readItems(g, PARENT).filter(itemIsRegionHeading);
  const realItems = (g: ReturnType<typeof emptyGraph>) => readItems(g, PARENT).filter((it) => !itemIsRegionHeading(it));

  it('lays items into a 2×2 cross-tab and drops one labelled header per column + per row', () => {
    const g = celled([
      { id: 'a', ax: 'u1', ay: 'i1' }, { id: 'b', ax: 'u0', ay: 'i1' },
      { id: 'c', ax: 'u1', ay: 'i0' }, { id: 'd', ax: 'u0', ay: 'i0' },
    ]);
    const out = arrangeByMatrixLabeled(g, PARENT, ['a', 'b', 'c', 'd'], axOf, ayOf, BOARD_GRID, { facetIdX: 'ax', facetIdY: 'ay' });
    const pos = Object.fromEntries(realItems(out).map((i) => [i.memberId, i]));
    // Column identity by x (u0 left of u1); row identity by y (i0 above i1).
    expect(pos.b.x).toBe(pos.d.x); // u0 column
    expect(pos.a.x).toBe(pos.c.x); // u1 column
    expect(pos.a.x).toBeGreaterThan(pos.b.x);
    expect(pos.c.y).toBe(pos.d.y); // i0 row
    expect(pos.a.y).toBe(pos.b.y); // i1 row
    expect(pos.a.y).toBeGreaterThan(pos.c.y);
    // 2 column headers + 2 row headers, each "label · N".
    const hs = headings(out).map((h) => h.text).sort();
    expect(hs).toEqual(['i0 · 2', 'i1 · 2', 'u0 · 2', 'u1 · 2']);
  });

  it('re-running (even switching to a 1-D group) self-cleans the matrix headers — no accumulation', () => {
    const g = celled([{ id: 'a', ax: 'u1', ay: 'i1' }, { id: 'b', ax: 'u0', ay: 'i0' }]);
    const once = arrangeByMatrixLabeled(g, PARENT, ['a', 'b'], axOf, ayOf, BOARD_GRID, { facetIdX: 'ax', facetIdY: 'ay' });
    expect(headings(once)).toHaveLength(4); // 2 cols + 2 rows
    // Re-run over the whole board (headers included in the ids): still exactly 4, never 8.
    const twice = arrangeByMatrixLabeled(once, PARENT, realItems(once).map((i) => i.memberId), axOf, ayOf, BOARD_GRID, { facetIdX: 'ax', facetIdY: 'ay' });
    expect(headings(twice)).toHaveLength(4);
    expect(realItems(twice).map((i) => i.memberId).sort()).toEqual(['a', 'b']);
  });

  it('labelMapX renames column headers (reuses the SAME MARKER_FACET_LABELS as Group-by-marker)', () => {
    const g = celled([{ id: 'a', ax: 'check', ay: 'red' }, { id: 'b', ax: 'star', ay: 'red' }]);
    const out = arrangeByMatrixLabeled(g, PARENT, ['a', 'b'], axOf, ayOf, BOARD_GRID, { facetIdX: 'marker', facetIdY: 'fill', labelMapX: MARKER_FACET_LABELS });
    const texts = headings(out).map((h) => h.text);
    expect(texts).toContain('✓ Check · 1');
    expect(texts).toContain('★ Star · 1');
    expect(texts).toContain('red · 2'); // one row header, both items
  });

  it('both matrix rows are registered in the board batch pack', () => {
    const stub = { anyUnlockedSelected: true } as unknown as BoardBatchContext;
    const rowIds = buildBoardBatchPack(stub).map((r) => r.id);
    expect(rowIds).toContain('arrange-matrix-marker-fill');
    expect(rowIds).toContain('arrange-matrix-kind-tag');
  });
});

describe('spreadOutOverlaps — un-stack a pile, preserve rough layout (§9.4, cont.22)', () => {
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap: number) => {
    const sepX = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) >= a.w / 2 + b.w / 2 + gap - 1e-6;
    const sepY = Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) >= a.h / 2 + b.h / 2 + gap - 1e-6;
    return !(sepX || sepY);
  };
  const piled = (rows: ReadonlyArray<{ id: string; x: number; y: number; locked?: boolean }>) => {
    let g = emptyGraph();
    for (const b of rows) {
      g = placeItem(g, PARENT, { memberId: b.id, nodeRef: { family: 'test.item', parts: { id: b.id } }, kind: 'note', x: b.x, y: b.y, w: 100, h: 60, extra: b.locked ? { locked: true } : {} });
    }
    return g;
  };

  it('separates a stack of overlapping notes so no pair collides', () => {
    const g = piled([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 8 }, { id: 'c', x: 20, y: 16 }]);
    const out = spreadOutOverlaps(g, PARENT, ['a', 'b', 'c'], 12);
    const items = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, i]));
    for (const [x, y] of [['a', 'b'], ['a', 'c'], ['b', 'c']] as const) {
      expect(overlap(items[x], items[y], 12)).toBe(false);
    }
  });

  it('LEAVES a non-overlapping selection exactly in place (minimal movement)', () => {
    const g = piled([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 400, y: 0 }]);
    const out = spreadOutOverlaps(g, PARENT, ['a', 'b'], 12);
    const items = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, i]));
    expect(items.a).toMatchObject({ x: 0, y: 0 });
    expect(items.b).toMatchObject({ x: 400, y: 0 });
  });

  it('a LOCKED item is an immovable anchor (stays put); movers flow around it, no collision', () => {
    const g = piled([{ id: 'anchor', x: 0, y: 0, locked: true }, { id: 'm', x: 15, y: 10 }]);
    const out = spreadOutOverlaps(g, PARENT, ['anchor', 'm'], 12);
    const items = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, i]));
    expect(items.anchor).toMatchObject({ x: 0, y: 0 }); // locked → never moves
    expect(items.m.x !== 15 || items.m.y !== 10).toBe(true); // the mover shifted off
    expect(overlap(items.anchor, items.m, 12)).toBe(false);
  });

  it('<2 items is a no-op; connectors are ignored', () => {
    const g = piled([{ id: 'a', x: 0, y: 0 }]);
    expect(spreadOutOverlaps(g, PARENT, ['a'], 12)).toBe(g);
  });

  it('the Spread-out row is registered, gated on ≥2 nodes', () => {
    const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
    const stub = (over: Partial<BoardBatchContext>): BoardBatchContext => ({ applyBatch: () => {}, multipleNodesSelected: false, ...over } as unknown as BoardBatchContext);
    const row = buildBoardBatchPack(stub({ multipleNodesSelected: true })).find((r) => r.id === 'spread-out');
    expect(row).toBeTruthy();
    expect(row?.minCount).toBe(2);
    expect(row?.accepts([ref('a'), ref('b')])).toBe(true);
    expect(buildBoardBatchPack(stub({ multipleNodesSelected: false })).find((r) => r.id === 'spread-out')?.accepts([ref('a'), ref('b')])).toBe(false);
  });
});

describe('recolorSelectionToPalette — apply a colour theme (§9.5, cont.23)', () => {
  const notes = (rows: ReadonlyArray<{ id: string; x: number; y: number; fill?: string }>) => {
    let g = emptyGraph();
    for (const b of rows) {
      g = placeItem(g, PARENT, { memberId: b.id, nodeRef: { family: 'test.item', parts: { id: b.id } }, kind: 'note', x: b.x, y: b.y, w: 100, h: 60, extra: b.fill ? { visualLayerStack: seededFillStack(b.fill) } : {} });
    }
    return g;
  };

  it('cycles the palette across the selection in READING ORDER (y then x), not member order', () => {
    // Placed out of reading order; a=(0,200), b=(0,0), c=(0,100) → reading order b,c,a.
    const g = notes([{ id: 'a', x: 0, y: 200 }, { id: 'b', x: 0, y: 0 }, { id: 'c', x: 0, y: 100 }]);
    const pal = BOARD_PALETTES[0]; // sunset
    const out = recolorSelectionToPalette(g, PARENT, ['a', 'b', 'c'], pal, cycleAssign);
    const fill = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, itemFillColor(i)]));
    expect(fill.b).toBe(pal.colors[0]); // first in reading order
    expect(fill.c).toBe(pal.colors[1]);
    expect(fill.a).toBe(pal.colors[2]);
  });

  it('paints through setStackFill so the colour reads back via itemFillColor (SSOT)', () => {
    const g = notes([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 100 }]);
    const out = recolorSelectionToPalette(g, PARENT, ['a', 'b'], BOARD_PALETTES[1], cycleAssign);
    for (const i of readItems(out, PARENT)) expect(itemFillColor(i)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('nearestHueAssign harmonises EXISTING colours into the theme (a red note → the palette red)', () => {
    const rgb = { id: 'rgb', label: 'RGB', colors: ['#ff0000', '#00ff00', '#0000ff'] };
    const g = notes([{ id: 'r', x: 0, y: 0, fill: '#dd1111' }, { id: 'b', x: 0, y: 100, fill: '#1122ee' }]);
    const out = recolorSelectionToPalette(g, PARENT, ['r', 'b'], rgb, nearestHueAssign);
    const fill = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, itemFillColor(i)]));
    expect(fill.r).toBe('#ff0000'); // reddish → palette red
    expect(fill.b).toBe('#0000ff'); // bluish → palette blue
  });

  it('connectors + region headings are never recoloured', () => {
    let g = notes([{ id: 'a', x: 0, y: 0 }]);
    g = placeItem(g, PARENT, { memberId: 'c1', nodeRef: { family: 'test.item', parts: { id: 'c1' } }, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'a' } });
    const out = recolorSelectionToPalette(g, PARENT, ['a', 'c1'], BOARD_PALETTES[0], cycleAssign);
    const conn = readItems(out, PARENT).find((i) => i.memberId === 'c1');
    expect(conn?.extra?.visualLayerStack).toBeUndefined(); // connector untouched
  });

  it('every palette generates a registered "Palette: X" row (catalog-driven, not hand-written)', () => {
    const stub = { multipleNodesSelected: true, applyBatch: () => {} } as unknown as BoardBatchContext;
    const rowIds = buildBoardBatchPack(stub).map((r) => r.id);
    for (const pal of BOARD_PALETTES) expect(rowIds).toContain(`palette-${pal.id}`);
  });
});

describe('Color by facet (cont.42) — recolorSelectionByFacet + the DATA-generated catalog rows', () => {
  type G = ReturnType<typeof emptyGraph>;
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });

  it('paints every item SHARING a tag the SAME palette colour; distinct tags → distinct colours', () => {
    // a & c share "idea", b is "risk". Colours are assigned in ALPHABETICAL value order: idea<risk.
    const g = graphWithExtra([
      { id: 'a', x: 0, y: 0, w: 10, h: 10, extra: { tags: ['idea'] } },
      { id: 'b', x: 0, y: 100, w: 10, h: 10, extra: { tags: ['risk'] } },
      { id: 'c', x: 0, y: 200, w: 10, h: 10, extra: { tags: ['idea'] } },
    ]);
    const pal = BOARD_PALETTES[0];
    const out = recolorSelectionByFacet(g, PARENT, ['a', 'b', 'c'], pal, itemTags);
    const fill = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, itemFillColor(i)]));
    expect(fill.a).toBe(pal.colors[0]); // "idea" (alpha-first) → colour 0
    expect(fill.c).toBe(pal.colors[0]); // same tag → SAME colour (the whole point of by-group)
    expect(fill.b).toBe(pal.colors[1]); // "risk" → next colour
    expect(fill.a).not.toBe(fill.b);
  });

  it('cont.43 STABILITY: a value keeps its colour by VALUE (alphabetical), not by spatial position', () => {
    // "zebra" sits at the TOP (y0), "apple" below it (y100). A reading-order assignment would give
    // the top item (zebra) colour 0; the STABLE assignment gives apple colour 0 (apple < zebra),
    // so a tag's colour never drifts with where the note happens to sit.
    const g = graphWithExtra([
      { id: 'z', x: 0, y: 0, w: 10, h: 10, extra: { tags: ['zebra'] } },
      { id: 'p', x: 0, y: 100, w: 10, h: 10, extra: { tags: ['apple'] } },
    ]);
    const pal = BOARD_PALETTES[0];
    const out = recolorSelectionByFacet(g, PARENT, ['z', 'p'], pal, itemTags);
    const fill = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, itemFillColor(i)]));
    expect(fill.p).toBe(pal.colors[0]); // apple (alphabetically first) → colour 0, despite sitting lower
    expect(fill.z).toBe(pal.colors[1]); // zebra → colour 1, despite sitting on top
  });

  it('leaves items with NO facet value unchanged (a partition can only place what it can group)', () => {
    const g = graphWithExtra([
      { id: 'a', x: 0, y: 0, w: 10, h: 10, extra: { tags: ['idea'] } },
      { id: 'u', x: 0, y: 100, w: 10, h: 10 }, // untagged → not in any group
    ]);
    const out = recolorSelectionByFacet(g, PARENT, ['a', 'u'], BOARD_PALETTES[0], itemTags);
    const untagged = readItems(out, PARENT).find((i) => i.memberId === 'u');
    expect(untagged?.extra?.visualLayerStack).toBeUndefined(); // never painted
  });

  it('is a no-op (=== graph) when nothing in the selection carries the facet', () => {
    const g = graphWithExtra([{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', x: 0, y: 100, w: 10, h: 10 }]);
    expect(recolorSelectionByFacet(g, PARENT, ['a', 'b'], BOARD_PALETTES[0], itemTags)).toBe(g);
  });

  it('both catalog rows exist (color-by-tag / color-by-type) — DATA-generated, zero row code (L069/L090)', () => {
    const stub = { distinctFacetValues: {}, applyBatch: () => {} } as unknown as BoardBatchContext;
    const ids = buildBoardBatchPack(stub).map((r) => r.id);
    expect(ids).toContain('color-by-tag');
    expect(ids).toContain('color-by-type');
  });

  it('a color-by row is HIDDEN (accepts=false) unless the selection spans ≥2 distinct values (L118)', () => {
    const rowFor = (dfv: Record<string, number>) =>
      buildBoardBatchPack({ distinctFacetValues: dfv, applyBatch: () => {} } as unknown as BoardBatchContext)
        .find((r) => r.id === 'color-by-tag')!;
    expect(rowFor({ tag: 2 }).accepts([ref('a'), ref('b')])).toBe(true);
    expect(rowFor({ tag: 1 }).accepts([ref('a'), ref('b')])).toBe(false); // one colour isn't a "colour BY"
    expect(rowFor({}).accepts([ref('a'), ref('b')])).toBe(false); // facet absent → 0
  });

  it('run() delegates through applyBatch and recolours the two tag groups to two distinct colours', () => {
    let producer: ((g: G, ids: string[], p: AddressRef) => G) | null = null;
    const stub = {
      distinctFacetValues: { tag: 2 },
      applyBatch: (fn: (g: G, ids: string[], p: AddressRef) => G) => { producer = fn; },
    } as unknown as BoardBatchContext;
    const row = buildBoardBatchPack(stub).find((r) => r.id === 'color-by-tag')!;
    row.run([ref('a'), ref('b')]);
    expect(producer).not.toBeNull();
    const g = graphWithExtra([
      { id: 'a', x: 0, y: 0, w: 10, h: 10, extra: { tags: ['idea'] } },
      { id: 'b', x: 0, y: 100, w: 10, h: 10, extra: { tags: ['risk'] } },
    ]);
    const out = producer!(g, ['a', 'b'], PARENT);
    const fill = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, itemFillColor(i)]));
    expect(fill.a).not.toBe(fill.b); // two tags → two colours, proving end-to-end delegation
  });
});

describe('Kanban by facet (cont.45) — columns-by-value via the injected arrangeColumns layout', () => {
  it('both kanban rows exist (kanban-by-tag / kanban-by-kind)', () => {
    const stub = { multipleNodesSelected: true, applyBatch: () => {} } as unknown as BoardBatchContext;
    const ids = buildBoardBatchPack(stub).map((r) => r.id);
    expect(ids).toContain('kanban-by-tag');
    expect(ids).toContain('kanban-by-kind');
  });

  it('lays items into HORIZONTAL columns by tag (columns advance in x), with labelled headers', () => {
    // Two tags: "a" (t1,t2) and "b" (t3). Group-by would stack vertically; kanban places columns L→R.
    const g = graphWithExtra([
      { id: 't1', x: 0, y: 0, w: 100, h: 60, extra: { tags: ['a'] } },
      { id: 't2', x: 0, y: 0, w: 100, h: 60, extra: { tags: ['a'] } },
      { id: 't3', x: 0, y: 0, w: 100, h: 60, extra: { tags: ['b'] } },
    ]);
    const out = arrangeByFacetLabeled(g, PARENT, ['t1', 't2', 't3'], 20, (i) => itemTags(i), {
      facetId: 'tag', emptyLabel: 'Untagged', layout: arrangeColumns,
    });
    const pos = Object.fromEntries(readItems(out, PARENT).filter((i) => !itemIsRegionHeading(i)).map((i) => [i.memberId, { x: i.x, y: i.y }]));
    // Column "a": t1 above t2 (same x, t2 lower). Column "b" is to the RIGHT of column "a".
    expect(pos.t1.x).toBe(pos.t2.x); // same column
    expect(pos.t2.y).toBeGreaterThan(pos.t1.y); // stacked vertically
    expect(pos.t3.x).toBeGreaterThan(pos.t1.x); // "b" column is to the right
    // Two labelled column headers were placed (region headings), one per column.
    const headers = readItems(out, PARENT).filter(itemIsRegionHeading);
    expect(headers).toHaveLength(2);
  });

  it('switching Group-by ↔ Kanban self-cleans the headers (same facetId, no accumulation)', () => {
    let g = graphWithExtra([
      { id: 't1', x: 0, y: 0, w: 100, h: 60, extra: { tags: ['a'] } },
      { id: 't2', x: 0, y: 0, w: 100, h: 60, extra: { tags: ['b'] } },
    ]);
    g = arrangeByFacetLabeled(g, PARENT, ['t1', 't2'], 20, (i) => itemTags(i), { facetId: 'tag', layout: arrangeColumns });
    const afterKanban = readItems(g, PARENT).filter(itemIsRegionHeading).length;
    g = arrangeByFacetLabeled(g, PARENT, ['t1', 't2'], 20, (i) => itemTags(i), { facetId: 'tag' }); // back to group-by
    const afterGroup = readItems(g, PARENT).filter(itemIsRegionHeading).length;
    expect(afterKanban).toBe(2);
    expect(afterGroup).toBe(2); // NOT 4 — the kanban headers were cleaned, not accumulated
  });
});

describe('harmonizeSelectionFromAnchor — theme from a colour-theory scheme (§9.6, cont.24)', () => {
  const notes = (rows: ReadonlyArray<{ id: string; x: number; y: number; fill?: string; locked?: boolean }>) => {
    let g = emptyGraph();
    for (const b of rows) {
      const extra: Record<string, unknown> = {};
      if (b.fill) extra.visualLayerStack = seededFillStack(b.fill);
      if (b.locked) extra.locked = true;
      g = placeItem(g, PARENT, { memberId: b.id, nodeRef: { family: 'test.item', parts: { id: b.id } }, kind: 'note', x: b.x, y: b.y, w: 100, h: 60, extra });
    }
    return g;
  };
  const triadic = BOARD_HARMONY_SCHEMES.find((s) => s.id === 'triadic')!;

  it('seeds from the reading-first FILLED item and themes the selection with the generated scheme', () => {
    // Seed = the top note's blue (reading order); the others get the triadic scheme colours.
    const g = notes([{ id: 'seed', x: 0, y: 0, fill: '#2563eb' }, { id: 'b', x: 0, y: 100 }, { id: 'c', x: 0, y: 200 }]);
    const out = harmonizeSelectionFromAnchor(g, PARENT, ['seed', 'b', 'c'], triadic);
    const fill = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, itemFillColor(i)]));
    // Each note now carries one of the triadic scheme colours generated from the seed.
    const scheme = new Set(harmonize('#2563eb', triadic));
    for (const id of ['seed', 'b', 'c']) expect(scheme.has(fill[id] as string)).toBe(true);
    // The three fills span the wheel (a real triad, not all one colour).
    expect(new Set([fill.seed, fill.b, fill.c]).size).toBe(3);
  });

  it('no filled item → no seed → no-op', () => {
    const g = notes([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 100 }]);
    expect(harmonizeSelectionFromAnchor(g, PARENT, ['a', 'b'], triadic)).toBe(g);
  });

  it('a LOCKED seed keeps its colour; the movable notes harmonise around it', () => {
    const g = notes([{ id: 'seed', x: 0, y: 0, fill: '#ef4444', locked: true }, { id: 'b', x: 0, y: 100, fill: '#cccccc' }]);
    const out = harmonizeSelectionFromAnchor(g, PARENT, ['seed', 'b'], triadic);
    const fill = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, itemFillColor(i)]));
    expect(fill.seed).toBe('#ef4444'); // locked → untouched
    expect(fill.b).not.toBe('#cccccc'); // recoloured to a scheme colour
  });

  it('every scheme generates a registered "Harmonize: X" row, gated on anchorHasFill', () => {
    const withFill = { multipleNodesSelected: true, anchorHasFill: true, applyBatch: () => {} } as unknown as BoardBatchContext;
    const noFill = { multipleNodesSelected: true, anchorHasFill: false, applyBatch: () => {} } as unknown as BoardBatchContext;
    const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
    for (const scheme of BOARD_HARMONY_SCHEMES) {
      const on = buildBoardBatchPack(withFill).find((r) => r.id === `harmonize-${scheme.id}`);
      expect(on).toBeTruthy();
      expect(on?.accepts([ref('a'), ref('b')])).toBe(true);
      expect(buildBoardBatchPack(noFill).find((r) => r.id === `harmonize-${scheme.id}`)?.accepts([ref('a'), ref('b')])).toBe(false);
    }
  });
});

describe('Group by marker / Group by shape — emergent facets over per-item marker (cont.12) + shape (cont.13)', () => {
  const markerOf = (it: { extra?: Record<string, unknown> }) => (typeof it.extra?.marker === 'string' ? it.extra.marker : '');
  const shapeOf = (it: { extra?: Record<string, unknown> }) => (typeof it.extra?.shape === 'string' ? it.extra.shape : '');
  const boxes = (rows: ReadonlyArray<{ id: string; extra: Record<string, unknown> }>) => {
    let g = emptyGraph();
    let i = 0;
    for (const b of rows) {
      g = placeItem(g, PARENT, { memberId: b.id, nodeRef: { family: 'test.item', parts: { id: b.id } }, kind: 'note', x: i * 10, y: i * 10, w: 120, h: 60, extra: b.extra });
      i += 1;
    }
    return g;
  };
  const headings = (g: ReturnType<typeof emptyGraph>) => readItems(g, PARENT).filter(itemIsRegionHeading);

  it('Group by marker clusters by the per-item bullet, labelled by glyph+name; no-marker notes fall into "No marker"', () => {
    const g = boxes([
      { id: 'a1', extra: { marker: 'check' } },
      { id: 'a2', extra: { marker: 'check' } },
      { id: 'a3', extra: { marker: 'star' } },
      { id: 'a4', extra: {} }, // inherits the board default → no per-item marker → empty bucket
    ]);
    const out = arrangeByFacetLabeled(g, PARENT, ['a1', 'a2', 'a3', 'a4'], BOARD_GRID, markerOf, { facetId: 'marker', labelMap: MARKER_FACET_LABELS, emptyLabel: 'No marker' });
    const texts = headings(out).map((h) => h.text);
    expect(texts).toContain('✓ Check · 2');
    expect(texts).toContain('★ Star · 1');
    expect(texts).toContain('No marker · 1');
  });

  it('Group by shape clusters by the per-item shape, labelled by shape name', () => {
    const g = boxes([
      { id: 'a1', extra: { shape: 'ellipse' } },
      { id: 'a2', extra: { shape: 'diamond' } },
      { id: 'a3', extra: { shape: 'diamond' } },
    ]);
    const out = arrangeByFacetLabeled(g, PARENT, ['a1', 'a2', 'a3'], BOARD_GRID, shapeOf, { facetId: 'shape', labelMap: SHAPE_FACET_LABELS, emptyLabel: 'No shape' });
    const texts = headings(out).map((h) => h.text);
    expect(texts).toContain('Diamond · 2');
    expect(texts).toContain('Ellipse · 1');
  });

  it('both facet rows are registered in the board batch pack (auto-surfaced in bulk bar / ⌘K / right-click)', () => {
    const stub = { anyUnlockedSelected: true } as unknown as BoardBatchContext;
    const ids = buildBoardBatchPack(stub).map((r) => r.id);
    expect(ids).toContain('arrange-by-marker');
    expect(ids).toContain('arrange-by-shape');
  });

  it('the continuous axis rows (§9.4) are surfaced in the pack AND actually run over a real selection', () => {
    const stub = { anyUnlockedSelected: true } as unknown as BoardBatchContext;
    const pack = buildBoardBatchPack(stub);
    const ids = pack.map((r) => r.id);
    expect(ids).toContain('arrange-by-length'); // 1-D number-line by text length
    expect(ids).toContain('arrange-scatter-size-length'); // 2-D scatter (area x length)
    // Prove the row's produce() reaches arrangeSelectionOnAxis on real items (not just registered).
    let g = emptyGraph();
    const rows = [
      { id: 's', text: 'x', w: 40, h: 40 }, // short + small
      { id: 'l', text: 'a much longer note body', w: 200, h: 120 }, // long + big
    ];
    for (const r of rows) g = placeItem(g, PARENT, { memberId: r.id, nodeRef: { family: 'test.item', parts: { id: r.id } }, kind: 'note', x: 0, y: 0, w: r.w, h: r.h, text: r.text });
    const out = arrangeSelectionOnAxis(g, PARENT, ['s', 'l'], (i) => ({ x: typeof i.text === 'string' ? i.text.length : null }), { deOverlap: false });
    const bx = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, i]));
    expect(bx.l.x).toBeGreaterThan(bx.s.x); // longer note is further along the axis
  });

  it('the importance axis rows (b147) are surfaced AND rank a hub further along than the cards pointing to it', () => {
    const stub = { anyUnlockedSelected: true } as unknown as BoardBatchContext;
    const ids = buildBoardBatchPack(stub).map((r) => r.id);
    expect(ids).toContain('arrange-by-importance');
    expect(ids).toContain('arrange-scatter-importance-progress');
    // a → hub, b → hub: hub is endorsed by both, so its PageRank importance places it further along the axis.
    let g = emptyGraph();
    for (const id of ['hub', 'a', 'b']) g = placeItem(g, PARENT, { memberId: id, nodeRef: { family: 'test.item', parts: { id } }, kind: 'note', x: 0, y: 0, w: 40, h: 40, text: id });
    for (const [mid, from, to] of [['e1', 'a', 'hub'], ['e2', 'b', 'hub']] as const)
      g = placeItem(g, PARENT, { memberId: mid, nodeRef: { family: 'test.item', parts: { id: mid } }, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } });
    const ranks = importanceRanks(readItems(g, PARENT));
    const out = arrangeSelectionOnAxis(g, PARENT, ['hub', 'a', 'b'], (i) => ({ x: importanceValue(ranks, i.memberId) }), { deOverlap: false });
    const bx = Object.fromEntries(readItems(out, PARENT).map((i) => [i.memberId, i]));
    expect(bx.hub.x).toBeGreaterThan(bx.a.x); // the endorsed hub sits further along the importance axis
  });

  it('the community rows (b148) are surfaced in the pack (auto-surfaced in bulk bar / ⌘K / right-click)', () => {
    const stub = { anyUnlockedSelected: true } as unknown as BoardBatchContext;
    const ids = buildBoardBatchPack(stub).map((r) => r.id);
    expect(ids).toContain('arrange-by-cluster');
    expect(ids).toContain('kanban-by-cluster');
  });
});

describe('arrangeSelectionOnAxis (§9.4 — plot the selection along a numeric axis)', () => {
  // A board of cards each carrying a numeric field in `extra` (the caller precomputes it — the
  // engine is blind, L090). valueOf reads that number; the bridge scales it onto the plane.
  const board = () =>
    graphWith([
      { id: 'a', x: 0, y: 0, w: 100, h: 40 },
      { id: 'b', x: 0, y: 0, w: 100, h: 40 },
      { id: 'c', x: 0, y: 0, w: 100, h: 40 },
      { id: 'd', x: 0, y: 0, w: 100, h: 40 },
    ]);
  const SCORE: Record<string, number> = { a: 0, b: 25, c: 75, d: 100 };

  it('1-D timeline: X strictly increases with the value (a real ordering), deterministic', () => {
    const out = arrangeSelectionOnAxis(board(), PARENT, ['a', 'b', 'c', 'd'], (i) => ({ x: SCORE[i.memberId] }), {
      deOverlap: false,
    });
    const bx = boxesOf(out);
    expect(bx.a.x).toBeLessThan(bx.b.x);
    expect(bx.b.x).toBeLessThan(bx.c.x);
    expect(bx.c.x).toBeLessThan(bx.d.x);
  });

  it('2-D scatter: returning a Y switches mode; higher Y sits higher (smaller y) with invertY', () => {
    const out = arrangeSelectionOnAxis(
      board(),
      PARENT,
      ['a', 'd'],
      (i) => ({ x: SCORE[i.memberId], y: SCORE[i.memberId] }),
      { deOverlap: false },
    );
    const bx = boxesOf(out);
    expect(bx.d.y).toBeLessThan(bx.a.y); // d (value 100) above a (value 0)
  });

  it('an item with no value parks below the plot instead of being dropped (nothing lost)', () => {
    const out = arrangeSelectionOnAxis(
      board(),
      PARENT,
      ['a', 'b', 'c', 'd'],
      (i) => ({ x: i.memberId === 'c' ? null : SCORE[i.memberId] }),
      { deOverlap: false },
    );
    const bx = boxesOf(out);
    // Still 4 boxes; 'c' parked BELOW every on-axis card (larger y than the lane row).
    expect(Object.keys(bx)).toHaveLength(4);
    expect(bx.c.y).toBeGreaterThan(Math.max(bx.a.y, bx.b.y, bx.d.y));
    for (const p of Object.values(bx)) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it('deOverlap (default) removes overlaps when many cards share one value — a readable pile-free timeline', () => {
    // Every card at the SAME value would collide on one point; the MTV pass spreads them apart.
    const out = arrangeSelectionOnAxis(board(), PARENT, ['a', 'b', 'c', 'd'], () => ({ x: 50 }));
    const boxes = Object.values(boxesOf(out));
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i += 1)
      for (let j = i + 1; j < boxes.length; j += 1) {
        const A = boxes[i];
        const B = boxes[j];
        if (A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y) overlaps += 1;
      }
    expect(overlaps).toBe(0);
  });

  it('<2 nodes → no-op (returns the same graph reference)', () => {
    const g = board();
    expect(arrangeSelectionOnAxis(g, PARENT, ['a'], () => ({ x: 1 }))).toBe(g);
  });
});

describe('arrangeSelectionOnAxis labelled axis (§9.4 — the axis reads as a chart)', () => {
  const board = () =>
    graphWith([
      { id: 'a', x: 0, y: 0, w: 100, h: 40 },
      { id: 'b', x: 0, y: 0, w: 100, h: 40 },
      { id: 'c', x: 0, y: 0, w: 100, h: 40 },
    ]);
  const V: Record<string, number> = { a: 0, b: 50, c: 100 };

  it('showAxis materialises deterministic ghost-note tick labels (self-describing axis furniture)', () => {
    const out = arrangeSelectionOnAxis(board(), PARENT, ['a', 'b', 'c'], (i) => ({ x: V[i.memberId] }), { showAxis: true, deOverlap: false });
    const ticks = readItems(out, PARENT).filter(itemIsAxisTick);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.memberId.startsWith(AXIS_TICK_PREFIX)).toBe(true);
      expect(t.extra?.axisTick).toBe(true);
      expect(Number.isFinite(t.x) && Number.isFinite(t.y)).toBe(true);
      expect(typeof t.text).toBe('string'); // the formatted value label
    }
    // The three real cards are still present and NOT counted as ticks.
    const cards = readItems(out, PARENT).filter((i) => !itemIsAxisTick(i));
    expect(cards.map((c) => c.memberId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('re-plotting REPLACES the axis (idempotent — labels never accumulate)', () => {
    const first = arrangeSelectionOnAxis(board(), PARENT, ['a', 'b', 'c'], (i) => ({ x: V[i.memberId] }), { showAxis: true, deOverlap: false });
    const n1 = readItems(first, PARENT).filter(itemIsAxisTick).length;
    // Re-plot the SAME selection (the axis-tick notes exist now); they must be cleaned + re-derived,
    // not moved or doubled — and the tick notes are excluded from the plotted selection.
    const second = arrangeSelectionOnAxis(first, PARENT, ['a', 'b', 'c'], (i) => ({ x: V[i.memberId] }), { showAxis: true, deOverlap: false });
    const n2 = readItems(second, PARENT).filter(itemIsAxisTick).length;
    expect(n2).toBe(n1); // same count, not doubled
  });

  it('format maps the raw numeric to a human label on the axis ticks', () => {
    const out = arrangeSelectionOnAxis(board(), PARENT, ['a', 'b', 'c'], (i) => ({ x: V[i.memberId] }), { showAxis: true, deOverlap: false, format: (v) => `${v}%` });
    const texts = readItems(out, PARENT).filter(itemIsAxisTick).map((t) => t.text);
    expect(texts.some((t) => typeof t === 'string' && t.endsWith('%'))).toBe(true);
  });

  it('no showAxis → zero axis furniture (unchanged default)', () => {
    const out = arrangeSelectionOnAxis(board(), PARENT, ['a', 'b', 'c'], (i) => ({ x: V[i.memberId] }), { deOverlap: false });
    expect(readItems(out, PARENT).filter(itemIsAxisTick)).toHaveLength(0);
  });
});

describe('board furniture is ONE category (L063 — cross-arrangement clearing)', () => {
  const board = () =>
    graphWith([
      { id: 'a', x: 0, y: 0, w: 100, h: 40 },
      { id: 'b', x: 0, y: 0, w: 100, h: 40 },
      { id: 'c', x: 0, y: 0, w: 100, h: 40 },
    ]);

  it('grouping by facet AFTER an axis plot clears the axis ticks (furniture never clusters)', () => {
    // Plot with a labelled axis → axis-tick furniture on the board.
    const plotted = arrangeSelectionOnAxis(board(), PARENT, ['a', 'b', 'c'], (i) => ({ x: i.w }), { showAxis: true, deOverlap: false });
    expect(readItems(plotted, PARENT).filter(itemIsAxisTick).length).toBeGreaterThan(0);
    // Now group the SAME real cards by facet — the prior axis furniture must be gone (a new
    // arrangement clears the old one's furniture), and NO axis tick was clustered as content.
    const grouped = arrangeByFacetLabeled(plotted, PARENT, ['a', 'b', 'c'], 10, (i) => i.kind, { facetId: 'kind' });
    expect(readItems(grouped, PARENT).filter(itemIsAxisTick)).toHaveLength(0);
    // The three real cards survive; region headings (the new furniture) are present.
    const content = readItems(grouped, PARENT).filter((i) => !itemIsBoardFurniture(i));
    expect(content.map((i) => i.memberId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('plotting AFTER grouping clears the region headings (symmetric)', () => {
    const grouped = arrangeByFacetLabeled(board(), PARENT, ['a', 'b', 'c'], 10, (i) => i.kind, { facetId: 'kind' });
    expect(readItems(grouped, PARENT).filter(itemIsRegionHeading).length).toBeGreaterThan(0);
    const plotted = arrangeSelectionOnAxis(grouped, PARENT, ['a', 'b', 'c'], (i) => ({ x: i.w }), { showAxis: true, deOverlap: false });
    expect(readItems(plotted, PARENT).filter(itemIsRegionHeading)).toHaveLength(0); // region furniture cleared
  });
});

describe('arrangeSelectionAsTimeline (§9.5 — roadmap: continuous X × discrete swimlanes)', () => {
  const board = () =>
    graphWith([
      { id: 'a', x: 0, y: 0, w: 80, h: 40 },
      { id: 'b', x: 0, y: 0, w: 80, h: 40 },
      { id: 'c', x: 0, y: 0, w: 80, h: 40 },
      { id: 'd', x: 0, y: 0, w: 80, h: 40 },
    ]);
  const X: Record<string, number> = { a: 0, b: 100, c: 20, d: 80 };
  const LANE: Record<string, string> = { a: 'todo', b: 'todo', c: 'done', d: 'done' };
  const val = (i: { memberId: string }) => X[i.memberId];
  const lane = (i: { memberId: string }) => LANE[i.memberId];

  it('cards are ordered by value along X and separated into lane bands along Y', () => {
    const out = arrangeSelectionAsTimeline(board(), PARENT, ['a', 'b', 'c', 'd'], val, lane, { deOverlap: false });
    const bx = Object.fromEntries(readItems(out, PARENT).filter((i) => !itemIsBoardFurniture(i)).map((i) => [i.memberId, i]));
    // within 'todo': a(0) left of b(100)
    expect(bx.a.x).toBeLessThan(bx.b.x);
    // within 'done': c(20) left of d(80)
    expect(bx.c.x).toBeLessThan(bx.d.x);
    // lanes separated on Y: the two lanes sit at different bands (todo vs done rows differ)
    expect(bx.a.y).not.toBe(bx.c.y);
    expect(bx.a.y).toBe(bx.b.y); // same lane → same band centre
    expect(bx.c.y).toBe(bx.d.y);
  });

  it('materialises ONE labelled lane header per lane (region-heading furniture)', () => {
    const out = arrangeSelectionAsTimeline(board(), PARENT, ['a', 'b', 'c', 'd'], val, lane, { deOverlap: false });
    const headers = readItems(out, PARENT).filter(itemIsRegionHeading);
    expect(headers.length).toBe(2); // one per lane
    const texts = headers.map((h) => h.text);
    expect(texts.some((t) => typeof t === 'string' && t.startsWith('todo'))).toBe(true);
    expect(texts.some((t) => typeof t === 'string' && t.startsWith('done'))).toBe(true);
  });

  it('laneKeys forces order + keeps an empty lane header (persisted swimlane)', () => {
    const out = arrangeSelectionAsTimeline(board(), PARENT, ['a', 'b', 'c', 'd'], val, lane, { laneKeys: ['todo', 'doing', 'done'], deOverlap: false });
    const headers = readItems(out, PARENT).filter(itemIsRegionHeading);
    expect(headers.length).toBe(3); // incl. the empty 'doing' lane
    const doing = headers.find((h) => typeof h.text === 'string' && h.text.startsWith('doing'));
    expect(doing?.text).toContain('· 0'); // empty lane, count 0
  });

  it('per-lane de-overlap: cards sharing an X in a lane never collide, lanes stay separate', () => {
    // Every card at the same X within its lane → would stack on one point; per-lane MTV spreads them.
    const out = arrangeSelectionAsTimeline(board(), PARENT, ['a', 'b', 'c', 'd'], () => 50, lane);
    const boxes = readItems(out, PARENT).filter((i) => !itemIsBoardFurniture(i));
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i += 1)
      for (let j = i + 1; j < boxes.length; j += 1) {
        const A = boxes[i], B = boxes[j];
        if (A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y) overlaps += 1;
      }
    expect(overlaps).toBe(0);
  });

  it('is registered in the batch pack AND idempotent (re-run clears prior furniture)', () => {
    const stub = { anyUnlockedSelected: true } as unknown as BoardBatchContext;
    expect(buildBoardBatchPack(stub).map((r) => r.id)).toContain('arrange-timeline-kind');
    const once = arrangeSelectionAsTimeline(board(), PARENT, ['a', 'b', 'c', 'd'], val, lane, { deOverlap: false });
    const h1 = readItems(once, PARENT).filter(itemIsRegionHeading).length;
    const twice = arrangeSelectionAsTimeline(once, PARENT, ['a', 'b', 'c', 'd'], val, lane, { deOverlap: false });
    expect(readItems(twice, PARENT).filter(itemIsRegionHeading).length).toBe(h1); // not doubled
  });

  it('<2 nodes → no-op', () => {
    const g = board();
    expect(arrangeSelectionAsTimeline(g, PARENT, ['a'], val, lane)).toBe(g);
  });
});

describe('geometry sanitization — a malformed (non-finite / finite-huge) box cannot poison a batch op (cont.98 batch-11)', () => {
  // A persisted/producer-written item can carry a NON-FINITE (NaN/Infinity) or FINITE-HUGE
  // (Number.MAX_VALUE → overflows to Infinity on `x + w`) coordinate. boxesFor sanitizes via
  // finiteCoord, so one bad box no longer makes the whole align/distribute emit Infinity/NaN.
  const allFinite = (boxes: Record<string, { x: number; y: number; w: number; h: number }>) =>
    Object.values(boxes).every((b) => Number.isFinite(b.x) && Number.isFinite(b.y));

  it('alignBoxes stays finite when one box has a finite-HUGE coordinate', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 100, h: 50 },
      { id: 'b', x: 200, y: 0, w: 100, h: 50 },
      { id: 'c', x: Number.MAX_VALUE, y: 0, w: Number.MAX_VALUE, h: 50 }, // overflow bait
    ]);
    const out = boxesOf(alignBoxes(g, PARENT, ['a', 'b', 'c'], 'right'));
    expect(allFinite(out)).toBe(true); // 'right' = maxR - b.w; maxR was Infinity before the clamp
    expect(Number.isFinite(out.a.x)).toBe(true);
  });

  it('alignBoxes stays finite when one box has a NaN coordinate', () => {
    const g = graphWith([
      { id: 'a', x: 10, y: 0, w: 100, h: 50 },
      { id: 'b', x: NaN, y: 0, w: 100, h: 50 },
    ]);
    const out = boxesOf(alignBoxes(g, PARENT, ['a', 'b'], 'left'));
    expect(Number.isFinite(out.a.x)).toBe(true);
    expect(Number.isFinite(out.b.x)).toBe(true);
  });

  it('distributeBoxes stays finite with a finite-huge outlier (no Infinity centre)', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', x: 100, y: 0, w: 10, h: 10 },
      { id: 'c', x: Number.MAX_VALUE, y: 0, w: Number.MAX_VALUE, h: 10 },
    ]);
    expect(allFinite(boxesOf(distributeBoxes(g, PARENT, ['a', 'b', 'c'], 'h')))).toBe(true);
  });

  it('distributeSpacing stays finite with a finite-huge outlier (no Infinity span/gap)', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', x: 100, y: 0, w: 10, h: 10 },
      { id: 'c', x: Number.MAX_VALUE, y: 0, w: Number.MAX_VALUE, h: 10 },
    ]);
    expect(allFinite(boxesOf(distributeSpacing(g, PARENT, ['a', 'b', 'c'], 'h')))).toBe(true);
  });

  it('a normal board is BYTE-IDENTICAL through the sanitizer (zero regression)', () => {
    const g = graphWith([
      { id: 'a', x: 10, y: 0, w: 100, h: 50 },
      { id: 'b', x: 40, y: 100, w: 60, h: 50 },
      { id: 'c', x: 90, y: 200, w: 80, h: 50 },
    ]);
    // 'left' aligns all to minX = 10 — the sanitizer is a no-op for these in-range coords.
    const out = boxesOf(alignBoxes(g, PARENT, ['a', 'b', 'c'], 'left'));
    expect(out.a.x).toBe(10);
    expect(out.b.x).toBe(10);
    expect(out.c.x).toBe(10);
  });

  it('snapToGrid with a NON-FINITE grid is a no-op (the `grid <= 0` guard alone let NaN through)', () => {
    const g = graphWith([{ id: 'a', x: 10, y: 20, w: 100, h: 50 }]);
    expect(snapToGrid(g, PARENT, ['a'], NaN)).toBe(g); // NaN <= 0 is false → old guard passed → NaN positions
    expect(snapToGrid(g, PARENT, ['a'], Infinity)).toBe(g);
    expect(snapToGrid(g, PARENT, ['a'], 0)).toBe(g);
    expect(snapToGrid(g, PARENT, ['a'], -5)).toBe(g);
    // a real grid still snaps.
    expect(boxesOf(snapToGrid(g, PARENT, ['a'], 24)).a.x).toBe(Math.round(10 / 24) * 24);
  });
});

describe('batch-actions — cont.98 batch-23 hardening (graph traversal + finite coords)', () => {
  const node = (id: string): BoardItem =>
    ({ memberId: id, kind: 'note', text: id, x: 0, y: 0, w: 10, h: 10, extra: {} } as unknown as BoardItem);
  const conn = (from: string, to: string): BoardItem =>
    ({ memberId: `c-${from}-${to}`, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

  it('#4 mindMapOutline does not overflow on a 20000-deep connector chain (iterative walk)', () => {
    const N = 20000;
    const items: BoardItem[] = [];
    for (let i = 0; i < N; i += 1) items.push(node(`n${i}`));
    for (let i = 0; i + 1 < N; i += 1) items.push(conn(`n${i}`, `n${i + 1}`));
    const ids = Array.from({ length: N }, (_, i) => `n${i}`);
    let outline: ReturnType<typeof mindMapOutline> = [];
    expect(() => { outline = mindMapOutline(items, ids); }).not.toThrow(); // recursive walk would RangeError here
    expect(outline).toHaveLength(N); // every node emitted once
    expect(outline[0].depth).toBe(0);
    expect(outline[N - 1].depth).toBe(N - 1); // linear chain → strictly increasing depth
  });

  it('#4 mindMapOutline still emits pre-order (depth + order preserved) on a small tree', () => {
    // root → a (→ a1), b ; visual order top-to-bottom is input order here (all y=0 → x=0 tie → stable)
    const items = [node('root'), node('a'), node('a1'), node('b'), conn('root', 'a'), conn('a', 'a1'), conn('root', 'b')];
    const out = mindMapOutline(items, ['root', 'a', 'a1', 'b']);
    expect(out.map((l) => l.depth)).toEqual([0, 1, 2, 1]); // root, a, a1, b — a's subtree before b
    expect(out.map((l) => l.text)).toEqual(['root', 'a', 'a1', 'b']);
  });

  it('#3 parentViaConnectors ignores a self-loop (A→A is not its own parent)', () => {
    expect(parentViaConnectors([node('a'), conn('a', 'a')], 'a')).toBeUndefined();
    // a real parent still resolves, even alongside a self-loop
    expect(parentViaConnectors([node('a'), node('b'), conn('a', 'a'), conn('a', 'b')], 'b')).toBe('a');
  });

  it('#2 descendantsViaConnectors excludes a DANGLING endpoint (no phantom id)', () => {
    // connector A→"ghost" where "ghost" is not a real item — must not appear in the descendant set.
    const items = [node('a'), node('b'), conn('a', 'b'), conn('a', 'ghost')];
    expect(descendantsViaConnectors(items, 'a').sort()).toEqual(['b']); // ghost dropped
  });

  it('#2 setBranchHidden does NOT throw when the branch has a dangling connector (was a crash)', () => {
    let g = emptyGraph();
    const ref = (id: string): AddressRef => ({ family: 'test.item', parts: { id } });
    g = placeItem(g, PARENT, { memberId: 'a', nodeRef: ref('a'), kind: 'note', x: 0, y: 0, w: 10, h: 10 });
    g = placeItem(g, PARENT, { memberId: 'b', nodeRef: ref('b'), kind: 'note', x: 0, y: 0, w: 10, h: 10 });
    g = placeItem(g, PARENT, { memberId: 'ca', nodeRef: ref('ca'), kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'b' } });
    // a dangling connector A→ghost (ghost never placed) — the old reachViaConnectors returned "ghost",
    // and setMemberFields threw `no member ghost` when setBranchHidden tried to patch it.
    g = placeItem(g, PARENT, { memberId: 'cg', nodeRef: ref('cg'), kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'ghost' } });
    let out = g;
    expect(() => { out = setBranchHidden(g, PARENT, 'a', true); }).not.toThrow();
    const b = readItems(out, PARENT).find((i) => i.memberId === 'b')!;
    expect(b.extra?.hidden).toBe(true); // the real descendant is still collapsed
  });

  it('#7 descendantsViaConnectors returns every child once on a WIDE graph (head-index BFS)', () => {
    const items: BoardItem[] = [node('root')];
    for (let i = 0; i < 5000; i += 1) { items.push(node(`k${i}`)); items.push(conn('root', `k${i}`)); }
    const desc = descendantsViaConnectors(items, 'root');
    expect(desc).toHaveLength(5000);
    expect(new Set(desc).size).toBe(5000); // no duplicates
  });

  it('#11 arrangeByFacet writes only FINITE positions even when an item has Number.MAX_VALUE width', () => {
    const ref = (id: string): AddressRef => ({ family: 'test.item', parts: { id } });
    let g = emptyGraph();
    g = placeItem(g, PARENT, { memberId: 'w1', nodeRef: ref('w1'), kind: 'note', x: 0, y: 0, w: Number.MAX_VALUE, h: 10, extra: { tags: ['x'] } });
    g = placeItem(g, PARENT, { memberId: 'w2', nodeRef: ref('w2'), kind: 'note', x: 0, y: 0, w: Number.MAX_VALUE, h: 10, extra: { tags: ['x'] } });
    g = placeItem(g, PARENT, { memberId: 'w3', nodeRef: ref('w3'), kind: 'note', x: 0, y: 0, w: 10, h: 10, extra: { tags: ['y'] } });
    const out = arrangeByFacet(g, PARENT, ['w1', 'w2', 'w3'], 10, (i) => (i.extra?.tags as string[] | undefined) ?? []);
    for (const it of readItems(out, PARENT)) {
      expect(Number.isFinite(it.x)).toBe(true);
      expect(Number.isFinite(it.y)).toBe(true); // MAX_VALUE width no longer overflows the cluster span to Infinity/NaN
    }
  });
});

describe('batch-actions — cont.98 batch-25 hardening (flip/rotate finite pivot + mesh cap)', () => {
  const ref = (id: string): AddressRef => ({ family: 'test.item', parts: { id } });

  it('#11 flipItems writes only FINITE positions when an item has Number.MAX_VALUE geometry', () => {
    let g = emptyGraph();
    g = placeItem(g, PARENT, { memberId: 'a', nodeRef: ref('a'), kind: 'note', x: Number.MAX_VALUE, y: 0, w: Number.MAX_VALUE, h: 10 });
    g = placeItem(g, PARENT, { memberId: 'b', nodeRef: ref('b'), kind: 'note', x: 0, y: 0, w: 10, h: 10 });
    const out = flipItems(g, PARENT, ['a', 'b'], 'x');
    for (const it of readItems(out, PARENT)) expect(Number.isFinite(it.x)).toBe(true);
  });

  it('#11 rotateItems writes only FINITE positions when an item has Number.MAX_VALUE geometry', () => {
    let g = emptyGraph();
    g = placeItem(g, PARENT, { memberId: 'a', nodeRef: ref('a'), kind: 'note', x: Number.MAX_VALUE, y: Number.MAX_VALUE, w: 10, h: 10 });
    g = placeItem(g, PARENT, { memberId: 'b', nodeRef: ref('b'), kind: 'note', x: 0, y: 0, w: 10, h: 10 });
    const out = rotateItems(g, PARENT, ['a', 'b'], 90);
    for (const it of readItems(out, PARENT)) {
      expect(Number.isFinite(it.x)).toBe(true);
      expect(Number.isFinite(it.y)).toBe(true);
    }
  });

  it('#9 newMeshConnectors refuses an absurdly large full mesh (O(n^2) OOM guard)', () => {
    const huge = Array.from({ length: 501 }, (_, i) => `n${i}`);
    expect(newMeshConnectors(huge, new Set())).toEqual([]); // over MAX_MESH_NODES → no-op, never mints ~125k pairs
    // a normal small selection still fully meshes: 4 nodes → 6 unordered pairs
    expect(newMeshConnectors(['a', 'b', 'c', 'd'], new Set())).toHaveLength(6);
  });
});

describe('minOf / maxOf — reduce bounds SSOT (cont.98 batch-43): the fix for every Math.min(...spread) site', () => {
  it('handles an array FAR past the JS spread arg limit without a RangeError (where Math.min(...arr) throws)', () => {
    // 200k > the V8 spread limit (~125k): `Math.min(...arr)` / `Math.max(...arr)` RangeError here — the
    // exact crash a select-all align/distribute over a large imported board would hit. The reduce form does not.
    const big = new Array(200_000).fill(0).map((_, i) => i);
    expect(() => Math.min(...big)).toThrow(); // documents the pre-fix failure mode
    expect(minOf(big)).toBe(0);
    expect(maxOf(big)).toBe(199_999);
  });

  it('finiteCoord-clamps each element so a non-finite coord never poisons the bound (output always finite)', () => {
    expect(minOf([5, 10, 3])).toBe(3);
    expect(maxOf([5, 10, 3])).toBe(10);
    expect(maxOf([5, Number.MAX_VALUE, 3])).toBe(1e7);      // finite-huge → BOARD_COORD_LIMIT (1e7)
    expect(maxOf([Number.POSITIVE_INFINITY, 1])).toBe(1);   // Infinity → fallback 0, so max is 1
    expect(minOf([5, Number.NaN, 3])).toBe(0);              // NaN → fallback 0, becomes the min
    expect(Number.isFinite(minOf([5, Number.NaN, 3]))).toBe(true);
  });

  it('empty → 0 (a no-op layout; never Infinity/-Infinity)', () => {
    expect(minOf([])).toBe(0);
    expect(maxOf([])).toBe(0);
  });
});

describe('patchItems — batch presentation patch (cont.98 batch-46, O(N^2) -> O(M+K))', () => {
  // O(N) direct graph literal — placeItem is itself O(M) per call (it spreads the members map), so
  // building via a placeItem loop would be O(N^2) and dominate/timeout the scale test. Constructing the
  // one-group graph literal directly (the exact shape getGroup/membersOf read) keeps the SETUP O(N) so
  // the scale test measures `patchItems`, not the builder.
  const build = (n: number) => {
    const members: Record<string, { memberId: string; nodeRef: AddressRef; presentation: Record<string, unknown> }> = {};
    const memberOrder: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `m${i}`;
      memberOrder.push(id);
      members[id] = {
        memberId: id,
        nodeRef: { family: 'test.item', parts: { id } },
        presentation: { kind: 'note', x: i, y: i * 2, w: 10, h: 10, text: `t${i}` },
      };
    }
    return { groups: { [groupKey(PARENT)]: { groupRef: PARENT, memberOrder, members } } } as ReturnType<typeof emptyGraph>;
  };

  it('#1 is SEMANTICALLY IDENTICAL to the K x patchItem fold (the O(N^2) path it replaces)', () => {
    const g = build(600);
    // Varied patches: geometry (x/y) + a presentation key (locked) + a pruned key (undefined clears).
    const patches = Array.from({ length: 600 }, (_, i) => ({
      memberId: `m${i}`,
      patch: i % 3 === 0 ? { x: i * 100, locked: true } : i % 3 === 1 ? { y: i * 7 } : { w: 42, text: undefined },
    }));
    const batched = patchItems(g, PARENT, patches);
    const folded = patches.reduce((acc, { memberId, patch }) => patchItem(acc, PARENT, memberId, patch), g);
    expect(batched).toEqual(folded); // deep-equal: the batch primitive changes complexity, never the result
  });

  it('#2 a zero-effect / empty batch returns the SAME graph reference (structural no-op)', () => {
    const g = build(5);
    expect(patchItems(g, PARENT, [])).toBe(g); // no patches → identical reference
    expect(patchItems(g, PARENT, [{ memberId: 'nope', patch: { x: 1 } }])).toBe(g); // only-stale → identical reference
  });

  it('#3 SKIPS a stale member id instead of aborting the batch (the one intentional divergence from patchItem)', () => {
    const g = build(3);
    const out = patchItems(g, PARENT, [
      { memberId: 'm0', patch: { x: 999 } },
      { memberId: 'ghost', patch: { x: 1 } }, // absent → patchItem would THROW; patchItems skips
      { memberId: 'm2', patch: { x: 777 } },
    ]);
    const byId = new Map(readItems(out, PARENT).map((i) => [i.memberId, i]));
    expect(byId.get('m0')!.x).toBe(999); // the live members still applied
    expect(byId.get('m2')!.x).toBe(777);
    expect(byId.has('ghost')).toBe(false); // the stale id did not create a phantom member
  });

  it('#4 untouched members keep REFERENCE identity (structural sharing, P1) — only the patched member is new', () => {
    const g = build(50);
    const before = (g as { groups: Record<string, { members: Record<string, unknown> }> }).groups;
    const gk = Object.keys(before)[0];
    const out = patchItems(g, PARENT, [{ memberId: 'm10', patch: { x: 5 } }]);
    const beforeMembers = before[gk].members;
    const afterMembers = (out as { groups: Record<string, { members: Record<string, unknown> }> }).groups[gk].members;
    expect(afterMembers.m10).not.toBe(beforeMembers.m10); // the patched member is a new object
    expect(afterMembers.m20).toBe(beforeMembers.m20); // every untouched member is shared by reference
    expect(afterMembers.m49).toBe(beforeMembers.m49);
  });

  it('#5 SCALE: a 20000-member select-all batch completes + is correct (the O(N^2) fold would be ~4e8 map-copies)', () => {
    const g = build(20000);
    const patches = Array.from({ length: 20000 }, (_, i) => ({ memberId: `m${i}`, patch: { x: i + 1 } }));
    const out = patchItems(g, PARENT, patches);
    const items = readItems(out, PARENT);
    expect(items).toHaveLength(20000);
    const byId = new Map(items.map((i) => [i.memberId, i]));
    expect(byId.get('m0')!.x).toBe(1);
    expect(byId.get('m19999')!.x).toBe(20000); // patched across the whole selection, O(M+K)
  });
});

describe('vote-axis rows (b84 — dot-voting plotted spatially, votes × axis L069)', () => {
  const ref = (m: string): NodeRef => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } });
  // A ctx whose applyBatch runs the row's produce against a real graph and captures the result — so we
  // exercise the REAL row (proving votesAxisValue reads extra.votes), not just the engine.
  const runRow = (rowId: string, g0: ReturnType<typeof emptyGraph>, ids: string[]) => {
    let captured = g0;
    const ctx = {
      anyUnlockedSelected: true,
      applyBatch: (fn: (g: typeof g0, ii: string[], p: typeof PARENT) => typeof g0) => {
        captured = fn(g0, [], PARENT);
      },
    } as unknown as BoardBatchContext;
    buildBoardBatchPack(ctx).find((r) => r.id === rowId)!.run(ids.map(ref));
    return boxesOf(captured);
  };

  it('both vote rows are registered in the pack (auto-surfaced in bulk bar / ⌘K / right-click)', () => {
    const ids = buildBoardBatchPack({ anyUnlockedSelected: true } as unknown as BoardBatchContext).map((r) => r.id);
    expect(ids).toContain('arrange-by-votes'); // 1-D priority number-line by dot count
    expect(ids).toContain('arrange-scatter-votes-progress'); // 2-D votes x progress
  });

  it('"Line up by votes" places more-voted cards further right and parks unvoted cards in the pile below', () => {
    const g0 = graphWithExtra([
      { id: 'lo', x: 0, y: 0, w: 100, h: 40, extra: { votes: { a: 1 } } }, // 1 dot
      { id: 'hi', x: 0, y: 0, w: 100, h: 40, extra: { votes: { a: 3, b: 2 } } }, // 5 dots
      { id: 'none', x: 0, y: 0, w: 100, h: 40 }, // no votes → no-value pile
    ]);
    const bx = runRow('arrange-by-votes', g0, ['lo', 'hi', 'none']);
    expect(bx.hi.x).toBeGreaterThan(bx.lo.x); // 5 dots sits right of 1 dot (real ordering by votes)
    expect(bx.none.y).toBeGreaterThan(bx.hi.y); // the unvoted card parks BELOW the axis line
  });

  it('"Plot votes vs progress" is a 2-D scatter: more votes → further right, more progress → higher (smaller y)', () => {
    const g0 = graphWithExtra([
      // popular + barely started (top-right target): 4 votes, 1/4 checklist done
      { id: 'pop', x: 0, y: 0, w: 100, h: 40, extra: { votes: { a: 4 }, checklist: [{ id: 's1', text: 'x', done: true }, { id: 's2', text: 'y', done: false }, { id: 's3', text: 'z', done: false }, { id: 's4', text: 'w', done: false }] } },
      // unpopular + mostly done: 1 vote, 3/4 done
      { id: 'quiet', x: 0, y: 0, w: 100, h: 40, extra: { votes: { a: 1 }, checklist: [{ id: 's1', text: 'x', done: true }, { id: 's2', text: 'y', done: true }, { id: 's3', text: 'z', done: true }, { id: 's4', text: 'w', done: false }] } },
    ]);
    const bx = runRow('arrange-scatter-votes-progress', g0, ['pop', 'quiet']);
    expect(bx.pop.x).toBeGreaterThan(bx.quiet.x); // 4 votes right of 1 vote
    // Higher progress sits HIGHER on screen (smaller y): quiet (3/4 done) is above pop (1/4 done). So the
    // popular-but-unstarted card lands at the bottom-right — "lots of votes, barely started" reads clearly.
    expect(bx.pop.y).toBeGreaterThan(bx.quiet.y);
  });
});
