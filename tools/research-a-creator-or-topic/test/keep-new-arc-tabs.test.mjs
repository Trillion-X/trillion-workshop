import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepNewArcTabs, blake3Hex } from '../do-work/keep-new-arc-tabs-in-the-inspiration-library.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const blake3Bytes = bytes => makeHashCodeHexFromBytes(bytes).slice(3);

const here = dirname(fileURLToPath(import.meta.url));
const sidebar = join(here, 'fixtures', 'arc-sidebar-sample.json');
const obscura = join(here, 'stand-in', 'obscura-stub.mjs');
const calm = { oneMinuteLoad: () => 10, pause: async () => {} };
const base = { obscura, sidebar };

// The runner writes its scratch folder and its output under the working folder, so each test runs in its own.
function inFreshFolder() {
  const folder = mkdtempSync(join(tmpdir(), 'arc-intake-test-'));
  process.chdir(folder);
  return folder;
}

const shotsOut = () => JSON.parse(readFileSync(join('out', 'shots.json'), 'utf8'));

test('plans the new rows, shoots the design rows and bundles the shots into one output', async () => {
  inFreshFolder();
  const out = await keepNewArcTabs({ ...base, held: [], limit: 10 }, { blake3Hex, ...calm });
  assert.equal(out.outcome, 'planned');
  assert.equal(out.counts.new, 5);
  assert.equal(out.counts.shots_ok, 2);
  assert.equal(out.counts.shots_failed, 0);
  assert.equal(out.rows.length, 5);
  assert.equal(out.shot_rows.filter(s => s.state === 'none' && s.name).length, 2);
  const shots = shotsOut();
  assert.equal(shots.length, 2);
  for (const shot of shots) {
    assert.match(shot.name, /^\/library\/inspiration\/(site|component|flow)\/.+\.png$/);
    assert.ok(Buffer.from(shot.png_base64, 'base64').length > 0);
  }
  assert.deepEqual(shots.map(s => s.id), out.shot_rows.filter(s => s.name).map(s => s.id));
  for (const row of out.shot_rows.filter(s => s.name)) {
    assert.match(row.blake3, /^[0-9a-f]{64}$/);
    const shot = shots.find(s => s.id === row.id);
    assert.equal(row.blake3, blake3Bytes(Buffer.from(shot.png_base64, 'base64')), 'the identity is the BLAKE3 of the shot bytes');
  }
  assert.equal(existsSync(join('work', 'StorableSidebar.copy.json')), false, 'the sidebar copy is removed');
  assert.equal(existsSync(join('work', 'ledger.json')), false, 'no ledger is written');
});

test('plans the same rows again on a second run, since nothing is recorded anywhere', async () => {
  inFreshFolder();
  const first = await keepNewArcTabs({ ...base, held: [], limit: 0 }, { blake3Hex, ...calm });
  const again = await keepNewArcTabs({ ...base, held: [], limit: 0 }, { blake3Hex, ...calm });
  assert.equal(first.counts.new, 5);
  assert.equal(again.counts.new, 5);
  assert.deepEqual(again.rows.map(r => r.id), first.rows.map(r => r.id));
});

test('skips addresses the library already holds', async () => {
  inFreshFolder();
  const out = await keepNewArcTabs({ ...base, held: ['https://refero.design/x'], limit: 10 }, { blake3Hex, ...calm });
  assert.equal(out.counts.held, 1);
  assert.equal(out.counts.new, 4);
  assert.equal(out.shot_rows.length, 1);
});

test('compares held addresses in canonical form, as the library stores them raw', async () => {
  inFreshFolder();
  const out = await keepNewArcTabs({
    ...base,
    held: ['https://www.youtube.com/watch?v=abc123&t=9', 'https://www.refero.design/x?utm_source=b'],
    limit: 0,
  }, { blake3Hex, ...calm });
  assert.equal(out.counts.held, 2);
  assert.equal(out.counts.new, 3);
});

test('marks a shot that fails as failed with no file name, keeps going, and bundles only the shots that worked', async () => {
  inFreshFolder();
  const out = await keepNewArcTabs({
    ...base,
    held: [],
    limit: 10,
    pending_shots: [{ id: 'record:inspiration-item:0000000000000000', url: 'https://unreachable.example/', kind: 'site', site: 'unreachable.example' }],
  }, { blake3Hex, ...calm });
  const failed = out.shot_rows.find(s => s.id === 'record:inspiration-item:0000000000000000');
  assert.deepEqual(failed, { id: 'record:inspiration-item:0000000000000000', name: null, blake3: null, state: 'failed' });
  assert.equal(out.counts.shots_failed, 1);
  const shots = shotsOut();
  assert.ok(!shots.some(s => s.id === failed.id));
  assert.ok(!shots.some(s => s.name.includes('unreachable')));
});

test('waits while the one-minute load is at or above the gate', async () => {
  inFreshFolder();
  const readings = [90, 90, 10, 10, 10];
  let paused = 0;
  const out = await keepNewArcTabs({ ...base, held: [], limit: 10 }, {
    blake3Hex,
    oneMinuteLoad: () => readings.shift() ?? 10,
    pause: async ms => { assert.equal(ms, 60_000); paused += 1; },
  });
  assert.equal(paused, 2);
  assert.equal(out.waited, 2);
});

test('returns every new row for one parameterised insert, at any count', async () => {
  inFreshFolder();
  const lines = [];
  for (let i = 0; i < 450; i++) lines.push('T' + i, { parentID: 'F1', data: { tab: { savedURL: `https://site${i}.example/`, savedTitle: `Site ${i}` } } });
  const big = join(tmpdir(), `sidebar-${Date.now()}.json`);
  writeFileSync(big, JSON.stringify({ sidebar: { containers: [{ spaces: [], items: ['F1', { parentID: null, data: { itemContainer: { containerType: { spaceItems: { _0: 'S1' } } } } }, ...lines] }] } }));
  const out = await keepNewArcTabs({ obscura, sidebar: big, held: [], limit: 0 }, { blake3Hex, ...calm });
  assert.equal(out.rows.length, 450);
  assert.ok(out.rows.every(r => r.id.startsWith('record:inspiration-item:') && Array.isArray(r.tags)));
});

test('runs its entry point from a path with a space and answers one JSON line', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'arc intake ')), 'research-a-creator-or-topic');
  const doWork = join(root, 'do-work');
  mkdirSync(doWork, { recursive: true });
  const doWorkSource = join(here, '..', 'do-work');
  for (const name of ['keep-new-arc-tabs-in-the-inspiration-library.mjs', 'arc-inspiration-intake.mjs', 'arc-inspiration-intake.json']) {
    cpSync(join(doWorkSource, name), join(doWork, name));
  }
  cpSync(join(here, '..', '..', 'content-identity', 'read-data'), join(root, '..', 'content-identity', 'read-data'), { recursive: true });
  cpSync(join(here, '..', '..', '..', 'node_modules', '@noble', 'hashes'), join(root, '..', 'node_modules', '@noble', 'hashes'), { recursive: true });
  const run = spawnSync(process.execPath, [join(doWork, 'keep-new-arc-tabs-in-the-inspiration-library.mjs')], { input: '{}', encoding: 'utf8', cwd: root });
  assert.equal(run.status, 1, 'an input with no folders is refused with exit 1');
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).outcome, 'error');
});
