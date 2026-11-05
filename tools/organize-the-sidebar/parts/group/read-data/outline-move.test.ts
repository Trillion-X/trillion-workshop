// packages/group/read-data/outline-move.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { moveSubtree, moveSubtreeDir, subtreeRange } from '../../../read-data/outline-move.ts';
import type { ListItem } from '../../../read-data/list-block-model.ts';

const tree = (...spec: [string, number][]): ListItem[] =>
  spec.map(([id, indent]) => ({ id, indent, text: id }));
const ids = (items: readonly ListItem[]) => items.map((i) => i.id);
const shape = (items: readonly ListItem[]) => items.map((i) => `${i.id}@${i.indent}`);

describe('subtreeRange — a row plus its descendants', () => {
  const t = tree(['p', 0], ['a', 1], ['b', 2], ['c', 1], ['q', 0]); // p > (a > b, c), q
  it('covers the parent and every deeper row until a shallower/equal row', () => {
    expect(subtreeRange(t, 0)).toEqual([0, 4]); // p..c
    expect(subtreeRange(t, 1)).toEqual([1, 3]); // a..b
    expect(subtreeRange(t, 3)).toEqual([3, 4]); // c (leaf)
    expect(subtreeRange(t, 4)).toEqual([4, 5]); // q (leaf, last)
  });
});

describe('moveSubtreeDir — sibling-aware move (fixes the moveItem parent/child corruption)', () => {
  it('moving a PARENT down moves its WHOLE subtree past the next sibling (no child promotion)', () => {
    // moveItem would swap p with its child a → corruption. moveSubtree keeps p>a>b intact.
    const t = tree(['p', 0], ['a', 1], ['b', 2], ['s', 0]);
    expect(shape(moveSubtreeDir(t, 'p', 'down'))).toEqual(['s@0', 'p@0', 'a@1', 'b@2']);
  });

  it('moving a parent up moves its whole subtree above the previous sibling', () => {
    const t = tree(['s', 0], ['c', 1], ['p', 0], ['a', 1]); // s>c, p>a
    expect(shape(moveSubtreeDir(t, 'p', 'up'))).toEqual(['p@0', 'a@1', 's@0', 'c@1']);
  });

  it('is a no-op when there is no sibling in that direction', () => {
    const t = tree(['p', 0], ['a', 1], ['b', 1]); // a and b are children; a has no prev sibling
    expect(ids(moveSubtreeDir(t, 'a', 'up'))).toEqual(['p', 'a', 'b']); // a is first child → no-op
    expect(ids(moveSubtreeDir(t, 'b', 'down'))).toEqual(['p', 'a', 'b']); // b is last child → no-op
  });

  it('reorders leaf siblings like the old move but never corrupts', () => {
    const t = tree(['x', 0], ['y', 0], ['z', 0]);
    expect(ids(moveSubtreeDir(t, 'x', 'down'))).toEqual(['y', 'x', 'z']);
    expect(ids(moveSubtreeDir(t, 'z', 'up'))).toEqual(['x', 'z', 'y']);
  });
});

describe('moveSubtree — the drag-to-drop core', () => {
  const t = tree(['p', 0], ['a', 1], ['b', 2], ['q', 0], ['r', 0]);

  it('drops a subtree before an arbitrary target row (drag semantics)', () => {
    // drag p (with a,b) to before r
    expect(shape(moveSubtree(t, 'p', 'r'))).toEqual(['q@0', 'p@0', 'a@1', 'b@2', 'r@0']);
  });

  it('drop with null target appends the block to the end', () => {
    expect(ids(moveSubtree(t, 'p', null))).toEqual(['q', 'r', 'p', 'a', 'b']);
  });

  it('cannot drop a subtree into itself (no-op)', () => {
    expect(ids(moveSubtree(t, 'p', 'b'))).toEqual(['p', 'a', 'b', 'q', 'r']); // b is inside p
    expect(ids(moveSubtree(t, 'p', 'a'))).toEqual(['p', 'a', 'b', 'q', 'r']); // a is inside p
  });

  it('re-normalizes so a moved block adopts a legal depth (no skipped levels)', () => {
    // move a deep block (b at indent 2) to the front → its root clamps to 0, nesting preserved
    const deep = tree(['root', 0], ['mid', 1], ['leaf', 2]);
    const moved = moveSubtree(deep, 'leaf', 'root'); // leaf has no children → single row to front
    expect(shape(moved)).toEqual(['leaf@0', 'root@0', 'mid@1']);
  });

  it('unknown id → unchanged copy', () => {
    expect(ids(moveSubtree(t, 'nope', 'q'))).toEqual(ids(t));
  });
});
