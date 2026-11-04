// tools/keep-a-search-that-found-no-tool/test/dead-end-search.test.mjs
//
// A search with no candidates is kept once per job and counted up; anything else is not a dead end. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deadEndJob, deadEndSearches } from '../src/dead-end-search.mjs';

function account({ due = true } = {}) {
  const settings = new Map();
  let noted = 0;
  const store = { setting: name => settings.get(name) ?? null, setSetting: (name, value) => { settings.set(name, value); return value; },
    settings: prefix => [...settings].filter(([name]) => name.startsWith(prefix)).map(([name, value]) => ({ name, value })) };
  let clock = Date.parse('2026-11-04T10:00:00Z');
  const searches = deadEndSearches({ store, keep: { due: () => due, noted: () => { noted += 1; } }, now: () => new Date(clock) });
  return { searches, notes: () => noted, tick: () => { clock += 60000; } };
}

test('only an answer with an empty candidates list is a dead end, and a job too short is not kept', () => {
  assert.equal(deadEndJob({ job: '  turn   a scan into text ' }, { candidates: [] }), 'turn a scan into text');
  assert.equal(deadEndJob({ job: 'turn a scan into text' }, { candidates: [{ tool_id: 'tool:a' }] }), '');
  assert.equal(deadEndJob({ job: 'turn a scan into text' }, { error: 'failed' }), '');
  assert.equal(deadEndJob({ job: 'ab' }, { candidates: [] }), '');
});

test('the same job is one record that counts up, newest first in the list', async () => {
  const { searches, notes, tick } = account();
  const first = await searches.missed({ job: 'turn a scan into text' }, { candidates: [] });
  tick();
  const again = await searches.missed({ job: 'turn a scan into text' }, { candidates: [] });
  tick();
  await searches.missed({ job: 'translate a voice note' }, { candidates: [] });
  assert.equal(again.times, 2);
  assert.equal(again.first_at, first.at);
  assert.equal(again.choice_id, first.choice_id);
  assert.equal(notes(), 3);
  assert.deepEqual(searches.list().map(row => row.job), ['translate a voice note', 'turn a scan into text']);
  assert.equal(await searches.missed({ job: 'turn a scan into text' }, { candidates: [{ tool_id: 'tool:a' }] }), null);
});

test('a job asked again inside the refresh window is not written again', async () => {
  const { searches, notes } = account({ due: false });
  await searches.missed({ job: 'turn a scan into text' }, { candidates: [] });
  const kept = await searches.missed({ job: 'turn a scan into text' }, { candidates: [] });
  assert.equal(kept.times, 1);
  assert.equal(notes(), 1);
});
