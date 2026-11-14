// packages/group/show/default-item-size.integration.test.ts
//
// R2b end-to-end proof: the panel's placeDraftAt places a new item with
// boardDefaultItemSize(boardAppearance) as its w/h when the draft declares none. This test
// mirrors that exact composition through the REAL engine (placeItem → readItems) and asserts:
//   - no board override → the new note is 220×160 (zero-regression, the old hardcoded DEFAULTS)
//   - a board defaultWidth/Height preset → the new note takes THOSE dimensions
//   - a draft with its own w/h always wins over the board default
// This proves the hardcoded `DEFAULTS {220,160}` is now board-presettable DATA, not source.

import { describe, it, expect } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems, boardRootRef, itemRef } from '../read-data/group-board-model';
import { boardDefaultItemSize } from './item-appearance';

/** The exact placeDraftAt size logic: a draft's own w/h wins, else the board's cascade default. */
function placeWithDefault(
  boardAppearance: Record<string, unknown> | undefined,
  draft: { kind: string; w?: number; h?: number },
) {
  const size = boardDefaultItemSize(boardAppearance);
  const g = placeItem(emptyGraph(), boardRootRef('B'), {
    memberId: 'm1',
    nodeRef: itemRef('B', 'i1'),
    kind: draft.kind,
    x: 0,
    y: 0,
    w: typeof draft.w === 'number' ? draft.w : size.w,
    h: typeof draft.h === 'number' ? draft.h : size.h,
  });
  return readItems(g, boardRootRef('B'))[0];
}

describe('R2b — new-item default footprint is board-presettable DATA (placeDraftAt path)', () => {
  it('no board override → a new note is 220×160 (zero-regression vs the old DEFAULTS)', () => {
    const item = placeWithDefault(undefined, { kind: 'note' });
    expect({ w: item.w, h: item.h }).toEqual({ w: 220, h: 160 });
  });

  it('a board that presets a larger default → the new note takes it (no code change, DATA)', () => {
    const item = placeWithDefault({ defaultWidth: 360, defaultHeight: 260 }, { kind: 'note' });
    expect({ w: item.w, h: item.h }).toEqual({ w: 360, h: 260 });
  });

  it('a draft with its OWN footprint (a live surface / natural-aspect image) always wins', () => {
    const item = placeWithDefault({ defaultWidth: 360 }, { kind: 'media', w: 640, h: 480 });
    expect({ w: item.w, h: item.h }).toEqual({ w: 640, h: 480 });
  });

  it('a bad board preset fails safe to 220×160 (never a zero-size item)', () => {
    const item = placeWithDefault({ defaultWidth: 0, defaultHeight: -1 }, { kind: 'note' });
    expect({ w: item.w, h: item.h }).toEqual({ w: 220, h: 160 });
  });
});
