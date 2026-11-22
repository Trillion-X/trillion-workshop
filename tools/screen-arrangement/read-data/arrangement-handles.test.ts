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
