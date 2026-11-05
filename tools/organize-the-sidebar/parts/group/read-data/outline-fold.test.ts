// packages/group/read-data/outline-fold.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { hasChildren, hiddenByCollapse, visibleRows } from '../../../read-data/outline-fold.ts';
import type { ListItem } from '../../../read-data/list-block-model.ts';

const rows = (...indents: number[]): ListItem[] =>
  indents.map((indent, i) => ({ id: `r${i}`, indent, text: `t${i}` }));

describe('outline-fold — collapse/expand structure', () => {
  const tree = rows(0, 1, 2, 1, 0); // r0 > (r1 > r2, r3), r4

  it('hasChildren is true only for rows with a deeper next row', () => {
    expect(hasChildren(tree, 0)).toBe(true); // r0 has r1
    expect(hasChildren(tree, 1)).toBe(true); // r1 has r2
    expect(hasChildren(tree, 2)).toBe(false); // r2 (leaf)
    expect(hasChildren(tree, 3)).toBe(false); // r3 (leaf — next is shallower r4)
    expect(hasChildren(tree, 4)).toBe(false); // r4 (last)
  });

  it('collapsing a parent hides its whole subtree (the parent stays visible)', () => {
    const vis = visibleRows(tree, new Set(['r0']));
    expect(vis.map((r) => r.id)).toEqual(['r0', 'r4']); // r1/r2/r3 hidden, r0 & sibling r4 stay
  });

  it('collapsing a mid-level parent hides only its own descendants', () => {
    const vis = visibleRows(tree, new Set(['r1']));
    expect(vis.map((r) => r.id)).toEqual(['r0', 'r1', 'r3', 'r4']); // only r2 hidden
  });

  it('nested collapses compose (a row hidden by any collapsed ancestor)', () => {
    expect([...hiddenByCollapse(tree, new Set(['r0', 'r1']))].sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('no collapse → every row visible (identity)', () => {
    expect(visibleRows(tree, new Set()).map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('a collapsed LEAF hides nothing (no children)', () => {
    expect(visibleRows(tree, new Set(['r2'])).map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });
});
