// Independent maintenance projections must progress through short wakes and cold restarts.
// Model cursor commits must stop inside an expensive page without skipping unprocessed records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const MODEL = { kinds: [{ type: 'basket', parts: [{ role: 'fruit', path: ['fruit'] }] }] };
const INDEXES = [{ type: 'basket', name: 'label', paths: [['label']], backfill: 'label-v1' }];
const RUNS = { page_bytes: 512, memtable_bytes: 4 * 1024 * 1024, cache_bytes: 8192, filter_bytes: 0, fill_pages: 64, fill_save_pages: 64 };
const meta = (host, key) => {
  const row = host.db.prepare('SELECT value FROM record_keys_meta WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : undefined;
};
const putMeta = (host, key, value) => host.db.prepare('INSERT INTO record_keys_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
const modelCursor = state => state?.walking?.after ?? state?.seen_after ?? null;
function fixture({ count = 1200, unknownChecksum = true, runs = RUNS, model = MODEL, indexes = INDEXES } = {}) {
  const host = sqliteHost(':memory:');
  const plain = recordLogStore(host.sql, { transaction: host.transaction, runs });
  plain.write(Array.from({ length: count }, (_, i) => ({ id: `b${String(i).padStart(5, '0')}`, type: 'basket', value: { label: `label-${i}`, fruit: [`f${i}`], text: 'x'.repeat(160) } })));
  plain.checkpoint();
  if (unknownChecksum) putMeta(host, 'covered', meta(host, 'covered').at);
  host.db.prepare("DELETE FROM record_keys_meta WHERE key = 'model_build_v2'").run();
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, runs, model, indexes });
  return { host, open, count };
}

test('an unfiltered run progresses while checksum, index and model upgrades remain unfinished; model progresses before filter completion', () => {
  const { host, open, count } = fixture();
  let store = open();
  assert.equal(store.checksum({ build: false }).root, null);
  assert.equal(store.indexReady('basket', 'label'), false);
  assert.equal(store.model().complete, false);
  const before = [...host.sql.exec('SELECT pages, filter_bits FROM record_keys_runs')];
  assert.ok(before.some(row => row.pages > 64 && row.filter_bits === 0));
  const first = store.maintain({ max_pages: 64 });
  assert.ok(first.diagnostics.filter_pages > 0 && first.diagnostics.filter_pages <= 64);
  assert.equal(store.checksum({ build: false }).root, null, 'filter repair did not wait for the checksum');
  assert.equal(store.indexReady('basket', 'label'), false, 'filter repair did not wait for the index');
  assert.equal(store.model().complete, false, 'filter repair did not wait for the model');
  assert.ok(first.diagnostics.model_walk?.walked > 0, 'model also progressed while filtering remained pending');
  assert.ok(meta(host, 'filter_fill')?.page > 0, 'partial filter progress was durable');
  assert.ok(meta(host, 'model_build_v2').walking.after !== null, 'partial model progress was durable');
  store = open();
  let turns = 0;
  while (store.maintain({ max_pages: 64 }).more) { assert.ok(++turns < 200); }
  assert.ok(store.checksum({ build: false }).root !== null);
  assert.equal(store.indexReady('basket', 'label'), true);
  assert.equal(store.model().complete, true);
  assert.equal(meta(host, 'filter_fill'), undefined);
  for (let i = 0; i < count; i += 137) {
    assert.deepEqual(store.holdersOf(`f${i}`).holders.map(row => row.id), [`b${String(i).padStart(5, '0')}`]);
  }
  assert.equal(open().model().complete, true);
});

