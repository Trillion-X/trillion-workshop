import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeOf, rowOf } from '../do-work/tell-the-makers.mjs';

const note = 'The export button does nothing on the Files screen.\nSecond line of detail.';

test('the same feedback always gets the same content id, under the feedback prefix', () => {
  const one = rowOf(shapeOf({ credential_name: 'makers-login', kind: 'friction', note, where: 'my workspace', screen: 'https://example.com/files' }));
  const two = rowOf(shapeOf({ credential_name: 'makers-login', kind: 'friction', note, where: 'my workspace', screen: 'https://example.com/files' }));
  assert.equal(one.id, two.id);
  assert.match(one.id, /^record:calendar-task:feedback-[0-9a-f]{64}$/);
  assert.notEqual(one.id, rowOf(shapeOf({ credential_name: 'makers-login', kind: 'a bug report', note, where: 'my workspace' })).id);
});

test('the title is the first line, cut to 80 characters; the description keeps the whole note, kind, where and screen', () => {
  const row = rowOf(shapeOf({ credential_name: 'makers-login', kind: 'an idea', note: 'x'.repeat(120), where: 'Acme', screen: 'https://example.com/s' }));
  assert.equal(row.title.length, 80);
  assert.ok(row.description.startsWith('x'.repeat(120)));
  assert.match(row.description, /Kind: an idea/);
  assert.match(row.description, /Where: Acme/);
  assert.match(row.description, /Screen: https:\/\/example\.com\/s/);
  assert.equal(rowOf(shapeOf({ credential_name: 'makers-login', kind: 'feedback', note })).title, note.split('\n')[0]);
});

test('a kind outside the four, an empty note and an over-long note are refused', () => {
  assert.throws(() => shapeOf({ credential_name: 'makers-login', kind: 'praise', note }), /kind must be one of/);
  assert.throws(() => shapeOf({ credential_name: 'makers-login', kind: 'feedback', note: '   ' }), /note must be your words/);
  assert.throws(() => shapeOf({ kind: 'feedback', note, credential_name: '' }), /credential_name/);
  assert.throws(() => shapeOf({ credential_name: 'makers-login', kind: 'feedback', note: 'x'.repeat(8001) }), /at most 8000/);
});
