import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepNewArcTabs, blake3Hex } from '../do-work/keep-new-arc-tabs-in-the-inspiration-library.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sidebar = join(here, 'fixtures', 'arc-sidebar-sample.json');
const obscura = join(here, 'stand-in', 'obscura-stub.mjs');
const calm = { oneMinuteLoad: () => 10, pause: async () => {} };
const fresh = () => mkdtempSync(join(tmpdir(), 'arc-intake-test-'));
const base = { obscura, sidebar };

test('plans the new rows, shoots the design rows and keeps the ledger', async () => {
  const state = fresh();
  const out = await keepNewArcTabs({ ...base, held: [], limit: 10, state_folder: state }, { blake3Hex, ...calm });
  assert.equal(out.outcome, 'planned');
  assert.equal(out.counts.new, 5);
  assert.equal(out.counts.shots_ok, 2);
  assert.equal(out.counts.shots_failed, 0);
  assert.equal(out.statements.filter(s => s.startsWith('insert into public.inspiration_items')).length, 1);
  assert.equal(out.statements.filter(s => s.startsWith('update public.inspiration_items')).length, 2);
  assert.ok(out.shots.every(s => existsSync(s.path)));
  assert.ok(existsSync(join(state, 'ledger.json')));
  const again = await keepNewArcTabs({ ...base, held: [], limit: 10, state_folder: state }, { blake3Hex, ...calm });
  assert.equal(again.counts.new, 0);
  assert.equal(again.shots.length, 0);
});

test('skips addresses the library already holds', async () => {
  const out = await keepNewArcTabs({ ...base, held: ['https://refero.design/x'], limit: 10, state_folder: fresh() }, { blake3Hex, ...calm });
  assert.equal(out.counts.held, 1);
  assert.equal(out.counts.new, 4);
  assert.equal(out.shots.length, 1);
});

test('marks a shot that fails as failed and keeps going', async () => {
  const out = await keepNewArcTabs({
    ...base,
    held: [],
    limit: 10,
    state_folder: fresh(),
    pending_shots: [{ id: 'record:inspiration-item:0000000000000000', url: 'https://unreachable.example/', kind: 'site', site: 'unreachable.example' }],
  }, { blake3Hex, ...calm });
  const failed = out.shots.find(s => s.id === 'record:inspiration-item:0000000000000000');
  assert.equal(failed.ok, false);
  assert.ok(out.statements.some(s => s.includes("screenshot_state = 'failed'") && s.includes('0000000000000000')));
  assert.equal(out.counts.shots_failed, 1);
});

test('waits while the one-minute load is at or above the gate', async () => {
  const readings = [90, 90, 10, 10, 10];
  let paused = 0;
  const out = await keepNewArcTabs({ ...base, held: [], limit: 10, state_folder: fresh() }, {
    blake3Hex,
    oneMinuteLoad: () => readings.shift() ?? 10,
    pause: async ms => { assert.equal(ms, 60_000); paused += 1; },
  });
  assert.equal(paused, 2);
  assert.equal(out.waited, 2);
});

test('batches the insert statements at 200 rows', async () => {
  const lines = [];
  for (let i = 0; i < 450; i++) lines.push('T' + i, { parentID: 'F1', data: { tab: { savedURL: `https://site${i}.example/`, savedTitle: `Site ${i}` } } });
  const big = join(fresh(), 'sidebar.json');
  writeFileSync(big, JSON.stringify({ sidebar: { containers: [{ spaces: [], items: ['F1', { parentID: null, data: { itemContainer: { containerType: { spaceItems: { _0: 'S1' } } } } }, ...lines] }] } }));
  const out = await keepNewArcTabs({ obscura, sidebar: big, held: [], limit: 0, state_folder: fresh() }, { blake3Hex, ...calm });
  const inserts = out.statements.filter(s => s.startsWith('insert into'));
  assert.deepEqual(inserts.map(s => (s.match(/\('record:inspiration-item:/g) ?? []).length), [200, 200, 50]);
});
