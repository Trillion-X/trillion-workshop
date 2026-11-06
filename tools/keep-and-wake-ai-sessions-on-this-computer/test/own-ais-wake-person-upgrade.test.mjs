// Ported from old trillion test/own-ais-wake-person-upgrade.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The wake index is tools/hand-work-to-ais agentRecordStore (agent-records.mjs
// scheduledWake, old src/agent-records.mjs) over this tool's record-log store and RECORD_INDEXES; the scan sizes come from
// tools/shared-code/src/own-ais.json, and countingHost is this folder's test/counting-host-for-tests.mjs.
// Left out: every answer of the retired own-AI routing (src/own-ais-routing.mjs ownAisRouting: runner().nextDue(), its
// retry time and the bounded pages it read). Searched the three repos for ownAisRouting, own-ais-routing,
// openScheduledHandoffsPage callers and no_taker: no running code routes own-AI work (tools/shared-code/test/own-ais.test.mjs
// records the same search). The first test's scan therefore runs a fixed number of cold wakes (MANY over one wake's
// pages, rounded up) instead of until the routing's answer changed; every assertion on the store, its wake index and
// its background build is the old one.
// Person-origin work is found by the wake index at every priority, and an older checkpoint has no person-origin keys:
// background index slices and the bounded scheduler fallback must converge without hiding a late-page job. The scan
// sizes come from src/own-ais.json (schedule_scan), so the scan spans several wakes with the shipped settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { RECORD_INDEXES } from '../src/record-engine.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import settings from '../../shared-code/src/own-ais.json' with { type: 'json' };
import { countingHost } from './counting-host-for-tests.mjs';

const NOW = Date.parse('2026-10-09T06:00:00Z');
const SCAN = settings.schedule_scan;
const at = n => new Date(NOW - 86400000 + n * 1000).toISOString();
const id = n => `h_${String(n).padStart(5, '0')}`;
const job = (n, extra = {}) => ({ handoff_id: id(n), job: `job ${n}`, state: 'open', handed_at: at(n), priority: 0,
  to_agent: null, taken_by: null, generation: 0, input: {}, ...extra });
const personJob = n => job(n, { input: { arrived: { from_person: true } } });
const buildKey = 'index-build:agent-handoff:handoff-wake-origin';
const oldIndexes = RECORD_INDEXES.filter(index => index.name !== 'wake_person').map(index => index.name === 'wake_timing' ? { ...index, name: 'wake', backfill: undefined } : index);
// Enough open work to need more than one wake of bounded pages, with the person's job on the last of them.
const MANY = SCAN.page_size * SCAN.pages_per_wake * 2 + 40;
const LATE = MANY - 40;

function opened(host, indexes = RECORD_INDEXES, sql = host.sql) {
  const records = recordLogStore(sql, { transaction: host.host.transaction, indexes });
  const store = agentRecordStore({ records, transaction: host.host.transaction });
  return { records, store };
}
function earlier(count = 140, missingFacts = false, person = 100) {
  const host = countingHost(), old = opened(host, oldIndexes);
  old.store.transaction(() => { for (let n = 0; n < count; n++) old.store.putHandoff(n === person ? personJob(n) : job(n)); });
  if (missingFacts) {
    // A pre-wake record has its original open/time index but not the derived scheduling facts.
    const rows = [];
    for (let n = 0; n < count; n++) {
      const key = 'agent-handoff:' + id(n), value = old.records.read(key);
      const { wake_from, from_person, ...found } = value.found_by;
      rows.push({ id: key, type: 'agent-handoff', value: { ...value, found_by: found } });
    }
    old.records.write(rows);
  }
  // The previous owner already finished its wake-only fact mark, even for an older origin field layout.
  old.records.write([{ id: 'agent-review-mark:wake-facts', type: 'agent-review-mark', value: { after: id(count - 1), done: true } }]);
  old.records.checkpoint();
  return { host, reopen: sql => opened(host, RECORD_INDEXES, sql), state: () => {
    const value = host.sql.exec('SELECT value FROM record_keys_meta WHERE key = ?', buildKey).toArray()[0]?.value;
    return value ? JSON.parse(value) : null;
  } };
}

test('old checkpoints stay not ready and bounded scans retain a late-page job across cold restarts', () => {
  const f = earlier(MANY, false, LATE);
  // The wakes the old routing's bounded scan spanned: one wake reads page_size * pages_per_wake open jobs.
  const WAKES = Math.ceil(MANY / (SCAN.page_size * SCAN.pages_per_wake));
  assert.ok(WAKES > 1, 'the scan spans more than one wake');
  for (let wakes = 0; wakes < WAKES; wakes += 1) {
    const { records, store } = f.reopen();
    store.scheduledWake.step();
    assert.equal(records.indexReady('agent-handoff', 'wake_person'), false);
    assert.equal(store.scheduledWake.ready(), false, 'missing keys are not a claim that no exempt work exists');
    assert.notEqual(records.maintenanceAt(), null, 'the existing background maintainer owns the upgrade');
    records.checkpoint();
  }
  const logRows = f.host.sql.exec("SELECT COUNT(*) AS n FROM record_log WHERE id LIKE 'agent-handoff:%'").one().n;
  let prior = -1, completed = 0;
  for (let n = 0; ; n++) {
    assert.ok(n < Math.ceil(MANY / 32) + 10);
    const { records } = f.reopen();
    const result = records.maintain();
    const state = f.state();
    if (!state) continue; // Other already-declared background groups may own this slice.
    const last = Number(state.after.split('_').at(-1));
    assert.ok(last - prior <= 32, 'an exemption build slice visits at most 32 current heads');
    prior = last;
    completed += result.indexes_ready.filter(index => index.name === 'wake_person').length;
    if (state.ready) break;
  }
  let { records, store } = f.reopen();
  for (let n = 0; !store.scheduledWake.ready(); n++) {
    assert.ok(n < MANY); store.scheduledWake.step(); records.checkpoint(); ({ records, store } = f.reopen());
  }
  assert.equal(completed, 1);
  assert.equal(store.scheduledWake.ready(), true);
  assert.ok(store.scheduledWake.rows({ to_agent: '', priority: 0, from_person: true, limit: MANY }).some(row => row.item.handoff_id === id(LATE)), 'the late-page person job is in the wake index');
  assert.equal(f.host.sql.exec("SELECT COUNT(*) AS n FROM record_log WHERE id LIKE 'agent-handoff:%'").one().n, logRows, 'index backfill never rewrites handoffs');
  assert.deepEqual(records.maintain().indexes_ready, []);
});

