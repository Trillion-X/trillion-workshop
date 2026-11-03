// tools/media-composition/test/edit-command-log.test.mjs
//
// An edit session is a log of typed commands (tools/media-composition/read-data/edit-command-log.mjs): appended before shown,
// snapshotted every few, reopened exactly (undo history included), with undo and redo as entries and groups kept or discarded whole.
import assert from 'node:assert/strict';
import test from 'node:test';
import rules from '../read-data/edit-command-log.json' with { type: 'json' };
import { memoryEditLogStore, openEditLog } from '../read-data/edit-command-log.mjs';

const reduce = (state, command) => {
  if (command.type === 'ADD_CUT') return { ...state, cuts: [...state.cuts, command.cut] };
  if (command.type === 'REMOVE_CUT') return { ...state, cuts: state.cuts.filter((cut) => cut.id !== command.id) };
  if (command.type === 'SET_ZOOM') return { ...state, zoom: command.zoom };
  throw new Error(`unknown command ${command.type}`);
};
const initial = { cuts: [], zoom: 1 };
const open = (store, session = 's1') => openEditLog({ session, store, reduce, initial });
const cut = (id) => ({ type: 'ADD_CUT', cut: { id, start: 0, end: 1 } });

test('every command is appended before the new state is returned, and a failing append changes nothing', async () => {
  const store = memoryEditLogStore();
  const log = await open(store);
  assert.deepEqual((await log.apply(cut('a'))).cuts.map((c) => c.id), ['a']);
  assert.deepEqual((await store.entriesAfter('s1', 0)).map((e) => [e.seq, e.command.type]), [[1, 'ADD_CUT']]);
  const failing = { ...store, append: async () => { throw new Error('disk full'); } };
  const broken = await openEditLog({ session: 's1', store: failing, reduce, initial });
  await assert.rejects(() => broken.apply(cut('b')), /disk full/);
  assert.deepEqual(broken.state().cuts.map((c) => c.id), ['a']);
  assert.equal(broken.seq(), 1);
});

test('a reload with no snapshot replays the whole log to the same state', async () => {
  const store = memoryEditLogStore();
  const log = await open(store);
  await log.apply(cut('a')); await log.apply({ type: 'SET_ZOOM', zoom: 2 }); await log.apply(cut('b'));
  const again = await open(store);
  assert.deepEqual(again.state(), log.state());
  assert.equal(again.seq(), 3);
});

test('a snapshot is written every N commands and a reload reads it plus only the commands after it', async () => {
  const store = memoryEditLogStore();
  const log = await open(store);
  for (let index = 1; index <= rules.snapshot_every + 3; index += 1) await log.apply(cut(`c${index}`));
  const snapshot = await store.latestSnapshot('s1');
  assert.equal(snapshot.seq, rules.snapshot_every);
  assert.equal((await store.entriesAfter('s1', snapshot.seq)).length, 3);
  const reads = [];
  const watching = { ...store, entriesAfter: async (session, after) => { reads.push(after); return store.entriesAfter(session, after); } };
  const again = await openEditLog({ session: 's1', store: watching, reduce, initial });
  assert.deepEqual(reads, [rules.snapshot_every]);
  assert.deepEqual(again.state(), log.state());
});

test('undo and redo are entries too, so a reload reproduces them, and a new command clears what could be redone', async () => {
  const store = memoryEditLogStore();
  const log = await open(store);
  await log.apply(cut('a')); await log.apply(cut('b'));
  await log.undo();
  assert.deepEqual(log.state().cuts.map((c) => c.id), ['a']);
  assert.deepEqual((await open(store)).state(), log.state());
  await log.redo();
  assert.deepEqual(log.state().cuts.map((c) => c.id), ['a', 'b']);
  await log.undo();
  await log.apply(cut('c'));
  const length = log.seq();
  await log.redo();
  assert.equal(log.seq(), length, 'nothing to redo after a new command: no entry written');
  assert.deepEqual((await open(store)).state().cuts.map((c) => c.id), ['a', 'c']);
  const empty = await open(memoryEditLogStore(), 'other');
  await empty.undo();
  assert.equal(empty.seq(), 0, 'nothing to undo: no entry written');
});

test('undo history survives a snapshot exactly', async () => {
  const store = memoryEditLogStore();
  const log = await open(store);
  for (let index = 1; index <= rules.snapshot_every; index += 1) await log.apply(cut(`c${index}`));
  assert.equal((await store.latestSnapshot('s1')).seq, rules.snapshot_every);
  const again = await open(store);
  await again.undo();
  assert.equal(again.state().cuts.length, rules.snapshot_every - 1);
  await again.redo();
  assert.deepEqual(again.state(), log.state());
});

test('undo goes back no further than most_undo', async () => {
  const store = memoryEditLogStore();
  const small = { ...rules, most_undo: 3 };
  const log = await openEditLog({ session: 's', store, reduce, initial }, small);
  for (let index = 1; index <= 6; index += 1) await log.apply(cut(`c${index}`));
  for (let index = 0; index < 6; index += 1) await log.undo();
  assert.deepEqual(log.state().cuts.map((c) => c.id), ['c1', 'c2', 'c3']);
});

test('a group is kept whole or discarded whole', async () => {
  const store = memoryEditLogStore();
  const log = await open(store);
  await log.apply(cut('a'));
  const kept = log.group();
  await kept.apply({ type: 'SET_ZOOM', zoom: 2 }); await kept.apply({ type: 'SET_ZOOM', zoom: 3 });
  assert.equal(kept.keep().zoom, 3);
  const dropped = log.group();
  await dropped.apply({ type: 'SET_ZOOM', zoom: 5 }); await dropped.apply(cut('b'));
  assert.equal((await dropped.discard()).zoom, 3);
  assert.deepEqual(log.state().cuts.map((c) => c.id), ['a']);
  assert.deepEqual((await open(store)).state(), log.state());
});
