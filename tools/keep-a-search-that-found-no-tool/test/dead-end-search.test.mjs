// tools/keep-a-search-that-found-no-tool/test/dead-end-search.test.mjs
//
// Only an answer with no candidates is a dead end, the job is tidied and cut, and one job has one record name.
// The counted record itself is proven on the store by the recipe (workflow:keep-a-search-that-found-no-tool).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deadEndJob, deadEndName } from '../src/dead-end-search.mjs';

test('only an answer with an empty candidates list is a dead end, and a job too short is not kept', () => {
  assert.equal(deadEndJob({ job: '  turn   a scan into text ' }, { candidates: [] }), 'turn a scan into text');
  assert.equal(deadEndJob({ job: 'turn a scan into text' }, { candidates: [{ tool_id: 'tool:a' }] }), '');
  assert.equal(deadEndJob({ job: 'turn a scan into text' }, { error: 'failed' }), '');
  assert.equal(deadEndJob({ job: 'ab' }, { candidates: [] }), '');
});

test('one job has one record name, and the name stays inside the choice family', () => {
  const name = deadEndName('turn a scan into text');
  assert.equal(name, deadEndName('turn a scan into text'));
  assert.notEqual(name, deadEndName('translate a voice note'));
  assert.ok(name.startsWith('choice:tool:dead:'));
  assert.equal(name.length, 'choice:tool:dead:'.length + 32);
});
