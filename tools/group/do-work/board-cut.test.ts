// packages/group/do-work/board-cut.test.ts
//
// =============================================================================
// PURPOSE (#201)
// =============================================================================
//
// Proves the CUT (⌘X) contract faithfully. `cutSelected` in GroupBoardPanel is a
// pure composition of three shipped primitives:
//
//     const ids = unlockedOf(graph, [...selected], parentRef);   // lock chokepoint
//     if (!ids.length) return;
//     copySelected(ids);   // = copyItemsToClipboard(readItems ∩ ids) → setBoardClipboard
//     deleteSelected();    // = removeItem per unlocked id (one undo step)
//
// This test replays that EXACT sequence on a real GroupGraph fixture with a locked
// member, and asserts the two invariants that make Cut lock-consistent (#135/#136):
//   1. The clipboard receives ONLY the unlocked selected items (a locked item is
//      never cut — so what you paste == what was removed).
//   2. The graph loses ONLY the unlocked selected items; the locked one stays.
//
// Live click-through of ⌘X in the studio workspace is blocked by the cluttered
// pan/zoom panel swallowing synthetic selection (documented), so this deterministic
// replay is the proof of record for the cut semantics.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { describe, expect, it, beforeEach } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems, removeItem } from '../read-data/group-board-model';
import { unlockedOf, setLocked } from './batch-actions';
import {
  copyItemsToClipboard,
  setBoardClipboard,
  getBoardClipboard,
  clipboardItemCount,
} from './board-clipboard';

const PARENT: AddressRef = { family: 'test.board', parts: { id: 'root' } };

function graphWith(boxes: ReadonlyArray<{ id: string; x: number; y: number }>) {
  let g = emptyGraph();
  for (const b of boxes) {
    g = placeItem(g, PARENT, {
      memberId: b.id,
      nodeRef: { family: 'test.item', parts: { id: b.id } },
      kind: 'note',
      x: b.x,
      y: b.y,
      w: 100,
      h: 60,
    });
  }
  return g;
}

/** Replays `cutSelected`'s exact body: unlocked filter → copy → remove. Returns the
 *  post-cut graph so the test can assert what survived. */
function cut(graph: ReturnType<typeof graphWith>, selectedIds: readonly string[]) {
  const ids = unlockedOf(graph, selectedIds, PARENT);
  if (ids.length === 0) return { graph, cutIds: [] as string[] };
  const clip = copyItemsToClipboard(readItems(graph, PARENT).filter((i) => ids.includes(i.memberId)));
  if (clip) setBoardClipboard(clip);
  let next = graph;
  for (const id of ids) next = removeItem(next, PARENT, id);
  return { graph: next, cutIds: ids };
}

describe('board Cut (⌘X) — #201', () => {
  beforeEach(() => setBoardClipboard(null));

  it('copies ONLY the unlocked selected items to the clipboard (locked item is never cut)', () => {
    let g = graphWith([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 200, y: 0 },
      { id: 'c', x: 400, y: 0 },
    ]);
    g = setLocked(g, PARENT, ['b'], true); // b is locked

    const { cutIds } = cut(g, ['a', 'b', 'c']);

    expect(cutIds.sort()).toEqual(['a', 'c']); // b excluded by the lock chokepoint
    expect(clipboardItemCount()).toBe(2);
    const clip = getBoardClipboard()!;
    // The clipboard carries a + c, never the locked b.
    expect(clip.items.every((it) => it.extra?.locked !== true)).toBe(true);
  });

  it('removes ONLY the unlocked items from the board; the locked one stays', () => {
    let g = graphWith([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 200, y: 0 },
      { id: 'c', x: 400, y: 0 },
    ]);
    g = setLocked(g, PARENT, ['b'], true);

    const { graph } = cut(g, ['a', 'b', 'c']);
    const remaining = readItems(graph, PARENT).map((i) => i.memberId).sort();

    expect(remaining).toEqual(['b']); // a + c cut, b survives
  });

  it('is a NO-OP when every selected item is locked (nothing copied, nothing removed)', () => {
    let g = graphWith([{ id: 'a', x: 0, y: 0 }]);
    g = setLocked(g, PARENT, ['a'], true);

    const { graph, cutIds } = cut(g, ['a']);

    expect(cutIds).toEqual([]);
    expect(getBoardClipboard()).toBeNull(); // untouched (beforeEach cleared it)
    expect(readItems(graph, PARENT).map((i) => i.memberId)).toEqual(['a']); // still there
  });

  it('cuts the WHOLE selection when nothing is locked (common case)', () => {
    const g = graphWith([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 200, y: 0 },
    ]);
    const { graph, cutIds } = cut(g, ['a', 'b']);

    expect(cutIds.sort()).toEqual(['a', 'b']);
    expect(clipboardItemCount()).toBe(2);
    expect(readItems(graph, PARENT)).toEqual([]); // board emptied
  });
});