test('pre-wake records never become ready before their facts are present, even when index backfill finishes first', () => {
  const f = earlier(140, true);
  let live = f.reopen();
  for (let n = 0; !live.records.indexReady('agent-handoff', 'wake_person'); n++) {
    assert.ok(n < 20); live.records.maintain(); live = f.reopen();
  }
  assert.equal(live.store.scheduledWake.ready(), false, 'building an empty index is not proof of complete wake facts');
  for (let n = 0; !live.store.scheduledWake.ready(); n++) {
    assert.ok(n < 10); live.store.scheduledWake.step(); live.records.checkpoint(); live = f.reopen();
  }
  assert.deepEqual(live.store.scheduledWake.rows({ to_agent: '', priority: 0, from_person: true, limit: 16 }).map(row => row.item.handoff_id), [id(100)]);
});

test('an interrupted backfill does not publish readiness or advance past absent keys', () => {
  const f = earlier(65);
  let fault = true;
  const sql = { exec(query, ...args) {
    if (fault && query.startsWith('INSERT INTO record_keys_meta') && args[0] === buildKey) {
      fault = false; throw new Error('Injected crash before exemption progress');
    }
    return f.host.sql.exec(query, ...args);
  } };
  const live = f.reopen(sql);
  assert.throws(() => live.records.maintain(), /Injected crash/);
  assert.equal(f.state(), null);
  assert.equal(f.reopen().store.scheduledWake.ready(), false);
  for (let n = 0; ; n++) {
    assert.ok(n < 20);
    const reopened = f.reopen(); reopened.records.maintain(); reopened.store.scheduledWake.step();
    if (reopened.store.scheduledWake.ready()) break;
  }
});

test('current writes during a background build add and remove wake keys on both sides of its cursor', () => {
  const f = earlier();
  let live = f.reopen(); live.records.maintain();
  live.store.putHandoff(personJob(1));
  live.store.putHandoff(job(100));
  live.store.putHandoff(personJob(130));
  live.store.putHandoff({ ...personJob(140), handoff_id: 'a-before-cursor', handed_at: at(-1) });
  live.records.checkpoint();
  for (let n = 0; !live.store.scheduledWake.ready(); n++) {
    assert.ok(n < 20); live = f.reopen(); live.records.maintain(); live.store.scheduledWake.step();
  }
  const rows = live.store.scheduledWake.rows({ to_agent: '', priority: 0, from_person: true, limit: 16 });
  assert.deepEqual(rows.map(row => row.item.handoff_id), ['a-before-cursor', id(1), id(130)]);
  live.store.putHandoff({ ...personJob(1), state: 'finished' });
  assert.deepEqual(live.store.scheduledWake.rows({ to_agent: '', priority: 0, from_person: true, limit: 16 }).map(row => row.item.handoff_id), ['a-before-cursor', id(130)]);
});

test('an old completed wake-only mark and shorter wake keys cannot hide person work or retain finished work', () => {
  const host = countingHost();
  const indexes = oldIndexes.map(index => index.name === 'wake' ? { ...index,
    paths: index.paths.filter(path => path.at(-1) !== 'from_person') } : index);
  const old = opened(host, indexes);
  old.store.putHandoff(personJob(0));
  const key = 'agent-handoff:' + id(0), value = old.records.read(key);
  delete value.found_by.from_person;
  old.records.write([{ id: key, type: 'agent-handoff', value },
    { id: 'agent-review-mark:wake-facts', type: 'agent-review-mark', value: { after: id(0), done: true } }]);
  old.records.checkpoint();
  let live = opened(host);
  live.records.maintain();
  assert.equal(live.records.indexReady('agent-handoff', 'wake_person'), true);
  assert.equal(live.store.scheduledWake.ready(), false, 'an old complete mark does not prove person-origin facts');
  live.store.scheduledWake.step(); live.records.checkpoint(); live = opened(host);
  assert.equal(live.store.scheduledWake.ready(), true);
  live.store.putHandoff({ ...personJob(0), state: 'finished' });
  live.records.checkpoint(); live = opened(host);
  assert.deepEqual(live.store.scheduledWake.rows({ to_agent: '', priority: 0, limit: 16 }), []);
  assert.deepEqual(live.store.scheduledWake.rows({ to_agent: '', priority: 0, from_person: true, limit: 16 }), []);
});
