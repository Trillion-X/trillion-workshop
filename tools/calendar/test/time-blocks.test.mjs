// Carries the package's projection, account and sync-state cases (a bakery's own pickups and orders stand in for the
// package's fixtures), and adds the rows a lens cannot use or has no rows for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAccounts, readSelector, readSyncStates, readTimeBlocks } from '../read-data/time-blocks.mjs';

const lens = (owner, address, over = {}) => ({
  kind: 'time-block-lens', lens_id: 'blocks', input_address: address, owner_ref: owner, owner_label: owner,
  selectors: { identity: 'id', start: 'start', end: 'end', title: 'title', all_day: 'allDay', timezone: 'timezone', color: 'color', state: 'state', lane: 'lane' },
  relations: { linkedRecord: 'linkedRefs', account: 'accountRef' },
  ...over,
});

test('arbitrary rows project into blocks ordered by start, then end, then id; rows without an end are skipped and counted', () => {
  const result = readTimeBlocks([lens('shop-a', 'feed-a'), lens('shop-b', 'feed-b')], {
    'feed-a': [
      { id: 'same-id', start: '2026-06-16T14:00:00.000Z', end: '2026-06-16T15:00:00.000Z', title: 'Planning', timezone: 'Zone/One', color: '#2451ff', state: 'ready', lane: 'work', linkedRefs: ['record:one'], accountRef: 'account:a' },
      { id: 'missing-end', start: '2026-06-16T15:00:00.000Z' },
    ],
    'feed-b': [
      { id: 'same-id', start: '2026-06-16T14:30:00.000Z', end: '2026-06-16T15:30:00.000Z', title: 'Review', state: 'conflict', linkedRefs: 'record:two' },
      { id: 'free-window', start: '2026-06-16T16:00:00.000Z', end: '2026-06-16T16:30:00.000Z', title: 'Available', state: 'available' },
    ],
  });
  assert.deepEqual(result.diagnostics, { lensCount: 2, rowCount: 4, skippedRowCount: 1 });
  assert.deepEqual(result.blocks.map(block => block.id), ['shop-a:blocks:same-id', 'shop-b:blocks:same-id', 'shop-b:blocks:free-window']);
  assert.deepEqual(result.blocks[0].interval, { start: '2026-06-16T14:00:00.000Z', end: '2026-06-16T15:00:00.000Z', allDay: false, timezone: 'Zone/One' });
  assert.equal(result.blocks[0].display.title, 'Planning');
  assert.equal(result.blocks[0].display.color, '#2451ff');
  assert.deepEqual(result.blocks[0].relations, { linkedRecord: ['record:one'], account: ['account:a'] });
  assert.deepEqual(result.blocks[1].relations.linkedRecord, ['record:two']);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].id, 'rows-skipped');
});

test('a new kind of record that happens in time is one lens and no code', () => {
  const result = readTimeBlocks([{
    kind: 'time-block-lens', lens_id: 'scheduled-work', input_address: 'feed-work', owner_ref: 'work-owner',
    selectors: { identity: 'key', start: 'window.from', end: 'window.to', title: 'summary', state: { path: 'status', fallback: 'ready' } },
    relations: { linkedRecord: 'links' },
  }], { 'feed-work': [{ key: 'work-1', window: { from: '2026-06-16T17:00:00.000Z', to: '2026-06-16T17:20:00.000Z' }, summary: 'Follow up', links: ['record:alpha', 'record:beta'] }] });
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].id, 'work-owner:scheduled-work:work-1');
  assert.equal(result.blocks[0].display.title, 'Follow up');
  assert.equal(result.blocks[0].state.ref, 'ready');
  assert.deepEqual(result.blocks[0].relations.linkedRecord, ['record:alpha', 'record:beta']);
});

test('rows given as lists of cells are read by column', () => {
  const result = readTimeBlocks([{
    kind: 'time-block-lens', lens_id: 'cells', input_address: 'cell-feed', owner_ref: 'cell-owner',
    selectors: { identity: { column: 0 }, start: { column: 1 }, end: { column: 2 }, title: { column: 3 }, all_day: { column: 4 } },
  }], { 'cell-feed': [['cell-1', '2026-06-16T18:00:00.000Z', '2026-06-16T19:00:00.000Z', 'Cell row', 'true']] });
  assert.equal(result.blocks[0].id, 'cell-owner:cells:cell-1');
  assert.equal(result.blocks[0].interval.allDay, true);
  assert.equal(result.blocks[0].display.title, 'Cell row');
});

test('a fallback path lets an open-ended window end where it starts, and a title come from another field', () => {
  const result = readTimeBlocks([{
    kind: 'time-block-lens', lens_id: 'scheduled-actions', input_address: 'windows', owner_ref: 'work',
    selectors: { identity: 'time_window_id', start: 'start', end: { path: 'end', fallback_path: 'start' }, title: { path: 'title', fallback_path: 'record_id' } },
  }], { windows: [{ time_window_id: 'tw-1', start: '2026-07-21T15:00:00Z', record_id: 'work-a' }] });
  assert.equal(result.blocks[0].interval.end, '2026-07-21T15:00:00Z');
  assert.equal(result.blocks[0].display.title, 'work-a');
  assert.equal(readSelector({}, { path: 'x', fallback: 'kept' }), 'kept');
});

