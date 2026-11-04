// tools/write-a-post-for-each-place/test/write-a-post-row.test.mjs
//
// tool:write-a-post-for-a-place run the way the container runner runs it: the same blocks become a body for a named surface,
// for a capability record handed in whole and for a post place's own limits; a wrong choice of record is refused in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rowOf(rows, 'tool:write-a-post-for-a-place');
const blocks = [
  { type: 'heading', text: 'What changed', level: 2 },
  { type: 'collapsible', summary: 'Files', blocks: [{ type: 'list', items: ['a.js'] }] },
  { type: 'checklist', items: [{ text: 'Tests', done: true }] },
];

test('a named surface that shows everything folds sections and draws boxes, with the marker first', async () => {
  const ran = await runRow(row, { surface: 'github_comment', marker: 'marker:one', blocks });
  assert.equal(ran.status, 0);
  assert.ok(ran.result.body.startsWith('marker:one'));
  assert.ok(ran.result.body.includes('<details>') && ran.result.body.includes('- [x] Tests'));
  assert.deepEqual(ran.result.degraded, []);
  assert.equal(ran.result.capability.id, 'github_comment');
});

test('a capability record handed in whole degrades what it cannot show; a post place becomes a record from its limits', async () => {
  const plain = await runRow(row, { capability: { dialect: 'plain', html: false, collapsibles: false, checkboxes: false, max_chars: null, theme: { strategy: 'single' } }, blocks });
  assert.equal(plain.status, 0);
  assert.ok(!plain.result.body.includes('<') && !plain.result.body.includes('#'));
  assert.deepEqual([...plain.result.degraded].sort(), ['checkboxes', 'collapsibles']);
  const placed = await runRow(row, { place: { id: 'post-place:sample', format: { caption_max_characters: 40 } }, blocks: [{ type: 'paragraph', text: 'x'.repeat(30) }, { type: 'paragraph', text: 'y'.repeat(30) }] });
  assert.equal(placed.status, 0);
  assert.equal(placed.result.truncated, true);
  assert.deepEqual(placed.result.unproven_used, ['max_chars']);
});

test('an unknown surface, two records at once, or an unknown block type is refused in words', async () => {
  const unknown = await runRow(row, { surface: 'nowhere', blocks });
  assert.match(unknown.error, /No surface is named nowhere/);
  const both = await runRow(row, { surface: 'plain_message', place: {}, blocks });
  assert.match(both.error, /exactly one of surface/);
  const odd = await runRow(row, { surface: 'plain_message', blocks: [{ type: 'video' }] });
  assert.match(odd.error, /unknown block type/);
});
