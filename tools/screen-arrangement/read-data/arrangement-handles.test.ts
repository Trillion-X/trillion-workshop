import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../show/SplitTreeArranger.tsx', import.meta.url), 'utf8');
const words = JSON.parse(readFileSync(new URL('./arrangement-words.json', import.meta.url), 'utf8'));
const sizes = JSON.parse(readFileSync(new URL('../pane-sizes.json', import.meta.url), 'utf8'));

test('the pane handle names and announcements are lines of the words file', () => {
  for (const key of ['resize_width', 'resize_height', 'at_minimum', 'size', 'minimum_label']) {
    assert.equal(typeof words[key], 'string', key);
  }
  assert.ok(!source.includes("'Resize pane width'"));
  assert.ok(!source.includes('Use the arrow keys to resize this pane only'));
});

test('the pane handle rail has a resting opacity from DATA', () => {
  assert.equal(typeof sizes.defaults.handle_rail_rest_opacity, 'number');
  assert.ok(sizes.defaults.handle_rail_rest_opacity > 0);
});

import { shouldCommitPaneResize, splitCollapsedToFloor } from "../read-data/split-tree-operations";

test("a click that never moves commits nothing", () => {
  assert.equal(shouldCommitPaneResize({ moved: false, sizes: [300, 300] }), false);
});

test("a pane whose content has not arrived (0 px) commits nothing", () => {
  assert.equal(shouldCommitPaneResize({ moved: true, sizes: [0, 300] }), false);
});

test("a real move between measured panes commits", () => {
  assert.equal(shouldCommitPaneResize({ moved: true, sizes: [300, 300] }), true);
});

test("a split with every pane at the drag floor is collapsed", () => {
  assert.equal(splitCollapsedToFloor([20, 20, 20], 20), true);
  assert.equal(splitCollapsedToFloor([570, 20], 20), false);
});

test("the Home starting split has no zero size and each size is at least the content minimum", () => {
  const part = JSON.parse(readFileSync(new URL("../../keep-goals-and-focus/part.json", import.meta.url), "utf8"));
  const find = (node) => {
    if (node && typeof node === "object") {
      if (node.kind === "split" && node.dir === "column" && node.keep === true && Array.isArray(node.sizes)) return node;
      for (const value of Object.values(node)) {
        const hit = find(value);
        if (hit) return hit;
      }
    }
    return null;
  };
  const home = find(part);
  const minimum = JSON.parse(readFileSync(new URL("../pane-sizes.json", import.meta.url), "utf8")).defaults.content_minimum_height_px;
  assert.ok(home, "the Home split is found");
  assert.ok(home.sizes.every(size => size >= minimum), "every Home starting size is at least the content minimum");
});