test('two lenses over the same rows give two distinct sets of blocks', () => {
  const rows = [{ id: 'shared', starts_at: '2026-07-19T09:00:00Z', ends_at: '2026-07-19T10:00:00Z' }];
  const make = (id, owner, address) => ({ kind: 'time-block-lens', lens_id: id, input_address: address, owner_ref: owner, selectors: { identity: 'id', start: 'starts_at', end: 'ends_at' } });
  const result = readTimeBlocks([make('l1', 'a', 'one'), make('l2', 'b', 'two')], { one: rows, two: rows });
  assert.equal(new Set(result.blocks.map(block => block.id)).size, 2);
});

test('no lenses gives no blocks and no issues; a lens with no rows and a lens that is not usable are each said', () => {
  assert.deepEqual(readTimeBlocks([], {}), { blocks: [], diagnostics: { lensCount: 0, rowCount: 0, skippedRowCount: 0 }, issues: [] });
  const result = readTimeBlocks([
    { kind: 'time-block-lens', lens_id: 'quiet', input_address: 'nothing-here', owner_ref: 'o', owner_label: 'Quiet shop', selectors: { identity: 'id', start: 's', end: 'e' } },
    { kind: 'time-block-lens', lens_id: 'broken', input_address: 'x', selectors: { identity: 'id' } },
    'not a lens',
  ], {});
  assert.deepEqual(result.issues.map(issue => issue.id), ['lens-has-no-rows:quiet', 'lens-unusable:broken', 'lens-unusable:unnamed']);
  assert.match(result.issues[1].detail, /owner_ref is missing.*selectors\.start is missing.*selectors\.end is missing/);
  assert.equal(result.diagnostics.lensCount, 1);
});

test('accounts are read through account lenses, ordered by label, with a primary calendar when none is listed', () => {
  const accountLens = { kind: 'calendar-account-lens', lens_id: 'accounts', input_address: 'accounts', selectors: { identity: 'id', label: 'name', color: 'colour', visible: 'shown', calendars: 'lists' } };
  const result = readAccounts([accountLens], {
    accounts: [
      { id: 'b', name: 'Zed', colour: '#111', shown: false },
      { id: 'a', name: 'Alpha', colour: '#222', lists: [{ id: 'a:one', label: 'One', read_only: true }, { id: '', label: 'dropped' }] },
      { name: 'no identity' },
    ],
  });
  assert.deepEqual(result.accounts.map(account => account.id), ['a', 'b']);
  assert.deepEqual(result.accounts[0].calendars, [{ id: 'a:one', label: 'One', color: '#222', visible: true, readOnly: true }]);
  assert.deepEqual(result.accounts[1].calendars, [{ id: 'b:primary', label: 'Zed', color: '#111', visible: false }]);
  assert.equal(result.accounts[1].visible, false);
  assert.equal(result.diagnostics.skippedRowCount, 1);
  assert.equal(result.accounts[0].statusLabel, 'Connected');
});

test('a queued change shows as a waiting block and is never called saved', () => {
  const result = readSyncStates([
    { id: 'queue-1', affected_block_ref: 'block:1', proposed_start: '2026-06-16T20:00:00.000Z', proposed_end: '2026-06-16T20:30:00.000Z' },
    { id: 'queue-2', affected_block_ref: 'block:3', proposed_start: '2026-06-16T22:00:00.000Z', proposed_end: '2026-06-16T22:30:00.000Z', queue_state: 'waiting-to-sync' },
    { id: 'no-times', affected_block_ref: 'block:9' },
  ], []);
  assert.deepEqual(result.diagnostics, { queuedCount: 2, conflictCount: 0 });
  assert.equal(result.queuedBlocks[0].id, 'calendar:queued-change:queue-1');
  assert.equal(result.queuedBlocks[0].display.title, 'Waiting to sync');
  assert.equal(result.queuedBlocks[0].state.ref, 'waiting-to-sync');
  assert.deepEqual(result.queuedBlocks[0].relations.affectedBlock, ['block:1']);
  assert.doesNotMatch(JSON.stringify(result), /saved/);
});

test('a conflict shows where it would land with the interval it replaces, each beside its own record', () => {
  const result = readSyncStates([], [
    { id: 'skipped', affected_block_ref: 'block:0', original_start: 'a', original_end: 'b' },
    { id: 'conflict-1', affected_block_ref: 'block:2', original_start: '2026-06-16T21:00:00.000Z', original_end: '2026-06-16T21:30:00.000Z', proposed_start: '2026-06-16T21:15:00.000Z', proposed_end: '2026-06-16T21:45:00.000Z', owner_message_ref: 'message:conflict' },
  ]);
  assert.deepEqual(result.diagnostics, { queuedCount: 0, conflictCount: 1 });
  const block = result.conflictBlocks[0];
  assert.equal(block.id, 'calendar:conflict:conflict-1');
  assert.equal(block.display.title, 'Resolve conflict');
  assert.equal(block.state.ref, 'conflict');
  assert.deepEqual(block.relations, {
    affectedBlock: ['block:2'],
    ownerMessage: ['message:conflict'],
    originalInterval: ['2026-06-16T21:00:00.000Z', '2026-06-16T21:30:00.000Z'],
  });
});