test('short maintenance wakes rotate first choice durably across cold restarts', () => {
  const { host, open } = fixture();
  let filterMoved = false;
  let modelMoved = false;
  let checksumMoved = false;
  let indexMoved = false;
  const firstChoices = new Set();
  for (let wake = 0; wake < 20; wake += 1) {
    const store = open();
    let checks = 0;
    const step = store.maintain({ max_pages: 64, left: () => checks++ < 25 ? 1 : 0 });
    if (step.diagnostics.filter_pages > 0) filterMoved = true;
    if (step.diagnostics.model_walk?.walked > 0) modelMoved = true;
    checksumMoved ||= meta(host, 'sums_build')?.after !== undefined || store.checksum({ build: false }).root !== null;
    indexMoved ||= meta(host, 'index-build:basket:label-v1')?.after != null || store.indexReady('basket', 'label');
    firstChoices.add(meta(host, 'maintenance_next'));
    assert.ok((step.diagnostics.model_walk?.walked ?? 0) <= 256);
    assert.ok((step.diagnostics.filter_pages ?? 0) <= 64);
    if (filterMoved && modelMoved && checksumMoved && indexMoved) break;
  }
  assert.ok(filterMoved && modelMoved && checksumMoved && indexMoved, 'every independent projection must get actual progress under repeated short cold wakes');
  assert.ok(firstChoices.size > 1, 'priority is retained, not reset to filters on every open');
});

for (const phase of ['parts', 'properties']) {
  test(`model ${phase} walk checkpoints the last completed id when its deadline expires inside a page`, () => {
    const model = phase === 'parts' ? MODEL : { kinds: [{ type: 'basket' }] };
    const { host, open, count } = fixture({ count: 600, unknownChecksum: false, runs: { ...RUNS, filter_bytes: 1024 * 1024 }, model, indexes: [] });
    let store = open();
    let checks = 0;
    const step = store.maintain({ max_pages: 64, left: () => checks++ < 25 ? 1 : 0 });
    assert.equal(step.diagnostics.model_walk.phase, phase);
    assert.ok(step.diagnostics.model_walk.walked > 0 && step.diagnostics.model_walk.walked < 256, 'yield within the page, not after all 256 records');
    const saved = meta(host, 'model_build_v2');
    const cursor = modelCursor(saved);
    assert.equal(cursor, `b${String(step.diagnostics.model_walk.walked - 1).padStart(5, '0')}`);
    assert.equal(store.model().complete, false);
    store = open();
    let seen = step.diagnostics.model_walk.walked;
    for (let wakes = 0; !store.model().complete; wakes += 1) {
      assert.ok(wakes < 50);
      const next = store.maintain({ max_pages: 64 });
      const walk = next.diagnostics.model_walk;
      if (walk?.phase === phase) seen += walk.walked;
    }
    assert.equal(seen, count, 'every id is visited once across the interruption and restart');
    if (phase === 'parts') for (let i = 0; i < count; i += 53) assert.equal(store.holdersOf(`f${i}`).holders.length, 1);
    assert.equal(open().model().complete, true);
  });

  test(`a deadline expiring before the model ${phase} page starts cannot mark that page complete`, () => {
    const model = phase === 'parts' ? MODEL : { kinds: [{ type: 'basket' }] };
    const { host, open } = fixture({ count: 5, unknownChecksum: false, runs: { ...RUNS, filter_bytes: 1024 * 1024 }, model, indexes: [] });
    const store = open();
    const exec = host.sql.exec.bind(host.sql);
    let expired = false;
    host.sql.exec = (query, ...params) => {
      const answer = exec(query, ...params);
      if (/INSERT INTO record_keys_meta/.test(query) && params[0] === 'maintenance_next') expired = true;
      return answer;
    };
    const first = store.maintain({ max_pages: 64, left: () => expired ? 0 : 1 });
    host.sql.exec = exec;
    assert.equal(first.diagnostics.model_walk.walked, 0);
    assert.equal(store.model().complete, false, 'no rows inspected is not proof of an empty page');
    const state = meta(host, 'model_build_v2');
    assert.equal(modelCursor(state), null);
    if (phase === 'parts') assert.ok(state.walking !== null);
    else assert.equal(state.seen_walked, false);
    const again = open();
    for (let wakes = 0; !again.model().complete; wakes += 1) { assert.ok(wakes < 10); again.maintain({ max_pages: 64 }); }
    if (phase === 'parts') assert.equal(again.holdersOf('f4').holders.length, 1);
  });
}
