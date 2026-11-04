// Registry tools are told apart as read, write or unknown from two independent signals (src/tool-sources.mjs toolEffectOf),
// and one that may change things is kept as effectful.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowFromEntry, toolEffectOf } from '../src/tool-sources.mjs';

test('a tool is read only when the request is safe and its words say nothing of changing things', () => {
  assert.equal(toolEffectOf({ method: 'GET', label: 'Search videos', job: 'Finds videos about a topic' }), 'read');
  assert.equal(toolEffectOf({ read_only: true, label: 'List files' }), 'read');
  assert.equal(toolEffectOf({ method: 'POST', label: 'Search videos' }), 'write', 'an unsafe request is a write whatever it says');
  assert.equal(toolEffectOf({ method: 'GET', label: 'Delete a video' }), 'write', 'its own words can say write even when the request looks safe');
  assert.equal(toolEffectOf({ read_only: false, label: 'List files' }), 'write');
  assert.equal(toolEffectOf({ label: 'Do the thing' }), 'unknown');
  assert.equal(toolEffectOf({ label: 'Send an email' }), 'write');
});

test('a registry result that is not known to only read is kept as one that may change things', () => {
  const source = { id: 'source:x', id_prefix: 'tool:x:', label: 'X', entry: { id: 'id', label: 'name', job: 'summary', method: 'method' }, row: { invoke: { kind: 'gateway-call', url: 'https://x.example/{id}' } } };
  const kept = (raw) => rowFromEntry(source, raw).invoke.external_effect;
  assert.equal(kept({ id: 'a', name: 'Search', summary: 'find things', method: 'GET' }), undefined, 'a read leaves the row as it was');
  assert.equal(kept({ id: 'b', name: 'Publish a post', summary: 'publish', method: 'POST' }), true);
  assert.equal(kept({ id: 'c', name: 'Mystery', summary: 'does something' }), true, 'unknown is never taken for read only');
  const row = rowFromEntry(source, { id: 'b', name: 'Publish a post', summary: 'publish', method: 'POST' });
  console.log('EFFECT READBACK:', JSON.stringify({ id: row.id, external_effect: row.invoke.external_effect }));
});
