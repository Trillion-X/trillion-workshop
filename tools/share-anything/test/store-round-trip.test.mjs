// tools/share-anything/test/store-round-trip.test.mjs
//
// The proof that the tool works on the person's own store in the store's own language: one scenario (a list shared with a person
// and a link, a person stopped, a run share given and ended by its rule) run on a Map, on PGlite (a real Postgres-compatible
// database, in memory) and on a JSON folder in a new temporary directory. Each store must answer the same and hold no key.
// Every name and time is made up.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { shareAnything } from '../do-work/share-anything.mjs';
import { applyWrites, callSweep, callTool, jsonFolderStore, memoryStore, pgliteStore } from './caller-store.mjs';

const list = { label: 'Sample list', row_type: 'sample-row', fields: [{ id: 'title', label: 'Title' }] };
const seed = { 'list:sample': list };
const FUTURE = '2999-01-01T00:00:00.000Z';

async function scenario(store) {
  const shared = await callTool(store, { op: 'share', grant: 'sharing:list:sample', thing: { list: 'sample' }, with: ['sample-person'], link: true, origin: 'https://example.invalid', until: FUTURE });
  const keys = [shared.people[0].key, shared.link.key];
  const stopped = await callTool(store, { op: 'stop', grant: 'sharing:list:sample', principal: 'sample-person' });
  const seen = await callTool(store, { op: 'access', grant: 'sharing:list:sample' });
  const runShared = await callTool(store, { op: 'share', can: ['run'], grant: 'sharing:team-tools', tools: ['tool:sample-a'], with: ['member-a'], unused_days: 30, now: '2026-01-01T00:00:00.000Z' });
  const swept = await callSweep(store, '2026-03-01T00:00:00.000Z', { 'sharing:team-tools': '2026-01-05T00:00:00.000Z' });
  const left = await store.get('sharing:team-tools');
  const everything = await store.text();
  return {
    keys,
    answers: {
      shared: { label: shared.label, reach: shared.reach, people: shared.people.map(person => person.principal), expires_at: shared.expires_at },
      stopped: stopped.removed,
      seen: { state: seen.state, people: seen.people.map(person => person.principal), link: seen.link.on },
      runShared: { tools: runShared.tools, ends: runShared.ends },
      swept: { ended: swept.ended, waiting: swept.waiting, never: swept.never, writes: swept.writes.length },
      run: left,
    },
    everything,
  };
}

async function onEach(name, make) {
  const result = await make();
  // Keys are answered once: they are in the answers, never in what the store holds.
  for (const key of result.keys) assert.equal(result.everything.includes(key), false, `${name}: no key is kept`);
  assert.equal(result.everything.includes('shr_'), false, `${name}: no key prefix is kept`);
  return result.answers;
}

test('the same scenario answers the same on a Map, PGlite and a JSON folder, and each keeps no key', async () => {
  const fromMemory = await onEach('memory', () => scenario(memoryStore(seed)));
  const fromPglite = await onEach('pglite', async () => {
    const db = new PGlite();
    try { return await scenario(await pgliteStore(db, seed)); } finally { await db.close(); }
  });
  const folder = join(tempFolder(join(tmpdir(), 'share-anything-proof-')), 'store');
  const fromFolder = await onEach('json-folder', () => scenario(jsonFolderStore(folder, seed)));
  assert.deepEqual(fromPglite, fromMemory, 'PGlite answers what the Map answers');
  assert.deepEqual(fromFolder, fromMemory, 'the JSON folder answers what the Map answers');
  assert.equal(fromMemory.swept.ended.length, 1, 'the run share whose 30 days passed unused is withdrawn');
  assert.equal(fromMemory.run, null, 'and no longer held');
});

test('a write made on PGlite after the tool read the store is refused, and the other change stays', async () => {
  const db = new PGlite();
  try {
    const store = await pgliteStore(db, seed);
    await callTool(store, { op: 'share', grant: 'sharing:list:sample', thing: { list: 'sample' }, with: ['first'] });
    const before = await store.get('sharing:list:sample');
    const answer = shareAnything({ op: 'stop', grant: 'sharing:list:sample', principal: 'first', stored: { kept: before } });
    await store.put('sharing:list:sample', { ...before, title: 'Changed by someone else' }, 'share');
    await assert.rejects(() => applyWrites(store, answer.writes), /conflict at sharing:list:sample/);
    const after = await store.get('sharing:list:sample');
    assert.equal(after.title, 'Changed by someone else');
    assert.equal(after.people.length, 1, 'the stop was not made blind');
  } finally { await db.close(); }
});
