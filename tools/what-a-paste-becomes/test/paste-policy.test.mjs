// tools/what-a-paste-becomes/read-data/paste-policy.mjs (DATA in paste-policy.json; moved with Trillion-X/trillion test/paste-policy.test.mjs): what a paste into a composer becomes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { markupHasText, pasteDecision } from '../read-data/paste-policy.mjs';

const now = () => new Date('2026-10-19T09:05:07Z');

test('short text is a normal paste; long text becomes a named attachment the person is told about', () => {
  assert.deepEqual(pasteDecision({ text: 'hello' }, { now }), { action: 'insert' });
  assert.deepEqual(pasteDecision({ text: 'x'.repeat(5000) }, { now }), { action: 'insert' }, 'exactly at the threshold stays text');
  const long = pasteDecision({ text: 'y'.repeat(5001) }, { now });
  assert.equal(long.action, 'attach_text');
  assert.equal(long.name, 'Pasted text 2026-10-19-09-05-07.txt');
  assert.equal(long.text.length, 5001);
  assert.equal(long.said, 'A long paste (5001 characters) became the attachment Pasted text 2026-10-19-09-05-07.txt.');
  console.log('REAL readback of a long paste decision:', JSON.stringify({ ...long, text: `[${long.text.length} chars]` }));
});

test('an image attaches only when the clipboard markup has no text of its own', () => {
  const png = { type: 'image/png', name: 'shot.png' };
  assert.equal(pasteDecision({ text: '', html: '', files: [png] }, { now }).action, 'attach_images');
  assert.equal(pasteDecision({ text: '', html: '<meta charset=utf-8><img src="a.png">', files: [png] }, { now }).action, 'attach_images', 'tags and no words is still just an image');
  assert.equal(pasteDecision({ text: 'A caption', html: '<p>A caption</p><img src="a.png">', files: [png] }, { now }).action, 'insert', 'a copied page keeps its text');
  assert.equal(pasteDecision({ text: '', html: '', files: [{ type: 'application/pdf' }] }, { now }).action, 'insert');
  assert.equal(markupHasText('<style>p{color:red}</style><img src="a.png">'), false, 'style bodies are not words');
  assert.equal(markupHasText('<div>&nbsp;</div>'), false);
});

test('the row sample runs as the container runs it: a long paste becomes a named attachment', () => {
  const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url))).records[0].payload;
  const run = spawnSync('node', ['read-data/paste-policy.mjs'], { cwd: new URL('..', import.meta.url), input: JSON.stringify(row.verify[0].input), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { result } = JSON.parse(run.stdout);
  assert.equal(result.action, 'attach_text');
  assert.equal(result.name, row.verify[0].contains);
});
