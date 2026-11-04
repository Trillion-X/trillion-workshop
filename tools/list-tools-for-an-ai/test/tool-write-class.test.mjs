// Whether a tool changes anything, from its own operation (read-data/tool-write-class.mjs). Moved from Trillion-X/trillion
// test/spaces.test.mjs ('a pursuit runs tools that change things unless its own rules deny run_write_tool; reads are never
// held'): its first four lines, assertions unchanged. The rest of that test runs a pursuit's rules through
// src/person-spaces.mjs and stays in trillion with that caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a pursuit runs tools that change things unless its own rules deny run_write_tool; reads are never held', async () => {
  const { writeClassOf } = await import('../read-data/tool-write-class.mjs');
  assert.deepEqual(['tool:read-calendar', 'tool:send-to-all-ais', 'tool:anything-odd'].map(id => writeClassOf({ id })), ['read', 'write', 'write']);
  assert.equal(writeClassOf({ id: 'tool:odd', read_only: true }), 'read');
  assert.equal(writeClassOf({ id: 'tool:x', invoke: { action: 'list-things' } }), 'read');
});
