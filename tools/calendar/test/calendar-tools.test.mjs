// Each tool runs the way its row runs it: its argv, with the input on stdin, in the folder its workdir stands for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

function runByRow(toolId, input, { stdio } = {}) {
  const row = rows.find(item => item.id === toolId);
  assert.ok(row, `${toolId} is a row in tool-rows.json`);
  assert.equal(row.invoke.workdir, row.invoke.files.package_files.at);
  assert.deepEqual(row.invoke.stdin, { fill: { from: 'input' } });
  const ran = spawnSync(process.execPath, row.invoke.argv.slice(1), { cwd: folder, encoding: 'utf8', input: JSON.stringify(input), ...(stdio ? { stdio } : {}) });
  if (ran.status !== 0) return { refused: ran.stderr.trim() };
  return JSON.parse(ran.stdout.trim().split('\n').at(-1));
}

const pick = (answer, selector) => selector.slice(1).match(/[^.[\]]+/g).reduce((value, key) => value?.[key], answer);

test('every row\'s sample run gives what its verify says', () => {
  for (const row of rows.filter(item => Array.isArray(item.verify))) {
    for (const check of row.verify.filter(item => item.kind === 'sample-run')) {
      assert.ok(JSON.stringify(pick(runByRow(row.id, check.input), check.output_selector)).includes(check.contains), `${row.id}: ${check.output_selector} contains ${check.contains}`);
    }
  }
});

test('the Google row mounts three held values on three descriptors and reads, never writes', () => {
  const row = rows.find(item => item.id === 'tool:read-google-calendar-events');
  assert.deepEqual(row.invoke.credential_mounts.map(mount => mount.fd), [3, 4, 5]);
  assert.ok(row.invoke.credential_mounts.every(mount => /^google-calendar-[a-z-]+$/.test(mount.secret_name)));
  assert.equal(row.invoke.internet, true);
  const code = ['do-work/read-google-calendar-events.mjs', 'read-data/google-events.mjs'].map(file => readFileSync(resolve(folder, file), 'utf8')).join('\n');
  assert.doesNotMatch(code, /method:\s*'(PUT|PATCH|DELETE)'/);
  assert.doesNotMatch(code, /console\.|process\.env/);
});

test('reading time blocks through the row: blocks, accounts and sync states together', () => {
  const answer = runByRow('tool:read-time-blocks', {
    lenses: [{ kind: 'time-block-lens', lens_id: 'orders', input_address: 'pickups', owner_ref: 'bakery', selectors: { identity: 'id', start: 's', end: 'e' } }],
    feeds: { pickups: [{ id: 'p1', s: '2026-01-05T09:00:00Z', e: '2026-01-05T09:30:00Z' }, { id: 'p0', s: '2026-01-05T08:00:00Z', e: '2026-01-05T08:30:00Z' }], people: [{ id: 'u', name: 'Ada' }] },
    account_lenses: [{ kind: 'calendar-account-lens', lens_id: 'people', input_address: 'people', selectors: { identity: 'id', label: 'name' } }],
    queued_changes: [{ id: 'q', affected_block_ref: 'b', proposed_start: '2026-01-05T10:00:00Z', proposed_end: '2026-01-05T10:30:00Z' }],
  });
  assert.deepEqual(answer.blocks.map(block => block.id), ['bakery:orders:p0', 'bakery:orders:p1']);
  assert.equal(answer.accounts[0].label, 'Ada');
  assert.equal(answer.queued_blocks[0].state.ref, 'waiting-to-sync');
  assert.equal(answer.conflict_blocks.length, 0);
});

test('laying out through the row, with blocks read by the other row', () => {
  const read = runByRow('tool:read-time-blocks', {
    lenses: [{ kind: 'time-block-lens', lens_id: 'orders', input_address: 'pickups', owner_ref: 'bakery', selectors: { identity: 'id', start: 's', end: 'e' } }],
    feeds: { pickups: [{ id: 'p1', s: '2026-01-07T09:00:00Z', e: '2026-01-07T10:00:00Z' }, { id: 'p2', s: '2026-01-07T09:15:00Z', e: '2026-01-07T09:45:00Z' }] },
  });
  const laid = runByRow('tool:lay-out-a-calendar-view', { blocks: read.blocks, views: [{ kind: 'calendar-view-descriptor', view_id: 'day', layout: 'time-grid' }], utc_offset_minutes: 60 });
  assert.equal(laid.anchor_day, '2026-01-07');
  assert.deepEqual(laid.days[0].timed.map(item => [item.id, item.start_minute, item.column, item.column_count]), [['bakery:orders:p1', 600, 0, 2], ['bakery:orders:p2', 615, 1, 2]]);
  assert.deepEqual(laid.clashes[0].ids, ['bakery:orders:p1', 'bakery:orders:p2']);
});

test('bad input is refused with every problem listed', () => {
  const read = runByRow('tool:read-time-blocks', { lenses: {}, feeds: { a: 1 }, queued_changes: 3 });
  for (const part of ['lenses must be', 'feeds.a must be', 'queued_changes must be']) assert.match(read.refused, new RegExp(part));
  const laid = runByRow('tool:lay-out-a-calendar-view', { blocks: [{ id: 'x' }], views: 'day', anchor: 4, utc_offset_minutes: 5000 });
  for (const part of ['views must be a list', 'blocks\\[0\\] must be', 'anchor must be text', 'utc_offset_minutes']) assert.match(laid.refused, new RegExp(part));
  assert.match(runByRow('tool:read-time-blocks', 5).refused, /Give \{ lenses, feeds \}/);
});

test('the Google row without its credentials refuses by name and sends nothing', () => {
  const refused = runByRow('tool:read-google-calendar-events', { range_start: '2026-06-01T00:00:00Z', range_end: '2026-07-01T00:00:00Z' }, { stdio: ['pipe', 'pipe', 'pipe'] });
  assert.match(refused.refused, /No Google client id arrived/);
});
